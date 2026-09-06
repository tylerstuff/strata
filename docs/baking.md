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

Moving characters remain outside the static vertex profile. The separate hybrid path below combines static lightmaps with actor probe lighting and dynamic directional shadows. The bounded local point-light shadow path is described below. A native Strata path tracer remains unimplemented.

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

Sampling blends eight neighboring probes and six signed-axis lobes with squared normal weights. Invalid or visibility-rejected probes contribute nothing; outside the volume or with no visible neighbors, indirect contribution is zero. This is an approximation: coarse directional visibility can miss thin walls or produce changes at visibility boundaries, six lobes cannot reproduce all directional detail, and moving geometry does not occlude or update baked indirect light. Probe lighting is diffuse only, applies albedo/nonmetallic fraction once, and is incompatible with vertex-bake/progressive-GI profiles. Baked specular, dynamic indirect transport and automatic probe placement remain future work. Dynamic directional shadows are supported.

Mixed scenes cache static directional depth separately, copy it into the working depth texture each frame, then draw moving casters. This prevents old silhouettes accumulating. The cache invalidates when the light fit, light direction, presentation or history reset changes. The extra depth texture costs 4/16/64 MiB at 1024/2048/4096, respectively, plus one full-depth GPU copy per frame. Telemetry accounts for both textures; `shadow-static` timestamps cover cache rebuild draws, `shadow` covers moving draws. A pass-time sum excludes the intervening copy, so use total-frame measurements for performance claims. Static-only scenes retain the existing single-depth cache path.

### Offline probe backend

```sh
npm run bake:probes -- --input /external/static-scene.gltf \
  --config /external/probe-grid.json --output /external/new-probes \
  --blender /Applications/Blender.app/Contents/MacOS/Blender
```

The JSON configuration supplies `revision`, scene-space `origin`, `spacing`, `counts`, `samples` and `emissionScale`; `transport` selects `combined` (default) or `indirect`;  an optional `normalization` overrides the source-bound normalization. Use the same normalization and emission scale as the environment bake. The launcher requires a new output directory outside the repository. Only `bake.json` marks a completed bake; failed jobs can leave partial files. The backend writes `probes.json` and records the source hash, normalization, Cycles settings and validity count. Blender is an offline dependency only; no Blender dependency enters runtime bundles.

Cycles bakes emission-only direct and bounced diffuse onto tiny white six-face receivers, excluding sun/sky to avoid counting runtime sources twice. Visibility uses static geometry ray casts; alpha-masked surfaces are treated as opaque in those casts. A proximity/backface heuristic rejects suspect probes, but is not a robust interior-volume classifier. Grid placement and coverage require author review. No scene-derived output is committed or uploaded.

`npm run test:hybrid-baked` checks generated public-package pixels against an independent interpolation/material reference, probe off/blocked/outside controls, revision rejection, resource stability, cached versus fresh moving shadows, and disposal. Offline Cycles and external Bistro validation are separate from this runtime test.

## One shadowed local point light (issue #62)

Imported scenes can opt into one point light. Lit receivers explicitly set `localLighting: true`, or use `combineImportedAssets(environment, actor, { localLighting: true, bakedProbeLighting: true })` for actor materials. The scene supplies:

```ts
const pointLight = {
  id: 'street-lamp', position: [0, 3, 0], color: [1, .55, .2],
  intensity: 3, range: 12, shadowMapSize: 512,
} as const;
await engine.setScene({ renderer: 'imported', asset, pointLight, bakedProbes: indirectVolume });
// The same ID updates position, color, intensity or range; edge changes require scene replacement.
engine.render({ imported: { pointLight: { ...pointLight, intensity: 0 } } });
```

Position/range use final scene units; intensity is linear incident radiance times squared scene-unit distance. Scale intensity by the square of a normalization scale when converting source units. The light uses inverse-square attenuation, a smooth finite-range fade and the existing GGX BRDF. Incident radiance is capped at 64 before fading; this bounded profile is not an unrestricted photometric light. There is no contribution inside the near plane (range × .001). Put surrogate lights outside opaque emitter enclosures. An emissive mesh does not automatically create a point light.

Six 90-degree depth faces use the existing alpha-mask, rigid and skin caster pipelines. A 3×3 filter remaps taps across face edges and applies perspective receiver-plane depth correction. Static depth is cached independently of camera movement and temporal resets, invalidating on light position/range, presentation or cancelled frames. Each animated frame clears and redraws dynamic-only depth; ordinary receivers sample the minimum of static and dynamic depths. Baked lamp layers sample dynamic depth only. The static and working depth arrays cost 12 MiB at 512 or 48 MiB at 1024, plus 432 light-uniform bytes and six 352-byte frame bindings. Disabled scenes retain a 24-byte depth placeholder and 432-byte uniform. `estimateImportedTextureAllocation` accepts `pointShadowMapSize` and includes both depth arrays in the imported texture budget. Directional render targets remain separately accounted.

`point-shadow-static` and `point-shadow` timestamps each span six face passes. The point path has no per-frame static-depth copy; directional mixed shadows still copy depth outside their pass timings. Assess total-frame cadence. Draw/triangle/upload telemetry includes submitted point passes. The cache does not yet cull individual static meshes per light face, so initial builds or moving a light in a large scene can be expensive. This is one point light, not clustered multi-light rendering, area-light shadows or dynamic GI.

A local receiver using probes **must** use `transport: 'indirect'`; omission means the original combined direct-plus-indirect bake. Set the same option in the offline probe config to bake indirect diffuse only. Runtime rejects combined probes, combined static lightmaps, unlit or vertex-baked local receivers, and progressive GI with this light. This prevents double-counting or incorrectly shadowing already baked lamp illumination.

Combined lightmaps alone remain fixed. The separate direct-contribution layer below enables moving shadows on selected baked receivers. The actor demonstration uses a point approximation for one nearby lantern and indirect-only probes from all emissive surfaces; it does not reproduce direct illumination from every street lamp.

`npm run test:point-shadow` validates generated public-package lighting on all six faces and selected seams/corners, fixed receiver shadows, moving cached-versus-fresh equality, off controls and disposal. CPU tests cover projection, admission, allocation and atomic controls. External assets and Cycles results remain local.

Run `node scripts/test-bake-probes.mjs /path/to/blender` separately to verify combined versus indirect-only transport on generated emissive geometry. Both must retain diffuse bounce; the combined bake must also contain the direct emitter contribution.

## Moving shadows on baked receivers

`EXT_strata_lightmap` version 2 adds `pointLight: { texture: { index, texCoord: 1 }, range, light }`. The added RGBM texture contains direct diffuse irradiance/pi from one selected emitter, using the existing lightmap UVs. `light` is the fixed `ImportedPointLightControl` descriptor for its point-shadow approximation. Decoded materials expose `bakedPointLightTexture`, `bakedPointLightRange` and `bakedPointLight`. The layer requires an ordinary static combined lightmap and a matching scene point light. Light position, range, color and intensity changes are rejected until the layer is rebaked/replaced. `imported.bakedShadows: false` disables only the layer's moving occlusion for comparison; it does not turn the lamp off.

The shader reconstructs `combined - min(combined, lampDirect) * (1 - dynamicVisibility)` per RGB channel, then applies albedo/nonmetallic fraction once. Both RGBM textures are decoded before bilinear filtering. Clamping the contribution to the combined bake prevents negative values when independently sampled/filtered bakes disagree. Indirect bounce and other lamps remain unchanged; this is fixed baked indirect lighting, not dynamic GI. Existing static occlusion is not applied a second time. The layer has no mipmaps, retains its bake resolution and participates in the texture budget.

```sh
npm run bake:shadow-layer -- --input /external/lightmapped/scene.gltf \
  --config /external/lamp-layer.json --output /external/new-shadow-layer \
  --blender /path/to/blender
```

The config supplies a `revision`, `light`, scene-normalized `emitterBounds: [min, max]`, `emitterMaterial`, source `normalization: { scale, translation }`, named `receivers`, `samples` (default 128) and `maxEdge` (default 1024). Cycles selects emitter faces by centroid/material, zeroes all other emissions in its temporary import, and bakes DIRECT diffuse only. Geometry, UVs and original textures are referenced unchanged in the new output glTF. The final `bake.json` records source hash, selected face count and per-atlas ranges; only that file marks completion. Temporary import files and partial output remain external if a bake fails.

The local Bistro slice selects one lantern and eleven pavement materials. Its area-emitter direct bake uses a point approximation for moving occlusion, so it does not provide area-light penumbrae or shadows from all street lamps. Supporting another light currently requires a separate scene/profile. Generated GPU tests check preserved residual light, empty dynamic depth, on/off controls, movement/return and fixed-light rejection alongside the existing point-shadow tests.

Run `node scripts/test-bake-shadow-layer.mjs /path/to/blender` for a generated two-receiver Cycles bake that verifies the selected emitter, direct output and unchanged geometry/texture references. Runtime tests also cover decode-before-filter interpolation of the contribution texture.
