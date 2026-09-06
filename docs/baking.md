# Static diffuse baking

Strata has an initial optional offline bake workflow and an explicit Core rendering profile for its output. The first backend is Blender Cycles, invoked by Strata tooling; it is not a Strata path tracer. Blender/Python are offline authoring dependencies only. Browser applications consume the resulting ordinary imported asset and baked-lighting controls with no baker dependency.

```sh
npm run bake:imported -- --input /external/scene.gltf \
  --output /external/new-bake --blender /Applications/Blender.app/Contents/MacOS/Blender \
  --samples 32 --emission-scale 1
```

The output directory must be new and outside this repository. Failed jobs can leave partial output; only a completed `bake.json` marks success. The input must be static glTF JSON with unique named materials, external image files, and no skins, animations or vertex albedo. The baker joins static receivers while preserving their material slots. The generated `scene.gltf` references the original material textures and stores normalized linear diffuse irradiance divided by pi in vertex RGB. `bake.json` records the restoring intensity, source identity, backend, samples and emission scale. Alpha remains material-driven. Baked direct emission transport and up to four diffuse bounces include Cycles visibility. The bake excludes sun and sky so applications can retain separate runtime directional/environment lighting without counting those sources twice.

Load the output through `loadGltf` and render it with:

```ts
engine.render({ imported: {
  presentation: 'model-only',
  bakedVertexLighting: { intensity: bake.intensity },
} });
```

Set intensity to zero for a comparison with the same materials but no baked contribution. `null` restores ordinary vertex-albedo interpretation; omit the property to retain the current setting. Do not use `null` as an off toggle on baked data. Core multiplies baked diffuse irradiance by base color and the nonmetallic fraction once, without adding material AO a second time. Normal-mapped sun/specular shading remains independent. This slice accepts immutable geometry only and rejects progressive GI combined with this profile. It uses the existing vertex buffer and a few uniform fields, with no per-frame rays or additional bake texture allocation.

This is a low-frequency vertex bake, not a lightmap system: detail is limited by vertex density, sharp lighting boundaries can smear across triangles, and 16/32-sample bakes can retain noise. Tracing texture sampling is capped at 512; export reloads original texture resolution. No irradiance clamp is deliberately applied; the manifest restores the maximum linear value after glTF color normalization. Fixed baked lighting cannot respond correctly when a lamp or wall moves. Emission-scale overrides alter authored light power and are recorded explicitly.

Moving characters must remain outside this static profile. Their transforms, animation and dynamic directional shadows continue to use the ordinary renderer, but receiving this bake through directional irradiance probes, mixed static/dynamic scene composition, local-light shadows, lightmap atlases and a native Strata baking backend are not implemented here. These are required next steps for general hybrid lighting; a static Bistro bake does not establish them.

Issue #61 tracks the initial implementation; #62 tracks hybrid character/probe lighting. `npm run test:imported-baked` checks public-package pixels against an independent diffuse reference, including zero intensity and changes without material tinting. The full check includes this GPU test; running the offline Cycles baker is separate from runtime CI. Run `node scripts/test-bake-imported.mjs /path/to/blender` for the generated three-material backend regression. Blender 5.2.0 LTS is the tested backend. Its shared vertex-color export bug is handled by a narrowly scoped in-process exporter hook; no installed Blender files are modified. The local `bake-checkpoint.blend` retains computed colors for export debugging without retracing.
