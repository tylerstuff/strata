# Imported material lighting

Tracked in [issue #33](https://github.com/tylerstuff/strata/issues/33). The optional
imported renderer supports authored material shading, an explicit unlit-material
relighting mode, and generated distant environment illumination. It remains an
ordinary browser WebGPU path. No source model or downloaded environment is bundled.

## Controls and material policy

Pass the controls through `engine.render({ imported: controls })`:

```ts
import type { ImportedControls } from '@strata-engine/core';

const controls: ImportedControls = {
  shading: 'authored',
  lighting: {
    directionToLight: [0.4, 0.8, 0.3],
    color: [1, 1, 1],
    intensity: 1,
    ambient: [0, 0, 0],
    environment: { preset: 'studio', intensity: 1, rotationRadians: 0 },
  },
};
```

`shading` defaults to `authored`. Source unlit materials keep their base texture,
factor and vertex colors and ignore lighting, emission, normal maps and AO as
specified by glTF. Choosing `relit` changes only those unlit materials to a matte
dielectric with metallic zero, roughness 0.65, and the geometric normal. It preserves
base colors, alpha masking, sidedness, and the animated pose. Previously ignored
normal, metallic/roughness, emission and AO fields remain ignored. Source PBR
materials keep their authored values in both modes. Caller-owned assets are not
modified. This explicit interpretation is useful for inspecting shape; it does
not recover a material that the source author did not supply.

Environment illumination defaults to off. A supplied `lighting` object replaces
the complete lighting state: omitted or null `environment` disables it. Omitting
`lighting` itself retains the current lights and environment. `shading` is retained
when omitted. Environment intensity is a scene-linear radiance multiplier in
0–64; zero turns illumination off. Rotation is finite radians within +/-1e6,
defaults to zero, and positive yaw rotates the environment about world +Y. Changes
reset temporal history. Imported telemetry reports the effective mode and a copied
environment setting.

Directional light, existing diffuse ambient fill and environment illumination are
additive. Set ambient to zero to measure the environment alone. Neither ambient
nor environment light knows scene visibility. The environment has no GI, local
reflections, shadowing by the model, or interior occlusion. A dark room cannot be
correctly lit by adding unrestricted distant light. Material AO attenuates diffuse
environment irradiance only; specular environment light has no occlusion model.

## Animated normal and tangent transforms

Rigid and skinned vertices transform normals by the inverse transpose and tangents
by the linear transform, retaining reflection handedness. The shader removes a
positive common matrix scale before forming cofactors and scales directions before
normalizing them. Small valid transforms therefore do not trigger a fallback merely
because of the model's units. The determinant sign uses separately scaled columns;
the normal cofactors retain relative column magnitudes for nonuniform scale.

A collapsed blended skin matrix has no unique inverse-transpose normal. When its
normal direction vanishes, the shader retains the local normal and constructs a
finite perpendicular tangent when needed. The same tangent repair applies after
interpolation. This is a rendering fallback, not a recovered physical surface;
severely ill-conditioned transforms remain limited by float32 precision. This
correction does not establish improved shadows, texture detail, or any particular
character's appearance.

Generated transform checks use an independent double-precision linear solver on
the exact float32 matrix inputs, including small/large uniform scales, reflections,
nonuniform scale, shear and degenerate blends. The imported browser validation
executes the production WGSL against these witnesses. CPU fixture checks alone do
not validate shader execution or accept visual quality.

## Incident radiance contract

The source of truth is `radiance` in `scripts/imported-environment-bake.mjs`.
For a normalized world direction `w`, first apply inverse yaw:

```text
d = (cos(yaw)*w.x - sin(yaw)*w.z, w.y,
     sin(yaw)*w.x + cos(yaw)*w.z)
incidentRadiance(w) = intensity * radiance(preset, d)
```

For studio, start at RGB `(0.025, 0.03, 0.04)` and sum three lobes
`color * exp(sharpness * (dot(d, normalize(direction)) - 1))`:

| Direction | Sharpness | Linear RGB |
| --- | --- | --- |
| (-0.45, 0.72, 0.52) | 12 | (4.2, 3.9, 3.6) |
| (0.75, 0.3, -0.65) | 20 | (2.8, 3.1, 3.5) |
| (-0.5, 0.1, -0.7) | 4 | (0.35, 0.4, 0.5) |

For sky, interpolate from horizon `(0.55, 0.65, 0.8)` to the upper pole
`(0.24, 0.48, 0.95)` by `d.y^0.6` when `d.y >= 0`. Otherwise interpolate from
the same horizon to `(0.045, 0.04, 0.035)` by `1 - exp(6*d.y)`. There is no
additional exposure multiplier or sun disk. Other lighting systems sharing these
settings must evaluate this incident radiance; the filtered lookup tables below
are approximations for a material response, not a replacement incident source.

## Approximation and resource bounds

Each preset has a 64-square RGBA16F cube with seven independently GGX-convolved
levels. Layer order is +X, -X, +Y, -Y, +Z, -Z; row zero is the top. Levels map linearly
to perceptual roughness 0.06–1. Each texel uses 256 deterministic GGX samples with
N=V=reflection direction, normalized by the sum of positive NoL. This split-sum
approximation does not retain view-dependent convolution for a nonuniform source.

The shader reads those same layers through a 2D-array view and performs explicit
bilinear and mip interpolation. Taps crossing one face edge fetch the corresponding
adjacent-face border texel. A corner's missing fourth tap is the mean of the three
incident face-corner texels. Both presets use the same rule, including the final
1-square mip. No texture load goes outside a face. This costs four to six explicit
texel loads per mip (at most twelve across two mips); its frame cost is unmeasured.

This filtering path followed a preserved local Chrome 152 software-adapter
failure: a constant-white cube returned 0.71132487 at direction
(-0.8660254, 0, 0.5), mip six, while its BRDF lookup was correct. An ordinary cube
view reproduced the cube-array result; a two-square mip also lost energy when
its footprint crossed an edge. The failure conflicts with constant-preserving
[seamless cube filtering](https://docs.vulkan.org/spec/latest/chapters/textures.html#textures-cubemapedge).
Explicit adjacent-face loads avoid this dependency without changing radiance,
roughness, energy acceptance, or the generated data. This evidence identifies
tested browser behavior, not an upstream SwiftShader revision or general adapter
classification.

Diffuse illumination uses nine real orthonormal spherical-harmonic coefficients.
Projection uses exact cube-texel solid angles, then cosine convolution factors
pi, 2pi/3, pi/4 for bands zero, one and two. These coefficients store irradiance;
the shader divides by pi exactly once. Band limitation smooths narrow lights and
can ring; reconstructed negative RGB values are clamped to zero.

A shared 64-square RG16F DFG lookup integrates single-scatter correlated Smith GGX
with alpha=roughness squared and Schlick Fresnel. It uses 4096 deterministic visible
GGX hemisphere samples and the direct shader's small-denominator guards. The grid
includes roughness endpoints and concentrates NoV samples near grazing:
`NoV=0.0001+0.9999*(x/63)^2`, `roughness=0.06+0.94*y/63`. Runtime sampling applies
the inverse coordinate map and texel-center offsets. F0 is the standard mixture
of 0.04 dielectric and base-color metallic reflectance. The specular energy term
is `clamp(F0*A+B, 0, 1)`. Diffuse uses `(1-metallic)*(1-specularEnergy)` as an
energy-bounded split-sum partition. There is no multi-scatter compensation or
hidden specular fill. This approximation preserves the constant white furnace
bound; it is not an exact integral of the direct-light diffuse partition.

The bake follows the BRDF and split-sum concepts described in
[Filament](https://google.github.io/filament/main/filament.html#lighting/imagebasedlights)
and the visible-normal sampling derivation in
[PBRT](https://pbr-book.org/4ed/Reflection_Models/Roughness_Using_Microfacet_Theory).
The emitted metadata records source/baker hashes, payload hashes, conventions,
sample counts and SH values. Regenerate or verify it with:

```sh
node scripts/generate-imported-environment.mjs
node scripts/generate-imported-environment.mjs --check
```

The fixed texture payload is 540640 bytes: two cubes at 262128 bytes each and a
16384-byte DFG lookup. A 176-byte uniform holds the selected SH, mode, intensity
and rotation. Resources are allocated once per imported scene, including when
environment illumination is off; toggles do not allocate. They share the scene's
creation failure/cancellation cleanup and disposal. Decode/upload is bounded and
synchronous with cancellation checks immediately before and after allocation.
There is no runtime integration/bake or per-frame texture upload. Initial creation
and sampling costs have no claimed frame-performance bound.

The generated payload loads only with the optional imported renderer. The runtime
facade and optional glTF loader/estimator do not statically import it. Ship the
complete precompiled package, including its optional ESM chunks and WASM.

## Texture allocation estimate

```ts
import { estimateImportedTextureAllocation } from '@strata-engine/core/gltf';

const estimate = estimateImportedTextureAllocation(asset, {
  maxTextureDimension: 8192,
  maxTextureDimension2D: Math.min(16384, engine.info.maxTextureDimension2D),
});
if (!estimate.fitsBudget) {
  // Choose a lower requested edge, then create the scene with that same edge.
}
```

Both edges must be positive integers up to 16384. The effective edge is their
minimum. The CPU-only estimator shares the renderer's allocation plan: preserve
aspect ratio, floor resized dimensions to at least one pixel, deduplicate by image
and color-space role, and include every RGBA8 mip level. Base/emissive maps are
sRGB; metallic/roughness, normal and AO maps are linear. One image used in both
roles allocates two textures. Sampler differences do not duplicate texture data.
Unreferenced images allocate nothing. The total includes both white fallback
texels (eight bytes) and all 540640 environment bytes, even when unlit/off.

The returned `gpuTextureBytes`, `textureBudgetBytes`, `fitsBudget`, requested and
effective edges and per-texture records let a caller choose a cap without decoding
images or allocating GPU resources. Valid over-budget input returns `fitsBudget:
false`; scene creation rejects it before allocation. The cap is 512 MiB of texture
payload, excluding driver padding, buffers, shadow maps and frame targets. For
example, two distinct 8192-square RGBA8 images with full mips exceed the cap; the
same pair at 4096 fits. Geometry, encoded data, samplers and PBR values still need
the separate scene validation. The estimate is not a whole-process memory limit.

## Validation scope

CPU tests cover hashes and finite half-floats, constant-radiance convolution,
irradiance moments, cube axes, independent incoming-direction quadrature anchors,
roughness-one analytic furnace energy, malformed controls, snapshots, history
resets, disposal and allocation failures. Texture-plan tests include shared
roles, non-square images, device limits and the 8192-to-4096 budget decision.

`npm run test:imported` includes production-WGSL numeric probes for off/intensity,
preset selection, cube orientation, inverse yaw, affine irradiance, material AO,
DFG anchors and single-scatter furnace energy. A deliberately removed-specular
shader must fail the same furnace assertion. Signed spatial RGB fields test
adjacent border-row orientation. Another 196 analytic face/mip/preset witnesses
test all axes, seams, corners, unequal edge weights and fractional LOD; their
expectations contain no CPU copy of the production sampler. Actual shader
mutations that reverse a border row, discard adjacent-face color, or discard mip
interpolation must fail the same controls. Rendered generated meshes check
authored unlit invariance, explicit matte relighting, unchanged source PBR and
metal illumination without a direct light. These are functional controls, not
performance evidence. The launcher saves results outside the repository; any
real-model visual captures must follow the external asset policy as well.
