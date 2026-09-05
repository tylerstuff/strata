import { describe, expect, it } from 'vitest';
import {
  applySceneBatch, createProceduralScene, createScene, inspectScene, parseBatch, sceneRevision,
  serializeScene, validateBatch, type Result, type SceneBatch, type SceneOperation,
} from '../src/index.js';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
}

function batch(scene = createProceduralScene(), operations: SceneOperation[] = []): SceneBatch {
  return { format: 'strata.scene-edit', version: 1, expectedRevision: sceneRevision(scene), operations };
}

describe('typed scene transactions', () => {
  it('uses the same semantic revision across object and collection ordering', () => {
    const scene = createProceduralScene();
    scene.entities.push({ ...structuredClone(scene.entities[0]!), id: 'another-box' });
    const reversed = structuredClone({ ...scene, entities: [...scene.entities].reverse() });
    expect(sceneRevision(scene)).toBe(sceneRevision(reversed));
    reversed.entities[0]!.transform.position[0] = 1000000.0001;
    expect(sceneRevision(scene)).not.toBe(sceneRevision(reversed));
  });

  it('creates references in any batch order and produces deterministic final changes', () => {
    const scene = createScene('new-scene');
    const fixture = createProceduralScene();
    const result = unwrap(applySceneBatch(scene, batch(scene, [
      { op: 'set-entity', value: fixture.entities[0]! },
      { op: 'set-material', value: fixture.materials[0]! },
      { op: 'set-asset', value: fixture.assets[0]! },
    ])));
    expect(result.changed).toBe(true);
    expect(result.changes.map(change => [change.collection, change.id, change.before])).toEqual([
      ['assets', 'unit-box', null], ['materials', 'warm-stone', null], ['entities', 'box-1', null],
    ]);
    expect(scene.entities).toEqual([]);
    expect(result.revision).toBe(sceneRevision(result.scene));
  });

  it('sets replace by stable ID, no-op repeated sets do not change revision, and no input aliases escape', () => {
    const scene = createProceduralScene();
    const entity = structuredClone(scene.entities[0]!);
    entity.transform.position[0] = 1000000.0001;
    const edit = batch(scene, [{ op: 'set-entity', value: entity }]);
    const result = unwrap(applySceneBatch(scene, edit));
    expect(result.scene.entities).toHaveLength(1);
    expect(scene.entities[0]!.transform.position[0]).toBe(0);
    const before = result.changes[0]!.before;
    if (before && 'transform' in before) before.transform.position[0] = -99;
    expect(scene.entities[0]!.transform.position[0]).toBe(0);
    const repeated = unwrap(applySceneBatch(result.scene, batch(result.scene, edit.operations)));
    expect(repeated.changed).toBe(false);
    expect(repeated.revision).toBe(result.revision);
    result.scene.entities[0]!.transform.position[0] = 0;
    expect(entity.transform.position[0]).toBe(1000000.0001);
  });

  it('rejects a dangling reference without changing the input, but accepts combined removal', () => {
    const scene = createProceduralScene();
    const original = serializeScene(scene);
    const removal: SceneOperation[] = [{ op: 'remove-asset', id: 'unit-box' }];
    const invalid = applySceneBatch(scene, batch(scene, removal));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.diagnostics).toContainEqual(expect.objectContaining({ entityId: 'box-1' }));
    expect(serializeScene(scene)).toBe(original);
    const result = unwrap(applySceneBatch(scene, batch(scene, [
      ...removal, { op: 'remove-entity', id: 'box-1' }, { op: 'remove-material', id: 'warm-stone' },
    ])));
    expect(result.scene.assets).toEqual([]);
    expect(result.scene.entities).toEqual([]);
  });

  it('rejects stale snapshots, unknown operations/fields and newline IDs/revisions', () => {
    const scene = createProceduralScene();
    const edit = batch(scene);
    edit.expectedRevision = `sha256:${'0'.repeat(64)}`;
    const result = applySceneBatch(scene, edit);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]!.code).toBe('SCENE_STALE');
    expect(validateBatch({ ...batch(scene), operations: [{ op: 'move', id: 'box-1' }] }).ok).toBe(false);
    expect(validateBatch({ ...batch(scene), extra: true }).ok).toBe(false);
    expect(validateBatch({ ...batch(scene), expectedRevision: `${sceneRevision(scene)}\n` }).ok).toBe(false);
    expect(validateBatch(batch(scene, [{ op: 'remove-entity', id: 'box-1\n' }])).ok).toBe(false);
    expect(validateBatch({ ...batch(scene), operations: [{ op: 'remove-entity', id: 'box-1', value: null }] }).ok).toBe(false);
    for (const operation of [null, 7, {}, { op: 'unknown' }, { op: 'set-entity' }, { op: 'remove-asset' },
      { op: 'set-asset', value: { id: 'x', kind: 'external' } }]) {
      const malformed = validateBatch({ ...batch(scene), operations: [operation] });
      expect(malformed.ok).toBe(false);
      if (!malformed.ok) expect(malformed.diagnostics.length).toBeGreaterThan(0);
    }
    const parse = parseBatch('{broken', 'edit.json');
    expect(parse.ok).toBe(false);
    if (!parse.ok) expect(parse.diagnostics[0]).toMatchObject({ source: 'edit.json', code: 'INVALID_JSON' });
  });
});

describe('bounded inspection', () => {
  it('pages lexically by stable ID and returns selected asset, material, or entity without dumping the scene', () => {
    const scene = createProceduralScene();
    scene.entities.push({ ...structuredClone(scene.entities[0]!), id: 'aaa' });
    const first = unwrap(inspectScene(scene, { limit: 1 }));
    expect(first.entities.map(entity => entity.id)).toEqual(['aaa']);
    expect(first.nextCursor).toBe('aaa');
    const second = unwrap(inspectScene(scene, { limit: 1, after: first.nextCursor! }));
    expect(second.entities.map(entity => entity.id)).toEqual(['box-1']);
    expect(second.nextCursor).toBe(null);
    for (const query of [{ entityId: 'box-1' }, { assetId: 'unit-box' }, { materialId: 'warm-stone' }]) {
      const selected = unwrap(inspectScene(scene, query));
      expect(selected.selection).not.toBe(null);
      expect(selected.entities).toEqual([]);
      expect(selected.counts).toEqual({ entities: 2, assets: 1, materials: 1 });
    }
    expect(inspectScene(scene, { limit: 1001 }).ok).toBe(false);
    expect(inspectScene(scene, { after: 'missing' }).ok).toBe(false);
    expect(inspectScene(scene, { entityId: 'missing' }).ok).toBe(false);
    expect(inspectScene(scene, { entityId: 'box-1', assetId: 'unit-box' }).ok).toBe(false);
    expect(inspectScene(scene, { entityId: 'box-1', limit: 1 }).ok).toBe(false);
    for (const malformed of [{ limit: null }, new Date(), Object.create({ entityId: 'box-1' })]) {
      expect(inspectScene(scene, malformed as Parameters<typeof inspectScene>[1]).ok).toBe(false);
    }
  });
});
