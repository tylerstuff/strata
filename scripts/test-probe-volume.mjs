import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';

if (process.argv.length !== 2) throw new Error('Usage: node scripts/test-probe-volume.mjs');
const command = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = {};
const bundle = await build({ entryPoints: ['tests/browser/probe-volume-validation.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  plugins: [{ name: 'record-sampling-source', setup(build) {
    build.onLoad({ filter: /packages\/core\/src\/.*\.ts$/ }, async ({ path }) => {
      const contents = await readFile(path, 'utf8'); sourceFiles[relative(process.cwd(), path)] = hash(contents);
      return { contents, loader: 'ts' };
    });
  } }] });
const output = resolve(homedir(), 'Downloads/Strata-Benchmark-Results', `${new Date().toISOString().replaceAll(':', '-')}-probe-volume-validation`);
await mkdir(output, { recursive: true });
const sourceStatus = (await command('git', ['status', '--porcelain'])).stdout;
const report = { kind: 'strata-probe-volume-functional', status: 'running', totalFramePerformanceEvidence: false,
  source: { commit: (await command('git', ['rev-parse', 'HEAD'])).stdout.trim(), dirty: Boolean(sourceStatus.trim()), status: sourceStatus, moduleSha256: sourceFiles },
  harnessSha256: hash(await readFile('tests/browser/probe-volume-validation.ts')), runnerSha256: hash(await readFile('scripts/test-probe-volume.mjs')),
  bundleSha256: hash(bundle.outputFiles[0].contents), softwareGpu: process.env.STRATA_TEST_SOFTWARE_GPU === '1', browserErrors: [], cleanupErrors: [] };
let browser; let server; let timer;
try {
  server = await createBenchmarkServer({ assetRoot: '' });
  const flags = ['--enable-unsafe-webgpu'];
  if (report.softwareGpu) flags.push(...(platform() === 'linux'
    ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
  browser = await chromium.launch({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headless: process.env.STRATA_TEST_HEADED !== '1', args: flags });
  report.browser = { version: browser.version(), arguments: flags };
  const page = await browser.newPage();
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.browserErrors.push(message.text()); });
  await page.route(`${server.url}/probe-volume.html`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Strata finite probe volume validation</title>' }));
  await page.route(`${server.url}/probe-volume.js`, route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text }));
  await page.goto(`${server.url}/probe-volume.html`);
  report.result = await Promise.race([
    page.evaluate(async () => (await import('/probe-volume.js')).validateProbeVolume()),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Probe volume validation exceeded 60 seconds.')), 60_000); }),
  ]);
  assert.deepEqual(report.browserErrors, []); assert.equal(report.result.status, 'passed');
  if (!report.softwareGpu) {
    assert.notEqual(report.result.adapter.isFallbackAdapter, true, 'Hardware diagnostic selected a fallback adapter.');
    assert(!/swiftshader|llvmpipe|software rasterizer|software adapter/i.test(JSON.stringify(report.result.adapter)), 'Hardware diagnostic selected a software adapter.');
  }
  const sourceAfter = { commit: (await command('git', ['rev-parse', 'HEAD'])).stdout.trim(), status: (await command('git', ['status', '--porcelain'])).stdout,
    moduleSha256: Object.fromEntries(await Promise.all(Object.keys(sourceFiles).map(async path => [path, hash(await readFile(path))]))),
    harnessSha256: hash(await readFile('tests/browser/probe-volume-validation.ts')), runnerSha256: hash(await readFile('scripts/test-probe-volume.mjs')) };
  report.sourceVerification = { after: sourceAfter, unchanged: false };
  assert.equal(sourceAfter.commit, report.source.commit, 'Source commit changed during validation.');
  assert.equal(sourceAfter.status, report.source.status, 'Source status changed during validation.');
  assert.deepEqual(sourceAfter.moduleSha256, report.source.moduleSha256, 'Runtime source changed during validation.');
  assert.equal(sourceAfter.harnessSha256, report.harnessSha256, 'Harness source changed during validation.');
  assert.equal(sourceAfter.runnerSha256, report.runnerSha256, 'Runner source changed during validation.');
  report.sourceVerification.unchanged = true;
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack ?? String(error); process.exitCode = 1; }
finally {
  clearTimeout(timer);
  const cleanup = await Promise.allSettled([browser?.close(), server?.close()]);
  for (const result of cleanup) if (result.status === 'rejected') report.cleanupErrors.push(String(result.reason));
  if (report.cleanupErrors.length) { report.status = 'failed'; process.exitCode = 1; }
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Probe volume ${report.status}. External report: ${output}/report.json`);
}
