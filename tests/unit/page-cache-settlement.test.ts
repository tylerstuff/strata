import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeometryPageCache } from '../../packages/core/src/geometry/page-cache.js';
import { GeometryTransferBudget } from '../../packages/core/src/geometry/transfer-budget.js';
import { geometryDevice, geometryFixture } from './geometry-fixture.js';

const pageBytes = 65_536;
const url = 'https://geometry.test/manifest.json';
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function budget() {
  return new GeometryTransferBudget({ maxRequests: 1, pageStagingBytes: pageBytes,
    transientBytes: pageBytes, residentBytes: 1024, gpuBufferBytes: 2 * pageBytes, uploadBytesPerFrame: pageBytes });
}
function observed(promise: Promise<void>) {
  const result = { settled: false, promise: promise.then(() => { result.settled = true; }) };
  return result;
}
async function microtasks() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
async function readyCache(detail: () => Promise<Response>) {
  const f = { ...geometryDevice(), ...geometryFixture() };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/000000.bin')
    ? new Response(f.bodies[0]!.slice(0)) : detail());
  const cache = await GeometryPageCache.create(f.device, f.manifest, url,
    { poolBytes: 2 * pageBytes, maxRetries: 0, fetch: fetcher });
  return { ...f, cache, fetcher };
}

afterEach(() => vi.restoreAllMocks());

describe('page-cache disposal settlement', () => {
  it('waits for ownership end before advance and settles canceled delay work without starting fetch', async () => {
    const f = { ...geometryDevice(), ...geometryFixture() }; const transfer = budget();
    const fetcher = vi.fn<typeof fetch>();
    const handle = GeometryPageCache.begin(f.device, f.manifest, url,
      { poolBytes: 2 * pageBytes, fetch: fetcher, pageLoadDelayMs: 120_000 }, transfer);
    const done = observed(handle.whenDisposedAndSettled());
    await microtasks(); expect(done.settled).toBe(false);
    handle.advance(transfer.beginFrame(0));
    handle.dispose(); handle.dispose();
    expect(transfer.telemetry.requests).toBe(1);
    expect(done.settled).toBe(false);
    await done.promise;
    expect(fetcher).not.toHaveBeenCalled();
    expect(transfer.telemetry).toMatchObject({ requests: 0, pageStagingBytes: 0, residentBytes: 0, gpuBufferBytes: 0 });
    expect(f.buffers[0]!.destroy).toHaveBeenCalledOnce();
  });

  it('a failed handle still waits for its original late response and body cancellation after repeated disposal', async () => {
    const f = { ...geometryDevice(), ...geometryFixture() }; const transfer = budget();
    const response = deferred<Response>(); const canceled = deferred<void>();
    const cancel = vi.fn(() => canceled.promise);
    const fetcher = vi.fn(() => response.promise);
    const handle = GeometryPageCache.begin(f.device, f.manifest, url,
      { poolBytes: 2 * pageBytes, maxRetries: 0, fetch: fetcher }, transfer);
    handle.advance(transfer.beginFrame(0));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const done = observed(handle.whenDisposedAndSettled());
    handle.advance(budget().beginFrame(0));
    expect(handle.status).toBe('failed');
    await handle.waitForChange(handle.revision);
    handle.dispose(); handle.dispose();
    await microtasks(); expect(done.settled).toBe(false);
    expect(transfer.telemetry).toMatchObject({ requests: 1, pageStagingBytes: pageBytes, gpuBufferBytes: 0 });
    response.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await microtasks(); expect(done.settled).toBe(false);
    expect(transfer.telemetry.pageStagingBytes).toBe(pageBytes);
    canceled.resolve();
    await done.promise;
    expect(transfer.telemetry).toMatchObject({ requests: 0, pageStagingBytes: 0, residentBytes: 0, gpuBufferBytes: 0 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(f.raw.queue.writeBuffer).not.toHaveBeenCalled();
  });

  it('waits for catch/finally lease release after the fetch abort listener rejects synchronously', async () => {
    const f = { ...geometryDevice(), ...geometryFixture() }; const transfer = budget();
    const fetcher = vi.fn<typeof fetch>((_input, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('Synchronous abort rejection')), { once: true });
    }));
    const handle = GeometryPageCache.begin(f.device, f.manifest, url,
      { poolBytes: 2 * pageBytes, fetch: fetcher }, transfer);
    handle.advance(transfer.beginFrame(0));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const done = observed(handle.whenDisposedAndSettled());
    handle.dispose();
    expect(done.settled).toBe(false);
    expect(transfer.telemetry).toMatchObject({ requests: 1, pageStagingBytes: pageBytes });
    await done.promise;
    expect(transfer.telemetry).toMatchObject({ requests: 0, pageStagingBytes: 0 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('a taken handle ends ownership while its live cache waits for provider disposal', async () => {
    const f = { ...geometryDevice(), ...geometryFixture() }; const transfer = budget();
    const handle = GeometryPageCache.begin(f.device, f.manifest, url,
      { poolBytes: 2 * pageBytes, fetch: async () => new Response(f.bodies[0]!.slice(0)) }, transfer);
    const handleDone = observed(handle.whenDisposedAndSettled());
    handle.advance(transfer.beginFrame(0));
    await vi.waitFor(() => expect(transfer.telemetry.requests).toBe(0));
    handle.advance(transfer.beginFrame(1));
    expect(handle.status).toBe('ready');
    await microtasks(); expect(handleDone.settled).toBe(false);
    const cache = handle.takeReady();
    await handleDone.promise;
    const cacheDone = observed(cache.whenDisposedAndSettled());
    handle.dispose(); await microtasks();
    expect(cacheDone.settled).toBe(false);
    expect(cache.isLodResident(0, 1)).toBe(true);
    cache.dispose(); await cacheDone.promise;
    expect(f.buffers[0]!.destroy).toHaveBeenCalledOnce();
  });

  it('keeps a disposed provider unsettled while a body read and its original cancellation remain pending', async () => {
    const canceled = deferred<void>(); const cancel = vi.fn(() => canceled.promise);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel }));
    const f = await readyCache(async () => response);
    const done = observed(f.cache.whenDisposedAndSettled());
    f.cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }]);
    await vi.waitFor(() => expect(response.body!.locked).toBe(true));
    f.cache.dispose();
    expect(f.cache.telemetry.pendingRequests).toBe(0);
    await microtasks(); expect(done.settled).toBe(false);
    controller.enqueue(new Uint8Array([1]));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await microtasks(); expect(done.settled).toBe(false);
    canceled.resolve(); await done.promise;
    expect(response.body!.locked).toBe(false);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.raw.queue.writeBuffer).toHaveBeenCalledOnce();
    expect(f.cache.telemetry.completedPages).toBe(0);
    expect(() => f.cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }])).toThrow('disposed');
  });

  it('keeps digest validation owned after dispose clears pending scheduling state', async () => {
    const fixture = geometryFixture();
    const f = await readyCache(async () => new Response(fixture.bodies[1]!.slice(0)));
    const digest = deferred<ArrayBuffer>();
    const spy = vi.spyOn(crypto.subtle, 'digest').mockReturnValue(digest.promise);
    const done = observed(f.cache.whenDisposedAndSettled());
    f.cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }]);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
    f.cache.dispose(); f.cache.dispose();
    expect(f.cache.telemetry.pendingRequests).toBe(0);
    await microtasks(); expect(done.settled).toBe(false);
    digest.resolve(Uint8Array.from(f.manifest.pages[1]!.sha256.match(/../g)!, byte => Number.parseInt(byte, 16)).buffer);
    await done.promise;
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.raw.queue.writeBuffer).toHaveBeenCalledOnce();
    expect(f.cache.telemetry.completedPages).toBe(0);
    expect(f.buffers[0]!.destroy).toHaveBeenCalledOnce();
  });
});
