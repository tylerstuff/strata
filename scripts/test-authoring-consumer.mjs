import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'strata-authoring-consumer-'));
const rustLog = join(temporary, 'unexpected-rust-invocation.log');
const guards = join(temporary, 'tool-guards');
const env = { ...process.env, PATH: `${guards}${delimiter}${process.env.PATH ?? ''}`, STRATA_AUTHORING_RUST_LOG: rustLog };
// A caller's private benchmark collection must never affect this procedural test.
delete env.STRATA_BENCHMARK_ASSET_DIR;

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed (${error.status ?? error.code}):\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
}

try {
  await mkdir(guards);
  for (const command of ['cargo', 'rustc', 'rustup', 'wasm-pack']) {
    const path = join(guards, command);
    await writeFile(path, '#!/bin/sh\nprintf "%s\\n" "$0" >> "$STRATA_AUTHORING_RUST_LOG"\nexit 91\n');
    await chmod(path, 0o755);
  }
  const packResult = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], join(root, 'packages', 'authoring')));
  // npm versions return either an array or a workspace-name keyed object.
  const packed = Array.isArray(packResult) ? packResult.find(item => item.name === '@strata-engine/authoring')
    : packResult['@strata-engine/authoring'];
  assert.ok(packed, 'npm pack did not report the authoring package');
  const files = new Set(packed.files.map(file => file.path));
  for (const required of ['dist/index.js', 'dist/index.d.ts', 'dist/bin.js', 'README.md']) {
    assert.ok(files.has(required), `Packed authoring package is missing ${required}; run npm run build:authoring first`);
  }
  assert.equal([...files].some(file => /(?:^|\/)(?:src|tests|target|node_modules)\//.test(file)), false,
    'The packed package must contain its distribution, not contributor sources or toolchains');
  assert.equal([...files].some(file => /\.(?:rs|wasm|wgsl|gltf|glb|zip)$/.test(file)), false,
    'Standalone authoring must not package renderers, Rust sources, or external models');
  const archive = join(temporary, packed.filename);
  const manifest = JSON.parse(run('tar', ['-xOf', archive, 'package/package.json'], root));
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(manifest.scripts?.[hook], undefined, `Authoring consumers must not need a ${hook} build`);
  }
  for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(manifest[kind]?.['@strata-engine/core'], undefined, 'Authoring must be independently installable');
  }
  assert.equal(manifest.bin?.['strata-scene'], './dist/bin.js');
  const runtime = JSON.parse(await readFile(join(root, 'packages', 'core', 'package.json'), 'utf8'));
  for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(runtime[kind]?.['@strata-engine/authoring'], undefined, 'Runtime consumers must not install authoring');
  }

  const consumer = join(temporary, 'consumer');
  await cp(join(root, 'tests', 'consumers', 'authoring'), consumer, { recursive: true });
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'strata-authoring-packed-consumer', private: true, type: 'module',
    dependencies: { '@strata-engine/authoring': `file:${archive}` },
  }, null, 2));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  assert.equal((await lstat(join(consumer, 'node_modules', '@strata-engine', 'authoring'))).isSymbolicLink(), false,
    'Consumer must resolve an installed archive, not the workspace package');
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      lib: ['ES2022'], types: [], skipLibCheck: false,
    },
    files: ['typecheck.ts'],
  }, null, 2));
  run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(consumer, 'tsconfig.json')], consumer);
  process.stdout.write(run(process.execPath, ['workflow.mjs'], consumer));
  await assert.rejects(readFile(rustLog, 'utf8'), { code: 'ENOENT' }, 'Consumer installation or execution invoked a Rust tool');
  console.log('Packed authoring: isolated archive, TypeScript declarations, CLI/API workflow, and installation without build hooks or Rust passed');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
