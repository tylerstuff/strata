# Reflection motion reference preparation

This CPU-only harness preparation implements the reference/mask/schedule portion of the [issue #17 next-slice proposal](https://github.com/tylerstuff/strata/issues/17#issuecomment-5553583661). It adds no renderer candidate, browser integration or performance evidence. The historical [still-image comparison](benchmarks/2026-09-05-m2-reflection-miss-quality.md) remains unchanged; its results do not establish moving-scene quality.

`scripts/reflection-motion-reference.mjs` imports the existing independent emitter-face area quadrature and analytic box intersections. Neither reference module imports engine sampling, traversal or shader code. The old oracle accepts an optional explicit pixel corpus and viewport; omitted arguments retain the original 576 witnesses and 320×180 pixel-center calculation.

## Frozen preparation contract

Version 1 uses 320×180 physical pixels, 240 submissions and roughness .08/.35. Each profile is intended to run at quarter, half and full resolution with the same 256-candidate cap. That cap exercises incomplete coverage at higher scales; it is not an equal-executed-ray or equal-time assertion. GI, sun and TAA are disabled. Reflection mode is world, max distance 16 m, update interval 1, with an explicit history reset only on submission 1. Existing automatic world/camera invalidation remains enabled.

| Profile | Expected source/camera schedule |
| --- | --- |
| Still | Pristine emitter and fixed camera for all 240 submissions. |
| Camera→hold | Hold the initial camera through 60; translate eye and target together along world Z from 0 to 0.2 m over 61–120; hold through 240. |
| Object→hold | Fixed receiver camera; emitter offset −0.4 m through 60, linear motion to +0.4 m over 61–120, then hold through 240. |
| Thin phase 0/1/2/3 | Fixed camera and a narrowed emitter box. Its virtual center shifts by 0/1/2/3 full-resolution pixels, exercising all four quarter-grid phases. Each phase is a separate 240-submission profile. |

Thin width is 1.5 pixels at the projected virtual center's depth, obtained by changing the emitter's Z half-size. Perspective corners can have different widths/shifts. The camera must have the receiver orientation, with image Y and view depth invariant under Z translation. This is a procedural box, not an imported asset.

Every submission has an explicit expected scene, stored-f32 camera matrix, controls and pose identity. Evaluation frames are 1, 60, 61, 75, 90, 105, 120, 121, 122, 124, 128, 136, 152, 180 and every frame from 181–240. Movement happens on every 61–120 submission, including those not captured. Results describe the selected evaluation frames; unsampled motion frames cannot establish a continuous bound.

Preparation starts from a separately authored, pristine numeric scene/camera snapshot, before observing candidate output. Do not seed expected inputs from a capture's returned current state. The plan owns frozen copies. Its SHA-256 identity includes the contract, profile, initial numeric geometry/material/light/camera inputs, pixel corpus and complete expected frame schedule. The comparator requires both the requested frame identity and observed numeric source/camera/control values to match, including camera-cut and GI-reset flags. A frame number alone is insufficient. Identical hold poses may reuse quadrature by `poseKey`, but each comparison still needs its own matching frame receipt.

## Dense regions and errors

The dense row-major ROI is the union of projected virtual emitter corners over all 240 expected poses, expanded by four pixels on each side. The plan rejects an ROI outside the viewport or exceeding 16,384 pixels; it never silently crops. Freeze the plan and expected masks before candidate inspection and reuse them at every resolution scale. These are source-derived masks, never candidate-derived masks.

Geometric masks intersect the visible reflector and then the sharp reflected ray with the expected source, using the existing 0.002 m normal bias, 0.002 m minimum and 16 m maximum ray interval. They distinguish current feature, background and the initial feature's vacated region. They include blocker ordering. For object/camera-motion hold evaluations, empty vacated masks fail; all comparisons require nonempty feature and background regions. These sharp-ray masks label geometric regions: glossy GGX radiance may extend into the background or vacated mask, so those regions are compared against their own glossy reference values, not forced to zero.

Reported errors are linear RGB channel RMSE, mean absolute error, signed bias and maximum absolute error, separately for visible/feature/background/vacated regions. Dense finite values within the composition texture's ±65,504 representable magnitude are required. Empty optional regions return `null`. The motion-relative residual is `actual(frame,pixel) − reference(frame,pixel)`. Residual variation is the mean per-channel population variance of that residual over the chosen frames and a declared fixed nonempty mask. Do not reuse the historical static-reference temporal variance calculation across moving truth. A future run must state its exact frame set and fixed-mask construction, including visibility exclusions.

Before candidate outcomes, retain the existing paired 64/128-subdivision reference sanity checks: RMSE <0.01 and maximum absolute difference <0.05 on the declared region. These are empirical quadrature-resolution checks, not certified truth or acceptable engine errors. Every distinct evaluated pose and thin phase needs this qualification. A failing reference requires a separately recorded refinement decision before evaluating a candidate. The fast unit tests use low subdivisions to exercise mechanics and do not claim reference convergence.

`proposedImprovementMargin()` records the proposed absolute RMSE margin `2 × max(coarse/fine RMSE) + range(repeated baseline-run RMSE)`, using only pre-candidate measurements for the same profile, region and schedule. It returns a proposal, never a quality pass. Freeze measured values and any final acceptance gates before candidate captures. Recovery lag remains a later GPU integration metric: define its baseline-derived error limit first, then report the first evaluated hold frame after which all remaining evaluated hold frames satisfy it; label sparse evaluation as sampled evidence and report censored failures.

## Checks and next integration boundary

Run the focused CPU checks without building Core or starting a browser:

```sh
node --test scripts/reflection-image-reference.test.mjs scripts/reflection-motion-reference.test.mjs
```

The tests independently construct a two-box fixture/camera. They check translation math, immutable schedules, dense feature/vacated masks and the sparse grid's thin-feature blind spot. Actual low-subdivision quadrature supplies negative controls: zeroed, energy-preserving blurred and retained initial-pose images have nonzero regional errors. Stale reference records, stale observed source/camera state, wrong controls and invalid image shapes fail. Exact-reference controls only test the analysis machinery; they are not engine quality gates.

The next browser harness must construct the scheduled procedural source and supply the translated camera through a test provider, capture observed state and linear reflection composition, and pair each evaluated frame with its precomputed reference. The fixed public reflection fixture does not expose the thin-box dimensions or this translated camera path; this preparation does not claim those controls are implemented there. The existing internal effect's scene-factory boundary and a test geometry provider are integration points. Do not change benchmark defaults or silently modify the historical browser harness.

The real run still needs baseline reference qualification, negative controls, actual primary/shadow counts, freshness/coverage/failure diagnostics, named adapter/build/source identities and quarter/half/full comparisons. Later reconstruction candidates must preserve the proposed raw/history comparison boundary. Heavy quadrature and readbacks run outside normal timing; unfenced performance and integrated-scene acceptance remain separate work. No local benchmark assets are read or embedded by this harness.
