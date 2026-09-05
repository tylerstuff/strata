import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, homedir, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';

const command = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const smoke = process.argv.includes('--smoke');
const unknown = process.argv.slice(2).filter(value => value !== '--smoke');
if (unknown.length) throw new Error(`Unknown integrated validation argument: ${unknown.join(', ')}`);
const fixture = await mkdtemp(join(tmpdir(), 'strata-integrated-fixture-'));
const directory = resolve(homedir(), 'Downloads/Strata-Benchmark-Results', `${new Date().toISOString().replaceAll(':', '-')}-integrated-validation`);
await mkdir(directory, { recursive: true });
const report = { kind: 'strata-integrated-functional-validation', performanceEvidence: false, scope: smoke ? 'smoke' : 'full',
  host: { platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model ?? null,
    systemMemoryBytes: totalmem(), node: process.version }, results: [], images: [] };
let server; let browser;
try {
  const [revision, dirty] = await Promise.all([command('git', ['rev-parse', 'HEAD'], { cwd: repository }), command('git', ['status', '--porcelain'], { cwd: repository })]);
  report.source = { commit: revision.stdout.trim(), dirty: Boolean(dirty.stdout.trim()) };
  // A fresh exact fixture also tests the cooker/parser hash contract. No local
  // asset collection is mounted, and the temporary output is deleted on failure.
  await command('cargo', ['run', '--release', '--locked', '--package', 'strata-geometry-cooker', '--',
    '--output', fixture, '--seed', '1337', '--tiles', '4', '--cells', '64', '--trace-proxy'], { cwd: repository });
  const [manifestText, proxyText, proxyBytes] = await Promise.all([
    readFile(join(fixture, 'manifest.json'), 'utf8'), readFile(join(fixture, 'trace-proxy.json'), 'utf8'), readFile(join(fixture, 'trace-proxy.bin'))]);
  const manifest = JSON.parse(manifestText); const proxy = JSON.parse(proxyText);
  report.fixture = { source: manifest.source, pages: manifest.pages.length, rootPages: manifest.rootPageIds.length,
    poolBytes: 8 * 65536, persistentProxyTriangles: proxy.mesh.indexCount / 3, proxyPayloadBytes: proxyBytes.length,
    proxySourceManifestSha256: proxy.sourceManifestSha256, proxyPayloadSha256: proxy.mesh.sha256 };
  assert(manifest.pages.length > 8 && manifest.rootPageIds.length < 8, 'Fixture must exercise real page eviction.');
  const bundled = await build({ absWorkingDir: repository, entryPoints: ['tests/browser/integrated-validation.ts'], bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', write: false });
  server = await createBenchmarkServer({ assetRoot: '', proceduralRoot: fixture });
  const args = ['--enable-unsafe-webgpu'];
  if (process.env.STRATA_TEST_SOFTWARE_GPU === '1') args.push(...(platform() === 'linux'
    ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
  browser = await chromium.launch({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headless: process.env.STRATA_TEST_HEADED !== '1', args });
  report.host.browser = browser.version(); report.softwareGpu = process.env.STRATA_TEST_SOFTWARE_GPU === '1';
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
  const errors = []; report.browserErrors = errors;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); } });
  await page.route(`${server.url}/integrated-validation.html`, route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><title>Strata integrated validation</title><canvas width="320" height="180"></canvas>' }));
  await page.route(`${server.url}/integrated-validation.js`, route => route.fulfill({ contentType: 'text/javascript', body: bundled.outputFiles[0].text }));
  // Only these two known generated files extend the server's strict page allowlist.
  await page.route(`${server.url}/procedural-assets/trace-proxy.json`, route => route.fulfill({ contentType: 'application/json', body: proxyText }));
  await page.route(`${server.url}/procedural-assets/trace-proxy.bin`, route => route.fulfill({ contentType: 'application/octet-stream', body: proxyBytes }));
  await page.goto(`${server.url}/integrated-validation.html`);
  const start = async options => {
    const result = await page.evaluate(async options => (await import('/integrated-validation.js')).startIntegratedValidation(options), {
      manifestUrl: '/procedural-assets/manifest.json', traceProxyUrl: '/procedural-assets/trace-proxy.json', ...options });
    report.adapter ??= result.adapter; return result;
  };
  const run = async (name, filename = name) => {
    console.log(`Integrated case: ${filename}`);
    const result = await page.evaluate(async name => (await import('/integrated-validation.js')).runIntegratedCase(name), name);
    report.results.push(result);
    const image = `${filename}.png`; await page.locator('canvas').screenshot({ path: join(directory, image) }); report.images.push(image);
  };
  await start({ cameraMode: 'receiver' });
  await run('cold-mirror'); await run('terrain-trace');
  if (!smoke) {
    await run('lifecycle');
    await start({ cameraMode: 'overview' }); await run('shared-materials');
    await start({ cameraMode: 'tour' }); await run('streaming'); await run('empty-reflection-pass');
    await start({ cameraMode: 'terrain-witness', terrainColor: 'green', wallColor: 'neutral' }); await run('terrain-lighting', 'green-terrain-indirect');
    await start({ cameraMode: 'terrain-witness', terrainColor: 'neutral', wallColor: 'neutral' }); await run('terrain-lighting', 'neutral-terrain-indirect');
    await run('lighting-latency');
  }
  report.disposal = await page.evaluate(async () => (await import('/integrated-validation.js')).disposeIntegratedValidation());
  assert.deepEqual(errors, []);
  console.log(`Integrated validation passed. Local functional evidence: ${directory}`);
} catch (error) { report.failure = error.message; throw error; }
finally {
  const cleanup = await Promise.allSettled([browser?.close(), server?.close(), rm(fixture, { recursive: true, force: true })]);
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const failed = cleanup.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
}
