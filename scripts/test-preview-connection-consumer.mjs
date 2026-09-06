import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Installed archives and CPU fakes only. This command never builds packages or
// launches a browser; build Core, authoring and preview before invoking it.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'strata-preview-connection-consumer-'));
const guards = join(temporary, 'tool-guards');
const toolLog = join(temporary, 'unexpected-tool-invocation.log');
const env = {
  ...process.env, PATH: `${guards}${delimiter}${process.env.PATH ?? ''}`,
  STRATA_PREVIEW_TOOL_LOG: toolLog, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  PLAYWRIGHT_BROWSERS_PATH: join(temporary, 'uninstalled-browsers'),
};
delete env.STRATA_BENCHMARK_ASSET_DIR;
delete env.STRATA_PREVIEW_CORE_ARCHIVE;
delete env.STRATA_PREVIEW_CORE_SHA256;

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed (${error.status ?? error.code}):\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
}

async function pack(directory) {
  const name = `@strata-engine/${directory}`;
  const result = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], join(root, 'packages', directory)));
  const packed = Array.isArray(result) ? result.find(item => item.name === name) : result[name];
  assert.ok(packed, `npm pack did not report ${name}`);
  const files = new Set(packed.files.map(file => file.path));
  const required = ['dist/index.js', 'dist/index.d.ts', 'README.md'];
  if (directory === 'core') required.push('dist/worker.js', 'dist/strata_runtime.wasm');
  if (directory === 'preview') required.push('dist/connection.js', 'dist/connection.d.ts', 'dist/connection-bin.js');
  for (const file of required) assert.ok(files.has(file), `${name} is missing ${file}; build the packages first`);
  assert.equal([...files].some(file => /(?:^|\/)(?:src|tests|target|node_modules)\//.test(file)), false,
    'Consumers receive compiled files, without workspace source or toolchains');
  assert.equal([...files].some(file => (directory === 'core' ? /\.(?:rs|gltf|glb|zip)$/ : /\.(?:rs|wasm|wgsl|gltf|glb|zip)$/).test(file)), false,
    'Optional tools must not embed renderer assets or models; Core owns precompiled WASM');
  const archive = join(temporary, packed.filename);
  const manifest = JSON.parse(run('tar', ['-xOf', archive, 'package/package.json'], root));
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, '0.0.0');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(manifest.scripts?.[hook], undefined, `${name} must not build during installation`);
  }
  for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const forbidden = directory === 'preview' ? ['puppeteer', 'vite']
      : ['@strata-engine/authoring', '@strata-engine/preview', 'playwright', 'puppeteer', 'vite', ...(directory === 'authoring' ? ['@strata-engine/core'] : [])];
    for (const dependency of forbidden) assert.equal(manifest[kind]?.[dependency], undefined, `${name} must not require ${dependency}`);
    for (const version of Object.values(manifest[kind] ?? {})) assert.equal(/^(?:file:|link:|\/)/.test(version), false,
      'Distributable manifests must not contain local dependency paths');
  }
  if (directory === 'preview') {
    assert.equal(manifest.exports?.['./connection']?.import, './dist/connection.js');
    assert.equal(manifest.exports?.['./connection']?.types, './dist/connection.d.ts');
    assert.equal(manifest.bin?.['strata-preview-connection'], './dist/connection-bin.js');
    assert.equal(manifest.bin?.['strata-preview'], './dist/bin.js');
  }
  console.log(`${name} workspace archive SHA256: ${createHash('sha256').update(await readFile(archive)).digest('hex')}`);
  return archive;
}

try {
  await mkdir(guards);
  for (const command of ['cargo', 'rustc', 'rustup', 'wasm-pack', 'chromium', 'chromium-browser', 'google-chrome', 'playwright', 'firefox']) {
    const path = join(guards, command);
    await writeFile(path, '#!/bin/sh\nprintf "%s\\n" "$0" >> "$STRATA_PREVIEW_TOOL_LOG"\nexit 91\n');
    await chmod(path, 0o755);
  }
  const core = await pack('core');
  const authoring = await pack('authoring');
  const preview = await pack('preview');
  const consumer = join(temporary, 'consumer');
  await cp(join(root, 'tests', 'consumers', 'preview-connection'), consumer, { recursive: true });
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'strata-preview-connection-packed-consumer', private: true, type: 'module',
    dependencies: {
      '@strata-engine/core': `file:${core}`,
      '@strata-engine/authoring': `file:${authoring}`,
      '@strata-engine/preview': `file:${preview}`,
    },
  }, null, 2));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  for (const name of ['core', 'authoring', 'preview']) {
    assert.equal((await lstat(join(consumer, 'node_modules', '@strata-engine', name))).isSymbolicLink(), false,
      `${name} must resolve from its archive, without a workspace symlink`);
  }
  for (const dependency of ['puppeteer', 'vite']) {
    await assert.rejects(lstat(join(consumer, 'node_modules', dependency)), { code: 'ENOENT' });
  }
  const wasm = await readFile(join(consumer, 'node_modules', '@strata-engine', 'core', 'dist', 'strata_runtime.wasm'));
  assert.deepEqual(wasm.subarray(0, 8), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), 'Installed Core must ship compiled WASM');
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      lib: ['ES2022', 'DOM'], types: [], skipLibCheck: false, exactOptionalPropertyTypes: true,
    }, files: ['typecheck.ts'],
  }, null, 2));
  run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(consumer, 'tsconfig.json')], consumer);
  process.stdout.write(run(process.execPath, ['workflow.mjs'], consumer));
  await assert.rejects(readFile(toolLog, 'utf8'), { code: 'ENOENT' }, 'Packed connection invoked Rust or a browser');
  console.log('Packed connection: isolated declarations, CLI/stdio, rooted files, real session cancellation and native capture publication passed; CPU only, no browser/GPU proof');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
