import { describe, expect, it, vi } from 'vitest';
import { createGiScene, giBoxToWorld, triangulateGiScene } from '../../packages/core/src/gi/scene-data.js';
import type { GiVec3 } from '../../packages/core/src/gi/scene-data.js';
import { createGiCamera } from '../../packages/core/src/gi/room-geometry.js';
import { buildGiTraceData, refitGiTraceData, traceGiBruteForce, traceGiBvh } from '../../packages/core/src/gi/trace-data.js';
import { createReflectionScene, reflectionSurface, reflectionWitness } from '../../packages/core/src/reflections/reflection-scene.js';
import { ReflectionGeometry, packReflectionGeometry } from '../../packages/core/src/reflections/reflection-geometry.js';

const normalize = (value: GiVec3): GiVec3 => value.map(component => component / Math.hypot(...value)) as unknown as GiVec3;
function project(matrix: Float32Array, point: GiVec3): GiVec3 {
  const clip = Array.from({ length: 4 }, (_, row) => matrix[row]! * point[0] + matrix[4 + row]! * point[1] + matrix[8 + row]! * point[2] + matrix[12 + row]!);
  return [clip[0]! / clip[3]!, clip[1]! / clip[3]!, clip[2]! / clip[3]!];
}

describe('closed selective-reflection fixture', () => {
  it('extends the original 132-triangle GI fixture without changing its geometry or materials', () => {
    const base = createGiScene(); const scene = createReflectionScene(); const triangles = triangulateGiScene(scene);
    expect(scene.boxes.slice(0, base.boxes.length)).toEqual(base.boxes);
    expect(scene.materials.slice(0, base.materials.length)).toEqual(base.materials);
    expect(triangulateGiScene(base)).toHaveLength(132);
    expect(triangles).toHaveLength(156);
    expect(scene.reflectorBoxId).toBe(11); expect(scene.objectBoxId).toBe(12);
    expect(scene.bounds).toEqual(base.bounds);
    expect(Object.isFrozen(scene)).toBe(true); expect(Object.isFrozen(scene.boxes)).toBe(true);
    const mirror = scene.materials[scene.boxes[scene.reflectorBoxId]!.materialId]!;
    const emitter = scene.materials[scene.boxes[scene.objectBoxId]!.materialId]!;
    expect(mirror).toMatchObject({ metallic: 1, roughness: 0.08, emission: [0, 0, 0] });
    expect(emitter).toMatchObject({ metallic: 0, albedo: [0.6, 0.08, 0.03], emission: [4, 0.25, 0.08] });
    for (const triangle of triangles) {
      const a = triangle.p1.map((value, axis) => value - triangle.p0[axis]!);
      const b = triangle.p2.map((value, axis) => value - triangle.p0[axis]!);
      const cross = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
      expect(cross.reduce((sum, value, axis) => sum + value * triangle.normal[axis]!, 0)).toBeGreaterThan(0);
    }
    const top = triangles.filter(triangle => triangle.boxId === scene.reflectorBoxId && triangle.normal[1] > 0.99);
    expect(top).toHaveLength(2);
    expect(top.flatMap(triangle => [triangle.p0[1], triangle.p1[1], triangle.p2[1]]).every(y => Math.abs(y - reflectionSurface.planeY) < 1e-8)).toBe(true);
  });

  it('keeps every real cube corner offscreen while every mirrored corner projects onto the selected mirror', () => {
    const camera = createGiCamera(1280, 720, 0, [0, 0], 'receiver');
    for (const objectOffset of [-0.4, 0, 0.4]) {
      const scene = createReflectionScene({ objectOffset }); const cube = scene.boxes[scene.objectBoxId]!;
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
        const point = giBoxToWorld(cube, [x * cube.halfSize[0], y * cube.halfSize[1], z * cube.halfSize[2]]);
        expect(project(camera.viewProjection, point)[1]).toBeGreaterThan(1.5);
        const virtual: GiVec3 = [point[0], 2 * reflectionSurface.planeY - point[1], point[2]];
        const reflected = project(camera.viewProjection, virtual);
        expect(Math.abs(reflected[0])).toBeLessThan(0.32); expect(Math.abs(reflected[1])).toBeLessThan(0.24);
        expect(reflected[2]).toBeGreaterThan(0); expect(reflected[2]).toBeLessThan(1);
        const fraction = (camera.eye[1] - reflectionSurface.planeY) / (camera.eye[1] - virtual[1]);
        for (const axis of [0, 2]) {
          const floor = camera.eye[axis]! + fraction * (virtual[axis]! - camera.eye[axis]!);
          expect(floor).toBeGreaterThan(reflectionSurface.min[axis]!); expect(floor).toBeLessThan(reflectionSurface.max[axis]!);
        }
      }
    }
  });

  it('uses an independent mirror witness that reaches the emissive cube without floor self-intersection and moves across the image', () => {
    const camera = createGiCamera(1280, 720, 0, [0, 0], 'receiver'); const pixels: number[] = [];
    for (const objectOffset of [-0.4, 0, 0.4]) {
      const scene = createReflectionScene({ objectOffset }); const witness = reflectionWitness(scene, camera.eye);
      const incident = normalize(witness.point.map((value, axis) => value - camera.eye[axis]!) as unknown as GiVec3);
      const primary = traceGiBruteForce(scene, { origin: camera.eye, direction: incident, tMin: 0.002, tMax: 16 });
      expect(primary.status).toBe(1); expect(primary.boxId).toBe(scene.reflectorBoxId);
      const ray = { origin: witness.origin, direction: witness.direction, tMin: 0.002, tMax: 16 };
      const brute = traceGiBruteForce(scene, ray); const bvh = traceGiBvh(buildGiTraceData(scene), ray);
      expect(brute.status).toBe(1); expect(brute.boxId).toBe(scene.objectBoxId);
      expect(bvh.boxId).toBe(brute.boxId); expect(bvh.distance).toBeCloseTo(brute.distance, 5);
      pixels.push((project(camera.viewProjection, witness.virtualObject)[0] + 1) * 640);
    }
    expect(pixels[2]! - pixels[0]!).toBeGreaterThan(250);
    expect(pixels[1]).toBeCloseTo(640, 5);
  });

  it('preserves trace topology and exact raster material values through rigid, lighting and roughness changes', () => {
    const original = createReflectionScene(); const changed = createReflectionScene({ objectOffset: 0.4, roughness: 0.35, doorOpen: false, lightIntensity: 2 });
    const data = buildGiTraceData(original); const buffers = [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData];
    refitGiTraceData(data, changed);
    [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData].forEach((buffer, index) => expect(buffer).toBe(buffers[index]));
    const vertices = packReflectionGeometry(changed, new Set([changed.objectBoxId]));
    const triangles = triangulateGiScene(changed);
    expect(vertices.byteLength).toBe(156 * 3 * 60);
    for (const triangle of triangles) {
      const material = changed.materials[triangle.materialId]!;
      const expected = [...triangle.p0, ...triangle.normal, ...material.albedo, ...material.emission,
        material.roughness, material.metallic ?? 0, triangle.boxId === changed.objectBoxId ? 1 : 0].map(Math.fround);
      expect([...vertices.subarray(triangle.id * 45, triangle.id * 45 + 15)]).toEqual(expected);
      const traceMaterial = new DataView(data.materialData);
      expect(traceMaterial.getFloat32(material.id * 32 + 28, true)).toBe(material.metallic ?? 0);
    }
    expect(() => createReflectionScene({ objectOffset: 0.4001 })).toThrow('objectOffset');
    expect(() => createReflectionScene({ roughness: -0.01 })).toThrow('roughness');
    expect(() => createReflectionScene({ roughness: Number.NaN })).toThrow('roughness');
    expect(createReflectionScene({ roughness: 0 }).state.roughness).toBe(0);
  });

  it('invalidates moving object depth, clears the flag on the next frame, and owns all geometry allocations', () => {
    const buffers: { label: string; bytes: Float32Array<ArrayBuffer>; destroy: ReturnType<typeof vi.fn> }[] = [];
    const device = {
      limits: { maxBufferSize: 256 * 1024 * 1024 },
      createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => { const buffer = { label: descriptor.label ?? '', bytes: new Float32Array(descriptor.size / 4), destroy: vi.fn() }; buffers.push(buffer); return buffer; }),
      queue: { writeBuffer: vi.fn((buffer: typeof buffers[number], _offset: number, input: Float32Array<ArrayBuffer>) => buffer.bytes.set(input)) },
    };
    const scene = createReflectionScene(); const geometry = new ReflectionGeometry(device as unknown as GPUDevice, scene);
    const camera = geometry.camera(640, 360, 0, [0, 0]); const encoder = {} as GPUCommandEncoder;
    expect(geometry.gpuBufferBytes).toBe(156 * 3 * 60 + 32);
    expect(geometry.prepare(encoder, camera, 640, 360, false, {})).toMatchObject({ triangles: 312, drawCalls: 2, uploadBytes: 0 });
    geometry.setScene(createReflectionScene({ objectOffset: 0.4 }));
    expect(geometry.prepare(encoder, camera, 640, 360, false, {}).uploadBytes).toBe(geometry.initialUploadBytes);
    const flag = (box: number) => buffers[0]!.bytes[box * 12 * 45 + 14];
    expect(flag(scene.objectBoxId)).toBe(1); expect(flag(scene.reflectorBoxId)).toBe(0); expect(flag(0)).toBe(0);
    expect(geometry.prepare(encoder, camera, 640, 360, false, {}).uploadBytes).toBe(156 * 3 * 60);
    expect(flag(scene.objectBoxId)).toBe(0);
    expect(geometry.prepare(encoder, camera, 640, 360, false, {}).uploadBytes).toBe(0);
    geometry.dispose(); geometry.dispose();
    expect(geometry.gpuBufferBytes).toBe(0); expect(buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });
});
