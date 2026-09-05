import { describe, expect, it } from 'vitest';
import { createGiScene, triangulateGiScene } from '../../packages/core/src/gi/scene-data.js';
import type { GiSceneData, GiVec3 } from '../../packages/core/src/gi/scene-data.js';
import { buildGiTraceData, createGiReferenceRays, giBoxSignedDistance, giTraceLimits, giTraceStrides, packGiRays, refitGiTraceData,
  traceGiBruteForce, traceGiBvh, traceGiSdf } from '../../packages/core/src/gi/trace-data.js';
import type { GiRay, GiTraceHit } from '../../packages/core/src/gi/trace-data.js';
import { giTraceShader } from '../../packages/core/src/gi/trace-shaders.js';

const subtract = (a: GiVec3, b: GiVec3): GiVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: GiVec3, b: GiVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: GiVec3, b: GiVec3): GiVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function ray(origin: GiVec3, direction: GiVec3, tMax = 24, tMin = 0.0005): GiRay {
  const length = Math.hypot(...direction);
  return { origin, direction: direction.map(v => v / length) as unknown as GiVec3, tMin, tMax };
}
function sameHit(actual: GiTraceHit, expected: GiTraceHit): void {
  expect(actual.status).toBe(expected.status);
  if (expected.status !== 1) return;
  expect(actual.distance).toBeCloseTo(expected.distance, 4);
  expect(actual.boxId).toBe(expected.boxId);
  expect(actual.materialId).toBe(expected.materialId);
  expect(dot(actual.normal, expected.normal)).toBeGreaterThan(0.9999);
}

describe('shared two-room GI scene', () => {
  it('uses exact outward CCW boxes, immutable linear materials and a normalized sun', () => {
    const scene = createGiScene();
    const triangles = triangulateGiScene(scene);
    expect(triangles).toHaveLength(132);
    expect(scene.boxes).toHaveLength(11);
    expect(Math.hypot(...scene.light.direction)).toBeCloseTo(1, 12);
    expect(Object.isFrozen(scene)).toBe(true);
    expect(Object.isFrozen(scene.boxes[0]!.center)).toBe(true);
    for (const triangle of triangles) {
      const geometric = cross(subtract(triangle.p1, triangle.p0), subtract(triangle.p2, triangle.p0));
      expect(dot(geometric, triangle.normal)).toBeGreaterThan(0);
      expect(Math.hypot(...triangle.normal)).toBeCloseTo(1, 7);
      expect(triangle.materialId).toBe(scene.boxes[triangle.boxId]!.materialId);
      for (const point of [triangle.p0, triangle.p1, triangle.p2]) for (const value of point) expect(Math.fround(value)).toBe(value);
    }
  });

  it('keeps the same rigid door dimensions and source IDs across discrete transform/light changes', () => {
    const closed = createGiScene({ doorOpen: false });
    const open = createGiScene({ doorOpen: true, wallColor: 'neutral', lightIntensity: 0.5 });
    expect(open.boxes[open.doorBoxId]!.halfSize).toEqual(closed.boxes[closed.doorBoxId]!.halfSize);
    expect(open.light.radiance).toEqual([2, 1.9, 1.75]);
    expect(open.materials[1]!.albedo).toEqual([0.45, 0.45, 0.45]);
    expect(triangulateGiScene(open).map(t => [t.id, t.boxId, t.materialId])).toEqual(triangulateGiScene(closed).map(t => [t.id, t.boxId, t.materialId]));
    const aperture = ray([-1, 1.4, 0], [1, 0, 0]);
    expect(traceGiBruteForce(closed, aperture).boxId).toBe(closed.doorBoxId);
    expect(traceGiBruteForce(closed, aperture).distance).toBeCloseTo(0.96, 5);
    expect(traceGiBruteForce(open, aperture).boxId).not.toBe(open.doorBoxId);
    expect(traceGiBruteForce(open, aperture).distance).toBeCloseTo(7, 5);
  });

  it('has a sunlit red wall and a shadowed receiver connected only through the open doorway', () => {
    const open = createGiScene(); const closed = createGiScene({ doorOpen: false });
    const receiver: GiVec3 = [-1.5, 0.01, 0.2]; const redPoint: GiVec3 = [4.5, 1.5, -3.999];
    const towardWall = subtract(redPoint, receiver); const length = Math.hypot(...towardWall);
    expect(traceGiBruteForce(open, ray(receiver, towardWall, length - 0.01)).status).toBe(0);
    expect(traceGiBruteForce(closed, ray(receiver, towardWall, length - 0.01)).boxId).toBe(closed.doorBoxId);
    expect(traceGiBruteForce(open, ray(receiver, open.light.direction)).status).toBe(1);
    expect(traceGiBruteForce(open, ray(redPoint, open.light.direction)).status).toBe(0);
  });

  it('validates scene controls and keeps the initial unit-spaced grid outside solids', () => {
    for (const options of [{ lightIntensity: -1 }, { lightIntensity: Infinity }, { lightIntensity: 9 }, { doorOpen: 'yes' }, { wallColor: 'blue' }]) {
      expect(() => createGiScene(options as never)).toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    }
    for (const doorOpen of [false, true]) {
      const scene = createGiScene({ doorOpen });
      for (let x = 0; x < 12; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 8; z++) {
        const point: GiVec3 = [-5.5 + x, 0.5 + y, -3.5 + z];
        expect(scene.boxes.every(box => giBoxSignedDistance(box, point) > 0)).toBe(true);
      }
    }
  });
});

describe('packed deterministic triangle BVH', () => {
  it('packs declared layouts and bounds; repeated construction is byte-identical', () => {
    const scene = createGiScene(); const a = buildGiTraceData(scene); const b = buildGiTraceData(createGiScene());
    for (const name of ['nodeData', 'triangleData', 'boxData', 'materialData', 'uniformData'] as const) expect(new Uint8Array(a[name])).toEqual(new Uint8Array(b[name]));
    expect(a.nodeData.byteLength).toBe(a.nodeCount * giTraceStrides.node);
    expect(a.triangleData.byteLength).toBe(132 * 64);
    expect(a.boxData.byteLength).toBe(11 * 48);
    expect(a.materialData.byteLength).toBe(3 * 32);
    expect(a.uniformData.byteLength).toBe(48);
    expect(a.gpuBufferBytes).toBe(a.nodeData.byteLength + a.triangleData.byteLength + a.boxData.byteLength + a.materialData.byteLength + 48);
    expect(a.maxDepth).toBeLessThan(giTraceLimits.stack);
    const nodes = new DataView(a.nodeData); const packed = new DataView(a.triangleData);
    const seen = new Set<number>();
    for (let id = 0; id < a.nodeCount; id++) {
      const first = nodes.getUint32(id * 32 + 12, true); const count = nodes.getUint32(id * 32 + 28, true);
      if (!count) { expect(first).toBeGreaterThan(id); expect(first + 1).toBeLessThan(a.nodeCount); continue; }
      expect(count).toBeLessThanOrEqual(4);
      for (let i = first; i < first + count; i++) { expect(seen.has(i)).toBe(false); seen.add(i); }
      for (let i = first; i < first + count; i++) for (let axis = 0; axis < 3; axis++) {
        const p0 = packed.getFloat32(i * 64 + axis * 4, true);
        const min = nodes.getFloat32(id * 32 + axis * 4, true); const max = nodes.getFloat32(id * 32 + 16 + axis * 4, true);
        for (const p of [p0, p0 + packed.getFloat32(i * 64 + 16 + axis * 4, true), p0 + packed.getFloat32(i * 64 + 32 + axis * 4, true)]) {
          expect(p).toBeGreaterThanOrEqual(min - 0.000001); expect(p).toBeLessThanOrEqual(max + 0.000001);
        }
      }
    }
    expect(seen.size).toBe(a.triangleCount);
    expect(new Set(a.triangleOrder).size).toBe(a.triangleCount);
    expect([...new Uint32Array(a.uniformData, 32, 4)]).toEqual([a.nodeCount, 132, 11, 3]);
  });

  it('matches independent brute force on deterministic random, axis, parallel and clipped rays', () => {
    for (const doorOpen of [false, true]) {
      const scene = createGiScene({ doorOpen }); const data = buildGiTraceData(scene);
      const rays = [...createGiReferenceRays(scene, 384),
        ray([-2, 1.2, 0], [1, 0, 0]), ray([2, 1.2, 0], [-1, 0, 0]), ray([-2, 1.2, 0], [0, -1, 0]),
        ray([-2, 1.2, 0], [0, 1, 0]), ray([2, 1.2, 0], [0, 1, 0]), ray([-2, 1.2, 0], [0, 0, -1]),
        ray([-2, 1.2, 0], [0, -1, 0], 0.5), ray([-2, 1.2, 0], [0, -1, 0], 1.2),
        ray([-2, 1.2, 0], [0, -1, 0], 24, 1.3), ray([0, 1.4, 0], [1, 0, 0]),
      ];
      for (const value of rays) sameHit(traceGiBvh(data, value), traceGiBruteForce(scene, value));
    }
  });

  it('refits both door states and materials without reallocating or changing topology', () => {
    const data = buildGiTraceData(createGiScene({ doorOpen: false }));
    const buffers = [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData];
    const order = [...data.triangleOrder];
    for (const state of [{ doorOpen: true, wallColor: 'neutral' as const, lightIntensity: 0 }, { doorOpen: false }]) {
      const scene = createGiScene(state); refitGiTraceData(data, scene);
      expect([data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData]).toEqual(buffers);
      expect(data.triangleOrder).toEqual(order);
      for (const value of createGiReferenceRays(scene, 256, 991)) sameHit(traceGiBvh(data, value), traceGiBruteForce(scene, value));
    }
    expect(() => refitGiTraceData(data, { ...data.scene, boxes: data.scene.boxes.slice(1) })).toThrow();
  });

  it('fails explicitly for invalid topology and cyclic traversal instead of reporting a miss', () => {
    const scene = createGiScene(); const data = buildGiTraceData(scene);
    const excessive = { ...scene, boxes: Array.from({ length: 342 }, (_, id) => ({ ...scene.boxes[0]!, id })) };
    expect(() => buildGiTraceData(excessive)).toThrow(/limits/);
    const broken = new DataView(data.nodeData); broken.setUint32(12, 0, true); broken.setUint32(28, 0, true);
    expect(traceGiBvh(data, ray([-2, 1, 0], [0, -1, 0])).status).toBe(2);
    expect(() => traceGiBvh(data, { origin: [0, 0, 0], direction: [0, 0, 0], tMin: 0, tMax: 1 })).toThrow(/unit direction/);
  });
});

describe('bounded analytic box SDF candidate and ray ABI', () => {
  it('agrees on ordinary hits and finite misses for the same room/door source', () => {
    for (const doorOpen of [false, true]) {
      const scene = createGiScene({ doorOpen });
      for (const value of [ray([-2, 1.2, 0], [0, -1, 0]), ray([2, 1.2, 0], [0, 1, 0]), ray([-1, 1.4, 0], [1, 0, 0]), ray([-2, 1.2, 0], [0, -1, 0], 0.5)]) {
        const sdf = traceGiSdf(scene, value); const exact = traceGiBruteForce(scene, value);
        expect(sdf.status).toBe(exact.status);
        if (sdf.status === 1) { expect(sdf.distance).toBeCloseTo(exact.distance, 3); expect(sdf.boxId).toBe(exact.boxId); }
        expect(sdf.steps).toBeLessThanOrEqual(128);
        expect(sdf.primitiveTests).toBe(sdf.steps * scene.boxes.length);
      }
    }
  });

  it('reports a grazing near-surface step-budget exhaustion explicitly', () => {
    const scene = createGiScene();
    const result = traceGiSdf(scene, ray([-4, 0.001, 0], [1, 0, 0]));
    expect(result.status).toBe(2);
    expect(result.steps).toBe(128);
    expect(result.primitiveTests).toBe(128 * scene.boxes.length);
  });

  it('packs fixed ray fields and repeats seeded input exactly', () => {
    const scene = createGiScene(); const values = createGiReferenceRays(scene, 32, 4);
    const buffer = packGiRays(values);
    expect(buffer.byteLength).toBe(values.length * 32);
    expect(values).toEqual(createGiReferenceRays(scene, 32, 4));
    const floats = new Float32Array(buffer);
    expect([...floats.slice(0, 3)]).toEqual(values[0]!.origin.map(Math.fround));
    expect(floats[3]).toBe(Math.fround(values[0]!.tMin));
    expect([...floats.slice(4, 7)]).toEqual(values[0]!.direction.map(Math.fround));
    expect(floats[7]).toBe(24);
    expect(() => packGiRays([])).toThrow();
    expect(() => packGiRays([ray([0, 0, 0], [1, 0, 0], 1, 2)])).toThrow();
  });

  it('supports caller-owned WGSL binding groups without importing GPU globals', () => {
    const code = giTraceShader({ group: 0, firstBinding: 3 });
    expect(code).toContain('@group(0) @binding(3)');
    expect(code).toContain('@group(0) @binding(7)');
    expect(code).toContain('fn giTraceAnyBvh');
    expect(() => giTraceShader({ group: 4 })).toThrow();
  });
});
