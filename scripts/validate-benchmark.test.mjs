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

function sampleDistribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return { count: 0, min: null, mean: null, p50: null, p95: null, p99: null, max: null };
  return { count: sorted.length, min: sorted[0], mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    p99: sorted[Math.ceil(sorted.length * 0.99) - 1], max: sorted.at(-1) };
}

function giFixture({ enabled = true, temporal = true, probes = 32, rays = 64, dynamic = false, timed = false } = {}) {
  const report = fixture();
  const run = report.runs[0];
  run.workload = { id: 'two-room-software-gi-v1', seed: 1337, instanceCount: 0, renderer: 'gi', temporal,
    renderPath: 'world-space-diffuse-gi-v1', cameraPath: 'gi-overview-v1', debugView: 'final',
    externalAssetsUsed: false, sourceTriangleCount: 132, giEnabled: enabled, giScenario: dynamic ? 'door-light' : 'static' };
  run.quality = { giEnabled: enabled, probesPerUpdate: probes, raysPerProbe: rays, traceRepresentation: 'triangle-bvh-v1',
    grid: [12, 4, 8], maxTraceDistance: 32, screenTracing: false, giScenario: run.workload.giScenario,
    scenarioPeriodSeconds: 60, materialFixture: 'shared-flat-lambertian-v1', events: dynamic ? [
      { atSeconds: 10, doorOpen: false }, { atSeconds: 20, doorOpen: true }, { atSeconds: 30, lightIntensity: 0.2 },
      { atSeconds: 40, lightIntensity: 1 }, { atSeconds: 50, wallColor: 'neutral' },
    ] : [] };
  const names = [...(enabled ? ['gi-trace', 'gi-update', 'gi-shade'] : []), 'shadow', 'raster', 'presentation', ...(temporal ? ['temporal'] : [])];
  const base = run.frames[0];
  run.frames = Array.from({ length: dynamic ? 7 : 2 }, (_, index) => {
    const frameId = index + 2; // Include one submitted warm-up frame.
    const phase = dynamic ? index % 6 : 0;
    const framesSinceReset = enabled ? (dynamic && index > 0 ? 1 : frameId) : 0;
    const gi = { sourceFrameId: enabled ? frameId : null, worldRevision: dynamic ? index + 1 : 1,
      cacheEpoch: enabled ? (dynamic ? index + 1 : 1) : 0, enabled, probeCount: 384, probesPerUpdate: probes,
      raysPerProbe: rays, primaryRaysPerFrame: enabled ? probes * rays : 0, maxShadowRaysPerFrame: enabled ? probes * rays : 0,
      updatePeriodFrames: Math.ceil(384 / probes), framesSinceReset, probeUpdatesSinceReset: framesSinceReset * probes,
      submittedFrames: enabled ? frameId : 0, primaryRaysSubmitted: enabled ? frameId * probes * rays : 0,
      validProbeCount: null, traceFailures: null, hysteresis: 0.85, maxTraceDistance: 32,
      doorOpen: phase !== 1, wallColor: phase === 5 ? 'neutral' : 'red', lightIntensity: phase === 3 ? 0.2 : 1,
      traceRepresentation: 'triangle-bvh-v1', traceGeometryBytes: 11392, cacheBufferBytes: 6368 + probes * rays * 32,
      cacheTextureBytes: 1966080, composeBufferBytes: 96, composeTextureBytes: enabled ? 1280 * 720 * 8 : 0 };
    return { ...base, frameId, elapsedMs: index * (dynamic ? 10000 : 16), frameIntervalMs: dynamic && index < 6 ? 10000 : 16,
      triangleCountSourceFrameId: frameId, drawCalls: temporal ? 4 : 3, dispatchCalls: enabled ? 3 : 0,
      triangles: temporal ? 266 : 265, gi, gpuMs: timed ? 0 : null,
      gpuPasses: timed ? Object.fromEntries(names.map(name => [name, 0])) : {},
      allocatedGpuBufferBytes: gi.traceGeometryBytes + gi.cacheBufferBytes + gi.composeBufferBytes + 65536,
      allocatedGpuTextureBytes: gi.cacheTextureBytes + gi.composeTextureBytes + 16777216 };
  });
  const count = run.frames.length;
  const intervals = run.frames.map(frame => frame.frameIntervalMs);
  Object.assign(run.capture, { requestedDurationSeconds: intervals.reduce((sum, value) => sum + value, 0) / 1000,
    actualDurationMs: intervals.reduce((sum, value) => sum + value, 0), frameCount: count });
  Object.assign(run.profiling, { gpuTimestampAvailable: timed, reason: timed ? 'available' : 'timestamp-query-unavailable',
    capturedGpuSamples: timed ? count : 0, timedFrameCount: timed ? count : 0, capturedPassSampleCount: timed ? count * names.length : 0 });
  Object.assign(run.allocations, { submittedFrames: run.frames.at(-1).frameId, gi: { ...run.frames.at(-1).gi },
    allocatedGpuBufferBytes: run.frames[0].allocatedGpuBufferBytes, allocatedGpuTextureBytes: run.frames[0].allocatedGpuTextureBytes });
  Object.assign(run.summary, { frameIntervalMs: sampleDistribution(intervals),
    cpuSubmissionMs: sampleDistribution(run.frames.map(frame => frame.cpuSubmissionMs)),
    gpuPassMs: sampleDistribution(timed ? run.frames.map(() => 0) : []),
    meanCallbackCadenceFps: 1000 * count / run.capture.actualDurationMs, framesAbove20Ms: intervals.filter(value => value > 20).length,
    drawCalls: count * (temporal ? 4 : 3), dispatchCalls: count * (enabled ? 3 : 0),
    maxTrackedGpuBufferBytes: run.frames[0].allocatedGpuBufferBytes, maxTrackedGpuTextureBytes: run.frames[0].allocatedGpuTextureBytes });
  run.gpuPasses = timed ? Object.fromEntries(names.map(name => [name, { ...sampleDistribution(run.frames.map(() => 0)), sampleCount: count, totalMs: 0 }])) : {};
  return report;
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

test('accepts GI on/off with independent TAA, bounded ray budgets, and unknown GPU status', () => {
  for (const enabled of [false, true]) for (const temporal of [false, true]) for (const timed of [false, true]) {
    const report = giFixture({ enabled, temporal, timed });
    assert.equal(validateBenchmarkReport(report), report);
    assert.equal(report.runs[0].allocations.gi.traceFailures, null);
    assert.equal(report.runs[0].allocations.gi.validProbeCount, null);
  }
  for (const [probes, rays] of [[1, 16], [127, 17], [128, 128]]) {
    const report = giFixture({ probes, rays });
    assert.equal(validateBenchmarkReport(report), report);
  }
});

test('validates each door/light event and the new cache epoch on a full scenario cycle', () => {
  for (const enabled of [false, true]) {
    const report = giFixture({ dynamic: true, enabled });
    assert.equal(validateBenchmarkReport(report), report);
  }
  for (const [mutate, expected] of [
    [run => { run.quality.events[0].atSeconds = 9; }, /event schedule/],
    [run => { run.frames[1].gi.doorOpen = true; }, /world state differs/],
    [run => { run.frames[3].gi.lightIntensity = 1; }, /world state differs/],
    [run => { run.frames[5].gi.wallColor = 'red'; }, /world state differs/],
    [run => { run.frames[1].gi.worldRevision++; run.frames[1].gi.cacheEpoch++; }, /world revision/],
    [run => { run.frames[1].gi.cacheEpoch--; }, /cache epoch/],
    [run => { run.frames[1].gi.framesSinceReset = 2; run.frames[1].gi.probeUpdatesSinceReset = 64; }, /cache age/],
  ]) {
    const report = giFixture({ dynamic: true });
    mutate(report.runs[0]);
    assert.throws(() => validateBenchmarkReport(report), expected);
  }
});

test('rejects incomplete GI telemetry, fabricated budgets, invalid counters and resource estimates', () => {
  for (const [mutate, expected] of [
    [run => { delete run.quality; }, /schema/],
    [run => { delete run.frames[0].gi; }, /schema/],
    [run => { delete run.frames[0].gi.traceFailures; }, /schema/],
    [run => { delete run.frames[0].gpuPasses; }, /schema/],
    [run => { delete run.allocations.gi; }, /schema/],
    [run => { run.workload.seed = 1; }, /schema/],
    [run => { run.workload.instanceCount = 512; }, /schema/],
    [run => { run.workload.sourceTriangleCount = 120; }, /schema/],
    [run => { run.quality.screenTracing = true; }, /schema/],
    [run => { run.quality.probesPerUpdate = 129; }, /schema/],
    [run => { run.frames[0].gi.validProbeCount = 385; }, /schema/],
    [run => { run.frames[0].gi.enabled = false; }, /enabled state or probe budget/],
    [run => { run.frames[0].gi.primaryRaysPerFrame--; }, /ray budget/],
    [run => { run.frames[0].gi.maxShadowRaysPerFrame++; }, /ray budget/],
    [run => { run.frames[0].gi.updatePeriodFrames++; }, /update period/],
    [run => { run.frames[0].gi.probeUpdatesSinceReset--; }, /cumulative work/],
    [run => { run.frames[0].gi.primaryRaysSubmitted--; }, /cumulative work/],
    [run => { run.frames[0].gi.traceFailures = 1; }, /traversal failures/],
    [run => { run.frames[0].gi.validProbeCount = 65; }, /valid-probe count/],
    [run => { run.frames[0].gi.sourceFrameId--; }, /source frame/],
    [run => { run.frames[0].triangleCountSourceFrameId--; }, /geometry counters/],
    [run => { run.frames[0].dispatchCalls--; }, /draw\/dispatch\/triangle/],
    [run => { run.frames[0].gi.cacheBufferBytes++; }, /allocation estimates/],
    [run => { run.frames[0].gi.composeTextureBytes = 0; }, /allocation estimates/],
    [run => { run.frames[0].allocatedGpuBufferBytes = 1; }, /exceed total/],
    [run => { run.allocations.gi.sourceFrameId--; }, /final GI telemetry/],
  ]) {
    const report = giFixture();
    mutate(report.runs[0]);
    assert.throws(() => validateBenchmarkReport(report), expected);
  }
  const disabled = giFixture({ enabled: false });
  disabled.runs[0].frames[0].gi.sourceFrameId = 2;
  assert.throws(() => validateBenchmarkReport(disabled), /disabled GI reports submitted cache work/);
});

test('requires exactly the active GI passes and rejects orphaned pass summaries', () => {
  for (const [enabled, temporal, missing] of [[true, true, 'gi-trace'], [true, false, 'gi-update'], [false, true, 'temporal'], [false, false, 'shadow']]) {
    const report = giFixture({ enabled, temporal, timed: true });
    delete report.runs[0].frames[0].gpuPasses[missing];
    assert.throws(() => validateBenchmarkReport(report), /incomplete frame pass timings/);
  }
  const report = giFixture({ enabled: false, temporal: false, timed: true });
  const run = report.runs[0];
  run.frames[0].gpuPasses['gi-shade'] = 0;
  assert.throws(() => validateBenchmarkReport(report), /incomplete frame pass timings/);
  delete run.frames[0].gpuPasses['gi-shade'];
  run.gpuPasses['gi-shade'] = { ...sampleDistribution([]), sampleCount: 0, totalMs: 0 };
  assert.throws(() => validateBenchmarkReport(report), /pass summaries contain measurements absent/);
});
