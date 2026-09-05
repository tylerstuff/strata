import { StrataError } from '../errors.js';
import { RasterRenderer, normalizeRasterControls } from '../rendering/raster-renderer.js';
import type { RasterGiProvider } from '../rendering/gi-provider.js';
import type { CameraFrame } from '../rendering/raster-math.js';
import type { RasterControls, RasterOutputs, RasterPassName, RasterTimestamps } from '../rendering/raster-types.js';
import { validateGiControls } from '../gi/gi-renderer.js';
import { buildGiTraceData, refitGiTraceData } from '../gi/trace-data.js';
import type { GiTraceData } from '../gi/trace-data.js';
import type { GiTriangle } from '../gi/scene-data.js';
import { ProbeCache } from '../gi/probe-cache.js';
import type { ProbeBindings } from '../gi/probe-cache.js';
import type { GiControls, GiTelemetry } from '../gi/gi-types.js';
import { createReflectionScene } from './reflection-scene.js';
import type { ReflectionSceneData } from './reflection-scene.js';
import type { ReflectionSceneOptions as ReflectionFixtureOptions } from './reflection-scene.js';
import { ReflectionGeometry } from './reflection-geometry.js';
import { ReflectionCache, normalizeReflectionControls } from './reflection-cache.js';
import type { NormalizedReflectionControls } from './reflection-cache.js';
import { ReflectionComposer } from './reflection-composer.js';
import type { ReflectionControls, ReflectionSceneOptions, ReflectionTelemetry } from './reflection-types.js';

export type ReflectionRenderControls = RasterControls & { gi?: GiControls; reflections?: ReflectionControls };
type Controls = ReflectionRenderControls;
const traceArrays = (data: GiTraceData): readonly ArrayBuffer[] => [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData];

/** Shared lighting over an explicit persistent tracing source. Not part of the package facade. */
export class ReflectionEffect implements RasterGiProvider {
  giEnabled = true;
  controls: NormalizedReflectionControls;
  private revision = 1;
  private diffuseInvalidationRevision = 1;
  private frames = 0;
  private traceDirty = false;
  private resetPending = false;
  private pendingProbes: ProbeBindings | undefined;
  private disposed = false;

  private constructor(private readonly device: GPUDevice, readonly traceData: GiTraceData,
    private readonly traceBuffers: readonly GPUBuffer[], readonly probeCache: ProbeCache,
    readonly reflectionCache: ReflectionCache, readonly composer: ReflectionComposer, private scene: ReflectionSceneData,
    private readonly sceneFactory: (options: ReflectionFixtureOptions) => ReflectionSceneData) {
    this.controls = normalizeReflectionControls({ roughness: scene.state.roughness, objectOffset: scene.state.objectOffset });
  }
  static async create(device: GPUDevice, scene: ReflectionSceneData, options: Omit<ReflectionSceneOptions, 'renderer' | 'cameraMode'>,
    source: { sceneFactory?: (options: ReflectionFixtureOptions) => ReflectionSceneData; staticTriangles?: readonly GiTriangle[] } = {}): Promise<ReflectionEffect> {
    const data = buildGiTraceData(scene, source.staticTriangles); const buffers: GPUBuffer[] = [];
    let probes: ProbeCache | undefined; let reflections: ReflectionCache | undefined; let composer: ReflectionComposer | undefined;
    try {
      for (const [index, bytes] of traceArrays(data).entries()) {
        if (bytes.byteLength > device.limits.maxBufferSize || (index < 4 && bytes.byteLength > device.limits.maxStorageBufferBindingSize)) {
          throw new StrataError('UNSUPPORTED_LIMIT', 'Reflection tracing geometry exceeds device buffer limits.');
        }
        const buffer = device.createBuffer({ label: `Strata reflection trace data ${index}`, size: bytes.byteLength, usage: (index === 4 ? 0x40 : 0x80) | 0x8 | 0x4 });
        buffers.push(buffer); device.queue.writeBuffer(buffer, 0, bytes);
      }
      const entries = buffers.map((buffer, binding) => ({ binding, resource: { buffer } }));
      probes = await ProbeCache.create(device, entries, {
        ...(options.probesPerUpdate === undefined ? {} : { probesPerUpdate: options.probesPerUpdate }),
        ...(options.raysPerProbe === undefined ? {} : { raysPerProbe: options.raysPerProbe }),
      });
      reflections = await ReflectionCache.create(device, entries, {
        ...(options.resolutionScale === undefined ? {} : { resolutionScale: options.resolutionScale }),
        ...(options.maxRaysPerFrame === undefined ? {} : { maxRaysPerFrame: options.maxRaysPerFrame }),
      });
      composer = await ReflectionComposer.create(device, entries, reflections.samplingLayout);
      return new ReflectionEffect(device, data, buffers, probes, reflections, composer, scene, source.sceneFactory ?? createReflectionScene);
    } catch (cause) { composer?.dispose(); reflections?.dispose(); probes?.dispose(); for (const buffer of buffers) buffer.destroy(); throw cause; }
  }
  get active(): boolean { return this.giEnabled || this.controls.mode !== 'off'; }
  get currentScene(): ReflectionSceneData { return this.scene; }
  /** Internal diagnostics borrow these buffers; ownership stays with the effect. */
  get traceBindings(): readonly GPUBindGroupEntry[] {
    return this.traceBuffers.map((buffer, binding) => ({ binding, resource: { buffer } }));
  }
  get gpuBufferBytes(): number { return this.disposed ? 0 : this.traceData.gpuBufferBytes + this.probeCache.gpuBufferBytes + this.reflectionCache.gpuBufferBytes + this.composer.gpuBufferBytes; }
  get gpuTextureBytes(): number { return this.disposed ? 0 : this.probeCache.gpuTextureBytes + this.reflectionCache.gpuTextureBytes + this.composer.gpuTextureBytes; }
  get initialUploadBytes(): number { return this.traceData.gpuBufferBytes + this.probeCache.initialUploadBytes + this.reflectionCache.initialUploadBytes; }
  get preparePassNames(): readonly RasterPassName[] { return this.giEnabled ? ['gi-trace', 'gi-update'] : []; }
  get composePassNames(): readonly RasterPassName[] { return [...(this.controls.mode === 'world' ? ['reflection-trace', 'reflection-resolve'] as const : []), 'gi-shade']; }
  get giTelemetry(): GiTelemetry {
    return { ...this.probeCache.telemetry, enabled: this.giEnabled, worldRevision: this.revision,
      objectMotionRollingRefresh: true,
      doorOpen: this.scene.state.doorOpen, wallColor: this.scene.state.wallColor, lightIntensity: this.scene.state.lightIntensity,
      traceRepresentation: 'triangle-bvh-v1', traceGeometryBytes: this.traceData.gpuBufferBytes,
      cacheBufferBytes: this.probeCache.gpuBufferBytes, cacheTextureBytes: this.probeCache.gpuTextureBytes,
      composeBufferBytes: this.composer.gpuBufferBytes, composeTextureBytes: this.composer.gpuTextureBytes,
      primaryRaysPerFrame: this.giEnabled ? this.probeCache.probesPerUpdate * this.probeCache.raysPerProbe : 0,
      maxShadowRaysPerFrame: this.giEnabled ? this.probeCache.probesPerUpdate * this.probeCache.raysPerProbe : 0,
    };
  }
  get reflectionTelemetry(): ReflectionTelemetry {
    const tracing = this.controls.mode === 'world';
    return { ...this.reflectionCache.telemetry, mode: this.controls.mode, roughness: this.controls.roughness,
      maxDistance: this.controls.maxDistance, updateEvery: this.controls.updateEvery, objectOffset: this.controls.objectOffset,
      worldRevision: this.revision, giEnabled: this.giEnabled, traceRepresentation: 'triangle-bvh-v1',
      traceGeometryBytes: this.traceData.gpuBufferBytes, composeBufferBytes: this.composer.gpuBufferBytes,
      composeTextureBytes: this.composer.gpuTextureBytes,
      ...(!tracing ? { scheduledCandidates: 0, maxPrimaryRays: 0, maxShadowRays: 0 } : {}),
    };
  }
  mergedControls(patch: ReflectionControls | undefined): NormalizedReflectionControls {
    // Validate the patch before merging so explicit invalid values cannot be hidden by defaults.
    if (patch !== undefined) normalizeReflectionControls(patch);
    return normalizeReflectionControls({ ...this.controls, resetHistory: false,
      ...Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined)),
    });
  }
  update(input: Controls): boolean {
    validateGiControls(input.gi); const controls = this.mergedControls(input.reflections); const gi = input.gi ?? {};
    const state = this.scene.state;
    const hardChanged = (gi.doorOpen !== undefined && gi.doorOpen !== state.doorOpen)
      || (gi.wallColor !== undefined && gi.wallColor !== state.wallColor)
      || (gi.lightIntensity !== undefined && gi.lightIntensity !== state.lightIntensity)
      || controls.roughness !== state.roughness;
    const changed = hardChanged || controls.objectOffset !== state.objectOffset;
    const giEnabled = gi.enabled ?? this.giEnabled; const toggled = giEnabled !== this.giEnabled;
    const resetWorld = changed || gi.resetCache || (toggled && giEnabled);
    const resetDiffuse = hardChanged || gi.resetCache || (toggled && giEnabled);
    if (resetWorld && this.revision === 0xffffffff) throw new StrataError('UNSUPPORTED_LIMIT', 'Reflection world revisions exhausted; recreate the scene.');
    if (resetDiffuse && this.diffuseInvalidationRevision === 0xffffffff) throw new StrataError('UNSUPPORTED_LIMIT', 'Diffuse invalidation revisions exhausted; recreate the scene.');
    const settingsChanged = Object.entries(controls).some(([key, value]) => key !== 'resetHistory' && value !== this.controls[key as keyof NormalizedReflectionControls]);
    if (changed) {
      const next = this.sceneFactory({ doorOpen: gi.doorOpen ?? state.doorOpen,
        wallColor: gi.wallColor ?? state.wallColor, lightIntensity: gi.lightIntensity ?? state.lightIntensity,
        objectOffset: controls.objectOffset, roughness: controls.roughness });
      refitGiTraceData(this.traceData, next); this.scene = next; this.traceDirty = true;
    }
    if (resetWorld) this.revision++;
    // A rigid object's continuous motion refits tracing and resets reflection/TAA history,
    // but diffuse probes refresh on their bounded cycle instead of starving at frontier zero.
    if (resetDiffuse) this.diffuseInvalidationRevision++;
    this.controls = controls; this.giEnabled = giEnabled;
    this.resetPending ||= Boolean(resetWorld || toggled || settingsChanged || input.cameraCut || controls.resetHistory);
    return Boolean(resetWorld || toggled || settingsChanged || controls.resetHistory);
  }
  prepare(encoder: GPUCommandEncoder, _camera: CameraFrame, _width: number, _height: number, _time: number, timestamps: RasterTimestamps) {
    let uploadBytes = 0;
    if (this.traceDirty) {
      for (const [index, bytes] of traceArrays(this.traceData).entries()) this.device.queue.writeBuffer(this.traceBuffers[index]!, 0, bytes);
      uploadBytes += this.traceData.gpuBufferBytes; this.traceDirty = false;
    }
    if (!this.giEnabled) { this.pendingProbes = this.probeCache.bindings; return { uploadBytes, dispatchCalls: 0 }; }
    const result = this.probeCache.encode(encoder, { revision: this.revision, invalidationRevision: this.diffuseInvalidationRevision, frameIndex: this.frames,
      timestamps: { ...(timestamps['gi-trace'] ? { trace: timestamps['gi-trace'] } : {}), ...(timestamps['gi-update'] ? { update: timestamps['gi-update'] } : {}) },
    });
    this.pendingProbes = result.bindings;
    return { uploadBytes: uploadBytes + result.uploadBytes, dispatchCalls: result.dispatchCalls };
  }
  compose(encoder: GPUCommandEncoder, outputs: RasterOutputs, camera: CameraFrame, width: number, height: number,
    _time: number, controls: RasterControls, timestamps: RasterTimestamps) {
    if (!this.pendingProbes) throw new StrataError('RENDER_FAILED', 'Reflection scene was not prepared.');
    const reflection = this.reflectionCache.encode(encoder, { outputs, camera, width, height, frameIndex: this.frames,
      worldRevision: this.revision, controls: this.controls, reset: this.resetPending || controls.cameraCut === true,
      probes: this.pendingProbes, giEnabled: this.giEnabled,
      timestamps: { ...(timestamps['reflection-trace'] ? { trace: timestamps['reflection-trace'] } : {}),
        ...(timestamps['reflection-resolve'] ? { resolve: timestamps['reflection-resolve'] } : {}) },
    });
    const composed = this.composer.encode(encoder, outputs, camera, width, height, controls, this.pendingProbes, reflection.bindings, this.giEnabled, timestamps['gi-shade']);
    return { view: composed.view, dispatchCalls: reflection.dispatchCalls + composed.dispatchCalls, uploadBytes: reflection.uploadBytes + composed.uploadBytes,
      ...(reflection.skippedGpuPasses ? { skippedGpuPasses: reflection.skippedGpuPasses } : {}) };
  }
  submitted(frameId: number): void {
    this.probeCache.submitted(frameId); this.reflectionCache.submitted(frameId); this.pendingProbes = undefined;
    this.frames++; this.resetPending = false;
  }
  cancelFrame(): void { this.probeCache.cancelFrame(); this.reflectionCache.cancelFrame(); this.pendingProbes = undefined; this.resetPending = true; }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.composer.dispose(); this.reflectionCache.dispose(); this.probeCache.dispose(); for (const buffer of this.traceBuffers) buffer.destroy();
  }
}

/** Restricted selected-mirror experiment. Diagnostic resources remain internal. */
export class ReflectionRenderer {
  private constructor(private readonly raster: RasterRenderer, private readonly geometry: ReflectionGeometry, private readonly effect: ReflectionEffect) {}
  static async create(device: GPUDevice, format: GPUTextureFormat, options: ReflectionSceneOptions): Promise<ReflectionRenderer> {
    if (options.renderer !== 'reflections' || (options.cameraMode !== undefined && !['receiver', 'overview', 'tour'].includes(options.cameraMode))) {
      throw new StrataError('INVALID_OPTIONS', 'Reflection scenes require a supported camera mode.');
    }
    const scene = createReflectionScene(options); const effect = await ReflectionEffect.create(device, scene, options);
    let geometry: ReflectionGeometry | undefined;
    try {
      geometry = new ReflectionGeometry(device, scene, options.cameraMode ?? 'receiver');
      return new ReflectionRenderer(await RasterRenderer.create(device, format, {}, geometry, effect), geometry, effect);
    } catch (cause) { geometry?.dispose(); effect.dispose(); throw cause; }
  }
  get gpuBufferBytes(): number { return this.raster.gpuBufferBytes; }
  get gpuTextureBytes(): number { return this.raster.gpuTextureBytes; }
  get initialUploadBytes(): number { return this.raster.initialUploadBytes; }
  get giTelemetry(): GiTelemetry { return this.effect.giTelemetry; }
  get reflectionTelemetry(): ReflectionTelemetry { return this.effect.reflectionTelemetry; }
  get currentScene(): ReflectionSceneData { return this.effect.currentScene; }
  get currentCamera(): CameraFrame | undefined { return this.geometry.currentCamera; }
  get composer(): ReflectionComposer { return this.effect.composer; }
  get directTexture(): GPUTexture | undefined { return this.raster.directTexture; }
  get outputs(): RasterOutputs | undefined { return this.raster.outputs; }
  get probeCache(): ProbeCache { return this.effect.probeCache; }
  get reflectionCache(): ReflectionCache { return this.effect.reflectionCache; }
  get traceData(): GiTraceData { return this.effect.traceData; }
  passNames(controls: Controls = {}): readonly RasterPassName[] {
    const temporal = normalizeRasterControls(controls).temporal; validateGiControls(controls.gi);
    const reflections = this.effect.mergedControls(controls.reflections); const gi = controls.gi?.enabled ?? this.effect.giEnabled;
    const active = gi || reflections.mode !== 'off';
    return [...(gi ? ['gi-trace', 'gi-update'] as const : []), 'shadow', 'raster',
      ...(active ? [...(reflections.mode === 'world' ? ['reflection-trace', 'reflection-resolve'] as const : []), 'gi-shade'] as const : []),
      ...(temporal ? ['temporal'] as const : []), 'presentation'];
  }
  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number, timeSeconds: number,
    controls: Controls = {}, timestamps: RasterTimestamps = {}) {
    normalizeRasterControls(controls); const oldScene = this.effect.currentScene; const reset = this.effect.update(controls);
    if (oldScene !== this.effect.currentScene) this.geometry.setScene(this.effect.currentScene);
    return this.raster.encode(encoder, target, width, height, timeSeconds, { ...controls, cameraCut: controls.cameraCut || reset }, timestamps);
  }
  submitted(frameId: number): void { this.effect.submitted(frameId); }
  cancelFrame(): void { this.effect.cancelFrame(); }
  dispose(): void { this.raster.dispose(); }
}
