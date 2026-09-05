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
  // Bilinear filtering must reject depth per contributing texel, otherwise a
  // passing nearest-depth sample can still blend in a different surface's RGB.
  for (var y = 0; y <= 1; y++) {
    for (var x = 0; x <= 1; x++) {
      let historyPixel = clamp(footprintBase + vec2i(x, y), vec2i(0), size - vec2i(1));
      let tap = textureLoad(previousHistory, historyPixel, 0);
      let weight = select(1.0 - fraction.x, fraction.x, x == 1) * select(1.0 - fraction.y, fraction.y, y == 1);
      if (weight > 0.0 && tap.a > 0.0 && abs(tap.a - motion.w) <= tolerance) {
        accumulated += tap.rgb * weight;
        acceptedWeight += weight;
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
  let history = clamp(accumulated / acceptedWeight, minimum, maximum);
  return vec4f(mix(current, history, ${temporalHistoryWeight}), motion.z);
}
`;
