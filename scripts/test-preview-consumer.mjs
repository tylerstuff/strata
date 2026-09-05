import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'strata-preview-consumer-'));
const toolLog = join(temporary, 'unexpected-tool-invocation.log');
const guards = join(temporary, 'tool-guards');
const env = {
  ...process.env, PATH: `${guards}${delimiter}${process.env.PATH ?? ''}`, STRATA_PREVIEW_TOOL_LOG: toolLog,
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', PLAYWRIGHT_BROWSERS_PATH: join(temporary, 'uninstalled-browsers'),
};
delete env.STRATA_BENCHMARK_ASSET_DIR;

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed (${error.status ?? error.code}):\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
}

async function pack(name, directory) {
  const result = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], join(root, 'packages', directory)));
  const packed = Array.isArray(result) ? result.find(item => item.name === name) : result[name];
  assert.ok(packed, `npm pack did not report ${name}`);
  const files = new Set(packed.files.map(file => file.path));
  for (const required of ['dist/index.js', 'dist/index.d.ts', 'README.md', ...(name === '@strata-engine/preview' ? ['dist/bin.js'] : [])]) {
    assert.ok(files.has(required), `${name} is missing ${required}; build the authoring and preview packages first`);
  }
  assert.equal([...files].some(file => /(?:^|\/)(?:src|tests|target|node_modules)\//.test(file)), false,
    `${name} must ship compiled distribution files, not workspace sources or toolchains`);
  assert.equal([...files].some(file => (name === '@strata-engine/core' ? /\.(?:rs|gltf|glb|zip)$/ : /\.(?:rs|wasm|wgsl|gltf|glb|zip)$/).test(file)), false,
    'Optional tools must not embed renderers, Rust sources, or imported models; Core ships precompiled WASM');
  const archive = join(temporary, packed.filename);
  verifyManifest(archive, name);
  return archive;
}

function verifyManifest(archive, name) {
  const manifest = JSON.parse(run('tar', ['-xOf', archive, 'package/package.json'], root));
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, '0.0.0');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(manifest.scripts?.[hook], undefined, `${name} consumers must not run a ${hook} build`);
  }
  for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const forbidden = name === '@strata-engine/preview' ? ['puppeteer', 'vite']
      : ['@strata-engine/authoring', '@strata-engine/preview', 'playwright', 'puppeteer', 'vite', ...(name === '@strata-engine/authoring' ? ['@strata-engine/core'] : [])];
    for (const dependency of forbidden) {
      assert.equal(manifest[kind]?.[dependency], undefined, `${name} must not require ${dependency}`);
    }
    for (const version of Object.values(manifest[kind] ?? {})) {
      assert.equal(/^(?:file:|link:|\/)/.test(version), false, 'Published manifests must not retain local checkpoint paths');
    }
  }
  if (name === '@strata-engine/preview') {
    assert.equal(manifest.dependencies?.['@strata-engine/core'], '0.0.0');
    assert.equal(manifest.dependencies?.playwright, '1.63.0');
    assert.equal(manifest.bin?.['strata-preview'], './dist/bin.js');
  }
  return manifest;
}

async function coreArchive() {
  let archive;
  if (process.env.STRATA_PREVIEW_CORE_ARCHIVE) {
    // Snapshot the supplied bytes before hashing/installing so reported identity matches consumption.
    const bytes = await readFile(resolve(process.env.STRATA_PREVIEW_CORE_ARCHIVE));
    archive = join(temporary, 'verified-core-checkpoint.tgz');
    await writeFile(archive, bytes);
    verifyManifest(archive, '@strata-engine/core');
  } else archive = await pack('@strata-engine/core', 'core');
  const bytes = await readFile(archive);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (process.env.STRATA_PREVIEW_CORE_SHA256) {
    assert.equal(sha256, process.env.STRATA_PREVIEW_CORE_SHA256.toLowerCase(), 'Core archive SHA256 does not match the supplied checkpoint');
  }
  const contents = run('tar', ['-tf', archive], root).split('\n');
  for (const required of ['package/dist/index.js', 'package/dist/index.d.ts', 'package/dist/worker.js', 'package/dist/strata_runtime.wasm']) {
    assert.ok(contents.includes(required), `Core archive is missing ${required}; build merged Core or supply a verified checkpoint`);
  }
  console.log(`Core archive SHA256: ${sha256} (${process.env.STRATA_PREVIEW_CORE_ARCHIVE ? 'external checkpoint' : 'workspace package'})`);
  return archive;
}

try {
  await mkdir(guards);
  for (const command of ['cargo', 'rustc', 'rustup', 'wasm-pack', 'chromium', 'chromium-browser', 'google-chrome', 'playwright', 'firefox']) {
    const path = join(guards, command);
    await writeFile(path, '#!/bin/sh\nprintf "%s\\n" "$0" >> "$STRATA_PREVIEW_TOOL_LOG"\nexit 91\n');
    await chmod(path, 0o755);
  }
  const authoringArchive = await pack('@strata-engine/authoring', 'authoring');
  const previewArchive = await pack('@strata-engine/preview', 'preview');
  const runtimeArchive = await coreArchive();
  const runtime = JSON.parse(await readFile(join(root, 'packages', 'core', 'package.json'), 'utf8'));
  for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const dependency of ['@strata-engine/authoring', '@strata-engine/preview']) {
      assert.equal(runtime[kind]?.[dependency], undefined, 'Ordinary runtime consumers must not install optional authoring/preview tools');
    }
  }

  const consumer = join(temporary, 'consumer');
  await cp(join(root, 'tests', 'consumers', 'preview'), consumer, { recursive: true });
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'strata-preview-packed-consumer', private: true, type: 'module',
    dependencies: {
      '@strata-engine/authoring': `file:${authoringArchive}`,
      '@strata-engine/preview': `file:${previewArchive}`,
      '@strata-engine/core': `file:${runtimeArchive}`,
    },
  }, null, 2));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  for (const name of ['authoring', 'preview', 'core']) {
    assert.equal((await lstat(join(consumer, 'node_modules', '@strata-engine', name))).isSymbolicLink(), false,
      `Consumer ${name} must resolve its packed archive, not a workspace symlink`);
  }
  for (const dependency of ['puppeteer']) {
    await assert.rejects(lstat(join(consumer, 'node_modules', dependency)), { code: 'ENOENT' }, `${dependency} must not be installed for this CPU fixture`);
  }
  const wasm = await readFile(join(consumer, 'node_modules', '@strata-engine', 'core', 'dist', 'strata_runtime.wasm'));
  assert.deepEqual(wasm.subarray(0, 8), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), 'Installed Core must contain its precompiled WASM module');
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      lib: ['ES2022', 'DOM'], types: [], skipLibCheck: false,
    },
    files: ['typecheck.ts'],
  }, null, 2));
  run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(consumer, 'tsconfig.json')], consumer);
  process.stdout.write(run(process.execPath, ['workflow.mjs'], consumer));
  await assert.rejects(readFile(toolLog, 'utf8'), { code: 'ENOENT' }, 'Packed consumer invoked a Rust tool or browser');
  console.log('Packed preview: isolated archives, public declarations, fake-driver orchestration and real artifact publication passed; no browser/GPU validation');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
