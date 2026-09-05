import { describe, expect, it } from 'vitest';
import { injectTraceGiPhaseClock, serializeTraceGiPhaseCamera, traceGiPhasePlan, validateTraceGiPhasePlan } from '../browser/trace-gi-phase-validation.js';
import { createRasterCamera } from '../../packages/core/src/rendering/raster-math.js';

type Bag = Record<string, unknown>;

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(assertDeepFrozen);
}

function fixture() {
  const probeCache = { pending: undefined, disposed: false, epoch: 1, frontier: 32, lastFrameIndex: 0,
    sourceFrameId: 1, submittedFrames: 1, seed: 1337, history: new Uint32Array([1, 0, 1, 0]), bindings: {} };
  const reflectionCache = { pending: undefined, disposed: false, epoch: 1, frontier: 32768, frameIndex: 0,
    sourceFrameId: 1, submittedFrames: 1, history: new Uint32Array([0, 1, 0, 1]), bindings: {} };
  const effect = { frames: 1, pendingProbes: undefined, pendingTraceUpdateCount: undefined, disposed: false,
    probeCache, reflectionCache, revision: 2, diffuseInvalidationRevision: 2, resetPending: false,
    lastSubmittedTraceFrameId: 1, lastSubmittedUpdateCount: 0, traceBuffers: [{ id: 'borrowed-source-buffer' }],
    scene: { doorOpen: false, lightIntensity: 1, objectOffset: -.4 }, signedZero: -0 };
  const renderer = { effect, raster: { jitterIndex: 1, historyReady: true }, sourceFrameId: 1 };
  return { renderer, effect, probeCache, reflectionCache };
}

function capture(f: ReturnType<typeof fixture>) {
  return {
    owners: [f.renderer, f.effect, f.probeCache, f.reflectionCache, f.renderer.raster],
    descriptors: [f.renderer, f.effect, f.probeCache, f.reflectionCache, f.renderer.raster].map(Object.getOwnPropertyDescriptors),
    probeBytes: Array.from(f.probeCache.history), reflectionBytes: Array.from(f.reflectionCache.history),
  };
}

function assertUnchanged(before: ReturnType<typeof capture>, f: ReturnType<typeof fixture>, expectedClock?: number): void {
  before.owners.forEach((owner, i) => {
    const after = Object.getOwnPropertyDescriptors(owner), prior = before.descriptors[i]!;
    expect(Reflect.ownKeys(after)).toEqual(Reflect.ownKeys(prior));
    for (const key of Reflect.ownKeys(prior)) {
      const old = Reflect.get(prior, key) as PropertyDescriptor;
      const now = Reflect.get(after, key) as PropertyDescriptor;
      expect(now.get).toBe(old.get); expect(now.set).toBe(old.set);
      expect(now.writable).toBe(old.writable); expect(now.enumerable).toBe(old.enumerable); expect(now.configurable).toBe(old.configurable);
      expect(Object.is(now.value, i === 1 && key === 'frames' && expectedClock !== undefined ? expectedClock : old.value)).toBe(true);
    }
  });
  expect(Array.from(f.probeCache.history)).toEqual(before.probeBytes);
  expect(Array.from(f.reflectionCache.history)).toEqual(before.reflectionBytes);
}

describe('frozen shared lighting phase diagnostic plan', () => {
  it('serializes an actual raster camera into independent ordinary arrays that survive JSON transport', () => {
    const source = createRasterCamera(1280, 720, 16, 16, [.125, -.25]);
    const snapshot = serializeTraceGiPhaseCamera(source), values = { view: [...source.view], viewProjection: [...source.viewProjection], eye: [...source.eye], far: source.far };
    expect(snapshot).toEqual(values);
    for (const key of ['view', 'viewProjection', 'eye'] as const) {
      expect(Array.isArray(snapshot[key])).toBe(true); expect(snapshot[key]).not.toBe(source[key]);
    }
    expect('projectionScaleY' in snapshot).toBe(false); expect('orthographic' in snapshot).toBe(false);
    const transported = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    // JSON metadata canonicalizes signed zero; archived native uniform bytes carry its exact representation.
    expect(transported.view).toEqual(values.view.map(v => v === 0 ? 0 : v));
    expect(transported.viewProjection).toEqual(values.viewProjection.map(v => v === 0 ? 0 : v));
    expect(transported.eye).toEqual(values.eye.map(v => v === 0 ? 0 : v)); expect(transported.far).toBe(values.far);
    expect(serializeTraceGiPhaseCamera({ ...source, projectionScaleY: .5, orthographic: false })).toMatchObject({ projectionScaleY: .5, orthographic: false });
    source.view.fill(42); source.viewProjection.fill(43); (source.eye as unknown as number[])[0] = 44;
    expect(snapshot).toEqual(values);
  });

  it('keeps the preregistered t16 geometry, lighting and 242/968 submission boundary', () => {
    expect(traceGiPhasePlan).toMatchObject({ correctnessOnly: true, performanceEligible: false,
      width: 1280, height: 720, format: 'bgra8unorm', cameraMode: 'tour', maxRunMs: 300000,
      geometry: { mode: 'resident-full', requestedPoolBytes: 8388608, actualPoolBytes: 5242880, pages: 80,
        pixelError: 2, maxConcurrentRequests: 4, uploadBudgetBytes: 262144 },
      lighting: { probesPerUpdate: 32, raysPerProbe: 64, probeSeed: 1337, resolutionScale: .25,
        roughness: .08, maxDistance: 16, updateEvery: 1, maxRaysPerFrame: 32768 },
      initialWorld: { doorOpen: false, wallColor: 'red', lightIntensity: 1, objectOffset: -.4, roughness: .08 },
      counts: { cells: 4, submissionsPerCell: 242, captureSubmissionsPerCell: 241, totalSubmissions: 968 },
    });
    expect(traceGiPhasePlan.precondition).toMatchObject({ time: 5, controls: { temporal: true, debugView: 'final', cameraCut: true, exposureEV: 0,
      gi: { enabled: true, resetCache: true }, reflections: { mode: 'world', resetHistory: true } } });
    expect(traceGiPhasePlan.reset).toMatchObject({ time: 16, controls: { temporal: true, debugView: 'final', cameraCut: true, exposureEV: 0,
      gi: { enabled: true, doorOpen: true, wallColor: 'red', lightIntensity: 0, resetCache: true },
      reflections: { mode: 'world', objectOffset: 0, roughness: .08, maxDistance: 16, updateEvery: 1, resetHistory: true } } });
    expect(traceGiPhasePlan.held).toEqual({ time: 16, controls: { temporal: true, debugView: 'final', exposureEV: 0 }, count: 240 });
    expect(traceGiPhasePlan.counts.submissionsPerCell).toBe(1 + 1 + traceGiPhasePlan.held.count);
    expect(traceGiPhasePlan.counts.totalSubmissions).toBe(4 * (1 + 1 + traceGiPhasePlan.held.count));
    // There are no repeated reset flags in the held controls, and no fabricated historical submission IDs.
    expect('gi' in traceGiPhasePlan.held.controls).toBe(false);
    expect('reflections' in traceGiPhasePlan.held.controls).toBe(false);
  });

  it('derives t16 sampling clocks from the archived pre-t0 index plus three preceding 241-frame captures', () => {
    expect(traceGiPhasePlan.phases).toEqual([
      { label: 5399, firstSampleIndex: 6123, lastSampleIndex: 6363 },
      { label: 5400, firstSampleIndex: 6124, lastSampleIndex: 6364 },
    ]);
    for (const phase of traceGiPhasePlan.phases) {
      expect(phase.firstSampleIndex).toBe(phase.label + 1 + 3 * (1 + 240));
      expect(phase.lastSampleIndex).toBe(phase.firstSampleIndex + 240);
      expect(phase.lastSampleIndex - phase.firstSampleIndex + 1).toBe(241);
    }
  });

  it('returns an independent deeply frozen exact snapshot without freezing or retaining caller objects', () => {
    const input = structuredClone(traceGiPhasePlan), snapshot = validateTraceGiPhasePlan(input);
    expect(snapshot).toEqual(traceGiPhasePlan); expect(snapshot).not.toBe(input);
    expect(snapshot.phases).not.toBe(input.phases); expect(snapshot.reset.controls.gi).not.toBe(input.reset.controls.gi);
    expect(Object.isFrozen(input)).toBe(false); assertDeepFrozen(traceGiPhasePlan); assertDeepFrozen(snapshot);
    input.phases[0]!.firstSampleIndex = 0; input.reset.controls.gi.lightIntensity = 1;
    expect(snapshot.phases[0]!.firstSampleIndex).toBe(6123); expect(snapshot.reset.controls.gi.lightIntensity).toBe(0);
    expect(() => { snapshot.phases[0]!.firstSampleIndex = 0; }).toThrow();
  });

  it('rejects every changed primitive, rather than accepting a plan with merely matching version or counts', () => {
    const leaves: string[][] = [];
    const visit = (value: unknown, path: string[]): void => {
      if (value !== null && typeof value === 'object') Object.entries(value).forEach(([key, child]) => visit(child, [...path, key]));
      else leaves.push(path);
    };
    visit(traceGiPhasePlan, []); expect(leaves.length).toBeGreaterThan(60);
    for (const path of leaves) {
      const copy = structuredClone(traceGiPhasePlan) as unknown as Bag;
      let owner = copy;
      for (const key of path.slice(0, -1)) owner = owner[key] as Bag;
      const key = path.at(-1)!, value = owner[key];
      owner[key] = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : `${String(value)}-changed`;
      expect(() => validateTraceGiPhasePlan(copy), path.join('.')).toThrow();
    }
  });

  it('rejects missing, extra, reordered, sparse, nonfinite and signed-zero input changes', () => {
    const variants: Array<(plan: Bag) => void> = [
      p => { delete p.initialWorld; },
      p => { (p.lighting as Bag).unknownSetting = false; },
      p => { p.phases = [...p.phases as unknown[]].reverse(); },
      p => { delete (p.phases as unknown[])[0]; },
      p => { (p.phases as unknown[]).length++; },
      p => { ((p.reset as Bag).controls as Bag).reflections = { ...((p.reset as Bag).controls as Bag).reflections as Bag, objectOffset: -0 }; },
      p => { (p.lighting as Bag).roughness = NaN; },
      p => { (p.geometry as Bag).actualPoolBytes = Infinity; },
    ];
    for (const mutate of variants) {
      const input = structuredClone(traceGiPhasePlan) as unknown as Bag; mutate(input);
      expect(() => validateTraceGiPhasePlan(input)).toThrow();
    }
    expect(() => validateTraceGiPhasePlan(Object.fromEntries(Object.entries(traceGiPhasePlan).reverse()))).toThrow();
    for (const input of [undefined, null, false, [], {}, { version: 1 }]) expect(() => validateTraceGiPhasePlan(input)).toThrow();
  });
});

describe('proof-only shared lighting clock injection', () => {
  it.each([6123, 6124])('changes only the existing frame value to %i, preserving descriptors, cache contents and submission IDs', phase => {
    const f = fixture();
    Object.defineProperty(f.effect, 'frames', { value: 1, writable: true, enumerable: false, configurable: false });
    const before = capture(f), result = injectTraceGiPhaseClock(f.renderer, phase);
    expect(result).toEqual({ path: 'IntegratedRenderer.effect.frames', previousValue: 1, value: phase,
      changedPropertyCount: 1, cachesUnchanged: true, historicalSubmissionIdsSynthesized: false });
    assertUnchanged(before, f, phase);
    expect(f.renderer.sourceFrameId).toBe(1); expect(f.probeCache.sourceFrameId).toBe(1);
    expect(f.reflectionCache.sourceFrameId).toBe(1); expect(f.renderer.raster.jitterIndex).toBe(1);
  });

  it('rejects a second injection even if a caller restores the numeric frame value to one', () => {
    const f = fixture(); injectTraceGiPhaseClock(f.renderer, 6123); f.effect.frames = 1;
    const before = capture(f);
    expect(() => injectTraceGiPhaseClock(f.renderer, 6124)).toThrow('already injected');
    assertUnchanged(before, f);
  });

  it('rejects invalid clocks before changing the effect or any cache state', () => {
    for (const phase of [-1, 0, 5399, 5400, 6122, 6123.5, 6125, NaN, Infinity]) {
      const f = fixture(), before = capture(f);
      expect(() => injectTraceGiPhaseClock(f.renderer, phase)).toThrow('Unfrozen'); assertUnchanged(before, f);
    }
  });

  it('requires the single completed precondition and a writable own data-property seam', () => {
    for (const value of [0, 2, '1', undefined, NaN]) {
      const f = fixture(); Object.defineProperty(f.effect, 'frames', { value, writable: true }); const before = capture(f);
      expect(() => injectTraceGiPhaseClock(f.renderer, 6123)).toThrow('precondition'); assertUnchanged(before, f);
    }
    for (const mode of ['readonly', 'accessor', 'inherited'] as const) {
      const f = fixture(); let accessorCalls = 0;
      if (mode === 'readonly') Object.defineProperty(f.effect, 'frames', { value: 1, writable: false });
      else if (mode === 'accessor') Object.defineProperty(f.effect, 'frames', { get() { accessorCalls++; return 1; } });
      else { delete (f.effect as Partial<typeof f.effect>).frames; Object.setPrototypeOf(f.effect, { frames: 1 }); }
      const before = capture(f); expect(() => injectTraceGiPhaseClock(f.renderer, 6123)).toThrow('precondition');
      assertUnchanged(before, f); expect(accessorCalls).toBe(0);
    }
  });

  it('rejects pending or disposed effect/cache states without touching any other state', () => {
    const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
      f => { (f.effect as Bag).pendingProbes = {}; },
      f => { (f.effect as Bag).pendingTraceUpdateCount = 0; },
      f => { f.effect.disposed = true; },
      f => { (f.probeCache as Bag).pending = {}; },
      f => { f.probeCache.disposed = true; },
      f => { (f.reflectionCache as Bag).pending = {}; },
      f => { f.reflectionCache.disposed = true; },
      f => { delete (f.probeCache as Partial<typeof f.probeCache>).disposed; },
      f => { (f.effect as Bag).reflectionCache = null; },
    ];
    for (const mutate of changes) {
      const f = fixture(); mutate(f); const before = capture(f);
      expect(() => injectTraceGiPhaseClock(f.renderer, 6123)).toThrow(); assertUnchanged(before, f);
    }
  });

  it('rejects missing, inherited or accessor effect properties without invoking an accessor', () => {
    const f = fixture(), before = capture(f); let calls = 0;
    const accessor = Object.defineProperty({}, 'effect', { get() { calls++; return f.effect; } });
    for (const renderer of [undefined, null, false, 1, {}, { effect: null }, Object.create({ effect: f.effect }), accessor]) {
      expect(() => injectTraceGiPhaseClock(renderer, 6123)).toThrow();
    }
    expect(calls).toBe(0); assertUnchanged(before, f);
  });
});
