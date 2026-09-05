import { StrataError } from '../errors.js';
import { triangulateGiScene } from './scene-data.js';
import type { GiBox, GiSceneData, GiTriangle, GiVec3 } from './scene-data.js';

export const giTraceLimits = Object.freeze({ triangles: 4096, nodes: 8191, stack: 32, leafSize: 4, sdfSteps: 128, epsilon: 0.0002, maxDistance: 24 });
export const giTraceStrides = Object.freeze({ node: 32, triangle: 64, box: 48, material: 32, uniform: 48, ray: 32, hit: 48 });
export interface GiRay { readonly origin: GiVec3; readonly direction: GiVec3; readonly tMin: number; readonly tMax: number }
export interface GiTraceHit {
  readonly distance: number; readonly triangleId: number; readonly materialId: number; readonly boxId: number;
  readonly normal: GiVec3; readonly status: 0 | 1 | 2;
  readonly nodeVisits: number; readonly primitiveTests: number; readonly steps: number;
}
export interface GiTraceData {
  scene: GiSceneData;
  readonly nodeData: ArrayBuffer; readonly triangleData: ArrayBuffer; readonly boxData: ArrayBuffer;
  readonly materialData: ArrayBuffer; readonly uniformData: ArrayBuffer;
  readonly triangleOrder: readonly number[];
  readonly nodeCount: number; readonly triangleCount: number; readonly boxCount: number; readonly materialCount: number;
  readonly maxDepth: number; readonly gpuBufferBytes: number;
}
interface Node { min: number[]; max: number[]; first: number; count: number }
const missingId = 0xffff_ffff;
const dot = (a: GiVec3, b: GiVec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a: GiVec3, b: GiVec3): GiVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: GiVec3, b: GiVec3): GiVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function invalid(message: string): never { throw new StrataError('INVALID_OPTIONS', `Invalid GI trace data: ${message}`); }

function validateScene(scene: GiSceneData): void {
  if (!scene.boxes.length || scene.boxes.length * 12 > giTraceLimits.triangles || !scene.materials.length || scene.materials.length > 256) invalid('scene exceeds fixed primitive/material limits.');
  scene.materials.forEach((material, id) => {
    if (material.id !== id || material.albedo.some(v => !Number.isFinite(v) || v < 0 || v > 1)
      || material.emission.some(v => !Number.isFinite(v) || v < 0 || v > 1000) || !Number.isFinite(material.roughness)) invalid('invalid material.');
  });
  scene.boxes.forEach((box, id) => {
    if (box.id !== id || box.center.some(v => !Number.isFinite(v) || Math.abs(v) > 1000)
      || box.halfSize.some(v => !Number.isFinite(v) || v < 0.0001 || v > 100)
      || !Number.isFinite(box.yaw) || !Number.isInteger(box.materialId) || !scene.materials[box.materialId]) invalid('invalid box.');
  });
  if (Math.abs(Math.hypot(...scene.light.direction) - 1) > 0.00001 || scene.light.direction.some(v => !Number.isFinite(v))
    || scene.light.radiance.some(v => !Number.isFinite(v) || v < 0 || v > 1000)) invalid('invalid light.');
}

function triangleBounds(triangles: readonly GiTriangle[], ids: readonly number[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
  for (const id of ids) for (const point of [triangles[id]!.p0, triangles[id]!.p1, triangles[id]!.p2]) {
    for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis]!, point[axis]!); max[axis] = Math.max(max[axis]!, point[axis]!); }
  }
  return { min, max };
}

/** Tiny deterministic median BVH; construction is not a per-frame dense runtime job. */
export function buildGiTraceData(scene: GiSceneData): GiTraceData {
  validateScene(scene);
  const triangles = triangulateGiScene(scene);
  const nodes: Node[] = [{ min: [], max: [], first: 0, count: 0 }];
  const order: number[] = [];
  let maxDepth = 0;
  const build = (nodeId: number, ids: number[], depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);
    if (depth >= giTraceLimits.stack || nodes.length > giTraceLimits.nodes) invalid('BVH exceeds bounded traversal limits.');
    const bounds = triangleBounds(triangles, ids);
    const node = nodes[nodeId]!; node.min = bounds.min; node.max = bounds.max;
    if (ids.length <= giTraceLimits.leafSize) { node.first = order.length; node.count = ids.length; order.push(...ids); return; }
    const extents = bounds.max.map((max, axis) => max - bounds.min[axis]!);
    let axis = 0; for (let i = 1; i < 3; i++) if (extents[i]! > extents[axis]!) axis = i;
    const centroid = (id: number) => { const t = triangles[id]!; return t.p0[axis]! + t.p1[axis]! + t.p2[axis]!; };
    ids.sort((a, b) => centroid(a) - centroid(b) || a - b);
    const middle = Math.floor(ids.length / 2);
    node.first = nodes.length;
    nodes.push({ min: [], max: [], first: 0, count: 0 }, { min: [], max: [], first: 0, count: 0 });
    build(node.first, ids.slice(0, middle), depth + 1); build(node.first + 1, ids.slice(middle), depth + 1);
  };
  build(0, triangles.map(t => t.id), 1);
  const nodeData = new ArrayBuffer(nodes.length * giTraceStrides.node);
  const nodeView = new DataView(nodeData);
  nodes.forEach((node, id) => { nodeView.setUint32(id * 32 + 12, node.first, true); nodeView.setUint32(id * 32 + 28, node.count, true); });
  const triangleData = new ArrayBuffer(triangles.length * giTraceStrides.triangle);
  const boxData = new ArrayBuffer(scene.boxes.length * giTraceStrides.box);
  const materialData = new ArrayBuffer(scene.materials.length * giTraceStrides.material);
  const uniformData = new ArrayBuffer(giTraceStrides.uniform);
  const data: GiTraceData = { scene, nodeData, triangleData, boxData, materialData, uniformData,
    triangleOrder: Object.freeze(order), nodeCount: nodes.length, triangleCount: triangles.length, boxCount: scene.boxes.length,
    materialCount: scene.materials.length, maxDepth,
    gpuBufferBytes: nodeData.byteLength + triangleData.byteLength + boxData.byteLength + materialData.byteLength + uniformData.byteLength };
  refitGiTraceData(data, scene);
  return data;
}

function setVector(view: DataView, offset: number, value: GiVec3): void { for (let axis = 0; axis < 3; axis++) view.setFloat32(offset + axis * 4, value[axis]!, true); }

/** Synchronous atomic scene preparation; caller uploads all five buffers before encoding. */
export function refitGiTraceData(data: GiTraceData, scene: GiSceneData): void {
  validateScene(scene);
  if (scene.boxes.length !== data.boxCount || scene.materials.length !== data.materialCount) invalid('refit cannot change topology.');
  const triangles = triangulateGiScene(scene);
  const packed = new DataView(data.triangleData);
  data.triangleOrder.forEach((id, index) => {
    const triangle = triangles[id]!; const at = index * 64;
    setVector(packed, at, triangle.p0); packed.setUint32(at + 12, triangle.materialId, true);
    setVector(packed, at + 16, subtract(triangle.p1, triangle.p0)); packed.setUint32(at + 28, triangle.boxId, true);
    setVector(packed, at + 32, subtract(triangle.p2, triangle.p0)); packed.setUint32(at + 44, triangle.id, true);
    setVector(packed, at + 48, triangle.normal);
  });
  const nodes = new DataView(data.nodeData);
  for (let id = data.nodeCount - 1; id >= 0; id--) {
    const at = id * 32; const first = nodes.getUint32(at + 12, true); const count = nodes.getUint32(at + 28, true);
    const b = count ? triangleBounds(triangles, data.triangleOrder.slice(first, first + count)) : {
      min: [0, 1, 2].map(axis => Math.min(nodes.getFloat32(first * 32 + axis * 4, true), nodes.getFloat32((first + 1) * 32 + axis * 4, true))),
      max: [0, 1, 2].map(axis => Math.max(nodes.getFloat32(first * 32 + 16 + axis * 4, true), nodes.getFloat32((first + 1) * 32 + 16 + axis * 4, true))),
    };
    setVector(nodes, at, b.min as unknown as GiVec3); setVector(nodes, at + 16, b.max as unknown as GiVec3);
  }
  const boxes = new DataView(data.boxData);
  scene.boxes.forEach((box, id) => {
    const at = id * 48; setVector(boxes, at, box.center); boxes.setUint32(at + 12, box.materialId, true);
    setVector(boxes, at + 16, box.halfSize); boxes.setUint32(at + 28, box.id, true);
    boxes.setFloat32(at + 32, Math.cos(box.yaw), true); boxes.setFloat32(at + 36, Math.sin(box.yaw), true);
  });
  const materials = new DataView(data.materialData);
  scene.materials.forEach((material, id) => {
    setVector(materials, id * 32, material.albedo); materials.setFloat32(id * 32 + 12, material.roughness, true); setVector(materials, id * 32 + 16, material.emission);
  });
  const uniform = new DataView(data.uniformData);
  setVector(uniform, 0, scene.light.direction); uniform.setFloat32(12, giTraceLimits.epsilon, true);
  setVector(uniform, 16, scene.light.radiance); uniform.setFloat32(28, giTraceLimits.maxDistance, true);
  [data.nodeCount, data.triangleCount, data.boxCount, data.materialCount].forEach((count, i) => uniform.setUint32(32 + i * 4, count, true));
  data.scene = scene;
}

export function validateGiRay(ray: GiRay): void {
  if (ray.origin.some(v => !Number.isFinite(v) || Math.abs(v) > 1000) || ray.direction.some(v => !Number.isFinite(v))
    || Math.abs(Math.hypot(...ray.direction) - 1) > 0.00001 || !Number.isFinite(ray.tMin) || !Number.isFinite(ray.tMax)
    || ray.tMin < 0 || ray.tMax <= ray.tMin || ray.tMax > 1000) invalid('ray needs a finite origin, unit direction and 0<=tMin<tMax<=1000.');
}

function miss(ray: GiRay): GiTraceHit {
  return { distance: ray.tMax, triangleId: missingId, materialId: missingId, boxId: missingId, normal: [0, 0, 0], status: 0, nodeVisits: 0, primitiveTests: 0, steps: 0 };
}

function intersectTriangle(ray: GiRay, p0: GiVec3, e1: GiVec3, e2: GiVec3): number | undefined {
  const p = cross(ray.direction, e2); const determinant = dot(e1, p);
  if (Math.abs(determinant) < 1e-8) return undefined;
  const inverse = 1 / determinant; const s = subtract(ray.origin, p0); const u = dot(s, p) * inverse;
  if (u < 0 || u > 1) return undefined;
  const q = cross(s, e1); const v = dot(ray.direction, q) * inverse;
  if (v < 0 || u + v > 1) return undefined;
  const distance = dot(e2, q) * inverse;
  return distance >= ray.tMin && distance <= ray.tMax ? distance : undefined;
}

/** Independent source-triangle scan, without packed nodes or BVH ordering. */
export function traceGiBruteForce(scene: GiSceneData, ray: GiRay): GiTraceHit {
  validateGiRay(ray);
  const triangles = triangulateGiScene(scene);
  let result = miss(ray);
  for (const triangle of triangles) {
    const distance = intersectTriangle(ray, triangle.p0, subtract(triangle.p1, triangle.p0), subtract(triangle.p2, triangle.p0));
    if (distance !== undefined && (result.status === 0 || distance < result.distance || (distance === result.distance && triangle.id < result.triangleId))) {
      result = { ...result, distance, triangleId: triangle.id, materialId: triangle.materialId, boxId: triangle.boxId, normal: triangle.normal, status: 1 };
    }
  }
  return { ...result, primitiveTests: triangles.length };
}

function vectorAt(view: DataView, at: number): GiVec3 { return [view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)]; }
function aabbEntry(ray: GiRay, min: GiVec3, max: GiVec3, limit: number): number {
  let near = ray.tMin; let far = limit;
  for (let axis = 0; axis < 3; axis++) {
    const direction = ray.direction[axis]!; const origin = ray.origin[axis]!;
    if (Math.abs(direction) < 1e-20) { if (origin < min[axis]! || origin > max[axis]!) return Infinity; continue; }
    const a = (min[axis]! - origin) / direction; const b = (max[axis]! - origin) / direction;
    near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
    if (far < near) return Infinity;
  }
  return near;
}

/** Packed-data CPU mirror used for tree/refit checks; GPU tests use the brute source oracle. */
export function traceGiBvh(data: GiTraceData, ray: GiRay): GiTraceHit {
  validateGiRay(ray);
  const nodes = new DataView(data.nodeData); const triangles = new DataView(data.triangleData);
  let result = miss(ray); const stack = [0]; let nodeVisits = 0; let primitiveTests = 0;
  while (stack.length) {
    const id = stack.pop()!;
    if (id >= data.nodeCount || ++nodeVisits > giTraceLimits.nodes) return { ...result, status: 2, nodeVisits, primitiveTests };
    const at = id * 32;
    if (aabbEntry(ray, vectorAt(nodes, at), vectorAt(nodes, at + 16), result.distance) === Infinity) continue;
    const first = nodes.getUint32(at + 12, true); const count = nodes.getUint32(at + 28, true);
    if (!count) {
      if (stack.length + 2 > giTraceLimits.stack || first + 1 >= data.nodeCount) return { ...result, status: 2, nodeVisits, primitiveTests };
      const left = aabbEntry(ray, vectorAt(nodes, first * 32), vectorAt(nodes, first * 32 + 16), result.distance);
      const right = aabbEntry(ray, vectorAt(nodes, (first + 1) * 32), vectorAt(nodes, (first + 1) * 32 + 16), result.distance);
      if (left <= right) { if (right !== Infinity) stack.push(first + 1); if (left !== Infinity) stack.push(first); }
      else { if (left !== Infinity) stack.push(first); if (right !== Infinity) stack.push(first + 1); }
      continue;
    }
    if (count > giTraceLimits.leafSize || first + count > data.triangleCount) return { ...result, status: 2, nodeVisits, primitiveTests };
    for (let index = first; index < first + count; index++) {
      const offset = index * 64; primitiveTests++;
      const distance = intersectTriangle(ray, vectorAt(triangles, offset), vectorAt(triangles, offset + 16), vectorAt(triangles, offset + 32));
      const triangleId = triangles.getUint32(offset + 44, true);
      if (distance !== undefined && (result.status === 0 || distance < result.distance || (distance === result.distance && triangleId < result.triangleId))) {
        result = { ...result, distance, triangleId, materialId: triangles.getUint32(offset + 12, true), boxId: triangles.getUint32(offset + 28, true), normal: vectorAt(triangles, offset + 48), status: 1 };
      }
    }
  }
  return { ...result, nodeVisits, primitiveTests };
}

function boxLocal(box: GiBox, point: GiVec3): GiVec3 {
  const p = subtract(point, box.center); const c = Math.cos(box.yaw); const s = Math.sin(box.yaw);
  return [c * p[0] - s * p[2], p[1], s * p[0] + c * p[2]];
}
export function giBoxSignedDistance(box: GiBox, point: GiVec3): number {
  const local = boxLocal(box, point); const q = local.map((v, axis) => Math.abs(v) - box.halfSize[axis]!);
  return Math.hypot(...q.map(v => Math.max(v, 0))) + Math.min(Math.max(...q), 0);
}
function boxNormal(box: GiBox, point: GiVec3): GiVec3 {
  const local = boxLocal(box, point); const distance = local.map((v, axis) => Math.abs(Math.abs(v) - box.halfSize[axis]!));
  let axis = 0; for (let i = 1; i < 3; i++) if (distance[i]! < distance[axis]!) axis = i;
  const n = [0, 0, 0]; n[axis] = local[axis]! < 0 ? -1 : 1;
  const c = Math.cos(box.yaw); const s = Math.sin(box.yaw);
  return [c * n[0]! + s * n[2]!, n[1]!, -s * n[0]! + c * n[2]!];
}

/** Deliberately bounded comparison candidate; reports nonconvergence instead of claiming a miss. */
export function traceGiSdf(scene: GiSceneData, ray: GiRay): GiTraceHit {
  validateGiRay(ray);
  let distance = ray.tMin; let primitiveTests = 0;
  for (let step = 0; step < giTraceLimits.sdfSteps; step++) {
    const point: GiVec3 = [ray.origin[0] + ray.direction[0] * distance, ray.origin[1] + ray.direction[1] * distance, ray.origin[2] + ray.direction[2] * distance];
    let nearest = Infinity; let boxId = 0;
    for (const box of scene.boxes) { const d = giBoxSignedDistance(box, point); primitiveTests++; if (d < nearest) { nearest = d; boxId = box.id; } }
    if (Math.abs(nearest) <= giTraceLimits.epsilon) {
      const box = scene.boxes[boxId]!;
      return { distance, triangleId: missingId, materialId: box.materialId, boxId, normal: boxNormal(box, point), status: 1, nodeVisits: 0, primitiveTests, steps: step + 1 };
    }
    distance += Math.abs(nearest) * 0.9;
    if (distance > ray.tMax) return { ...miss(ray), primitiveTests, steps: step + 1 };
  }
  return { ...miss(ray), status: 2, primitiveTests, steps: giTraceLimits.sdfSteps };
}

export function packGiRays(rays: readonly GiRay[]): ArrayBuffer {
  if (!rays.length || rays.length > 65536) invalid('ray batch must contain 1..65536 rays.');
  const buffer = new ArrayBuffer(rays.length * giTraceStrides.ray); const view = new DataView(buffer);
  rays.forEach((ray, i) => { validateGiRay(ray); setVector(view, i * 32, ray.origin); view.setFloat32(i * 32 + 12, ray.tMin, true); setVector(view, i * 32 + 16, ray.direction); view.setFloat32(i * 32 + 28, ray.tMax, true); });
  return buffer;
}

/** Seeded incoherent rays from free space; solid-origin behavior is tested explicitly elsewhere. */
export function createGiReferenceRays(scene: GiSceneData, count = 4096, seed = 1337): readonly GiRay[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 65536 || !Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) invalid('invalid reference ray count or seed.');
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
  const rays: GiRay[] = [];
  for (let i = 0; i < count; i++) {
    let origin: GiVec3 = [0, 0, 0];
    for (let attempt = 0; attempt < 100; attempt++) {
      origin = [(random() - 0.5) * 14, random() * 5 + 0.01, (random() - 0.5) * 10];
      if (scene.boxes.every(box => giBoxSignedDistance(box, origin) > 0.002)) break;
      if (attempt === 99) invalid('cannot place a free-space reference origin.');
    }
    const z = random() * 2 - 1; const angle = random() * Math.PI * 2; const radial = Math.sqrt(Math.max(0, 1 - z * z));
    rays.push({ origin, direction: [Math.cos(angle) * radial, z, Math.sin(angle) * radial], tMin: 0.0005, tMax: 24 });
  }
  return rays;
}
