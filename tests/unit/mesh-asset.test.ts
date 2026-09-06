import { describe, expect, it } from 'vitest';
import { createMeshAsset } from '../../packages/core/src/meshes/mesh-asset.js';
import { snapshotMeshTransforms } from '../../packages/core/src/meshes/mesh-transforms.js';
import type { ImportedMaterial } from '../../packages/core/src/imported/imported-types.js';
const material: ImportedMaterial = { name: 'matte', baseColorFactor: [.8, .2, .1, 1], metallicFactor: 0, roughnessFactor: .8,
  emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1, occlusionStrength: 1, alphaMode: 'OPAQUE', alphaCutoff: .5, doubleSided: false };
const mesh = () => ({ name: 'triangle', material: 0, indices: new Uint32Array([0, 1, 2]),
  vertices: new Float32Array([[0, 0, 0], [2, 0, 0], [0, 3, 0]].flatMap(p => [...p, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1])) });
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
describe('conventional mesh data boundary', () => {
  it('preserves application units and snapshots reusable geometry, material and bounds', () => {
    const a = mesh(), b = mesh(); const input = { meshes: [a, b], materials: [structuredClone(material)] };
    const result = createMeshAsset(input);
    a.vertices.fill(99); a.indices.fill(2); (input.materials[0]! as { name: string }).name = 'changed';
    expect(result.primitives[0]!.vertices[0]).toBe(0);
    expect(result.primitives[0]!.indices).toEqual(new Uint32Array([0, 1, 2]));
    expect(result.materials[0]!.name).toBe('matte');
    expect(result.bounds).toEqual({ min: [0, 0, 0], max: [2, 3, 0] });
    expect(result.normalization).toEqual({ scale: 1, translation: [0, 0, 0] });
    expect(result.primitives.map(p => p.deformation!.node)).toEqual([0, 1]);
  });
  it('owns compressed mip payloads and counts them in encoded source bytes', () => {
    const mips = [new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)];
    const image = { name: 'compressed', mimeType: 'image/png' as const, width: 4, height: 4,
      bytes: new Uint8Array([1, 2, 3]), compressed: { format: 'bc1-rgba-unorm' as const, mips } };
    const result = createMeshAsset({ meshes: [mesh()], materials: [material], images: [image] });
    mips[0]!.fill(255); image.bytes.fill(255);
    expect(result.images[0]!.compressed!.mips[0]![0]).toBe(0);
    expect(result.images[0]!.bytes[0]).toBe(1);
    expect(result.stats.encodedBytes).toBe(27);
    expect(() => createMeshAsset({ meshes: [mesh()], materials: [material], images: [{ ...image,
      compressed: { ...image.compressed, mips: mips.slice(1) } }] })).toThrow(/complete mip chain/);
  });
  it('rejects malformed indices, attributes, references and coordinate limits', () => {
    for (const corrupt of [(m: ReturnType<typeof mesh>) => { m.indices[2] = 3; },
      (m: ReturnType<typeof mesh>) => { m.vertices[1] = NaN; },
      (m: ReturnType<typeof mesh>) => { m.material = -1; },
      (m: ReturnType<typeof mesh>) => { m.vertices[0] = 2048; }]) {
      const m = mesh(); corrupt(m); expect(() => createMeshAsset({ meshes: [m], materials: [material] })).toThrow();
    }
  });
  it('accepts explicitly permitted reflections and rejects unsupported or invalid palettes', () => {
    const m = identity(); m[0] = -2; m[12] = 4;
    expect(() => snapshotMeshTransforms(m, 1)).toThrow(/double-sided/);
    const snapshot = snapshotMeshTransforms(m, 1, [true]); m[12] = 99; expect(snapshot[12]).toBe(4);
    expect(() => snapshotMeshTransforms(snapshot, 2)).toThrow();
    for (const [index, value] of [[0, 0], [3, .1], [15, 0], [12, Infinity]]) {
      const bad = identity(); bad[index!] = value!; expect(() => snapshotMeshTransforms(bad, 1)).toThrow();
    }
  });
});
