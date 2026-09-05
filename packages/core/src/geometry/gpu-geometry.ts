import { TerrainRendering, transformGeometryBounds, transformTerrainCamera } from './terrain-rendering.js';
import type { TerrainLight, TerrainRenderOptions } from './terrain-rendering.js';
import { StrataError } from '../errors.js';
import type { GeometryManifest } from './format.js';
import { GeometryPageCache } from './page-cache.js';
import type { GeometryPageDemand, GeometryPageCacheOptions } from './page-cache.js';
import type { GeometryTelemetry, VirtualSceneOptions } from './virtual-types.js';
import { buildGeometryMetadata, createTerrainCamera, geometryProjectionScale } from './geometry-data.js';
import { geometrySelectionShader, geometryVertexShader } from './gpu-geometry-shaders.js';
import { createLightMatrix } from '../rendering/raster-math.js';
import type { CameraFrame } from '../rendering/raster-math.js';
import type { RasterControls } from '../rendering/raster-types.js';
import type { RasterGeometryProvider } from '../rendering/geometry-provider.js';
import { GeometryChangeSignal } from './transfer-budget.js';
import type { GeometryInitialization, GeometryInitializationStatus, GeometryResourceLease, GeometryTransferBudget, GeometryUploadFrame } from './transfer-budget.js';

const usage = { mapRead: 0x1, copySource: 0x4, copyDestination: 0x8, uniform: 0x40, storage: 0x80, indirect: 0x100 };
const uniformBytes = 160;
const argumentBytes = 64;
const feedbackCapacity = 3;

/** Scalar preflight only. The caller owns the already parsed manifest and its JS objects.
 * The work-list reservation uses fullTriangles, a conservative bound on the packer's
 * min(fullTriangles, capacityPages * maxPageTriangles); it is not physical GPU usage. */
function initializationPlan(manifest: GeometryManifest) {
  const bounded = (count: number, maximum: number): void => {
    if (!Number.isSafeInteger(count) || count < 1 || count > maximum) {
      throw new StrataError('UNSUPPORTED_LIMIT', 'Host geometry initialization exceeds the cooked metadata count limits.');
    }
  };
  bounded(manifest.pages.length, 8192); bounded(manifest.tiles.length, 256); bounded(manifest.clusters.length, 262144);
  let lodCount = 0; let pageRefs = 0; let clusterRefs = 0; let fullTriangles = 0;
  for (const tile of manifest.tiles) {
    bounded(tile.lods.length, 8); lodCount += tile.lods.length;
    let tileTriangles = 0;
    for (const lod of tile.lods) {
      bounded(lod.pageIds.length, manifest.pages.length); bounded(lod.clusterIds.length, manifest.clusters.length);
      pageRefs += lod.pageIds.length; clusterRefs += lod.clusterIds.length;
      if (clusterRefs > manifest.clusters.length || pageRefs > manifest.clusters.length) {
        throw new StrataError('UNSUPPORTED_LIMIT', 'Host geometry initialization requires the parsed unique cluster ownership contract.');
      }
      let triangles = 0;
      for (const id of lod.clusterIds) {
        const cluster = manifest.clusters[id];
        if (!Number.isSafeInteger(id) || !cluster || !Number.isSafeInteger(cluster.triangleCount)
          || cluster.triangleCount < 1 || cluster.triangleCount > 128) {
          throw new StrataError('INVALID_OPTIONS', 'Host geometry initialization requires valid parsed cluster references.');
        }
        triangles += cluster.triangleCount;
      }
      tileTriangles = Math.max(tileTriangles, triangles);
    }
    fullTriangles += tileTriangles;
  }
  const metadataBytes = (16 + manifest.tiles.length * 12 + lodCount * 8 + manifest.clusters.length * 16 + pageRefs + clusterRefs) * 4;
  const residencyBytes = manifest.pages.length * 4;
  const selectionBytes = manifest.tiles.length * 32;
  return {
    metadataBytes, residencyBytes, selectionBytes, fullTriangles,
    // Metadata, table, selections, two triangle lists, indirect/uniform, three feedback slots.
    gpuBufferBytes: metadataBytes + residencyBytes + selectionBytes * 4 + fullTriangles * 8 + 416,
    // Permanent typed storage includes the provider's light matrix.
    residentBytes: residencyBytes + uniformBytes + argumentBytes + 64,
    // The packer has pageTriangles scratch; createLightMatrix has two 64-byte operands.
    transientBytes: metadataBytes + selectionBytes + residencyBytes + 128,
  };
}

interface FeedbackSlot { readonly buffer: GPUBuffer; busy: boolean; frameId: number; pending: Promise<void> | null }
interface Resources {
  readonly buffers: readonly GPUBuffer[];
  readonly metadata: GPUBuffer;
  readonly residency: GPUBuffer;
  readonly selections: GPUBuffer;
  readonly triangles: GPUBuffer;
  readonly arguments: GPUBuffer;
  readonly uniform: GPUBuffer;
  readonly selectPipeline: GPUComputePipeline;
  readonly compactPipeline: GPUComputePipeline;
  readonly selectBindings: GPUBindGroup;
  readonly compactBindings: GPUBindGroup;
  readonly bytes: number;
  readonly uploadedBytes: number;
}

/** GPU tile selection and triangle compaction over unique cooked pages. */
export class GpuGeometry implements RasterGeometryProvider {
  readonly shaderSource: string;
  readonly fragmentEntryPoint?: string;
  readonly usesMaterialTextures: boolean;
  readonly selectionPass = true;
  readonly vertexEntryPoint = 'virtualVertexMain';
  readonly shadowEntryPoint = 'virtualShadowMain';
  readonly halfExtent: number;
  readonly lightMatrix: Float32Array<ArrayBuffer>;
  private rasterBindings: GPUBindGroup | undefined;
  private shadowBindings: GPUBindGroup | undefined;
  private readonly feedback: FeedbackSlot[];
  private recording: FeedbackSlot | undefined;
  private readonly residencyWords: Uint32Array<ArrayBuffer>;
  private readonly argumentReset = new Uint32Array(argumentBytes / 4);
  private readonly uniformData = new ArrayBuffer(uniformBytes);
  private disposed = false;
  private residencyDirty = false;
  private droppedFeedback = 0;
  private latest: GeometryTelemetry = {
    sourceFrameId: null, visibleTiles: 0, selectedClusters: 0, shadowClusters: 0,
    selectedTriangles: 0, shadowTriangles: 0, missingDetailTiles: 0, coverageMissingTiles: 0,
    maxProjectedError: 0, overflowCount: 0,
  };

  private constructor(
    private readonly device: GPUDevice,
    readonly manifest: GeometryManifest,
    private readonly cache: GeometryPageCache,
    private readonly resources: Resources,
    private readonly triangleCapacity: number,
    private readonly pixelError: number,
    private readonly mode: 'streamed' | 'resident-lod' | 'resident-full',
    private readonly cameraMode: 'tour' | 'coverage',
    private readonly pageLoadDelayMs: number,
    feedback: FeedbackSlot[],
    residencyWords: Uint32Array<ArrayBuffer>,
    private readonly rendering: TerrainRendering,
    private readonly initializationLease?: GeometryResourceLease,
    initializedLightMatrix?: Float32Array<ArrayBuffer>,
  ) {
    this.feedback = feedback; this.residencyWords = residencyWords;
    this.shaderSource = geometryVertexShader + rendering.shader(5);
    this.usesMaterialTextures = rendering.shading !== 'lambert';
    if (!this.usesMaterialTextures) this.fragmentEntryPoint = 'terrainLambertFragment';
    const bounds = transformGeometryBounds(manifest.bounds, rendering.transform);
    this.halfExtent = Math.max(Math.abs(bounds.min[0]), Math.abs(bounds.max[0]), Math.abs(bounds.min[2]), Math.abs(bounds.max[2]));
    this.lightMatrix = initializedLightMatrix ?? createLightMatrix(this.halfExtent);
    this.argumentReset[1] = 1; this.argumentReset[5] = 1;
    // The second half of the reference list is used by the shadow draw.
    this.argumentReset[6] = triangleCapacity * 3;
  }

  static async create(device: GPUDevice, manifest: GeometryManifest, manifestUrl: URL, options: VirtualSceneOptions, renderOptions?: TerrainRenderOptions): Promise<GpuGeometry> {
    if (options.geometryMode === 'mesh-lod') throw new StrataError('INVALID_OPTIONS', 'mesh-lod uses the conventional geometry provider.');
    const pixelError = options.pixelError ?? 2;
    if (!Number.isFinite(pixelError) || pixelError <= 0 || pixelError > 1000) {
      throw new StrataError('INVALID_OPTIONS', 'pixelError must be positive and at most 1000 pixels.');
    }
    if (options.cameraMode !== undefined && !['tour', 'coverage'].includes(options.cameraMode)) {
      throw new StrataError('INVALID_OPTIONS', 'Unknown terrain camera mode.');
    }
    const cache = await GeometryPageCache.create(device, manifest, manifestUrl, options);
    const buffers: GPUBuffer[] = [];
    let rendering: TerrainRendering | undefined;
    let allocatedBytes = 0;
    function buffer(label: string, size: number, flags: GPUBufferUsageFlags): GPUBuffer {
      if (size > device.limits.maxBufferSize || ((flags & usage.storage) !== 0 && size > device.limits.maxStorageBufferBindingSize)) {
        throw new StrataError('UNSUPPORTED_LIMIT', `${label} exceeds the GPU buffer/storage-binding limit.`);
      }
      const result = device.createBuffer({ label, size, usage: flags });
      buffers.push(result); allocatedBytes += size; return result;
    }
    try {
      rendering = new TerrainRendering(device, renderOptions);
      const metadata = buildGeometryMetadata(manifest, cache.gpuBufferBytes / manifest.pageBytes, rendering.transform);
      const module = device.createShaderModule({ label: 'Strata virtual geometry selection', code: geometrySelectionShader });
      const [selectPipeline, compactPipeline] = await Promise.all([
        device.createComputePipelineAsync({ label: 'Strata projected-error tile selection', layout: 'auto', compute: { module, entryPoint: 'selectTiles' } }),
        device.createComputePipelineAsync({ label: 'Strata cluster triangle compaction', layout: 'auto', compute: { module, entryPoint: 'compactClusters' } }),
      ]);
      const metaBuffer = buffer('Strata cooked geometry metadata', metadata.words.byteLength, usage.storage | usage.copyDestination);
      const residencyWords = Uint32Array.from(manifest.pages, page => cache.getSlot(page.id) >>> 0);
      const residency = buffer('Strata page residency table', residencyWords.byteLength, usage.storage | usage.copyDestination);
      const initialSelections = new Uint32Array(manifest.tiles.length * 8).fill(0xffffffff);
      const selections = buffer('Strata current tile LOD selections', initialSelections.byteLength, usage.storage | usage.copyDestination | usage.copySource);
      const triangles = buffer('Strata camera and shadow triangle references', metadata.triangleCapacity * 8, usage.storage);
      const argumentsBuffer = buffer('Strata indirect geometry arguments and counters', argumentBytes, usage.storage | usage.indirect | usage.copySource | usage.copyDestination);
      const uniform = buffer('Strata geometry selection camera', uniformBytes, usage.uniform | usage.copyDestination);
      device.queue.writeBuffer(metaBuffer, 0, metadata.words);
      device.queue.writeBuffer(residency, 0, residencyWords);
      device.queue.writeBuffer(selections, 0, initialSelections);
      const entry = (binding: number, value: GPUBuffer): GPUBindGroupEntry => ({ binding, resource: { buffer: value } });
      const selectBindings = device.createBindGroup({ label: 'Strata tile selection inputs', layout: selectPipeline.getBindGroupLayout(0), entries: [
        entry(0, metaBuffer), entry(1, residency), entry(2, selections), entry(4, argumentsBuffer), entry(5, uniform),
      ] });
      const compactBindings = device.createBindGroup({ label: 'Strata cluster compaction inputs', layout: compactPipeline.getBindGroupLayout(0), entries: [
        entry(0, metaBuffer), entry(2, selections), entry(3, triangles), entry(4, argumentsBuffer), entry(5, uniform),
      ] });
      const feedback = Array.from({ length: feedbackCapacity }, (_, index) => ({
        buffer: buffer(`Strata geometry feedback ${index}`, argumentBytes + initialSelections.byteLength, usage.mapRead | usage.copyDestination),
        busy: false, frameId: 0, pending: null,
      }));
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Scene creation aborted.', 'AbortError');
      const result = new GpuGeometry(device, manifest, cache, {
        buffers, metadata: metaBuffer, residency, selections, triangles, arguments: argumentsBuffer, uniform,
        selectPipeline, compactPipeline, selectBindings, compactBindings, bytes: allocatedBytes,
        uploadedBytes: metadata.words.byteLength + residencyWords.byteLength + initialSelections.byteLength,
      }, metadata.triangleCapacity, pixelError, options.geometryMode ?? 'streamed', options.cameraMode ?? 'tour', options.pageLoadDelayMs ?? 0, feedback, residencyWords, rendering);
      return result;
    } catch (cause) {
      rendering?.dispose(); cache.dispose(); for (const owned of buffers) owned.destroy(); throw cause;
    }
  }

  /** Internal host-driven INITIALIZATION only. Normal prepare() is unchanged and is
   * not covered by this shared budget. The optional terrain rendering path is excluded. */
  static begin(device: GPUDevice, manifest: GeometryManifest, manifestUrl: URL, options: VirtualSceneOptions & GeometryPageCacheOptions,
    budget: GeometryTransferBudget): GeometryInitialization<GpuGeometry> {
    const allowedOptions = ['renderer', 'manifestUrl', 'geometryMode', 'residencyPolicy', 'poolBytes', 'pixelError',
      'pageLoadDelayMs', 'maxConcurrentRequests', 'uploadBudgetBytes', 'cameraMode', 'signal', 'fetch', 'now',
      'maxCompletedBytes', 'maxRetries', 'retryDelayMs', 'requestTimeoutMs'];
    if (arguments.length !== 5 || !options || typeof options !== 'object' || options.renderer !== 'virtual'
      || Object.keys(options).some(key => !allowedOptions.includes(key))) {
      throw new StrataError('INVALID_OPTIONS', 'Host geometry initialization accepts only default terrain rendering and VirtualSceneOptions.');
    }
    options = { ...options };
    if (options.geometryMode === 'mesh-lod') throw new StrataError('INVALID_OPTIONS', 'mesh-lod uses the conventional geometry provider.');
    const mode = options.geometryMode ?? 'streamed';
    const pixelError = options.pixelError ?? 2;
    if (!Number.isFinite(pixelError) || pixelError <= 0 || pixelError > 1000) {
      throw new StrataError('INVALID_OPTIONS', 'pixelError must be positive and at most 1000 pixels.');
    }
    if (options.cameraMode !== undefined && !['tour', 'coverage'].includes(options.cameraMode)) {
      throw new StrataError('INVALID_OPTIONS', 'Unknown terrain camera mode.');
    }
    const plan = initializationPlan(manifest);
    const cachePlan = GeometryPageCache.estimate(device, manifest, options);
    const changes = new GeometryChangeSignal();
    let status: GeometryInitializationStatus = 'pending'; let error: unknown;
    let ownLease: GeometryResourceLease | undefined; let transientLease: GeometryResourceLease | undefined;
    let cacheHandle: GeometryInitialization<GeometryPageCache> | undefined;
    let cache: GeometryPageCache | undefined; let result: GpuGeometry | undefined;
    let rendering: TerrainRendering | undefined; let lightMatrix: Float32Array<ArrayBuffer> | undefined;
    let metadata: ReturnType<typeof buildGeometryMetadata> | undefined;
    let initialSelections: Uint32Array<ArrayBuffer> | undefined;
    let residencyWords: Uint32Array<ArrayBuffer> | undefined;
    let pipelines: readonly [GPUComputePipeline, GPUComputePipeline] | undefined;
    let pipelinesPending = false;
    let resources: Resources | undefined; let feedback: FeedbackSlot[] = [];
    const buffers: GPUBuffer[] = [];
    let allocatedBytes = 0; let metadataOffset = 0; let selectionOffset = 0; let residencyOffset = 0;
    let triangleCapacity = 0;
    const unsubscribe = budget.subscribe(() => { if (status === 'pending') changes.notify(); });
    const detach = (): void => { unsubscribe(); options.signal?.removeEventListener('abort', onAbort); };
    const cleanup = (): void => {
      detach();
      if (result) { result.dispose(); result = undefined; }
      else {
        cache?.dispose(); rendering?.dispose();
        for (const buffer of buffers) buffer.destroy();
      }
      // The cache handle retains canceled request/staging ownership until settlement.
      cacheHandle?.dispose();
      // Pipeline compilation has no cancellation API. Keep this initializer's
      // reservations/storage until every started compilation operation settles.
      if (!pipelinesPending) {
        transientLease?.release(); ownLease?.release(); transientLease = undefined; ownLease = undefined;
        metadata = undefined; initialSelections = undefined; residencyWords = undefined; lightMatrix = undefined;
      }
      rendering = undefined; cache = undefined; resources = undefined; pipelines = undefined; feedback = [];
      buffers.length = 0;
    };
    const fail = (cause: unknown): void => {
      if (status !== 'pending' && status !== 'ready') return;
      status = 'failed'; error = cause; cleanup(); changes.notify();
    };
    const onAbort = (): void => fail(options.signal?.reason ?? new DOMException('Scene creation aborted.', 'AbortError'));
    const checkAbort = (): void => { if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Scene creation aborted.', 'AbortError'); };
    const watchCache = async (handle: GeometryInitialization<GeometryPageCache>): Promise<void> => {
      while (status === 'pending' && handle.status === 'pending') {
        const revision = handle.revision;
        await handle.waitForChange(revision);
        if (status !== 'pending') return;
        if (options.signal?.aborted) { onAbort(); return; }
        if ((handle.status as GeometryInitializationStatus) === 'failed') { fail(handle.error); return; }
        changes.notify();
      }
    };
    const allocate = (label: string, size: number, flags: GPUBufferUsageFlags): GPUBuffer => {
      if (size > device.limits.maxBufferSize || ((flags & usage.storage) !== 0 && size > device.limits.maxStorageBufferBindingSize)) {
        throw new StrataError('UNSUPPORTED_LIMIT', `${label} exceeds the GPU buffer/storage-binding limit.`);
      }
      if (allocatedBytes + size > plan.gpuBufferBytes) throw new StrataError('RENDER_FAILED', 'Geometry allocation exceeded its admitted plan.');
      const value = device.createBuffer({ label, size, usage: flags }); buffers.push(value); allocatedBytes += size; return value;
    };
    const admit = (): boolean => {
      const leases = budget.tryReserveMany([
        { residentBytes: plan.residentBytes, gpuBufferBytes: plan.gpuBufferBytes },
        { residentBytes: cachePlan.residentBytes, gpuBufferBytes: cachePlan.gpuBufferBytes },
        { transientBytes: plan.transientBytes },
      ]);
      if (!leases) return false;
      ownLease = leases[0]!; transientLease = leases[2]!;
      try { cacheHandle = GeometryPageCache.begin(device, manifest, manifestUrl, options, budget, leases[1]!); }
      catch (cause) { leases[1]!.release(); throw cause; }
      void watchCache(cacheHandle).catch(fail);
      checkAbort();
      rendering = new TerrainRendering(device);
      metadata = buildGeometryMetadata(manifest, cachePlan.capacityPages);
      if (metadata.words.byteLength !== plan.metadataBytes || metadata.triangleCapacity > plan.fullTriangles) {
        throw new StrataError('RENDER_FAILED', 'Packed geometry disagrees with its scalar admission plan.');
      }
      triangleCapacity = metadata.triangleCapacity;
      initialSelections = new Uint32Array(manifest.tiles.length * 8).fill(0xffffffff);
      residencyWords = new Uint32Array(manifest.pages.length);
      const bounds = manifest.bounds;
      lightMatrix = createLightMatrix(Math.max(Math.abs(bounds.min[0]), Math.abs(bounds.max[0]), Math.abs(bounds.min[2]), Math.abs(bounds.max[2])));
      const module = device.createShaderModule({ label: 'Strata virtual geometry selection', code: geometrySelectionShader });
      const pending: Promise<GPUComputePipeline>[] = [];
      const settlePipelines = (): void => {
        if (!pending.length) return;
        pipelinesPending = true;
        void Promise.allSettled(pending).then(values => {
          pipelinesPending = false;
          if (status !== 'pending') { cleanup(); changes.notify(); return; }
          if (options.signal?.aborted) { onAbort(); return; }
          const rejected = values.find(value => value.status === 'rejected');
          if (rejected?.status === 'rejected') { fail(rejected.reason); return; }
          pipelines = values.map(value => (value as PromiseFulfilledResult<GPUComputePipeline>).value) as unknown as readonly [GPUComputePipeline, GPUComputePipeline];
          changes.notify();
        });
      };
      try {
        const observe = (promise: Promise<GPUComputePipeline>): Promise<GPUComputePipeline> => promise.catch(cause => { fail(cause); throw cause; });
        pending.push(observe(device.createComputePipelineAsync({ label: 'Strata projected-error tile selection', layout: 'auto', compute: { module, entryPoint: 'selectTiles' } })));
        pending.push(observe(device.createComputePipelineAsync({ label: 'Strata cluster triangle compaction', layout: 'auto', compute: { module, entryPoint: 'compactClusters' } })));
      } catch (cause) { settlePipelines(); throw cause; }
      settlePipelines();
      changes.notify(); return true;
    };
    const createResources = (): void => {
      const [selectPipeline, compactPipeline] = pipelines!;
      const metaBuffer = allocate('Strata cooked geometry metadata', plan.metadataBytes, usage.storage | usage.copyDestination);
      const residency = allocate('Strata page residency table', plan.residencyBytes, usage.storage | usage.copyDestination);
      const selections = allocate('Strata current tile LOD selections', plan.selectionBytes, usage.storage | usage.copyDestination | usage.copySource);
      const triangles = allocate('Strata camera and shadow triangle references', triangleCapacity * 8, usage.storage);
      const argumentsBuffer = allocate('Strata indirect geometry arguments and counters', argumentBytes, usage.storage | usage.indirect | usage.copySource | usage.copyDestination);
      const uniform = allocate('Strata geometry selection camera', uniformBytes, usage.uniform | usage.copyDestination);
      const entry = (binding: number, value: GPUBuffer): GPUBindGroupEntry => ({ binding, resource: { buffer: value } });
      const selectBindings = device.createBindGroup({ label: 'Strata tile selection inputs', layout: selectPipeline.getBindGroupLayout(0), entries: [
        entry(0, metaBuffer), entry(1, residency), entry(2, selections), entry(4, argumentsBuffer), entry(5, uniform),
      ] });
      const compactBindings = device.createBindGroup({ label: 'Strata cluster compaction inputs', layout: compactPipeline.getBindGroupLayout(0), entries: [
        entry(0, metaBuffer), entry(2, selections), entry(3, triangles), entry(4, argumentsBuffer), entry(5, uniform),
      ] });
      feedback = Array.from({ length: feedbackCapacity }, (_, index) => ({
        buffer: allocate(`Strata geometry feedback ${index}`, argumentBytes + plan.selectionBytes, usage.mapRead | usage.copyDestination),
        busy: false, frameId: 0, pending: null,
      }));
      resources = { buffers: [...buffers], metadata: metaBuffer, residency, selections, triangles, arguments: argumentsBuffer, uniform,
        selectPipeline, compactPipeline, selectBindings, compactBindings, bytes: allocatedBytes,
        uploadedBytes: plan.metadataBytes + plan.residencyBytes + plan.selectionBytes };
    };
    const write = (frame: GeometryUploadFrame, buffer: GPUBuffer, bytes: Uint8Array<ArrayBuffer>, offset: number): number => {
      const size = Math.min(bytes.byteLength - offset, Math.floor(frame.remainingBytes / 4) * 4);
      if (!size) return offset;
      return frame.write(device, buffer, offset, bytes.subarray(offset, offset + size)) ? offset + size : offset;
    };
    const handle: GeometryInitialization<GpuGeometry> = Object.freeze({
      get status() { return status; }, get error() { return error; }, get revision() { return changes.revision; },
      advance(frame: GeometryUploadFrame) {
        const before = frame.writtenBytes;
        if (status !== 'pending') return { status, uploadBytes: 0 };
        try {
          if (frame.budget !== budget) throw new StrataError('INVALID_OPTIONS', 'Geometry initialization requires a frame from its own budget.');
          frame.assertCurrent();
          checkAbort();
          if (!ownLease && !admit()) return { status, uploadBytes: 0 };
          if (!pipelines) return { status, uploadBytes: 0 };
          if (!resources) createResources();
          if (metadata) {
            metadataOffset = write(frame, resources!.metadata, new Uint8Array(metadata.words.buffer), metadataOffset);
            if (metadataOffset !== plan.metadataBytes) return { status, uploadBytes: frame.writtenBytes - before };
            selectionOffset = write(frame, resources!.selections, new Uint8Array(initialSelections!.buffer), selectionOffset);
            if (selectionOffset !== plan.selectionBytes) return { status, uploadBytes: frame.writtenBytes - before };
            metadata = undefined; initialSelections = undefined; transientLease!.release(); transientLease = undefined;
            changes.notify();
          }
          if (!cache) {
            cacheHandle!.advance(frame);
            if (cacheHandle!.status === 'failed') throw cacheHandle!.error;
            if (cacheHandle!.status !== 'ready') return { status, uploadBytes: frame.writtenBytes - before };
            cache = cacheHandle!.takeReady();
            for (const page of manifest.pages) residencyWords![page.id] = cache.getSlot(page.id) >>> 0;
          }
          residencyOffset = write(frame, resources!.residency, new Uint8Array(residencyWords!.buffer), residencyOffset);
          if (residencyOffset !== plan.residencyBytes) return { status, uploadBytes: frame.writtenBytes - before };
          checkAbort();
          result = new GpuGeometry(device, manifest, cache, resources!, triangleCapacity, pixelError, mode,
            options.cameraMode ?? 'tour', options.pageLoadDelayMs ?? 0, feedback, residencyWords!, rendering!, ownLease, lightMatrix);
          status = 'ready'; changes.notify();
        } catch (cause) { fail(cause); }
        return { status, uploadBytes: frame.writtenBytes - before };
      },
      waitForChange: (revision: number) => status !== 'pending' ? Promise.resolve() : changes.wait(revision),
      takeReady() {
        if (status !== 'ready') throw new StrataError('INVALID_OPTIONS', 'Geometry initialization is not ready or was already taken.');
        const value = result!; result = undefined; status = 'taken'; detach();
        // Clear handle references without touching the resources now owned by the provider.
        ownLease = undefined; rendering = undefined; cache = undefined; cacheHandle = undefined; resources = undefined;
        residencyWords = undefined; lightMatrix = undefined; pipelines = undefined; feedback = [];
        buffers.length = 0;
        changes.notify(); return value;
      },
      dispose() {
        if (status === 'taken' || status === 'disposed') return;
        status = 'disposed'; cleanup(); changes.notify();
      },
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    return handle;
  }

  get gpuBufferBytes(): number { return this.disposed ? 0 : this.resources.bytes + this.cache.gpuBufferBytes + this.rendering.gpuBufferBytes; }
  get initialUploadBytes(): number { return this.resources.uploadedBytes + this.cache.initialUploadBytes + this.rendering.initialUploadBytes; }
  get geometryTelemetry(): GeometryTelemetry {
    return { ...this.cache.telemetry, ...this.latest, geometryMode: this.mode,
      ...(this.initializationLease ? { initializationProviderGpuReservedBytes: this.initializationLease.amounts.gpuBufferBytes,
        initializationProviderGpuRequestedBytes: this.resources.bytes } : {}),
      cameraPath: this.cameraMode === 'coverage' ? 'terrain-coverage-v1' : 'terrain-tour-v1',
      uniqueCompiledBytes: this.manifest.pages.length * this.manifest.pageBytes,
      sourceSeed: this.manifest.source.seed, sourceTriangleCount: this.manifest.source.triangleCount,
      sourcePageCount: this.manifest.pages.length, sourceRootPageCount: this.manifest.rootPageIds.length,
      sourceTilesPerSide: this.manifest.source.tilesPerSide, sourceCellsPerTile: this.manifest.source.cellsPerTile,
      pixelError: this.pixelError, pageLoadDelayMs: this.pageLoadDelayMs,
      worklistCapacityTriangles: this.triangleCapacity,
      pendingFeedbackFrames: this.feedback.filter(slot => slot.busy).length, droppedFeedbackFrames: this.droppedFeedback };
  }

  camera(width: number, height: number, time: number, jitter: readonly [number, number]): CameraFrame {
    return transformTerrainCamera(createTerrainCamera(this.manifest, width, height, time, jitter, this.cameraMode), this.rendering.transform);
  }

  setLight(light: TerrainLight): void { this.rendering.setLight(light); }

  attachPipelines(raster: GPURenderPipeline, shadow: GPURenderPipeline): void {
    const shared = [this.cache.buffer, this.resources.metadata, this.resources.residency, this.resources.triangles];
    const entries = shared.map((buffer, binding) => ({ binding, resource: { buffer } }));
    if (this.rendering.buffer) entries.push({ binding: 5, resource: { buffer: this.rendering.buffer } });
    this.shadowBindings = this.device.createBindGroup({ label: 'Strata shadow page pulling', layout: shadow.getBindGroupLayout(1), entries });
    this.rasterBindings = this.device.createBindGroup({ label: 'Strata raster page pulling', layout: raster.getBindGroupLayout(1),
      entries: [...entries, { binding: 4, resource: { buffer: this.resources.selections } }] });
  }

  prepare(encoder: GPUCommandEncoder, camera: CameraFrame, width: number, height: number, reset: boolean,
    _controls: RasterControls, timestampWrites?: GPUComputePassTimestampWrites): { dispatchCalls: number; uploadBytes: number; triangles: number } {
    if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'Virtual geometry was disposed.');
    if (Number(this.latest.overflowCount) || Number(this.latest.coverageMissingTiles)) {
      throw new StrataError('RENDER_FAILED', 'Virtual geometry feedback reported incomplete coverage or a work-list overflow.');
    }
    this.cancelFrame();
    let update: ReturnType<GeometryPageCache['update']>;
    try { update = this.cache.update(); }
    catch (cause) { this.residencyDirty = true; throw cause; }
    let uploadBytes = update.uploadBytes + uniformBytes + argumentBytes + this.rendering.flush();
    if (update.uploaded.length || update.evicted.length) this.residencyDirty = true;
    if (this.residencyDirty) {
      for (const page of this.manifest.pages) this.residencyWords[page.id] = this.cache.getSlot(page.id) >>> 0;
      this.device.queue.writeBuffer(this.resources.residency, 0, this.residencyWords);
      uploadBytes += this.residencyWords.byteLength;
      this.residencyDirty = false;
    }
    const floats = new Float32Array(this.uniformData); const words = new Uint32Array(this.uniformData);
    floats.set(camera.viewProjection, 0); floats.set(camera.view, 16);
    floats.set([geometryProjectionScale(camera, height), this.pixelError, width, height], 32);
    words.set([reset ? 1 : 0, this.mode === 'resident-full' ? 1 : 0, this.triangleCapacity, camera.orthographic ? 1 : 0], 36);
    this.device.queue.writeBuffer(this.resources.uniform, 0, this.uniformData);
    this.device.queue.writeBuffer(this.resources.arguments, 0, this.argumentReset);
    const pass = encoder.beginComputePass({ label: 'Strata geometry selection and compaction', ...(timestampWrites ? { timestampWrites } : {}) });
    pass.setPipeline(this.resources.selectPipeline); pass.setBindGroup(0, this.resources.selectBindings);
    pass.dispatchWorkgroups(Math.ceil(this.manifest.tiles.length / 64));
    pass.setPipeline(this.resources.compactPipeline); pass.setBindGroup(0, this.resources.compactBindings);
    pass.dispatchWorkgroups(Math.min(this.manifest.clusters.length, 32768), Math.ceil(this.manifest.clusters.length / 32768));
    pass.end();
    const slot = this.feedback.find(value => !value.busy);
    if (slot) {
      slot.busy = true; this.recording = slot;
      encoder.copyBufferToBuffer(this.resources.arguments, 0, slot.buffer, 0, argumentBytes);
      encoder.copyBufferToBuffer(this.resources.selections, 0, slot.buffer, argumentBytes, this.manifest.tiles.length * 32);
    } else this.droppedFeedback++;
    return { dispatchCalls: 2, uploadBytes, triangles: Number(this.latest.selectedTriangles) + Number(this.latest.shadowTriangles) };
  }

  draw(pass: GPURenderPassEncoder, phase: 'raster' | 'shadow'): void {
    const bindings = phase === 'raster' ? this.rasterBindings : this.shadowBindings;
    if (!bindings) throw new StrataError('RENDER_FAILED', 'Virtual geometry pipelines have not been attached.');
    pass.setBindGroup(1, bindings);
    pass.drawIndirect(this.resources.arguments, phase === 'raster' ? 0 : 16);
  }

  submitted(frameId: number): void {
    const slot = this.recording; this.recording = undefined;
    if (!slot || this.disposed) return;
    slot.frameId = frameId;
    const complete = async (): Promise<void> => {
      try {
        await slot.buffer.mapAsync(1, 0, argumentBytes + this.manifest.tiles.length * 32);
        if (this.disposed || (this.latest.sourceFrameId !== null && slot.frameId <= this.latest.sourceFrameId)) return;
        const buffer = slot.buffer.getMappedRange(); const words = new Uint32Array(buffer); const floats = new Float32Array(buffer);
        let visibleTiles = 0; let maxProjectedError = 0;
        const demands: GeometryPageDemand[] = [];
        for (const tile of this.manifest.tiles) {
          const offset = argumentBytes / 4 + tile.id * 8;
          if (words[offset + 2]) {
            visibleTiles++; maxProjectedError = Math.max(maxProjectedError, floats[offset + 4]!);
            demands.push({ tileId: tile.id, lod: words[offset]!, priority: floats[offset + 5]! });
          }
        }
        this.latest = { sourceFrameId: slot.frameId, visibleTiles, maxProjectedError,
          selectedClusters: words[8]!, shadowClusters: words[9]!, selectedTriangles: words[0]! / 3, shadowTriangles: words[4]! / 3,
          missingDetailTiles: words[11]!, coverageMissingTiles: words[10]!, overflowCount: words[12]! };
        this.cache.setDemand(demands);
      } catch { if (!this.disposed) this.droppedFeedback++; }
      finally {
        try { slot.buffer.unmap(); } catch { /* Device loss can finish a pending readback. */ }
        slot.busy = false; slot.pending = null;
      }
    };
    const pending = complete(); if (slot.busy) slot.pending = pending;
  }

  cancelFrame(): void {
    const slot = this.recording; this.recording = undefined;
    if (slot && !slot.pending) { slot.busy = false; this.droppedFeedback++; }
  }

  async flushFeedback(timeoutMs = 5000): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new StrataError('INVALID_OPTIONS', 'Geometry feedback timeout must be positive.');
    if (this.disposed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(this.feedback.map(slot => slot.pending)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StrataError('GPU_TIMING_TIMEOUT', 'Geometry feedback readback timed out.')), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelFrame(); this.disposed = true; this.cache.dispose(); this.rendering.dispose();
    for (const slot of this.feedback) { if (slot.busy) this.droppedFeedback++; slot.busy = false; }
    for (const buffer of this.resources.buffers) buffer.destroy();
    this.initializationLease?.release();
    this.rasterBindings = undefined; this.shadowBindings = undefined;
  }
}
