import { StrataError } from '../errors.js';
import type { ImportedAsset, ImportedMaterial, ImportedImage, ImportedPrimitive, ImportedVec3 } from '../imported/imported-types.js';

export interface MeshGeometry {
  readonly name: string;
  /** Object-local position3, normal3, UV2, tangent4, linear color4; 16 floats per vertex. */
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
  readonly material: number;
}
export interface MeshAssetOptions {
  readonly meshes: readonly MeshGeometry[];
  readonly materials: readonly ImportedMaterial[];
  readonly images?: readonly ImportedImage[];
  readonly maxTextureDimension?: number;
}

/** Copy a fixed-topology conventional scene into Core's shared PBR geometry contract.
 * No glTF parsing, automatic rescaling, network access or GPU access. Each mesh is
 * one independent root; imported.transforms supplies its per-frame world matrix.
 * Material and image compatibility are checked by setScene before commitment.
 */
export function createMeshAsset(options: MeshAssetOptions): ImportedAsset {
  const fail = (message: string): never => { throw new StrataError('INVALID_OPTIONS', `Mesh asset: ${message}`); };
  if (!options || !Array.isArray(options.meshes) || options.meshes.length < 1 || options.meshes.length > 4096
    || !Array.isArray(options.materials) || options.materials.length < 1 || options.materials.length > 4096
    || (options.images !== undefined && (!Array.isArray(options.images) || options.images.length > 1024))) fail('bounded meshes/materials/images are required.');
  const images = options.images ?? [];
  const maxTextureDimension = options.maxTextureDimension ?? 2048;
  if (!Number.isSafeInteger(maxTextureDimension) || maxTextureDimension < 1 || maxTextureDimension > 16384) fail('invalid texture dimension cap.');
  let geometryBytes = 0, encodedBytes = 0;
  // Check the aggregate before copying any potentially large payload.
  for (const mesh of options.meshes) {
    if (!mesh || typeof mesh.name !== 'string' || mesh.name.length > 1024 || !(mesh.vertices instanceof Float32Array)
      || !(mesh.vertices.buffer instanceof ArrayBuffer)
      || !(mesh.indices instanceof Uint32Array) || !(mesh.indices.buffer instanceof ArrayBuffer) || mesh.vertices.length === 0 || mesh.vertices.length % 16
      || mesh.indices.length === 0 || mesh.indices.length % 3
      || !Number.isInteger(mesh.material) || mesh.material < 0 || mesh.material >= options.materials.length) fail('invalid mesh layout or material reference.');
    geometryBytes += mesh.vertices.byteLength + mesh.indices.byteLength;
  }
  for (const image of images) {
    if (!image || !(image.bytes instanceof Uint8Array) || !(image.bytes.buffer instanceof ArrayBuffer)) fail('image bytes are required.');
    encodedBytes += image.bytes.byteLength;
  }
  if (geometryBytes > 128 * 1024 * 1024 || encodedBytes > 128 * 1024 * 1024) fail('source geometry and encoded images each have a 128 MiB limit.');
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const primitives: ImportedPrimitive[] = options.meshes.map((mesh, node) => {
    if (!mesh.vertices.every(Number.isFinite) || mesh.indices.some(index => index >= mesh.vertices.length / 16)) fail('nonfinite vertex or out-of-range index.');
    const vertices = mesh.vertices.slice(), indices = mesh.indices.slice();
    for (let offset = 0; offset < vertices.length; offset += 16) for (let axis = 0; axis < 3; axis++) {
      const value = vertices[offset + axis]!;
      if (Math.abs(value) > 1024) fail('local positions must be within 1024 units; choose application units explicitly.');
      min[axis] = Math.min(min[axis]!, value); max[axis] = Math.max(max[axis]!, value);
    }
    return { name: mesh.name, vertices, indices, material: mesh.material, deformation: { node, vertices } };
  });
  const bounds = { min: min as ImportedVec3, max: max as ImportedVec3 };
  return { version: 1, sourceUrl: 'strata:mesh-asset', primitives,
    materials: structuredClone(options.materials), images: images.map(image => ({ name: image.name, mimeType: image.mimeType, width: image.width, height: image.height, bytes: image.bytes.slice() })), bounds, sourceBounds: bounds,
    normalization: { scale: 1, translation: [0, 0, 0] }, maxTextureDimension, warnings: [], clips: [],
    rig: { nodes: primitives.map(() => ({ parent: null, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] })), skins: [] },
    stats: { meshInstances: primitives.length, primitives: primitives.length, vertices: primitives.reduce((sum, p) => sum + p.vertices.length / 16, 0),
      triangles: primitives.reduce((sum, p) => sum + p.indices.length / 3, 0), materials: options.materials.length, images: images.length,
      encodedBytes, geometryBytes, skinnedMeshInstances: 0, animationClips: 0 } };
}
