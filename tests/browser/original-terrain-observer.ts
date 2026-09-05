import { GpuGeometry } from '../../packages/core/src/geometry/gpu-geometry.js';
import { GeometryPageCache } from '../../packages/core/src/geometry/page-cache.js';
import type { GeometryManifest } from '../../packages/core/src/geometry/format.js';
import type { RetainedResidencyPlan } from '../../packages/core/src/geometry/retained-residency.js';
import { ORIGINAL_TERRAIN, observeTerrainFeedback } from '../helpers/original-terrain-recording.js';

/** Supplied frozen-module admission, NOT an independent hash of executing JS.
 * The future launcher must prove its loaded bytes; this layer checks live layouts. */
export const ORIGINAL_TERRAIN_OBSERVER_SOURCE = Object.freeze({
  'packages/core/src/geometry/gpu-geometry.ts': '16079208e8ca9c0d7a94c1dc5fdc36d3f6f004c157c0dceca34637e8ed7ada10',
  'packages/core/src/geometry/page-cache.ts': '983dc1f9815109c389d2b8ef3b6a3bdec0755af8b0edbba5682d2277832f4728',
  'packages/core/src/geometry/geometry-data.ts': 'ac25995f1f75862fa461704593695800f4ba34246cab872d93ad23fef2a4a4bb',
  'packages/core/src/geometry/gpu-geometry-shaders.ts': '95ffeeafd6665c5a66be4f0feca0ba44087d7be3d9d655cfb887ad1f9f02d68d',
  'packages/core/src/geometry/retained-residency.ts': 'f8348ff4164bbfd4d659948804d0fa7bfe61626acc398de83435d5f99942ace6',
  'packages/core/src/rendering/raster-renderer.ts': '7977f356d6498e0c600ae18f18ba40e09a83b0e135f7cdd61fc8628ed0525f9f',
});
export const ORIGINAL_TERRAIN_OBSERVER_LIMITS = Object.freeze({ feedbackSlots: 3, feedbackBytes: 2112,
  residencyBytes: 4796, selectionCameraBytes: 160, transformsBytes: 352,
  maxEvents: 200000, maxEventCopyBytes: 128 * 1024, maxEmittedCopyBytes: 2 * 1024 ** 3,
  maxErrors: 16, maxPendingFeedback: 3, maxRetainedFeedback: 3,
  maxLiveEncoderHooks: 8, maxEncoderCallbacks: 20000,
  scope: 'Diagnostic only; synchronous callbacks, bounded copies, no image/page-payload corpus. Copy costs estimate payload storage, NOT persisted UTF8 bytes; the later archive sink must separately count actual writes. Exceeding a cap fails admission, never trims required evidence.' });
const labels = Object.freeze({ residency: 'Strata page residency table', camera: 'Strata geometry selection camera',
  transforms: 'Strata current and previous transforms', selections: 'Strata current tile LOD selections',
  arguments: 'Strata indirect geometry arguments and counters', pool: 'Strata fixed geometry page pool' });
type ResourceName = keyof typeof labels;
type NativeMethod = (...args: any[]) => any;
interface CacheView {
  device: GPUDevice; manifest: GeometryManifest; settings: { mode: string; residencyPolicy: string; capacityPages: number };
  mapping: Int32Array; slots: Int32Array; roots: Set<number>; demands: { tileId: number; lod: number; priority: number }[];
  wanted: Set<number>; pageOrder: number[]; plannedLods: Map<number, number>; retainedPlan?: RetainedResidencyPlan;
  pending: Map<number, { pageId: number; epoch: number; cancelled: boolean; finished: boolean }>;
  completed: Map<number, Uint8Array>; failures: Map<number, { attempts: number; retryAt: number; terminal: boolean }>;
  frame: number; epoch: number; preloading: boolean; disposed: boolean; buffer: GPUBuffer;
  telemetry: Record<string, unknown>;
}
interface Slot { buffer: GPUBuffer; busy: boolean; frameId: number; pending: Promise<void> | null }
interface GeometryView {
  device: GPUDevice; manifest: GeometryManifest; cache: GeometryPageCache; feedback: Slot[]; recording?: Slot;
  resources: { residency: GPUBuffer; uniform: GPUBuffer; selections: GPUBuffer; arguments: GPUBuffer };
  residencyWords: Uint32Array; uniformData: ArrayBuffer; disposed: boolean;
}
export interface TerrainObserverEvent { eventId: number; kind: string; payload: unknown }
interface Preparation {
  ticket: number; generation: number; residency: Uint32Array; selectionCamera: Uint8Array;
  width: number; height: number; reset: boolean; cache: ReturnType<typeof cacheSnapshot>;
}
interface Ticket { prepared: Preparation; encoder: GPUCommandEncoder; slot: Slot; transformsVersion: number;
  transforms?: Uint8Array; commandBuffer?: GPUCommandBuffer; submitted: boolean; frameId?: number }
export interface TerrainObservedFeedback {
  ticket: number; frameId: number; generation: number; bytes: ArrayBuffer; prepared: Preparation; transforms: Uint8Array;
}
const cacheView = (cache: unknown) => cache as CacheView;
const geometryView = (geometry: unknown) => geometry as GeometryView;
function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  check(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum, 'Invalid observed integer');
}
function manifestGuard(m: GeometryManifest) {
  check(m.pages.length === 1199 && m.tiles.length === 64 && m.rootPageIds.length === 24 && m.pageBytes === 65536,
    'Original terrain topology required');
  check(m.source.kind === 'analytic-heightfield-v1' && m.source.seed === 1337 && m.source.tilesPerSide === 8
    && m.source.cellsPerTile === 128 && m.source.triangleCount === 2097152, 'Original terrain source required');
  check(m.pages.every((p, i) => p.id === i && p.byteLength === 65536)
    && m.tiles.every((t, i) => t.id === i && t.lods.length === 4), 'Original IDs/LOD layout required');
}
function cacheSnapshot(c: CacheView) {
  manifestGuard(c.manifest);
  check(c.mapping instanceof Int32Array && c.mapping.length === 1199 && c.slots instanceof Int32Array
    && c.slots.length === c.settings.capacityPages, 'Cache mapping layout differs');
  check((c.settings.mode === 'streamed' && c.settings.capacityPages === 128)
    || (c.settings.mode === 'resident-full' && c.settings.capacityPages === 1199 && c.settings.residencyPolicy === 'greedy'), 'Unexpected cache mode/capacity');
  check(['greedy', 'retain-fallback'].includes(c.settings.residencyPolicy), 'Unknown policy');
  for (const values of [c.wanted, c.pageOrder, c.pending, c.completed, c.failures]) {
    check(('size' in values ? values.size : values.length) <= 1199, 'Page state cap exceeded');
  }
  check(c.demands.length <= 64 && c.plannedLods.size <= 64 && c.roots.size === 24, 'Demand/root cap exceeded');
  const p = c.retainedPlan;
  if (p) check(p.selectedLods.size <= 64 && p.blockedDemands.length <= 64 && p.pageOrder.length <= 1199
    && p.protectedPageIds.size <= 1199 && p.wantedPageIds.size <= 1199
    && (!p.target || (p.target.pageIds.length <= 1199 && p.target.missingPageIds.length <= 1199)), 'Retained plan cap exceeded');
  integer(c.frame); integer(c.epoch);
  return {
    frame: c.frame, epoch: c.epoch, preloading: c.preloading, disposed: c.disposed,
    mode: c.settings.mode, policy: c.settings.residencyPolicy, capacityPages: c.settings.capacityPages,
    mapping: c.mapping.slice(), slots: c.slots.slice(), roots: [...c.roots],
    demands: c.demands.map(d => ({ tileId: d.tileId, lod: d.lod, priority: d.priority })),
    wanted: [...c.wanted], pageOrder: [...c.pageOrder], plannedLods: [...c.plannedLods].map(([tileId, lod]) => ({ tileId, lod })),
    pending: [...c.pending].map(([pageId, r]) => ({ pageId, epoch: r.epoch, cancelled: r.cancelled, finished: r.finished })),
    completed: [...c.completed].map(([pageId, data]) => ({ pageId, bytes: data.byteLength })),
    failures: [...c.failures].map(([pageId, f]) => ({ pageId, attempts: f.attempts, retryAt: f.retryAt, terminal: f.terminal })),
    retained: p ? { selectedLods: [...p.selectedLods].map(([tileId, lod]) => ({ tileId, lod })),
      target: p.target ? { ...p.target, pageIds: [...p.target.pageIds], missingPageIds: [...p.target.missingPageIds] } : null,
      protectedPageIds: [...p.protectedPageIds], wantedPageIds: [...p.wantedPageIds], pageOrder: [...p.pageOrder],
      blockedDemands: p.blockedDemands.map(d => ({ ...d })), unsatisfiedDemandCount: p.unsatisfiedDemandCount,
      deferredDemandCount: p.deferredDemandCount } : null,
  };
}
/** CPU byte-copy semantics of GPUQueue.writeBuffer, including typed-array units. */
export function terrainWrittenBytes(data: AllowSharedBufferSource, dataOffset = 0, size?: number): Uint8Array {
  integer(dataOffset);
  const view = ArrayBuffer.isView(data);
  const unit = view && 'BYTES_PER_ELEMENT' in data ? Number(data.BYTES_PER_ELEMENT) : 1;
  const bytes = view ? data.byteLength : data.byteLength;
  const count = size === undefined ? bytes / unit - dataOffset : size;
  integer(count); const start = dataOffset * unit, length = count * unit;
  check(Number.isSafeInteger(start) && Number.isSafeInteger(length) && start + length <= bytes && length <= 4796,
    'Observed write slice out of bounds');
  return new Uint8Array(view ? data.buffer : data, (view ? data.byteOffset : 0) + start, length).slice();
}
function copyCost(value: unknown): number {
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (value === null || value === undefined) return 4;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value !== 'object') return 8;
  return Object.entries(value).reduce((sum, [key, item]) => sum + key.length * 2 + copyCost(item), 0);
}
let currentObserver: object | undefined;

/** One native device/terrain provider per diagnostic case. No drawing, queue work,
 * resource allocation or cancellation is introduced. Callbacks must be synchronous
 * bounded sinks; asynchronous persistence belongs to the later browser entry. */
export function installOriginalTerrainObserver(device: GPUDevice, options: {
  sourceIdentity: Readonly<Record<string, string>>; manifestSha256: string; emit: (event: TerrainObserverEvent) => void;
}) {
  check(!currentObserver, 'Another terrain observer is still installed');
  check(options.manifestSha256 === ORIGINAL_TERRAIN.manifestSha256, 'Original manifest identity required');
  const expected = Object.entries(ORIGINAL_TERRAIN_OBSERVER_SOURCE);
  check(Object.keys(options.sourceIdentity).length === expected.length && expected.every(([key, hash]) => options.sourceIdentity[key] === hash),
    'Supplied frozen source identity differs');
  check(typeof options.emit === 'function', 'Synchronous observation sink required');
  const emit = options.emit;
  let active = true, failed = false, emitting = false, eventId = 0, emittedCopyBytes = 0, ticketId = 0;
  let geometry: GpuGeometry | undefined, cache: GeometryPageCache | undefined, pending: Ticket | undefined;
  let prepareDepth = 0, lastFrameId: number | undefined, queueSubmissions = 0, frameSubmissions = 0, diagnosticSubmissions = 0;
  let nativeFrameCallbacks = 0, feedbackCount = 0;
  let liveEncoderHooks = 0, encoderCallbacks = 0;
  const errors: string[] = [], restorers = new Set<() => void>();
  const resources = new Map<ResourceName, GPUBuffer>();
  const mirrors = new Map<GPUBuffer, { bytes: Uint8Array; initialized: Uint8Array; version: number }>();
  const commandTickets = new WeakMap<GPUCommandBuffer, Ticket>(), encoderTickets = new WeakMap<GPUCommandEncoder, Ticket>();
  const slotTickets = new Map<GPUBuffer, Ticket>(), feedback = new Map<number, TerrainObservedFeedback>();
  const fail = (cause: unknown) => { failed = true; if (errors.length < 16) errors.push(String(cause).slice(0, 2048)); };
  const safely = (fn: () => void) => { if (active && !failed) try { fn(); } catch (cause) { fail(cause); } };
  const event = (kind: string, payload: unknown) => {
    check(!emitting, 'Recursive observer callback');
    const bytes = copyCost(payload) + kind.length * 2 + 32;
    check(eventId < ORIGINAL_TERRAIN_OBSERVER_LIMITS.maxEvents && bytes <= ORIGINAL_TERRAIN_OBSERVER_LIMITS.maxEventCopyBytes
      && emittedCopyBytes + bytes <= ORIGINAL_TERRAIN_OBSERVER_LIMITS.maxEmittedCopyBytes, 'Observer evidence cap exceeded');
    const owned = structuredClone(payload); eventId++; emittedCopyBytes += bytes;
    emitting = true;
    try {
      const returned: unknown = emit({ eventId, kind, payload: owned });
      if (returned instanceof Promise) void returned.catch(cause => { if (active) fail(cause); });
      check(returned === undefined, 'Observer sink must return void synchronously');
    }
    finally { emitting = false; }
  };
  function patch(target: object, key: string, make: (native: NativeMethod) => NativeMethod) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    const native = Reflect.get(target, key); check(typeof native === 'function', `Missing native method ${key}`);
    const wrapper = make(native);
    Object.defineProperty(target, key, { configurable: true, writable: true, value: wrapper });
    const restore = () => {
      restorers.delete(restore);
      if (Object.getOwnPropertyDescriptor(target, key)?.value !== wrapper) { fail(`Observer method replaced before detach: ${key}`); return; }
      if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
    };
    restorers.add(restore); return restore;
  }
  function bindCache(value: GeometryPageCache) {
    check(!cache || cache === value, 'More than one native terrain cache'); cache = value;
    check(cacheView(value).device === device, 'Wrong native cache device'); cacheSnapshot(cacheView(value));
  }
  function mirror(name: ResourceName) {
    const buffer = resources.get(name), value = buffer && mirrors.get(buffer);
    check(value && value.initialized.every(byte => byte === 1), `Missing complete successful ${name} write`);
    return value;
  }
  function bindGeometry(value: GpuGeometry) {
    check(!geometry || geometry === value, 'More than one native terrain provider');
    const g = geometryView(value); check(g.device === device, 'Wrong geometry device'); manifestGuard(g.manifest); bindCache(g.cache);
    check(g.feedback.length === 3 && g.feedback.every((s, i) => s.buffer.label === `Strata geometry feedback ${i}`
      && s.buffer.size === 2112), 'Frozen source requires exactly three native feedback slots');
    check(g.resources.residency === resources.get('residency') && g.resources.uniform === resources.get('camera')
      && g.resources.selections === resources.get('selections') && g.resources.arguments === resources.get('arguments'), 'Native resource identities differ');
    if (geometry) return; geometry = value;
    for (const slot of g.feedback) {
      const observed = observeTerrainFeedback(slot.buffer, () => {
        // submitted() writes the native slot ID immediately before mapAsync().
        return { frameId: slot.frameId, generation: cacheView(g.cache).epoch };
      }, result => safely(() => {
        const t = slotTickets.get(slot.buffer); check(t && t.frameId === result.frameId && t.submitted, 'Feedback has no submitted native ticket');
        check(t.prepared.generation === result.generation && result.generation === cacheView(g.cache).epoch
          && t.transforms && result.bytes.byteLength === 2112, 'Stale generation or incomplete frame');
        const receipt = { ...result, ticket: t.prepared.ticket, prepared: structuredClone(t.prepared), transforms: t.transforms.slice() };
        feedback.set(result.frameId, receipt);
        if (feedback.size > 3) feedback.delete(feedback.keys().next().value!);
        slotTickets.delete(slot.buffer);
        feedbackCount++;
        event('feedback', { ...result, ticket: t.prepared.ticket });
      }));
      const map = Object.getOwnPropertyDescriptor(slot.buffer, 'mapAsync')?.value;
      const read = Object.getOwnPropertyDescriptor(slot.buffer, 'getMappedRange')?.value;
      restorers.add(() => {
        if (Object.getOwnPropertyDescriptor(slot.buffer, 'mapAsync')?.value === map
          && Object.getOwnPropertyDescriptor(slot.buffer, 'getMappedRange')?.value === read) observed.detach();
        else fail('Feedback observer replaced before detach');
      });
      patch(slot.buffer, 'mapAsync', native => function (this: GPUBuffer, ...args: Parameters<GPUBuffer['mapAsync']>) {
        let result: Promise<void>;
        try { result = Reflect.apply(native, this, args); } catch (cause) { if (active) fail(cause); throw cause; }
        void result.then(undefined, cause => { if (active) fail(cause); });
        return result;
      });
    }
    event('geometry-created', { cache: cacheSnapshot(cacheView(g.cache)), feedbackSlots: 3 });
  }
  function trackEncoder(encoder: GPUCommandEncoder) {
    check(liveEncoderHooks < ORIGINAL_TERRAIN_OBSERVER_LIMITS.maxLiveEncoderHooks
      && encoderCallbacks < ORIGINAL_TERRAIN_OBSERVER_LIMITS.maxEncoderCallbacks, 'Encoder observation cap exceeded');
    liveEncoderHooks++; encoderCallbacks++;
    const restore = patch(encoder, 'finish', native => function (this: GPUCommandEncoder, ...args: unknown[]) {
      let result: GPUCommandBuffer;
      try { result = Reflect.apply(native, this, args); }
      catch (cause) { if (encoderTickets.has(this)) fail(cause); throw cause; }
      finally { restore(); liveEncoderHooks--; }
      safely(() => {
        const t = encoderTickets.get(this); if (!t) return;
        check(!t.commandBuffer, 'Encoder finished twice');
        const raster = mirror('transforms'); check(raster.version > t.transformsVersion, 'Current raster transforms not written after prepare');
        const a = new Uint8Array(t.prepared.selectionCamera.buffer), b = raster.bytes;
        check(a.slice(0, 64).every((v, i) => v === b[i]) && a.slice(64, 128).every((v, i) => v === b[128 + i]), 'Raster/selection camera bytes differ');
        t.transforms = raster.bytes.slice(); t.commandBuffer = result; commandTickets.set(result, t);
        event('encoder-finished', { ticket: t.prepared.ticket, transforms: t.transforms });
      }); return result;
    });
  }
  const observer = {
    get errors() { return [...errors]; },
    get summary() { return { active, failed, eventCount: eventId, emittedCopyBytes, preparedTickets: ticketId,
      queueSubmissions, frameSubmissions, nativeFrameCallbacks, feedbackCount, diagnosticSubmissions, pendingTicket: pending?.prepared.ticket ?? null,
      pendingFeedback: slotTickets.size, retainedFeedback: feedback.size,
      liveEncoderHooks, encoderCallbacks,
      sourceQualification: 'Supplied frozen-module admission plus live native layout/identity checks; no independent loaded-byte proof here.' }; },
    resource(name: ResourceName) { return resources.get(name); },
    feedbackFor(frameId: number) { const value = feedback.get(frameId); check(value, 'Requested native feedback is not retained'); return structuredClone(value); },
    assertHealthy() { check(active && !failed, `Terrain observer failed: ${errors.join('; ')}`); },
    assertComplete(expectedFrames: number) {
      observer.assertHealthy(); integer(expectedFrames); check(expectedFrames > 0, 'Expected frame count required');
      check(ticketId === expectedFrames && frameSubmissions === expectedFrames && nativeFrameCallbacks === expectedFrames
        && feedbackCount === expectedFrames && !pending && slotTickets.size === 0, 'Missing native preparation/submission/feedback receipts');
      return observer.summary;
    },
    detach() {
      if (!active) return; active = false;
      for (const restore of [...restorers].reverse()) try { restore(); } catch (cause) { fail(cause); }
      restorers.clear(); resources.clear(); mirrors.clear(); feedback.clear(); slotTickets.clear(); pending = undefined;
      liveEncoderHooks = 0;
      if (currentObserver === observer) currentObserver = undefined;
    },
  };
  currentObserver = observer;
  try {
    patch(device, 'createBuffer', native => function (this: GPUDevice, ...args: Parameters<GPUDevice['createBuffer']>) {
      const result = Reflect.apply(native, this, args) as GPUBuffer;
      safely(() => {
        const name = (Object.keys(labels) as ResourceName[]).find(k => labels[k] === args[0].label); if (!name) return;
        check(this === device && !resources.has(name), 'Duplicate/wrong native buffer');
        const expected = { residency: 4796, camera: 160, transforms: 352, selections: 2048, arguments: 64, pool: result.size }[name];
        check(result.size === expected && args[0].size === expected && result.label === labels[name], `Wrong ${name} layout`);
        const usage = { residency: 0x88, camera: 0x48, transforms: 0x48, selections: 0x8c, arguments: 0x18c, pool: 0x88 }[name];
        check(args[0].usage === usage && result.usage === usage && args[0].mappedAtCreation !== true, `Wrong ${name} usage`);
        if (name === 'pool') check(result.size === 8388608 || result.size === 1199 * 65536, 'Wrong pool size');
        resources.set(name, result);
        if (['residency', 'camera', 'transforms'].includes(name)) mirrors.set(result, { bytes: new Uint8Array(expected), initialized: new Uint8Array(expected), version: 0 });
      }); return result;
    });
    patch(device.queue, 'writeBuffer', native => function (this: GPUQueue, ...args: Parameters<GPUQueue['writeBuffer']>) {
      let copied: Uint8Array | undefined; const tracked = mirrors.get(args[0]);
      safely(() => { if (tracked) {
        check(this === device.queue, 'Wrong native queue'); copied = terrainWrittenBytes(args[2], args[3], args[4]);
        integer(args[1]); check(args[1] % 4 === 0 && copied.byteLength % 4 === 0 && args[1] + copied.byteLength <= tracked.bytes.length, 'Invalid tracked write range');
      } });
      let result; try { result = Reflect.apply(native, this, args); } catch (cause) { if (tracked || pending || prepareDepth) fail(cause); throw cause; }
      safely(() => { if (tracked && copied) { tracked.bytes.set(copied, args[1]); tracked.initialized.fill(1, args[1], args[1] + copied.length); tracked.version++; } });
      return result;
    });
    patch(device, 'createCommandEncoder', native => function (this: GPUDevice, ...args: Parameters<GPUDevice['createCommandEncoder']>) {
      const result = Reflect.apply(native, this, args); safely(() => { check(this === device, 'Wrong encoder device'); trackEncoder(result); }); return result;
    });
    patch(device.queue, 'submit', native => function (this: GPUQueue, ...args: Parameters<GPUQueue['submit']>) {
      let tickets: Ticket[] = [];
      safely(() => {
        check(this === device.queue && Array.isArray(args[0]) && args[0].length <= 16, 'Expected bounded native command-buffer array');
        // Do not enumerate arbitrary iterables or replace the caller's array.
        tickets = args[0].flatMap(b => { const t = commandTickets.get(b); return t ? [t] : []; });
        check(tickets.length <= 1 && tickets.every(t => !t.submitted && t === pending), 'Duplicate/stale frame command buffer');
      });
      let result; try { result = Reflect.apply(native, this, args); } catch (cause) { fail(cause); throw cause; }
      safely(() => {
        queueSubmissions++; if (tickets.length) { tickets[0]!.submitted = true; frameSubmissions++; } else diagnosticSubmissions++;
        event('queue-submit', { queueSubmission: queueSubmissions, tickets: tickets.map(t => t.prepared.ticket), kind: tickets.length ? 'frame' : 'diagnostic' });
      }); return result;
    });
    for (const method of ['update', 'setDemand', 'replan'] as const) patch(GeometryPageCache.prototype, method, native => function (this: GeometryPageCache, ...args: unknown[]) {
      const owned = cacheView(this).device === device;
      if (owned) safely(() => bindCache(this));
      let result; try { result = Reflect.apply(native, this, args); } catch (cause) { if (owned) fail(cause); throw cause; }
      if (owned) safely(() => event(`cache-${method}`, { state: cacheSnapshot(cacheView(this)),
        ...(method === 'update' ? { result } : {}) }));
      return result;
    });
    patch(GpuGeometry, 'create', native => function (this: typeof GpuGeometry, ...args: Parameters<typeof GpuGeometry.create>) {
      const owned = args[0] === device;
      if (owned) safely(() => manifestGuard(args[1]));
      const promise = Reflect.apply(native, this, args) as Promise<GpuGeometry>;
      if (owned) void promise.then(value => { if (active) safely(() => bindGeometry(value)); }, cause => { if (active) fail(cause); });
      return promise; // Original promise identity and settlement are unchanged.
    });
    patch(GpuGeometry.prototype, 'prepare', native => function (this: GpuGeometry, ...args: Parameters<GpuGeometry['prepare']>) {
      const owned = geometryView(this).device === device;
      if (owned) { prepareDepth++; safely(() => { bindGeometry(this); check(!pending, 'Unconsumed prior frame ticket'); }); }
      let result;
      try { result = Reflect.apply(native, this, args); } catch (cause) { if (owned) fail(cause); throw cause; }
      finally { if (owned) prepareDepth--; }
      if (owned) safely(() => {
        const g = geometryView(this), r = mirror('residency'), c = mirror('camera');
        check(g.recording && g.recording.busy && !g.recording.pending, 'Missing available native feedback slot');
        check(slotTickets.size < 3 && !slotTickets.has(g.recording.buffer), 'Feedback slot still belongs to an earlier frame');
        const prepared: Preparation = { ticket: ++ticketId, generation: cacheView(g.cache).epoch,
          residency: new Uint32Array(r.bytes.slice().buffer), selectionCamera: c.bytes.slice(),
          width: args[2], height: args[3], reset: args[4], cache: cacheSnapshot(cacheView(g.cache)) };
        check((args[2] === 1280 && args[3] === 720) || (args[2] === 1920 && args[3] === 1080), 'Original diagnostic dimensions required');
        check(prepared.residency.every((v, i) => v === (cacheView(g.cache).mapping[i]! >>> 0)), 'Successful residency writes differ from actual prepared cache');
        const f = new Float32Array(prepared.selectionCamera.buffer);
        check(f[34] === args[2] && f[35] === args[3], 'Observed camera dimensions differ');
        check(!encoderTickets.has(args[0]), 'Multiple prepares in one encoder');
        pending = { prepared, encoder: args[0], slot: g.recording, transformsVersion: resources.get('transforms') ? mirrors.get(resources.get('transforms')!)!.version : 0, submitted: false };
        encoderTickets.set(args[0], pending); event('prepared', prepared);
      }); return result;
    });
    patch(GpuGeometry.prototype, 'submitted', native => function (this: GpuGeometry, ...args: Parameters<GpuGeometry['submitted']>) {
      const owned = geometryView(this).device === device;
      if (owned) safely(() => {
        integer(args[0]); check(lastFrameId === undefined || args[0] === lastFrameId + 1, 'Native frame IDs are not consecutive');
        check(pending && pending.submitted && pending.commandBuffer && pending.transforms
          && pending.slot === geometryView(this).recording, 'submitted() has no successful native frame submission');
        pending.frameId = args[0]; slotTickets.set(pending.slot.buffer, pending); lastFrameId = args[0];
        nativeFrameCallbacks++;
        event('submitted', { ticket: pending.prepared.ticket, frameId: args[0], generation: pending.prepared.generation }); pending = undefined;
      });
      let result; try { result = Reflect.apply(native, this, args); } catch (cause) { if (owned) fail(cause); throw cause; } return result;
    });
    patch(GpuGeometry.prototype, 'cancelFrame', native => function (this: GpuGeometry, ...args: unknown[]) {
      const result = Reflect.apply(native, this, args);
      if (geometryView(this).device === device && !prepareDepth && pending) fail('Prepared frame cancelled; case cannot retry');
      return result;
    });
  } catch (cause) { observer.detach(); throw cause; }
  return observer;
}
