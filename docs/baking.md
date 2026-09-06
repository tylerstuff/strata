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

The default vertex profile is a low-frequency bake: detail is limited by vertex density, sharp lighting boundaries can smear across triangles, and 16/32-sample bakes can retain noise. Tracing texture sampling is capped at 512; export reloads original texture resolution. No irradiance clamp is deliberately applied; the manifest restores the maximum linear value after glTF color normalization. Fixed baked lighting cannot respond correctly when a lamp or wall moves. Emission-scale overrides alter authored light power and are recorded explicitly.

Moving characters must remain outside this static profile. Their transforms, animation and dynamic directional shadows continue to use the ordinary renderer, but receiving this bake through directional irradiance probes, mixed static/dynamic scene composition, local-light shadows and a native Strata baking backend are not implemented here. These are required next steps for general hybrid lighting; a static Bistro bake does not establish them.

Issue #61 tracks the initial implementation; #62 tracks hybrid character/probe lighting. `npm run test:imported-baked` checks public-package pixels against an independent diffuse reference, including zero intensity and changes without material tinting. The full check includes this GPU test; running the offline Cycles baker is separate from runtime CI. Run `node scripts/test-bake-imported.mjs /path/to/blender` for the generated three-material backend regression. Blender 5.2.0 LTS is the tested backend. Its shared vertex-color export bug is handled by a narrowly scoped in-process exporter hook; no installed Blender files are modified. The local `bake-checkpoint.blend` retains computed colors for export debugging without retracing.

## Texel lightmaps (issue #64)

For architectural receivers, select `--profile lightmap --edge 8192 --denoiser /path/to/oidnDenoise` with the same launcher. Open Image Denoise is an optional offline authoring dependency; its dedicated RTLightmap filter cleans the linear HDR lighting before RGBM encoding. `--denoiser auto` finds the executable on PATH; the default `none` produces raw diagnostic lighting that can be visibly noisy. The selected filter is recorded in the manifest. This writes a separate RGBM PNG containing emission-only diffuse irradiance/pi and secondary UV atlases allocated by material surface area. The ordinary albedo, normal, metallic/roughness, AO and emissive maps keep their original UVs and source files. Cycles remains the offline backend; it selects Metal when available, otherwise CPU. This profile uses source textures up to 1024 during tracing.

`loadGltf` recognizes the required, Strata-specific material extension:

```json
"EXT_strata_lightmap": {
  "version": 1, "encoding": "rgbm", "range": 256,
  "texture": { "index": 406, "texCoord": 1 }
}
```

The index refers to the glTF texture array. Its sampler must use clamp-to-edge and linear min/mag filtering without mipmaps. `TEXCOORD_1` is required on every receiving primitive. The loader retains it as `ImportedPrimitive.lightmapUvs`, independently of the 64-byte CPU vertex format. The renderer uploads a 72-byte vertex format that includes the secondary UVs. Imported GPU geometry has a 384 MiB aggregate ceiling (including the added UVs); each buffer must also fit the device limit. Atlas seams can increase the exported vertex count. Material properties are `lightmapTexture` and a positive `lightmapRange` up to 65536. The texture cannot alias another material texture role.

Lightmaps are enabled by the asset; leave `bakedVertexLighting` null. The renderer decodes each of four RGBM texels **before** bilinear interpolation, then applies material albedo and the nonmetallic fraction once. It does not apply AO twice or combine a vertex bake/progressive GI with the lightmap. Static receivers are required; this does not add probe lighting to moving characters.

Atlases retain their authored resolution independently of the ordinary texture cap, have one mip level, and count toward the shared 512 MiB texture budget. An individual 4096-square RGBM atlas costs 64 MiB; an 8192-square atlas costs 256 MiB. The baker treats `--edge` as an aggregate texel budget: it distributes approximately edge-squared texels among power-of-two material atlases, with a 128-square minimum per used material. The manifest records actual atlas bytes. An atlas larger than the device limit is rejected instead of silently blurred. This initial profile has no directional lightmaps, baked specular, automatic streaming, or distant-lightmap mip filtering. Dense scenes may still need spatial splitting and manual UV authoring; automatic material atlases do not guarantee adequate texel density.

The baker explicitly restores the secondary UV selection after material separation, verifies original UVs are unchanged, and checks atlas coverage and finite, bounded UVs and refuses empty/nonfinite results before publishing the manifest. Runtime tests cover separate UVs, HDR colors, decode-before-filter interpolation, memory accounting, missing UVs, and rejection of animated receivers. All scene-specific models, textures, bake checkpoints and comparisons remain outside the repository.

Run `node scripts/test-bake-imported.mjs /path/to/blender lightmap` for the generated multi-material texel-bake regression.

The OIDN adapter uses the official [RTLightmap filter](https://github.com/RenderKit/oidn#rtlightmap) through its CLI, avoiding conflicts with Blender's bundled native libraries. It preflights the filter before the expensive bake and bounds each filtering subprocess to ten minutes.
