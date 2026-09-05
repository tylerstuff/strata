import { describe, expect, it } from 'vitest';
import { assertProbeResetLifecycle, rendererProofPlan } from '../browser/trace-update-renderer-validation.js';
import type { RendererProofKind } from '../browser/trace-update-renderer-validation.js';
import { GiTraceUpdater } from '../../packages/core/src/gi/trace-updates.js';
import { buildGiTraceData } from '../../packages/core/src/gi/trace-data.js';
import { createGiScene } from '../../packages/core/src/gi/scene-data.js';
import { createReflectionScene } from '../../packages/core/src/reflections/reflection-scene.js';
import { createIntegratedScene } from '../../packages/core/src/integrated/integrated-scene.js';

describe('frozen renderer-pair proof schedule', () => {
  it('stays within explicit submission/checkpoint limits with one bounded failure and immutable input controls', () => {
    for (const kind of ['gi', 'reflections', 'integrated'] as const) {
      const steps = rendererProofPlan.steps[kind];
      expect(steps).toHaveLength(62);
      expect(new Set(steps.map(step => step.id)).size).toBe(62);
      expect(steps.filter(step => step.action === 'submit')).toHaveLength(59);
      expect(steps.filter(step => step.checkpoint)).toHaveLength(21);
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
      resolutionScale: 1, maxRaysPerFrame: 32768, requestedResidentPoolBytes: 8 * 1024 ** 2, allocatedCanonicalResidentPoolBytes: 80 * 65536 });
    expect(rendererProofPlan.steps.reflections.slice(0, 12).map(step => step.id)).toEqual(Array.from({ length: 12 }, (_, i) => `sharp-warm-${i + 1}`));
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
