import { importedPointShader } from './imported-point-shader.js';
import { bakedProbeShader } from './baked-probes.js';
import { importedEnvironmentShader } from './imported-environment.js';
import { importedTransformShader } from './imported-transform.js';

/** Appended to the production raster shader; frame, shadow and GGX code are shared. */
export const importedShader = /* wgsl */ `
${importedEnvironmentShader}
${importedTransformShader}
${bakedProbeShader}
${importedPointShader}
struct ImportedMaterial {
  base: vec4f,
  emissive: vec4f,
  factors: vec4f,
  alpha: vec4f,
  lightmap: vec4f,
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
@group(1) @binding(16) var importedLightmap: texture_2d<f32>;
@group(1) @binding(22) var importedBakedPoint: texture_2d<f32>;
fn bakedPointTexel(p: vec2i) -> vec3f {
  let extent=vec2i(textureDimensions(importedBakedPoint));
  let value=textureLoad(importedBakedPoint,clamp(p,vec2i(0),extent-1),0);
  return value.rgb*value.a*importedMaterial.lightmap.w;
}
fn bakedPointDiffuse(uv: vec2f) -> vec3f {
  let p=clamp(uv,vec2f(0.0),vec2f(1.0))*vec2f(textureDimensions(importedBakedPoint))-0.5;
  let cell=vec2i(floor(p));let f=fract(p);
  return mix(mix(bakedPointTexel(cell),bakedPointTexel(cell+vec2i(1,0)),f.x),mix(bakedPointTexel(cell+vec2i(0,1)),bakedPointTexel(cell+vec2i(1,1)),f.x),f.y);
}
fn lightmapTexel(p: vec2i) -> vec3f {
  let extent = vec2i(textureDimensions(importedLightmap));
  let encoded = textureLoad(importedLightmap, clamp(p, vec2i(0), extent - vec2i(1)), 0);
  return encoded.rgb * encoded.a * importedMaterial.lightmap.x;
}
fn lightmapDiffuse(uv: vec2f) -> vec3f {
  let p = clamp(uv, vec2f(0.0), vec2f(1.0)) * vec2f(textureDimensions(importedLightmap)) - vec2f(0.5);
  let cell = vec2i(floor(p)); let f = fract(p);
  // Decode before interpolation: RGBM components cannot be filtered as linear radiance.
  return mix(mix(lightmapTexel(cell), lightmapTexel(cell + vec2i(1, 0)), f.x),
    mix(lightmapTexel(cell + vec2i(0, 1)), lightmapTexel(cell + vec2i(1, 1)), f.x), f.y);
}
struct ImportedVertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) tangent: vec4f,
  @location(4) color: vec4f,
  @location(7) lightmapUv: vec2f,
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
  @location(8) lightmapUv: vec2f,
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
  output.uv = input.uv; output.color = input.color; output.lightmapUv = input.lightmapUv;
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
  let basis = importedTransformFrame(a, input.normal, input.tangent);
  return importedVertex(input, (current * vec4f(input.position, 1.0)).xyz, (previous * vec4f(input.position, 1.0)).xyz,
    basis.normal, basis.tangent);
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
  let shadowGradient = shadowReceiverGradient(input.world);
  let worldDx = dpdx(input.world); let worldDy = dpdy(input.world);
  let baseSample = textureSample(importedBase, importedBaseSampler, input.uv);
  let mr = textureSample(importedMr, importedMrSampler, input.uv);
  var normalSample = textureSample(importedNormal, importedNormalSampler, input.uv).xyz * 2.0 - 1.0;
  if (importedMaterial.alpha.z > 1.5) {
    let xy = normalSample.xy * vec2f(1.0, select(1.0, -1.0, importedMaterial.alpha.z > 2.5));
    normalSample = vec3f(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
  }
  let occlusion = mix(1.0, textureSample(importedOcclusion, importedOcclusionSampler, input.uv).r, importedMaterial.factors.w);
  let emission = textureSample(importedEmissive, importedEmissiveSampler, input.uv).rgb * importedMaterial.emissive.rgb * importedMaterial.emissive.a;
  let bakedMode = importedEnvironmentSettings.modes.y > 0.5;
  let vertexAlbedo = vec4f(select(input.color.rgb, vec3f(1.0), bakedMode), input.color.a);
  let base = baseSample * importedMaterial.base * vertexAlbedo;
  if (importedMaterial.alpha.y > 0.5 && base.a < importedMaterial.alpha.x) { discard; }
  let shadow = shadowVisibilityPrepared(input.world, shadowGradient);
  let relit = importedMaterial.alpha.w > 0.5 && importedEnvironmentSettings.modes.x > 0.5;
  let unlit = importedMaterial.alpha.w > 0.5 && !relit;
  let roughness = select(clamp(mr.g * importedMaterial.factors.y, 0.06, 1.0), 0.65, relit);
  let metallic = select(clamp(mr.b * importedMaterial.factors.x, 0.0, 1.0), 0.0, relit);
  let basis = importedSurfaceFrame(input.normal, input.tangent);
  let n = basis.normal;
  let t = basis.tangent.xyz;
  let b = cross(n, t) * input.tangent.w;
  let mapped = normalize(vec3f(normalSample.xy * importedMaterial.factors.z, normalSample.z));
  // glTF flips the shaded normal on a double-sided backface, including normal mapping.
  let normal = select(n, normalize(mat3x3f(t, b, n) * mapped), importedMaterial.alpha.z > 0.5 && !relit) * select(-1.0, 1.0, front);
  let view = normalize(frame.eyeTime.xyz - input.world);
  let direct = evaluateDirectLight(base.rgb, roughness, metallic, normal,
    view, importedLight.direction.xyz, importedLight.radiance.rgb) * shadow;
  // Explicit diffuse fill, affected only by the asset's baked AO. This is not world-space GI or IBL.
  let materialAo = select(occlusion, 1.0, relit);
  let fill = base.rgb * (1.0 - metallic) * importedLight.ambient.rgb * materialAo;
  let environment = importedEnvironmentLight(base.rgb, roughness, metallic, normal, view, materialAo);
  var lightmapped = vec3f(0.0);
  if (importedMaterial.lightmap.x > 0.0) {
    var irradiance=lightmapDiffuse(input.lightmapUv);
    let distance=length(input.world-importedPoint.positionRange.xyz);
    if (importedMaterial.lightmap.w > 0.0 && importedPoint.controls.w > 0.5 && distance >= importedPoint.controls.y && distance < importedPoint.positionRange.w) {
      let contribution=min(irradiance,bakedPointDiffuse(input.lightmapUv));
      if (any(contribution > vec3f(0.0))) { irradiance-=contribution*(1.0-pointVisibility(input.world,worldDx,worldDy,true)); }
    }
    lightmapped=base.rgb*(1.0-metallic)*irradiance;
  }
  if (importedMaterial.lightmap.y > 0.5) { lightmapped += base.rgb * (1.0 - metallic) * bakedProbeDiffuse(input.world, normal); }
  var local = vec3f(0.0);
  if (importedMaterial.lightmap.z > 0.5) { local = pointDirect(input.world, worldDx, worldDy, base.rgb, roughness, metallic, normal, view); }
  let baked = select(vec3f(0.0), base.rgb * (1.0 - metallic) * input.color.rgb * importedEnvironmentSettings.modes.z, bakedMode);
  var output: GBufferOutput;
  output.hdr = vec4f(select(direct + local + fill + baked + lightmapped + select(emission, vec3f(0.0), relit) + environment, base.rgb, unlit), shadow);
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
