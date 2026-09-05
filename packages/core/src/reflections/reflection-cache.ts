import { StrataError } from '../errors.js';
import type { CameraFrame } from '../rendering/raster-math.js';
import type { RasterOutputs } from '../rendering/raster-types.js';
import type { ProbeBindings } from '../gi/probe-cache.js';
import { invertGiMatrix } from '../gi/room-geometry.js';
import { reflectionSurface } from './reflection-scene.js';
import type { ReflectionControls } from './reflection-types.js';
import { normalizeReflectionControls, reflectionCandidateRegion } from './reflection-reference.js';
import type { NormalizedReflectionControls, ReflectionRegion } from './reflection-reference.js';
import { reflectionTraceShader, reflectionResolveShader } from './reflection-shaders.js';
export { reflectionSamplingShader } from './reflection-shaders.js';
export { normalizeReflectionControls } from './reflection-reference.js';
export type { NormalizedReflectionControls } from './reflection-reference.js';

export const reflectionCacheLayout = Object.freeze({ configBytes: 240, statisticsBytes: 32, textureBytesPerPixel: 88,
  historyWeight: 0.8, maxHistoryAge: 16, defaultResolutionScale: 0.25, defaultRayBudget: 32768, maximumRayBudget: 131072 });
export interface ReflectionCacheOptions { resolutionScale?: 0.25 | 0.5 | 1; maxRaysPerFrame?: number }
/** Four entries matching samplingLayout. Identity changes on resize; do not cache by uniform alone. */
export interface ReflectionBindings { readonly entries: readonly GPUBindGroupEntry[] }
export interface ReflectionFrame {
  outputs: RasterOutputs; camera: CameraFrame; width: number; height: number;
  frameIndex: number; worldRevision: number; controls: ReflectionControls; reset?: boolean;
  probes: ProbeBindings; giEnabled: boolean;
  timestamps?: { trace?: GPUComputePassTimestampWrites; resolve?: GPUComputePassTimestampWrites };
}
interface Texture { texture: GPUTexture; view: GPUTextureView }
interface Bank { radiance: Texture; surface: Texture; metadata: Texture; bindings: ReflectionBindings }
interface Targets { width: number; height: number; raw: Texture; rawMetadata: Texture; banks: readonly Bank[]; textures: readonly GPUTexture[] }
interface Pending {
  index: number; key: string; scheduleKey: string; epoch: number; frameIndex: number; worldRevision: number; frames: number;
  frontier: number; candidates: number; region: ReflectionRegion; controls: NormalizedReflectionControls; maxAge: number;
}

/** Finite selected-surface tracing and independent specular history. No per-frame readbacks. */
export class ReflectionCache {
  private targets: Targets | undefined;
  private committedIndex = 0;
  private epoch = 0;
  private frames = 0;
  private frontier = 0;
  private key = '';
  private scheduleKey = '';
  private frameIndex = -1;
  private worldRevision = 0;
  private sourceFrameId: number | null = null;
  private submittedFrames = 0;
  private traceFrames = 0;
  private totalCandidates = 0;
  private candidates = 0;
  private region: ReflectionRegion = { x: 0, y: 0, width: 0, height: 0 };
  private maxAge: number = reflectionCacheLayout.maxHistoryAge;
  private controls = normalizeReflectionControls();
  private pending: Pending | undefined;
  private source: RasterOutputs | undefined;
  private traceGroups: readonly GPUBindGroup[] | undefined;
  private resolveGroups: readonly GPUBindGroup[] | undefined;
  private readonly probeGroups = new Map<GPUBuffer, GPUBindGroup>();
  private disposed = false;

  private constructor(private readonly device: GPUDevice, private readonly configs: readonly GPUBuffer[],
    private readonly statistics: GPUBuffer, private readonly tracePipeline: GPUComputePipeline, private readonly resolvePipeline: GPUComputePipeline,
    private readonly traceLayout: GPUBindGroupLayout, private readonly resolveLayout: GPUBindGroupLayout,
    private readonly sceneGroup: GPUBindGroup, private readonly probeLayout: GPUBindGroupLayout,
    readonly samplingLayout: GPUBindGroupLayout, readonly resolutionScale: 0.25 | 0.5 | 1, readonly maxRaysPerFrame: number) {}

  static async create(device: GPUDevice, traceEntries: readonly GPUBindGroupEntry[], options: ReflectionCacheOptions = {}): Promise<ReflectionCache> {
    if (!options || typeof options !== 'object' || Array.isArray(options) || options.resolutionScale === null || options.maxRaysPerFrame === null) {
      throw new StrataError('INVALID_OPTIONS', 'Reflection cache options must be an object with non-null values.');
    }
    const scale = options.resolutionScale ?? 0.25; const budget = options.maxRaysPerFrame ?? 32768;
    if (![0.25, 0.5, 1].includes(scale) || !Number.isInteger(budget) || budget < 1 || budget > 131072
      || traceEntries.length !== 5 || traceEntries.some((entry, index) => entry.binding !== index)) {
      throw new StrataError('INVALID_OPTIONS', 'Reflections require scale 0.25/0.5/1, 1..131072 rays and five ordered trace bindings.');
    }
    if (device.limits.maxBufferSize < 240 || device.limits.maxStorageBufferBindingSize < 32) throw new StrataError('UNSUPPORTED_LIMIT', 'Reflection uniforms/statistics exceed device limits.');
    const buffer = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: 4, buffer: { type } });
    const texture = (binding: number, sampleType: GPUTextureSampleType): GPUBindGroupLayoutEntry => ({ binding, visibility: 4, texture: { sampleType } });
    const storage = (binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry => ({ binding, visibility: 4, storageTexture: { access: 'write-only', format } });
    const traceLayout = device.createBindGroupLayout({ label: 'Strata reflection trace inputs', entries: [buffer(0, 'uniform'), texture(1, 'depth'),
      texture(2, 'float'), texture(3, 'float'), texture(4, 'float'), storage(5, 'rgba16float'), storage(6, 'rgba32uint'), buffer(7, 'storage')] });
    const resolveLayout = device.createBindGroupLayout({ label: 'Strata reflection resolve inputs', entries: [buffer(0, 'uniform'), texture(1, 'float'),
      texture(2, 'float'), texture(3, 'float'), texture(4, 'float'), texture(5, 'uint'), texture(6, 'float'), texture(7, 'float'), texture(8, 'uint'),
      storage(9, 'rgba16float'), storage(10, 'rgba16float'), storage(11, 'rgba32uint'), buffer(12, 'storage')] });
    const sceneLayout = device.createBindGroupLayout({ label: 'Strata reflection trace scene', entries: [0, 1, 2, 3, 4].map(binding => buffer(binding, binding === 4 ? 'uniform' : 'read-only-storage')) });
    const probeLayout = device.createBindGroupLayout({ label: 'Strata reflection hit irradiance', entries: [texture(0, 'float'), texture(1, 'unfilterable-float'), buffer(2, 'read-only-storage'), buffer(3, 'uniform')] });
    const samplingLayout = device.createBindGroupLayout({ label: 'Strata reflection sampling', entries: [texture(0, 'float'), texture(1, 'float'), texture(2, 'uint'), buffer(3, 'uniform')] });
    const [tracePipeline, resolvePipeline] = await Promise.all([
      device.createComputePipelineAsync({ label: 'Strata bounded software reflections', layout: device.createPipelineLayout({ bindGroupLayouts: [traceLayout, sceneLayout, probeLayout] }),
        compute: { module: device.createShaderModule({ label: 'Strata reflection trace WGSL', code: reflectionTraceShader }), entryPoint: 'reflectionTrace' } }),
      device.createComputePipelineAsync({ label: 'Strata reflection history resolve', layout: device.createPipelineLayout({ bindGroupLayouts: [resolveLayout] }),
        compute: { module: device.createShaderModule({ label: 'Strata reflection resolve WGSL', code: reflectionResolveShader }), entryPoint: 'reflectionResolve' } }),
    ]);
    const buffers: GPUBuffer[] = []; let cache: ReflectionCache | undefined;
    try {
      const create = (label: string, size: number, usage: number): GPUBuffer => {
        const value = device.createBuffer({ label, size, usage: usage | 0x4 | 0x8 }); buffers.push(value); return value;
      };
      const configs = [0, 1].map(index => create(`Strata reflection configuration ${index}`, 240, 0x40));
      const statistics = create('Strata reflection diagnostics', 32, 0x80);
      const sceneGroup = device.createBindGroup({ label: 'Strata reflection BVH resources', layout: sceneLayout, entries: [...traceEntries] });
      cache = new ReflectionCache(device, configs, statistics, tracePipeline, resolvePipeline, traceLayout, resolveLayout, sceneGroup, probeLayout, samplingLayout, scale, budget);
      cache.resize(1, 1); return cache;
    } catch (cause) { if (cache) cache.dispose(); else for (const resource of buffers) resource.destroy(); throw cause; }
  }

  private resize(width: number, height: number): void {
    if (this.targets?.width === width && this.targets.height === height) return;
    const textures: GPUTexture[] = [];
    const make = (label: string, format: GPUTextureFormat): Texture => {
      const texture = this.device.createTexture({ label, size: [width, height], format, usage: 0x1 | 0x4 | 0x8 });
      textures.push(texture); return { texture, view: texture.createView() };
    };
    let targets: Targets;
    try {
      const raw = make('Strata raw reflection radiance and hit distance', 'rgba16float');
      const rawMetadata = make('Strata raw reflection source frame epoch mask', 'rgba32uint');
      const banks = [0, 1].map(index => {
        const radiance = make(`Strata reflection radiance and surface depth ${index}`, 'rgba16float');
        const surface = make(`Strata reflection normal and roughness ${index}`, 'rgba16float');
        const metadata = make(`Strata reflection source freshness epoch mask ${index}`, 'rgba32uint');
        return { radiance, surface, metadata, bindings: { entries: [
          { binding: 0, resource: radiance.view }, { binding: 1, resource: surface.view }, { binding: 2, resource: metadata.view },
          { binding: 3, resource: { buffer: this.configs[index]! } },
        ] } };
      });
      targets = { width, height, raw, rawMetadata, banks, textures };
    } catch (cause) { for (const texture of textures) texture.destroy(); throw cause; }
    for (const texture of this.targets?.textures ?? []) texture.destroy();
    this.targets = targets; this.committedIndex = 0; this.source = undefined; this.traceGroups = undefined; this.resolveGroups = undefined;
  }

  get bindings(): ReflectionBindings { return this.targets!.banks[this.committedIndex]!.bindings; }
  get initialUploadBytes(): number { return 0; }
  get gpuBufferBytes(): number { return this.disposed ? 0 : 512; }
  get gpuTextureBytes(): number { return this.disposed ? 0 : this.targets!.width * this.targets!.height * 88; }
  get telemetry(): Readonly<Record<string, number | string | boolean | null>> {
    return { sourceFrameId: this.sourceFrameId, worldRevision: this.worldRevision, cacheEpoch: this.epoch, mode: this.controls.mode,
      resolutionScale: this.resolutionScale, reflectionWidth: this.targets?.width ?? 0, reflectionHeight: this.targets?.height ?? 0,
      roughness: this.controls.roughness, maxDistance: this.controls.maxDistance, updateEvery: this.controls.updateEvery,
      maxRaysPerFrame: this.maxRaysPerFrame, scheduledCandidates: this.candidates, candidateRegionPixels: this.region.width * this.region.height,
      maxPrimaryRays: this.candidates, maxShadowRays: this.candidates, framesSinceReset: this.frames,
      submittedFrames: this.submittedFrames, traceFrames: this.traceFrames, totalScheduledCandidates: this.totalCandidates,
      maxHistoryAge: this.maxAge, actualPrimaryRays: null, actualShadowRays: null, traceFailures: null, historyReusedPixels: null,
      screenTracing: false, gpuBufferBytes: this.gpuBufferBytes, gpuTextureBytes: this.gpuTextureBytes };
  }
  /** statistics u32[8]: candidate slots, primary rays, shadow rays, hits, misses, failures, reused pixels, fallback pixels. */
  get diagnostics() {
    const index = this.pending?.index ?? this.committedIndex; const bank = this.targets!.banks[index]!;
    return { rawTexture: this.targets!.raw.texture, rawMetadataTexture: this.targets!.rawMetadata.texture,
      radianceTexture: bank.radiance.texture, surfaceTexture: bank.surface.texture, metadataTexture: bank.metadata.texture,
      configBuffer: this.configs[index]!, statisticsBuffer: this.statistics, layout: reflectionCacheLayout };
  }

  private bindSources(outputs: RasterOutputs): void {
    if (this.source === outputs && this.traceGroups && this.resolveGroups) return;
    const targets = this.targets!; const bind = (binding: number, buffer: GPUBuffer): GPUBindGroupEntry => ({ binding, resource: { buffer } });
    const traceGroups = this.configs.map(config => this.device.createBindGroup({ label: 'Strata reflection trace frame', layout: this.traceLayout, entries: [
      bind(0, config), { binding: 1, resource: outputs.depth }, { binding: 2, resource: outputs.normal }, { binding: 3, resource: outputs.material },
      { binding: 4, resource: outputs.motion }, { binding: 5, resource: targets.raw.view }, { binding: 6, resource: targets.rawMetadata.view }, bind(7, this.statistics),
    ] }));
    const resolveGroups = this.configs.map((config, index) => {
      const previous = targets.banks[1 - index]!; const next = targets.banks[index]!;
      return this.device.createBindGroup({ label: 'Strata reflection history frame', layout: this.resolveLayout, entries: [bind(0, config),
        { binding: 1, resource: outputs.normal }, { binding: 2, resource: outputs.material }, { binding: 3, resource: outputs.motion },
        { binding: 4, resource: targets.raw.view }, { binding: 5, resource: targets.rawMetadata.view }, { binding: 6, resource: previous.radiance.view },
        { binding: 7, resource: previous.surface.view }, { binding: 8, resource: previous.metadata.view }, { binding: 9, resource: next.radiance.view },
        { binding: 10, resource: next.surface.view }, { binding: 11, resource: next.metadata.view }, bind(12, this.statistics)] });
    });
    this.traceGroups = traceGroups; this.resolveGroups = resolveGroups; this.source = outputs;
  }

  encode(encoder: GPUCommandEncoder, input: ReflectionFrame): { bindings: ReflectionBindings; dispatchCalls: number; uploadBytes: number } {
    if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'Reflection cache is disposed.');
    if (![input.width, input.height].every(value => Number.isInteger(value) && value > 0 && value <= this.device.limits.maxTextureDimension2D)
      || ![input.frameIndex, input.worldRevision].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)
      || typeof input.giEnabled !== 'boolean' || (input.reset !== undefined && typeof input.reset !== 'boolean')) throw new StrataError('INVALID_OPTIONS', 'Invalid reflection dimensions, frame, revision or GI state.');
    const controls = normalizeReflectionControls(input.controls); this.cancelFrame();
    const width = Math.max(1, Math.ceil(input.width * this.resolutionScale)); const height = Math.max(1, Math.ceil(input.height * this.resolutionScale));
    const scheduleKey = [width, height, input.worldRevision, input.giEnabled, controls.mode, controls.roughness, controls.maxDistance, controls.updateEvery,
      controls.objectOffset].join(',');
    const key = [scheduleKey, ...input.camera.view].join(','); // View motion invalidates reflected parallax; projection jitter does not.
    const resized = controls.mode === 'world' && (this.targets?.width !== width || this.targets.height !== height);
    const resetSchedule = input.reset === true || controls.resetHistory || resized || scheduleKey !== this.scheduleKey || input.frameIndex <= this.frameIndex;
    const reset = resetSchedule || key !== this.key;
    const epoch = reset ? this.epoch + 1 : this.epoch;
    if (epoch > 0xffffffff) throw new StrataError('UNSUPPORTED_LIMIT', 'Reflection epoch exhausted; recreate the scene.');
    if (controls.mode === 'world') this.resize(width, height);
    const targets = this.targets!; const index = 1 - this.committedIndex; const frames = reset ? 1 : this.frames + 1;
    const region = controls.mode === 'world' ? reflectionCandidateRegion(input.camera, width, height, reflectionSurface) : { x: 0, y: 0, width: 0, height: 0 };
    const regionPixels = region.width * region.height; const update = controls.mode === 'world' && (reset || (frames - 1) % controls.updateEvery === 0);
    const candidates = update ? Math.min(this.maxRaysPerFrame, regionPixels) : 0;
    // Camera-only resets discard stale radiance but keep rotation fair when the quota cannot cover the region.
    const start = resetSchedule || regionPixels === 0 ? 0 : this.frontier % regionPixels;
    const frontier = regionPixels ? (start + candidates) % regionPixels : 0;
    const maxAge = Math.min(16, Math.max(controls.updateEvery, Math.ceil(regionPixels / this.maxRaysPerFrame) * controls.updateEvery));
    const data = new ArrayBuffer(240); const floats = new Float32Array(data); const words = new Uint32Array(data);
    floats.set(invertGiMatrix(input.camera.viewProjection), 0); floats.set(input.camera.view, 16); floats.set(input.camera.eye, 32);
    words.set([width, height, input.width, input.height], 36); words.set([input.frameIndex, epoch, ['off', 'probe-only', 'world'].indexOf(controls.mode), Number(input.giEnabled)], 40);
    words.set([start, candidates, regionPixels, Number(update)], 44); floats.set([controls.roughness, controls.maxDistance, 0.8, maxAge], 48);
    words.set([Number(reset), controls.updateEvery, 0, 0], 52); words.set([region.x, region.y, region.width, region.height], 56);
    this.device.queue.writeBuffer(this.configs[index]!, 0, data);
    let dispatchCalls = 0; let uploadBytes = 240;
    if (controls.mode === 'world') {
      this.bindSources(input.outputs);
      let probes = this.probeGroups.get(input.probes.uniform);
      if (!probes) {
        probes = this.device.createBindGroup({ label: 'Strata reflection hit probes', layout: this.probeLayout, entries: [
          { binding: 0, resource: input.probes.irradiance }, { binding: 1, resource: input.probes.visibility },
          { binding: 2, resource: { buffer: input.probes.state } }, { binding: 3, resource: { buffer: input.probes.uniform } },
        ] }); this.probeGroups.set(input.probes.uniform, probes);
      }
      this.device.queue.writeBuffer(this.statistics, 0, new Uint32Array(8)); uploadBytes += 32;
      const trace = encoder.beginComputePass({ label: 'Strata selective reflection trace', ...(input.timestamps?.trace ? { timestampWrites: input.timestamps.trace } : {}) });
      trace.setPipeline(this.tracePipeline); trace.setBindGroup(0, this.traceGroups![index]!); trace.setBindGroup(1, this.sceneGroup); trace.setBindGroup(2, probes);
      if (candidates > 0) { trace.dispatchWorkgroups(Math.ceil(candidates / 64)); dispatchCalls++; } trace.end();
      const resolve = encoder.beginComputePass({ label: 'Strata reflection temporal reconstruction', ...(input.timestamps?.resolve ? { timestampWrites: input.timestamps.resolve } : {}) });
      resolve.setPipeline(this.resolvePipeline); resolve.setBindGroup(0, this.resolveGroups![index]!);
      resolve.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); resolve.end(); dispatchCalls++;
    }
    this.pending = { index, key, scheduleKey, epoch, frameIndex: input.frameIndex, worldRevision: input.worldRevision, frames, frontier, candidates, region, controls, maxAge };
    return { bindings: targets.banks[index]!.bindings, dispatchCalls, uploadBytes };
  }

  submitted(frameId: number): void {
    if (this.disposed || !this.pending) return;
    const pending = this.pending; this.pending = undefined;
    this.committedIndex = pending.index; this.key = pending.key; this.scheduleKey = pending.scheduleKey; this.epoch = pending.epoch; this.frameIndex = pending.frameIndex;
    this.worldRevision = pending.worldRevision; this.frames = pending.frames; this.frontier = pending.frontier;
    this.candidates = pending.candidates; this.region = pending.region; this.controls = pending.controls; this.maxAge = pending.maxAge;
    this.sourceFrameId = frameId; this.submittedFrames++; this.totalCandidates += pending.candidates;
    if (pending.candidates > 0) this.traceFrames++;
  }
  cancelFrame(): void { this.pending = undefined; }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.pending = undefined;
    for (const buffer of [...this.configs, this.statistics]) buffer.destroy();
    for (const texture of this.targets?.textures ?? []) texture.destroy();
    this.source = undefined; this.traceGroups = undefined; this.resolveGroups = undefined; this.probeGroups.clear();
  }
}
