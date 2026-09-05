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
  if (workload.renderer === 'integrated') {
    ensure(run.assetTraffic.externalAssetsUsed === true, `${prefix} integrated fixture must record cooked asset traffic`);
    return; // Its exact motion/door/light schedule is constrained by integratedQuality.
  }
  ensure(run.assetTraffic.externalAssetsUsed === false, `${prefix} GI fixture must not claim external asset traffic`);
  const expected = workload.giScenario === 'static' ? [] : giEvents;
  ensure(quality.events.length === expected.length && expected.every((event, index) => {
    const actual = quality.events[index];
    return Object.keys(actual).length === Object.keys(event).length && Object.entries(event).every(([key, value]) => actual[key] === value);
  }), `${prefix} GI event schedule differs from the declared scenario`);
}

function validateGiFrame(run, frame, prior, prefix) {
  const gi = frame.gi;
  const integrated = run.workload.renderer === 'integrated';
  const reflections = run.workload.renderer === 'reflections' || integrated;
  const composeActive = gi.enabled || (reflections && run.workload.reflectionMode !== 'off');
  const { probesPerUpdate, raysPerProbe } = run.quality;
  const rayBudget = probesPerUpdate * raysPerProbe;
  const rolling = gi.objectMotionRollingRefresh === true;
  ensure(gi.enabled === run.workload.giEnabled && gi.probesPerUpdate === probesPerUpdate && gi.raysPerProbe === raysPerProbe,
    `${prefix} GI enabled state or probe budget differs from its workload`);
  ensure(gi.primaryRaysPerFrame === (gi.enabled ? rayBudget : 0) && gi.maxShadowRaysPerFrame === (gi.enabled ? rayBudget : 0), `${prefix} GI ray budget is inconsistent`);
  ensure(gi.updatePeriodFrames === Math.ceil(384 / probesPerUpdate), `${prefix} GI update period is inconsistent`);
  ensure(gi.probeUpdatesSinceReset === gi.framesSinceReset * probesPerUpdate && gi.primaryRaysSubmitted === gi.submittedFrames * rayBudget,
    `${prefix} GI cumulative work counters are inconsistent`);
  ensure(gi.framesSinceReset <= gi.submittedFrames, `${prefix} GI reset age exceeds submitted work`);
  if ('diffuseInvalidationRevision' in gi) {
    ensure(gi.maxSampleAgeFrames === gi.updatePeriodFrames - 1
      && gi.refreshFrontier === (gi.probeUpdatesSinceReset % 384), `${prefix} GI rolling refresh age/frontier is inconsistent`);
    ensure(gi.enabled ? gi.diffuseInvalidationRevision >= 1 && gi.sampleFrameIndex === frame.frameId - 1
      : gi.diffuseInvalidationRevision === null && gi.sampleFrameIndex === null, `${prefix} GI diffuse revision/sample provenance is inconsistent`);
  }
  // Null means the GPU result has not been read. Never turn that absence into a measured zero.
  ensure(gi.traceFailures === null || gi.traceFailures === 0, `${prefix} records GI traversal failures`);
  if (gi.validProbeCount !== null) ensure(gi.validProbeCount <= Math.min(384, gi.probeUpdatesSinceReset), `${prefix} GI valid-probe count exceeds updated coverage`);
  if (!integrated) ensure(frame.triangleCountSourceFrameId === frame.frameId, `${prefix} GI geometry counters have a mismatched source frame`);
  const dispatches = (gi.enabled ? 2 : 0) + Number(composeActive)
    + (reflections && run.workload.reflectionMode === 'world' ? 1 + Number(frame.reflections.scheduledCandidates > 0) : 0);
  if (!integrated) ensure(frame.drawCalls === 3 + Number(run.workload.temporal) && frame.dispatchCalls === dispatches
    && frame.triangles === (reflections ? 313 : 265) + Number(run.workload.temporal), `${prefix} GI draw/dispatch/triangle counts do not match the fixture`);

  // Match the shared simulation helper's modulo arithmetic at exact event boundaries.
  const phase = integrated ? ((frame.elapsedMs / 1000 % 60) + 60) % 60 : run.workload.giScenario === 'static' ? 0 : Math.floor((frame.elapsedMs / 1000) % 60 / 10);
  ensure(gi.doorOpen === (integrated ? !(phase >= 4 && phase < 8) : phase !== 1)
    && gi.wallColor === (!integrated && phase === 5 ? 'neutral' : 'red')
    && gi.lightIntensity === (integrated ? phase >= 14 && phase < 18 ? 0 : 1 : phase === 3 ? 0.2 : 1), `${prefix} GI world state differs from the scenario at this frame`);
  if (integrated) close(frame.reflections.objectOffset, phase >= 2 && phase < 6 ? 0.4 * Math.sin((phase - 2) * Math.PI / 2) : 0, `${prefix} integrated object motion`);
  if (gi.enabled) {
    ensure(gi.sourceFrameId === frame.frameId && gi.submittedFrames === frame.frameId && gi.framesSinceReset >= 1
      && gi.cacheEpoch === (rolling ? gi.diffuseInvalidationRevision : gi.worldRevision), `${prefix} GI cache epoch or source frame is inconsistent`);
  } else {
    ensure(gi.sourceFrameId === null && gi.submittedFrames === 0 && gi.framesSinceReset === 0 && gi.cacheEpoch === 0,
      `${prefix} disabled GI reports submitted cache work`);
  }
  if (prior) {
    const previous = prior.gi;
    const hardChanged = gi.doorOpen !== previous.doorOpen || gi.wallColor !== previous.wallColor || gi.lightIntensity !== previous.lightIntensity;
    const changed = hardChanged || (integrated && frame.reflections.objectOffset !== prior.reflections.objectOffset);
    ensure(frame.frameId === prior.frameId + 1, `${prefix} GI capture skipped a submitted frame`);
    ensure(gi.worldRevision === previous.worldRevision + Number(changed), `${prefix} GI world revision does not match scene changes`);
    if (gi.enabled) {
      const reset = rolling ? hardChanged : changed;
      ensure(gi.framesSinceReset === (reset ? 1 : previous.framesSinceReset + 1), `${prefix} GI cache age did not reset or advance correctly`);
      if (rolling) ensure(gi.diffuseInvalidationRevision === previous.diffuseInvalidationRevision + Number(hardChanged), `${prefix} GI diffuse invalidation does not match hard scene changes`);
    }
  }
  // Median subdivision with <=4 triangles per leaf: 156 triangles produce 119 nodes.
  const traceBytes = integrated ? 1335 * 32 + 2204 * 64 + 13 * 48 + 6 * 32 + 48 : reflections ? 119 * 32 + 156 * 64 + 13 * 48 + 5 * 32 + 48 : 11392;
  ensure(gi.traceGeometryBytes === traceBytes && gi.cacheBufferBytes === 6368 + rayBudget * 32
    && gi.cacheTextureBytes === 1966080 && gi.composeBufferBytes === 96
    && gi.composeTextureBytes === (composeActive ? run.resolution.width * run.resolution.height * 8 : 0), `${prefix} GI allocation estimates violate the fixed layout`);
  ensure(frame.allocatedGpuBufferBytes >= gi.traceGeometryBytes + gi.cacheBufferBytes + gi.composeBufferBytes
    && frame.allocatedGpuTextureBytes >= gi.cacheTextureBytes + gi.composeTextureBytes, `${prefix} GI resources exceed total tracked allocations`);
}

function validateReflectionFrame(run, frame, prior, prefix) {
  const reflected = frame.reflections; const gi = frame.gi; const quality = run.quality;
  if (run.workload.renderer !== 'integrated') ensure(reflected.objectOffset === 0, `${prefix} fixed reflection benchmark moved its object`);
  const world = quality.reflectionMode === 'world'; const active = world || quality.reflectionMode === 'probe-only' || gi.enabled;
  ensure(run.workload.reflectionMode === quality.reflectionMode && reflected.mode === quality.reflectionMode,
    `${prefix} reflection mode differs from its workload`);
  for (const name of ['resolutionScale', 'maxRaysPerFrame', 'roughness', 'maxDistance', 'updateEvery']) {
    ensure(reflected[name] === quality[name], `${prefix} reflection ${name} differs from its quality setting`);
  }
  ensure(reflected.worldRevision === gi.worldRevision && reflected.giEnabled === gi.enabled,
    `${prefix} reflection world revision or GI state differs from the shared scene`);
  ensure(reflected.actualPrimaryRays === null && reflected.actualShadowRays === null && reflected.traceFailures === null
    && reflected.historyReusedPixels === null, `${prefix} unread reflection GPU counters must remain null`);
  const width = world ? Math.ceil(run.resolution.width * quality.resolutionScale) : 1;
  const height = world ? Math.ceil(run.resolution.height * quality.resolutionScale) : 1;
  ensure(reflected.reflectionWidth === width && reflected.reflectionHeight === height && reflected.gpuBufferBytes === 512
    && reflected.gpuTextureBytes === width * height * 88 && reflected.traceGeometryBytes === gi.traceGeometryBytes
    && reflected.composeBufferBytes === gi.composeBufferBytes && reflected.composeTextureBytes === gi.composeTextureBytes,
  `${prefix} reflection allocation estimates violate the fixed layout`);
  ensure(frame.allocatedGpuBufferBytes >= gi.traceGeometryBytes + gi.cacheBufferBytes + gi.composeBufferBytes + reflected.gpuBufferBytes
    && frame.allocatedGpuTextureBytes >= gi.cacheTextureBytes + gi.composeTextureBytes + reflected.gpuTextureBytes,
  `${prefix} combined reflection resources exceed total tracked allocations`);
  ensure(reflected.candidateRegionPixels <= width * height && reflected.scheduledCandidates <= Math.min(quality.maxRaysPerFrame, reflected.candidateRegionPixels)
    && reflected.maxPrimaryRays === reflected.scheduledCandidates && reflected.maxShadowRays === reflected.scheduledCandidates,
  `${prefix} reflection ray budget or candidate bounds are inconsistent`);
  if (!world) ensure(reflected.scheduledCandidates === 0 && reflected.candidateRegionPixels === 0
    && reflected.traceFrames === 0 && reflected.totalScheduledCandidates === 0, `${prefix} disabled/probe-only reflection mode claims traced work`);
  if (active) {
    ensure(reflected.sourceFrameId === frame.frameId && reflected.submittedFrames === frame.frameId
      && reflected.cacheEpoch >= 1 && reflected.framesSinceReset >= 1 && reflected.framesSinceReset <= reflected.submittedFrames,
    `${prefix} reflection cache epoch, age or source frame is inconsistent`);
    const expectedAge = Math.min(16, Math.max(quality.updateEvery, Math.ceil(reflected.candidateRegionPixels / quality.maxRaysPerFrame) * quality.updateEvery));
    ensure(reflected.maxHistoryAge === expectedAge, `${prefix} reflection history age exceeds its bounded schedule`);
    if (world) {
      const update = (reflected.framesSinceReset - 1) % quality.updateEvery === 0;
      ensure(reflected.scheduledCandidates === (update ? Math.min(quality.maxRaysPerFrame, reflected.candidateRegionPixels) : 0),
        `${prefix} reflection candidate count differs from the update schedule`);
    }
  } else {
    ensure(reflected.sourceFrameId === null && reflected.submittedFrames === 0 && reflected.cacheEpoch === 0
      && reflected.framesSinceReset === 0 && reflected.maxHistoryAge === 16, `${prefix} fully disabled reflections report submitted cache work`);
  }
  ensure(reflected.traceFrames <= reflected.submittedFrames && reflected.totalScheduledCandidates >= reflected.scheduledCandidates
    && reflected.totalScheduledCandidates <= reflected.traceFrames * quality.maxRaysPerFrame,
  `${prefix} reflection cumulative work is inconsistent`);
  if (prior) {
    const previous = prior.reflections;
    ensure(reflected.traceFrames === previous.traceFrames + Number(reflected.scheduledCandidates > 0)
      && reflected.totalScheduledCandidates === previous.totalScheduledCandidates + reflected.scheduledCandidates,
    `${prefix} reflection cumulative work does not match submitted candidates`);
    if (active) {
      const reset = reflected.cacheEpoch === previous.cacheEpoch + 1;
      ensure((reset && reflected.framesSinceReset === 1) || (reflected.cacheEpoch === previous.cacheEpoch
        && reflected.framesSinceReset === previous.framesSinceReset + 1), `${prefix} reflection epoch and age did not advance consistently`);
      if (gi.worldRevision !== prior.gi.worldRevision) ensure(reset, `${prefix} changed reflection world reused an old cache epoch`);
      else if (!['reflections-tour-v1', 'integrated-tour-v1'].includes(run.workload.cameraPath)) ensure(!reset, `${prefix} static reflection camera unexpectedly reset its cache`);
    }
  }
}

function validateIntegratedFrame(run, frame, prefix) {
  const info = frame.integrated; const geometry = frame.geometry; const quality = run.quality;
  ensure(info.cameraPath === run.workload.cameraPath && info.terrainColor === run.workload.terrainColor
    && quality.terrainColor === info.terrainColor && quality.geometryMode === run.workload.geometryMode,
  `${prefix} integrated scene differs from its workload`);
  ensure(Object.entries(info).every(([key, value]) => quality.representation[key] === value), `${prefix} integrated tracing representation changed during capture`);
  close(info.proxyMaxVerticalError, (0.07 * (64 / 3 + 1 / 3) + 0.0001) * 0.125, `${prefix} proxy bound`);
  ensure(info.proxyMeasuredMaxVerticalError <= info.proxyMaxVerticalError, `${prefix} measured proxy error exceeds its bound`);
  const asset = run.metadata.geometryAsset;
  if (asset) ensure(info.proxySourceManifestSha256 === asset.manifestSha256
    && info.proxyPayloadSha256 === asset.traceProxy?.mesh?.sha256, `${prefix} tracing proxy does not match external source metadata`);
  ensure(geometry.cameraPath === run.workload.cameraPath && geometry.geometryMode === quality.geometryMode
    && geometry.sourceSeed === 1337 && geometry.sourceTilesPerSide === 4 && geometry.sourceCellsPerTile === 64
    && geometry.sourceTriangleCount === 131072 && geometry.sourcePageCount === 80 && geometry.sourceRootPageCount === 3
    && geometry.uniqueCompiledBytes === run.workload.uniqueCompiledBytes,
  `${prefix} integrated geometry source changed or differs from the fixture`);
  ensure(geometry.pixelError === quality.pixelError && geometry.pageLoadDelayMs === quality.pageLoadDelayMs,
    `${prefix} integrated geometry budget differs from its quality settings`);
  const mesh = quality.geometryMode === 'mesh-lod';
  if (mesh) ensure(geometry.poolBytes === 0 && geometry.residentPages === 0 && geometry.packedGeometryBytes > 0,
    `${prefix} conventional geometry claims a page pool or lacks packed geometry`);
  else if (quality.geometryMode === 'streamed') ensure(geometry.poolBytes < geometry.uniqueCompiledBytes,
    `${prefix} streamed integrated source must exceed its resident page pool`);
  else ensure(geometry.residentPages === 80 && geometry.capacityPages === 80, `${prefix} resident comparison lacks source pages`);
  const active = frame.gi.enabled || frame.reflections.mode !== 'off'; const world = frame.reflections.mode === 'world';
  const dispatches = Number(!mesh) * 2 + Number(frame.gi.enabled) * 2 + Number(active) + Number(world) + Number(world && frame.reflections.scheduledCandidates > 0);
  ensure(frame.dispatchCalls === dispatches && frame.drawCalls === (mesh ? geometry.visibleTiles + 19 : 5) + Number(run.workload.temporal),
    `${prefix} integrated draw/dispatch counts differ from its submitted providers`);
  ensure(frame.triangles === geometry.selectedTriangles + geometry.shadowTriangles + 313 + Number(run.workload.temporal),
    `${prefix} integrated triangle count does not combine delayed terrain and current room counts`);
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
    const integrated = run.workload.renderer === 'integrated';
    const virtual = run.workload.renderer === 'virtual' || integrated;
    const reflections = run.workload.renderer === 'reflections' || integrated;
    const gi = run.workload.renderer === 'gi' || reflections;
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
      if (reflections) validateReflectionFrame(run, frame, frames[frameIndex - 1], `${prefix}.frames[${frameIndex}]`);
      if (integrated) validateIntegratedFrame(run, frame, `${prefix}.frames[${frameIndex}]`);
      if (frame.gpuSpanMs !== undefined || frame.gpuPassIntervals !== undefined) {
        ensure(frame.gpuPassIntervals !== undefined && frame.gpuSpanMs !== undefined, `${prefix} GPU span requires pass intervals`);
        const intervals = Object.entries(frame.gpuPassIntervals);
        if (frame.gpuMs === null) ensure(frame.gpuSpanMs === null && intervals.length === 0, `${prefix} untimed frame claims a GPU span`);
        else {
          const names = Object.keys(frame.gpuPasses ?? {});
          ensure(frame.gpuSpanMs !== null && intervals.length > 0 && intervals.length === names.length
            && names.every(name => Object.hasOwn(frame.gpuPassIntervals, name)), `${prefix} GPU span lacks complete pass intervals`);
          for (const [name, interval] of intervals) {
            ensure(interval.endMs >= interval.startMs, `${prefix} GPU pass interval is reversed`);
            close(interval.endMs - interval.startMs, frame.gpuPasses[name], `${prefix} GPU pass interval duration`);
          }
          close(Math.min(...intervals.map(([, interval]) => interval.startMs)), 0, `${prefix} GPU interval origin`);
          close(frame.gpuSpanMs, Math.max(...intervals.map(([, interval]) => interval.endMs)), `${prefix} GPU span envelope`);
        }
      }
      if (frame.gpuPasses !== undefined) {
        const entries = Object.entries(frame.gpuPasses);
        if (frame.gpuMs === null) ensure(entries.length === 0, `${prefix} has named timings for an untimed frame`);
        else {
          ensure(entries.length > 0, `${prefix} has no named timings for a timed frame`);
          close(frame.gpuMs, entries.reduce((sum, [, value]) => sum + value, 0), `${prefix} frame pass sum`);
          const expected = run.workload.renderer === 'raster' || virtual || gi ? [
            ...(virtual && run.workload.geometryMode !== 'mesh-lod' ? ['selection'] : []),
            ...(gi && run.workload.giEnabled ? ['gi-trace', 'gi-update'] : []),
            ...(reflections && run.workload.reflectionMode === 'world' ? [
              ...(frame.reflections.scheduledCandidates > 0 ? ['reflection-trace'] : []), 'reflection-resolve',
            ] : []),
            ...(gi && (run.workload.giEnabled || (reflections && run.workload.reflectionMode !== 'off')) ? ['gi-shade'] : []),
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
    if (reflections) ensure(Object.entries(frames.at(-1).reflections).every(([key, value]) => run.allocations.reflections[key] === value),
      `${prefix} final reflection telemetry differs from the last submitted frame`);
    if (integrated) ensure(Object.entries(frames.at(-1).integrated).every(([key, value]) => run.allocations.integrated[key] === value),
      `${prefix} final integrated telemetry differs from the last submitted frame`);
    const intervalTotal = frames.reduce((sum, frame) => sum + frame.frameIntervalMs, 0);
    close(capture.actualDurationMs, intervalTotal, `${prefix} capture duration`);
    ensure(capture.actualDurationMs + 1e-5 >= capture.requestedDurationSeconds * 1000, `${prefix} ended before its requested capture duration`);
    distribution(summary.frameIntervalMs, frames.map(frame => frame.frameIntervalMs), `${prefix}.summary.frameIntervalMs`);
    distribution(summary.cpuSubmissionMs, frames.map(frame => frame.cpuSubmissionMs), `${prefix}.summary.cpuSubmissionMs`);
    distribution(summary.gpuPassMs, gpuValues, `${prefix}.summary.gpuPassMs`);
    if (summary.gpuSpanMs !== undefined || frames.some(frame => frame.gpuSpanMs !== undefined)) {
      ensure(summary.gpuSpanMs !== undefined, `${prefix} GPU span summary is missing`);
      distribution(summary.gpuSpanMs, frames.flatMap(frame => frame.gpuSpanMs == null ? [] : [frame.gpuSpanMs]), `${prefix}.summary.gpuSpanMs`);
    }
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
