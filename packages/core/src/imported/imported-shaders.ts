import { importedEnvironmentShader } from './imported-environment.js';

/** Appended to the production raster shader; frame, shadow and GGX code are shared. */
export const importedShader = /* wgsl */ `
${importedEnvironmentShader}
struct ImportedMaterial {
  base: vec4f,
  emissive: vec4f,
  factors: vec4f,
  alpha: vec4f,
};
struct ImportedLight { direction: vec4f, radiance: vec4f, ambient: vec4f, };
@group(1) @binding(0) var<uniform> importedMaterial: ImportedMaterial;
@group(1) @binding(1) var importedBase: texture_2d<f32>;
@group(1) @binding(2) var importedBaseSampler: sampler;
@group(1) @binding(3) var importedMr: texture_2d<f32>;
@group(1) @binding(4) var importedMrSampler: sampler;
@group(1) @binding(5) var importedNormal: texture_2d<f32>;
@group(1) @binding(6) var importedNormalSampler: sampler;
@group(1) @binding(7) var importedOcclusion: texture_2d<f32>;
@group(1) @binding(8) var importedOcclusionSampler: sampler;
@group(1) @binding(9) var importedEmissive: texture_2d<f32>;
@group(1) @binding(10) var importedEmissiveSampler: sampler;
@group(1) @binding(11) var<uniform> importedLight: ImportedLight;
struct ImportedVertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) tangent: vec4f,
  @location(4) color: vec4f,
};
struct ImportedVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) uv: vec2f,
  @location(2) world: vec3f,
  @location(3) currentClip: vec4f,
  @location(4) previousClip: vec4f,
  @location(5) viewDepths: vec2f,
  @location(6) tangent: vec4f,
  @location(7) color: vec4f,
};
struct ImportedShadowOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) alpha: f32,
};
fn importedVertex(input: ImportedVertexInput, current: vec3f, previous: vec3f, normal: vec3f, tangent: vec4f) -> ImportedVertexOutput {
  var output: ImportedVertexOutput;
  output.currentClip = frame.viewProjection * vec4f(current, 1.0);
  output.previousClip = frame.previousViewProjection * vec4f(previous, 1.0);
  output.position = output.currentClip; output.world = current;
  output.normal = normal; output.tangent = tangent;
  output.uv = input.uv; output.color = input.color;
  output.viewDepths = vec2f(-(frame.view * vec4f(current, 1.0)).z, -(frame.previousView * vec4f(previous, 1.0)).z);
  return output;
}
fn importedShadow(input: ImportedVertexInput, position: vec3f) -> ImportedShadowOutput {
  var output: ImportedShadowOutput;
  output.position = frame.lightViewProjection * vec4f(position, 1.0);
  output.uv = input.uv; output.alpha = input.color.a;
  return output;
}
@vertex fn importedVertexMain(input: ImportedVertexInput) -> ImportedVertexOutput {
  return importedVertex(input, input.position, input.position, input.normal, input.tangent);
}
@vertex fn importedShadowMain(input: ImportedVertexInput) -> ImportedShadowOutput {
  return importedShadow(input, input.position);
}
struct ImportedDeformation { mode: u32, node: u32, padding0: u32, padding1: u32, };
@group(2) @binding(0) var<storage, read> importedCurrentTransforms: array<mat4x4f>;
@group(2) @binding(1) var<storage, read> importedPreviousTransforms: array<mat4x4f>;
@group(2) @binding(2) var<uniform> importedDeformation: ImportedDeformation;
struct ImportedSkinInput { @location(5) joints: vec4u, @location(6) weights: vec4f, };
fn importedCurrentSkinMatrix(skin: ImportedSkinInput) -> mat4x4f {
  let weights = skin.weights / max(dot(skin.weights, vec4f(1.0)), 1e-8);
  return importedCurrentTransforms[skin.joints.x] * weights.x + importedCurrentTransforms[skin.joints.y] * weights.y
    + importedCurrentTransforms[skin.joints.z] * weights.z + importedCurrentTransforms[skin.joints.w] * weights.w;
}
fn importedPreviousSkinMatrix(skin: ImportedSkinInput) -> mat4x4f {
  let weights = skin.weights / max(dot(skin.weights, vec4f(1.0)), 1e-8);
  return importedPreviousTransforms[skin.joints.x] * weights.x + importedPreviousTransforms[skin.joints.y] * weights.y
    + importedPreviousTransforms[skin.joints.z] * weights.z + importedPreviousTransforms[skin.joints.w] * weights.w;
}
fn importedDeformedVertex(input: ImportedVertexInput, current: mat4x4f, previous: mat4x4f) -> ImportedVertexOutput {
  let a = mat3x3f(current[0].xyz, current[1].xyz, current[2].xyz);
  let cofactors = mat3x3f(cross(a[1], a[2]), cross(a[2], a[0]), cross(a[0], a[1]));
  let determinant = dot(a[0], cofactors[0]);
  // Exact inverse transpose up to normalization, including determinant sign.
  // A collapsing animated transform has no unique normal; retain a finite local fallback.
  let transformed = cofactors * input.normal * select(-1.0, 1.0, determinant >= 0.0);
  let normal = normalize(select(input.normal, transformed, dot(transformed, transformed) > 1e-16));
  let tangentRaw = a * input.tangent.xyz;
  let tangent = normalize(select(input.tangent.xyz, tangentRaw, dot(tangentRaw, tangentRaw) > 1e-16));
  return importedVertex(input, (current * vec4f(input.position, 1.0)).xyz, (previous * vec4f(input.position, 1.0)).xyz,
    normal, vec4f(tangent, input.tangent.w * select(-1.0, 1.0, determinant >= 0.0)));
}
@vertex fn importedRigidVertexMain(input: ImportedVertexInput) -> ImportedVertexOutput {
  return importedDeformedVertex(input, importedCurrentTransforms[importedDeformation.node], importedPreviousTransforms[importedDeformation.node]);
}
@vertex fn importedRigidShadowMain(input: ImportedVertexInput) -> ImportedShadowOutput {
  return importedShadow(input, (importedCurrentTransforms[importedDeformation.node] * vec4f(input.position, 1.0)).xyz);
}
@vertex fn importedSkinVertexMain(input: ImportedVertexInput, skin: ImportedSkinInput) -> ImportedVertexOutput {
  return importedDeformedVertex(input, importedCurrentSkinMatrix(skin), importedPreviousSkinMatrix(skin));
}
@vertex fn importedSkinShadowMain(input: ImportedVertexInput, skin: ImportedSkinInput) -> ImportedShadowOutput {
  return importedShadow(input, (importedCurrentSkinMatrix(skin) * vec4f(input.position, 1.0)).xyz);
}
@fragment fn importedShadowFragment(input: ImportedShadowOutput) {
  let alpha = textureSample(importedBase, importedBaseSampler, input.uv).a * importedMaterial.base.a * input.alpha;
  if (importedMaterial.alpha.y > 0.5 && alpha < importedMaterial.alpha.x) { discard; }
}
@fragment fn importedFragment(input: ImportedVertexOutput, @builtin(front_facing) front: bool) -> GBufferOutput {
  let baseSample = textureSample(importedBase, importedBaseSampler, input.uv);
  let mr = textureSample(importedMr, importedMrSampler, input.uv);
  let normalSample = textureSample(importedNormal, importedNormalSampler, input.uv).xyz * 2.0 - 1.0;
  let occlusion = mix(1.0, textureSample(importedOcclusion, importedOcclusionSampler, input.uv).r, importedMaterial.factors.w);
  let emission = textureSample(importedEmissive, importedEmissiveSampler, input.uv).rgb * importedMaterial.emissive.rgb * importedMaterial.emissive.a;
  let base = baseSample * importedMaterial.base * input.color;
  if (importedMaterial.alpha.y > 0.5 && base.a < importedMaterial.alpha.x) { discard; }
  let relit = importedMaterial.alpha.w > 0.5 && importedEnvironmentSettings.modes.x > 0.5;
  let unlit = importedMaterial.alpha.w > 0.5 && !relit;
  let roughness = select(clamp(mr.g * importedMaterial.factors.y, 0.06, 1.0), 0.65, relit);
  let metallic = select(clamp(mr.b * importedMaterial.factors.x, 0.0, 1.0), 0.0, relit);
  let n = normalize(input.normal);
  let t = normalize(input.tangent.xyz - n * dot(n, input.tangent.xyz));
  let b = cross(n, t) * input.tangent.w;
  let mapped = normalize(vec3f(normalSample.xy * importedMaterial.factors.z, normalSample.z));
  // glTF flips the shaded normal on a double-sided backface, including normal mapping.
  let normal = select(n, normalize(mat3x3f(t, b, n) * mapped), importedMaterial.alpha.z > 0.5 && !relit) * select(-1.0, 1.0, front);
  let shadow = shadowVisibility(input.world);
  let view = normalize(frame.eyeTime.xyz - input.world);
  let direct = evaluateDirectLight(base.rgb, roughness, metallic, normal,
    view, importedLight.direction.xyz, importedLight.radiance.rgb) * shadow;
  // Explicit diffuse fill, affected only by the asset's baked AO. This is not world-space GI or IBL.
  let materialAo = select(occlusion, 1.0, relit);
  let fill = base.rgb * (1.0 - metallic) * importedLight.ambient.rgb * materialAo;
  let environment = importedEnvironmentLight(base.rgb, roughness, metallic, normal, view, materialAo);
  var output: GBufferOutput;
  output.hdr = vec4f(select(direct + fill + select(emission, vec3f(0.0), relit) + environment, base.rgb, unlit), shadow);
  output.normal = vec4f(select(normal, n * select(-1.0, 1.0, front), unlit), roughness);
  output.material = vec4f(base.rgb, metallic);
  let currentUv = input.currentClip.xy / input.currentClip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  let previousUv = input.previousClip.xy / input.previousClip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  output.motion = vec4f(previousUv - currentUv, input.viewDepths);
  return output;
}
`;

export const importedMipmapShader = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
struct MipVertex { @builtin(position) position: vec4f, @location(0) uv: vec2f, };
@vertex fn mipVertex(@builtin(vertex_index) index: u32) -> MipVertex {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  var output: MipVertex; output.position = vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0); output.uv = uv; return output;
}
@fragment fn mipFragment(input: MipVertex) -> @location(0) vec4f { return textureSample(source, sourceSampler, input.uv); }
`;
