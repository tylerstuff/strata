import assert from 'node:assert/strict';

// Offline analysis only. The runner separately validates source, workload,
// hardware/power, schema, images and cleanup; these numbers are not run admission.
const counters = ['traceUpdateCount', 'traceQueuedUpdateCount', 'traceChangedBoxCount',
  'traceRegeneratedTriangleCount', 'tracePackedTriangleCount', 'traceRefitLeafCount',
  'traceRefitAncestorCount', 'traceAttemptedWriteCalls', 'traceQueuedWriteCalls',
  'traceQueuedUploadBytes', 'traceFullBufferFallbackCount'];
const windows = [['whole', 0, 60000], ['opening', 0, 8000], ['lit', 8000, 14000],
  ['sunOff', 14000, 18000], ['remainder', 18000, 60000]];
const runOrder = [['incremental', 1280, 720], ['full', 1280, 720],
  ['full', 1920, 1080], ['incremental', 1920, 1080]];

function finite(value, label) {
  assert(Number.isFinite(value) && value >= 0, `${label} must be finite and nonnegative`);
  return value;
}
function integer(value, label) {
  assert(Number.isSafeInteger(value) && value >= 0, `${label} must be a nonnegative safe integer`);
  return value;
}
function distribution(values) {
  values.forEach(value => finite(value, 'distribution sample'));
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = q => sorted[Math.ceil(q * sorted.length) - 1] ?? null;
  return { count: values.length, min: sorted[0] ?? null, max: sorted.at(-1) ?? null,
    mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) };
}
function summarizeWindow(frames) {
  const sum = get => frames.reduce((value, frame) => value + get(frame), 0);
  const changed = frames.filter(frame => frame.traceDelta.traceUpdateCount > 0);
  const trace = Object.fromEntries(counters.map(key => [key, integer(sum(frame => frame.traceDelta[key]), key)]));
  const geometryKnown = frames.every(frame => frame.geometryUploadBytes !== null);
  const spans = frames.flatMap(frame => frame.gpuSpanMs == null ? [] : [frame.gpuSpanMs]);
  const passNames = [...new Set(frames.flatMap(frame => Object.keys(frame.gpuPasses ?? {})))].sort();
  return { frameCount: frames.length, changedTargetFrameCount: changed.length,
    changedTargetCount: trace.traceUpdateCount,
    cpuSubmissionMs: distribution(frames.map(frame => frame.cpuSubmissionMs)),
    changedTargetCpuSubmissionMs: distribution(changed.map(frame => frame.cpuSubmissionMs)),
    frameIntervalMs: distribution(frames.map(frame => frame.frameIntervalMs)),
    callbacksAbove20Ms: frames.filter(frame => frame.frameIntervalMs > 20).length,
    callbackShareAbove20Ms: frames.length ? frames.filter(frame => frame.frameIntervalMs > 20).length / frames.length : null,
    gpuSpanMs: distribution(spans), gpuSpanCoverage: frames.length ? spans.length / frames.length : null,
    gpuPasses: Object.fromEntries(passNames.map(pass => [pass, distribution(frames.flatMap(frame =>
      frame.gpuPasses?.[pass] == null ? [] : [frame.gpuPasses[pass]]))])),
    totalUploadBytes: integer(sum(frame => frame.uploadBytes), 'total upload bytes'),
    geometryUploadBytes: geometryKnown ? integer(sum(frame => frame.geometryUploadBytes), 'geometry upload bytes') : null,
    trace, traceBytesPerChangedTarget: trace.traceUpdateCount ? trace.traceQueuedUploadBytes / trace.traceUpdateCount : null,
    maxTrackedGpuBufferBytes: frames.length ? Math.max(...frames.map(frame => frame.allocatedGpuBufferBytes)) : null,
    maxTrackedGpuTextureBytes: frames.length ? Math.max(...frames.map(frame => frame.allocatedGpuTextureBytes)) : null,
    maxTraceMetadataBytes: frames.length ? Math.max(...frames.map(frame => frame.gi.traceMetadataBytes)) : null };
}

export function summarizeTraceRun(run) {
  assert(Array.isArray(run.frames) && run.frames.length, 'measured frames are required');
  assert(run.assetTraffic?.giAtCaptureStart, 'capture-start GI counters are required');
  let previous = run.assetTraffic.giAtCaptureStart;
  let geometryPrevious = run.assetTraffic.geometryAtCaptureStart?.uploadedBytes;
  let previousElapsed = -1, previousId = -1;
  const frames = run.frames.map(frame => {
    integer(frame.frameId, 'frame ID'); finite(frame.elapsedMs, 'elapsedMs');
    assert(frame.frameId > previousId && frame.elapsedMs > previousElapsed && frame.elapsedMs < 60000,
      'frames must be ordered within the measured 60-second window');
    previousId = frame.frameId; previousElapsed = frame.elapsedMs;
    for (const key of ['cpuSubmissionMs', 'frameIntervalMs', 'uploadBytes', 'allocatedGpuBufferBytes', 'allocatedGpuTextureBytes']) finite(frame[key], key);
    finite(frame.gi?.traceMetadataBytes, 'trace metadata bytes');
    const delta = Object.fromEntries(counters.map(key => {
      const before = integer(previous[key], `previous ${key}`), after = integer(frame.gi?.[key], key);
      assert(after >= before, `cumulative ${key} decreased`);
      return [key, after - before];
    }));
    assert(frame.gi.traceQueuedUpdateCount <= frame.gi.traceUpdateCount, 'queued trace target exceeds CPU target');
    previous = frame.gi;
    let geometryUploadBytes = null;
    const current = frame.geometry?.uploadedBytes;
    if (current != null && geometryPrevious != null) {
      integer(current, 'geometry uploaded bytes'); integer(geometryPrevious, 'previous geometry uploaded bytes');
      assert(current >= geometryPrevious, 'cumulative geometry uploaded bytes decreased');
      geometryUploadBytes = current - geometryPrevious;
    }
    geometryPrevious = current;
    return { ...frame, traceDelta: delta, geometryUploadBytes };
  });
  return { arm: run.metadata?.traceMaintenanceArm, resolution: run.resolution,
    windows: Object.fromEntries(windows.map(([name, start, end]) => [name,
      summarizeWindow(frames.filter(frame => frame.elapsedMs >= start && frame.elapsedMs < end))])) };
}

function reduction(candidate, full) {
  return candidate == null || full == null || full <= 0 ? null : 1 - candidate / full;
}
function regression(candidate, full, fraction, absolute) {
  return candidate == null || full == null ? null : candidate - full > Math.max(full * fraction, absolute);
}

/** Practical frozen thresholds only; image/correctness/source/power review remains separate. */
export function summarizeTracePerformance(report, { canonicalUpdate } = {}) {
  assert.equal(report.runs?.length, 4, 'all four frozen runs are required');
  report.runs.forEach((run, i) => {
    const [arm, width, height] = runOrder[i];
    assert.equal(run.metadata?.traceMaintenanceArm, arm, 'frozen arm order differs');
    assert.equal(run.resolution?.width, width); assert.equal(run.resolution?.height, height);
    assert.equal(run.capture?.warmupSeconds, 30); assert.equal(run.capture?.requestedDurationSeconds, 60);
    assert.equal(run.mode, 'performance', 'smoke/sustained runs are not this comparison');
  });
  const runs = report.runs.map(summarizeTraceRun);
  let canonicalReduction = null;
  if (canonicalUpdate !== undefined) {
    integer(canonicalUpdate.incrementalBytes, 'canonical incremental bytes');
    integer(canonicalUpdate.fullBytes, 'canonical full bytes');
    assert(canonicalUpdate.fullBytes > 0 && typeof canonicalUpdate.evidenceSha256 === 'string'
      && /^[0-9a-f]{64}$/.test(canonicalUpdate.evidenceSha256), 'canonical transition needs a nonzero full count and evidence digest');
    canonicalReduction = reduction(canonicalUpdate.incrementalBytes, canonicalUpdate.fullBytes);
  }
  const comparisons = [[0, 1], [3, 2]].map(([candidateIndex, fullIndex]) => {
    const candidate = runs[candidateIndex], full = runs[fullIndex];
    const c = candidate.windows.whole, f = full.windows.whole;
    const openingCpuReduction = reduction(candidate.windows.opening.changedTargetCpuSubmissionMs.p95,
      full.windows.opening.changedTargetCpuSubmissionMs.p95);
    const cpuRegressed = regression(c.cpuSubmissionMs.p95, f.cpuSubmissionMs.p95, .1, .25);
    const gpuRegressed = regression(c.gpuSpanMs.p95, f.gpuSpanMs.p95, .05, .3);
    // Compare integer counts so an exact one-percentage-point boundary does not
    // flip because binary64 subtraction gives 0.010000000000000009.
    const cadenceRegressed = !c.frameCount || !f.frameCount ? null
      : (c.callbacksAbove20Ms * f.frameCount - f.callbacksAbove20Ms * c.frameCount) * 100 > c.frameCount * f.frameCount;
    const complete = [openingCpuReduction, canonicalReduction, cpuRegressed, gpuRegressed, cadenceRegressed].every(value => value !== null);
    const meets = complete && openingCpuReduction >= .25 && canonicalReduction >= .9
      && !cpuRegressed && !gpuRegressed && !cadenceRegressed;
    return { width: candidate.resolution.width, height: candidate.resolution.height,
      openingChangedTargetCpuP95Reduction: openingCpuReduction, canonicalTraceByteReduction: canonicalReduction,
      wholeCpuP95Regressed: cpuRegressed, wholeGpuSpanP95Regressed: gpuRegressed,
      callbackShareAbove20MsRegressed: cadenceRegressed,
      numericalDecision: !complete ? 'incomplete' : meets ? 'meets-numerical-thresholds' : 'does-not-meet-numerical-thresholds' };
  });
  return { kind: 'trace-maintenance-performance-summary-v1', runs, comparisons,
    canonicalUpdate: canonicalUpdate ?? null,
    limitations: [
      'The caller must separately validate exact source, workload, hardware, stable power, errors, images and disposal.',
      'Single opposite-order pairs are practical comparisons, not statistical significance or general hardware claims.',
      'GPU spans/pass intervals exclude some work and may overlap; missing samples stay unavailable. Inspect coverage before accepting a GPU comparison.',
      'Canonical upload savings describe the separately evidenced offset-zero-to-0.4 transition, not every RAF motion update.',
      'Requested GPU allocations and typed trace metadata exclude browser/driver/whole-VRAM/JS-heap overhead; do not add aliased reflection counters.' ] };
}
