import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, homedir, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createBenchmarkServer } from './benchmark-server.mjs';
import { prepareGalleryOutput } from './gallery-output.mjs';

const runnerPath = fileURLToPath(import.meta.url);
const repository = resolve(dirname(runnerPath), '..');
const command = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonicalJson = value => JSON.stringify(order(JSON.parse(JSON.stringify(value))));
function order(value) {
  return Array.isArray(value) ? value.map(order) : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, order(value[key])])) : value;
}
let prepareOnly = false, requestedOutput;
const parameters = process.argv.slice(2);
for (let index = 0; index < parameters.length; index++) {
  const argument = parameters[index];
  if (argument === '--prepare-only' && !prepareOnly) { prepareOnly = true; continue; }
  if (argument === '--output' && requestedOutput === undefined && parameters[index + 1] && !parameters[index + 1].startsWith('--')) {
    requestedOutput = parameters[++index]; continue;
  }
  throw new Error(`Unknown, repeated or incomplete geometry initialization argument: ${argument}`);
}
const directory = await prepareGalleryOutput(resolve(requestedOutput ?? resolve(homedir(), 'Downloads/Strata-Benchmark-Results',
  `${new Date().toISOString().replaceAll(':', '-')}-geometry-initialization`)));
assert.deepEqual(await readdir(directory), [], 'Use a fresh evidence directory.');
const harnessPath = 'tests/browser/geometry-initialization-validation.ts';
const artifactPath = resolve(directory, 'geometry-initialization-validation.mjs');
const report = {
  kind: 'strata-geometry-initialization-validation-v1', status: 'running', stage: 'source', prepareOnly,
  performanceEvidence: false, softwareGpuRequested: process.env.STRATA_TEST_SOFTWARE_GPU === '1',
  host: { platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model ?? null, memoryBytes: totalmem(), node: process.version },
  source: {}, results: {}, routes: [], expectedAborts: [], routeErrors: [], browserErrors: [], requestFailures: [], responseErrors: [], cleanupErrors: [], identityErrors: [],
  limitations: [
    'Generated analytic terrain only; no external benchmark collection is read, served, copied or uploaded.',
    '--prepare-only cooks and hashes sources, bundles the harness and validates its plan without launching a browser or requesting an adapter.',
    'Queue receipts hash CPU write arguments accepted by native queue calls; they are not GPU buffer readbacks or GPU completion evidence.',
    'GPU evidence is production selection feedback plus presentation/depth texture readbacks; production buffer usages remain unchanged.',
    'The direct harness imports internal source; the separate smoke imports built public Core. Packed consumers are checked by the unchanged test:consumers command.',
    'Initialization allowance excludes normal prepare/render writes. Details are deliberately held to compare identical coarse residency.',
    'Correctness only: no performance, general world streaming, temporal history quality, imported assets or arbitrary scene claim.',
  ],
};
let browser, context, server, artifact, inputPaths, fixtureDirectory;
const routes = new Map(), held = new Map(), routeHandlers = new Set();
function errorDetails(error) {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? null,
    ...(error.details === undefined ? {} : { details: error.details }) } : { message: String(error) };
}
async function persistReport() {
  assert.equal(await realpath(directory), directory, 'Evidence directory changed.');
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(directory, 'report.json'), bytes);
  await writeFile(resolve(directory, 'report.sha256'), `${hash(bytes)}  report.json\n`);
}
async function revision() {
  const [head, tree, status, diff] = await Promise.all([
    command('git', ['rev-parse', 'HEAD'], { cwd: repository }),
    command('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repository }),
    command('git', ['status', '--porcelain=v1'], { cwd: repository }),
    command('git', ['diff', '--binary', 'HEAD'], { cwd: repository, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }),
  ]);
  return { commit: head.stdout.trim(), tree: tree.stdout.trim(), dirty: status.stdout.length !== 0, status: status.stdout,
    trackedDiffSha256: hash(diff.stdout), runnerSha256: hash(await readFile(runnerPath)) };
}
async function fileHashes(paths) {
  return Promise.all(paths.map(async path => { const bytes = await readFile(resolve(repository, path));
    return { path, bytes: bytes.length, sha256: hash(bytes) }; }));
}
async function runtimeFiles(path = resolve(repository, 'packages/core/dist'), prefix = '') {
  const files = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) files.push(...await runtimeFiles(resolve(path, entry.name), `${prefix}${entry.name}/`));
    else {
      assert(entry.isFile(), 'Built package must contain ordinary files.');
      const bytes = await readFile(resolve(path, entry.name));
      files.push({ path: `${prefix}${entry.name}`, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  return files;
}
async function bounded(promise, label, timeoutMs = 180000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
async function verifyIdentity() {
  for (const [name, read, before] of [
    ['revision', revision, report.source.before],
    ['runtime', runtimeFiles, report.source.builtRuntimeBefore],
    ['inputs', () => fileHashes(inputPaths), report.source.inputsBefore],
    ['bundle', async () => hash(await readFile(artifactPath)), report.source.harnessSha256],
  ]) {
    if (before === undefined) continue;
    try { const after = await read(); report.source[`${name}After`] = after;
      assert.deepEqual(after, before, `${name} identity changed during validation.`);
    } catch (error) { report.identityErrors.push({ stage: name, ...errorDetails(error) }); }
  }
}
async function cookSource({ id, seed, tiles, cells, poolPages, expected }) {
  const output = resolve(fixtureDirectory, id);
  const args = ['run', '--release', '--locked', '--package', 'strata-geometry-cooker', '--',
    '--output', output, '--seed', String(seed), '--tiles', String(tiles), '--cells', String(cells)];
  const result = await command('cargo', args, { cwd: repository, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  const raw = await readFile(resolve(output, 'manifest.json'));
  const manifest = JSON.parse(raw.toString('utf8'));
  assert.equal(manifest.source.kind, 'analytic-heightfield-v1');
  assert.equal(manifest.source.seed, seed); assert.equal(manifest.source.tilesPerSide, tiles); assert.equal(manifest.source.cellsPerTile, cells);
  assert.equal(manifest.pageBytes, 65536); assert.equal(manifest.pages.length, expected.pages);
  assert.equal(manifest.rootPageIds.length, expected.roots); assert.equal(manifest.source.triangleCount, expected.triangles);
  const manifestUrl = `/__host-init__/${id}/manifest.json`;
  routes.set(manifestUrl, { body: raw, contentType: 'application/json', source: id, hold: false });
  const pageHashes = [];
  for (const page of manifest.pages) {
    assert.equal(page.url, `pages/${String(page.id).padStart(6, '0')}.bin`);
    const bytes = await readFile(resolve(output, page.url));
    assert.equal(bytes.length, 65536); assert.equal(hash(bytes), page.sha256, `Cooked page hash ${id}/${page.id}`);
    pageHashes.push({ id: page.id, bytes: bytes.length, sha256: page.sha256 });
    routes.set(`/__host-init__/${id}/${page.url}`, { body: bytes, contentType: 'application/octet-stream', source: id,
      pageId: page.id, hold: !manifest.rootPageIds.includes(page.id) });
  }
  report.results[`cooker-${id}`] = { command: ['cargo', ...args.map(value => value === output ? '<temporary fixture>' : value)],
    stdout: result.stdout, stderr: result.stderr, pageHashes };
  return { id, manifestUrl, manifest, manifestSha256: hash(raw), pageHashes, poolPages, rootPageIndices: manifest.rootPageIds };
}

try {
  report.source.before = await revision();
  report.source.builtRuntimeBefore = await runtimeFiles();
  assert(report.source.builtRuntimeBefore.some(file => file.path === 'index.js'), 'Run npm run build first.');
  const cookerFiles = (await command('git', ['ls-files', 'crates/geometry-cooker', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'], { cwd: repository })).stdout.trim().split('\n');
  report.stage = 'bundle';
  const bundle = await build({ absWorkingDir: repository, entryPoints: [harnessPath], bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', write: false, metafile: true });
  assert.equal(bundle.outputFiles.length, 1);
  artifact = bundle.outputFiles[0].contents;
  inputPaths = [...new Set([...Object.keys(bundle.metafile.inputs), ...cookerFiles, 'scripts/test-geometry-initialization.mjs',
    'scripts/benchmark-server.mjs', 'scripts/gallery-output.mjs', 'scripts/build.mjs', 'package.json', 'package-lock.json',
    'scripts/test-geometry.mjs', 'scripts/test-geometry-fallback.mjs', 'scripts/test-geometry-retention.mjs', 'scripts/test-consumers.mjs'])].sort();
  report.source.inputsBefore = await fileHashes(inputPaths);
  report.source.harnessSha256 = hash(artifact);
  await writeFile(artifactPath, artifact);
  report.stage = 'cpu-preparation';
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'strata-host-init-webgpu-'));
  const sources = [];
  // Sequential cooker jobs keep this CPU preparation bounded and avoid Cargo build-lock contention.
  sources.push(await cookSource({ id: 'large', seed: 45, tiles: 4, cells: 64, poolPages: 4,
    expected: { pages: 80, roots: 3, triangles: 131072 } }));
  sources.push(await cookSource({ id: 'small', seed: 46, tiles: 2, cells: 8, poolPages: 2,
    expected: { pages: 2, roots: 1, triangles: 512 } }));
  for (const alias of ['cancel', 'corrupt']) {
    for (const [path, entry] of [...routes]) {
      if (!path.startsWith('/__host-init__/small/')) continue;
      const body = Buffer.from(entry.body);
      const root = entry.pageId !== undefined && sources[1].rootPageIndices.includes(entry.pageId);
      if (alias === 'corrupt' && root) body[0] ^= 1;
      routes.set(path.replace('/small/', `/${alias}/`), { ...entry, body, source: alias,
        hold: entry.pageId !== undefined && (alias === 'cancel' || entry.hold), corrupt: alias === 'corrupt' && root });
    }
  }
  const module = await import(pathToFileURL(artifactPath).href);
  assert.equal(typeof module.runGeometryInitializationValidation, 'function');
  assert.equal(typeof module.prepareGeometryInitializationValidation, 'function');
  const input = { sources };
  report.results.preparation = await module.prepareGeometryInitializationValidation(input);
  report.source.preparationCanonicalSha256 = hash(canonicalJson(report.results.preparation));
  report.source.preparationHashDefinition = 'SHA256 of UTF-8 JSON with recursively sorted object keys and preserved array order.';
  report.results.executionPlan = { directSubmissions: 12, publicEngineFrames: 1,
    directTimeoutMs: 180000, publicTimeoutMs: 60000,
    afterAllocation: ['npm run test:geometry:initialization -- --output <fresh external directory>', 'npm run test:geometry', 'npm run test:consumers'],
    localGpuAuthorizedByThisPreparation: false };
  await writeFile(resolve(directory, 'preparation.json'), `${JSON.stringify(report.results.preparation, null, 2)}\n`);
  await persistReport();
  console.log(`Geometry initialization CPU preparation passed; canonical SHA256 ${report.source.preparationCanonicalSha256}.`);
  if (prepareOnly) report.status = 'prepared';
  else {
    report.stage = 'browser-start';
    server = await createBenchmarkServer({ assetRoot: '' });
    const args = ['--enable-unsafe-webgpu'];
    if (report.softwareGpuRequested) args.push(...(platform() === 'linux'
      ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
      : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
    const { chromium } = await import('playwright');
    const channel = process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headless = process.env.STRATA_TEST_HEADED !== '1';
    browser = await chromium.launch({ channel, headless, args });
    report.browser = { version: browser.version(), channel, headless, args };
    context = await browser.newContext({ viewport: { width: 900, height: 750 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    context.on('requestfailed', request => {
      const pending = held.get(request);
      const receipt = { url: request.url(), error: request.failure()?.errorText ?? 'unknown' };
      if (pending) {
        if (pending.receipt.expectedReason && receipt.error === 'net::ERR_ABORTED') report.expectedAborts.push({ ...receipt, reason: pending.receipt.expectedReason });
        else report.requestFailures.push({ ...receipt, reason: pending.receipt.expectedReason ?? 'No disposal intent announced.' });
        pending.receipt.outcome = 'aborted'; pending.resolve();
      } else report.requestFailures.push(receipt);
    });
    context.on('response', response => { if (response.status() >= 400) report.responseErrors.push({ url: response.url(), status: response.status() }); });
    const scriptPath = '/geometry-initialization-validation.mjs', htmlPath = '/geometry-initialization-validation.html';
    await context.route(`${server.url}${scriptPath}`, route => route.fulfill({ contentType: 'text/javascript', body: Buffer.from(artifact) }));
    await context.route(`${server.url}${htmlPath}`, route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Strata geometry initialization</title><canvas id="engine" width="256" height="256"></canvas>' }));
    await context.route(`${server.url}/__host-init__/**`, route => {
      const action = (async () => {
        try {
          const path = new URL(route.request().url()).pathname, entry = routes.get(path);
          assert(entry, `Unexpected fixture request: ${path}`);
          const receipt = { path, source: entry.source, pageId: entry.pageId ?? null,
            outcome: entry.hold ? 'held' : 'delivered', corrupt: entry.corrupt ?? false, bytes: entry.hold ? 0 : entry.body.length,
            deliveredSha256: entry.hold ? null : hash(entry.body) };
          report.routes.push(receipt);
          if (entry.hold) {
            await new Promise(resolve => held.set(route.request(), { resolve, receipt, route }));
            // Finish the route action even when the browser already aborted its request.
            await route.abort('aborted');
            held.delete(route.request());
          } else await route.fulfill({ contentType: entry.contentType, body: entry.body, headers: { 'content-length': String(entry.body.length) } });
        } catch (error) {
          report.routeErrors.push({ url: route.request().url(), ...errorDetails(error) });
          try { await route.abort('failed'); } catch (abortError) { report.routeErrors.push(errorDetails(abortError)); }
          held.delete(route.request());
        }
      })();
      routeHandlers.add(action);
      return action.finally(() => routeHandlers.delete(action));
    });
    const page = await context.newPage();
    await page.exposeFunction('__strataInitializationBeforeDispose', async sourceId => {
      assert(['large', 'small', 'cancel', 'corrupt'].includes(sourceId), 'Unknown disposal source.');
      // The cancellation case must reach the held HTTP route before its abort is authorized.
      if (sourceId === 'cancel' && !report.routes.some(route => route.source === 'cancel' && route.outcome === 'aborted')) {
        const deadline = Date.now() + 5000;
        while (![...held.values()].some(pending => pending.receipt.source === sourceId)) {
          assert(Date.now() < deadline, 'Cancellation root route observation exceeded 5000ms.');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      for (const pending of held.values()) if (pending.receipt.source === sourceId) pending.receipt.expectedReason = 'provider-dispose';
    });
    page.on('pageerror', error => report.browserErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.browserErrors.push(message.text()); });
    const navigation = await page.goto(`${server.url}${htmlPath}`);
    assert(navigation?.ok(), 'Initialization validation page failed to load.');
    report.stage = 'direct-webgpu';
    await persistReport();
    report.results.browser = await bounded(page.evaluate(async ({ path, input }) => {
      try { const harness = await import(path);
        return { status: 'passed', rendered: await harness.runGeometryInitializationValidation({ ...input,
          beforeDispose: sourceId => globalThis.__strataInitializationBeforeDispose(sourceId) }) };
      } catch (error) { return { status: 'failed', failure: { name: error?.name, message: error?.message ?? String(error),
        stack: error?.stack ?? null, details: error?.details ?? null } }; }
    }, { path: scriptPath, input: { ...input, expectedPreparationHash: report.source.preparationCanonicalSha256 } }), 'Direct WebGPU validation');
    const capturedImages = report.results.browser.rendered?.images;
    if (capturedImages) for (const [name, dataUrl] of Object.entries(capturedImages)) {
      assert(/^(host|eager)-(large|small)-(coverage|final|resized-final)$/.test(name), 'Unexpected capture name.');
      assert(typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,'), 'Expected an inline PNG readback witness.');
      const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
      assert(bytes.length > 8 && bytes.length < 4 * 1024 * 1024, 'Capture exceeds its bounded dimensions.');
      const path = resolve(directory, `${name}.png`);
      await writeFile(path, bytes);
      capturedImages[name] = { path, bytes: bytes.length, sha256: hash(bytes) };
    }
    await persistReport();
    const rendered = report.results.browser.rendered;
    assert.equal(report.results.browser.status, 'passed', report.results.browser.failure?.message);
    assert.equal(rendered.passed, true);
    assert.equal(hash(canonicalJson(rendered.preparation)), report.source.preparationCanonicalSha256, 'Browser preparation differs from preregistered plan.');
    await bounded(Promise.all([...routeHandlers]), 'Direct provider HTTP disposal', 10000);
    assert.equal(held.size, 0, 'Direct providers left held HTTP requests before runner cleanup.');
    report.results.directHttpOwnershipBeforeRunnerCleanup = { heldRequests: held.size, routeHandlers: routeHandlers.size };
    report.stage = 'built-public-engine';
    report.results.engine = await bounded(page.evaluate(async manifestUrl => {
      const { createEngine } = await import('/packages/core/dist/index.js');
      const canvas = document.querySelector('#engine');
      const engine = await createEngine({ canvas, profiling: true });
      try {
        engine.resize(256, 256);
        await engine.setScene({ renderer: 'virtual', manifestUrl, cameraMode: 'coverage', pixelError: 1000, poolBytes: 131072 });
        const frame = engine.render({ temporal: false, debugView: 'coverage', timeSeconds: 0 });
        await engine.flushGpuTimings();
        return { info: engine.info, frame, telemetry: engine.getTelemetry(), crossOriginIsolated: globalThis.crossOriginIsolated };
      } finally { await globalThis.__strataInitializationBeforeDispose('small'); engine.dispose(); }
    }, sources[1].manifestUrl), 'Built public Engine smoke', 60000);
    const engine = report.results.engine;
    assert.equal(engine.crossOriginIsolated, false); assert.equal(engine.telemetry.gpuErrorCount, 0);
    assert.equal(engine.telemetry.geometry.sourceFrameId, engine.frame.frameId);
    assert.equal(engine.telemetry.geometry.coverageMissingTiles, 0); assert.equal(engine.telemetry.geometry.overflowCount, 0);
    assert(engine.telemetry.geometry.selectedTriangles > 0 && engine.telemetry.geometry.shadowTriangles > 0);
    assert.equal(engine.frame.drawCalls, 3); assert.equal(engine.frame.dispatchCalls, 2);
    await bounded(Promise.all([...routeHandlers]), 'Public Engine HTTP disposal', 10000);
    assert.equal(held.size, 0, 'Public Engine left held HTTP requests before runner cleanup.');
    report.results.publicHttpOwnershipBeforeRunnerCleanup = { heldRequests: held.size, routeHandlers: routeHandlers.size };
    assert(report.routes.some(route => route.source === 'cancel' && route.pageId !== null && route.outcome === 'aborted'));
    assert(report.routes.some(route => route.source === 'corrupt' && route.corrupt && route.outcome === 'delivered'));
    assert(report.routes.filter(route => route.outcome === 'delivered' && route.pageId !== null && !route.corrupt)
      .every(route => sources.find(source => source.id === route.source)?.rootPageIndices.includes(route.pageId)), 'A non-root page was delivered.');
    assert.deepEqual(report.routeErrors, []); assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.requestFailures, []); assert.deepEqual(report.responseErrors, []);
    report.status = 'passed';
  }
} catch (error) {
  report.status = 'failed'; report.failure = errorDetails(error); process.exitCode = 1;
} finally {
  // Forced runner cleanup is a failure, never evidence of provider disposal.
  if (held.size) report.cleanupErrors.push({ message: `${held.size} held requests required forced runner cleanup.` });
  for (const pending of held.values()) {
    pending.receipt.outcome = 'forced-runner-cleanup'; pending.resolve();
  }
  try { await bounded(Promise.all([...routeHandlers]), 'Fixture route cleanup', 10000); }
  catch (error) { report.cleanupErrors.push(errorDetails(error)); }
  for (const [name, resource] of [['context', context], ['browser', browser], ['server', server]]) {
    try { await resource?.close(); } catch (error) { report.cleanupErrors.push({ resource: name, ...errorDetails(error) }); }
  }
  if (fixtureDirectory) {
    try { await rm(fixtureDirectory, { recursive: true, force: true }); report.generatedFixtureCleanup = 'removed'; }
    catch (error) { report.cleanupErrors.push({ resource: 'generated fixtures', ...errorDetails(error) }); }
  }
  await verifyIdentity();
  if (report.cleanupErrors.length || report.identityErrors.length || report.routeErrors.length || report.browserErrors.length || report.requestFailures.length || report.responseErrors.length) {
    report.status = 'failed'; process.exitCode = 1;
  }
  report.finalStage = report.stage;
  await persistReport();
  console.log(`Geometry initialization ${prepareOnly ? 'CPU preparation' : 'functional validation'} ${report.status}. External report: ${directory}/report.json`);
}
