import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { arch, cpus, homedir, platform, release } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createBenchmarkServer } from './benchmark-server.mjs';
import { prepareGalleryOutput } from './gallery-output.mjs';

const runnerPath = fileURLToPath(import.meta.url);
const repository = resolve(dirname(runnerPath), '..');
const command = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, candidate) => {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
let prepareOnly = false, requestedOutput;
const parameters = process.argv.slice(2);
for (let index = 0; index < parameters.length; index++) {
  const argument = parameters[index];
  if (argument === '--prepare-only' && !prepareOnly) { prepareOnly = true; continue; }
  if (argument === '--output' && requestedOutput === undefined && parameters[index + 1] && !parameters[index + 1].startsWith('--')) {
    requestedOutput = parameters[++index]; continue;
  }
  throw new Error(`Unknown, repeated or incomplete authored motion argument: ${argument}`);
}
const requestedDirectory = resolve(requestedOutput ?? resolve(homedir(), 'Downloads/Strata-Benchmark-Results',
  `${new Date().toISOString().replaceAll(':', '-')}-authored-motion-validation`));
assert(!inside(repository, requestedDirectory), 'Authored motion evidence must remain outside the repository.');
// Check canonical existing ancestors before mkdir, including other Git worktrees.
const directory = await prepareGalleryOutput(requestedDirectory);
assert(!inside(await realpath(repository), await realpath(directory)), 'Authored motion output resolves into the repository.');
assert.deepEqual(await readdir(directory), [], 'Use a fresh output directory; existing evidence must not be overwritten.');

const harnessPath = 'tests/browser/authored-motion-validation.ts';
const artifactPath = resolve(directory, 'authored-motion-validation.mjs');
const runtimeDirectory = resolve(repository, 'packages/core/dist');
const report = {
  kind: 'strata-authored-motion-validation', status: 'running', stage: 'source', prepareOnly,
  performanceEvidence: false, softwareGpuRequested: process.env.STRATA_TEST_SOFTWARE_GPU === '1',
  host: { platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model ?? null, node: process.version },
  source: {}, results: {}, browserErrors: [], requestFailures: [], responseErrors: [], cleanupErrors: [], identityErrors: [],
  limitations: ['Generated static boxes only; no external asset collection is served or copied.',
    'CPU preparation runs before any browser launch; --prepare-only never launches a browser or requests a GPU.',
    'GPU motion reference shares fixed-function rasterization/interpolation; named adapter details come only from the harness.',
    'Functional correctness evidence only; no performance, temporal resolve, scanout or world-streaming claim.',
    'The direct motion harness does not execute the built runtime; its bytes are recorded for identity only.',
    'Public Engine motion metadata is covered separately by test:authored-boxes.'],
};
let browser, context, server, artifact, inputPaths, referenceModule;
function errorDetails(error) {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? null,
    ...(error.details === undefined ? {} : { details: error.details }),
    ...(error.cause === undefined ? {} : { cause: String(error.cause) }) } : { message: String(error) };
}
function canonicalJson(value) {
  const plain = JSON.parse(JSON.stringify(value));
  const ordered = item => Array.isArray(item) ? item.map(ordered) : item !== null && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])])) : item;
  return JSON.stringify(ordered(plain));
}
async function persistReport() {
  assert.equal(await realpath(directory), directory, 'Evidence directory changed during validation.');
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(directory, 'report.json'), bytes);
  await writeFile(resolve(directory, 'report.sha256'), `${hash(bytes)}  report.json\n`);
}
async function revision() {
  const [head, status, diff] = await Promise.all([
    command('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }),
    command('git', ['status', '--porcelain=v1'], { cwd: repository, encoding: 'utf8' }),
    command('git', ['diff', '--binary', 'HEAD'], { cwd: repository, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }),
  ]);
  return { commit: head.stdout.trim(), dirty: status.stdout.length !== 0, status: status.stdout,
    trackedDiffSha256: hash(diff.stdout), runnerSha256: hash(await readFile(runnerPath)) };
}
async function inputHashes(paths) {
  return Promise.all(paths.map(async path => ({ path, sha256: hash(await readFile(resolve(repository, path))) })));
}
async function runtimeFiles(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${prefix}${entry.name}`, local = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await runtimeFiles(local, `${path}/`));
    else {
      assert(entry.isFile(), `Unexpected non-file in built package: ${path}`);
      const bytes = await readFile(local); files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  return files;
}
async function runtimeIdentity() {
  try { return { available: true, files: await runtimeFiles(runtimeDirectory) }; }
  catch (error) { if (error.code === 'ENOENT') return { available: false, reason: 'Built runtime is absent.' }; throw error; }
}
async function bounded(promise, label, timeoutMs = 300000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
async function verifyIdentity() {
  const checks = [
    ['source', async () => { report.source.after = await revision(); assert.deepEqual(report.source.after, report.source.before, 'Source/runner identity changed.'); }],
    ['built-runtime', async () => { report.source.builtRuntimeAfter = await runtimeIdentity(); assert.deepEqual(report.source.builtRuntimeAfter, report.source.builtRuntimeBefore, 'Built runtime changed.'); }],
    ...(inputPaths ? [['harness-inputs', async () => { report.source.harnessInputsAfter = await inputHashes(inputPaths);
      assert.deepEqual(report.source.harnessInputsAfter, report.source.harnessInputsBefore, 'Harness input bytes changed.'); }]] : []),
    ...(artifact ? [['bundle', async () => { report.source.harnessAfterSha256 = hash(await readFile(artifactPath));
      assert.equal(report.source.harnessAfterSha256, report.source.harnessSha256, 'External harness bundle changed.'); }]] : []),
  ];
  for (const [stage, check] of checks) {
    try { await check(); } catch (error) { report.identityErrors.push({ stage, ...errorDetails(error) }); }
  }
}

try {
  report.source.before = await revision();
  report.source.builtRuntimeBefore = await runtimeIdentity();
  report.stage = 'bundle';
  const bundle = await build({ absWorkingDir: repository, entryPoints: [harnessPath], bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', write: false, metafile: true,
    external: ['/packages/core/dist/*'] });
  assert.equal(bundle.outputFiles.length, 1, 'Motion harness must be one independently hashed bundle.');
  artifact = bundle.outputFiles[0].contents;
  inputPaths = Object.keys(bundle.metafile.inputs).sort();
  report.source.harnessSha256 = hash(artifact);
  report.source.harnessInputsBefore = await inputHashes(inputPaths);
  await writeFile(artifactPath, artifact);
  report.stage = 'cpu-preparation';
  referenceModule = await import(pathToFileURL(artifactPath).href);
  assert.equal(typeof referenceModule.prepareAuthoredMotionValidation, 'function', 'Missing CPU preparation export.');
  assert.equal(typeof referenceModule.runAuthoredMotionValidation, 'function', 'Missing browser validation export.');
  report.results.cpuReference = await bounded(referenceModule.prepareAuthoredMotionValidation(), 'Authored motion CPU preparation');
  report.source.preparationCanonicalSha256 = hash(canonicalJson(report.results.cpuReference));
  report.source.preparationHashDefinition = 'SHA256 of UTF-8 canonical JSON of the complete CPU preparation report, recursively sorted object keys, array order preserved.';
  await writeFile(resolve(directory, 'preparation.json'), `${JSON.stringify(report.results.cpuReference, null, 2)}\n`);
  await persistReport();
  console.log(`Authored motion CPU preparation passed; canonical SHA256 ${report.source.preparationCanonicalSha256}.`);
  if (prepareOnly) report.status = 'prepared';
  else {
    report.stage = 'browser-start';
    // Match the existing authored-box runner's server and browser selection.
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
    context.on('requestfailed', request => report.requestFailures.push({ url: request.url(), error: request.failure()?.errorText ?? 'unknown' }));
    context.on('response', response => { if (response.status() >= 400) report.responseErrors.push({ url: response.url(), status: response.status() }); });
    const page = await context.newPage();
    page.on('pageerror', error => report.browserErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') report.browserErrors.push(message.text());
      if (/^Authored (?:motion|correctness):/.test(message.text())) console.log(message.text());
    });
    const scriptPath = '/authored-motion-validation.mjs', htmlPath = '/authored-motion-validation.html';
    await context.route(`${server.url}${scriptPath}`, route => route.fulfill({ contentType: 'text/javascript', body: Buffer.from(artifact) }));
    await context.route(`${server.url}${htmlPath}`, route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Strata authored motion correctness</title><canvas id="engine" width="512" height="512"></canvas>' }));
    const navigation = await page.goto(`${server.url}${htmlPath}`);
    assert(navigation?.ok(), 'Authored motion validation page failed to load.');
    report.stage = 'gpu-reference';
    await persistReport();
    const result = await bounded(page.evaluate(async ({ path, software }) => {
      try {
        const harness = await import(path);
        const rendered = await harness.runAuthoredMotionValidation({ software });
        const result = { status: 'passed', rendered };
        globalThis.__strataAuthoredMotionResult = result; return result;
      } catch (error) {
        const result = { status: 'failed', failure: { name: error?.name ?? 'Error', message: error?.message ?? String(error),
          stack: error?.stack ?? null, details: error?.details ?? null } };
        globalThis.__strataAuthoredMotionResult = result; return result;
      }
    }, { path: scriptPath, software: report.softwareGpuRequested }), 'Authored motion GPU reference');
    report.results.browser = result;
    await persistReport();
    assert.equal(result.status, 'passed', result.failure?.message ?? 'Authored motion GPU checks failed.');
    assert.equal(result.rendered?.stage, 'complete', 'Motion harness did not complete its checks.');
    report.source.browserPreparationCanonicalSha256 = hash(canonicalJson(result.rendered.preparation));
    assert.equal(report.source.browserPreparationCanonicalSha256, report.source.preparationCanonicalSha256,
      'Browser fixture, masks or gates differ from the CPU preparation completed before launch.');
    report.results.engine = { status: 'not-run-here', reason: 'Public Engine motion metadata is covered separately by test:authored-boxes; this harness exercises the internal authored renderer.' };
    assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.requestFailures, []); assert.deepEqual(report.responseErrors, []);
    report.status = 'passed';
  }
} catch (error) {
  report.status = 'failed'; report.failure = errorDetails(error); process.exitCode = 1;
} finally {
  for (const [name, resource] of [['context', context], ['browser', browser], ['server', server]]) {
    try { await resource?.close(); } catch (error) { report.cleanupErrors.push({ resource: name, ...errorDetails(error) }); }
  }
  if (report.source.before) await verifyIdentity();
  if (report.cleanupErrors.length || report.identityErrors.length || report.browserErrors.length || report.requestFailures.length || report.responseErrors.length) {
    report.status = 'failed'; process.exitCode = 1;
  }
  report.finalStage = report.stage;
  await persistReport();
  console.log(`Authored motion ${prepareOnly ? 'CPU preparation' : 'functional validation'} ${report.status}. External report: ${directory}/report.json`);
}
