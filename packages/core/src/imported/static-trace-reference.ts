/** CPU-only oracle for generated static-tracer tests; no GPU or runtime dependency. */
export type StaticTracePoint = readonly [number, number, number];
export interface StaticTraceReferenceRay {
  readonly origin: StaticTracePoint;
  readonly direction: StaticTracePoint;
  readonly tMin: number;
  readonly tMax: number;
}
export interface StaticTraceReferenceHit {
  readonly status: 0 | 1 | 2 | 3;
  readonly triangle: number;
  readonly distance: number;
  readonly barycentric: readonly [number, number];
  readonly nodeVisits: number;
}

const subtract = (a: StaticTracePoint, b: StaticTracePoint): StaticTracePoint => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: StaticTracePoint, b: StaticTracePoint) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: StaticTracePoint, b: StaticTracePoint): StaticTracePoint =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Independent f64 ray/plane intersection followed by a projected 2x2 solve. */
export function intersectStaticTriangleReference(
  ray: StaticTraceReferenceRay, p0: StaticTracePoint, p1: StaticTracePoint, p2: StaticTracePoint, cullBackfaces = false,
): { distance: number; barycentric: readonly [number, number] } | null {
  let e1 = subtract(p1, p0), e2 = subtract(p2, p0);
  const scale = Math.max(...e1.map(Math.abs), ...e2.map(Math.abs));
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  e1 = e1.map(value => value / scale) as unknown as StaticTracePoint;
  e2 = e2.map(value => value / scale) as unknown as StaticTracePoint;
  const normal = cross(e1, e2), denominator = dot(normal, ray.direction);
  if (denominator === 0 || (cullBackfaces && denominator >= 0)) return null;
  const distance = dot(normal, subtract(p0, ray.origin)) / denominator;
  if (!Number.isFinite(distance) || distance < ray.tMin || distance > ray.tMax) return null;
  const relative = ray.origin.map((value, axis) => (value - p0[axis]! + ray.direction[axis]! * distance) / scale);
  const dominant = normal.reduce((best, value, axis) => Math.abs(value) > Math.abs(normal[best]!) ? axis : best, 0);
  const x = (dominant + 1) % 3, y = (dominant + 2) % 3;
  const determinant = e1[x]! * e2[y]! - e1[y]! * e2[x]!;
  const u = (relative[x]! * e2[y]! - relative[y]! * e2[x]!) / determinant;
  const v = (e1[x]! * relative[y]! - e1[y]! * relative[x]!) / determinant;
  return u >= 0 && v >= 0 && u + v <= 1 ? { distance, barycentric: [u, v] } : null;
}

interface Node { readonly min: StaticTracePoint; readonly max: StaticTracePoint; readonly first: number; readonly count: number }
interface Triangle { readonly p0: StaticTracePoint; readonly p1: StaticTracePoint; readonly p2: StaticTracePoint; readonly source: number }

/**
 * Structural/budget reference over packed buffers. AABB entries are measured
 * once when queued, with near-first DFS as in the documented runtime contract.
 * Triangle math is independent of the production sheared edge formulation.
 */
export function traceStaticReference(
  nodesBuffer: ArrayBuffer, trianglesBuffer: ArrayBuffer, ray: StaticTraceReferenceRay,
  options: { readonly maxVisits: number; readonly anyHit?: boolean; readonly cullBackfaces?: boolean },
): StaticTraceReferenceHit {
  const result = (status: 0 | 1 | 2 | 3, nodeVisits: number, distance = ray.tMax): StaticTraceReferenceHit =>
    ({ status, triangle: 0xffffffff, distance, barycentric: [0, 0], nodeVisits });
  if (![...ray.origin, ...ray.direction, ray.tMin, ray.tMax].every(Number.isFinite) || ray.direction.every(value => value === 0)
    || ray.tMin < 0 || ray.tMax < ray.tMin || !Number.isInteger(options.maxVisits) || options.maxVisits < 0 || options.maxVisits > 0xffffffff) return result(3, 0, 0);
  if (!nodesBuffer.byteLength || nodesBuffer.byteLength % 32 || !trianglesBuffer.byteLength || trianglesBuffer.byteLength % 64) return result(3, 0);
  const nodes = new DataView(nodesBuffer), triangles = new DataView(trianglesBuffer);
  const nodeCount = nodesBuffer.byteLength / 32, triangleCount = trianglesBuffer.byteLength / 64;
  if (triangleCount > 1_048_576 || nodeCount > triangleCount * 2 - 1) return result(3, 0);
  const limit = Math.min(options.maxVisits, nodeCount);
  if (!limit) return result(2, 0);
  const vector = (view: DataView, offset: number): StaticTracePoint =>
    [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)];
  const node = (id: number): Node => ({ min: vector(nodes, id * 32), max: vector(nodes, id * 32 + 16),
    first: nodes.getUint32(id * 32 + 12, true), count: nodes.getUint32(id * 32 + 28, true) });
  const validNode = (n: Node) => [...n.min, ...n.max].every(Number.isFinite) && n.min.every((value, axis) => value <= n.max[axis]!);
  const entry = (n: Node, upper: number): number | null => {
    let near = ray.tMin, far = upper;
    for (let axis = 0; axis < 3; axis++) {
      const o = ray.origin[axis]!, d = ray.direction[axis]!;
      if (d === 0) { if (o < n.min[axis]! || o > n.max[axis]!) return null; }
      else {
        const a = (n.min[axis]! - o) / d, b = (n.max[axis]! - o) / d;
        near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
        if (near > far) return null;
      }
    }
    return near;
  };
  let visits = 1;
  const root = node(0);
  if (!validNode(root)) return result(3, visits);
  const rootEntry = entry(root, ray.tMax);
  if (rootEntry === null) return result(0, visits);
  const pending = [{ id: 0, depth: 1, entry: rootEntry }];
  let hit = result(0, visits), previousSource = 0xffffffff;
  while (pending.length) {
    const item = pending.pop()!;
    if (item.entry > hit.distance) continue;
    const n = node(item.id);
    if (!n.count) {
      if (item.depth >= 32 || nodeCount < 2 || n.first <= item.id || n.first >= nodeCount - 1) return result(3, visits);
      const children: { id: number; depth: number; entry: number }[] = [];
      for (const id of [n.first, n.first + 1]) {
        if (visits >= limit) return result(2, visits);
        visits++;
        const child = node(id);
        if (!validNode(child) || child.min.some((value, axis) => value < n.min[axis]!) || child.max.some((value, axis) => value > n.max[axis]!)) return result(3, visits);
        const near = entry(child, hit.distance);
        if (near !== null) children.push({ id, depth: item.depth + 1, entry: near });
      }
      if (pending.length + children.length > 32) return result(3, visits);
      children.sort((a, b) => b.entry - a.entry || b.id - a.id);
      pending.push(...children);
    } else {
      if (n.count > 4 || n.first >= triangleCount || n.count > triangleCount - n.first) return result(3, visits);
      for (let index = n.first; index < n.first + n.count; index++) {
        const offset = index * 64;
        const triangle: Triangle = { p0: vector(triangles, offset), p1: vector(triangles, offset + 16),
          p2: vector(triangles, offset + 32), source: triangles.getUint32(offset + 44, true) };
        const normal = vector(triangles, offset + 48);
        if (triangle.source >= triangleCount || triangles.getUint32(offset + 12, true) !== 0 || triangles.getUint32(offset + 60, true) !== 0
          || ![...triangle.p0, ...triangle.p1, ...triangle.p2, ...normal].every(Number.isFinite) || normal.every(value => value === 0)) return result(3, visits);
        const intersection = intersectStaticTriangleReference({ ...ray, tMax: hit.distance }, triangle.p0, triangle.p1, triangle.p2, options.cullBackfaces);
        if (intersection && (hit.status === 0 || intersection.distance < hit.distance
          || (intersection.distance === hit.distance && (triangle.source < previousSource || (triangle.source === previousSource && index < hit.triangle))))) {
          hit = { status: 1, triangle: index, ...intersection, nodeVisits: visits }; previousSource = triangle.source;
          if (options.anyHit) return hit;
        }
      }
    }
  }
  return { ...hit, nodeVisits: visits };
}

/** f32 reference for the scale-relative geometric bias and final outward ULP. */
export function offsetStaticTraceReference(point: StaticTracePoint, normal: StaticTracePoint,
  p0: StaticTracePoint, p1: StaticTracePoint, p2: StaticTracePoint): StaticTracePoint {
  const f = Math.fround;
  const extent = Math.max(...subtract(p1, p0).map(value => Math.abs(f(value))), ...subtract(p2, p0).map(value => Math.abs(f(value))));
  const error = [0, 1, 2].map(axis => f(2.384185791015625e-7 * f(Math.max(Math.abs(p0[axis]!), Math.abs(p1[axis]!), Math.abs(p2[axis]!)) + extent)));
  const distance = f(f(f(Math.abs(normal[0]) * error[0]!) + f(Math.abs(normal[1]) * error[1]!)) + f(Math.abs(normal[2]) * error[2]!));
  const word = new Uint32Array(1), scalar = new Float32Array(word.buffer);
  return point.map((value, axis) => {
    scalar[0] = f(value + f(normal[axis]! * distance));
    if (normal[axis] === 0) return scalar[0]!;
    if (scalar[0] === 0) return normal[axis]! > 0 ? 2 ** -126 : -(2 ** -126);
    word[0] = word[0]! + ((scalar[0]! < 0) === (normal[axis]! > 0) ? -1 : 1);
    return scalar[0]!;
  }) as unknown as StaticTracePoint;
}
