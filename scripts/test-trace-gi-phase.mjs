import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { bundleTraceProof, newExternalDirectory, proofHash, traceProofInputs } from './test-trace-updates.mjs';
import { compareTraceGiPhaseCells } from './trace-gi-phase-comparison.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = promisify(execFile);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const inside = (root, path) => { const p = relative(root, path); return !isAbsolute(p) && p !== '..' && !p.startsWith(`..${sep}`); };
export const PHASE_SOURCE = 'c91c285489a9befe8ce27d7264dfc56a295d12d5';
export const PHASE_PLAN_SHA = '590b30bae791b4654c92e9e633a8c4e965d9f8f9af87dd1545459f3bdb5e942d';
export const PHASE_RUNS = Object.freeze([
  { id: '1-incremental-5399', updater: 'incremental', phaseLabel: 5399 },
  { id: '2-full-5399', updater: 'full', phaseLabel: 5399 },
  { id: '3-full-5400', updater: 'full', phaseLabel: 5400 },
  { id: '4-incremental-5400', updater: 'incremental', phaseLabel: 5400 },
].map(Object.freeze));
export const PHASE_LIMITS = Object.freeze({ totalMs: 300000, workMs: 280000, cleanupMs: 15000,
  maxArtifactBytes: 32 * 1024 ** 2, maxCellBytes: 256 * 1024 ** 2, maxTotalBytes: 1024 ** 3,
  maxArtifactsPerCell: 4096, maxEventsPerCell: 512, maxEventBytes: 1024 ** 2,
  maxCellEventBytes: 16 * 1024 ** 2, maxPngBytes: 4 * 1024 ** 2,
  byteCapScope: 'Artifact/cell/total byte caps count raw native artifacts; PNG derivatives and event logs have separate explicit caps. Four bounded cell summaries and one combined report repeat metadata, never raw payloads.' });
export const PHASE_PROBE_OBSERVABLES = Object.freeze({ inspectedProbeCount: 384, finalEpoch: 2,
  validityWords: Object.freeze([0, 1]), requireEveryProbeValid: false, reportInvalidCounts: true,
  finalUpdatesFirst32: 21, finalUpdatesRemaining352: 20, maxSampleAgeFrames: 11, hysteresis: .85 });
const production = 'packages/core/src/gi/trace-updates.ts';
const full = 'tests/helpers/full-trace-performance-updater.ts';
const helperSha = 'e7b2f6c683faa00569fd87841ffb522ecc9c72c67474f7631d35d1fdec3387e5';
const entry = 'tests/browser/trace-gi-phase-validation.ts';
const usage = 'Use --prepare-only --asset-root PATH --plan PATH --output NEW_EXTERNAL_DIR [--allow-dirty-draft], or --run --manifest PATH --manifest-sha256 SHA --output NEW_EXTERNAL_DIR. GPU use requires a separately approved allocation.';

export function parsePhaseArguments(args) {
  const options = {}, flags = ['--prepare-only', '--run', '--allow-dirty-draft'];
  const values = ['--asset-root', '--plan', '--output', '--manifest', '--manifest-sha256'];
  for (let i = 0; i < args.length; i++) {
    const key = args[i]; assert(!Object.hasOwn(options, key), `Duplicate argument. ${usage}`);
    if (flags.includes(key)) options[key] = true;
    else { assert(values.includes(key) && args[i + 1] && !args[i + 1].startsWith('--'), usage); options[key] = args[++i]; }
  }
  const prepare = options['--prepare-only'] === true; assert(prepare !== (options['--run'] === true), usage);
  const required = prepare ? ['--asset-root', '--plan', '--output'] : ['--manifest', '--manifest-sha256', '--output'];
  const allowed = [...required, ...(prepare ? ['--prepare-only', '--allow-dirty-draft'] : ['--run'])];
  assert(required.every(key => typeof options[key] === 'string') && Object.keys(options).every(key => allowed.includes(key)), usage);
  if (!prepare) assert(/^[a-f0-9]{64}$/.test(options['--manifest-sha256']), 'Reviewed manifest SHA256 required.');
  return options;
}
async function sourceState() {
  const git = async (...args) => (await command('git', ['-C', repository, ...args])).stdout.trim();
  return { root: repository, commit: await git('rev-parse', 'HEAD'), tree: await git('rev-parse', 'HEAD^{tree}'),
    runtimeTree: await git('rev-parse', 'HEAD:packages/core'), status: await git('status', '--porcelain'),
    trackedDiffSha256: proofHash(await git('diff', 'HEAD')) };
}
async function verifyRuntimeBase() {
  const { stdout } = await command('git', ['-C', repository, 'diff', '--name-only', PHASE_SOURCE, '--', 'packages/core']);
  assert.equal(stdout.trim(), '', 'Diagnostic must not change production runtime from measured source.');
}
export async function verifyPhaseFile(path, expected) {
  const bytes = await readFile(path); assert.equal(proofHash(bytes), expected.sha256, `Frozen SHA256 differs: ${path}`);
  if (expected.bytes !== undefined) assert.equal(bytes.length, expected.bytes, `Frozen length differs: ${path}`);
  return bytes;
}
async function assetInventory(input) {
  const root = await realpath(input); assert(!inside(repository, root) && !inside(root, repository), 'Assets must stay external.');
  const files = [];
  const add = async (name, sha256, size) => {
    const path = await realpath(resolve(root, name)); assert(inside(root, path), 'Asset escaped its root.');
    const data = await verifyPhaseFile(path, { sha256, bytes: size }); files.push({ name, sha256, bytes: data.length }); return data;
  };
  const manifest = JSON.parse(await add('manifest.json', traceProofInputs['manifest.json']));
  await add('trace-proxy.json', traceProofInputs['trace-proxy.json']); await add('trace-proxy.bin', traceProofInputs['trace-proxy.bin']);
  assert.equal(manifest.pages.length, 80);
  for (const [id, page] of manifest.pages.entries()) {
    assert.equal(page.id, id); assert.equal(page.url, `pages/${String(id).padStart(6, '0')}.bin`); assert.equal(page.byteLength, 65536);
    await add(page.url, page.sha256, page.byteLength);
  }
  return { root, files };
}
export function assertPhaseBundleGraph(candidate, control) {
  assert.deepEqual(candidate.substitutions, []);
  assert.deepEqual(control.substitutions, [{ requested: production, actual: full, sha256: helperSha }]);
  assert.equal(control.modules[production], undefined); assert.equal(candidate.modules[full], undefined);
  assert.equal(control.modules[full], helperSha); assert.equal(typeof candidate.modules[production], 'string');
  const a = { ...candidate.modules }, b = { ...control.modules }; delete a[production]; delete b[full];
  assert.deepEqual(a, b, 'Only the approved updater module may differ.');
}
const shaderEntry = `
export { createIntegratedScene } from './packages/core/src/integrated/integrated-scene.ts';
export { createGiScene } from './packages/core/src/gi/scene-data.ts';
export { RoomGeometry } from './packages/core/src/gi/room-geometry.ts';
export { ReflectionGeometry } from './packages/core/src/reflections/reflection-geometry.ts';
export { TerrainRendering } from './packages/core/src/geometry/terrain-rendering.ts';
export { integratedTerrainTransform } from './packages/core/src/geometry/trace-proxy.ts';
export { GiComposer } from './packages/core/src/gi/gi-composer.ts';
export { ReflectionComposer } from './packages/core/src/reflections/reflection-composer.ts';
export { probeTraceShader, probeUpdateShader } from './packages/core/src/gi/probe-cache-shaders.ts';
export { reflectionTraceShader, reflectionResolveShader } from './packages/core/src/reflections/reflection-shaders.ts';
export { geometrySelectionShader, geometryVertexShader } from './packages/core/src/geometry/gpu-geometry-shaders.ts';
export { rasterShader, presentationShader } from './packages/core/src/rendering/raster-shaders.ts';
export { temporalShader } from './packages/core/src/rendering/temporal-shader.ts';`;

/** CPU-only descriptor collection; no browser/device request and no altered production WGSL. */
async function shaderSources(api) {
  const sources = { probeTrace: api.probeTraceShader(), probeUpdate: api.probeUpdateShader,
    reflectionTrace: api.reflectionTraceShader, reflectionResolve: api.reflectionResolveShader,
    geometrySelection: api.geometrySelectionShader, presentation: api.presentationShader, temporal: api.temporalShader };
  const owned = new Set();
  const fake = { limits: { maxBufferSize: 1 << 28 }, queue: { writeBuffer() {} },
    createBuffer(d) { const b = { ...d, destroy() { owned.delete(b); } }; owned.add(b); return b; },
    createBindGroupLayout: d => d, createPipelineLayout: d => d, createBindGroup: d => d,
    createComputePipelineAsync: async d => d, createShaderModule(d) { sources[d.label] = d.code; return d; } };
  const scene = api.createIntegratedScene(), room = new api.RoomGeometry(fake, api.createGiScene(), 'receiver');
  const reflection = new api.ReflectionGeometry(fake, scene);
  const terrain = new api.TerrainRendering(fake, { transform: api.integratedTerrainTransform, shading: 'lambert', albedo: scene.materials[5].albedo, light: scene.light });
  try {
    sources.roomRaster = api.rasterShader + room.shaderSource;
    sources.reflectionRaster = api.rasterShader + reflection.shaderSource;
    sources.terrainRaster = api.rasterShader + api.geometryVertexShader + terrain.shader(5);
    const gi = await api.GiComposer.create(fake, []); gi.dispose();
    const specular = await api.ReflectionComposer.create(fake, [], {}); specular.dispose();
  } finally { room.dispose(); reflection.dispose(); terrain.dispose(); }
  assert.equal(owned.size, 0); assert(Object.values(sources).every(code => typeof code === 'string' && code.length > 0));
  return sources;
}
async function runnerGraph() {
  const files = ['scripts/test-trace-gi-phase.mjs', 'scripts/trace-gi-phase-comparison.mjs', 'scripts/test-trace-updates.mjs',
    'scripts/benchmark-server.mjs', 'scripts/gallery-catalog.mjs', 'package.json', 'package-lock.json'];
  return Object.fromEntries(await Promise.all(files.map(async path => [path, proofHash(await readFile(resolve(repository, path)))])));
}
export async function preparePhase(args) {
  const before = await sourceState(); assert(!before.status || args['--allow-dirty-draft'], 'Freeze a clean commit or create an explicit non-runnable dirty draft.');
  await verifyRuntimeBase();
  const sourcePlan = await verifyPhaseFile(args['--plan'], { sha256: PHASE_PLAN_SHA });
  const assets = await assetInventory(args['--asset-root']), output = await newExternalDirectory(args['--output']);
  const candidate = await bundleTraceProof(entry, output, 'incremental.mjs');
  const control = await bundleTraceProof(entry, output, 'full.mjs', [{ requested: production, actual: full }]);
  assertPhaseBundleGraph(candidate, control);
  const cpu = await bundleTraceProof({ contents: shaderEntry, resolveDir: repository, sourcefile: 'phase-shader-exports.ts', loader: 'ts' }, output, 'shader-exports.mjs');
  const api = await import(pathToFileURL(resolve(output, 'incremental.mjs')).href);
  const plan = api.validateTraceGiPhasePlan(structuredClone(api.traceGiPhasePlan));
  const shaders = await shaderSources(await import(pathToFileURL(resolve(output, 'shader-exports.mjs')).href));
  const diagnosticShaders = { exactShadowLoad: api.traceGiPhaseShadowReadShader };
  assert.equal(typeof diagnosticShaders.exactShadowLoad, 'string');
  const artifacts = [];
  for (const [name, bytes] of [['plan.md', sourcePlan], ['workload.json', json(plan)], ['shaders.json', json(shaders)], ['diagnostic-shaders.json', json(diagnosticShaders)]]) {
    await writeFile(resolve(output, name), bytes, { flag: 'wx' }); artifacts.push({ name, bytes: Buffer.byteLength(bytes), sha256: proofHash(bytes) });
  }
  const runners = await runnerGraph();
  for (const b of [candidate, control, cpu]) for (const [path, sha] of Object.entries(b.modules)) await verifyPhaseFile(resolve(repository, path), { sha256: sha });
  assert.deepEqual(await sourceState(), before, 'Source changed during preparation.');
  const manifest = { schemaVersion: 1, kind: 'strata-issue20-shared-lighting-phase-diagnostic', correctnessOnly: true, performanceEligible: false,
    runnable: !before.status && !args['--allow-dirty-draft'], createdAt: new Date().toISOString(), source: before,
    measuredBase: PHASE_SOURCE, planSha256: PHASE_PLAN_SHA, runs: PHASE_RUNS, limits: PHASE_LIMITS,
    probeObservables: PHASE_PROBE_OBSERVABLES, assets, runners,
    bundles: { incremental: candidate, full: control, cpu }, artifacts,
    shaders: Object.fromEntries(Object.entries(shaders).map(([key, code]) => [key, proofHash(code)])),
    diagnosticShaders: Object.fromEntries(Object.entries(diagnosticShaders).map(([key, code]) => [key, proofHash(code)])) };
  const bytes = json(manifest); await writeFile(resolve(output, 'manifest.json'), bytes, { flag: 'wx' });
  return { path: resolve(output, 'manifest.json'), sha256: proofHash(bytes), runnable: manifest.runnable };
}
export async function verifyPhase(manifestPath, sha256) {
  const path = await realpath(manifestPath), directory = dirname(path);
  const manifest = JSON.parse(await verifyPhaseFile(path, { sha256 }));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, 'strata-issue20-shared-lighting-phase-diagnostic');
  assert.equal(manifest.runnable, true, 'Draft manifests cannot request a GPU.');
  assert.equal(manifest.correctnessOnly, true); assert.equal(manifest.performanceEligible, false);
  assert.equal(manifest.measuredBase, PHASE_SOURCE); assert.equal(manifest.planSha256, PHASE_PLAN_SHA);
  assert.deepEqual(manifest.runs, PHASE_RUNS); assert.deepEqual(manifest.limits, PHASE_LIMITS);
  assert.deepEqual(manifest.probeObservables, PHASE_PROBE_OBSERVABLES);
  assert.deepEqual(await sourceState(), manifest.source, 'Exact clean reviewed source required.'); await verifyRuntimeBase();
  assert.deepEqual(await runnerGraph(), manifest.runners); assertPhaseBundleGraph(manifest.bundles.incremental, manifest.bundles.full);
  for (const file of [...manifest.artifacts, ...Object.values(manifest.bundles).flatMap(b => b.files)]) {
    const target = await realpath(resolve(directory, file.name)); assert(inside(directory, target)); await verifyPhaseFile(target, file);
  }
  for (const b of Object.values(manifest.bundles)) for (const [name, sha] of Object.entries(b.modules)) await verifyPhaseFile(resolve(repository, name), { sha256: sha });
  const api = await import(pathToFileURL(resolve(directory, 'incremental.mjs')).href);
  const workload = api.validateTraceGiPhasePlan(JSON.parse(await readFile(resolve(directory, 'workload.json'), 'utf8')));
  for (const [name, hashes] of [['shaders.json', manifest.shaders], ['diagnostic-shaders.json', manifest.diagnosticShaders]]) {
    const codes = JSON.parse(await readFile(resolve(directory, name), 'utf8'));
    assert.deepEqual(Object.fromEntries(Object.entries(codes).map(([key, code]) => [key, proofHash(code)])), hashes);
  }
  assert.deepEqual(await assetInventory(manifest.assets.root), manifest.assets);
  return { manifest, directory, workload };
}

/** Lossless PNG: swizzle native BGRA only, filter0 and ordinary zlib. */
export function phaseNativePng(bytes, width, height) {
  assert(Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0);
  assert.equal(bytes.length, width * height * 4);
  const crc = data => { let c = 0xffffffff; for (const byte of data) { c ^= byte; for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const label = Buffer.from(name), out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); label.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([label, data])), out.length - 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const s = (y * width + x) * 4, d = y * (width * 4 + 1) + 1 + x * 4; raw[d] = bytes[s + 2]; raw[d + 1] = bytes[s + 1]; raw[d + 2] = bytes[s]; raw[d + 3] = bytes[s + 3]; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export function validatePhaseArtifact(artifact) {
  assert(/^(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_-]+\.bin$/.test(artifact.name), 'Unsafe artifact name.');
  assert(Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 && artifact.bytes <= PHASE_LIMITS.maxArtifactBytes, 'Artifact byte cap.');
  assert(/^[a-f0-9]{64}$/.test(artifact.sha256));
  assert(typeof artifact.base64 === 'string' && artifact.base64.length <= Math.ceil(artifact.bytes / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(artifact.base64), 'Invalid artifact encoding.');
  const bytes = Buffer.from(artifact.base64, 'base64'); assert.equal(bytes.length, artifact.bytes); assert.equal(proofHash(bytes), artifact.sha256, 'Artifact payload SHA256 differs.');
  if (artifact.format !== undefined) {
    const bpp = { bgra8unorm: 4, rgba8unorm: 4, rgba16float: 8, rg32float: 8, rgba32uint: 16, depth32float: 4, r32float: 4 }[artifact.format];
    assert(bpp && Number.isSafeInteger(artifact.width) && artifact.width > 0 && Number.isSafeInteger(artifact.height) && artifact.height > 0);
    assert.equal(bytes.length, artifact.width * artifact.height * bpp, 'Native texture dimensions differ.');
  }
  return bytes;
}
export async function withPhaseDeadline(operation, label, milliseconds) {
  let timer; try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} deadline exceeded.`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
export async function closePhaseBrowser(browserServer) {
  await browserServer.close();
  const process = browserServer.process();
  assert(process.exitCode !== null || process.signalCode !== null, 'Owned browser still alive after close.');
  return { pid: process.pid, exitCode: process.exitCode, signalCode: process.signalCode };
}
export function finalizePhaseStatus(report, elapsedMs) {
  if (report.browserErrors.length || report.status !== 'pass' || !report.cleanup.browserExited || !report.cleanup.serverClosed
    || !report.cleanup.deviceDestroyed || !report.cleanup.artifactsDrained || !report.cleanup.frozenInputsVerified
    || report.cleanup.forcedKill || elapsedMs >= PHASE_LIMITS.totalMs) report.status = 'fail';
  report.elapsedMs = elapsedMs; return report.status;
}

/** Loopback server serves ONLY the reviewed bundles and allowlisted assets, verifying bytes on each request. */
async function frozenPhaseServer(frozen, failures) {
  const routes = new Map();
  for (const name of ['incremental.mjs', 'full.mjs', 'workload.json', 'shaders.json', 'diagnostic-shaders.json']) {
    const record = [...frozen.manifest.artifacts, ...Object.values(frozen.manifest.bundles).flatMap(b => b.files)].find(a => a.name === name);
    assert(record, `Missing frozen route ${name}`); routes.set(`/proof/${name}`, { ...record, path: resolve(frozen.directory, name) });
  }
  for (const file of frozen.manifest.assets.files) routes.set(`/external-assets/${file.name}`, { ...file, path: resolve(frozen.manifest.assets.root, file.name) });
  const server = createServer(async (request, response) => {
    try {
      assert(/^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host ?? '') && request.method === 'GET', 'Unapproved request host/method.');
      if (request.url === '/proof.html') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Strata phase diagnostic</title><link rel="icon" href="data:,">'); return; }
      const file = routes.get(request.url); assert(file, `Unfrozen request ${request.url}`);
      const body = await verifyPhaseFile(file.path, file); response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': file.name.endsWith('.mjs') ? 'text/javascript' : file.name.endsWith('.json') ? 'application/json' : 'application/octet-stream' }).end(body);
    } catch (error) { failures.push(String(error)); response.writeHead(500).end(); }
  });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((res, rej) => { server.close(e => e ? rej(e) : res()); server.closeAllConnections(); }) };
}

export async function runPhase(args) {
  const started = performance.now(), frozen = await verifyPhase(args['--manifest'], args['--manifest-sha256']);
  const output = await newExternalDirectory(args['--output']);
  const report = { kind: 'strata-issue20-shared-lighting-phase-results', correctnessOnly: true, performanceEligible: false,
    startedAt: new Date().toISOString(), manifest: { path: resolve(args['--manifest']), sha256: args['--manifest-sha256'] },
    status: 'running', browserErrors: [], cells: [], cleanup: {}, limits: PHASE_LIMITS };
  let browser, browserServer, server, watchdog, stopped = false, acceptingCallbacks = true, activeCell = null, totalBytes = 0;
  const active = () => { assert(!stopped && performance.now() - started < PHASE_LIMITS.workMs, 'Diagnostic work ended.'); };
  const remainingWork = maximum => Math.max(1, Math.min(maximum, PHASE_LIMITS.workMs - (performance.now() - started)));
  let writes = Promise.resolve();
  const persist = fn => { assert(acceptingCallbacks, 'Diagnostic artifact/event admission is closed.'); writes = writes.then(fn); return writes; };
  const work = async () => {
    const { chromium } = await import('playwright'); active();
    server = await frozenPhaseServer(frozen, report.browserErrors);
    if (stopped) { await server.close(); throw Error('Timed out during server creation.'); } active();
    browserServer = await chromium.launchServer({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headless: process.env.STRATA_TEST_HEADED !== '1',
      timeout: remainingWork(30000), args: ['--enable-unsafe-webgpu'] });
    if (stopped) { await browserServer.kill(); throw Error('Timed out during browser launch.'); }
    const child = browserServer.process(); report.browserProcess = { pid: child.pid, spawnedAt: new Date().toISOString() };
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: remainingWork(15000) }); active(); report.browser = browser.version();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000);
    page.on('pageerror', e => report.browserErrors.push(String(e))); page.on('console', m => { if (m.type() === 'error') report.browserErrors.push(m.text()); });
    page.on('requestfailed', r => report.browserErrors.push(`${r.url()}: ${r.failure()?.errorText}`));
    await page.exposeFunction('savePhaseArtifact', (cellId, artifact) => persist(async () => {
      assert.equal(cellId, activeCell?.id, 'Artifact belongs to inactive cell.');
      const cell = activeCell, bytes = validatePhaseArtifact(artifact);
      assert(!cell.artifacts.some(a => a.name === artifact.name), 'Duplicate artifact.');
      assert(cell.artifacts.length < PHASE_LIMITS.maxArtifactsPerCell && cell.bytes + bytes.length <= PHASE_LIMITS.maxCellBytes
        && totalBytes + bytes.length <= PHASE_LIMITS.maxTotalBytes, 'Diagnostic artifact/storage cap exceeded.');
      const path = resolve(output, cellId, artifact.name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { flag: 'wx' });
      const { base64: _payload, ...record } = artifact; cell.artifacts.push(record); cell.bytes += bytes.length; totalBytes += bytes.length;
      if (artifact.name.endsWith('/native.bin')) {
        assert.equal(artifact.format, 'bgra8unorm'); const png = phaseNativePng(bytes, artifact.width, artifact.height), name = artifact.name.replace(/\.bin$/, '.png');
        assert(png.length <= PHASE_LIMITS.maxPngBytes, 'PNG derivative cap exceeded.');
        await writeFile(resolve(output, cellId, name), png, { flag: 'wx' }); cell.pngs.push({ name, bytes: png.length, sha256: proofHash(png), source: artifact.name });
      }
    }));
    await page.exposeFunction('recordPhaseEvent', (cellId, event) => persist(async () => {
      assert.equal(cellId, activeCell?.id, 'Event belongs to inactive cell.');
      const line = JSON.stringify({ cellId, at: new Date().toISOString(), event }) + '\n', size = Buffer.byteLength(line);
      assert(activeCell.events.length < PHASE_LIMITS.maxEventsPerCell && size <= PHASE_LIMITS.maxEventBytes
        && activeCell.eventBytes + size <= PHASE_LIMITS.maxCellEventBytes, 'Event cap exceeded.');
      activeCell.events.push(event); activeCell.eventBytes += size; await appendFile(resolve(output, 'events.jsonl'), line);
    }));
    await page.goto(`${server.url}/proof.html`); active();
    // One hardware device for the invocation; every renderer/cache cell is freshly owned.
    report.deviceResult = await page.evaluate(async () => {
      const errors = [], state = { errors, expectedDestroy: false, openScopes: 0 };
      const [api, workload, shaders, diagnostic] = await Promise.all([import('/proof/incremental.mjs'), fetch('/proof/workload.json').then(r => r.json()),
        fetch('/proof/shaders.json').then(r => r.json()), fetch('/proof/diagnostic-shaders.json').then(r => r.json())]);
      api.validateTraceGiPhasePlan(workload);
      if (!navigator.gpu || navigator.gpu.getPreferredCanvasFormat() !== 'bgra8unorm') throw Error('Expected native BGRA WebGPU presentation.');
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance', forceFallbackAdapter: false });
      if (!adapter || adapter.info.isFallbackAdapter !== false) throw Error('Hardware adapter classification required.');
      const device = await adapter.requestDevice({ requiredFeatures: [] }); state.device = device; state.api = api; state.workload = workload;
      globalThis.strataPhaseState = state;
      state.finishDevice = () => {
        if (!state.cleanupPromise) {
          const scopes = state.openScopes; state.openScopes = 0;
          state.cleanupPromise = api.finishProofDevice(device, scopes, () => { state.expectedDestroy = true; }, 15000);
        }
        return state.cleanupPromise;
      };
      device.addEventListener('uncapturederror', e => errors.push(`${e.error.constructor.name}: ${e.error.message}`));
      device.lost.then(info => { if (!state.expectedDestroy) errors.push(`Device lost: ${info.reason}: ${info.message}`); });
      for (const type of ['internal', 'out-of-memory', 'validation']) { device.pushErrorScope(type); state.openScopes++; }
      const frozenShaders = new Set([...Object.values(shaders), ...Object.values(diagnostic)]); state.shaderDescriptors = [];
      state.recorded = new Proxy(device, { get(target, key) {
        if (key === 'createShaderModule') return descriptor => { if (!frozenShaders.has(descriptor.code)) throw Error(`Unfrozen WGSL ${descriptor.label}`);
          state.shaderDescriptors.push({ label: descriptor.label ?? '', code: descriptor.code }); return device.createShaderModule(descriptor); };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const info = adapter.info; return { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
        isFallbackAdapter: info.isFallbackAdapter, features: [...adapter.features].sort(), format: navigator.gpu.getPreferredCanvasFormat() };
    });
    for (const run of PHASE_RUNS) {
      active(); activeCell = { ...run, bytes: 0, eventBytes: 0, artifacts: [], pngs: [], events: [] }; report.cells.push(activeCell);
      const cell = activeCell;
      const completed = await withPhaseDeadline(page.evaluate(async run => {
        const s = globalThis.strataPhaseState;
        const firstShader = s.shaderDescriptors.length;
        try {
          const api = await import(`/proof/${run.updater}.mjs`);
          const result = await api.runTraceGiPhaseCell(s.recorded, { plan: s.workload, phaseLabel: run.phaseLabel,
            manifestUrl: new URL('/external-assets/manifest.json', location.href).href, traceProxyUrl: new URL('/external-assets/trace-proxy.json', location.href).href },
          artifact => globalThis.savePhaseArtifact(run.id, artifact), value => globalThis.recordPhaseEvent(run.id, value));
          if (s.errors.length) throw Error(s.errors.join('\n')); return { result, shaderDescriptors: s.shaderDescriptors.slice(firstShader) };
        } catch (error) { return { result: { status: 'failed', failure: { message: error.message, stack: error.stack, proofEvidence: error.proofEvidence } }, shaderDescriptors: s.shaderDescriptors.slice(firstShader) }; }
      }, run), `Phase cell ${run.id}`, remainingWork(frozen.workload.maxCellMs));
      cell.result = completed.result; cell.shaderDescriptors = completed.shaderDescriptors;
      await writes; await writeFile(resolve(output, `${run.id}.json`), json(cell), { flag: 'wx' });
      assert.equal(cell.result.status, 'passed', cell.result.failure?.message); activeCell = null;
    }
    report.deviceCleanup = await page.evaluate(async () => {
      const s = globalThis.strataPhaseState;
      const cleanup = await s.finishDevice();
      return { ...cleanup, errors: [...s.errors, ...cleanup.errors], shaders: s.shaderDescriptors };
    });
    assert.deepEqual(report.deviceCleanup.errors, []); report.cleanup.deviceDestroyed = report.deviceCleanup.destroyed === true;
    active();
    report.comparison = await compareTraceGiPhaseCells(report.cells, async (cell, name) => readFile(resolve(output, cell.id, name)));
    await verifyPhase(args['--manifest'], args['--manifest-sha256']); active();
    report.status = 'pass';
  };
  // Work stops early enough to close and confirm the exact owned browser before the whole300s cap.
  watchdog = setTimeout(() => { stopped = true; report.cleanup.forcedKill = true; void browserServer?.kill().catch(e => report.browserErrors.push(String(e))); },
    Math.max(1, PHASE_LIMITS.totalMs - 1000 - (performance.now() - started)));
  try { await withPhaseDeadline(work(), 'Phase diagnostic work', Math.max(1, PHASE_LIMITS.workMs - (performance.now() - started))); }
  catch (error) { report.status = 'fail'; report.failure = { message: error.message, stack: error.stack, proofDifference: error.proofDifference, proofEvidence: error.proofEvidence }; }
  finally {
    stopped = true; acceptingCallbacks = false;
    try {
      if (browser && !report.cleanup.deviceDestroyed) {
        // Failure cleanup is also recorded; cell resources are destroyed by the helper's finally block.
        const pages = browser.contexts().flatMap(c => c.pages());
        if (pages[0]) report.failedDeviceCleanup = await withPhaseDeadline(pages[0].evaluate(async () => {
          const s = globalThis.strataPhaseState; if (!s) return null;
          return s.finishDevice();
        }), 'Failure device cleanup', 2000);
      }
    } catch (error) { report.browserErrors.push(String(error)); }
    try {
      await withPhaseDeadline((async () => {
        const cleanup = await Promise.allSettled([
          (async () => { if (browserServer) await closePhaseBrowser(browserServer); report.cleanup.browserExited = true; })(),
          (async () => { if (server) await server.close(); report.cleanup.serverClosed = true; })(),
        ]);
        for (const item of cleanup) if (item.status === 'rejected') { report.status = 'fail'; report.browserErrors.push(String(item.reason)); }
        // Callback admission is closed; drain the complete accepted chain only after browser closure.
        await writes; report.cleanup.artifactsDrained = true;
        await verifyPhase(args['--manifest'], args['--manifest-sha256']); report.cleanup.frozenInputsVerified = true;
      })(), 'Browser/server/artifact cleanup', PHASE_LIMITS.cleanupMs);
    } catch (error) { report.status = 'fail'; report.browserErrors.push(String(error)); }
    if (browserServer && !report.cleanup.browserExited) {
      report.cleanup.forcedKill = true;
      try { await withPhaseDeadline(browserServer.kill(), 'Owned browser kill', Math.max(1, PHASE_LIMITS.totalMs - (performance.now() - started) - 100));
        const p = browserServer.process(); report.cleanup.browserExited = p.exitCode !== null || p.signalCode !== null;
      } catch (error) { report.browserErrors.push(String(error)); }
    }
    clearTimeout(watchdog); finalizePhaseStatus(report, performance.now() - started);
    report.completedAt = new Date().toISOString(); report.totalRawBytes = totalBytes;
    await writeFile(resolve(output, 'report.json'), json(report), { flag: 'wx' });
  }
  return { path: resolve(output, 'report.json'), status: report.status };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const args = parsePhaseArguments(process.argv.slice(2)); const result = args['--prepare-only'] ? await preparePhase(args) : await runPhase(args);
    console.log(json(result)); if (result.status === 'fail') process.exitCode = 1;
  } catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
