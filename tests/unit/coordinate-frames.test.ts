import { describe, expect, it } from 'vitest';
import {
  composeTransform, renderTransformPair,
} from '../../prototypes/coordinates/coordinates.js';
import type { CoordinateSample, Vec3 } from '../../prototypes/coordinates/coordinates.js';

const OFFSETS = [0, 1_000, -1_000, 10_000, -10_000, 100_000, -100_000, 1_000_000, -1_000_000];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sample = (position: Vec3, origin: Vec3): CoordinateSample => ({
  transform: composeTransform({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }), origin,
});

/** Independent row-major camera/projection reference, no production raster imports.
 * Camera yaw uses cos=4/5, sin=3/5; w=-view.z and finite ordinary depth [0,1]. */
function clip(model: Float32Array, point: Vec3, yawSign: number): number[] {
  const world = [0, 1, 2].map(row =>
    model[row]! * point[0] + model[4 + row]! * point[1] + model[8 + row]! * point[2] + model[12 + row]!,
  );
  const near = 0.1;
  const far = 10_000;
  const matrix = [
    [0.8, 0, -0.6 * yawSign, 0],
    [0, 1, 0, 0],
    [far / (near - far) * 0.6 * yawSign, 0, far / (near - far) * 0.8, far * near / (near - far)],
    [-0.6 * yawSign, 0, -0.8, 0],
  ];
  return matrix.map(row => row[0]! * world[0]! + row[1]! * world[1]! + row[2]! * world[2]! + row[3]!);
}

function ndc(clipPosition: number[]): number[] {
  return clipPosition.slice(0, 3).map(value => value / clipPosition[3]!);
}

describe('isolated current/previous coordinate frames', () => {
  it('uploads an independently specified rotation, scale and relative translation in column order', () => {
    const current: CoordinateSample = {
      transform: composeTransform({
        position: [1_000_000.25, -1_000_000.5, 1_000_000.75],
        rotation: [0.5, 0.5, 0.5, 0.5], scale: [2, 4, 8],
      }),
      origin: [1_000_000, -1_000_000, 1_000_000],
    };
    // The all-half quaternion cycles X->Y, Y->Z, Z->X. Everything is exact binary.
    expect(renderTransformPair(current).current).toEqual(new Float32Array([
      0, 2, 0, 0, 0, 0, 4, 0, 8, 0, 0, 0, 0.25, -0.5, 0.75, 1,
    ]));
  });

  it.each(OFFSETS)('matches near-origin camera matrices and motion at offset %s m', offset => {
    const base: Vec3 = [offset, -offset, offset];
    const vertices: Vec3[] = [[0, 0, 0], [0.001, 0, 0], [-0.001, 0.002, 0.001]];
    // Both entity and camera move. Previous view orientation differs from current.
    const localCurrent = sample([2.001, 1, -20], [0.001, 0.002, 0]);
    const localPrevious = sample([2, 1, -20.002], [0, 0, 0]);
    const local = renderTransformPair(localCurrent, localPrevious);
    const far = renderTransformPair(
      sample(add(base, localCurrent.transform.position), add(base, localCurrent.origin)),
      sample(add(base, localPrevious.transform.position), add(base, localPrevious.origin)),
    );
    expect(far.historyValid).toBe(true);
    for (const vertex of vertices) {
      const current = ndc(clip(far.current, vertex, 1));
      const previous = ndc(clip(far.previous!, vertex, -1));
      const referenceCurrent = ndc(clip(local.current, vertex, 1));
      const referencePrevious = ndc(clip(local.previous!, vertex, -1));
      for (let axis = 0; axis < 3; axis++) {
        expect(Math.abs(current[axis]! - referenceCurrent[axis]!)).toBeLessThanOrEqual(1e-7);
        expect(Math.abs(previous[axis]! - referencePrevious[axis]!)).toBeLessThanOrEqual(1e-7);
        const motion = current[axis]! - previous[axis]!;
        const referenceMotion = referenceCurrent[axis]! - referencePrevious[axis]!;
        expect(Math.abs(motion - referenceMotion)).toBeLessThanOrEqual(2e-7);
      }
    }
  });

  it('preserves origin changes and boundary crossings without rewriting globals', () => {
    const object: Vec3 = [1_000_002, 0, -20];
    // Crosses a 1024 m candidate cell boundary around a fixed object.
    const previous = sample(object, [999_935.999, 0, 0]);
    const current = sample(object, [999_936.001, 0, 0]);
    const snapshot = JSON.stringify({ current, previous });
    const pair = renderTransformPair(current, previous);
    expect(pair.historyValid).toBe(true);
    expect(pair.current[12]).toBeCloseTo(65.999, 4);
    expect(pair.previous![12]).toBeCloseTo(66.001, 4);
    expect(JSON.stringify({ current, previous })).toBe(snapshot);
    // Incorrectly using current origin for the previous transform loses camera motion.
    const wrong = renderTransformPair(current, { ...previous, origin: current.origin });
    expect(wrong.previous![12]).toBe(wrong.current[12]);
    expect(pair.previous![12]).not.toBe(pair.current[12]);
  });

  it('preserves micrometre motion over a slow camera sequence against an integer-tick reference', () => {
    const anchor = 1_000_000;
    const object: Vec3 = [anchor + 0.01, 2, -10];
    let previous: CoordinateSample | undefined;
    for (let frame = 0; frame < 257; frame++) {
      // Absolute integer micrometre ticks avoid a recursively accumulated oracle.
      const ticks = BigInt(anchor) * 1_000_000n + BigInt(frame - 128);
      const origin: Vec3 = [Number(ticks) / 1e6, 0, 0];
      const current = sample(object, origin);
      const pair = renderTransformPair(current, previous);
      const expected = Number(10_000n - BigInt(frame - 128)) / 1e6;
      expect(Math.abs(pair.current[12]! - expected)).toBeLessThanOrEqual(1e-9 + Math.abs(expected) * 2 ** -24);
      expect(pair.historyValid).toBe(frame > 0);
      if (previous) {
        expect(pair.current[12]).toBeLessThan(pair.previous![12]!);
      }
      previous = current;
    }
  });

  it('keeps two views independent and does not infer camera cuts from distance', () => {
    const position: Vec3 = [1_000_000, 2, 3];
    const viewA = sample(position, [999_999, 0, 0]);
    const viewB = sample(position, [-1_000_000, 0, 0]);
    const first = renderTransformPair(viewA);
    const other = renderTransformPair(viewB, viewA);
    expect(first.current[12]).toBe(1);
    expect(first.previous).toBeNull();
    expect(first.historyValid).toBe(false);
    expect(other.current[12]).toBe(2_000_000);
    expect(other.previous![12]).toBe(1);
    expect(other.historyValid).toBe(true);
    expect(renderTransformPair(viewA).current).toEqual(first.current);
  });

  it.each(['camera-cut', 'object-teleport'] as const)('exposes invalid history for %s', reason => {
    const previous = sample([-1_000_000, 0, -10], [-1_000_000, 0, 0]);
    const current = sample([1_000_000.001, 0, -10], [1_000_000, 0, 0]);
    const pair = renderTransformPair(current, previous, reason);
    expect(pair.current[12]).toBeCloseTo(0.001, 8);
    expect(pair.previous).toBeNull();
    expect(pair.historyValid).toBe(false);
  });

  it('rejects float32 overflow after otherwise finite deep affine composition', () => {
    const local = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1e6, 1e6, 1e6] } as const;
    let transform = composeTransform(local);
    for (let index = 0; index < 6; index++) transform = composeTransform(local, transform);
    expect(Number.isFinite(transform.linear[0])).toBe(true);
    expect(() => renderTransformPair({ transform, origin: [0, 0, 0] })).toThrow(/float32/);
  });
});
