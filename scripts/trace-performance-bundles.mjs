/** CPU preparation/admission only. No browser or GPU is created by this module. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build, transform, version as esbuildVersion } from 'esbuild';
import { newExternalDirectory, proofHash, verifyProof } from './test-trace-updates.mjs';

const exec = promisify(execFile);
export const TRACE_REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const production = 'packages/core/src/gi/trace-updates.ts';
const control = 'tests/helpers/full-trace-performance-updater.ts';
const assetPrefix = 'integrated-courtyard-v1-s1337-t4-c64';
export const TRACE_PERFORMANCE_RUNS = Object.freeze([
  Object.freeze({ arm: 'incremental', width: 1280, height: 720 }),
  Object.freeze({ arm: 'full', width: 1280, height: 720 }),
  Object.freeze({ arm: 'full', width: 1920, height: 1080 }),
  Object.freeze({ arm: 'incremental', width: 1920, height: 1080 }),
]);
export const TRACE_CAPTURE_TIMES = Object.freeze([0, 3, 5, 16, 32]);
export const TRACE_GPU_DEADLINE_MS = 12 * 60 * 1000;
export const TRACE_PERFORMANCE_OPTIONS = Object.freeze({
  warmupSeconds: 30, durationSeconds: 60, seed: 1337, mode: 'performance', renderer: 'integrated',
  temporal: true, debugView: 'final', manifestUrl: `/external-assets/${assetPrefix}/manifest.json`,
  traceProxyUrl: `/external-assets/${assetPrefix}/trace-proxy.json`, terrainColor: 'green',
  geometryMode: 'streamed', residencyPolicy: 'greedy', poolBytes: 1048576, pixelError: 2, pageLoadDelayMs: 0,
  cameraMode: 'tour', giEnabled: true, giScenario: 'integrated-tour', probesPerUpdate: 32, raysPerProbe: 64,
  reflectionMode: 'world', reflectionResolutionScale: 0.25, reflectionMaxRays: 32768,
  reflectionRoughness: 0.08, reflectionMaxDistance: 16, reflectionUpdateEvery: 1,
});
const canonical = Object.freeze({
  'manifest.json': '818d7d020a608d59e83b334b1737ac655de545986e5a8a7494d76910a09c86ca',
  'trace-proxy.json': 'e5341ca032a49c21591f3a47029c301ad0325e6abdde3bb1542f2e6e5cbee47c',
  'trace-proxy.bin': '84f04ccba50710badebe35de421b29bf830a113f6bfad65a18549ddea4afd3c4',
});
const packageFlags = Object.freeze({ entryPoints: ['packages/core/src/index.ts', 'packages/core/src/worker.ts', 'packages/core/src/gltf.ts'],
  bundle: true, splitting: true, chunkNames: '[name]-[hash]', format: 'esm', platform: 'browser', target: 'es2022', sourcemap: true, legalComments: 'none' });
const appFlags = Object.freeze({ entryPoints: ['benchmarks/src/main.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['@strata-engine/core'], sourcemap: true });
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const within = (root, path) => { const p = relative(root, path); return p === '' || (!isAbsolute(p) && p !== '..' && !p.startsWith(`..${sep}`)); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeName = value => typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !value.split('/').some(p => !p || p === '.' || p === '..') && !/[\\?#%]/.test(value);

export async function traceSourceState(root = TRACE_REPOSITORY) {
  const git = async (...args) => (await exec('git', args, { cwd: root, timeout: 15000, maxBuffer: 4 * 1024 ** 2, encoding: 'utf8' })).stdout;
  return { root: await realpath(root), commit: (await git('rev-parse', 'HEAD')).trim(), tree: (await git('rev-parse', 'HEAD^{tree}')).trim(),
    status: (await git('status', '--porcelain')).trim() };
}
export function assertTraceSource(source, expectedCommit) {
  assert(/^[a-f0-9]{40}$/.test(expectedCommit), 'An exact 40-character source commit is required.');
  assert.equal(source.commit, expectedCommit, 'The source commit differs from the frozen commit.');
  assert.equal(source.status, '', 'Preparation and execution require a clean source, including untracked files.');
}
export async function verifyTraceFile(path, expected) {
  assert(sha(expected.sha256), 'Invalid expected SHA256.');
  const bytes = await readFile(path);
  assert.equal(bytes.byteLength, expected.bytes, `Frozen byte length changed: ${path}`);
  assert.equal(proofHash(bytes), expected.sha256, `Frozen bytes changed: ${path}`);
  return bytes;
}
async function fileRecord(path, name) { const bytes = await readFile(path); return { name, bytes: bytes.byteLength, sha256: proofHash(bytes) }; }
async function sourceFiles() {
  const names = (await exec('git', ['ls-files', '-z'], { cwd: TRACE_REPOSITORY, timeout: 15000, maxBuffer: 4 * 1024 ** 2 })).stdout.split('\0').filter(Boolean).sort();
  return Promise.all(names.map(name => fileRecord(resolve(TRACE_REPOSITORY, name), name)));
}
async function assetsAt(assetRoot) {
  const root = await realpath(resolve(assetRoot));
  assert(!within(root, TRACE_REPOSITORY) && !within(TRACE_REPOSITORY, root), 'Asset collection and repository must be separate.');
  const directory = await realpath(resolve(root, assetPrefix));
  assert(within(root, directory));
  const files = [];
  const add = async (name, expected, length) => {
    assert(safeName(name));
    const path = await realpath(resolve(directory, name)); assert(within(directory, path), 'Asset symlink escapes its source directory.');
    const record = await fileRecord(path, `${assetPrefix}/${name}`);
    assert.equal(record.sha256, expected, `Canonical asset changed: ${name}`);
    if (length !== undefined) assert.equal(record.bytes, length);
    files.push(record);
  };
  for (const [name, hash] of Object.entries(canonical)) await add(name, hash);
  const geometry = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  assert.equal(geometry.pages.length, 80);
  for (const [i, page] of geometry.pages.entries()) {
    assert.equal(page.url, `pages/${String(i).padStart(6, '0')}.bin`);
    await add(page.url, page.sha256, 65536);
  }
  return { root, files, geometryAsset: { manifestSha256: canonical['manifest.json'], source: geometry.source,
    traceProxy: { manifestSha256: canonical['trace-proxy.json'], ...JSON.parse(await readFile(resolve(directory, 'trace-proxy.json'), 'utf8')) } } };
}
/** Only the replacement may be outside core; the original profiler's timestamp BigInt remains untouched. */
export function assertMeasuredModuleGraph(modules, substitutions, arm) {
  assert(['incremental', 'full'].includes(arm));
  for (const [requested, item] of Object.entries(modules)) {
    assert(requested.startsWith('packages/core/src/'), `Non-runtime module in measured package: ${requested}`);
    assert.equal(item.source, arm === 'full' && requested === production ? control : requested, 'Unapproved source substitution.');
  }
  assert(modules[production], 'The measured package did not include the updater.');
  assert.deepEqual(substitutions, arm === 'full' ? [{ requested: production, source: control, sha256: modules[production].sha256 }] : []);
}
export function assertMeasuredControlCode(executable) {
  assert(!/\bBigInt\s*\(|\b\d+n\b|\bmapAsync\b|\breadBuffer\b|\btraceGiBruteForce\b/.test(executable), 'An oracle/readback is reachable from the measured control.');
}
async function buildPackage(output, arm, wasm) {
  const directory = resolve(output, arm, 'packages/core/dist'); await mkdir(directory, { recursive: true });
  const modules = {}, substitutions = [];
  const built = await build({ ...packageFlags, absWorkingDir: TRACE_REPOSITORY, outdir: directory, write: false, metafile: true, logLevel: 'silent',
    plugins: [{ name: 'exact-single-maintenance-substitution', setup(builder) {
      builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, async ({ path }) => {
        const requested = relative(TRACE_REPOSITORY, path);
        const source = arm === 'full' && requested === production ? control : requested;
        const contents = await readFile(resolve(TRACE_REPOSITORY, source), 'utf8');
        modules[requested] = { source, sha256: proofHash(contents), bytes: Buffer.byteLength(contents) };
        if (source !== requested) substitutions.push({ requested, source, sha256: proofHash(contents) });
        return { contents, loader: path.endsWith('.ts') ? 'ts' : 'js', resolveDir: dirname(resolve(TRACE_REPOSITORY, source)) };
      });
    } }],
  });
  assertMeasuredModuleGraph(modules, substitutions, arm);
  if (arm === 'full') {
    const executable = (await transform(await readFile(resolve(TRACE_REPOSITORY, control), 'utf8'), { loader: 'ts', target: 'es2022', legalComments: 'none' })).code;
    assertMeasuredControlCode(executable);
  }
  const files = [];
  for (const file of built.outputFiles) {
    const name = relative(output, file.path); assert(safeName(name));
    await writeFile(file.path, file.contents, { flag: 'wx' });
    files.push({ name, url: `/packages/core/dist/${relative(directory, file.path)}`, bytes: file.contents.byteLength, sha256: proofHash(file.contents) });
  }
  const wasmName = `${arm}/packages/core/dist/strata_runtime.wasm`;
  await writeFile(resolve(output, wasmName), wasm, { flag: 'wx' });
  files.push({ name: wasmName, url: '/packages/core/dist/strata_runtime.wasm', bytes: wasm.byteLength, sha256: proofHash(wasm) });
  const graphName = `${arm}/metafile.json`; await writeFile(resolve(output, graphName), json(built.metafile), { flag: 'wx' });
  const updaterOutputs = Object.entries(built.metafile.outputs).filter(([path, entry]) => path.endsWith('.js') && entry.inputs[production]?.bytesInOutput > 0)
    .map(([path]) => `/packages/core/dist/${relative(directory, resolve(TRACE_REPOSITORY, path))}`);
  assert(updaterOutputs.length > 0, 'The maintenance implementation is not reachable in emitted JavaScript.');
  return { arm, flags: packageFlags, modules, substitutions, files, updaterOutputs, graph: await fileRecord(resolve(output, graphName), graphName) };
}
/** CPU-only build component; callers still need clean-source preparation/admission. */
export async function buildTracePerformancePackages(directory, wasm) {
  const bundles = {};
  for (const arm of ['incremental', 'full']) bundles[arm] = await buildPackage(directory, arm, wasm);
  assert.deepEqual(Object.keys(bundles.incremental.modules).sort(), Object.keys(bundles.full.modules).sort(), 'Arms have different module graphs.');
  for (const [name, item] of Object.entries(bundles.incremental.modules)) if (name !== production) assert.deepEqual(bundles.full.modules[name], item, `Unexpected arm source difference: ${name}`);
  for (const url of ['/packages/core/dist/worker.js', '/packages/core/dist/strata_runtime.wasm']) {
    const candidate = bundles.incremental.files.find(f => f.url === url), full = bundles.full.files.find(f => f.url === url);
    assert(candidate && full, `Required artifact is missing: ${url}`);
    assert.equal(candidate.sha256, full.sha256, `Worker/WASM changed across arms: ${url}`);
  }
  return bundles;
}

export async function prepareTracePerformance({ commit, assetRoot, output }) {
  const before = await traceSourceState(); assertTraceSource(before, commit);
  const assets = await assetsAt(assetRoot);
  // Source collection is read-only; even a symlinked output ancestor must not enter it.
  let ancestor = resolve(output); while (!(await stat(ancestor).catch(() => null))) ancestor = dirname(ancestor);
  assert(!within(assets.root, await realpath(ancestor)), 'Results must not be placed inside the source asset collection.');
  const directory = await newExternalDirectory(output);
  const inputs = await sourceFiles();
  const wasmPaths = ['packages/core/dist/strata_runtime.wasm', 'target/wasm32-unknown-unknown/release/strata_runtime.wasm'];
  const wasmInputs = await Promise.all(wasmPaths.map(name => fileRecord(resolve(TRACE_REPOSITORY, name), name)));
  assert.equal(wasmInputs[0].sha256, wasmInputs[1].sha256, 'Built package WASM differs from the release compiler output; run npm run build first.');
  const wasm = await readFile(resolve(TRACE_REPOSITORY, wasmPaths[0]));
  const bundles = await buildTracePerformancePackages(directory, wasm);
  const appDirectory = resolve(directory, 'app'); await mkdir(appDirectory);
  const builtApp = await build({ ...appFlags, absWorkingDir: TRACE_REPOSITORY, outfile: resolve(appDirectory, 'app.js'), write: false, metafile: true, logLevel: 'silent' });
  assert(Object.keys(builtApp.metafile.inputs).every(p => p.startsWith('benchmarks/src/')), 'Application bundled runtime/harness code instead of importing the package.');
  const app = { flags: appFlags, files: [], graph: null };
  for (const file of builtApp.outputFiles) {
    await writeFile(file.path, file.contents, { flag: 'wx' });
    app.files.push({ name: relative(directory, file.path), url: `/benchmarks/browser/${relative(appDirectory, file.path)}`, bytes: file.contents.byteLength, sha256: proofHash(file.contents) });
  }
  const html = await readFile(resolve(TRACE_REPOSITORY, 'benchmarks/browser/index.html'));
  await writeFile(resolve(appDirectory, 'index.html'), html, { flag: 'wx' });
  app.files.push({ name: 'app/index.html', url: '/', bytes: html.byteLength, sha256: proofHash(html) });
  await writeFile(resolve(appDirectory, 'metafile.json'), json(builtApp.metafile), { flag: 'wx' });
  app.graph = await fileRecord(resolve(appDirectory, 'metafile.json'), 'app/metafile.json');
  assert.deepEqual(await traceSourceState(), before, 'Source changed during preparation.');
  assert.deepEqual(await sourceFiles(), inputs, 'Source bytes changed during preparation.');
  assert.deepEqual(await assetsAt(assets.root), assets, 'Source assets changed during preparation.');
  for (const input of wasmInputs) await verifyTraceFile(resolve(TRACE_REPOSITORY, input.name), input);
  const manifest = { schemaVersion: 1, kind: 'strata-trace-maintenance-frozen-performance', createdAt: new Date().toISOString(),
    source: before, inputs, esbuildVersion, wasmInputs, assets, bundles, app,
    control: { id: 'full-performance', helper: { path: control, sha256: bundles.full.modules[production].sha256 } },
    options: TRACE_PERFORMANCE_OPTIONS, runs: TRACE_PERFORMANCE_RUNS, captureTimes: TRACE_CAPTURE_TIMES, gpuDeadlineMs: TRACE_GPU_DEADLINE_MS,
    prerequisites: 'A matching passed full-performance direct-write and renderer correctness receipt is required before GPU admission.',
    limitations: 'Original browser-time RAF workload; frame counts and continuous-motion samples differ across independent runs. No correctness oracle is measured.' };
  const path = resolve(directory, 'manifest.json'); const bytes = json(manifest); await writeFile(path, bytes, { flag: 'wx' });
  return { path, sha256: proofHash(bytes), source: before, options: manifest.options, runs: manifest.runs };
}

export async function loadTracePerformanceManifest({ manifestPath, manifestSha256 }) {
  assert(sha(manifestSha256), 'The reviewed manifest SHA256 is required.');
  const path = await realpath(resolve(manifestPath)), bytes = await readFile(path);
  assert.equal(proofHash(bytes), manifestSha256, 'Manifest SHA256 mismatch.');
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, 'strata-trace-maintenance-frozen-performance');
  assert.deepEqual(manifest.options, TRACE_PERFORMANCE_OPTIONS); assert.deepEqual(manifest.runs, TRACE_PERFORMANCE_RUNS);
  assert.deepEqual(manifest.captureTimes, TRACE_CAPTURE_TIMES);
  assert.equal(manifest.gpuDeadlineMs, TRACE_GPU_DEADLINE_MS);
  assert.equal(manifest.control.id, 'full-performance'); assert.equal(manifest.control.helper.path, control);
  return { manifest, directory: dirname(path), manifestPath: path, manifestSha256 };
}
export async function assertTracePerformanceFrozen(frozen) {
  const { manifest, directory } = frozen;
  const current = await loadTracePerformanceManifest(frozen); assert.deepEqual(current.manifest, manifest, 'Manifest changed since admission.');
  const source = await traceSourceState(); assertTraceSource(source, manifest.source.commit); assert.deepEqual(source, manifest.source);
  assert.equal(esbuildVersion, manifest.esbuildVersion);
  for (const item of [...manifest.inputs, ...manifest.wasmInputs]) {
    assert(safeName(item.name)); await verifyTraceFile(resolve(TRACE_REPOSITORY, item.name), item);
  }
  for (const item of [...manifest.app.files, manifest.app.graph, ...Object.values(manifest.bundles).flatMap(b => [...b.files, b.graph])]) {
    assert(safeName(item.name)); const path = await realpath(resolve(directory, item.name)); assert(within(directory, path)); await verifyTraceFile(path, item);
  }
  for (const [arm, bundle] of Object.entries(manifest.bundles)) assertMeasuredModuleGraph(bundle.modules, bundle.substitutions, arm);
  assert.deepEqual(await assetsAt(manifest.assets.root), manifest.assets, 'Canonical source assets changed.');
  return { at: new Date().toISOString(), source: 'unchanged', assets: 'unchanged', artifacts: 'unchanged', manifestSha256: frozen.manifestSha256 };
}
/** Exact paths only: unknown package chunks cannot fall through to mutable dist. */
export function frozenTraceRoute(manifest, arm, path) {
  assert(['incremental', 'full'].includes(arm), 'Unknown measured arm.');
  if (typeof path !== 'string' || !path.startsWith('/') || /[\\?#%]/.test(path) || path.split('/').some(p => p === '.' || p === '..')) return null;
  const matches = [...manifest.app.files, ...manifest.bundles[arm].files].filter(f => f.url === path);
  if (matches.length > 1) throw Error('Ambiguous frozen route.');
  if (matches.length === 1) return { kind: 'artifact', ...matches[0] };
  const asset = manifest.assets.files.find(f => `/external-assets/${f.name}` === path);
  if (asset) return { kind: 'asset', ...asset, url: path };
  return null;
}

export function assertTraceCorrectnessReceipt(report, proof, manifest, proofSha256, rendererPlan) {
  assert.equal(report.status, 'pass'); assert.equal(report.result?.status, 'pass'); assert.equal(report.sourceGuard, 'unchanged');
  assert.equal(report.requestedAdapter, 'hardware'); assert.equal(report.result.adapter?.isFallbackAdapter, false);
  assert(!/swiftshader|llvmpipe|software rasterizer|software adapter/i.test(JSON.stringify(report.result.adapter)));
  assert.equal(report.manifest?.sha256, proofSha256); assert.equal(proof.runnable, true); assert.equal(proof.correctnessOnly, true);
  assert.equal(proof.source.commit, manifest.source.commit); assert.equal(proof.source.status, '');
  for (const full of [report.fullControl, proof.fullControl]) {
    assert.equal(full?.id, 'full-performance', 'The BigInt correctness control cannot admit a timing run.');
    assert.deepEqual(full.helper, manifest.control.helper);
  }
  assert.equal(report.result.stages?.A?.status, 'passed');
  assert.equal(report.result.stages?.BC?.status, 'passed');
  assert.equal(report.result.stages.A.fullControl, 'full-performance');
  assert.deepEqual(report.result.stages.A.failures, []);
  assert.equal(report.result.stages.A.cleanup.liveArms, 0);
  assert.equal(report.result.stages.A.cleanup.createdBuffers, report.result.stages.A.cleanup.destroyedBuffers);
  const bc = report.result.stages.BC;
  assert(rendererPlan, 'The verified frozen renderer plan is required.'); assert.deepEqual(bc.plan, rendererPlan);
  const counts = { gi: { steps: 62, submissions: 59, checkpoints: 21 }, reflections: { steps: 63, submissions: 60, checkpoints: 22 }, integrated: { steps: 63, submissions: 60, checkpoints: 22 } };
  assert.deepEqual(rendererPlan.exactCounts, counts);
  assert.deepEqual(bc.pairs.map(pair => pair.kind), ['gi', 'reflections', 'integrated']);
  for (const pair of bc.pairs) {
    const expected = counts[pair.kind], steps = rendererPlan.steps[pair.kind];
    assert.equal(pair.frames.length, expected.steps); assert.equal(steps.length, expected.steps);
    for (const arm of ['candidate', 'full']) {
      assert.equal(pair.frames.filter(frame => frame[arm].submitted === true).length, expected.submissions);
      assert.equal(pair.frames.filter(frame => frame[arm].captured === true).length, expected.checkpoints);
    }
    for (const [i, frame] of pair.frames.entries()) {
      assert.deepEqual(frame.step, steps[i], 'Actual renderer inputs differ from the frozen plan.');
      for (const arm of ['candidate', 'full']) {
        const actual = frame[arm]; assert.equal(actual.id, steps[i].id); assert.equal(actual.action, steps[i].action);
        assert.equal(actual.submitted, steps[i].action === 'submit'); assert.equal(actual.captured, steps[i].checkpoint && actual.submitted);
        assert.equal(actual.cpuTrace.length, 5); assert.equal(actual.gpuTrace.length, 5);
        if (actual.captured) assert(Object.keys(actual.textures).length > 0, 'A claimed checkpoint has no retained textures.');
      }
    }
    assert(pair.writeLogs?.candidate && pair.writeLogs?.full, 'Actual renderer write logs are missing.');
  }
  assert.equal(bc.cleanup.length, rendererPlan.streamedChurn === 'run' ? 7 : 6);
  for (const item of bc.cleanup) assert.deepEqual(item.after, { buffers: 0, textures: 0 });
  if (rendererPlan.streamedChurn === 'skip-unchanged-candidate-only') assert.equal(bc.streamed.status, 'skipped');
  assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.result.errors, []);
  assert.deepEqual(report.result.cleanup?.errors, []);
  assert.equal(report.cleanup?.browser?.status, 'fulfilled'); assert.equal(report.cleanup?.server?.status, 'fulfilled');
  assert(!report.failure && !report.finalizationFailure && !report.eventPersistenceFailure);
}
export function traceCanonicalReceipt(report, evidenceSha256) {
  assert(sha(evidenceSha256));
  const stage = report.result.stages.A;
  const step = 'fresh-canonical-plus-point4';
  const canonicalCase = stage.cases.find(item => item.step === step); assert(canonicalCase, 'Canonical GPU write case is missing.');
  const actual = {};
  for (const [arm, calls, expectedBytes] of [['incremental', 7, 912], ['full-performance', 5, 184640]]) {
    const writes = stage.writes.filter(w => w.step === step && w.arm === arm);
    assert.equal(writes.length, calls); assert(writes.every(w => w.returned === true));
    const bytes = writes.reduce((sum, w) => { assert(Number.isSafeInteger(w.bytes) && w.bytes > 0); return sum + w.bytes; }, 0);
    assert.equal(bytes, expectedBytes);
    const state = canonicalCase.states.find(item => item.arm === arm); assert(state);
    assert.equal(state.result.uploadBytes, bytes); assert.equal(state.result.writeCalls, calls);
    actual[arm] = { bytes, calls, writes: writes.map(({ buffer, offset, bytes }) => ({ buffer, offset, bytes })) };
  }
  return { incrementalBytes: actual.incremental.bytes, fullBytes: actual['full-performance'].bytes, evidenceSha256, actualWrites: actual };
}
export async function loadTraceCorrectnessReceipt(args, manifest) {
  const records = {};
  for (const name of ['report', 'manifest']) {
    const path = await realpath(resolve(args[`correctness-${name}`])); const hash = args[`correctness-${name}-sha256`]; assert(sha(hash));
    const bytes = await readFile(path); assert.equal(proofHash(bytes), hash, `Correctness ${name} hash mismatch.`);
    records[name] = { path, sha256: hash, bytes: bytes.byteLength, value: JSON.parse(bytes) };
  }
  // CPU-only verification of the original receipt's modules, assets and exact plan.
  const proof = await verifyProof(records.manifest.path, records.manifest.sha256);
  const steps = JSON.parse(await readFile(resolve(proof.directory, 'steps.json'), 'utf8'));
  assertTraceCorrectnessReceipt(records.report.value, records.manifest.value, manifest, records.manifest.sha256, steps.renderer);
  return { ...Object.fromEntries(Object.entries(records).map(([key, { value: _value, ...record }]) => [key, record])),
    canonicalUpdate: traceCanonicalReceipt(records.report.value, records.report.sha256) };
}

export function parseTracePerformanceArguments(args) {
  const options = {};
  const values = new Set(['--commit', '--asset-root', '--output', '--manifest', '--manifest-sha256', '--correctness-report', '--correctness-report-sha256', '--correctness-manifest', '--correctness-manifest-sha256']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i]; assert(!Object.hasOwn(options, key.slice(2)), `Duplicate option ${key}.`);
    if (key === '--trace-prepare-only' || key === '--trace-performance') options[key.slice(2)] = true;
    else { assert(values.has(key), `Unknown trace comparison option: ${key}`); const value = args[++i]; assert(value && !value.startsWith('--'), `Missing ${key}.`); options[key.slice(2)] = value; }
  }
  assert(Boolean(options['trace-prepare-only']) !== Boolean(options['trace-performance']), 'Choose --trace-prepare-only or --trace-performance.');
  const required = options['trace-prepare-only'] ? ['commit', 'asset-root', 'output'] : ['manifest', 'manifest-sha256', 'output', 'correctness-report', 'correctness-report-sha256', 'correctness-manifest', 'correctness-manifest-sha256'];
  assert.deepEqual(Object.keys(options).sort(), [...required, options['trace-prepare-only'] ? 'trace-prepare-only' : 'trace-performance'].sort(), `Only the fixed comparison options are accepted; require ${required.join(', ')}.`);
  return options;
}
