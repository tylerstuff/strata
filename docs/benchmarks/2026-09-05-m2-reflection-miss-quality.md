# Bounded reflection miss accumulation experiment

This partial [issue #17](https://github.com/tylerstuff/strata/issues/17) correction reduces stationary reflection noise by treating a completed world-ray miss as a valid black sample. It preserves the 0.8 exponential history weight, ray quotas, spatial reconstruction, and hard world/camera invalidation. It does **not** establish good moving-camera reflection quality or solve quarter-resolution detail loss.

The original code assigned successful misses to the same source category as unavailable work. That category rejected previous history on the miss and made the miss unavailable as history on the next frame. The correction introduces source 5 for a completed bounded-world miss. A blend of valid samples is source 3, while raw metadata retains the fresh hit/miss classification. Exhaustion, absent work, cancellation and failed epoch/depth/normal/roughness/age checks remain rejected. There is no environment light in this prototype: treating a completed miss as black is an explicit finite-domain boundary, including when GI is enabled. This changes completed misses from the old diffuse-probe substitution; untraced/expired samples retain that separate approximation.

## Independent reference and controls

The experiment renders the same 156-triangle mirror-room fixture through the original runtime archived from `7e43e9365c09eb07a55d071fa346d2dddc91ef83` and through the pending patch. It holds the receiver camera and emitter fixed, disables GI, the sun and TAA, and uses the emissive cube `(4, 0.25, 0.08)` as the only light. Both versions use the same frame seeds, 32,768-candidate cap, 16 m trace distance, update interval 1, exposure 1 and 240 submitted frames. Every submission is followed by a queue fence. This is frame-count image-quality evidence, not a throughput or presented-frame-rate measurement.

At 320×180, a frozen 32×18 grid selects 576 pixel centers in the central 96×54 rectangle: X=112+3i and Y=63+3j. All 576 lie on the visible mirror. The reference reconstructs their primary planar intersections independently, integrates the visible emissive-box faces with deterministic midpoint area quadrature, evaluates GGX with separable Smith masking and Schlick Fresnel directly, and tests occlusion using independent oriented-box slabs. It imports no production random sampler, BVH, reflection helper or WGSL. Serialized mirror bounds/materials, zero direct light, GPU accumulation settings and the compiled ray bias/tMin contract are checked. F0 includes the actual `rgba8unorm` material quantization, 217/255.

The reference uses 128×128 samples per visible box face. Comparing 64×64 with 128×128 gave RGB RMSE 0.0010415 at roughness 0.08 and 0.00000975 at roughness 0.35; maximum absolute residuals were 0.01076 and 0.0000502. These are empirical integration-resolution checks, **not certified ground truth bounds**. The reference evaluates pixel centers without pixel-area filtering. Quarter-resolution comparisons intentionally retain the existing coarse reconstruction error.

The captured frames are 1, 8, 32, 65 and every frame from 181 through 240. Metrics below use the last 60 frames. Temporal variance is the mean per-witness, per-RGB-channel linear-radiance population variance. Mean-image RMSE compares the 60-frame mean to the reference. It must not be confused with the quality of any one displayed frame.

## Results

Hardware: local Apple M2, 16 GiB unified memory; headed Chrome 152.0.7977.82. WebGPU reports `vendor=apple`, `architecture=metal-3`, non-fallback adapter, and empty device/description strings. No runtime performance claim follows from this untimed test.

| Roughness | Reflection scale per axis | Temporal variance, original → patched | Reduction | Mean-image RGB RMSE, original → patched |
| --- | --- | --- | --- | --- |
| 0.08 | 1 | 0.059106 → 0.008969 | 84.8% | 0.036600 → 0.034870 |
| 0.08 | 0.25 | 0.021984 → 0.003392 | 84.6% | 0.114637 → 0.113792 |
| 0.35 | 1 | 0.223915 → 0.043555 | 80.5% | 0.107338 → 0.086499 |
| 0.35 | 0.25 | 0.112374 → 0.018705 | 83.4% | 0.081143 → 0.057064 |

This is a genuine mixture test. Respectively, 138, 131, 557 and 553 witnesses saw both an emissive hit and a completed world miss among captured frames. Across all 147,456 paired witness observations, raw source classifications agreed exactly after mapping original source 2 to new source 5, and emissive-hit flags had zero disagreements. The patch changed accumulation, not the underlying observed ray outcomes. No traversal exhaustion was reported in the witnesses.

The correction visibly reduces isolated bright speckles in the roughness-0.35 image, but substantial grain remains. Its frame-240 full-resolution RMSE fell from 0.51327 to 0.22879; the corrected frame still has maximum channel error 1.61 against the finite-domain reference. A fixed 0.8 exponential history has only about nine effective independent samples at stationarity. Waiting for 240 submissions does not turn it into a 240-sample average.

The roughness-0.08 quarter-resolution mean-image error barely changes, despite the lower temporal variance. Inspection still shows a coarse, irregular reflected silhouette. The small mean-error change is also comparable to the reference's integration residual. Lower noise therefore does not establish correct reconstruction or close #17. Static-camera measurements do not cover camera motion, moving-object invalidation, diffuse-cache resets or broad TAA resets; those require separate evidence.

## Reproduction and retained evidence

Run from the repository with installed development dependencies:

```sh
node --test scripts/reflection-image-reference.test.mjs
STRATA_TEST_BROWSER_CHANNEL=chrome STRATA_TEST_HEADED=1 node scripts/test-reflection-image.mjs
```

The runner archives the baseline source, bundles the identical capture harness separately against both versions, and stores bundle hashes, experiment-source hashes, current tracked diff, raw linear witness frames, scene/camera inputs, quadrature data and PNG captures externally. It applies no quality-improvement threshold tuned after observing results. It fails missing hit/miss mixtures, changed source outcomes, invalid reference resolution, GPU errors and tracked resource leaks. Sampled-grid PNGs enlarge sparse witnesses; they are not dense reference renders.

Local image evidence directory:
`~/Downloads/Strata-Benchmark-Results/2026-09-05T04-47-12.265Z-reflection-image-oracle/`.

This recorded the dirty candidate based on the baseline commit; its tracked-diff SHA-256 was `f4b6906f61ac8311e3fba293800d97f35fce67892ae146b31cbe1b3c4945bbb8`. Original/candidate browser-bundle SHA-256 values are `cc34deeac834707109f1ad1f9faadb59c73821ed79e9431cd74183a6bb1fdbb1` and `5f07f55ed1f9daafaeefde5feba40e2f67a10154ea3c7fcc5d6f91ed309b8b97`. The subsequent `sampling-agreement-audit.json` checks the saved immutable frame files and hashes them; this same comparison is now automated in the runner. That bookkeeping addition did not change the captured runtime or image reference.

Production functional validation also passed on hardware and SwiftShader: reports `2026-09-05T04-37-04.450Z-reflection-validation` and `2026-09-05T04-37-31.477Z-reflection-validation`. Each includes the existing 18 scene/lifecycle cases and 384 GGX direction/weight cases, plus the new production-WGSL 240-frame alternating hit/miss test, nine direct accumulation cases and 16 history-qualification cases. CPU coverage includes 17 reflection-cache tests and four independent image-reference tests. Those functional checks do not replace the image-error measurements.

The estimator remains the [Heitz visible-normal GGX sampler](https://jcgt.org/published/0007/04/01/). This change does not add a spatial denoiser, multiple bounces, screen-space tracing or native hardware ray tracing.
