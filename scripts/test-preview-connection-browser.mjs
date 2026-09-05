import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, homedir, platform, release, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { prepareGalleryOutput } from './gallery-output.mjs';
import { formatProcessCleanupSummary, superviseChildProcess } from './preview-process-cleanup.mjs';

// No builds or external asset collection. Preparation never launches a browser;
// the run stage requires its own explicitly granted browser/GPU window.
const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const runner = 'scripts/test-preview-connection-browser.mjs';
const workflow = 'tests/consumers/preview-connection/browser-workflow.mjs';
const cleanupHelper = 'scripts/preview-process-cleanup.mjs';
const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const inside = (base, path) => { const suffix = relative(base, path); return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)); };
const host = () => ({ platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model ?? null, node: process.version });
const browserOptions = () => ({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headed: process.env.STRATA_TEST_HEADED === '1',
  softwareGpu: process.env.STRATA_TEST_SOFTWARE_GPU === '1', browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null });
const args = process.argv.slice(2);
const prepareOnly = args.length === 1 && args[0] === '--prepare-only';
const runPrepared = args.length === 2 && args[0] === '--run-prepared' && isAbsolute(args[1]);
assert.ok(args.length === 0 || prepareOnly || runPrepared,
  'Usage: node scripts/test-preview-connection-browser.mjs [--prepare-only | --run-prepared ABSOLUTE_REPORT_DIRECTORY]');

async function command(name, parameters, cwd = root, env = process.env) {
  return execute(name, parameters, { cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
}
async function loggedCommand(label, name, parameters, cwd, env) {
  let stdout = '', stderr = '';
  try {
    const result = await command(name, parameters, cwd, env); stdout = result.stdout; stderr = result.stderr; return result;
  } catch (error) { stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; throw error; }
  finally { await writeFile(join(output, `${label}.stdout.txt`), stdout); await writeFile(join(output, `${label}.stderr.txt`), stderr); }
}
async function evidenceFile(path) {
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: hash(bytes) };
}
async function tree(directory, prefix = '', symlinks = false) {
  const files = {};
  for (const item of (await readdir(join(directory, prefix))).sort()) {
    const path = prefix ? `${prefix}/${item}` : item;
    const absolute = join(directory, path), stat = await lstat(absolute);
    if (stat.isDirectory()) Object.assign(files, await tree(directory, path, symlinks));
    else if (stat.isSymbolicLink()) {
      assert.ok(symlinks && inside(directory, await realpath(absolute)), `Unexpected or escaping symlink: ${absolute}`);
      files[path] = { link: await readlink(absolute) };
    } else {
      assert.ok(stat.isFile(), `Unexpected non-file: ${absolute}`);
      files[path] = { ...(await evidenceFile(absolute)), mode: stat.mode & 0o777 };
    }
  }
  return files;
}
async function sourceIdentity() {
  const paths = (await command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean).sort();
  const files = {};
  for (const path of new Set(paths)) {
    try { files[path] = await evidenceFile(join(root, path)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files[path] = null; }
  }
  return {
    repository: root, commit: (await command('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    branch: (await command('git', ['branch', '--show-current'])).stdout.trim(),
    status: (await command('git', ['status', '--porcelain=v1', '--untracked-files=all'])).stdout,
    files,
  };
}
async function buildIdentity() {
  const builds = {};
  for (const name of ['core', 'authoring', 'preview']) builds[name] = await tree(join(root, 'packages', name, 'dist'));
  return builds;
}
function environment(frozen, preparation = false) {
  const env = { ...process.env, PATH: `${join(frozen.temporaryDirectory, preparation ? 'prepare-guards' : 'rust-guards')}${delimiter}${process.env.PATH ?? ''}`,
    STRATA_PREVIEW_TOOL_LOG: join(frozen.outputDirectory, 'unexpected-tool-invocation.log'),
    STRATA_PREVIEW_CHECK_OUTPUT: frozen.outputDirectory, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    STRATA_TEST_BROWSER_CHANNEL: frozen.browser.channel, STRATA_TEST_HEADED: frozen.browser.headed ? '1' : '0',
    STRATA_TEST_SOFTWARE_GPU: frozen.browser.softwareGpu ? '1' : '0' };
  for (const key of Object.keys(env)) if (key.startsWith('STRATA_PREVIEW_CORE') || key === 'STRATA_BENCHMARK_ASSET_DIR' || key === 'NODE_OPTIONS' || key === 'NODE_PATH') delete env[key];
  if (preparation) env.PLAYWRIGHT_BROWSERS_PATH = join(frozen.temporaryDirectory, 'uninstalled-browsers');
  else if (frozen.browser.browsersPath === null) delete env.PLAYWRIGHT_BROWSERS_PATH;
  else env.PLAYWRIGHT_BROWSERS_PATH = frozen.browser.browsersPath;
  return env;
}
async function guards(directory, names) {
  await mkdir(directory);
  for (const name of names) {
    const path = join(directory, name);
    await writeFile(path, '#!/bin/sh\nprintf "%s\\n" "$0" >> "$STRATA_PREVIEW_TOOL_LOG"\nexit 91\n');
    await chmod(path, 0o755);
  }
}
async function pack(name, output, env) {
  const packageName = `@strata-engine/${name}`;
  const packed = JSON.parse((await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', join(output, 'archives')], join(root, 'packages', name), env)).stdout);
  const entry = Array.isArray(packed) ? packed.find(item => item.name === packageName) : packed[packageName];
  assert.ok(entry, `npm pack did not report ${packageName}`);
  assert.equal(entry.filename, `strata-engine-${name}-0.0.0.tgz`);
  const path = join('archives', entry.filename), archive = join(output, path);
  const manifest = JSON.parse((await command('tar', ['-xOf', archive, 'package/package.json'], root, env)).stdout);
  assert.equal(manifest.name, packageName); assert.equal(manifest.version, '0.0.0');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(manifest.scripts?.[hook], undefined, `${packageName} installation must not build`);
  for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const forbidden = name === 'preview' ? ['@strata-engine/editor', 'puppeteer', 'vite']
      : ['@strata-engine/authoring', '@strata-engine/preview', '@strata-engine/editor', 'playwright', 'puppeteer', 'vite', ...(name === 'authoring' ? ['@strata-engine/core'] : [])];
    for (const dependency of forbidden) assert.equal(manifest[kind]?.[dependency], undefined, `${packageName} must not require ${dependency}`);
    for (const version of Object.values(manifest[kind] ?? {})) assert.equal(/^(?:file:|link:|\/)/.test(version), false, 'Archive contains a local dependency');
  }
  if (name === 'preview') {
    assert.equal(manifest.dependencies?.['@strata-engine/core'], '0.0.0');
    assert.equal(manifest.dependencies?.['@strata-engine/authoring'], '0.0.0');
    assert.equal(manifest.dependencies?.playwright, '1.63.0');
    assert.equal(manifest.exports?.['./connection']?.import, './dist/connection.js');
    assert.equal(manifest.bin?.['strata-preview-connection'], './dist/connection-bin.js');
  }
  const files = entry.files.map(file => file.path).sort();
  for (const file of ['dist/index.js', 'dist/index.d.ts', 'README.md',
    ...(name === 'core' ? ['dist/worker.js', 'dist/strata_runtime.wasm'] : []),
    ...(name === 'preview' ? ['dist/connection.js', 'dist/connection.d.ts', 'dist/connection-bin.js', 'dist/browser/client.js'] : [])]) assert.ok(files.includes(file), `Build ${packageName} before running this check; missing ${file}`);
  assert.equal(files.some(path => /(?:^|\/)(?:src|tests|target|node_modules)\//.test(path) || /\.(?:rs|gltf|glb|zip)$/.test(path)), false, 'Archive contains source, toolchains or imported assets');
  return { path, ...(await evidenceFile(archive)), files };
}
async function writeReport(output, report) {
  const bytes = json(report);
  await writeFile(join(output, 'report.json'), bytes);
  await writeFile(join(output, 'report.sha256'), `${hash(bytes)}  report.json\n`);
}
async function noTools(output) { await assert.rejects(readFile(join(output, 'unexpected-tool-invocation.log')), { code: 'ENOENT' }, 'Guarded tooling was invoked'); }

let output, frozen, report, ownedTemporaryDirectory, ownsTemporary = false, claimedRun = false;
async function prepare() {
  output = await prepareGalleryOutput(join(homedir(), 'Downloads', 'Strata-Preview-Checks',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-packed-preview-connection-${process.pid}`));
  assert.deepEqual(await readdir(output), [], 'Preparation requires a fresh external directory');
  const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'strata-preview-connection-browser-')));
  ownsTemporary = true; ownedTemporaryDirectory = temporaryDirectory;
  frozen = { format: 'strata.preview.connection.browser-freeze', version: 1, outputDirectory: output,
    temporaryDirectory, consumerDirectory: join(temporaryDirectory, 'consumer'), preparedAt: new Date().toISOString(),
    browser: browserOptions(), node: { version: process.version, executable: await realpath(process.execPath), ...(await evidenceFile(process.execPath)) },
    plan: { browserLifetimes: 1, submittedFrames: 10, captures: 5 }, archives: {} };
  report = { format: 'strata.preview.connection.browser-check', version: 1, status: 'preparing', outputDirectory: output,
    startedAt: frozen.preparedAt, plan: frozen.plan, browser: frozen.browser, preparationHost: host(),
    purpose: 'Installed stdio correctness only; no performance, presented-frame, imported-asset or quality-target claim.' };
  frozen.source = await sourceIdentity(); frozen.builds = await buildIdentity();
  assert.ok(['chromium', 'chrome'].includes(frozen.browser.channel), 'STRATA_TEST_BROWSER_CHANNEL must be chromium or chrome');
  if (process.env.STRATA_PREVIEW_RUNTIME_REVIEWED_COMMIT) {
    frozen.runtimeReviewedCommit = (await command('git', ['rev-parse', '--verify', `${process.env.STRATA_PREVIEW_RUNTIME_REVIEWED_COMMIT}^{commit}`])).stdout.trim();
    await command('git', ['diff', '--exit-code', frozen.runtimeReviewedCommit, '--', 'packages/core', 'packages/authoring', 'packages/preview']);
  } else frozen.runtimeReviewedCommit = null;
  report.runtimeReviewedCommit = frozen.runtimeReviewedCommit;
  report.gpuMode = frozen.browser.softwareGpu ? 'explicit software GPU correctness mode' : 'hardware requested; actual adapter is reported by workflow receipts';
  const rust = ['cargo', 'rustc', 'rustup', 'wasm-pack'];
  await guards(join(temporaryDirectory, 'rust-guards'), rust);
  await guards(join(temporaryDirectory, 'prepare-guards'), [...rust, 'chromium', 'chromium-browser', 'google-chrome', 'playwright', 'firefox']);
  await mkdir(join(output, 'archives'));
  const env = environment(frozen, true);
  for (const name of ['core', 'authoring', 'preview']) frozen.archives[name] = await pack(name, output, env);
  await mkdir(frozen.consumerDirectory);
  await copyFile(join(root, workflow), join(frozen.consumerDirectory, 'browser-workflow.mjs'));
  await copyFile(join(root, workflow), join(output, 'browser-workflow.mjs'));
  await copyFile(join(root, runner), join(output, 'runner.mjs'));
  await copyFile(join(root, cleanupHelper), join(output, 'preview-process-cleanup.mjs'));
  await copyFile(join(root, cleanupHelper), join(frozen.consumerDirectory, 'preview-process-cleanup.mjs'));
  await writeFile(join(frozen.consumerDirectory, 'package.json'), json({ name: 'strata-preview-connection-browser-consumer', private: true, type: 'module',
    dependencies: Object.fromEntries(Object.entries(frozen.archives).map(([name, archive]) => [`@strata-engine/${name}`, `file:${join(output, archive.path)}`])) }));
  await loggedCommand('install', 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], frozen.consumerDirectory, env);
  for (const name of ['core', 'authoring', 'preview']) {
    const installed = join(frozen.consumerDirectory, 'node_modules/@strata-engine', name);
    assert.equal((await lstat(installed)).isSymbolicLink(), false, 'Packages must be installed archive copies');
    // Compare every archived file with the installed copy, including declarations
    // and README bytes, rather than assuming npm selected the local archive.
    const extracted = join(temporaryDirectory, `archive-${name}`); await mkdir(extracted);
    await command('tar', ['-xf', join(output, frozen.archives[name].path), '-C', extracted], root, env);
    assert.deepEqual(await tree(installed), await tree(join(extracted, 'package')), `Installed ${name} differs from its archive`);
    await rm(extracted, { recursive: true });
  }
  const wasm = await readFile(join(frozen.consumerDirectory, 'node_modules/@strata-engine/core/dist/strata_runtime.wasm'));
  assert.deepEqual(wasm.subarray(0, 8), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const client = await readFile(join(frozen.consumerDirectory, 'node_modules/@strata-engine/preview/dist/browser/client.js'), 'utf8');
  const imports = [...client.matchAll(/\b(?:import|export)\s+(?:[^;'"\n]*?\s+from\s*)?['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.deepEqual(imports, ['@strata-engine/core']);
  assert.equal(/\bimport\s*\(|\brequire\s*\(|node:|@strata-engine\/(?:authoring|preview)|playwright/.test(client), false);
  frozen.browserBoundary = { imports, clientSha256: hash(client), precompiledWasmSha256: hash(wasm) };
  const prepared = await loggedCommand('prepare', process.execPath, ['browser-workflow.mjs', '--prepare', output], frozen.consumerDirectory, env);
  assert.equal(prepared.stderr, '', 'CPU preparation must have clean stderr'); await noTools(output);
  frozen.inputs = await tree(join(output, 'inputs'));
  frozen.inputManifest = await evidenceFile(join(output, 'input-sha256.json'));
  frozen.harness = { workflow: await evidenceFile(join(output, 'browser-workflow.mjs')), runner: await evidenceFile(join(output, 'runner.mjs')),
    cleanupHelper: await evidenceFile(join(output, 'preview-process-cleanup.mjs')) };
  frozen.installation = await tree(frozen.consumerDirectory, '', true);
  frozen.guards = { rust: await tree(join(temporaryDirectory, 'rust-guards')), preparation: await tree(join(temporaryDirectory, 'prepare-guards')) };
  assert.deepEqual(await sourceIdentity(), frozen.source, 'Source changed during preparation');
  assert.deepEqual(await buildIdentity(), frozen.builds, 'Built packages changed during preparation');
  await writeFile(join(output, 'source-sha256.json'), json(frozen.source));
  await writeFile(join(output, 'build-sha256.json'), json(frozen.builds));
  await writeFile(join(output, 'installation-sha256.json'), json(frozen.installation));
  const bytes = json(frozen);
  await writeFile(join(output, 'freeze.json'), bytes, { flag: 'wx' });
  await writeFile(join(output, 'freeze.sha256'), `${hash(bytes)}  freeze.json\n`, { flag: 'wx' });
  report.status = 'prepared'; report.preparedAt = new Date().toISOString(); report.freezeSha256 = hash(bytes);
  report.source = { commit: frozen.source.commit, branch: frozen.source.branch, status: frozen.source.status };
  report.archives = frozen.archives; report.browserBoundary = frozen.browserBoundary;
  report.consumerDirectory = frozen.consumerDirectory;
  await writeReport(output, report);
}
async function verifyFrozen() {
  assert.equal(await realpath(root), frozen.source.repository, 'Prepared source repository differs');
  assert.equal(await realpath(output), frozen.outputDirectory, 'Prepared output directory moved');
  const temporaryBase = await realpath(tmpdir());
  assert.equal(dirname(frozen.temporaryDirectory), temporaryBase, 'Prepared consumer must be in the OS temp directory');
  assert.ok(frozen.temporaryDirectory.startsWith(join(temporaryBase, 'strata-preview-connection-browser-')));
  assert.equal(frozen.consumerDirectory, join(frozen.temporaryDirectory, 'consumer'));
  assert.equal(await realpath(frozen.temporaryDirectory), frozen.temporaryDirectory);
  ownsTemporary = true; ownedTemporaryDirectory = frozen.temporaryDirectory;
  assert.deepEqual(browserOptions(), frozen.browser, 'Requested browser/hardware mode changed since preparation');
  assert.deepEqual({ version: process.version, executable: await realpath(process.execPath), ...(await evidenceFile(process.execPath)) }, frozen.node, 'Node runtime changed since preparation');
  assert.deepEqual(await sourceIdentity(), frozen.source, 'Source HEAD, status or file hashes changed since preparation');
  assert.deepEqual(await buildIdentity(), frozen.builds, 'Built packages changed since preparation');
  assert.deepEqual(await tree(frozen.consumerDirectory, '', true), frozen.installation, 'Installed consumer bytes changed since preparation');
  assert.deepEqual(await tree(join(frozen.temporaryDirectory, 'rust-guards')), frozen.guards.rust);
  assert.deepEqual(await tree(join(frozen.temporaryDirectory, 'prepare-guards')), frozen.guards.preparation);
  assert.deepEqual(await tree(join(output, 'inputs')), frozen.inputs, 'Generated input bytes changed since preparation');
  assert.deepEqual(await evidenceFile(join(output, 'input-sha256.json')), frozen.inputManifest);
  for (const archive of Object.values(frozen.archives)) {
    assert.ok(archive.path.startsWith('archives/') && !archive.path.includes('..'));
    assert.deepEqual(await evidenceFile(join(output, archive.path)), { bytes: archive.bytes, sha256: archive.sha256 }, 'Prepared archive changed');
  }
  assert.deepEqual(await evidenceFile(join(output, 'browser-workflow.mjs')), frozen.harness.workflow);
  assert.deepEqual(await evidenceFile(join(output, 'runner.mjs')), frozen.harness.runner);
  assert.deepEqual(await evidenceFile(join(output, 'preview-process-cleanup.mjs')), frozen.harness.cleanupHelper);
  for (const [name, value] of [['source', frozen.source], ['build', frozen.builds], ['installation', frozen.installation]]) {
    assert.equal(await readFile(join(output, `${name}-sha256.json`), 'utf8'), json(value), `External ${name} manifest changed`);
  }
  await noTools(output);
}

async function runBrowser() {
  // Exclusive claim is retained on success and failure: a prepared run cannot be
  // retried or silently repurposed after an interrupted browser attempt.
  try { await writeFile(join(output, 'run-claimed.json'), json({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' }); }
  catch (error) { report = undefined; ownsTemporary = false; throw error; }
  claimedRun = true;
  report.status = 'verifying'; report.runHost = host(); await writeReport(output, report);
  await verifyFrozen();
  report.status = 'running'; report.runStartedAt = new Date().toISOString();
  await writeReport(output, report);
  let stdout = '', stderr = '', workloadError;
  try {
    const child = spawn(process.execPath, ['browser-workflow.mjs', '--run', output], {
      cwd: frozen.consumerDirectory, env: environment(frozen), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    // This exact supervisor also runs in CPU fixtures with detached Node children.
    const outcome = await superviseChildProcess(child, { rootCommand: process.execPath,
      timeoutMs: 240_000, termGraceMs: 5000, killGraceMs: 1000, exitGraceMs: 1000 });
    stdout = outcome.stdout; stderr = outcome.stderr; report.process = outcome.process;
    if (outcome.error) {
      try { process.stderr.write(formatProcessCleanupSummary(outcome)); }
      catch (error) { report.process.diagnosticReportingError = error.message; }
      try {
        process.stderr.write(`${JSON.stringify({
          format: 'strata.preview.process-cleanup-package-identity', version: 1,
          sourceCommit: frozen.source.commit,
          archives: { core: frozen.archives.core.sha256, authoring: frozen.archives.authoring.sha256, preview: frozen.archives.preview.sha256 },
        })}\n`);
      } catch (error) { report.process.packageIdentityReportingError = error.message; }
      throw Object.assign(new Error(outcome.error.message), { name: outcome.error.name });
    }
    assert.equal(stderr, '', 'Successful browser workflow must have clean stderr');
    const result = JSON.parse(await readFile(join(output, 'workflow-report.json'), 'utf8'));
    report.workflow = result;
    assert.equal(result.format, 'strata.preview.connection.browser-workflow'); assert.equal(result.status, 'passed');
    assert.equal(result.totalSubmittedFrames, frozen.plan.submittedFrames);
    assert.equal(result.captures.length, frozen.plan.captures);
    assert.equal(result.distinctSessionIds, 1); assert.equal(result.browserLifetimes, 1);
  } catch (error) { workloadError = error; throw error;
  } finally {
    await writeFile(join(output, 'workflow.stdout.txt'), stdout); await writeFile(join(output, 'workflow.stderr.txt'), stderr);
    if (!report.workflow) {
      try { report.workflow = JSON.parse(await readFile(join(output, 'workflow-report.json'), 'utf8')); }
      catch (error) { report.workflowReportError = { code: error.code ?? null, message: error.message }; }
    }
    try { await verifyFrozen(); report.postRunIdentity = { status: 'passed' }; }
    catch (error) { report.postRunIdentity = { status: 'failed', message: error.message }; if (!workloadError) throw error; }
  }
  report.status = 'passed'; process.stdout.write(stdout);
}

try {
  if (runPrepared) {
    output = await realpath(args[1]);
    assert.equal(await prepareGalleryOutput(output), output, 'Prepared evidence must remain external');
    const bytes = await readFile(join(output, 'freeze.json'));
    assert.equal(await readFile(join(output, 'freeze.sha256'), 'utf8'), `${hash(bytes)}  freeze.json\n`, 'Freeze manifest changed');
    frozen = JSON.parse(bytes); assert.equal(frozen.format, 'strata.preview.connection.browser-freeze'); assert.equal(frozen.version, 1);
    const previous = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    assert.equal(previous.status, 'prepared', 'Only a previously unrun prepared consumer can execute');
    assert.equal(previous.freezeSha256, hash(bytes));
    await assert.rejects(lstat(join(output, 'run-claimed.json')), { code: 'ENOENT' }, 'Prepared consumer was already claimed');
    report = previous;
  } else await prepare();
  console.log(`Packed connection: one planned browser, 10 submissions, 5 captures. Source: ${frozen.source.commit}`);
  console.log(`Core archive SHA256: ${frozen.archives.core.sha256}`);
  if (!prepareOnly) await runBrowser();
  else console.log(`CPU preparation complete; browser not launched. Retained consumer: ${frozen.consumerDirectory}`);
} catch (error) {
  if (report) { report.status = 'failed'; report.error = { name: error.name, message: error.message }; }
  process.exitCode = 1;
  console.error(error.message);
} finally {
  if (ownsTemporary && (!prepareOnly || report?.status !== 'prepared')) {
    try { await rm(ownedTemporaryDirectory, { recursive: true, force: true }); if (report) report.consumerCleanup = { status: 'removed' }; }
    catch (error) { if (report) { report.status = 'failed'; report.consumerCleanup = { status: 'failed', message: error.message }; } process.exitCode = 1; }
  }
  if (report) {
    report.finishedAt = new Date().toISOString(); report.browserRunClaimed = claimedRun;
    await writeReport(output, report);
    console.log(`Packed connection browser report: ${join(output, 'report.json')}`);
  }
}
