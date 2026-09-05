import { StrataError } from '../errors.js';
import { RasterRenderer, normalizeRasterControls } from '../rendering/raster-renderer.js';
import type { RasterGiProvider } from '../rendering/gi-provider.js';
import type { CameraFrame } from '../rendering/raster-math.js';
import type { RasterControls, RasterOutputs, RasterPassName, RasterTimestamps } from '../rendering/raster-types.js';
import type { SceneFrameStats } from '../rendering/scene-renderer.js';
import { createGiScene } from './scene-data.js';
import type { GiSceneData } from './scene-data.js';
import { buildGiTraceData, refitGiTraceData } from './trace-data.js';
import type { GiTraceData } from './trace-data.js';
import { ProbeCache } from './probe-cache.js';
import type { ProbeBindings } from './probe-cache.js';
import { GiComposer } from './gi-composer.js';
import { RoomGeometry } from './room-geometry.js';
import type { GiControls, GiSceneOptions, GiTelemetry } from './gi-types.js';

export function validateGiControls(controls: GiControls | undefined): void {
  if (controls === undefined) return;
  if (!controls || typeof controls !== 'object' || Array.isArray(controls)
    || (controls.enabled !== undefined && typeof controls.enabled !== 'boolean')
    || (controls.resetCache !== undefined && typeof controls.resetCache !== 'boolean')
    || (controls.doorOpen !== undefined && typeof controls.doorOpen !== 'boolean')
    || (controls.wallColor !== undefined && !['red', 'neutral'].includes(controls.wallColor))
    || (controls.lightIntensity !== undefined && (!Number.isFinite(controls.lightIntensity) || controls.lightIntensity < 0 || controls.lightIntensity > 8))) {
    throw new StrataError('INVALID_OPTIONS', 'Invalid GI enable, reset, door, wall color or light controls.');
  }
}

function traceArrays(data: GiTraceData): readonly ArrayBuffer[] {
  return [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData];
}

class GiEffect implements RasterGiProvider {
  active = true;
  private revision = 1;
  private frames = 0;
  private traceDirty = false;
  private pendingBindings: ProbeBindings | undefined;
  private disposed = false;

  private constructor(private readonly device: GPUDevice, readonly traceData: GiTraceData,
    private readonly traceBuffers: readonly GPUBuffer[], readonly probeCache: ProbeCache, readonly composer: GiComposer,
    private scene: GiSceneData) {}

  static async create(device: GPUDevice, scene: GiSceneData, options: GiSceneOptions): Promise<GiEffect> {
    const data = buildGiTraceData(scene); const buffers: GPUBuffer[] = [];
    let cache: ProbeCache | undefined; let composer: GiComposer | undefined;
    try {
      for (const [index, bytes] of traceArrays(data).entries()) {
        if (bytes.byteLength > device.limits.maxBufferSize || (index < 4 && bytes.byteLength > device.limits.maxStorageBufferBindingSize)) {
          throw new StrataError('UNSUPPORTED_LIMIT', 'GI tracing geometry exceeds device buffer limits.');
        }
        const buffer = device.createBuffer({ label: `Strata GI trace data ${index}`, size: bytes.byteLength, usage: (index === 4 ? 0x40 : 0x80) | 0x8 | 0x4 });
        buffers.push(buffer); device.queue.writeBuffer(buffer, 0, bytes);
      }
      const entries = buffers.map((buffer, binding) => ({ binding, resource: { buffer } }));
      cache = await ProbeCache.create(device, entries, {
        ...(options.probesPerUpdate === undefined ? {} : { probesPerUpdate: options.probesPerUpdate }),
        ...(options.raysPerProbe === undefined ? {} : { raysPerProbe: options.raysPerProbe }),
      });
      composer = await GiComposer.create(device, entries);
      return new GiEffect(device, data, buffers, cache, composer, scene);
    } catch (cause) { composer?.dispose(); cache?.dispose(); for (const buffer of buffers) buffer.destroy(); throw cause; }
  }
  get currentScene(): GiSceneData { return this.scene; }
  get gpuBufferBytes(): number { return this.disposed ? 0 : this.traceData.gpuBufferBytes + this.probeCache.gpuBufferBytes + this.composer.gpuBufferBytes; }
  get gpuTextureBytes(): number { return this.disposed ? 0 : this.probeCache.gpuTextureBytes + this.composer.gpuTextureBytes; }
  get initialUploadBytes(): number { return this.traceData.gpuBufferBytes + this.probeCache.initialUploadBytes; }
  get telemetry(): GiTelemetry {
    return { ...this.probeCache.telemetry, enabled: this.active, worldRevision: this.revision,
      doorOpen: this.scene.state.doorOpen, wallColor: this.scene.state.wallColor, lightIntensity: this.scene.state.lightIntensity,
      traceRepresentation: 'triangle-bvh-v1', traceGeometryBytes: this.traceData.gpuBufferBytes,
      cacheBufferBytes: this.probeCache.gpuBufferBytes, cacheTextureBytes: this.probeCache.gpuTextureBytes,
      composeBufferBytes: this.composer.gpuBufferBytes, composeTextureBytes: this.composer.gpuTextureBytes,
      primaryRaysPerFrame: this.active ? this.probeCache.probesPerUpdate * this.probeCache.raysPerProbe : 0,
      maxShadowRaysPerFrame: this.active ? this.probeCache.probesPerUpdate * this.probeCache.raysPerProbe : 0,
    };
  }
  update(controls: GiControls = {}): boolean {
    validateGiControls(controls);
    const changed = (controls.doorOpen !== undefined && controls.doorOpen !== this.scene.state.doorOpen)
      || (controls.wallColor !== undefined && controls.wallColor !== this.scene.state.wallColor)
      || (controls.lightIntensity !== undefined && controls.lightIntensity !== this.scene.state.lightIntensity);
    const toggled = controls.enabled !== undefined && controls.enabled !== this.active;
    if (controls.enabled !== undefined) this.active = controls.enabled;
    if (changed || controls.resetCache || (toggled && this.active)) {
      if (this.revision === 0xffffffff) throw new StrataError('UNSUPPORTED_LIMIT', 'GI world revisions exhausted; recreate this scene.');
      this.revision++;
    }
    if (changed) {
      const next = createGiScene({ doorOpen: controls.doorOpen ?? this.scene.state.doorOpen,
        wallColor: controls.wallColor ?? this.scene.state.wallColor, lightIntensity: controls.lightIntensity ?? this.scene.state.lightIntensity });
      refitGiTraceData(this.traceData, next); this.scene = next; this.traceDirty = true;
    }
    return changed || Boolean(controls.resetCache) || toggled;
  }
  prepare(encoder: GPUCommandEncoder, _camera: CameraFrame, _width: number, _height: number, _time: number, timestamps: RasterTimestamps) {
    let uploadBytes = 0;
    if (this.traceDirty) {
      for (const [index, bytes] of traceArrays(this.traceData).entries()) this.device.queue.writeBuffer(this.traceBuffers[index]!, 0, bytes);
      uploadBytes += this.traceData.gpuBufferBytes; this.traceDirty = false;
    }
    const prepared = this.probeCache.encode(encoder, { revision: this.revision, frameIndex: this.frames,
      timestamps: { ...(timestamps['gi-trace'] ? { trace: timestamps['gi-trace'] } : {}), ...(timestamps['gi-update'] ? { update: timestamps['gi-update'] } : {}) },
    });
    this.pendingBindings = prepared.bindings;
    return { uploadBytes: uploadBytes + prepared.uploadBytes, dispatchCalls: prepared.dispatchCalls };
  }
  compose(encoder: GPUCommandEncoder, outputs: RasterOutputs, camera: CameraFrame, width: number, height: number,
    _time: number, controls: RasterControls, timestamps: RasterTimestamps) {
    if (!this.pendingBindings) throw new StrataError('RENDER_FAILED', 'GI cache was not prepared for composition.');
    return this.composer.encode(encoder, outputs, camera, width, height, controls, this.pendingBindings, timestamps['gi-shade']);
  }
  submitted(frameId: number): void { this.probeCache.submitted(frameId); this.pendingBindings = undefined; this.frames++; }
  cancelFrame(): void { this.probeCache.cancelFrame(); this.pendingBindings = undefined; }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.composer.dispose(); this.probeCache.dispose();
    for (const buffer of this.traceBuffers) buffer.destroy();
  }
}

/** Two-room world-space GI proof. Internal diagnostic handles are not exported by the public package. */
export class GiRenderer {
  private constructor(private readonly raster: RasterRenderer, private readonly room: RoomGeometry, private readonly effect: GiEffect) {}
  static async create(device: GPUDevice, format: GPUTextureFormat, options: GiSceneOptions): Promise<GiRenderer> {
    if (options.renderer !== 'gi' || (options.cameraMode !== undefined && !['receiver', 'overview', 'tour'].includes(options.cameraMode))) {
      throw new StrataError('INVALID_OPTIONS', 'GI scenes require a supported camera mode.');
    }
    const scene = createGiScene(options);
    const effect = await GiEffect.create(device, scene, options);
    let room: RoomGeometry | undefined;
    try {
      room = new RoomGeometry(device, scene, options.cameraMode ?? 'receiver');
      const raster = await RasterRenderer.create(device, format, {}, room, effect);
      return new GiRenderer(raster, room, effect);
    } catch (cause) { room?.dispose(); effect.dispose(); throw cause; }
  }
  get gpuBufferBytes(): number { return this.raster.gpuBufferBytes; }
  get gpuTextureBytes(): number { return this.raster.gpuTextureBytes; }
  get initialUploadBytes(): number { return this.raster.initialUploadBytes; }
  get giTelemetry(): GiTelemetry { return this.effect.telemetry; }
  get currentScene(): GiSceneData { return this.effect.currentScene; }
  get currentCamera(): CameraFrame | undefined { return this.room.currentCamera; }
  get composer(): GiComposer { return this.effect.composer; }
  get directTexture(): GPUTexture | undefined { return this.raster.directTexture; }
  get probeCache(): ProbeCache { return this.effect.probeCache; }
  get traceData(): GiTraceData { return this.effect.traceData; }
  passNames(controls: RasterControls & { gi?: GiControls } = {}): readonly RasterPassName[] {
    validateGiControls(controls.gi); const enabled = controls.gi?.enabled ?? this.effect.active;
    return [...(enabled ? ['gi-trace', 'gi-update'] as const : []), 'shadow', 'raster',
      ...(enabled ? ['gi-shade'] as const : []), ...(normalizeRasterControls(controls).temporal ? ['temporal'] as const : []), 'presentation'];
  }
  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number, timeSeconds: number,
    controls: RasterControls & { gi?: GiControls } = {}, timestamps: RasterTimestamps = {}): SceneFrameStats {
    const oldScene = this.effect.currentScene;
    const reset = this.effect.update(controls.gi);
    if (oldScene !== this.effect.currentScene) this.room.setScene(this.effect.currentScene);
    return this.raster.encode(encoder, target, width, height, timeSeconds, { ...controls, cameraCut: controls.cameraCut || reset }, timestamps);
  }
  submitted(frameId: number): void { this.effect.submitted(frameId); }
  cancelFrame(): void { this.effect.cancelFrame(); }
  dispose(): void { this.raster.dispose(); }
}
