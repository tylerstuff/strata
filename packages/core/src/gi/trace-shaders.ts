import { StrataError } from '../errors.js';

/** Five bindings: read-only nodes, triangles, boxes, materials, then the 48-byte uniform. */
export function giTraceShader(options: { group?: number; firstBinding?: number } = {}): string {
  const group = options.group ?? 1; const first = options.firstBinding ?? 0;
  if (!Number.isInteger(group) || group < 0 || group > 3 || !Number.isInteger(first) || first < 0 || first > 995) {
    throw new StrataError('INVALID_OPTIONS', 'Invalid GI trace shader binding locations.');
  }
  return /* wgsl */ `
struct GiBvhNode { minimum: vec3f, first: u32, maximum: vec3f, count: u32, };
struct GiTraceTriangle { p0: vec3f, materialId: u32, edge1: vec3f, boxId: u32, edge2: vec3f, sourceId: u32, normal: vec3f, padding: f32, };
struct GiTraceBox { center: vec3f, materialId: u32, halfSize: vec3f, boxId: u32, rotation: vec4f, };
struct GiTraceMaterial { albedo: vec3f, roughness: f32, emission: vec3f, metallic: f32, };
struct GiTraceConfiguration { lightDirection: vec3f, rayEpsilon: f32, lightRadiance: vec3f, maxDistance: f32, counts: vec4u, };
struct GiRay { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, };
struct GiTraceHit {
  distance: f32, triangleId: u32, materialId: u32, boxId: u32,
  normal: vec3f, status: u32,
  nodeVisits: u32, primitiveTests: u32, steps: u32, padding: u32,
};
@group(${group}) @binding(${first}) var<storage, read> giNodes: array<GiBvhNode>;
@group(${group}) @binding(${first + 1}) var<storage, read> giTriangles: array<GiTraceTriangle>;
@group(${group}) @binding(${first + 2}) var<storage, read> giBoxes: array<GiTraceBox>;
@group(${group}) @binding(${first + 3}) var<storage, read> giMaterials: array<GiTraceMaterial>;
@group(${group}) @binding(${first + 4}) var<uniform> giTraceConfig: GiTraceConfiguration;

fn giEmptyHit(ray: GiRay) -> GiTraceHit {
  var hit: GiTraceHit;
  hit.distance = ray.tMax; hit.triangleId = 0xffffffffu; hit.materialId = 0xffffffffu; hit.boxId = 0xffffffffu;
  return hit;
}
fn giValidRay(ray: GiRay) -> bool {
  let lengthSquared = dot(ray.direction, ray.direction);
  return all(abs(ray.origin) <= vec3f(1000.0)) && lengthSquared > 0.9999 && lengthSquared < 1.0001
    && ray.tMin >= 0.0 && ray.tMax > ray.tMin && ray.tMax <= 1000.0;
}
// Explicit parallel-axis handling avoids 0 * infinity NaNs on box boundaries.
fn giBoxEntry(ray: GiRay, minimum: vec3f, maximum: vec3f, limit: f32) -> f32 {
  var near = ray.tMin; var far = limit;
  for (var axis = 0u; axis < 3u; axis++) {
    let origin = ray.origin[axis]; let direction = ray.direction[axis];
    if (abs(direction) < 1e-20) {
      if (origin < minimum[axis] || origin > maximum[axis]) { return -1.0; }
    } else {
      let a = (minimum[axis] - origin) / direction; let b = (maximum[axis] - origin) / direction;
      near = max(near, min(a, b)); far = min(far, max(a, b));
      if (far < near) { return -1.0; }
    }
  }
  return near;
}
fn giTriangleDistance(ray: GiRay, triangle: GiTraceTriangle) -> f32 {
  let p = cross(ray.direction, triangle.edge2); let determinant = dot(triangle.edge1, p);
  if (abs(determinant) < 1e-8) { return -1.0; }
  let inverse = 1.0 / determinant; let s = ray.origin - triangle.p0; let u = dot(s, p) * inverse;
  if (u < 0.0 || u > 1.0) { return -1.0; }
  let q = cross(s, triangle.edge1); let v = dot(ray.direction, q) * inverse;
  if (v < 0.0 || u + v > 1.0) { return -1.0; }
  let distance = dot(triangle.edge2, q) * inverse;
  if (distance < ray.tMin || distance > ray.tMax) { return -1.0; }
  return distance;
}
fn giTraverseBvh(ray: GiRay, anyHit: bool) -> GiTraceHit {
  var hit = giEmptyHit(ray);
  let nodeCount = giTraceConfig.counts.x; let triangleCount = giTraceConfig.counts.y;
  if (!giValidRay(ray) || nodeCount == 0u || nodeCount > 8191u || triangleCount == 0u || triangleCount > 4096u
    || nodeCount > arrayLength(&giNodes) || triangleCount > arrayLength(&giTriangles)) { hit.status = 2u; return hit; }
  var stack: array<u32, 32>; stack[0] = 0u; var stackSize = 1u;
  loop {
    if (stackSize == 0u) { break; }
    stackSize--; let id = stack[stackSize]; hit.nodeVisits++;
    if (id >= nodeCount || hit.nodeVisits > 8191u) { hit.status = 2u; return hit; }
    let node = giNodes[id];
    if (giBoxEntry(ray, node.minimum, node.maximum, hit.distance) < 0.0) { continue; }
    if (node.count == 0u) {
      if (node.first >= nodeCount - 1u) { hit.status = 2u; return hit; }
      let left = giNodes[node.first]; let right = giNodes[node.first + 1u];
      let a = giBoxEntry(ray, left.minimum, left.maximum, hit.distance);
      let b = giBoxEntry(ray, right.minimum, right.maximum, hit.distance);
      let needed = select(0u, 1u, a >= 0.0) + select(0u, 1u, b >= 0.0);
      if (stackSize + needed > 32u) { hit.status = 2u; return hit; }
      if (a >= 0.0 && b >= 0.0) {
        let leftFirst = a <= b;
        stack[stackSize] = select(node.first, node.first + 1u, leftFirst); stackSize++;
        stack[stackSize] = select(node.first + 1u, node.first, leftFirst); stackSize++;
      } else if (a >= 0.0) { stack[stackSize] = node.first; stackSize++; }
      else if (b >= 0.0) { stack[stackSize] = node.first + 1u; stackSize++; }
      continue;
    }
    if (node.count > 4u || node.first > triangleCount || node.count > triangleCount - node.first) { hit.status = 2u; return hit; }
    for (var index = node.first; index < node.first + node.count; index++) {
      let triangle = giTriangles[index]; hit.primitiveTests++;
      let distance = giTriangleDistance(ray, triangle);
      if (distance >= 0.0 && (hit.status == 0u || distance < hit.distance || (distance == hit.distance && triangle.sourceId < hit.triangleId))) {
        // 0xfffffffe identifies the persistent non-box triangle source; never index giBoxes with it.
        if (triangle.materialId >= giTraceConfig.counts.w
          || (triangle.boxId >= giTraceConfig.counts.z && triangle.boxId != 0xfffffffeu)) { hit.status = 2u; return hit; }
        hit.distance = distance; hit.normal = triangle.normal; hit.triangleId = triangle.sourceId;
        hit.materialId = triangle.materialId; hit.boxId = triangle.boxId; hit.status = 1u;
        if (anyHit) { return hit; }
      }
    }
  }
  return hit;
}
fn giTraceBvh(ray: GiRay) -> GiTraceHit { return giTraverseBvh(ray, false); }
fn giTraceAnyBvh(ray: GiRay) -> GiTraceHit { return giTraverseBvh(ray, true); }

fn giBoxLocal(box: GiTraceBox, point: vec3f) -> vec3f {
  let p = point - box.center; let c = box.rotation.x; let s = box.rotation.y;
  return vec3f(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
}
fn giSignedBoxDistance(box: GiTraceBox, point: vec3f) -> f32 {
  let q = abs(giBoxLocal(box, point)) - box.halfSize;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}
fn giSdfBoxNormal(box: GiTraceBox, point: vec3f) -> vec3f {
  let p = giBoxLocal(box, point); let distances = abs(abs(p) - box.halfSize);
  var axis = 0u; if (distances.y < distances[axis]) { axis = 1u; } if (distances.z < distances[axis]) { axis = 2u; }
  var normal = vec3f(0.0); normal[axis] = select(1.0, -1.0, p[axis] < 0.0);
  let c = box.rotation.x; let s = box.rotation.y;
  return vec3f(c * normal.x + s * normal.z, normal.y, -s * normal.x + c * normal.z);
}
fn giTraceSdf(ray: GiRay) -> GiTraceHit {
  var hit = giEmptyHit(ray); let count = giTraceConfig.counts.z;
  // A box-only SDF cannot silently stand in for a scene containing static mesh triangles.
  if (!giValidRay(ray) || count == 0u || count > 341u || count > arrayLength(&giBoxes)
    || giTraceConfig.counts.y != count * 12u) { hit.status = 2u; return hit; }
  var distance = ray.tMin;
  for (var step = 0u; step < 128u; step++) {
    let point = ray.origin + ray.direction * distance;
    var nearest = 1e30; var nearestBox = 0u;
    for (var index = 0u; index < count; index++) {
      let d = giSignedBoxDistance(giBoxes[index], point); hit.primitiveTests++;
      if (d < nearest) { nearest = d; nearestBox = index; }
    }
    hit.steps = step + 1u;
    if (abs(nearest) <= 0.0002) {
      let box = giBoxes[nearestBox];
      if (box.materialId >= giTraceConfig.counts.w || box.boxId >= count) { hit.status = 2u; return hit; }
      hit.distance = distance; hit.materialId = box.materialId; hit.boxId = box.boxId;
      hit.normal = giSdfBoxNormal(box, point); hit.status = 1u; return hit;
    }
    distance += abs(nearest) * 0.9;
    if (distance > ray.tMax) { return hit; }
  }
  hit.status = 2u; return hit;
}
`;
}
