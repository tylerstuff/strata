import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBenchmarkAppGraph, assertMeasuredControlCode, assertMeasuredModuleGraph, assertTraceCorrectnessReceipt, assertTraceSource, buildTracePerformanceApp, buildTracePerformancePackages,
  frozenTraceRoute, loadTracePerformanceManifest, parseTracePerformanceArguments, traceCanonicalReceipt,
  TRACE_CAPTURE_TIMES, TRACE_GPU_DEADLINE_MS, TRACE_PERFORMANCE_OPTIONS, TRACE_PERFORMANCE_RUNS, verifyTraceFile } from './trace-performance-bundles.mjs';
import { newExternalDirectory, proofHash } from './test-trace-updates.mjs';
import { assertTracePower, completeTraceCaptureRecord, validatePendingTraceRun, withTracePerformanceDeadline } from './run-benchmark.mjs';
import { validateBenchmarkReport } from './validate-benchmark.mjs';

const commit = 'a'.repeat(40), digest = 'b'.repeat(64), proofDigest = 'c'.repeat(64);
const updater = 'packages/core/src/gi/trace-updates.ts', helper = 'tests/helpers/full-trace-performance-updater.ts';
function manifest() {
  return { schemaVersion: 1, kind: 'strata-trace-maintenance-frozen-performance', source: { commit, status: '' },
    control: { id: 'full-performance', helper: { path: helper, sha256: digest } },
    options: TRACE_PERFORMANCE_OPTIONS, runs: TRACE_PERFORMANCE_RUNS, captureTimes: TRACE_CAPTURE_TIMES, gpuDeadlineMs: TRACE_GPU_DEADLINE_MS,
    app: { files: [{ name: 'app/index.html', url: '/', bytes: 1, sha256: digest }, { name: 'app/app.js', url: '/benchmarks/browser/app.js', bytes: 1, sha256: digest }] },
    bundles: Object.fromEntries(['incremental', 'full'].map(arm => [arm, { files: ['index.js', 'worker.js', 'strata_runtime.wasm', 'chunk-frozen.js'].map(name =>
      ({ name: `${arm}/${name}`, url: `/packages/core/dist/${name}`, sha256: digest, bytes: 1 })) }])),
    assets: { files: [{ name: 'fixture/pages/000001.bin', bytes: 65536, sha256: digest }] } };
}
const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'strata-trace-perf-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test('fixed CLI disallows workload overrides, ambiguous modes, duplicates and missing frozen identities', () => {
  assert.deepEqual(parseTracePerformanceArguments(['--trace-prepare-only', '--commit', commit, '--asset-root', '/assets', '--output', '/results']),
    { 'trace-prepare-only': true, commit, 'asset-root': '/assets', output: '/results' });
  const run = ['--trace-performance', '--manifest', '/manifest', '--manifest-sha256', digest, '--output', '/results',
    '--correctness-report', '/proof', '--correctness-report-sha256', digest, '--correctness-manifest', '/pm', '--correctness-manifest-sha256', proofDigest];
  assert.equal(parseTracePerformanceArguments(run)['trace-performance'], true);
  for (const extra of [['--duration', '5'], ['--renderer', 'gi'], ['--trace-prepare-only'], ['--output', '/other'], ['--asset-root', '/other']]) assert.throws(() => parseTracePerformanceArguments([...run, ...extra]));
  assert.throws(() => parseTracePerformanceArguments(run.slice(0, -2)));
  assert.throws(() => parseTracePerformanceArguments(['--trace-performance']));
});
test('admission requires exact clean SHA including untracked files', () => {
  assert.doesNotThrow(() => assertTraceSource({ commit, status: '' }, commit));
  for (const status of ['?? unexpected.ts', ' M source.ts', null]) assert.throws(() => assertTraceSource({ commit, status }, commit));
  assert.throws(() => assertTraceSource({ commit: 'd'.repeat(40), status: '' }, commit));
  assert.throws(() => assertTraceSource({ commit, status: '' }, commit.slice(0, 7)));
});
test('order and workload are fixed; the two resolutions reverse arm order', () => {
  assert.deepEqual(TRACE_PERFORMANCE_RUNS.map(r => [r.arm, r.width, r.height]), [['incremental', 1280, 720], ['full', 1280, 720], ['full', 1920, 1080], ['incremental', 1920, 1080]]);
  assert.deepEqual(TRACE_CAPTURE_TIMES, [0, 3, 5, 16, 32]);
  assert.equal(TRACE_PERFORMANCE_OPTIONS.warmupSeconds, 30); assert.equal(TRACE_PERFORMANCE_OPTIONS.durationSeconds, 60);
  assert.equal(TRACE_PERFORMANCE_OPTIONS.poolBytes, 1048576); assert.equal(TRACE_PERFORMANCE_OPTIONS.reflectionMaxDistance, 16);
  assert.throws(() => { TRACE_PERFORMANCE_RUNS[0].height = 10; }); assert.throws(() => { TRACE_PERFORMANCE_OPTIONS.seed = 0; });
});
test('routes serve only the chosen frozen package, exact app and canonical asset allowlist', () => {
  const m = manifest();
  assert.equal(frozenTraceRoute(m, 'full', '/packages/core/dist/worker.js').name, 'full/worker.js');
  assert.equal(frozenTraceRoute(m, 'incremental', '/packages/core/dist/worker.js').name, 'incremental/worker.js');
  assert.equal(frozenTraceRoute(m, 'full', '/fixture'), null);
  assert.equal(frozenTraceRoute(m, 'full', '/external-assets/fixture/pages/000001.bin').kind, 'asset');
  for (const path of ['/packages/core/src/index.ts', '/packages/core/dist/unfrozen.js', '/packages/core/dist/index.js?cache=1',
    '/packages/core/dist/../index.js', '/packages/core/dist/%69ndex.js', '/external-assets/fixture/pages/000002.bin', '//packages/core/dist/index.js', '/packages\\core\\dist\\index.js']) {
    assert.equal(frozenTraceRoute(m, 'full', path), null, path);
  }
  assert.throws(() => frozenTraceRoute(m, 'full-correctness-only', '/'));
});
test('module graph permits exactly one substitution and excludes correctness dependencies', () => {
  const base = { [updater]: { source: updater, sha256: digest }, 'packages/core/src/profiling/gpu-profiler.ts': { source: 'packages/core/src/profiling/gpu-profiler.ts', sha256: digest } };
  assertMeasuredModuleGraph(base, [], 'incremental');
  const full = { ...base, [updater]: { source: helper, sha256: digest } };
  const swaps = [{ requested: updater, source: helper, sha256: digest }]; assertMeasuredModuleGraph(full, swaps, 'full');
  assert.throws(() => assertMeasuredModuleGraph(full, swaps, 'incremental'));
  assert.throws(() => assertMeasuredModuleGraph({ ...full, 'tests/helpers/gi-trace-update-reference.ts': { source: 'tests/helpers/gi-trace-update-reference.ts', sha256: digest } }, swaps, 'full'));
  assert.throws(() => assertMeasuredModuleGraph({ ...full, [updater]: { source: 'tests/helpers/full-trace-updater.ts', sha256: digest } }, swaps, 'full'));
  assert.throws(() => assertMeasuredModuleGraph(full, [...swaps, swaps[0]], 'full'));
  for (const code of ['const n = BigInt(1);', 'const n = 1n;', 'await buffer.mapAsync(1);', 'readBuffer(device,b);', 'traceGiBruteForce(scene,ray);']) assert.throws(() => assertMeasuredControlCode(code));
  assertMeasuredControlCode('const residual = a - (sum - b); queue.writeBuffer(buffer,0,bytes);');
});
test('artifact byte and reviewed-manifest tampering fail before any launch', async t => {
  const dir = await temp(t), path = join(dir, 'manifest.json');
  await writeFile(path, JSON.stringify(manifest()));
  const bytes = await readFile(path), expected = { sha256: proofHash(bytes), bytes: bytes.length };
  await verifyTraceFile(path, expected);
  await loadTracePerformanceManifest({ manifestPath: path, manifestSha256: expected.sha256 });
  const changed = manifest(); changed.runs = [...TRACE_PERFORMANCE_RUNS].reverse(); await writeFile(path, JSON.stringify(changed));
  await assert.rejects(loadTracePerformanceManifest({ manifestPath: path, manifestSha256: expected.sha256 }), /SHA256 mismatch/);
  await assert.rejects(loadTracePerformanceManifest({ manifestPath: path, manifestSha256: proofHash(await readFile(path)) }));
  await assert.rejects(verifyTraceFile(path, expected));
  await writeFile(path, Buffer.from(bytes).fill(0)); await assert.rejects(verifyTraceFile(path, expected), /Frozen bytes changed/);
});
test('external outputs reject other Git worktrees, symlinked ancestors and existing evidence', async t => {
  const dir = await temp(t), repo = join(dir, 'other'); await mkdir(repo); await writeFile(join(repo, '.git'), 'gitdir: /irrelevant');
  await assert.rejects(newExternalDirectory(join(repo, 'evidence')), /outside every Git worktree/);
  const alias = join(dir, 'alias'); await symlink(repo, alias); await assert.rejects(newExternalDirectory(join(alias, 'evidence')), /outside every Git worktree/);
  const output = await newExternalDirectory(join(dir, 'external')); await assert.rejects(newExternalDirectory(output), /EEXIST/);
});
function receipt() {
  const m = manifest(), fullControl = m.control;
  const counts = { gi: { steps: 62, submissions: 59, checkpoints: 21 }, reflections: { steps: 63, submissions: 60, checkpoints: 22 }, integrated: { steps: 63, submissions: 60, checkpoints: 22 } };
  const rendererPlan = { exactCounts: counts, streamedChurn: 'skip-unchanged-candidate-only', steps: {} };
  const pairs = Object.entries(counts).map(([kind, count]) => {
    const steps = Array.from({ length: count.steps }, (_, i) => ({ id: `${kind}-${i}`, action: i < count.submissions ? 'submit' : 'cancel', checkpoint: i < count.checkpoints }));
    rendererPlan.steps[kind] = steps;
    return { kind, writeLogs: { candidate: [], full: [] }, frames: steps.map(step => {
      const arm = { id: step.id, action: step.action, submitted: step.action === 'submit', captured: step.checkpoint,
        cpuTrace: Array(5).fill({ bytes: 4, sha256: digest }), gpuTrace: Array(5).fill({ bytes: 4, sha256: digest }), textures: step.checkpoint ? { hdr: { bytes: 8, sha256: digest } } : {} };
      return { step, candidate: structuredClone(arm), full: structuredClone(arm) };
    }) };
  });
  return { measured: m, proof: { runnable: true, correctnessOnly: true, source: m.source, fullControl },
    rendererPlan,
    report: { status: 'pass', requestedAdapter: 'hardware', sourceGuard: 'unchanged', manifest: { sha256: proofDigest }, fullControl, browserErrors: [],
      cleanup: { browser: { status: 'fulfilled' }, server: { status: 'fulfilled' } },
      result: { status: 'pass', adapter: { isFallbackAdapter: false, description: 'test hardware' }, errors: [], cleanup: { errors: [] },
        stages: { A: { status: 'passed', fullControl: 'full-performance', failures: [], cleanup: { createdBuffers: 2, destroyedBuffers: 2, liveArms: 0 } },
          BC: { status: 'passed', plan: structuredClone(rendererPlan), pairs, streamed: { status: 'skipped' }, cleanup: Array.from({ length: 6 }, () => ({ after: { buffers: 0, textures: 0 } })) } } } } };
}
test('receipt requires matched source/control, both completed stages, errors and cleanup', () => {
  const check = data => assertTraceCorrectnessReceipt(data.report, data.proof, data.measured, proofDigest, data.rendererPlan);
  check(receipt());
  for (const mutate of [d => { d.report.fullControl.id = 'full-correctness-only'; }, d => { d.proof.source = { commit: 'd'.repeat(40), status: '' }; },
    d => { d.report.result.stages.BC.status = 'running'; }, d => { d.report.result.stages.A.cleanup.liveArms = 1; },
    d => { d.report.browserErrors.push('late error'); }, d => { d.report.cleanup.server.status = 'rejected'; }, d => { d.report.finalizationFailure = 'late source drift'; },
    d => { d.report.result.stages.A.fullControl = 'full-correctness-only'; }, d => { d.report.manifest.sha256 = digest; },
    d => { d.report.requestedAdapter = 'software'; }, d => { d.report.result.adapter.isFallbackAdapter = true; },
    d => { delete d.report.result.adapter.isFallbackAdapter; }, d => { d.report.result.adapter.description = 'SwiftShader'; },
    d => { d.report.result.stages.BC.pairs.pop(); }, d => { d.report.result.stages.BC.pairs[0].frames.pop(); },
    d => { d.report.result.stages.BC.pairs[0].frames[0].candidate.captured = false; },
    d => { d.report.result.stages.BC.pairs[0].frames[0].candidate.textures = {}; },
    d => { d.report.result.stages.BC.plan.steps.gi[0].id = 'changed'; },
    d => { d.report.result.stages.BC.cleanup[0].after.buffers = 1; }]) {
    const data = structuredClone(receipt()); mutate(data); assert.throws(() => check(data));
  }
});
test('canonical byte reduction comes from returned GPU writes and the matching flush totals', () => {
  const writes = [];
  const step = 'fresh-canonical-plus-point4';
  for (const [arm, sizes] of [['incremental', [32, 32, 32, 192, 64, 512, 48]], ['full-performance', [42720, 141056, 624, 192, 48]]]) {
    sizes.forEach((bytes, buffer) => writes.push({ step, arm, bytes, buffer, offset: 0, returned: true }));
  }
  const report = { result: { stages: { A: { writes, cases: [{ step, states: [{ arm: 'incremental', result: { uploadBytes: 912, writeCalls: 7 } }, { arm: 'full-performance', result: { uploadBytes: 184640, writeCalls: 5 } }] }] } } } };
  assert.equal(traceCanonicalReceipt(report, digest).fullBytes, 184640);
  writes[0].returned = false; assert.throws(() => traceCanonicalReceipt(report, digest)); writes[0].returned = true;
  writes[0].bytes++; assert.throws(() => traceCanonicalReceipt(report, digest));
});
test('stable battery is accepted; profile changes and thermal limits are rejected', () => {
  const snapshot = { source: 'Battery Power', lowPowerMode: { 'Battery Power': 0 }, thermal: { noThermalWarningRecorded: true, noPerformanceWarningRecorded: true, limits: {} } };
  const profile = assertTracePower(snapshot); assertTracePower(snapshot, profile);
  assert.throws(() => assertTracePower({ ...snapshot, source: 'AC Power', lowPowerMode: { 'AC Power': 0 } }, profile));
  assert.throws(() => assertTracePower({ ...snapshot, lowPowerMode: { 'Battery Power': 1 } }, profile));
  assert.throws(() => assertTracePower({ ...snapshot, thermal: { ...snapshot.thermal, limits: { CPU_Speed_Limit: 75 } } }));
  assert.throws(() => assertTracePower({ ...snapshot, thermal: null }));
});
test('actual production package builds differ only in the control source, keeping worker and WASM identities', async t => {
  const directory = await temp(t);
  // This build test does not execute a worker; a minimal valid WASM header is an opaque copied artifact.
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const bundles = await buildTracePerformancePackages(directory, wasm);
  assert.equal(bundles.full.substitutions.length, 1); assert.equal(bundles.incremental.substitutions.length, 0);
  assert.notEqual(bundles.full.modules[updater].sha256, bundles.incremental.modules[updater].sha256);
  for (const bundle of Object.values(bundles)) {
    assert(bundle.files.some(item => item.url === '/packages/core/dist/index.js'));
    for (const item of bundle.files) await verifyTraceFile(join(directory, item.name), item);
    const code = (await Promise.all(bundle.files.filter(item => item.name.endsWith('.js')).map(item => readFile(join(directory, item.name), 'utf8')))).join('\n');
    assert(!code.includes('traceGiBruteForce(')); assert(!code.includes('conservativeFullNodeReference('));
    assert(!code.includes('tests/helpers/full-trace-updater.ts'));
  }
});
test('actual benchmark app keeps only its original scenario closure and imports Engine externally', async t => {
  const directory = await temp(t);
  const app = await buildTracePerformanceApp(directory);
  for (const item of [...app.files, app.graph]) await verifyTraceFile(join(directory, item.name), item);
  const graph = JSON.parse(await readFile(join(directory, app.graph.name), 'utf8'));
  assert.deepEqual(assertBenchmarkAppGraph(graph), app.moduleContract);
  assert.equal(app.moduleContract.scanned.length, 11); assert.equal(app.moduleContract.emitted.length, 5);
  assert.deepEqual(app.moduleContract.emitted.filter(path => path.startsWith('packages/')), ['packages/core/src/integrated/integrated-scene.ts']);
  const scriptPath = Object.keys(graph.outputs).find(path => path.endsWith('.js'));
  for (const mutate of [
    g => { g.inputs['packages/core/src/engine.ts'] = { bytes: 1, imports: [] }; },
    g => { g.inputs['tests/helpers/full-trace-updater.ts'] = { bytes: 1, imports: [] }; },
    g => { g.inputs['benchmarks/src/unreviewed.ts'] = { bytes: 1, imports: [] }; },
    g => { g.outputs[scriptPath].inputs['packages/core/src/errors.ts'] = { bytesInOutput: 1 }; },
    g => { g.outputs[scriptPath].inputs['packages/core/src/gi/trace-updates.ts'] = { bytesInOutput: 1 }; },
    g => { g.outputs[scriptPath].inputs['packages/core/src/integrated/integrated-renderer.ts'] = { bytesInOutput: 1 }; },
    g => { g.outputs[scriptPath].imports = []; },
    g => { g.outputs[scriptPath].imports[0].external = false; },
    g => { g.outputs[scriptPath].imports[0].path = '@strata-engine/core/unreviewed'; },
  ]) {
    const changed = structuredClone(graph); mutate(changed); assert.throws(() => assertBenchmarkAppGraph(changed));
  }
});

function benchmarkFixture() {
  // Minimal synthetic fixture for the REAL report validator, not timing evidence.
  const empty = { count: 0, min: null, mean: null, p50: null, p95: null, p99: null, max: null };
  const frame = { drawCalls: 1, dispatchCalls: 0, triangles: 12, uploadBytes: 0, allocatedGpuBufferBytes: 64, allocatedGpuTextureBytes: 128, gpuMs: null };
  const run = { schemaVersion: 1, startedAt: '2026-09-05T00:00:00Z', completedAt: '2026-09-05T00:00:01Z', mode: 'performance',
    workload: { id: 'procedural-boxes-v1', seed: 1337, instanceCount: 1, cameraPath: 'orbit-20s-v1', renderPath: 'diffuse-raster-v1', externalAssetsUsed: false },
    resolution: { width: 1280, height: 720, devicePixelRatio: 1, cssWidth: 1280, cssHeight: 720, screenWidth: 1920, screenHeight: 1080 },
    capture: { warmupSeconds: 0, requestedDurationSeconds: .036, actualDurationMs: 36, frameCount: 2, visibilityChanges: [] },
    browser: { userAgent: 'test browser', hardwareConcurrency: 8, crossOriginIsolated: false, secureContext: true },
    adapter: { vendor: 'test hardware', architecture: 'test', device: '', description: '', isFallbackAdapter: false },
    capabilities: { adapterFeatures: [], adapterLimits: {}, deviceLimits: {} },
    profiling: { enabled: true, gpuTimestampAvailable: false, reason: 'timestamp-query-unavailable', timestampPrecision: 'browser-dependent', capturedGpuSamples: 0, pendingGpuSamples: 0, droppedGpuSamples: 0 },
    coldStart: { initializeMs: 1, sceneSetupMs: 1, uploadBytes: 64 },
    assetTraffic: { externalAssetsUsed: false, steadyUploadBytes: 0, documentResourceTransferBytes: 0, documentResourceDecodedBytes: 0, note: 'Synthetic fixture' },
    allocations: { submittedFrames: 2, totalUploadBytes: 64, allocatedGpuBufferBytes: 64, allocatedGpuTextureBytes: 128, wasmMemoryBytes: 65536, pendingGpuSamples: 0, droppedGpuSamples: 0, gpuErrorCount: 0, note: 'Synthetic fixture' },
    summary: { frameIntervalMs: { count: 2, min: 16, mean: 18, p50: 16, p95: 20, p99: 20, max: 20 },
      cpuSubmissionMs: { count: 2, min: 1, mean: 2, p50: 1, p95: 3, p99: 3, max: 3 }, gpuPassMs: empty,
      meanCallbackCadenceFps: 1000 / 18, framesAbove20Ms: 0, targetFrameIntervalMs: 1000 / 60, drawCalls: 2, dispatchCalls: 0, uploadBytes: 0,
      maxTrackedGpuBufferBytes: 64, maxTrackedGpuTextureBytes: 128 },
    gpuPasses: {}, metadata: {}, limitations: ['Synthetic fixture'],
    frames: [{ ...frame, frameId: 2, elapsedMs: 0, frameIntervalMs: 16, cpuSubmissionMs: 1 }, { ...frame, frameId: 3, elapsedMs: 16, frameIntervalMs: 20, cpuSubmissionMs: 3 }],
    runner: { width: 1280, height: 720, captures: [] } };
  return { schemaVersion: 1, kind: 'strata-local-benchmark-session', comparisonKind: 'strata-trace-maintenance-performance', createdAt: '2026-09-05T00:00:00Z', mode: 'performance',
    host: {}, source: { commit: null, dirty: null }, browser: { headed: true, softwareGpu: false }, runs: [run] };
}
test('pending producer records validate measured fields, and final real validator requires completed image evidence', () => {
  const report = benchmarkFixture(), runner = report.runs[0].runner;
  validatePendingTraceRun(report); assert.equal(runner.captureValidation, undefined);
  assert.throws(() => validateBenchmarkReport(report), /screenshot validation/);
  assert.throws(() => completeTraceCaptureRecord(runner));
  runner.captures = TRACE_CAPTURE_TIMES.map(timeSeconds => ({ timeSeconds, settleFrames: 240, filename: `t${timeSeconds}.png`,
    status: 'complete', admissionRequired: timeSeconds === 0, bytes: 100, sha256: digest,
    validation: { passed: true, screenshotWidth: 1280, screenshotHeight: 720 } }));
  completeTraceCaptureRecord(runner); validateBenchmarkReport(report);
  assert.equal(runner.captureFilename, 't0.png'); assert.equal(runner.captureTimeSeconds, 0);
  runner.captures[3].validation.passed = false; completeTraceCaptureRecord(runner); validateBenchmarkReport(report);
  runner.captures[0].validation.passed = false; assert.throws(() => completeTraceCaptureRecord(runner)); runner.captures[0].validation.passed = true;
  for (const mutate of [r => { r.captures.pop(); }, r => { r.captures[2].status = 'failed'; }, r => { r.captures[1].timeSeconds = 4; },
    r => { r.captures[1].settleFrames = 239; }, r => { delete r.captures[1].sha256; }, r => { r.captures[1].validation.screenshotWidth = 1920; }]) {
    const changed = structuredClone(runner); mutate(changed); assert.throws(() => completeTraceCaptureRecord(changed));
  }
  // The temporary pending-image exemption does not bypass timing/frame validation.
  report.runs[0].summary.uploadBytes = 10; assert.throws(() => validatePendingTraceRun(report));
});
test('outer deadline forces teardown and awaits the interrupted work; normal work is not closed early', async () => {
  let stop, closed = 0, settled = false;
  const pendingGpuOperation = new Promise((_, reject) => { stop = () => reject(Error('Browser closed')); });
  await assert.rejects(withTracePerformanceDeadline(async live => {
    live(); try { await pendingGpuOperation; } finally { settled = true; }
  }, async () => { closed++; stop(); }, 10), /Frozen GPU window exceeded/);
  assert.equal(closed, 1); assert.equal(settled, true);
  assert.equal(await withTracePerformanceDeadline(async live => { live(); return 7; }, () => { closed++; }, 1000), 7);
  assert.equal(closed, 1);
});
