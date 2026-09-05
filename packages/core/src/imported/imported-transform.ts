/** Shared by imported raster stages and the generated numerical shader probe. */
export const importedTransformShader = /* wgsl */ `
struct ImportedTangentFrame { normal: vec3f, tangent: vec4f, };
fn importedMaxAbs(v: vec3f) -> f32 { return max(max(abs(v.x), abs(v.y)), abs(v.z)); }
fn importedScaleDirection(v: vec3f) -> vec3f {
  let scale = importedMaxAbs(v);
  if (scale > 0.0) { return v / scale; }
  return vec3f(0.0);
}
fn importedUnit(v: vec3f, fallback: vec3f) -> vec3f {
  let scale = importedMaxAbs(v);
  // Divide components directly: a reciprocal can overflow for a tiny valid vector.
  if (scale > 0.0) {
    let scaled = v / scale;
    return scaled * inverseSqrt(dot(scaled, scaled));
  }
  return fallback;
}
fn importedPerpendicular(n: vec3f) -> vec3f {
  // Choose an axis away from n, so even a collapsed tangent has a finite basis.
  let axis = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.x) > 0.5);
  return importedUnit(cross(n, axis), vec3f(0.0, 0.0, 1.0));
}
fn importedSurfaceFrame(normal: vec3f, tangent: vec4f) -> ImportedTangentFrame {
  let n = importedUnit(normal, vec3f(0.0, 1.0, 0.0));
  let direction = importedUnit(tangent.xyz, vec3f(0.0));
  let transverse = cross(n, direction);
  // This cutoff is dimensionless, after normalization. It prevents roundoff in
  // a parallel tangent from being amplified into an arbitrary nonorthogonal axis.
  // A second cross keeps the result perpendicular even for nearly parallel input;
  // subtracting n * dot(n, direction) would amplify its cancellation error.
  if (dot(transverse, transverse) > 1e-12) {
    return ImportedTangentFrame(n, vec4f(importedUnit(cross(transverse, n), vec3f(1.0, 0.0, 0.0)), tangent.w));
  }
  return ImportedTangentFrame(n, vec4f(importedPerpendicular(n), tangent.w));
}
fn importedTransformFrame(linear: mat3x3f, normal: vec3f, tangent: vec4f) -> ImportedTangentFrame {
  let scale = max(max(importedMaxAbs(linear[0]), importedMaxAbs(linear[1])), importedMaxAbs(linear[2]));
  let local = importedSurfaceFrame(normal, tangent);
  if (scale == 0.0) { return local; }
  // A positive common scale changes neither direction nor handedness. Remove it
  // before cross products: a valid small model must not look like a collapsed skin.
  let a = mat3x3f(linear[0] / scale, linear[1] / scale, linear[2] / scale);
  let cofactors = mat3x3f(cross(a[1], a[2]), cross(a[2], a[0]), cross(a[0], a[1]));
  // Only the sign uses independent column scales. The determinant of a very
  // anisotropic matrix can underflow even when its needed cofactor is usable.
  let orientation = dot(importedScaleDirection(linear[0]),
    cross(importedScaleDirection(linear[1]), importedScaleDirection(linear[2])));
  let sign = select(-1.0, 1.0, orientation >= 0.0);
  // Inverse transpose up to positive magnitude, including reflections. A truly
  // collapsed blend has no unique normal; retain a finite local fallback.
  let n = importedUnit(cofactors * local.normal * sign, local.normal);
  let t = importedUnit(a * importedUnit(tangent.xyz, local.tangent.xyz), local.tangent.xyz);
  return importedSurfaceFrame(n, vec4f(t, tangent.w * sign));
}
`;
