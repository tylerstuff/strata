import { describe, expect, it, vi } from 'vitest';
import { RegionInitializationCoordinator } from '../../packages/core/src/geometry/region-initialization.js';
import { GeometryTransferBudget } from '../../packages/core/src/geometry/transfer-budget.js';
import { geometryDevice } from './geometry-fixture.js';

type Descriptor = Parameters<RegionInitializationCoordinator['replaceDesired']>[1][number];
type Limits = ConstructorParameters<typeof RegionInitializationCoordinator>[2];
type RuntimeOptions = NonNullable<ConstructorParameters<typeof RegionInitializationCoordinator>[3]>;
const pageBytes = 65_536;
const settle = async () => { for (let count = 0; count < 12; count++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function sharedBudget() {
  return new GeometryTransferBudget({ maxRequests: 1, pageStagingBytes: pageBytes, transientBytes: 1_048_576,
    residentBytes: 1_048_576, gpuBufferBytes: 1_048_576, uploadBytesPerFrame: pageBytes });
}
function descriptor(id = 'region-a') {
  return { id, manifestUrl: new URL(`https://geometry.test/${id}/manifest.json`), manifestBytes: 256,
    manifestSha256: 'a'.repeat(64), bounds: { min: [-8, -2, -8] as [number, number, number], max: [8, 2, 8] as [number, number, number] },
    options: { poolBytes: 2 * pageBytes, pixelError: 2, cameraMode: 'tour' as const, residencyPolicy: 'greedy' as const } };
}
function fixture(overrides: Partial<Limits> = {}, runtime: RuntimeOptions = {}) {
  const gpu = geometryDevice(); const budget = sharedBudget(); const response = deferred<Response>();
  const fetch = vi.fn<typeof globalThis.fetch>(() => response.promise);
  const limits: Limits = { maxDesiredRegions: 4, maxLiveRegions: 2, maxManifestBytes: pageBytes,
    maxRetainedManifestBytes: 2 * pageBytes, ...overrides };
  const coordinator = new RegionInitializationCoordinator(gpu.device, budget, limits, { fetch, ...runtime });
  return { gpu, budget, response, fetch, limits, coordinator };
}
async function dispose(state: ReturnType<typeof fixture>) {
  state.coordinator.dispose(); state.response.resolve(new Response('{}'));
  await state.coordinator.whenDisposedAndSettled();
}
function replaceUnknown(coordinator: RegionInitializationCoordinator, revision: unknown, descriptors: unknown) {
  return coordinator.replaceDesired(revision as number, descriptors as readonly Descriptor[]);
}

describe('region coordinator atomic descriptor validation', () => {
  it('queues a cloned and normalized descriptor without allocating or fetching', async () => {
    const state = fixture(); const value = descriptor();
    const input = { ...value, options: { poolBytes: value.options.poolBytes } };
    state.coordinator.replaceDesired(1, [input]);
    expect(state.fetch).not.toHaveBeenCalled(); expect(state.gpu.raw.createBuffer).not.toHaveBeenCalled();
    expect(state.coordinator.snapshot()).toMatchObject({ desiredRevision: 1, liveEntries: 0, retainedManifestBytes: 0,
      regions: [{ id: value.id, status: 'queued', manifestUrl: value.manifestUrl.href,
        options: { poolBytes: 2 * pageBytes, pixelError: 2, cameraMode: 'tour', residencyPolicy: 'greedy' } }] });
    const previous = state.coordinator.snapshot();
    input.manifestUrl.pathname = '/mutated.json'; input.options.poolBytes = 3 * pageBytes;
    input.bounds.min[0] = -123; input.bounds.max[1] = 456;
    expect(state.coordinator.snapshot()).toEqual(previous);
    await dispose(state);
  });

  it('rejects an invalid whole replacement before changing the valid desired set or its revision', async () => {
    const state = fixture(); const a = descriptor(); state.coordinator.replaceDesired(1, [a]);
    const before = state.coordinator.snapshot(); const beforeBudget = state.budget.telemetry;
    expect(() => replaceUnknown(state.coordinator, 2, [descriptor('region-b'), { ...descriptor('region-c'), options: { poolBytes: 1 } }])).toThrow();
    expect(state.coordinator.snapshot()).toEqual(before); expect(state.budget.telemetry).toEqual(beforeBudget);
    expect(state.fetch).not.toHaveBeenCalled();
    state.coordinator.replaceDesired(2, [descriptor('region-b')]);
    expect(state.coordinator.snapshot().desiredRevision).toBe(2);
    await dispose(state);
  });

  it('does not abort or retire an admitted manifest when a later replacement descriptor is invalid', async () => {
    const state = fixture(); state.coordinator.replaceDesired(1, [descriptor()]);
    state.coordinator.advance(state.budget.beginFrame(0)); await settle();
    expect(state.fetch).toHaveBeenCalledTimes(1);
    const signal = state.fetch.mock.calls[0]![1]!.signal!;
    const before = state.coordinator.snapshot(); const beforeBudget = state.budget.telemetry;
    expect(() => replaceUnknown(state.coordinator, 2, [descriptor('region-b'), { ...descriptor('region-c'), bounds: null }])).toThrow();
    expect(signal.aborted).toBe(false); expect(state.coordinator.snapshot()).toEqual(before);
    expect(state.budget.telemetry).toEqual(beforeBudget); await dispose(state);
  });

  it('rejects a sparse replacement before mutating an active reused record, bounds or counters', async () => {
    const state = fixture(); state.coordinator.replaceDesired(1, [descriptor()]);
    state.coordinator.advance(state.budget.beginFrame(0)); await settle();
    expect(state.fetch).toHaveBeenCalledTimes(1);
    const signal = state.fetch.mock.calls[0]![1]!.signal!;
    const before = state.coordinator.snapshot(); const beforeBudget = state.budget.telemetry;
    const changed = descriptor(); changed.bounds.min[0] = -99;
    const sparse = new Array<Descriptor>(2); sparse[0] = changed;
    expect(() => state.coordinator.replaceDesired(2, sparse)).toThrow(/Region descriptor/);
    expect(state.coordinator.snapshot()).toEqual(before); expect(state.budget.telemetry).toEqual(beforeBudget);
    expect(signal.aborted).toBe(false); expect(state.fetch).toHaveBeenCalledTimes(1);
    state.coordinator.replaceDesired(2, [changed]);
    expect(state.coordinator.snapshot()).toMatchObject({ desiredRevision: 2, reusedEntries: before.reusedEntries + 1,
      regions: [{ incarnation: before.regions[0]!.incarnation, bounds: changed.bounds }] });
    expect(signal.aborted).toBe(false); await dispose(state);
  });

  it.each(['min', 'max'] as const)('rejects sparse %s bounds atomically', async axis => {
    const state = fixture(); state.coordinator.replaceDesired(1, [descriptor()]);
    const before = state.coordinator.snapshot(); const beforeBudget = state.budget.telemetry;
    const value = descriptor('region-b'); const sparse = new Array<number>(3);
    sparse[0] = value.bounds[axis][0]; sparse[2] = value.bounds[axis][2];
    const invalid = { ...value, bounds: { ...value.bounds, [axis]: sparse } };
    expect(() => replaceUnknown(state.coordinator, 2, [invalid])).toThrow(/three finite ordered coordinates/);
    expect(state.coordinator.snapshot()).toEqual(before); expect(state.budget.telemetry).toEqual(beforeBudget);
    expect(state.fetch).not.toHaveBeenCalled(); await dispose(state);
  });

  it('reads only bounded numeric slots without invoking custom desired or bounds iterators', async () => {
    const state = fixture({ maxDesiredRegions: 1, maxLiveRegions: 1 }); const value = descriptor();
    const iterator = vi.fn(() => { throw new Error('Caller-supplied iterator must not run.'); });
    const desired = [value];
    for (const input of [desired, value.bounds.min, value.bounds.max]) {
      Object.defineProperty(input, Symbol.iterator, { value: iterator });
    }
    state.coordinator.replaceDesired(1, desired);
    expect(iterator).not.toHaveBeenCalled();
    expect(state.coordinator.snapshot()).toMatchObject({ desiredRevision: 1, liveEntries: 0,
      regions: [{ id: value.id, status: 'queued', bounds: { min: [-8, -2, -8], max: [8, 2, 8] } }] });
    expect(state.coordinator.snapshot().regions).toHaveLength(1);
    expect(state.fetch).not.toHaveBeenCalled(); await dispose(state);
  });

  it.each([
    ['empty id', (value: ReturnType<typeof descriptor>) => ({ ...value, id: '' })],
    ['oversized id', (value: ReturnType<typeof descriptor>) => ({ ...value, id: 'r'.repeat(129) })],
    ['oversized URL', (value: ReturnType<typeof descriptor>) => ({ ...value, manifestUrl: new URL(`https://geometry.test/${'a'.repeat(2048)}`) })],
    ['URL credentials', (value: ReturnType<typeof descriptor>) => ({ ...value, manifestUrl: new URL('https://user:pass@geometry.test/manifest.json') })],
    ['non-HTTP URL', (value: ReturnType<typeof descriptor>) => ({ ...value, manifestUrl: new URL('file:///tmp/manifest.json') })],
    ['URL string', (value: ReturnType<typeof descriptor>) => ({ ...value, manifestUrl: value.manifestUrl.href })],
    ['missing URL', (value: ReturnType<typeof descriptor>) => ({ ...value, manifestUrl: null })],
    ['bad hash', (value: ReturnType<typeof descriptor>) => ({ ...value, manifestSha256: 'x'.repeat(64) })],
    ['unsafe byte length', (value: ReturnType<typeof descriptor>) => ({ ...value, manifestBytes: Number.MAX_SAFE_INTEGER + 1 })],
    ['zero byte length', (value: ReturnType<typeof descriptor>) => ({ ...value, manifestBytes: 0 })],
    ['fractional byte length', (value: ReturnType<typeof descriptor>) => ({ ...value, manifestBytes: 1.5 })],
    ['unknown descriptor field', (value: ReturnType<typeof descriptor>) => ({ ...value, transform: {} })],
    ['null bounds', (value: ReturnType<typeof descriptor>) => ({ ...value, bounds: null })],
    ['short bounds', (value: ReturnType<typeof descriptor>) => ({ ...value, bounds: { min: [0, 0], max: [1, 1, 1] } })],
    ['long bounds', (value: ReturnType<typeof descriptor>) => ({ ...value, bounds: { min: [0, 0, 0, 0], max: [1, 1, 1] } })],
    ['inverted bounds', (value: ReturnType<typeof descriptor>) => ({ ...value, bounds: { min: [2, 0, 0], max: [1, 1, 1] } })],
    ['nonfinite bounds', (value: ReturnType<typeof descriptor>) => ({ ...value, bounds: { min: [NaN, 0, 0], max: [1, 1, 1] } })],
    ['unsafe bounds', (value: ReturnType<typeof descriptor>) => ({ ...value, bounds: { min: [0, 0, 0], max: [Number.MAX_SAFE_INTEGER + 1, 1, 1] } })],
    ['unknown bounds field', (value: ReturnType<typeof descriptor>) => ({ ...value, bounds: { ...value.bounds, origin: [0, 0, 0] } })],
    ['null options', (value: ReturnType<typeof descriptor>) => ({ ...value, options: null })],
  ] as const)('rejects %s atomically', async (_name, invalid) => {
    const state = fixture(); state.coordinator.replaceDesired(1, [descriptor()]); const before = state.coordinator.snapshot();
    expect(() => replaceUnknown(state.coordinator, 2, [invalid(descriptor('region-b'))])).toThrow();
    expect(state.coordinator.snapshot()).toEqual(before); expect(state.fetch).not.toHaveBeenCalled();
    await dispose(state);
  });

  it.each([
    {}, { poolBytes: null }, { poolBytes: 0 }, { poolBytes: pageBytes - 1 }, { poolBytes: pageBytes + 1 },
    { poolBytes: pageBytes, pixelError: 0 }, { poolBytes: pageBytes, pixelError: 1001 }, { poolBytes: pageBytes, pixelError: NaN },
    { poolBytes: pageBytes, pixelError: null }, { poolBytes: pageBytes, cameraMode: null }, { poolBytes: pageBytes, cameraMode: 'orbit' },
    { poolBytes: pageBytes, residencyPolicy: null }, { poolBytes: pageBytes, residencyPolicy: 'lru' },
    { poolBytes: pageBytes, renderer: 'virtual' }, { poolBytes: pageBytes, geometryMode: 'resident-full' },
    { poolBytes: pageBytes, fetch: () => undefined }, { poolBytes: pageBytes, signal: new AbortController().signal },
    { poolBytes: pageBytes, uploadBudgetBytes: pageBytes }, { poolBytes: pageBytes, transform: {} },
  ])('rejects unsupported or invalid initialization options %#', async options => {
    const state = fixture(); const before = state.coordinator.snapshot();
    expect(() => replaceUnknown(state.coordinator, 1, [{ ...descriptor(), options }])).toThrow();
    expect(state.coordinator.snapshot()).toEqual(before); expect(state.fetch).not.toHaveBeenCalled();
    await dispose(state);
  });

  it('accepts boundary values without admitting them before advance', async () => {
    const state = fixture(); const value = descriptor('r'.repeat(128));
    state.coordinator.replaceDesired(1, [{ ...value,
      bounds: { min: [-Number.MAX_SAFE_INTEGER, 0, 0], max: [Number.MAX_SAFE_INTEGER, 0, 0] },
      options: { poolBytes: pageBytes, pixelError: 1000, cameraMode: 'coverage', residencyPolicy: 'retain-fallback' } }]);
    expect(state.coordinator.snapshot().regions[0]).toMatchObject({ id: value.id, status: 'queued',
      options: { poolBytes: pageBytes, pixelError: 1000, cameraMode: 'coverage', residencyPolicy: 'retain-fallback' } });
    expect(state.fetch).not.toHaveBeenCalled(); await dispose(state);
  });

  it('rejects duplicate IDs, excess desired entries and non-array inputs without partial replacement', async () => {
    const state = fixture({ maxDesiredRegions: 2 }); state.coordinator.replaceDesired(1, [descriptor()]); const before = state.coordinator.snapshot();
    for (const input of [[descriptor('b'), descriptor('b')], [descriptor('a'), descriptor('b'), descriptor('c')], null, {}]) {
      expect(() => replaceUnknown(state.coordinator, 2, input)).toThrow(); expect(state.coordinator.snapshot()).toEqual(before);
    }
    expect(state.fetch).not.toHaveBeenCalled(); await dispose(state);
  });

  it('requires safe, positive and strictly increasing desired revisions while permitting skipped revisions', async () => {
    const state = fixture();
    for (const revision of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
      const before = state.coordinator.snapshot();
      expect(() => replaceUnknown(state.coordinator, revision, [descriptor()])).toThrow(); expect(state.coordinator.snapshot()).toEqual(before);
    }
    state.coordinator.replaceDesired(1, [descriptor()]); const before = state.coordinator.snapshot();
    expect(() => state.coordinator.replaceDesired(1, [])).toThrow(); expect(state.coordinator.snapshot()).toEqual(before);
    state.coordinator.replaceDesired(Number.MAX_SAFE_INTEGER, []);
    expect(state.coordinator.snapshot().desiredRevision).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => state.coordinator.replaceDesired(2, [])).toThrow(); await dispose(state);
  });
});

describe('region coordinator configuration and admission validation', () => {
  it.each([
    { maxDesiredRegions: 0 }, { maxDesiredRegions: 65 }, { maxDesiredRegions: 1.5 }, { maxLiveRegions: 0 },
    { maxLiveRegions: 65 }, { maxLiveRegions: 5 }, { maxManifestBytes: 0 }, { maxManifestBytes: 2 ** 31 },
    { maxRetainedManifestBytes: 0 }, { maxRetainedManifestBytes: Number.MAX_SAFE_INTEGER + 1 }, { extra: true },
  ])('rejects invalid or unsupported configured limits %#', overrides => {
    const gpu = geometryDevice(); const budget = sharedBudget();
    expect(() => new RegionInitializationCoordinator(gpu.device, budget, { maxDesiredRegions: 4, maxLiveRegions: 2,
      maxManifestBytes: pageBytes, maxRetainedManifestBytes: pageBytes, ...overrides } as Limits)).toThrow();
    expect(gpu.raw.createBuffer).not.toHaveBeenCalled();
  });

  it.each([null, { extra: true }, { fetch: null }, { requestTimeoutMs: 0 }, { requestTimeoutMs: 120_001 }])('rejects invalid runtime options %#', options => {
    const gpu = geometryDevice();
    expect(() => new RegionInitializationCoordinator(gpu.device, sharedBudget(), { maxDesiredRegions: 4, maxLiveRegions: 2,
      maxManifestBytes: pageBytes, maxRetainedManifestBytes: pageBytes }, options as RuntimeOptions)).toThrow();
    expect(gpu.raw.createBuffer).not.toHaveBeenCalled();
  });

  it.each([
    { reason: 'individual manifest cap', limits: { maxManifestBytes: 128 }, manifestBytes: 129 },
    { reason: 'configured retained-content cap', limits: { maxRetainedManifestBytes: 128 }, manifestBytes: 129 },
    { reason: 'configured shared staging cap', limits: { maxManifestBytes: 2 * pageBytes, maxRetainedManifestBytes: 2 * pageBytes }, manifestBytes: pageBytes + 1 },
  ])('rejects an individually impossible $reason without waiting or fetching', async ({ limits, manifestBytes }) => {
    const state = fixture(limits); const before = state.coordinator.snapshot();
    expect(() => replaceUnknown(state.coordinator, 1, [{ ...descriptor(), manifestBytes }])).toThrow();
    expect(state.coordinator.snapshot()).toEqual(before); expect(state.fetch).not.toHaveBeenCalled();
    expect(state.budget.telemetry).toMatchObject({ requests: 0, pageStagingBytes: 0 }); await dispose(state);
  });

  it('keeps an individually feasible source pending under temporary shared pressure, then admits after release', async () => {
    const state = fixture(); const blocker = state.budget.tryRequest(pageBytes)!;
    state.coordinator.replaceDesired(1, [descriptor()]);
    expect(state.coordinator.advance(state.budget.beginFrame(0)).uploadBytes).toBe(0);
    expect(state.fetch).not.toHaveBeenCalled(); expect(state.coordinator.snapshot().regions[0]!.error).toBeUndefined();
    blocker.release(); state.coordinator.advance(state.budget.beginFrame(1)); await settle();
    expect(state.fetch).toHaveBeenCalledTimes(1); expect(state.coordinator.snapshot().regions[0]!.error).toBeUndefined();
    await dispose(state); expect(state.budget.telemetry).toMatchObject({ requests: 0, pageStagingBytes: 0 });
  });

  it.each(['foreign', 'expired'] as const)('rejects a %s frame before state changes, allocation or fetch', async kind => {
    const state = fixture(); state.coordinator.replaceDesired(1, [descriptor()]);
    const frame = (kind === 'foreign' ? sharedBudget() : state.budget).beginFrame(0);
    if (kind === 'expired') state.budget.beginFrame(1);
    const before = state.coordinator.snapshot(); const beforeBudget = state.budget.telemetry;
    expect(() => state.coordinator.advance(frame)).toThrow();
    expect(state.coordinator.snapshot()).toEqual(before); expect(state.budget.telemetry).toEqual(beforeBudget);
    expect(state.fetch).not.toHaveBeenCalled(); expect(state.gpu.raw.createBuffer).not.toHaveBeenCalled();
    await dispose(state);
  });

  it('prevents future admission after idempotent disposal', async () => {
    const state = fixture(); state.coordinator.replaceDesired(1, [descriptor()]);
    state.coordinator.dispose(); state.coordinator.dispose(); await state.coordinator.whenDisposedAndSettled();
    expect(state.coordinator.snapshot()).toMatchObject({ disposed: true, liveEntries: 0, retiringEntries: 0, retainedManifestBytes: 0 });
    expect(() => state.coordinator.replaceDesired(2, [descriptor('b')])).toThrow();
    const before = state.coordinator.snapshot();
    expect(state.coordinator.advance(state.budget.beginFrame(0))).toEqual({ uploadBytes: 0, advancedIncarnations: [] });
    expect(state.coordinator.snapshot()).toEqual(before);
    expect(state.fetch).not.toHaveBeenCalled(); expect(state.gpu.raw.createBuffer).not.toHaveBeenCalled();
  });

  it('resolves terminal change waits while keeping settlement and retained metadata pending through original fetch cleanup', async () => {
    const state = fixture(); const value = descriptor(); state.coordinator.replaceDesired(1, [value]);
    state.coordinator.advance(state.budget.beginFrame(0)); await settle(); expect(state.fetch).toHaveBeenCalledTimes(1);
    const originalSignal = state.fetch.mock.calls[0]![1]!.signal!;
    let settled = false; const completion = state.coordinator.whenDisposedAndSettled().then(() => { settled = true; });
    await settle(); expect(settled).toBe(false);
    state.coordinator.dispose(); expect(originalSignal.aborted).toBe(true);
    await state.coordinator.waitForChange(state.coordinator.snapshot().revision); await settle();
    expect(settled).toBe(false); expect(state.coordinator.snapshot()).toMatchObject({ disposed: true, liveEntries: 1,
      retiringEntries: 1, retainedManifestBytes: value.manifestBytes });
    state.response.resolve(new Response('{}')); await completion;
    expect(state.coordinator.snapshot()).toMatchObject({ liveEntries: 0, retiringEntries: 0, retainedManifestBytes: 0, settledEntries: 1 });
    expect(state.budget.telemetry).toMatchObject({ requests: 0, pageStagingBytes: 0 });
    expect(state.gpu.raw.createBuffer).not.toHaveBeenCalled();
  });

  it('caps retained failure text instead of storing the unbounded error object', async () => {
    const failure = new Error('x'.repeat(4096));
    const state = fixture({}, { fetch: vi.fn<typeof globalThis.fetch>(async () => { throw failure; }) });
    state.coordinator.replaceDesired(1, [descriptor()]); state.coordinator.advance(state.budget.beginFrame(0));
    await vi.waitFor(() => expect(state.coordinator.snapshot().regions[0]!.status).toBe('failed'));
    expect(state.coordinator.snapshot().regions[0]!.error).toBe('x'.repeat(512));
    await dispose(state);
  });
});
