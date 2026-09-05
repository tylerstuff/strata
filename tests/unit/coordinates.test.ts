import { describe, expect, it } from 'vitest';
import {
  canonicalTransform, composeTransform, MAX_POSITION_METERS, MAX_SCALE, MIN_SCALE,
  relativePosition, renderPosition, renderTransform, transformPoint, validatePosition, validateTransform,
} from '../../prototypes/coordinates/coordinates.js';
import type { GlobalTransform, Mat3, Transform, Vec3 } from '../../prototypes/coordinates/coordinates.js';
import { CELL_METERS, normalizeCell, relativeCell, splitPosition } from '../../prototypes/coordinates/cell-candidate.js';

const TRANSLATION_ERROR_METERS = 1e-9;
const PARENT_ERROR_METERS = 1e-8;
const MICROMETRES_PER_METRE = 1_000_000n;
const IDENTITY: Transform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const IDENTITY_LINEAR: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function expectVector(actual: ArrayLike<number>, expected: readonly number[], tolerance: number): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((value, axis) => expect(Math.abs(actual[axis]! - value)).toBeLessThanOrEqual(tolerance));
}

/** Test-only adjacent-value oracle, independent of the cell normalization arithmetic. */
function adjacent(value: number, direction: 'up' | 'down'): number {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value);
  const increment = (value > 0) === (direction === 'up') ? 1n : -1n;
  bits.setBigUint64(0, bits.getBigUint64(0) + increment);
  return bits.getFloat64(0);
}

describe('binary64 world coordinates before the float32 upload boundary', () => {
  for (const offsetMetres of [0, 1_000, 10_000, 100_000, 1_000_000]) {
    for (const sign of [-1, 1]) {
      it(`matches independent integer-micrometre differences at ${sign * offsetMetres} m`, () => {
        const base = BigInt(sign * offsetMetres) * MICROMETRES_PER_METRE;
        // Every axis gets a different local value and direction. These decimal fixtures
        // must incur ordinary Number input rounding; no expected result uses that rounding.
        const originTicks = [base + 7_000_123n, -base - 320_031n, base + 1_023_999_999n];
        for (const deltaTicks of [[1n, -1_000n, 31_250n], [-1n, 1_000n, -124_123_456n]]) {
          const positionTicks = originTicks.map((value, axis) => value + deltaTicks[axis]!);
          const origin = originTicks.map(value => Number(value) / 1e6) as unknown as Vec3;
          const position = positionTicks.map(value => Number(value) / 1e6) as unknown as Vec3;
          const expected = positionTicks.map((value, axis) => Number(value - originTicks[axis]!) / 1e6);
          const relative = relativePosition(position, origin);
          expectVector(relative, expected, TRANSLATION_ERROR_METERS);
          expectVector(relativeCell(splitPosition(position), splitPosition(origin)), expected, TRANSLATION_ERROR_METERS);

          const uploaded = renderPosition(position, origin);
          const nearOrigin = renderPosition(expected as unknown as Vec3, [0, 0, 0]);
          expected.forEach((value, axis) => {
            const uploadTolerance = TRANSLATION_ERROR_METERS + Math.abs(value) * 2 ** -24;
            expect(Math.abs(uploaded[axis]! - value)).toBeLessThanOrEqual(uploadTolerance);
            expect(Math.abs(uploaded[axis]! - nearOrigin[axis]!)).toBeLessThanOrEqual(2 * uploadTolerance);
          });
        }
      });
    }
  }

  it('detects the lost millimetre when global positions are rounded before subtraction', () => {
    for (const offset of [-1_000_000, -100_000, 100_000, 1_000_000]) {
      const point: Vec3 = [offset + 0.001, offset - 0.001, offset + 0.001];
      const origin: Vec3 = [offset, offset, offset];
      const early = point.map((value, axis) => Math.fround(Math.fround(value) - Math.fround(origin[axis]!)));
      expect(early).toEqual([0, 0, 0]);
      expectVector(renderPosition(point, origin), [0.001, -0.001, 0.001], TRANSLATION_ERROR_METERS);
    }
  });

  it('keeps the guard range separate from the range of a relative difference', () => {
    const position: Vec3 = [MAX_POSITION_METERS, -MAX_POSITION_METERS, 0];
    const origin: Vec3 = [-MAX_POSITION_METERS, MAX_POSITION_METERS, 0];
    expect(relativePosition(position, origin)).toEqual([2 * MAX_POSITION_METERS, -2 * MAX_POSITION_METERS, 0]);
  });
});

describe('integer-cell comparison candidate', () => {
  const half = CELL_METERS / 2;
  for (const [value, expectedCell] of [
    [adjacent(-half, 'down'), -1], [-half, 0], [adjacent(-half, 'up'), 0],
    [adjacent(half, 'down'), 0], [half, 1], [adjacent(half, 'up'), 1],
  ]) {
    it(`uses the half-open interval at local ${value}`, () => {
      const result = normalizeCell({ cell: [0, 0, 0], local: [value!, value!, value!] });
      expect(result.cell).toEqual([expectedCell, expectedCell, expectedCell]);
      const expectedLocal = value! - expectedCell! * CELL_METERS;
      expect(result.local).toEqual([expectedLocal, expectedLocal, expectedLocal]);
      result.local.forEach(local => {
        expect(local).toBeGreaterThanOrEqual(-half);
        expect(local).toBeLessThan(half);
      });
      expect(normalizeCell(result)).toEqual(result);
    });
  }

  it('carries multiple cells in both directions and canonicalizes signed zero', () => {
    const result = normalizeCell({ cell: [7, -7, -0], local: [2_560, -2_560, -0] });
    expect(result).toEqual({ cell: [10, -9, 0], local: [-512, -512, 0] });
    expect(Object.is(result.cell[2], -0)).toBe(false);
    expect(Object.is(result.local[2], -0)).toBe(false);
    expect(splitPosition([MAX_POSITION_METERS, -MAX_POSITION_METERS, 0])).toEqual({
      cell: [1_048_576, -1_048_576, 0], local: [0, 0, 0],
    });
  });

  it('retains micrometre differences across a cell boundary near the int32 limit', () => {
    // Expected displacement is exactly one micrometre before input Number rounding.
    const result = relativeCell(
      { cell: [2_147_483_647, -2_147_483_647, 0], local: [-512, 511.999999, 0] },
      { cell: [2_147_483_646, -2_147_483_646, 0], local: [511.999999, -512, 0] },
    );
    expectVector(result, [1e-6, -1e-6, 0], TRANSLATION_ERROR_METERS);
  });

  it('rejects invalid cells and overflowing positive and negative carries', () => {
    for (const cell of [0.5, NaN, Infinity, -2_147_483_649, 2_147_483_648]) {
      expect(() => normalizeCell({ cell: [cell, 0, 0], local: [0, 0, 0] })).toThrow(RangeError);
    }
    expect(() => normalizeCell({ cell: [2_147_483_647, 0, 0], local: [512, 0, 0] })).toThrow(/carry/);
    expect(() => normalizeCell({ cell: [-2_147_483_648, 0, 0], local: [adjacent(-512, 'down'), 0, 0] })).toThrow(/carry/);
    expect(normalizeCell({ cell: [2_147_483_647, -2_147_483_648, 0], local: [511, -512, 0] }).cell)
      .toEqual([2_147_483_647, -2_147_483_648, 0]);
    expect(() => normalizeCell({ cell: [0, 0, 0], local: [NaN, 0, 0] })).toThrow(RangeError);
    expect(() => normalizeCell({ cell: [0, 0, 0], local: [MAX_POSITION_METERS + 1, 0, 0] })).toThrow(RangeError);
  });
});

describe('parent-local transforms composed in binary64', () => {
  it('evaluates an exact signed-permutation and power-of-two parent chain', () => {
    const base = 2 ** 19;
    const root = composeTransform({ position: [base, -base, base], rotation: [0, 0, 1, 0], scale: [2, 4, 8] });
    // The all-half unit quaternion cycles X -> Y -> Z -> X exactly.
    const child = composeTransform({ position: [1 / 2, -1 / 4, 1 / 8], rotation: [0.5, 0.5, 0.5, 0.5], scale: [1 / 2, 2, 1 / 4] }, root);
    const grandchild = composeTransform({ position: [2, -4, 8], rotation: [0, 1, 0, 0], scale: [2, 1 / 2, 4] }, child);
    expect(child.position).toEqual([base - 1, -base + 1, base + 1]);
    expectVector(child.linear, [0, -2, 0, 0, 0, 16, -1 / 2, 0, 0], 0);
    expect(grandchild.position).toEqual([base - 5, -base - 3, base - 63]);
    expectVector(grandchild.linear, [0, 4, 0, 0, 0, 8, 2, 0, 0], 0);
    expect(transformPoint(grandchild, [1 / 8, 1 / 4, 1 / 2])).toEqual([base - 4, -base - 2.5, base - 61]);
  });

  for (const base of [-1_000_000, 0, 1_000_000]) {
    it(`preserves noncommuting rotations, nonuniform scale and shear at ${base} m`, () => {
      const parent = composeTransform({ position: [base, -base, base], rotation: [0, 0, 3 / 5, 4 / 5], scale: [2, 3, 4] });
      const child = composeTransform({ position: [3, -2, 5], rotation: [3 / 5, 0, 0, 4 / 5], scale: [4, 2, 1] }, parent);
      // Independent rational oracle: Rz has cos=7/25, sin=24/25; Rx has
      // the same rational terms. Multiplying their scaled row-major matrices
      // on paper yields these numerators; no production math computes expectations.
      const linearNumerators = [1_400, 4_800, 0, -1_008, 294, 4_800, 1_728, -504, 700];
      expectVector(child.linear, linearNumerators.map(value => value / 625), 1e-12);
      expectVector(child.position, [base + 186 / 25, -base + 102 / 25, base + 20], PARENT_ERROR_METERS);
      const transformed = transformPoint(child, [7, -11, 13]);
      expectVector(transformed, [base + 48_002 / 625, -base + 26_364 / 625, base - 31_200 / 625], PARENT_ERROR_METERS);
      expectVector(relativePosition(transformed, [base, -base, base]), [48_002 / 625, 26_364 / 625, -31_200 / 625], PARENT_ERROR_METERS);
      // Nonorthogonal columns are expected: collapsing this result to a single
      // rotation and diagonal scale would lose the parent's induced shear.
      const columnDot = child.linear[3] * child.linear[6] + child.linear[4] * child.linear[7] + child.linear[5] * child.linear[8];
      expect(Math.abs(columnDot - 1_470_000 / 390_625)).toBeLessThan(1e-12);
    });
  }

  it('distinguishes validation from explicit canonicalization without mutating input', () => {
    const source: Transform = { position: [-0, 1, 2], rotation: [-0, 0, 0, 1 + 5e-7], scale: [MIN_SCALE, 1, MAX_SCALE] };
    validateTransform(source);
    expect(source.rotation[3]).toBe(1 + 5e-7);
    expect(Object.is(source.position[0], -0)).toBe(true);
    const canonical = canonicalTransform(source);
    expect(canonical.rotation).toEqual([0, 0, 0, 1]);
    expect(canonical.position).toEqual([0, 1, 2]);
    expect(canonical.position).not.toBe(source.position);
    expect(canonical.rotation).not.toBe(source.rotation);
    expect(canonical.scale).not.toBe(source.scale);
    expectVector(composeTransform(source).linear, [MIN_SCALE, 0, 0, 0, 1, 0, 0, 0, MAX_SCALE], 0);
  });

  it('round-trips binary64 JSON numbers without implicitly normalizing accepted rotations', () => {
    const source: Transform = {
      position: [1_000_000.000001, -1_000_000.000001, 0.001],
      rotation: [0, 0, 0, 1 + 5e-7],
      scale: [MIN_SCALE, 1, MAX_SCALE],
    };
    const restored = JSON.parse(JSON.stringify(source)) as Transform;
    validateTransform(restored);
    expect(restored).toEqual(source);
    expect(restored.rotation[3]).toBe(1 + 5e-7);
    const canonical = canonicalTransform(restored);
    expect(canonical.rotation[3]).toBe(1);
    expect(restored.rotation[3]).toBe(1 + 5e-7);
  });

  it('rejects invalid input positions, quaternions and scales', () => {
    validatePosition([MAX_POSITION_METERS, -MAX_POSITION_METERS, 0]);
    for (const value of [NaN, Infinity, -Infinity, adjacent(MAX_POSITION_METERS, 'up'), adjacent(-MAX_POSITION_METERS, 'down')]) {
      expect(() => validatePosition([0, value, 0])).toThrow(RangeError);
    }
    expect(() => validatePosition([0, 0] as unknown as Vec3)).toThrow(RangeError);
    for (const rotation of [[0, 0, 0, 0], [0, 0, 0, 1.01], [0, NaN, 0, 1]]) {
      expect(() => validateTransform({ ...IDENTITY, rotation: rotation as unknown as Transform['rotation'] })).toThrow(RangeError);
    }
    for (const value of [0, -1, MIN_SCALE / 2, MAX_SCALE * 2, NaN, Infinity]) {
      expect(() => validateTransform({ ...IDENTITY, scale: [1, value, 1] })).toThrow(RangeError);
    }
  });

  it('checks composed position bounds and nonfinite or float32-overflowing matrices', () => {
    const edge: GlobalTransform = { position: [MAX_POSITION_METERS, 0, 0], linear: IDENTITY_LINEAR };
    expect(() => composeTransform({ ...IDENTITY, position: [1, 0, 0] }, edge)).toThrow(RangeError);
    expect(() => transformPoint(edge, [1, 0, 0])).toThrow(RangeError);
    for (const value of [NaN, Infinity]) {
      const parent: GlobalTransform = { position: [0, 0, 0], linear: [value, 0, 0, 0, 1, 0, 0, 0, 1] };
      expect(() => composeTransform(IDENTITY, parent)).toThrow(RangeError);
      expect(() => transformPoint(parent, [0, 0, 0])).toThrow(RangeError);
    }
    const huge: GlobalTransform = { position: [0, 0, 0], linear: [Number.MAX_VALUE, 0, 0, 0, 1, 0, 0, 0, 1] };
    expect(() => composeTransform({ ...IDENTITY, scale: [MAX_SCALE, 1, 1] }, huge)).toThrow(RangeError);
    expect(() => renderTransform({ transform: huge, origin: [0, 0, 0] })).toThrow(/float32/);
  });
});
