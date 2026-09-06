/** Test-only independent source geometry, exact-dyadic bounds, and ray oracle.
 * Imports are types only: production packing/traversal/updater helpers are not reused.
 */
import type { GiBox, GiSceneData, GiTriangle, GiVec3 } from '../../packages/core/src/gi/scene-data.js';
import type { GiRay, GiTraceData } from '../../packages/core/src/gi/trace-data.js';
export const updateOracleGates = Object.freeze({ seed: 0x20201337, rays: 512, minNonBoundary: 384,
  distanceAbsolute: 2e-4, distanceRelative: 2e-5, normalDot: .9999, barycentricMargin: 1e-4, parallelCosine: 1e-4, tieDistance: 2e-4 });
const vec = (x: readonly number[]): GiVec3 => [x[0]!, x[1]!, x[2]!];
const sub = (a: GiVec3, b: GiVec3): GiVec3 => vec(a.map((x, i) => x - b[i]!));
const dot = (a: GiVec3, b: GiVec3) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const cross = (a: GiVec3, b: GiVec3): GiVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: GiVec3): GiVec3 => vec(a.map(x => x / Math.hypot(...a)));
const fbits = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0]!;
const fromBits = (x: number) => new Float32Array(new Uint32Array([x]).buffer)[0]!;
/** Exact signed integer in units of the minimum positive binary32 subnormal. */
export function f32Dyadic(x: number): bigint {
  const b = fbits(x), exponent = (b >>> 23) & 255, fraction = b & 0x7fffff;
  if (exponent === 255 || Math.fround(x) !== x) throw new Error('Oracle needs finite actual f32 input.');
  const magnitude = exponent ? BigInt(0x800000 | fraction) << BigInt(exponent - 1) : BigInt(fraction);
  return b >>> 31 ? -magnitude : magnitude;
}
function adjacent(x: number, positive: boolean): number {
  if (x === 0) return positive ? fromBits(1) : fromBits(0x80000001);
  return fromBits((fbits(x) + ((x > 0) === positive ? 1 : -1)) >>> 0);
}
/** Direct exact integer comparisons avoid sharing production compensated-add arithmetic. */
export function directedF32(exact: bigint, positive: boolean): number {
  if (exact === 0n) return 0;
  let candidate = Math.fround(Number(exact) * 2 ** -149);
  while (positive ? f32Dyadic(candidate) < exact : f32Dyadic(candidate) > exact) candidate = adjacent(candidate, positive);
  for (;;) {
    const neighbor = adjacent(candidate, !positive);
    if (positive ? f32Dyadic(neighbor) >= exact : f32Dyadic(neighbor) <= exact) candidate = neighbor; else return candidate;
  }
}
export function referenceBoxPoint(box: GiBox, local: GiVec3): GiVec3 {
  const angle = box.yaw, c = Math.cos(angle), s = Math.sin(angle);
  return [Math.fround(local[0] * c + local[2] * s + box.center[0]), Math.fround(local[1] + box.center[1]),
    Math.fround(local[0] * -s + local[2] * c + box.center[2])];
}
const faces = [
  [0, 6, 2, 0, 4, 6], [1, 3, 7, 1, 7, 5], [0, 5, 4, 0, 1, 5],
  [2, 6, 7, 2, 7, 3], [0, 3, 1, 0, 2, 3], [4, 5, 7, 4, 7, 6],
] as const;
export function referenceUpdateTriangles(scene: GiSceneData, persistent: readonly GiTriangle[] = []): GiTriangle[] {
  const result: GiTriangle[] = [];
  for (const box of scene.boxes) {
    const corners = Array.from({ length: 8 }, (_, bits) => referenceBoxPoint(box, vec(box.halfSize.map((h, axis) => (bits & 1 << axis ? 1 : -1) * h))));
    for (const ids of faces) for (let i = 0; i < 6; i += 3) {
      const p0 = corners[ids[i]!]!, p1 = corners[ids[i + 1]!]!, p2 = corners[ids[i + 2]!]!;
      result.push({ id: result.length, boxId: box.id, materialId: box.materialId, p0, p1, p2, normal: unit(cross(sub(p1, p0), sub(p2, p0))) });
    }
  }
  const offset = result.length;
  for (const t of persistent) result.push({ ...t, id: offset + t.id });
  return result;
}
export function generatedTraceProxy(): GiTriangle[] {
  const result: GiTriangle[] = [];
  // Deliberately synthetic tilted plane; same2048-triangle size, not the canonical cooked heightfield.
  const p = (x: number, z: number): GiVec3 => [x, Math.fround(-1.5 + x / 128 + z / 256), z];
  for (let z = -16; z < 16; z++) for (let x = -16; x < 16; x++) {
    const points = [p(x, z), p(x, z + 1), p(x + 1, z + 1), p(x + 1, z)];
    for (const indices of [[0, 1, 2], [0, 2, 3]]) {
      const p0 = points[indices[0]!]!, p1 = points[indices[1]!]!, p2 = points[indices[2]!]!;
      result.push({ id: result.length, boxId: 0xfffffffe, materialId: 5, p0, p1, p2, normal: vec(unit(cross(sub(p1, p0), sub(p2, p0))).map(Math.fround)) });
    }
  }
  return result;
}
export function conservativeNodeReference(data: GiTraceData, source: readonly GiTriangle[]): ArrayBuffer {
  const result = data.nodeData.slice(0), nodes = new DataView(result), packed = new DataView(data.triangleData);
  for (let node = data.nodeCount - 1; node >= 0; node--) {
    const at = node * 32, first = nodes.getUint32(at + 12, true), count = nodes.getUint32(at + 28, true);
    for (let axis = 0; axis < 3; axis++) {
      let minimum: bigint | undefined, maximum: bigint | undefined;
      const include = (value: bigint) => { if (minimum === undefined || value < minimum) minimum = value; if (maximum === undefined || value > maximum) maximum = value; };
      if (count) for (let slot = first; slot < first + count; slot++) {
        const t = source[data.triangleOrder[slot]!]!;
        for (const point of [t.p0, t.p1, t.p2]) include(f32Dyadic(point[axis]!));
        const p0 = f32Dyadic(packed.getFloat32(slot * 64 + axis * 4, true)); include(p0);
        include(p0 + f32Dyadic(packed.getFloat32(slot * 64 + 16 + axis * 4, true)));
        include(p0 + f32Dyadic(packed.getFloat32(slot * 64 + 32 + axis * 4, true)));
      } else for (const child of [first, first + 1]) {
        include(f32Dyadic(nodes.getFloat32(child * 32 + axis * 4, true))); include(f32Dyadic(nodes.getFloat32(child * 32 + 16 + axis * 4, true)));
      }
      nodes.setFloat32(at + axis * 4, directedF32(minimum!, false), true); nodes.setFloat32(at + 16 + axis * 4, directedF32(maximum!, true), true);
    }
  }
  return result;
}
export function assertConservativeContainment(data: GiTraceData, source: readonly GiTriangle[]): void {
  const n = new DataView(data.nodeData), p = new DataView(data.triangleData);
  for (let node = 0; node < data.nodeCount; node++) {
    const first = n.getUint32(node * 32 + 12, true), count = n.getUint32(node * 32 + 28, true);
    for (let axis = 0; axis < 3; axis++) {
      const lo = f32Dyadic(n.getFloat32(node * 32 + axis * 4, true)), hi = f32Dyadic(n.getFloat32(node * 32 + 16 + axis * 4, true));
      const inside = (value: bigint) => { if (value < lo || value > hi) throw Error(`Nonconservative node${node}/axis${axis}.`); };
      if (!count) for (const child of [first, first + 1]) { inside(f32Dyadic(n.getFloat32(child * 32 + axis * 4, true))); inside(f32Dyadic(n.getFloat32(child * 32 + 16 + axis * 4, true))); }
      else for (let slot = first; slot < first + count; slot++) {
        const t = source[data.triangleOrder[slot]!]!;
        for (const point of [t.p0, t.p1, t.p2]) inside(f32Dyadic(point[axis]!));
        const p0 = f32Dyadic(p.getFloat32(slot * 64 + axis * 4, true)); inside(p0);
        inside(p0 + f32Dyadic(p.getFloat32(slot * 64 + 16 + axis * 4, true))); inside(p0 + f32Dyadic(p.getFloat32(slot * 64 + 32 + axis * 4, true)));
      }
    }
  }
}
export interface UpdateOracleHit { readonly triangle: GiTriangle; readonly distance: number; readonly boundary: boolean }
export function bruteUpdateOracle(ray: GiRay, triangles: readonly GiTriangle[]): UpdateOracleHit | null {
  let best: { triangle: GiTriangle; distance: number; weights: number[]; cosine: number } | undefined, second = Infinity;
  for (const t of triangles) {
    const edge1 = sub(t.p1, t.p0), edge2 = sub(t.p2, t.p0), plane = cross(edge1, edge2), denominator = dot(plane, ray.direction);
    if (Math.abs(denominator) < 1e-12) continue;
    const distance = dot(plane, sub(t.p0, ray.origin)) / denominator;
    if (distance < ray.tMin || distance > ray.tMax) continue;
    const point = vec(ray.origin.map((v, i) => v + ray.direction[i]! * distance)), delta = sub(point, t.p0);
    const a = dot(edge1, edge1), b = dot(edge1, edge2), c = dot(edge2, edge2), d = dot(delta, edge1), e = dot(delta, edge2), determinant = a * c - b * b;
    const u = (d * c - e * b) / determinant, v = (e * a - d * b) / determinant;
    if (u < -1e-10 || v < -1e-10 || u + v > 1 + 1e-10) continue;
    if (!best || distance < best.distance || (distance === best.distance && t.id < best.triangle.id)) {
      if (best) second = Math.min(second, best.distance);
      best = { triangle: t, distance, weights: [1 - u - v, u, v], cosine: Math.abs(denominator) / Math.hypot(...plane) };
    } else second = Math.min(second, distance);
  }
  return best ? { triangle: best.triangle, distance: best.distance, boundary: Math.min(...best.weights) < updateOracleGates.barycentricMargin
    || best.cosine < updateOracleGates.parallelCosine || second - best.distance < updateOracleGates.tieDistance } : null;
}
export interface UpdateRayWitness { readonly category: 'broad' | 'rigid' | 'terrain' | 'mirror'; readonly ray: GiRay }
export function updateRayCorpus(scene: GiSceneData, makeScene: (options: { objectOffset?: number; doorOpen?: boolean }) => GiSceneData): UpdateRayWitness[] {
  const result: UpdateRayWitness[] = [];
  const add = (category: UpdateRayWitness['category'], origin: GiVec3, direction: GiVec3, tMax = 48) => result.push({ category,
    ray: { origin: vec(origin.map(Math.fround)), direction: vec(unit(direction).map(Math.fround)), tMin: Math.fround(.0005), tMax: Math.fround(tMax) } });
  let rng = updateOracleGates.seed;
  const random = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return (rng + .5) / 4294967296; };
  for (let i = 0; i < 256; i++) {
    const origin: GiVec3 = [36 * random() - 18, 12 * random() - 4, 36 * random() - 18], z = 2 * random() - 1, angle = 2 * Math.PI * random(), radial = Math.sqrt(1 - z * z);
    add('broad', origin, [radial * Math.cos(angle), z, radial * Math.sin(angle)]);
  }
  const targetBox = (box: GiBox) => {
    for (let face = 0; face < 6; face++) for (const [a, b] of [[-.6, -.2], [.2, -.6], [.6, .2], [-.2, .6]]) {
      const axis = Math.floor(face / 2), sign = face % 2 ? 1 : -1, local = [0, 0, 0]; local[axis] = sign * box.halfSize[axis]!;
      local[(axis + 1) % 3] = a! * box.halfSize[(axis + 1) % 3]!; local[(axis + 2) % 3] = b! * box.halfSize[(axis + 2) % 3]!;
      const outside = [...local]; outside[axis]! += sign * .25;
      const point = referenceBoxPoint(box, vec(local)), origin = referenceBoxPoint(box, vec(outside)); add('rigid', origin, sub(point, origin), 8);
    }
  };
  for (const offset of [-.4, 0, .4]) targetBox(makeScene({ objectOffset: offset }).boxes[12]!);
  for (const doorOpen of [true, false]) targetBox(makeScene({ doorOpen }).boxes[scene.doorBoxId]!);
  for (let i = 0; i < 8; i++) add('rigid', [-1, 1.1 + i * .08, -.35 + i * .1], [1, 0, 0], i % 2 ? 8 : .7);
  for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) add('terrain', [x * 4 - 14.3, 3, z * 4 - 14.7], [.013, -1, -.007], 32);
  result[result.length - 1] = { category: 'terrain', ray: { origin: [5.5, 1.5, -3.5], direction: vec(unit([2.5, -4.18542041344715, 0]).map(Math.fround)), tMin: Math.fround(.0005), tMax: 32 } };
  const eye: GiVec3 = [-3, 2.4, .2];
  for (const offset of [-.4, 0, .4]) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) {
    const virtual: GiVec3 = [-.8 + (x - 1.5) * .07, .02 - 1.12, .2 + offset + (z - 1.5) * .07];
    const fraction = (eye[1] - .01) / (eye[1] - virtual[1]); const point = vec(eye.map((v, i) => v + fraction * (virtual[i]! - v)));
    const incident = sub(point, eye); add('mirror', [point[0], .012, point[2]], [incident[0], -incident[1], incident[2]], 16);
  }
  for (let i = 0; i < 16; i++) { const point: GiVec3 = [-1.95 + (i % 4) * .3, .01, -.9 + Math.floor(i / 4) * .6], incident = sub(point, eye); add('mirror', [point[0], .012, point[2]], [incident[0], -incident[1], incident[2]], 16); }
  if (result.length !== 512) throw Error('Preregistered ray count drift.'); return result;
}
export function dirtyTopology(data: GiTraceData, boxIds: readonly number[]) {
  const sourceIds = new Set(boxIds.flatMap(box => Array.from({ length: 12 }, (_, t) => box * 12 + t))), slots: number[] = [], leaves = new Set<number>(), ancestors = new Set<number>();
  data.triangleOrder.forEach((id, slot) => { if (sourceIds.has(id)) slots.push(slot); });
  const parent = new Map<number, number>(), nodes = new DataView(data.nodeData);
  for (let n = 0; n < data.nodeCount; n++) {
    const first = nodes.getUint32(n * 32 + 12, true), count = nodes.getUint32(n * 32 + 28, true);
    if (!count) { parent.set(first, n); parent.set(first + 1, n); }
    else if (slots.some(slot => slot >= first && slot < first + count)) leaves.add(n);
  }
  for (const leaf of leaves) { let next = parent.get(leaf); while (next !== undefined) { ancestors.add(next); next = parent.get(next); } }
  return { slots, leaves: [...leaves], ancestors: [...ancestors] };
}

/** Supplemental analytic primitive oracle: transform a ray into each box's local
 * frame and intersect three closed intervals, without triangulation or Gram tests. */
export function analyticBoxUpdateOracle(ray: GiRay, scene: GiSceneData): { boxId: number; distance: number; normal: GiVec3 } | null {
  let best: { boxId: number; distance: number; normal: GiVec3 } | null = null;
  for (const box of scene.boxes) {
    const c = Math.cos(box.yaw), s = Math.sin(box.yaw);
    const dx = ray.origin[0] - box.center[0], dy = ray.origin[1] - box.center[1], dz = ray.origin[2] - box.center[2];
    const origin = [c * dx - s * dz, dy, s * dx + c * dz];
    const direction = [c * ray.direction[0] - s * ray.direction[2], ray.direction[1], s * ray.direction[0] + c * ray.direction[2]];
    let entry = -Infinity, exit = Infinity, entryAxis = 0, exitAxis = 0, entrySign = 0, exitSign = 0;
    for (let axis = 0; axis < 3; axis++) {
      if (direction[axis] === 0) {
        if (Math.abs(origin[axis]!) > box.halfSize[axis]!) { entry = Infinity; exit = -Infinity; break; }
        continue;
      }
      const first = (-box.halfSize[axis]! - origin[axis]!) / direction[axis]!;
      const second = (box.halfSize[axis]! - origin[axis]!) / direction[axis]!;
      const near = Math.min(first, second), far = Math.max(first, second), sign = first < second ? -1 : 1;
      if (near > entry) { entry = near; entryAxis = axis; entrySign = sign; }
      if (far < exit) { exit = far; exitAxis = axis; exitSign = -sign; }
    }
    const inside = entry < ray.tMin, distance = inside ? exit : entry;
    if (entry > exit || distance < ray.tMin || distance > ray.tMax || !Number.isFinite(distance) || (best && distance >= best.distance)) continue;
    const local = [0, 0, 0]; local[inside ? exitAxis : entryAxis] = inside ? exitSign : entrySign;
    best = { boxId: box.id, distance, normal: [c * local[0]! + s * local[2]!, local[1]!, -s * local[0]! + c * local[2]!] };
  }
  return best;
}
