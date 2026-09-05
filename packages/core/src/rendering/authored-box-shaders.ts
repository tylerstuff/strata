import { ggxDistributionShader } from './raster-shaders.js';

/**
 * Matches the existing fixed-exposure presentation curve. For an sRGB target,
 * the attachment performs the transfer; ordinary canvas unorm targets need it
 * explicitly. Background uses this final mapping in both diagnostic modes.
 */
export function authoredClearColor(
  background: readonly [number, number, number], targetIsSrgb: boolean,
): GPUColorDict {
  const present = (value: number) => {
    const mapped = Math.max(0, Math.min(1, (value * (2.51 * value + 0.03)) / (value * (2.43 * value + 0.59) + 0.14)));
    return targetIsSrgb ? mapped : mapped <= 0.0031308 ? mapped * 12.92 : 1.055 * mapped ** (1 / 2.4) - 0.055;
  };
  return { r: present(background[0]), g: present(background[1]), b: present(background[2]), a: 1 };
}

/** Authored root-box color and submitted-view motion; no temporal accumulation. */
export function authoredBoxShader(targetIsSrgb: boolean): string {
  return /* wgsl */ `
${ggxDistributionShader}
const attachmentIsSrgb = ${targetIsSrgb};
struct Frame {
  viewProjection: mat4x4f,
  previousViewProjection: mat4x4f,
  directionToLight: vec4f,
  radiance: vec4f,
  settings: vec4u,
};
@group(0) @binding(0) var<uniform> frame: Frame;
struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) model0: vec4f,
  @location(3) model1: vec4f,
  @location(4) model2: vec4f,
  @location(5) model3: vec4f,
  @location(6) normal0: vec3f,
  @location(7) normal1: vec3f,
  @location(8) normal2: vec3f,
  @location(9) material: vec4f,
  @location(10) roughness: f32,
  @location(11) previousModel0: vec4f,
  @location(12) previousModel1: vec4f,
  @location(13) previousModel2: vec4f,
  @location(14) previousModel3: vec4f,
};
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) relativePosition: vec3f,
  @location(1) normal: vec3f,
  @location(2) @interpolate(flat) material: vec4f,
  @location(3) @interpolate(flat) roughness: f32,
  @location(4) previousClip: vec4f,
  @location(5) viewDepth: f32,
};
@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
  let model = mat4x4f(input.model0, input.model1, input.model2, input.model3);
  let normalMatrix = mat3x3f(input.normal0, input.normal1, input.normal2);
  let relative = model * vec4f(input.position, 1.0);
  var output: VertexOutput;
  output.position = frame.viewProjection * relative;
  let previousModel = mat4x4f(input.previousModel0, input.previousModel1, input.previousModel2, input.previousModel3);
  output.previousClip = frame.previousViewProjection * (previousModel * vec4f(input.position, 1.0));
  output.viewDepth = output.position.w;
  output.relativePosition = relative.xyz;
  output.normal = normalMatrix * input.normal;
  output.material = input.material;
  output.roughness = input.roughness;
  return output;
}
fn linearToSrgb(value: vec3f) -> vec3f {
  let color = max(value, vec3f(0.0));
  return select(1.055 * pow(color, vec3f(1.0 / 2.4)) - 0.055, color * 12.92, color <= vec3f(0.0031308));
}
fn toneMap(value: vec3f) -> vec3f {
  let x = max(value, vec3f(0.0));
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
fn present(value: vec3f) -> vec3f {
  if (attachmentIsSrgb) { return value; }
  return linearToSrgb(value);
}
fn authoredDirect(base: vec3f, authoredRoughness: f32, metallic: f32, n: vec3f, position: vec3f) -> vec3f {
  let light = normalize(frame.directionToLight.xyz);
  let nl = clamp(dot(n, light), 0.0, 1.0);
  let viewLengthSquared = dot(position, position);
  if (nl <= 0.0 || viewLengthSquared <= 0.000000000001) { return vec3f(0.0); }
  let view = -position * inverseSqrt(viewLengthSquared);
  let viewCosine = dot(n, view);
  if (viewCosine <= 0.0) { return vec3f(0.0); }
  let halfVector = view + light;
  let halfLengthSquared = dot(halfVector, halfVector);
  if (halfLengthSquared <= 0.000000000001) { return vec3f(0.0); }
  let halfDirection = halfVector * inverseSqrt(halfLengthSquared);
  let nv = clamp(viewCosine, 0.0001, 1.0);
  let nh = clamp(dot(n, halfDirection), 0.0, 1.0);
  let vh = clamp(dot(view, halfDirection), 0.0, 1.0);
  // The same numerical floor applies to distribution AND visibility. The
  // descriptor remains unchanged; roughness zero does not create a mirror.
  let roughness = clamp(authoredRoughness, 0.06, 1.0);
  let alpha = roughness * roughness;
  let alpha2 = alpha * alpha;
  let distribution = distributionGgx(roughness, nh);
  let visibility = 0.5 / max(nl * sqrt(nv * nv * (1.0 - alpha2) + alpha2)
    + nv * sqrt(nl * nl * (1.0 - alpha2) + alpha2), 0.00001);
  let f0 = mix(vec3f(0.04), base, metallic);
  let fresnel = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);
  let diffuse = (1.0 - fresnel) * (1.0 - metallic) * base / 3.14159265;
  return (diffuse + distribution * visibility * fresnel) * nl * frame.radiance.xyz;
}
fn color(input: VertexOutput) -> vec4f {
  if (frame.settings.x == 1u) { return vec4f(present(input.material.rgb), 1.0); }
  let direct = authoredDirect(input.material.rgb, input.roughness, input.material.a,
    normalize(input.normal), input.relativePosition);
  return vec4f(present(toneMap(direct)), 1.0);
}
struct FragmentOutput {
  @location(0) color: vec4f,
  @location(1) motion: vec4f,
};
@fragment fn fragmentMain(input: VertexOutput) -> FragmentOutput {
  var output: FragmentOutput;
  output.color = color(input);
  output.motion = vec4f(0.0, 0.0, input.viewDepth, 0.0);
  // Interpolate homogeneous previous clips with the CURRENT perspective, then
  // divide here. W=0 explicitly rejects missing/out-of-frustum prior data; it
  // does not claim the point was visible in the prior depth buffer.
  let previous = input.previousClip;
  if (frame.settings.y != 0u && previous.w > 0.0
    && all(abs(previous.xy) <= vec2f(previous.w)) && previous.z >= 0.0 && previous.z <= previous.w) {
    let currentUv = input.position.xy / vec2f(frame.settings.zw);
    let previousUv = previous.xy / previous.w * vec2f(0.5, -0.5) + vec2f(0.5);
    output.motion = vec4f(previousUv - currentUv, input.viewDepth, previous.w);
  }
  return output;
}
`;
}
