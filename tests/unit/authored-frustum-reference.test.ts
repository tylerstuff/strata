import { describe, expect, it } from 'vitest';
import { selectAuthoredBoxVisibility } from '../../packages/core/src/rendering/authored-frustum-visibility.js';
import { validateAuthoredBoxScene, validateAuthoredFrameCamera } from '../../packages/core/src/rendering/authored-box-validation.js';
import { packWorldCoordinateFrame } from '../../packages/core/src/rendering/world-coordinate-frame.js';
import { authoredFrustumAnchors, authoredFrustumCases, authoredFrustumPerspective, authoredFrustumViewProjection,
  frustumBox, frustumScene } from '../fixtures/authored-frustum.js';
import { exactPackedBoxClip, exactTriangleClipVertexCount } from '../helpers/authored-frustum-reference.js';
import type { FrustumClipPoint } from '../helpers/authored-frustum-reference.js';

const cases = authoredFrustumCases();
function pack(boxes = cases.map(fixture => fixture.box), anchor = authoredFrustumAnchors[0]!) {
  const scene = validateAuthoredBoxScene(frustumScene(boxes, anchor));
  validateAuthoredFrameCamera(scene, scene.camera, 256, 256);
  return packWorldCoordinateFrame(scene.boxes, scene.camera, authoredFrustumPerspective);
}
function modelAt(models: Float32Array, index: number): Float32Array { return models.slice(index * 16, index * 16 + 16); }

describe('independent exact-rational authored frustum oracle', () => {
  it('clips a triangle crossing the volume even when none of its three vertices is inside', () => {
    const spanning: readonly FrustumClipPoint[] = [[-4, -4, 0.5, 1], [4, -4, 0.5, 1], [0, 4, 0.5, 1]];
    expect(exactTriangleClipVertexCount(spanning)).toBeGreaterThanOrEqual(3);
    expect(exactTriangleClipVertexCount([[2, 0, 0.5, 1], [3, -1, 0.5, 1], [3, 1, 0.5, 1]])).toBe(0);
  });

  it('retains exact tangency and arbitrarily small binary64 slivers without a geometric epsilon', () => {
    expect(exactTriangleClipVertexCount([[1, 0, 0.5, 1], [2, -1, 0.5, 1], [2, 1, 0.5, 1]])).toBeGreaterThan(0);
    const step = 2 ** -50;
    expect(exactTriangleClipVertexCount([[1 - step, 0, 0.5, 1], [2, -1, 0.5, 1], [2, 1, 0.5, 1]])).toBeGreaterThan(0);
    expect(exactTriangleClipVertexCount([[1 + step, 0, 0.5, 1], [2, -1, 0.5, 1], [2, 1, 0.5, 1]])).toBe(0);
  });

  it('distinguishes ordinary WebGPU near/far planes and never divides by nonpositive w', () => {
    for (const depth of [-1 / 1024, 1 + 1 / 1024]) {
      expect(exactTriangleClipVertexCount([[0, 0, depth, 1], [0.1, 0, depth, 1], [0, 0.1, depth, 1]])).toBe(0);
    }
    for (const depth of [0, 1]) {
      expect(exactTriangleClipVertexCount([[0, 0, depth, 1], [0.1, 0, depth, 1], [0, 0.1, depth, 1]])).toBe(3);
    }
    expect(exactTriangleClipVertexCount([[0, 0, -1, -1], [0.1, 0, -1, -1], [0, 0.1, -1, -1]])).toBe(0);
    expect(exactTriangleClipVertexCount([[0, 0, -1, -1], [-0.5, 0, 0.5, 1], [0.5, 0.5, 0.5, 1]])).toBeGreaterThan(0);
  });

  it('rejects malformed/nonfinite reference input instead of treating uncertainty as an expected rejection', () => {
    expect(() => exactTriangleClipVertexCount([])).toThrow(RangeError);
    expect(() => exactTriangleClipVertexCount([[Infinity, 0, 0, 1], [0, 0, 0, 1], [0, 1, 0, 1]])).toThrow(RangeError);
    expect(() => exactPackedBoxClip(new Float32Array(15), authoredFrustumViewProjection())).toThrow(RangeError);
  });

  it('uses the hand-derived exact square projection and independent cyclic rotation columns', () => {
    const result = pack();
    expect(result.viewProjection).toEqual(authoredFrustumViewProjection());
    const index = cases.findIndex(fixture => fixture.box.id === 'cyclic-nonuniform');
    // q=(1/2,1/2,1/2,1/2) maps local X→Y, Y→Z, Z→X.
    expect(Array.from(modelAt(result.modelMatrices, index))).toEqual([
      0, 1 / 4, 0, 0, 0, 0, 1 / 4096, 0, 1 / 2, 0, 0, 0, 3 / 2, 0, -3 / 2, 1,
    ]);
  });

  it.each(cases.map((fixture, index) => ({ ...fixture, index, id: fixture.box.id })))
  ('matches the preregistered geometric boundary result for $id', fixture => {
    const result = pack();
    const oracle = exactPackedBoxClip(modelAt(result.modelMatrices, fixture.index), result.viewProjection);
    expect(oracle.intersectsSurface).toBe(fixture.intersectsSurface);
    expect(oracle.clippedTriangleVertexCounts).toHaveLength(12);
    if (fixture.box.id === 'wide-face-no-inside-corner') {
      expect(oracle.insideCorners).toBe(0);
      expect(oracle.intersectingTriangles).toBeGreaterThan(0);
    }
  });
});

describe('selector versus independent triangle clipping', () => {
  it('retains every exact intersecting surface and rejects every fixed separated plane case', () => {
    const result = pack();
    const selection = selectAuthoredBoxVisibility(result.modelMatrices, result.viewProjection);
    const retained = new Set(selection.retainedIndices);
    const independentlyIntersecting: number[] = [];
    const requiredRejections: number[] = [];
    for (const [index, fixture] of cases.entries()) {
      const oracle = exactPackedBoxClip(modelAt(result.modelMatrices, index), result.viewProjection);
      if (oracle.intersectsSurface) {
        independentlyIntersecting.push(index);
        expect(retained.has(index), fixture.box.id).toBe(true);
      }
      if (fixture.requireRejection) {
        requiredRejections.push(index);
        expect(retained.has(index), fixture.box.id).toBe(false);
      }
    }
    expect(independentlyIntersecting).toHaveLength(26);
    expect(requiredRejections).toHaveLength(7);
    expect(selection.diagnostics.rejectedBoxes).toBeGreaterThanOrEqual(7);
  });

  it('preserves exact packed matrices, oracle outcomes and selected IDs at every signed mixed-axis offset', () => {
    const baseline = pack();
    const referenceSelection = selectAuthoredBoxVisibility(baseline.modelMatrices, baseline.viewProjection);
    const referenceOutcomes = cases.map((_, index) => exactPackedBoxClip(modelAt(baseline.modelMatrices, index), baseline.viewProjection));
    for (const anchor of authoredFrustumAnchors) {
      const translated = pack(undefined, anchor);
      expect(translated.modelMatrices, `packed models at ${anchor}`).toEqual(baseline.modelMatrices);
      expect(translated.viewProjection).toEqual(baseline.viewProjection);
      expect(selectAuthoredBoxVisibility(translated.modelMatrices, translated.viewProjection).retainedIndices).toEqual(referenceSelection.retainedIndices);
      expect(cases.map((_, index) => exactPackedBoxClip(modelAt(translated.modelMatrices, index), translated.viewProjection))).toEqual(referenceOutcomes);
    }
    const cell = (x: number): number => Math.floor((x + 512) / 1024);
    expect(cell(authoredFrustumAnchors[9]![0])).not.toBe(cell(authoredFrustumAnchors[10]![0]));
    expect(cell(authoredFrustumAnchors[11]![0])).not.toBe(cell(authoredFrustumAnchors[12]![0]));
  });

  it('retains a box containing the full frustum although none of its surface triangles intersects', () => {
    const result = pack([frustumBox('contains-frustum', [0, 0, 0], [8, 8, 8])]);
    const oracle = exactPackedBoxClip(result.modelMatrices, result.viewProjection);
    expect(oracle.insideCorners).toBe(0);
    expect(oracle.intersectsSurface).toBe(false);
    expect(selectAuthoredBoxVisibility(result.modelMatrices, result.viewProjection).retainedIndices).toEqual([0]);
  });

  it.each([
    { name: 'minimum field of view and aspect', fov: Math.PI / 180, near: 1, far: 2, width: 1, height: 64, depth: 1.5 },
    { name: 'maximum field of view and aspect', fov: 150 * Math.PI / 180, near: 1, far: 2, width: 64, height: 1, depth: 1.5 },
    { name: 'minimum near plane and maximum depth ratio', fov: Math.PI / 2, near: 0.001, far: 100, width: 1, height: 1, depth: 1 },
    { name: 'maximum far plane and depth ratio', fov: Math.PI / 2, near: 0.04096, far: 4096, width: 1, height: 1, depth: 1 },
    { name: 'closely spaced near and far planes', fov: Math.PI / 2, near: 1, far: 1 + 2 ** -22, width: 1, height: 1, depth: 1 + 2 ** -23 },
  ])('retains exact intersecting triangles at the legal $name', fixture => {
    const input = frustumScene([frustumBox('extreme-lens', [0, 0, -fixture.depth], [0.0001, 0.0001, 0.0001])]);
    const scene = validateAuthoredBoxScene({ ...input, camera: { ...input.camera, projection: {
      kind: 'perspective', verticalFovRadians: fixture.fov, near: fixture.near, far: fixture.far,
    } } });
    const camera = validateAuthoredFrameCamera(scene, scene.camera, fixture.width, fixture.height);
    const result = packWorldCoordinateFrame(scene.boxes, camera, { verticalFovRadians: fixture.fov,
      near: fixture.near, far: fixture.far, aspect: fixture.width / fixture.height });
    expect(exactPackedBoxClip(result.modelMatrices, result.viewProjection).intersectsSurface).toBe(true);
    const selection = selectAuthoredBoxVisibility(result.modelMatrices, result.viewProjection);
    expect(selection.retainedIndices).toEqual([0]);
    if (fixture.name === 'closely spaced near and far planes') {
      // This still-admitted lens exceeds the enclosure's coefficient domain.
      // Falling back retains the root; it does not expand or narrow admission.
      expect(selection.diagnostics.unsupportedRetainedBoxes).toBe(1);
    }
  });

  it('keeps legal world-position guard neighbors distinct from invalid outside-guard inputs', () => {
    const limit = 2 ** 30;
    for (const sign of [-1, 1]) {
      const scene = frustumScene([frustumBox('guard-neighbor', [0, 0, -3 / 2])], [sign * limit, -sign * limit, 0]);
      const admitted = validateAuthoredBoxScene(scene);
      const result = packWorldCoordinateFrame(admitted.boxes, admitted.camera, authoredFrustumPerspective);
      expect(exactPackedBoxClip(result.modelMatrices, result.viewProjection).intersectsSurface).toBe(true);
      expect(selectAuthoredBoxVisibility(result.modelMatrices, result.viewProjection).retainedIndices).toEqual([0]);
      const box = scene.boxes[0]!;
      expect(() => validateAuthoredBoxScene({ ...scene, boxes: [{ ...box, transform: { ...box.transform,
        position: [sign * (limit + 2 ** -20), box.transform.position[1], box.transform.position[2]],
      } }] })).toThrow(/1073741824/);
    }
  });

  it('keeps the unculled reference complete and uploads full resident model ranges', () => {
    const result = pack();
    const modelsBefore = result.modelMatrices.slice();
    const selected = selectAuthoredBoxVisibility(result.modelMatrices, result.viewProjection);
    const all = selectAuthoredBoxVisibility(result.modelMatrices, result.viewProjection, 'none');
    expect(all.retainedIndices).toEqual(cases.map((_, index) => index));
    expect(all.drawnIndices).toEqual(cases.map((_, index) => index));
    expect(all.diagnostics.testedBoxes).toBe(0);
    expect(selected.diagnostics.drawnBoxes).toBeLessThan(all.diagnostics.drawnBoxes);
    for (const mode of [selected, all]) {
      expect(mode.diagnostics.packedInstances).toBe(cases.length);
      expect(mode.diagnostics.currentModelUploadBytes).toBe(cases.length * 64);
      expect(mode.diagnostics.previousModelUploadBytes).toBe(cases.length * 64);
      expect(mode.diagnostics.frameUniformUploadBytes).toBe(176);
      expect(mode.diagnostics.totalUploadBytes).toBe(cases.length * 128 + 176);
    }
    expect(result.modelMatrices).toEqual(modelsBefore);
  });

  it('detects the fixed center-only and half-size negative controls on the original sliver fixture', () => {
    const fixture = cases.find(value => value.box.id === 'right-sliver')!;
    const result = pack([fixture.box]);
    const model = result.modelMatrices;
    expect(exactPackedBoxClip(model, result.viewProjection).intersectsSurface).toBe(true);
    expect(selectAuthoredBoxVisibility(model, result.viewProjection).retainedIndices).toEqual([0]);
    // Deliberately wrong: the center alone is outside even though a sliver enters.
    expect(model[12]! > -model[14]!).toBe(true);
    const undersized = model.slice();
    for (const index of [0, 1, 2, 4, 5, 6, 8, 9, 10]) undersized[index] = undersized[index]! / 2;
    expect(exactPackedBoxClip(undersized, result.viewProjection).intersectsSurface).toBe(false);
    expect(selectAuthoredBoxVisibility(undersized, result.viewProjection).retainedIndices).toEqual([]);
    // The bad candidate loses the exact original fixture's required selected ID.
    expect(selectAuthoredBoxVisibility(undersized, result.viewProjection).retainedIndices).not.toEqual([0]);
  });

  it('detects early global-f32 conversion using a fixed visible sliver at a million-metre offset', () => {
    const box = frustumBox('early-f32-control', [113 / 64 - 1 / 1024, 0, -97 / 64]);
    const anchor = [1_000_000 + 1 / 32, -1_000_000, 1_000_000] as const;
    const result = pack([box], anchor);
    expect(exactPackedBoxClip(result.modelMatrices, result.viewProjection).intersectsSurface).toBe(true);
    expect(selectAuthoredBoxVisibility(result.modelMatrices, result.viewProjection).retainedIndices).toEqual([0]);
    const wrong = result.modelMatrices.slice();
    for (let axis = 0; axis < 3; axis++) {
      wrong[12 + axis] = Math.fround(box.transform.position[axis]! + anchor[axis]!) - Math.fround(anchor[axis]!);
    }
    expect(Array.from(wrong.slice(12, 15))).toEqual([29 / 16, 0, -3 / 2]);
    expect(exactPackedBoxClip(wrong, result.viewProjection).intersectsSurface).toBe(false);
    expect(selectAuthoredBoxVisibility(wrong, result.viewProjection).retainedIndices).toEqual([]);
  });
});
