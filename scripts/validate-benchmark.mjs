import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const schema = JSON.parse(readFileSync(new URL('../benchmarks/result.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

function ensure(condition, message) {
  if (!condition) throw new Error(`Invalid benchmark report: ${message}`);
}

function close(actual, expected, label) {
  ensure(Number.isFinite(actual) && Number.isFinite(expected)
    && Math.abs(actual - expected) <= 1e-7 * Math.max(1, Math.abs(expected)), `${label} does not match its frame samples`);
}

function distribution(actual, values, label) {
  ensure(actual.count === values.length, `${label}.count does not match its frame samples`);
  const fields = ['min', 'mean', 'p50', 'p95', 'p99', 'max'];
  if (!values.length) {
    ensure(fields.every(field => actual[field] === null), `${label} must report null, not zero, when samples are unavailable`);
    return;
  }
  const ordered = [...values].sort((left, right) => left - right);
  const expected = {
    min: ordered[0], max: ordered.at(-1), mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: ordered[Math.ceil(values.length * 0.5) - 1],
    p95: ordered[Math.ceil(values.length * 0.95) - 1],
    p99: ordered[Math.ceil(values.length * 0.99) - 1],
  };
  for (const field of fields) close(actual[field], expected[field], `${label}.${field}`);
}

const giEvents = [
  { atSeconds: 10, doorOpen: false }, { atSeconds: 20, doorOpen: true }, { atSeconds: 30, lightIntensity: 0.2 },
  { atSeconds: 40, lightIntensity: 1 }, { atSeconds: 50, wallColor: 'neutral' },
];

function validateGiWorkload(run, prefix) {
  const { workload, quality } = run;
  ensure(workload.giEnabled === quality.giEnabled && workload.giScenario === quality.giScenario, `${prefix} GI quality differs from its workload`);
  ensure(run.assetTraffic.externalAssetsUsed === false, `${prefix} GI fixture must not claim external asset traffic`);
  const expected = workload.giScenario === 'static' ? [] : giEvents;
  ensure(quality.events.length === expected.length && expected.every((event, index) => {
    const actual = quality.events[index];
    return Object.keys(actual).length === Object.keys(event).length && Object.entries(event).every(([key, value]) => actual[key] === value);
  }), `${prefix} GI event schedule differs from the declared scenario`);
}

function validateGiFrame(run, frame, prior, prefix) {
  const gi = frame.gi;
  const { probesPerUpdate, raysPerProbe } = run.quality;
  const rayBudget = probesPerUpdate * raysPerProbe;
  ensure(gi.enabled === run.workload.giEnabled && gi.probesPerUpdate === probesPerUpdate && gi.raysPerProbe === raysPerProbe,
    `${prefix} GI enabled state or probe budget differs from its workload`);
  ensure(gi.primaryRaysPerFrame === (gi.enabled ? rayBudget : 0) && gi.maxShadowRaysPerFrame === (gi.enabled ? rayBudget : 0), `${prefix} GI ray budget is inconsistent`);
  ensure(gi.updatePeriodFrames === Math.ceil(384 / probesPerUpdate), `${prefix} GI update period is inconsistent`);
  ensure(gi.probeUpdatesSinceReset === gi.framesSinceReset * probesPerUpdate && gi.primaryRaysSubmitted === gi.submittedFrames * rayBudget,
    `${prefix} GI cumulative work counters are inconsistent`);
  ensure(gi.framesSinceReset <= gi.submittedFrames, `${prefix} GI reset age exceeds submitted work`);
  // Null means the GPU result has not been read. Never turn that absence into a measured zero.
  ensure(gi.traceFailures === null || gi.traceFailures === 0, `${prefix} records GI traversal failures`);
  if (gi.validProbeCount !== null) ensure(gi.validProbeCount <= Math.min(384, gi.probeUpdatesSinceReset), `${prefix} GI valid-probe count exceeds updated coverage`);
  ensure(frame.triangleCountSourceFrameId === frame.frameId, `${prefix} GI geometry counters have a mismatched source frame`);
  ensure(frame.drawCalls === (run.workload.temporal ? 4 : 3) && frame.dispatchCalls === (gi.enabled ? 3 : 0)
    && frame.triangles === 265 + Number(run.workload.temporal), `${prefix} GI draw/dispatch/triangle counts do not match the fixture`);

  const phase = run.workload.giScenario === 'static' ? 0 : Math.floor((frame.elapsedMs / 1000) % 60 / 10);
  ensure(gi.doorOpen === (phase !== 1) && gi.wallColor === (phase === 5 ? 'neutral' : 'red')
    && gi.lightIntensity === (phase === 3 ? 0.2 : 1), `${prefix} GI world state differs from the scenario at this frame`);
  if (gi.enabled) {
    ensure(gi.sourceFrameId === frame.frameId && gi.submittedFrames === frame.frameId && gi.framesSinceReset >= 1
      && gi.cacheEpoch === gi.worldRevision, `${prefix} GI cache epoch or source frame is inconsistent`);
  } else {
    ensure(gi.sourceFrameId === null && gi.submittedFrames === 0 && gi.framesSinceReset === 0 && gi.cacheEpoch === 0,
      `${prefix} disabled GI reports submitted cache work`);
  }
  if (prior) {
    const previous = prior.gi;
    const changed = gi.doorOpen !== previous.doorOpen || gi.wallColor !== previous.wallColor || gi.lightIntensity !== previous.lightIntensity;
    ensure(frame.frameId === prior.frameId + 1, `${prefix} GI capture skipped a submitted frame`);
    ensure(gi.worldRevision === previous.worldRevision + Number(changed), `${prefix} GI world revision does not match scene changes`);
    if (gi.enabled) ensure(gi.framesSinceReset === (changed ? 1 : previous.framesSinceReset + 1), `${prefix} GI cache age did not reset or advance correctly`);
  }
  ensure(gi.traceGeometryBytes === 11392 && gi.cacheBufferBytes === 6368 + rayBudget * 32
    && gi.cacheTextureBytes === 1966080 && gi.composeBufferBytes === 96
    && gi.composeTextureBytes === (gi.enabled ? run.resolution.width * run.resolution.height * 8 : 0), `${prefix} GI allocation estimates violate the fixed layout`);
  ensure(frame.allocatedGpuBufferBytes >= gi.traceGeometryBytes + gi.cacheBufferBytes + gi.composeBufferBytes
    && frame.allocatedGpuTextureBytes >= gi.cacheTextureBytes + gi.composeTextureBytes, `${prefix} GI resources exceed total tracked allocations`);
}

/** Validate a completed session and the relationships JSON Schema cannot express. */
export function validateBenchmarkReport(report) {
  ensure(!Object.hasOwn(report ?? {}, 'failure'), 'the session records a failure');
  if (!validateSchema(report)) {
    throw new Error(`Invalid benchmark report schema: ${ajv.errorsText(validateSchema.errors, { separator: '; ' })}`);
  }
  if (report.mode !== 'smoke') {
    ensure(report.browser.headed === true && report.browser.softwareGpu === false, 'performance evidence must use a headed hardware browser');
  }
  for (let index = 0; index < report.runs.length; index++) {
    const run = report.runs[index];
    const prefix = `runs[${index}]`;
    const { frames, summary, capture, profiling } = run;
    ensure(run.mode === report.mode, `${prefix} mode differs from the session`);
    ensure((run.resolution.width === 1280 && run.resolution.height === 720)
      || (run.resolution.width === 1920 && run.resolution.height === 1080), `${prefix} has a mismatched resolution pair`);
    const virtual = run.workload.renderer === 'virtual';
    const gi = run.workload.renderer === 'gi';
    ensure(run.workload.seed <= 0xffff_ffff && (virtual || gi ? run.workload.instanceCount === 0
      : run.workload.instanceCount >= 1 && run.workload.instanceCount <= 16_384), `${prefix} has an invalid procedural workload`);
    if (virtual) {
      ensure(['streamed', 'resident-lod', 'resident-full', 'mesh-lod'].includes(run.workload.geometryMode), `${prefix} has an unknown geometry mode`);
      ensure(run.workload.externalAssetsUsed === true && run.assetTraffic.externalAssetsUsed === true, `${prefix} must identify cooked asset traffic`);
      ensure(run.workload.sourceTriangleCount > 0 && run.workload.uniqueCompiledBytes > 0, `${prefix} is missing unique geometry quantities`);
      ensure(run.allocations.geometry?.pendingFeedbackFrames === 0, `${prefix} has undrained geometry feedback`);
    }
    if (gi) validateGiWorkload(run, prefix);
    ensure(capture.warmupSeconds <= 600 && capture.requestedDurationSeconds > 0 && capture.requestedDurationSeconds <= 1800, `${prefix} has an invalid capture duration`);
    ensure(frames.length > 0 && capture.frameCount === frames.length, `${prefix} frame count differs from its capture`);
    ensure(!capture.visibilityChanges.some(change => change.state !== 'visible'), `${prefix} was hidden during measurement`);
    ensure((run.allocations.gpuErrorCount ?? 0) === 0, `${prefix} records GPU errors`);
    ensure(profiling.pendingGpuSamples === 0 && run.allocations.pendingGpuSamples === 0, `${prefix} has undrained GPU timing samples`);
    if (report.mode !== 'smoke') {
      ensure(run.adapter.isFallbackAdapter !== true && !/swiftshader|llvmpipe|software rasterizer|software adapter/i.test(JSON.stringify(run.adapter)), `${prefix} used a software/fallback adapter`);
    }
    if (run.runner) ensure(run.runner.captureValidation?.passed === true, `${prefix} failed screenshot validation`);
    const gpuValues = frames.flatMap(frame => frame.gpuMs === null ? [] : [frame.gpuMs]);
    ensure(profiling.capturedGpuSamples === gpuValues.length, `${prefix} GPU sample count is inconsistent`);
    if (profiling.timedFrameCount !== undefined) ensure(profiling.timedFrameCount === gpuValues.length, `${prefix} timed frame count is inconsistent`);
    if (profiling.capturedPassSampleCount !== undefined) ensure(profiling.capturedPassSampleCount === Object.values(run.gpuPasses).reduce((sum, pass) => sum + pass.sampleCount, 0), `${prefix} pass sample count is inconsistent`);
    const namedPasses = new Map();
    if (!profiling.gpuTimestampAvailable) {
      ensure(gpuValues.length === 0 && Object.keys(run.gpuPasses).length === 0, `${prefix} claims GPU measurements without available timestamps`);
    }
    close(frames[0].elapsedMs, 0, `${prefix} first frame start`);
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
      const frame = frames[frameIndex];
      ensure(frame.frameIntervalMs > 0, `${prefix} contains an empty frame interval`);
      ensure(frame.drawCalls > 0 && (frame.triangles > 0 || (virtual && frame.triangleCountSourceFrameId === null)), `${prefix} contains a frame without procedural geometry`);
      if (virtual) {
        const geometry = frame.geometry;
        ensure(geometry && frame.triangleCountSourceFrameId === geometry.sourceFrameId, `${prefix} geometry counters lack a matching source frame`);
        ensure(geometry.sourceFrameId === null || (Number.isInteger(geometry.sourceFrameId) && geometry.sourceFrameId >= 0 && geometry.sourceFrameId <= frame.frameId), `${prefix} geometry counters claim a future frame`);
        ensure(geometry.coverageMissingTiles === 0 && geometry.overflowCount === 0, `${prefix} records incomplete geometry coverage or overflow`);
        ensure(geometry.residentPages >= geometry.rootPages && geometry.residentPages <= geometry.capacityPages
          && geometry.capacityPages * geometry.pageBytes === geometry.poolBytes, `${prefix} violates geometry page residency bounds`);
        if (run.workload.geometryMode === 'streamed') ensure(geometry.poolBytes <= run.quality.poolBytes, `${prefix} exceeds its configured geometry pool`);
      }
      if (gi) validateGiFrame(run, frame, frames[frameIndex - 1], `${prefix}.frames[${frameIndex}]`);
      if (frame.gpuPasses !== undefined) {
        const entries = Object.entries(frame.gpuPasses);
        if (frame.gpuMs === null) ensure(entries.length === 0, `${prefix} has named timings for an untimed frame`);
        else {
          ensure(entries.length > 0, `${prefix} has no named timings for a timed frame`);
          close(frame.gpuMs, entries.reduce((sum, [, value]) => sum + value, 0), `${prefix} frame pass sum`);
          const expected = run.workload.renderer === 'raster' || virtual || gi ? [
            ...(virtual && run.workload.geometryMode !== 'mesh-lod' ? ['selection'] : []),
            ...(gi && run.workload.giEnabled ? ['gi-trace', 'gi-update', 'gi-shade'] : []),
            'shadow', 'raster', 'presentation', ...(run.workload.temporal ? ['temporal'] : []),
          ] : ['procedural'];
          ensure(entries.length === expected.length && expected.every(name => Object.hasOwn(frame.gpuPasses, name)), `${prefix} contains incomplete frame pass timings`);
        }
        for (const [name, value] of entries) {
          const values = namedPasses.get(name) ?? [];
          values.push(value);
          namedPasses.set(name, values);
        }
      }
      if (frameIndex > 0) {
        const prior = frames[frameIndex - 1];
        ensure(frame.frameId > prior.frameId, `${prefix} frame IDs are not strictly increasing`);
        close(frame.elapsedMs, prior.elapsedMs + prior.frameIntervalMs, `${prefix} frame ${frameIndex} callback alignment`);
      }
    }
    if (gi) {
      const final = frames.at(-1).gi;
      ensure(Object.entries(final).every(([key, value]) => run.allocations.gi[key] === value), `${prefix} final GI telemetry differs from the last submitted frame`);
      ensure(Object.keys(run.gpuPasses).length === namedPasses.size, `${prefix} GI pass summaries contain measurements absent from captured frames`);
    }
    const intervalTotal = frames.reduce((sum, frame) => sum + frame.frameIntervalMs, 0);
    close(capture.actualDurationMs, intervalTotal, `${prefix} capture duration`);
    ensure(capture.actualDurationMs + 1e-5 >= capture.requestedDurationSeconds * 1000, `${prefix} ended before its requested capture duration`);
    distribution(summary.frameIntervalMs, frames.map(frame => frame.frameIntervalMs), `${prefix}.summary.frameIntervalMs`);
    distribution(summary.cpuSubmissionMs, frames.map(frame => frame.cpuSubmissionMs), `${prefix}.summary.cpuSubmissionMs`);
    distribution(summary.gpuPassMs, gpuValues, `${prefix}.summary.gpuPassMs`);
    close(summary.meanCallbackCadenceFps, 1000 / summary.frameIntervalMs.mean, `${prefix} callback cadence`);
    close(summary.targetFrameIntervalMs, 1000 / 60, `${prefix} target frame interval`);
    ensure(summary.framesAbove20Ms === frames.filter(frame => frame.frameIntervalMs > 20).length, `${prefix} slow-frame count is inconsistent`);
    for (const key of ['drawCalls', 'dispatchCalls', 'uploadBytes']) {
      ensure(summary[key] === frames.reduce((sum, frame) => sum + frame[key], 0), `${prefix} ${key} summary is inconsistent`);
    }
    ensure(run.assetTraffic.steadyUploadBytes === summary.uploadBytes, `${prefix} capture upload traffic differs from its frame samples`);
    ensure(summary.maxTrackedGpuBufferBytes === frames.reduce((maximum, frame) => Math.max(maximum, frame.allocatedGpuBufferBytes), 0), `${prefix} buffer allocation maximum is inconsistent`);
    ensure(summary.maxTrackedGpuTextureBytes === frames.reduce((maximum, frame) => Math.max(maximum, frame.allocatedGpuTextureBytes), 0), `${prefix} texture allocation maximum is inconsistent`);
    close(Object.values(run.gpuPasses).reduce((sum, pass) => sum + pass.totalMs, 0), gpuValues.reduce((sum, value) => sum + value, 0), `${prefix} GPU pass totals`);
    ensure(Object.values(run.gpuPasses).reduce((sum, pass) => sum + pass.sampleCount, 0) >= gpuValues.length, `${prefix} has fewer pass samples than timed frames`);
    for (const [name, values] of namedPasses) {
      const pass = run.gpuPasses[name];
      ensure(pass && pass.sampleCount === values.length, `${prefix} named pass coverage differs from frames`);
      distribution(pass, values, `${prefix}.gpuPasses.${name}`);
      close(pass.totalMs, values.reduce((sum, value) => sum + value, 0), `${prefix} named pass total`);
    }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/validate-benchmark.mjs /external/path/report.json');
    const report = validateBenchmarkReport(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(`Valid ${report.mode} session: ${report.runs.length} run(s), ${report.runs.reduce((sum, run) => sum + run.frames.length, 0)} frames.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
