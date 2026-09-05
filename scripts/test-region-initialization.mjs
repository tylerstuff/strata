import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createBenchmarkServer } from './benchmark-server.mjs';
import { prepareGalleryOutput } from './gallery-output.mjs';

const runnerPath = fileURLToPath(import.meta.url);
const repository = resolve(dirname(runnerPath), '..');
const command = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const schema = 'strata-region-initialization-validation-v1';
const harnessPath = 'tests/browser/region-initialization-validation.ts';
const artifactName = 'region-initialization-validation.mjs';
const sha256 = /^[a-f0-9]{64}$/;

/** Same identities as the unchanged cooker's four-source CPU proof at 4b78034. */
export const REGION_FIXTURE_IDENTITIES = Object.freeze([
  [51, 2766, 'd47cb3aeb68cf8c9461f7bd1b2d236eee6496b4a2925dbcb58c715a039435678',
    'ebc1074b29b90264bdf1a25b5faada6cfb0d8bba47485ee11d48d8afd0af184f', '3a55980a1d3820bb9fb477a788b80d60f41750ca84d19a0f0a5ed96e73395f55'],
  [52, 2768, '063deacb2b3fffc7009783e199eb0f53199f7dfc282dd86366247be8daa38f69',
    '358ee837107673732c88f877567edd04bab62feddc84d34517400002792e9dd6', 'dc80b73ac30177012fe8f533fa9940f3da28fa3b902653ce3a6dc7b756f0f3d1'],
  [53, 2768, '3313f201facb1f73fe93db9b98fbb48496774ef30b444ac082f7c9bce91ff3a6',
    'e748f8c428f97084312aae93be8fab43851c9b04002b6570819549f569150d8c', '7b2ff1ea9261b069d57e968eccf1326b57d74cfc0ef46e52239d5b20335939ae'],
  [54, 2766, 'a54e168624e003aa313d0502230e8f4ab216d43967b02ff4711e3ebcfcca3a35',
    '5b3f9c519e5140cbfad706b3c65bbe41258b96bdb58ad6ee53722633ed3e89a3', '5f12c5611e90a219802f95e080775659fef6c94d2298c5aed8fbc6d19467f9af'],
].map(([seed, manifestBytes, manifestSha256, ...pages]) => Object.freeze({ id: `seed-${seed}`, seed,
  manifestBytes, manifestSha256, pageHashes: Object.freeze(pages.map((value, id) => Object.freeze({ id, sha256: value }))) })));

export const REGION_EXECUTION_PLAN = Object.freeze({
  directSubmissions: 8, directTimeoutMs: 180000, routeCleanupTimeoutMs: 10000, resourceCleanupTimeoutMs: 10000,
  browser: { channel: 'chrome', headless: false, softwareGpu: false, args: ['--enable-unsafe-webgpu'] },
  requiredAdapter: 'Apple Metal, non-fallback', automaticRetries: 0,
  coordinatorLimits: { maxDesiredRegions: 4, maxLiveRegions: 2, maxManifestBytes: 2768, maxRetainedManifestBytes: 5536 },
  transferLimits: { maxRequests: 2, pageStagingBytes: 65536, transientBytes: 1048576, residentBytes: 1048576,
    gpuBufferBytes: 4194304, uploadBytesPerFrame: 65536 },
  outerWindow: { owner: 'external coordinator', watchdogSeconds: 600, stopCommandsSeconds: 575, cleanupSeconds: 590,
    subsequentCommands: ['node scripts/test-geometry.mjs', 'node scripts/test-geometry-fallback.mjs',
      'node scripts/test-geometry-retention.mjs', 'node scripts/test-geometry-initialization.mjs', 'node scripts/test-consumers.mjs'], stopAfterFirstFailure: true },
  localGpuAuthorizedByPreparation: false,
});

export function canonicalJson(value) {
  function order(item) {
    return Array.isArray(item) ? item.map(order) : item !== null && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, order(item[key])])) : item;
  }
  return JSON.stringify(order(JSON.parse(JSON.stringify(value))));
}

export function parseRegionInitializationArgs(argv) {
  let prepareOnly = false, prepared, output;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--prepare-only' && !prepareOnly) { prepareOnly = true; continue; }
    if ((argument === '--prepared' && prepared === undefined || argument === '--output' && output === undefined)
      && typeof argv[index + 1] === 'string' && argv[index + 1].length > 0 && !argv[index + 1].startsWith('-')) {
      if (argument === '--prepared') prepared = argv[++index]; else output = argv[++index];
      continue;
    }
    throw new Error(`Unknown, repeated or incomplete region initialization argument: ${argument}`);
  }
  assert(output, '--output is required and must identify a fresh directory outside Git.');
  assert(prepareOnly !== (prepared !== undefined), 'Choose exactly one of --prepare-only or --prepared <frozen directory>.');
  if (prepared !== undefined) assert.notEqual(resolve(prepared), resolve(output), 'Prepared and output directories must differ.');
  return { prepareOnly, prepared, output };
}

export function validateHardwareEnvironment(environment) {
  assert.equal(environment.STRATA_TEST_BROWSER_CHANNEL, 'chrome', 'Native execution requires STRATA_TEST_BROWSER_CHANNEL=chrome.');
  assert.equal(environment.STRATA_TEST_HEADED, '1', 'Native execution requires STRATA_TEST_HEADED=1.');
  assert.equal(environment.STRATA_TEST_SOFTWARE_GPU, '0', 'Native execution requires STRATA_TEST_SOFTWARE_GPU=0.');
  return REGION_EXECUTION_PLAN.browser;
}

function safeRelativePath(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\')
    && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}
function validateFiles(files, label) {
  assert(Array.isArray(files) && files.length > 0, `${label} file identity list is required.`);
  const seen = new Set();
  for (const file of files) {
    assert(safeRelativePath(file.path) && !seen.has(file.path), `${label} contains an unsafe or repeated path.`);
    assert(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && sha256.test(file.sha256), `${label} has an invalid byte/hash receipt.`);
    seen.add(file.path);
  }
  assert.deepEqual(files.map(file => file.path), [...seen].sort(), `${label} paths must be sorted.`);
}
function validateSource(source) {
  assert(source && /^[a-f0-9]{40}$/.test(source.head) && /^[a-f0-9]{40}$/.test(source.tree), 'Exact source HEAD/tree required.');
  assert.equal(source.dirty, false, 'Source must be clean.'); assert.equal(source.status, '', 'Source must have empty Git status.');
  assert.equal(source.trackedDiffSha256, hash(Buffer.alloc(0)), 'Source tracked diff must be empty.');
  assert(sha256.test(source.runnerSha256), 'Runner hash required.');
  validateFiles(source.inputs, 'Source');
}
function validateRuntime(files) {
  validateFiles(files, 'Built runtime');
  for (const name of ['index.js', 'worker.js', 'strata_runtime.wasm']) assert(files.some(file => file.path === name), `Built runtime missing ${name}.`);
  assert(files.some(file => file.path.endsWith('.d.ts')), 'Built runtime declarations required.');
}
function validateIdentity(evidence) {
  validateSource(evidence.sourceBefore); validateSource(evidence.sourceAfter);
  assert.deepEqual(evidence.sourceAfter, evidence.sourceBefore, 'Source changed during preparation or preflight.');
  validateRuntime(evidence.builtRuntimeBefore); validateRuntime(evidence.builtRuntimeAfter);
  assert.deepEqual(evidence.builtRuntimeAfter, evidence.builtRuntimeBefore, 'Built runtime changed during preparation or preflight.');
  assert(sha256.test(evidence.browserBundleSha256) && sha256.test(evidence.preparationSha256), 'Bundle and preparation hashes required.');
  assert.deepEqual(evidence.fixtures, REGION_FIXTURE_IDENTITIES, 'Fixture identities differ from the frozen CPU sources.');
  assert.deepEqual(evidence.executionPlan, REGION_EXECUTION_PLAN, 'Execution plan differs from the bounded native profile.');
  const chrome = evidence.installedChrome;
  assert(chrome && isAbsolute(chrome.executablePath) && /^\d+(?:\.\d+){3}$/.test(chrome.version)
    && sha256.test(chrome.executableSha256) && sha256.test(chrome.infoPlistSha256), 'Installed Chrome identity required.');
}

/** Pure validation; must succeed before the execution branch imports Playwright. */
export function validatePreparedEvidence(preparedReport, currentEvidence) {
  assert.equal(preparedReport.schema, schema, 'Unknown prepared evidence schema.');
  assert.equal(preparedReport.mode, 'prepared', 'Execution requires CPU preparation evidence.');
  assert.equal(preparedReport.passed, true, 'Preparation must have passed.');
  assert.equal(preparedReport.status, 'prepared', 'Preparation must have completed.');
  assert.equal(preparedReport.performanceEvidence, false, 'Preparation is not performance evidence.');
  assert.equal(preparedReport.browserLaunched, false, 'Preparation must not launch a browser.');
  assert.equal(preparedReport.gpuExecutionAttempted, false, 'Preparation must not attempt GPU execution.');
  assert.equal(preparedReport.generatedFixtureCleanup, 'removed', 'Prepared fixture cleanup must complete.');
  assert.equal(preparedReport.frozenCopiesVerifiedAfter, true, 'Prepared code/package copies must be verified.');
  assert.equal(preparedReport.failure, undefined, 'Preparation must not contain a failure.');
  for (const key of ['cleanupErrors', 'identityErrors', 'routeErrors', 'browserErrors', 'requestFailures', 'responseErrors']) {
    assert.deepEqual(preparedReport[key], [], `Preparation ${key} must be empty.`);
  }
  validateIdentity(preparedReport); validateIdentity(currentEvidence);
  for (const key of ['sourceBefore', 'sourceAfter', 'builtRuntimeBefore', 'builtRuntimeAfter', 'browserBundleSha256',
    'preparationSha256', 'fixtures', 'executionPlan', 'installedChrome']) {
    assert.deepEqual(currentEvidence[key], preparedReport[key], `${key} differs from frozen preparation.`);
  }
  return true;
}

function errorDetails(error) {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? null,
    ...(error.details === undefined ? {} : { details: error.details }) } : { message: String(error) };
}
async function bounded(promise, label, timeoutMs) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
async function fileHashes(paths) {
  return Promise.all(paths.map(async path => {
    assert(safeRelativePath(path), 'Source path escapes the repository.');
    const canonical = await realpath(resolve(repository, path));
    assert.equal(canonical, resolve(repository, path), 'Source inputs must not redirect through symlinks.');
    const bytes = await readFile(canonical); return { path, bytes: bytes.length, sha256: hash(bytes) };
  }));
}
async function revision(inputPaths) {
  const [head, tree, status, diff, inputs] = await Promise.all([
    command('git', ['rev-parse', 'HEAD'], { cwd: repository }),
    command('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repository }),
    command('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repository }),
    command('git', ['diff', '--binary', 'HEAD'], { cwd: repository, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }),
    fileHashes(inputPaths),
  ]);
  return { head: head.stdout.trim(), tree: tree.stdout.trim(), dirty: status.stdout.length !== 0, status: status.stdout,
    trackedDiffSha256: hash(diff.stdout), runnerSha256: hash(await readFile(runnerPath)), inputs };
}
async function runtimeFiles(path = resolve(repository, 'packages/core/dist'), prefix = '') {
  const files = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (entry.isDirectory()) files.push(...await runtimeFiles(resolve(path, entry.name), `${prefix}${entry.name}/`));
    else {
      assert(entry.isFile(), 'Built package must contain ordinary files.');
      const bytes = await readFile(resolve(path, entry.name));
      files.push({ path: `${prefix}${entry.name}`, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
async function installedChrome() {
  assert.equal(platform(), 'darwin', 'This frozen native proof requires installed macOS Chrome and Apple Metal.');
  const app = '/Applications/Google Chrome.app/Contents';
  const executablePath = await realpath(resolve(app, 'MacOS/Google Chrome'));
  await access(executablePath, constants.X_OK);
  const plist = resolve(app, 'Info.plist');
  const result = await command('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { timeout: 5000 });
  return { executablePath, version: result.stdout.trim(), executableSha256: hash(await readFile(executablePath)), infoPlistSha256: hash(await readFile(plist)) };
}
async function copyFiles(directory, prefix, files, sourceRoot) {
  for (const file of files) {
    const bytes = await readFile(resolve(sourceRoot, file.path));
    assert.equal(hash(bytes), file.sha256, `Source changed while copying ${file.path}.`);
    const destination = resolve(directory, prefix, file.path);
    await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes);
  }
}
async function readContained(directory, path) {
  assert(safeRelativePath(path), 'Prepared artifact path must be relative and contained.');
  const resolved = resolve(directory, path), canonical = await realpath(resolved);
  assert.equal(canonical, resolved, 'Prepared artifacts must not redirect through symlinks.');
  assert((await stat(canonical)).isFile(), 'Prepared artifacts must be files.');
  return readFile(canonical);
}
async function readPrepared(directory) {
  const bytes = await readContained(directory, 'report.json');
  assert.equal((await readContained(directory, 'report.sha256')).toString('utf8'), `${hash(bytes)}  report.json\n`, 'Prepared report checksum mismatch.');
  const report = JSON.parse(bytes.toString('utf8'));
  validatePreparedEvidence(report, report);
  assert.equal(hash(await readContained(directory, artifactName)), report.browserBundleSha256, 'Frozen browser bundle changed.');
  assert.equal(hash(canonicalJson(JSON.parse(await readContained(directory, 'preparation.json')))), report.preparationSha256, 'Frozen plan changed.');
  assert.equal(hash(canonicalJson(report.preparation)), report.preparationSha256, 'Report plan differs from frozen plan.');
  await verifyCopies(directory, report);
  return { directory, report, reportSha256: hash(bytes) };
}
async function verifyCopies(directory, report) {
  for (const [prefix, files] of [['source-inputs', report.sourceBefore.inputs], ['built-runtime', report.builtRuntimeBefore]]) {
    for (const file of files) {
      const content = await readContained(directory, `${prefix}/${file.path}`);
      assert.equal(content.length, file.bytes, `Frozen ${prefix}/${file.path} length changed.`);
      assert.equal(hash(content), file.sha256, `Frozen ${prefix}/${file.path} hash changed.`);
    }
  }
}

async function canonicalFutureDirectory(path) {
  let ancestor = resolve(path); const suffix = [];
  for (;;) {
    try { return resolve(await realpath(ancestor), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor); assert.notEqual(parent, ancestor, 'Cannot resolve output ancestry.');
      suffix.unshift(relative(parent, ancestor)); ancestor = parent;
    }
  }
}

async function cookSource(identity, fixtureDirectory, routes, cookerReceipts) {
  const output = resolve(fixtureDirectory, identity.id);
  const args = ['run', '--release', '--locked', '--package', 'strata-geometry-cooker', '--', '--output', output,
    '--seed', String(identity.seed), '--tiles', '2', '--cells', '8'];
  const result = await command('cargo', args, { cwd: repository, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  const raw = await readFile(resolve(output, 'manifest.json')), manifest = JSON.parse(raw.toString('utf8'));
  assert.equal(raw.length, identity.manifestBytes); assert.equal(hash(raw), identity.manifestSha256, 'Manifest differs from frozen CPU fixture.');
  assert.equal(manifest.source.kind, 'analytic-heightfield-v1'); assert.equal(manifest.source.seed, identity.seed);
  assert.equal(manifest.source.tilesPerSide, 2); assert.equal(manifest.source.cellsPerTile, 8); assert.equal(manifest.source.triangleCount, 512);
  assert.equal(manifest.pageBytes, 65536); assert.equal(manifest.pages.length, 2); assert.deepEqual(manifest.rootPageIds, [0]);
  const manifestUrl = `/__region-init__/${identity.id}/manifest.json`;
  routes.set(manifestUrl, { body: raw, contentType: 'application/json', source: identity.id });
  for (const [id, page] of manifest.pages.entries()) {
    assert.equal(page.id, id); assert.equal(page.url, `pages/${String(id).padStart(6, '0')}.bin`);
    const bytes = await readFile(resolve(output, page.url));
    assert.equal(bytes.length, 65536); assert.equal(hash(bytes), page.sha256); assert.equal(page.sha256, identity.pageHashes[id].sha256);
    routes.set(`/__region-init__/${identity.id}/${page.url}`, { body: bytes, contentType: 'application/octet-stream', source: identity.id, pageId: id });
  }
  cookerReceipts.push({ id: identity.id, command: ['cargo', ...args.map(value => value === output ? '<temporary fixture>' : value)], stdout: result.stdout, stderr: result.stderr });
  return { id: identity.id, manifestUrl, manifest, manifestBytes: raw.length, manifestSha256: hash(raw),
    pageHashes: identity.pageHashes, rootPageIndices: [0], poolPages: 2 };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseRegionInitializationArgs(argv);
  if (!options.prepareOnly) validateHardwareEnvironment(process.env);
  const preparedDirectory = options.prepared === undefined ? undefined : await realpath(resolve(options.prepared));
  // Validate frozen input before creating this run's output; never mutate previous evidence.
  const prepared = preparedDirectory === undefined ? undefined : await readPrepared(preparedDirectory);
  const candidate = await canonicalFutureDirectory(options.output);
  if (preparedDirectory) {
    const rel = relative(preparedDirectory, candidate);
    assert(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel), 'Output must be outside the frozen preparation directory.');
  }
  const directory = await prepareGalleryOutput(candidate);
  assert.deepEqual(await readdir(directory), [], 'Use a fresh evidence directory.');
  const report = { schema, mode: options.prepareOnly ? 'prepared' : 'native', passed: false, status: 'running', stage: 'source',
    performanceEvidence: false, browserLaunched: false, gpuExecutionAttempted: false,
    host: { platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model ?? null, memoryBytes: totalmem(), node: process.version },
    ...(prepared ? { preparedFrom: { directory: prepared.directory, reportSha256: prepared.reportSha256 } } : {}),
    fixtures: REGION_FIXTURE_IDENTITIES, executionPlan: REGION_EXECUTION_PLAN,
    cooker: [], routes: [], routeErrors: [], browserErrors: [], requestFailures: [], responseErrors: [], cleanupErrors: [], identityErrors: [],
    limitations: [
      'Correctness only. No performance, world rendering, placement, arbitrary geometry or request-admission fairness claim.',
      'CPU preparation never imports Playwright, starts a browser or requests a GPU adapter; it does not authorize native execution.',
      'Only unchanged procedural cooker seeds 51-54 are used. No external benchmark collection is read or copied.',
      'Source and built-package copies contain code, WASM and declarations; reports contain fixture hashes/counts, never cooked asset bytes.',
      'Queue write hashes describe accepted CPU arguments; native rendering feedback and texture readbacks provide GPU evidence.',
      'ABA holds use controlled injected fetch/cancel lifetimes in the harness. Loopback route delivery is separate from body/hash/owner settlement.',
      'The harness observes coordinator-owned providers without transferring their disposal responsibility. The public package is covered by subsequent regressions.',
      'The external coordinator owns the ten-minute watchdog, process-group cleanup and sequential unchanged regressions.',
    ],
  };
  let browser, context, server, fixtureDirectory, inputPaths, artifact;
  const routes = new Map(), routeHandlers = new Set();
  async function persist() {
    assert.equal(await realpath(directory), directory, 'Evidence output moved.');
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    await writeFile(resolve(directory, 'report.json'), bytes); await writeFile(resolve(directory, 'report.sha256'), `${hash(bytes)}  report.json\n`);
  }
  async function verifyIdentity() {
    for (const [key, read, before] of [
      ['sourceAfter', () => revision(inputPaths), report.sourceBefore], ['builtRuntimeAfter', runtimeFiles, report.builtRuntimeBefore],
      ['installedChromeAfter', installedChrome, report.installedChrome],
      ['browserBundleAfterSha256', async () => hash(await readFile(resolve(directory, artifactName))), report.browserBundleSha256],
      ['preparationAfterSha256', async () => hash(canonicalJson(JSON.parse(await readFile(resolve(directory, 'preparation.json'))))), report.preparationSha256],
    ]) {
      if (before === undefined) continue;
      try { report[key] = await read(); assert.deepEqual(report[key], before, `${key} changed.`); }
      catch (error) { report.identityErrors.push({ stage: key, ...errorDetails(error) }); }
    }
  }
  try {
    // Inspect entry inputs without importing the bundle or performing browser work.
    const initial = await revision([]); assert.equal(initial.dirty, false, 'Commit the reviewed CPU preparation before freezing it.');
    report.installedChrome = await installedChrome();
    report.builtRuntimeBefore = await runtimeFiles(); validateRuntime(report.builtRuntimeBefore);
    const cookerFiles = (await command('git', ['ls-files', 'crates/geometry-cooker', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'], { cwd: repository })).stdout.trim().split('\n').filter(Boolean);
    report.stage = 'bundle';
    const bundle = await build({ absWorkingDir: repository, entryPoints: [harnessPath], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, metafile: true });
    assert.equal(bundle.outputFiles.length, 1); artifact = bundle.outputFiles[0].contents;
    inputPaths = [...new Set([...Object.keys(bundle.metafile.inputs), ...cookerFiles, 'scripts/test-region-initialization.mjs',
      'scripts/benchmark-server.mjs', 'scripts/gallery-catalog.mjs', 'scripts/gallery-output.mjs', 'scripts/build.mjs',
      'package.json', 'package-lock.json', 'packages/core/package.json', 'scripts/test-geometry.mjs',
      'scripts/test-geometry-fallback.mjs', 'scripts/test-geometry-retention.mjs', 'scripts/test-geometry-initialization.mjs', 'scripts/test-consumers.mjs'])].sort();
    report.sourceBefore = await revision(inputPaths); validateSource(report.sourceBefore);
    for (const key of ['head', 'tree', 'dirty', 'status', 'trackedDiffSha256', 'runnerSha256']) assert.deepEqual(report.sourceBefore[key], initial[key], 'Source changed while bundling.');
    // A second CPU bundle, now bracketed by hashes, rules out a torn initial bundle.
    const frozenBundle = await build({ absWorkingDir: repository, entryPoints: [harnessPath], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, metafile: true });
    assert.equal(hash(frozenBundle.outputFiles[0].contents), hash(artifact), 'Bundle changed while recording inputs.');
    assert.deepEqual(frozenBundle.metafile.inputs, bundle.metafile.inputs, 'Bundle dependency graph changed.');
    report.browserBundleSha256 = hash(artifact);
    await writeFile(resolve(directory, artifactName), artifact);
    await copyFiles(directory, 'source-inputs', report.sourceBefore.inputs, repository);
    await copyFiles(directory, 'built-runtime', report.builtRuntimeBefore, resolve(repository, 'packages/core/dist'));
    report.stage = 'cpu-preparation'; fixtureDirectory = await mkdtemp(join(tmpdir(), 'strata-region-webgpu-'));
    const sources = [];
    for (const identity of REGION_FIXTURE_IDENTITIES) sources.push(await cookSource(identity, fixtureDirectory, routes, report.cooker));
    for (const alias of ['corrupt-manifest', 'corrupt-root']) for (const [path, entry] of [...routes]) {
      if (!path.startsWith('/__region-init__/seed-54/')) continue;
      const body = Buffer.from(entry.body), corrupt = alias === 'corrupt-manifest' ? entry.pageId === undefined : entry.pageId === 0;
      if (corrupt) body[0] ^= 1;
      routes.set(path.replace('/seed-54/', `/${alias}/`), { ...entry, body, source: alias, corrupt });
    }
    const module = await import(pathToFileURL(resolve(directory, artifactName)).href);
    assert.equal(typeof module.prepareRegionInitializationValidation, 'function'); assert.equal(typeof module.runRegionInitializationValidation, 'function');
    const input = { sources };
    report.preparation = await module.prepareRegionInitializationValidation(input);
    assert.deepEqual(report.preparation.coordinatorLimits, REGION_EXECUTION_PLAN.coordinatorLimits, 'Harness coordinator limits differ from runner plan.');
    assert.deepEqual(report.preparation.transferLimits, REGION_EXECUTION_PLAN.transferLimits, 'Harness transfer limits differ from runner plan.');
    assert.equal(report.preparation.gates.directRenderSubmissions, 8);
    assert.equal(report.preparation.gates.totalDeadlineMs, REGION_EXECUTION_PLAN.directTimeoutMs);
    report.preparationSha256 = hash(canonicalJson(report.preparation));
    await writeFile(resolve(directory, 'preparation.json'), `${JSON.stringify(report.preparation, null, 2)}\n`);
    report.sourceAfter = await revision(inputPaths); report.builtRuntimeAfter = await runtimeFiles();
    validateIdentity(report); await persist();
    if (options.prepareOnly) { report.passed = true; report.status = 'prepared'; }
    else {
      report.stage = 'frozen-preflight'; validatePreparedEvidence(prepared.report, report);
      // Re-read the frozen directory to detect edits during recooking, before any browser import.
      assert.equal((await readPrepared(prepared.directory)).reportSha256, prepared.reportSha256, 'Prepared evidence changed during preflight.');
      assert.deepEqual(await installedChrome(), report.installedChrome, 'Installed Chrome changed before launch.');
      report.frozenIdentityVerifiedBeforePlaywrightImport = true; await persist();
      validateHardwareEnvironment(process.env);
      report.stage = 'browser-start';
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ channel: 'chrome', headless: false, args: [...REGION_EXECUTION_PLAN.browser.args], timeout: 30000 });
      report.browserLaunched = true;
      report.browser = { version: browser.version(), ...REGION_EXECUTION_PLAN.browser };
      assert.equal(report.browser.version, report.installedChrome.version, 'Launched Chrome version differs from CPU preflight.');
      server = await createBenchmarkServer({ assetRoot: '' });
      context = await browser.newContext({ viewport: { width: 900, height: 750 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
      context.on('requestfailed', request => report.requestFailures.push({ url: request.url(), error: request.failure()?.errorText ?? 'unknown' }));
      context.on('response', response => { if (response.status() >= 400) report.responseErrors.push({ url: response.url(), status: response.status() }); });
      const scriptPath = `/${artifactName}`, htmlPath = '/region-initialization-validation.html';
      await context.route('**/*', route => {
        const action = (async () => {
          try {
            const request = route.request(), url = new URL(request.url());
            assert.equal(url.origin, server.url, 'Only the owned loopback origin may be requested.');
            assert.equal(url.search, '', 'Query routes are not allowlisted.'); assert.equal(request.method(), 'GET');
            if (url.pathname === scriptPath) return await route.fulfill({ contentType: 'text/javascript', body: Buffer.from(artifact) });
            if (url.pathname === htmlPath) return await route.fulfill({ contentType: 'text/html',
              body: '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Strata region initialization</title>' });
            const entry = routes.get(url.pathname); assert(entry, `Unexpected fixture route: ${url.pathname}`);
            const receipt = { path: url.pathname, source: entry.source, pageId: entry.pageId ?? null,
              bytes: entry.body.length, deliveredSha256: hash(entry.body), corrupt: entry.corrupt ?? false, outcome: 'fulfilling' };
            report.routes.push(receipt);
            // Every valid page is served normally. A non-root request is still a correctness failure.
            if (entry.pageId !== undefined && entry.pageId !== 0) report.routeErrors.push({ message: `Unexpected detail request: ${url.pathname}` });
            await route.fulfill({ contentType: entry.contentType, body: entry.body, headers: { 'content-length': String(entry.body.length) } });
            receipt.outcome = 'delivered';
          } catch (error) {
            report.routeErrors.push({ url: route.request().url(), ...errorDetails(error) });
            try { await route.abort('failed'); } catch (abortError) { report.routeErrors.push(errorDetails(abortError)); }
          }
        })();
        routeHandlers.add(action);
        return action.finally(() => routeHandlers.delete(action));
      });
      const page = await context.newPage();
      page.on('pageerror', error => report.browserErrors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') report.browserErrors.push(message.text()); });
      const navigation = await page.goto(`${server.url}${htmlPath}`, { timeout: 30000 }); assert(navigation?.ok());
      report.stage = 'direct-webgpu'; report.gpuExecutionAttempted = true; await persist();
      report.browserResult = await bounded(page.evaluate(async ({ path, input }) => {
        try { const harness = await import(path); return await harness.runRegionInitializationValidation(input); }
        catch (error) { return { passed: false, failure: { name: error?.name, message: error?.message ?? String(error), stack: error?.stack ?? null, details: error?.details ?? null } }; }
      }, { path: scriptPath, input: { ...input, expectedPreparationHash: report.preparationSha256 } }), 'Native region proof', REGION_EXECUTION_PLAN.directTimeoutMs);
      if (report.browserResult.images) for (const [name, dataUrl] of Object.entries(report.browserResult.images)) {
        assert(/^[a-z0-9-]{1,96}$/.test(name), 'Unsafe readback image name.');
        assert(typeof dataUrl === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl), 'Expected PNG readback.');
        assert(dataUrl.length < 6 * 1024 * 1024, 'Readback PNG exceeds bounded size.');
        const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
        assert(bytes.length > 8 && bytes.length < 4 * 1024 * 1024 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Invalid bounded PNG.');
        await writeFile(resolve(directory, `${name}.png`), bytes);
        report.browserResult.images[name] = { path: `${name}.png`, bytes: bytes.length, sha256: hash(bytes) };
      }
      await persist();
      assert.equal(report.browserResult.passed, true, report.browserResult.failure?.message ?? JSON.stringify(report.browserResult.errors));
      assert.equal(hash(canonicalJson(report.browserResult.preparation)), report.preparationSha256, 'Browser plan differs from prepared plan.');
      const rendered = report.browserResult;
      assert.equal(rendered.schema, 'strata-region-initialization-webgpu-v1');
      assert.equal(rendered.adapter?.isFallbackAdapter, false, 'Native adapter must not be a fallback.');
      assert(/apple/i.test(rendered.adapter?.vendor ?? '') && /metal/i.test(rendered.adapter?.architecture ?? ''), 'The frozen proof requires Apple Metal.');
      assert.equal(rendered.submissions, 8); assert.equal(rendered.nativeQueueSubmissions?.length, 8);
      assert(rendered.nativeQueueSubmissions.every(value => value.commandBufferCount === 1 && value.phase === 'render-submit'));
      assert.equal(rendered.frames?.length, 8); assert.equal(rendered.comparisons?.length, 4);
      assert.equal(rendered.drawCalls, 24); assert.equal(rendered.dispatchCalls, 16);
      assert.deepEqual(Object.keys(rendered.images).sort(), REGION_FIXTURE_IDENTITIES.flatMap(source => [`coordinator-${source.id}`, `eager-${source.id}`]).sort());
      assert.deepEqual(rendered.errors, []);
      await bounded(Promise.all([...routeHandlers]), 'Original route handler settlement', REGION_EXECUTION_PLAN.routeCleanupTimeoutMs);
      assert.equal(routeHandlers.size, 0, 'Routes remained active before runner cleanup.');
      report.httpOwnershipBeforeRunnerCleanup = { heldRoutes: 0, originalHandlers: routeHandlers.size,
        policy: 'All allowlisted responses fulfilled normally; controlled ABA holds belong to the harness.' };
      assert(report.routes.some(route => route.source === 'corrupt-manifest' && route.corrupt && route.outcome === 'delivered'));
      assert(report.routes.some(route => route.source === 'corrupt-root' && route.corrupt && route.outcome === 'delivered'));
      for (const key of ['routeErrors', 'browserErrors', 'requestFailures', 'responseErrors']) assert.deepEqual(report[key], [], `${key} must be empty.`);
      report.passed = true; report.status = 'passed';
    }
  } catch (error) { report.status = 'failed'; report.failure = errorDetails(error); }
  finally {
    if (routeHandlers.size) report.cleanupErrors.push({ message: `${routeHandlers.size} original route handlers required runner cleanup.` });
    try { await bounded(Promise.all([...routeHandlers]), 'Original route cleanup', REGION_EXECUTION_PLAN.routeCleanupTimeoutMs); }
    catch (error) { report.cleanupErrors.push(errorDetails(error)); }
    for (const [name, resource] of [['context', context], ['browser', browser], ['server', server]]) {
      if (!resource) continue;
      try { await bounded(resource.close(), `${name} cleanup`, REGION_EXECUTION_PLAN.resourceCleanupTimeoutMs); }
      catch (error) { report.cleanupErrors.push({ resource: name, ...errorDetails(error) }); }
    }
    if (fixtureDirectory) {
      try { await rm(fixtureDirectory, { recursive: true, force: true }); report.generatedFixtureCleanup = 'removed'; }
      catch (error) { report.cleanupErrors.push({ resource: 'generated fixtures', ...errorDetails(error) }); }
    }
    await verifyIdentity();
    if (report.sourceBefore && report.builtRuntimeBefore) {
      try { await verifyCopies(directory, report); report.frozenCopiesVerifiedAfter = true; }
      catch (error) { report.identityErrors.push({ stage: 'frozen copies', ...errorDetails(error) }); }
    }
    if (prepared) {
      try { assert.equal((await readPrepared(prepared.directory)).reportSha256, prepared.reportSha256, 'Frozen preparation changed during native run.'); }
      catch (error) { report.identityErrors.push({ stage: 'prepared evidence', ...errorDetails(error) }); }
    }
    if (report.failure || ['cleanupErrors', 'identityErrors', 'routeErrors', 'browserErrors', 'requestFailures', 'responseErrors'].some(key => report[key].length)) {
      report.passed = false; report.status = 'failed';
    }
    report.finalStage = report.stage; await persist();
    console.log(`Region initialization ${options.prepareOnly ? 'CPU preparation' : 'native correctness'} ${report.status}: ${directory}/report.json`);
  }
  return report;
}

// Importing the runner exposes CPU test helpers only; no preparation or browser work starts.
if (process.argv[1] && resolve(process.argv[1]) === runnerPath) {
  try { if (!(await main()).passed) process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
