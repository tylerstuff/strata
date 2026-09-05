import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';

const command = promisify(execFile); const args = process.argv.slice(2); const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index]; const value = args[index + 1];
  if (!['--samples', '--corner-samples', '--analyze'].includes(flag) || !value || options.has(flag)) throw new Error('Usage: node scripts/test-probe-quality.mjs [--samples 262144] [--corner-samples 1048576] [--analyze /external/capture.json]');
  options.set(flag, value);
}
const samples = Number(options.get('--samples') ?? 262144); const cornerSamples = Number(options.get('--corner-samples') ?? 1048576);
for (const count of [samples, cornerSamples]) assert(Number.isInteger(count) && count >= 1024 && count <= 1048576 && count % 8 === 0, 'Samples must be1024..1048576 and divisible by8.');
const sourceRoot = process.cwd(); const sourceFiles = new Map();
const bundle = await build({ entryPoints: ['tests/browser/probe-quality-validation.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  plugins: [{ name: 'capture-source-hashes', setup(build) {
    build.onLoad({ filter: /(?:packages\/core\/src|tests\/browser)\/.*\.ts$/ }, async ({ path }) => {
      const contents = await readFile(path, 'utf8'); sourceFiles.set(path, createHash('sha256').update(contents).digest('hex')); return { contents, loader: 'ts' };
    });
  } }] });
const output = resolve(homedir(), 'Downloads/Strata-Benchmark-Results', `${new Date().toISOString().replaceAll(':', '-')}-probe-quality`);
await mkdir(output, { recursive: true });
const revision = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim();
const dirty = (await command('git', ['status', '--porcelain'])).stdout.trim().length > 0;
const report = { kind: 'strata-probe-quality-attribution', totalFramePerformanceEvidence: false,
  source: { commit: revision, dirty, root: sourceRoot, moduleSha256: Object.fromEntries(sourceFiles) },
  softwareGpu: process.env.STRATA_TEST_SOFTWARE_GPU === '1', browserErrors: [], diagnosticOnly: true };
let browser; let server;
try {
  if (options.has('--analyze')) {
    const capturePath = resolve(options.get('--analyze')); const text = await readFile(capturePath, 'utf8'); const imported = JSON.parse(text);
    assert.equal(imported.kind, 'strata-probe-quality-attribution'); assert(imported.capture && !imported.capture.failure && !imported.failure, 'Imported capture did not pass its oracle checks.');
    report.capture = imported.capture; report.source = imported.source; report.browser = imported.browser; report.softwareGpu = imported.softwareGpu;
    report.captureArtifact = { path: capturePath, sha256: createHash('sha256').update(text).digest('hex') };
  } else {
    server = await createBenchmarkServer({ assetRoot: '' }); const flags = ['--enable-unsafe-webgpu'];
    if (report.softwareGpu) flags.push(...(platform() === 'linux'
      ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
      : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
    browser = await chromium.launch({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headless: process.env.STRATA_TEST_HEADED !== '1', args: flags });
    report.browser = browser.version();
    const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => report.browserErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.browserErrors.push(message.text()); else if (message.text().startsWith('Probe quality diagnostic:')) console.log(message.text()); });
    await page.route(`${server.url}/quality.html`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Strata probe quality diagnostic</title><canvas></canvas>' }));
    await page.route(`${server.url}/quality.js`, route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text }));
    await page.goto(`${server.url}/quality.html`);
    report.capture = await page.evaluate(async () => (await import('/quality.js')).validateProbeQuality());
    assert.equal(report.capture.failure, undefined, report.capture.failure);
    assert.deepEqual(report.browserErrors, []);
    if (!report.softwareGpu) assert.equal(report.capture.adapter.isFallbackAdapter, false, 'Hardware diagnostic unexpectedly selected a fallback adapter.');
    // Explicitly release the browser before the higher-sample independent CPU integration.
    await browser.close(); browser = undefined; await server.close(); server = undefined;
    const capturePath = resolve(output, 'capture.json'); const captureText = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(capturePath, captureText);
    report.captureArtifact = { path: capturePath, sha256: createHash('sha256').update(captureText).digest('hex') };
  }
  report.analysisSource = { commit: revision, dirty, root: sourceRoot };
  const referenceBundle = await build({ entryPoints: ['tests/browser/probe-quality-reference.ts'], bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022' });
  const referencePath = resolve(output, 'reference.mjs'); await writeFile(referencePath, referenceBundle.outputFiles[0].text);
  report.referenceModuleSha256 = createHash('sha256').update(referenceBundle.outputFiles[0].text).digest('hex');
  console.log(`Probe quality diagnostic: no browser active; independent CPU reference ${samples} samples/direction (${cornerSamples} for corner).`);
  report.analysis = (await import(pathToFileURL(referencePath).href)).analyzeProbeQuality(report.capture, samples, cornerSamples);
  assert.equal((await command('git', ['rev-parse', 'HEAD'])).stdout.trim(), revision, 'Source commit changed during diagnostic.');
  for (const [path, hash] of sourceFiles) assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), hash, `Bundled source changed: ${path}`);
  console.log(`Probe quality attribution completed. Saved local report: ${output}/report.json`);
} catch (error) { report.failure = error.stack ?? String(error); throw error; }
finally {
  await Promise.allSettled([browser?.close(), server?.close()]);
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
