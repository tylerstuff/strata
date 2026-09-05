import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBenchmarkServer } from './benchmark-server.mjs';
import { createGalleryFixture } from './gallery-fixture.mjs';

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

test('gallery catalog exposes bounded metadata and contained recommended entries without copying files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-gallery-catalog-'));
  const assetRoot = join(directory, 'assets');
  await mkdir(join(assetRoot, 'model with spaces'), { recursive: true });
  await writeFile(join(assetRoot, 'model with spaces/scene.gltf'), '{"asset":{"version":"2.0"}}');
  await writeFile(join(directory, 'private.gltf'), 'private sentinel');
  await symlink(join(directory, 'private.gltf'), join(assetRoot, 'escape.gltf'));
  const model = {
    id: 'test-model', title: 'A <model>', recommended_gltf: 'model with spaces/scene.gltf',
    source_url: 'https://example.com/model', license_url: 'https://creativecommons.org/licenses/by/4.0/',
    archive_author_credit: 'Author', license: 'CC-BY-4.0', recommended_gltf_sha256: 'a'.repeat(64),
    recommended_counts: { triangles_stored_mesh_primitives_once: 12, meshes: 1, skins: 0, animations: 0 },
    recommended_texture_dimensions: ['2048x1024'], recommended_extensions_used: ['KHR_materials_emissive_strength'],
    alpha_modes: ['OPAQUE'], caveats: ['Static test fixture.'],
  };
  await writeFile(join(assetRoot, 'catalog.json'), JSON.stringify({ assets: [model,
    { ...model, id: 'escape', recommended_gltf: 'escape.gltf', source_url: 'javascript:alert(1)', license_url: 'https://user:pass@example.com/' },
    { ...model, id: 'traversal', recommended_gltf: '../private.gltf' },
    { ...model, id: 'missing', recommended_gltf: 'missing.gltf' },
    { ...model, id: 'remote', recommended_gltf: 'https://example.com/scene.gltf' },
    { ...model, id: 'test-model' }, { ...model, id: '../invalid' },
  ] }));
  const oldCi = process.env.CI;
  delete process.env.CI;
  let server;
  try {
    server = await createBenchmarkServer({ assetRoot });
    const response = await fetch(`${server.url}/api/gallery/catalog`);
    const body = await response.text();
    assert.ok(!body.includes(directory));
    assert.ok(!body.includes('private sentinel'));
    const catalog = JSON.parse(body);
    assert.equal(catalog.format, 'strata.gallery.catalog');
    assert.equal(catalog.version, 1);
    assert.equal(catalog.available, true);
    assert.equal(catalog.assets.length, 5);
    assert.equal(catalog.diagnostics.length, 2);
    const first = catalog.assets[0];
    assert.equal(first.entryUrl, '/external-assets/model%20with%20spaces/scene.gltf');
    assert.equal(first.sourceSha256, 'a'.repeat(64));
    assert.equal(first.title, 'A <model>');
    assert.equal(first.triangles, 12);
    assert.equal(first.meshCount, 1);
    assert.equal(first.textureMaxEdge, 2048);
    assert.deepEqual(first.features, { requiredExtensions: [], usedExtensions: ['KHR_materials_emissive_strength'],
      alphaModes: ['OPAQUE'], skins: 0, animations: 0, morphTargets: 0 });
    assert.equal((await fetch(`${server.url}${first.entryUrl}`)).status, 200);
    for (const entry of catalog.assets.slice(1)) {
      assert.equal(entry.entryUrl, null);
      assert.ok(entry.unavailableReason);
    }
    assert.equal(catalog.assets[1].sourceUrl, null);
    assert.equal(catalog.assets[1].licenseUrl, null);
    const head = await fetch(`${server.url}/api/gallery/catalog`, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(body)));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(`${server.url}/api/gallery/catalog`, { method: 'POST' })).status, 405);
    for (const path of ['main.ts', 'catalog.ts', 'state.ts', '../README.md']) {
      assert.equal((await fetch(`${server.url}/gallery/${path}`)).status, 404);
    }
    await writeFile(join(assetRoot, 'catalog.json'), '{');
    const invalid = await (await fetch(`${server.url}/api/gallery/catalog`)).json();
    assert.equal(invalid.available, false);
    assert.deepEqual(invalid.assets, []);
    assert.equal(invalid.diagnostics.length, 1);
    assert.ok(!JSON.stringify(invalid).includes(directory));
  } finally {
    await server?.close();
    if (oldCi === undefined) delete process.env.CI; else process.env.CI = oldCi;
    await rm(directory, { recursive: true, force: true });
  }
});

test('gallery without a configured collection reports an actionable empty state', async () => {
  const server = await createBenchmarkServer({ assetRoot: '' });
  try {
    const result = await (await fetch(`${server.url}/api/gallery/catalog`)).json();
    assert.equal(result.available, false);
    assert.deepEqual(result.assets, []);
    assert.match(result.diagnostics[0], /STRATA_BENCHMARK_ASSET_DIR/);
  } finally { await server.close(); }
});

test('CI gallery route serves only the bounded temporary generated fixture', async () => {
  const fixture = await createGalleryFixture();
  const outside = await mkdtemp(join(tmpdir(), 'strata-gallery-outside-'));
  const oldCi = process.env.CI;
  let server;
  try {
    process.env.CI = 'true';
    server = await createBenchmarkServer({ assetRoot: '', galleryFixtureRoot: fixture.directory });
    const catalog = await (await fetch(`${server.url}/api/gallery/catalog`)).json();
    assert.equal(catalog.available, true);
    assert.deepEqual(catalog.assets.map(asset => asset.id), ['fixture-red', 'fixture-green']);
    assert.deepEqual(catalog.assets.map(asset => asset.entryUrl), ['/procedural-gallery-assets/red.gltf', '/procedural-gallery-assets/green.gltf']);
    for (const name of ['red.gltf', 'green.gltf', 'scene.bin']) {
      assert.equal((await fetch(`${server.url}/procedural-gallery-assets/${name}`)).status, 200);
    }
    for (const name of ['fixture.json', 'catalog.json', 'private.txt', '%2e%2e%2fprivate.txt']) {
      assert.equal((await fetch(`${server.url}/procedural-gallery-assets/${name}`)).status, 404);
    }
    assert.deepEqual(await (await fetch(`${server.url}/benchmark-config.json`)).json(), { externalAssets: { available: false, catalogUrl: null } });
    await assert.rejects(createBenchmarkServer({ assetRoot: fixture.directory, galleryFixtureRoot: fixture.directory }), /cannot be combined/);
    await assert.rejects(createBenchmarkServer({ assetRoot: '', galleryFixtureRoot: tmpdir() }), /dedicated temporary/);
    await assert.rejects(createBenchmarkServer({ assetRoot: '', galleryFixtureRoot: repository }), /dedicated temporary/);
    await writeFile(join(outside, 'private.bin'), 'must not be served');
    await rm(join(fixture.directory, 'scene.bin'));
    await symlink(join(outside, 'private.bin'), join(fixture.directory, 'scene.bin'));
    assert.equal((await fetch(`${server.url}/procedural-gallery-assets/scene.bin`)).status, 404);
    await assert.rejects(createBenchmarkServer({ assetRoot: '', galleryFixtureRoot: fixture.directory }), /contained/);
    await writeFile(join(fixture.directory, 'fixture.json'), JSON.stringify({ format: 'strata-gallery-fixture', version: 1,
      source: { kind: 'external-model' }, files: [] }));
    await assert.rejects(createBenchmarkServer({ assetRoot: '', galleryFixtureRoot: fixture.directory }), /Only the small generated/);
  } finally {
    await server?.close();
    if (oldCi === undefined) delete process.env.CI; else process.env.CI = oldCi;
    await fixture.dispose();
    await rm(outside, { recursive: true, force: true });
  }
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
