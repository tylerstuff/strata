/** Shared with the browser shader probe so numeric validation executes the production function. */
export const ggxDistributionShader = /* wgsl */ `
fn distributionGgx(roughness: f32, nDotH: f32) -> f32 {
  let r = clamp(roughness, 0.06, 1.0);
  let alpha = r * r;
  let alpha2 = alpha * alpha;
  let nh = clamp(nDotH, 0.0, 1.0);
  let nh2 = nh * nh;
  // Avoid cancellation at normal incidence; floor before squaring and below
  // the minimum supported alpha2 (0.06^4 = 0.00001296).
  let denom = max((1.0 - nh2) + alpha2 * nh2, 0.0000001);
  return alpha2 / (3.14159265 * denom * denom);
}
`;

export const rasterShader = /* wgsl */ `
${ggxDistributionShader}
struct Frame {
  viewProjection: mat4x4f,
  previousViewProjection: mat4x4f,
  view: mat4x4f,
  previousView: mat4x4f,
  lightViewProjection: mat4x4f,
  eyeTime: vec4f,
  parameters: vec4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var baseColorTexture: texture_2d<f32>;
@group(0) @binding(2) var metallicRoughnessTexture: texture_2d<f32>;
@group(0) @binding(3) var materialSampler: sampler;
@group(0) @binding(4) var shadowTexture: texture_depth_2d;
@group(0) @binding(5) var shadowSampler: sampler_comparison;

struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) translation: vec3f,
  @location(3) scale: vec3f,
  @location(4) yaw: f32,
  @location(5) color: vec4f,
  @location(6) uv: vec2f,
  @builtin(instance_index) instance: u32,
};
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) color: vec3f,
  @location(2) uv: vec2f,
  @location(3) world: vec3f,
  @location(4) currentClip: vec4f,
  @location(5) previousClip: vec4f,
  @location(6) viewDepths: vec2f,
  @location(7) @interpolate(flat) metallic: f32,
  @location(8) @interpolate(flat) roughness: f32,
};
fn rotateY(value: vec3f, yaw: f32) -> vec3f {
  let c = cos(yaw); let s = sin(yaw);
  return vec3f(c * value.x + s * value.z, value.y, -s * value.x + c * value.z);
}
fn animatedOffset(instance: u32, time: f32) -> vec3f {
  if (instance == 1u) { return vec3f(sin(time * 1.7) * 1.2, 0.35 + sin(time * 2.3) * 0.35, cos(time * 1.3) * 0.7); }
  return vec3f(0.0);
}
fn worldPosition(input: VertexInput, time: f32) -> vec3f {
  return rotateY(input.position * input.scale, input.yaw) + input.translation + animatedOffset(input.instance, time);
}
@vertex fn shadowMain(input: VertexInput) -> @builtin(position) vec4f {
  return frame.lightViewProjection * vec4f(worldPosition(input, frame.eyeTime.w), 1.0);
}
@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
  let current = worldPosition(input, frame.eyeTime.w);
  let previous = worldPosition(input, frame.parameters.x);
  var output: VertexOutput;
  output.currentClip = frame.viewProjection * vec4f(current, 1.0);
  output.previousClip = frame.previousViewProjection * vec4f(previous, 1.0);
  output.position = output.currentClip;
  output.normal = normalize(rotateY(input.normal / input.scale, input.yaw));
  output.world = current;
  output.color = input.color.rgb;
  output.uv = input.uv * select(2.0, 24.0, input.instance == 0u);
  output.viewDepths = vec2f(-(frame.view * vec4f(current, 1.0)).z, -(frame.previousView * vec4f(previous, 1.0)).z);
  output.metallic = select(0.0, 1.0, input.instance > 0u && input.instance % 3u == 0u);
  output.roughness = select(0.8, 0.28, output.metallic > 0.5);
  return output;
}
fn shadowVisibility(world: vec3f) -> f32 {
  let clip = frame.lightViewProjection * vec4f(world, 1.0);
  let ndc = clip.xyz / clip.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || ndc.z <= 0.0 || ndc.z >= 1.0) { return 1.0; }
  let texel = 1.0 / vec2f(textureDimensions(shadowTexture));
  var visibility = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      visibility += textureSampleCompareLevel(shadowTexture, shadowSampler, uv + vec2f(f32(x), f32(y)) * texel, ndc.z - 0.00025);
    }
  }
  return visibility / 9.0;
}
fn evaluateDirect(base: vec3f, roughness: f32, metallic: f32, n: vec3f, v: vec3f) -> vec3f {
  let l = normalize(vec3f(0.35, 0.8, 0.4));
  let h = normalize(v + l);
  let nl = max(dot(n, l), 0.0);
  let nv = max(dot(n, v), 0.0001);
  let nh = clamp(dot(n, h), 0.0, 1.0);
  let vh = max(dot(v, h), 0.0);
  let alpha = roughness * roughness;
  let alpha2 = alpha * alpha;
  let distribution = distributionGgx(roughness, nh);
  let visibility = 0.5 / max(nl * sqrt(nv * nv * (1.0 - alpha2) + alpha2) + nv * sqrt(nl * nl * (1.0 - alpha2) + alpha2), 0.00001);
  let f0 = mix(vec3f(0.04), base, metallic);
  let fresnel = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);
  let diffuse = (1.0 - fresnel) * (1.0 - metallic) * base / 3.14159265;
  return (diffuse + distribution * visibility * fresnel) * nl * vec3f(4.0, 3.8, 3.5);
}
struct GBufferOutput {
  @location(0) hdr: vec4f,
  @location(1) normal: vec4f,
  @location(2) material: vec4f,
  @location(3) motion: vec4f,
};
@fragment fn fragmentMain(input: VertexOutput) -> GBufferOutput {
  let base = textureSample(baseColorTexture, materialSampler, input.uv).rgb * input.color;
  let mr = textureSample(metallicRoughnessTexture, materialSampler, input.uv);
  let roughness = clamp(mr.g * input.roughness, 0.06, 1.0);
  let metallic = mr.b * input.metallic;
  let normal = normalize(input.normal);
  let shadow = shadowVisibility(input.world);
  let direct = evaluateDirect(base, roughness, metallic, normal, normalize(frame.eyeTime.xyz - input.world)) * shadow;
  let currentUV = input.currentClip.xy / input.currentClip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  let previousUV = input.previousClip.xy / input.previousClip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  var output: GBufferOutput;
  output.hdr = vec4f(direct, shadow);
  output.normal = vec4f(normal, roughness);
  output.material = vec4f(base, metallic);
  output.motion = vec4f(previousUV - currentUV, input.viewDepths);
  return output;
}
`;

export const presentationShader = /* wgsl */ `
struct Settings { mode: u32, padding: u32, far: f32, exposure: f32, };
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var resolved: texture_2d<f32>;
@group(0) @binding(2) var hdr: texture_2d<f32>;
@group(0) @binding(3) var normal: texture_2d<f32>;
@group(0) @binding(4) var material: texture_2d<f32>;
@group(0) @binding(5) var motion: texture_2d<f32>;
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
}
fn linearToSrgb(value: vec3f) -> vec3f {
  let color = max(value, vec3f(0.0));
  return select(1.055 * pow(color, vec3f(1.0 / 2.4)) - 0.055, color * 12.92, color <= vec3f(0.0031308));
}
fn toneMap(value: vec3f) -> vec3f {
  let x = max(value * settings.exposure, vec3f(0.0));
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
@fragment fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = vec2i(position.xy);
  let raw = textureLoad(hdr, pixel, 0);
  let velocity = textureLoad(motion, pixel, 0);
  let surface = textureLoad(normal, pixel, 0);
  let mat = textureLoad(material, pixel, 0);
  var color: vec3f;
  switch settings.mode {
    case 1u: { color = linearToSrgb(toneMap(raw.rgb)); }
    case 2u: { color = vec3f(raw.a); }
    case 3u: { color = vec3f(select(0.0, 1.0 - clamp(velocity.z / settings.far, 0.0, 1.0), velocity.z > 0.0)); }
    case 4u: { color = select(vec3f(0.0), surface.xyz * 0.5 + 0.5, velocity.z > 0.0); }
    case 5u: { color = vec3f(clamp(velocity.xy * 64.0 + 0.5, vec2f(0.0), vec2f(1.0)), 0.5); }
    case 6u: { color = vec3f(mat.a, surface.a, 0.0); }
    default: { color = linearToSrgb(toneMap(textureLoad(resolved, pixel, 0).rgb)); }
  }
  return vec4f(color, 1.0);
}
`;
