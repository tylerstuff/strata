/** Generated numerical fixtures only. No engine imports, shaders or external assets. */
export type TransformVec3 = readonly [number, number, number];
export type TransformVec4 = readonly [number, number, number, number];
/** Column-major linear transform, exactly as uploaded to a mat3x3<f32>. */
export type TransformMatrix3 = readonly [number, number, number, number, number, number, number, number, number];

interface TransformInput {
  readonly name: string;
  readonly matrix: TransformMatrix3;
  readonly normal: TransformVec3;
  readonly tangent: TransformVec4;
}
export interface NonsingularTransformCase extends TransformInput {
  readonly expectFiniteOnly?: false;
  readonly expectedNormal: TransformVec3;
  readonly expectedTangent: TransformVec4;
}
export interface DegenerateTransformCase extends TransformInput {
  /** No unique inverse-transpose frame: require finite unit, orthogonal axes and |w|=1. */
  readonly expectFiniteOnly: true;
}
export type TransformCase = NonsingularTransformCase | DegenerateTransformCase;

const vector = (v: readonly number[]): TransformVec3 => [v[0]!, v[1]!, v[2]!];
const unit = (v: TransformVec3): TransformVec3 => {
  const length = Math.hypot(...v);
  if (!(length > 0) || !Number.isFinite(length)) throw new Error('The reference direction is not finite and nonzero.');
  return [v[0] / length, v[1] / length, v[2] / length];
};
const f32Vector = (v: TransformVec3): TransformVec3 => vector(v.map(Math.fround));
const f32Matrix = (m: readonly number[]): TransformMatrix3 => {
  if (m.length !== 9) throw new Error('A fixture matrix needs nine components.');
  return m.map(Math.fround) as unknown as TransformMatrix3;
};
const dot = (a: TransformVec3, b: TransformVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const multiply = (m: TransformMatrix3, v: TransformVec3): TransformVec3 => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];

/**
 * Double-precision partial-pivot Gaussian elimination of A^T x = n.
 * No cross products, adjugate/cofactor formula, determinant product, f32
 * arithmetic emulation, or proposed production normal helper participates.
 * Sign follows row swaps and pivot signs, including very anisotropic matrices.
 */
function solveNormal(matrix: TransformMatrix3, normal: TransformVec3): { normal: TransformVec3; sign: number } {
  const rows = Array.from({ length: 3 }, (_, row) => [matrix[row * 3]!, matrix[row * 3 + 1]!, matrix[row * 3 + 2]!, normal[row]!]);
  let sign = 1;
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    if (rows[pivot]![column] === 0) throw new Error('A nonsingular fixture became singular after f32 conversion.');
    if (pivot !== column) { [rows[pivot], rows[column]] = [rows[column]!, rows[pivot]!]; sign *= -1; }
    const diagonal = rows[column]![column]!;
    sign *= Math.sign(diagonal);
    for (let entry = column; entry < 4; entry++) rows[column]![entry] = rows[column]![entry]! / diagonal;
    for (let row = column + 1; row < 3; row++) {
      const factor = rows[row]![column]!;
      for (let entry = column; entry < 4; entry++) rows[row]![entry] = rows[row]![entry]! - factor * rows[column]![entry]!;
    }
  }
  const x = [0, 0, 0];
  for (let row = 2; row >= 0; row--) {
    let value = rows[row]![3]!;
    for (let column = row + 1; column < 3; column++) value -= rows[row]![column]! * x[column]!;
    x[row] = value;
  }
  return { normal: unit(vector(x)), sign };
}

function nonsingular(name: string, matrixInput: readonly number[], normalInput: TransformVec3, tangentInput: TransformVec4): NonsingularTransformCase {
  const matrix = f32Matrix(matrixInput), normal = f32Vector(normalInput);
  const tangent = tangentInput.map(Math.fround) as unknown as TransformVec4;
  // Remove only the positive common scale in double precision. The reference
  // still uses the exact uploaded f32 matrix, not its unquantized generator.
  const maximum = Math.max(...matrix.map(Math.abs));
  const scaled = matrix.map(value => value / maximum) as unknown as TransformMatrix3;
  const solved = solveNormal(scaled, normal);
  const rawTangent = multiply(scaled, vector(tangent));
  const projection = dot(rawTangent, solved.normal);
  const expectedTangent = unit(vector(rawTangent.map((value, axis) => value - solved.normal[axis]! * projection)));
  return { name, matrix, normal, tangent, expectedNormal: solved.normal,
    expectedTangent: [...expectedTangent, tangent[3] * solved.sign] };
}

const normal = unit([2, -1, 3]);
const tangent = unit([3, 0, -2]);
const rotateY: TransformMatrix3 = [0, 0, -1, 0, 1, 0, 1, 0, 0];
const rotateZ: TransformMatrix3 = [0, 1, 0, -1, 0, 0, 0, 0, 1];
const rotation: TransformMatrix3 = [Math.cos(.63), 0, -Math.sin(.63), 0, 1, 0, Math.sin(.63), 0, Math.cos(.63)];
const stretchShear: TransformMatrix3 = [1.5, .125, -.25, .375, .75, .125, -.125, .25, 2];
const rotatedShear = vectorColumns(rotation, stretchShear);
function vectorColumns(left: TransformMatrix3, right: TransformMatrix3): TransformMatrix3 {
  return [0, 3, 6].flatMap(offset => multiply(left, vector(right.slice(offset, offset + 3)))) as unknown as TransformMatrix3;
}
const reflected = (m: TransformMatrix3): TransformMatrix3 => m.map((value, index) => index % 3 === 0 ? -value : value) as unknown as TransformMatrix3;
const families: readonly [string, TransformMatrix3, number][] = [
  ['identity', [1, 0, 0, 0, 1, 0, 0, 0, 1], 1],
  ['quarter-turn-y', rotateY, 1],
  ['signed-quarter-turn-z', rotateZ, -1],
  ['rotation', rotation, -1],
  ['reflected-rotation', reflected(rotation), -1],
  ['rotated-nonuniform-shear', rotatedShear, 1],
  ['reflected-nonuniform-shear', reflected(rotatedShear), 1],
];
const scales = [1e-30, 1e-10, 1e-5, 1, 1e10, 1e30] as const;

export const importedTransformCases: readonly NonsingularTransformCase[] = [
  ...families.flatMap(([name, matrix, sign]) => scales.map(scale =>
    nonsingular(`${name}/scale-${scale}`, matrix.map(value => value * scale), normal, [...tangent, sign]))),
  // The normal's Y cofactor is representable in f32 while the determinant
  // product underflows. The expected reflection sign must remain negative.
  nonsingular('anisotropic-reflection/determinant-underflow', [-1, 0, 0, 0, 2 ** -80, 0, 0, 0, 2 ** -80], [0, 1, 0], [1, 0, 0, 1]),
];

const blend = (a: TransformMatrix3, b: TransformMatrix3, weight: number) =>
  a.map((value, index) => Math.fround(Math.fround(value * weight) + Math.fround(b[index]! * (1 - weight))));
const identity: TransformMatrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const degenerate = (name: string, matrix: readonly number[], n: TransformVec3, t: TransformVec4): DegenerateTransformCase =>
  ({ name, matrix: f32Matrix(matrix), normal: f32Vector(n), tangent: t.map(Math.fround) as unknown as TransformVec4, expectFiniteOnly: true });

export const degenerateTransformCases: readonly DegenerateTransformCase[] = [
  degenerate('zero/cancellation-opposite-transforms', blend(identity, identity.map(value => -value) as unknown as TransformMatrix3, .5), [0, 0, 1], [1, 0, 0, 1]),
  degenerate('rank1/half-turn-blend', blend(identity, [1, 0, 0, 0, -1, 0, 0, 0, -1], .5), [0, 0, 1], [1, 0, 0, -1]),
  degenerate('rank2/reflection-blend', blend(identity, [1, 0, 0, 0, 1, 0, 0, 0, -1], .5), [0, 0, 1], [1, 0, 0, 1]),
  degenerate('rank1/off-axis', [1, 2, -1, 2, 4, -2, -1, -2, 1], normal, [...tangent, -1]),
  degenerate('rank2/tangent-collapses', [0, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 1], [1, 0, 0, -1]),
  degenerate('rank1/tangent-parallel-to-fallback-normal', [0, 0, 1, 0, 0, 0, 0, 0, 0], [0, 0, 1], [1, 0, 0, 1]),
  // Valid orthogonal authored inputs; a rank-one transform sends the tangent
  // almost along the fallback normal. Subtractive Gram-Schmidt can lose the
  // transverse direction here even when its squared-length test passes.
  ...[2e-6, 1e-5].map(delta => degenerate(`rank1/tangent-near-parallel-${delta}`,
    [1 + delta, 1 - delta, 1, 0, 0, 0, 0, 0, 0], unit([1, 1, 1]), [...unit([1, -1, 0]), 1])),
  degenerate('rank2/tiny-reflection-blend', blend(identity, [1, 0, 0, 0, 1, 0, 0, 0, -1], .5).map(value => value * 1e-30), [0, 0, 1], [1, 0, 0, 1]),
  degenerate('rank1/large-half-turn-blend', blend(identity, [1, 0, 0, 0, -1, 0, 0, 0, -1], .5).map(value => value * 1e30), [0, 0, 1], [1, 0, 0, -1]),
];

export interface LegacyTransformWitness extends NonsingularTransformCase {
  /** Original vertex formula only, before the fragment's Gram-Schmidt step. */
  readonly legacyNormal: TransformVec3;
  readonly legacyTangent: TransformVec4;
}
// This explicitly labeled negative control mirrors the OLD formula, never the
// production fix or the oracle. Round individual operations to f32 so the fixed
// 1e-16 squared-length threshold and determinant underflow are observable on CPU.
function legacyWitness(sample: NonsingularTransformCase): LegacyTransformWitness {
  const f = Math.fround;
  const product = (a: number, b: number) => f(a * b);
  const sum = (a: number, b: number, c: number) => f(f(a + b) + c);
  const cross = (a: TransformVec3, b: TransformVec3): TransformVec3 => [
    f(product(a[1], b[2]) - product(a[2], b[1])), f(product(a[2], b[0]) - product(a[0], b[2])), f(product(a[0], b[1]) - product(a[1], b[0])),
  ];
  const squared = (v: TransformVec3) => sum(product(v[0], v[0]), product(v[1], v[1]), product(v[2], v[2]));
  const transform = (columns: readonly TransformVec3[], v: TransformVec3): TransformVec3 => vector([0, 1, 2].map(row =>
    sum(product(columns[0]![row]!, v[0]), product(columns[1]![row]!, v[1]), product(columns[2]![row]!, v[2]))));
  const columns = [0, 3, 6].map(offset => vector(sample.matrix.slice(offset, offset + 3)));
  const cofactors = [cross(columns[1]!, columns[2]!), cross(columns[2]!, columns[0]!), cross(columns[0]!, columns[1]!)];
  const determinant = sum(...columns[0]!.map((value, axis) => product(value, cofactors[0]![axis]!)) as [number, number, number]);
  const sign = determinant >= 0 ? 1 : -1;
  const transformed = vector(transform(cofactors, sample.normal).map(value => product(value, sign)));
  const tangentRaw = transform(columns, vector(sample.tangent));
  const legacyNormal = unit(squared(transformed) > f(1e-16) ? transformed : sample.normal);
  const legacyTangent = unit(squared(tangentRaw) > f(1e-16) ? tangentRaw : vector(sample.tangent));
  return { ...sample, legacyNormal, legacyTangent: [...legacyTangent, sample.tangent[3] * sign] };
}
export const legacyTransformWitnesses: readonly LegacyTransformWitness[] = [
  legacyWitness(nonsingular('legacy/rotated-normal-1e-5', rotateY.map(value => value * 1e-5), [0, 0, 1], [1, 0, 0, 1])),
  legacyWitness(nonsingular('legacy/reflected-normal-1e-5', reflected(rotateY).map(value => value * 1e-5), [0, 0, 1], [1, 0, 0, -1])),
  legacyWitness(nonsingular('legacy/tiny-tangent-1e-10', rotateY.map(value => value * 1e-10), [0, 0, 1], [1, 0, 0, 1])),
  legacyWitness(nonsingular('legacy/reflection-sign-1e-30', reflected(rotateY).map(value => value * 1e-30), [0, 0, 1], [1, 0, 0, 1])),
];
