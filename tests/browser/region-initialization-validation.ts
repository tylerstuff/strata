import { parseGeometryManifest } from '../../packages/core/src/geometry/format.js';
import { buildGeometryMetadata, createTerrainCamera, geometryProjectionScale } from '../../packages/core/src/geometry/geometry-data.js';
import { GpuGeometry } from '../../packages/core/src/geometry/gpu-geometry.js';
import type { GeometryPageCacheOptions } from '../../packages/core/src/geometry/page-cache.js';
import { RegionInitializationCoordinator } from '../../packages/core/src/geometry/region-initialization.js';
import type { RegionDescriptor } from '../../packages/core/src/geometry/region-initialization.js';
import { GeometryTransferBudget } from '../../packages/core/src/geometry/transfer-budget.js';
import type { VirtualSceneOptions } from '../../packages/core/src/geometry/virtual-types.js';
import { RasterRenderer } from '../../packages/core/src/rendering/raster-renderer.js';
import { RegionValidationDeadline } from './region-validation-deadline.js';

interface SourceInput {
  readonly id: string;
  readonly manifestUrl: string;
  readonly manifest: unknown;
  readonly manifestBytes: number;
  readonly manifestSha256: string;
  readonly pageHashes: readonly { readonly id: number; readonly sha256: string }[];
  readonly rootPageIndices: readonly number[];
  readonly poolPages: number;
}
export interface RegionInitializationValidationInput {
  readonly sources: readonly SourceInput[];
  readonly expectedPreparationHash?: string;
}
const pageBytes = 65_536;
const transferLimits = Object.freeze({ maxRequests: 2, pageStagingBytes: pageBytes, transientBytes: 1_048_576,
  residentBytes: 1_048_576, gpuBufferBytes: 4_194_304, uploadBytesPerFrame: pageBytes });
const coordinatorLimits = Object.freeze({ maxDesiredRegions: 4, maxLiveRegions: 2, maxManifestBytes: 2768, maxRetainedManifestBytes: 5536 });
const framePlan = Object.freeze({ name: 'final', width: 256, height: 256, debugView: 'final' as const,
  cameraCut: true, temporal: false, timeSeconds: 0 });
// Identities from the frozen four-source CPU proof, cooked with the unchanged legacy recipe.
const manifestPins = [
  { bytes: 2766, sha256: 'd47cb3aeb68cf8c9461f7bd1b2d236eee6496b4a2925dbcb58c715a039435678' },
  { bytes: 2768, sha256: '063deacb2b3fffc7009783e199eb0f53199f7dfc282dd86366247be8daa38f69' },
  { bytes: 2768, sha256: '3313f201facb1f73fe93db9b98fbb48496774ef30b444ac082f7c9bce91ff3a6' },
  { bytes: 2766, sha256: 'a54e168624e003aa313d0502230e8f4ab216d43967b02ff4711e3ebcfcca3a35' },
] as const;
const require = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const json = (value: unknown): string => JSON.stringify(value);
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return item;
});
const message = (cause: unknown): string => cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
const digest = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  value => value.toString(16).padStart(2, '0')).join('');
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

/** Pure CPU preparation. Importing this module or preparing it touches no browser/GPU surface. */
export function prepareRegionInitializationValidation(input: RegionInitializationValidationInput) {
  require(Array.isArray(input.sources) && input.sources.length === 4, 'Exactly four pinned procedural sources are required.');
  const sources = manifestPins.map((pin, index) => {
    const source = input.sources[index]!; const seed = 51 + index;
    require(source?.id === `seed-${seed}` && source.manifestUrl === `/__region-init__/seed-${seed}/manifest.json`, 'Source order, id or fixture route differs from the pinned plan.');
    require(source.manifestBytes === pin.bytes && source.manifestSha256 === pin.sha256, 'Manifest length or SHA-256 differs from the frozen CPU source identity.');
    const manifest = parseGeometryManifest(source.manifest);
    require(manifest.source.kind === 'analytic-heightfield-v1' && manifest.source.seed === seed
      && manifest.source.tilesPerSide === 2 && manifest.source.cellsPerTile === 8 && manifest.source.triangleCount === 512, 'Source recipe differs from seeds 51–54, 2x2 tiles and 8 cells.');
    require(manifest.pageBytes === pageBytes && manifest.pages.length === 2 && manifest.tiles.length === 4 && manifest.clusters.length === 8,
      'Pinned source page/tile/cluster counts changed.');
    require(json(source.rootPageIndices) === '[0]' && json(manifest.rootPageIds) === '[0]' && source.poolPages === 2, 'Pinned root or pool shape changed.');
    const pageHashes = source.pageHashes.map(page => ({ id: page.id, sha256: page.sha256 }));
    require(json(pageHashes) === json(manifest.pages.map(page => ({ id: page.id, sha256: page.sha256 }))), 'Page hashes disagree with the parsed manifest.');
    const metadata = buildGeometryMetadata(manifest, source.poolPages);
    const camera = createTerrainCamera(manifest, framePlan.width, framePlan.height, 0, [0, 0], 'coverage');
    const maximumCoarseProjectedError = Math.max(...manifest.tiles.map(tile => tile.lods.at(-1)!.error * geometryProjectionScale(camera, framePlan.height)));
    require(camera.orthographic && maximumCoarseProjectedError < 500, 'Coarsest LOD lacks the factor-of-two selection margin at pixelError 1000.');
    const coarseTriangles = manifest.tiles.reduce((sum, tile) => sum + tile.lods.at(-1)!.clusterIds.reduce((count, id) => count + manifest.clusters[id]!.triangleCount, 0), 0);
    const coarseClusters = manifest.tiles.reduce((sum, tile) => sum + tile.lods.at(-1)!.clusterIds.length, 0);
    const expectedInitialUploadBytes = metadata.words.byteLength + manifest.tiles.length * 32 + manifest.pages.length * 4 + pageBytes;
    require(coarseTriangles === 128 && coarseClusters === 4 && metadata.words.byteLength === 1088 && expectedInitialUploadBytes === 66_760, 'Pinned coarse geometry or upload plan changed.');
    return { id: source.id, manifestUrl: source.manifestUrl, manifestBytes: source.manifestBytes, manifestSha256: source.manifestSha256,
      pageHashes, source: manifest.source, poolPages: source.poolPages, rootPageIndices: [...source.rootPageIndices],
      pages: manifest.pages.length, tiles: manifest.tiles.length, clusters: manifest.clusters.length,
      metadataBytes: metadata.words.byteLength, selectionBytes: manifest.tiles.length * 32, residencyBytes: manifest.pages.length * 4,
      maximumCoarseProjectedError, expectedInitialUploadBytes, coarseTriangles, coarseClusters };
  });
  require(new Set(sources.map(source => source.manifestSha256)).size === 4
    && new Set(sources.map(source => source.pageHashes[0]!.sha256)).size === 4, 'Four distinct manifest and root identities are required.');
  const half = framePlan.height / 2 / 1.05;
  const interiorSide = Math.floor(framePlan.height / 2 + half) - 3 - (Math.ceil(framePlan.height / 2 - half) + 3);
  require(interiorSide * interiorSide === 55_696, 'Coverage interior changed.');
  return { schema: 'strata-region-initialization-webgpu-preparation-v1', sources, coordinatorLimits, transferLimits,
    frames: [framePlan], pixelError: 1000, cameraMode: 'coverage' as const, adapterProfile: { vendor: 'Apple', architecture: 'Metal', fallback: false },
    gates: { maximumInitializationFrames: 600, initializationDeadlineMs: 60_000, totalDeadlineMs: 180_000,
      directRenderSubmissions: 8, expectedDrawCalls: 24, expectedDispatchCalls: 16, coverageBoundaryPixels: 3,
      expectedInteriorSamples: interiorSide * interiorSide, maximumDepthDifference: 0.000002, maximumColorChannelDifference: 1,
      successfulCoordinatorUploadBytes: 267_040, heldRetirementFrames: 3 },
    exclusions: ['Queue hashes describe accepted CPU write arguments, not GPU pool or metadata readback.',
      'Held ABA fetch/cancellation promises are controlled lifetime evidence, not native network abort or latency evidence.',
      'Initialization budgets exclude eager references and ordinary renderer setup/prepare writes.',
      'Logical ownership and requested resource sizes do not measure driver memory or GPU completion.',
      'No placement, composite scene, retention-policy, temporal quality, public API or performance acceptance.'],
    observation: 'Eight existing RasterRenderer frames use actual private ready providers. Native usages are unchanged; existing depth and an owned presentation target are copied in each render submission.' };
}

interface BufferRecord { readonly resource: GPUBuffer; readonly owner: string; readonly phase: string; readonly label: string; readonly size: number; readonly usage: number; destroys: number }
interface TextureRecord { readonly resource: GPUTexture; readonly owner: string; readonly label: string; readonly format: GPUTextureFormat; readonly usage: number; destroys: number }
interface WriteRecord { readonly buffer: GPUBuffer; readonly owner: string; readonly phase: string; readonly frame: number | null; readonly label: string; readonly offset: number; readonly bytes: Uint8Array<ArrayBuffer> }
interface RequestRecord { readonly owner: string; readonly source: string; readonly url: string; readonly kind: 'manifest' | 'root'; readonly transport: 'native-fetch' | 'controlled-lifetime'; readonly budgetAtStart?: unknown; aborted: boolean; settled: boolean; outcome?: string }
interface Control { readonly response: ReturnType<typeof deferred<Response>>; readonly cancellation: ReturnType<typeof deferred<void>>; readonly record: RequestRecord; readonly signal: AbortSignal; readonly bytes: number; delivered: boolean; cancelStarted: boolean; cancelSettled: boolean }
interface Capture { readonly color: Uint8Array<ArrayBuffer>; readonly depth: Float32Array<ArrayBuffer>; readonly depthSha256: string }
type Snapshot = ReturnType<RegionInitializationCoordinator['snapshot']>;
// This structural borrow is confined to the frozen test bundle. Nothing is exported from production.
interface BorrowedEntry { readonly owner: { readonly incarnation: number; readonly descriptor: { readonly id: string } }; readonly retiring: boolean; readonly provider?: GpuGeometry; readonly handle?: { readonly status: string } }

/** Explicit native entry point. CPU preparation never calls this function. */
export async function runRegionInitializationValidation(input: RegionInitializationValidationInput) {
  const startedAt = performance.now();
  const preparation = prepareRegionInitializationValidation(input);
  const deadline = new RegionValidationDeadline(startedAt + preparation.gates.totalDeadlineMs);
  const assertTime = (): void => deadline.assertOpen();
  const bounded = <T>(start: () => Promise<T>, milliseconds = 10_000): Promise<T> => deadline.bounded(start, milliseconds);
  const checkedDigest = (bytes: Uint8Array<ArrayBuffer>): Promise<string> => bounded(() => digest(bytes), preparation.gates.totalDeadlineMs);
  const preparationSha256 = await checkedDigest(new TextEncoder().encode(canonicalJson(preparation)));
  require(preparationSha256 === input.expectedPreparationHash, 'Browser preparation differs from the frozen canonical preparation hash.');
  const report: Record<string, unknown> = { schema: 'strata-region-initialization-webgpu-v1', passed: false, performanceEvidence: false,
    preparation, preparationSha256, errors: [], frames: [], initializationFrames: [], lifecycle: [], comparisons: [], images: {}, sourceReceipts: [] };
  const errors = report.errors as string[];
  const buffers: BufferRecord[] = []; const textures: TextureRecord[] = []; const writes: WriteRecord[] = [];
  const requests: RequestRecord[] = []; const controls: Control[] = []; const pendingFetches = new Set<Promise<Response>>();
  const queueSubmissions: { owner: string; phase: string; commandBufferCount: number; labels: string[] }[] = [];
  const coordinators: { name: string; coordinator: RegionInitializationCoordinator; budget: GeometryTransferBudget }[] = [];
  const renderers = new Map<GpuGeometry, RasterRenderer>(); const eagerProviders = new Set<GpuGeometry>();
  const creationControllers: AbortController[] = []; const creationOperations = new Set<Promise<GpuGeometry>>(); const restore: (() => void)[] = [];
  const rendererOperations = new Set<Promise<RasterRenderer>>(); const nativeOperations = new Set<Promise<unknown>>();
  const manifests = input.sources.map(source => parseGeometryManifest(source.manifest));
  const nativeFetch = globalThis.fetch.bind(globalThis);
  let device: GPUDevice | undefined; let intentionallyDestroyed = false; let initializationGuard = false;
  let adapterOperation: Promise<GPUAdapter | null> | undefined; let deviceOperation: Promise<GPUDevice> | undefined;
  const acquisition = { adapterPending: false, devicePending: false, cleanupStarted: false, deviceDestroyed: false,
    lateDeviceDestroyed: false, lateDeviceCleanupArmed: false };
  let owner = 'harness'; let phase = 'setup'; let hostFrame: number | null = null; let frameId = 0; let submissions = 0;
  let totalDraws = 0; let totalDispatches = 0; let forcedResourceCleanup = 0;
  const nextFrame = (): Promise<void> => bounded(() => new Promise(resolve => requestAnimationFrame(() => resolve())), 5_000);
  const own = <T>(nextOwner: string, nextPhase: string, action: () => T): T => {
    const previousOwner = owner; const previousPhase = phase; owner = nextOwner; phase = nextPhase;
    const reset = (): void => { owner = previousOwner; phase = previousPhase; };
    try { const value = action(); if (value instanceof Promise) return value.finally(reset) as T; reset(); return value; }
    catch (cause) { reset(); throw cause; }
  };
  const replace = (object: object, key: string, value: unknown): void => {
    const previous = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, writable: true, value });
    restore.push(() => { if (previous) Object.defineProperty(object, key, previous); else Reflect.deleteProperty(object, key); });
  };
  const observeNative = <T>(operation: Promise<T>): Promise<T> => {
    nativeOperations.add(operation);
    void operation.then(() => nativeOperations.delete(operation), () => nativeOperations.delete(operation));
    return operation;
  };
  const noBudget = (budget: GeometryTransferBudget): boolean => (['requests', 'pageStagingBytes', 'transientBytes', 'residentBytes', 'gpuBufferBytes'] as const).every(key => budget.telemetry[key] === 0);
  const check = (coordinator: RegionInitializationCoordinator, budget: GeometryTransferBudget): void => {
    const snapshot = coordinator.snapshot(); const telemetry = budget.telemetry;
    require(snapshot.liveEntries <= 2 && snapshot.retainedManifestBytes <= coordinatorLimits.maxRetainedManifestBytes, 'Coordinator exceeded live or retained-content capacity.');
    require(snapshot.retiringEntries <= snapshot.liveEntries && snapshot.regions.length <= 4, 'Coordinator entry counts are inconsistent.');
    require(telemetry.requests <= transferLimits.maxRequests, 'Shared request capacity was exceeded.');
    for (const key of ['pageStagingBytes', 'transientBytes', 'residentBytes', 'gpuBufferBytes'] as const) require(telemetry[key] <= transferLimits[key], `Shared ${key} capacity was exceeded.`);
  };
  const settleWithoutAdvancing = (done: () => boolean): Promise<void> => deadline.stage({
    milliseconds: preparation.gates.initializationDeadlineMs, done,
    wait: async () => { const count = writes.length; await nextFrame(); require(writes.length === count, 'Asynchronous work wrote without a host advance.'); },
  });
  const advance = (name: string, coordinator: RegionInitializationCoordinator, budget: GeometryTransferBudget): void => {
    assertTime();
    require(frameId < preparation.gates.maximumInitializationFrames, 'Coordinator exceeded 600 total host advances.');
    hostFrame = ++frameId; const frame = budget.beginFrame(frameId); const before = writes.length;
    try {
      const result = own(name, 'initialization', () => coordinator.advance(frame));
      const actual = writes.slice(before).reduce((sum, write) => sum + write.bytes.byteLength, 0);
      require(actual === result.uploadBytes && actual === frame.writtenBytes && actual <= pageBytes, 'Accepted native writes disagree with the shared host allowance.');
      require(new Set(result.advancedIncarnations).size === result.advancedIncarnations.length, 'An incarnation advanced twice in one host turn.');
      check(coordinator, budget);
      (report.initializationFrames as unknown[]).push({ owner: name, frame: frameId, actualAcceptedQueueBytes: actual, ...result,
        coordinator: coordinator.snapshot(), budget: budget.telemetry });
    } finally { hostFrame = null; }
  };
  const drive = (name: string, coordinator: RegionInitializationCoordinator, budget: GeometryTransferBudget, done: (snapshot: Snapshot) => boolean): Promise<void> => deadline.stage({
    milliseconds: preparation.gates.initializationDeadlineMs, done: () => done(coordinator.snapshot()),
    wait: async () => { const count = writes.length; await nextFrame(); require(writes.length === count, 'Initialization wrote asynchronously between host allowances.'); },
    advance: () => advance(name, coordinator, budget),
  });
  const deliverControl = (control: Control): void => {
    if (control.delivered) return;
    control.delivered = true;
    control.response.resolve(new Response(new ReadableStream<Uint8Array<ArrayBuffer>>({ cancel() {
      control.cancelStarted = true;
      return control.cancellation.promise.then(() => { control.cancelSettled = true; });
    } }), { headers: { 'content-length': String(control.bytes) } }));
  };
  const fetchFor = (requestOwner: string, state?: { coordinator: () => RegionInitializationCoordinator; budget: GeometryTransferBudget }, aba = false): typeof fetch => async (resource, options) => {
    assertTime();
    const url = new URL(resource instanceof Request ? resource.url : String(resource), location.href);
    const sourceIndex = input.sources.findIndex(source => url.pathname.startsWith(`/__region-init__/${source.id}/`));
    const alias = url.pathname.split('/')[2]; const index = sourceIndex === -1 && ['corrupt-manifest', 'corrupt-root'].includes(alias ?? '') ? 3 : sourceIndex;
    require(index >= 0 && url.origin === location.origin, `Unexpected fixture request: ${url.href}`);
    const source = input.sources[index]!; const manifest = manifests[index]!;
    const base = new URL(sourceIndex === -1 ? `/__region-init__/${alias}/manifest.json` : source.manifestUrl, location.href);
    const isManifest = url.href === base.href;
    const page = manifest.pages.find(value => new URL(value.url, base).href === url.href);
    require(isManifest || (page && manifest.rootPageIds.includes(page.id)), 'The fixed coarse proof requested optional detail or an unknown page.');
    const controlled = aba && controls.length < 2 && isManifest;
    const signal = options?.signal;
    if (state) {
      check(state.coordinator(), state.budget);
      require(state.coordinator().snapshot().liveEntries > 0 && state.budget.telemetry.requests > 0
        && state.budget.telemetry.pageStagingBytes >= (isManifest ? source.manifestBytes : pageBytes), 'A request started before its entry and payload admission.');
    }
    const record: RequestRecord = { owner: requestOwner, source: source.id, url: url.href, kind: isManifest ? 'manifest' : 'root',
      transport: controlled ? 'controlled-lifetime' : 'native-fetch', ...(state ? { budgetAtStart: state.budget.telemetry } : {}), aborted: signal?.aborted ?? false, settled: false };
    requests.push(record); const onAbort = (): void => { record.aborted = true; };
    signal?.addEventListener('abort', onAbort, { once: true });
    let operation: Promise<Response>;
    if (controlled) {
      require(signal, 'Controlled original manifest fetch lacks its owner signal.');
      const control: Control = { response: deferred<Response>(), cancellation: deferred<void>(), record, signal: signal!, bytes: source.manifestBytes,
        delivered: false, cancelStarted: false, cancelSettled: false };
      controls.push(control); operation = control.response.promise;
    } else operation = nativeFetch(resource, options);
    pendingFetches.add(operation);
    try { const response = await operation; record.outcome = `HTTP ${response.status}`; return response; }
    catch (cause) { record.outcome = message(cause); throw cause; }
    finally { record.settled = true; pendingFetches.delete(operation); signal?.removeEventListener('abort', onAbort); }
  };
  const descriptor = (index: number, id = input.sources[index]!.id, alias?: string): RegionDescriptor => {
    const source = input.sources[index]!;
    return { id, manifestUrl: new URL(alias ? `/__region-init__/${alias}/manifest.json` : source.manifestUrl, location.href),
      manifestBytes: source.manifestBytes, manifestSha256: source.manifestSha256, bounds: manifests[index]!.bounds,
      options: { poolBytes: 2 * pageBytes, pixelError: 1000, cameraMode: 'coverage', residencyPolicy: 'greedy' } };
  };
  const borrowReady = (coordinator: RegionInitializationCoordinator, id: string): GpuGeometry => {
    const receipt = coordinator.snapshot().regions.find(region => region.id === id);
    require(receipt?.status === 'ready', 'Private borrow requires a current ready receipt.');
    const entries = [...(coordinator as unknown as { live: Set<BorrowedEntry> }).live].filter(entry => !entry.retiring
      && entry.owner.descriptor.id === id && entry.owner.incarnation === receipt!.incarnation);
    require(entries.length === 1 && entries[0]!.provider && entries[0]!.handle?.status === 'taken', 'Private ready provider does not match its transferred incarnation.');
    return entries[0]!.provider!;
  };
  const retireRenderer = async (provider: GpuGeometry): Promise<void> => {
    await bounded(() => provider.whenDisposedAndSettled());
    const raster = renderers.get(provider); require(raster, 'Retired provider lost its retained renderer.');
    raster!.dispose(); renderers.delete(provider);
  };
  try {
    const adapter = await bounded(() => {
      const adapterRequest = navigator.gpu.requestAdapter(); acquisition.adapterPending = true;
      adapterOperation = adapterRequest.finally(() => { acquisition.adapterPending = false; });
      return adapterOperation;
    });
    require(adapter, 'WebGPU adapter unavailable.');
    require(!adapter!.info.isFallbackAdapter, 'The native proof requires a non-fallback adapter.');
    report.adapter = { vendor: adapter!.info.vendor, architecture: adapter!.info.architecture, device: adapter!.info.device,
      description: adapter!.info.description, isFallbackAdapter: adapter!.info.isFallbackAdapter };
    require(/apple/i.test(adapter!.info.vendor) && /metal/i.test(adapter!.info.architecture), 'The frozen native proof requires the Apple Metal adapter profile.');
    // Retain the original acquisition chain beyond the deadline race. A device
    // arriving after cleanup began is owned and destroyed by this callback.
    const gpu = await bounded(() => {
      const deviceRequest = adapter!.requestDevice(); acquisition.devicePending = true;
      deviceOperation = deviceRequest.then(value => {
        device = value;
        if (acquisition.cleanupStarted) {
          intentionallyDestroyed = true;
          try { value.destroy(); acquisition.deviceDestroyed = true; acquisition.lateDeviceDestroyed = true; }
          catch (cause) { errors.push(`Late device cleanup: ${message(cause)}`); }
        }
        return value;
      }).finally(() => { acquisition.devicePending = false; });
      return deviceOperation;
    });
    gpu.addEventListener('uncapturederror', event => errors.push(event.error.message));
    void gpu.lost.then(info => { if (!intentionallyDestroyed) errors.push(`Unexpected device loss: ${info.reason}: ${info.message}`); });
    gpu.pushErrorScope('out-of-memory'); gpu.pushErrorScope('validation');
    const createBuffer = gpu.createBuffer.bind(gpu); const createTexture = gpu.createTexture.bind(gpu);
    const writeBuffer = gpu.queue.writeBuffer.bind(gpu.queue); const submit = gpu.queue.submit.bind(gpu.queue);
    const computePipeline = gpu.createComputePipelineAsync.bind(gpu); const renderPipeline = gpu.createRenderPipelineAsync.bind(gpu);
    replace(gpu, 'createComputePipelineAsync', (description: GPUComputePipelineDescriptor) => { assertTime(); return observeNative(computePipeline(description)); });
    replace(gpu, 'createRenderPipelineAsync', (description: GPURenderPipelineDescriptor) => { assertTime(); return observeNative(renderPipeline(description)); });
    replace(gpu, 'createBuffer', (description: GPUBufferDescriptor) => {
      assertTime();
      const resource = createBuffer(description);
      const record: BufferRecord = { resource, owner, phase, label: description.label ?? '', size: description.size, usage: description.usage, destroys: 0 };
      buffers.push(record); const destroy = resource.destroy.bind(resource);
      replace(resource, 'destroy', () => { destroy(); record.destroys++; });
      const map = resource.mapAsync.bind(resource);
      replace(resource, 'mapAsync', (mode: GPUMapModeFlags, offset?: number, size?: number) => { assertTime(); return observeNative(map(mode, offset, size)); });
      require(resource.usage === description.usage, 'Observer changed native buffer usage.');
      if (phase === 'initialization') {
        const reserved = coordinators.reduce((sum, state) => sum + state.budget.telemetry.gpuBufferBytes, 0);
        const owned = buffers.filter(value => value.phase === 'initialization' && !value.destroys).reduce((sum, value) => sum + value.size, 0);
        require(owned <= reserved, 'Native initialization allocation preceded shared reservation.');
      }
      return resource;
    });
    replace(gpu, 'createTexture', (description: GPUTextureDescriptor) => {
      assertTime();
      const resource = createTexture(description); const record: TextureRecord = { resource, owner, label: description.label ?? '', format: description.format, usage: description.usage, destroys: 0 };
      textures.push(record); const destroy = resource.destroy.bind(resource);
      replace(resource, 'destroy', () => { destroy(); record.destroys++; });
      require(resource.usage === description.usage, 'Observer changed native texture usage.'); return resource;
    });
    replace(gpu.queue, 'writeBuffer', (buffer: GPUBuffer, offset: number, data: AllowSharedBufferSource, dataOffset = 0, size?: number) => {
      assertTime();
      writeBuffer(buffer, offset, data, dataOffset, size);
      const view = ArrayBuffer.isView(data); const elementBytes = view && 'BYTES_PER_ELEMENT' in data ? Number(data.BYTES_PER_ELEMENT) : 1;
      const bytes = new Uint8Array(view ? data.buffer : data, (view ? data.byteOffset : 0) + dataOffset * elementBytes,
        size === undefined ? data.byteLength - dataOffset * elementBytes : size * elementBytes).slice();
      writes.push({ buffer, owner, phase, frame: hostFrame, label: buffer.label, offset, bytes });
      require(!initializationGuard || (hostFrame !== null && phase === 'initialization'), 'Native initialization write occurred outside a host allowance.');
    });
    replace(gpu.queue, 'submit', (commands: Iterable<GPUCommandBuffer>) => {
      assertTime();
      const commandBuffers = [...commands]; submit(commandBuffers);
      queueSubmissions.push({ owner, phase, commandBufferCount: commandBuffers.length, labels: commandBuffers.map(buffer => buffer.label) });
    });

    const verifyProvider = async (sourceIndex: number, provider: GpuGeometry, expectedOwner: string, expectedPhase: string): Promise<void> => {
      const source = input.sources[sourceIndex]!; const expected = preparation.sources[sourceIndex]!;
      require(provider.initialUploadBytes === expected.expectedInitialUploadBytes, 'Ready provider initial upload accounting differs.');
      require(provider.geometryTelemetry.sourceSeed === expected.source.seed && provider.geometryTelemetry.residentPages === 1, 'Ready provider has the wrong source or root residency.');
      // Native buffer identity links accepted arguments to this borrowed provider; the buffers are never read back.
      const privateBuffers = provider as unknown as { cache: { buffer: GPUBuffer }; resources: { metadata: GPUBuffer; selections: GPUBuffer; residency: GPUBuffer } };
      const targets = [privateBuffers.cache.buffer, privateBuffers.resources.metadata, privateBuffers.resources.selections, privateBuffers.resources.residency];
      const accepted = writes.filter(write => targets.includes(write.buffer));
      require(accepted.every(write => write.owner === expectedOwner && write.phase === expectedPhase), 'Provider initialization writes have an unexpected owner or phase.');
      require(accepted.reduce((sum, write) => sum + write.bytes.byteLength, 0) === expected.expectedInitialUploadBytes, 'Provider accepted queue bytes disagree with preparation.');
      const root = accepted.filter(write => write.buffer === privateBuffers.cache.buffer);
      require(root.length === 1 && root[0]!.offset === 0 && root[0]!.bytes.byteLength === pageBytes && await checkedDigest(root[0]!.bytes) === source.pageHashes[0]!.sha256, 'Ready provider root arguments differ from its authenticated source.');
      const packed = new Uint8Array(expected.metadataBytes); let offset = 0;
      for (const write of accepted.filter(value => value.buffer === privateBuffers.resources.metadata)) {
        require(write.offset === offset, 'Metadata CPU arguments have a gap or overlap.'); packed.set(write.bytes, offset); offset += write.bytes.byteLength;
      }
      const metadata = buildGeometryMetadata(manifests[sourceIndex]!, 2).words;
      require(offset === packed.byteLength && await checkedDigest(packed) === await checkedDigest(new Uint8Array(metadata.buffer)), 'Ready metadata arguments differ from the production packer.');
      (report.sourceReceipts as unknown[]).push({ owner: expectedOwner, source: source.id, manifestSha256: source.manifestSha256,
        meaning: 'CPU arguments accepted by native queue; no pool or metadata readback', acceptedQueueBytes: expected.expectedInitialUploadBytes,
        metadataArgumentSha256: await checkedDigest(packed), rootArgumentSha256: await checkedDigest(root[0]!.bytes), telemetry: provider.geometryTelemetry });
    };
    const render = async (sourceIndex: number, provider: GpuGeometry, renderOwner: string): Promise<Capture> => {
      assertTime(); initializationGuard = false;
      const raster = await bounded(() => {
        const creation = own(`raster:${renderOwner}`, 'raster-setup', () => RasterRenderer.create(gpu, 'rgba8unorm', {}, provider)
          .then(raster => { renderers.set(provider, raster); return raster; }));
        rendererOperations.add(creation);
        void creation.then(() => rendererOperations.delete(creation), () => rendererOperations.delete(creation));
        return creation;
      });
      const { width, height } = framePlan; const bytesPerRow = width * 4; const bytes = bytesPerRow * height;
      const target = own(renderOwner, 'diagnostic', () => gpu.createTexture({ label: 'Region initialization presentation witness', size: [width, height], format: 'rgba8unorm', usage: 16 | 1 }));
      const readback = own(renderOwner, 'diagnostic', () => gpu.createBuffer({ label: 'Region initialization color/depth readback', size: bytes * 2, usage: 1 | 8 }));
      try {
        const expected = preparation.sources[sourceIndex]!; const rootsBefore = writes.filter(write => write.label === 'Strata fixed geometry page pool').length;
        const encoder = gpu.createCommandEncoder({ label: `Region initialization ${renderOwner} final` });
        const prior = { ...provider.geometryTelemetry };
        const stats = own(renderOwner, 'render-outside-initialization-budget', () => raster.encode(encoder, target.createView(), width, height, 0,
          { temporal: false, debugView: 'final', cameraCut: true }));
        require(prior.sourceFrameId === null && stats.triangles === 1, 'First-frame raster stats must describe preceding empty feedback plus presentation.');
        const depth = [...textures].reverse().find(value => value.owner === renderOwner && value.label === 'Strata raster depth' && !value.destroys)?.resource;
        require(depth, 'Existing renderer did not create its depth target.');
        encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow }, [width, height]);
        encoder.copyTextureToBuffer({ texture: depth!, aspect: 'depth-only' }, { buffer: readback, offset: bytes, bytesPerRow }, [width, height]);
        own(renderOwner, 'render-submit', () => gpu.queue.submit([encoder.finish()])); provider.submitted(++submissions);
        await bounded(() => Promise.all([provider.flushFeedback(), readback.mapAsync(1)]));
        const mapped = new Uint8Array(readback.getMappedRange()); const color = mapped.slice(0, bytes); const depthBytes = mapped.slice(bytes);
        readback.unmap(); const depths = new Float32Array(depthBytes.buffer); const telemetry = { ...provider.geometryTelemetry };
        require(telemetry.sourceFrameId === submissions && telemetry.visibleTiles === 4, 'Native selection feedback has the wrong frame or visible tile count.');
        require(telemetry.selectedTriangles === expected.coarseTriangles && telemetry.shadowTriangles === expected.coarseTriangles
          && telemetry.selectedClusters === expected.coarseClusters && telemetry.shadowClusters === expected.coarseClusters, 'Native camera/shadow counts disagree with independent coarse totals.');
        require(telemetry.coverageMissingTiles === 0 && telemetry.missingDetailTiles === 0 && telemetry.overflowCount === 0, 'Native feedback reports missing coarse coverage/detail or overflow.');
        require(stats.drawCalls === 3 && stats.dispatchCalls === 2, 'Existing selection/shadow/raster/presentation path did not execute.');
        require(writes.filter(write => write.label === 'Strata fixed geometry page pool').length === rootsBefore, 'A detail page reached the compared frame.');
        totalDraws += stats.drawCalls; totalDispatches += stats.dispatchCalls;
        let coveredPixels = 0; let interiorSamples = 0;
        for (let pixel = 0; pixel < depths.length; pixel++) {
          require(Number.isFinite(depths[pixel]) && depths[pixel]! >= 0 && depths[pixel]! <= 1, 'Readback contains invalid depth.');
          require(color[pixel * 4 + 3] === 255, 'Readback presentation is not opaque.'); if (depths[pixel]! < 1) coveredPixels++;
        }
        for (const pixel of [0, width - 1, width * (height - 1), width * height - 1]) require(depths[pixel] === 1, 'Expected background corner contains geometry.');
        const half = height / 2 / 1.05;
        for (let y = Math.ceil(height / 2 - half) + 3; y < Math.floor(height / 2 + half) - 3; y++) {
          for (let x = Math.ceil(width / 2 - half) + 3; x < Math.floor(width / 2 + half) - 3; x++) {
            require(depths[y * width + x]! < 1, 'Native depth has a terrain-interior hole.'); interiorSamples++;
          }
        }
        require(interiorSamples === preparation.gates.expectedInteriorSamples, 'Interior sample count changed.');
        const depthSha256 = await checkedDigest(depthBytes); const colorSha256 = await checkedDigest(color);
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d')!; const output = context.createImageData(width, height); output.data.set(color); context.putImageData(output, 0, 0);
        (report.images as Record<string, string>)[renderOwner.replaceAll(':', '-')] = canvas.toDataURL('image/png');
        (report.frames as unknown[]).push({ owner: renderOwner, source: expected.id, ...framePlan, submission: submissions, stats, telemetry,
          statsTriangleCountSourceFrameId: prior.sourceFrameId, statsTriangleCountSourceMeaning: 'Pre-encode feedback; current native counts are in post-submission telemetry.',
          coveredPixels, interiorSamples, colorSha256, depthSha256 });
        assertTime();
        return { color, depth: depths, depthSha256 };
      } finally { try { readback.unmap(); } catch { /* Failed mapping is still cleaned up. */ } readback.destroy(); target.destroy(); initializationGuard = true; }
    };
    const references: Capture[] = [];
    for (let index = 0; index < input.sources.length; index++) {
      initializationGuard = false; const source = input.sources[index]!; const url = new URL(source.manifestUrl, location.href);
      const creationController = new AbortController(); creationControllers.push(creationController);
      const referenceOwner = `eager:${source.id}`;
      const eagerOptions: VirtualSceneOptions & GeometryPageCacheOptions = {
        renderer: 'virtual', manifestUrl: url, geometryMode: 'streamed', cameraMode: 'coverage', pixelError: 1000, poolBytes: 2 * pageBytes,
        maxConcurrentRequests: 2, maxCompletedBytes: pageBytes, maxRetries: 0, requestTimeoutMs: 120_000, uploadBudgetBytes: pageBytes,
        fetch: fetchFor(referenceOwner), signal: creationController.signal,
      };
      const provider = await bounded(() => {
        const operation = own(referenceOwner, 'eager-initialization', () => GpuGeometry.create(gpu, manifests[index]!, url, eagerOptions)
          .then(provider => { eagerProviders.add(provider); return provider; }));
        creationOperations.add(operation); void operation.then(() => creationOperations.delete(operation), () => creationOperations.delete(operation));
        return operation;
      }, 60_000);
      await verifyProvider(index, provider, referenceOwner, 'eager-initialization');
      references.push(await render(index, provider, referenceOwner));
      renderers.get(provider)!.dispose(); renderers.delete(provider); await bounded(() => provider.whenDisposedAndSettled()); eagerProviders.delete(provider);
    }
    require(new Set(references.map(capture => capture.depthSha256)).size === 4, 'Distinct source references produced identical native depth identities.');
    initializationGuard = true;
    const budget = new GeometryTransferBudget(transferLimits); let coordinator!: RegionInitializationCoordinator;
    coordinator = new RegionInitializationCoordinator(gpu, budget, coordinatorLimits,
      { fetch: fetchFor('coordinator:main', { coordinator: () => coordinator, budget }, true), requestTimeoutMs: 120_000 });
    coordinators.push({ name: 'coordinator:main', coordinator, budget });
    const mainWrites = () => writes.filter(write => write.owner === 'coordinator:main' && write.phase === 'initialization');
    const beforeABA = { writes: writes.length, buffers: buffers.length };
    coordinator.replaceDesired(1, [descriptor(0)]);
    require(requests.every(request => request.owner !== 'coordinator:main'), 'replaceDesired performed eager fetch work.');
    await drive('coordinator:main', coordinator, budget, () => controls.length === 1);
    const originalA = coordinator.snapshot().regions[0]!.incarnation;
    coordinator.replaceDesired(2, [descriptor(1, input.sources[0]!.id)]);
    await drive('coordinator:main', coordinator, budget, () => controls.length === 2);
    coordinator.replaceDesired(3, [descriptor(0)]);
    require(controls.every(control => control.signal.aborted), 'ABA retirement did not abort both original owner signals.');
    controls.forEach(deliverControl); await settleWithoutAdvancing(() => controls.every(control => control.cancelStarted));
    for (let count = 0; count < preparation.gates.heldRetirementFrames; count++) {
      await nextFrame(); advance('coordinator:main', coordinator, budget);
      const snapshot = coordinator.snapshot();
      require(snapshot.liveEntries === 2 && snapshot.retiringEntries === 2 && snapshot.retainedManifestBytes === input.sources[0]!.manifestBytes + input.sources[1]!.manifestBytes,
        'Retiring original operations released their slots or retained quota prematurely.');
      require(snapshot.regions[0]!.status === 'queued' && budget.telemetry.requests === 2, 'Fresh A bypassed the held retirement/request caps.');
      require(requests.filter(request => request.owner === 'coordinator:main').length === 2 && writes.length === beforeABA.writes && buffers.length === beforeABA.buffers,
        'Stale manifests allowed a third fetch or native initialization side effect.');
    }
    (report.lifecycle as unknown[]).push({ name: 'aba-held-original-cancellation', execution: 'Controlled abort-insensitive injected fetch and delayed ReadableStream cancellation; no native-network timing claim.',
      snapshot: coordinator.snapshot(), budget: budget.telemetry, originalA, heldFrames: preparation.gates.heldRetirementFrames });
    controls.forEach(control => control.cancellation.resolve());
    await settleWithoutAdvancing(() => coordinator.snapshot().liveEntries === 0);
    require(controls.every(control => control.cancelSettled) && noBudget(budget), 'Original ABA cancellation did not settle its charged ownership.');
    // Finish fresh A alone so admission rotation has a single candidate before expansion.
    await drive('coordinator:main', coordinator, budget, snapshot => snapshot.regions[0]!.status === 'ready' || snapshot.regions[0]!.status === 'failed');
    require(coordinator.snapshot().regions[0]!.status === 'ready' && coordinator.snapshot().regions[0]!.incarnation !== originalA, 'Fresh A did not publish a new authenticated incarnation.');
    const freshA = coordinator.snapshot().regions[0]!.incarnation;
    coordinator.replaceDesired(4, input.sources.map((_, index) => descriptor(index)));
    await drive('coordinator:main', coordinator, budget, snapshot => snapshot.regions.filter(region => region.status === 'ready').length === 2 || snapshot.regions.some(region => region.status === 'failed'));
    const first = coordinator.snapshot();
    require(json(first.regions.map(region => region.status)) === json(['ready', 'ready', 'queued', 'queued']) && first.regions[0]!.incarnation === freshA, 'Four desired sources did not retain the first ready pair in two slots.');
    const compare = (index: number, capture: Capture): void => {
      const reference = references[index]!; let maximumDepthDifference = 0; let maximumColorChannelDifference = 0;
      let changedDepthValues = 0; let changedColorChannels = 0;
      for (let pixel = 0; pixel < capture.depth.length; pixel++) {
        require((capture.depth[pixel] === 1) === (reference.depth[pixel] === 1), 'Coordinator/eager native coverage masks differ.');
        const difference = Math.abs(capture.depth[pixel]! - reference.depth[pixel]!); maximumDepthDifference = Math.max(maximumDepthDifference, difference); if (difference) changedDepthValues++;
      }
      for (let channel = 0; channel < capture.color.length; channel++) {
        const difference = Math.abs(capture.color[channel]! - reference.color[channel]!); maximumColorChannelDifference = Math.max(maximumColorChannelDifference, difference); if (difference) changedColorChannels++;
      }
      require(maximumDepthDifference <= preparation.gates.maximumDepthDifference && maximumColorChannelDifference <= preparation.gates.maximumColorChannelDifference, 'Coordinator/eager native image equivalence exceeded its frozen thresholds.');
      (report.comparisons as unknown[]).push({ source: input.sources[index]!.id, maximumDepthDifference, maximumColorChannelDifference, changedDepthValues, changedColorChannels });
    };
    const firstProviders: GpuGeometry[] = [];
    for (const index of [0, 1]) {
      const provider = borrowReady(coordinator, input.sources[index]!.id); firstProviders.push(provider);
      await verifyProvider(index, provider, 'coordinator:main', 'initialization'); compare(index, await render(index, provider, `coordinator:${input.sources[index]!.id}`));
    }
    require(coordinator.snapshot().liveEntries === 2 && coordinator.snapshot().regions.slice(2).every(region => region.status === 'queued'), 'Rendering changed the two-slot admission state.');
    coordinator.replaceDesired(5, [descriptor(2), descriptor(3)]);
    await settleWithoutAdvancing(() => coordinator.snapshot().liveEntries === 0);
    for (const provider of firstProviders) await retireRenderer(provider);
    require(noBudget(budget), 'First-pair ownership remained after original provider settlement.');
    await drive('coordinator:main', coordinator, budget, snapshot => snapshot.regions.every(region => region.status === 'ready') || snapshot.regions.some(region => region.status === 'failed'));
    require(coordinator.snapshot().regions.every(region => region.status === 'ready'), 'Second pair failed initialization.');
    const secondProviders: GpuGeometry[] = [];
    for (const index of [2, 3]) {
      const provider = borrowReady(coordinator, input.sources[index]!.id); secondProviders.push(provider);
      await verifyProvider(index, provider, 'coordinator:main', 'initialization'); compare(index, await render(index, provider, `coordinator:${input.sources[index]!.id}`));
    }
    const mainAccepted = mainWrites().reduce((sum, write) => sum + write.bytes.byteLength, 0);
    require(mainAccepted === preparation.gates.successfulCoordinatorUploadBytes && coordinator.snapshot().uploadBytes === mainAccepted && budget.telemetry.uploadBytes === mainAccepted, 'Four-source initialization upload total changed.');
    require(coordinator.snapshot().startedEntries === 6 && coordinator.snapshot().peakLiveEntries === 2, 'ABA plus four successful sources have incorrect lifetime counts.');
    (report.lifecycle as unknown[]).push({ name: 'four-source-two-slot-turnover', firstReady: first, secondReady: coordinator.snapshot(), budget: budget.telemetry,
      successfulAcceptedQueueBytes: mainAccepted, secondPairAdmissionOrder: requests.filter(request => request.owner === 'coordinator:main' && request.kind === 'manifest' && ['seed-53', 'seed-54'].includes(request.source)).map(request => request.source) });
    coordinator.dispose(); await bounded(() => coordinator.whenDisposedAndSettled());
    for (const provider of secondProviders) await retireRenderer(provider);
    require(noBudget(budget) && coordinator.snapshot().liveEntries === 0 && coordinator.snapshot().retainedManifestBytes === 0 && coordinator.snapshot().settledEntries === 6, 'Main coordinator disposal did not settle all six original lifetimes.');

    for (const kind of ['corrupt-manifest', 'corrupt-root'] as const) {
      initializationGuard = true; const failureBudget = new GeometryTransferBudget(transferLimits); let failureCoordinator!: RegionInitializationCoordinator;
      const name = `coordinator:${kind}`;
      failureCoordinator = new RegionInitializationCoordinator(gpu, failureBudget, coordinatorLimits,
        { fetch: fetchFor(name, { coordinator: () => failureCoordinator, budget: failureBudget }), requestTimeoutMs: 120_000 });
      coordinators.push({ name, coordinator: failureCoordinator, budget: failureBudget });
      const bufferStart = buffers.length; const submissionStart = queueSubmissions.length;
      failureCoordinator.replaceDesired(1, [descriptor(3, kind, kind)]);
      await drive(name, failureCoordinator, failureBudget, snapshot => snapshot.regions[0]!.status === 'failed' || snapshot.regions[0]!.status === 'ready');
      const failed = failureCoordinator.snapshot(); require(failed.regions[0]!.status === 'failed', 'A corrupted source published a ready provider.');
      const accepted = writes.filter(write => write.owner === name);
      require(!accepted.some(write => write.label === 'Strata fixed geometry page pool'), 'Corrupted root arguments reached a native pool upload.');
      if (kind === 'corrupt-manifest') require(buffers.length === bufferStart && accepted.length === 0 && /SHA-256/.test(failed.regions[0]!.error ?? ''), 'Corrupted manifest did not fail before geometry allocation.');
      else require(accepted.reduce((sum, write) => sum + write.bytes.byteLength, 0) === 1216 && /page failed validation or loading/.test(failed.regions[0]!.error ?? ''), 'Corrupted root did not fail after exactly the bounded metadata/selection writes.');
      const writesAtTerminal = writes.length; failureCoordinator.dispose(); await bounded(() => failureCoordinator.whenDisposedAndSettled());
      await nextFrame(); require(writes.length === writesAtTerminal && queueSubmissions.length === submissionStart, 'Corruption cleanup wrote or submitted stale work.');
      require(noBudget(failureBudget) && failureCoordinator.snapshot().liveEntries === 0 && failureCoordinator.snapshot().retainedManifestBytes === 0, 'Corrupt-source ownership did not settle.');
      require(buffers.slice(bufferStart).every(buffer => buffer.destroys === 1), 'Corrupt-source native buffers were not destroyed exactly once.');
      (report.lifecycle as unknown[]).push({ name: kind, failed, final: failureCoordinator.snapshot(), finalBudget: failureBudget.telemetry,
        acceptedQueueBytes: accepted.reduce((sum, write) => sum + write.bytes.byteLength, 0), rootUploads: 0, submissions: 0 });
    }
    require(submissions === 8 && queueSubmissions.length === 8 && queueSubmissions.every(value => value.commandBufferCount === 1 && value.phase === 'render-submit')
      && totalDraws === 24 && totalDispatches === 16, 'Actual native render submission/draw/dispatch counts differ from preparation.');
    await bounded(() => gpu.queue.onSubmittedWorkDone());
    const validation = await bounded(() => gpu.popErrorScope()); const allocation = await bounded(() => gpu.popErrorScope());
    require(!validation && !allocation, `WebGPU error scope: ${validation?.message ?? allocation?.message}`);
    require(errors.length === 0 && pendingFetches.size === 0 && controls.every(control => control.cancelSettled), 'Native errors or original controlled/fetch operations remain.');
    require(buffers.every(buffer => buffer.destroys === 1) && textures.every(texture => texture.destroys === 1), 'Native resource ownership did not end with exactly one destroy call.');
    assertTime(); report.passed = true;
  } catch (cause) { report.failure = message(cause); }
  finally {
    acquisition.cleanupStarted = true;
    acquisition.lateDeviceCleanupArmed = acquisition.devicePending;
    try { await bounded(() => Promise.allSettled([...(adapterOperation ? [adapterOperation] : []), ...(deviceOperation ? [deviceOperation] : [])])); }
    catch (cause) { errors.push(message(cause)); }
    for (const controller of creationControllers) controller.abort();
    for (const state of coordinators) state.coordinator.dispose();
    for (const control of controls) { deliverControl(control); control.cancellation.resolve(); }
    try { await bounded(() => Promise.allSettled([...creationOperations, ...rendererOperations])); } catch (cause) { errors.push(message(cause)); }
    for (const provider of eagerProviders) provider.dispose();
    try { await bounded(() => Promise.all([...coordinators.map(state => state.coordinator.whenDisposedAndSettled()), ...[...eagerProviders].map(provider => provider.whenDisposedAndSettled())])); }
    catch (cause) { errors.push(message(cause)); }
    for (const [provider, raster] of renderers) { try { raster.dispose(); await bounded(() => provider.whenDisposedAndSettled()); } catch (cause) { errors.push(message(cause)); } }
    renderers.clear(); eagerProviders.clear();
    try { await bounded(() => Promise.allSettled([...pendingFetches])); } catch (cause) { errors.push(message(cause)); }
    for (const record of [...buffers, ...textures]) if (!record.destroys) {
      forcedResourceCleanup++; try { record.resource.destroy(); } catch (cause) { errors.push(message(cause)); }
    }
    try { await bounded(() => Promise.allSettled([...nativeOperations])); } catch (cause) { errors.push(message(cause)); }
    if (device && !acquisition.deviceDestroyed) {
      try { await bounded(() => device!.queue.onSubmittedWorkDone()); } catch (cause) { errors.push(message(cause)); }
      intentionallyDestroyed = true; device.destroy(); acquisition.deviceDestroyed = true;
    }
    report.nativeAcquisition = acquisition;
    report.nativeResources = { buffers: buffers.map(({ resource: _resource, ...record }) => record), textures: textures.map(({ resource: _resource, ...record }) => record),
      liveBuffers: buffers.filter(buffer => !buffer.destroys).length, liveTextures: textures.filter(texture => !texture.destroys).length, forcedResourceCleanup };
    try {
      report.queueWrites = await bounded(() => Promise.all(writes.map(async ({ buffer: _buffer, bytes, ...record }) => ({ ...record,
        bytes: bytes.byteLength, argumentSha256: await checkedDigest(bytes) }))), preparation.gates.totalDeadlineMs);
    } catch (cause) { errors.push(`Queue receipt hashing: ${message(cause)}`); }
    report.queueReceiptMeaning = 'Copied CPU arguments after successful native writeBuffer calls; no pool/metadata readback or execution-completion claim.';
    report.requests = requests;
    report.requestReceiptMeaning = 'Request settled means the injected/native fetch promise returned a Response or rejected; original body/hash/cancellation cleanup is established separately by coordinator/provider settlement barriers.';
    report.finalCoordinators = coordinators.map(state => ({ name: state.name, snapshot: state.coordinator.snapshot(), budget: state.budget.telemetry }));
    report.submissions = submissions; report.nativeQueueSubmissions = queueSubmissions; report.drawCalls = totalDraws; report.dispatchCalls = totalDispatches;
    report.pendingFetches = pendingFetches.size; report.pendingCreationOperations = creationOperations.size;
    report.pendingRendererOperations = rendererOperations.size; report.pendingNativeOperations = nativeOperations.size;
    report.controlledLifetimes = controls.map(control => ({ source: control.record.source, delivered: control.delivered, aborted: control.signal.aborted,
      cancelStarted: control.cancelStarted, cancelSettled: control.cancelSettled }));
    for (const undo of restore.reverse()) undo();
    try { assertTime(); } catch (cause) { errors.push(`Final browser success: ${message(cause)}`); }
    if (errors.length || forcedResourceCleanup || acquisition.adapterPending || acquisition.devicePending || pendingFetches.size || creationOperations.size || rendererOperations.size || nativeOperations.size || controls.some(control => !control.cancelSettled)
      || coordinators.some(state => !noBudget(state.budget) || state.coordinator.snapshot().liveEntries !== 0)) report.passed = false;
  }
  return report;
}
