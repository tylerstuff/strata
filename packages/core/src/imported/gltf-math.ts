import { gltfError, vector } from './gltf-accessor.js';
import type { GltfObject } from './gltf-accessor.js';

export const identityMatrix = (): Float64Array<ArrayBuffer> => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
export function multiplyGltfMatrices(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array<ArrayBuffer> {
  const result = new Float64Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) result[column * 4 + row]! += a[k * 4 + row]! * b[column * 4 + k]!;
  if (!result.every(Number.isFinite)) gltfError('Hierarchy transform overflow.'); return result;
}
export function nodeMatrix(node: GltfObject): Float64Array<ArrayBuffer> {
  if (node.matrix !== undefined) {
    if (node.translation !== undefined || node.rotation !== undefined || node.scale !== undefined) gltfError('A node cannot mix matrix and TRS.');
    const result = new Float64Array(vector(node.matrix, 16, 'node.matrix')); affine(result); return result;
  }
  const t = vector(node.translation ?? [0, 0, 0], 3, 'node.translation'); const s = vector(node.scale ?? [1, 1, 1], 3, 'node.scale');
  const q = vector(node.rotation ?? [0, 0, 0, 1], 4, 'node.rotation'); const length = Math.hypot(...q);
  if (length < 1e-12) gltfError('Node rotation is a zero quaternion.');
  const [x, y, z, w] = q.map(value => value / length) as [number, number, number, number];
  return new Float64Array([
    (1 - 2 * (y * y + z * z)) * s[0]!, (2 * (x * y + z * w)) * s[0]!, (2 * (x * z - y * w)) * s[0]!, 0,
    (2 * (x * y - z * w)) * s[1]!, (1 - 2 * (x * x + z * z)) * s[1]!, (2 * (y * z + x * w)) * s[1]!, 0,
    (2 * (x * z + y * w)) * s[2]!, (2 * (y * z - x * w)) * s[2]!, (1 - 2 * (x * x + y * y)) * s[2]!, 0,
    t[0]!, t[1]!, t[2]!, 1,
  ]);
}
export function affine(matrix: ArrayLike<number>): void {
  if (matrix.length !== 16 || Array.from(matrix).some(value => !Number.isFinite(value)) || matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) gltfError('Transforms must be finite affine matrices.');
}
export function transformDirection(matrix: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] {
  return [matrix[0]! * x + matrix[4]! * y + matrix[8]! * z, matrix[1]! * x + matrix[5]! * y + matrix[9]! * z, matrix[2]! * x + matrix[6]! * y + matrix[10]! * z];
}
export function unit(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z); if (!Number.isFinite(length) || length < 1e-20) gltfError('Degenerate normal/tangent or transform.');
  return [x / length, y / length, z / length];
}
/** Cofactors form inverse-transpose; tangent handedness uses the same determinant. */
export function normalMatrix(matrix: ArrayLike<number>): { matrix: Float64Array<ArrayBuffer>; sign: number } {
  const a = matrix[0]!, b = matrix[4]!, c = matrix[8]!, d = matrix[1]!, e = matrix[5]!, f = matrix[9]!, g = matrix[2]!, h = matrix[6]!, i = matrix[10]!;
  const det = a * (e * i - f * h) + b * (f * g - d * i) + c * (d * h - e * g);
  if (!Number.isFinite(det) || det === 0) gltfError('A mesh/skin transform has a singular normal matrix.');
  const result = identityMatrix();
  result.set([(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, 0,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, 0,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det, 0], 0);
  if (!result.every(Number.isFinite)) gltfError('Normal matrix overflow.'); return { matrix: result, sign: Math.sign(det) };
}
