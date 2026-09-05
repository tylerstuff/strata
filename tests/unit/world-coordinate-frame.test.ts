import { describe, expect, it } from 'vitest';
import { packWorldCoordinateFrame, WorldCoordinateError } from '../../packages/core/src/rendering/world-coordinate-frame.js';
import { getWorldCoordinateFixture, getWorldCoordinateFixtures, referenceBoxNormal, referenceBoxPoint } from '../fixtures/world-coordinates.js';
import type { Vec3 } from '../fixtures/world-coordinates.js';

type Box = Parameters<typeof packWorldCoordinateFrame>[0][number];
type Camera = Parameters<typeof packWorldCoordinateFrame>[1];
type Perspective = Parameters<typeof packWorldCoordinateFrame>[2];
const CAMERA: Camera = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
const LENS: Perspective = { verticalFovRadians: Math.PI / 2, aspect: 1, near: 1, far: 3 };
const BOX: Box = { dimensions: [1, 1, 1], transform: { position: [0, 0, -2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } };
const CORNERS: readonly Vec3[] = [-0.5, 0.5].flatMap(x => [-0.5, 0.5].flatMap(y => [-0.5, 0.5].map(z => [x, y, z] as Vec3)));
const F32_ROUNDOFF = 2 ** -24;
const INPUT_ERROR_METRES = 1e-9;

function expectVector(actual: ArrayLike<number>, expected: readonly number[], tolerance: number): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((value, axis) => expect(Math.abs(actual[axis]! - value)).toBeLessThanOrEqual(tolerance));
}

/** Test-side matrix evaluation only; the expected values come from rational fixtures. */
function apply(matrix: ArrayLike<number>, point: readonly number[], stride = 4): number[] {
  return Array.from({ length: stride === 4 ? 4 : 3 }, (_, row) =>
    matrix[row]! * point[0]! + matrix[4 + row]! * point[1]! + matrix[8 + row]! * point[2]!
      + (stride === 4 ? matrix[12 + row]! * (point[3] ?? 1) : 0));
}

function unit(value: readonly number[]): number[] {
  const length = Math.hypot(...value);
  return value.map(component => component / length);
}

function expectCoordinateError(action: () => unknown, path: string, boxIndex: number | null): void {
  let thrown: unknown;
  try { action(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(WorldCoordinateError);
  expect(thrown).toBeInstanceOf(RangeError);
  const error = thrown as WorldCoordinateError;
  expect(error.path).toBe(path);
  expect(error.boxIndex).toBe(boxIndex);
  expect(typeof error.reason).toBe('string');
  expect(error.reason.length).toBeGreaterThan(0);
}

describe('pure camera-relative root box packing', () => {
  it('packs independently worked column-major model, padded normal, view and projection layouts', () => {
    const fixture = getWorldCoordinateFixture('static-dyadic-pos-1000000m/0');
    const box = fixture.boxes.find(value => value.id === 'rotated')!;
    const result = packWorldCoordinateFrame([box], fixture.camera, LENS);
    expect(result.origin).toEqual(fixture.camera.position);
    expect(result.viewRotation).toBeInstanceOf(Float32Array);
    expect(result.viewProjection).toBeInstanceOf(Float32Array);
    expect(result.modelMatrices).toBeInstanceOf(Float32Array);
    expect(result.normalMatrices).toBeInstanceOf(Float32Array);
    expect(result.relativeBounds).toBeInstanceOf(Float64Array);
    expectVector(result.viewRotation, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
    expectVector(result.viewProjection, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.5, -1, 0, 0, -1.5, 0], 0);
    // Effective side lengths are 1/4, 3/16, 3/64. The all-half quaternion
    // maps local X -> world Y, Y -> Z, and Z -> X, without floating products.
    expectVector(result.modelMatrices, [
      0, 1 / 4, 0, 0, 0, 0, 3 / 16, 0, 3 / 64, 0, 0, 0, 1 / 4, 1 / 8, -3 / 2, 1,
    ], 0);
    expectVector(result.normalMatrices, [
      0, 4, 0, 0, 0, 0, Math.fround(16 / 3), 0, Math.fround(64 / 3), 0, 0, 0,
    ], 0);
    expect(Array.from(result.relativeBounds)).toEqual([29 / 128, 0, -51 / 32, 35 / 128, 1 / 4, -45 / 32]);
  });

  it('matches rational transforms, pinhole projections, oblique normals and geometric corner bounds', () => {
    const selected = getWorldCoordinateFixtures().filter(frame => frame.sequence.startsWith('static-')
      || frame.sequence.startsWith('teleport-') || frame.sequence.startsWith('camera-cut-')
      || frame.sequence.startsWith('replacement-') || frame.sequence.startsWith('local-teleport-')
      || (frame.sequence === 'boundary-dyadic' && [7, 8, 23, 24].includes(frame.index))
      || (frame.sequence.startsWith('slow-') && [0, 31].includes(frame.index)));
    for (const frame of selected) {
      const result = packWorldCoordinateFrame(frame.boxes, frame.camera, frame.perspective);
      expect(result.modelMatrices.length).toBe(frame.boxes.length * 16);
      expect(result.normalMatrices.length).toBe(frame.boxes.length * 12);
      expect(result.relativeBounds.length).toBe(frame.boxes.length * 6);
      for (const [index, box] of frame.boxes.entries()) {
        const model = result.modelMatrices.subarray(index * 16, (index + 1) * 16);
        const normal = result.normalMatrices.subarray(index * 12, (index + 1) * 12);
        const bounds = result.relativeBounds.subarray(index * 6, (index + 1) * 6);
        const expectedMin = [Infinity, Infinity, Infinity]; const expectedMax = [-Infinity, -Infinity, -Infinity];
        for (const corner of CORNERS) {
          const oracle = referenceBoxPoint(frame.id, box.id, corner);
          const relative = apply(model, corner);
          for (let axis = 0; axis < 3; axis++) {
            expectedMin[axis] = Math.min(expectedMin[axis]!, oracle.relative[axis]!);
            expectedMax[axis] = Math.max(expectedMax[axis]!, oracle.relative[axis]!);
            // Input rounding plus packed coefficient error, not a WGSL or image budget.
            const magnitude = Math.abs(model[12 + axis]!) + 0.5 * (Math.abs(model[axis]!) + Math.abs(model[4 + axis]!) + Math.abs(model[8 + axis]!));
            expect(Math.abs(relative[axis]! - oracle.relative[axis]!)).toBeLessThanOrEqual(INPUT_ERROR_METRES + 2 * F32_ROUNDOFF * magnitude);
          }
          if (oracle.insideClip) {
            const clip = apply(result.viewProjection, relative);
            const pixel = [(clip[0]! / clip[3]! + 1) * frame.viewport.width / 2, (1 - clip[1]! / clip[3]!) * frame.viewport.height / 2];
            expectVector(pixel, oracle.pixel!, 1e-4);
            expect(Math.abs(clip[2]! / clip[3]! - oracle.ndcDepth!)).toBeLessThanOrEqual(2e-7);
          }
        }
        expectVector(bounds, [...expectedMin, ...expectedMax], INPUT_ERROR_METRES);
        for (const input of [[1, 0, 0], [0, -1, 0], [0, 0, 1], [1, 1, 0]] as const) {
          const oracle = referenceBoxNormal(frame.id, box.id, input);
          expectVector(unit(apply(normal, input, 3)), oracle, 2e-7);
          // Normals are directions; scaling the input by a fraction preserves direction.
          expectVector(unit(apply(normal, input.map(value => value / 4), 3)), oracle, 2e-7);
        }
        expect([normal[3], normal[7], normal[11]]).toEqual([0, 0, 0]);
      }
    }
  });

  it('subtracts in binary64 before float32 conversion and accepts distant numeric-only clusters', () => {
    for (const offset of [-1_000_000, 1_000_000]) {
      const box: Box = { ...BOX, transform: { ...BOX.transform, position: [offset + 0.001, -offset - 0.001, offset - 2] } };
      const result = packWorldCoordinateFrame([box], { ...CAMERA, position: [offset, -offset, offset] }, LENS);
      expectVector(result.modelMatrices.subarray(12, 15), [0.001, -0.001, -2], 1e-9);
      expect(Math.fround(box.transform.position[0]) - Math.fround(offset)).toBe(0);
    }
    const stress = getWorldCoordinateFixture('teleport-dyadic/1');
    const result = packWorldCoordinateFrame(stress.boxes, stress.camera, stress.perspective);
    expect(result.modelMatrices).toHaveLength(15 * 16);
    expect(result.relativeBounds.some(value => Math.abs(value) > 4096)).toBe(true);
    expect(result.modelMatrices.every(Number.isFinite)).toBe(true);
  });

  it('keeps geometric binary64 bounds distinct from rounded GPU vertex containment', () => {
    // f32(0.1) rounds upward. Its positive unit-box face exceeds the source
    // binary64 half extent, even before WGSL arithmetic can add further error.
    const box: Box = { ...BOX, dimensions: [0.1, 1, 1], transform: { ...BOX.transform, position: [0, 0, 0] } };
    const result = packWorldCoordinateFrame([box], CAMERA, LENS);
    expect(result.relativeBounds[0]).toBe(-0.05);
    expect(result.relativeBounds[3]).toBe(0.05);
    const roundedCorner = apply(result.modelMatrices, [0.5, 0, 0]);
    expect(roundedCorner[0]).toBeGreaterThan(result.relativeBounds[3]!);
  });

  it('returns fresh buffers and does not mutate or alias frozen fixture inputs', () => {
    const fixture = getWorldCoordinateFixture('static-decimal-pos-1000000m/0');
    const before = JSON.stringify(fixture);
    const first = packWorldCoordinateFrame(fixture.boxes, fixture.camera, fixture.perspective);
    const second = packWorldCoordinateFrame(fixture.boxes, fixture.camera, fixture.perspective);
    expect(first.origin).not.toBe(fixture.camera.position);
    expect(first.origin).not.toBe(second.origin);
    expect(first.camera.position).toEqual(fixture.camera.position);
    expect(first.camera.position).not.toBe(first.origin);
    expect(first.camera.position).not.toBe(fixture.camera.position);
    expect(first.camera.rotation).not.toBe(fixture.camera.rotation);
    expect(first.camera).not.toBe(second.camera);
    expect(first.camera.position).not.toBe(second.camera.position);
    expect(first.camera.rotation).not.toBe(second.camera.rotation);
    const arrays = ['viewRotation', 'viewProjection', 'modelMatrices', 'normalMatrices', 'relativeBounds'] as const;
    for (const key of arrays) {
      expect(first[key]).toEqual(second[key]);
      expect(first[key].buffer).not.toBe(second[key].buffer);
      const previous = second[key][0];
      first[key][0] = 123;
      expect(second[key][0]).toBe(previous);
    }
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it('normalizes accepted quaternions without rewriting their source values', () => {
    const rotation = [0, 0, 0, 1 + 5e-7] as const;
    const camera: Camera = { ...CAMERA, rotation };
    const box: Box = { ...BOX, transform: { ...BOX.transform, rotation } };
    const result = packWorldCoordinateFrame([box], camera, LENS);
    expect(result.viewRotation).toEqual(packWorldCoordinateFrame([BOX], CAMERA, LENS).viewRotation);
    expect(result.modelMatrices).toEqual(packWorldCoordinateFrame([BOX], CAMERA, LENS).modelMatrices);
    expect(result.camera.rotation).toEqual([0, 0, 0, 1]);
    expect(result.camera.position).toEqual(CAMERA.position);
    expect(camera.rotation[3]).toBe(1 + 5e-7);
    expect(box.transform.rotation[3]).toBe(1 + 5e-7);
  });

  it('keeps consecutive camera snapshots independent without global origin state', () => {
    const firstFrame = getWorldCoordinateFixture('local-teleport-dyadic/0');
    const nextFrame = getWorldCoordinateFixture('local-teleport-dyadic/1');
    const first = packWorldCoordinateFrame(firstFrame.boxes, firstFrame.camera, firstFrame.perspective);
    const snapshot = structuredClone(first);
    const next = packWorldCoordinateFrame(nextFrame.boxes, nextFrame.camera, nextFrame.perspective);
    expect(first).toEqual(snapshot);
    expect(next.origin).not.toEqual(first.origin);
    expect(next.modelMatrices).not.toEqual(first.modelMatrices);
    expect(packWorldCoordinateFrame(firstFrame.boxes, firstFrame.camera, firstFrame.perspective)).toEqual(first);
    expect(nextFrame.boxes).toEqual(firstFrame.boxes);
  });

  it('preserves binary64 camera pose values separately from packed float32 matrices', () => {
    const normOffset = 1 + 5e-7;
    const camera: Camera = {
      position: [1_000_000.001, -1_000_000.001, 0.000001],
      rotation: [0, 0, 0.6 * normOffset, 0.8 * normOffset],
    };
    const result = packWorldCoordinateFrame([], camera, LENS);
    expect(result.camera.position).toEqual(camera.position);
    expect(result.origin).toEqual(camera.position);
    expect(result.camera.position[0]).not.toBe(Math.fround(camera.position[0]));
    expectVector(result.camera.rotation, [0, 0, 0.6, 0.8], 1e-15);
    expect(result.camera.rotation[2]).not.toBe(Math.fround(0.6));
    expect(camera.rotation[2]).toBe(0.6 * normOffset);
  });
});

describe('coordinate packer numeric contract and errors', () => {
  it('allows an empty batch and ignores metadata outside the numeric box contract', () => {
    const empty = packWorldCoordinateFrame([], CAMERA, LENS);
    expect(empty.modelMatrices.length).toBe(0);
    expect(empty.normalMatrices.length).toBe(0);
    expect(empty.relativeBounds.length).toBe(0);
    const metadata = { ...BOX, id: '', material: { unavailable: true } };
    expect(packWorldCoordinateFrame([metadata], CAMERA, LENS)).toEqual(packWorldCoordinateFrame([BOX], CAMERA, LENS));
  });

  it('accepts documented root limits and relative differences outside the absolute guard', () => {
    const edge = 2 ** 30;
    const box: Box = { dimensions: [1, 1, 1], transform: { position: [edge, -edge, 0], rotation: [0, 0, 0, 1], scale: [1e-6, 1e6, 1] } };
    const result = packWorldCoordinateFrame([box], { ...CAMERA, position: [-edge, edge, 0] }, LENS);
    expect(result.modelMatrices[12]).toBe(2 * edge);
    expect(result.modelMatrices[13]).toBe(-2 * edge);
    expect(result.modelMatrices.every(Number.isFinite)).toBe(true);
    expect(result.normalMatrices.every(Number.isFinite)).toBe(true);
  });

  it('attributes invalid box components to their index and exact numeric path', () => {
    for (const value of [NaN, Infinity, -Infinity, 2 ** 30 + 1, -(2 ** 30) - 1]) {
      const invalid: Box = { ...BOX, transform: { ...BOX.transform, position: [0, value, 0] } };
      expectCoordinateError(() => packWorldCoordinateFrame([BOX, invalid], CAMERA, LENS), '/boxes/1/transform/position/1', 1);
    }
    for (const value of [0, -1, NaN, Infinity]) {
      expectCoordinateError(() => packWorldCoordinateFrame([{ ...BOX, dimensions: [1, 1, value] }], CAMERA, LENS), '/boxes/0/dimensions/2', 0);
    }
    for (const value of [0, -1, 1e-6 / 2, 1e6 * 2, NaN, Infinity]) {
      const invalid: Box = { ...BOX, transform: { ...BOX.transform, scale: [value, 1, 1] } };
      expectCoordinateError(() => packWorldCoordinateFrame([invalid], CAMERA, LENS), '/boxes/0/transform/scale/0', 0);
    }
    const invalidRotation: Box = { ...BOX, transform: { ...BOX.transform, rotation: [0, 0, NaN, 1] } };
    expectCoordinateError(() => packWorldCoordinateFrame([invalidRotation], CAMERA, LENS), '/boxes/0/transform/rotation/2', 0);
  });

  it('rejects zero and nonunit quaternion norms', () => {
    for (const rotation of [[0, 0, 0, 0], [0, 0, 0, 1.01]] as const) {
      expectCoordinateError(() => packWorldCoordinateFrame([{ ...BOX, transform: { ...BOX.transform, rotation } }], CAMERA, LENS), '/boxes/0/transform/rotation', 0);
      expectCoordinateError(() => packWorldCoordinateFrame([BOX], { ...CAMERA, rotation }, LENS), '/camera/rotation', null);
    }
  });

  it('attributes malformed tuples and camera numbers without leaking native TypeErrors', () => {
    expectCoordinateError(() => packWorldCoordinateFrame(null as unknown as readonly Box[], CAMERA, LENS), '/boxes', null);
    expectCoordinateError(() => packWorldCoordinateFrame([null as unknown as Box], CAMERA, LENS), '/boxes/0', 0);
    expectCoordinateError(() => packWorldCoordinateFrame([BOX], null as unknown as Camera, LENS), '/camera', null);
    expectCoordinateError(() => packWorldCoordinateFrame([BOX], CAMERA, null as unknown as Perspective), '/camera/projection', null);
    for (const tuple of [[1, 1], [1, 1, 1, 1], [1, , 1]]) {
      const invalid: Box = { ...BOX, dimensions: tuple as unknown as Vec3 };
      expectCoordinateError(() => packWorldCoordinateFrame([invalid], CAMERA, LENS),
        tuple.length === 3 ? '/boxes/0/dimensions/1' : '/boxes/0/dimensions', 0);
    }
    const shortPosition = { ...CAMERA, position: [0, 0] as unknown as Vec3 };
    expectCoordinateError(() => packWorldCoordinateFrame([BOX], shortPosition, LENS), '/camera/position', null);
    for (const value of [NaN, Infinity, 2 ** 30 + 1]) {
      expectCoordinateError(() => packWorldCoordinateFrame([BOX], { ...CAMERA, position: [value, 0, 0] }, LENS), '/camera/position/0', null);
    }
    expectCoordinateError(() => packWorldCoordinateFrame([BOX], { ...CAMERA, rotation: [0, NaN, 0, 1] }, LENS), '/camera/rotation/1', null);
  });

  it('rejects collapsed or overflowing effective sides and reciprocals before deriving bounds', () => {
    for (const [dimension, scale] of [[Number.MIN_VALUE, 1], [1e-40, 1], [Number.MAX_VALUE, 1], [Number.MAX_VALUE, 1e6]]) {
      const box: Box = { ...BOX, dimensions: [dimension!, 1, 1], transform: { ...BOX.transform, scale: [scale!, 1, 1] } };
      expectCoordinateError(() => packWorldCoordinateFrame([box], CAMERA, LENS), '/boxes/0/dimensions/0', 0);
    }
    // A broad numeric domain is intentional; runtime preview dimensions are a separate cap.
    for (const dimension of [1e-38, 1e38]) {
      const result = packWorldCoordinateFrame([{ ...BOX, dimensions: [dimension, 1, 1] }], CAMERA, LENS);
      expect(result.modelMatrices[0]).toBeGreaterThan(0);
      expect(result.normalMatrices[0]).toBeGreaterThan(0);
      expect(result.modelMatrices.every(Number.isFinite)).toBe(true);
      expect(result.normalMatrices.every(Number.isFinite)).toBe(true);
      expect(result.relativeBounds.every(Number.isFinite)).toBe(true);
      expect(result.relativeBounds[0]).toBe(-dimension / 2);
      expect(result.relativeBounds[3]).toBe(dimension / 2);
    }
  });

  it('rejects invalid lens inputs with separate camera and viewport paths', () => {
    const cases: readonly [keyof Perspective, number, string][] = [
      ['verticalFovRadians', 0, '/camera/projection/verticalFovRadians'],
      ['verticalFovRadians', Math.PI, '/camera/projection/verticalFovRadians'],
      ['verticalFovRadians', NaN, '/camera/projection/verticalFovRadians'],
      ['verticalFovRadians', Infinity, '/camera/projection/verticalFovRadians'],
      ['aspect', 0, '/viewport/aspect'], ['aspect', -1, '/viewport/aspect'], ['aspect', Infinity, '/viewport/aspect'],
      ['near', 0, '/camera/projection/near'], ['near', -1, '/camera/projection/near'], ['near', NaN, '/camera/projection/near'],
      ['far', 1, '/camera/projection/far'], ['far', 0.5, '/camera/projection/far'], ['far', Infinity, '/camera/projection/far'],
    ];
    for (const [field, value, path] of cases) {
      expectCoordinateError(() => packWorldCoordinateFrame([BOX], CAMERA, { ...LENS, [field]: value }), path, null);
    }
  });

  it('rejects otherwise positive lens values that cannot form a finite nonzero float32 projection', () => {
    const cases: readonly [keyof Perspective, number, string][] = [
      ['verticalFovRadians', 1e-40, '/camera/projection/verticalFovRadians'],
      ['aspect', Number.MIN_VALUE, '/viewport/aspect'], ['aspect', Number.MAX_VALUE, '/viewport/aspect'],
      ['near', Number.MIN_VALUE, '/camera/projection/near'],
    ];
    for (const [field, value, path] of cases) {
      expectCoordinateError(() => packWorldCoordinateFrame([BOX], CAMERA, { ...LENS, [field]: value }), path, null);
    }
  });
});
