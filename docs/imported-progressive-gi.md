# Static imported progressive diffuse lighting

This internal effect is tracked in [issue #15](https://github.com/tylerstuff/strata/issues/15). It is a bounded progressive preview for static imported geometry, separate from the room probe experiment. Integration must prepare and validate the complete imported static BVH before creating the effect. It is not a real-time GI or virtual-geometry implementation.

## Source and material contract

The supported source has exactly one used, lit, OPAQUE material and no rig, animation, deformation or ground. Unused material entries do not participate. The validated BVH retains every source triangle and its original corner order. Its packed triangle ID is distinct from `sourceTriangleId`, which addresses the original global index triplet and indexed 64-byte vertex attributes.

The effect owns uploaded BVH, source-index and source-vertex buffers. Material texture views and samplers are borrowed and must outlive it. Base color and emissive views use the imported renderer's sRGB decoding; metallic/roughness is linear. Barycentric interpolation preserves UV0 and linear vertex colors. Base color factors, metallic factor, emissive factor and emissive strength retain their source meaning. Primary emission remains in the current raster HDR; a traced secondary surface's emission contributes to its outgoing radiance.

Indirect transport uses triangle geometric normals for both shading and origin offsets. Normal maps still affect direct raster shading, but do not perturb the indirect BSDF. This is an explicit approximation for assets such as the house. The initial compute texture policy is authored sampling at LOD zero; it has no derivative-based texture-footprint or ray-cone estimate. The diffuse model is Lambertian `baseColor * (1 - metallic)`, without the raster microfacet model's angle-dependent Fresnel partition. Specular bounces and additional diffuse surface bounces are absent.

## Estimator and visibility

An unjittered camera ray identifies the exact visible receiver and its geometric normal. Its projected depth must agree with the current raster depth before transport is accepted. A cosine-weighted ray then either reaches the environment or the nearest opaque secondary surface. A secondary surface returns its emission plus Lambertian reflection of a visibility-tested directional light and a separate cosine-weighted environment visibility query. A further surface blocks that environment query; it does not become another bounce.

The incident studio/sky radiance follows `radiance()` in the environment baker at commit `4942f50`, including its yaw convention and intensity. It uses the unfiltered analytic source, not the SH irradiance or filtered specular cube. A constant-radiance mode exists only for internal generated tests.

All visibility queries use the complete BVH, including offscreen geometry. Each sample uses at most four queries: primary, secondary, secondary directional visibility, and secondary environment visibility. Traversal has an explicit node-visit quota, a bounded stack and distinct hit, miss, exhausted and invalid results. Exhaustion is never open sky. Any unknown path marks the pixel's estimate unknown until reset and displays direct-only lighting; the effect does not discard expensive paths and normalize only the cheaper completed samples. Diagnostic counters report this limitation.

Origin offsets depend on original positions, triangle extent and representable float32 steps along the oriented geometric normal. They avoid a fixed scene-unit bias, but are a practical floating-point allowance rather than a certified exact-intersection guarantee.

## Integration and lifecycle

The engine integration is explicitly selected at scene creation:

```ts
engine.resize(640, 360); // 230,400 physical pixels, within the default budget.
await engine.setScene({ renderer: 'imported', asset, indirect: {} });
engine.render({ imported: { lighting, indirect: { enabled: true } } });
await engine.waitForIdle();
const state = engine.getTelemetry().imported?.indirect;
// Compare the same direct baseline without the accumulated indirect contribution.
engine.render({ imported: { indirect: { enabled: false } } });
```

`indirect` accepts the effect's bounded `maxPixels`, `pixelBatch`, `maxSamples`,
`maxVisits` and `seed` options. Admission checks the physical viewport before CPU
preparation or material allocation, then checks it again before commitment in case
the host resized during loading. Oversized later resizes reject before changing
the canvas. The engine serializes imported creation and awaits worker cleanup even
for a direct-only replacement after cancelled tracing. Memory preflight includes
the previous imported scene's retained source buffers and the acknowledged WASM
high-water mark. Prepared tracing arrays are released after upload; browser GC and
driver residency are outside the payload estimate.

The progressive scene always excludes raster ambient/environment terms and TAA,
including while `indirect.enabled` is false. The requested environment remains the
incident source for visibility-tested transport. Telemetry records those exclusions,
the submitted accumulation revision and the preparation estimates. `waitForIdle`
also collects revision-tagged sample counters; simultaneous calls share the pending
readback. Counters from an older revision are never published as current. A ground
presentation is rejected because it is absent from the tracing source. Recreate the
scene without `indirect` to return to the ordinary imported rendering path.

The generated public-engine path is checked by `npm run test:imported-progressive`
(also included in `npm run test:imported-indirect` and `npm run check`). It exercises
actual HTTP-loaded worker/WASM and optional shader chunks, perspective receiver
agreement, sky convergence against an independent integral, baseline/emission
exclusions, viewport admission, cancellation/replacement and disposal. These checks
passed both hardware and software adapters. The static-house preparation and
generated fixtures do not establish correct rendered house transport; a fixed
interior witness remains a separate acceptance check before gallery promotion.

`ImportedIndirectEffect` implements the existing `RasterGiProvider`. Root integration owns CPU preparation, material handles, controls and activation. It must disable raster TAA to provide an unjittered camera, zero ordinary ambient fill and exclude diffuse SH IBL while this effect is active. Interior correctness comparisons also keep specular IBL off. Both the GI-on and matched GI-off references need the same direct baseline. These exclusions prevent double counting or unoccluded fill from appearing through walls.

`prepare()` and `compose()` encode work; the owner must call `submitted()` only after successful queue submission, or `cancelFrame()` on failure. Camera, resolution, lighting, environment and option changes reset accumulation. Enabling after a pause also resets it. A failed frame forces a reset before reuse. Composing adds only accumulated indirect radiance to the current direct HDR, preserving direct-light and texture detail.

The first preview uses full-resolution per-pixel accumulation with bounded batches; it does not upsample lighting across surface boundaries. Defaults are 262,144 pixels, 4,096 scheduled pixel updates per frame, 64 samples per pixel and 4,096 node visits per query. These are workload bounds, not timing guarantees. The integration can explicitly choose a 640×360 or 320×180 preview. It must preflight `maxPixels` before activation; an oversized resize rejects before changing resources. CPU progress describes submitted scheduling, while GPU readback reports attempted, completed, exhausted and invalid samples. Frame count is not a convergence measurement.

The shader-free `imported-indirect-options` module exports `normalizeImportedIndirectOptions()` and `validateImportedIndirectSize(device.limits, width, height, normalizedOptions)`. Call these before CPU preparation or material allocation. The effect's `validateSize()` delegates to the same check, so activation and later resizes share one set of limits.

Each pixel's accumulator occupies 32 bytes, the composed HDR target 8 bytes, and uniforms/counters 304 bytes, in addition to exact source/BVH GPU buffers and an optional readback buffer. Borrowed material textures are accounted by their owner. Allocation telemetry excludes driver and browser overhead.

## Validation boundary

Generated validation covers original source IDs and barycentrics, small triangles and grazing rays, visibility budgets, an offscreen colored rectangle with an independent form-factor reference, blocked openings and secondary-light occlusion, visible versus bounced environment, emission/color-space interpretation, and effect lifecycle. Explicit-point shader fixtures are distinguished from tests with valid camera matrices. Deterministic sampled-ray agreement is reported separately from a distribution's analytic mean; a fixed hash sequence is not assumed to be IID.

Actual-house acceptance needs a fixed interior camera, verified source/texture identities, zero unexplained invalid or exhausted paths and a clear blocked/offscreen transport witness. Those assets, BVHs and captures remain external. Generated tests and a small reference scene do not establish gallery-wide quality, 60 FPS or superiority over another renderer.
