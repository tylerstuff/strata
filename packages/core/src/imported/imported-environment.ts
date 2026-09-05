import { StrataError } from '../errors.js';
import type { ImportedEnvironment } from './imported-types.js';
import { environmentCubeData, environmentDfgData, environmentMetadata } from './imported-environment-data.js';
import { importedEnvironmentFilter } from './imported-environment-filter.js';
export { importedEnvironmentTextureBytes as environmentTextureBytes } from './imported-limits.js';

export const environmentUniformBytes = 176;
export type EnvironmentSettings = Required<ImportedEnvironment> | null;

export function snapshotEnvironment(value: ImportedEnvironment | null | undefined): EnvironmentSettings {
  if (value === undefined || value === null) return null;
  const fail = (): never => { throw new StrataError('INVALID_OPTIONS', 'Imported environment needs studio/sky, intensity 0–64, and a finite rotation in radians within +/-1e6.'); };
  if (typeof value !== 'object' || Array.isArray(value) || !['studio', 'sky'].includes(value.preset)
    || !Number.isFinite(value.intensity) || value.intensity < 0 || value.intensity > 64) fail();
  const rotationRadians = value.rotationRadians === undefined ? 0 : value.rotationRadians;
  if (!Number.isFinite(rotationRadians) || Math.abs(rotationRadians) > 1e6) fail();
  return { preset: value.preset, intensity: value.intensity, rotationRadians };
}

/** World-to-environment rotation is inverse yaw; all diffuse/specular samples use it. */
export function environmentUniform(environment: EnvironmentSettings, shading: 'authored' | 'relit'): Float32Array<ArrayBuffer> {
  const data = new Float32Array(environmentUniformBytes / 4), rotation = environment?.rotationRadians ?? 0;
  data.set([environment?.intensity ?? 0, Math.cos(rotation), Math.sin(rotation), environment?.preset === 'sky' ? 1 : 0]);
  data[4] = Number(shading === 'relit');
  if (environment) environmentMetadata.environments[environment.preset].sh.forEach((coefficient, index) => data.set(coefficient, 8 + index * 4));
  return data;
}

function decode(encoded: string, expected: number): Uint8Array<ArrayBuffer> {
  const source = atob(encoded);
  if (source.length !== expected) throw new StrataError('RENDER_FAILED', 'Generated environment payload has an invalid length.');
  return Uint8Array.from(source, character => character.charCodeAt(0));
}

/** Fixed procedural resources owned by one ImportedGeometry, including when lighting is off. */
export function createEnvironmentResources(device: GPUDevice): {
  cube: GPUTexture; dfg: GPUTexture; sampler: GPUSampler; uniform: GPUBuffer;
} {
  let cube: GPUTexture | undefined, dfg: GPUTexture | undefined, uniform: GPUBuffer | undefined;
  try {
    cube = device.createTexture({ label: 'Strata generated studio/sky GGX radiance', size: [64, 64, 12], mipLevelCount: 7,
      format: 'rgba16float', usage: 0x2 | 0x4 });
    for (const [index, preset] of (['studio', 'sky'] as const).entries()) {
      const bytes = decode(environmentCubeData[preset], 262128); let offset = 0;
      for (let level = 0; level < 7; level++) {
        const edge = 64 >> level, length = edge * edge * 6 * 8;
        device.queue.writeTexture({ texture: cube, mipLevel: level, origin: [0, 0, index * 6] }, bytes.subarray(offset, offset + length),
          { bytesPerRow: edge * 8, rowsPerImage: edge }, [edge, edge, 6]);
        offset += length;
      }
    }
    dfg = device.createTexture({ label: 'Strata generated correlated GGX DFG', size: [64, 64], format: 'rg16float', usage: 0x2 | 0x4 });
    device.queue.writeTexture({ texture: dfg }, decode(environmentDfgData, 16384), { bytesPerRow: 64 * 4 }, [64, 64]);
    uniform = device.createBuffer({ label: 'Strata imported environment and shading', size: environmentUniformBytes, usage: 0x40 | 0x8 });
    device.queue.writeBuffer(uniform, 0, environmentUniform(null, 'authored'));
    const sampler = device.createSampler({ label: 'Strata environment trilinear clamp', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge', minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear' });
    return { cube, dfg, sampler, uniform };
  } catch (error) { cube?.destroy(); dfg?.destroy(); uniform?.destroy(); throw error; }
}

export const importedEnvironmentShader = /* wgsl */ `
struct ImportedEnvironmentSettings { parameters: vec4f, modes: vec4f, sh: array<vec4f, 9>, };
@group(1) @binding(12) var importedEnvironmentCube: texture_2d_array<f32>;
@group(1) @binding(13) var importedEnvironmentDfg: texture_2d<f32>;
@group(1) @binding(14) var importedEnvironmentSampler: sampler;
@group(1) @binding(15) var<uniform> importedEnvironmentSettings: ImportedEnvironmentSettings;
${importedEnvironmentFilter}
fn importedEnvironmentDirection(world: vec3f) -> vec3f {
  let c = importedEnvironmentSettings.parameters.y; let s = importedEnvironmentSettings.parameters.z;
  return vec3f(c * world.x - s * world.z, world.y, s * world.x + c * world.z);
}
fn importedEnvironmentIrradiance(n: vec3f) -> vec3f {
  let sh = importedEnvironmentSettings.sh;
  return max(vec3f(0.0), sh[0].rgb * 0.28209479177387814
    + sh[1].rgb * (0.4886025119029199 * n.y) + sh[2].rgb * (0.4886025119029199 * n.z) + sh[3].rgb * (0.4886025119029199 * n.x)
    + sh[4].rgb * (1.0925484305920792 * n.x * n.y) + sh[5].rgb * (1.0925484305920792 * n.y * n.z)
    + sh[6].rgb * (0.31539156525252005 * (3.0 * n.z * n.z - 1.0))
    + sh[7].rgb * (1.0925484305920792 * n.x * n.z) + sh[8].rgb * (0.5462742152960396 * (n.x * n.x - n.y * n.y)));
}
fn importedEnvironmentLight(base: vec3f, roughness: f32, metallic: f32, normal: vec3f, view: vec3f, ao: f32) -> vec3f {
  if (importedEnvironmentSettings.parameters.x <= 0.0) { return vec3f(0.0); }
  let nv = clamp(dot(normal, view), 0.0001, 1.0);
  let roughnessCoordinate = clamp((roughness - 0.06) / 0.94, 0.0, 1.0);
  // Endpoint grid with a quadratic NoV distribution keeps both material endpoints and grazing samples.
  let dfgUv = (vec2f(sqrt((nv - 0.0001) / 0.9999), roughnessCoordinate) * 63.0 + 0.5) / 64.0;
  let dfg = textureSampleLevel(importedEnvironmentDfg, importedEnvironmentSampler, dfgUv, 0.0).rg;
  let f0 = mix(vec3f(0.04), base, metallic);
  let specularEnergy = clamp(f0 * dfg.x + dfg.y, vec3f(0.0), vec3f(1.0));
  let reflection = importedEnvironmentDirection(reflect(-view, normal));
  let radiance = importedCubeRadiance(reflection, roughnessCoordinate * 6.0, i32(importedEnvironmentSettings.parameters.w));
  let irradiance = importedEnvironmentIrradiance(importedEnvironmentDirection(normal));
  // Energy-bounded diffuse partition, a declared split-sum approximation. SH contains irradiance, not irradiance/pi.
  // Material AO affects diffuse only; specular has no geometry visibility/occlusion approximation.
  let diffuse = base * (1.0 - metallic) * (1.0 - specularEnergy) * irradiance * (ao / 3.141592653589793);
  return (diffuse + radiance * specularEnergy) * importedEnvironmentSettings.parameters.x;
}
`;
