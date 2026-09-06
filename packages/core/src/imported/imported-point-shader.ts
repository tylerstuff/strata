/** Six-face point shadow sampling; taps cross face edges using the shared cube convention. */
export const importedPointShader = /* wgsl */ `
struct ImportedPointSettings { matrices: array<mat4x4f, 6>, positionRange: vec4f, colorIntensity: vec4f, controls: vec4f, };
@group(1) @binding(19) var<uniform> importedPoint: ImportedPointSettings;
@group(1) @binding(20) var importedPointDepth: texture_depth_2d_array;
@group(1) @binding(21) var importedPointStaticDepth: texture_depth_2d_array;
fn pointFaceDirection(face: i32, uv: vec2f) -> vec3f {
  let p = uv * 2.0 - 1.0;
  switch face {
    case 0: { return vec3f(1.0, -p.y, -p.x); }
    case 1: { return vec3f(-1.0, -p.y, p.x); }
    case 2: { return vec3f(p.x, 1.0, p.y); }
    case 3: { return vec3f(p.x, -1.0, -p.y); }
    case 4: { return vec3f(p.x, -p.y, 1.0); }
    default: { return vec3f(-p.x, -p.y, -1.0); }
  }
}
fn pointReceiverDepth(world: vec3f, dx: vec3f, dy: vec3f, face: i32, uv: vec2f) -> f32 {
  let matrix = importedPoint.matrices[face];
  let clip = matrix * vec4f(world, 1.0); let ndc = clip.xyz / clip.w;
  let a = matrix * vec4f(dx, 0.0); let b = matrix * vec4f(dy, 0.0);
  let sx = (a.xyz - ndc * a.w) / clip.w * vec3f(0.5, -0.5, 1.0);
  let sy = (b.xyz - ndc * b.w) / clip.w * vec3f(0.5, -0.5, 1.0);
  let det = sx.x * sy.y - sx.y * sy.x;
  var gradient = vec2f(0.0);
  if (abs(det) > 1e-12) { gradient = vec2f(sx.z * sy.y - sy.z * sx.y, sy.z * sx.x - sx.z * sy.x) / det; }
  let center = ndc.xy * vec2f(0.5, -0.5) + 0.5;
  return ndc.z + clamp(dot(gradient, uv - center), -0.01, 0.01) - 0.000005;
}
fn pointVisibility(world: vec3f, dx: vec3f, dy: vec3f, dynamicOnly: bool) -> f32 {
  let address = importedCubeAddress(world - importedPoint.positionRange.xyz);
  let edge = importedPoint.controls.z; var sum = 0.0;
  let cell = floor(address.uv * edge);
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let tap = (cell + vec2f(f32(x), f32(y)) + 0.5) / edge;
    let adjacent = importedCubeAddress(pointFaceDirection(address.face, tap));
    let pixel = clamp(vec2i(adjacent.uv * edge), vec2i(0), vec2i(i32(edge) - 1));
    let reference = pointReceiverDepth(world, dx, dy, adjacent.face, (vec2f(pixel) + 0.5) / edge);
    var depth = textureLoad(importedPointDepth, pixel, adjacent.face, 0);
    if (!dynamicOnly) { depth = min(depth, textureLoad(importedPointStaticDepth, pixel, adjacent.face, 0)); }
    sum += select(0.0, 1.0, reference <= depth);
  } }
  return sum / 9.0;
}
fn pointDirect(world: vec3f, dx: vec3f, dy: vec3f, base: vec3f, roughness: f32, metallic: f32, normal: vec3f, view: vec3f) -> vec3f {
  if (importedPoint.controls.x < 0.5) { return vec3f(0.0); }
  let delta = importedPoint.positionRange.xyz - world; let distance = length(delta);
  if (distance < importedPoint.controls.y || distance >= importedPoint.positionRange.w) { return vec3f(0.0); }
  let fade = max(0.0, 1.0 - pow(distance / importedPoint.positionRange.w, 4.0));
  // Bounded HDR domain, matching the renderer's directional incident radiance bound.
  let incident = min(vec3f(64.0), importedPoint.colorIntensity.rgb * importedPoint.colorIntensity.a / (distance * distance)) * fade * fade;
  return evaluateDirectLight(base, roughness, metallic, normal, view, delta / distance, incident) * pointVisibility(world, dx, dy, false);
}
`;
