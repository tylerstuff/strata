import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBenchmarkReport } from './validate-benchmark.mjs';

function fixture() {
  const empty = { count: 0, min: null, mean: null, p50: null, p95: null, p99: null, max: null };
  const frame = { drawCalls: 1, dispatchCalls: 0, triangles: 12, uploadBytes: 0, allocatedGpuBufferBytes: 64, allocatedGpuTextureBytes: 128, gpuMs: null };
  const run = {
    schemaVersion: 1, startedAt: '2026-09-05T00:00:00Z', completedAt: '2026-09-05T00:00:01Z', mode: 'performance',
    workload: { id: 'procedural-boxes-v1', seed: 1337, instanceCount: 1, cameraPath: 'orbit-20s-v1', renderPath: 'diffuse-raster-v1', externalAssetsUsed: false },
    resolution: { width: 1280, height: 720, devicePixelRatio: 1, cssWidth: 1280, cssHeight: 720, screenWidth: 1920, screenHeight: 1080 },
    capture: { warmupSeconds: 0, requestedDurationSeconds: 0.036, actualDurationMs: 36, frameCount: 2, visibilityChanges: [] },
    browser: { userAgent: 'test browser', hardwareConcurrency: 8, crossOriginIsolated: false, secureContext: true },
    adapter: { vendor: 'test hardware', architecture: 'test', device: '', description: '', isFallbackAdapter: false },
    capabilities: { adapterFeatures: [], adapterLimits: {}, deviceLimits: {} },
    profiling: { enabled: true, gpuTimestampAvailable: false, reason: 'timestamp-query-unavailable', timestampPrecision: 'browser-dependent', capturedGpuSamples: 0, pendingGpuSamples: 0, droppedGpuSamples: 0 },
    coldStart: { initializeMs: 1, sceneSetupMs: 1, uploadBytes: 64 },
    assetTraffic: { externalAssetsUsed: false, steadyUploadBytes: 0, documentResourceTransferBytes: 0, documentResourceDecodedBytes: 0, note: 'Synthetic test fixture' },
    allocations: { submittedFrames: 2, totalUploadBytes: 64, allocatedGpuBufferBytes: 64, allocatedGpuTextureBytes: 128, wasmMemoryBytes: 65536, pendingGpuSamples: 0, droppedGpuSamples: 0, gpuErrorCount: 0, note: 'Synthetic test fixture' },
    summary: {
      frameIntervalMs: { count: 2, min: 16, mean: 18, p50: 16, p95: 20, p99: 20, max: 20 },
      cpuSubmissionMs: { count: 2, min: 1, mean: 2, p50: 1, p95: 3, p99: 3, max: 3 },
      gpuPassMs: empty, meanCallbackCadenceFps: 1000 / 18, framesAbove20Ms: 0,
      targetFrameIntervalMs: 1000 / 60, drawCalls: 2, dispatchCalls: 0, uploadBytes: 0,
      maxTrackedGpuBufferBytes: 64, maxTrackedGpuTextureBytes: 128,
    },
    gpuPasses: {}, metadata: {}, limitations: ['Synthetic data, not performance evidence'],
    frames: [{ ...frame, frameId: 2, elapsedMs: 0, frameIntervalMs: 16, cpuSubmissionMs: 1 }, { ...frame, frameId: 3, elapsedMs: 16, frameIntervalMs: 20, cpuSubmissionMs: 3 }],
    runner: { captureValidation: { passed: true } },
  };
  return {
    schemaVersion: 1, kind: 'strata-local-benchmark-session', createdAt: '2026-09-05T00:00:00Z', mode: 'performance',
    host: {}, source: { commit: null, dirty: null }, browser: { headed: true, softwareGpu: false }, runs: [run],
  };
}

test('valid unavailable GPU timings remain null; quantized zero timings remain valid measurements', () => {
  const unavailable = fixture();
  assert.equal(validateBenchmarkReport(unavailable), unavailable);
  const quantized = fixture();
  const run = quantized.runs[0];
  run.profiling.gpuTimestampAvailable = true;
  run.profiling.reason = 'available';
  run.profiling.capturedGpuSamples = 2;
  run.frames.forEach(frame => { frame.gpuMs = 0; });
  run.summary.gpuPassMs = { count: 2, min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  run.gpuPasses = { procedural: { sampleCount: 2, totalMs: 0 } };
  assert.equal(validateBenchmarkReport(quantized), quantized);
});

test('rejects fabricated GPU zeros, missing required measurements, and inconsistent summaries', () => {
  for (const [mutate, expected] of [
    [run => { run.summary.gpuPassMs.mean = 0; }, /must report null/],
    [run => { run.frames[0].gpuMs = 0; run.profiling.capturedGpuSamples = 1; }, /without available timestamps/],
    [run => { delete run.frames[0].gpuMs; }, /schema/],
    [run => { run.summary.frameIntervalMs.p95 = 18; }, /p95 does not match/],
    [run => { run.capture.frameCount = 1; }, /frame count differs/],
    [run => { run.frames[1].elapsedMs = 17; }, /callback alignment/],
    [run => { run.capture.actualDurationMs = 40; }, /capture duration does not match/],
    [run => { run.assetTraffic.steadyUploadBytes = 16; }, /capture upload traffic differs/],
    [run => { run.gpuPasses = { procedural: { sampleCount: 1, totalMs: 0 } }; }, /without available timestamps/],
  ]) {
    const report = fixture();
    mutate(report.runs[0]);
    assert.throws(() => validateBenchmarkReport(report), expected);
  }
});

test('rejects failed, hidden, software, blank, or GPU-invalid performance captures', () => {
  for (const [mutate, expected] of [
    [report => { report.failure = 'capture failed'; }, /session records a failure/],
    [report => { report.browser.headed = false; }, /headed hardware browser/],
    [report => { report.runs[0].adapter.isFallbackAdapter = true; }, /software\/fallback/],
    [report => { report.runs[0].capture.visibilityChanges.push({ atMs: 1, state: 'hidden' }); }, /hidden during measurement/],
    [report => { report.runs[0].allocations.gpuErrorCount = 1; }, /GPU errors/],
    [report => { report.runs[0].runner.captureValidation.passed = false; }, /screenshot validation/],
    [report => { report.runs[0].resolution.height = 1080; }, /mismatched resolution/],
  ]) {
    const report = fixture();
    mutate(report);
    assert.throws(() => validateBenchmarkReport(report), expected);
  }
});

test('keeps complete named pass timings distinct from the number of timed frames', () => {
  const report = fixture();
  const run = report.runs[0];
  Object.assign(run.workload, { renderer: 'raster', temporal: true });
  Object.assign(run.profiling, { gpuTimestampAvailable: true, reason: 'available', capturedGpuSamples: 2, timedFrameCount: 2, capturedPassSampleCount: 8 });
  const zero = { count: 2, min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  run.summary.gpuPassMs = { ...zero };
  const passes = { shadow: 0, raster: 0, temporal: 0, presentation: 0 };
  run.frames.forEach(frame => { frame.gpuMs = 0; frame.gpuPasses = { ...passes }; });
  run.gpuPasses = Object.fromEntries(Object.keys(passes).map(name => [name, { ...zero, sampleCount: 2, totalMs: 0 }]));
  assert.equal(validateBenchmarkReport(report), report);
  delete run.frames[0].gpuPasses.shadow;
  assert.throws(() => validateBenchmarkReport(report), /incomplete frame pass timings/);
  run.frames[0].gpuPasses.shadow = 0;
  run.profiling.capturedPassSampleCount = 2;
  assert.throws(() => validateBenchmarkReport(report), /pass sample count is inconsistent/);
});

test('validates delayed geometry feedback independently from current frame submissions', () => {
  const report = fixture();
  const run = report.runs[0];
  Object.assign(run.workload, { renderer: 'virtual', geometryMode: 'streamed', instanceCount: 0,
    externalAssetsUsed: true, sourceTriangleCount: 32768, uniqueCompiledBytes: 1048576 });
  run.assetTraffic.externalAssetsUsed = true;
  run.quality = { poolBytes: 524288 };
  run.allocations.geometry = { pendingFeedbackFrames: 0 };
  const geometry = { sourceFrameId: null, coverageMissingTiles: 0, overflowCount: 0,
    poolBytes: 524288, capacityPages: 8, residentPages: 2, rootPages: 2, pageBytes: 65536 };
  Object.assign(run.frames[0], { triangles: 0, triangleCountSourceFrameId: null, geometry: { ...geometry } });
  Object.assign(run.frames[1], { triangleCountSourceFrameId: 2, geometry: { ...geometry, sourceFrameId: 2 } });
  assert.equal(validateBenchmarkReport(report), report);
  run.frames[1].geometry.sourceFrameId = 4;
  run.frames[1].triangleCountSourceFrameId = 4;
  assert.throws(() => validateBenchmarkReport(report), /future frame/);
  run.frames[1].geometry.sourceFrameId = 2;
  run.frames[1].triangleCountSourceFrameId = 2;
  run.frames[1].geometry.residentPages = 9;
  assert.throws(() => validateBenchmarkReport(report), /residency bounds/);
  run.frames[1].geometry.residentPages = 2;
  run.frames[1].geometry.coverageMissingTiles = 1;
  assert.throws(() => validateBenchmarkReport(report), /incomplete geometry coverage/);
});
