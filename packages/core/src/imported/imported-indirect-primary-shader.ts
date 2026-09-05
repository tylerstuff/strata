/** Optional shared-primary baseline. Uses the base source bindings and spatial record ABI. */
export const importedIndirectPrimaryShader = /* wgsl */ `
const PRIMARY_UNINITIALIZED = 0u;
const PRIMARY_READY = 1u;
const PRIMARY_BACKGROUND = 2u;
const PRIMARY_EXHAUSTED = 3u;
const PRIMARY_INVALID = 4u;
const PRIMARY_STATE_SHIFT = 22u;
const PRIMARY_QUERY_ISSUED = 0x02000000u;
const PRIMARY_MAX_COORDINATE = 1073741824.0; // 2^30.
const PRIMARY_MIN_W = 9.313225746154785e-10; // 2^-30.

fn primaryRecordState(identity: u32) -> u32 { return (identity >> PRIMARY_STATE_SHIFT) & 7u; }
fn primaryFiniteNonnegativeWords(words: vec3u, maximum: f32) -> bool {
  for (var channel = 0u; channel < 3u; channel++) {
    let word = words[channel]; let magnitude = word & 0x7fffffffu;
    if (magnitude != 0u && ((word & 0x80000000u) != 0u || magnitude > bitcast<u32>(maximum))) { return false; }
  }
  return true;
}
fn primaryTriangleValid(triangle: StaticTraceTriangle) -> bool {
  // The source validator also proves normal direction/topology. These checks
  // bound new reconstruction/orientation operations, not inherited predicates.
  if (!spatialBounded3(triangle.p0, 8192.0) || !spatialBounded3(triangle.p1, 8192.0)
    || !spatialBounded3(triangle.p2, 8192.0) || !spatialBounded3(triangle.normal, 1.01)) { return false; }
  let normSquared = dot(triangle.normal, triangle.normal);
  return normSquared >= 0.99 && normSquared <= 1.01;
}
fn primaryReadyDataValid(record: IndirectSpatialGuide) -> bool {
  if ((record.identity & SPATIAL_RESERVED) != 0u || primaryRecordState(record.identity) != PRIMARY_READY
    || (record.identity & PRIMARY_QUERY_ISSUED) == 0u
    || (record.identity & SPATIAL_ID_MASK) >= arrayLength(&staticTraceTriangles)) { return false; }
  if (!primaryFiniteNonnegativeWords(record.rho, 65504.0)
    || any((record.point & vec3u(0x7fffffffu)) > vec3u(bitcast<u32>(PRIMARY_MAX_COORDINATE)))) { return false; }
  return primaryTriangleValid(staticTraceTriangles[record.identity & SPATIAL_ID_MASK]);
}
fn primaryRecordValid(record: IndirectSpatialGuide) -> bool {
  if ((record.identity & SPATIAL_RESERVED) != 0u) { return false; }
  let state = primaryRecordState(record.identity);
  if (state == PRIMARY_READY) {
    if (!primaryReadyDataValid(record)) { return false; }
    if ((record.identity & SPATIAL_VALID) != 0u) { return spatialGuideValid(record); }
    return record.footprint == 0u;
  }
  if (any(record.rho != vec3u(0u)) || any(record.point != vec3u(0u)) || record.footprint != 0u) { return false; }
  if (state == PRIMARY_UNINITIALIZED) { return record.identity == 0u; }
  if (state == PRIMARY_BACKGROUND) { return record.identity == (PRIMARY_BACKGROUND << PRIMARY_STATE_SHIFT); }
  if (state == PRIMARY_EXHAUSTED) { return record.identity == ((PRIMARY_EXHAUSTED << PRIMARY_STATE_SHIFT) | PRIMARY_QUERY_ISSUED); }
  if (state == PRIMARY_INVALID) {
    return (record.identity & ~PRIMARY_QUERY_ISSUED) == (PRIMARY_INVALID << PRIMARY_STATE_SHIFT);
  }
  return false;
}
fn primaryTerminal(state: u32, queried: bool) -> IndirectSpatialGuide {
  return IndirectSpatialGuide(vec3u(0u), (state << PRIMARY_STATE_SHIFT) | select(0u, PRIMARY_QUERY_ISSUED, queried), vec3u(0u), 0u);
}
fn primaryMatrixBounded(matrix: mat4x4f) -> bool {
  return spatialBounded4(matrix[0], PRIMARY_MAX_COORDINATE) && spatialBounded4(matrix[1], PRIMARY_MAX_COORDINATE)
    && spatialBounded4(matrix[2], PRIMARY_MAX_COORDINATE) && spatialBounded4(matrix[3], PRIMARY_MAX_COORDINATE);
}
// Zero denotes an invalid schedule. Valid batches never wrap across the end.
fn primaryPixelCount() -> u32 {
  let size = indirectFrame.sizeBudget.xy;
  if (size.x == 0u || size.y == 0u || size.x > 65536u || size.y > 65536u) { return 0u; }
  if (size.x > 65536u / size.y) { return 0u; }
  let pixels = size.x * size.y;
  if (indirectFrame.sizeBudget.z >= pixels || indirectFrame.sizeBudget.w == 0u
    || indirectFrame.sizeBudget.w > pixels - indirectFrame.sizeBudget.z
    || arrayLength(&indirectSpatial.records) < pixels) { return 0u; }
  return pixels;
}
struct PrimaryRay { origin: vec3f, direction: vec3f, distance: f32, valid: bool, };
fn primaryRay(pixel: vec2u) -> PrimaryRay {
  var result: PrimaryRay;
  if (!primaryMatrixBounded(indirectFrame.inverseViewProjection) || !primaryMatrixBounded(indirectFrame.viewProjection)) { return result; }
  let size = indirectFrame.sizeBudget.xy;
  if (size.x == 0u || size.y == 0u || any(size > vec2u(65536u)) || any(pixel >= size)) { return result; }
  let uv = (vec2f(pixel) + 0.5) / vec2f(size);
  let clipXY = uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  if (any((bitcast<vec2u>(clipXY) & vec2u(0x7fffffffu)) > vec2u(bitcast<u32>(1.0)))) { return result; }
  // Each product <=2^30; four-term homogeneous sums <=2^32 before evaluation.
  let nearH = indirectFrame.inverseViewProjection * vec4f(clipXY, 0.0, 1.0);
  let farH = indirectFrame.inverseViewProjection * vec4f(clipXY, 1.0, 1.0);
  if (!spatialBounded4(nearH, 8589934592.0) || !spatialBounded4(farH, 8589934592.0)
    || abs(nearH.w) < PRIMARY_MIN_W || abs(farH.w) < PRIMARY_MIN_W) { return result; }
  // Guard products <=2^63; each homogeneous quotient is bounded before divide.
  if (!spatialBounded3(nearH.xyz, abs(nearH.w) * PRIMARY_MAX_COORDINATE)
    || !spatialBounded3(farH.xyz, abs(farH.w) * PRIMARY_MAX_COORDINATE)) { return result; }
  let origin = nearH.xyz / nearH.w; let endpoint = farH.xyz / farH.w;
  if (!spatialBounded3(origin, PRIMARY_MAX_COORDINATE) || !spatialBounded3(endpoint, PRIMARY_MAX_COORDINATE)) { return result; }
  let delta = endpoint - origin; // Components <=2^31; squared sum <2^64.
  let normSquared = dot(delta, delta);
  if (!staticFinite(normSquared) || normSquared < 8.673617379884035e-19 || normSquared >= 18446744073709551616.0) { return result; }
  let distance = sqrt(normSquared);
  if (!staticFinite(distance) || distance < PRIMARY_MIN_W || distance > 4294967296.0) { return result; }
  let direction = delta / distance; // Independent worst-case quotient <=2^61.
  if (!spatialBounded3(direction, 2.0) || !any(direction != vec3f(0.0))) { return result; }
  result.origin = origin; result.direction = direction; result.distance = distance; result.valid = true;
  return result;
}
struct PrimaryWeights { value: vec3f, valid: bool, };
fn primaryWeightsValid(weights: vec3f) -> bool {
  return spatialBounded3(weights, 2.0) && all(weights >= vec3f(-0.00000095367431640625))
    && all(weights <= vec3f(1.0000009536743164));
}
fn primaryWeights(barycentric: vec2f) -> PrimaryWeights {
  var result: PrimaryWeights;
  if (any((bitcast<vec2u>(barycentric) & vec2u(0x7fffffffu)) > vec2u(bitcast<u32>(2.0)))) { return result; }
  let weights = vec3f(1.0 - barycentric.x - barycentric.y, barycentric);
  if (!primaryWeightsValid(weights)) { return result; }
  result.value = weights; result.valid = true; return result;
}
fn primaryDepthMatches(point: vec3f, depth: f32) -> bool {
  if (!spatialBounded3(point, PRIMARY_MAX_COORDINATE) || !primaryMatrixBounded(indirectFrame.viewProjection)
    || !staticFinite(depth) || depth < 0.0 || depth >= 1.0) { return false; }
  // Three xyz products <=2^60 and the translation <=2^30: sum <2^62.
  let projected = indirectFrame.viewProjection * vec4f(point, 1.0);
  if (!spatialBounded4(projected, 9223372036854775808.0) || projected.w < PRIMARY_MIN_W) { return false; }
  if (abs(projected.z) > 2.0 * projected.w) { return false; } // Guard product <=2^64.
  let depthProjected = projected.z / projected.w;
  if (!staticFinite(depthProjected)) { return false; }
  return abs(depthProjected - depth) <= 0.00002;
}
struct PrimaryRho { value: vec3f, valid: bool, };
fn primaryDiffuse(triangle: StaticTraceTriangle, weights: vec3f) -> PrimaryRho {
  var result: PrimaryRho;
  if (!primaryWeightsValid(weights)) { return result; }
  let indexCount = arrayLength(&indirectIndices);
  // Check BEFORE multiplying source ID or vertex offsets; no u32 wraparound.
  if (indexCount < 3u || triangle.sourceTriangleId > (indexCount - 3u) / 3u) { return result; }
  let source = triangle.sourceTriangleId * 3u;
  var uv = vec2f(0.0); var color = vec3f(0.0);
  for (var corner = 0u; corner < 3u; corner++) {
    let vertex = indirectIndices[source + corner];
    if (vertex >= arrayLength(&indirectVertices) / 16u) { return result; }
    let offset = vertex * 16u;
    let sourceUv = vec2f(indirectVertices[offset + 6u], indirectVertices[offset + 7u]);
    let sourceColor = vec3f(indirectVertices[offset + 12u], indirectVertices[offset + 13u], indirectVertices[offset + 14u]);
    if (any((bitcast<vec2u>(sourceUv) & vec2u(0x7fffffffu)) > vec2u(bitcast<u32>(PRIMARY_MAX_COORDINATE)))
      || !spatialBounded3(sourceColor, PRIMARY_MAX_COORDINATE)) { return result; }
    // |weight|<2: individual products <2^31, every partial sum <2^33.
    uv += sourceUv * weights[corner]; color += sourceColor * weights[corner];
  }
  if (any((bitcast<vec2u>(uv) & vec2u(0x7fffffffu)) > vec2u(bitcast<u32>(8589934592.0)))
    || !primaryFiniteNonnegativeWords(bitcast<vec3u>(color), 8589934592.0)) { return result; }
  if (!primaryFiniteNonnegativeWords(bitcast<vec3u>(indirectFrame.baseColorFactor.rgb), 1.0)
    || !staticFinite(indirectFrame.materialSettings.x) || indirectFrame.materialSettings.x < 0.0 || indirectFrame.materialSettings.x > 1.0
    || !staticFinite(indirectFrame.materialSettings.y) || indirectFrame.materialSettings.y != 0.0) { return result; }
  let base = textureSampleLevel(indirectBaseColor, indirectBaseSampler, uv, 0.0).rgb;
  let metallicSample = textureSampleLevel(indirectMetallicRoughness, indirectMetallicSampler, uv, 0.0).b;
  if (!primaryFiniteNonnegativeWords(bitcast<vec3u>(base), 1.0)
    || !staticFinite(metallicSample) || metallicSample < 0.0 || metallicSample > 1.0) { return result; }
  let metallic = clamp(metallicSample * indirectFrame.materialSettings.x, 0.0, 1.0);
  // Preserve the legacy order; factors <=1 bound EVERY intermediate by2^33.
  let rho = base * indirectFrame.baseColorFactor.rgb * color * (1.0 - metallic);
  if (!primaryFiniteNonnegativeWords(bitcast<vec3u>(rho), 65504.0)) { return result; }
  result.value = rho; result.valid = true; return result;
}

@compute @workgroup_size(64) fn prepareImportedIndirectPrimary(@builtin(global_invocation_id) id: vec3u) {
  let pixels = primaryPixelCount();
  if (pixels == 0u || id.x >= indirectFrame.sizeBudget.w) { return; }
  let pixelIndex = indirectFrame.sizeBudget.z + id.x;
  // Prepared records are immutable until an explicit whole-generation clear.
  let previous = indirectSpatial.records[pixelIndex];
  if (previous.identity != 0u || any(previous.rho != vec3u(0u)) || any(previous.point != vec3u(0u)) || previous.footprint != 0u) { return; }
  let pixel = vec2u(pixelIndex % indirectFrame.sizeBudget.x, pixelIndex / indirectFrame.sizeBudget.x);
  var result = primaryTerminal(PRIMARY_INVALID, false);
  indirectSpatial.records[pixelIndex] = result;
  if (any(pixel >= textureDimensions(indirectDepth))) { return; }
  let depth = textureLoad(indirectDepth, vec2i(pixel), 0);
  if (!staticFinite(depth) || depth < 0.0 || depth > 1.0) { return; }
  if (depth == 1.0) { indirectSpatial.records[pixelIndex] = primaryTerminal(PRIMARY_BACKGROUND, false); return; }
  let ray = primaryRay(pixel);
  if (!ray.valid) { return; }
  result = primaryTerminal(PRIMARY_INVALID, true);
  indirectSpatial.records[pixelIndex] = result;
  let hit = traceStaticVisible(ray.origin, ray.direction, 0.0, ray.distance, indirectFrame.options.y, indirectFrame.options.w == 0u);
  if (hit.status == 2u) { indirectSpatial.records[pixelIndex] = primaryTerminal(PRIMARY_EXHAUSTED, true); return; }
  if (hit.status != 1u || hit.triangle > SPATIAL_ID_MASK || hit.triangle >= arrayLength(&staticTraceTriangles)) { return; }
  let triangle = staticTraceTriangles[hit.triangle];
  if (!primaryTriangleValid(triangle)) { return; }
  let weights = primaryWeights(hit.barycentric);
  if (!weights.valid) { return; }
  let point = triangle.p0 * weights.value.x + triangle.p1 * weights.value.y + triangle.p2 * weights.value.z;
  if (!primaryDepthMatches(point, depth)) { return; }
  let rho = primaryDiffuse(triangle, weights.value);
  if (!rho.valid) { return; }
  var identity = hit.triangle | (PRIMARY_READY << PRIMARY_STATE_SHIFT) | PRIMARY_QUERY_ISSUED;
  if (dot(triangle.normal, ray.direction) > 0.0) { identity |= SPATIAL_FLIPPED; }
  result = IndirectSpatialGuide(bitcast<vec3u>(rho.value), identity, bitcast<vec3u>(point), 0u);
  // Guide qualification cannot remove or alter the valid transport inputs.
  indirectSpatial.records[pixelIndex] = spatialQualifyGuide(result, vec2i(pixel));
}
`;
