import { createEngine, type Engine, type FrameMetrics, type RenderOptions } from '@strata-engine/core';
import { loadGltf } from '@strata-engine/core/gltf';
import type { GalleryAsset } from './catalog.js';
import { normalizeOrbit, orbitEye, type GalleryOrbit } from './orbit.js';
import { GalleryMeasurements } from './state.js';

type PreparedAsset = Awaited<ReturnType<typeof loadGltf>>;
type ImportedControls = NonNullable<RenderOptions['imported']>;
export type GalleryPhase = 'initializing' | 'empty' | 'loading' | 'ready' | 'unsupported' | 'error' | 'disposed';
export const scenePresets = { 'model-only': 'Model only', ground: 'Ground plane' } as const;
export const lightingPresets = {
  studio: { label: 'Soft studio', directionToLight: [0.5, 0.8, 0.7], color: [1, 0.94, 0.86], intensity: 3, ambient: [0.12, 0.14, 0.17], background: [0.055, 0.065, 0.07] },
  daylight: { label: 'Daylight', directionToLight: [-0.6, 1, 0.4], color: [1, 0.98, 0.9], intensity: 4, ambient: [0.12, 0.17, 0.23], background: [0.36, 0.46, 0.56] },
  dusk: { label: 'Warm dusk', directionToLight: [0.8, 0.3, -0.4], color: [1, 0.48, 0.2], intensity: 3.5, ambient: [0.05, 0.06, 0.12], background: [0.055, 0.035, 0.065] },
} as const;
export const debugViews = { final: 'Final', direct: 'Direct light', shadow: 'Shadow', depth: 'Depth', normal: 'Normals', motion: 'Motion', material: 'Material' } as const;
export type ScenePreset = keyof typeof scenePresets;
export type LightingPreset = keyof typeof lightingPresets;
export type DebugView = keyof typeof debugViews;
export interface GalleryAnimation {
  readonly clipId: string | null;
  readonly timeSeconds: number;
  readonly loop: boolean;
  readonly playing: boolean;
}

const limits = { minimumDistance: 0.15, maximumDistance: 50 };
const initialOrbit: GalleryOrbit = { azimuth: 0.55, elevation: 0.24, distance: 4.5, target: [0, 1, 0] };
const freshAnimation = (): GalleryAnimation => ({ clipId: null, timeSeconds: 0, loop: true, playing: false });

function failure(error: unknown) {
  return { code: error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'GALLERY_FAILED', message: error instanceof Error ? error.message : String(error) };
}
function stopped(message: string): Error { return new DOMException(message, 'AbortError'); }

/** Owns one real Strata engine. The gallery does not contain another renderer. */
export class GalleryRuntime {
  readonly #canvas: HTMLCanvasElement;
  readonly #changed: () => void;
  readonly #measurements = new GalleryMeasurements();
  #engine: Engine | null = null;
  #epoch = 0;
  #phase: GalleryPhase = 'initializing';
  #error: ReturnType<typeof failure> | null = null;
  #model: GalleryAsset | null = null;
  #requestedModel: GalleryAsset | null = null;
  #asset: PreparedAsset | null = null;
  #sceneCommit: unknown = null;
  #viewRevision = 0;
  #scenePreset: ScenePreset = 'model-only';
  #lightingPreset: LightingPreset = 'studio';
  #debugView: DebugView = 'final';
  #orbit: GalleryOrbit = normalizeOrbit(initialOrbit, limits);
  #resetOrbit: GalleryOrbit = this.#orbit;
  #animation: GalleryAnimation = freshAnimation();
  #live = false;
  #busy: 'settings' | 'capture' | null = null;
  #raf: number | null = null;
  #lastTimestamp: number | null = null;
  #lastUiTimestamp = 0;
  #lastFrame: FrameMetrics | null = null;
  #submittedView: { frameId: number; controls: ImportedControls } | null = null;
  #load: AbortController | null = null;
  #initialization = new AbortController();
  #request = 0;
  #pendingSize: readonly [number, number] | null = null;

  constructor(canvas: HTMLCanvasElement, changed: () => void) { this.#canvas = canvas; this.#changed = changed; }
  reportFailure(error: unknown) { this.#fault(error); }

  async initialize(): Promise<void> {
    try {
      const engine = await createEngine({ canvas: this.#canvas, profiling: true, signal: this.#initialization.signal, initializationTimeoutMs: 30_000 });
      if (this.#phase === 'disposed') { engine.dispose(); throw stopped('Gallery was disposed during initialization.'); }
      this.#engine = engine;
      this.#epoch += 1;
      this.#measurements.clear();
      this.#phase = 'empty';
      this.#applySize();
      this.#changed();
    } catch (error) {
      if (this.#phase !== 'disposed') {
        this.#error = failure(error);
        this.#phase = /WEBGPU|ADAPTER|FEATURE|LIMIT/.test(this.#error.code) ? 'unsupported' : 'error';
        this.#changed();
      }
      throw error;
    }
  }

  #identity() { return { engineEpoch: this.#epoch, viewRevision: this.#viewRevision, modelId: this.#model?.id ?? null }; }
  #ownsRequest(request: number) { return request === this.#request && this.#phase !== 'disposed'; }
  #healthy(): Engine {
    if (!this.#engine || this.#phase === 'disposed') throw new Error('The gallery runtime is not available.');
    const telemetry = this.#engine.getTelemetry();
    if (this.#engine.state !== 'ready' || telemetry.gpuErrorCount > 0) {
      const error = new Error(telemetry.lastGpuError ?? `The Strata engine is ${this.#engine.state}. Reload the gallery to recreate it.`);
      this.#fault(error);
      throw error;
    }
    return this.#engine;
  }
  #ready(): Engine {
    if (this.#phase !== 'ready' || this.#busy) throw new Error('The gallery must be ready and idle for this operation.');
    return this.#healthy();
  }
  #stopFrames() {
    if (this.#raf !== null) cancelAnimationFrame(this.#raf);
    this.#raf = null;
    this.#lastTimestamp = null;
    this.#measurements.resetCallback();
  }
  #fault(error: unknown) {
    if (this.#phase === 'disposed') return;
    this.#stopFrames();
    this.#live = false;
    this.#error = failure(error);
    this.#phase = 'error';
    this.#changed();
  }

  async selectModel(model: GalleryAsset): Promise<void> {
    model = structuredClone(model);
    if (this.#busy) throw new Error('A capture or view change is still settling.');
    this.#healthy();
    const request = ++this.#request;
    this.#load?.abort(stopped('A newer model selection superseded this load.'));
    this.#stopFrames();
    this.#live = false;
    this.#requestedModel = model;
    this.#error = null;
    if (model.entryUrl === null || model.unavailableReason !== null) {
      this.#phase = 'unsupported';
      this.#error = { code: 'GALLERY_ASSET_UNAVAILABLE', message: model.unavailableReason ?? 'The model entry is unavailable.' };
      this.#changed();
      throw new Error(this.#error.message);
    }
    const load = new AbortController();
    this.#load = load;
    const timeout = setTimeout(() => load.abort(new Error('Model loading exceeded 120 seconds.')), 120_000);
    let sceneReplacementStarted = false;
    this.#phase = 'loading';
    this.#changed();
    try {
      const asset = await loadGltf(model.entryUrl, { signal: load.signal, maxTextureDimension: 2048 });
      if (load.signal.aborted || request !== this.#request) throw load.signal.reason ?? stopped('Model load was superseded.');
      sceneReplacementStarted = true;
      const commit = await this.#healthy().setScene({ renderer: 'imported', asset, signal: load.signal });
      if (load.signal.aborted || request !== this.#request) throw load.signal.reason ?? stopped('Model load was superseded.');
      this.#asset = asset;
      this.#model = model;
      this.#sceneCommit = commit === undefined ? null : commit;
      const idle = asset.clips.find(clip => /^(?:idle|f_idle|idle01)$/i.test(clip.name.trim()));
      this.#animation = idle ? { clipId: idle.id, timeSeconds: 0, loop: true, playing: true } : freshAnimation();
      const target = asset.bounds.min.map((value, axis) => (value + asset.bounds.max[axis]!) / 2) as [number, number, number];
      const radius = Math.hypot(...asset.bounds.max.map((value, axis) => (value - asset.bounds.min[axis]!) / 2));
      this.#resetOrbit = normalizeOrbit({ ...initialOrbit, target, distance: Math.max(2, radius / Math.sin(0.42)) }, limits);
      this.#orbit = this.#resetOrbit;
      this.#viewRevision += 1;
      this.#applySize();
      this.#submit(true);
      await this.#settleFrames(this.#healthy(), load.signal);
      if (load.signal.aborted || request !== this.#request) throw load.signal.reason ?? stopped('Model load was superseded.');
      this.#healthy();
      this.#phase = 'ready';
      this.#live = Boolean(idle);
      this.#changed();
      this.#schedule();
    } catch (error) {
      if (this.#ownsRequest(request)) {
        // A void-returning Core baseline cannot prove whether a rejected
        // replacement committed before retiring its old resources.
        if (sceneReplacementStarted) { this.#model = null; this.#asset = null; this.#sceneCommit = null; }
        this.#error = failure(error);
        this.#phase = /UNSUPPORTED/.test(this.#error.code) ? 'unsupported' : 'error';
        this.#changed();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.#load === load) this.#load = null;
    }
  }

  #controls(): ImportedControls {
    const light = lightingPresets[this.#lightingPreset];
    return {
      camera: { eye: orbitEye(this.#orbit), target: this.#orbit.target, verticalFov: 0.84 },
      lighting: { directionToLight: light.directionToLight, color: light.color, intensity: light.intensity, ambient: light.ambient },
      presentation: this.#scenePreset, background: light.background,
      animation: { clipId: this.#animation.clipId, timeSeconds: this.#animation.timeSeconds, loop: this.#animation.loop },
    };
  }
  #submit(cameraCut = false): FrameMetrics {
    const engine = this.#healthy();
    const controls = this.#controls();
    const frame = engine.render({ imported: controls, temporal: true, debugView: this.#debugView, cameraCut, timeSeconds: this.#animation.timeSeconds });
    this.#lastFrame = frame;
    this.#submittedView = { frameId: frame.frameId, controls: structuredClone(controls) };
    this.#measurements.recordFrame(frame, this.#identity());
    this.#measurements.recordGpuTimings(engine.drainGpuTimings());
    return frame;
  }
  async #settleFrames(engine: Engine, signal?: AbortSignal, collectTimings = false) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await engine.waitForIdle();
      if (collectTimings) await engine.flushGpuTimings();
      if (signal?.aborted) throw signal.reason ?? stopped('Model load was canceled.');
      this.#healthy();
      if (!this.#pendingSize) return;
      if (attempt === 3) throw new Error('Viewport kept changing while the gallery was preparing a stable frame.');
      this.#applySize();
      this.#submit(true);
    }
  }
  #schedule() {
    if (!this.#live || this.#phase !== 'ready' || this.#busy || this.#raf !== null || document.hidden) return;
    this.#raf = requestAnimationFrame(timestamp => {
      this.#raf = null;
      try {
        if (this.#animation.playing && this.#animation.clipId !== null && this.#lastTimestamp !== null) {
          const clip = this.#asset?.clips.find(item => item.id === this.#animation.clipId);
          let timeSeconds = this.#animation.timeSeconds + Math.max(0, (timestamp - this.#lastTimestamp) / 1000);
          if (clip && !this.#animation.loop && timeSeconds >= clip.duration) {
            timeSeconds = clip.duration;
            this.#animation = { ...this.#animation, playing: false };
          } else if (clip && this.#animation.loop && clip.duration > 0) timeSeconds %= clip.duration;
          this.#animation = { ...this.#animation, timeSeconds };
        }
        this.#lastTimestamp = timestamp;
        this.#measurements.recordCallback(timestamp);
        this.#applySize();
        this.#submit();
        if (timestamp - this.#lastUiTimestamp >= 150) { this.#lastUiTimestamp = timestamp; this.#changed(); }
        this.#schedule();
      } catch (error) { this.#fault(error); }
    });
  }
  setLive(value: boolean) {
    this.#ready();
    if (typeof value !== 'boolean') throw new Error('Live view must be a boolean.');
    this.#live = value;
    this.#stopFrames();
    this.#schedule();
    this.#changed();
  }
  visibilityChanged() { this.#stopFrames(); this.#schedule(); }

  async #change(apply: () => void, cameraCut = true) {
    const engine = this.#ready();
    this.#busy = 'settings';
    this.#stopFrames();
    this.#changed();
    try {
      apply();
      this.#viewRevision += 1;
      this.#applySize();
      this.#submit(cameraCut);
      await this.#settleFrames(engine);
      this.#healthy();
    } catch (error) { this.#fault(error); throw error; }
    finally { this.#busy = null; this.#changed(); this.#schedule(); }
  }
  async setScenePreset(id: ScenePreset) {
    if (!Object.hasOwn(scenePresets, id)) throw new Error('Unknown scene preset.');
    await this.#change(() => { this.#scenePreset = id; });
  }
  async setLightingPreset(id: LightingPreset) {
    if (!Object.hasOwn(lightingPresets, id)) throw new Error('Unknown lighting preset.');
    await this.#change(() => { this.#lightingPreset = id; });
  }
  async setDebugView(id: DebugView) {
    if (!Object.hasOwn(debugViews, id)) throw new Error('Unknown debug view.');
    await this.#change(() => { this.#debugView = id; });
  }
  async setOrbit(value: Partial<GalleryOrbit>) {
    const next = normalizeOrbit({ ...this.#orbit, ...value }, limits);
    await this.#change(() => { this.#orbit = next; });
  }
  async resetCamera() { await this.#change(() => { this.#orbit = this.#resetOrbit; }); }
  async setAnimation(value: Partial<GalleryAnimation>) {
    const next = { ...this.#animation, ...value };
    if (typeof next.loop !== 'boolean' || typeof next.playing !== 'boolean' || !Number.isFinite(next.timeSeconds) || next.timeSeconds < 0) throw new Error('Animation requires nonnegative finite time and boolean playback settings.');
    const clip = this.#asset?.clips.find(item => item.id === next.clipId);
    if (next.clipId !== null && !clip) throw new Error('The runtime does not expose that animation clip.');
    if (next.clipId === null) { next.timeSeconds = 0; next.playing = false; }
    else if (clip) next.timeSeconds = next.loop && clip.duration > 0 ? next.timeSeconds % clip.duration : Math.min(clip.duration, next.timeSeconds);
    await this.#change(() => { this.#animation = next; if (next.playing) this.#live = true; });
  }

  resize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('Viewport dimensions must be positive integers.');
    this.#pendingSize = this.#canvas.width === width && this.#canvas.height === height ? null : [width, height];
    if (!this.#busy && this.#phase === 'ready') {
      try { this.#applySize(); this.#submit(true); this.#changed(); } catch (error) { this.#fault(error); }
    }
  }
  async setViewport(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > this.#healthy().info.maxTextureDimension2D || height > this.#healthy().info.maxTextureDimension2D) throw new Error('Viewport dimensions exceed the supported physical pixel range.');
    await this.#change(() => { this.#pendingSize = [width, height]; });
    return this.getState();
  }
  #applySize() {
    if (!this.#pendingSize || !this.#engine) return;
    const max = this.#engine.info.maxTextureDimension2D;
    const [width, height] = this.#pendingSize.map(value => Math.min(max, value)) as [number, number];
    this.#pendingSize = null;
    if (this.#canvas.width === width && this.#canvas.height === height) return;
    this.#engine.resize(width, height);
    this.#viewRevision += 1;
  }

  async renderFrames(count = 1) {
    const engine = this.#ready();
    if (!Number.isInteger(count) || count < 1 || count > 120) throw new Error('Explicit frames must be an integer from 1 to 120.');
    this.#busy = 'capture';
    this.#live = false;
    this.#animation = { ...this.#animation, playing: false };
    this.#stopFrames();
    this.#changed();
    try {
      this.#applySize();
      for (let index = 0; index < count; index += 1) this.#submit(index === 0);
      await this.#settleFrames(engine, undefined, true);
      this.#measurements.recordGpuTimings(engine.drainGpuTimings());
      this.#healthy();
      const state = this.getState();
      state.busy = null;
      return state;
    } catch (error) { this.#fault(error); throw error; }
    finally { this.#busy = null; this.#changed(); }
  }
  async captureState(frames = 4) {
    const state = await this.renderFrames(frames);
    return { format: 'strata.gallery.capture-state', version: 1, capturedAt: new Date().toISOString(), presentedFrameId: null, state };
  }
  getState() {
    if (this.#phase === 'ready' && this.#engine && (this.#engine.state !== 'ready' || this.#engine.getTelemetry().gpuErrorCount > 0)) {
      this.#fault(new Error(this.#engine.getTelemetry().lastGpuError ?? `The Strata engine is ${this.#engine.state}.`));
    }
    const asset = this.#asset;
    const result = {
      format: 'strata.gallery.state', version: 1, phase: this.#phase, error: this.#error,
      requestedModelId: this.#requestedModel?.id ?? null, modelId: this.#model?.id ?? null,
      engineEpoch: this.#epoch, sceneCommit: this.#sceneCommit, viewRevision: this.#viewRevision,
      source: this.#model ? { entryUrl: this.#model.entryUrl, catalogGltfSha256: this.#model.sourceSha256 } : null,
      asset: asset ? { sourceUrl: asset.sourceUrl, bounds: asset.bounds, sourceBounds: asset.sourceBounds, normalization: asset.normalization, stats: asset.stats, warnings: asset.warnings, maxTextureDimension: asset.maxTextureDimension, clips: asset.clips.map(({ id, name, duration }) => ({ id, name, duration })) } : null,
      settings: { scenePreset: this.#scenePreset, lightingPreset: this.#lightingPreset, debugView: this.#debugView, orbit: this.#orbit, animation: this.#animation, temporal: true, effective: this.#controls() },
      live: this.#live, busy: this.#busy, viewport: { width: this.#canvas.width, height: this.#canvas.height },
      frame: this.#lastFrame, submittedView: this.#submittedView, measurements: this.#measurements.snapshot(this.#identity()),
      telemetry: this.#engine?.getTelemetry() ?? null, engineInfo: this.#engine?.info ?? null,
    };
    return structuredClone(result);
  }
  dispose() {
    if (this.#phase === 'disposed') return;
    this.#phase = 'disposed';
    this.#request += 1;
    this.#initialization.abort();
    this.#load?.abort();
    this.#stopFrames();
    this.#live = false;
    this.#engine?.dispose();
    this.#asset = null;
    this.#changed();
  }
}

export type GalleryState = ReturnType<GalleryRuntime['getState']>;
