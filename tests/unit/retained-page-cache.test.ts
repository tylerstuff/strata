import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GeometryPageCache } from '../../packages/core/src/geometry/page-cache.js';
import type { GeometryPageCacheOptions } from '../../packages/core/src/geometry/page-cache.js';
import type { GeometryManifest } from '../../packages/core/src/geometry/format.js';

const pageBytes = 65_536;
const bounds = { min: [0, 0, 0], max: [1, 1, 1] } as const;

/** Dependency fixtures use real hashed vertex/index pages; cooker conformance is tested separately. */
function fixture(groups: number[][][]) {
  const pageCount = Math.max(...groups.flat(2)) + 1;
  const bodies = Array.from({ length: pageCount }, (_, pageId) => {
    const body = new ArrayBuffer(pageBytes);
    new Float32Array(body, 0, 24).set([
      0, 0, 0, 0, 1, 0, 0, 0,
      1, 0, 0, 0, 1, 0, 1, 0,
      0, 0, 1, 0, 1, 0, 0, 1,
    ]);
    new Uint32Array(body, 96, 3).set([0, 1, 2]);
    new Uint32Array(body, pageBytes - 4, 1)[0] = pageId;
    return body;
  });
  const manifest: GeometryManifest = {
    format: 'strata-geometry', version: 1, pageBytes, vertexStride: 32, indexFormat: 'uint32',
    source: { kind: 'analytic-heightfield-v1', seed: 1, tilesPerSide: 1, cellsPerTile: 8, cellSize: 1, triangleCount: 128 },
    bounds, rootPageIds: [0],
    pages: bodies.map((body, id) => ({
      id, url: `pages/${String(id).padStart(6, '0')}.bin`, byteLength: pageBytes,
      sha256: createHash('sha256').update(new Uint8Array(body)).digest('hex'), pinned: id === 0,
    })),
    clusters: bodies.map((_, id) => ({
      id, pageId: id, vertexOffset: 0, vertexCount: 3, indexOffset: 96, indexCount: 3, triangleCount: 1, bounds,
    })),
    tiles: groups.map((lods, id) => ({
      id, bounds, lods: lods.map((pages, level) => ({ level, error: level, clusterIds: pages, pageIds: pages })),
    })),
  };
  const writes: { pageId: number; offset: number; byteLength: number }[] = [];
  const buffer = { destroy: vi.fn() };
  let failNextPage: number | null = null;
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    createBuffer: vi.fn(() => buffer),
    queue: { writeBuffer: vi.fn((_buffer: unknown, offset: number, bytes: Uint8Array<ArrayBuffer>) => {
      const pageId = new DataView(bytes.buffer, bytes.byteOffset).getUint32(pageBytes - 4, true);
      if (pageId === failNextPage) { failNextPage = null; throw new Error('injected synchronous page upload failure'); }
      writes.push({ pageId, offset, byteLength: bytes.byteLength });
    }) },
  };
  const requests: { pageId: number; signal: AbortSignal; resolved: boolean; resolve: (response: Response) => void }[] = [];
  // Intentionally ignore fetch cancellation here: the real cache must reject a
  // response which arrives after its request was cancelled or demand replaced.
  const fetcher: typeof fetch = async (input, init) => {
    const pageId = Number(new URL(String(input)).pathname.match(/(\d+)\.bin$/)![1]);
    if (pageId === 0) return new Response(bodies[0]!.slice(0));
    return new Promise(resolve => requests.push({ pageId, signal: init!.signal!, resolved: false, resolve }));
  };
  const resolve = (pageId: number) => {
    const request = requests.find(request => request.pageId === pageId && !request.resolved);
    if (!request) throw new Error(`No pending controlled request for page ${pageId}.`);
    request.resolved = true;
    request.resolve(new Response(bodies[pageId]!.slice(0)));
  };
  const waitForRequest = async (pageId: number) => {
    await vi.waitFor(() => expect(requests.some(request => request.pageId === pageId && !request.resolved)).toBe(true));
  };
  const create = (options: GeometryPageCacheOptions = {}) => GeometryPageCache.create(
    device as unknown as GPUDevice, manifest, 'https://geometry.test/terrain/manifest.json', {
      poolBytes: 4 * pageBytes, residencyPolicy: 'retain-fallback', fetch: fetcher,
      maxConcurrentRequests: 2, maxCompletedBytes: 2 * pageBytes, uploadBudgetBytes: 2 * pageBytes,
      maxRetries: 0, ...options,
    },
  );
  const close = async (cache: GeometryPageCache) => {
    cache.dispose();
    for (const request of requests) if (!request.resolved) resolve(request.pageId);
    // Allow ignored-abort fetch responses to leave the real cache's load path.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(buffer.destroy).toHaveBeenCalledOnce();
  };
  return { manifest, requests, writes, device, create, resolve, waitForRequest, close,
    failNextUpload(pageId: number) { failNextPage = pageId; } };
}

function assertBounds(cache: GeometryPageCache, gpu: ReturnType<typeof fixture>) {
  const telemetry = cache.telemetry;
  const slots = gpu.manifest.pages.map(page => cache.getSlot(page.id)).filter(slot => slot !== -1);
  expect(slots).toHaveLength(telemetry.residentPages);
  expect(new Set(slots).size).toBe(slots.length);
  expect(slots.every(slot => slot >= 0 && slot < telemetry.capacityPages)).toBe(true);
  expect(telemetry.residentPages).toBeLessThanOrEqual(telemetry.capacityPages);
  expect(telemetry.stagingReservedBytes).toBeLessThanOrEqual(telemetry.stagingBudgetBytes);
  expect(telemetry.completedBytes).toBe(telemetry.completedPages * pageBytes);
  expect(cache.gpuBufferBytes).toBe(telemetry.capacityPages * pageBytes);
  expect(cache.getSlot(0)).not.toBe(-1);
  expect(gpu.writes.every(write => write.byteLength === pageBytes && write.offset % pageBytes === 0
    && write.offset < telemetry.capacityPages * pageBytes)).toBe(true);
}

async function ready(cache: GeometryPageCache, gpu: ReturnType<typeof fixture>, pageIds: number[]) {
  const previousCompleted = cache.telemetry.completedPages;
  for (const pageId of pageIds) { await gpu.waitForRequest(pageId); gpu.resolve(pageId); }
  await vi.waitFor(() => expect(cache.telemetry.completedPages).toBe(previousCompleted + pageIds.length));
  assertBounds(cache, gpu);
}

describe('retained residency through real cache lifecycle', () => {
  it('preserves a complete intermediate through delayed finer pages and a second-upload failure/retry', async () => {
    const gpu = fixture([[[1, 2], [3], [0]]]);
    const cache = await gpu.create();
    try {
      const rootSlot = cache.getSlot(0);
      cache.setDemand([{ tileId: 0, lod: 1, priority: 1 }]);
      await ready(cache, gpu, [3]);
      expect(cache.update().uploaded.map(page => page.pageId)).toEqual([3]);
      const intermediateSlot = cache.getSlot(3);
      cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }]);
      await gpu.waitForRequest(1); await gpu.waitForRequest(2);
      expect(cache.update().uploadBytes).toBe(0);
      expect(cache.isLodResident(0, 1)).toBe(true);
      expect(cache.isLodResident(0, 0)).toBe(false);
      expect(cache.telemetry).toMatchObject({
        residencyPolicy: 'retain-fallback', retainedProtectedPages: 2, retainedTargetTile: 0,
        retainedTargetLod: 0, retainedUnsatisfiedDemands: 1, retainedBlockedDemands: 0,
      });

      await ready(cache, gpu, [1, 2]);
      const uploadsBefore = cache.telemetry.uploadedPages;
      gpu.failNextUpload(2);
      expect(() => cache.update()).toThrow('injected synchronous page upload failure');
      expect(cache.telemetry.uploadedPages - uploadsBefore).toBe(1);
      expect(cache.getSlot(1)).not.toBe(-1);
      expect(cache.getSlot(2)).toBe(-1);
      expect(cache.getSlot(3)).toBe(intermediateSlot);
      expect(cache.getSlot(0)).toBe(rootSlot);
      expect(cache.isLodResident(0, 1)).toBe(true);
      expect(cache.telemetry.completedPages).toBe(1);
      assertBounds(cache, gpu);

      const retry = cache.update();
      expect(retry.uploaded.map(page => page.pageId)).toEqual([2]);
      expect(retry.uploadBytes).toBe(pageBytes);
      expect(retry.evicted).toEqual([]);
      expect(cache.isLodResident(0, 0)).toBe(true);
      expect(cache.telemetry).toMatchObject({ retainedTargetTile: null, retainedUnsatisfiedDemands: 0, retainedProtectedPages: 3 });
      expect(cache.getSlot(0)).toBe(rootSlot);
      assertBounds(cache, gpu);
    } finally { await gpu.close(cache); }
  });

  it('blocks a full pool, including exact-demand coarsening, until visibility releases active protection', async () => {
    const gpu = fixture([[[1, 2], [3], [0]], [[4], [0]]]);
    const cache = await gpu.create({ poolBytes: 3 * pageBytes });
    try {
      cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }]);
      await ready(cache, gpu, [1, 2]);
      expect(cache.update().uploadBytes).toBe(2 * pageBytes);
      const initialSlots = [0, 1, 2].map(pageId => cache.getSlot(pageId));
      cache.setDemand([{ tileId: 0, lod: 1, priority: 1 }, { tileId: 1, lod: 0, priority: 2 }]);
      expect(cache.update()).toEqual({ uploaded: [], evicted: [], uploadBytes: 0 });
      expect(cache.isLodResident(0, 0)).toBe(true);
      expect(cache.isLodResident(0, 1)).toBe(false);
      expect(cache.telemetry).toMatchObject({
        retainedProtectedPages: 3, retainedTargetTile: null, retainedBlockedDemands: 2,
        retainedUnsatisfiedDemands: 2, pendingRequests: 0, evictions: 0,
      });
      expect(gpu.requests.map(request => request.pageId)).toEqual([1, 2]);
      expect([0, 1, 2].map(pageId => cache.getSlot(pageId))).toEqual(initialSlots);
      assertBounds(cache, gpu);

      cache.setDemand([{ tileId: 1, lod: 0, priority: 2 }]);
      await ready(cache, gpu, [4]);
      const update = cache.update();
      expect(update.uploaded.map(page => page.pageId)).toEqual([4]);
      expect(update.evicted.map(page => page.pageId)).toEqual([1]);
      expect(cache.getSlot(0)).toBe(initialSlots[0]);
      expect(cache.isLodResident(1, 0)).toBe(true);
      expect(cache.telemetry).toMatchObject({ retainedBlockedDemands: 0, retainedUnsatisfiedDemands: 0 });
      assertBounds(cache, gpu);
    } finally { await gpu.close(cache); }
  });

  it('protects an incidentally completed preferred LOD before a second shared-page eviction', async () => {
    const gpu = fixture([
      [[1, 2], [3, 4], [0]], [[4, 5], [0]], [[6], [0]], [[3], [0]], [[7, 8], [0]],
    ]);
    const cache = await gpu.create({ poolBytes: 5 * pageBytes });
    try {
      cache.setDemand([{ tileId: 2, lod: 0, priority: 1 }]);
      await ready(cache, gpu, [6]); cache.update();
      cache.setDemand([{ tileId: 3, lod: 0, priority: 1 }]);
      await ready(cache, gpu, [3]); cache.update();
      const seededSlot = cache.getSlot(3);
      cache.setDemand([{ tileId: 4, lod: 0, priority: 1 }]);
      await ready(cache, gpu, [7, 8]); cache.update();
      expect(cache.telemetry.residentPages).toBe(5);
      // Eviction ages are 6, then 3, then 7/8. After 4 evicts 6, page3
      // becomes essential through [3,4] and must not be the next victim.
      cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }, { tileId: 1, lod: 0, priority: 2 }]);
      expect(cache.telemetry).toMatchObject({ retainedTargetTile: 1, retainedProtectedPages: 1 });
      await ready(cache, gpu, [4, 5]);
      const update = cache.update();
      expect(update.uploaded.map(page => page.pageId)).toEqual([4, 5]);
      expect(update.uploadBytes).toBe(2 * pageBytes);
      expect(update.evicted.map(page => page.pageId)).toEqual([6, 7]);
      expect(cache.getSlot(3)).toBe(seededSlot);
      expect(cache.isLodResident(0, 1)).toBe(true);
      expect(cache.isLodResident(1, 0)).toBe(true);
      expect(cache.isLodResident(0, 0)).toBe(false);
      expect(cache.telemetry).toMatchObject({
        retainedProtectedPages: 4, retainedTargetTile: null, retainedBlockedDemands: 1,
        retainedUnsatisfiedDemands: 1, residentPages: 5, capacityPages: 5, pendingRequests: 0,
      });
      // The old root-only protection would admit [1,2], then evict page3.
      expect(gpu.requests.map(request => request.pageId)).toEqual([6, 3, 7, 8, 4, 5]);
      expect(cache.update().uploadBytes).toBe(0);
      expect(cache.getSlot(3)).toBe(seededSlot);
      assertBounds(cache, gpu);
    } finally { await gpu.close(cache); }
  });

  it('ignores late canceled target responses while preserving the current complete alternative', async () => {
    const gpu = fixture([[[1, 2], [3], [0]], [[4], [0]]]);
    const cache = await gpu.create({ maxConcurrentRequests: 3, maxCompletedBytes: 3 * pageBytes });
    try {
      cache.setDemand([{ tileId: 0, lod: 1, priority: 1 }]);
      await ready(cache, gpu, [3]); cache.update();
      const alternativeSlot = cache.getSlot(3);
      cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }]);
      await gpu.waitForRequest(1); await gpu.waitForRequest(2);
      cache.setDemand([{ tileId: 0, lod: 1, priority: 1 }, { tileId: 1, lod: 0, priority: 2 }]);
      expect(gpu.requests.filter(request => request.pageId === 1 || request.pageId === 2)
        .every(request => request.signal.aborted)).toBe(true);
      expect(cache.telemetry.requestsCancelled).toBe(2);
      await ready(cache, gpu, [4]);
      expect(cache.update().uploaded.map(page => page.pageId)).toEqual([4]);
      expect(cache.getSlot(3)).toBe(alternativeSlot);

      gpu.resolve(1); gpu.resolve(2);
      await vi.waitFor(() => expect(cache.telemetry.pendingRequests).toBe(0));
      expect(cache.update()).toEqual({ uploaded: [], evicted: [], uploadBytes: 0 });
      expect(gpu.writes.map(write => write.pageId)).toEqual([0, 3, 4]);
      expect(cache.isLodResident(0, 1)).toBe(true);
      expect(cache.isLodResident(1, 0)).toBe(true);
      expect(cache.getSlot(1)).toBe(-1); expect(cache.getSlot(2)).toBe(-1);
      expect(cache.telemetry).toMatchObject({
        retainedTargetTile: null, retainedUnsatisfiedDemands: 0, retainedProtectedPages: 3,
        failedPages: 0, requestsFailed: 0,
      });
      assertBounds(cache, gpu);
    } finally { await gpu.close(cache); }
  });

  it('leaves greedy replacement available for comparison', async () => {
    const gpu = fixture([[[1, 2], [3], [0]], [[4], [0]]]);
    const cache = await gpu.create({ poolBytes: 3 * pageBytes, residencyPolicy: 'greedy' });
    try {
      cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }]);
      await ready(cache, gpu, [1, 2]); cache.update();
      cache.setDemand([{ tileId: 0, lod: 1, priority: 1 }, { tileId: 1, lod: 0, priority: 2 }]);
      await ready(cache, gpu, [4, 3]);
      const update = cache.update();
      expect(update.uploaded.map(page => page.pageId)).toEqual([4, 3]);
      expect(update.evicted.map(page => page.pageId)).toEqual([1, 2]);
      expect(cache.isLodResident(0, 1)).toBe(true);
      expect(cache.isLodResident(0, 0)).toBe(false);
      expect(cache.telemetry).toMatchObject({ residencyPolicy: 'greedy', retainedProtectedPages: 0 });
      assertBounds(cache, gpu);
    } finally { await gpu.close(cache); }
  });
});
