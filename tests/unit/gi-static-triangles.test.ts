import { describe, expect, it } from 'vitest';
import { createReflectionScene } from '../../packages/core/src/reflections/reflection-scene.js';
import type { GiTriangle } from '../../packages/core/src/gi/scene-data.js';
import { integratedTerrainMaterial, terrainTraceObjectId } from '../../packages/core/src/geometry/trace-proxy.js';
import { buildGiTraceData, refitGiTraceData, traceGiBruteForce, traceGiBvh, traceGiSdf } from '../../packages/core/src/gi/trace-data.js';

const staticSource = (): GiTriangle[] => [
  { id: 0, boxId: terrainTraceObjectId, materialId: 5, p0: [8, -2, 0], p1: [8, -2, 2], p2: [10, -2, 2], normal: [0, 1, 0] },
  { id: 1, boxId: terrainTraceObjectId, materialId: 5, p0: [8, -2, 0], p1: [10, -2, 2], p2: [10, -2, 0], normal: [0, 1, 0] },
];
const scene = (doorOpen = true) => { const source = createReflectionScene({ doorOpen }); return { ...source, materials: [...source.materials, integratedTerrainMaterial] }; };
const ray = { origin: [9, 1, 0.5], direction: [0, -1, 0], tMin: 0.001, tMax: 10 } as const;

describe('persistent static triangles in shared software tracing', () => {
  it('traces non-box source triangles while preserving the independent brute-force oracle', () => {
    const source = scene(); const statics = staticSource(); const data = buildGiTraceData(source, statics);
    expect(data.triangleCount).toBe(158); expect(data.boxCount).toBe(13);
    const actual = traceGiBvh(data, ray); const expected = traceGiBruteForce(source, ray, statics);
    expect(actual.status).toBe(1); expect(actual.distance).toBe(3); expect(actual.boxId).toBe(terrainTraceObjectId);
    expect(actual.triangleId).toBe(157); expect(actual.materialId).toBe(5);
    expect([actual.distance, actual.normal, actual.materialId, actual.triangleId]).toEqual([expected.distance, expected.normal, expected.materialId, expected.triangleId]);
    expect(traceGiBruteForce(source, ray).status).toBe(0);
    expect(() => traceGiSdf(source, ray, statics)).toThrow(/cannot represent/);
  });

  it('deep-copies persistent geometry and retains it across room, material and light refits', () => {
    const mutable = staticSource(); const data = buildGiTraceData(scene(false), mutable);
    const resources = [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData];
    const retained = data.staticTriangles; const order = data.triangleOrder;
    (mutable[0]!.p0 as unknown as number[])[1] = 10; mutable.length = 0;
    expect(data.staticTriangles).toHaveLength(2); expect(Object.isFrozen(data.staticTriangles[0]!.p0)).toBe(true);
    const changed = scene(true); const next = { ...changed, materials: [...changed.materials.slice(0, 5), { ...integratedTerrainMaterial, albedo: [0.45, 0.45, 0.45] as const }] };
    refitGiTraceData(data, next);
    expect(data.staticTriangles).toBe(retained); expect(data.triangleOrder).toBe(order);
    expect([data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData]).toEqual(resources);
    expect(traceGiBvh(data, ray).distance).toBe(3); expect(traceGiBvh(data, ray).boxId).toBe(terrainTraceObjectId);
    expect(new DataView(data.materialData).getFloat32(5 * 32, true)).toBe(Math.fround(0.45));
    expect(buildGiTraceData(createReflectionScene()).staticTriangles).toEqual([]);
  });

  it('enforces combined primitive limits, IDs, finite geometry and matching outward normals', () => {
    const source = scene(); const first = staticSource()[0]!;
    for (const broken of [
      { ...first, id: 1 }, { ...first, boxId: 1000 }, { ...first, boxId: 0xffffffff },
      { ...first, materialId: 6 }, { ...first, normal: [0, -1, 0] },
      { ...first, p0: [8, NaN, 0] }, { ...first, p2: first.p1 },
    ]) expect(() => buildGiTraceData(source, [broken as GiTriangle])).toThrow(/static triangle/);
    expect(() => buildGiTraceData(source, Array.from({ length: 4096 - 156 + 1 }, (_, id) => ({ ...first, id })))).toThrow(/limits/);
  });
});
