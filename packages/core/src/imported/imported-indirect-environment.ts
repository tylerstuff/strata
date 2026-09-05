/**
 * Incident radiance contract from imported-lighting-quality 4942f50.
 * Matches radiance() in scripts/imported-environment-bake.mjs, before cube
 * filtering, SH projection, exposure or BRDF integration. Constant is test-only.
 */
export const importedIndirectEnvironmentShader = /* wgsl */ `
fn importedIndirectEnvironment(world: vec3f, settings: vec4f, constantRadiance: vec3f) -> vec3f {
  if (settings.x == 0.0 || settings.y == 0.0) { return vec3f(0.0); }
  if (settings.x == 3.0) { return constantRadiance * settings.y; }
  let direction = vec3f(settings.z * world.x - settings.w * world.z, world.y,
    settings.w * world.x + settings.z * world.z);
  var radiance: vec3f;
  if (settings.x == 1.0) {
    radiance = vec3f(0.025, 0.03, 0.04);
    radiance += vec3f(4.2, 3.9, 3.6) * exp(12.0 * (dot(direction, normalize(vec3f(-0.45, 0.72, 0.52))) - 1.0));
    radiance += vec3f(2.8, 3.1, 3.5) * exp(20.0 * (dot(direction, normalize(vec3f(0.75, 0.3, -0.65))) - 1.0));
    radiance += vec3f(0.35, 0.4, 0.5) * exp(4.0 * (dot(direction, normalize(vec3f(-0.5, 0.1, -0.7))) - 1.0));
  } else {
    let horizon = vec3f(0.55, 0.65, 0.8);
    let y = direction.y;
    if (y >= 0.0) { radiance = mix(horizon, vec3f(0.24, 0.48, 0.95), pow(y, 0.6)); }
    else { radiance = mix(horizon, vec3f(0.045, 0.04, 0.035), 1.0 - exp(y * 6.0)); }
  }
  return radiance * settings.y;
}
`;
