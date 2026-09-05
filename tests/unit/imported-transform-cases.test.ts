import { describe, expect, it } from 'vitest';
import { degenerateTransformCases, importedTransformCases, legacyTransformWitnesses,
  type NonsingularTransformCase, type TransformMatrix3, type TransformVec3 } from '../browser/imported-transform-cases.js';

const v3 = (values: readonly number[]): TransformVec3 => [values[0]!, values[1]!, values[2]!];
const dot = (a: TransformVec3, b: TransformVec3) => a.reduce((sum, value, axis) => sum + value * b[axis]!, 0);
const cross = (a: TransformVec3, b: TransformVec3): TransformVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (value: TransformVec3): TransformVec3 => v3(value.map(component => component / Math.hypot(...value)));
const difference = (a: readonly number[], b: readonly number[]) => Math.hypot(...a.map((value, axis) => value - b[axis]!));
const near = (actual: readonly number[], expected: readonly number[], epsilon = 2e-12) => expect(difference(actual, expected)).toBeLessThan(epsilon);
const columns = (matrix: TransformMatrix3) => [0, 3, 6].map(offset => v3(matrix.slice(offset, offset + 3)));
const normalizedMatrix = (matrix: TransformMatrix3): TransformMatrix3 => matrix.map(value => value / Math.max(...matrix.map(Math.abs))) as unknown as TransformMatrix3;
function transform(matrix: TransformMatrix3, value: TransformVec3): TransformVec3 {
  // Three transformed geometric edges, not a cofactor/adjugate normal transform.
  const [x, y, z] = columns(matrix);
  return v3([0, 1, 2].map(axis => x![axis]! * value[0] + y![axis]! * value[1] + z![axis]! * value[2]));
}
const sample = (name: string): NonsingularTransformCase => {
  const found = importedTransformCases.find(value => value.name === name);
  if (!found) throw new Error(`Missing case ${name}`);
  return found;
};

describe('independent imported transform fixture references', () => {
  it('uploads finite exact-f32 inputs and supplies finite orthonormal expected frames only for nonsingular cases', () => {
    expect(importedTransformCases).toHaveLength(43); expect(degenerateTransformCases).toHaveLength(10);
    const all = [...importedTransformCases, ...degenerateTransformCases, ...legacyTransformWitnesses];
    expect(new Set(all.map(value => value.name)).size).toBe(all.length);
    for (const value of all) {
      expect(value.matrix).toHaveLength(9); expect(value.normal).toHaveLength(3); expect(value.tangent).toHaveLength(4);
      for (const component of [...value.matrix, ...value.normal, ...value.tangent]) {
        expect(Number.isFinite(component)).toBe(true); expect(Object.is(Math.fround(component), component)).toBe(true);
      }
      expect(Math.abs(value.tangent[3])).toBe(1);
      expect(Math.abs(Math.hypot(...value.normal) - 1)).toBeLessThan(8e-8);
      expect(Math.abs(dot(value.normal, v3(value.tangent)))).toBeLessThan(8e-8);
      if (value.expectFiniteOnly) {
        expect('expectedNormal' in value).toBe(false); expect('expectedTangent' in value).toBe(false);
      } else {
        expect([...value.expectedNormal, ...value.expectedTangent].every(Number.isFinite)).toBe(true);
        expect(Math.hypot(...value.expectedNormal)).toBeCloseTo(1, 13);
        expect(Math.hypot(...value.expectedTangent.slice(0, 3))).toBeCloseTo(1, 13);
        expect(Math.abs(dot(value.expectedNormal, v3(value.expectedTangent)))).toBeLessThan(2e-14);
        expect(Math.abs(value.expectedTangent[3])).toBe(1);
      }
    }
  });

  it('agrees with the oriented area of an independently transformed plane, including determinant handedness', () => {
    for (const value of importedTransformCases) {
      const matrix = normalizedMatrix(value.matrix), [x, y, z] = columns(matrix);
      // Oriented tetrahedral volume determines handedness independently of the
      // Gaussian pivot bookkeeping used by the fixture generator.
      const signedVolume = dot(x!, cross(y!, z!));
      expect(signedVolume).not.toBe(0);
      expect(value.expectedTangent[3]).toBe(value.tangent[3] * Math.sign(signedVolume));
      const n = unit(value.normal);
      const axis: TransformVec3 = Math.abs(n[0]) < .8 ? [1, 0, 0] : [0, 1, 0];
      const u = unit(cross(n, axis)), v = cross(n, u);
      const areaNormal = unit(cross(transform(matrix, u), transform(matrix, v)));
      near(value.expectedNormal, areaNormal.map(component => component * Math.sign(signedVolume)));
      // The inverse-transpose result must annihilate both transformed plane edges.
      expect(Math.abs(dot(value.expectedNormal, unit(transform(matrix, u))))).toBeLessThan(2e-12);
      expect(Math.abs(dot(value.expectedNormal, unit(transform(matrix, v))))).toBeLessThan(2e-12);
    }
  });

  it('satisfies the defining transpose equation and preserves forward tangent direction', () => {
    for (const value of importedTransformCases) {
      const matrix = normalizedMatrix(value.matrix);
      const transposeNormal = v3(columns(matrix).map(column => dot(column, value.expectedNormal)));
      near(unit(transposeNormal), unit(value.normal));
      const direction = transform(matrix, v3(value.tangent));
      const t = v3(value.expectedTangent), n = value.expectedNormal;
      expect(dot(t, direction)).toBeGreaterThan(0);
      // A projected direction lies in span(A*t, n); this geometric constraint
      // does not recompute the fixture's Gram-Schmidt formula.
      expect(Math.abs(dot(unit(direction), cross(n, t)))).toBeLessThan(2e-12);
    }
  });

  it('is invariant under all six positive common scales, with only exact-f32 input rounding differences', () => {
    const families = new Set(importedTransformCases.filter(value => value.name.includes('/scale-')).map(value => value.name.split('/')[0]!));
    for (const family of families) {
      const control = sample(`${family}/scale-1`);
      const scaled = importedTransformCases.filter(value => value.name.startsWith(`${family}/scale-`));
      expect(scaled).toHaveLength(6);
      for (const value of scaled) {
        near(value.expectedNormal, control.expectedNormal, 3e-7);
        near(value.expectedTangent, control.expectedTangent, 3e-7);
      }
    }
  });

  it('reflects world-space axes and flips tangent handedness without changing their magnitudes', () => {
    for (const name of ['rotation', 'rotated-nonuniform-shear']) {
      const reflectedName = name === 'rotation' ? 'reflected-rotation' : 'reflected-nonuniform-shear';
      for (const value of importedTransformCases.filter(value => value.name.startsWith(`${name}/`))) {
        const reflected = sample(value.name.replace(name, reflectedName));
        near(reflected.expectedNormal, [-value.expectedNormal[0], value.expectedNormal[1], value.expectedNormal[2]]);
        near(reflected.expectedTangent, [-value.expectedTangent[0], value.expectedTangent[1], value.expectedTangent[2], -value.expectedTangent[3]]);
      }
    }
  });

  it('retains the negative sign when an f32 determinant product underflows but the inverse direction exists', () => {
    const value = sample('anisotropic-reflection/determinant-underflow');
    expect(Math.fround(Math.fround(value.matrix[0] * value.matrix[4]) * value.matrix[8])).toBe(-0);
    expect(value.matrix[4]).toBeGreaterThan(0); expect(Math.fround(value.matrix[0] * value.matrix[8])).not.toBe(0);
    near(value.expectedNormal, [0, 1, 0]); near(value.expectedTangent, [-1, 0, 0, -1]);
  });

  it('includes exact-rank cancellation and collapsed/parallel tangent inputs without inventing a singular normal oracle', () => {
    for (const value of degenerateTransformCases) {
      const maximum = Math.max(...value.matrix.map(Math.abs));
      let rank = 0;
      if (maximum > 0) {
        const [x, y, z] = columns(normalizedMatrix(value.matrix));
        const areas = [cross(x!, y!), cross(y!, z!), cross(z!, x!)];
        rank = areas.some(area => Math.hypot(...area) > 1e-12) ? 2 : 1;
        expect(Math.abs(dot(x!, areas[1]!))).toBeLessThan(1e-12);
      }
      expect(value.name.startsWith(rank === 0 ? 'zero/' : `rank${rank}/`)).toBe(true);
      expect(value.expectFiniteOnly).toBe(true);
    }
    const zero = degenerateTransformCases.find(value => value.name.startsWith('zero/'))!;
    expect(zero.matrix.every(value => value === 0)).toBe(true);
    const collapsed = degenerateTransformCases.find(value => value.name.includes('tangent-collapses'))!;
    near(transform(collapsed.matrix, v3(collapsed.tangent)), [0, 0, 0]);
    const parallel = degenerateTransformCases.find(value => value.name.includes('tangent-parallel'))!;
    near(unit(transform(parallel.matrix, v3(parallel.tangent))), parallel.normal);
    const nearParallel = degenerateTransformCases.filter(value => value.name.includes('tangent-near-parallel'));
    expect(nearParallel).toHaveLength(2);
    for (const value of nearParallel) {
      expect(dot(value.normal, v3(value.tangent))).toBe(0);
      const angleSine = Math.hypot(...cross(unit(value.normal), unit(transform(value.matrix, v3(value.tangent)))));
      expect(angleSine).toBeGreaterThan(1e-7); expect(angleSine).toBeLessThan(1e-4);
    }
  });

  it('provides numerical negative controls for the old absolute threshold and underflowed reflection sign', () => {
    const [rotated, reflected, tinyTangent, tinyReflection] = legacyTransformWitnesses;
    near(rotated!.expectedNormal, [1, 0, 0]); near(reflected!.expectedNormal, [-1, 0, 0]);
    for (const value of [rotated!, reflected!]) {
      near(value.legacyNormal, [0, 0, 1]);
      expect(difference(value.legacyNormal, value.expectedNormal)).toBeGreaterThan(1);
      expect(Math.max(...value.matrix.map(Math.abs))).toBe(Math.fround(1e-5));
    }
    near(tinyTangent!.legacyTangent, [1, 0, 0, 1]); near(tinyTangent!.expectedTangent, [0, 0, -1, 1]);
    expect(difference(tinyTangent!.legacyTangent, tinyTangent!.expectedTangent)).toBeGreaterThan(1);
    expect(tinyReflection!.legacyTangent[3]).toBe(1); expect(tinyReflection!.expectedTangent[3]).toBe(-1);
  });
});
