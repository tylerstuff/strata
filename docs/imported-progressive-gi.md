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

The first actual-house interior capture on 2026-09-05 did not pass visual
acceptance: sky-only and directional-only views remained almost black at 64
samples per pixel despite zero invalid/exhausted paths or GPU errors. A separately
recorded asset-request event failure also leaves that run's report failed. The
original report and captures are retained externally; source/material, visibility
and sampling diagnostics are in progress in issue #15. Completed sample counters
and passing generated fixtures do not clear this gallery promotion hold.

`ImportedIndirectEffect` implements the existing `RasterGiProvider`. Root integration owns CPU preparation, material handles, controls and activation. It must disable raster TAA to provide an unjittered camera, zero ordinary ambient fill and exclude diffuse SH IBL while this effect is active. Interior correctness comparisons also keep specular IBL off. Both the GI-on and matched GI-off references need the same direct baseline. These exclusions prevent double counting or unoccluded fill from appearing through walls.

`prepare()` and `compose()` encode work; the owner must call `submitted()` only after successful queue submission, or `cancelFrame()` on failure. Camera, resolution, lighting, environment and option changes reset accumulation. Enabling after a pause also resets it. A failed frame forces a reset before reuse. Composing adds only accumulated indirect radiance to the current direct HDR, preserving direct-light and texture detail.

The first preview uses full-resolution per-pixel accumulation with bounded batches; it does not upsample lighting across surface boundaries. Defaults are 262,144 pixels, 4,096 scheduled pixel updates per frame, 64 samples per pixel and 4,096 node visits per query. These are workload bounds, not timing guarantees. The integration can explicitly choose a 640×360 or 320×180 preview. It must preflight `maxPixels` before activation; an oversized resize rejects before changing resources. CPU progress describes submitted scheduling, while GPU readback reports attempted, completed, exhausted and invalid samples. Frame count is not a convergence measurement.

The shader-free `imported-indirect-options` module exports `normalizeImportedIndirectOptions()` and `validateImportedIndirectSize(device.limits, width, height, normalizedOptions)`. Call these before CPU preparation or material allocation. The effect's `validateSize()` delegates to the same check, so activation and later resizes share one set of limits.

Each pixel's accumulator occupies 32 bytes, the composed HDR target 8 bytes, and uniforms/counters 304 bytes, in addition to exact source/BVH GPU buffers and an optional readback buffer. Borrowed material textures are accounted by their owner. Allocation telemetry excludes driver and browser overhead.

## Validation boundary

Generated validation covers original source IDs and barycentrics, small triangles and grazing rays, visibility budgets, an offscreen colored rectangle with an independent form-factor reference, blocked openings and secondary-light occlusion, visible versus bounced environment, emission/color-space interpretation, and effect lifecycle. Explicit-point shader fixtures are distinguished from tests with valid camera matrices. Deterministic sampled-ray agreement is reported separately from a distribution's analytic mean; a fixed hash sequence is not assumed to be IID.

Actual-house acceptance needs a fixed interior camera, verified source/texture identities, zero unexplained invalid or exhausted paths and a clear blocked/offscreen transport witness. Those assets, BVHs and captures remain external. Generated tests and a small reference scene do not establish gallery-wide quality, 60 FPS or superiority over another renderer.

## Optional spatial reconstruction experiment

A scene can explicitly retain geometric guides for a bounded presentation filter:

```ts
engine.resize(320, 180);
await engine.setScene({
  renderer: 'imported', asset,
  indirect: { maxSamples: 64, spatialDenoise: true },
});
engine.render({ imported: { indirect: { enabled: true, denoise: 'spatial' } } });
await engine.waitForIdle();
// Retain the same samples and guides for an unfiltered comparison.
engine.render({ imported: { indirect: { enabled: true, denoise: 'off' } } });
```

`spatialDenoise` is a creation capability, separately normalized from numeric trace
limits. It requires seven storage bindings and imposes a 65,536-pixel lifetime
viewport cap, including when filtering is off. Admission checks precede source
preparation and repeat at resize and final asynchronous commitment. There is no
implicit fallback. Without this capability, the original six-binding shader,
resource layout and tracing limits remain in use. Requesting `spatial` without it
rejects before geometry or lighting changes.

`denoise` initially defaults to `off` and persists when omitted. Providing indirect
controls still requires `enabled`. Changing only this filter does not reset or
retrace transport or upload source geometry. Ordinary submitted-frame and batch
cursor advancement continues, including at the sample cap. Pausing/re-enabling
indirect lighting retains its existing reset behavior.

The optional buffer contains a 16-byte diagnostic header and 32 bytes per pixel:
exact primary diffuse reflectance, the BVH triangle index and normal orientation,
exact primary point and a local world-space pixel footprint. This adds 1,843,216
bytes at 320×180, or 2,097,168 bytes at the capability cap. Guides are populated
alongside the original validated primary hit, before secondary tracing, without
another random sample or ray. A guide failure bypasses reconstruction without
changing raw sample status. Records clear with accumulation; the diagnostic header
clears each composition. The original 32-byte estimator records and 16-byte sample
counter buffer remain unchanged. Diagnostic staging adds 16 bytes while mapped.

Composition performs one 5×5 positive binomial gather of indirect illumination,
then remodulates the exact center reflectance. It does not average direct HDR,
authored color texture, shadow alpha or final shaded color. The recovered quantity
is `(sum / samples) / rho`, or irradiance divided by pi; no additional pi is used.
Zero-reflectance donor channels provide no incident information and are omitted;
a zero-reflectance center stays zero. Completed black estimates retain denominator
weight. A completed zero center can reconstruct illumination from compatible
neighbors while its raw state remains zero. Background, untraced, invalid and
exhausted centers remain direct-only.

Donors must have compatible geometric normals and material IDs, symmetric tangent
plane distance within the declared footprint/coordinate allowance, and bounded
world distance for their screen separation. The kernel is the outer product of
`[1, 4, 6, 4, 1]`. Normal agreement must be at least 0.95; its power-32 weight is
clamped to [0.125, 1]. Both point-to-plane distances must fit
`0.05 * min(footprints) + 8 * 2^-23 * (maxAbs(P) + maxAbs(Q) + extent(A) + extent(B))`.
World separation must not exceed `(screenDistance + 1.5) * max(footprints)`. Footprints intersect actual adjacent
inverse-projection near/far rays with the primary tangent plane, including for
orthographic cameras. They reject grazing or out-of-domain solves. Triangle IDs
need not match, so triangulation edges are not intentionally preserved. Material
agreement is currently vacuous because admission permits one used material.
The additional guide helpers bound matrix components to 2^20, homogeneous ray
components to 2^24, absolute ray homogeneous w to at least 2^-20, dehomogenized
points to 2^20 and footprints to [2^-40, 2^20]. A ray with absolute tangent-plane
cosine below 0.1 is rejected. These are conservative admission bounds for the
optional guide computation, not added restrictions on raw transport.
These guards are heuristic: thin surfaces inside their tolerance and lighting
boundaries on one plane can still mix. This filter is biased reconstruction and
cannot infer illumination absent from all nearby samples.

The capability uses a conservative composed HDR domain of 0..65472, including
filter-off mode. Raw mean and direct-plus-raw composition are proved safe before
filtering; newly introduced positive demodulation and weighted arithmetic have
explicit lower/upper bounds before operations. Tiny positive reflectance below
2^-16 falls back to the raw channel, without clamping albedo. An unsafe eligible
donor causes whole-channel raw fallback, rather than omitting its potentially
bright contribution. Signed zero stays zero. Filter-only arithmetic failures use
the already-proved raw result. This contract covers new reconstruction arithmetic
within its explicit input domain; it cannot recover arbitrary upstream
indeterminate shader arithmetic. The optional storage view reads sums and rho as
integer words without changing their byte layout, so positive subnormal values
cannot silently become completed zero before classification. For samples 1..1024,
a positive raw sum must satisfy `samples * 2^-126 <= sum <= samples * 65504`
before division. A positive donor additionally requires
`sum >= samples * rho * 2^-90` before demodulation. Incident illumination stays
below 2^32, the total kernel weight at most 256 and weighted sums below 2^40.
Raw composition must satisfy `rawMean <= 65472 - direct` before addition;
remodulation must satisfy `candidateI <= (65472 - direct) / centerRho` before
multiplication. Filter fallback counters count at most once per channel and
composition, even with multiple unsafe donors.

If raw composition itself cannot fit that domain, the pixel displays a diagnostic
marker and `waitForIdle()` rejects with `PRESENTATION_HDR_FAULT`. Raw samples and
sample counters are unchanged, and this is not reported as device loss. Following
a valid new scene, reset or control submission, a stale diagnostic cannot poison
the new frame. `sampleCounters.spatialDiagnostics` contains four per-composition
counts: `filteredPixels`, `fallbackChannels`, `hdrFaultChannels` and
`guideBypassPixels`. Filtered pixels count centers with at least one channel
entering the gather, including a later fallback; guide bypass counts spatial-mode
centers whose guide is invalid. The readback carries its actual submitted frame ID, accumulation
revision, denoiser mode and presentation revision. Telemetry publishes it only
when those tags match the current submitted presentation. Runtime presentation
control edits do not relabel an older GPU header.

This is an experimental option with an actual-house visual acceptance hold. It
has no real-time performance, general denoising quality or convergence claim.
The sampler, source, material and light definitions remain unchanged so its effect
can be judged independently.
