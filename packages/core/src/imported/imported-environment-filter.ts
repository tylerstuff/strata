/** Explicit cube filtering over the existing six 2D-array layers per preset. */
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
fn importedCubeFaceDirection(face: i32, p: vec2f) -> vec3f {
  switch face {
    case 0: { return vec3f(1.0, -p.y, -p.x); }
    case 1: { return vec3f(-1.0, -p.y, p.x); }
    case 2: { return vec3f(p.x, 1.0, p.y); }
    case 3: { return vec3f(p.x, -1.0, -p.y); }
    case 4: { return vec3f(p.x, -p.y, 1.0); }
    default: { return vec3f(-p.x, -p.y, -1.0); }
  }
}
fn importedCubeLoad(direction: vec3f, face: i32, edge: i32, level: i32, preset: i32) -> vec3f {
  let pixel = clamp(vec2i(floor(importedCubeFaceUv(direction, face) * f32(edge))), vec2i(0), vec2i(edge - 1));
  return textureLoad(importedEnvironmentCube, pixel, preset * 6 + face, level).rgb;
}
fn importedCubeTap(face: i32, pixel: vec2i, edge: i32, level: i32, preset: i32) -> vec3f {
  let outside = (pixel < vec2i(0)) | (pixel >= vec2i(edge));
  if (!any(outside)) { return textureLoad(importedEnvironmentCube, pixel, preset * 6 + face, level).rgb; }
  let p = (vec2f(pixel) + 0.5) * (2.0 / f32(edge)) - 1.0;
  if (all(outside)) {
    // The missing fourth tap at a corner is the mean of its three incident
    // face-corner texels. This defined rule preserves constants and symmetry.
    let corner = importedCubeFaceDirection(face, sign(p));
    let x = select(0, 1, corner.x < 0.0); let y = select(2, 3, corner.y < 0.0); let z = select(4, 5, corner.z < 0.0);
    return (importedCubeLoad(corner, x, edge, level, preset) + importedCubeLoad(corner, y, edge, level, preset)
      + importedCubeLoad(corner, z, edge, level, preset)) / 3.0;
  }
  // Extend the source face texel center through the edge to the adjacent face.
  // The projected border texel is in bounds even for the final 1x1 level.
  let direction = importedCubeFaceDirection(face, p); let adjacent = importedCubeAddress(direction);
  return importedCubeLoad(direction, adjacent.face, edge, level, preset);
}
fn importedCubeLevel(address: ImportedCubeAddress, level: i32, preset: i32) -> vec3f {
  let edge = 64 >> u32(level); let position = address.uv * f32(edge) - 0.5;
  let pixel = vec2i(floor(position)); let weight = fract(position);
  let a = mix(importedCubeTap(address.face, pixel, edge, level, preset), importedCubeTap(address.face, pixel + vec2i(1, 0), edge, level, preset), weight.x);
  let b = mix(importedCubeTap(address.face, pixel + vec2i(0, 1), edge, level, preset), importedCubeTap(address.face, pixel + vec2i(1, 1), edge, level, preset), weight.x);
  return mix(a, b, weight.y);
}
fn importedCubeRadiance(direction: vec3f, lod: f32, preset: i32) -> vec3f {
  let address = importedCubeAddress(direction); let clamped = clamp(lod, 0.0, 6.0); let lower = i32(floor(clamped));
  let a = importedCubeLevel(address, lower, preset); let weight = fract(clamped);
  if (weight == 0.0 || lower == 6) { return a; }
  return mix(a, importedCubeLevel(address, lower + 1, preset), weight);
}
`;
