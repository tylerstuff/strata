import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  applySceneBatch, createProceduralScene, createScene, createSceneFile, editSceneFile,
  inspectScene, parseScene, previewSceneFile, readSceneFile, sceneRevision, serializeScene, validateScene,
} from '@strata-engine/authoring';

const cli = resolve('node_modules', '.bin', 'strata-scene');
const scenePath = resolve('scene.json');
const batchPath = resolve('batch.json');

function command(args, expectedExit = 0) {
  const result = spawnSync(cli, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  assert.equal(result.status, expectedExit, `${args.join(' ')}: ${result.stdout}\n${result.stderr}`);
  // Parsing the entire stream rejects extra result objects or mixed progress logs.
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, expectedExit === 0);
  if (!value.ok) {
    assert.ok(value.diagnostics.length > 0);
    for (const diagnostic of value.diagnostics) {
      assert.equal(typeof diagnostic.code, 'string');
      assert.equal(typeof diagnostic.path, 'string');
      assert.ok(diagnostic.message.length > 0);
      assert.ok(diagnostic.suggestion.length > 0);
    }
  }
  return value;
}

const makeBatch = (expectedRevision, operations) => ({ format: 'strata.scene-edit', version: 1, expectedRevision, operations });
const unwrap = result => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};

assert.equal(command(['--help']).capabilities.runtimeLoading, false);
assert.equal(command(['schema']).schemaName, 'scene');
assert.equal(command(['schema', 'batch']).schemaName, 'batch');
command(['create'], 2);
const created = command(['create', scenePath, '--id', 'consumer-demo', '--name', 'Packed consumer', '--fixture', 'boxes']);
assert.equal(created.sceneId, 'consumer-demo');
const initial = await readSceneFile(scenePath);
assert.equal(created.revision, initial.revision);
assert.equal(sceneRevision(initial.scene), initial.revision);
const originalBytes = await readFile(scenePath, 'utf8');
assert.equal(serializeScene(unwrap(parseScene(originalBytes, scenePath))), originalBytes);
assert.deepEqual(initial.scene, createProceduralScene('consumer-demo', 'Packed consumer'));
command(['create', scenePath, '--id', 'other-scene'], 4);
assert.equal(await readFile(scenePath, 'utf8'), originalBytes);

const entity = initial.scene.entities[0];
const material = initial.scene.materials.find(item => item.id === entity.materialId);
const movedEntity = { ...entity, transform: { ...entity.transform, position: [3.5, 2, -4] } };
const secondEntity = { ...entity, id: 'box-2', transform: { ...entity.transform, position: [-2, 0.5, 0] } };
const newMaterial = { ...material, baseColor: [0.2, 0.6, 0.9, 1], roughness: 0.35 };
const batch = makeBatch(initial.revision, [
  { op: 'set-entity', value: movedEntity }, { op: 'set-entity', value: secondEntity },
  { op: 'set-material', value: newMaterial },
]);
await writeFile(batchPath, JSON.stringify(batch));
const preview = await previewSceneFile(scenePath, batch);
const pure = unwrap(applySceneBatch(initial.scene, batch));
assert.equal(preview.revision, pure.revision);
const diff = command(['diff', scenePath, '--batch', batchPath]);
assert.equal(diff.baseRevision, initial.revision);
assert.equal(diff.revision, preview.revision);
assert.deepEqual(diff.changes, preview.changes);
assert.equal(diff.changed, true);
assert.ok(diff.changes.length > 0);
assert.equal(await readFile(scenePath, 'utf8'), originalBytes, 'Preview must not write');
const edited = command(['edit', scenePath, '--batch', batchPath]);
assert.equal(edited.revision, preview.revision);
let current = await readSceneFile(scenePath);
assert.deepEqual(current.scene, preview.scene);
assert.deepEqual(current.scene.entities.find(item => item.id === entity.id).transform.position, [3.5, 2, -4]);
assert.deepEqual(current.scene.materials.find(item => item.id === material.id).baseColor, [0.2, 0.6, 0.9, 1]);
const changedBytes = await readFile(scenePath, 'utf8');
assert.equal(command(['edit', scenePath, '--batch', batchPath], 4).diagnostics[0].code, 'SCENE_STALE');
assert.equal(await readFile(scenePath, 'utf8'), changedBytes, 'Stale edit must preserve file bytes');

for (const [flag, key, id] of [['entity', 'entityId', entity.id], ['asset', 'assetId', entity.assetId], ['material', 'materialId', entity.materialId]]) {
  assert.deepEqual(command(['inspect', scenePath, `--${flag}`, id]).inspection, unwrap(inspectScene(current.scene, { [key]: id })));
}
assert.deepEqual(command(['inspect', scenePath, '--limit', '1']).inspection, unwrap(inspectScene(current.scene, { limit: 1 })));
assert.deepEqual(command(['inspect', scenePath, '--limit', '1', '--after', entity.id]).inspection,
  unwrap(inspectScene(current.scene, { limit: 1, after: entity.id })));
command(['inspect', scenePath, '--entity', 'absent'], 3);
assert.equal(command(['validate', scenePath]).revision, current.revision);
command(['validate', scenePath, '--assets']);

const invalid = makeBatch(current.revision, [{ op: 'remove-material', id: material.id }]);
await writeFile(batchPath, JSON.stringify(invalid));
command(['diff', scenePath, '--batch', batchPath], 3);
command(['edit', scenePath, '--batch', batchPath], 3);
assert.equal(await readFile(scenePath, 'utf8'), changedBytes, 'An invalid final graph must preserve file bytes');
const repeat = await editSceneFile(scenePath, makeBatch(current.revision, batch.operations));
assert.equal(repeat.changed, false);
assert.equal(repeat.revision, current.revision);
assert.equal(await readFile(scenePath, 'utf8'), changedBytes);
assert.equal(repeat.scene.entities.length, 2, 'Repeating explicit sets must not create duplicates');

// Batch order may temporarily break references; the complete final graph must be valid.
const replacementMaterial = { ...newMaterial, id: 'replacement-material' };
await editSceneFile(scenePath, makeBatch(current.revision, [
  { op: 'remove-material', id: material.id },
  { op: 'set-material', value: replacementMaterial },
  ...current.scene.entities.map(value => ({ op: 'set-entity', value: { ...value, materialId: replacementMaterial.id } })),
]));
current = await readSceneFile(scenePath);
assert.equal(current.scene.materials.length, 1);
assert.ok(current.scene.entities.every(item => item.materialId === replacementMaterial.id));
assert.equal(validateScene(current.scene).ok, true);
assert.equal(serializeScene(current.scene), await readFile(scenePath, 'utf8'));

const unsupportedPath = resolve('unsupported.json');
await writeFile(unsupportedPath, JSON.stringify({ ...current.scene, camera: {} }));
const unsupported = command(['validate', unsupportedPath], 3);
const unsupportedSource = await realpath(unsupportedPath);
assert.ok(unsupported.diagnostics.some(item => item.code === 'UNSUPPORTED_FIELD' && item.path === '/camera' && item.source === unsupportedSource));
const malformedPath = resolve('malformed.json');
await writeFile(malformedPath, '{"format":');
assert.equal(command(['validate', malformedPath], 3).diagnostics[0].code, 'INVALID_JSON');
command(['validate', resolve('does-not-exist.json')], 5);

// A tiny local descriptor exercises missing-file diagnostics; no importer or renderer is implied.
const referencesPath = resolve('references.json');
await createSceneFile(referencesPath, {
  ...createScene('external-references'),
  assets: [{ id: 'local-mesh', kind: 'external', uri: 'tiny.gltf', mediaType: 'model/gltf+json' }],
});
command(['validate', referencesPath]);
const missing = command(['validate', referencesPath, '--assets'], 3);
assert.ok(missing.diagnostics.some(item => item.assetId === 'local-mesh'));
await writeFile(resolve('tiny.gltf'), '{"asset":{"version":"2.0"}}\n');
assert.equal(command(['validate', referencesPath, '--assets', '--asset-root', resolve('.')]).assets.checked, 1);

console.log('Authoring consumer: creation, schemas, inspection, serialization, preview, atomic batch edits, stale writes, recovery, and external-reference checks passed');
