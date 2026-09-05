import { StrataError } from '../errors.js';
import { probeTraceShader, probeUpdateShader } from './probe-cache-shaders.js';
export { probeSamplingShader } from './probe-cache-shaders.js';

export const probeCacheLayout = Object.freeze({
  grid: [12, 4, 8] as const, origin: [-5.5, 0.5, -3.5] as const, spacing: 1,
  probeCount: 384, atlasColumns: 24, atlasRows: 16, irradianceTileSize: 8, visibilityTileSize: 16,
  irradianceWidth: 192, irradianceHeight: 128, visibilityWidth: 384, visibilityHeight: 256,
  stateStride: 16, rayStride: 32, statisticsBytes: 32, configBytes: 96, maxDistance: 32,
});
export interface ProbeCacheOptions { probesPerUpdate?: number; raysPerProbe?: number; hysteresis?: number; seed?: number }
export interface ProbeBindings {
  readonly irradiance: GPUTextureView;
  readonly visibility: GPUTextureView;
  readonly state: GPUBuffer;
  readonly uniform: GPUBuffer;
}
export interface ProbeFrame {
  readonly revision: number;
  readonly frameIndex: number;
  readonly reset?: boolean;
  readonly timestamps?: { readonly trace?: GPUComputePassTimestampWrites; readonly update?: GPUComputePassTimestampWrites };
}
interface Atlas { irradiance: GPUTexture; visibility: GPUTexture; irradianceView: GPUTextureView; visibilityView: GPUTextureView }
interface Pending { index: number; epoch: number; revision: number; frontier: number; frames: number; frameIndex: number; reset: boolean }

/** Fixed world-space irradiance cache. No screen-space inputs or native ray-tracing features. */
export class ProbeCache {
  private committedIndex = 0;
  private epoch = 0;
  private revision = -1;
  private frontier = 0;
  private frames = 0;
  private submittedFrames = 0;
  private sourceFrameId: number | null = null;
  private pending: Pending | undefined;
  private disposed = false;

  private constructor(private readonly device: GPUDevice,
    private readonly atlases: readonly Atlas[], private readonly configs: readonly GPUBuffer[],
    private readonly states: GPUBuffer, private readonly rays: GPUBuffer, private readonly statistics: GPUBuffer,
    private readonly tracePipeline: GPUComputePipeline, private readonly updatePipeline: GPUComputePipeline,
    private readonly traceBindings: readonly GPUBindGroup[], private readonly updateBindings: readonly GPUBindGroup[],
    private readonly sceneBindings: GPUBindGroup,
    readonly probesPerUpdate: number, readonly raysPerProbe: number, private readonly hysteresis: number, private readonly seed: number) {}

  static async create(device: GPUDevice, traceEntries: readonly GPUBindGroupEntry[], options: ProbeCacheOptions = {}): Promise<ProbeCache> {
    const probes = options.probesPerUpdate ?? 32; const rays = options.raysPerProbe ?? 64;
    const hysteresis = options.hysteresis ?? 0.85; const seed = options.seed ?? 1337;
    if (!Number.isInteger(probes) || probes < 1 || probes > 128 || !Number.isInteger(rays) || rays < 16 || rays > 128
      || !Number.isFinite(hysteresis) || hysteresis < 0 || hysteresis > 0.95 || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new StrataError('INVALID_OPTIONS', 'Probe cache requires 1..128 probes/update, 16..128 rays/probe, hysteresis 0..0.95 and a uint32 seed.');
    }
    if (traceEntries.length !== 5 || traceEntries.some((entry, index) => entry.binding !== index)) {
      throw new StrataError('INVALID_OPTIONS', 'Probe cache needs trace nodes, triangles, boxes, materials and uniform at bindings 0..4.');
    }
    const rayBytes = probes * rays * probeCacheLayout.rayStride;
    if (device.limits.maxTextureDimension2D < probeCacheLayout.visibilityWidth || rayBytes > device.limits.maxStorageBufferBindingSize
      || rayBytes > device.limits.maxBufferSize) throw new StrataError('UNSUPPORTED_LIMIT', 'The probe cache exceeds device texture/buffer limits.');
    const buffers: GPUBuffer[] = []; const textures: GPUTexture[] = [];
    try {
      const entry = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: 4, buffer: { type } });
      const traceLayout = device.createBindGroupLayout({ label: 'Strata probe trace layout', entries: [entry(0, 'uniform'), entry(1, 'storage'), entry(2, 'storage')] });
      const sceneLayout = device.createBindGroupLayout({ label: 'Strata probe scene layout', entries: [0, 1, 2, 3, 4].map(binding => entry(binding, binding === 4 ? 'uniform' : 'read-only-storage')) });
      const updateLayout = device.createBindGroupLayout({ label: 'Strata probe update layout', entries: [
        entry(0, 'uniform'), entry(1, 'read-only-storage'), entry(2, 'storage'),
        { binding: 3, visibility: 4, texture: { sampleType: 'float' } },
        { binding: 4, visibility: 4, texture: { sampleType: 'unfilterable-float' } },
        { binding: 5, visibility: 4, storageTexture: { access: 'write-only', format: 'rgba16float' } },
        { binding: 6, visibility: 4, storageTexture: { access: 'write-only', format: 'rg32float' } }, entry(7, 'storage'),
      ] });
      const [tracePipeline, updatePipeline] = await Promise.all([
        device.createComputePipelineAsync({ label: 'Strata one-bounce software probe trace',
          layout: device.createPipelineLayout({ bindGroupLayouts: [traceLayout, sceneLayout] }),
          compute: { module: device.createShaderModule({ label: 'Strata probe tracing shader', code: probeTraceShader() }), entryPoint: 'probeTrace' } }),
        device.createComputePipelineAsync({ label: 'Strata visibility-aware probe integration',
          layout: device.createPipelineLayout({ bindGroupLayouts: [updateLayout] }),
          compute: { module: device.createShaderModule({ label: 'Strata probe integration shader', code: probeUpdateShader }), entryPoint: 'probeUpdate' } }),
      ]);
      const makeBuffer = (label: string, size: number, usage: number): GPUBuffer => {
        const buffer = device.createBuffer({ label, size, usage: usage | 0x4 | 0x8 }); buffers.push(buffer); return buffer;
      };
      const configs = [0, 1].map(index => makeBuffer(`Strata probe config ${index}`, probeCacheLayout.configBytes, 0x40));
      const states = makeBuffer('Strata probe epoch validity and age', probeCacheLayout.probeCount * probeCacheLayout.stateStride, 0x80);
      const rayBuffer = makeBuffer('Strata probe ray radiance distance and status', rayBytes, 0x80);
      const statistics = makeBuffer('Strata probe trace and update diagnostics', probeCacheLayout.statisticsBytes, 0x80);
      const makeTexture = (label: string, width: number, height: number, format: GPUTextureFormat): GPUTexture => {
        const texture = device.createTexture({ label, size: [width, height], format, usage: 0x1 | 0x2 | 0x4 | 0x8 }); textures.push(texture); return texture;
      };
      const atlases = [0, 1].map(index => {
        const irradiance = makeTexture(`Strata probe irradiance ${index}`, 192, 128, 'rgba16float');
        const visibility = makeTexture(`Strata probe visibility moments ${index}`, 384, 256, 'rg32float');
        return { irradiance, visibility, irradianceView: irradiance.createView(), visibilityView: visibility.createView() };
      });
      const bind = (binding: number, buffer: GPUBuffer): GPUBindGroupEntry => ({ binding, resource: { buffer } });
      const traceBindings = configs.map(config => device.createBindGroup({ label: 'Strata probe trace resources', layout: traceLayout,
        entries: [bind(0, config), bind(1, rayBuffer), bind(2, statistics)] }));
      const updateBindings = configs.map((config, index) => device.createBindGroup({ label: 'Strata probe atlas resources', layout: updateLayout, entries: [
        bind(0, config), bind(1, rayBuffer), bind(2, states),
        { binding: 3, resource: atlases[1 - index]!.irradianceView }, { binding: 4, resource: atlases[1 - index]!.visibilityView },
        { binding: 5, resource: atlases[index]!.irradianceView }, { binding: 6, resource: atlases[index]!.visibilityView }, bind(7, statistics),
      ] }));
      const sceneBindings = device.createBindGroup({ label: 'Strata probe trace scene', layout: sceneLayout, entries: [...traceEntries] });
      return new ProbeCache(device, atlases, configs, states, rayBuffer, statistics, tracePipeline, updatePipeline,
        traceBindings, updateBindings, sceneBindings, probes, rays, hysteresis, seed);
    } catch (cause) { for (const resource of [...buffers, ...textures]) resource.destroy(); throw cause; }
  }

  get gpuBufferBytes(): number { return this.disposed ? 0 : 2 * 96 + 384 * 16 + this.probesPerUpdate * this.raysPerProbe * 32 + 32; }
  get gpuTextureBytes(): number { return this.disposed ? 0 : 2 * (192 * 128 * 8 + 384 * 256 * 8); }
  get initialUploadBytes(): number { return 0; }
  private frameBindings(index: number): ProbeBindings {
    return { irradiance: this.atlases[index]!.irradianceView, visibility: this.atlases[index]!.visibilityView, state: this.states, uniform: this.configs[index]! };
  }
  get bindings(): ProbeBindings { return this.frameBindings(this.committedIndex); }
  /** Internal test/debug handles; all buffers/textures support COPY_SRC. */
  get diagnostics(): {
    rayBuffer: GPUBuffer; stateBuffer: GPUBuffer; statisticsBuffer: GPUBuffer; configBuffer: GPUBuffer;
    irradianceTexture: GPUTexture; visibilityTexture: GPUTexture; layout: typeof probeCacheLayout;
  } {
    const index = this.pending?.index ?? this.committedIndex;
    return { rayBuffer: this.rays, stateBuffer: this.states, statisticsBuffer: this.statistics, configBuffer: this.configs[index]!,
      irradianceTexture: this.atlases[index]!.irradiance, visibilityTexture: this.atlases[index]!.visibility, layout: probeCacheLayout };
  }
  get telemetry(): Readonly<Record<string, number | boolean | null>> {
    return { sourceFrameId: this.sourceFrameId, worldRevision: this.revision, cacheEpoch: this.epoch, probeCount: 384,
      probesPerUpdate: this.probesPerUpdate, raysPerProbe: this.raysPerProbe,
      primaryRaysPerFrame: this.probesPerUpdate * this.raysPerProbe, maxShadowRaysPerFrame: this.probesPerUpdate * this.raysPerProbe,
      updatePeriodFrames: Math.ceil(384 / this.probesPerUpdate), framesSinceReset: this.frames,
      probeUpdatesSinceReset: this.frames * this.probesPerUpdate, submittedFrames: this.submittedFrames,
      primaryRaysSubmitted: this.submittedFrames * this.probesPerUpdate * this.raysPerProbe,
      validProbeCount: null, traceFailures: null, hysteresis: this.hysteresis, maxTraceDistance: 32 };
  }

  encode(encoder: GPUCommandEncoder, frame: ProbeFrame): { bindings: ProbeBindings; dispatchCalls: number; uploadBytes: number; primaryRays: number; probeUpdates: number } {
    if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'Probe cache was disposed.');
    if (![frame.revision, frame.frameIndex].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)
      || (frame.reset !== undefined && typeof frame.reset !== 'boolean')) throw new StrataError('INVALID_OPTIONS', 'Probe revision/frame index must be uint32.');
    this.cancelFrame();
    const reset = this.revision !== frame.revision || frame.reset === true;
    const epoch = reset ? this.epoch + 1 : this.epoch;
    if (epoch > 0xffffffff) throw new StrataError('UNSUPPORTED_LIMIT', 'Probe epoch exhausted; recreate this scene.');
    const start = reset ? 0 : this.frontier; const index = 1 - this.committedIndex;
    const data = new ArrayBuffer(96); const floats = new Float32Array(data); const words = new Uint32Array(data);
    floats.set([-5.5, 0.5, -3.5, 1], 0); words.set([12, 4, 8, 384], 4);
    words.set([start, this.probesPerUpdate, this.raysPerProbe, epoch], 8);
    floats.set([this.hysteresis, 32, 0.12, 32], 12);
    words.set([frame.frameIndex, reset ? 1 : 0, this.seed, 0], 16); words.set([24, 8, 16, 0], 20);
    this.device.queue.writeBuffer(this.configs[index]!, 0, data);
    this.device.queue.writeBuffer(this.statistics, 0, new Uint32Array(8));
    // Copy preserves probes outside this frame's finite update window.
    encoder.copyTextureToTexture({ texture: this.atlases[this.committedIndex]!.irradiance }, { texture: this.atlases[index]!.irradiance }, [192, 128]);
    encoder.copyTextureToTexture({ texture: this.atlases[this.committedIndex]!.visibility }, { texture: this.atlases[index]!.visibility }, [384, 256]);
    const trace = encoder.beginComputePass({ label: 'Strata GI software probe trace', ...(frame.timestamps?.trace ? { timestampWrites: frame.timestamps.trace } : {}) });
    trace.setPipeline(this.tracePipeline); trace.setBindGroup(0, this.traceBindings[index]!); trace.setBindGroup(1, this.sceneBindings);
    trace.dispatchWorkgroups(Math.ceil(this.probesPerUpdate * this.raysPerProbe / 64)); trace.end();
    const update = encoder.beginComputePass({ label: 'Strata GI irradiance and visibility update', ...(frame.timestamps?.update ? { timestampWrites: frame.timestamps.update } : {}) });
    update.setPipeline(this.updatePipeline); update.setBindGroup(0, this.updateBindings[index]!); update.dispatchWorkgroups(this.probesPerUpdate); update.end();
    this.pending = { index, epoch, revision: frame.revision, frontier: (start + this.probesPerUpdate) % 384,
      frames: reset ? 1 : this.frames + 1, frameIndex: frame.frameIndex, reset };
    return { bindings: this.frameBindings(index), dispatchCalls: 2, uploadBytes: 128,
      primaryRays: this.probesPerUpdate * this.raysPerProbe, probeUpdates: this.probesPerUpdate };
  }
  submitted(frameId: number): void {
    if (!this.pending || this.disposed) return;
    const pending = this.pending; this.pending = undefined;
    this.committedIndex = pending.index; this.epoch = pending.epoch; this.revision = pending.revision;
    this.frontier = pending.frontier; this.frames = pending.frames; this.sourceFrameId = frameId; this.submittedFrames++;
  }
  cancelFrame(): void { this.pending = undefined; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.pending = undefined;
    for (const buffer of [...this.configs, this.states, this.rays, this.statistics]) buffer.destroy();
    for (const atlas of this.atlases) { atlas.irradiance.destroy(); atlas.visibility.destroy(); }
  }
}
