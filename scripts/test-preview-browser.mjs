import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Correctness acceptance only. Run in an explicitly scheduled browser/GPU slot,
// after building; this harness never builds Rust or launches concurrent browsers.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'strata-preview-browser-'));
const output = join(homedir(), 'Downloads', 'Strata-Preview-Checks', `${new Date().toISOString().replace(/[:.]/g, '-')}-packed-preview-browser-${process.pid}`);
await mkdir(output, { recursive: true });
const guards = join(temporary, 'rust-guards');
const toolLog = join(output, 'unexpected-rust-invocation.log');
const env = {
  ...process.env, PATH: `${guards}${delimiter}${process.env.PATH ?? ''}`,
  STRATA_PREVIEW_TOOL_LOG: toolLog, STRATA_PREVIEW_CHECK_OUTPUT: output,
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
};
delete env.STRATA_BENCHMARK_ASSET_DIR;
const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {
  format: 'strata.preview.browser-check', version: 1, status: 'running',
  startedAt: new Date().toISOString(), outputDirectory: output,
  purpose: 'Packed consumer correctness; no FPS, frame-budget, or visual-quality target claim.',
  plan: { browserLifetimes: 2, submittedFrames: 14, captures: 7, apiViewport: [512, 512], resizedViewport: [640, 360] },
  browser: { channel: env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headed: env.STRATA_TEST_HEADED === '1', softwareGpu: env.STRATA_TEST_SOFTWARE_GPU === '1' },
  archives: {},
};

async function run(command, args, cwd = root, timeout = 120_000) {
  try {
    const { stdout, stderr } = await execute(command, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed (${error.code ?? error.signal}):\n${error.stdout ?? ''}${error.stderr ?? ''}`, { cause: error });
  }
}

async function inspectArchive(archive, name) {
  const manifest = JSON.parse((await run('tar', ['-xOf', archive, 'package/package.json'])).stdout);
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, '0.0.0');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(manifest.scripts?.[hook], undefined, `${name} consumers must not build on installation`);
  }
  for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const version of Object.values(manifest[kind] ?? {})) {
      assert.equal(/^(?:file:|link:|\/)/.test(version), false, `${name} contains a local dependency path`);
    }
    const forbidden = name === '@strata-engine/preview' ? ['@strata-engine/editor', 'puppeteer', 'vite']
      : ['@strata-engine/authoring', '@strata-engine/preview', '@strata-engine/editor', 'playwright', 'puppeteer', 'vite', ...(name === '@strata-engine/authoring' ? ['@strata-engine/core'] : [])];
    for (const dependency of forbidden) assert.equal(manifest[kind]?.[dependency], undefined, `${name} must not require ${dependency}`);
  }
  if (name === '@strata-engine/preview') {
    assert.equal(manifest.dependencies?.['@strata-engine/core'], '0.0.0');
    assert.equal(manifest.dependencies?.['@strata-engine/authoring'], '0.0.0');
    assert.equal(manifest.dependencies?.playwright, '1.63.0');
    assert.equal(manifest.bin?.['strata-preview'], './dist/bin.js');
  }
  const contents = (await run('tar', ['-tf', archive])).stdout.trim().split('\n');
  for (const path of ['dist/index.js', 'dist/index.d.ts', 'README.md',
    ...(name === '@strata-engine/core' ? ['dist/worker.js', 'dist/strata_runtime.wasm'] : []),
    ...(name === '@strata-engine/preview' ? ['dist/bin.js', 'dist/browser/client.js'] : [])]) {
    assert.ok(contents.includes(`package/${path}`), `${name} is missing ${path}; build before running this check`);
  }
  assert.equal(contents.some(path => /(?:^|\/)(?:src|tests|target|node_modules)\//.test(path)), false, 'Archive must contain distributions, not workspace source/toolchains');
  assert.equal(contents.some(path => /\.(?:rs|gltf|glb|zip)$/.test(path)), false, 'Archive must not contain Rust sources or imported models');
  const bytes = await readFile(archive);
  report.archives[name] = { version: manifest.version, sha256: sha256(bytes), bytes: bytes.length };
  return archive;
}

async function pack(name, directory) {
  const packed = JSON.parse((await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], join(root, 'packages', directory))).stdout);
  const entry = Array.isArray(packed) ? packed.find(item => item.name === name) : packed[name];
  assert.ok(entry, `npm pack did not report ${name}`);
  return inspectArchive(join(temporary, entry.filename), name);
}

async function sourceEvidence() {
  const paths = (await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z',
    'packages/core', 'packages/authoring', 'packages/preview', 'scripts/test-preview-browser.mjs', 'tests/consumers/preview/browser-workflow.mjs', 'package.json', 'package-lock.json'])).stdout.split('\0').filter(Boolean).sort();
  const files = {};
  for (const path of new Set(paths)) {
    try { files[path] = sha256(await readFile(join(root, path))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files[path] = null; }
  }
  const manifest = `${JSON.stringify(files, null, 2)}\n`;
  await writeFile(join(output, 'source-sha256.json'), manifest);
  return {
    commit: (await run('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    branch: (await run('git', ['branch', '--show-current'])).stdout.trim(),
    status: (await run('git', ['status', '--short'])).stdout,
    sourceManifest: 'source-sha256.json', sourceManifestSha256: sha256(manifest),
    note: 'Worktree source identity is recorded separately from consumed archive bytes; an external Core checkpoint may have a different source commit.',
  };
}

try {
  assert.ok(['chromium', 'chrome'].includes(report.browser.channel), 'STRATA_TEST_BROWSER_CHANNEL must be chromium or chrome');
  report.source = await sourceEvidence();
  await mkdir(guards);
  for (const command of ['cargo', 'rustc', 'rustup', 'wasm-pack']) {
    const path = join(guards, command);
    await writeFile(path, '#!/bin/sh\nprintf "%s\\n" "$0" >> "$STRATA_PREVIEW_TOOL_LOG"\nexit 91\n');
    await chmod(path, 0o755);
  }
  const authoring = await pack('@strata-engine/authoring', 'authoring');
  const preview = await pack('@strata-engine/preview', 'preview');
  let core;
  if (env.STRATA_PREVIEW_CORE_ARCHIVE) {
    // Copy first: the hash and install must refer to the same checkpoint bytes.
    core = join(temporary, 'verified-core-checkpoint.tgz');
    await writeFile(core, await readFile(resolve(env.STRATA_PREVIEW_CORE_ARCHIVE)));
    await inspectArchive(core, '@strata-engine/core');
  } else core = await pack('@strata-engine/core', 'core');
  report.coreSource = env.STRATA_PREVIEW_CORE_ARCHIVE
    ? { kind: 'external-checkpoint', path: resolve(env.STRATA_PREVIEW_CORE_ARCHIVE), commit: env.STRATA_PREVIEW_CORE_SOURCE_REVISION ?? null }
    : { kind: 'workspace-package', commit: report.source.commit };
  if (env.STRATA_PREVIEW_CORE_SHA256) assert.equal(report.archives['@strata-engine/core'].sha256, env.STRATA_PREVIEW_CORE_SHA256.toLowerCase(), 'Core archive SHA256 mismatch');

  await mkdir(join(output, 'archives'));
  for (const [name, archive] of [['core', core], ['authoring', authoring], ['preview', preview]]) {
    const path = join('archives', `strata-engine-${name}-0.0.0.tgz`);
    await copyFile(archive, join(output, path));
    assert.equal(sha256(await readFile(join(output, path))), report.archives[`@strata-engine/${name}`].sha256);
    report.archives[`@strata-engine/${name}`].relativePath = path;
  }

  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  await copyFile(join(root, 'tests/consumers/preview/browser-workflow.mjs'), join(consumer, 'browser-workflow.mjs'));
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'strata-preview-packed-browser-consumer', private: true, type: 'module',
    dependencies: { '@strata-engine/core': `file:${core}`, '@strata-engine/authoring': `file:${authoring}`, '@strata-engine/preview': `file:${preview}` },
  }, null, 2));
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  for (const name of ['core', 'authoring', 'preview']) {
    assert.equal((await lstat(join(consumer, 'node_modules/@strata-engine', name))).isSymbolicLink(), false, `${name} must be installed from its archive`);
  }
  const wasm = await readFile(join(consumer, 'node_modules/@strata-engine/core/dist/strata_runtime.wasm'));
  assert.deepEqual(wasm.subarray(0, 8), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const client = await readFile(join(consumer, 'node_modules/@strata-engine/preview/dist/browser/client.js'), 'utf8');
  // This small unbundled bridge is served directly. Type-only adapter imports must
  // disappear; optional Node tooling must never cross into the browser module.
  const imports = [...client.matchAll(/\b(?:import|export)\s+(?:[^;'"\n]*?\s+from\s*)?['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.deepEqual(imports, ['@strata-engine/core'], 'Browser bridge must import only the runtime');
  assert.equal(/\bimport\s*\(|\brequire\s*\(|node:|@strata-engine\/(?:authoring|preview)|playwright/.test(client), false);
  report.browserBoundary = { imports, clientSha256: sha256(client), precompiledWasmSha256: sha256(wasm) };
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Packed preview browser correctness: 14 planned submissions, 7 captures, two sequential browsers. Output: ${output}`);
  console.log(`Core archive SHA256: ${report.archives['@strata-engine/core'].sha256}`);
  let child;
  try { child = await run(process.execPath, ['browser-workflow.mjs'], consumer, 240_000); }
  catch (error) {
    await writeFile(join(output, 'workflow.stdout.txt'), error.cause?.stdout ?? '');
    await writeFile(join(output, 'workflow.stderr.txt'), error.cause?.stderr ?? '');
    throw error;
  }
  await writeFile(join(output, 'workflow.stdout.txt'), child.stdout);
  await writeFile(join(output, 'workflow.stderr.txt'), child.stderr);
  assert.equal(child.stderr, '', 'Successful browser workflow must have clean stderr');
  report.workflow = JSON.parse(await readFile(join(output, 'workflow-report.json'), 'utf8'));
  assert.equal(report.workflow.status, 'passed');
  assert.equal(report.workflow.totalSubmittedFrames, report.plan.submittedFrames);
  assert.equal(report.workflow.captures.length, report.plan.captures);
  await assert.rejects(readFile(toolLog), { code: 'ENOENT' }, 'Consumer unexpectedly invoked Rust tooling');
  report.status = 'passed';
  process.stdout.write(child.stdout);
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message };
  process.exitCode = 1;
  console.error(error.message);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await rm(temporary, { recursive: true, force: true });
  console.log(`Packed preview browser report: ${join(output, 'report.json')}`);
}
