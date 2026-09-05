import { describe, expect, it } from 'vitest';
import { createImportedPoseEvaluator, sampleImportedChannel } from '../../packages/core/src/imported/imported-animation.js';
import type { ImportedAnimationChannel, ImportedAsset, ImportedNode } from '../../packages/core/src/imported/imported-types.js';

const node = (parent: number | null = null, translation: readonly [number, number, number] = [0, 0, 0]): ImportedNode =>
  ({ parent, translation, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
function channel(path: ImportedAnimationChannel['path'], interpolation: ImportedAnimationChannel['interpolation'], times: number[], values: number[]): ImportedAnimationChannel {
  return { node: 1, path, interpolation, times: new Float32Array(times), values: new Float32Array(values) };
}
function asset(channels: ImportedAnimationChannel[] = []): ImportedAsset {
  const inverseBind = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, 0, 0, 1]);
  return {
    version: 1, sourceUrl: 'https://fixtures.test/rig.gltf', primitives: [], materials: [], images: [],
    sourceBounds: { min: [10, 0, 0], max: [14, 4, 4] }, bounds: { min: [0, 0, 0], max: [2, 2, 2] },
    normalization: { scale: 0.5, translation: [-5, 0, 0] }, maxTextureDimension: 2048, warnings: [],
    stats: { meshInstances: 0, primitives: 0, vertices: 0, triangles: 0, materials: 0, images: 0,
      encodedBytes: 0, geometryBytes: 0, skinnedMeshInstances: 0, animationClips: 1 },
    // The mesh node has a deliberately unrelated transform. A skin follows joints, not this node.
    rig: { nodes: [node(null, [10, 0, 0]), node(0, [2, 0, 0]), node(null, [100, 0, 0])],
      skins: [{ joints: [1], inverseBindMatrices: inverseBind }] },
    clips: [{ id: 'walk', name: 'Walk', duration: 4, channels }],
  };
}
function sample(input: ImportedAnimationChannel, time: number): number[] {
  const output = new Float64Array(input.path === 'rotation' ? 4 : 3);
  sampleImportedChannel(input, time, output); return [...output];
}

describe('imported animation interpolation', () => {
  it('clamps each channel independently and uses the exact next key in STEP mode', () => {
    const linear = channel('translation', 'LINEAR', [1, 3], [2, 4, 6, 6, 12, 18]);
    expect(sample(linear, 0)).toEqual([2, 4, 6]);
    expect(sample(linear, 2)).toEqual([4, 8, 12]);
    expect(sample(linear, 4)).toEqual([6, 12, 18]);
    expect(sample({ ...linear, interpolation: 'STEP' }, 2.999)).toEqual([2, 4, 6]);
    expect(sample({ ...linear, interpolation: 'STEP' }, 3)).toEqual([6, 12, 18]);
  });
  it('interpolates quaternions along the short arc, including opposite-sign representations', () => {
    const half = Math.SQRT1_2;
    const rotation = channel('rotation', 'LINEAR', [0, 4], [0, 0, 0, 1, 0, 0, -half, -half]);
    const actual = sample(rotation, 2);
    expect(actual[2]).toBeCloseTo(Math.sin(Math.PI / 8), 6);
    expect(actual[3]).toBeCloseTo(Math.cos(Math.PI / 8), 6);
    expect(Math.hypot(...actual)).toBeCloseTo(1, 12);
    const antipodes = channel('rotation', 'LINEAR', [0, 1], [0, 0, 0, 1, 0, 0, 0, -1]);
    expect(sample(antipodes, 0.5)).toEqual([0, 0, 0, 1]);
  });
  it('scales cubic tangents by a non-unit segment duration and normalizes cubic rotations', () => {
    // p0=0,p1=4,outTangent0=2,inTangent1=0 over two seconds gives midpoint 2.5.
    const cubic = channel('translation', 'CUBICSPLINE', [1, 3], [
      0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0,
    ]);
    expect(sample(cubic, 2)).toEqual([2.5, 0, 0]);
    expect(sample(cubic, 3)).toEqual([4, 0, 0]);
    const quaternion = channel('rotation', 'CUBICSPLINE', [0, 2], [
      0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0,
    ]);
    expect(sample(quaternion, 1)[2]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(sample(quaternion, 1)[3]).toBeCloseTo(Math.SQRT1_2, 12);
  });
  it('normalizes accepted near-unit endpoints before computing the rotation arc', () => {
    const nearUnit = channel('rotation', 'LINEAR', [0, 4], [0, 0, 0, 0.9991, 0, 0, 1.0009, 0]);
    const pose = createImportedPoseEvaluator(asset([nearUnit])).evaluate({ clipId: 'walk', timeSeconds: 2, loop: false });
    const matrix = pose.nodeMatrices.subarray(16, 32);
    expect(matrix[0]).toBeCloseTo(0, 7);
    expect(matrix[1]).toBeCloseTo(0.5, 7);
    expect(matrix[4]).toBeCloseTo(-0.5, 7);
  });
});

describe('imported pose ownership and transform composition', () => {
  it('applies joint ancestors, inverse bind, and normalization once while ignoring the mesh node', () => {
    const source = asset([channel('translation', 'LINEAR', [0, 4], [2, 0, 0, 6, 0, 0])]);
    const evaluator = createImportedPoseEvaluator(source);
    const rest = evaluator.evaluate();
    expect(rest.skinMatrices[0]![12]).toBe(0);
    expect(rest.nodeMatrices[2 * 16 + 12]).toBe(45);
    const middle = evaluator.evaluate({ clipId: 'walk', timeSeconds: 2, loop: false });
    expect(middle.skinMatrices[0]![12]).toBe(1);
    expect(middle.skinMatrices[0]![0]).toBe(0.5);
    expect(middle.nodeMatrices[16 + 12]).toBe(2);
    expect(evaluator.evaluate({ clipId: 'walk', timeSeconds: 6, loop: true }).skinMatrices[0]![12]).toBe(1);
    const endpoint = evaluator.evaluate({ clipId: 'walk', timeSeconds: 6, loop: false });
    expect(endpoint.timeSeconds).toBe(4); expect(endpoint.skinMatrices[0]![12]).toBe(2);
    expect(evaluator.evaluate().skinMatrices[0]![12]).toBe(0);
  });
  it('composes animated rotation and nonuniform scale in node hierarchy order', () => {
    const source = asset([
      channel('rotation', 'LINEAR', [0, 4], [0, 0, 0, 1, 0, 0, 1, 0]),
      channel('scale', 'LINEAR', [0, 4], [1, 1, 1, 3, 5, 1]),
    ]);
    const pose = createImportedPoseEvaluator(source).evaluate({ clipId: 'walk', timeSeconds: 2, loop: false });
    const matrix = pose.nodeMatrices.subarray(16, 32);
    // 90-degree Z rotation after scale(2,3,1), then global scale .5.
    expect(matrix[0]).toBeCloseTo(0, 6); expect(matrix[1]).toBeCloseTo(1, 6);
    expect(matrix[4]).toBeCloseTo(-1.5, 6); expect(matrix[5]).toBeCloseTo(0, 6);
    expect(matrix[10]).toBeCloseTo(0.5, 6);
  });
  it('snapshots external curves and node matrices at creation', () => {
    const curve = channel('translation', 'LINEAR', [0, 4], [2, 0, 0, 6, 0, 0]);
    const source = asset([curve]); const evaluator = createImportedPoseEvaluator(source);
    curve.values.fill(100); source.rig!.skins[0]!.inverseBindMatrices[12] = 100;
    expect(evaluator.evaluate({ clipId: 'walk', timeSeconds: 2, loop: false }).skinMatrices[0]![12]).toBe(1);
  });
  it('rejects cycles, invalid keys, unknown clips and invalid playback time before evaluation', () => {
    const cyclic = { ...asset(), rig: { nodes: [node(1), node(0)], skins: [] } };
    expect(() => createImportedPoseEvaluator(cyclic)).toThrow(/cycle/);
    expect(() => createImportedPoseEvaluator(asset([channel('translation', 'LINEAR', [0, 0], [0, 0, 0, 1, 1, 1])]))).toThrow(/increase/);
    const evaluator = createImportedPoseEvaluator(asset());
    expect(() => evaluator.evaluate({ clipId: 'missing', timeSeconds: 0, loop: false })).toThrow(/does not exist/);
    expect(() => evaluator.evaluate({ clipId: 'walk', timeSeconds: -1, loop: false })).toThrow(/controls/);
    expect(() => evaluator.evaluate({ clipId: 'walk', timeSeconds: Infinity, loop: false })).toThrow(/controls/);
  });
});
