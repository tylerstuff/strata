import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { advanceRendererProofModes, assertDisabledRendererCaches, assertProbeResetLifecycle, assertRendererProofModes,
  assertRendererSharpSample, createRendererProofPlan, rendererProofPlan, rendererSharpRay,
  runRendererPairValidation, validateRendererProofPlan } from '../browser/trace-update-renderer-validation.js';
import type { RendererProofKind } from '../browser/trace-update-renderer-validation.js';
import { GiTraceUpdater } from '../../packages/core/src/gi/trace-updates.js';
import { buildGiTraceData, traceGiBvh } from '../../packages/core/src/gi/trace-data.js';
import type { GiRay } from '../../packages/core/src/gi/trace-data.js';
import { createGiCamera, invertGiMatrix } from '../../packages/core/src/gi/room-geometry.js';
import { createGiScene } from '../../packages/core/src/gi/scene-data.js';
import { createReflectionScene } from '../../packages/core/src/reflections/reflection-scene.js';
import { createIntegratedScene } from '../../packages/core/src/integrated/integrated-scene.js';

describe('frozen renderer-pair proof schedule', () => {
  it('retains the complete reviewed serialized schedule and exact f64 motion bits without transcendental regeneration', () => {
    // Archived ed83499 steps.json renderer.steps; independent fixed digest, no external files needed in CI.
    expect(createHash('sha256').update(JSON.stringify(rendererProofPlan.steps)).digest('hex'))
      .toBe('58df81195fd1462697e73d0af006870321d8d892eaf22e4ad08d8b9d5027045f');
    const value = rendererProofPlan.steps.reflections.find(step => step.id === 'soft-motion-8')!.controls.reflections!.objectOffset!;
    const word = new DataView(new ArrayBuffer(8)); word.setFloat64(0, value);
    expect(word.getBigUint64(0)).toBe(0xbfd62b9586ad0a21n);
    const changed = structuredClone(rendererProofPlan); word.setBigUint64(0, 0xbfd62b9586ad0a20n);
    const oneUlp = word.getFloat64(0); expect(Math.fround(oneUlp)).toBe(Math.fround(value));
    changed.steps.reflections.find(step => step.id === 'soft-motion-8')!.controls.reflections!.objectOffset = oneUlp;
    expect(() => validateRendererProofPlan(changed)).toThrow('controls.reflections.objectOffset');
    // The known f64 discrepancy rounded to identical source records; that does not permit input mismatch.
    const source = (offset: number) => {
      const data = buildGiTraceData(createReflectionScene({ roughness: .08, objectOffset: offset }));
      const updater = new GiTraceUpdater(data); updater.dispose();
      return [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData].map(bytes => new Uint8Array(bytes));
    };
    expect(source(oneUlp)).toEqual(source(value));
  });

  it('validates both explicit scopes and takes an immutable owned snapshot before any await', () => {
    for (const mode of ['run', 'skip-unchanged-candidate-only'] as const) {
      const input = JSON.parse(JSON.stringify(createRendererProofPlan(mode)));
      const snapshot = validateRendererProofPlan(input);
      expect(snapshot).toEqual(input); expect(snapshot).not.toBe(input);
      input.steps.reflections[0].controls.temporal = true; input.streamedTimes[0] = 99;
      expect(snapshot.steps.reflections[0]!.controls.temporal).toBe(false); expect(snapshot.streamedTimes[0]).toBe(0);
      expect(Object.isFrozen(snapshot.steps.reflections[0]!.controls)).toBe(true);
      expect(() => { snapshot.streamedTimes[0] = 99; }).toThrow();
    }
    for (const value of [undefined, null, {}, { ...rendererProofPlan, streamedChurn: 'skip' }]) {
      expect(() => validateRendererProofPlan(value)).toThrow('churn mode');
    }
  });

  it('rejects every mutated primitive plus missing, additional, reordered and sparse plan input', () => {
    const paths: string[][] = [];
    const visit = (value: unknown, path: string[]) => {
      if (value !== null && typeof value === 'object') for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
      else paths.push(path);
    };
    visit(rendererProofPlan, []); expect(paths.length).toBeGreaterThan(2000);
    for (const path of paths) {
      const copy = structuredClone(rendererProofPlan);
      let parent = copy as unknown as Record<string, unknown>;
      for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
      const key = path.at(-1)!, value = parent[key];
      parent[key] = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : `${value}-mutated`;
      expect(() => validateRendererProofPlan(copy), path.join('.')).toThrow();
    }
    const variants = [
      (p: typeof rendererProofPlan) => { delete (p.steps.reflections[0] as { controls?: unknown }).controls; },
      (p: typeof rendererProofPlan) => { Object.assign(p.steps.reflections[0]!.controls, { unknownControl: false }); },
      (p: typeof rendererProofPlan) => { const list = p.steps.reflections as Array<typeof p.steps.reflections[0]>; [list[0], list[1]] = [list[1]!, list[0]!]; },
      (p: typeof rendererProofPlan) => { p.streamedTimes.length++; },
      (p: typeof rendererProofPlan) => { p.streamedTimes[0] = -0; },
      (p: typeof rendererProofPlan) => { p.settings.seed = NaN; },
      (p: typeof rendererProofPlan) => { p.limits.successfulFramesPerArm = Infinity; },
    ];
    for (const mutate of variants) { const copy = structuredClone(rendererProofPlan); mutate(copy); expect(() => validateRendererProofPlan(copy)).toThrow(); }
    expect(() => validateRendererProofPlan(Object.fromEntries(Object.entries(rendererProofPlan).reverse()))).toThrow('keys/order');
  });

  it('rejects a missing or mutated frozen plan before either renderer factory can execute', async () => {
    let calls = 0;
    const factory = async () => { calls++; throw Error('Renderer creation must not run'); };
    for (const input of [undefined, { ...rendererProofPlan, settings: { ...rendererProofPlan.settings, seed: 1 } }]) {
      await expect(runRendererPairValidation({} as GPUDevice, factory, factory, { manifestUrl: '', traceProxyUrl: '' }, input)).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });
  it('stays within explicit submission/checkpoint limits with one bounded failure and immutable input controls', () => {
    for (const kind of ['gi', 'reflections', 'integrated'] as const) {
      const steps = rendererProofPlan.steps[kind];
      const count = kind === 'gi' ? { steps: 62, submissions: 59, checkpoints: 21 } : { steps: 63, submissions: 60, checkpoints: 22 };
      expect(rendererProofPlan.exactCounts[kind]).toEqual(count);
      expect(steps).toHaveLength(count.steps);
      expect(new Set(steps.map(step => step.id)).size).toBe(count.steps);
      expect(steps.filter(step => step.action === 'submit')).toHaveLength(count.submissions);
      expect(steps.filter(step => step.checkpoint)).toHaveLength(count.checkpoints);
      expect(steps.filter(step => step.action === 'submit').length).toBeLessThanOrEqual(rendererProofPlan.limits.successfulFramesPerArm);
      expect(steps.filter(step => step.checkpoint).length).toBeLessThanOrEqual(rendererProofPlan.limits.textureCheckpointsPerFixture);
      expect(steps.filter(step => step.action === 'fail-write').map(step => [step.id, step.failWriteOrdinal])).toEqual([['partial-write-failure', 2]]);
      expect(steps.filter(step => step.action === 'cancel').map(step => step.id)).toEqual(['hard-reset-cancel', 'queued-upload-cancel']);
      expect(steps.every(step => step.controls.temporal === false && step.time === 0)).toBe(true);
      expect(steps.slice(0, -1).every(step => step.width === 320 && step.height === 180)).toBe(true);
      expect(steps.at(-1)).toMatchObject({ id: 'resize', width: 384, height: 216 });
      expect(Object.isFrozen(steps) && steps.every(step => Object.isFrozen(step) && Object.isFrozen(step.controls))).toBe(true);
    }
  });

  it('separates sharp initialization from registered roughness edits and omits unsupported standalone GI controls', () => {
    expect(rendererProofPlan.settings).toMatchObject({ roughness: 0, temporal: false, probesPerUpdate: 32, raysPerProbe: 64,
      resolutionScale: 1, maxRaysPerFrame: 32768, maxDistance: 16, requestedResidentPoolBytes: 8 * 1024 ** 2, allocatedCanonicalResidentPoolBytes: 80 * 65536 });
    expect(rendererProofPlan.steps.reflections.slice(0, 12).map(step => step.id)).toEqual(Array.from({ length: 12 }, (_, i) => `sharp-warm-${i + 1}`));
    expect(rendererProofPlan.version).toBe('issue20-renderer-pair-v3');
    expect(rendererProofPlan.steps.reflections[12]).toMatchObject({ id: 'sharp-moved-point4', checkpoint: true, controls: { reflections: { objectOffset: .4, roughness: 0 } } });
    expect(rendererProofPlan.steps.gi.some(step => step.id === 'sharp-moved-point4')).toBe(false);
    expect(rendererProofPlan.steps.reflections.find(step => step.id === 'world-S0')?.controls.reflections?.roughness).toBe(.08);
    expect(rendererProofPlan.steps.reflections.find(step => step.id === 'world-S7')?.controls).toMatchObject({ gi: { wallColor: 'neutral' }, reflections: { roughness: .3 } });
    expect(rendererProofPlan.steps.reflections.find(step => step.id === 'world-S8')?.controls.gi?.lightIntensity).toBe(0);
    expect(rendererProofPlan.steps.gi.every(step => step.controls.reflections === undefined)).toBe(true);
    const motion = rendererProofPlan.steps.reflections.filter(step => step.id.startsWith('soft-motion'));
    expect(motion).toHaveLength(12); expect(new Set(motion.map(step => step.controls.reflections?.objectOffset)).size).toBeGreaterThan(6);
    expect(motion.every(step => Math.abs(step.controls.reflections!.objectOffset!) <= .4)).toBe(true);
    expect(rendererProofPlan.streamedTimes).toEqual([0, 34, 46, 0]);
    expect(rendererProofPlan.limits.streamedFramesPerPose).toBe(30);
    expect(rendererProofPlan.limits.streamedDeadlineMs).toBe(90_000);
  });

  it('uses requested persistent modes and rejects CPU negative controls that ignore disable or advance inactive caches', () => {
    let expected = { gi: true, reflections: 'world' as 'world' | 'off' | 'probe-only' | null };
    const inactive = [];
    for (const step of rendererProofPlan.steps.reflections) {
      expected = advanceRendererProofModes(expected, step.controls);
      expect(rendererProofPlan.modeTransitions.reflections!.find(row => row.id === step.id)).toEqual({ id: step.id, ...expected });
      if (step.id.startsWith('disabled-edit-')) {
        inactive.push(step.id); expect(expected).toEqual({ gi: false, reflections: 'off' });
        // Deliberately ignore the requested mode in the observed arm. Pair equality alone would accept two such arms.
        expect(() => assertRendererProofModes(expected, { enabled: true }, { mode: 'world' })).toThrow('harness-owned requested modes');
        expect(() => assertRendererProofModes(expected, { enabled: false }, { mode: 'off' })).not.toThrow();
      }
    }
    expect(inactive).toEqual(['disabled-edit-1', 'disabled-edit-2', 'disabled-edit-3']);
    const before = { probe: { cacheEpoch: 8, refreshFrontier: 32, sourceFrameId: 50, submittedFrames: 50, sampleFrameIndex: 49 },
      reflection: { cacheEpoch: 17, sourceFrameId: 50, submittedFrames: 50, totalScheduledCandidates: 5000 } };
    expect(() => assertDisabledRendererCaches(before, before, [{ label: 'Strata geometry selection' }])).not.toThrow();
    for (const label of ['Strata GI software probe trace', 'Strata selective reflection trace', 'Strata reflection shade']) {
      expect(() => assertDisabledRendererCaches(before, before, [{ label }])).toThrow('encoded a GI/reflection pass');
    }
    expect(() => assertDisabledRendererCaches(before, { ...before, probe: { ...before.probe, submittedFrames: 51 } }, [])).toThrow('advanced cache');
    expect(() => assertDisabledRendererCaches(before, { ...before, reflection: { ...before.reflection, cacheEpoch: 18 } }, [])).toThrow('advanced cache');
  });

  it('independently rejects stale initial geometry at the single moved sharp checkpoint (CPU negative control only)', () => {
    const camera = createGiCamera(320, 180, 0, [0, 0], 'receiver'), config = new ArrayBuffer(240), f = new Float32Array(config), u = new Uint32Array(config);
    f.set(invertGiMatrix(camera.viewProjection)); f.set(camera.eye, 32);
    u.set([320, 180, 320, 180], 36); u.set([12, 2, 2, 1], 40);
    // Frozen receiver projection has this entire mirror rectangle below the32,768 candidate cap.
    u.set([0, 27930, 27930, 1], 44); f.set([0, 16, .8, 1], 48); u.set([1, 1, 0, 0], 52); u.set([1, 42, 266, 105], 56);
    const witness = rendererSharpRay(camera.viewProjection, config, .4);
    expect(witness).toMatchObject({ x: 192, y: 89, candidate: 12693, scheduledOffset: 12693, initialEmitterDistance: null });
    expect(witness.expectedDistance).toBeCloseTo(1.1017776, 6);
    expect(rendererSharpRay(camera.viewProjection, config, 0).initialEmitterDistance).not.toBeNull();
    const ray: GiRay = { origin: witness.origin, direction: witness.direction, tMin: .002, tMax: 16 };
    const stale = traceGiBvh(buildGiTraceData(createReflectionScene({ roughness: 0 })), ray);
    const moved = traceGiBvh(buildGiTraceData(createReflectionScene({ roughness: 0, objectOffset: .4 })), ray);
    expect(moved.boxId).toBe(12); expect(stale.boxId).not.toBe(12);
    const sample = { source: 1, frame: 12, epoch: 2, mask: 1, distance: moved.distance, rgb: [3.5, .3, .1] };
    expect(() => assertRendererSharpSample(witness, config, 12, sample)).not.toThrow();
    // Even granting stale data a fresh tag and bright color cannot disguise its wrong intersection distance.
    expect(() => assertRendererSharpSample(witness, config, 12, { ...sample, distance: stale.distance })).toThrow('expected emitter distance');
    expect(() => assertRendererSharpSample(witness, config, 12, { ...sample, frame: 11 })).toThrow('current-frame');
    const unscheduled = config.slice(0); new Uint32Array(unscheduled)[45] = 1;
    expect(() => rendererSharpRay(camera.viewProjection, unscheduled, .4)).toThrow('not in this current scheduled window');
  });

  it('rejects a shared false-pass where cancelling the reset commits state or retry silently reuses old history', () => {
    const before = { cacheEpoch: 7, refreshFrontier: 160, framesSinceReset: 5, probeUpdatesSinceReset: 160,
      submittedFrames: 21, sampleFrameIndex: 20, sourceFrameId: 21 };
    const state = new Uint32Array(384 * 4);
    for (let probe = 0; probe < 384; probe++) state.set([7, 1, 5, 20], probe * 4);
    const config = new Uint32Array(24); config.set([0, 32, 64, 8], 8); config.set([21, 1, 1337, 12], 16);
    expect(() => assertProbeResetLifecycle('cancel', before, before, config.buffer, state.buffer, state.buffer)).not.toThrow();
    expect(() => assertProbeResetLifecycle('cancel', before, { ...before, cacheEpoch: 8 }, config.buffer, state.buffer, state.buffer)).toThrow('committed probe telemetry');
    const disturbed = state.slice(); disturbed[0] = 8;
    expect(() => assertProbeResetLifecycle('cancel', before, before, config.buffer, state.buffer, disturbed.buffer)).toThrow('changed actual probe state');
    const after = { cacheEpoch: 8, refreshFrontier: 32, framesSinceReset: 1, probeUpdatesSinceReset: 32,
      submittedFrames: 22, sampleFrameIndex: 21, sourceFrameId: 22 };
    const updated = state.slice(); for (let probe = 0; probe < 32; probe++) updated.set([8, 1, 1, 21], probe * 4);
    expect(() => assertProbeResetLifecycle('retry', before, after, config.buffer, state.buffer, updated.buffer)).not.toThrow();
    for (const wrong of [{ cacheEpoch: 7 }, { refreshFrontier: 192 }, { framesSinceReset: 6 }, { submittedFrames: 23 }]) {
      expect(() => assertProbeResetLifecycle('retry', before, { ...after, ...wrong }, config.buffer, state.buffer, updated.buffer)).toThrow('exactly one new epoch');
    }
    expect(() => assertProbeResetLifecycle('retry', before, after, config.buffer, state.buffer, state.buffer)).toThrow('selected GPU probe record');
    const tailChanged = updated.slice(); tailChanged[32 * 4] = 8;
    expect(() => assertProbeResetLifecycle('retry', before, after, config.buffer, state.buffer, tailChanged.buffer)).toThrow('unscheduled GPU probe records');
    for (const [word, value] of [[8, 160], [11, 7], [17, 0]]) {
      const wrong = config.slice(); wrong[word!] = value!;
      expect(() => assertProbeResetLifecycle('retry', before, after, wrong.buffer, state.buffer, updated.buffer)).toThrow('epoch+1');
    }
  });

  it.each(['gi', 'reflections', 'integrated'] as const)('%s planned second-write failure is reachable and queued cancellation needs no re-upload', (kind: RendererProofKind) => {
    // This small CPU scheduling fixture checks admission/call ordinals, not the canonical GPU image or ray oracle.
    const factory = kind === 'gi' ? createGiScene : kind === 'reflections' ? createReflectionScene : createIntegratedScene;
    let state = { doorOpen: true, wallColor: 'red' as 'red' | 'neutral', lightIntensity: 1, objectOffset: 0, roughness: 0 };
    const data = buildGiTraceData(factory(state)), updater = new GiTraceUpdater(data);
    const buffers = [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData].map(bytes => ({ size: bytes.byteLength })) as GPUBuffer[];
    let gi = true, reflection = kind !== 'gi', attempts = 0, failOrdinal: number | undefined, thrown = 0;
    const queue = { writeBuffer() { attempts++; if (attempts === failOrdinal) { thrown++; throw Error('planned failure'); } } } as unknown as GPUQueue;
    for (const step of rendererProofPlan.steps[kind]) {
      const input = step.controls;
      state = { ...state, ...(input.gi?.doorOpen === undefined ? {} : { doorOpen: input.gi.doorOpen }),
        ...(input.gi?.wallColor === undefined ? {} : { wallColor: input.gi.wallColor }),
        ...(input.gi?.lightIntensity === undefined ? {} : { lightIntensity: input.gi.lightIntensity }),
        ...(input.reflections?.objectOffset === undefined ? {} : { objectOffset: input.reflections.objectOffset }),
        ...(input.reflections?.roughness === undefined ? {} : { roughness: input.reflections.roughness }) };
      gi = input.gi?.enabled ?? gi;
      reflection = input.reflections?.mode === undefined ? reflection : input.reflections.mode !== 'off';
      updater.update(factory(state)); attempts = 0; failOrdinal = step.failWriteOrdinal;
      const before = updater.telemetry;
      if (gi || reflection) {
        if (step.action === 'fail-write') {
          expect(() => updater.flush(queue, buffers)).toThrow('planned failure');
          expect(attempts).toBe(2); expect(updater.telemetry.queuedUpdateCount).toBe(before.queuedUpdateCount);
          expect(updater.telemetry.pendingUploadBytes).toBeGreaterThan(0);
        } else updater.flush(queue, buffers);
      } else {
        expect(updater.telemetry.queuedUpdateCount).toBe(before.queuedUpdateCount);
        expect(attempts).toBe(0);
      }
      if (step.id === 'queued-upload-retry') expect(attempts).toBe(0);
      if (step.id === 'new-target-retry') expect(updater.telemetry).toMatchObject({ queuedUpdateCount: updater.telemetry.updateCount, pendingRangeCount: 0 });
    }
    expect(thrown).toBe(1); updater.dispose();
  });
});
