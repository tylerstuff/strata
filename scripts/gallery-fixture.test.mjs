import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGalleryFixture } from './gallery-fixture.mjs';

const fixtureModule = fileURLToPath(new URL('./gallery-fixture.mjs', import.meta.url));
const repository = fileURLToPath(new URL('../', import.meta.url));
const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const approximate = (actual, expected, epsilon = 1e-6) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= epsilon, `${actual} != ${expected}`));
};

function decode(model, binary, index) {
  const accessor = model.accessors[index];
  const view = model.bufferViews[accessor.bufferView];
  const width = components[accessor.type];
  const bytes = accessor.componentType === 5123 ? 2 : 4;
  assert.ok([5123, 5126].includes(accessor.componentType));
  assert.equal(view.buffer, 0);
  assert.equal(view.byteOffset % 4, 0);
  const start = view.byteOffset + accessor.byteOffset;
  const length = accessor.count * width * bytes;
  assert.ok(start >= view.byteOffset && start + length <= view.byteOffset + view.byteLength);
  assert.ok(view.byteOffset + view.byteLength <= binary.length);
  return Array.from({ length: accessor.count }, (_, element) => Array.from({ length: width }, (_, component) => {
    const offset = start + (element * width + component) * bytes;
    return bytes === 2 ? binary.readUInt16LE(offset) : binary.readFloatLE(offset);
  }));
}

test('fixture identities, resource ranges, catalog, colors, and manifest are bounded and deterministic', async () => {
  const first = await createGalleryFixture();
  const second = await createGalleryFixture();
  try {
    assert.notEqual(first.directory, second.directory);
    const location = relative(repository, first.directory);
    assert.ok(location.startsWith('..') || isAbsolute(location));
    const names = ['catalog.json', 'fixture.json', 'green.gltf', 'red.gltf', 'scene.bin'];
    assert.deepEqual((await fs.readdir(first.directory)).sort(), names);
    let total = 0;
    for (const name of names) {
      const bytes = await fs.readFile(join(first.directory, name));
      total += bytes.length;
      assert.deepEqual(bytes, await fs.readFile(join(second.directory, name)), name);
    }
    assert.ok(total <= 64 * 1024);
    const manifest = JSON.parse(await fs.readFile(join(first.directory, 'fixture.json'), 'utf8'));
    assert.equal(manifest.format, 'strata-gallery-fixture');
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.source, { kind: 'procedural-box-skin-v1' });
    assert.deepEqual(manifest.files.map(file => file.path), ['red.gltf', 'green.gltf', 'scene.bin', 'catalog.json']);
    for (const file of manifest.files) assert.equal(file.byteLength, (await fs.stat(join(first.directory, file.path))).size);
    const catalog = JSON.parse(await fs.readFile(join(first.directory, 'catalog.json'), 'utf8'));
    assert.deepEqual(catalog.assets.map(asset => asset.id), ['fixture-red', 'fixture-green']);
    const models = await Promise.all(['red.gltf', 'green.gltf'].map(async name => JSON.parse(await fs.readFile(join(first.directory, name), 'utf8'))));
    const binary = await fs.readFile(join(first.directory, 'scene.bin'));
    for (const [index, model] of models.entries()) {
      assert.equal(model.asset.version, '2.0');
      assert.deepEqual(model.buffers, [{ uri: 'scene.bin', byteLength: binary.length }]);
      for (let accessor = 0; accessor < model.accessors.length; accessor++) decode(model, binary, accessor);
      assert.equal(model.materials[0].alphaMode, 'OPAQUE');
      assert.equal(model.materials[0].pbrMetallicRoughness.metallicFactor, 0);
      assert.ok(model.materials[0].pbrMetallicRoughness.roughnessFactor > 0);
      assert.equal(model.images, undefined);
      assert.equal(model.textures, undefined);
      const asset = catalog.assets[index];
      assert.equal(asset.source_url, null);
      assert.equal(asset.license, null);
      assert.equal(asset.license_url, null);
      assert.equal(asset.source.generated, true);
      assert.equal(asset.recommended_gltf, index ? 'green.gltf' : 'red.gltf');
      assert.deepEqual(asset.recommended_counts, { triangles_stored_mesh_primitives_once: 12, meshes: 1, skins: 1, animations: 1, morph_target_entries_across_primitives: 0 });
      assert.deepEqual(asset.alpha_modes, ['OPAQUE']);
    }
    assert.deepEqual(models[0].meshes, models[1].meshes);
    assert.deepEqual(models[0].accessors, models[1].accessors);
    assert.deepEqual(models[0].skins, models[1].skins);
    assert.deepEqual(models[0].animations, models[1].animations);
    const red = models[0].materials[0].pbrMetallicRoughness.baseColorFactor;
    const green = models[1].materials[0].pbrMetallicRoughness.baseColorFactor;
    assert.ok(red[0] > 0.7 && red[1] < 0.2 && green[1] > 0.7 && green[0] < 0.2);
    assert.equal(red[3], 1);
    assert.equal(green[3], 1);
  } finally { await Promise.all([first.dispose(), second.dispose()]); }
  await Promise.all([first.dispose(), first.dispose(), second.dispose()]);
  await assert.rejects(fs.stat(first.directory), { code: 'ENOENT' });
  await assert.rejects(fs.stat(second.directory), { code: 'ENOENT' });
});

test('cube topology, normals, UVs, inverse binds, and LINEAR skin deformation have the intended semantics', async () => {
  const fixture = await createGalleryFixture();
  try {
    const model = JSON.parse(await fs.readFile(join(fixture.directory, 'red.gltf'), 'utf8'));
    const binary = await fs.readFile(join(fixture.directory, 'scene.bin'));
    const primitive = model.meshes[0].primitives[0];
    const readAttribute = name => decode(model, binary, primitive.attributes[name]);
    const positions = readAttribute('POSITION'), normals = readAttribute('NORMAL'), uvs = readAttribute('TEXCOORD_0');
    const joints = readAttribute('JOINTS_0'), weights = readAttribute('WEIGHTS_0');
    const indices = decode(model, binary, primitive.indices).flat();
    assert.equal(positions.length, 24);
    assert.equal(indices.length, 36);
    assert.equal(primitive.mode, 4);
    assert.equal(model.accessors[primitive.indices].componentType, 5123);
    assert.equal(model.accessors[primitive.attributes.JOINTS_0].componentType, 5123);
    assert.equal(model.accessors[primitive.attributes.JOINTS_0].type, 'VEC4');
    assert.equal(model.accessors[primitive.attributes.WEIGHTS_0].componentType, 5126);
    for (const position of positions) assert.ok(position.every(value => Math.abs(value) === 0.5));
    for (const normal of normals) approximate([Math.hypot(...normal)], [1]);
    for (const uv of uvs) assert.ok(uv.every(value => value >= 0 && value <= 1));
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      const ids = indices.slice(triangle, triangle + 3);
      assert.equal(new Set(ids).size, 3);
      assert.ok(ids.every(index => index >= 0 && index < positions.length));
      const [a, b, c] = ids.map(index => positions[index]);
      const ab = b.map((value, axis) => value - a[axis]), ac = c.map((value, axis) => value - a[axis]);
      const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      approximate(cross, normals[ids[0]]);
    }
    assert.deepEqual(model.scenes[model.scene].nodes, [0, 1]);
    assert.deepEqual(model.nodes[0].children, [2]);
    assert.equal(model.nodes[1].mesh, 0);
    assert.equal(model.nodes[1].skin, 0);
    assert.deepEqual(model.nodes[2].children, [3]);
    for (const node of model.nodes) {
      assert.deepEqual(node.rotation, [0, 0, 0, 1]);
      assert.deepEqual(node.scale, [1, 1, 1]);
    }
    for (const index of [0, 1, 2]) assert.deepEqual(model.nodes[index].translation, [0, 0, 0]);
    const skin = model.skins[0];
    assert.deepEqual(skin.joints, [2, 3]);
    assert.equal(skin.skeleton, 2);
    const binds = decode(model, binary, skin.inverseBindMatrices);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    approximate(binds[0], identity);
    approximate(binds[1].map((value, index) => index === 13 ? value + model.nodes[3].translation[1] : value), identity);
    const animation = model.animations[0];
    assert.equal(model.animations.length, 1);
    assert.equal(animation.name, 'Shift');
    assert.deepEqual(animation.channels, [{ sampler: 0, target: { node: 3, path: 'translation' } }]);
    const sampler = animation.samplers[0];
    assert.equal(sampler.interpolation, 'LINEAR');
    const times = decode(model, binary, sampler.input).flat(), translations = decode(model, binary, sampler.output);
    assert.deepEqual(times, [0, 0.5, 1]);
    approximate(translations[0], model.nodes[3].translation);
    approximate(translations[2], model.nodes[3].translation);
    const deform = time => {
      const interval = time <= times[1] ? 0 : 1;
      const mix = (time - times[interval]) / (times[interval + 1] - times[interval]);
      const translation = translations[interval].map((value, axis) => value * (1 - mix) + translations[interval + 1][axis] * mix);
      return positions.map((position, index) => {
        assert.ok(joints[index].every(joint => joint >= 0 && joint < skin.joints.length));
        approximate([weights[index].reduce((sum, weight) => sum + weight, 0)], [1]);
        return position.map((value, axis) => weights[index].reduce((sum, weight, influence) => {
          const joint = joints[index][influence];
          const jointTranslation = joint === 1 ? translation[axis] : 0;
          return sum + weight * (value + binds[joint][12 + axis] + jointTranslation);
        }, 0));
      });
    };
    const rest = deform(0), middle = deform(0.5), end = deform(1), quarter = deform(0.25);
    let moving = 0;
    for (let vertex = 0; vertex < positions.length; vertex++) {
      approximate(rest[vertex], positions[vertex]);
      approximate(end[vertex], positions[vertex]);
      if (positions[vertex][1] > 0) {
        moving++;
        approximate(middle[vertex], positions[vertex].map((value, axis) => value + [0.6, 0.3, 0][axis]));
        approximate(quarter[vertex], positions[vertex].map((value, axis) => value + [0.3, 0.15, 0][axis]));
      } else approximate(middle[vertex], positions[vertex]);
    }
    assert.equal(moving, 12);
  } finally { await fixture.dispose(); }
});

test('creation removes a partially written directory when a write fails', async () => {
  const mkdtemp = fs.mkdtemp, writeFile = fs.writeFile;
  let created;
  const temporaryMock = mock.method(fs, 'mkdtemp', async (...args) => created = await mkdtemp(...args));
  const writeMock = mock.method(fs, 'writeFile', async (path, ...args) => {
    if (path.endsWith('green.gltf')) throw new Error('fixture write failure');
    return writeFile(path, ...args);
  });
  try { await assert.rejects(createGalleryFixture(), /fixture write failure/); }
  finally { temporaryMock.mock.restore(); writeMock.mock.restore(); }
  assert.ok(created);
  await assert.rejects(fs.stat(created), { code: 'ENOENT' });
});

test('generation runs with filesystem reads denied outside its module and temporary directory', async () => {
  const temporaryRoot = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'strata-gallery-permissions-')));
  try {
    const child = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${fixtureModule}`, `--allow-fs-read=${temporaryRoot}`,
      `--allow-fs-write=${temporaryRoot}`, '--input-type=module', '--eval',
      `const {createGalleryFixture}=await import(${JSON.stringify(new URL('./gallery-fixture.mjs', import.meta.url).href)}); const fixture=await createGalleryFixture(); await fixture.dispose(); console.log('generated without asset reads');`],
    { encoding: 'utf8', timeout: 10_000, cwd: temporaryRoot,
      env: { ...process.env, TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot,
        STRATA_BENCHMARK_ASSET_DIR: join(repository, 'external-assets-must-not-be-read') } });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /generated without asset reads/);
    assert.deepEqual(await fs.readdir(temporaryRoot), []);
  } finally { await fs.rm(temporaryRoot, { recursive: true, force: true }); }
});
