import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, platform } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';

const prepareOnly = process.argv.length === 3 && process.argv[2] === '--prepare-only';
if (process.argv.length !== 2 && !prepareOnly) throw new Error('Usage: node scripts/test-imported-progressive.mjs [--prepare-only]');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runnerPath = fileURLToPath(import.meta.url), harnessPath = 'tests/browser/imported-progressive-validation.ts';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = () => {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), dirty: status !== '', status };
};
async function files(directory) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else { assert(entry.isFile(), `Unexpected non-file in built package: ${path}`); result.push(path); }
  }
  return result;
}
async function builtIdentity() {
  return Object.fromEntries(await Promise.all((await files(join(root, 'packages/core/dist'))).map(async path => {
    const bytes = await readFile(path); return [relative(root, path), { bytes: bytes.length, sha256: hash(bytes) }];
  })));
}
const { PNG } = createRequire(import.meta.url)(join(root, 'node_modules/playwright-core/lib/utilsBundle.js'));
const output = join(homedir(), 'Downloads/Strata-Benchmark-Results', `${new Date().toISOString().replaceAll(':', '-')}-imported-progressive-public`);
await mkdir(output, { recursive: true });
const report = { kind: 'strata-imported-progressive-public-generated', status: 'running', performanceEvidence: false,
  sourceBefore: source(), softwareGpu: process.env.STRATA_TEST_SOFTWARE_GPU === '1', prepareOnly,
  browserErrors: [], requestFailures: [], responseErrors: [], cleanupErrors: [], loadedRuntime: [], publicLoadingStages: [],
  limitations: ['Generated fixture geometry/images only; no external asset collection is served or copied.',
    'The browser imports the built public package over HTTP. The harness contains no bundled runtime source; this is not an archive-install packaging test.',
    'Functional API, pixels, scheduling and resource lifecycle evidence; no timing, scanout or frame-rate claim.',
    'Readback counters carry their own accumulation revision and submitted-frame count; frame count is not samples per pixel.'] };
let browser, server, timer, context, harnessBytes, runnerBytes, bundleBytes;
const pendingResponses = [];
async function drainResponses() {
  let count = -1;
  while (count !== pendingResponses.length) { count = pendingResponses.length; await Promise.all(pendingResponses); }
}
async function verifyIdentity() {
  report.sourceAfter = source(); assert.deepEqual(report.sourceAfter, report.sourceBefore, 'Source identity changed during validation.');
  report.builtAfter = await builtIdentity(); assert.deepEqual(report.builtAfter, report.builtBefore, 'Built package bytes changed during validation.');
  report.harnessAfterSha256 = hash(await readFile(join(root, harnessPath)));
  report.runnerAfterSha256 = hash(await readFile(runnerPath));
  report.bundleAfterSha256 = hash(await readFile(join(output, 'bundle.js')));
  assert.equal(report.harnessAfterSha256, report.harnessSha256, 'Browser harness changed during validation.');
  assert.equal(report.runnerAfterSha256, report.runnerSha256, 'Runner changed during validation.');
  assert.equal(report.bundleAfterSha256, report.bundleSha256, 'External harness bundle changed during validation.');
}
async function persistCaptures(captures = []) {
  const names = new Set();
  for (const capture of captures) {
    assert(/^[a-z0-9][a-z0-9-]*$/.test(capture.name) && !names.has(capture.name), 'Capture names must be unique safe filenames.'); names.add(capture.name);
    assert(typeof capture.png === 'string' && /^data:image\/png;base64,/.test(capture.png), 'Capture must be a PNG data URL.');
    const bytes = Buffer.from(capture.png.slice('data:image/png;base64,'.length), 'base64'), image = PNG.sync.read(bytes);
    assert.equal(image.width, capture.width); assert.equal(image.height, capture.height);
    const file = `${capture.name}.png`; await writeFile(join(output, file), bytes);
    capture.file = file; capture.bytes = bytes.length; capture.sha256 = hash(bytes); delete capture.png;
  }
}
try {
  report.builtBefore = await builtIdentity();
  for (const path of ['index.js', 'worker.js', 'strata_runtime.wasm']) assert(report.builtBefore[`packages/core/dist/${path}`], 'Run npm run build before public validation.');
  const effectPaths = Object.keys(report.builtBefore).filter(path => /\/imported-indirect-effect-[^/]+\.js$/.test(path));
  const preparationPaths = Object.keys(report.builtBefore).filter(path => /\/static-trace-data-[^/]+\.js$/.test(path));
  assert(effectPaths.length && preparationPaths.length, 'Built package is missing the optional progressive modules; run npm run build.');
  const spatialPaths = Object.keys(report.builtBefore).filter(path => /\/imported-indirect-spatial-shader-[^/]+\.js$/.test(path));
  assert(spatialPaths.length, 'Built package is missing the separately loaded spatial reconstruction module.');
  report.lazyModules = { effectPaths, preparationPaths, spatialPaths };
  harnessBytes = await readFile(join(root, harnessPath)); runnerBytes = await readFile(runnerPath);
  const bundle = await build({ absWorkingDir: root, entryPoints: [harnessPath], bundle: true, write: false, metafile: true,
    external: ['/packages/core/dist/*'], format: 'esm', platform: 'browser', target: 'es2022' });
  assert.deepEqual(Object.keys(bundle.metafile.inputs), [harnessPath], 'Public harness must not bundle runtime source or a competing runtime implementation.');
  bundleBytes = bundle.outputFiles[0].contents;
  assert(/["']\/packages\/core\/dist\/index\.js["']/.test(bundle.outputFiles[0].text) && /\bimport\s*\(/.test(bundle.outputFiles[0].text), 'Public package import must remain a real browser HTTP import.');
  report.bundleInputs = bundle.metafile.inputs;
  report.bundleSha256 = hash(bundleBytes); report.harnessSha256 = hash(harnessBytes); report.runnerSha256 = hash(runnerBytes);
  await Promise.all([writeFile(join(output, 'bundle.js'), bundleBytes), writeFile(join(output, 'harness.ts'), harnessBytes), writeFile(join(output, 'runner.mjs'), runnerBytes)]);
  await verifyIdentity();
  if (prepareOnly) report.status = 'prepared';
  else {
    server = await createBenchmarkServer({ assetRoot: '' });
    const args = ['--enable-unsafe-webgpu'];
    if (report.softwareGpu) args.push(...(platform() === 'linux'
      ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
      : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
    const channel = process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headless = process.env.STRATA_TEST_HEADED !== '1';
    browser = await chromium.launch({ channel, headless, args });
    report.browser = { version: browser.version(), channel, headless, args, platform: platform(), node: process.version };
    context = await browser.newContext({ viewport: { width: 640, height: 480 }, serviceWorkers: 'block' });
    context.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== server.url || !url.pathname.startsWith('/packages/core/dist/')) return;
      const path = url.pathname.slice(1);
      pendingResponses.push((async () => {
        const record = { path, status: response.status(), resourceType: response.request().resourceType() };
        report.loadedRuntime.push(record);
        const bytes = await response.body(), expected = report.builtBefore[path];
        record.bytes = bytes.length; record.sha256 = hash(bytes);
        const headers = response.headers();
        record.contentType = headers['content-type'] ?? null;
        record.coop = headers['cross-origin-opener-policy'] ?? null; record.coep = headers['cross-origin-embedder-policy'] ?? null;
        assert.equal(record.status, 200, `Runtime HTTP error: ${path}`);
        assert(expected, `Runtime request not present in the frozen package: ${path}`);
        assert.deepEqual({ bytes: record.bytes, sha256: record.sha256 }, expected, `Served runtime bytes differ from the frozen package: ${path}`);
        assert.equal(record.coop, null); assert.equal(record.coep, null);
        const saved = join(output, 'loaded-runtime', path); await mkdir(dirname(saved), { recursive: true }); await writeFile(saved, bytes);
      })().catch(error => { report.responseErrors.push(error.stack ?? String(error)); }));
    });
    context.on('requestfailed', request => report.requestFailures.push({ url: request.url(), error: request.failure()?.errorText ?? 'unknown' }));
    const page = await context.newPage();
    page.on('pageerror', error => report.browserErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.browserErrors.push(message.text()); });
    await page.exposeFunction('__strataProgressiveStage', async name => {
      await drainResponses(); assert.deepEqual(report.responseErrors, []);
      const paths = [...new Set(report.loadedRuntime.map(record => record.path))].sort();
      const effect = effectPaths.filter(path => paths.includes(path)), preparation = preparationPaths.filter(path => paths.includes(path));
      const spatial = spatialPaths.filter(path => paths.includes(path));
      const stages = ['empty', 'direct', 'progressive', 'spatial', 'complete'];
      assert.equal(name, stages[report.publicLoadingStages.length], 'Unexpected or duplicate public loading stage.');
      report.publicLoadingStages.push({ name, paths, effect, preparation, spatial });
      if (['empty', 'direct', 'progressive'].includes(name)) assert.equal(spatial.length, 0, `${name} eagerly loaded spatial reconstruction.`);
      else assert(spatial.length > 0, 'Capability scene did not load spatial reconstruction.');
      if (name === 'empty' || name === 'direct') {
        assert.equal(effect.length, 0, `${name} scene eagerly loaded the indirect effect.`);
        assert.equal(preparation.length, 0, `${name} scene eagerly loaded static tracing preparation.`);
      } else {
        assert(effect.length > 0, 'Progressive scene did not load its indirect effect.');
        assert(preparation.length > 0, 'Progressive scene did not load static tracing preparation.');
      }
      console.log(`Public progressive stage: ${name}`);
    });
    const htmlPath = '/tests/imported-progressive/index.html', scriptPath = '/tests/imported-progressive/harness.js';
    await context.route(`${server.url}${htmlPath}`, route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Strata public progressive checks</title></head><body></body></html>' }));
    await context.route(`${server.url}${scriptPath}`, route => route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: Buffer.from(bundleBytes) }));
    const navigation = await page.goto(`${server.url}${htmlPath}`); assert(navigation?.ok(), 'Generated validation page failed to load.');
    assert.equal(navigation.headers()['cross-origin-opener-policy'], undefined); assert.equal(navigation.headers()['cross-origin-embedder-policy'], undefined);
    report.pageUrl = page.url();
    report.result = await Promise.race([
      page.evaluate(async path => (await import(path)).validateImportedProgressive(), scriptPath),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Public progressive validation exceeded 180 seconds.')), 180_000); }),
    ]);
    // Preserve completed cases and images even if a later browser assertion failed.
    await persistCaptures(report.result.captures);
    assert.equal(report.result.status, 'passed', report.result.failure ?? 'Public progressive browser checks failed.');
    assert.equal(report.result.ordinaryHosting.crossOriginIsolated, false);
    for (const field of ['allocatedGpuBufferBytes', 'allocatedGpuTextureBytes', 'wasmMemoryBytes']) assert.equal(report.result.disposed?.[field], 0, `Disposal retained ${field}.`);
    assert.deepEqual(report.publicLoadingStages.map(stage => stage.name), ['empty', 'direct', 'progressive', 'spatial', 'complete']);
    if (!report.softwareGpu) {
      assert.notEqual(report.result.adapter.isFallbackAdapter, true, 'Hardware validation selected a fallback adapter.');
      assert(!/swiftshader|llvmpipe|software rasterizer|software adapter/i.test(JSON.stringify(report.result.adapter)), 'Hardware validation selected a software adapter.');
    }
    await drainResponses();
    for (const path of ['packages/core/dist/index.js', 'packages/core/dist/worker.js', 'packages/core/dist/strata_runtime.wasm']) {
      assert(report.loadedRuntime.some(record => record.path === path && record.status === 200 && record.sha256 === report.builtBefore[path].sha256), `Missing actual HTTP body evidence: ${path}`);
    }
    assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.requestFailures, []); assert.deepEqual(report.responseErrors, []);
    await verifyIdentity(); report.status = 'passed';
  }
} catch (error) { report.status = 'failed'; report.failure = error.stack ?? String(error); process.exitCode = 1; }
finally {
  clearTimeout(timer);
  for (const cleanup of [async () => context?.close(), async () => browser?.close(), async () => server?.close()]) {
    try { await cleanup(); } catch (error) { report.cleanupErrors.push(error.stack ?? String(error)); }
  }
  await drainResponses();
  if (report.responseErrors.length || report.cleanupErrors.length) { report.status = 'failed'; process.exitCode = 1; }
  try { if (bundleBytes) await verifyIdentity(); } catch (error) { report.status = 'failed'; report.identityFailure = error.stack ?? String(error); process.exitCode = 1; }
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(output, 'report.json'), bytes); await writeFile(join(output, 'report.sha256'), `${hash(bytes)}  report.json\n`);
  console.log(`Public imported progressive checks ${report.status}. External report: ${output}/report.json`);
}
