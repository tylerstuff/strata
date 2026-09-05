import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GalleryMeasurements } from './state.ts';

const original = { engineEpoch: 1, viewRevision: 1, modelId: 'model-a' };
const otherView = { ...original, viewRevision: 2 };

function frame(frameId, cpuSubmissionMs = frameId) {
  return {
    frameId, cpuSubmissionMs, drawCalls: 1, dispatchCalls: 0, triangles: 12,
    uploadBytes: 0, allocatedGpuBufferBytes: 0, allocatedGpuTextureBytes: 0, wasmMemoryBytes: 0,
  };
}

function timing(frameId, pass = 'raster', startOffsetMs = 0, endOffsetMs = 2) {
  return { frameId, pass, gpuMs: endOffsetMs - startOffsetMs, startOffsetMs, endOffsetMs };
}

test('keeps delayed samples attached to the submitted model and view', () => {
  const measurements = new GalleryMeasurements();
  measurements.recordFrame(frame(1), original);
  measurements.recordFrame(frame(2), otherView);
  measurements.recordGpuTimings([timing(1)]);
  assert.equal(measurements.snapshot(otherView).cpuSubmissionMs, 2);
  assert.equal(measurements.snapshot(otherView).gpu.frameId, null);
  assert.equal(measurements.snapshot(original).gpu.frameId, 1);
  assert.equal(measurements.snapshot({ ...original, modelId: 'model-b' }).submittedFrameId, null);
});

test('selects the newest matching timed frame, independent of readback order', () => {
  const measurements = new GalleryMeasurements();
  for (let id = 1; id <= 3; id++) measurements.recordFrame(frame(id), original);
  measurements.recordGpuTimings([timing(2), timing(1)]);
  const snapshot = measurements.snapshot(original);
  assert.equal(snapshot.submittedFrameId, 3);
  assert.equal(snapshot.gpu.frameId, 2);
});

test('isolates reused frame IDs across engine epochs and clears callback history', () => {
  const measurements = new GalleryMeasurements();
  measurements.recordFrame(frame(1), original);
  measurements.recordGpuTimings([timing(1)]);
  measurements.recordCallback(10);
  measurements.recordCallback(20);
  const recreated = { ...original, engineEpoch: 2 };
  measurements.recordFrame(frame(1, 9), recreated);
  assert.equal(measurements.snapshot(original).submittedFrameId, null);
  assert.equal(measurements.snapshot(recreated).cpuSubmissionMs, 9);
  assert.equal(measurements.snapshot(recreated).gpu.frameId, null);
  assert.equal(measurements.snapshot(recreated).callbackIntervalMs, null);
  measurements.recordGpuTimings([timing(1, 'new-engine')]);
  assert.equal(measurements.snapshot(recreated).gpu.samples[0]?.pass, 'new-engine');
  measurements.clear();
  assert.equal(measurements.snapshot(recreated).submittedFrameId, null);
});

test('preserves measured zero and computes the envelope of overlapping passes', () => {
  const measurements = new GalleryMeasurements();
  measurements.recordFrame(frame(1, 0), original);
  measurements.recordGpuTimings([timing(1, 'zero', 0, 0)]);
  assert.equal(measurements.snapshot(original).cpuSubmissionMs, 0);
  assert.equal(measurements.snapshot(original).gpu.spanMs, 0);
  measurements.recordGpuTimings([timing(1, 'first', 0, 4), timing(1, 'overlap', 2, 5)]);
  assert.equal(measurements.snapshot(original).gpu.spanMs, 5);
  assert.equal(measurements.snapshot(original).gpu.passCount, 3);
});

test('missing or invalid pass boundaries leave the span unavailable', () => {
  for (const offsets of [{}, { startOffsetMs: 2, endOffsetMs: 1 }, { startOffsetMs: NaN, endOffsetMs: 1 }]) {
    const measurements = new GalleryMeasurements();
    measurements.recordFrame(frame(1), original);
    measurements.recordGpuTimings([timing(1), { frameId: 1, pass: 'unknown', gpuMs: 1, ...offsets }]);
    const snapshot = measurements.snapshot(original);
    assert.equal(snapshot.gpu.spanMs, null);
    assert.equal(snapshot.gpu.passCount, 2);
  }
});

test('evicts old frames and drops unknown IDs without retaining their samples', () => {
  const measurements = new GalleryMeasurements();
  measurements.recordFrame(frame(1), original);
  for (let id = 2; id <= 257; id++) measurements.recordFrame(frame(id), otherView);
  measurements.recordGpuTimings([timing(1), timing(258)]);
  assert.equal(measurements.snapshot(original).submittedFrameId, null);
  assert.equal(measurements.snapshot(otherView).gpu.frameId, null);
  measurements.recordFrame(frame(258), otherView);
  assert.equal(measurements.snapshot(otherView).gpu.frameId, null);
});

test('bounds unique passes, ignores duplicate drains and withholds truncated spans', () => {
  const measurements = new GalleryMeasurements();
  measurements.recordFrame(frame(1), original);
  measurements.recordGpuTimings([timing(1), timing(1)]);
  assert.equal(measurements.snapshot(original).gpu.passCount, 1);
  measurements.recordGpuTimings(Array.from({ length: 20 }, (_, index) => timing(1, `pass-${index}`)));
  assert.equal(measurements.snapshot(original).gpu.passCount, 16);
  assert.equal(measurements.snapshot(original).gpu.spanMs, null);
});

test('detaches inputs and prevents repeated frames from acquiring a new identity', () => {
  const measurements = new GalleryMeasurements();
  const identity = { ...original };
  const sample = timing(1);
  measurements.recordFrame(frame(1), identity);
  measurements.recordGpuTimings([sample]);
  identity.viewRevision = 10;
  // Core types are readonly; a caller can still mutate a raw object at runtime.
  Object.assign(sample, { gpuMs: 100 });
  measurements.recordFrame(frame(1), otherView);
  assert.equal(measurements.snapshot(original).gpu.samples[0]?.gpuMs, 2);
  assert.equal(measurements.snapshot(otherView).submittedFrameId, null);
});

test('resets invalid and paused callback intervals without fabricating zero cadence', () => {
  const measurements = new GalleryMeasurements();
  measurements.recordCallback(0);
  assert.equal(measurements.snapshot(original).callbackIntervalMs, null);
  measurements.recordCallback(16);
  assert.equal(measurements.snapshot(original).callbackIntervalMs, 16);
  for (const timestamp of [16, 1, NaN, Infinity, -1]) {
    measurements.recordCallback(timestamp);
    assert.equal(measurements.snapshot(original).callbackIntervalMs, null);
  }
  measurements.recordCallback(100);
  assert.equal(measurements.snapshot(original).callbackIntervalMs, null);
  measurements.recordCallback(116);
  measurements.resetCallback();
  assert.equal(measurements.snapshot(original).callbackIntervalMs, null);
  measurements.recordCallback(1000);
  assert.equal(measurements.snapshot(original).callbackIntervalMs, null);
});
