import { StrataError } from '../errors.js';
import type { ImportedVec3 } from './imported-types.js';

/** Fixed scene-space grid. Six-axis diffuse irradiance/pi and octahedral first-hit distances. */
export interface BakedProbeVolume {
  readonly version: 1;
  /** Omission means combined emission direct plus indirect transport. */
  readonly transport?: 'combined' | 'indirect';
  readonly revision: string;
  readonly origin: ImportedVec3;
  readonly spacing: ImportedVec3;
  readonly counts: ImportedVec3;
  /** Probe-major +X,-X,+Y,-Y,+Z,-Z RGB, linear HDR. */
  readonly irradiance: readonly number[];
  /** Probe-major 16x16 octahedral nearest-surface distances in scene units. */
  readonly visibility: readonly number[];
  readonly valid: readonly number[];
}
export function prepareBakedProbes(volume?: BakedProbeVolume): { data: Float32Array<ArrayBuffer>; uniform: Float32Array<ArrayBuffer>; revision?: string } {
  const fail = (): never => { throw new StrataError('INVALID_OPTIONS', 'Invalid baked probe volume: finite bounded version-1 grid and complete HDR/visibility payload required.'); };
  if (!volume) return { data: new Float32Array(280), uniform: new Float32Array(16) };
  if (volume.transport !== undefined && volume.transport !== 'combined' && volume.transport !== 'indirect') fail();
  if (volume.version !== 1 || typeof volume.revision !== 'string' || !volume.revision.length || volume.revision.length > 128) fail();
  for (const vector of [volume.origin, volume.spacing, volume.counts]) if (!Array.isArray(vector) || vector.length !== 3 || !vector.every(Number.isFinite)) fail();
  if (volume.origin.some(v => Math.abs(v) > 1024) || volume.spacing.some(v => v <= 0 || v > 1024)
    || volume.counts.some(v => !Number.isInteger(v) || v < 2 || v > 64)) fail();
  const count = volume.counts.reduce((n, v) => n * v, 1);
  if (count > 4096 || volume.origin.some((v, i) => Math.abs(v + volume.spacing[i]! * (volume.counts[i]! - 1)) > 1024)) fail();
  for (const [array, length, maximum] of [[volume.irradiance, count * 18, 65536], [volume.visibility, count * 256, 8192], [volume.valid, count, 1]] as const) {
    if (!Array.isArray(array) || array.length !== length || !array.every(v => Number.isFinite(v) && v >= 0 && v <= maximum)) fail();
  }
  if (volume.valid.some(v => v !== 0 && v !== 1)) fail();
  const data = new Float32Array(count * 280), uniform = new Float32Array(16);
  for (let probe = 0; probe < count; probe++) {
    for (let face = 0; face < 6; face++) {
      for (let channel = 0; channel < 3; channel++) data[probe * 280 + face * 4 + channel] = volume.irradiance[probe * 18 + face * 3 + channel]!;
      data[probe * 280 + face * 4 + 3] = volume.valid[probe]!;
    }
    for (let ray = 0; ray < 256; ray++) data[probe * 280 + 24 + ray] = volume.visibility[probe * 256 + ray]!;
  }
  uniform.set(volume.origin, 0); uniform.set(volume.spacing, 4); new Uint32Array(uniform.buffer).set(volume.counts, 8);
  uniform[12] = 1; uniform[13] = Math.min(...volume.spacing) * .025;
  return { data, uniform, revision: volume.revision };
}

export const bakedProbeShader = /* wgsl */ `
struct BakedProbeSettings { origin: vec4f, spacing: vec4f, counts: vec4u, controls: vec4f, };
@group(1) @binding(17) var<storage, read> bakedProbeData: array<vec4f>;
@group(1) @binding(18) var<uniform> bakedProbeSettings: BakedProbeSettings;
fn bakedOct(direction: vec3f) -> vec2f {
  let d = direction / max(dot(abs(direction), vec3f(1.0)), 1e-8);
  var uv = d.xy;
  if (d.z < 0.0) { uv = (vec2f(1.0) - abs(uv.yx)) * select(vec2f(-1.0), vec2f(1.0), uv >= vec2f(0.0)); }
  return uv * 0.5 + 0.5;
}
fn bakedProbeDiffuse(world: vec3f, normal: vec3f) -> vec3f {
  if (bakedProbeSettings.controls.x < 0.5) { return vec3f(0.0); }
  let grid = (world - bakedProbeSettings.origin.xyz) / bakedProbeSettings.spacing.xyz;
  let maximum = vec3f(bakedProbeSettings.counts.xyz - vec3u(1));
  if (any(grid < vec3f(0.0)) || any(grid > maximum)) { return vec3f(0.0); }
  let cell = min(vec3u(floor(grid)), bakedProbeSettings.counts.xyz - vec3u(2));
  let fraction = grid - vec3f(cell);
  var sum = vec3f(0.0); var total = 0.0;
  for (var corner = 0u; corner < 8u; corner++) {
    let offset = vec3u(corner & 1u, (corner >> 1u) & 1u, (corner >> 2u) & 1u);
    let coordinate = cell + offset;
    let index = coordinate.x + bakedProbeSettings.counts.x * (coordinate.y + bakedProbeSettings.counts.y * coordinate.z);
    let base = index * 70u;
    if (bakedProbeData[base].w < 0.5) { continue; }
    let position = bakedProbeSettings.origin.xyz + vec3f(coordinate) * bakedProbeSettings.spacing.xyz;
    let delta = world + normal * bakedProbeSettings.controls.y - position;
    let distance = length(delta);
    let uv = min(vec2u(bakedOct(delta) * 16.0), vec2u(15));
    let ray = uv.x + uv.y * 16u;
    let visibleDistance = bakedProbeData[base + 6u + ray / 4u][ray % 4u];
    if (distance > visibleDistance + bakedProbeSettings.controls.y) { continue; }
    let weights = select(vec3f(1.0) - fraction, fraction, offset != vec3u(0));
    let weight = weights.x * weights.y * weights.z;
    let n2 = normal * normal;
    let light = bakedProbeData[base + select(1u, 0u, normal.x >= 0.0)].rgb * n2.x
      + bakedProbeData[base + select(3u, 2u, normal.y >= 0.0)].rgb * n2.y
      + bakedProbeData[base + select(5u, 4u, normal.z >= 0.0)].rgb * n2.z;
    sum += light * weight; total += weight;
  }
  // Zero is explicit when all nearby probes are invalid/occluded; no unoccluded fallback.
  return sum / max(total, 1e-6);
}
`;
