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
    ensure(run.workload.seed <= 0xffff_ffff && run.workload.instanceCount >= 1 && run.workload.instanceCount <= 16_384, `${prefix} has an invalid procedural workload`);
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
      ensure(frame.drawCalls > 0 && frame.triangles > 0, `${prefix} contains a frame without procedural geometry`);
      if (frame.gpuPasses !== undefined) {
        const entries = Object.entries(frame.gpuPasses);
        if (frame.gpuMs === null) ensure(entries.length === 0, `${prefix} has named timings for an untimed frame`);
        else {
          ensure(entries.length > 0, `${prefix} has no named timings for a timed frame`);
          close(frame.gpuMs, entries.reduce((sum, [, value]) => sum + value, 0), `${prefix} frame pass sum`);
          const expected = run.workload.renderer === 'raster' ? ['shadow', 'raster', 'presentation', ...(run.workload.temporal ? ['temporal'] : [])] : ['procedural'];
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
