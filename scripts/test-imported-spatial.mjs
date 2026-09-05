import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';

if (process.argv.length !== 2) throw new Error('Usage: node scripts/test-imported-spatial.mjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = () => ({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  status: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }) });
const initialSource = source(), modules = {};
const harnessPath = 'tests/browser/imported-indirect-spatial-validation.ts';
const harness = await readFile(join(root, harnessPath));
const runner = await readFile(fileURLToPath(import.meta.url));
const fixtureNames = [];
const fixtures = new Map(await Promise.all(fixtureNames.map(async name => [name, await readFile(join(root, 'tests/fixtures', name))])));
const bundle = await build({ absWorkingDir: root, entryPoints: [harnessPath], bundle: true, write: false,
  format: 'esm', platform: 'browser', target: 'es2022', plugins: [{ name: 'record-imported-indirect-source', setup(builder) {
    builder.onLoad({ filter: /(?:packages\/core\/src|tests\/helpers)\/.*\.ts$/ }, async ({ path }) => {
      const contents = await readFile(path); modules[relative(root, path)] = hash(contents); return { contents, loader: 'ts' };
    });
  } }] });
assert.deepEqual(source(), initialSource, 'Source identity changed while preparing the validation bundle.');
const output = join(homedir(), 'Downloads/Strata-Benchmark-Results', `${new Date().toISOString().replaceAll(':', '-')}-imported-spatial-validation`);
await mkdir(output, { recursive: true });
await writeFile(join(output, 'bundle.js'), bundle.outputFiles[0].contents);
await writeFile(join(output, 'harness.ts'), harness); await writeFile(join(output, 'runner.mjs'), runner);
const report = { kind: 'strata-imported-spatial-reconstruction-generated', status: 'running', performanceEvidence: false,
  sourceBefore: initialSource, modules, bundleSha256: hash(bundle.outputFiles[0].contents), harnessSha256: hash(harness), runnerSha256: hash(runner),
  fixtures: [...fixtures].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: hash(bytes) })),
  softwareGpu: process.env.STRATA_TEST_SOFTWARE_GPU === '1', browserErrors: [], requestFailures: [], cleanupErrors: [],
  limitations: ['Only generated geometry and immutable generated environment references are loaded. No external model collection is served or copied.',
    'Functional linear-HDR, same-ray radiometry and lifecycle checks; no timing or performance claim.',
    'CPU-reference fixtures measure linear-HDR reconstruction and geometry rejection, not unseen visibility or arbitrary light discontinuities.',
    'The raw transport sampler is unchanged. Passing these fixtures does not establish useful actual-house visual quality.'] };
let browser, server, timer;
try {
  server = await createBenchmarkServer({ assetRoot: '' });
  const args = ['--enable-unsafe-webgpu'];
  if (report.softwareGpu) args.push(...(platform() === 'linux'
    ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
  browser = await chromium.launch({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headless: process.env.STRATA_TEST_HEADED !== '1', args });
  report.browser = { version: browser.version(), args };
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.browserErrors.push(message.text()); });
  page.on('requestfailed', request => report.requestFailures.push({ url: request.url(), error: request.failure()?.errorText ?? 'unknown' }));
  await page.route(`${server.url}/imported-spatial.html`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Strata generated imported spatial checks</title>' }));
  await page.route(`${server.url}/imported-spatial.js`, route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text }));
  for (const [name, bytes] of fixtures) await page.route(`${server.url}/${name}`, route => route.fulfill({ contentType: 'application/json', body: bytes }));
  await page.goto(`${server.url}/imported-spatial.html`);
  report.result = await Promise.race([
    page.evaluate(async () => (await import('/imported-spatial.js')).validateImportedSpatial()),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Imported spatial validation exceeded120seconds.')), 120_000); }),
  ]);
  assert.equal(report.result.status, 'passed'); assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.requestFailures, []);
  if (!report.softwareGpu) {
    assert.notEqual(report.result.adapter.isFallbackAdapter, true, 'Hardware validation selected a fallback adapter.');
    assert(!/swiftshader|llvmpipe|software rasterizer|software adapter/i.test(JSON.stringify(report.result.adapter)), 'Hardware validation selected a software adapter.');
  }
  report.sourceAfter = source(); assert.deepEqual(report.sourceAfter, report.sourceBefore, 'Source identity changed during validation.');
  report.modulesAfter = Object.fromEntries(await Promise.all(Object.keys(modules).map(async path => [path, hash(await readFile(join(root, path)))])));
  assert.deepEqual(report.modulesAfter, modules, 'Runtime/reference source bytes changed during validation.');
  assert.equal(hash(await readFile(join(root, harnessPath))), report.harnessSha256, 'Harness changed during validation.');
  assert.equal(hash(await readFile(fileURLToPath(import.meta.url))), report.runnerSha256, 'Runner changed during validation.');
  for (const fixture of report.fixtures) assert.equal(hash(await readFile(join(root, 'tests/fixtures', fixture.name))), fixture.sha256, 'Fixture changed during validation.');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack ?? String(error); process.exitCode = 1; }
finally {
  clearTimeout(timer);
  for (const result of await Promise.allSettled([browser?.close(), server?.close()])) if (result.status === 'rejected') report.cleanupErrors.push(String(result.reason));
  if (report.cleanupErrors.length) { report.status = 'failed'; process.exitCode = 1; }
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Imported spatial generated checks ${report.status}. External report: ${output}/report.json`);
}
