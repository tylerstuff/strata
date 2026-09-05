import { importedIndirectShader } from './imported-indirect-shader.js';

/** Optional spatial reconstruction. Does not change the raw estimator or its ABI. */
export const importedIndirectSpatialHelpers = /* wgsl */ `
struct IndirectSpatialGuide {
  rho: vec3u, identity: u32, // Exact f32 bits; classify zero/tiny before reinterpretation.
  point: vec3f, footprint: f32,
};
struct IndirectSpatialGuides {
  filteredPixels: atomic<u32>, fallbackChannels: atomic<u32>,
  hdrFaultChannels: atomic<u32>, guideBypassPixels: atomic<u32>,
  records: array<IndirectSpatialGuide>,
};
@group(1) @binding(6) var<storage, read_write> indirectSpatial: IndirectSpatialGuides;
const SPATIAL_ID_MASK = 0x000fffffu;
const SPATIAL_VALID = 0x00100000u;
const SPATIAL_FLIPPED = 0x00200000u;
const SPATIAL_RESERVED = 0xffc00000u;
const SPATIAL_HDR_MAX = 65472.0;
const SPATIAL_MIN_RHO = 0.0000152587890625; // 2^-16; no denominator clamp.
const SPATIAL_MIN_NORMAL = 1.1754943508222875e-38; // 2^-126.
const SPATIAL_MIN_I = 8.077935669463161e-28; // 2^-90.
const SPATIAL_MAX_I = 4294967296.0; // 2^32, exclusive.

// Bit checks precede arithmetic: NaN/Inf/negative/subnormal inputs cannot be
// rescued by finite-math comparisons or silently converted into completed zero.
fn spatialNormalOrZero(word: u32) -> bool {
  let magnitude = word & 0x7fffffffu;
  return magnitude == 0u || ((word & 0x80000000u) == 0u
    && magnitude >= 0x00800000u && magnitude < 0x7f800000u);
}
fn spatialBounded(value: f32, limit: f32) -> bool {
  return (bitcast<u32>(value) & 0x7fffffffu) <= bitcast<u32>(limit);
}
fn spatialBounded3(value: vec3f, limit: f32) -> bool {
  return all((bitcast<vec3u>(value) & vec3u(0x7fffffffu)) <= vec3u(bitcast<u32>(limit)));
}
fn spatialBounded4(value: vec4f, limit: f32) -> bool {
  return all((bitcast<vec4u>(value) & vec4u(0x7fffffffu)) <= vec4u(bitcast<u32>(limit)));
}
fn spatialMatrixBounded(matrix: mat4x4f) -> bool {
  return spatialBounded4(matrix[0], 1048576.0) && spatialBounded4(matrix[1], 1048576.0)
    && spatialBounded4(matrix[2], 1048576.0) && spatialBounded4(matrix[3], 1048576.0);
}
fn spatialMaxAbs(value: vec3f) -> f32 { return max(abs(value.x), max(abs(value.y), abs(value.z))); }
fn spatialExtent(triangle: StaticTraceTriangle) -> f32 {
  return max(spatialMaxAbs(triangle.p1 - triangle.p0), spatialMaxAbs(triangle.p2 - triangle.p0));
}
fn spatialTriangleSafe(triangle: StaticTraceTriangle) -> bool {
  if (!spatialBounded3(triangle.p0, 1048576.0) || !spatialBounded3(triangle.p1, 1048576.0)
    || !spatialBounded3(triangle.p2, 1048576.0) || !spatialBounded3(triangle.normal, 1.01)) { return false; }
  let normSquared = dot(triangle.normal, triangle.normal);
  return normSquared >= 0.99 && normSquared <= 1.01;
}
fn spatialIdentityValid(identity: u32) -> bool {
  return (identity & SPATIAL_RESERVED) == 0u && (identity & SPATIAL_VALID) != 0u;
}
fn spatialGuideValid(guide: IndirectSpatialGuide) -> bool {
  if (!spatialIdentityValid(guide.identity)
    || (guide.identity & SPATIAL_ID_MASK) >= arrayLength(&staticTraceTriangles)) { return false; }
  if (!spatialBounded3(guide.point, 1048576.0) || !spatialNormalOrZero(bitcast<u32>(guide.footprint))
    || guide.footprint < 9.094947017729282e-13 || guide.footprint > 1048576.0) { return false; }
  for (var channel = 0u; channel < 3u; channel++) {
    let word = guide.rho[channel]; let magnitude = word & 0x7fffffffu;
    if (magnitude != 0u && ((word & 0x80000000u) != 0u || magnitude > bitcast<u32>(65504.0))) { return false; }
  }
  return spatialTriangleSafe(staticTraceTriangles[guide.identity & SPATIAL_ID_MASK]);
}
fn spatialNormal(guide: IndirectSpatialGuide) -> vec3f {
  let normal = staticTraceTriangles[guide.identity & SPATIAL_ID_MASK].normal;
  return select(normal, -normal, (guide.identity & SPATIAL_FLIPPED) != 0u);
}

// xyz = intersection, w = validity. Matrices <=2^20, homogeneous values
// <=2^24, |w|>=2^-20 and dehomogenized coordinates <=2^20 bound all new
// products before evaluation. Outside this numerical domain, use raw GI.
fn spatialTangentPoint(pixel: vec2f, point: vec3f, normal: vec3f) -> vec4f {
  let size = vec2f(indirectFrame.sizeBudget.xy);
  if (any(size < vec2f(1.0)) || any(size > vec2f(65536.0))
    || any(pixel < vec2f(0.0)) || any(pixel >= size)) { return vec4f(0.0); }
  let clip = ((pixel + 0.5) / size) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let nearH = indirectFrame.inverseViewProjection * vec4f(clip, 0.0, 1.0);
  let farH = indirectFrame.inverseViewProjection * vec4f(clip, 1.0, 1.0);
  if (!spatialBounded4(nearH, 16777216.0) || !spatialBounded4(farH, 16777216.0)
    || abs(nearH.w) < 0.00000095367431640625 || abs(farH.w) < 0.00000095367431640625) { return vec4f(0.0); }
  if (!spatialBounded3(nearH.xyz, abs(nearH.w) * 1048576.0)
    || !spatialBounded3(farH.xyz, abs(farH.w) * 1048576.0)) { return vec4f(0.0); }
  let nearPoint = nearH.xyz / nearH.w; let farPoint = farH.xyz / farH.w;
  let delta = farPoint - nearPoint;
  let lengthSquared = dot(delta, delta);
  if (lengthSquared < 8.271806125530277e-25) { return vec4f(0.0); } // (2^-40)^2.
  let rayLength = sqrt(lengthSquared);
  let direction = delta / rayLength;
  if (abs(dot(normal, direction)) < 0.1) { return vec4f(0.0); }
  let denominator = dot(normal, delta);
  let numerator = dot(normal, point - nearPoint);
  if (denominator == 0.0) { return vec4f(0.0); }
  if (denominator > 0.0) {
    if (numerator < 0.0 || numerator > denominator) { return vec4f(0.0); }
  } else {
    if (numerator > 0.0 || numerator < denominator) { return vec4f(0.0); }
  }
  if (numerator != 0.0 && abs(numerator) < abs(denominator) * SPATIAL_MIN_I) { return vec4f(0.0); }
  let fraction = numerator / denominator;
  if (fraction < 0.0 || fraction > 1.0) { return vec4f(0.0); }
  let result = nearPoint + delta * fraction;
  if (!spatialBounded3(result, 1048576.0)) { return vec4f(0.0); }
  return vec4f(result, 1.0);
}
fn spatialWriteGuide(pixelIndex: u32, pixel: vec2i, primary: StaticTraceHit,
    point: vec3f, rho: vec3f, normal: vec3f, direction: vec3f) {
  // The record is zeroed on reset. Failure here never changes tracing status.
  indirectSpatial.records[pixelIndex].identity = 0u;
  if (primary.triangle > SPATIAL_ID_MASK || primary.triangle >= arrayLength(&staticTraceTriangles)
    || !spatialBounded3(point, 1048576.0) || !spatialBounded3(normal, 1.01)
    || !spatialTriangleSafe(staticTraceTriangles[primary.triangle])
    || !spatialMatrixBounded(indirectFrame.inverseViewProjection)
    || !spatialMatrixBounded(indirectFrame.viewProjection)) { return; }
  let size = indirectFrame.sizeBudget.xy;
  if (size.x < 2u || size.y < 2u || size.x > 65536u || size.y > 65536u) { return; }
  let projected = indirectFrame.viewProjection * vec4f(point, 1.0);
  if (!spatialBounded4(projected, 4398046511104.0) || projected.w < 0.00000095367431640625
    || abs(projected.x) > projected.w || abs(projected.y) > projected.w
    || projected.z < 0.0 || projected.z > projected.w) { return; }
  let center = spatialTangentPoint(vec2f(pixel), point, normal);
  let xPixel = pixel + vec2i(select(1, -1, pixel.x + 1 >= i32(size.x)), 0);
  let yPixel = pixel + vec2i(0, select(1, -1, pixel.y + 1 >= i32(size.y)));
  let xPoint = spatialTangentPoint(vec2f(xPixel), point, normal);
  let yPoint = spatialTangentPoint(vec2f(yPixel), point, normal);
  if (center.w == 0.0 || xPoint.w == 0.0 || yPoint.w == 0.0) { return; }
  let dx = xPoint.xyz - center.xyz; let dy = yPoint.xyz - center.xyz;
  let footprintSquared = max(dot(dx, dx), dot(dy, dy));
  if (footprintSquared < 8.271806125530277e-25 || footprintSquared > 1099511627776.0) { return; }
  var identity = primary.triangle | SPATIAL_VALID;
  if (dot(staticTraceTriangles[primary.triangle].normal, direction) > 0.0) { identity |= SPATIAL_FLIPPED; }
  let guide = IndirectSpatialGuide(bitcast<vec3u>(rho), identity, point, sqrt(footprintSquared));
  if (spatialGuideValid(guide)) { indirectSpatial.records[pixelIndex] = guide; }
}

struct SpatialMean { value: f32, valid: bool, positive: bool, }
fn spatialRawMean(sumWord: u32, samples: u32) -> SpatialMean {
  if (samples < 1u || samples > 1024u || !spatialNormalOrZero(sumWord)) { return SpatialMean(0.0, false, false); }
  if ((sumWord & 0x7fffffffu) == 0u) { return SpatialMean(0.0, true, false); }
  let sum = bitcast<f32>(sumWord); let count = f32(samples);
  if (sum < count * SPATIAL_MIN_NORMAL || sum > count * 65504.0) { return SpatialMean(0.0, false, true); }
  let value = sum / count; let word = bitcast<u32>(value);
  return SpatialMean(value, word >= 0x00800000u && word <= bitcast<u32>(65504.0), true);
}
struct SpatialRawColor { mean: f32, color: f32, valid: bool, }
fn spatialRawColor(sumWord: u32, samples: u32, directWord: u32) -> SpatialRawColor {
  if (!spatialNormalOrZero(directWord)) { return SpatialRawColor(0.0, 0.0, false); }
  let direct = bitcast<f32>(directWord);
  if (direct > SPATIAL_HDR_MAX) { return SpatialRawColor(0.0, 0.0, false); }
  let mean = spatialRawMean(sumWord, samples);
  if (!mean.valid || mean.value > SPATIAL_HDR_MAX - direct) { return SpatialRawColor(0.0, 0.0, false); }
  let color = direct + mean.value;
  // The precondition already bounds the sum far below f32 overflow and below
  // FP16's infinity boundary. Also retain the conservative f32 domain endpoint.
  return SpatialRawColor(mean.value, color, color <= SPATIAL_HDR_MAX);
}
struct SpatialIncident { value: f32, valid: bool, omitted: bool, }
fn spatialIncident(sumWord: u32, samples: u32, rhoWord: u32) -> SpatialIncident {
  if ((rhoWord & 0x7fffffffu) == 0u) { return SpatialIncident(0.0, true, true); }
  if (rhoWord < bitcast<u32>(SPATIAL_MIN_RHO) || rhoWord > bitcast<u32>(65504.0)) { return SpatialIncident(0.0, false, false); }
  let rho = bitcast<f32>(rhoWord);
  let mean = spatialRawMean(sumWord, samples);
  if (!mean.valid) { return SpatialIncident(0.0, false, false); }
  if (!mean.positive) { return SpatialIncident(0.0, true, false); }
  let countRho = f32(samples) * rho;
  if (bitcast<f32>(sumWord) < countRho * SPATIAL_MIN_I || mean.value >= rho * SPATIAL_MAX_I) { return SpatialIncident(0.0, false, false); }
  let incident = mean.value / rho; let incidentWord = bitcast<u32>(incident);
  return SpatialIncident(incident, incidentWord >= 0x00800000u && incidentWord < bitcast<u32>(SPATIAL_MAX_I), false);
}
struct SpatialRemodulated { indirect: f32, color: f32, valid: bool, }
fn spatialRemodulate(incident: f32, rhoWord: u32, directWord: u32) -> SpatialRemodulated {
  // Center zero/tiny channels are handled before this helper. The only accepted
  // positive incident domain originates from >=2^-90 inputs and bounded weights.
  let incidentWord = bitcast<u32>(incident);
  let incidentMagnitude = incidentWord & 0x7fffffffu;
  if (!spatialNormalOrZero(incidentWord) || incidentMagnitude >= bitcast<u32>(SPATIAL_MAX_I)
    || (incidentMagnitude != 0u && incidentMagnitude < bitcast<u32>(4.0389678347315804e-31))
    || rhoWord < bitcast<u32>(SPATIAL_MIN_RHO) || rhoWord > bitcast<u32>(65504.0)
    || !spatialNormalOrZero(directWord) || (directWord & 0x7fffffffu) > bitcast<u32>(SPATIAL_HDR_MAX)) {
    return SpatialRemodulated(0.0, 0.0, false);
  }
  let rho = bitcast<f32>(rhoWord); let direct = bitcast<f32>(directWord);
  let budget = SPATIAL_HDR_MAX - direct;
  if (incident > budget / rho) { return SpatialRemodulated(0.0, 0.0, false); }
  let value = incident * rho; let valueWord = bitcast<u32>(value);
  if (!spatialNormalOrZero(valueWord) || (incident > 0.0 && (valueWord & 0x7fffffffu) == 0u)) { return SpatialRemodulated(0.0, 0.0, false); }
  let color = direct + value;
  return SpatialRemodulated(value, color, color <= SPATIAL_HDR_MAX);
}
fn spatialPairWeight(center: IndirectSpatialGuide, donor: IndirectSpatialGuide, offset: vec2i) -> f32 {
  let a = staticTraceTriangles[center.identity & SPATIAL_ID_MASK];
  let b = staticTraceTriangles[donor.identity & SPATIAL_ID_MASK];
  if (a.materialId != b.materialId) { return 0.0; }
  let na = spatialNormal(center); let nb = spatialNormal(donor);
  let alignment = clamp(dot(na, nb), 0.0, 1.0);
  if (alignment < 0.95) { return 0.0; }
  let delta = donor.point - center.point;
  let allowance = 0.00000095367431640625 * (spatialMaxAbs(center.point) + spatialMaxAbs(donor.point)
    + spatialExtent(a) + spatialExtent(b));
  let tolerance = 0.05 * min(center.footprint, donor.footprint) + allowance;
  if (abs(dot(na, delta)) > tolerance || abs(dot(nb, delta)) > tolerance) { return 0.0; }
  let separation = (length(vec2f(offset)) + 1.5) * max(center.footprint, donor.footprint);
  if (dot(delta, delta) > separation * separation) { return 0.0; }
  var normalWeight = alignment * alignment;
  normalWeight *= normalWeight; normalWeight *= normalWeight;
  normalWeight *= normalWeight; normalWeight *= normalWeight;
  let kernel = array<f32, 5>(1.0, 4.0, 6.0, 4.0, 1.0);
  return kernel[u32(offset.x + 2)] * kernel[u32(offset.y + 2)] * clamp(normalWeight, 0.125, 1.0);
}
`;

const spatialCompose = /* wgsl */ `
@compute @workgroup_size(8, 8) fn composeImportedIndirect(@builtin(global_invocation_id) id: vec3u) {
  let size = indirectFrame.sizeBudget.xy;
  if (any(id.xy >= size)) { return; }
  let pixel = vec2i(id.xy); let pixelIndex = id.y * size.x + id.x;
  let direct = textureLoad(indirectDirect, pixel, 0);
  let state = indirectStates[pixelIndex];
  var color = direct.rgb; var indirect = vec3f(0.0); var fault = false;
  if (state.status == 0u && state.samples > 0u) {
    // Raw composition is proved before inspecting guides or the display toggle.
    for (var channel = 0u; channel < 3u; channel++) {
      let raw = spatialRawColor(state.sum[channel], state.samples, bitcast<u32>(direct[channel]));
      if (!raw.valid) { atomicAdd(&indirectSpatial.hdrFaultChannels, 1u); fault = true; }
      else { color[channel] = raw.color; indirect[channel] = raw.mean; }
    }
    if (!fault && indirectFrame.materialSettings.w == 1.0) {
      let center = indirectSpatial.records[pixelIndex];
      if (!spatialGuideValid(center)) { atomicAdd(&indirectSpatial.guideBypassPixels, 1u); }
      else {
        var activeChannels = vec3<bool>(false); var fallback = vec3<bool>(false);
        var sum = vec3f(0.0); var weights = vec3f(0.0);
        for (var channel = 0u; channel < 3u; channel++) {
          if ((center.rho[channel] & 0x7fffffffu) == 0u) { color[channel] = direct[channel]; indirect[channel] = 0.0; }
          else if (center.rho[channel] < bitcast<u32>(SPATIAL_MIN_RHO)) { fallback[channel] = true; }
          else { activeChannels[channel] = true; }
        }
        // Counts an eligible center for which at least one channel enters the
        // gather, even if an unsafe donor subsequently forces a channel fallback.
        if (any(activeChannels)) { atomicAdd(&indirectSpatial.filteredPixels, 1u); }
        for (var y = -2; y <= 2; y++) { for (var x = -2; x <= 2; x++) {
          let q = pixel + vec2i(x, y);
          if (any(q < vec2i(0)) || any(q >= vec2i(size))) { continue; }
          let qi = u32(q.y) * size.x + u32(q.x); let donorState = indirectStates[qi];
          if (donorState.status != 0u || donorState.samples == 0u) { continue; }
          let donor = indirectSpatial.records[qi];
          if (!spatialGuideValid(donor)) { continue; }
          let weight = spatialPairWeight(center, donor, vec2i(x, y));
          if (weight == 0.0) { continue; }
          for (var channel = 0u; channel < 3u; channel++) {
            if (!activeChannels[channel] || fallback[channel]) { continue; }
            let incident = spatialIncident(donorState.sum[channel], donorState.samples, donor.rho[channel]);
            if (!incident.valid) { fallback[channel] = true; continue; }
            if (incident.omitted) { continue; }
            // Completed zero estimates still contribute their positive weight.
            sum[channel] += weight * incident.value; weights[channel] += weight;
          }
        } }
        for (var channel = 0u; channel < 3u; channel++) {
          if (activeChannels[channel] && !fallback[channel]) {
            if (weights[channel] < 0.125 || weights[channel] > 256.0
              || sum[channel] >= 1099511627776.0) { fallback[channel] = true; }
            else {
              let irradiance = sum[channel] / weights[channel];
              let result = spatialRemodulate(irradiance, center.rho[channel], bitcast<u32>(direct[channel]));
              if (!result.valid) { fallback[channel] = true; }
              else { color[channel] = result.color; indirect[channel] = result.indirect; }
            }
          }
          if (fallback[channel]) { atomicAdd(&indirectSpatial.fallbackChannels, 1u); }
        }
      }
    }
  }
  if (indirectFrame.materialSettings.z == 1.0) { color = indirect; }
  if (indirectFrame.materialSettings.z == 2.0) {
    color = vec3f(0.0);
    if (state.status == 0u) { color = vec3f(0.0, min(f32(state.samples) / f32(indirectFrame.options.x), 1.0), 0.0); }
    if (state.status == 2u) { color = vec3f(1.0, 0.0, 1.0); }
    if (state.status == 3u) { color = vec3f(1.0, 0.25, 0.0); }
  }
  if (fault) { color = vec3f(1.0, 0.0, 1.0); }
  textureStore(indirectOutput, pixel, vec4f(color, direct.a));
}
`;

/** Derive the opt-in variant without changing even one byte of the legacy WGSL. */
export function withImportedIndirectSpatial(base: string): string {
  const insertion = '  let normal = indirectNormal(primary, primaryDirection);';
  const compose = '@compute @workgroup_size(8, 8) fn composeImportedIndirect';
  const stateSum = '  sum: vec3f,';
  const add = '  indirectStates[pixelIndex].sum += sample;';
  if ([insertion, compose, stateSum, add].some(marker => base.split(marker).length !== 2)) {
    throw new Error('Imported indirect spatial shader integration markers changed.');
  }
  const trace = base.slice(0, base.indexOf(compose)).replace(stateSum, '  sum: vec3u,')
    .replace(add, '  indirectStates[pixelIndex].sum = bitcast<vec3u>(bitcast<vec3f>(indirectStates[pixelIndex].sum) + sample);')
    .replace(insertion, `${insertion}
  if (state.attempts == 0u) { spatialWriteGuide(pixelIndex, pixel, primary, point, rho, normal, primaryDirection); }`);
  return `${trace}\n${importedIndirectSpatialHelpers}\n${spatialCompose}`;
}

/** Loaded only for the explicit seven-storage-buffer capability. */
export const importedIndirectSpatialShader = withImportedIndirectSpatial(importedIndirectShader);
