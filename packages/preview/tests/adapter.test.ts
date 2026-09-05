import { describe, expect, it } from 'vitest';
import { createProceduralScene, createScene, sceneRevision, type SceneDocument } from '@strata-engine/authoring';
import { validateAuthoredBoxScene, type BoxSceneDescriptor } from '@strata-engine/core';
import { prepareAuthoredPreviewLoad, type AuthoredPreviewLoadInput, type AuthoredPreviewViewInput } from '../src/adapter.js';

function view(): AuthoredPreviewViewInput {
  return {
    camera: { position: [0, 1, 3], rotation: [0, 0, 0, 1], projection: { kind: 'perspective', verticalFovRadians: Math.PI / 3, near: 0.1, far: 100 } },
    light: { directionToLight: [0, 1, 0], radiance: [2, 2, 2] },
    background: [0.05, 0.1, 0.15],
  };
}

function input(scene = createProceduralScene('adapter-scene')): AuthoredPreviewLoadInput {
  return { scene, revision: sceneRevision(scene), view: view() };
}

describe('authoring to Core box adapter', () => {
  it('lowers verified references to the exported Core descriptor and resolves only explicit profile defaults', () => {
    const source = input();
    const before = structuredClone(source);
    const result = prepareAuthoredPreviewLoad(source);
    const descriptor: BoxSceneDescriptor = result.scene;
    expect(descriptor).toEqual({
      format: 'strata.runtime-boxes', version: 1, coordinateSystem: 'strata-world-v1',
      sceneId: source.scene.id, sourceRevision: source.revision,
      boxes: [{
        id: 'box-1', dimensions: [1, 1, 1], transform: source.scene.entities[0]!.transform,
        material: { baseColor: [0.7, 0.5, 0.3, 1], metallic: 0, roughness: 0.8 },
      }],
      camera: source.view.camera, light: source.view.light, background: source.view.background,
    });
    expect(result.view).toEqual({ ...source.view, debugView: 'final', timeSeconds: 0, temporal: false });
    expect(result.sceneId).toBe(source.scene.id);
    expect(result.sourceRevision).toBe(source.revision);
    expect(validateAuthoredBoxScene(descriptor)).toEqual(descriptor);
    expect(source).toEqual(before);
  });

  it('preserves entity order, IDs and actual asset/material references independently of registry order', () => {
    const source = input();
    source.scene.assets.unshift({ id: 'second-asset', kind: 'procedural-box', size: [3, 2, 1] });
    source.scene.materials.unshift({ id: 'second-material', kind: 'pbr', baseColor: [0.1, 0.2, 0.3, 1], metallic: 0.75, roughness: 0 });
    source.scene.entities[0]!.id = 'z-entity';
    source.scene.entities.push({
      ...structuredClone(source.scene.entities[0]!), id: 'a-entity', assetId: 'second-asset', materialId: 'second-material',
    });
    source.revision = sceneRevision(source.scene);
    const { scene } = prepareAuthoredPreviewLoad(source);
    expect(scene.boxes.map(box => box.id)).toEqual(['z-entity', 'a-entity']);
    expect(scene.boxes.map(box => box.dimensions)).toEqual([[1, 1, 1], [3, 2, 1]]);
    expect(scene.boxes[1]!.material).toEqual({ baseColor: [0.1, 0.2, 0.3, 1], metallic: 0.75, roughness: 0 });
    expect(source.scene.entities.map(entity => entity.id)).toEqual(['z-entity', 'a-entity']);
  });

  it('preserves binary64 global coordinates, full quaternion, nonuniform scale and signed zero without normalization', () => {
    const source = input();
    const entity = source.scene.entities[0]!;
    entity.transform = {
      position: [1_000_000.000125, -0, -1_000_000.00025],
      rotation: [0.2, 0.3, 0.4, Math.sqrt(0.71)], scale: [2, 0.5, 3],
    };
    source.scene.assets[0] = { id: 'unit-box', kind: 'procedural-box', size: [1.125, 2.25, 0.75] };
    source.view.camera = { ...source.view.camera, position: [1_000_000, 1, -999_997] };
    source.revision = sceneRevision(source.scene);
    const result = prepareAuthoredPreviewLoad(source);
    expect(result.scene.boxes[0]!.transform).toEqual(entity.transform);
    expect(result.scene.boxes[0]!.dimensions).toEqual([1.125, 2.25, 0.75]);
    expect(Object.is(result.scene.boxes[0]!.transform.position[1], -0)).toBe(true);
    expect(result.scene.boxes[0]!.transform.position[0]).not.toBe(Math.fround(entity.transform.position[0]));
    expect(result.scene.camera.position).toEqual(source.view.camera.position);
  });

  it('returns detached frozen Core/view snapshots before the caller can change the source', () => {
    const source = input();
    const result = prepareAuthoredPreviewLoad(source);
    source.scene.entities[0]!.transform.position[0] = 5;
    source.scene.materials[0]!.baseColor[0] = 1;
    source.view.camera = { ...source.view.camera, position: [0, 0, 9] };
    expect(result.scene.boxes[0]!.transform.position[0]).toBe(0);
    expect(result.scene.boxes[0]!.material.baseColor[0]).toBe(0.7);
    expect(result.view.camera.position).toEqual([0, 1, 3]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.scene.boxes[0]!.transform.position)).toBe(true);
    expect(Object.isFrozen(result.view)).toBe(true);
  });

  it('accepts an empty document as an empty Core scene without adding a floor or implicit object', () => {
    const source = input(createScene('empty-preview'));
    expect(prepareAuthoredPreviewLoad(source).scene.boxes).toEqual([]);
  });

  it('rejects missing/stale source revision with canonical identity evidence', () => {
    const source = input();
    expect(() => prepareAuthoredPreviewLoad({ ...source, revision: 'stale' })).toThrowError(expect.objectContaining({
      code: 'PREVIEW_SOURCE_REVISION_MISMATCH', details: expect.objectContaining({ expectedRevision: 'stale', actualRevision: source.revision }),
    }));
    const { revision: _revision, ...missing } = source;
    expect(() => prepareAuthoredPreviewLoad(missing)).toThrowError(expect.objectContaining({ code: 'PREVIEW_INVALID_OPTIONS' }));
    source.scene.entities[0]!.transform.position[0] = 3;
    expect(() => prepareAuthoredPreviewLoad(source)).toThrowError(expect.objectContaining({ code: 'PREVIEW_SOURCE_REVISION_MISMATCH' }));
  });

  it.each(['assetId', 'materialId'] as const)('rejects missing %s references before lowering', key => {
    const source = input();
    source.scene.entities[0]![key] = 'missing';
    expect(() => prepareAuthoredPreviewLoad(source)).toThrowError(expect.objectContaining({
      code: 'PREVIEW_INVALID_OPTIONS', details: expect.objectContaining({ diagnostics: expect.arrayContaining([
        expect.objectContaining({ path: `/scene/entities/0/${key}`, entityId: 'box-1' }),
      ]) }),
    }));
  });

  it.each([false, true])('rejects every external descriptor, including unused=%s', unused => {
    const scene = createProceduralScene();
    scene.assets.push({ id: 'external', kind: 'external', uri: 'external.glb', mediaType: 'model/gltf-binary' });
    if (!unused) scene.entities[0]!.assetId = 'external';
    expect(() => prepareAuthoredPreviewLoad(input(scene))).toThrowError(expect.objectContaining({
      code: 'PREVIEW_UNSUPPORTED_ASSET', details: expect.objectContaining({ assetId: 'external' }),
    }));
  });

  it.each(['camera', 'light', 'background'] as const)('requires explicit view.%s', field => {
    const source = input();
    const incomplete = { ...source.view } as Record<string, unknown>;
    delete incomplete[field];
    expect(() => prepareAuthoredPreviewLoad({ ...source, view: incomplete })).toThrowError(expect.objectContaining({
      code: 'PREVIEW_INVALID_OPTIONS', details: { diagnostics: [{ path: `/view/${field}`, reason: 'Required preview field is missing.' }] },
    }));
  });

  it.each([
    { temporal: true }, { debugView: 'normals' }, { gi: {} }, { reflections: {} }, { cameraCut: true }, { shadows: true },
  ])('rejects unsupported view controls %j', extra => {
    const source = input();
    expect(() => prepareAuthoredPreviewLoad({ ...source, view: { ...source.view, ...extra } })).toThrowError(expect.objectContaining({ code: 'PREVIEW_UNSUPPORTED_FEATURE' }));
  });

  it('accepts explicit supported settings and finite fixed time without implicit animation', () => {
    const source = input();
    const result = prepareAuthoredPreviewLoad({ ...source, view: { ...source.view, debugView: 'base-color', timeSeconds: -2.5, temporal: false } });
    expect(result.view).toMatchObject({ debugView: 'base-color', timeSeconds: -2.5, temporal: false });
    expect(result.scene.boxes[0]!.transform).toEqual(source.scene.entities[0]!.transform);
  });

  it('rejects non-JSON input without invoking getters or coercing objects', () => {
    let read = false;
    const source = input();
    const getter = { ...source, get view() { read = true; return view(); } };
    expect(() => prepareAuthoredPreviewLoad(getter)).toThrowError(expect.objectContaining({ code: 'PREVIEW_INVALID_OPTIONS' }));
    expect(read).toBe(false);
    expect(() => prepareAuthoredPreviewLoad({ ...source, view: { ...source.view, timeSeconds: Infinity } })).toThrowError(expect.objectContaining({ code: 'PREVIEW_INVALID_OPTIONS' }));
    expect(() => prepareAuthoredPreviewLoad({ ...source, ignored: true })).toThrowError(expect.objectContaining({ code: 'PREVIEW_UNSUPPORTED_FEATURE' }));
  });

  it.each(['geometry-size', 'local-range', 'camera-lens', 'light', 'count'] as const)('delegates unsupported %s profile limits to Core validation', kind => {
    const source = input();
    if (kind === 'geometry-size') source.scene.entities[0]!.transform.scale[0] = 2048;
    if (kind === 'local-range') source.scene.entities[0]!.transform.position[0] = 5000;
    if (kind === 'camera-lens') source.view.camera = { ...source.view.camera, projection: { ...source.view.camera.projection, far: 5000 } };
    if (kind === 'light') source.view.light = { ...source.view.light, radiance: [65, 1, 1] };
    if (kind === 'count') source.scene.entities = Array.from({ length: 1025 }, (_, index) => ({ ...structuredClone(source.scene.entities[0]!), id: `box-${index}` }));
    source.revision = sceneRevision(source.scene);
    expect(() => prepareAuthoredPreviewLoad(source)).toThrowError(expect.objectContaining({
      code: 'PREVIEW_RUNTIME_VALIDATION_FAILED', details: expect.objectContaining({ coreCode: expect.any(String), diagnostics: expect.any(Array) }),
    }));
  });
});
