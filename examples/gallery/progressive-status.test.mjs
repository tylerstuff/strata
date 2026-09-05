import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeProgressiveCounters } from './progressive-status.ts';

const identity = { engineEpoch: 2, sceneGeneration: 7, countersPending: false };
const unavailable = { attempted: null, completed: null, exhausted: null, invalid: null };
function telemetry({ progress: changes = {}, counters: counterChanges = {} } = {}) {
  const progress = { revision: 3, submittedFrames: 12, batchCursor: 4096, width: 640, height: 360,
    pendingReset: false, pendingFrame: false, enabled: true, normalMode: 'geometric', textureLod: 0,
    limits: { maxPixels: 262144, pixelBatch: 4096, maxSamples: 64, maxVisits: 4096, seed: 1337 }, ...changes };
  return { mode: 'progressive-diffuse', temporal: false, rasterAmbient: 'disabled', rasterEnvironment: 'disabled',
    progress, sampleCounters: counterChanges === null ? null : { ...progress, attempted: 100, completed: 100, exhausted: 0, invalid: 0, ...counterChanges },
    estimatedPeakCpuBytes: 1024, preparedTraceGpuBytes: 512 };
}

test('missing telemetry preserves engine/scene identity without inventing zero samples', () => {
  for (const value of [null, undefined]) {
    const result = describeProgressiveCounters(value, { ...identity, sceneGeneration: null });
    assert.deepEqual(result.counts, unavailable);
    assert.equal(result.identity, 'Engine 2 · scene none · accumulation none · readback unavailable');
    assert.match(result.message, /No progressive telemetry/);
  }
});

test('missing readback stays unavailable and reports an actual pending readback separately', () => {
  const input = telemetry({ counters: null });
  const absent = describeProgressiveCounters(input, identity);
  assert.deepEqual(absent.counts, unavailable);
  assert.match(absent.message, /No GPU sample readback/);
  const pending = describeProgressiveCounters(input, { ...identity, countersPending: true });
  assert.deepEqual(pending.counts, unavailable);
  assert.match(pending.message, /readback is pending/);
});

test('a different readback revision cannot be relabeled as the current accumulation', () => {
  for (const revision of [2, 4]) {
    const result = describeProgressiveCounters(telemetry({ counters: { revision } }), identity);
    assert.deepEqual(result.counts, unavailable);
    assert.equal(result.identity, 'Engine 2 · scene 7 · accumulation 3 · readback unavailable');
    assert.match(result.message, /different accumulation revision/);
  }
});

test('a pending reset hides even a matching revision until new accumulation is submitted', () => {
  const result = describeProgressiveCounters(telemetry({ progress: { pendingReset: true } }), identity);
  assert.deepEqual(result.counts, unavailable);
  assert.match(result.message, /reset is pending/);
  assert.match(result.identity, /readback unavailable$/);
});

test('valid zero samples remain zero without claiming convergence from scheduled frames', () => {
  const result = describeProgressiveCounters(telemetry({ counters: { attempted: 0, completed: 0 } }), identity);
  assert.deepEqual(result.counts, { attempted: 0, completed: 0, exhausted: 0, invalid: 0 });
  assert.equal(result.identity, 'Engine 2 · scene 7 · accumulation 3 · readback 12 submissions');
  assert.doesNotMatch(result.message, /converged|complete|unknown paths/i);
});

test('a delayed matching readback retains its exact submission tag while another readback is pending', () => {
  const input = telemetry({ counters: { submittedFrames: 4, attempted: 25, completed: 25 } });
  const result = describeProgressiveCounters(input, { ...identity, countersPending: true });
  assert.deepEqual(result.counts, { attempted: 25, completed: 25, exhausted: 0, invalid: 0 });
  assert.equal(result.identity, 'Engine 2 · scene 7 · accumulation 3 · readback 4 submissions');
  assert.match(result.message, /snapshot follows 4 submissions; current scheduling is at 12/);
  assert.match(result.message, /readback is pending; showing the tagged snapshot/);
});

test('exhausted or invalid samples explain the direct-only unknown-path limitation', () => {
  for (const counters of [{ attempted: 100, completed: 98, exhausted: 2, invalid: 0 }, { attempted: 100, completed: 99, exhausted: 0, invalid: 1 }]) {
    const result = describeProgressiveCounters(telemetry({ counters }), identity);
    assert.deepEqual(result.counts, counters);
    assert.match(result.message, /Unknown paths.*direct-only lighting until reset/);
    assert.doesNotMatch(result.message, /converged|complete/i);
  }
});

test('engine and scene changes disambiguate reused revisions without mutating telemetry', () => {
  const input = telemetry();
  const before = structuredClone(input);
  const first = describeProgressiveCounters(input, identity);
  const nextScene = describeProgressiveCounters(input, { ...identity, sceneGeneration: 8 });
  const nextEngine = describeProgressiveCounters(input, { ...identity, engineEpoch: 3 });
  assert.notEqual(first.identity, nextScene.identity);
  assert.notEqual(first.identity, nextEngine.identity);
  assert.deepEqual(input, before);
  assert.notEqual(first.counts, input.sampleCounters);
});

test('invalid numeric counters and future submission tags remain unavailable', () => {
  for (const counters of [{ attempted: NaN }, { completed: -1 }, { invalid: Infinity }, { exhausted: 0.5 }, { submittedFrames: 13 }]) {
    const result = describeProgressiveCounters(telemetry({ counters }), identity);
    assert.deepEqual(result.counts, unavailable);
    assert.match(result.message, /inconsistent counts or submission tags/);
  }
});
