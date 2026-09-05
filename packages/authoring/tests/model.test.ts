import { describe, expect, test } from 'vitest';
import {
  AuthoringError,
  MAX_SCALE,
  MIN_SCALE,
  WORLD_POSITION_LIMIT,
  createProceduralScene,
  createScene,
  type Diagnostic,
  type Result,
  type SceneDocument,
} from '../src/model.js';
import { canonicalJson, parseScene, serializeScene, validateScene } from '../src/schema.js';

function diagnostics<T>(result: Result<T>): Diagnostic[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected failed validation');
  for (const diagnostic of result.diagnostics) {
    expect(diagnostic.code).not.toBe('');
    expect(diagnostic.message).not.toBe('');
    expect(diagnostic.suggestion).not.toBe('');
    expect(diagnostic.path === '' || diagnostic.path.startsWith('/')).toBe(true);
  }
  return result.diagnostics;
}

describe('versioned scene documents', () => {
  test('creates valid empty and procedural documents without external files', () => {
    const empty = createScene('empty');
    expect(empty).toEqual({
      format: 'strata.scene', version: 1, id: 'empty', name: 'empty',
      coordinateSystem: 'strata-world-v1', assets: [], materials: [], entities: [],
    });
    expect(validateScene(empty)).toEqual({ ok: true, value: empty });
    expect(validateScene(createProceduralScene('fixture', 'Fixture')).ok).toBe(true);
  });

  test.each(['Invalid', '1box', 'box name', 'box\n', 'box/child', '', `a${'b'.repeat(64)}`])('rejects invalid stable ID %j', (id) => {
    expect(() => createScene(id)).toThrow(AuthoringError);
    const errors = diagnostics(validateScene({ ...createScene('valid'), id }));
    expect(errors).toContainEqual(expect.objectContaining({ code: 'INVALID_ID', path: '/id' }));
  });

  test('validates creator arguments at runtime', () => {
    expect(() => createScene(3 as unknown as string)).toThrow(AuthoringError);
    expect(() => createScene('demo', '')).toThrow(AuthoringError);
    expect(() => createScene('demo', 'a'.repeat(257))).toThrow(AuthoringError);
    expect(() => createProceduralScene('demo', null as unknown as string)).toThrow(AuthoringError);
    expect(validateScene(createScene('emoji-name', '🌍'.repeat(256))).ok).toBe(true);
  });

  test('rejects future versions and unsupported coordinate contracts', () => {
    const errors = diagnostics(validateScene({ ...createScene('demo'), version: 2, coordinateSystem: 'float32-world' }));
    expect(errors).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_VERSION', path: '/version' }));
    expect(errors).toContainEqual(expect.objectContaining({ path: '/coordinateSystem' }));
  });

  test('rejects unsupported hierarchy and renderer knobs with escaped pointers and IDs', () => {
    const scene = createProceduralScene();
    const input = {
      ...scene, camera: {},
      entities: [{ ...scene.entities[0]!, parentId: 'parent', 'future/option~x': true }],
    };
    const errors = diagnostics(validateScene(input));
    expect(errors).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_FIELD', path: '/camera' }));
    expect(errors).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_FIELD', path: '/entities/0/parentId', entityId: 'box-1' }));
    expect(errors).toContainEqual(expect.objectContaining({ path: '/entities/0/future~1option~0x', entityId: 'box-1' }));
  });

  test('reports missing fields at the field pointer', () => {
    const scene = createProceduralScene();
    const { assetId: _assetId, ...entity } = scene.entities[0]!;
    const errors = diagnostics(validateScene({ ...scene, entities: [entity] }));
    expect(errors).toContainEqual(expect.objectContaining({ code: 'REQUIRED_FIELD', path: '/entities/0/assetId', entityId: 'box-1' }));
  });

  test('rejects duplicate IDs within collections and permits the same ID in separate namespaces', () => {
    const scene = createProceduralScene();
    scene.assets.push({ ...scene.assets[0]! });
    scene.materials.push({ ...scene.materials[0]! });
    scene.entities.push(structuredClone(scene.entities[0]!));
    const errors = diagnostics(validateScene(scene));
    expect(errors.filter((item) => item.code === 'DUPLICATE_ID').map((item) => item.path)).toEqual([
      '/assets/1/id', '/materials/1/id', '/entities/1/id',
    ]);
    const shared = createProceduralScene();
    shared.entities[0]!.id = shared.assets[0]!.id;
    expect(validateScene(shared).ok).toBe(true);
  });

  test('reports missing asset/material references with both identities', () => {
    const scene = createProceduralScene();
    scene.assets = [];
    scene.materials = [];
    const errors = diagnostics(validateScene(scene));
    expect(errors).toEqual([
      expect.objectContaining({ code: 'MISSING_ASSET', path: '/entities/0/assetId', entityId: 'box-1', assetId: 'unit-box' }),
      expect.objectContaining({ code: 'MISSING_MATERIAL', path: '/entities/0/materialId', entityId: 'box-1', materialId: 'warm-stone' }),
    ]);
  });

  test('accepts external descriptors without accessing the referenced file', () => {
    const scene = createScene('external');
    scene.assets.push({ id: 'external-model', kind: 'external', uri: 'file:///does-not-exist/model.gltf', mediaType: 'model/gltf+json' });
    expect(validateScene(scene).ok).toBe(true);
    expect(parseScene(serializeScene(scene))).toEqual({ ok: true, value: scene });
  });

  test.each([
    { id: 'box', kind: 'procedural-box', size: [0, 1, 1] },
    { id: 'box', kind: 'procedural-box', size: [1, 1] },
    { id: 'box', kind: 'procedural-box', size: [1, 1, 1], uri: 'model.gltf' },
    { id: 'model', kind: 'external', uri: 'model.gltf' },
    { id: 'model', kind: 'external', uri: '   ', mediaType: 'model/gltf+json' },
    { id: 'model', kind: 'external', uri: 'model.gltf', mediaType: 'gltf' },
    { id: 'model', kind: 'external', uri: 'model.gltf', mediaType: 'model/gltf+json', size: [1, 1, 1] },
    { id: 'terrain', kind: 'imported-virtual-geometry' },
  ])('rejects unsupported or incomplete asset descriptor %j', (asset) => {
    const errors = diagnostics(validateScene({ ...createScene('demo'), assets: [asset] }));
    expect(errors[0]!.assetId).toBe(asset.id);
  });

  test.each([
    { baseColor: [0.7, 0.5, 0.3, 0.5] },
    { baseColor: [2, 0.5, 0.3, 1] },
    { metallic: -0.1 },
    { roughness: 1.1 },
    { kind: 'unlit' },
  ])('rejects unsupported material values %j', (change) => {
    const scene = createProceduralScene();
    const errors = diagnostics(validateScene({ ...scene, materials: [{ ...scene.materials[0], ...change }] }));
    expect(errors[0]!.materialId).toBe('warm-stone');
  });
});

describe('strata-world-v1 authoring boundary', () => {
  test('preserves large float64 positions and accepts agreed inclusive coordinate and scale limits', () => {
    const scene = createProceduralScene();
    const transform = scene.entities[0]!.transform;
    transform.position = [1_000_000.0001, -WORLD_POSITION_LIMIT, WORLD_POSITION_LIMIT];
    transform.scale = [MIN_SCALE, MAX_SCALE, 1];
    const reloaded = parseScene(serializeScene(scene));
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) throw new Error('Expected parsed scene');
    expect(reloaded.value.entities[0]!.transform).toEqual(transform);
    expect(reloaded.value.entities[0]!.transform.position[0]).not.toBe(Math.fround(transform.position[0]));
  });

  test.each([
    { position: [WORLD_POSITION_LIMIT + 1, 0, 0] },
    { position: [0, -WORLD_POSITION_LIMIT - 1, 0] },
    { position: [0, 0] },
    { position: ['0', 0, 0] },
    { rotation: [0, 0, 0] },
    { rotation: [0, 0, 0, 0] },
    { rotation: [0, 0, 0, 1.001] },
    { scale: [0, 1, 1] },
    { scale: [-1, 1, 1] },
    { scale: [MIN_SCALE / 2, 1, 1] },
    { scale: [1, MAX_SCALE + 1, 1] },
  ])('rejects invalid transform %j', (change) => {
    const scene = createProceduralScene();
    const entity = scene.entities[0]!;
    const errors = diagnostics(validateScene({ ...scene, entities: [{ ...entity, transform: { ...entity.transform, ...change } }] }));
    expect(errors[0]!.entityId).toBe(entity.id);
    expect(errors[0]!.path.startsWith('/entities/0/transform/')).toBe(true);
  });

  test('accepts near-unit quaternions within tolerance without silently changing values', () => {
    const scene = createProceduralScene();
    const quaternion: [number, number, number, number] = [0, 0, 0, 1 + 0.5e-6];
    scene.entities[0]!.transform.rotation = quaternion;
    expect(validateScene(scene).ok).toBe(true);
    const reloaded = parseScene(serializeScene(scene));
    expect(reloaded.ok && reloaded.value.entities[0]!.transform.rotation).toEqual(quaternion);
    expect(scene.entities[0]!.transform.rotation).toBe(quaternion);
  });

  test.each([NaN, Infinity, -Infinity])('rejects non-finite typed caller values %j before JSON can turn them into null', (number) => {
    const scene = createProceduralScene();
    scene.entities[0]!.transform.position[0] = number;
    const errors = diagnostics(validateScene(scene));
    expect(errors).toContainEqual(expect.objectContaining({ code: 'INVALID_JSON_VALUE', path: '/entities/0/transform/position/0', entityId: 'box-1' }));
    expect(() => serializeScene(scene)).toThrow(AuthoringError);
  });
});

describe('deterministic JSON and diagnostics', () => {
  test('sorts scene collections and keys, preserves values, and does not mutate caller order', () => {
    const scene = createProceduralScene();
    scene.entities.push({ ...structuredClone(scene.entities[0]!), id: 'aaa' });
    scene.assets.push({ id: 'aaa', kind: 'procedural-box', size: [3, 2, 1] });
    scene.materials.push({ ...structuredClone(scene.materials[0]!), id: 'aaa' });
    const original = structuredClone(scene);
    const reordered = {
      entities: [...scene.entities].reverse(), materials: [...scene.materials].reverse(),
      assets: [...scene.assets].reverse(), coordinateSystem: scene.coordinateSystem,
      name: scene.name, id: scene.id, version: scene.version, format: scene.format,
    };
    const serialized = serializeScene(scene);
    expect(serializeScene(reordered)).toBe(serialized);
    expect(scene).toEqual(original);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(serialized.endsWith('\n\n')).toBe(false);
    expect(serialized.startsWith('{\n  "assets": [')).toBe(true);
    const parsed = JSON.parse(serialized) as SceneDocument;
    expect(parsed.entities.map((entity) => entity.id)).toEqual(['aaa', 'box-1']);
    expect(parsed.assets.map((asset) => asset.id)).toEqual(['aaa', 'unit-box']);
    expect(parsed.materials.map((material) => material.id)).toEqual(['aaa', 'warm-stone']);
  });

  test('canonical JSON sorts numeric-looking object keys lexically and keeps arrays ordered', () => {
    expect(canonicalJson({ '2': 'two', '10': 'ten', z: [2, 1], a: -0 })).toBe(
      '{\n  "10": "ten",\n  "2": "two",\n  "a": 0,\n  "z": [\n    2,\n    1\n  ]\n}\n',
    );
  });

  test('canonical writer does not lose plain __proto__ data', () => {
    const input: unknown = JSON.parse('{"__proto__":{"z":1,"a":2},"ok":true}');
    expect(JSON.parse(canonicalJson(input))).toEqual(input);
  });

  test.each([
    { label: 'undefined', value: undefined },
    { label: 'bigint', value: 1n },
    { label: 'Date', value: new Date() },
    { label: 'undefined property', value: { value: undefined } },
    { label: 'sparse array', value: new Array(2) },
    { label: 'symbol value', value: { value: Symbol('x') } },
  ])('rejects non-JSON data: $label', ({ value }) => {
    expect(() => canonicalJson(value)).toThrow(AuthoringError);
  });

  test('rejects accessors without invoking them and handles circular input', () => {
    let getterCalled = false;
    const input = { get field(): string { getterCalled = true; return 'unsafe'; } };
    expect(() => canonicalJson(input)).toThrow(AuthoringError);
    expect(getterCalled).toBe(false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(AuthoringError);
    expect(diagnostics(validateScene(circular))[0]!.path).toBe('/self');
  });

  test('parses invalid JSON with source context and preserves useful parser locations when available', () => {
    const errors = diagnostics(parseScene('{\n  "format":', 'broken.scene.json'));
    expect(errors).toEqual([expect.objectContaining({
      code: 'INVALID_JSON', path: '', source: 'broken.scene.json', line: 2, column: 12,
    })]);
  });

  test('attaches source to semantic diagnostics and keeps JSON pointers as source locations', () => {
    const scene = createProceduralScene();
    scene.entities[0]!.assetId = 'missing';
    const errors = diagnostics(parseScene(JSON.stringify(scene), 'fixture.scene.json'));
    expect(errors).toContainEqual(expect.objectContaining({
      code: 'MISSING_ASSET', path: '/entities/0/assetId', source: 'fixture.scene.json', entityId: 'box-1', assetId: 'missing',
    }));
    expect(errors[0]!.line).toBeUndefined();
    expect(errors[0]!.column).toBeUndefined();
  });
});
