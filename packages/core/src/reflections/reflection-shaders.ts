import { giTraceShader } from '../gi/trace-shaders.js';
import { probeSamplingShader } from '../gi/probe-cache-shaders.js';

const common = /* wgsl */ `
struct ReflectionConfig {
  inverseViewProjection: mat4x4f, view: mat4x4f, eye: vec4f,
  size: vec4u, frame: vec4u, window: vec4u, settings: vec4f, flags: vec4u, region: vec4u,
};
struct ReflectionSample { radiance: vec3f, source: u32, };
fn reflectionWorld(uv: vec2f, depth: f32, config: ReflectionConfig) -> vec3f {
  let clip = vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), depth, 1.0);
  let point = config.inverseViewProjection * clip; return point.xyz / point.w;
}
fn reflectionQualify(metadata: vec4u, previous: vec4f, surface: vec4f, depth: f32, normal: vec3f, roughness: f32, config: ReflectionConfig) -> bool {
  return metadata.w != 0u && (metadata.x == 0u || metadata.x == 1u || metadata.x == 3u) && metadata.z == config.frame.y && metadata.y <= config.frame.x
    && config.frame.x - metadata.y <= u32(config.settings.w) && depth > 0.0 && previous.a > 0.0
    && abs(previous.a - depth) <= max(0.02, depth * 0.01) && dot(surface.xyz, normal) >= 0.98 && abs(surface.a - roughness) <= 0.005;
}
fn reflectionHash(value: u32) -> u32 {
  var bits = value; bits = (bits ^ (bits >> 16u)) * 0x7feb352du; bits = (bits ^ (bits >> 15u)) * 0x846ca68bu; return bits ^ (bits >> 16u);
}
fn reflectionRandom(value: u32) -> f32 { return f32(reflectionHash(value) & 0x00ffffffu) / 16777216.0; }
fn reflectionFresnel(f0: vec3f, cosine: f32) -> vec3f { return f0 + (vec3f(1.0) - f0) * pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0); }
struct ReflectionDirection { direction: vec3f, weight: vec3f, };
// Heitz 2018 visible GGX normals; separable Smith reduces BRDF*cos/PDF to F*G1(L).
fn reflectionDirection(view: vec3f, normal: vec3f, roughness: f32, random: vec2f, f0: vec3f) -> ReflectionDirection {
  let tangent = normalize(cross(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(normal.z) >= 0.999), normal));
  let bitangent = cross(normal, tangent); let basis = mat3x3f(tangent, bitangent, normal);
  let local = transpose(basis) * view; let alpha = max(roughness * roughness, 1e-6);
  var halfVector = vec3f(0.0, 0.0, 1.0);
  if (roughness > 0.0) {
    let stretched = normalize(vec3f(local.xy * alpha, local.z));
    let lateral = dot(stretched.xy, stretched.xy);
    var first = vec3f(1.0, 0.0, 0.0);
    if (lateral > 1e-12) { first = vec3f(-stretched.y, stretched.x, 0.0) / sqrt(lateral); }
    let second = cross(stretched, first); let radius = sqrt(random.x); var angle = 6.28318530718 * random.y;
    if (angle > 3.14159265359) { angle -= 6.28318530718; }
    // WGSL trig error must not change the sampled disk radius, especially near its rim.
    let circle = normalize(vec2f(cos(angle), sin(angle)));
    let diskX = radius * circle.x; let blend = 0.5 + 0.5 * stretched.z;
    let diskY = (1.0 - blend) * sqrt(max(0.0, 1.0 - diskX * diskX)) + blend * radius * circle.y;
    let hemisphere = first * diskX + second * diskY + stretched * sqrt(max(0.0, 1.0 - diskX * diskX - diskY * diskY));
    halfVector = normalize(vec3f(hemisphere.xy * alpha, max(0.0, hemisphere.z)));
  }
  let vh = dot(local, halfVector); let light = 2.0 * vh * halfVector - local;
  let nl = max(0.0, light.z); var masking = 1.0;
  if (roughness > 0.0) { masking = 2.0 * nl / max(nl + sqrt(alpha * alpha + (1.0 - alpha * alpha) * nl * nl), 1e-8); }
  let weight = reflectionFresnel(f0, vh) * select(0.0, masking, light.z > 0.0);
  return ReflectionDirection(normalize(basis * light), weight);
}
`;

/** Internal test hook: the exact estimator helper compiled by the production trace pipeline. */
export const reflectionDirectionShader = common;

export const reflectionTraceShader = common + giTraceShader({ group: 1 }) + probeSamplingShader({ group: 2 }) + /* wgsl */ `
@group(0) @binding(0) var<uniform> reflectionConfig: ReflectionConfig;
@group(0) @binding(1) var reflectionDepth: texture_depth_2d;
@group(0) @binding(2) var reflectionNormal: texture_2d<f32>;
@group(0) @binding(3) var reflectionMaterial: texture_2d<f32>;
@group(0) @binding(4) var reflectionMotion: texture_2d<f32>;
@group(0) @binding(5) var reflectionRaw: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var reflectionRawMetadata: texture_storage_2d<rgba32uint, write>;
@group(0) @binding(7) var<storage, read_write> reflectionStats: array<atomic<u32>>;
@compute @workgroup_size(64) fn reflectionTrace(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= reflectionConfig.window.y || reflectionConfig.window.z == 0u) { return; }
  let candidate = (reflectionConfig.window.x + id.x) % reflectionConfig.window.z;
  let location = reflectionConfig.region.xy + vec2u(candidate % reflectionConfig.region.z, candidate / reflectionConfig.region.z);
  let pixel = vec2i(location); let uv = (vec2f(location) + 0.5) / vec2f(reflectionConfig.size.xy);
  let source = min(vec2i(uv * vec2f(reflectionConfig.size.zw)), vec2i(reflectionConfig.size.zw) - 1);
  let material = textureLoad(reflectionMaterial, source, 0); let depth = textureLoad(reflectionDepth, source, 0);
  let frame = reflectionConfig.frame.x; let epoch = reflectionConfig.frame.y;
  atomicAdd(&reflectionStats[0], 1u);
  if (material.a < 0.5 || depth >= 1.0) {
    textureStore(reflectionRaw, pixel, vec4f(0.0)); textureStore(reflectionRawMetadata, pixel, vec4u(0u, frame, epoch, 0u)); return;
  }
  let sourceUv = (vec2f(source) + 0.5) / vec2f(reflectionConfig.size.zw);
  let world = reflectionWorld(sourceUv, depth, reflectionConfig); let normal = normalize(textureLoad(reflectionNormal, source, 0).xyz);
  let view = normalize(reflectionConfig.eye.xyz - world);
  if (dot(view, normal) <= 0.0) {
    textureStore(reflectionRaw, pixel, vec4f(0.0)); textureStore(reflectionRawMetadata, pixel, vec4u(0u, frame, epoch, 0u)); return;
  }
  let random = vec2f(reflectionRandom(location.x + location.y * reflectionConfig.size.x + frame * 747796405u),
    reflectionRandom(location.x * 2891336453u + location.y * 277803737u + frame * 1597334677u));
  let sample = reflectionDirection(view, normal, reflectionConfig.settings.x, random, material.rgb);
  if (all(sample.weight <= vec3f(0.0))) {
    // A below-hemisphere BSDF sample contributes zero; it must not become a bright fallback.
    textureStore(reflectionRaw, pixel, vec4f(0.0)); textureStore(reflectionRawMetadata, pixel, vec4u(0u, frame, epoch, 1u)); return;
  }
  let ray = GiRay(world + normal * 0.002, 0.002, sample.direction, reflectionConfig.settings.y);
  let hit = giTraceBvh(ray); atomicAdd(&reflectionStats[1], 1u);
  var color = vec3f(0.0); var kind = 2u;
  if (hit.status == 2u) { kind = 4u; atomicAdd(&reflectionStats[5], 1u); }
  else if (hit.status == 0u) { atomicAdd(&reflectionStats[4], 1u); }
  else {
    atomicAdd(&reflectionStats[3], 1u); kind = 1u;
    let hitMaterial = giMaterials[hit.materialId]; color = hitMaterial.emission;
    if (dot(hit.normal, sample.direction) < 0.0) {
      let point = ray.origin + hit.distance * ray.direction; let cosine = max(0.0, dot(hit.normal, giTraceConfig.lightDirection));
      let diffuse = hitMaterial.albedo * (1.0 - hitMaterial.metallic) / 3.14159265359;
      if (cosine > 0.0) {
        let shadow = giTraceAnyBvh(GiRay(point + hit.normal * 0.002, 0.002, giTraceConfig.lightDirection, 32.0));
        atomicAdd(&reflectionStats[2], 1u);
        if (shadow.status == 0u) { color += diffuse * giTraceConfig.lightRadiance * cosine; }
        if (shadow.status == 2u) { atomicAdd(&reflectionStats[5], 1u); kind = 4u; }
      }
      if (reflectionConfig.frame.w != 0u) { color += diffuse * sampleProbeIrradiance(point, hit.normal, -sample.direction); }
    }
    color *= sample.weight;
  }
  textureStore(reflectionRaw, pixel, vec4f(color, hit.distance));
  textureStore(reflectionRawMetadata, pixel, vec4u(kind, frame, epoch, 1u));
}
`;

export const reflectionResolveShader = common + /* wgsl */ `
@group(0) @binding(0) var<uniform> reflectionConfig: ReflectionConfig;
@group(0) @binding(1) var reflectionNormal: texture_2d<f32>;
@group(0) @binding(2) var reflectionMaterial: texture_2d<f32>;
@group(0) @binding(3) var reflectionMotion: texture_2d<f32>;
@group(0) @binding(4) var reflectionRaw: texture_2d<f32>;
@group(0) @binding(5) var reflectionRawMetadata: texture_2d<u32>;
@group(0) @binding(6) var reflectionPrevious: texture_2d<f32>;
@group(0) @binding(7) var reflectionPreviousSurface: texture_2d<f32>;
@group(0) @binding(8) var reflectionPreviousMetadata: texture_2d<u32>;
@group(0) @binding(9) var reflectionNext: texture_storage_2d<rgba16float, write>;
@group(0) @binding(10) var reflectionNextSurface: texture_storage_2d<rgba16float, write>;
@group(0) @binding(11) var reflectionNextMetadata: texture_storage_2d<rgba32uint, write>;
@group(0) @binding(12) var<storage, read_write> reflectionStats: array<atomic<u32>>;
@compute @workgroup_size(8, 8) fn reflectionResolve(@builtin(global_invocation_id) id: vec3u) {
  let size = reflectionConfig.size.xy; if (any(id.xy >= size)) { return; }
  let pixel = vec2i(id.xy); let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let source = min(vec2i(uv * vec2f(reflectionConfig.size.zw)), vec2i(reflectionConfig.size.zw) - 1);
  let motion = textureLoad(reflectionMotion, source, 0); let surface = textureLoad(reflectionNormal, source, 0);
  let material = textureLoad(reflectionMaterial, source, 0); let epoch = reflectionConfig.frame.y; let frame = reflectionConfig.frame.x;
  if (material.a < 0.5 || motion.z <= 0.0) {
    textureStore(reflectionNext, pixel, vec4f(0.0)); textureStore(reflectionNextSurface, pixel, vec4f(0.0));
    textureStore(reflectionNextMetadata, pixel, vec4u(0u, frame, epoch, 0u)); return;
  }
  let normal = normalize(surface.xyz); let rawMeta = textureLoad(reflectionRawMetadata, pixel, 0);
  let fresh = rawMeta.w != 0u && rawMeta.y == frame && rawMeta.z == epoch && reflectionConfig.window.w != 0u;
  var color = vec3f(0.0); var kind = 2u; var freshFrame = frame;
  let previousUv = uv + motion.xy; var accumulated = vec3f(0.0); var accepted = 0.0; var oldest = frame;
  if (reflectionConfig.flags.x == 0u && all(previousUv >= vec2f(0.0)) && all(previousUv < vec2f(1.0))) {
    let footprint = previousUv * vec2f(size) - 0.5; let base = vec2i(floor(footprint)); let fraction = fract(footprint);
    for (var y = 0; y < 2; y++) { for (var x = 0; x < 2; x++) {
      let tap = clamp(base + vec2i(x, y), vec2i(0), vec2i(size) - 1);
      let history = textureLoad(reflectionPrevious, tap, 0); let historySurface = textureLoad(reflectionPreviousSurface, tap, 0);
      let metadata = textureLoad(reflectionPreviousMetadata, tap, 0);
      let weight = select(1.0 - fraction.x, fraction.x, x == 1) * select(1.0 - fraction.y, fraction.y, y == 1);
      if (weight > 0.0 && reflectionQualify(metadata, history, historySurface, motion.w, normal, reflectionConfig.settings.x, reflectionConfig)) {
        accumulated += history.rgb * weight; accepted += weight; oldest = min(oldest, metadata.y);
      }
    } }
  }
  if (fresh) {
    kind = rawMeta.x;
    if (kind == 0u || kind == 1u) {
      color = textureLoad(reflectionRaw, pixel, 0).rgb;
      // Perfect mirrors keep current detail. Glossy samples accumulate only qualified surface history.
      if (accepted > 0.0 && reflectionConfig.settings.x > 0.0) { color = mix(color, accumulated / accepted, reflectionConfig.settings.z); }
    }
  } else if (accepted > 0.0) {
    color = accumulated / accepted; kind = 3u; freshFrame = oldest; atomicAdd(&reflectionStats[6], 1u);
  }
  if (kind == 2u || kind == 4u) { atomicAdd(&reflectionStats[7], 1u); }
  textureStore(reflectionNext, pixel, vec4f(color, motion.z));
  textureStore(reflectionNextSurface, pixel, vec4f(normal, reflectionConfig.settings.x));
  textureStore(reflectionNextMetadata, pixel, vec4u(kind, freshFrame, epoch, 1u));
}
`;

/** Four bindings: float HDR/depth, float normal/roughness, uint source/frame/epoch/mask, uniform config. */
export function reflectionSamplingShader({ group = 3, firstBinding = 0 }: { group?: number; firstBinding?: number } = {}): string {
  return common + /* wgsl */ `
@group(${group}) @binding(${firstBinding}) var reflectionHistory: texture_2d<f32>;
@group(${group}) @binding(${firstBinding + 1}) var reflectionHistorySurface: texture_2d<f32>;
@group(${group}) @binding(${firstBinding + 2}) var reflectionHistoryMetadata: texture_2d<u32>;
@group(${group}) @binding(${firstBinding + 3}) var<uniform> reflectionSamplingConfig: ReflectionConfig;
fn sampleReflection(uv: vec2f, world: vec3f, normal: vec3f, roughness: f32, fallback: vec3f) -> ReflectionSample {
  if (reflectionSamplingConfig.frame.z == 0u) { return ReflectionSample(vec3f(0.0), 0u); }
  if (reflectionSamplingConfig.frame.z == 1u) { return ReflectionSample(fallback, 2u); }
  let size = vec2i(textureDimensions(reflectionHistory)); let depth = -(reflectionSamplingConfig.view * vec4f(world, 1.0)).z;
  let footprint = uv * vec2f(size) - 0.5; let base = vec2i(floor(footprint)); let fraction = fract(footprint);
  var sum = vec3f(0.0); var total = 0.0; var maximum = -1.0; var source = 2u;
  for (var y = 0; y < 2; y++) { for (var x = 0; x < 2; x++) {
    let pixel = clamp(base + vec2i(x, y), vec2i(0), size - 1);
    let history = textureLoad(reflectionHistory, pixel, 0); let surface = textureLoad(reflectionHistorySurface, pixel, 0);
    let metadata = textureLoad(reflectionHistoryMetadata, pixel, 0);
    let weight = select(1.0 - fraction.x, fraction.x, x == 1) * select(1.0 - fraction.y, fraction.y, y == 1);
    let surfaceValid = metadata.w != 0u && metadata.z == reflectionSamplingConfig.frame.y && history.a > 0.0
      && abs(history.a - depth) <= max(0.02, depth * 0.01) && dot(surface.xyz, normal) >= 0.98 && abs(surface.a - roughness) <= 0.005;
    if (weight <= 0.0 || !surfaceValid) { continue; }
    var radiance = fallback; var kind = metadata.x;
    if (reflectionQualify(metadata, history, surface, depth, normal, roughness, reflectionSamplingConfig)) { radiance = history.rgb; }
    else if (kind != 4u) { kind = 2u; }
    sum += radiance * weight; total += weight;
    if (weight > maximum) { maximum = weight; source = kind; }
  } }
  if (total <= 0.0) { return ReflectionSample(fallback, 2u); }
  return ReflectionSample(sum / total, source);
}
`;
}
