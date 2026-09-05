import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTraceRun, summarizeTracePerformance } from './summarize-trace-performance.mjs';

const counterNames = ['traceUpdateCount', 'traceQueuedUpdateCount', 'traceChangedBoxCount',
  'traceRegeneratedTriangleCount', 'tracePackedTriangleCount', 'traceRefitLeafCount',
  'traceRefitAncestorCount', 'traceAttemptedWriteCalls', 'traceQueuedWriteCalls',
  'traceQueuedUploadBytes', 'traceFullBufferFallbackCount'];
function run(arm = 'incremental', width = 1280, height = 720) {
  const counters = Object.fromEntries(counterNames.map(key => [key, 0]));
  counters.traceUpdateCount = 100; counters.traceQueuedUpdateCount = 100;
  counters.traceQueuedUploadBytes = 500000; counters.traceQueuedWriteCalls = 1000;
  counters.traceAttemptedWriteCalls = 1000;
  const start = { ...counters, traceMetadataBytes: arm === 'incremental' ? 150801 : 187185 };
  let geometryBytes = 4096;
  const frames = [0, 4000, 8000, 14000, 18000, 59000].map((elapsedMs, i) => {
    const changed = i < 2;
    if (changed) {
      counters.traceUpdateCount++; counters.traceQueuedUpdateCount++; counters.traceChangedBoxCount++;
      counters.traceQueuedUploadBytes += arm === 'incremental' ? 912 : 184640;
      counters.traceQueuedWriteCalls += arm === 'incremental' ? 7 : 5;
      counters.traceAttemptedWriteCalls += arm === 'incremental' ? 7 : 5;
      counters.traceRegeneratedTriangleCount += arm === 'incremental' ? 12 : 156;
      counters.tracePackedTriangleCount += arm === 'incremental' ? 12 : 2204;
    }
    geometryBytes += i === 0 ? 65536 : 0;
    return { frameId: 200 + i, elapsedMs, frameIntervalMs: 16.7,
      cpuSubmissionMs: changed ? arm === 'incremental' ? 2 : 4 : 1,
      gpuSpanMs: 10, gpuPasses: { scene: 9 }, uploadBytes: changed ? arm === 'incremental' ? 912 : 184640 : 64,
      allocatedGpuBufferBytes: 5000000, allocatedGpuTextureBytes: 12000000,
      gi: { ...counters, traceMetadataBytes: start.traceMetadataBytes }, geometry: { uploadedBytes: geometryBytes } };
  });
  return { mode: 'performance', metadata: { traceMaintenanceArm: arm }, resolution: { width, height },
    capture: { warmupSeconds: 30, requestedDurationSeconds: 60 },
    assetTraffic: { giAtCaptureStart: start, geometryAtCaptureStart: { uploadedBytes: 4096 } }, frames };
}
function report() { return { runs: [run(), run('full'), run('full', 1920, 1080), run('incremental', 1920, 1080)] }; }
const evidence = { canonicalUpdate: { incrementalBytes: 912, fullBytes: 184640, evidenceSha256: 'a'.repeat(64) } };

test('first measured delta uses capture-start counters and excludes warmup totals', () => {
  const summary = summarizeTraceRun(run());
  assert.equal(summary.windows.opening.changedTargetCount, 2);
  assert.equal(summary.windows.opening.changedTargetFrameCount, 2);
  assert.equal(summary.windows.opening.trace.traceQueuedUploadBytes, 1824);
  assert.equal(summary.windows.opening.trace.traceQueuedWriteCalls, 14);
  assert.equal(summary.windows.opening.geometryUploadBytes, 65536);
  assert.equal(summary.windows.whole.trace.traceQueuedUploadBytes, 1824);
  assert.equal(summary.windows.whole.maxTraceMetadataBytes, 150801);
});

test('fixed-time windows are half-open and CPU subsets follow positive target deltas', () => {
  const r = run(); r.frames[2].cpuSubmissionMs = 70;
  const w = summarizeTraceRun(r).windows;
  assert.equal(w.opening.frameCount, 2); assert.equal(w.opening.changedTargetCpuSubmissionMs.p95, 2);
  assert.equal(w.lit.frameCount, 1); assert.equal(w.sunOff.frameCount, 1); assert.equal(w.remainder.frameCount, 2);
  assert.equal(w.whole.cpuSubmissionMs.p95, 70); assert.equal(w.whole.changedTargetCpuSubmissionMs.p95, 2);
  assert.equal(w.lit.changedTargetCpuSubmissionMs.p95, null);
});

test('missing GPU/geometry observations stay unavailable and cannot imply numerical acceptance', () => {
  const r = report();
  for (const run of r.runs) for (const frame of run.frames) { frame.gpuSpanMs = null; frame.gpuPasses = {}; }
  delete r.runs[0].assetTraffic.geometryAtCaptureStart;
  const summary = summarizeTracePerformance(r, evidence);
  assert.equal(summary.runs[0].windows.whole.geometryUploadBytes, null);
  assert.equal(summary.runs[0].windows.whole.gpuSpanMs.p95, null);
  assert.equal(summary.comparisons[0].numericalDecision, 'incomplete');
});

test('four-run order and 30/60 timing are required; partial or smoke runs cannot qualify', () => {
  const r = report(); [r.runs[0], r.runs[1]] = [r.runs[1], r.runs[0]];
  assert.throws(() => summarizeTracePerformance(r, evidence), /arm order/);
  assert.throws(() => summarizeTracePerformance({ runs: report().runs.slice(1) }), /four/);
  const smoke = report(); smoke.runs[0].mode = 'smoke';
  assert.throws(() => summarizeTracePerformance(smoke), /smoke/);
  const short = report(); short.runs[0].capture.warmupSeconds = 1;
  assert.throws(() => summarizeTracePerformance(short));
});

test('canonical savings require separate evidenced bytes and cannot be inferred from RAF totals', () => {
  const incomplete = summarizeTracePerformance(report());
  assert.equal(incomplete.comparisons[0].canonicalTraceByteReduction, null);
  assert.equal(incomplete.comparisons[0].numericalDecision, 'incomplete');
  const passed = summarizeTracePerformance(report(), evidence);
  assert.equal(passed.comparisons[0].numericalDecision, 'meets-numerical-thresholds');
  assert.equal(passed.comparisons[0].openingChangedTargetCpuP95Reduction, .5);
  assert.throws(() => summarizeTracePerformance(report(), { canonicalUpdate: { ...evidence.canonicalUpdate, evidenceSha256: 'unknown' } }), /digest/);
  const failed = summarizeTracePerformance(report(), { canonicalUpdate: { ...evidence.canonicalUpdate, incrementalBytes: 40000 } });
  assert.equal(failed.comparisons[0].numericalDecision, 'does-not-meet-numerical-thresholds');
});

test('whole-tour tail or cadence regression remains visible despite opening improvement', () => {
  const r = report(); r.runs[0].frames[5].gpuSpanMs = 20; r.runs[0].frames[5].frameIntervalMs = 40;
  const summary = summarizeTracePerformance(r, evidence);
  assert.equal(summary.comparisons[0].openingChangedTargetCpuP95Reduction, .5);
  assert.equal(summary.comparisons[0].wholeGpuSpanP95Regressed, true);
  assert.equal(summary.comparisons[0].callbackShareAbove20MsRegressed, true);
  assert.equal(summary.comparisons[0].numericalDecision, 'does-not-meet-numerical-thresholds');
});

test('counter resets, unordered frames and unavailable start snapshots are rejected', () => {
  const r = run(); r.frames[1].gi.traceQueuedUploadBytes = 0;
  assert.throws(() => summarizeTraceRun(r), /decreased/);
  const unordered = run(); unordered.frames[1].frameId = unordered.frames[0].frameId;
  assert.throws(() => summarizeTraceRun(unordered), /ordered/);
  const missing = run(); delete missing.assetTraffic.giAtCaptureStart;
  assert.throws(() => summarizeTraceRun(missing), /capture-start/);
});

test('an exact one percentage point cadence increase is at the allowed boundary', () => {
  const r = report();
  for (const run of r.runs) {
    const sample = run.frames[0], slowCount = run.metadata.traceMaintenanceArm === 'incremental' ? 51 : 50;
    run.frames = Array.from({ length: 100 }, (_, i) => ({ ...sample, frameId: 200 + i,
      elapsedMs: i * 600, frameIntervalMs: i < slowCount ? 25 : 16.7 }));
  }
  assert.equal(summarizeTracePerformance(r, evidence).comparisons[0].callbackShareAbove20MsRegressed, false);
  r.runs[0].frames[51].frameIntervalMs = 25;
  assert.equal(summarizeTracePerformance(r, evidence).comparisons[0].callbackShareAbove20MsRegressed, true);
});
