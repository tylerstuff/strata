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

Moving characters remain outside the static vertex profile. The separate hybrid path below combines static lightmaps with actor probe lighting and dynamic directional shadows. Local-light shadows and a native Strata path tracer remain unimplemented.

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

Lightmaps are enabled by the asset; leave `bakedVertexLighting` null. The renderer decodes each of four RGBM texels **before** bilinear interpolation, then applies material albedo and the nonmetallic fraction once. It does not apply AO twice or combine a vertex bake/progressive GI with the lightmap. Lightmap receivers must remain static; moving characters use the separate probe path below.

Atlases retain their authored resolution independently of the ordinary texture cap, have one mip level, and count toward the shared 512 MiB texture budget. An individual 4096-square RGBM atlas costs 64 MiB; an 8192-square atlas costs 256 MiB. The baker treats `--edge` as an aggregate texel budget: it distributes approximately edge-squared texels among power-of-two material atlases, with a 128-square minimum per used material. The manifest records actual atlas bytes. An atlas larger than the device limit is rejected instead of silently blurred. This initial profile has no directional lightmaps, baked specular, automatic streaming, or distant-lightmap mip filtering. Dense scenes may still need spatial splitting and manual UV authoring; automatic material atlases do not guarantee adequate texel density.

The baker explicitly restores the secondary UV selection after material separation, verifies original UVs are unchanged, and checks atlas coverage and finite, bounded UVs and refuses empty/nonfinite results before publishing the manifest. Runtime tests cover separate UVs, HDR colors, decode-before-filter interpolation, memory accounting, missing UVs, and rejection of animated receivers. All scene-specific models, textures, bake checkpoints and comparisons remain outside the repository.

Run `node scripts/test-bake-imported.mjs /path/to/blender lightmap` for the generated multi-material texel-bake regression.

The OIDN adapter uses the official [RTLightmap filter](https://github.com/RenderKit/oidn#rtlightmap) through its CLI, avoiding conflicts with Blender's bundled native libraries. It preflights the filter before the expensive bake and bounds each filtering subprocess to ten minutes.

## Baked lighting on moving actors (issue #62)

Core now supports one immutable imported environment and one independently animated or rigid actor in the same imported renderer. `combineImportedAssets(environment, actor, { bakedProbeLighting: true })` borrows their payloads and remaps actor material/texture indices. The environment must have no deformation or animation; the actor must come from animated `loadGltf` or `createMeshAsset`, with deformation on every primitive. This is a bounded composition helper, not arbitrary scene authoring or multiple independently controlled rigs.

```ts
const navigation = { bounds: environment.bounds, normalization: environment.normalization };
const mixed = combineImportedAssets(environment, actor, { bakedProbeLighting: true });
await engine.setScene({ renderer: 'imported', asset: mixed, bakedProbes: volume });
engine.render({ imported: {
  placement: actorWorldMatrix,
  animation: { clipId: walkClipId, timeSeconds: time, loop: true },
  bakedProbes: { revision: volume.revision, enabled: true },
} });
```

Static vertices stay in final scene coordinates. The composed asset's normalization applies only to actor deformation; retain the environment navigation metadata before composition. `placement` is a column-major affine matrix applied after actor animation and normalization. Omission means identity. Existing rigid-root `transforms` can also address the actor, subject to their existing skin/clip restrictions. Topology stays fixed and current/previous deformation palettes remain allocated. Rejecting a malformed placement or stale probe revision leaves the last accepted controls intact. Probe toggles invalidate temporal history; omission retains the current toggle.

Static lightmaps illuminate the environment, while explicitly opted-in actor materials sample a scene-space probe grid. The version-1 `BakedProbeVolume` contains `origin`, positive `spacing`, integer `counts`, a caller-assigned `revision`, probe-major `irradiance` (+X, -X, +Y, -Y, +Z, -Z RGB, linear irradiance/pi), `visibility` (16×16 octahedral first-hit distances per probe), and a binary `valid` mask. X varies fastest. Each axis has 2–64 probes and the volume has at most 4096 probes. Coordinates stay within ±1024; irradiance is bounded to 65536 and visibility distances to 8192. The packed GPU payload costs 1120 bytes per probe plus a 64-byte uniform; imported scenes without probes retain a 1120-byte dummy binding and that uniform. Data is validated and copied on scene creation. Replacing the volume requires a scene replacement; per-frame controls select only its revision and enable state.

Sampling blends eight neighboring probes and six signed-axis lobes with squared normal weights. Invalid or visibility-rejected probes contribute nothing; outside the volume or with no visible neighbors, indirect contribution is zero. This is an approximation: coarse directional visibility can miss thin walls or produce changes at visibility boundaries, six lobes cannot reproduce all directional detail, and moving geometry does not occlude or update baked indirect light. Probe lighting is diffuse only, applies albedo/nonmetallic fraction once, and is incompatible with vertex-bake/progressive-GI profiles. Local lamp shadow maps, baked specular, dynamic indirect transport and automatic probe placement remain future work. Dynamic directional shadows are supported.

Mixed scenes cache static directional depth separately, copy it into the working depth texture each frame, then draw moving casters. This prevents old silhouettes accumulating. The cache invalidates when the light fit, light direction, presentation or history reset changes. The extra depth texture costs 4/16/64 MiB at 1024/2048/4096, respectively, plus one full-depth GPU copy per frame. Telemetry accounts for both textures; `shadow-static` timestamps cover cache rebuild draws, `shadow` covers moving draws. A pass-time sum excludes the intervening copy, so use total-frame measurements for performance claims. Static-only scenes retain the existing single-depth cache path.

### Offline probe backend

```sh
npm run bake:probes -- --input /external/static-scene.gltf \
  --config /external/probe-grid.json --output /external/new-probes \
  --blender /Applications/Blender.app/Contents/MacOS/Blender
```

The JSON configuration supplies `revision`, scene-space `origin`, `spacing`, `counts`, `samples` and `emissionScale`; an optional `normalization` overrides the source-bound normalization. Use the same normalization and emission scale as the environment bake. The launcher requires a new output directory outside the repository. Only `bake.json` marks a completed bake; failed jobs can leave partial files. The backend writes `probes.json` and records the source hash, normalization, Cycles settings and validity count. Blender is an offline dependency only; no Blender dependency enters runtime bundles.

Cycles bakes emission-only direct and bounced diffuse onto tiny white six-face receivers, excluding sun/sky to avoid counting runtime sources twice. Visibility uses static geometry ray casts; alpha-masked surfaces are treated as opaque in those casts. A proximity/backface heuristic rejects suspect probes, but is not a robust interior-volume classifier. Grid placement and coverage require author review. No scene-derived output is committed or uploaded.

`npm run test:hybrid-baked` checks generated public-package pixels against an independent interpolation/material reference, probe off/blocked/outside controls, revision rejection, resource stability, cached versus fresh moving shadows, and disposal. Offline Cycles and external Bistro validation are separate from this runtime test.
