import { parseGeometryManifest } from '../../packages/core/src/geometry/format.js';
import type { GeometryManifest } from '../../packages/core/src/geometry/format.js';
import { buildGeometryMetadata, createTerrainCamera, geometryProjectionScale } from '../../packages/core/src/geometry/geometry-data.js';
import { GpuGeometry } from '../../packages/core/src/geometry/gpu-geometry.js';
import type { GeometryPageCacheOptions } from '../../packages/core/src/geometry/page-cache.js';
import { GeometryTransferBudget } from '../../packages/core/src/geometry/transfer-budget.js';
import type { GeometryInitialization } from '../../packages/core/src/geometry/transfer-budget.js';
import type { VirtualSceneOptions } from '../../packages/core/src/geometry/virtual-types.js';
import { RasterRenderer } from '../../packages/core/src/rendering/raster-renderer.js';

interface SourceInput {
  readonly id: string;
  readonly manifestUrl: string;
  readonly manifest: unknown;
  readonly manifestSha256: string;
  readonly pageHashes: readonly { readonly id: number; readonly sha256: string }[];
  readonly rootPageIndices: readonly number[];
  readonly poolPages: number;
}
export interface GeometryInitializationValidationInput {
  readonly sources: readonly SourceInput[];
  readonly expectedPreparationHash?: string;
  readonly beforeDispose?: (sourceId: string) => Promise<void>;
}
const pageBytes = 65_536;
const limits = Object.freeze({ maxRequests: 2, pageStagingBytes: pageBytes, transientBytes: 1_048_576,
  residentBytes: 1_048_576, gpuBufferBytes: 4_194_304, uploadBytesPerFrame: pageBytes });
const framePlan = Object.freeze([
  { name: 'coverage', width: 256, height: 256, debugView: 'coverage' as const, cameraCut: true },
  { name: 'final', width: 256, height: 256, debugView: 'final' as const, cameraCut: false },
  { name: 'resized-final', width: 320, height: 192, debugView: 'final' as const, cameraCut: true },
]);
const require = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const json = (value: unknown): string => JSON.stringify(value);
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  return item;
});
const message = (error: unknown): string => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
const digest = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  value => value.toString(16).padStart(2, '0')).join('');
const textDigest = (value: string): Promise<string> => digest(new TextEncoder().encode(value));

/** CPU-only preparation: importing/calling this function creates no browser/GPU resources. */
export function prepareGeometryInitializationValidation(input: GeometryInitializationValidationInput) {
  require(input.sources.length === 2, 'Exactly two procedural sources are required.');
  require(new Set(input.sources.map(source => source.id)).size === 2, 'Source ids must differ.');
  const sources = input.sources.map(source => {
    const manifest = parseGeometryManifest(source.manifest);
    require(/^[a-z][a-z0-9-]*$/.test(source.id), 'Invalid source id.');
    require(/^\/__host-init__\/[a-z][a-z0-9-]*\/manifest\.json$/.test(source.manifestUrl), 'Expected a local generated fixture URL.');
    require(/^[a-f0-9]{64}$/.test(source.manifestSha256), 'Expected a pinned manifest SHA-256.');
    require(json(source.rootPageIndices) === json(manifest.rootPageIds), 'Root receipt disagrees with parsed manifest.');
    const pageHashes = source.pageHashes.map(page => ({ id: page.id, sha256: page.sha256 }));
    require(json(pageHashes) === json(manifest.pages.map(page => ({ id: page.id, sha256: page.sha256 }))), 'Page hash receipt differs from manifest.');
    require(Number.isInteger(source.poolPages) && source.poolPages >= manifest.rootPageIds.length, 'Pool must fit complete roots.');
    const metadata = buildGeometryMetadata(manifest, source.poolPages);
    const maximumCoarseProjectedError = Math.max(...framePlan.map(frame => {
      const camera = createTerrainCamera(manifest, frame.width, frame.height, 0, [0, 0], 'coverage');
      require(camera.orthographic, 'Expected the existing orthographic coverage camera.');
      return Math.max(...manifest.tiles.map(tile => tile.lods.at(-1)!.error * geometryProjectionScale(camera, frame.height)));
    }));
    // A factor-of-two gap avoids a numerically marginal GPU desired-LOD decision.
    require(maximumCoarseProjectedError < 500, 'Pinned coarsest geometry cannot be selected safely with pixelError 1000.');
    return { id: source.id, manifestUrl: source.manifestUrl, manifestSha256: source.manifestSha256, pageHashes,
      source: manifest.source, poolPages: source.poolPages, rootPageIndices: source.rootPageIndices,
      pages: manifest.pages.length, tiles: manifest.tiles.length, clusters: manifest.clusters.length,
      metadataBytes: metadata.words.byteLength, selectionBytes: manifest.tiles.length * 32, residencyBytes: manifest.pages.length * 4, maximumCoarseProjectedError,
      expectedInitialUploadBytes: metadata.words.byteLength + manifest.tiles.length * 32 + manifest.pages.length * 4 + manifest.rootPageIds.length * pageBytes,
      coarseTriangles: manifest.tiles.reduce((sum, tile) => sum + tile.lods.at(-1)!.clusterIds.reduce((count, id) => count + manifest.clusters[id]!.triangleCount, 0), 0),
      coarseClusters: manifest.tiles.reduce((sum, tile) => sum + tile.lods.at(-1)!.clusterIds.length, 0) };
  });
  require(sources.some(source => source.source.seed === 45 && source.source.tilesPerSide === 4 && source.source.cellsPerTile === 64 && source.metadataBytes > pageBytes), 'Missing pinned large-metadata fixture.');
  require(sources.some(source => source.source.seed === 46 && source.source.tilesPerSide === 2 && source.source.cellsPerTile === 8), 'Missing pinned small fixture.');
  require(new Set(sources.map(source => source.pageHashes[source.rootPageIndices[0]!]!.sha256)).size === 2, 'Sources must contain distinct root bytes.');
  return { schema: 'strata-host-initialization-webgpu-preparation-v1', sources, limits, frames: framePlan, pixelError: 1000,
    gates: { maximumInitializationFrames: 600, initializationDeadlineMs: 60_000, totalDeadlineMs: 180_000,
      directRenderSubmissions: 12, expectedDrawCalls: 36, expectedDispatchCalls: 24,
      coverageBoundaryPixels: 3, minimumInteriorSamples: 10_000, minimumCoverageChannel: 240, maximumBackgroundChannelExclusive: 100,
      maximumDepthDifference: 0.000002, maximumColorChannelDifference: 1 },
    exclusions: ['Queue hashes describe CPU arguments, not GPU pool/metadata bytes.', 'Initialization upload cap excludes RasterRenderer setup and ordinary prepare() writes.',
      'Resource counters describe logical ownership and requested native sizes, not driver memory.', 'No performance or full-world acceptance claim.'],
    observation: 'Native GPU resources and descriptor usages are unchanged. Existing raster depth and a harness-owned presentation target are copied after the actual render.' };
}

interface BufferRecord { readonly resource: GPUBuffer; readonly owner: string; readonly label: string; readonly size: number; readonly usage: number; destroys: number }
interface TextureRecord { readonly resource: GPUTexture; readonly owner: string; readonly label: string; readonly format: GPUTextureFormat; destroys: number }
interface WriteRecord { readonly owner: string; readonly phase: string; readonly hostFrame: number | null; readonly label: string; readonly offset: number; readonly bytes: Uint8Array<ArrayBuffer> }
interface RequestRecord { readonly owner: string; readonly url: string; readonly root: boolean; readonly startedFrame: number | null; settled: boolean; aborted: boolean; outcome?: string }
interface ImageFrame { readonly name: string; readonly width: number; readonly height: number; readonly color: Uint8Array<ArrayBuffer>; readonly depth: Float32Array<ArrayBuffer>; readonly telemetry: Record<string, unknown> }

/** Runs only when explicitly invoked in an allocated WebGPU validation window. */
export async function runGeometryInitializationValidation(input: GeometryInitializationValidationInput) {
  const preparation = prepareGeometryInitializationValidation(input);
  const preparationSha256 = await textDigest(canonicalJson(preparation));
  require(preparationSha256 === input.expectedPreparationHash, 'Browser preparation differs from the frozen CPU preparation.');
  const report: Record<string, unknown> = { schema: 'strata-host-initialization-webgpu-v1', passed: false, performanceEvidence: false,
    preparationSha256, preparation, frames: [], initializationFrames: [], lifecycle: [], sourceReceipts: [], errors: [], images: {} };
  const errors = report.errors as string[];
  const deadline = performance.now() + preparation.gates.totalDeadlineMs;
  let device: GPUDevice | undefined;
  let owner = 'harness'; let phase = 'setup'; let hostFrame: number | null = null; let submission = 0;
  let initializationOnly = true;
  const queueSubmissions: { owner: string; phase: string; commandBufferCount: number; labels: string[] }[] = [];
  let intentionallyDestroyed = false;
  const buffers: BufferRecord[] = []; const textures: TextureRecord[] = []; const writes: WriteRecord[] = [];
  const requests: RequestRecord[] = []; const pendingFetches = new Set<Promise<unknown>>();
  const handles = new Map<GeometryInitialization<GpuGeometry>, string>(); const providers = new Map<GpuGeometry, string>();
  const renderers = new Map<RasterRenderer, string>(); const budgets: GeometryTransferBudget[] = [];
  const restore: (() => void)[] = [];
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const assertTime = (): void => require(performance.now() < deadline, 'Validation exceeded the preregistered 180-second bound.');
  const bounded = async <T>(promise: Promise<T>, milliseconds = 10_000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Bounded browser operation timed out.')), Math.min(milliseconds, Math.max(1, deadline - performance.now()))); })]); }
    finally { clearTimeout(timer); }
  };
  const nextFrame = (): Promise<void> => bounded(new Promise(resolve => requestAnimationFrame(() => resolve())), 5_000);
  const own = <T>(nextOwner: string, nextPhase: string, action: () => T): T => {
    const previousOwner = owner; const previousPhase = phase; owner = nextOwner; phase = nextPhase;
    const reset = (): void => { owner = previousOwner; phase = previousPhase; };
    try { const value = action(); if (value instanceof Promise) return value.finally(reset) as T; reset(); return value; }
    catch (cause) { reset(); throw cause; }
  };
  const beforeDispose = (sourceId: string): Promise<void> => bounded(input.beforeDispose?.(sourceId) ?? Promise.resolve());
  const replace = (object: object, key: string, value: unknown): void => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, writable: true, value });
    restore.push(() => { if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key); });
  };
  const trackedFetch = (requestOwner: string, manifest: GeometryManifest, url: URL): typeof fetch => async (resource, options) => {
    const requestUrl = new URL(resource instanceof Request ? resource.url : String(resource), location.href);
    const page = manifest.pages.find(value => new URL(value.url, url).href === requestUrl.href);
    require(page, `Unexpected page request: ${requestUrl.href}`);
    const record: RequestRecord = { owner: requestOwner, url: requestUrl.href, root: manifest.rootPageIds.includes(page!.id),
      startedFrame: hostFrame, settled: false, aborted: options?.signal?.aborted ?? false };
    requests.push(record);
    const aborted = (): void => { record.aborted = true; };
    options?.signal?.addEventListener('abort', aborted, { once: true });
    const pending = nativeFetch(resource, options);
    pendingFetches.add(pending);
    try { const response = await pending; record.outcome = `HTTP ${response.status}`; return response; }
    catch (cause) { record.outcome = message(cause); throw cause; }
    finally { record.settled = true; pendingFetches.delete(pending); options?.signal?.removeEventListener('abort', aborted); }
  };
  const optionsFor = (source: SourceInput, manifest: GeometryManifest, requestOwner: string, signal?: AbortSignal): VirtualSceneOptions & GeometryPageCacheOptions => {
    const url = new URL(source.manifestUrl, location.href);
    return { renderer: 'virtual', manifestUrl: url, geometryMode: 'streamed', cameraMode: 'coverage', pixelError: preparation.pixelError,
      poolBytes: source.poolPages * pageBytes, uploadBudgetBytes: pageBytes, maxConcurrentRequests: 2,
      maxCompletedBytes: pageBytes, maxRetries: 0, requestTimeoutMs: 120_000, fetch: trackedFetch(requestOwner, manifest, url), ...(signal ? { signal } : {}) };
  };
  const checkBudget = (budget: GeometryTransferBudget): void => {
    const telemetry = budget.telemetry;
    for (const key of ['pageStagingBytes', 'transientBytes', 'residentBytes', 'gpuBufferBytes'] as const) require(telemetry[key] <= budget.limits[key], `${key} exceeds its shared limit.`);
    require(telemetry.requests <= budget.limits.maxRequests, 'Request count exceeds shared limit.');
  };
  const noBudget = (budget: GeometryTransferBudget): boolean => (['requests', 'pageStagingBytes', 'transientBytes', 'residentBytes', 'gpuBufferBytes'] as const)
    .every(key => budget.telemetry[key] === 0);
  const drain = async (): Promise<void> => {
    for (let count = 0; count < 120 && (pendingFetches.size || budgets.some(budget => !noBudget(budget))); count++) { assertTime(); await nextFrame(); }
    require(pendingFetches.size === 0 && budgets.every(noBudget), 'Disposal did not settle all requests and logical leases.');
  };
  const advance = (budget: GeometryTransferBudget, active: readonly { id: string; handle: GeometryInitialization<GpuGeometry> }[], frameId: number): void => {
    hostFrame = frameId;
    const allowance = budget.beginFrame(frameId); const before = writes.length; let returned = 0;
    for (const item of active) if (item.handle.status === 'pending') returned += own(item.id, 'initialization', () => item.handle.advance(allowance).uploadBytes);
    const actual = writes.slice(before).reduce((sum, write) => sum + write.bytes.byteLength, 0);
    require(actual === returned && actual === allowance.writtenBytes && actual <= pageBytes, 'Shared frame receipt differs from successful native queue calls.');
    checkBudget(budget);
    (report.initializationFrames as unknown[]).push({ frameId, owners: active.map(item => item.id), actualAcceptedQueueBytes: actual,
      returnedUploadBytes: returned, remainingBytes: allowance.remainingBytes, statuses: active.map(item => item.handle.status), budget: budget.telemetry });
    hostFrame = null;
  };
  const verifyInitialWrites = async (source: SourceInput, manifest: GeometryManifest, id: string, writePhase: string) => {
    const accepted = writes.filter(value => value.owner === id && value.phase === writePhase);
    const expectedMetadata = buildGeometryMetadata(manifest, source.poolPages).words;
    const metadata = new Uint8Array(expectedMetadata.byteLength); let metadataOffset = 0;
    for (const value of accepted.filter(write => write.label === 'Strata cooked geometry metadata')) {
      require(value.offset === metadataOffset, 'Metadata queue arguments have a gap or overlap.');
      metadata.set(value.bytes, value.offset); metadataOffset += value.bytes.byteLength;
    }
    require(metadataOffset === metadata.byteLength && await digest(metadata) === await digest(new Uint8Array(expectedMetadata.buffer)), 'Metadata CPU write arguments differ from the prepared packer.');
    const rootWrites = accepted.filter(value => value.label === 'Strata fixed geometry page pool');
    require(rootWrites.length === manifest.rootPageIds.length && rootWrites.every(value => value.bytes.byteLength === pageBytes), 'Native queue did not accept exactly one complete write per root.');
    const rootArgumentHashes = await Promise.all(rootWrites.map(async value => ({ offset: value.offset, sha256: await digest(value.bytes) })));
    require(json(rootArgumentHashes.map(value => value.sha256).sort()) === json(manifest.rootPageIds.map(id => manifest.pages[id]!.sha256).sort()), 'Root CPU write arguments differ from authenticated source pages.');
    const residencyWrites = accepted.filter(value => value.label === 'Strata page residency table');
    require(residencyWrites.reduce((sum, value) => sum + value.bytes.byteLength, 0) === manifest.pages.length * 4, 'Final residency write is incomplete.');
    const allowed = new Set(['Strata fixed geometry page pool', 'Strata cooked geometry metadata', 'Strata page residency table', 'Strata current tile LOD selections']);
    require(accepted.every(value => allowed.has(value.label)), 'Unexpected eager uniform or unrelated initialization write.');
    return { owner: id, meaning: 'CPU write arguments accepted by native queue; not GPU buffer readback',
      metadataArgumentSha256: await digest(metadata), rootArgumentHashes, acceptedQueueBytes: accepted.reduce((sum, value) => sum + value.bytes.byteLength, 0) };
  };
  const initialize = async (budget: GeometryTransferBudget, active: readonly { id: string; handle: GeometryInitialization<GpuGeometry> }[], stop?: () => boolean): Promise<void> => {
    const until = performance.now() + preparation.gates.initializationDeadlineMs;
    for (let id = 0; id < preparation.gates.maximumInitializationFrames; id++) {
      assertTime(); require(performance.now() < until, 'Initialization exceeded its 60-second bound.');
      const before = writes.length; await nextFrame();
      require(writes.length === before, 'Initialization wrote asynchronously between host frame allowances.');
      advance(budget, active, id);
      if (stop?.() || active.every(item => item.handle.status !== 'pending')) return;
    }
    throw new Error('Initialization exceeded 600 host frames.');
  };
  try {
    const sourceManifests = new Map<string, GeometryManifest>();
    for (const source of input.sources) {
      const response = await bounded(nativeFetch(new URL(source.manifestUrl, location.href)));
      require(response.ok, `Manifest HTTP ${response.status}`);
      const raw = new Uint8Array(await response.arrayBuffer());
      const manifestSha256 = await digest(raw);
      require(manifestSha256 === source.manifestSha256, 'Fetched manifest differs from prepared source SHA-256.');
      const manifest = parseGeometryManifest(JSON.parse(new TextDecoder().decode(raw)));
      require(json(manifest) === json(parseGeometryManifest(source.manifest)), 'Fetched source differs from prepared parsed manifest.');
      sourceManifests.set(source.id, manifest);
      (report.sourceReceipts as unknown[]).push({ id: source.id, manifestSha256, source: manifest.source, roots: manifest.rootPageIds });
    }
    const adapter = await bounded(navigator.gpu.requestAdapter()); require(adapter, 'WebGPU adapter unavailable.');
    report.adapter = { vendor: adapter!.info.vendor, architecture: adapter!.info.architecture, device: adapter!.info.device,
      description: adapter!.info.description, isFallbackAdapter: adapter!.info.isFallbackAdapter };
    device = await bounded(adapter!.requestDevice()); const gpu = device;
    gpu.addEventListener('uncapturederror', event => errors.push(event.error.message));
    void gpu.lost.then(info => { if (!intentionallyDestroyed) errors.push(`Unexpected device loss: ${info.reason}: ${info.message}`); });
    gpu.pushErrorScope('out-of-memory'); gpu.pushErrorScope('validation');
    const createBuffer = gpu.createBuffer.bind(gpu); const createTexture = gpu.createTexture.bind(gpu);
    const writeBuffer = gpu.queue.writeBuffer.bind(gpu.queue); const submit = gpu.queue.submit.bind(gpu.queue);
    replace(gpu, 'createBuffer', (descriptor: GPUBufferDescriptor) => {
      const resource = createBuffer(descriptor);
      const record: BufferRecord = { resource, owner, label: descriptor.label ?? '', size: descriptor.size, usage: descriptor.usage, destroys: 0 };
      buffers.push(record);
      const destroy = resource.destroy.bind(resource);
      replace(resource, 'destroy', () => { record.destroys++; destroy(); });
      require(resource.usage === descriptor.usage, 'Observer changed native buffer usage.');
      if (phase === 'initialization') {
        const reserved = budgets.reduce((sum, budget) => sum + budget.telemetry.gpuBufferBytes, 0);
        const owned = buffers.filter(value => value.owner.startsWith('host:') && !value.destroys).reduce((sum, value) => sum + value.size, 0);
        require(owned <= reserved, 'Native initializer allocation preceded aggregate admission.');
      }
      return resource;
    });
    replace(gpu, 'createTexture', (descriptor: GPUTextureDescriptor) => {
      const resource = createTexture(descriptor); const record: TextureRecord = { resource, owner, label: descriptor.label ?? '', format: descriptor.format, destroys: 0 };
      textures.push(record); const destroy = resource.destroy.bind(resource);
      replace(resource, 'destroy', () => { record.destroys++; destroy(); }); return resource;
    });
    replace(gpu.queue, 'writeBuffer', (buffer: GPUBuffer, offset: number, data: AllowSharedBufferSource, dataOffset = 0, size?: number) => {
      const view = ArrayBuffer.isView(data); const elementBytes = view && 'BYTES_PER_ELEMENT' in data ? Number(data.BYTES_PER_ELEMENT) : 1;
      const bytes = new Uint8Array(view ? data.buffer : data, (view ? data.byteOffset : 0) + dataOffset * elementBytes,
        size === undefined ? data.byteLength - dataOffset * elementBytes : size * elementBytes).slice();
      writeBuffer(buffer, offset, data, dataOffset, size);
      writes.push({ owner, phase, hostFrame, label: buffer.label, offset, bytes });
      require(!initializationOnly || hostFrame !== null, 'Native initialization write occurred outside a host allowance.');
    });
    replace(gpu.queue, 'submit', (commands: Iterable<GPUCommandBuffer>) => {
      const commandBuffers = [...commands]; submit(commandBuffers);
      queueSubmissions.push({ owner, phase, commandBufferCount: commandBuffers.length, labels: commandBuffers.map(value => value.label) });
    });

    const budget = new GeometryTransferBudget(limits); budgets.push(budget);
    const active = input.sources.map(source => {
      const id = `host:${source.id}`; const manifest = sourceManifests.get(source.id)!;
      const creationController = new AbortController();
      const beforeBuffers = buffers.length; const beforeWrites = writes.length; const beforeRequests = requests.length;
      const handle = own(id, 'begin', () => GpuGeometry.begin(gpu, manifest, new URL(source.manifestUrl, location.href), optionsFor(source, manifest, id, creationController.signal), budget));
      handles.set(handle, source.id);
      require(beforeBuffers === buffers.length && beforeWrites === writes.length && beforeRequests === requests.length, 'begin() performed eager initialization work.');
      return { id, handle, creationController };
    });
    await initialize(budget, active);
    require(active.every(item => item.handle.status === 'ready'), `Initialization failed: ${active.map(item => message(item.handle.error)).join('; ')}`);
    const hostProviders = new Map<string, GpuGeometry>();
    for (const [index, item] of active.entries()) {
      const source = input.sources[index]!; const expected = preparation.sources[index]!;
      const provider = item.handle.takeReady(); providers.set(provider, source.id); hostProviders.set(source.id, provider);
      let secondTakeFailed = false; try { item.handle.takeReady(); } catch { secondTakeFailed = true; }
      require(secondTakeFailed, 'takeReady() transferred ownership twice.');
      item.handle.dispose();
      item.creationController.abort(new Error('Creation signal aborted after ownership transfer'));
      require(buffers.filter(value => value.owner === item.id).every(value => value.destroys === 0), 'Taken handle disposed provider buffers.');
      const accepted = writes.filter(value => value.owner === item.id && value.phase === 'initialization');
      require(accepted.reduce((sum, value) => sum + value.bytes.byteLength, 0) === expected.expectedInitialUploadBytes, 'Initial native write total differs from prepared sources.');
      require(provider.initialUploadBytes === expected.expectedInitialUploadBytes, 'Provider initial-upload accounting differs.');
      require(provider.geometryTelemetry.residentPages === expected.rootPageIndices.length, 'Ready provider lacks exact complete roots.');
      require(requests.filter(value => value.owner === item.id).every(value => value.root && value.settled), 'Readiness retained an unsettled root request or requested detail early.');
      const metadataWrites = accepted.filter(value => value.label === 'Strata cooked geometry metadata');
      const metadataFrames = new Set(metadataWrites.map(value => value.hostFrame));
      if (expected.metadataBytes > pageBytes) require(metadataFrames.size >= 2, 'Large metadata did not span host frames.');
      (report.lifecycle as unknown[]).push({ name: 'ready-transfer', owner: item.id, status: item.handle.status, metadataFrames: [...metadataFrames],
        creationSignalAbortedAfterTransfer: item.creationController.signal.aborted,
        telemetry: provider.geometryTelemetry, gpuBufferBytes: provider.gpuBufferBytes, initialUploadBytes: provider.initialUploadBytes,
        queueArguments: await verifyInitialWrites(source, sourceManifests.get(source.id)!, item.id, 'initialization') });
    }
    report.sharedReadyBudget = budget.telemetry;
    initializationOnly = false;

    const render = async (source: SourceInput, provider: GpuGeometry, mode: 'host' | 'eager'): Promise<ImageFrame[]> => {
      const id = `${mode}:${source.id}`; const expected = preparation.sources.find(value => value.id === source.id)!;
      const raster = await own(`raster:${id}`, 'raster-setup', () => bounded(RasterRenderer.create(gpu, 'rgba8unorm', {}, provider)));
      renderers.set(raster, source.id); const images: ImageFrame[] = [];
      try {
        for (const frame of framePlan) {
          assertTime(); const frameOwner = `readback:${id}:${frame.name}`;
          const target = own(frameOwner, 'diagnostic', () => gpu.createTexture({ label: 'Host initialization presentation witness', size: [frame.width, frame.height], format: 'rgba8unorm', usage: 16 | 1 }));
          const bytesPerRow = Math.ceil(frame.width * 4 / 256) * 256; const bytes = bytesPerRow * frame.height;
          const readback = own(frameOwner, 'diagnostic', () => gpu.createBuffer({ label: 'Host initialization color/depth readback', size: bytes * 2, usage: 1 | 8 }));
          try {
            const beforePages = writes.filter(value => value.label === 'Strata fixed geometry page pool').length;
            const encoder = gpu.createCommandEncoder({ label: `Host initialization ${id} ${frame.name}` });
            const priorFeedback = { ...provider.geometryTelemetry };
            const stats = own(id, 'render-outside-initialization-budget', () => raster.encode(encoder, target.createView(), frame.width, frame.height, 0,
              { temporal: false, debugView: frame.debugView, cameraCut: frame.cameraCut }));
            require(stats.triangles === Number(priorFeedback.selectedTriangles) + Number(priorFeedback.shadowTriangles) + 1,
              'Returned raster triangle count disagrees with its preceding GPU feedback.');
            require(priorFeedback.sourceFrameId === null || priorFeedback.sourceFrameId < submission + 1, 'Pre-encode feedback was incorrectly labeled as current.');
            const depth = [...textures].reverse().find(value => value.label === 'Strata raster depth' && value.destroys === 0)?.resource;
            require(depth, 'Production raster did not create a depth target.');
            encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow }, [frame.width, frame.height]);
            encoder.copyTextureToBuffer({ texture: depth!, aspect: 'depth-only' }, { buffer: readback, offset: bytes, bytesPerRow }, [frame.width, frame.height]);
            own(id, 'render-submit', () => gpu.queue.submit([encoder.finish()])); provider.submitted(++submission);
            await bounded(Promise.all([provider.flushFeedback(), readback.mapAsync(1)]));
            const mapped = new Uint8Array(readback.getMappedRange()); const color = new Uint8Array(frame.width * frame.height * 4); const depthBytes = new Uint8Array(color.byteLength);
            for (let y = 0; y < frame.height; y++) {
              color.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + frame.width * 4), y * frame.width * 4);
              depthBytes.set(mapped.subarray(bytes + y * bytesPerRow, bytes + y * bytesPerRow + frame.width * 4), y * frame.width * 4);
            }
            readback.unmap(); const depths = new Float32Array(depthBytes.buffer); const telemetry = { ...provider.geometryTelemetry };
            require(telemetry.sourceFrameId === submission, 'GPU feedback has the wrong source submission.');
            require(telemetry.coverageMissingTiles === 0 && telemetry.overflowCount === 0, 'GPU reported a coverage hole or work-list overflow.');
            require(telemetry.selectedTriangles === expected.coarseTriangles && telemetry.shadowTriangles === expected.coarseTriangles,
              'Actual camera/shadow triangle counts differ from independent coarse totals.');
            require(telemetry.selectedClusters === expected.coarseClusters && telemetry.shadowClusters === expected.coarseClusters,
              'Actual camera/shadow cluster counts differ from independent coarse totals.');
            require(stats.drawCalls === 3 && stats.dispatchCalls === 2, 'Expected production selection/shadow/raster/presentation path did not execute.');
            require(writes.filter(value => value.label === 'Strata fixed geometry page pool').length === beforePages, 'Held detail reached the compared render.');
            const half = frame.height / 2 / 1.05; let interiorSamples = 0; let minimumCoverage = 255; let covered = 0;
            for (let pixel = 0; pixel < depths.length; pixel++) {
              require(Number.isFinite(depths[pixel]) && depths[pixel]! >= 0 && depths[pixel]! <= 1, 'Invalid GPU depth value.');
              require(color[pixel * 4 + 3] === 255, 'Presentation is not opaque.');
              if (depths[pixel]! < 1) covered++;
            }
            for (let y = Math.ceil(frame.height / 2 - half) + 3; y < Math.floor(frame.height / 2 + half) - 3; y++) {
              for (let x = Math.ceil(frame.width / 2 - half) + 3; x < Math.floor(frame.width / 2 + half) - 3; x++) {
                const pixel = y * frame.width + x; require(depths[pixel]! < 1, 'Missing actual raster depth in terrain interior.'); interiorSamples++;
                if (frame.debugView === 'coverage') minimumCoverage = Math.min(minimumCoverage, color[pixel * 4]!, color[pixel * 4 + 1]!, color[pixel * 4 + 2]!);
              }
            }
            require(interiorSamples > 10_000, 'Coverage witness is too small.');
            if (frame.debugView === 'coverage') require(minimumCoverage >= 240 && [...color.subarray(0, 3)].every(value => value < 100), 'Coverage/background diagnostic is invalid.');
            const canvas = document.createElement('canvas'); canvas.width = frame.width; canvas.height = frame.height;
            const context = canvas.getContext('2d')!; const image = context.createImageData(frame.width, frame.height); image.data.set(color); context.putImageData(image, 0, 0);
            (report.images as Record<string, string>)[`${mode}-${source.id}-${frame.name}`] = canvas.toDataURL('image/png');
            (report.frames as unknown[]).push({ owner: id, name: frame.name, width: frame.width, height: frame.height, sourceFrameId: submission,
              temporal: false, timeSeconds: 0, cameraCut: frame.cameraCut, stats, telemetry, coveredPixels: covered, interiorSamples,
              statsTriangleCountSourceFrameId: priorFeedback.sourceFrameId,
              statsTriangleCountSourceMeaning: 'Harness captured provider feedback immediately before encode; RasterRenderer stats have no source-id field.',
              ...(frame.debugView === 'coverage' ? { minimumCoverage } : {}), colorSha256: await digest(color), depthSha256: await digest(depthBytes) });
            images.push({ name: frame.name, width: frame.width, height: frame.height, color, depth: depths, telemetry });
          } finally { try { readback.unmap(); } catch { /* Cleanup also handles a failed map. */ } readback.destroy(); target.destroy(); }
        }
      } finally { await beforeDispose(source.id); raster.dispose(); renderers.delete(raster); providers.delete(provider); }
      return images;
    };

    const comparisons = [];
    for (const source of input.sources) {
      const host = hostProviders.get(source.id)!; const hostImages = await render(source, host, 'host');
      const manifest = sourceManifests.get(source.id)!;
      const eager = await own(`eager:${source.id}`, 'eager-initialization', () => bounded(GpuGeometry.create(gpu, manifest,
        new URL(source.manifestUrl, location.href), optionsFor(source, manifest, `eager:${source.id}`)), 60_000));
      providers.set(eager, source.id);
      require(eager.initialUploadBytes === preparation.sources.find(value => value.id === source.id)!.expectedInitialUploadBytes, 'Unchanged eager initialization receipt differs.');
      (report.lifecycle as unknown[]).push({ name: 'eager-ready', owner: `eager:${source.id}`, telemetry: eager.geometryTelemetry,
        queueArguments: await verifyInitialWrites(source, manifest, `eager:${source.id}`, 'eager-initialization') });
      const eagerImages = await render(source, eager, 'eager');
      for (const [index, left] of hostImages.entries()) {
        const right = eagerImages[index]!; let maximumDepthDifference = 0; let maximumColorChannelDifference = 0; let changedDepthValues = 0; let changedColorChannels = 0;
        for (let pixel = 0; pixel < left.depth.length; pixel++) {
          require((left.depth[pixel] === 1) === (right.depth[pixel] === 1), 'Host/eager raster coverage masks differ.');
          const difference = Math.abs(left.depth[pixel]! - right.depth[pixel]!); maximumDepthDifference = Math.max(maximumDepthDifference, difference); if (difference) changedDepthValues++;
        }
        for (let channel = 0; channel < left.color.length; channel++) {
          const difference = Math.abs(left.color[channel]! - right.color[channel]!); maximumColorChannelDifference = Math.max(maximumColorChannelDifference, difference); if (difference) changedColorChannels++;
        }
        require(maximumDepthDifference <= preparation.gates.maximumDepthDifference && maximumColorChannelDifference <= 1, 'Host/eager GPU render exceeded preregistered equivalence thresholds.');
        comparisons.push({ source: source.id, frame: left.name, maximumDepthDifference, maximumColorChannelDifference, changedDepthValues, changedColorChannels });
      }
    }
    report.comparisons = comparisons;
    require(submission === 12 && queueSubmissions.length === 12 && queueSubmissions.every(value => value.commandBufferCount === 1), 'Unexpected actual native queue submission count.');
    await drain();

    const small = input.sources.find(source => parseGeometryManifest(source.manifest).source.seed === 46)!;
    for (const kind of ['cancel', 'corrupt'] as const) {
      initializationOnly = true;
      const source = { ...small, id: kind, manifestUrl: `/__host-init__/${kind}/manifest.json` };
      const response = await bounded(nativeFetch(new URL(source.manifestUrl, location.href))); require(response.ok, `Lifecycle manifest HTTP ${response.status}`);
      const raw = new Uint8Array(await response.arrayBuffer()); require(await digest(raw) === small.manifestSha256, 'Lifecycle source changed its manifest identity.');
      const manifest = parseGeometryManifest(JSON.parse(new TextDecoder().decode(raw))); const controller = new AbortController();
      const lifecycleBudget = new GeometryTransferBudget(limits); budgets.push(lifecycleBudget); const id = `host:${kind}`;
      const handle = own(id, 'begin', () => GpuGeometry.begin(gpu, manifest, new URL(source.manifestUrl, location.href), optionsFor(source, manifest, id, controller.signal), lifecycleBudget));
      handles.set(handle, kind);
      await initialize(lifecycleBudget, [{ id, handle }], kind === 'cancel' ? () => requests.some(value => value.owner === id && value.root && !value.settled) : undefined);
      if (kind === 'cancel') {
        require(handle.status === 'pending' && lifecycleBudget.telemetry.pageStagingBytes === pageBytes, 'Cancellation did not interrupt an owned pending root request.');
        await beforeDispose(kind);
        controller.abort(new Error('Deliberate host initialization cancellation'));
      }
      require(handle.status === 'failed', `${kind} initializer unexpectedly published readiness.`);
      let took = false; try { handle.takeReady(); took = true; } catch { /* Expected terminal refusal. */ }
      require(!took, 'Failed initializer transferred a provider.');
      require(writes.some(value => value.owner === id && value.label === 'Strata cooked geometry metadata'), 'Lifecycle witness failed before native metadata writes.');
      require(!writes.some(value => value.owner === id && value.label === 'Strata fixed geometry page pool'), 'Canceled/corrupt root reached a native page write.');
      const before = writes.filter(value => value.owner === id).length; const terminal = { name: kind, status: handle.status, error: message(handle.error), budgetAtTerminal: lifecycleBudget.telemetry };
      await beforeDispose(kind); handle.dispose(); await drain();
      require(writes.filter(value => value.owner === id).length === before, 'Stale lifecycle work wrote after termination.');
      require(buffers.filter(value => value.owner === id).every(value => value.destroys === 1), 'Lifecycle GPU buffers were not destroyed exactly once.');
      (report.lifecycle as unknown[]).push({ ...terminal, settledBudget: lifecycleBudget.telemetry, nativeWritesAfterTerminal: 0 });
      initializationOnly = false;
    }
    await bounded(gpu.queue.onSubmittedWorkDone());
    const validationError = await bounded(gpu.popErrorScope()); const allocationError = await bounded(gpu.popErrorScope());
    require(!validationError && !allocationError, `WebGPU error scope: ${validationError?.message ?? allocationError?.message}`);
    require(errors.length === 0, errors.join('\n'));
    require(buffers.every(value => value.destroys === 1) && textures.every(value => value.destroys === 1), 'Native resources did not finish with exactly one destroy call.');
    require(submission === 12 && queueSubmissions.length === 12
      && queueSubmissions.every(value => value.commandBufferCount === 1 && value.phase === 'render-submit'),
    'Lifecycle work changed the exact twelve native render submissions.');
    report.passed = true;
  } catch (cause) { report.failure = message(cause); }
  finally {
    const cleanup = async (sourceId: string, action: () => void, notify = true): Promise<void> => {
      if (notify) { try { await beforeDispose(sourceId); } catch (cause) { errors.push(message(cause)); } }
      try { action(); } catch (cause) { errors.push(message(cause)); }
    };
    for (const [raster, sourceId] of renderers) await cleanup(sourceId, () => raster.dispose());
    for (const [provider, sourceId] of providers) await cleanup(sourceId, () => provider.dispose());
    for (const [handle, sourceId] of handles) await cleanup(sourceId, () => handle.dispose(), handle.status === 'pending' || handle.status === 'ready');
    try { await drain(); } catch (cause) { errors.push(message(cause)); }
    for (const record of [...buffers, ...textures]) if (!record.destroys) { try { record.resource.destroy(); } catch (cause) { errors.push(message(cause)); } }
    if (device) {
      try { await bounded(device.queue.onSubmittedWorkDone()); } catch (cause) { errors.push(message(cause)); }
      intentionallyDestroyed = true; device.destroy();
    }
    report.nativeResources = { buffers: buffers.map(({ resource: _resource, ...record }) => record), textures: textures.map(({ resource: _resource, ...record }) => record),
      liveBuffers: buffers.filter(value => !value.destroys).length, liveTextures: textures.filter(value => !value.destroys).length };
    report.queueWrites = await Promise.all(writes.map(async ({ bytes, ...record }) => ({ ...record, bytes: bytes.byteLength, argumentSha256: await digest(bytes) })));
    report.queueReceiptMeaning = 'Copied CPU arguments after successful native writeBuffer calls; not GPU pool/metadata readback or proof of completion.';
    report.requests = requests; report.finalBudgets = budgets.map(budget => budget.telemetry);
    report.submissions = submission; report.nativeQueueSubmissions = queueSubmissions; report.pendingFetches = pendingFetches.size;
    for (const undo of restore.reverse()) undo();
    if (errors.length) report.passed = false;
  }
  return report;
}
