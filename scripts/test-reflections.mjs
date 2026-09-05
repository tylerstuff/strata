import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, homedir, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';

const command = promisify(execFile);
const renderOnly = process.argv.includes('--render-only');
const unknown = process.argv.slice(2).filter(value => !['--smoke', '--render-only'].includes(value));
if (renderOnly && process.argv.includes('--smoke')) throw new Error('--smoke and --render-only are separate scopes.');
if (unknown.length) throw new Error(`Unknown reflection validation argument: ${unknown.join(', ')}`);
const bundled = await build({ entryPoints: ['tests/browser/reflection-validation.ts'], bundle: true, format: 'esm',
  platform: 'browser', target: 'es2022', write: false });
const directory = resolve(homedir(), 'Downloads/Strata-Benchmark-Results', `${new Date().toISOString().replaceAll(':', '-')}-reflection-validation`);
await mkdir(directory, { recursive: true });
const report = { kind: 'strata-reflection-validation', totalFramePerformanceEvidence: false, functionalScope: process.argv.includes('--smoke') ? 'smoke' : renderOnly ? 'rendered' : 'full',
  host: { platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model ?? null,
    systemMemoryBytes: totalmem(), node: process.version }, results: {} };
const args = ['--enable-unsafe-webgpu'];
if (process.env.STRATA_TEST_SOFTWARE_GPU === '1') args.push(...(platform() === 'linux'
  ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
let server; let browser; let page;
try {
  const [revision, dirty] = await Promise.all([command('git', ['rev-parse', 'HEAD']), command('git', ['status', '--porcelain'])]);
  report.source = { commit: revision.stdout.trim(), dirty: dirty.stdout.trim().length > 0 };
  server = await createBenchmarkServer({ assetRoot: '' });
  browser = await chromium.launch({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium',
    headless: process.env.STRATA_TEST_HEADED !== '1', args });
  report.host.browser = browser.version(); report.softwareGpu = process.env.STRATA_TEST_SOFTWARE_GPU === '1';
  page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
  const errors = []; report.browserErrors = errors;
  page.on('pageerror', error => errors.push(error.message));
  page.on('crash', () => errors.push('Browser page crashed.'));
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); } });
  await page.route(`${server.url}/reflection-validation.html`, route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><title>Strata reflection validation</title><canvas width="320" height="180"></canvas>' }));
  await page.route(`${server.url}/reflection-validation.js`, route => route.fulfill({ contentType: 'text/javascript', body: bundled.outputFiles[0].text }));
  await page.goto(`${server.url}/reflection-validation.html`);
  if (!renderOnly) {
    console.log('Validating the production reflection renderer and estimator kernel...');
    report.results.smoke = await page.evaluate(async () => (await import('/reflection-validation.js')).validateReflectionSmoke());
  }
  if (!process.argv.includes('--smoke')) {
    report.results.cases = []; report.images = [];
    await page.evaluate(async () => (await import('/reflection-validation.js')).startReflectionValidation());
    for (const name of ['cold-world', 'history', 'move-minus', 'move-plus', 'rough', 'camera-cut', 'fallback', 'off', 'probe-only-cold', 'probe-only-warm', 'resize', 'temporal-toggle']) {
      console.log(`Reflection case: ${name}`);
      const result = await page.evaluate(async name => (await import('/reflection-validation.js')).runReflectionCase(name), name);
      report.results.cases.push(result);
      const filename = `${name}.png`; await page.locator('canvas').screenshot({ path: resolve(directory, filename) }); report.images.push(filename);
      if (name === 'cold-world') for (const view of ['final', 'reflections', 'reflection-source']) {
        await page.evaluate(async view => (await import('/reflection-validation.js')).showReflectionView(view), view);
        const filename = `receiver-${view}.png`; await page.locator('canvas').screenshot({ path: resolve(directory, filename) }); report.images.push(filename);
      }
    }
    await page.evaluate(async () => (await import('/reflection-validation.js')).startReflectionValidation('tour'));
    report.results.cases.push(await page.evaluate(async () => (await import('/reflection-validation.js')).runReflectionCase('camera-motion')));
    await page.evaluate(async () => (await import('/reflection-validation.js')).startReflectionValidation('receiver', 256));
    report.results.cases.push(await page.evaluate(async () => (await import('/reflection-validation.js')).runReflectionCase('quota')));
    await page.evaluate(async () => (await import('/reflection-validation.js')).startReflectionValidation('tour', 256));
    report.results.cases.push(await page.evaluate(async () => (await import('/reflection-validation.js')).runReflectionCase('quota-tour')));
    await page.evaluate(async () => (await import('/reflection-validation.js')).startReflectionValidation('receiver', 32768, .25));
    for (const name of ['quarter-cold', 'quarter-move', 'quarter-resize']) {
      console.log(`Reflection case: ${name}`);
      report.results.cases.push(await page.evaluate(async name => (await import('/reflection-validation.js')).runReflectionCase(name), name));
      if (name === 'quarter-cold') for (const view of ['final', 'reflections']) {
        await page.evaluate(async view => (await import('/reflection-validation.js')).showReflectionView(view), view);
        const filename = `quarter-${view}.png`; await page.locator('canvas').screenshot({ path: resolve(directory, filename) }); report.images.push(filename);
      }
    }
    report.results.disposal = await page.evaluate(async () => (await import('/reflection-validation.js')).disposeReflectionValidation());
  }
  assert.deepEqual(errors, []);
  console.log(`Reflection validation passed. Local evidence: ${directory}`);
} catch (error) {
  report.failure = error.message;
  report.diagnostics = await page?.evaluate(async () => (await import('/reflection-validation.js')).reflectionValidationDiagnostics()).catch(() => null);
  console.error('Reflection failure diagnostics:', JSON.stringify(report.diagnostics));
  throw error;
}
finally {
  const cleanup = await Promise.allSettled([browser?.close(), server?.close()]);
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const failed = cleanup.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
}
