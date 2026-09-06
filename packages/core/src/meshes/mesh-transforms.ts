import { StrataError } from '../errors.js';

/** Complete root-world palette. Validate before retaining or uploading any matrix. */
export function snapshotMeshTransforms(input: unknown, count: number): Float32Array<ArrayBuffer> {
  const fail = (): never => { throw new StrataError('INVALID_OPTIONS', 'Mesh transforms require one finite, invertible column-major affine matrix per root mesh (maximum 4096).'); };
  if (!Number.isInteger(count) || count < 1 || count > 4096
    || (!(input instanceof Float32Array) && !(input instanceof Float64Array))
    || (typeof SharedArrayBuffer !== 'undefined' && input.buffer instanceof SharedArrayBuffer) || input.length !== count * 16) fail();
  const values = input as Float32Array | Float64Array;
  const result = new Float32Array(values);
  for (let offset = 0; offset < result.length; offset += 16) {
    const m = result.subarray(offset, offset + 16);
    if (!m.every(Number.isFinite) || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) fail();
    const determinant = m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!)
      - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) fail();
  }
  return result;
}
