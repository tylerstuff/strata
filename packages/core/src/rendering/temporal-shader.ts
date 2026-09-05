import { temporalAbsoluteDepthTolerance, temporalHistoryWeight, temporalRelativeDepthTolerance } from './temporal-reprojection.js';

export const temporalShader = /* wgsl */ `
struct ResolveOptions {
  size: vec2u,
  useHistory: u32,
  padding: u32,
};
@group(0) @binding(0) var currentHdr: texture_2d<f32>;
@group(0) @binding(1) var currentMotion: texture_2d<f32>;
@group(0) @binding(2) var previousHistory: texture_2d<f32>;
@group(0) @binding(3) var<uniform> options: ResolveOptions;

@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[index], 0.0, 1.0);
}

fn catmullRomWeights(fraction: f32) -> vec4f {
  let squared = fraction * fraction;
  let cubed = squared * fraction;
  return vec4f(-0.5 * fraction + squared - 0.5 * cubed,
    1.0 - 2.5 * squared + 1.5 * cubed,
    0.5 * fraction + 2.0 * squared - 1.5 * cubed,
    -0.5 * squared + 0.5 * cubed);
}

@fragment fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = vec2i(position.xy);
  let size = vec2i(options.size);
  let current = textureLoad(currentHdr, pixel, 0).rgb;
  // XY is previousUV-currentUV. Z/W are current/expected-prior positive view depth.
  let motion = textureLoad(currentMotion, pixel, 0);
  let currentOnly = vec4f(current, max(motion.z, 0.0));
  if (options.useHistory == 0u || !(motion.z > 0.0 && motion.w > 0.0)) {
    return currentOnly;
  }
  let currentUv = (vec2f(pixel) + vec2f(0.5)) / vec2f(options.size);
  let previousUv = currentUv + motion.xy;
  if (!(all(previousUv >= vec2f(0.0)) && all(previousUv < vec2f(1.0)))) {
    return currentOnly;
  }
  let footprint = previousUv * vec2f(options.size) - vec2f(0.5);
  let footprintBase = vec2i(floor(footprint));
  let fraction = fract(footprint);
  let tolerance = max(${temporalAbsoluteDepthTolerance}, ${temporalRelativeDepthTolerance} * motion.w);
  var accumulated = vec3f(0.0);
  var acceptedWeight = 0.0;
  let cubicX = catmullRomWeights(fraction.x);
  let cubicY = catmullRomWeights(fraction.y);
  var cubicAccumulated = vec3f(0.0);
  var cubicValid = true;
  // Signed cubic weights are safe only when every contributing depth agrees.
  // A rejected tap falls back to positive, depth-qualified central bilinear taps;
  // never renormalize a partially accepted signed kernel across a depth edge.
  for (var y = 0; y < 4; y++) {
    for (var x = 0; x < 4; x++) {
      let historyPixel = clamp(footprintBase + vec2i(x - 1, y - 1), vec2i(0), size - vec2i(1));
      let tap = textureLoad(previousHistory, historyPixel, 0);
      let matches = tap.a > 0.0 && abs(tap.a - motion.w) <= tolerance;
      let cubicWeight = cubicX[x] * cubicY[y];
      if (cubicWeight != 0.0) {
        if (matches) { cubicAccumulated += tap.rgb * cubicWeight; }
        else { cubicValid = false; }
      }
      if (x >= 1 && x <= 2 && y >= 1 && y <= 2) {
        let weight = select(1.0 - fraction.x, fraction.x, x == 2) * select(1.0 - fraction.y, fraction.y, y == 2);
        if (weight > 0.0 && matches) {
          accumulated += tap.rgb * weight;
          acceptedWeight += weight;
        }
      }
    }
  }
  if (!(acceptedWeight > 0.0)) {
    return currentOnly;
  }
  var minimum = current;
  var maximum = current;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let neighbor = clamp(pixel + vec2i(x, y), vec2i(0), size - vec2i(1));
      let color = textureLoad(currentHdr, neighbor, 0).rgb;
      minimum = min(minimum, color);
      maximum = max(maximum, color);
    }
  }
  let reconstructed = select(accumulated / acceptedWeight, cubicAccumulated, cubicValid);
  let history = clamp(reconstructed, minimum, maximum);
  // A tiny surviving footprint must not carry the full historical confidence.
  let historyWeight = ${temporalHistoryWeight} * clamp(acceptedWeight, 0.0, 1.0);
  return vec4f(mix(current, history, historyWeight), motion.z);
}
`;
