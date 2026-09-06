import { StrataError } from '../errors.js';
import { generateTangents } from './mesh-tangents-internal.js';

/** Snapshot mesh vertices and derive UV-aligned tangent4 attributes for normal maps.
 * Run at asset preparation, never per frame. Split vertices at UV/normal seams,
 * including mirrored islands. Degenerate UVs receive a perpendicular fallback.
 * This is the loader's UV derivative algorithm, not exact MikkTSpace.
 */
export async function prepareMeshTangents(
  vertices: Float32Array<ArrayBuffer>, indices: Uint32Array<ArrayBuffer>,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Float32Array<ArrayBuffer>> {
  const fail = (message: string): never => { throw new StrataError('INVALID_OPTIONS', `Mesh tangents: ${message}`); };
  if (!options || typeof options !== 'object' || (options.signal !== undefined && (!options.signal || typeof options.signal.aborted !== 'boolean' || typeof options.signal.addEventListener !== 'function'))) fail('invalid preparation options.');
  if (!(vertices instanceof Float32Array) || !(vertices.buffer instanceof ArrayBuffer)
    || !(indices instanceof Uint32Array) || !(indices.buffer instanceof ArrayBuffer)
    || vertices.length === 0 || vertices.length % 16 || indices.length === 0 || indices.length % 3) fail('expected interleaved mesh vertices and triangle indices.');
  // Includes owned copies and the six-double accumulation buffer.
  if (vertices.byteLength + indices.byteLength + vertices.length / 16 * 48 > 128 * 1024 * 1024) fail('preparation exceeds the 128 MiB working budget.');
  if (options.signal?.aborted) throw new StrataError('SCENE_LOAD_ABORTED', 'Mesh tangent preparation aborted.');
  if (!vertices.every(Number.isFinite) || indices.some(i => i >= vertices.length / 16)) fail('nonfinite attribute or invalid index.');
  for (let at = 0; at < vertices.length; at += 16) {
    if (Math.abs(Math.hypot(vertices[at + 3]!, vertices[at + 4]!, vertices[at + 5]!) - 1) > .001) fail('normals must be unit length.');
  }
  const result = vertices.slice(), ownedIndices = indices.slice();
  await generateTangents(result, ownedIndices, options.signal);
  if (!result.every(Number.isFinite)) fail('tangent accumulation overflowed.');
  return result;
}
