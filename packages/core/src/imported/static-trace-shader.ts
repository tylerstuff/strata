/**
 * Internal static-BVH WGSL library. The caller declares read-only storage globals
 * `staticTraceNodes: array<StaticTraceNode>` and
 * `staticTraceTriangles: array<StaticTraceTriangle>` at its own binding locations.
 * Bind only the used node/triangle ranges: arrayLength is the authoritative count.
 *
 * Triangle identifies the packed BVH record; its sourceTriangleId identifies the
 * original index triplet. Barycentrics are the weights of original p1 and p2.
 * Ray limits are inclusive. Directions need not be normalized; distance is the
 * ray parameter, so callers needing world distances supply unit directions.
 * nodeVisits counts AABB evaluations, including rejected child boxes. Closest
 * hits require complete traversal; invalid/exhausted results erase provisional
 * hits. Occlusion may return as soon as an opaque blocker is proved.
 *
 * Original-position dominant-axis shear avoids an absolute area cutoff. This is
 * finite f32 tracing, not an exact-predicate or certified watertight algorithm.
 * The host still validates topology, bounds and geometry before GPU upload.
 */
export const staticTraceShader = /* wgsl */ `
struct StaticTraceNode { minimum: vec3f, first: u32, maximum: vec3f, count: u32, };
struct StaticTraceTriangle {
  p0: vec3f, materialId: u32,
  p1: vec3f, sourceVertex0: u32,
  p2: vec3f, sourceTriangleId: u32,
  normal: vec3f, padding: u32,
};
struct StaticTraceHit {
  status: u32, triangle: u32, distance: f32,
  barycentric: vec2f, nodeVisits: u32,
};
struct StaticTriangleIntersection { status: u32, distance: f32, barycentric: vec2f, };
struct StaticTracePending { node: u32, depth: u32, entry: f32, };

fn staticFinite(value: f32) -> bool {
  return (bitcast<u32>(value) & 0x7f800000u) != 0x7f800000u;
}
fn staticFinite3(value: vec3f) -> bool {
  return all((bitcast<vec3u>(value) & vec3u(0x7f800000u)) != vec3u(0x7f800000u));
}
fn staticResult(status: u32, distance: f32, visits: u32) -> StaticTraceHit {
  var result: StaticTraceHit;
  result.status = status; result.triangle = 0xffffffffu;
  result.distance = distance; result.nodeVisits = visits;
  return result;
}
fn staticValidNode(node: StaticTraceNode) -> bool {
  return staticFinite3(node.minimum) && staticFinite3(node.maximum) && all(node.minimum <= node.maximum);
}

// Parallel axes are tested explicitly, including rays lying on a slab boundary.
// For nonparallel axes, clamp numerators against the finite ray segment first;
// very small directions therefore cannot require an overflowing division.
fn staticBoxEntry(origin: vec3f, direction: vec3f, minimum: vec3f, maximum: vec3f,
  tMin: f32, tMax: f32) -> f32 {
  var near = tMin; var far = tMax;
  for (var axis = 0u; axis < 3u; axis++) {
    let d = direction[axis]; let o = origin[axis];
    if (d == 0.0) {
      if (o < minimum[axis] || o > maximum[axis]) { return -1.0; }
    } else {
      let magnitude = abs(d);
      let low = select(o - maximum[axis], minimum[axis] - o, d > 0.0);
      let high = select(o - minimum[axis], maximum[axis] - o, d > 0.0);
      let segmentNear = near * magnitude; let segmentFar = far * magnitude;
      if (high < segmentNear || low > segmentFar) { return -1.0; }
      if (low > segmentNear) { near = low / magnitude; }
      if (high < segmentFar) { far = high / magnitude; }
    }
  }
  return near;
}

fn staticTriangle(origin: vec3f, direction: vec3f, triangle: StaticTraceTriangle,
  tMin: f32, tMax: f32, cullBackfaces: bool) -> StaticTriangleIntersection {
  var result: StaticTriangleIntersection;
  if (!staticFinite3(triangle.p0) || !staticFinite3(triangle.p1) || !staticFinite3(triangle.p2)
    || !staticFinite3(triangle.normal) || !any(triangle.normal != vec3f(0.0))) {
    result.status = 3u; return result;
  }
  let directionScale = max(abs(direction.x), max(abs(direction.y), abs(direction.z)));
  let facing = dot(triangle.normal, direction / directionScale);
  if (!staticFinite(facing)) { result.status = 3u; return result; }
  if (cullBackfaces && facing >= 0.0) { return result; }
  var kz = 0u;
  if (abs(direction.y) > abs(direction[kz])) { kz = 1u; }
  if (abs(direction.z) > abs(direction[kz])) { kz = 2u; }
  var kx = (kz + 1u) % 3u; var ky = (kx + 1u) % 3u;
  if (direction[kz] < 0.0) { let saved = kx; kx = ky; ky = saved; }
  let a = triangle.p0 - origin; let b = triangle.p1 - origin; let c = triangle.p2 - origin;
  if (!staticFinite3(a) || !staticFinite3(b) || !staticFinite3(c)) { result.status = 3u; return result; }
  let sx = direction[kx] / direction[kz]; let sy = direction[ky] / direction[kz];
  var pa = vec2f(a[kx] - sx * a[kz], a[ky] - sy * a[kz]);
  var pb = vec2f(b[kx] - sx * b[kz], b[ky] - sy * b[kz]);
  var pc = vec2f(c[kx] - sx * c[kz], c[ky] - sy * c[kz]);
  let scale = max(max(abs(pa.x), abs(pa.y)), max(max(abs(pb.x), abs(pb.y)), max(abs(pc.x), abs(pc.y))));
  if (!staticFinite(scale)) { result.status = 3u; return result; }
  if (!(scale > 0.0)) { result.status = select(3u, 0u, facing == 0.0); return result; }
  // Rescale the projected footprint before products. Tiny triangles retain
  // area without an absolute determinant epsilon or squared-length underflow.
  pa /= scale; pb /= scale; pc /= scale;
  let e0 = pb.x * pc.y - pb.y * pc.x;
  let e1 = pc.x * pa.y - pc.y * pa.x;
  let e2 = pa.x * pb.y - pa.y * pb.x;
  if ((e0 < 0.0 || e1 < 0.0 || e2 < 0.0) && (e0 > 0.0 || e1 > 0.0 || e2 > 0.0)) { return result; }
  let determinant = e0 + e1 + e2;
  if (determinant == 0.0) { result.status = select(3u, 0u, facing == 0.0); return result; }
  let barycentric = vec3f(e0, e1, e2) / determinant;
  let distance = dot(barycentric, vec3f(a[kz], b[kz], c[kz]) / direction[kz]);
  if (!staticFinite(distance) || !staticFinite3(barycentric)) { result.status = 3u; return result; }
  if (distance < tMin || distance > tMax) { return result; }
  result.status = 1u; result.distance = distance; result.barycentric = barycentric.yz;
  return result;
}

fn traverseStatic(origin: vec3f, direction: vec3f, tMin: f32, tMax: f32,
  maxVisits: u32, anyHit: bool, cullBackfaces: bool) -> StaticTraceHit {
  if (!staticFinite3(origin) || !staticFinite3(direction) || !any(direction != vec3f(0.0))
    || !staticFinite(tMin) || !staticFinite(tMax) || tMin < 0.0 || tMax < tMin
    || !staticFinite3(direction * tMax) || !staticFinite3(origin + direction * tMax)) {
    return staticResult(3u, 0.0, 0u);
  }
  let nodeCount = arrayLength(&staticTraceNodes); let triangleCount = arrayLength(&staticTraceTriangles);
  if (triangleCount == 0u || triangleCount > 1048576u || nodeCount == 0u || nodeCount > triangleCount * 2u - 1u) {
    return staticResult(3u, tMax, 0u);
  }
  // A validated tree visits each node at most once. This secondary limit also
  // bounds malformed shared-child graphs even when a caller supplies UINT_MAX.
  let visitLimit = min(maxVisits, nodeCount);
  if (visitLimit == 0u) { return staticResult(2u, tMax, 0u); }
  let root = staticTraceNodes[0];
  if (!staticValidNode(root)) { return staticResult(3u, tMax, 1u); }
  let entry = staticBoxEntry(origin, direction, root.minimum, root.maximum, tMin, tMax);
  var hit = staticResult(0u, tMax, 1u);
  if (entry < 0.0) { return hit; }
  var stack: array<StaticTracePending, 32>;
  stack[0] = StaticTracePending(0u, 1u, entry); var stackSize = 1u;
  loop {
    if (stackSize == 0u) { break; }
    stackSize--; let pending = stack[stackSize];
    if (pending.entry > hit.distance) { continue; }
    let node = staticTraceNodes[pending.node];
    if (node.count == 0u) {
      if (pending.depth >= 32u || nodeCount < 2u || node.first <= pending.node || node.first >= nodeCount - 1u) {
        return staticResult(3u, tMax, hit.nodeVisits);
      }
      var entries = vec2f(-1.0);
      for (var side = 0u; side < 2u; side++) {
        if (hit.nodeVisits >= visitLimit) { return staticResult(2u, tMax, hit.nodeVisits); }
        let child = staticTraceNodes[node.first + side]; hit.nodeVisits++;
        if (!staticValidNode(child) || any(child.minimum < node.minimum) || any(child.maximum > node.maximum)) {
          return staticResult(3u, tMax, hit.nodeVisits);
        }
        entries[side] = staticBoxEntry(origin, direction, child.minimum, child.maximum, tMin, hit.distance);
      }
      let needed = select(0u, 1u, entries.x >= 0.0) + select(0u, 1u, entries.y >= 0.0);
      if (stackSize + needed > 32u) { return staticResult(3u, tMax, hit.nodeVisits); }
      let nearSide = select(1u, 0u, entries.x <= entries.y);
      for (var order = 0u; order < 2u; order++) {
        let side = select(1u - nearSide, nearSide, order == 1u);
        if (entries[side] >= 0.0) {
          stack[stackSize] = StaticTracePending(node.first + side, pending.depth + 1u, entries[side]); stackSize++;
        }
      }
    } else {
      if (node.count > 4u || node.first >= triangleCount || node.count > triangleCount - node.first) {
        return staticResult(3u, tMax, hit.nodeVisits);
      }
      for (var index = node.first; index < node.first + node.count; index++) {
        let triangle = staticTraceTriangles[index];
        if (triangle.sourceTriangleId >= triangleCount || triangle.materialId != 0u || triangle.padding != 0u) {
          return staticResult(3u, tMax, hit.nodeVisits);
        }
        let intersection = staticTriangle(origin, direction, triangle, tMin, hit.distance, cullBackfaces);
        if (intersection.status == 3u) { return staticResult(3u, tMax, hit.nodeVisits); }
        if (intersection.status == 1u) {
          var prefer = hit.status == 0u || intersection.distance < hit.distance;
          if (hit.status == 1u && intersection.distance == hit.distance) {
            let previousId = staticTraceTriangles[hit.triangle].sourceTriangleId;
            prefer = triangle.sourceTriangleId < previousId || (triangle.sourceTriangleId == previousId && index < hit.triangle);
          }
          if (prefer) {
            hit.status = 1u; hit.triangle = index; hit.distance = intersection.distance; hit.barycentric = intersection.barycentric;
          }
          if (anyHit) { return hit; }
        }
      }
    }
  }
  return hit;
}
fn traceStatic(origin: vec3f, direction: vec3f, tMin: f32, tMax: f32, maxVisits: u32) -> StaticTraceHit {
  return traverseStatic(origin, direction, tMin, tMax, maxVisits, false, false);
}
fn traceStaticVisible(origin: vec3f, direction: vec3f, tMin: f32, tMax: f32, maxVisits: u32, cullBackfaces: bool) -> StaticTraceHit {
  return traverseStatic(origin, direction, tMin, tMax, maxVisits, false, cullBackfaces);
}
fn traceStaticOcclusion(origin: vec3f, direction: vec3f, tMin: f32, tMax: f32, maxVisits: u32) -> StaticTraceHit {
  return traverseStatic(origin, direction, tMin, tMax, maxVisits, true, false);
}

// Supply the oriented unit GEOMETRIC normal. This scale-relative error allowance
// plus one representable outward step is deliberately independent of texture
// normals. It is a practical f32 bias, not a certified intersection error bound.
fn staticTraceOffset(point: vec3f, normal: vec3f, triangle: StaticTraceTriangle) -> vec3f {
  let e1 = abs(triangle.p1 - triangle.p0); let e2 = abs(triangle.p2 - triangle.p0);
  let extent = max(max(e1.x, max(e1.y, e1.z)), max(e2.x, max(e2.y, e2.z)));
  let magnitude = max(abs(triangle.p0), max(abs(triangle.p1), abs(triangle.p2)));
  let error = 2.384185791015625e-7 * (magnitude + vec3f(extent));
  var shifted = point + normal * dot(abs(normal), error);
  for (var axis = 0u; axis < 3u; axis++) {
    if (normal[axis] == 0.0) { continue; }
    if (shifted[axis] == 0.0) {
      // WebGPU may flush subnormal values. The smallest normal is still vastly
      // below the represented normalized-preview geometry scale.
      shifted[axis] = select(-1.1754943508222875e-38, 1.1754943508222875e-38, normal[axis] > 0.0);
    } else {
      let bits = bitcast<u32>(shifted[axis]);
      let decrement = (shifted[axis] < 0.0) == (normal[axis] > 0.0);
      shifted[axis] = bitcast<f32>(select(bits + 1u, bits - 1u, decrement));
    }
  }
  return shifted;
}
`;
