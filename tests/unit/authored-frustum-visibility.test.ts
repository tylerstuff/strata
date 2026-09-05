import { describe, expect, it } from 'vitest';
import { selectAuthoredBoxVisibility } from '../../packages/core/src/rendering/authored-frustum-visibility.js';
import { validateAuthoredBoxScene, validateAuthoredFrameCamera } from '../../packages/core/src/rendering/authored-box-validation.js';
import { packWorldCoordinateFrame } from '../../packages/core/src/rendering/world-coordinate-frame.js';
import type { BoxSceneDescriptor } from '../../packages/core/src/rendering/authored-box-types.js';

// Independent exact dyadic packed matrices: square 90-degree camera, near=1,
// far=2, clip=(x,y,-2z-2,-z), and unit-cube side lengths1/8.
const VP = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -2, -1, 0, 0, -2, 0]);
function models(visible: readonly boolean[]): Float32Array {
  const values = new Float32Array(visible.length * 16);
  visible.forEach((inside, index) => values.set([
    1 / 8, 0, 0, 0, 0, 1 / 8, 0, 0, 0, 0, 1 / 8, 0, inside ? 0 : 4, 0, -1.5, 1,
  ], index * 16));
  return values;
}

describe('CPU-only resident authored frustum draw selection', () => {
  it('retains immutable scene slots and emits ascending contiguous instance ranges', () => {
    const input = models([true, true, false, true, false, false, true, true]);
    const before = input.slice(), cameraBefore = VP.slice();
    const result = selectAuthoredBoxVisibility(input, VP);
    expect(result.retainedIndices).toEqual([0, 1, 3, 6, 7]);
    expect(result.drawnIndices).toEqual([0, 1, 3, 6, 7]);
    expect(result.runs).toEqual([
      { firstInstance: 0, instanceCount: 2 }, { firstInstance: 3, instanceCount: 1 }, { firstInstance: 6, instanceCount: 2 },
    ]);
    expect(result.rejectionPlanes).toEqual([null, null, 'right', null, 'right', 'right', null, null]);
    expect(result.diagnostics).toMatchObject({ candidateBoxes: 8, testedBoxes: 8, rejectedBoxes: 3, retainedBoxes: 5,
      drawnBoxes: 5, skippedBoxes: 3, drawCalls: 3, drawnTriangles: 60, fallbackReason: null });
    expect(input).toEqual(before); expect(VP).toEqual(cameraBefore);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.runs[0])).toBe(true);
    expect(Object.isFrozen(result.retainedIndices)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
  });

  it('caps fragmented draw work by keeping additional roots in one full-range fallback', () => {
    const sixteenRuns = Array.from({ length: 32 }, (_, index) => index % 2 === 0);
    const normal = selectAuthoredBoxVisibility(models(sixteenRuns), VP);
    expect(normal.runs).toHaveLength(16);
    expect(normal.diagnostics.fallbackReason).toBe(null);
    const result = selectAuthoredBoxVisibility(models([...sixteenRuns, true]), VP);
    expect(result.retainedIndices).toEqual(Array.from({ length: 17 }, (_, index) => index * 2));
    expect(result.drawnIndices).toEqual(Array.from({ length: 33 }, (_, index) => index));
    expect(result.runs).toEqual([{ firstInstance: 0, instanceCount: 33 }]);
    expect(result.diagnostics).toMatchObject({ candidateBoxes: 33, rejectedBoxes: 16, retainedBoxes: 17,
      drawnBoxes: 33, skippedBoxes: 0, drawCalls: 1, drawnTriangles: 396, fallbackReason: 'run-limit' });
  });

  it('keeps empty residency distinct from all-culled nonempty residency and its full planned uploads', () => {
    const empty = selectAuthoredBoxVisibility(new Float32Array(), VP);
    expect(empty.runs).toEqual([]);
    expect(empty.diagnostics).toMatchObject({ candidateBoxes: 0, testedBoxes: 0, planeTests: 0, drawCalls: 0,
      packedInstances: 0, currentModelUploadBytes: 0, previousModelUploadBytes: 0, frameUniformUploadBytes: 0, totalUploadBytes: 0 });
    const culled = selectAuthoredBoxVisibility(models([false, false]), VP);
    expect(culled.retainedIndices).toEqual([]); expect(culled.drawnIndices).toEqual([]); expect(culled.runs).toEqual([]);
    expect(culled.diagnostics).toMatchObject({ candidateBoxes: 2, rejectedBoxes: 2, drawnBoxes: 0, drawCalls: 0,
      drawnTriangles: 0, packedInstances: 2, currentModelUploadBytes: 128, previousModelUploadBytes: 128,
      frameUniformUploadBytes: 176, totalUploadBytes: 432 });
  });

  it('retains a real forced-all reference without applying the enclosure or a run fallback', () => {
    const result = selectAuthoredBoxVisibility(models([false, true, false]), VP, 'none');
    expect(result.retainedIndices).toEqual([0, 1, 2]);
    expect(result.drawnIndices).toEqual([0, 1, 2]);
    expect(result.classifications).toEqual(['not-tested', 'not-tested', 'not-tested']);
    expect(result.runs).toEqual([{ firstInstance: 0, instanceCount: 3 }]);
    expect(result.diagnostics).toMatchObject({ candidateBoxes: 3, testedBoxes: 0, planeTests: 0, rejectedBoxes: 0,
      drawCalls: 1, drawnTriangles: 36, totalUploadBytes: 560, fallbackReason: null });
  });

  it.each([NaN, Infinity, 2 ** -149, 2 ** 30])('retains rather than rejecting an unsupported numeric model (%s)', value => {
    const input = models([false, false]); input[0] = value;
    const result = selectAuthoredBoxVisibility(input, VP);
    expect(result.retainedIndices).toEqual([0]);
    expect(result.classifications).toEqual(['unsupported', 'outside']);
    expect(result.rejectionPlanes[0]).toBe(null);
    expect(result.diagnostics.unsupportedRetainedBoxes).toBe(1);
  });

  it('retains every root if the shared projection is outside the arithmetic proof domain', () => {
    const projection = VP.slice(); projection[0] = 2 ** -149;
    const result = selectAuthoredBoxVisibility(models([false, false]), projection);
    expect(result.retainedIndices).toEqual([0, 1]);
    expect(result.diagnostics).toMatchObject({ testedBoxes: 2, planeTests: 0, rejectedBoxes: 0, unsupportedRetainedBoxes: 2 });
  });

  it('checks buffer shape and resident count, with 1024 still admitted and no larger batch', () => {
    expect(selectAuthoredBoxVisibility(models(Array(1024).fill(true)), VP).diagnostics.drawnBoxes).toBe(1024);
    expect(() => selectAuthoredBoxVisibility(models(Array(1025).fill(true)), VP)).toThrow(RangeError);
    expect(() => selectAuthoredBoxVisibility(new Float32Array(17), VP)).toThrow(RangeError);
    expect(() => selectAuthoredBoxVisibility(models([true]), new Float32Array(15))).toThrow(RangeError);
  });

  it('does not turn offscreen or override-camera admission failures into culling', () => {
    const scene: BoxSceneDescriptor = {
      format: 'strata.runtime-boxes', version: 1, coordinateSystem: 'strata-world-v1', sceneId: 'visibility-admission', sourceRevision: null,
      boxes: [{ id: 'outside-frustum', dimensions: [1, 1, 1], transform: {
        position: [4095.5, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      }, material: { baseColor: [1, 0, 0, 1], metallic: 0, roughness: 0.5 } }],
      camera: { position: [0, 0, 0], rotation: [0, 0, 0, 1], projection: {
        kind: 'perspective', verticalFovRadians: Math.PI / 2, near: 1, far: 2,
      } }, light: { directionToLight: [0, 1, 0], radiance: [1, 1, 1] }, background: [0, 0, 0],
    };
    const admitted = validateAuthoredBoxScene(scene);
    expect(() => validateAuthoredFrameCamera(admitted, { ...scene.camera, position: [-1 / 8, 0, 0] }, 512, 512))
      .toThrow(/4096/);
    expect(() => validateAuthoredBoxScene({ ...scene, boxes: [{ ...scene.boxes[0]!, transform: {
      ...scene.boxes[0]!.transform, position: [4096, 0, 0],
    } }] })).toThrow(/4096/);
  });

  it('is stateless across invisible frames, changed origins and re-entry without modifying any full model pack', () => {
    const boxes = [{ dimensions: [1 / 8, 1 / 8, 1 / 8] as const, transform: {
      position: [1_000_000, 0, -1.5] as const, rotation: [0, 0, 0, 1] as const, scale: [1, 1, 1] as const,
    } }];
    const perspective = { verticalFovRadians: Math.PI / 2, near: 1, far: 2, aspect: 1 };
    const current = packWorldCoordinateFrame(boxes, { position: [1_000_000, 0, 0], rotation: [0, 0, 0, 1] }, perspective);
    const invisible = packWorldCoordinateFrame(boxes, { position: [1_000_004, 0, 0], rotation: [0, 0, 0, 1] }, perspective);
    const firstBytes = current.modelMatrices.slice(), invisibleBytes = invisible.modelMatrices.slice();
    expect(selectAuthoredBoxVisibility(current.modelMatrices, current.viewProjection).drawnIndices).toEqual([0]);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(selectAuthoredBoxVisibility(invisible.modelMatrices, invisible.viewProjection).drawnIndices).toEqual([]);
    }
    expect(selectAuthoredBoxVisibility(current.modelMatrices, current.viewProjection).drawnIndices).toEqual([0]);
    expect(current.modelMatrices).toEqual(firstBytes); expect(invisible.modelMatrices).toEqual(invisibleBytes);
    expect(invisible.modelMatrices).toHaveLength(16);
    // Actual submitted-frame, failure and re-entry motion semantics remain a
    // renderer-integration acceptance requirement, not exercised by this helper.
  });
});
