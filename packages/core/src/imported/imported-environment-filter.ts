/** Hardware bilinear filtering over precomputed face aprons; explicit roughness interpolation. */
export const importedEnvironmentFilter = /* wgsl */ `
struct ImportedCubeAddress { face: i32, uv: vec2f, };
fn importedCubeFaceUv(d: vec3f, face: i32) -> vec2f {
  var p: vec2f;
  switch face {
    case 0: { p = vec2f(-d.z, -d.y) / abs(d.x); }
    case 1: { p = vec2f(d.z, -d.y) / abs(d.x); }
    case 2: { p = vec2f(d.x, d.z) / abs(d.y); }
    case 3: { p = vec2f(d.x, -d.z) / abs(d.y); }
    case 4: { p = vec2f(d.x, -d.y) / abs(d.z); }
    default: { p = vec2f(-d.x, -d.y) / abs(d.z); }
  }
  return p * 0.5 + 0.5;
}
fn importedCubeAddress(d: vec3f) -> ImportedCubeAddress {
  let a = abs(d); var face: i32;
  if (a.x >= a.y && a.x >= a.z) { face = select(0, 1, d.x < 0.0); }
  else if (a.y >= a.z) { face = select(2, 3, d.y < 0.0); }
  else { face = select(4, 5, d.z < 0.0); }
  return ImportedCubeAddress(face, importedCubeFaceUv(d, face));
}
fn importedCubeLevel(address: ImportedCubeAddress, level: i32, preset: i32) -> vec3f {
  let edge = 64 >> u32(level);
  let row = 128 - (128 >> u32(level)) + 2 * level;
  let p = address.uv * f32(edge) + vec2f(1.0);
  return textureSampleLevel(importedEnvironmentCube, importedEnvironmentSampler,
    (p + vec2f(0.0, f32(row))) / vec2f(66.0, 141.0), preset * 6 + address.face, 0.0).rgb;
}
fn importedCubeRadiance(direction: vec3f, lod: f32, preset: i32) -> vec3f {
  let address = importedCubeAddress(direction); let clamped = clamp(lod, 0.0, 6.0); let lower = i32(floor(clamped));
  let a = importedCubeLevel(address, lower, preset); let weight = fract(clamped);
  if (weight == 0.0 || lower == 6) { return a; }
  return mix(a, importedCubeLevel(address, lower + 1, preset), weight);
}
`;
