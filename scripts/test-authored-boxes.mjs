import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { arch, cpus, homedir, platform, release } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const parameters = process.argv.slice(2);
const prepareOnly = parameters.includes('--prepare-only');
let output;
for (let index = 0; index < parameters.length; index++) {
  const argument = parameters[index];
  if (argument === '--prepare-only') continue;
  if (argument === '--output' && parameters[index + 1] && !parameters[index + 1].startsWith('--')) { output = parameters[++index]; continue; }
  throw new Error(`Unknown or incomplete authored validation argument: ${argument}`);
}
const directory = resolve(output ?? resolve(homedir(), 'Downloads/Strata-Benchmark-Results',
  `${new Date().toISOString().replaceAll(':', '-')}-authored-box-validation`));
const inside = (root, candidate) => { const path = relative(root, candidate); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); };
assert(!inside(repository, directory), 'Authored captures and generated bundles must remain outside the repository.');
await mkdir(directory, { recursive: true });
assert(!inside(await realpath(repository), await realpath(directory)), 'Authored output resolves into the repository.');
const report = { kind: 'strata-authored-box-validation', performanceEvidence: false, prepareOnly,
  softwareGpuRequested: process.env.STRATA_TEST_SOFTWARE_GPU === '1',
  host: { platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model ?? null, node: process.version },
  source: {}, results: {}, images: [], browserErrors: [], cleanupErrors: [] };
let browser, server;
let failure;

async function revision() {
  const [head, status] = await Promise.all([
    command('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }),
    command('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }),
  ]);
  return { commit: head.stdout.trim(), dirty: status.stdout.trim().length !== 0 };
}

async function runtimeHashes(directory, prefix = '') {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const local = resolve(directory, entry.name), path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) results.push(...await runtimeHashes(local, `${path}/`));
    else if (entry.isFile() && /\.(?:js|wasm)$/.test(entry.name)) results.push({ path, sha256: hash(await readFile(local)) });
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

async function bounded(promise, label, timeoutMs = 300000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

try {
  report.source = await revision();
  const bundle = await build({ absWorkingDir: repository, entryPoints: ['tests/browser/authored-box-validation.ts'],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, metafile: true });
  const artifact = bundle.outputFiles[0].contents;
  const artifactPath = resolve(directory, 'authored-box-validation.mjs');
  await writeFile(artifactPath, artifact);
  report.source.harnessSha256 = hash(artifact);
  report.source.harnessInputs = await Promise.all(Object.keys(bundle.metafile.inputs).sort().map(async path => ({ path,
    sha256: hash(await readFile(resolve(repository, path))) })));
  report.source.runnerSha256 = hash(await readFile(fileURLToPath(import.meta.url)));
  // This module imports production CPU/shader definitions, but this entry invokes no DOM/GPU functions.
  report.results.cpuReference = (await import(pathToFileURL(artifactPath).href)).validateAuthoredBoxReference();
  console.log('Authored CPU reference: sixteen roots, rational coordinate crosschecks, per-object visibility and early-f32 sensitivity passed.');
  if (!prepareOnly) {
    const runtimeDirectory = resolve(repository, 'packages/core/dist');
    try { await readFile(resolve(runtimeDirectory, 'index.js')); await readFile(resolve(runtimeDirectory, 'strata_runtime.wasm')); }
    catch { throw new Error('The public Engine check requires the current built package. Run npm run build first.'); }
    report.source.builtRuntime = await runtimeHashes(runtimeDirectory);
    server = await createBenchmarkServer({ assetRoot: '' });
    const args = ['--enable-unsafe-webgpu'];
    if (report.softwareGpuRequested) args.push(...(platform() === 'linux'
      ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
      : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
    browser = await chromium.launch({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headless: process.env.STRATA_TEST_HEADED !== '1', args });
    report.host.browser = browser.version();
    const page = await browser.newPage({ viewport: { width: 900, height: 750 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => report.browserErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') report.browserErrors.push(message.text());
      if (message.text().startsWith('Authored correctness:')) console.log(message.text());
    });
    await page.route(`${server.url}/authored-box-validation.mjs`, route => route.fulfill({ contentType: 'text/javascript', body: Buffer.from(artifact) }));
    await page.route(`${server.url}/authored-box-validation.html`, route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><title>Strata authored box correctness</title><canvas id="engine" width="512" height="512"></canvas>' }));
    await page.goto(`${server.url}/authored-box-validation.html`);
    const rendered = await bounded(page.evaluate(async software => (await import('/authored-box-validation.mjs')).runAuthoredBoxValidation({ software }), report.softwareGpuRequested), 'Authored renderer validation');
    for (const { name, base64, authored } of rendered.images) {
      const bytes = Buffer.from(base64, 'base64'); const filename = `${name}.png`;
      await writeFile(resolve(directory, filename), bytes);
      report.images.push({ filename, sha256: hash(bytes), bytes: bytes.length, width: 512, height: 512, source: 'production GPU color readback encoded as PNG', authored });
    }
    delete rendered.images;
    report.results.rendered = rendered;
    console.log('Authored renderer: static offsets, paired camera motion, real depth/coverage, negative controls and direct PBR passed.');
    report.results.engine = await bounded(page.evaluate(async () => (await import('/authored-box-validation.mjs')).validateAuthoredEngine()), 'Public authored Engine validation', 90000);
    assert.deepEqual(report.browserErrors, []);
    assert.deepEqual(await runtimeHashes(runtimeDirectory), report.source.builtRuntime, 'Built runtime changed during validation.');
    console.log('Public Engine: exact scene-generation receipts, camera overrides, resize, clear and disposal passed.');
  }
  report.source.after = await revision();
  assert.equal(report.source.after.commit, report.source.commit, 'Source revision changed during validation.');
} catch (error) {
  failure = error; report.failure = error instanceof Error ? error.message : String(error);
} finally {
  for (const [name, resource] of [['browser', browser], ['server', server]]) {
    try { await resource?.close(); } catch (error) { report.cleanupErrors.push({ resource: name, message: error instanceof Error ? error.message : String(error) }); }
  }
  if (report.cleanupErrors.length && !failure) { failure = new Error('Authored validation cleanup failed.'); report.failure = failure.message; }
  await writeFile(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Authored ${prepareOnly ? 'CPU preparation' : 'functional validation'} report: ${directory}`);
}
if (failure) throw failure;
