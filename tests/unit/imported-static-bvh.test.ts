import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrataError } from '../../packages/core/src/errors.js';
import { loadWasmRuntime } from '../../packages/core/src/internal/wasm-runtime.js';
import type { StaticBvhResult } from '../../packages/core/src/internal/protocol.js';
import type { ImportedAsset, ImportedMaterial, ImportedPrimitive } from '../../packages/core/src/imported/imported-types.js';
import { loadGltf } from '../../packages/core/src/imported/gltf-loader.js';
import { preflightImportedStaticTrace, prepareImportedStaticTrace, validateImportedStaticBvh } from '../../packages/core/src/imported/static-trace-data.js';
import { estimateStaticBvhWorkingBytes, staticBvhNodeCapacity } from '../../packages/core/src/imported/static-trace-format.js';

// All geometry and attributes below are generated. No external model is read.
type Vec3 = readonly [number, number, number];
interface SourceTriangle { id: number; indices: readonly [number, number, number]; points: readonly [Vec3, Vec3, Vec3] }
interface Ray { origin: Vec3; direction: Vec3; tMin: number; tMax: number }
interface Hit { id: number; distance: number; barycentric: Vec3; normal: Vec3 }
const limits = { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 };
const material = (): ImportedMaterial => ({ name: 'Generated lit opaque material', baseColorFactor: [0.8, 0.6, 0.4, 1],
  metallicFactor: 0, roughnessFactor: 0.8, emissiveFactor: [0, 0, 0], emissiveStrength: 1,
  normalScale: 1, occlusionStrength: 1, alphaMode: 'OPAQUE', alphaCutoff: 0.5, doubleSided: false });

function primitive(points: readonly Vec3[], indices: readonly number[], name: string): ImportedPrimitive {
  const vertices = new Float32Array(points.length * 16);
  points.forEach((point, index) => vertices.set([
    ...point, 0, 0, 1, index / 32, 1 - index / 64, 1, 0, 0, 1,
    (index % 7) / 8, (index % 5) / 8, (index % 3) / 4, 1,
  ], index * 16));
  return { name, vertices, indices: new Uint32Array(indices), material: 0 };
}

function asset(primitives: readonly ImportedPrimitive[]): ImportedAsset {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let vertices = 0; let triangles = 0; let geometryBytes = 0;
  for (const mesh of primitives) {
    vertices += mesh.vertices.length / 16; triangles += mesh.indices.length / 3;
    geometryBytes += mesh.vertices.byteLength + mesh.indices.byteLength;
    for (let at = 0; at < mesh.vertices.length; at += 16) for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, mesh.vertices[at + axis]!);
      max[axis] = Math.max(max[axis]!, mesh.vertices[at + axis]!);
    }
  }
  return { version: 1, sourceUrl: 'https://fixtures.test/generated-static.gltf', primitives, materials: [material()], images: [],
    sourceBounds: { min, max }, bounds: { min, max }, normalization: { scale: 1, translation: [0, 0, 0] },
    maxTextureDimension: 2048, warnings: [], clips: [],
    stats: { meshInstances: primitives.length, primitives: primitives.length, vertices, triangles, materials: 1, images: 0,
      encodedBytes: 0, geometryBytes, skinnedMeshInstances: 0, animationClips: 0 } };
}

function smallSource(): ImportedAsset {
  return asset([
    primitive([
      [0, 0, 0], [0.5, 0, 0.5], [0, 0.5, 0.5],
      [0.625, 0, -0.5], [1, 0, -0.25], [0.625, 0.375, -0.25],
      [-1, 0, -0.25], [-0.625, 0, 0], [-1, 0.375, 0],
    ], [3, 4, 5, 0, 1, 2, 6, 7, 8, 0, 1, 2], 'Shuffled shared vertices'),
    primitive([
      [0.5, 0.625, 0], [0.75, 0.625, 0.25], [0.5, 1, 0.25],
      [-0.75, 0.625, 0], [-0.5, 0.625, 0.25], [-0.75, 1, 0.25],
      [0, 0, -0.5], [0.5, 0, 0], [0, 0.5, 0],
    ], [0, 1, 2, 3, 4, 5, 6, 7, 8], 'Local indices restart at zero'),
  ]);
}

function tiledSource(count = 5003): ImportedAsset {
  const columns = 128; const rows = Math.ceil(count / columns); const points: Vec3[] = [];
  for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
    const x = column / 64 - 1, y = row / 64;
    points.push([x, y, x / 8 + y / 4]);
  }
  const indices: number[] = [];
  for (let id = 0; id < count; id++) {
    // 127 and 5003 are coprime; source IDs intentionally disagree with spatial order.
    const cell = (id * 127) % count; const row = Math.floor(cell / columns), column = cell % columns;
    const first = row * (columns + 1) + column;
    indices.push(first, first + 1, first + columns + 1);
  }
  return asset([primitive(points, indices, '5003 indexed sloping triangles')]);
}

function sourceTriangles(input: ImportedAsset): SourceTriangle[] {
  const triangles: SourceTriangle[] = []; let vertexBase = 0;
  for (const mesh of input.primitives) {
    for (let at = 0; at < mesh.indices.length; at += 3) {
      const local = [mesh.indices[at]!, mesh.indices[at + 1]!, mesh.indices[at + 2]!] as const;
      triangles.push({ id: triangles.length, indices: local.map(index => index + vertexBase) as unknown as Vec3,
        points: local.map(index => [...mesh.vertices.subarray(index * 16, index * 16 + 3)] as unknown as Vec3) as unknown as [Vec3, Vec3, Vec3] });
    }
    vertexBase += mesh.vertices.length / 16;
  }
  return triangles;
}

const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Independent source oracle: plane intersection and projected signed areas, not the production Moller routine. */
function sourceIntersection(triangle: SourceTriangle, ray: Ray): Hit | undefined {
  const [a, b, c] = triangle.points; const n = cross(subtract(b, a), subtract(c, a));
  const divisor = dot(n, ray.direction);
  if (divisor === 0) return undefined;
  const distance = dot(n, subtract(a, ray.origin)) / divisor;
  if (distance < ray.tMin || distance > ray.tMax) return undefined;
  const point: Vec3 = [ray.origin[0] + distance * ray.direction[0], ray.origin[1] + distance * ray.direction[1], ray.origin[2] + distance * ray.direction[2]];
  const omit = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
  const axes = [0, 1, 2].filter(axis => axis !== omit); const x = axes[0]!, y = axes[1]!;
  const area = (p: Vec3, q: Vec3, r: Vec3): number => (q[x]! - p[x]!) * (r[y]! - p[y]!) - (q[y]! - p[y]!) * (r[x]! - p[x]!);
  const denominator = area(a, b, c);
  const barycentric: Vec3 = [area(point, b, c) / denominator, area(point, c, a) / denominator, area(point, a, b) / denominator];
  if (barycentric.some(weight => weight < -1e-12 || weight > 1 + 1e-12)) return undefined;
  const length = Math.hypot(...n);
  return { id: triangle.id, distance, barycentric, normal: [n[0] / length, n[1] / length, n[2] / length] };
}

function nearest(triangles: readonly SourceTriangle[], ray: Ray): Hit | undefined {
  let closest: Hit | undefined;
  for (const triangle of triangles) {
    const hit = sourceIntersection(triangle, ray);
    if (hit && (!closest || hit.distance < closest.distance || (hit.distance === closest.distance && hit.id < closest.id))) closest = hit;
  }
  return closest;
}

function vector(view: DataView, offset: number): Vec3 {
  return [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)];
}

/** Test-local packed-tree reader checks construction/culling. This does not substitute for a WGSL kernel test. */
function tracePacked(result: StaticBvhResult, ray: Ray): Hit | undefined {
  const nodes = new DataView(result.nodes), triangles = new DataView(result.triangles);
  const pending = [0]; let closest: Hit | undefined;
  while (pending.length) {
    const node = pending.pop()!; const offset = node * 32;
    const min = vector(nodes, offset), max = vector(nodes, offset + 16);
    let entry = ray.tMin, exit = closest?.distance ?? ray.tMax;
    for (let axis = 0; axis < 3; axis++) {
      if (ray.direction[axis] === 0) {
        if (ray.origin[axis]! < min[axis]! || ray.origin[axis]! > max[axis]!) { entry = Infinity; break; }
      } else {
        const first = (min[axis]! - ray.origin[axis]!) / ray.direction[axis]!;
        const second = (max[axis]! - ray.origin[axis]!) / ray.direction[axis]!;
        entry = Math.max(entry, Math.min(first, second)); exit = Math.min(exit, Math.max(first, second));
      }
    }
    if (entry > exit) continue;
    const first = nodes.getUint32(offset + 12, true), count = nodes.getUint32(offset + 28, true);
    if (count === 0) { pending.push(first, first + 1); continue; }
    for (let index = first; index < first + count; index++) {
      const at = index * 64;
      const hit = sourceIntersection({ id: triangles.getUint32(at + 44, true), indices: [0, 0, 0],
        points: [vector(triangles, at), vector(triangles, at + 16), vector(triangles, at + 32)] }, ray);
      if (hit && (!closest || hit.distance < closest.distance || (hit.distance === closest.distance && hit.id < closest.id))) closest = hit;
    }
  }
  return closest;
}

function expectHit(actual: Hit | undefined, expected: Hit | undefined): void {
  expect(actual?.id).toBe(expected?.id);
  if (!actual || !expected) return;
  expect(actual.distance).toBeCloseTo(expected.distance, 7);
  actual.normal.forEach((value, axis) => expect(value).toBeCloseTo(expected.normal[axis]!, 6));
  actual.barycentric.forEach((value, axis) => expect(value).toBeCloseTo(expected.barycentric[axis]!, 6));
}

async function build(input: Awaited<ReturnType<typeof prepareImportedStaticTrace>>, quota = 257): Promise<StaticBvhResult> {
  const bytes = new Uint8Array(await readFile(new URL('../../target/wasm32-unknown-unknown/release/strata_runtime.wasm', import.meta.url)));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })));
  const runtime = await loadWasmRuntime('https://fixtures.test/strata_runtime.wasm'); const wasm = runtime.exports;
  const vertexCount = input.positions.length / 3, triangleCount = input.indices.length / 3;
  try {
    expect(wasm.strata_bvh_begin(vertexCount, triangleCount, 256 * 1024 * 1024)).toBe(0);
    new Float32Array(wasm.memory.buffer, wasm.strata_bvh_positions_ptr(), input.positions.length).set(input.positions);
    new Uint32Array(wasm.memory.buffer, wasm.strata_bvh_indices_ptr(), input.indices.length).set(input.indices);
    let status = 0, calls = 0;
    while (status === 0) {
      status = wasm.strata_bvh_step(quota);
      if (++calls > 1_000_000) throw new Error('Generated BVH failed to complete within the finite test work limit.');
    }
    expect(status).toBe(1);
    const nodeCount = wasm.strata_bvh_node_count();
    const copy = (start: number, count: number): ArrayBuffer => wasm.memory.buffer.slice(start, start + count);
    return { nodes: copy(wasm.strata_bvh_nodes_ptr(), nodeCount * 32), triangles: copy(wasm.strata_bvh_triangles_ptr(), triangleCount * 64),
      vertexCount, triangleCount, nodeCount, maxDepth: wasm.strata_bvh_max_depth(), workUnits: wasm.strata_bvh_work_units(),
      workingBytes: wasm.strata_bvh_working_bytes(), wasmMemoryBytes: wasm.memory.buffer.byteLength };
  } finally { wasm.strata_bvh_dispose(); wasm.strata_runtime_dispose(); }
}

function checkPackedSource(result: StaticBvhResult, source: readonly SourceTriangle[]): void {
  const nodes = new DataView(result.nodes), triangles = new DataView(result.triangles);
  const seenNodes = new Set<number>(), seenSlots = new Set<number>(), seenIds = new Set<number>();
  const pending = [{ node: 0, depth: 1 }]; let maximumDepth = 0;
  const inside = (point: Vec3, minimum: Vec3, maximum: Vec3): boolean => point.every((value, axis) => value >= minimum[axis]! && value <= maximum[axis]!);
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (node >= result.nodeCount || seenNodes.has(node)) throw new Error('Packed tree contains an invalid or repeated node.');
    seenNodes.add(node); maximumDepth = Math.max(maximumDepth, depth);
    const at = node * 32, first = nodes.getUint32(at + 12, true), count = nodes.getUint32(at + 28, true);
    const minimum = vector(nodes, at), maximum = vector(nodes, at + 16);
    if (!count) {
      for (const child of [first, first + 1]) {
        if (child >= result.nodeCount || !inside(vector(nodes, child * 32), minimum, maximum)
          || !inside(vector(nodes, child * 32 + 16), minimum, maximum)) throw new Error('Child bounds escape their parent.');
        pending.push({ node: child, depth: depth + 1 });
      }
    } else {
      if (count > 4 || first + count > source.length) throw new Error('Packed leaf exceeds its source range or four-triangle limit.');
      for (let slot = first; slot < first + count; slot++) {
        if (seenSlots.has(slot)) throw new Error('A packed triangle belongs to two leaves.');
        seenSlots.add(slot);
        const offset = slot * 64, id = triangles.getUint32(offset + 44, true), original = source[id];
        if (!original || seenIds.has(id)) throw new Error('Source triangle identity is missing, duplicated or invalid.');
        seenIds.add(id);
        expect(triangles.getUint32(offset + 12, true)).toBe(0);
        expect(triangles.getUint32(offset + 28, true)).toBe(original.indices[0]);
        expect(triangles.getFloat32(offset + 60, true)).toBe(0);
        for (let corner = 0; corner < 3; corner++) {
          const actual = vector(triangles, offset + corner * 16);
          expect(actual).toEqual(original.points[corner]);
          if (!inside(actual, minimum, maximum)) throw new Error('Leaf bounds exclude a source vertex.');
        }
        const n = cross(subtract(original.points[1], original.points[0]), subtract(original.points[2], original.points[0]));
        const length = Math.hypot(...n); const packedNormal = vector(triangles, offset + 48);
        packedNormal.forEach((value, axis) => expect(value).toBeCloseTo(n[axis]! / length, 6));
      }
    }
  }
  expect(seenNodes.size).toBe(result.nodeCount); expect(seenSlots.size).toBe(source.length); expect(seenIds.size).toBe(source.length);
  expect(maximumDepth).toBe(result.maxDepth);
}

afterEach(() => vi.unstubAllGlobals());

describe('static imported source preparation', () => {
  it('preserves indexed attributes and global triangle identity across primitive boundaries without detaching caller buffers', async () => {
    const input = smallSource(); const before = input.primitives.map(mesh => ({ vertices: mesh.vertices.slice(), indices: mesh.indices.slice() }));
    const prepared = await prepareImportedStaticTrace(input, limits);
    expect([...prepared.primitiveTriangleOffsets]).toEqual([0, 4, 7]);
    expect([...prepared.indices]).toEqual(sourceTriangles(input).flatMap(triangle => [...triangle.indices]));
    expect([...prepared.vertices]).toEqual(input.primitives.flatMap(mesh => [...mesh.vertices]));
    expect(prepared.positions.length).toBe(input.stats.vertices * 3);
    for (let index = 0; index < input.stats.vertices; index++) {
      expect([...prepared.positions.subarray(index * 3, index * 3 + 3)]).toEqual([...prepared.vertices.subarray(index * 16, index * 16 + 3)]);
    }
    input.primitives.forEach((mesh, index) => { expect(mesh.vertices).toEqual(before[index]!.vertices); expect(mesh.indices).toEqual(before[index]!.indices); });
    const retained = prepared.vertices.slice(); input.primitives[0]!.vertices.fill(0); input.primitives[0]!.indices.fill(0);
    expect(prepared.vertices).toEqual(retained);
    expect([...prepared.indices.slice(0, 6)]).toEqual([3, 4, 5, 0, 1, 2]);
  });

  it('rejects unsupported animation and material modes before preparing geometry', () => {
    const source = smallSource();
    const invalid: ImportedAsset[] = [
      { ...source, rig: { nodes: [], skins: [] } },
      { ...source, clips: [{ id: 'motion', name: 'Motion', duration: 1, channels: [] }] },
      { ...source, primitives: [{ ...source.primitives[0]!, deformation: { node: 0, vertices: source.primitives[0]!.vertices } }] },
      { ...source, materials: [{ ...material(), alphaMode: 'MASK' }] },
      { ...source, materials: [{ ...material(), unlit: true }] },
      { ...source, materials: [material(), material()], primitives: [source.primitives[0]!, { ...source.primitives[1]!, material: 1 }] },
      { ...source, primitives: [{ ...source.primitives[0]!, material: 1 }] },
      { ...source, primitives: [{ ...source.primitives[0]!, material: -1 }] },
      { ...source, primitives: [{ ...source.primitives[0]!, material: 0.5 }] },
    ];
    for (const input of invalid) expect(() => preflightImportedStaticTrace(input, limits)).toThrow(StrataError);
  });

  it('accepts unused default, MASK and unlit entries while selecting only the used material', async () => {
    const source = smallSource();
    for (const unused of [material(), { ...material(), alphaMode: 'MASK' as const }, { ...material(), unlit: true }]) {
      const input = { ...source, materials: [material(), unused] };
      expect(preflightImportedStaticTrace(input, limits).sourceMaterialIndex).toBe(0);
      const prepared = await prepareImportedStaticTrace(input, limits);
      expect(prepared.sourceMaterialIndex).toBe(0);
      expect(input.materials).toHaveLength(2); expect(input.materials[1]).toBe(unused);
    }
  });

  it('preserves a nonzero source material selection while remapping packed triangles to material zero', async () => {
    const source = smallSource(), selected = { ...material(), baseColorFactor: [0.125, 0.5, 0.875, 1] as const };
    const input = { ...source, materials: [{ ...material(), unlit: true }, selected, { ...material(), alphaMode: 'MASK' as const }],
      primitives: source.primitives.map(mesh => ({ ...mesh, material: 1 })) };
    expect(preflightImportedStaticTrace(input, limits).sourceMaterialIndex).toBe(1);
    const prepared = await prepareImportedStaticTrace(input, limits), result = await build(prepared);
    expect(prepared.sourceMaterialIndex).toBe(1); expect(input.materials[prepared.sourceMaterialIndex]).toBe(selected);
    await validateImportedStaticBvh(prepared, result);
    const packed = new DataView(result.triangles);
    for (let triangle = 0; triangle < result.triangleCount; triangle++) expect(packed.getUint32(triangle * 64 + 12, true)).toBe(0);
    expect(input.primitives.every(mesh => mesh.material === 1)).toBe(true);
  });

  it('accepts actual generated loader output containing its unused appended default material', async () => {
    const data = new Float32Array([0, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const document = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
      materials: [{ name: 'Only authored material', pbrMetallicRoughness: { metallicFactor: 0, baseColorFactor: [0.8, 0.6, 0.4, 1] } }],
      buffers: [{ byteLength: data.byteLength, uri: 'data:application/octet-stream;base64,' + Buffer.from(data.buffer).toString('base64') }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(document))));
    const input = await loadGltf('https://fixtures.test/one-material.gltf');
    expect(input.materials).toHaveLength(2); expect(input.primitives[0]!.material).toBe(0);
    const prepared = await prepareImportedStaticTrace(input, limits);
    expect(prepared.sourceMaterialIndex).toBe(0); expect(prepared.triangleCount).toBe(1);
  });

  it('rejects nonfinite geometry and attributes, malformed strides and out-of-range indices', async () => {
    for (const at of [0, 3, 6, 8, 12, 15]) for (const bad of [NaN, Infinity, -Infinity]) {
      const input = smallSource(); input.primitives[0]!.vertices[at] = bad;
      await expect(prepareImportedStaticTrace(input, limits)).rejects.toThrow(StrataError);
    }
    const source = smallSource();
    for (const broken of [
      { ...source.primitives[0]!, vertices: new Float32Array(17) },
      { ...source.primitives[0]!, indices: new Uint32Array([0, 1]) },
      { ...source.primitives[0]!, indices: new Uint32Array([0, 1, 99]) },
    ]) await expect(prepareImportedStaticTrace({ ...source, primitives: [broken] }, limits)).rejects.toThrow(StrataError);
  });

  it('preflights separate GPU bindings and bounded CPU work before allocation', () => {
    const input = smallSource(), plan = preflightImportedStaticTrace(input, limits);
    expect(() => preflightImportedStaticTrace(input, { ...limits, maxStorageBufferBindingSize: 63 })).toThrow(StrataError);
    expect(() => preflightImportedStaticTrace(input, { ...limits, maxBufferSize: 63 })).toThrow(StrataError);
    expect(() => preflightImportedStaticTrace(input, limits, { maxWorkingBytes: 1 })).toThrow(StrataError);
    expect(() => preflightImportedStaticTrace(input, limits, { maxPeakCpuBytes: 1 })).toThrow(StrataError);
    expect(() => preflightImportedStaticTrace(input, limits, { maxWorkingBytes: plan.workingBytes - 1 })).toThrow(StrataError);
    expect(() => preflightImportedStaticTrace(input, limits, { maxWorkingBytes: plan.workingBytes })).not.toThrow();
    expect(() => preflightImportedStaticTrace(input, limits, { maxPeakCpuBytes: plan.estimatedPeakCpuBytes - 1 })).toThrow(StrataError);
    expect(() => preflightImportedStaticTrace(input, { ...limits, maxStorageBufferBindingSize: input.stats.vertices * 64 - 1 })).toThrow(StrataError);
    expect(() => preflightImportedStaticTrace(input, { ...limits, maxStorageBufferBindingSize: input.stats.vertices * 64 })).not.toThrow();
    // Loader telemetry is not the source of allocation or traversal counts.
    expect(preflightImportedStaticTrace({ ...input, stats: { ...input.stats, vertices: 0, triangles: 0 } }, limits)).toMatchObject({ vertexCount: 18, triangleCount: 7 });
    expect(staticBvhNodeCapacity(999_931) * 32).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect(999_931 * 64).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect(estimateStaticBvhWorkingBytes(18, 7)).toBeGreaterThan(7 * 64);
  });

  it('accounts for an existing worker heap and other resident scene buffers before admitting a replacement', () => {
    const input = smallSource(), fresh = preflightImportedStaticTrace(input, limits);
    const retainedWasmBytes = 128 * 1024 * 1024;
    const reused = preflightImportedStaticTrace(input, limits, { retainedWasmBytes });
    expect(reused.wasmGrowthAllowanceBytes).toBeGreaterThanOrEqual(retainedWasmBytes + reused.workingBytes);
    expect(reused.estimatedPeakCpuBytes).toBeGreaterThan(fresh.estimatedPeakCpuBytes);
    expect(() => preflightImportedStaticTrace(input, limits, { retainedWasmBytes, maxPeakCpuBytes: fresh.estimatedPeakCpuBytes })).toThrow(StrataError);
    const additionalResidentCpuBytes = 4 * 1024 * 1024;
    const overlapping = preflightImportedStaticTrace(input, limits, { additionalResidentCpuBytes });
    expect(overlapping.additionalResidentCpuBytes).toBe(additionalResidentCpuBytes);
    expect(overlapping.estimatedPeakCpuBytes).toBe(fresh.estimatedPeakCpuBytes + additionalResidentCpuBytes);
    expect(() => preflightImportedStaticTrace(input, limits, { additionalResidentCpuBytes,
      maxPeakCpuBytes: fresh.estimatedPeakCpuBytes + additionalResidentCpuBytes - 1 })).toThrow(StrataError);
    for (const invalid of [-1, NaN, Infinity]) {
      expect(() => preflightImportedStaticTrace(input, limits, { retainedWasmBytes: invalid })).toThrow(StrataError);
      expect(() => preflightImportedStaticTrace(input, limits, { additionalResidentCpuBytes: invalid })).toThrow(StrataError);
    }
  });

  it('honors cancellation at a yielded copy boundary while retaining caller-owned buffers', async () => {
    const input = tiledSource(), controller = new AbortController();
    const byteLengths = input.primitives.map(mesh => [mesh.vertices.byteLength, mesh.indices.byteLength]);
    const pending = prepareImportedStaticTrace(input, limits, { signal: controller.signal });
    controller.abort('generated cancellation witness');
    await expect(pending).rejects.toMatchObject({ code: 'SCENE_LOAD_ABORTED' });
    expect(input.primitives.map(mesh => [mesh.vertices.byteLength, mesh.indices.byteLength])).toEqual(byteLengths);
  });
});

describe('independent imported triangle oracle', () => {
  it('has a hand-computed sloping hit, barycentric weights, backface hit and stable coincident identity', () => {
    const triangles = sourceTriangles(smallSource());
    const ray: Ray = { origin: [0.125, 0.125, 1.25], direction: [0, 0, -1], tMin: 0.001, tMax: 2 };
    expectHit(nearest(triangles, ray), { id: 1, distance: 1, barycentric: [0.5, 0.25, 0.25], normal: [-1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)] });
    expect(nearest(triangles, { ...ray, tMax: 0.99 })).toBeUndefined();
    expect(nearest(triangles, { ...ray, tMin: 1.01 })?.id).toBe(6);
    expect(nearest(triangles, { ...ray, origin: [0.9, 0.9, 1.25] })).toBeUndefined();
    expectHit(nearest(triangles, { origin: [0.125, 0.125, -0.25], direction: [0, 0, 1], tMin: 0.001, tMax: 1 }),
      { id: 1, distance: 0.5, barycentric: [0.5, 0.25, 0.25], normal: [-1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)] });
    expect(sourceIntersection(triangles[1]!, { ...ray, direction: [Math.SQRT1_2, 0, Math.SQRT1_2] })).toBeUndefined();
  });
});

describe('compiled static BVH source agreement', () => {
  it('keeps the shared generated GPU fixture synchronized with source attributes, real WASM bytes and hand ray expectations', async () => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/imported-static-bvh.json', import.meta.url), 'utf8')) as {
      format: string;
      source: { vertexCount: number; triangleCount: number; vertices: number[]; positions: number[]; indices: number[];
        uv0: number[]; colors: number[]; primitiveTriangleOffsets: number[]; material: ImportedMaterial };
      packed: { nodeCount: number; maxDepth: number; nodesHex: string; trianglesHex: string; trianglePositionEncoding: string };
      rays: (Ray & { name: string; expected: { sourceTriangleId: number; distance: number; barycentric: Vec3; normal: Vec3 } | null })[];
    };
    const input = smallSource(), source = sourceTriangles(input), prepared = await prepareImportedStaticTrace(input, limits);
    const result = await build(prepared);
    expect(fixture.format).toBe('strata-generated-static-bvh-fixture-v1');
    expect(fixture.source.vertexCount).toBe(18); expect(fixture.source.triangleCount).toBe(7);
    expect(fixture.source.vertices).toEqual([...prepared.vertices]); expect(fixture.source.positions).toEqual([...prepared.positions]);
    expect(fixture.source.indices).toEqual([...prepared.indices]); expect(fixture.source.primitiveTriangleOffsets).toEqual([...prepared.primitiveTriangleOffsets]);
    expect(fixture.source.material).toEqual(input.materials[0]);
    const uv0: number[] = [], colors: number[] = [];
    for (let vertex = 0; vertex < prepared.vertexCount; vertex++) {
      uv0.push(...prepared.vertices.subarray(vertex * 16 + 6, vertex * 16 + 8));
      colors.push(...prepared.vertices.subarray(vertex * 16 + 12, vertex * 16 + 16));
    }
    expect(fixture.source.uv0).toEqual(uv0); expect(fixture.source.colors).toEqual(colors);
    expect(fixture.packed.trianglePositionEncoding).toBe('original-f32-p0-p1-p2');
    expect(fixture.packed.nodeCount).toBe(result.nodeCount); expect(fixture.packed.maxDepth).toBe(result.maxDepth);
    expect(fixture.packed.nodesHex).toBe(Buffer.from(result.nodes).toString('hex'));
    expect(fixture.packed.trianglesHex).toBe(Buffer.from(result.triangles).toString('hex'));
    const saved: StaticBvhResult = { ...result, nodes: new Uint8Array(Buffer.from(fixture.packed.nodesHex, 'hex')).buffer,
      triangles: new Uint8Array(Buffer.from(fixture.packed.trianglesHex, 'hex')).buffer };
    await validateImportedStaticBvh(prepared, saved); checkPackedSource(saved, source);
    expect(fixture.rays).toHaveLength(7);
    for (const ray of fixture.rays) {
      const expected = ray.expected ? { id: ray.expected.sourceTriangleId, distance: ray.expected.distance,
        barycentric: ray.expected.barycentric, normal: ray.expected.normal } : undefined;
      expectHit(nearest(source, ray), expected); expectHit(tracePacked(saved, ray), expected);
    }
  });

  it('packs exact indexed source positions and stable identities deterministically across step quotas', async () => {
    const input = smallSource(), source = sourceTriangles(input), prepared = await prepareImportedStaticTrace(input, limits);
    const first = await build(prepared, 1), second = await build(prepared, 4096);
    await validateImportedStaticBvh(prepared, first); await validateImportedStaticBvh(prepared, second);
    checkPackedSource(first, source);
    expect(new Uint8Array(first.nodes)).toEqual(new Uint8Array(second.nodes));
    expect(new Uint8Array(first.triangles)).toEqual(new Uint8Array(second.triangles));
    const forward: Ray = { origin: [0.125, 0.125, 1.25], direction: [0, 0, -1], tMin: 0.001, tMax: 2 };
    const rays: Ray[] = [forward, { ...forward, tMax: 0.99 }, { ...forward, tMin: 1.01 },
      { ...forward, origin: [0.9, 0.9, 1.25] }, { ...forward, origin: [0, 0, 1.25] },
      { origin: [0.125, 0.125, -0.25], direction: [0, 0, 1], tMin: 0.001, tMax: 1 },
      { origin: [-1, -1, 0.5], direction: [1, 0, 0], tMin: 0.001, tMax: 4 }];
    for (const ray of rays) expectHit(tracePacked(first, ray), nearest(source, ray));
    expect(tracePacked(first, forward)?.id).toBe(1);
  });

  it('retains original f32 endpoints that would be lost by precomputing f32 edges', async () => {
    const input = asset([primitive([[-1, 0, 0], [2 ** -26, 0, 0], [0, 1, 0]], [0, 1, 2], 'Endpoint precision witness')]);
    const prepared = await prepareImportedStaticTrace(input, limits), result = await build(prepared);
    await validateImportedStaticBvh(prepared, result); checkPackedSource(result, sourceTriangles(input));
    expect(new DataView(result.triangles).getFloat32(16, true)).toBe(2 ** -26);
    expect(Math.fround(-1 + Math.fround(1 + 2 ** -26))).toBe(0);

    // The exact signed area is -2^-100 even though binary64 endpoint subtraction
    // rounds both X edges to -1. The normal check must preserve that cancellation.
    const tiny = asset([primitive([[1, 1, 0], [2 ** -100, 0, 0], [0, 0, 0]], [0, 1, 2], 'Exact tiny area witness')]);
    const tinyPrepared = await prepareImportedStaticTrace(tiny, limits), tinyResult = await build(tinyPrepared);
    expect(2 ** -100 - 1).toBe(-1);
    expect(vector(new DataView(tinyResult.triangles), 48)).toEqual([0, 0, -1]);
    await expect(validateImportedStaticBvh(tinyPrepared, tinyResult)).resolves.toBeUndefined();
  });

  it('preserves signed-zero source words and rejects a sign-bit-only endpoint mutation', async () => {
    const input = asset([primitive([[-0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 1, 2], 'Signed zero witness')]);
    const prepared = await prepareImportedStaticTrace(input, limits), result = await build(prepared);
    expect(Object.is(prepared.positions[0], -0)).toBe(true);
    expect(new DataView(result.triangles).getUint32(0, true)).toBe(0x8000_0000);
    await expect(validateImportedStaticBvh(prepared, result)).resolves.toBeUndefined();
    const changed = { ...result, triangles: result.triangles.slice(0) };
    new DataView(changed.triangles).setUint32(0, 0, true);
    await expect(validateImportedStaticBvh(prepared, changed)).rejects.toThrow('original source position');
  });

  it('builds more than 4096 exact triangles and agrees with an independent source scan on seeded sloping rays', async () => {
    const input = tiledSource(), source = sourceTriangles(input), prepared = await prepareImportedStaticTrace(input, limits);
    const result = await build(prepared);
    await validateImportedStaticBvh(prepared, result); checkPackedSource(result, source);
    expect(result.triangleCount).toBe(5003); expect(result.nodeCount).toBeGreaterThan(1);
    let seed = 0x67214af1;
    const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
    for (let index = 0; index < 97; index++) {
      const triangle = source[Math.floor(random() * source.length)]!;
      const point = [0, 1, 2].map(axis => triangle.points[0][axis]! * 0.5 + triangle.points[1][axis]! * 0.25 + triangle.points[2][axis]! * 0.25) as unknown as Vec3;
      const raw: Vec3 = [(random() - 0.5) * 0.8, (random() - 0.5) * 0.8, -1]; const length = Math.hypot(...raw);
      const direction: Vec3 = [raw[0] / length, raw[1] / length, raw[2] / length];
      const origin: Vec3 = [point[0] - direction[0] * 2, point[1] - direction[1] * 2, point[2] - direction[2] * 2];
      const ray: Ray = { origin, direction, tMin: 0.001, tMax: 4 };
      const expected = nearest(source, ray);
      expect(expected?.id).toBe(triangle.id); expectHit(tracePacked(result, ray), expected);
      expectHit(tracePacked(result, { ...ray, tMax: 1.5 }), undefined);
    }
  });

  it('rejects corrupted source identity, original endpoints and hierarchy before upload', async () => {
    const prepared = await prepareImportedStaticTrace(smallSource(), limits), result = await build(prepared);
    const copy = (): StaticBvhResult => ({ ...result, nodes: result.nodes.slice(0), triangles: result.triangles.slice(0) });
    const badId = copy(); new DataView(badId.triangles).setUint32(44, result.triangleCount, true);
    await expect(validateImportedStaticBvh(prepared, badId)).rejects.toThrow(StrataError);
    const badPosition = copy(); new DataView(badPosition.triangles).setFloat32(16, 123, true);
    await expect(validateImportedStaticBvh(prepared, badPosition)).rejects.toThrow(StrataError);
    const badVertex = copy(); new DataView(badVertex.triangles).setUint32(28, result.vertexCount, true);
    await expect(validateImportedStaticBvh(prepared, badVertex)).rejects.toThrow(StrataError);
    const badChild = copy(); new DataView(badChild.nodes).setUint32(12, result.nodeCount, true);
    await expect(validateImportedStaticBvh(prepared, badChild)).rejects.toThrow(StrataError);
    const badBound = copy(); new DataView(badBound.nodes).setFloat32(0, 0.9, true);
    await expect(validateImportedStaticBvh(prepared, badBound)).rejects.toThrow(StrataError);
  });
});
