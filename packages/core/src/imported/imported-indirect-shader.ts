import { staticTraceShader } from './static-trace-shader.js';
import { importedIndirectEnvironmentShader } from './imported-indirect-environment.js';

/** One diffuse surface bounce, accumulated separately from the sharp raster HDR. */
export const importedIndirectShader = /* wgsl */ `
${staticTraceShader}
${importedIndirectEnvironmentShader}
struct ImportedIndirectFrame {
  inverseViewProjection: mat4x4f,
  viewProjection: mat4x4f,
  eye: vec4f,
  sizeBudget: vec4u,
  options: vec4u,
  lightDirection: vec4f,
  lightRadiance: vec4f,
  environment: vec4f,
  constantEnvironment: vec4f,
  baseColorFactor: vec4f,
  materialSettings: vec4f,
  emissiveFactor: vec4f,
};
struct ImportedIndirectState {
  sum: vec3f,
  samples: u32,
  attempts: u32,
  status: u32,
  padding: vec2u,
};
struct ImportedIndirectDiagnostics {
  attempted: atomic<u32>,
  completed: atomic<u32>,
  exhausted: atomic<u32>,
  invalid: atomic<u32>,
};
@group(0) @binding(0) var<uniform> indirectFrame: ImportedIndirectFrame;
@group(0) @binding(1) var indirectDepth: texture_depth_2d;
@group(0) @binding(2) var indirectDirect: texture_2d<f32>;
@group(0) @binding(3) var indirectOutput: texture_storage_2d<rgba16float, write>;
@group(1) @binding(0) var<storage, read> staticTraceNodes: array<StaticTraceNode>;
@group(1) @binding(1) var<storage, read> staticTraceTriangles: array<StaticTraceTriangle>;
@group(1) @binding(2) var<storage, read> indirectVertices: array<f32>;
@group(1) @binding(3) var<storage, read> indirectIndices: array<u32>;
@group(1) @binding(4) var<storage, read_write> indirectStates: array<ImportedIndirectState>;
@group(1) @binding(5) var<storage, read_write> indirectDiagnostics: ImportedIndirectDiagnostics;
@group(2) @binding(0) var indirectBaseColor: texture_2d<f32>;
@group(2) @binding(1) var indirectBaseSampler: sampler;
@group(2) @binding(2) var indirectMetallicRoughness: texture_2d<f32>;
@group(2) @binding(3) var indirectMetallicSampler: sampler;
@group(2) @binding(4) var indirectEmissive: texture_2d<f32>;
@group(2) @binding(5) var indirectEmissiveSampler: sampler;

fn indirectHash(value: u32) -> u32 {
  var word = value;
  word = (word ^ (word >> 16u)) * 0x7feb352du;
  word = (word ^ (word >> 15u)) * 0x846ca68bu;
  return word ^ (word >> 16u);
}
fn indirectRandom(seed: u32, dimension: u32) -> f32 {
  // Half-open mantissa bins avoid both pole singularities and exactly one.
  return (f32(indirectHash(seed ^ (dimension * 0x9e3779b9u)) >> 9u) + 0.5) / 8388608.0;
}
fn indirectCosineDirection(normal: vec3f, seed: u32, dimension: u32) -> vec3f {
  let u = indirectRandom(seed, dimension);
  let angle = 6.283185307179586 * indirectRandom(seed, dimension + 1u);
  let axis = select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(normal.z) > 0.999);
  let tangent = normalize(cross(axis, normal));
  let bitangent = cross(normal, tangent);
  // Approximate GPU sin/cos need not have exactly unit combined length. Preserve
  // the selected cosine-distribution elevation before constructing the direction.
  let azimuth = normalize(vec2f(cos(angle), sin(angle)));
  return normalize(tangent * (sqrt(u) * azimuth.x) + bitangent * (sqrt(u) * azimuth.y) + normal * sqrt(1.0 - u));
}
fn indirectPoint(hit: StaticTraceHit) -> vec3f {
  let triangle = staticTraceTriangles[hit.triangle];
  // Keep original corner ordering; source IDs are independent of BVH leaf order.
  return triangle.p0 * (1.0 - hit.barycentric.x - hit.barycentric.y)
    + triangle.p1 * hit.barycentric.x + triangle.p2 * hit.barycentric.y;
}
fn indirectNormal(hit: StaticTraceHit, incidentDirection: vec3f) -> vec3f {
  let n = staticTraceTriangles[hit.triangle].normal;
  return select(n, -n, dot(n, incidentDirection) > 0.0);
}
fn indirectDiffuse(hit: StaticTraceHit) -> vec3f {
  let triangle = staticTraceTriangles[hit.triangle];
  let source = triangle.sourceTriangleId * 3u;
  if (source + 2u >= arrayLength(&indirectIndices)) { return vec3f(-1.0); }
  let weights = vec3f(1.0 - hit.barycentric.x - hit.barycentric.y, hit.barycentric);
  var uv = vec2f(0.0);
  var color = vec3f(0.0);
  for (var corner = 0u; corner < 3u; corner++) {
    let vertex = indirectIndices[source + corner];
    if (vertex >= arrayLength(&indirectVertices) / 16u) { return vec3f(-1.0); }
    let offset = vertex * 16u;
    uv += vec2f(indirectVertices[offset + 6u], indirectVertices[offset + 7u]) * weights[corner];
    color += vec3f(indirectVertices[offset + 12u], indirectVertices[offset + 13u], indirectVertices[offset + 14u]) * weights[corner];
  }
  // Compute has no implicit derivatives. The first exact tracing preview samples
  // authored textures at LOD zero, with the borrowed color-space-correct views.
  let base = textureSampleLevel(indirectBaseColor, indirectBaseSampler, uv, indirectFrame.materialSettings.y).rgb;
  let metallic = clamp(textureSampleLevel(indirectMetallicRoughness, indirectMetallicSampler, uv,
    indirectFrame.materialSettings.y).b * indirectFrame.materialSettings.x, 0.0, 1.0);
  return base * indirectFrame.baseColorFactor.rgb * color * (1.0 - metallic);
}
fn indirectEmission(hit: StaticTraceHit) -> vec3f {
  let source = staticTraceTriangles[hit.triangle].sourceTriangleId * 3u;
  if (source + 2u >= arrayLength(&indirectIndices)) { return vec3f(-1.0); }
  let weights = vec3f(1.0 - hit.barycentric.x - hit.barycentric.y, hit.barycentric);
  var uv = vec2f(0.0);
  for (var corner = 0u; corner < 3u; corner++) {
    let vertex = indirectIndices[source + corner];
    if (vertex >= arrayLength(&indirectVertices) / 16u) { return vec3f(-1.0); }
    let offset = vertex * 16u;
    uv += vec2f(indirectVertices[offset + 6u], indirectVertices[offset + 7u]) * weights[corner];
  }
  return textureSampleLevel(indirectEmissive, indirectEmissiveSampler, uv, indirectFrame.materialSettings.y).rgb
    * indirectFrame.emissiveFactor.rgb;
}
fn indirectEnvironment(direction: vec3f) -> vec3f {
  return importedIndirectEnvironment(direction, indirectFrame.environment, indirectFrame.constantEnvironment.rgb);
}
fn indirectUnknown(pixel: u32, status: u32) {
  indirectStates[pixel].status = select(3u, 2u, status == 2u);
  // One unknown path invalidates this pixel's estimate. Discarding that path and
  // dividing only by completed samples would condition the estimate on tracing cost.
  if (status == 2u) { atomicAdd(&indirectDiagnostics.exhausted, 1u); }
  else { atomicAdd(&indirectDiagnostics.invalid, 1u); }
}
fn indirectFiniteNonnegative(value: vec3f) -> bool {
  return all(value >= vec3f(0.0)) && all(value <= vec3f(65504.0));
}

@compute @workgroup_size(64) fn traceImportedIndirect(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= indirectFrame.sizeBudget.w) { return; }
  let size = indirectFrame.sizeBudget.xy;
  let pixelIndex = (indirectFrame.sizeBudget.z + id.x) % (size.x * size.y);
  let state = indirectStates[pixelIndex];
  if (state.status != 0u || state.samples >= indirectFrame.options.x) { return; }
  let pixel = vec2i(i32(pixelIndex % size.x), i32(pixelIndex / size.x));
  let depth = textureLoad(indirectDepth, pixel, 0);
  if (depth >= 1.0) { indirectStates[pixelIndex].status = 4u; return; }
  indirectStates[pixelIndex].attempts += 1u;
  atomicAdd(&indirectDiagnostics.attempted, 1u);
  let uv = (vec2f(pixel) + 0.5) / vec2f(size);
  let clipXY = uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let nearH = indirectFrame.inverseViewProjection * vec4f(clipXY, 0.0, 1.0);
  let farH = indirectFrame.inverseViewProjection * vec4f(clipXY, 1.0, 1.0);
  if (!(abs(nearH.w) > 0.0 && abs(farH.w) > 0.0)) { indirectUnknown(pixelIndex, 3u); return; }
  let primaryOrigin = nearH.xyz / nearH.w;
  let farVector = farH.xyz / farH.w - primaryOrigin;
  let farDistance = length(farVector);
  if (!(farDistance > 0.0)) { indirectUnknown(pixelIndex, 3u); return; }
  let primaryDirection = farVector / farDistance;
  // Starting at clip z=0 excludes geometry clipped before the near plane and
  // also preserves parallel camera rays for an orthographic projection.
  let primary = traceStaticVisible(primaryOrigin, primaryDirection, 0.0, farDistance,
    indirectFrame.options.y, indirectFrame.options.w == 0u);
  if (primary.status != 1u) { indirectUnknown(pixelIndex, primary.status); return; }
  let point = indirectPoint(primary);
  let projected = indirectFrame.viewProjection * vec4f(point, 1.0);
  // The traced receiver must be the visible raster surface, not clipped or hidden geometry.
  if (!(projected.w > 0.0) || abs(projected.z / projected.w - depth) > 0.00002) {
    indirectUnknown(pixelIndex, 3u); return;
  }
  let rho = indirectDiffuse(primary);
  if (!indirectFiniteNonnegative(rho)) { indirectUnknown(pixelIndex, 3u); return; }
  let normal = indirectNormal(primary, primaryDirection);
  let seed = indirectHash(pixelIndex ^ indirectFrame.options.z ^ (state.attempts * 0x9e3779b9u));
  let direction = indirectCosineDirection(normal, seed, 1u);
  let origin = staticTraceOffset(point, normal, staticTraceTriangles[primary.triangle]);
  let secondary = traceStatic(origin, direction, 0.0, 1e30, indirectFrame.options.y);
  if (secondary.status >= 2u) { indirectUnknown(pixelIndex, secondary.status); return; }
  var incoming = vec3f(0.0);
  if (secondary.status == 0u) {
    incoming = indirectEnvironment(direction);
  } else {
    let secondaryPoint = indirectPoint(secondary);
    let secondaryNormal = indirectNormal(secondary, direction);
    let secondaryRho = indirectDiffuse(secondary);
    if (!indirectFiniteNonnegative(secondaryRho)) { indirectUnknown(pixelIndex, 3u); return; }
    let secondaryOrigin = staticTraceOffset(secondaryPoint, secondaryNormal, staticTraceTriangles[secondary.triangle]);
    let cosine = max(dot(secondaryNormal, indirectFrame.lightDirection.xyz), 0.0);
    if (cosine > 0.0 && any(indirectFrame.lightRadiance.rgb > vec3f(0.0))) {
      let shadow = traceStaticOcclusion(secondaryOrigin, indirectFrame.lightDirection.xyz, 0.0, 1e30, indirectFrame.options.y);
      if (shadow.status >= 2u) { indirectUnknown(pixelIndex, shadow.status); return; }
      if (shadow.status == 0u) { incoming += indirectFrame.lightRadiance.rgb * (cosine / 3.141592653589793); }
    }
    if (indirectFrame.environment.y > 0.0 && indirectFrame.environment.x > 0.0) {
      let skyDirection = indirectCosineDirection(secondaryNormal, seed, 3u);
      let sky = traceStaticOcclusion(secondaryOrigin, skyDirection, 0.0, 1e30, indirectFrame.options.y);
      if (sky.status >= 2u) { indirectUnknown(pixelIndex, sky.status); return; }
      if (sky.status == 0u) { incoming += indirectEnvironment(skyDirection); }
    }
    let emission = indirectEmission(secondary);
    if (!indirectFiniteNonnegative(emission)) { indirectUnknown(pixelIndex, 3u); return; }
    incoming = incoming * secondaryRho + emission;
  }
  let sample = rho * incoming;
  if (!indirectFiniteNonnegative(sample)) { indirectUnknown(pixelIndex, 3u); return; }
  indirectStates[pixelIndex].sum += sample;
  indirectStates[pixelIndex].samples += 1u;
  atomicAdd(&indirectDiagnostics.completed, 1u);
}

@compute @workgroup_size(8, 8) fn composeImportedIndirect(@builtin(global_invocation_id) id: vec3u) {
  let size = indirectFrame.sizeBudget.xy;
  if (any(id.xy >= size)) { return; }
  let pixel = vec2i(id.xy);
  let direct = textureLoad(indirectDirect, pixel, 0);
  let state = indirectStates[id.y * size.x + id.x];
  var indirect = vec3f(0.0);
  if (state.status == 0u && state.samples > 0u) { indirect = state.sum / f32(state.samples); }
  var color = direct.rgb + indirect;
  if (indirectFrame.materialSettings.z == 1.0) { color = indirect; }
  if (indirectFrame.materialSettings.z == 2.0) {
    color = vec3f(0.0);
    if (state.status == 0u) { color = vec3f(0.0, min(f32(state.samples) / f32(indirectFrame.options.x), 1.0), 0.0); }
    if (state.status == 2u) { color = vec3f(1.0, 0.0, 1.0); }
    if (state.status == 3u) { color = vec3f(1.0, 0.25, 0.0); }
  }
  textureStore(indirectOutput, pixel, vec4f(color, direct.a));
}
`;
