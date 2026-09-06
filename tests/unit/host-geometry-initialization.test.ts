import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GpuGeometry } from '../../packages/core/src/geometry/gpu-geometry.js';
import { buildGeometryMetadata } from '../../packages/core/src/geometry/geometry-data.js';
import { GeometryPageCache, type GeometryPageCacheOptions } from '../../packages/core/src/geometry/page-cache.js';
import { GeometryTransferBudget, type GeometryInitialization, type GeometryTransferLimits } from '../../packages/core/src/geometry/transfer-budget.js';
import type { VirtualSceneOptions } from '../../packages/core/src/geometry/virtual-types.js';
import { controlledCookedFetch, cookInitializationSource, deferred, recordingGeometryDevice, removeInitializationSource,
  initializationSourceReceipt, writeInitializationReceipt, type CookedInitializationSource } from '../helpers/cooked-geometry-initialization.js';

const pageBytes = 65_536;
let sources: CookedInitializationSource[] = [];
beforeAll(async () => {
  for (const seed of [42, 43, 44]) sources.push(await cookInitializationSource(seed));
}, 100_000);
afterAll(async () => { await Promise.all(sources.map(removeInitializationSource)); });
afterEach(() => { vi.unstubAllGlobals(); });

function createBudget(overrides: Partial<GeometryTransferLimits> = {}) {
  return new GeometryTransferBudget({ maxRequests: 2, pageStagingBytes: pageBytes, transientBytes: 1024 * 1024,
    residentBytes: 1024 * 1024, gpuBufferBytes: 4 * 1024 * 1024, uploadBytesPerFrame: pageBytes, ...overrides });
}
function options(source: CookedInitializationSource, fetchPages: typeof fetch, overrides: GeometryPageCacheOptions = {}): VirtualSceneOptions & GeometryPageCacheOptions {
  return { renderer: 'virtual', manifestUrl: source.url.href, poolBytes: 2 * pageBytes,
    maxConcurrentRequests: 2, maxCompletedBytes: pageBytes, maxRetries: 0, retryDelayMs: 0, fetch: fetchPages, ...overrides };
}
function gpuOptions(source: CookedInitializationSource): VirtualSceneOptions {
  return { renderer: 'virtual', manifestUrl: source.url.href, poolBytes: 2 * pageBytes, maxConcurrentRequests: 2 };
}
type TestDevice = ReturnType<typeof recordingGeometryDevice>;
const queueBytes = (devices: readonly TestDevice[]) => devices.reduce((sum, gpu) => sum + gpu.receipts.reduce((bytes, receipt) => bytes + receipt.bytes.byteLength, 0), 0);
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 1));
interface FrameReceipt { readonly id: number; readonly actualQueueBytes: number; readonly returnedUploadBytes: number; readonly remainingBytes: number }

function advanceFrame(budget: GeometryTransferBudget, handles: readonly GeometryInitialization<unknown>[], devices: readonly TestDevice[], id: number,
  receipts?: FrameReceipt[]) {
  const frame = budget.beginFrame(id);
  const before = queueBytes(devices);
  let returned = 0;
  for (const handle of handles) if (handle.status === 'pending') returned += handle.advance(frame).uploadBytes;
  const actual = queueBytes(devices) - before;
  expect(actual).toBe(returned);
  expect(frame.writtenBytes).toBe(actual);
  expect(actual).toBeLessThanOrEqual(budget.limits.uploadBytesPerFrame);
  expect(budget.telemetry.pageStagingBytes).toBeLessThanOrEqual(budget.limits.pageStagingBytes);
  expect(budget.telemetry.requests).toBeLessThanOrEqual(budget.limits.maxRequests);
  receipts?.push({ id, actualQueueBytes: actual, returnedUploadBytes: returned, remainingBytes: frame.remainingBytes });
  return frame;
}

async function finishInitializers(budget: GeometryTransferBudget, handles: readonly GeometryInitialization<unknown>[], devices: readonly TestDevice[],
  network: ReturnType<typeof controlledCookedFetch>, firstFrame = 1, receipts?: FrameReceipt[]) {
  for (let id = firstFrame; id < firstFrame + 200; id++) {
    advanceFrame(budget, handles, devices, id, receipts);
    for (const request of network.pending) request.respond();
    await settle();
    if (handles.every(handle => handle.status !== 'pending')) return;
  }
  throw new Error(`Host initialization did not settle: ${handles.map(handle => handle.status).join(', ')}`);
}

function expectNoOwnedBudget(budget: GeometryTransferBudget) {
  expect(budget.telemetry).toMatchObject({ requests: 0, pageStagingBytes: 0, transientBytes: 0, residentBytes: 0, gpuBufferBytes: 0 });
}

describe('host-driven initialization over real cooked page caches', () => {
  it('initializes distinct hashed sources under one shared page of staging and one page of writes per frame', async () => {
    expect(new Set(sources.map(source => source.manifest.pages[0]!.sha256)).size).toBe(3);
    expect(sources.every(source => source.manifest.rootPageIds.length === 1 && source.manifest.pages.length === 2)).toBe(true);
    const network = controlledCookedFetch(sources);
    vi.stubGlobal('fetch', network.fetch);
    const budget = createBudget();
    const frames: FrameReceipt[] = [];
    const devices = sources.map(() => recordingGeometryDevice());
    const handles = sources.map((source, index) => GpuGeometry.begin(devices[index]!.device, source.manifest, source.url,
      gpuOptions(source), budget));
    expect(queueBytes(devices)).toBe(0);
    expect(network.requests).toHaveLength(0);
    await finishInitializers(budget, handles, devices, network, 1, frames);
    expect(handles.map(handle => handle.status)).toEqual(['ready', 'ready', 'ready']);
    expect(network.requests).toHaveLength(3);
    expect(budget.telemetry.peakPageStagingBytes).toBe(pageBytes);
    expect(budget.telemetry.peakRequests).toBe(1);
    expect(budget.telemetry.uploadBytes).toBe(queueBytes(devices));
    const providers = handles.map(handle => handle.takeReady());
    for (const [index, provider] of providers.entries()) {
      expect(provider.geometryTelemetry).toMatchObject({ sourceSeed: sources[index]!.manifest.source.seed, residentPages: 1,
        requestsCompleted: 1, fetchedBytes: pageBytes, uploadedPages: 1 });
      const pool = devices[index]!.buffers.find(buffer => buffer.label === 'Strata fixed geometry page pool')!;
      expect(pool.bytes.slice(0, pageBytes)).toEqual(sources[index]!.pages[0]);
      expect(provider.initialUploadBytes).toBe(queueBytes([devices[index]!]));
      expect(provider.gpuBufferBytes).toBe(devices[index]!.buffers.reduce((sum, buffer) => sum + buffer.bytes.byteLength, 0));
      expect(() => handles[index]!.takeReady()).toThrow();
      handles[index]!.dispose();
      expect(devices[index]!.buffers.every(buffer => buffer.destroy.mock.calls.length === 0)).toBe(true);
    }
    expect(budget.telemetry.residentBytes).toBeGreaterThan(0);
    expect(budget.telemetry.gpuBufferBytes).toBe(providers.reduce((sum, provider) => sum + provider.gpuBufferBytes, 0));
    const ready = providers.map((provider, index) => ({ seed: sources[index]!.manifest.source.seed,
      createdBufferBytes: devices[index]!.buffers.reduce((sum, buffer) => sum + buffer.bytes.byteLength, 0),
      providerGpuBufferBytes: provider.gpuBufferBytes, initialUploadBytes: provider.initialUploadBytes, telemetry: provider.geometryTelemetry }));
    providers.forEach(provider => provider.dispose());
    expectNoOwnedBudget(budget);
    expect(devices.every(gpu => gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1))).toBe(true);
    await writeInitializationReceipt('three-source-shared-budget', { sources: sources.map(initializationSourceReceipt), limits: budget.limits,
      frames, ready, finalBudget: budget.telemetry, finalOwnership: 'zero', allBuffersDestroyedExactlyOnce: true });
  });

  it('produces byte-identical initial page pools, metadata and residency tables to legacy create()', async () => {
    const source = sources[0]!;
    const network = controlledCookedFetch([source], true);
    vi.stubGlobal('fetch', network.fetch);
    const legacyGpu = recordingGeometryDevice();
    const legacy = await GpuGeometry.create(legacyGpu.device, source.manifest, source.url, options(source, network.fetch));
    const hostGpu = recordingGeometryDevice();
    const budget = createBudget();
    const handle = GpuGeometry.begin(hostGpu.device, source.manifest, source.url, gpuOptions(source), budget);
    await finishInitializers(budget, [handle], [hostGpu], network);
    expect(handle.status).toBe('ready');
    const host = handle.takeReady();
    expect(hostGpu.buffers.map(buffer => buffer.label).sort()).toEqual(legacyGpu.buffers.map(buffer => buffer.label).sort());
    for (const buffer of legacyGpu.buffers) {
      const actual = hostGpu.buffers.find(value => value.label === buffer.label)!;
      expect(actual.bytes, buffer.label).toEqual(buffer.bytes);
    }
    expect(host.initialUploadBytes).toBe(legacy.initialUploadBytes);
    expect(host.gpuBufferBytes).toBe(legacy.gpuBufferBytes);
    host.dispose(); legacy.dispose(); expectNoOwnedBudget(budget);
  });

  it('splits real cooked metadata across frames before admitting root staging', async () => {
    const source = await cookInitializationSource(45, { tiles: 4, cells: 64 });
    const network = controlledCookedFetch([source]);
    const gpu = recordingGeometryDevice();
    const budget = createBudget();
    const frames: FrameReceipt[] = [];
    let handle: GeometryInitialization<GpuGeometry> | undefined;
    try {
      const roots = new Set(source.manifest.rootPageIds);
      const smallestRefinement = Math.min(...source.manifest.tiles.flatMap(tile => tile.lods.slice(0, -1)
        .map(lod => lod.pageIds.filter(id => !roots.has(id)).length)).filter(count => count > 0));
      const capacity = roots.size + smallestRefinement;
      const expected = buildGeometryMetadata(source.manifest, capacity);
      expect(expected.words.byteLength).toBeGreaterThan(pageBytes);
      handle = GpuGeometry.begin(gpu.device, source.manifest, source.url,
        options(source, network.fetch, { poolBytes: capacity * pageBytes }), budget);
      const metadataFrames = new Set<number>();
      let metadataWritten = 0;
      for (let id = 0; id < 200 && handle.status === 'pending'; id++) {
        const count = gpu.receipts.length;
        advanceFrame(budget, [handle], [gpu], id, frames);
        for (const receipt of gpu.receipts.slice(count)) {
          if (receipt.label !== 'Strata cooked geometry metadata') continue;
          expect(receipt.offset).toBe(metadataWritten);
          metadataWritten += receipt.bytes.byteLength;
          metadataFrames.add(id);
        }
        if (metadataWritten < expected.words.byteLength) {
          expect(network.requests).toHaveLength(0);
          expect(budget.telemetry.pageStagingBytes).toBe(0);
          expect(handle.status).toBe('pending');
          expect(budget.telemetry.transientBytes).toBeGreaterThan(0);
        }
        for (const request of network.pending) {
          expect(metadataWritten).toBe(expected.words.byteLength);
          expect(budget.telemetry.transientBytes).toBe(0);
          request.respond();
        }
        await settle();
      }
      expect(handle.status).toBe('ready');
      expect(metadataFrames.size).toBeGreaterThanOrEqual(2);
      expect(metadataWritten).toBe(expected.words.byteLength);
      const metadata = gpu.buffers.find(buffer => buffer.label === 'Strata cooked geometry metadata')!;
      expect(metadata.bytes).toEqual(new Uint8Array(expected.words.buffer));
      expect(network.requests.map(request => request.pageId)).toEqual(source.manifest.rootPageIds);
      const provider = handle.takeReady();
      expect(provider.initialUploadBytes).toBe(queueBytes([gpu]));
      expect(provider.gpuBufferBytes).toBe(gpu.buffers.reduce((sum, buffer) => sum + buffer.bytes.byteLength, 0));
      expect(budget.telemetry.gpuBufferBytes).toBeGreaterThanOrEqual(provider.gpuBufferBytes);
      const ready = { createdBufferBytes: gpu.buffers.reduce((sum, buffer) => sum + buffer.bytes.byteLength, 0),
        providerGpuBufferBytes: provider.gpuBufferBytes, initialUploadBytes: provider.initialUploadBytes, telemetry: provider.geometryTelemetry };
      provider.dispose(); expectNoOwnedBudget(budget);
      expect(gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
      await writeInitializationReceipt('large-metadata-multiple-frames', { source: initializationSourceReceipt(source), limits: budget.limits,
        capacityPages: capacity, metadataBytes: expected.words.byteLength, metadataFrameIds: [...metadataFrames],
        metadataWrites: gpu.receipts.filter(receipt => receipt.label === 'Strata cooked geometry metadata')
          .map(receipt => ({ offset: receipt.offset, bytes: receipt.bytes.byteLength })),
        frames, ready, finalBudget: budget.telemetry, finalOwnership: 'zero', allBuffersDestroyedExactlyOnce: true });
    } finally {
      handle?.dispose();
      for (const request of network.pending) request.respond();
      await removeInitializationSource(source);
    }
  }, 35_000);

  it('never writes behind the host after a frame has no remaining allowance', async () => {
    const source = sources[0]!;
    const gpu = recordingGeometryDevice();
    const network = controlledCookedFetch([source], true);
    vi.stubGlobal('fetch', network.fetch);
    const budget = createBudget();
    const handle = GpuGeometry.begin(gpu.device, source.manifest, source.url, gpuOptions(source), budget);
    const frame = budget.beginFrame(0);
    const filler = gpu.device.createBuffer({ label: 'host allowance consumer', size: pageBytes, usage: 8 });
    expect(frame.write(gpu.device, filler, 0, new Uint8Array(pageBytes))).toBe(true);
    const before = queueBytes([gpu]);
    expect(handle.advance(frame).uploadBytes).toBe(0);
    await settle();
    expect(handle.advance(frame).uploadBytes).toBe(0);
    expect(queueBytes([gpu])).toBe(before);
    expect(handle.status).toBe('pending');
    await finishInitializers(budget, [handle], [gpu], network);
    expect(handle.status).toBe('ready');
    handle.takeReady().dispose(); filler.destroy(); expectNoOwnedBudget(budget);
  });

  it('holds canceled fetch staging until settlement, then wakes and admits a different real source', async () => {
    const first = sources[0]!; const second = sources[1]!;
    const network = controlledCookedFetch([first, second]);
    const budget = createBudget({ maxRequests: 1 });
    const devices = [recordingGeometryDevice(), recordingGeometryDevice()];
    const a = GeometryPageCache.begin(devices[0]!.device, first.manifest, first.url, options(first, network.fetch), budget);
    const b = GeometryPageCache.begin(devices[1]!.device, second.manifest, second.url, options(second, network.fetch), budget);
    advanceFrame(budget, [a, b], devices, 0);
    await vi.waitFor(() => expect(network.requests).toHaveLength(1));
    const late = network.requests[0]!;
    const oldRevision = b.revision;
    a.dispose();
    expect(a.status).toBe('disposed');
    expect(late.signal?.aborted).toBe(true);
    expect(budget.telemetry).toMatchObject({ requests: 1, pageStagingBytes: pageBytes });
    advanceFrame(budget, [b], devices, 1);
    await settle();
    expect(network.requests).toHaveLength(1);
    // The change happens before registering this waiter: the revision check must avoid a lost wake.
    late.respond();
    await vi.waitFor(() => expect(b.revision).toBeGreaterThan(oldRevision));
    await b.waitForChange(oldRevision);
    await finishInitializers(budget, [b], devices, network, 2);
    expect(b.status).toBe('ready');
    expect(queueBytes([devices[0]!])).toBe(0);
    expect(network.requests).toHaveLength(2);
    b.takeReady().dispose();
    await vi.waitFor(() => expectNoOwnedBudget(budget));
    expect(devices.every(gpu => gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1))).toBe(true);
  });

  it('exposes a terminal hash failure while releasing capacity for another initializer', async () => {
    const first = sources[0]!; const second = sources[2]!;
    const network = controlledCookedFetch([first, second]);
    const budget = createBudget();
    const devices = [recordingGeometryDevice(), recordingGeometryDevice()];
    const a = GeometryPageCache.begin(devices[0]!.device, first.manifest, first.url, options(first, network.fetch), budget);
    const b = GeometryPageCache.begin(devices[1]!.device, second.manifest, second.url, options(second, network.fetch), budget);
    advanceFrame(budget, [a, b], devices, 0);
    await vi.waitFor(() => expect(network.requests).toHaveLength(1));
    const revision = a.revision;
    network.requests[0]!.respond({ corrupt: true });
    await a.waitForChange(revision);
    await finishInitializers(budget, [a, b], devices, network);
    expect(a.status).toBe('failed');
    expect(a.error).toBeInstanceOf(Error);
    expect(() => a.takeReady()).toThrow();
    expect(queueBytes([devices[0]!])).toBe(0);
    expect(b.status).toBe('ready');
    const cache = b.takeReady();
    expect(cache.telemetry.requestsCompleted).toBe(1);
    a.dispose();
    expect(devices[0]!.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    b.dispose(); cache.dispose(); expectNoOwnedBudget(budget);
  });

  it('waits for the complete delayed response body and authenticated root before publishing readiness', async () => {
    const source = sources[1]!;
    const network = controlledCookedFetch([source]);
    const gpu = recordingGeometryDevice();
    const budget = createBudget();
    const handle = GeometryPageCache.begin(gpu.device, source.manifest, source.url, options(source, network.fetch), budget);
    advanceFrame(budget, [handle], [gpu], 0);
    await vi.waitFor(() => expect(network.requests).toHaveLength(1));
    const body = network.requests[0]!.openStream();
    body.enqueue(source.pages[0]!.slice(0, pageBytes / 2));
    await settle();
    advanceFrame(budget, [handle], [gpu], 1);
    expect(handle.status).toBe('pending');
    expect(queueBytes([gpu])).toBe(0);
    expect(budget.telemetry).toMatchObject({ requests: 1, pageStagingBytes: pageBytes });
    body.enqueue(source.pages[0]!.slice(pageBytes / 2));
    body.close();
    await finishInitializers(budget, [handle], [gpu], network, 2);
    expect(handle.status).toBe('ready');
    const cache = handle.takeReady();
    expect(cache.telemetry).toMatchObject({ fetchedBytes: pageBytes, requestsCompleted: 1, uploadedPages: 1 });
    expect(gpu.buffers[0]!.bytes.slice(0, pageBytes)).toEqual(source.pages[0]);
    cache.dispose(); expectNoOwnedBudget(budget);
  });

  it.each(['HTTP', 'body'] as const)('retries a transient %s failure through the actual cache before uploading one authenticated root', async kind => {
    const source = sources[1]!;
    const network = controlledCookedFetch([source]);
    const gpu = recordingGeometryDevice();
    const budget = createBudget();
    const handle = GeometryPageCache.begin(gpu.device, source.manifest, source.url, options(source, network.fetch, { maxRetries: 1 }), budget);
    advanceFrame(budget, [handle], [gpu], 0);
    await vi.waitFor(() => expect(network.requests).toHaveLength(1));
    if (kind === 'HTTP') network.requests[0]!.respond({ status: 503 });
    else {
      const body = network.requests[0]!.openStream();
      body.enqueue(source.pages[0]!.slice(0, pageBytes / 2));
      await settle();
      body.error(new Error('injected connection loss halfway through a page'));
    }
    await finishInitializers(budget, [handle], [gpu], network);
    expect(handle.status).toBe('ready');
    const cache = handle.takeReady();
    expect(network.requests).toHaveLength(2);
    expect(cache.telemetry).toMatchObject({ requestsStarted: 2, requestsFailed: 1, requestsCompleted: 1, uploadedPages: 1,
      fetchedBytes: kind === 'HTTP' ? pageBytes : pageBytes * 1.5 });
    expect(queueBytes([gpu])).toBe(pageBytes);
    expect(gpu.buffers[0]!.bytes.slice(0, pageBytes)).toEqual(source.pages[0]);
    cache.dispose(); expectNoOwnedBudget(budget);
  });

  it('keeps canceled pipeline ownership until both asynchronous pipeline operations settle', async () => {
    const source = sources[0]!;
    const gpu = recordingGeometryDevice();
    const pipelines = [deferred<GPUComputePipeline>(), deferred<GPUComputePipeline>()];
    let index = 0;
    gpu.raw.createComputePipelineAsync.mockImplementation(() => pipelines[index++]!.promise as never);
    const network = controlledCookedFetch([source], true);
    vi.stubGlobal('fetch', network.fetch);
    const budget = createBudget();
    const handle = GpuGeometry.begin(gpu.device, source.manifest, source.url, gpuOptions(source), budget);
    for (let frame = 0; frame < 20 && index < 2; frame++) { advanceFrame(budget, [handle], [gpu], frame); await settle(); }
    expect(index).toBe(2);
    expect(handle.status).toBe('pending');
    handle.dispose();
    const before = queueBytes([gpu]);
    expect(handle.status).toBe('disposed');
    expect(budget.telemetry.residentBytes + budget.telemetry.transientBytes + budget.telemetry.gpuBufferBytes).toBeGreaterThan(0);
    pipelines[0]!.resolve({ getBindGroupLayout: vi.fn() } as unknown as GPUComputePipeline);
    await settle();
    expect(budget.telemetry.residentBytes + budget.telemetry.transientBytes + budget.telemetry.gpuBufferBytes).toBeGreaterThan(0);
    pipelines[1]!.reject(new Error('late pipeline failure'));
    await vi.waitFor(() => expectNoOwnedBudget(budget));
    expect(queueBytes([gpu])).toBe(before);
    expect(handle.status).toBe('disposed');
    expect(gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });

  it('cleans up a queue failure after metadata writes without publishing an incomplete provider', async () => {
    const source = sources[2]!;
    const network = controlledCookedFetch([source], true);
    vi.stubGlobal('fetch', network.fetch);
    const gpu = recordingGeometryDevice();
    const realWrite = gpu.raw.queue.writeBuffer.getMockImplementation()!;
    gpu.raw.queue.writeBuffer.mockImplementation((buffer, offset, input) => {
      if (buffer.label === 'Strata fixed geometry page pool') throw new Error('injected root queue failure');
      realWrite(buffer, offset, input);
    });
    const budget = createBudget();
    const handle = GpuGeometry.begin(gpu.device, source.manifest, source.url, gpuOptions(source), budget);
    await finishInitializers(budget, [handle], [gpu], network);
    expect(handle.status).toBe('failed');
    expect(String(handle.error)).toContain('injected root queue failure');
    expect(() => handle.takeReady()).toThrow();
    expect(gpu.receipts.some(receipt => receipt.label === 'Strata cooked geometry metadata')).toBe(true);
    expect(gpu.receipts.some(receipt => receipt.label === 'Strata fixed geometry page pool' || receipt.label === 'Strata page residency table')).toBe(false);
    expect(budget.telemetry.uploadBytes).toBe(queueBytes([gpu]));
    expect(gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    expectNoOwnedBudget(budget);
  });
});
