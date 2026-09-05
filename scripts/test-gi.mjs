import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, homedir, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';
import { checkPower } from './benchmark-power.mjs';

const runCommand = promisify(execFile);
async function powerSnapshot() {
  const result = { recordedAt: new Date().toISOString(), source: null, lowPowerMode: null, thermal: null };
  if (platform() !== 'darwin') return { ...result, availability: 'Automatic power observations are available on macOS only.' };
  const outputs = await Promise.all(['batt', 'custom', 'therm'].map(async argument => {
    try { return (await runCommand('pmset', ['-g', argument], { encoding: 'utf8', timeout: 5000 })).stdout; }
    catch { return null; }
  }));
  result.source = outputs[0]?.match(/Now drawing from '([^']+)'/)?.[1] ?? null;
  if (outputs[1]) {
    const modes = {}; let section = 'unknown';
    for (const line of outputs[1].split('\n')) {
      if (/^[^\s].*:$/.test(line)) section = line.replace(/:$/, '').trim();
      const match = line.match(/^\s*lowpowermode\s+(\d+)/); if (match) modes[section] = Number(match[1]);
    }
    result.lowPowerMode = Object.keys(modes).length ? modes : null;
  }
  if (outputs[2]) {
    const limits = {};
    for (const line of outputs[2].split('\n')) {
      const match = line.match(/(CPU_Scheduler_Limit|CPU_Available_CPUs|CPU_Speed_Limit|Thermal_Level|GPU_Speed_Limit)\s*=\s*(\d+)/);
      if (match) limits[match[1]] = Number(match[2]);
    }
    result.thermal = { limits, temperatureCelsius: null };
  }
  return result;
}

const measure = process.argv.includes('--measure');
const renderOnly = process.argv.includes('--render-only');
const unknown = process.argv.slice(2).filter(argument => !['--measure', '--render-only'].includes(argument));
if (unknown.length) throw new Error(`Unknown GI validation arguments: ${unknown.join(', ')}`);
if (measure && renderOnly) throw new Error('--measure and --render-only are separate validation scopes.');
if (measure && ((process.env.CI && !['0', 'false'].includes(process.env.CI.toLowerCase())) || process.env.STRATA_TEST_SOFTWARE_GPU === '1')) {
  throw new Error('GI representation measurements require local hardware; CI and software adapters run functional validation only.');
}
await build({ entryPoints: ['tests/browser/gi-validation.ts'], outfile: 'benchmarks/browser/gi-validation.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
const directory = resolve(homedir(), 'Downloads/Strata-Benchmark-Results', `${new Date().toISOString().replaceAll(':', '-')}-gi-validation`);
await mkdir(directory, { recursive: true });
const report = { kind: 'strata-gi-validation', representationMicrobenchmark: measure, totalFramePerformanceEvidence: false,
  functionalScope: renderOnly ? 'rendered' : measure ? 'tracing' : 'full',
  host: { platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model ?? null,
    systemMemoryBytes: totalmem(), node: process.version }, powerSamples: [], results: {} };
let powerProfile;
async function observePower(phase) {
  const snapshot = await powerSnapshot(); report.powerSamples.push({ phase, ...snapshot });
  if (measure) powerProfile = checkPower(snapshot, powerProfile, platform() === 'darwin');
}
const args = ['--enable-unsafe-webgpu'];
if (process.env.STRATA_TEST_SOFTWARE_GPU === '1') {
  args.push(...(platform() === 'linux'
    ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
}
let server;
let browser;
try {
  const [revision, workingTree] = await Promise.all([
    runCommand('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }),
    runCommand('git', ['status', '--porcelain'], { encoding: 'utf8' }),
  ]);
  report.source = { commit: revision.stdout.trim(), dirty: workingTree.stdout.trim().length > 0 };
  await observePower('before');
  server = await createBenchmarkServer({ assetRoot: '' });
  browser = await chromium.launch({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? (measure ? 'chrome' : 'chromium'),
    headless: measure ? false : process.env.STRATA_TEST_HEADED !== '1', args });
  report.host.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route(`${server.url}/gi-validation.html`, route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><title>Strata GI validation</title><canvas width="320" height="180"></canvas>' }));
  await page.goto(`${server.url}/gi-validation.html`);
  for (const doorOpen of renderOnly ? [] : [true, false]) {
    const name = doorOpen ? 'openDoorTracing' : 'closedDoorTracing';
    console.log(`Running ${doorOpen ? 'open' : 'closed'}-door tracing shaders...`);
    report.results[name] = await page.evaluate(async options => {
      if (document.visibilityState !== 'visible' && options.measure) throw new Error('Representation measurements require a visible browser.');
      return (await import('/benchmarks/browser/gi-validation.js')).validateGiTracing(options);
    }, { doorOpen, measure });
    await observePower(`after-${name}`);
    console.log(`GI trace validation: ${doorOpen ? 'open' : 'closed'} door, exact BVH closest/occlusion hits and same-ray SDF error/work distributions passed.`);
  }
  if (!measure) {
    if (!renderOnly) {
      report.results.probeCache = await page.evaluate(async () => (await import('/benchmarks/browser/gi-validation.js')).validateGiProbeCache());
      console.log('GI probe validation: finite budgets, submission epochs, full-grid updates, light reset, door invalidation and disposal passed.');
    }
    report.results.rendered = await page.evaluate(async () => (await import('/benchmarks/browser/gi-validation.js')).validateGiRenderedScene());
    assert.equal(report.results.rendered.failure, undefined, report.results.rendered.failure);
    console.log('GI rendered validation: cold offscreen color transfer, direct-only baseline, door leakage, light reset, convergence and lifecycle passed.');
    if (process.env.STRATA_TEST_SOFTWARE_GPU !== '1') {
      report.images = [];
      for (const cameraMode of ['receiver', 'overview']) {
        await page.evaluate(async mode => (await import('/benchmarks/browser/gi-validation.js')).startGiVisualScene(mode), cameraMode);
        for (const debugView of ['final', 'direct', 'indirect', 'trace', 'probe-age', 'probe-irradiance', 'probe-visibility']) {
          const metadata = await page.evaluate(async view => (await import('/benchmarks/browser/gi-validation.js')).renderGiVisualView(view), debugView);
          const filename = `${cameraMode}-${debugView}.png`;
          await page.locator('canvas').screenshot({ path: resolve(directory, filename) });
          report.images.push({ filename, ...metadata });
        }
        await page.evaluate(async () => (await import('/benchmarks/browser/gi-validation.js')).disposeGiVisualScene());
      }
      console.log('Captured receiver and overview final/direct/indirect/tracing/probe diagnostics.');
    }
  }
  assert.deepEqual(errors, []);
  console.log(`${measure ? 'GI tracing comparison measured' : 'GI validation passed'}. Local evidence: ${directory}`);
} catch (error) {
  report.failure = error.message;
  throw error;
} finally {
  const cleanup = await Promise.allSettled([browser?.close(), server?.close()]);
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const failed = cleanup.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}
