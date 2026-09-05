import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GeometryPageCache } from '../../packages/core/src/geometry/page-cache.js';
import type { GeometryPageCacheOptions } from '../../packages/core/src/geometry/page-cache.js';
import type { GeometryManifest } from '../../packages/core/src/geometry/format.js';

const pageBytes = 65_536;
const bounds = { min: [0, 0, 0], max: [1, 1, 1] } as const;

/** Small dependency fixtures test scheduling; full terrain conformance is tested by the parser/cooker. */
function fixture(groups: number[][] = [[1, 2], [3, 4]]) {
  const pageCount = Math.max(0, ...groups.flat()) + 1;
  const bodies = Array.from({ length: pageCount }, (_, pageId) => {
    const body = new ArrayBuffer(pageBytes);
    new Float32Array(body, 0, 24).set([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1]);
    new Uint32Array(body, 96, 3).set([0, 1, 2]);
    new Uint32Array(body, pageBytes - 4, 1)[0] = pageId;
    return body;
  });
  const manifest: GeometryManifest = {
    format: 'strata-geometry', version: 1, pageBytes, vertexStride: 32, indexFormat: 'uint32',
    source: { kind: 'analytic-heightfield-v1', seed: 1, tilesPerSide: 1, cellsPerTile: 8, cellSize: 1, triangleCount: groups.reduce((sum, group) => sum + group.length, 0) },
    bounds, rootPageIds: [0],
    pages: bodies.map((body, id) => ({ id, url: `pages/${String(id).padStart(6, '0')}.bin`, byteLength: pageBytes, sha256: createHash('sha256').update(new Uint8Array(body)).digest('hex'), pinned: id === 0 })),
    clusters: bodies.map((_, id) => ({ id, pageId: id, vertexOffset: 0, vertexCount: 3, indexOffset: 96, indexCount: 3, triangleCount: 1, bounds })),
    tiles: groups.map((pages, id) => ({ id, bounds, lods: [
      { level: 0, error: 0, clusterIds: pages, pageIds: pages }, { level: 1, error: 1, clusterIds: [0], pageIds: [0] },
    ] })),
  };
  const writes: { offset: number; byteLength: number; pageId: number }[] = [];
  const buffer = { destroy: vi.fn() };
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    createBuffer: vi.fn(() => buffer),
    queue: { writeBuffer: vi.fn((_buffer: unknown, offset: number, data: Uint8Array<ArrayBuffer>) => {
      writes.push({ offset, byteLength: data.byteLength, pageId: new DataView(data.buffer, data.byteOffset).getUint32(pageBytes - 4, true) });
    }) },
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const pageId = Number(new URL(String(input)).pathname.match(/(\d+)\.bin$/)![1]);
    return new Response(bodies[pageId]!.slice(0));
  });
  const create = (options: GeometryPageCacheOptions = {}) => GeometryPageCache.create(device as unknown as GPUDevice,
    manifest, 'https://geometry.test/terrain/manifest.json', { poolBytes: 3 * pageBytes, fetch: fetcher as typeof fetch, maxRetries: 0, ...options });
  return { manifest, bodies, device, buffer, writes, fetcher, create };
}

async function finish(cache: GeometryPageCache, condition: () => boolean) {
  await vi.waitFor(() => { cache.update(); expect(condition()).toBe(true); }, { timeout: 3000, interval: 5 });
}

function controlled(gpu: ReturnType<typeof fixture>, honorAbort = true) {
  const requests: { pageId: number; signal: AbortSignal; resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const pageId = Number(new URL(String(input)).pathname.match(/(\d+)\.bin$/)![1]);
    if (pageId === 0) return new Response(gpu.bodies[0]!.slice(0));
    return new Promise((resolve, reject) => {
      const signal = init!.signal!;
      if (honorAbort) signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      requests.push({ pageId, signal, resolve, reject });
    });
  };
  const resolve = (pageId: number) => requests.find(request => request.pageId === pageId)!.resolve(new Response(gpu.bodies[pageId]!.slice(0)));
  return { fetcher, requests, resolve };
}

describe('complete-LOD fixed page residency', () => {
  it('keeps coarse coverage pinned, completes the highest-priority LOD, and evicts stale demand', async () => {
    const gpu = fixture();
    const cache = await gpu.create({ uploadBudgetBytes: pageBytes });
    const rootSlot = cache.getSlot(0);
    expect(cache.gpuBufferBytes).toBe(3 * pageBytes);
    expect(cache.initialUploadBytes).toBe(pageBytes);
    cache.setDemand([{ tileId: 0, lod: 0, priority: 2 }, { tileId: 1, lod: 0, priority: 1 }]);
    await finish(cache, () => cache.isLodResident(0, 0));
    expect(cache.isLodResident(1, 0)).toBe(false);
    expect(cache.isLodResident(1, 1)).toBe(true);
    expect(gpu.fetcher.mock.calls.map(([input]) => String(input))).not.toContain('https://geometry.test/terrain/pages/000003.bin');
    cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }, { tileId: 1, lod: 0, priority: 3 }]);
    await finish(cache, () => cache.isLodResident(1, 0));
    expect(cache.getSlot(0)).toBe(rootSlot);
    expect(cache.isLodResident(0, 1)).toBe(true);
    expect(cache.telemetry.evictions).toBe(2);
    expect(cache.telemetry.residentPages).toBe(3);
    cache.dispose(); cache.dispose();
    expect(gpu.buffer.destroy).toHaveBeenCalledOnce();
    expect(cache.gpuBufferBytes).toBe(0);
    expect(() => cache.update()).toThrowError(expect.objectContaining({ code: 'ENGINE_DISPOSED' }));
  });

  it('does not expose a partially uploaded tile and bounds request/completion/upload bytes', async () => {
    const gpu = fixture([[1, 2, 3, 4]]);
    const network = controlled(gpu);
    const cache = await gpu.create({ poolBytes: 5 * pageBytes, fetch: network.fetcher, maxConcurrentRequests: 4, maxCompletedBytes: 2 * pageBytes, uploadBudgetBytes: pageBytes });
    cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }]);
    await vi.waitFor(() => expect(network.requests).toHaveLength(2));
    network.resolve(1); network.resolve(2);
    await vi.waitFor(() => expect(cache.telemetry.completedPages).toBe(2));
    expect(network.requests).toHaveLength(2);
    expect(cache.telemetry.stagingReservedBytes).toBeLessThanOrEqual(2 * pageBytes);
    expect(cache.update().uploadBytes).toBe(pageBytes);
    expect(cache.isLodResident(0, 0)).toBe(false);
    expect(cache.isLodResident(0, 1)).toBe(true);
    await vi.waitFor(() => expect(network.requests).toHaveLength(3));
    network.resolve(3);
    await vi.waitFor(() => expect(cache.telemetry.completedPages).toBe(2));
    expect(cache.update().uploadBytes).toBe(pageBytes);
    await vi.waitFor(() => expect(network.requests).toHaveLength(4));
    network.resolve(4);
    await finish(cache, () => cache.isLodResident(0, 0));
    expect(cache.telemetry.completedBytes).toBe(0);
    expect(gpu.writes.every(write => write.byteLength === pageBytes)).toBe(true);
    cache.dispose();
  });

  it('uses LRU only among unneeded detail pages and reports exact slot replacements', async () => {
    const gpu = fixture([[1], [2], [3]]);
    const cache = await gpu.create();
    for (const tileId of [0, 1]) {
      cache.setDemand([{ tileId, lod: 0, priority: 1 }]);
      await finish(cache, () => cache.isLodResident(tileId, 0));
    }
    const firstSlot = cache.getSlot(1);
    cache.setDemand([{ tileId: 2, lod: 0, priority: 1 }]);
    await vi.waitFor(() => expect(cache.telemetry.completedPages).toBe(1));
    gpu.device.queue.writeBuffer.mockImplementationOnce(() => { throw new Error('upload failed'); });
    expect(() => cache.update()).toThrow('upload failed');
    expect(cache.getSlot(1)).toBe(firstSlot);
    expect(cache.getSlot(3)).toBe(-1);
    expect(cache.telemetry.evictions).toBe(0);
    const result = cache.update();
    expect(result.evicted).toEqual([{ pageId: 1, slot: firstSlot }]);
    expect(result.uploaded).toEqual([{ pageId: 3, slot: firstSlot }]);
    expect(cache.getSlot(1)).toBe(-1);
    expect(cache.getSlot(2)).not.toBe(-1);
    expect(cache.getSlot(0)).not.toBe(-1);
    cache.dispose();
  });

  it('transfers a completed request reservation without reporting over-budget microtask states', async () => {
    const gpu = fixture([[1]]);
    const cache = await gpu.create({ maxConcurrentRequests: 1, maxCompletedBytes: pageBytes });
    // Control the asynchronous validation boundary so each promise reaction can
    // be observed independently of networking and native SHA scheduling.
    let complete!: (bytes: Uint8Array<ArrayBuffer>) => void;
    const loader = cache as unknown as { load: () => Promise<Uint8Array<ArrayBuffer>> };
    const mock = vi.spyOn(loader, 'load').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    try {
      cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }]);
      expect(cache.telemetry.pendingRequests).toBe(1);
      complete(new Uint8Array(gpu.bodies[1]!));
      const states = [];
      for (let index = 0; index < 8; index++) {
        await Promise.resolve();
        states.push(cache.telemetry);
      }
      expect(states.some(state => state.completedPages === 1)).toBe(true);
      for (const state of states) {
        expect(state.stagingReservedBytes).toBeLessThanOrEqual(state.stagingBudgetBytes);
        expect(state.pendingRequests + state.completedPages).toBe(1);
      }
    } finally { mock.mockRestore(); cache.dispose(); }
  });

  it('preloads complete resident baselines despite a smaller streamed cap or per-update budget', async () => {
    for (const geometryMode of ['resident-lod', 'resident-full'] as const) {
      const gpu = fixture();
      const cache = await gpu.create({ geometryMode, poolBytes: pageBytes, uploadBudgetBytes: pageBytes });
      expect(cache.gpuBufferBytes).toBe(5 * pageBytes);
      expect(cache.initialUploadBytes).toBe(5 * pageBytes);
      expect(cache.isLodResident(0, 0)).toBe(true);
      expect(cache.isLodResident(1, 0)).toBe(true);
      expect(cache.update().uploadBytes).toBe(0);
      expect(cache.telemetry.pendingRequests).toBe(0);
      cache.dispose();
    }
  });
});

describe('geometry request failure and cancellation', () => {
  it('cancels artificial loading delay before starting a stale network request', async () => {
    const gpu = fixture();
    const cache = await gpu.create({ pageLoadDelayMs: 30 });
    cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }]);
    expect(cache.telemetry.pendingRequests).toBe(2);
    cache.setDemand([]);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(gpu.fetcher).toHaveBeenCalledOnce();
    expect(cache.telemetry.pendingRequests).toBe(0);
    expect(cache.telemetry.requestsCancelled).toBe(2);
    cache.dispose();
  });

  it('discards completed old-camera pages before upload', async () => {
    const gpu = fixture();
    const cache = await gpu.create();
    cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }]);
    await vi.waitFor(() => expect(cache.telemetry.completedPages).toBe(2));
    cache.setDemand([{ tileId: 1, lod: 0, priority: 1 }]);
    await finish(cache, () => cache.isLodResident(1, 0));
    expect(cache.telemetry.discardedCompletions).toBe(2);
    expect(gpu.writes.map(write => write.pageId)).toEqual([0, 3, 4]);
    cache.dispose();
  });

  it('cancels stale requests and prevents late completions from crossing disposal epochs', async () => {
    const gpu = fixture();
    const network = controlled(gpu, false);
    const cache = await gpu.create({ fetch: network.fetcher });
    cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }]);
    await vi.waitFor(() => expect(network.requests).toHaveLength(2));
    cache.setDemand([{ tileId: 1, lod: 0, priority: 1 }]);
    expect(network.requests.slice(0, 2).every(request => request.signal.aborted)).toBe(true);
    network.resolve(1); network.resolve(2);
    await vi.waitFor(() => expect(network.requests).toHaveLength(4));
    cache.dispose();
    network.resolve(3); network.resolve(4);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(gpu.writes.map(write => write.pageId)).toEqual([0]);
    expect(cache.telemetry.completedPages).toBe(0);
    expect(cache.getSlot(1)).toBe(-1);
    expect(gpu.buffer.destroy).toHaveBeenCalledOnce();
  });

  it('rejects a bad hash, releases its incomplete group, and retains coarse coverage', async () => {
    const gpu = fixture();
    const fetcher: typeof fetch = async input => {
      const pageId = Number(new URL(String(input)).pathname.match(/(\d+)\.bin$/)![1]);
      const bytes = gpu.bodies[pageId]!.slice(0);
      if (pageId === 1) new Uint8Array(bytes)[1000] = 1;
      return new Response(bytes);
    };
    const cache = await gpu.create({ fetch: fetcher });
    cache.setDemand([{ tileId: 0, lod: 0, priority: 2 }, { tileId: 1, lod: 0, priority: 1 }]);
    await finish(cache, () => cache.isLodResident(1, 0));
    expect(cache.isLodResident(0, 0)).toBe(false);
    expect(cache.isLodResident(0, 1)).toBe(true);
    expect(cache.telemetry.failedPages).toBe(1);
    expect(cache.telemetry.requestsFailed).toBe(1);
    expect(gpu.writes.some(write => write.pageId === 1)).toBe(false);
    cache.dispose();
  });

  it('retries transient HTTP failure within its configured limit', async () => {
    const gpu = fixture([[1]]);
    let attempts = 0;
    const fetcher: typeof fetch = async input => {
      const id = Number(new URL(String(input)).pathname.match(/(\d+)\.bin$/)![1]);
      if (id === 1 && attempts++ === 0) return new Response('', { status: 503 });
      return new Response(gpu.bodies[id]!.slice(0));
    };
    const cache = await gpu.create({ fetch: fetcher, maxRetries: 1, retryDelayMs: 0 });
    cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }]);
    await finish(cache, () => cache.isLodResident(0, 0));
    expect(attempts).toBe(2);
    expect(cache.telemetry.requestsFailed).toBe(1);
    expect(cache.telemetry.failedPages).toBe(0);
    cache.dispose();
  });

  it('rejects oversized and truncated response bodies without uploading them', async () => {
    for (const size of [pageBytes + 1, pageBytes - 1]) {
      const gpu = fixture([[1]]);
      const cache = await gpu.create({ fetch: async input => {
        const id = Number(new URL(String(input)).pathname.match(/(\d+)\.bin$/)![1]);
        return new Response(id === 0 ? gpu.bodies[0]!.slice(0) : new ArrayBuffer(size));
      } });
      cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }]);
      await finish(cache, () => cache.telemetry.failedPages === 1);
      expect(cache.isLodResident(0, 1)).toBe(true);
      expect(gpu.writes.map(write => write.pageId)).toEqual([0]);
      cache.dispose();
    }
  });

  it('destroys failed root initialization and aborts superseded preload', async () => {
    const invalid = fixture();
    await expect(invalid.create({ fetch: (async () => new Response('', { status: 404 })) as typeof fetch })).rejects.toThrowError(expect.objectContaining({ code: 'SCENE_LOAD_FAILED' }));
    expect(invalid.buffer.destroy).toHaveBeenCalledOnce();
    const gpu = fixture();
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const creation = gpu.create({ signal: controller.signal, fetch: async (_input, init) => new Promise((_resolve, reject) => {
      requestSignal = init!.signal!;
      requestSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }) });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    controller.abort();
    await expect(creation).rejects.toThrowError(expect.objectContaining({ code: 'INITIALIZATION_ABORTED' }));
    expect(requestSignal!.aborted).toBe(true);
    expect(gpu.buffer.destroy).toHaveBeenCalledOnce();
  });

  it('rejects a cap without room for complete refinement before GPU allocation', async () => {
    const gpu = fixture();
    await expect(gpu.create({ poolBytes: 2 * pageBytes })).rejects.toThrow(/complete refinement/);
    expect(gpu.device.createBuffer).not.toHaveBeenCalled();
  });
});
