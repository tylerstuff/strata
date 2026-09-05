import { describe, expect, it } from 'vitest';
import { staticTraceShader } from '../../packages/core/src/imported/static-trace-shader.js';
import { intersectStaticTriangleReference, offsetStaticTraceReference, traceStaticReference } from '../../packages/core/src/imported/static-trace-reference.js';
import type { StaticTracePoint, StaticTraceReferenceRay } from '../../packages/core/src/imported/static-trace-reference.js';

type Triangle = readonly [StaticTracePoint, StaticTracePoint, StaticTracePoint];
type Node = { min: StaticTracePoint; max: StaticTracePoint; first: number; count: number };
const ray: StaticTraceReferenceRay = { origin: [0.25, 0.25, 0], direction: [0, 0, 1], tMin: 0, tMax: 10 };
const triangleAt = (z: number, size = 1, offset = 0): Triangle =>
  [[offset, offset, z], [offset + size, offset, z], [offset, offset + size, z]];

function pack(triangles: readonly Triangle[], suppliedNodes?: readonly Node[], sources?: readonly number[]) {
  const triangleBuffer = new ArrayBuffer(triangles.length * 64), data = new DataView(triangleBuffer);
  const all = triangles.flat();
  const nodes = suppliedNodes ?? [{ min: [0, 1, 2].map(axis => Math.min(...all.map(point => point[axis]!))) as unknown as StaticTracePoint,
    max: [0, 1, 2].map(axis => Math.max(...all.map(point => point[axis]!))) as unknown as StaticTracePoint, first: 0, count: triangles.length }];
  const nodeBuffer = new ArrayBuffer(nodes.length * 32), nodeData = new DataView(nodeBuffer);
  triangles.forEach((triangle, id) => {
    triangle.forEach((point, corner) => point.forEach((value, axis) => data.setFloat32(id * 64 + corner * 16 + axis * 4, value, true)));
    data.setUint32(id * 64 + 28, id * 3, true); data.setUint32(id * 64 + 44, sources?.[id] ?? id, true);
    const e1 = triangle[1].map((value, axis) => value - triangle[0][axis]!);
    const e2 = triangle[2].map((value, axis) => value - triangle[0][axis]!);
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const length = Math.hypot(...n);
    n.forEach((value, axis) => data.setFloat32(id * 64 + 48 + axis * 4, value / length, true));
  });
  nodes.forEach((node, id) => {
    node.min.forEach((value, axis) => nodeData.setFloat32(id * 32 + axis * 4, value, true));
    node.max.forEach((value, axis) => nodeData.setFloat32(id * 32 + 16 + axis * 4, value, true));
    nodeData.setUint32(id * 32 + 12, node.first, true); nodeData.setUint32(id * 32 + 28, node.count, true);
  });
  return { nodeBuffer, triangleBuffer, nodes: nodeData, triangles: data };
}

describe('static BVH tracing ABI and independent CPU reference', () => {
  it('exposes caller-bound storage and separate visibility/transport entry points', () => {
    // Integration contract only: this does not claim GPU compilation or execution.
    expect(staticTraceShader).not.toContain('@binding');
    for (const name of ['StaticTraceNode', 'StaticTraceTriangle', 'StaticTraceHit', 'traceStatic', 'traceStaticVisible', 'traceStaticOcclusion', 'staticTraceOffset']) {
      expect(staticTraceShader).toMatch(new RegExp(`(?:struct|fn) ${name}\\b`));
    }
    expect(staticTraceShader).toContain('arrayLength(&staticTraceNodes)');
    expect(staticTraceShader).toContain('arrayLength(&staticTraceTriangles)');
    const packed = pack([triangleAt(1)], undefined, [0]);
    expect(packed.nodeBuffer.byteLength).toBe(32); expect(packed.triangleBuffer.byteLength).toBe(64);
    const hit = traceStaticReference(packed.nodeBuffer, packed.triangleBuffer, ray, { maxVisits: 1 });
    expect(hit).toEqual({ status: 1, triangle: 0, distance: 1, barycentric: [0.25, 0.25], nodeVisits: 1 });
  });

  it('handles tiny geometry, translated tiny geometry and near-parallel rays without an absolute area cutoff', () => {
    for (const offset of [0, 1, -1]) for (const size of [1e-5, 1e-3, 1]) {
      const triangle = triangleAt(offset, size, offset);
      const origin: StaticTracePoint = [offset + size * 0.25, offset + size * 0.25, offset + size];
      const hit = intersectStaticTriangleReference({ origin, direction: [0, 0, -1], tMin: 0, tMax: size * 2 }, ...triangle)!;
      expect(hit.distance).toBeCloseTo(size, 13);
      expect(hit.barycentric[0]).toBeCloseTo(0.25, 10); expect(hit.barycentric[1]).toBeCloseTo(0.25, 10);
      const packed = pack([triangle]);
      expect(traceStaticReference(packed.nodeBuffer, packed.triangleBuffer,
        { origin, direction: [0, 0, -1], tMin: 0, tMax: size * 2 }, { maxVisits: 1 }).status).toBe(1);
    }
    const grazing = intersectStaticTriangleReference({ origin: [0.25, 0.25, 1e-12], direction: [1, 0, -1e-12], tMin: 0, tMax: 2 }, ...triangleAt(0, 4))!;
    expect(grazing.distance).toBeCloseTo(1, 12); expect(grazing.barycentric).toEqual([0.3125, 0.0625]);
    expect(intersectStaticTriangleReference({ ...ray, direction: [1, 0, 0] }, ...triangleAt(0))).toBeNull();
  });

  it('accepts all six axial directions, boundaries, signed zero slabs and inclusive distance clips', () => {
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const next = (axis + 1) % 3, last = (axis + 2) % 3;
      const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], origin = [0, 0, 0], direction = [-0, 0, -0];
      b[next] = 1; c[last] = 1; origin[next] = 0.25; origin[last] = 0.25; origin[axis] = -sign; direction[axis] = sign;
      const packed = pack([[a, b, c] as unknown as Triangle]);
      const query = { origin, direction, tMin: 1, tMax: 1 } as unknown as StaticTraceReferenceRay;
      expect(traceStaticReference(packed.nodeBuffer, packed.triangleBuffer, query, { maxVisits: 1 })).toMatchObject({ status: 1, distance: 1 });
      expect(traceStaticReference(packed.nodeBuffer, packed.triangleBuffer, { ...query, tMin: 0, tMax: 0.999 }, { maxVisits: 1 }).status).toBe(0);
      expect(traceStaticReference(packed.nodeBuffer, packed.triangleBuffer, { ...query, tMin: 1.001, tMax: 2 }, { maxVisits: 1 }).status).toBe(0);
    }
    const packed = pack([triangleAt(1)]);
    for (const origin of [[0, 0, 0], [1, 0, 0], [0.5, 0.5, 0]] as const) {
      expect(traceStaticReference(packed.nodeBuffer, packed.triangleBuffer, { ...ray, origin }, { maxVisits: 1 }).status).toBe(1);
    }
    expect(traceStaticReference(packed.nodeBuffer, packed.triangleBuffer, { ...ray, origin: [-0.001, 0, 0] }, { maxVisits: 1 }).status).toBe(0);
    expect(traceStaticReference(packed.nodeBuffer, packed.triangleBuffer, { ...ray, direction: [0, 0, 2] }, { maxVisits: 1 }).distance).toBe(0.5);
  });

  it('culls authored backfaces only for primary visibility and resolves ties by original source identity', () => {
    const front = triangleAt(2);
    const packed = pack([triangleAt(1), [front[0], front[2], front[1]]]);
    expect(traceStaticReference(packed.nodeBuffer, packed.triangleBuffer, ray, { maxVisits: 1 }).triangle).toBe(0);
    expect(traceStaticReference(packed.nodeBuffer, packed.triangleBuffer, ray, { maxVisits: 1, cullBackfaces: true })).toMatchObject({ triangle: 1, distance: 2 });
    expect(traceStaticReference(packed.nodeBuffer, packed.triangleBuffer, ray, { maxVisits: 1, anyHit: true })).toMatchObject({ status: 1, triangle: 0 });
    const duplicate = pack([triangleAt(1), triangleAt(1)], undefined, [1, 0]);
    expect(traceStaticReference(duplicate.nodeBuffer, duplicate.triangleBuffer, ray, { maxVisits: 1 }).triangle).toBe(1);
  });

  it('erases provisional closest hits when the remaining traversal budget is exhausted', () => {
    const packed = pack([triangleAt(1), triangleAt(2), triangleAt(3)], [
      { min: [0, 0, 0], max: [1, 1, 3], first: 1, count: 0 },
      { min: [0, 0, 0.25], max: [1, 1, 1], first: 0, count: 1 },
      { min: [0, 0, 0.5], max: [1, 1, 3], first: 3, count: 0 },
      { min: [0, 0, 2], max: [1, 1, 2], first: 1, count: 1 },
      { min: [0, 0, 3], max: [1, 1, 3], first: 2, count: 1 },
    ]);
    for (const maxVisits of [0, 1, 2, 3, 4]) {
      expect(traceStaticReference(packed.nodeBuffer, packed.triangleBuffer, ray, { maxVisits }))
        .toEqual({ status: 2, triangle: 0xffffffff, distance: 10, barycentric: [0, 0], nodeVisits: maxVisits });
    }
    expect(traceStaticReference(packed.nodeBuffer, packed.triangleBuffer, ray, { maxVisits: 5 })).toMatchObject({ status: 1, triangle: 0, distance: 1, nodeVisits: 5 });
    expect(traceStaticReference(packed.nodeBuffer, packed.triangleBuffer, ray, { maxVisits: 3, anyHit: true })).toMatchObject({ status: 1, triangle: 0, nodeVisits: 3 });
  });

  it('rejects invalid rays and malformed reached nodes/triangles without fabricating a miss', () => {
    const packed = pack([triangleAt(1)]);
    for (const change of [{ direction: [0, 0, 0] }, { origin: [NaN, 0, 0] }, { tMin: -1 }, { tMax: Infinity }, { tMin: 3, tMax: 2 }]) {
      expect(traceStaticReference(packed.nodeBuffer, packed.triangleBuffer, { ...ray, ...change } as StaticTraceReferenceRay, { maxVisits: 8 }).status).toBe(3);
    }
    for (const corrupt of [(p: typeof packed) => p.nodes.setUint32(28, 5, true), (p: typeof packed) => p.nodes.setUint32(12, 100, true),
      (p: typeof packed) => p.nodes.setFloat32(0, Infinity, true), (p: typeof packed) => p.triangles.setUint32(44, 1, true),
      (p: typeof packed) => p.triangles.setFloat32(48, NaN, true), (p: typeof packed) => p.triangles.setUint32(12, 1, true)]) {
      const bad = pack([triangleAt(1)]); corrupt(bad);
      expect(traceStaticReference(bad.nodeBuffer, bad.triangleBuffer, ray, { maxVisits: 8 }).status).toBe(3);
    }
    const cyclic = pack([triangleAt(1), triangleAt(2)], [
      { min: [0, 0, 0], max: [1, 1, 2], first: 0, count: 0 },
      { min: [0, 0, 1], max: [1, 1, 1], first: 0, count: 1 },
      { min: [0, 0, 2], max: [1, 1, 2], first: 1, count: 1 },
    ]);
    expect(traceStaticReference(cyclic.nodeBuffer, cyclic.triangleBuffer, ray, { maxVisits: 0xffffffff }).status).toBe(3);
  });

  it('offsets along oriented geometry below tiny feature scale at the origin and unit coordinates', () => {
    for (const position of [0, 1, -1]) {
      const triangle = triangleAt(position, 1e-5, position);
      const point: StaticTracePoint = [Math.fround(position + 2.5e-6), Math.fround(position + 2.5e-6), position];
      for (const sign of [-1, 1]) {
        const shifted = offsetStaticTraceReference(point, [0, 0, sign], ...triangle);
        expect(shifted[0]).toBe(point[0]); expect(shifted[1]).toBe(point[1]);
        expect((shifted[2] - point[2]) * sign).toBeGreaterThan(0);
        expect(Math.abs(shifted[2] - point[2])).toBeLessThan(1e-5 * 0.05);
        expect(intersectStaticTriangleReference({ origin: shifted, direction: [0, 0, sign], tMin: 0, tMax: 1 }, ...triangle)).toBeNull();
        const toward = intersectStaticTriangleReference({ origin: shifted, direction: [0, 0, -sign], tMin: 0, tMax: 1 }, ...triangle)!;
        expect(toward.distance).toBeGreaterThan(0);
      }
    }
  });
});
