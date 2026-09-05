import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), 'strata-retention-fixture-'));
const directory = resolve(homedir(), 'Downloads/Strata-Benchmark-Results', `${new Date().toISOString().replaceAll(':', '-')}-geometry-retention`);
await mkdir(directory, { recursive: true });
const report = { kind: 'strata-geometry-retention', performanceEvidence: false,
  source: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim().length > 0 },
  softwareGpu: process.env.STRATA_TEST_SOFTWARE_GPU === '1' };
let browser; let server;
try {
  execFileSync('cargo', ['run', '--release', '--locked', '--package', 'strata-geometry-cooker', '--', '--output', fixture,
    '--seed', '1337', '--tiles', '1', '--cells', '64', '--lod-profile', 'certified'], { cwd: repository, stdio: 'pipe' });
  const bundled = await build({ absWorkingDir: repository, entryPoints: ['tests/browser/geometry-retention-validation.ts'],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  report.bundleSha256 = createHash('sha256').update(bundled.outputFiles[0].text).digest('hex');
  report.manifestSha256 = createHash('sha256').update(await readFile(join(fixture, 'manifest.json'))).digest('hex');
  server = await createBenchmarkServer({ assetRoot: '', proceduralRoot: fixture }); const args = ['--enable-unsafe-webgpu'];
  if (report.softwareGpu) args.push(...(platform() === 'linux'
    ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
  browser = await chromium.launch({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headless: process.env.STRATA_TEST_HEADED !== '1', args });
  report.browser = browser.version(); const page = await browser.newPage(); const errors = [];
  page.setDefaultTimeout(120_000);
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route(`${server.url}/retention.html`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Strata cache retention</title>' }));
  await page.route(`${server.url}/retention.js`, route => route.fulfill({ contentType: 'text/javascript', body: bundled.outputFiles[0].text }));
  await page.goto(`${server.url}/retention.html`);
  const { images, ...result } = await page.evaluate(async () => (await import('/retention.js')).validateGeometryRetention('/procedural-assets/manifest.json'));
  assert.equal(result.levels, 7);
  assert.equal(result.results.length, 4);
  assert.deepEqual(result.results.map(item => [item.scenario, item.policy]), [
    ['blocked', 'greedy'], ['blocked', 'retain-fallback'], ['feasible', 'greedy'], ['feasible', 'retain-fallback'],
  ]);
  const held = result.results.find(item => item.scenario === 'blocked' && item.policy === 'retain-fallback');
  assert.equal(held.finalTelemetry.retainedBlockedDemands, 1);
  assert.ok(held.frames.filter(frame => frame.name.startsWith('blocked-held-')).every(frame => frame.selected === 0));
  const greedy = result.results.find(item => item.scenario === 'blocked' && item.policy === 'greedy');
  assert.equal(greedy.frames.find(frame => frame.name === 'target-upload-1').selected, 6);
  assert.equal(greedy.frames.at(-1).selected, 1);
  if (!report.softwareGpu) assert.equal(result.adapter.isFallbackAdapter, false, 'Hardware diagnostic selected a fallback adapter.');
  report.result = result; report.images = Object.keys(images).map(name => `${name}.png`);
  for (const [name, value] of Object.entries(images)) await writeFile(join(directory, `${name}.png`), Buffer.from(value.split(',')[1], 'base64'));
  assert.deepEqual(errors, []); console.log(`Geometry retention passed ${result.results.length} cache cases / ${result.results.reduce((sum, item) => sum + item.frames.length, 0)} GPU frames: ${directory}`);
} catch (error) { report.failure = error.stack ?? String(error); throw error; }
finally {
  await Promise.allSettled([browser?.close(), server?.close(), rm(fixture, { recursive: true, force: true })]);
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
