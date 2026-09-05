import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBenchmarkServer } from './benchmark-server.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));

test('procedural server works without external assets or isolation headers', async () => {
  const server = await createBenchmarkServer({ assetRoot: '' });
  try {
    const response = await fetch(`${server.url}/benchmark-config.json`);
    assert.equal(response.headers.get('cross-origin-opener-policy'), null);
    assert.equal(response.headers.get('cross-origin-embedder-policy'), null);
    assert.deepEqual(await response.json(), { externalAssets: { available: false, catalogUrl: null } });
    assert.equal((await fetch(`${server.url}/README.md`)).status, 404);
    assert.equal((await fetch(`${server.url}/external-assets/catalog.json`)).status, 404);
    assert.equal((await fetch(`${server.url}/benchmark-config.json`, { method: 'POST' })).status, 405);
    const wrongHost = await new Promise((resolve, reject) => {
      const req = request(server.url, { headers: { Host: 'attacker.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(wrongHost, 403);
  } finally { await server.close(); }
});

test('external files are read in place with traversal and symlink containment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-benchmark-server-'));
  const assetRoot = join(directory, 'assets');
  await mkdir(assetRoot);
  await writeFile(join(assetRoot, 'catalog.json'), '{"assets":[]}');
  await writeFile(join(assetRoot, 'mesh.bin'), new Uint8Array([1, 2, 3, 4]));
  await writeFile(join(directory, 'private.txt'), 'private sentinel');
  await symlink(join(directory, 'private.txt'), join(assetRoot, 'escape.bin'));
  const oldCi = process.env.CI;
  delete process.env.CI;
  let server;
  try {
    server = await createBenchmarkServer({ assetRoot });
    const config = await (await fetch(`${server.url}/benchmark-config.json`)).text();
    assert.ok(!config.includes(directory));
    assert.deepEqual(JSON.parse(config), { externalAssets: { available: true, catalogUrl: '/external-assets/catalog.json' } });
    assert.deepEqual(await (await fetch(`${server.url}/external-assets/catalog.json`)).json(), { assets: [] });
    assert.deepEqual(new Uint8Array(await (await fetch(`${server.url}/external-assets/mesh.bin`)).arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
    const head = await fetch(`${server.url}/external-assets/mesh.bin`, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), '4');
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    for (const path of ['%2e%2e%2fprivate.txt', 'escape.bin', '%00', '..%5cprivate.txt', '%E0%A4%A', '../catalog.json']) {
      assert.equal((await fetch(`${server.url}/external-assets/${path}`)).status, 404, path);
    }
  } finally {
    await server?.close();
    if (oldCi === undefined) delete process.env.CI; else process.env.CI = oldCi;
    await rm(directory, { recursive: true, force: true });
  }
});

test('in-repository, symlinked in-repository, and CI asset roots are rejected', async () => {
  const oldCi = process.env.CI;
  const directory = await mkdtemp(join(tmpdir(), 'strata-benchmark-root-'));
  try {
    delete process.env.CI;
    await assert.rejects(createBenchmarkServer({ assetRoot: repository }), /outside the repository/);
    await symlink(repository, join(directory, 'repository'));
    await assert.rejects(createBenchmarkServer({ assetRoot: join(directory, 'repository') }), /outside the repository/);
    process.env.CI = 'true';
    await assert.rejects(createBenchmarkServer({ assetRoot: directory }), /local only/);
  } finally {
    if (oldCi === undefined) delete process.env.CI; else process.env.CI = oldCi;
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid listening ports fail before opening a server', async () => {
  for (const port of [-1, 65536, 1.5, NaN]) await assert.rejects(createBenchmarkServer({ port, assetRoot: '' }), /Port/);
});

test('CI procedural route serves only bounded generated fixture paths with symlink containment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-geometry-fixture-'));
  const root = join(directory, 'cooked');
  await mkdir(join(root, 'pages'), { recursive: true });
  const manifest = { format: 'strata-geometry', version: 1, pageBytes: 65536,
    source: { kind: 'analytic-heightfield-v1' },
    pages: [0, 1].map(id => ({ id, url: `pages/${String(id).padStart(6, '0')}.bin`, byteLength: 65536 })) };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'pages/000000.bin'), new Uint8Array(65536));
  await writeFile(join(root, 'private.txt'), 'must not be served');
  await writeFile(join(directory, 'outside.bin'), new Uint8Array(65536));
  await symlink(join(directory, 'outside.bin'), join(root, 'pages/000001.bin'));
  const oldCi = process.env.CI;
  let server;
  try {
    process.env.CI = 'true';
    server = await createBenchmarkServer({ assetRoot: '', proceduralRoot: root });
    assert.deepEqual(await (await fetch(`${server.url}/procedural-assets/manifest.json`)).json(), manifest);
    assert.equal((await fetch(`${server.url}/procedural-assets/pages/000000.bin`)).status, 200);
    for (const path of ['private.txt', 'pages/000001.bin', 'pages/000002.bin', '%2e%2e%2foutside.bin']) {
      assert.equal((await fetch(`${server.url}/procedural-assets/${path}`)).status, 404, path);
    }
    await assert.rejects(createBenchmarkServer({ assetRoot: root, proceduralRoot: root }), /local only/);
    await assert.rejects(createBenchmarkServer({ assetRoot: '', proceduralRoot: tmpdir() }), /dedicated temporary/);
    await assert.rejects(createBenchmarkServer({ assetRoot: '', proceduralRoot: repository }), /dedicated temporary/);
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...manifest, source: { kind: 'external-model' } }));
    await assert.rejects(createBenchmarkServer({ assetRoot: '', proceduralRoot: root }), /Only small generated/);
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...manifest, pages: [{ id: 0, url: '../outside.bin', byteLength: 65536 }] }));
    await assert.rejects(createBenchmarkServer({ assetRoot: '', proceduralRoot: root }), /canonical bounded/);
  } finally {
    await server?.close();
    if (oldCi === undefined) delete process.env.CI; else process.env.CI = oldCi;
    await rm(directory, { recursive: true, force: true });
  }
});

test('automation refuses CI and explicit software GPU performance runs before browser startup', () => {
  const runner = fileURLToPath(new URL('./run-benchmark.mjs', import.meta.url));
  for (const [environment, message] of [
    [{ CI: 'true', STRATA_TEST_SOFTWARE_GPU: '0' }, /CI can run --smoke only/],
    [{ CI: '', STRATA_TEST_SOFTWARE_GPU: '1' }, /Software GPU execution is restricted/],
  ]) {
    const child = spawnSync(process.execPath, [runner], { env: { ...process.env, ...environment }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 1);
    assert.match(child.stderr, message);
  }
});
