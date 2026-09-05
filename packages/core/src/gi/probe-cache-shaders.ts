import { giTraceShader } from './trace-shaders.js';

const structs = /* wgsl */ `
struct GiProbeConfig { origin: vec4f, grid: vec4u, budget: vec4u, settings: vec4f, sequence: vec4u, atlas: vec4u, };
struct GiProbeState { epoch: u32, valid: u32, updates: u32, lastFrame: u32, };
struct GiProbeRay { radianceDistance: vec4f, directionStatus: vec4f, };
fn giProbePosition(id: u32, config: GiProbeConfig) -> vec3f {
  let x = id % config.grid.x; let y = (id / config.grid.x) % config.grid.y; let z = id / (config.grid.x * config.grid.y);
  return config.origin.xyz + vec3f(f32(x), f32(y), f32(z)) * config.origin.w;
}
fn giOctDirection(uv: vec2f) -> vec3f {
  var n = vec3f(uv * 2.0 - 1.0, 0.0); n.z = 1.0 - abs(n.x) - abs(n.y);
  if (n.z < 0.0) { n = vec3f((1.0 - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0)), n.z); }
  return normalize(n);
}
fn giOctEncode(direction: vec3f) -> vec2f {
  var n = direction / max(abs(direction.x) + abs(direction.y) + abs(direction.z), 1e-8);
  if (n.z < 0.0) { n = vec3f((1.0 - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0)), n.z); }
  return n.xy * 0.5 + 0.5;
}
`;

export function probeTraceShader(): string {
  return structs + giTraceShader({ group: 1, firstBinding: 0 }) + /* wgsl */ `
@group(0) @binding(0) var<uniform> probeConfig: GiProbeConfig;
@group(0) @binding(1) var<storage, read_write> probeRays: array<GiProbeRay>;
@group(0) @binding(2) var<storage, read_write> probeStats: array<atomic<u32>>;
@compute @workgroup_size(64) fn probeTrace(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= probeConfig.budget.y * probeConfig.budget.z) { return; }
  let localProbe = id.x / probeConfig.budget.z; let rayIndex = id.x % probeConfig.budget.z;
  let probe = (probeConfig.budget.x + localProbe) % probeConfig.grid.w;
  let y = 1.0 - 2.0 * (f32(rayIndex) + 0.5) / f32(probeConfig.budget.z);
  let phase = f32((probe * 747796405u + probeConfig.sequence.x * 2891336453u + probeConfig.sequence.z) & 65535u) * 0.000095873799;
  let angle = f32(rayIndex) * 2.399963229728653 + phase;
  let radius = sqrt(max(0.0, 1.0 - y * y));
  // Transcendental approximations vary across WebGPU backends; tracing requires a unit ray.
  let direction = normalize(vec3f(cos(angle) * radius, y, sin(angle) * radius));
  let origin = giProbePosition(probe, probeConfig);
  let ray = GiRay(origin, 0.002, direction, probeConfig.settings.y);
  let hit = giTraceBvh(ray);
  atomicAdd(&probeStats[0], 1u);
  var radiance = vec3f(0.0); var distance = probeConfig.settings.y; var status = 1.0;
  if (hit.status == 2u) { atomicAdd(&probeStats[3], 1u); status = -2.0; distance = 0.0; }
  else if (hit.status == 0u) { atomicAdd(&probeStats[2], 1u); }
  else {
    atomicAdd(&probeStats[1], 1u); distance = hit.distance;
    if (dot(hit.normal, direction) >= 0.0) { status = -1.0; }
    else {
      let material = giMaterials[hit.materialId]; radiance = material.emission;
      let cosine = max(0.0, dot(hit.normal, giTraceConfig.lightDirection));
      if (cosine > 0.0) {
        let point = origin + direction * hit.distance + hit.normal * 0.002;
        let shadow = giTraceAnyBvh(GiRay(point, 0.002, giTraceConfig.lightDirection, probeConfig.settings.y));
        atomicAdd(&probeStats[4], 1u);
        if (shadow.status == 0u) { radiance += material.albedo * giTraceConfig.lightRadiance * (cosine / 3.141592653589793); }
        else { atomicAdd(&probeStats[5], 1u); if (shadow.status == 2u) { atomicAdd(&probeStats[3], 1u); } }
      }
    }
  }
  probeRays[id.x].radianceDistance = vec4f(radiance, distance);
  probeRays[id.x].directionStatus = vec4f(direction, status);
}
`;
}

export const probeUpdateShader = structs + /* wgsl */ `
@group(0) @binding(0) var<uniform> probeConfig: GiProbeConfig;
@group(0) @binding(1) var<storage, read> probeRays: array<GiProbeRay>;
@group(0) @binding(2) var<storage, read_write> probeStates: array<GiProbeState>;
@group(0) @binding(3) var previousIrradiance: texture_2d<f32>;
@group(0) @binding(4) var previousVisibility: texture_2d<f32>;
@group(0) @binding(5) var nextIrradiance: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var nextVisibility: texture_storage_2d<rg32float, write>;
@group(0) @binding(7) var<storage, read_write> probeStats: array<atomic<u32>>;
var<workgroup> oldProbe: GiProbeState;
@compute @workgroup_size(64) fn probeUpdate(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let probe = (probeConfig.budget.x + group.x) % probeConfig.grid.w;
  if (lane == 0u) { oldProbe = probeStates[probe]; }
  workgroupBarrier();
  let origin = vec2u(probe % probeConfig.atlas.x, probe / probeConfig.atlas.x);
  let rayStart = group.x * probeConfig.budget.z;
  var backfaces = 0u; var failures = 0u;
  for (var index = 0u; index < probeConfig.budget.z; index++) {
    let status = probeRays[rayStart + index].directionStatus.w;
    if (status == -1.0) { backfaces++; } if (status == -2.0) { failures++; }
  }
  let valid = backfaces * 4u <= probeConfig.budget.z && failures == 0u;
  let history = select(0.0, probeConfig.settings.x, oldProbe.epoch == probeConfig.budget.w && oldProbe.valid != 0u && valid);
  let irradianceSize = probeConfig.atlas.y; let momentSize = probeConfig.atlas.z;
  for (var texel = lane; texel < momentSize * momentSize; texel += 64u) {
    let local = vec2u(texel % momentSize, texel / momentSize);
    let direction = giOctDirection((vec2f(local) + 0.5) / f32(momentSize));
    var moments = vec2f(0.0); var weight = 0.0;
    for (var index = 0u; index < probeConfig.budget.z; index++) {
      let ray = probeRays[rayStart + index];
      let cosine = pow(max(0.0, dot(direction, ray.directionStatus.xyz)), 32.0);
      let distance = ray.radianceDistance.w;
      moments += vec2f(distance, distance * distance) * cosine; weight += cosine;
    }
    moments /= max(weight, 1e-8);
    let coordinate = vec2i(origin * momentSize + local);
    // Visibility changes immediately when sampled; irradiance alone uses temporal hysteresis.
    // This avoids averaging old open-door distances into newly closed-door occlusion.
    textureStore(nextVisibility, coordinate, vec4f(moments, 0.0, 0.0));
  }
  if (lane < irradianceSize * irradianceSize) {
    let local = vec2u(lane % irradianceSize, lane / irradianceSize);
    let direction = giOctDirection((vec2f(local) + 0.5) / f32(irradianceSize));
    var irradiance = vec3f(0.0); var weight = 0.0;
    for (var index = 0u; index < probeConfig.budget.z; index++) {
      let ray = probeRays[rayStart + index]; let cosine = max(0.0, dot(direction, ray.directionStatus.xyz));
      irradiance += ray.radianceDistance.rgb * cosine; weight += cosine;
    }
    irradiance *= 3.141592653589793 / max(weight, 1e-6);
    let coordinate = vec2i(origin * irradianceSize + local);
    let previous = textureLoad(previousIrradiance, coordinate, 0).rgb;
    textureStore(nextIrradiance, coordinate, vec4f(select(vec3f(0.0), mix(irradiance, previous, history), valid), select(0.0, 1.0, valid)));
  }
  if (lane == 0u) {
    probeStates[probe] = GiProbeState(probeConfig.budget.w, select(0u, 1u, valid), select(1u, oldProbe.updates + 1u, oldProbe.epoch == probeConfig.budget.w), probeConfig.sequence.x);
    atomicAdd(&probeStats[7], 1u); if (!valid) { atomicAdd(&probeStats[6], 1u); }
  }
}
`;

/** Four read bindings: irradiance, distance moments, epoch/validity state, pending-frame config. */
export function probeSamplingShader({ group = 2, firstBinding = 0 }: { group?: number; firstBinding?: number } = {}): string {
  return structs + /* wgsl */ `
@group(${group}) @binding(${firstBinding}) var giProbeIrradiance: texture_2d<f32>;
@group(${group}) @binding(${firstBinding + 1}) var giProbeVisibility: texture_2d<f32>;
@group(${group}) @binding(${firstBinding + 2}) var<storage, read> giProbeStates: array<GiProbeState>;
@group(${group}) @binding(${firstBinding + 3}) var<uniform> giProbeConfig: GiProbeConfig;
fn giOctWrap(input: vec2i, size: i32) -> vec2i {
  var p = input;
  if (p.x < 0) { p = vec2i(-p.x - 1, size - p.y - 1); }
  else if (p.x >= size) { p = vec2i(2 * size - p.x - 1, size - p.y - 1); }
  if (p.y < 0) { p = vec2i(size - p.x - 1, -p.y - 1); }
  else if (p.y >= size) { p = vec2i(size - p.x - 1, 2 * size - p.y - 1); }
  return p;
}
fn giLoadProbe(texture: texture_2d<f32>, probe: u32, size: u32, direction: vec3f) -> vec4f {
  let pixel = giOctEncode(direction) * f32(size) - 0.5;
  let low = vec2i(floor(pixel)); let high = low + vec2i(1); let factor = fract(pixel);
  let origin = vec2i(i32(probe % giProbeConfig.atlas.x), i32(probe / giProbeConfig.atlas.x)) * i32(size);
  // Fold virtual border taps into this probe, preserving octahedral continuity without atlas gutters.
  return mix(mix(textureLoad(texture, origin + giOctWrap(low, i32(size)), 0),
    textureLoad(texture, origin + giOctWrap(vec2i(high.x, low.y), i32(size)), 0), factor.x),
    mix(textureLoad(texture, origin + giOctWrap(vec2i(low.x, high.y), i32(size)), 0),
    textureLoad(texture, origin + giOctWrap(high, i32(size)), 0), factor.x), factor.y);
}
fn giProbeVisibilityWeight(distance: f32, moments: vec2f) -> f32 {
  if (distance <= moments.x + 0.02) { return 1.0; }
  let variance = max(moments.y - moments.x * moments.x, 0.0001);
  let difference = distance - moments.x; let probability = variance / (variance + difference * difference);
  return probability * probability * probability;
}
// Nearest probe: validity, age in explicit frame ticks, epoch match, distance to probe.
fn sampleProbeDiagnostics(world: vec3f) -> vec4f {
  let grid = (world - giProbeConfig.origin.xyz) / giProbeConfig.origin.w;
  let cell = clamp(vec3i(round(grid)), vec3i(0), vec3i(giProbeConfig.grid.xyz) - vec3i(1));
  let probe = u32(cell.x) + u32(cell.y) * giProbeConfig.grid.x + u32(cell.z) * giProbeConfig.grid.x * giProbeConfig.grid.y;
  let state = giProbeStates[probe]; let current = state.epoch == giProbeConfig.budget.w;
  let age = giProbeConfig.sequence.x - min(giProbeConfig.sequence.x, state.lastFrame);
  return vec4f(select(0.0, 1.0, current && state.valid != 0u), f32(age), select(0.0, 1.0, current), length(world - giProbePosition(probe, giProbeConfig)));
}
fn sampleProbeIrradiance(world: vec3f, normal: vec3f, viewDirection: vec3f) -> vec3f {
  let point = world + normal * giProbeConfig.settings.z + viewDirection * 0.02;
  let grid = (point - giProbeConfig.origin.xyz) / giProbeConfig.origin.w;
  let base = vec3i(floor(grid)); let fraction = fract(grid);
  var irradiance = vec3f(0.0); var totalWeight = 0.0;
  for (var corner = 0u; corner < 8u; corner++) {
    let offset = vec3i(i32(corner & 1u), i32((corner >> 1u) & 1u), i32((corner >> 2u) & 1u));
    let cell = base + offset;
    if (any(cell < vec3i(0)) || any(cell >= vec3i(giProbeConfig.grid.xyz))) { continue; }
    let probe = u32(cell.x) + u32(cell.y) * giProbeConfig.grid.x + u32(cell.z) * giProbeConfig.grid.x * giProbeConfig.grid.y;
    let state = giProbeStates[probe];
    if (state.epoch != giProbeConfig.budget.w || state.valid == 0u) { continue; }
    let position = giProbePosition(probe, giProbeConfig);
    let delta = point - position; let distance = length(delta); let direction = select(normal, delta / max(distance, 1e-5), distance > 1e-5);
    let factors = select(vec3f(1.0) - fraction, fraction, offset != vec3i(0));
    let trilinear = factors.x * factors.y * factors.z;
    let orientation = pow(max(0.05, dot(normal, -direction) * 0.5 + 0.5), 2.0);
    let moments = giLoadProbe(giProbeVisibility, probe, giProbeConfig.atlas.z, direction).xy;
    let visibility = giProbeVisibilityWeight(distance, moments);
    let weight = trilinear * orientation * visibility;
    irradiance += giLoadProbe(giProbeIrradiance, probe, giProbeConfig.atlas.y, normal).rgb * weight; totalWeight += weight;
  }
  return irradiance / max(totalWeight, 1e-5);
}
`;
}
