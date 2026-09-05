import { afterEach, expect, it, vi } from 'vitest';
import { GpuGeometry } from '../../packages/core/src/geometry/gpu-geometry.js';
import { GeometryPageCache } from '../../packages/core/src/geometry/page-cache.js';
import { ORIGINAL_TERRAIN } from '../helpers/original-terrain-recording.js';
import { installOriginalTerrainObserver, ORIGINAL_TERRAIN_OBSERVER_SOURCE, terrainWrittenBytes } from '../browser/original-terrain-observer.js';
import type { TerrainObserverEvent } from '../browser/original-terrain-observer.js';

const owned: ReturnType<typeof installOriginalTerrainObserver>[] = [];
afterEach(() => { for (const observer of owned.splice(0)) observer.detach(); vi.restoreAllMocks(); });
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
/** Synthetic native-shaped objects only: these tests do not render or decode an asset. */
function fixture() {
  const buffers: any[] = [], events: TerrainObserverEvent[] = [], mapGate = deferred<void>();
  const queue = { writeBuffer: vi.fn(), submit: vi.fn() };
  const device = { queue,
    createBuffer: vi.fn((d: GPUBufferDescriptor) => {
      const bytes = new ArrayBuffer(Number(d.size));
      const nativeMap = vi.fn(() => mapGate.promise);
      const b = { ...d, label: d.label ?? '', size: Number(d.size), bytes,
        mapAsync: nativeMap, nativeMap, getMappedRange: vi.fn(() => bytes), unmap: vi.fn() };
      buffers.push(b); return b;
    }),
    createCommandEncoder: vi.fn(() => { const nativeFinish = vi.fn(() => ({})); return { finish: nativeFinish, nativeFinish }; }),
  } as unknown as GPUDevice;
  const manifest = { source: { kind: 'analytic-heightfield-v1', seed: 1337, tilesPerSide: 8, cellsPerTile: 128, triangleCount: 2097152 },
    pageBytes: 65536, pages: Array.from({ length: 1199 }, (_, id) => ({ id, byteLength: 65536 })),
    tiles: Array.from({ length: 64 }, (_, id) => ({ id, lods: [{}, {}, {}, {}] })), rootPageIds: Array.from({ length: 24 }, (_, i) => i) };
  const cache = Object.assign(Object.create(GeometryPageCache.prototype), { device, manifest,
    settings: { mode: 'streamed', residencyPolicy: 'greedy', capacityPages: 128 },
    mapping: new Int32Array(1199).fill(-1), slots: new Int32Array(128).fill(-1), roots: new Set(manifest.rootPageIds),
    demands: [], wanted: new Set(manifest.rootPageIds), pageOrder: [...manifest.rootPageIds], plannedLods: new Map(),
    pending: new Map(), completed: new Map(), failures: new Map(), frame: 0, epoch: 7, preloading: false, disposed: false });
  for (let i = 0; i < 24; i++) { cache.mapping[i] = i; cache.slots[i] = i; }
  const g = Object.assign(Object.create(GpuGeometry.prototype), { device, manifest, cache, disposed: false });
  const replan = vi.spyOn(GeometryPageCache.prototype as unknown as { replan: () => void }, 'replan').mockImplementation(function (this: any) {
    this.plannedLods = new Map(this.demands.map((d: any) => [d.tileId, d.lod]));
  });
  const update = vi.spyOn(GeometryPageCache.prototype, 'update').mockImplementation(function (this: any) {
    this.frame++; this.replan(); return { uploaded: [], evicted: [], uploadBytes: 0 };
  });
  vi.spyOn(GeometryPageCache.prototype, 'setDemand').mockImplementation(function (this: any, demands) {
    this.demands = demands.map(d => ({ ...d })); this.replan();
  });
  vi.spyOn(GpuGeometry.prototype, 'cancelFrame').mockImplementation(function (this: any) { this.recording = undefined; });
  vi.spyOn(GpuGeometry.prototype, 'prepare').mockImplementation(function (this: any, _encoder, camera, width, height, reset) {
    this.cancelFrame(); this.cache.update();
    this.device.queue.writeBuffer(this.resources.residency, 0, Uint32Array.from(this.cache.mapping));
    const data = new ArrayBuffer(160), f = new Float32Array(data);
    f.set(camera.viewProjection); f.set(camera.view, 16); f.set([1, 2, width, height], 32); new Uint32Array(data)[36] = Number(reset);
    this.device.queue.writeBuffer(this.resources.uniform, 0, data);
    this.recording = this.feedback.find((s: any) => !s.busy); this.recording.busy = true;
    return { dispatchCalls: 2, uploadBytes: 0, triangles: 1 };
  });
  vi.spyOn(GpuGeometry.prototype, 'submitted').mockImplementation(function (this: any, frameId) {
    const slot = this.recording; this.recording = undefined; slot.frameId = frameId;
    slot.pending = slot.buffer.mapAsync(1, 0, 2112).then(() => {
      slot.buffer.getMappedRange(); this.cache.setDemand([{ tileId: 2, lod: 1, priority: 9 }]);
      slot.buffer.unmap(); slot.busy = false; slot.pending = null;
    });
  });
  const creation = deferred<GpuGeometry>();
  const nativeCreate = vi.spyOn(GpuGeometry, 'create').mockReturnValue(creation.promise);
  const nativeSubmit = queue.submit, nativeWrite = queue.writeBuffer;
  const observer = installOriginalTerrainObserver(device, { sourceIdentity: ORIGINAL_TERRAIN_OBSERVER_SOURCE,
    manifestSha256: ORIGINAL_TERRAIN.manifestSha256, emit: e => { events.push(e); } }); owned.push(observer);
  const b = (label: string, size: number, usage = 0x88) => device.createBuffer({ label, size, usage });
  cache.buffer = b('Strata fixed geometry page pool', 8388608);
  g.resources = { residency: b('Strata page residency table', 4796), uniform: b('Strata geometry selection camera', 160, 0x48),
    selections: b('Strata current tile LOD selections', 2048, 0x8c), arguments: b('Strata indirect geometry arguments and counters', 64, 0x18c) };
  const transforms = b('Strata current and previous transforms', 352, 0x48);
  g.feedback = Array.from({ length: 3 }, (_, i) => ({ buffer: b(`Strata geometry feedback ${i}`, 2112, 9), busy: false, frameId: 0, pending: null }));
  const promise = GpuGeometry.create(device, manifest as never, new URL('https://fixture.test/manifest.json'), { renderer: 'virtual', manifestUrl: '/manifest.json' });
  const camera = { view: Float32Array.from({ length: 16 }, (_, i) => i), viewProjection: Float32Array.from({ length: 16 }, (_, i) => i + 16) };
  const prepare = () => {
    const encoder = device.createCommandEncoder(); g.prepare(encoder, camera, 1280, 720, false, {});
    return encoder;
  };
  const rasterWrite = () => { const f = new Float32Array(88); f.set(camera.viewProjection); f.set(camera.view, 32);
    device.queue.writeBuffer(transforms, 0, f); return f; };
  return { device, queue, nativeSubmit, nativeWrite, g, cache, manifest, observer, events, buffers, transforms, creation, nativeCreate, promise,
    replan, update, camera, prepare, rasterWrite, mapGate };
}
async function ready() { const f = fixture(); f.creation.resolve(f.g); await f.promise; return f; }

it('requires exact supplied module/manifest identities before installing any hooks', () => {
  const queue = { submit() {} }, device = { queue } as unknown as GPUDevice;
  const original = queue.submit;
  for (const patch of [{ manifestSha256: '0'.repeat(64) }, { sourceIdentity: {} },
    { sourceIdentity: { ...ORIGINAL_TERRAIN_OBSERVER_SOURCE, extra: 'x' } }]) {
    expect(() => installOriginalTerrainObserver(device, { sourceIdentity: ORIGINAL_TERRAIN_OBSERVER_SOURCE,
      manifestSha256: ORIGINAL_TERRAIN.manifestSha256, emit() {}, ...patch })).toThrow();
    expect(queue.submit).toBe(original);
  }
});

it('returns the unchanged native create Promise and does not bind late creation after detach', async () => {
  const f = fixture(); expect(f.promise).toBe(f.creation.promise);
  f.observer.detach(); f.creation.resolve(f.g); expect(await f.promise).toBe(f.g);
  expect(f.events).toEqual([]); expect(f.observer.summary.active).toBe(false);
});

it('binds actual prepared writes, finished transforms, submitted native frame and mapped generation', async () => {
  const f = await ready(), encoder = f.prepare(), data = f.rasterWrite();
  const descriptor = { label: 'original finish argument' }, command = encoder.finish(descriptor);
  const submitted = [command]; f.device.queue.submit(submitted); f.g.submitted(812);
  expect(f.nativeSubmit.mock.calls[0]![0]).toBe(submitted);
  expect(f.observer.summary).toMatchObject({ frameSubmissions: 1, diagnosticSubmissions: 0, pendingFeedback: 1 });
  const mappedPromise = f.g.feedback[0].buffer.nativeMap.mock.results[0].value;
  expect(mappedPromise).toBe(f.mapGate.promise);
  data.fill(0); f.cache.mapping[24] = 99; // Earlier snapshots must not alias mutable producer arrays.
  f.mapGate.resolve(); await f.g.feedback[0].pending;
  const receipt = f.observer.feedbackFor(812);
  expect(receipt).toMatchObject({ frameId: 812, generation: 7, ticket: 1 });
  expect(receipt.prepared.residency[24]).toBe(0xffffffff);
  expect(new Float32Array(receipt.transforms.buffer)[0]).toBe(16);
  expect(receipt.bytes.byteLength).toBe(2112); expect(f.observer.summary.pendingFeedback).toBe(0);
  expect(f.observer.assertComplete(1).feedbackCount).toBe(1);
  expect(() => f.observer.assertComplete(2)).toThrow(/Missing native/);
  receipt.prepared.residency.fill(8); expect(f.observer.feedbackFor(812).prepared.residency[0]).toBe(0);
  expect(f.events.map(e => e.eventId)).toEqual(f.events.map((_, i) => i + 1));
  expect(f.events.map(e => e.kind)).toContain('cache-setDemand'); f.observer.assertHealthy();
});

it('does not count diagnostic submissions as rendered frames or consume arbitrary iterables twice', async () => {
  const f = await ready(); const diagnostic = f.device.createCommandEncoder().finish();
  f.device.queue.submit([diagnostic]); expect(f.observer.summary).toMatchObject({ frameSubmissions: 0, diagnosticSubmissions: 1 });
  let iterations = 0;
  const input = { *[Symbol.iterator]() { iterations++; yield diagnostic; } };
  f.nativeSubmit.mockImplementation(value => { for (const _command of value) { /* Native consumes once. */ } });
  f.device.queue.submit(input); expect(iterations).toBe(1);
  expect(f.nativeSubmit.mock.calls[1]![0]).toBe(input); expect(() => f.observer.assertHealthy()).toThrow(/array/);
});

it('rejects missing/wrong/stale raster transform writes independently of selection-camera success', async () => {
  for (const kind of ['missing', 'stale', 'different']) {
    const f = await ready(); if (kind === 'stale') f.rasterWrite();
    const encoder = f.prepare();
    if (kind === 'different') { const data = f.rasterWrite(); data[0] = 99; f.device.queue.writeBuffer(f.transforms, 0, data); }
    encoder.finish(); expect(() => f.observer.assertHealthy()).toThrow();
    f.observer.detach(); vi.restoreAllMocks();
  }
});

it('native submit failure is unchanged, latches failure and cannot be relabelled by submitted()', async () => {
  const f = await ready(), encoder = f.prepare(); f.rasterWrite(); const command = encoder.finish();
  const failure = Error('native queue rejected'); f.nativeSubmit.mockImplementationOnce(() => { throw failure; });
  expect(() => f.device.queue.submit([command])).toThrow(failure);
  f.g.submitted(15); expect(f.observer.summary.frameSubmissions).toBe(0); expect(() => f.observer.assertHealthy()).toThrow();
  f.mapGate.resolve(); await f.g.feedback[0].pending;
});

it('prepare errors end evidence without changing native throws or retrying', async () => {
  const f = await ready(); const failure = Error('actual cache update failed');
  f.update.mockImplementationOnce(() => { throw failure; });
  expect(() => f.prepare()).toThrow(failure); expect(f.observer.summary.preparedTickets).toBe(0);
  expect(() => f.observer.assertHealthy()).toThrow();
});

it('native failed write is forwarded once and never produces a prepared ticket', async () => {
  const f = await ready(), failure = Error('native write rejected');
  f.nativeWrite.mockImplementationOnce(() => { throw failure; });
  expect(() => f.prepare()).toThrow(failure);
  expect(f.nativeWrite).toHaveBeenCalledTimes(1);
  expect(f.observer.summary.preparedTickets).toBe(0);
  expect(() => f.observer.assertComplete(1)).toThrow();
});

it('finish failure and explicit cancellation independently reject case continuation', async () => {
  for (const kind of ['finish', 'cancel']) {
    const f = await ready(), encoder = f.prepare(); f.rasterWrite();
    if (kind === 'finish') {
      const failure = Error('native finish rejected'); (encoder as any).nativeFinish.mockImplementationOnce(() => { throw failure; });
      expect(() => encoder.finish()).toThrow(failure);
      expect(encoder.finish).toBe((encoder as any).nativeFinish);
    } else f.g.cancelFrame();
    expect(() => f.observer.assertHealthy()).toThrow();
    f.observer.detach(); vi.restoreAllMocks();
  }
});

it('missing feedback or a changed native generation cannot become complete', async () => {
  const f = await ready(), encoder = f.prepare(); f.rasterWrite(); f.device.queue.submit([encoder.finish()]); f.g.submitted(40);
  expect(() => f.observer.assertComplete(1)).toThrow(/Missing native/);
  f.cache.epoch++; f.mapGate.resolve(); await f.g.feedback[0].pending;
  expect(f.observer.errors.join()).toMatch(/Stale generation/);
  expect(() => f.observer.feedbackFor(40)).toThrow(/not retained/);
});

it('map rejection retains original Promise settlement and fails feedback admission', async () => {
  const f = await ready(), encoder = f.prepare(); f.rasterWrite(); f.device.queue.submit([encoder.finish()]); f.g.submitted(5);
  const failure = Error('map rejected'), pending = f.g.feedback[0].pending;
  const rejected = expect(pending).rejects.toBe(failure);
  f.mapGate.reject(failure); await rejected;
  expect(f.observer.errors.join()).toMatch(/map rejected/);
  expect(() => f.observer.assertComplete(1)).toThrow();
});

it('native writeBuffer receiver, typed-array offset/count and return are unchanged', async () => {
  const f = await ready(), encoder = f.prepare(), data = new Float32Array(90);
  data.set(f.camera.viewProjection, 1); data.set(f.camera.view, 33);
  const marker = Symbol('native returned value'); f.nativeWrite.mockReturnValueOnce(marker);
  const args = [f.transforms, 0, data, 1, 88];
  expect(Reflect.apply(f.device.queue.writeBuffer, f.device.queue, args)).toBe(marker);
  const call = f.nativeWrite.mock.calls.at(-1)!;
  expect(call[2]).toBe(data); expect(call.slice(3)).toEqual([1, 88]);
  expect(f.nativeWrite.mock.contexts.at(-1)).toBe(f.device.queue);
  encoder.finish(); f.observer.assertHealthy();
});

it('captures actual upload/eviction result and successive incidental replans as owned values', async () => {
  const f = await ready();
  const nativeResult = { uploaded: [{ pageId: 25, slot: 24 }], evicted: [{ pageId: 26, slot: 24 }], uploadBytes: 65536 };
  f.update.mockImplementationOnce(function (this: any) {
    this.demands = [{ tileId: 0, lod: 1, priority: 7 }]; this.replan();
    this.mapping[25] = 24; this.replan(); return nativeResult;
  });
  expect(f.cache.update()).toBe(nativeResult);
  const updates = f.events.filter(e => e.kind === 'cache-update');
  const result = (updates[0]!.payload as any).result;
  nativeResult.uploaded[0]!.pageId = 90; expect(result.uploaded[0].pageId).toBe(25);
  const replans = f.events.filter(e => e.kind === 'cache-replan');
  expect(replans.length).toBe(2);
  expect((replans[0]!.payload as any).state.mapping[25]).toBe(-1);
  expect((replans[1]!.payload as any).state.mapping[25]).toBe(24);
});

it('typed array, DataView and ArrayBuffer write units preserve native subrange semantics', () => {
  const source = Uint32Array.from([10, 20, 30, 40]);
  expect([...new Uint32Array(terrainWrittenBytes(source.subarray(1), 1, 1).buffer)]).toEqual([30]);
  expect([...new Uint32Array(terrainWrittenBytes(source.buffer, 4, 8).buffer)]).toEqual([20, 30]);
  expect([...new Uint32Array(terrainWrittenBytes(new DataView(source.buffer, 4, 8), 4, 4).buffer)]).toEqual([30]);
  expect(() => terrainWrittenBytes(source, 4, 1)).toThrow();
  expect(() => terrainWrittenBytes(new Uint8Array(4800))).toThrow();
});

it('detach restores exact descriptors, releases finished-encoder hooks and does not overwrite another owner', async () => {
  const f = await ready(); const encoder = f.device.createCommandEncoder();
  const originalFinish = (encoder as any).nativeFinish;
  encoder.finish(); // A non-frame diagnostic finish also releases its per-encoder hook.
  expect(Object.getOwnPropertyDescriptor(encoder, 'finish')?.value).toBe(originalFinish);
  const replacement = vi.fn(); Object.defineProperty(f.device.queue, 'submit', { configurable: true, value: replacement });
  f.observer.detach(); expect(f.device.queue.submit).toBe(replacement);
  expect(f.observer.errors.join()).toMatch(/replaced before detach/);
});

it('sink exceptions fail separately without changing native return value or object identity', async () => {
  const f = await ready(); f.observer.detach();
  const observer = installOriginalTerrainObserver(f.device, { sourceIdentity: ORIGINAL_TERRAIN_OBSERVER_SOURCE,
    manifestSha256: ORIGINAL_TERRAIN.manifestSha256, emit() { throw Error('external sink failed'); } }); owned.push(observer);
  const native = f.cache.update(); expect(native.uploadBytes).toBe(0);
  expect(observer.errors.join()).toMatch(/sink failed/);
});

it('cache-state cap and asynchronous sinks cannot silently drop required evidence', async () => {
  const f = await ready();
  f.cache.pending = new Map(Array.from({ length: 1200 }, (_, id) => [id, { pageId: id, epoch: 7, cancelled: false, finished: false }]));
  const result = f.cache.update(); expect(result.uploadBytes).toBe(0);
  expect(f.observer.errors.join()).toMatch(/Page state cap/);
  f.observer.detach(); f.cache.pending.clear();
  const observer = installOriginalTerrainObserver(f.device, { sourceIdentity: ORIGINAL_TERRAIN_OBSERVER_SOURCE,
    manifestSha256: ORIGINAL_TERRAIN.manifestSha256, emit: async () => { throw Error('async sink rejected'); } }); owned.push(observer);
  f.cache.update(); await Promise.resolve();
  expect(observer.errors.join()).toMatch(/synchronously/); expect(observer.errors.join()).toMatch(/async sink rejected/);
});

it('original create rejection is unchanged and detachment never claims initialization succeeded', async () => {
  const f = fixture(), failure = Error('native initialization failed');
  const rejection = expect(f.promise).rejects.toBe(failure);
  f.creation.reject(failure); await rejection;
  expect(f.observer.errors.join()).toMatch(/initialization failed/); expect(f.events).toEqual([]);
});

it('unfinished encoder hooks are bounded and native allocation still forwards after observer cap failure', async () => {
  const f = await ready(), encoders = Array.from({ length: 9 }, () => f.device.createCommandEncoder());
  expect(encoders).toHaveLength(9); expect(f.observer.summary.liveEncoderHooks).toBe(8);
  expect(f.observer.errors.join()).toMatch(/Encoder observation cap/);
  f.observer.detach();
  expect(f.observer.summary.liveEncoderHooks).toBe(0);
  expect(encoders.every(e => e.finish === (e as any).nativeFinish)).toBe(true);
});
