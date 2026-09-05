import { describe, expect, it, vi } from 'vitest';
import { AuthoredBoxValidationError, validateAuthoredBoxScene, validateAuthoredFrameCamera, validateBoxCamera } from '../../packages/core/src/rendering/authored-box-validation.js';

function fixture() {
  return {
    format: 'strata.runtime-boxes', version: 1, coordinateSystem: 'strata-world-v1', sceneId: 'authored-test', sourceRevision: 'caller-revision',
    boxes: [{ id: 'box-1', dimensions: [1, 1, 1], transform: { position: [0, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      material: { baseColor: [0.7, 0.2, 0.1, 1], metallic: 0, roughness: 0 } }],
    camera: { position: [0, 0, 0], rotation: [0, 0, 0, 1], projection: { kind: 'perspective', verticalFovRadians: 55 * Math.PI / 180, near: 0.1, far: 32 } },
    light: { directionToLight: [0, 1, 0], radiance: [4, 3.8, 3.5] }, background: [0.02, 0.03, 0.05],
  };
}

function rejected(action: () => unknown, path: string, code = 'INVALID_OPTIONS') {
  expect(action).toThrowError(expect.objectContaining({ code, diagnostics: [{ path, reason: expect.any(String) }] }));
}

function deeplyFrozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(deeplyFrozen);
}

describe('authored box descriptor snapshots', () => {
  it('preserves binary64, accepted nonunit quaternions, roughness zero and exact caller correlation while owning every nested value', () => {
    const input = fixture();
    input.camera.position = [1_000_000, -1_000_000, 1_000_000];
    input.boxes[0]!.transform.position = [1_000_000 + 0.001, -1_000_000, 1_000_000 - 3];
    input.boxes[0]!.transform.rotation[3] = 1 + 5e-7;
    input.light.directionToLight[1] = 1 + 5e-7;
    input.background[0] = -0;
    input.sourceRevision = 'not-a-verified-hash 🧱';
    const result = validateAuthoredBoxScene(input);
    expect(result).toEqual(input);
    expect(result.boxes[0]!.transform.position[0]).toBe(1_000_000 + 0.001);
    expect(Math.fround(result.boxes[0]!.transform.position[0])).not.toBe(result.boxes[0]!.transform.position[0]);
    expect(result.boxes[0]!.transform.rotation[3]).toBe(1 + 5e-7);
    expect(result.light.directionToLight[1]).toBe(1 + 5e-7);
    expect(result.boxes[0]!.material.roughness).toBe(0);
    expect(Object.is(result.background[0], -0)).toBe(true);
    deeplyFrozen(result);
    input.boxes[0]!.transform.position[0] = 0;
    input.camera.projection.near = 5;
    input.boxes[0]!.material.baseColor[0] = 0;
    input.light.radiance[0] = 0;
    expect(result.boxes[0]!.transform.position[0]).toBe(1_000_000 + 0.001);
    expect(result.camera.projection.near).toBe(0.1);
    expect(result.boxes[0]!.material.baseColor[0]).toBe(0.7);
    expect(result.light.radiance[0]).toBe(4);
    const second = validateAuthoredBoxScene(result);
    expect(second).toEqual(result);
    expect(second.boxes[0]!.transform.position).not.toBe(result.boxes[0]!.transform.position);
  });

  it('accepts plain null-prototype records, empty scenes and null revisions', () => {
    const input = Object.assign(Object.create(null), fixture());
    input.camera = Object.assign(Object.create(null), input.camera);
    input.boxes = []; input.sourceRevision = null;
    const result = validateAuthoredBoxScene(input);
    expect(result.boxes).toEqual([]); expect(result.sourceRevision).toBeNull(); deeplyFrozen(result);
  });

  it('bounds box count, retains source order and independently copies shared input records', () => {
    const input = fixture(); const box = input.boxes[0]!;
    input.boxes = Array.from({ length: 1024 }, (_, index) => ({ ...box, id: `box-${index}` }));
    const result = validateAuthoredBoxScene(input);
    expect(result.boxes).toHaveLength(1024);
    expect(result.boxes[1023]!.id).toBe('box-1023');
    expect(result.boxes[0]!.transform).not.toBe(result.boxes[1]!.transform);
    input.boxes.push({ ...box, id: 'extra' });
    rejected(() => validateAuthoredBoxScene(input), '/boxes', 'UNSUPPORTED_LIMIT');
  });

  it('rejects duplicate/invalid IDs and bounds revision UTF-16 length without assuming hash syntax', () => {
    const input = fixture(); input.boxes.push({ ...input.boxes[0]! });
    rejected(() => validateAuthoredBoxScene(input), '/boxes/1/id');
    input.boxes.pop(); input.sceneId = 'trailing-newline\n';
    rejected(() => validateAuthoredBoxScene(input), '/sceneId');
    input.sceneId = 'a'.repeat(64); input.boxes[0]!.id = 'b'.repeat(64); input.sourceRevision = '🧱'.repeat(128);
    expect(validateAuthoredBoxScene(input).sourceRevision).toHaveLength(256);
    input.sourceRevision += 'x'; rejected(() => validateAuthoredBoxScene(input), '/sourceRevision');
    input.sourceRevision = ''; rejected(() => validateAuthoredBoxScene(input), '/sourceRevision');
    input.sourceRevision = 'valid'; input.boxes[0]!.id += 'b'; rejected(() => validateAuthoredBoxScene(input), '/boxes/0/id');
  });

  it.each(['format', 'version', 'coordinateSystem'] as const)('rejects unsupported %s instead of adapting it', field => {
    const input: Record<string, unknown> = fixture(); input[field] = field === 'version' ? 2 : 'unknown';
    rejected(() => validateAuthoredBoxScene(input), `/${field}`, 'UNSUPPORTED_FEATURE');
  });

  it('rejects wrongly typed versions and missing fields', () => {
    rejected(() => validateAuthoredBoxScene({ ...fixture(), version: '1' }), '/version');
    const input: Record<string, unknown> = fixture(); delete input.sourceRevision;
    rejected(() => validateAuthoredBoxScene(input), '/sourceRevision');
  });

  it.each(['assets', 'parent', 'shadows', 'gi', 'reflections', 'temporal'])('rejects unsupported %s data', field => {
    rejected(() => validateAuthoredBoxScene({ ...fixture(), [field]: false }), `/${field}`, 'UNSUPPORTED_FEATURE');
  });

  it('rejects per-box hierarchy, external URLs, matrices and textured materials', () => {
    for (const field of ['parent', 'uri', 'matrix']) {
      const input = fixture(); Object.assign(input.boxes[0]!, { [field]: 'external' });
      rejected(() => validateAuthoredBoxScene(input), `/boxes/0/${field}`, 'UNSUPPORTED_FEATURE');
    }
    const input = fixture(); Object.assign(input.boxes[0]!.material, { texture: 'https://asset.test/file.png' });
    rejected(() => validateAuthoredBoxScene(input), '/boxes/0/material/texture', 'UNSUPPORTED_FEATURE');
  });
});

describe('strict own JSON data ingress', () => {
  it('never invokes record or array accessors while rejecting them', () => {
    const get = vi.fn(() => fixture().camera); const input = fixture();
    Object.defineProperty(input, 'camera', { get, enumerable: true });
    rejected(() => validateAuthoredBoxScene(input), '/camera'); expect(get).not.toHaveBeenCalled();
    const second = fixture(); Object.defineProperty(second.boxes[0]!.dimensions, '0', { get, enumerable: true });
    rejected(() => validateAuthoredBoxScene(second), '/boxes/0/dimensions/0'); expect(get).not.toHaveBeenCalled();
  });

  it('rejects hidden/symbol properties, exotic prototypes, sparse arrays and array extras', () => {
    const hidden = fixture(); Object.defineProperty(hidden, 'sceneId', { value: 'hidden', enumerable: false });
    rejected(() => validateAuthoredBoxScene(hidden), '/sceneId');
    const symbol = fixture(); Object.assign(symbol, { [Symbol('extra')]: 1 }); rejected(() => validateAuthoredBoxScene(symbol), '');
    const inherited = Object.create(fixture()); rejected(() => validateAuthoredBoxScene(inherited), '');
    const sparse = fixture(); delete sparse.boxes[0]!.dimensions[1]; rejected(() => validateAuthoredBoxScene(sparse), '/boxes/0/dimensions');
    const extra = fixture(); Object.assign(extra.boxes, { extra: true }); rejected(() => validateAuthoredBoxScene(extra), '/boxes');
    const symbolicArray = fixture(); Object.assign(symbolicArray.background, { [Symbol('extra')]: 1 }); rejected(() => validateAuthoredBoxScene(symbolicArray), '/background');
  });

  it.each([undefined, NaN, Infinity, 1n, () => 1, new Number(1)])('rejects non-JSON numeric value %s', value => {
    const input = fixture(); (input.background as unknown[])[0] = value;
    rejected(() => validateAuthoredBoxScene(input), '/background/0');
  });

  it('rejects typed vectors, cyclic values and escaped unknown field names with bounded traversal', () => {
    const input = fixture(); Object.assign(input.camera, { position: new Float64Array([0, 0, 0]) });
    rejected(() => validateAuthoredBoxScene(input), '/camera/position');
    const cyclic = fixture(); Object.assign(cyclic.boxes[0]!.transform, { position: cyclic });
    rejected(() => validateAuthoredBoxScene(cyclic), '/boxes/0/transform/position');
    rejected(() => validateAuthoredBoxScene({ ...fixture(), 'a/b~c': 1 }), '/a~1b~0c', 'UNSUPPORTED_FEATURE');
  });

  it('provides frozen actionable diagnostics on a StrataError-compatible error', () => {
    try { validateAuthoredBoxScene(null); throw new Error('Expected rejection.'); }
    catch (error) {
      expect(error).toBeInstanceOf(AuthoredBoxValidationError);
      const failure = error as AuthoredBoxValidationError;
      expect(failure.code).toBe('INVALID_OPTIONS'); deeplyFrozen(failure.diagnostics);
    }
  });
});

describe('material, light and transform profile limits', () => {
  it('accepts material/light endpoints while preserving opaque roughness-zero data', () => {
    const input = fixture(); input.boxes[0]!.material = { baseColor: [0, 1, 0, 1], metallic: 1, roughness: 0 };
    input.light.radiance = [0, 64, 0]; input.background = [0, 1, 0];
    expect(validateAuthoredBoxScene(input)).toEqual(input);
    input.boxes[0]!.material.roughness = 1; expect(validateAuthoredBoxScene(input).boxes[0]!.material.roughness).toBe(1);
  });

  it('rejects transparency and invalid material/light values', () => {
    const alpha = fixture(); alpha.boxes[0]!.material.baseColor[3] = 0.9;
    rejected(() => validateAuthoredBoxScene(alpha), '/boxes/0/material/baseColor/3', 'UNSUPPORTED_FEATURE');
    const metallic = fixture(); metallic.boxes[0]!.material.metallic = 1.01; rejected(() => validateAuthoredBoxScene(metallic), '/boxes/0/material/metallic');
    const roughness = fixture(); roughness.boxes[0]!.material.roughness = -0.01; rejected(() => validateAuthoredBoxScene(roughness), '/boxes/0/material/roughness');
    const radiance = fixture(); radiance.light.radiance[0] = 65; rejected(() => validateAuthoredBoxScene(radiance), '/light/radiance/0');
    for (const direction of [[0, 0, 0], [0, 2, 0], [Infinity, 0, 0]]) {
      const input = fixture(); input.light.directionToLight = direction;
      rejected(() => validateAuthoredBoxScene(input), direction[0] === Infinity ? '/light/directionToLight/0' : '/light/directionToLight');
    }
  });

  it('checks effective lengths without restricting valid dimensions to unit-box sizes', () => {
    const input = fixture(); input.boxes[0]!.dimensions = [1, 1024, 128]; input.boxes[0]!.transform.scale = [1e-4, 1, 1e-6];
    expect(validateAuthoredBoxScene(input)).toEqual(input);
    input.boxes[0]!.dimensions[0] = 0.9;
    rejected(() => validateAuthoredBoxScene(input), '/boxes/0/dimensions/0', 'UNSUPPORTED_LIMIT');
    input.boxes[0]!.dimensions[0] = Number.MAX_VALUE;
    rejected(() => validateAuthoredBoxScene(input), '/boxes/0/dimensions/0', 'UNSUPPORTED_LIMIT');
    input.boxes[0]!.dimensions[0] = 1; input.boxes[0]!.transform.scale[0] = 0;
    rejected(() => validateAuthoredBoxScene(input), '/boxes/0/transform/scale/0');
  });

  it('rejects zero/negative dimensions and oversized source positions/quaternions', () => {
    for (const dimension of [0, -1]) {
      const input = fixture(); input.boxes[0]!.dimensions[0] = dimension;
      rejected(() => validateAuthoredBoxScene(input), '/boxes/0/dimensions/0');
    }
    const position = fixture(); position.boxes[0]!.transform.position[0] = 2 ** 30 + 1;
    rejected(() => validateAuthoredBoxScene(position), '/boxes/0/transform/position/0');
    const rotation = fixture(); rotation.boxes[0]!.transform.rotation = [0, 0, 0, 0];
    rejected(() => validateAuthoredBoxScene(rotation), '/boxes/0/transform/rotation');
  });

  it('normalizes only evaluation copies for rational independent rotated/nonuniform bounds', () => {
    // q=(0,0,3/5,4/5) gives Rz rows (7/25,-24/25,0),(24/25,7/25,0).
    // Full effective lengths (4,2,18) therefore give half extents (38/25,55/25,9).
    const input = fixture(); const box = input.boxes[0]!;
    box.dimensions = [2, 4, 6]; box.transform.scale = [2, 0.5, 3];
    box.transform.rotation = [0, 0, 0.6 * (1 + 5e-7), 0.8 * (1 + 5e-7)];
    const before = [...box.transform.rotation];
    for (const [axis, halfExtent] of [[0, 38 / 25], [1, 55 / 25], [2, 9]]) {
      box.transform.position = [0, 0, 0]; box.transform.position[axis!] = 4096 - halfExtent! - 0.01;
      expect(validateAuthoredBoxScene(input).boxes[0]!.transform.rotation).toEqual(before);
      box.transform.position[axis!] = box.transform.position[axis!]! + 0.02;
      rejected(() => validateAuthoredBoxScene(input), `/boxes/0/transform/position/${axis}`, 'UNSUPPORTED_LIMIT');
    }
    expect(box.transform.rotation).toEqual(before);
  });

  it('checks the complete box including at the exact extent boundary and translated global anchors', () => {
    for (const anchor of [0, 1_000_000, -1_000_000]) {
      const input = fixture(); input.camera.position = [anchor, anchor, anchor];
      input.boxes[0]!.dimensions = [2, 2, 2]; input.boxes[0]!.transform.position = [anchor + 4095, anchor, anchor];
      expect(validateAuthoredBoxScene(input)).toEqual(input);
      input.boxes[0]!.transform.position[0]! += 0.001;
      rejected(() => validateAuthoredBoxScene(input), '/boxes/0/transform/position/0', 'UNSUPPORTED_LIMIT');
    }
    const input = fixture(); input.camera.position = [2 ** 30, -(2 ** 30), 2 ** 30]; input.boxes[0]!.transform.position = [...input.camera.position];
    expect(validateAuthoredBoxScene(input)).toEqual(input);
  });
});

describe('camera and pre-upload frame validation', () => {
  it('copies/deep-freezes the camera, preserves accepted pose numbers and rejects implicit aspect or look-at forms', () => {
    const input = fixture().camera; input.rotation[3] = 1 + 5e-7;
    const result = validateBoxCamera(input); expect(result).toEqual(input); deeplyFrozen(result);
    input.position[0] = 100; expect(result.position[0]).toBe(0);
    rejected(() => validateBoxCamera({ ...input, target: [0, 0, 0] }), '/target', 'UNSUPPORTED_FEATURE');
    rejected(() => validateBoxCamera({ ...input, projection: { ...input.projection, aspect: 1 } }), '/projection/aspect', 'UNSUPPORTED_FEATURE');
  });

  it('accepts both FOV endpoints and bounded far/near ratios, and rejects unsupported lenses', () => {
    const camera = fixture().camera;
    for (const fov of [Math.PI / 180, 150 * Math.PI / 180]) {
      camera.projection.verticalFovRadians = fov; expect(validateBoxCamera(camera).projection.verticalFovRadians).toBe(fov);
    }
    camera.projection.near = 0.001; camera.projection.far = 100; expect(validateBoxCamera(camera)).toEqual(camera);
    camera.projection.far = 100.001; rejected(() => validateBoxCamera(camera), '/projection', 'UNSUPPORTED_LIMIT');
    camera.projection.near = 0.1; camera.projection.far = 4096; expect(validateBoxCamera(camera)).toEqual(camera);
    camera.projection.far = 4097; rejected(() => validateBoxCamera(camera), '/projection/far', 'UNSUPPORTED_LIMIT');
    camera.projection.far = 0.1; rejected(() => validateBoxCamera(camera), '/projection');
    camera.projection.far = 32; camera.projection.verticalFovRadians = 0.001;
    rejected(() => validateBoxCamera(camera), '/projection/verticalFovRadians', 'UNSUPPORTED_LIMIT');
    camera.projection.kind = 'orthographic'; rejected(() => validateBoxCamera(camera), '/projection/kind', 'UNSUPPORTED_FEATURE');
  });

  it('validates aspect and camera overrides against all boxes, returns the checked snapshot and changes no descriptor', () => {
    const input = fixture(); const scene = validateAuthoredBoxScene(input); const camera = fixture().camera;
    camera.position = [10, 2, 0];
    for (const [width, height] of [[64, 1], [1, 64], [1920, 1080]]) {
      const result = validateAuthoredFrameCamera(scene, camera, width!, height!);
      expect(result).toEqual(camera); expect(result).not.toBe(camera); deeplyFrozen(result);
    }
    rejected(() => validateAuthoredFrameCamera(scene, camera, 65, 1), '', 'UNSUPPORTED_LIMIT');
    rejected(() => validateAuthoredFrameCamera(scene, camera, 1, 65), '', 'UNSUPPORTED_LIMIT');
    for (const width of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      rejected(() => validateAuthoredFrameCamera(scene, camera, width, 1), '', 'INVALID_SIZE');
    }
    camera.position = [4096, 0, 0]; rejected(() => validateAuthoredFrameCamera(scene, camera, 512, 512), '/boxes/0/transform/position/0', 'UNSUPPORTED_LIMIT');
    expect(scene).toEqual(input);
  });

  it('does not trust a merely typed mutable descriptor, or previously caller-frozen input', () => {
    const input = fixture(); const scene = validateAuthoredBoxScene(input);
    const invalid = { ...scene, boxes: [{ ...scene.boxes[0]!, dimensions: [2048, 1, 1] as const }] };
    Object.freeze(invalid);
    rejected(() => validateAuthoredFrameCamera(invalid, scene.camera, 512, 512), '/boxes/0/dimensions/0', 'UNSUPPORTED_LIMIT');
    expect(validateAuthoredFrameCamera({ ...scene }, scene.camera, 512, 512)).toEqual(scene.camera);
  });
});
