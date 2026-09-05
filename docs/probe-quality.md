# Diffuse probe attribution diagnostic

This test-only investigation addresses [issue #15](https://github.com/tylerstuff/strata/issues/15). It changes no runtime algorithm. In three sampled static regions, freezing visibility weights did not reduce noise or change brightness. Supplying independently integrated probe irradiance still substantially overbrightened the two floor patches. That separates a receiver-interpolation error from the error in the stored probe lighting; it does not establish which grid-placement change would fix it. Issue #15 remains open.

## Capture and oracle

The hardware run uses the production `ReflectionRenderer`/`ProbeCache` on Apple M2 through headed Chrome, with reflections and TAA off. It warms for 240 submissions and captures the following 96 at 320×180. The fixed budget remains 384 probes, 32 refreshed per submission and 64 primary rays per refreshed probe. This is fenced functional readback, not frame-performance evidence.

There are three 3×3 patches: near-emitter negative-z `[-.45,0,-.3]`, near-emitter positive-z `[-.45,0,.75]`, and dark corner `[-5.2,0,3.1]`. Each patch offsets x/z by −.06/0/+.06 m. The test captures their 13 contributing probes, actual irradiance and moment texels, config/state words, interpolation factors and refreshed raw rays. The normal and view direction are up. Reported “energy” is the sum of linear RGB channels, not luminance; receiver albedo is 0.72 and display gain is one.

The CPU reconstruction of the actual GPU sampler differs by at most **5.55×10⁻⁸** per channel. Independent comparisons of **6,656 transferred rays** differ by at most **9.10×10⁻⁸ radiance** and **1.53×10⁻⁶ m distance**. The oracle shares the fixture's scene construction/material values, but uses separate oriented-box slab intersections and Lambertian shading, without production triangle/BVH traversal or probe integration. It separately records emission and reflected direct light. Finite-ray and history reconstructions are retained in the report.

Independent cosine-hemisphere integration evaluates both the actual irradiance-atlas texel directions and exact up at every donor probe position, plus a direct surface reference. The normal reference uses 262,144 samples per direction; the refined corner and its donor probes use 1,048,576. Probe reference values are irradiance E; surface/output comparisons consistently use `0.72 E / π`.

## What the controls measure

Each observation reuses exactly the same recorded production data:

| Control | Irradiance | Interpolation weights |
|---|---|---|
| P | Actual probe atlas | Actual current-frame weights |
| E | Independent reference at each actual atlas direction/probe | Actual current-frame weights |
| V | Actual probe atlas | All weights frozen from captured frame 240 |
| EV | Same reference as E | All weights frozen from frame 240 |
| EU | Independent exact-up reference at each probe | Actual current-frame weights |

The frozen control retains each point's recorded neighbor eligibility, trilinear, orientation and visibility product, including the denominator. It is a fixed production snapshot, **not a reference visibility solution**. E/EU are numerical substitutions in the test-only CPU reconstruction, whose P output is checked against the production GPU sampler. No renderer textures are replaced.

| Region | Surface oracle ± block SE | P mean / bias | E mean ± block SE / bias | EU mean ± block SE / bias |
|---|---:|---:|---:|---:|
| Negative-z emitter | .124791 ± .001457 | .178484 / +43.0% | .161925 ± .000752 / +29.8% | .167353 ± .001142 / +34.1% |
| Positive-z emitter | .114725 ± .001160 | .232618 / +102.8% | .237933 ± .001132 / +107.4% | .243675 ± .002058 / +112.4% |
| Dark corner | .001981 ± .0000438 | .0005045 / −74.5% | .0013755 ± .0000273 / −30.6% | .0012000 ± .0000214 / −39.4% |

Standard errors are empirical estimates from eight deterministic sampling blocks, **not certified error bounds**. E/EU block estimates combine donor blocks using the same captured point weights and the same albedo/π conversion. Spatial/temporal approximation errors are not included in these sampling estimates. Individual refined corner donor-direction relative block standard errors range approximately 1.8–8.6%; aggregate cancellation should not be treated as proof that each donor is accurate.

The corner surface reference changed from .0020903 ± .0001620 at 262,144 samples to .0019807 ± .0000438 at 1,048,576; its E prediction changed from .0014098 to .0013755. This improved sampling agreement supports substantial remaining underlighting, without treating the exact percentage as a certified value. Both reference runs use the same immutable GPU capture.

P and V match exactly at the negative-z patch and corner. At positive-z their mean difference is only 3.8×10⁻⁹. Their temporal standard deviations are therefore also effectively identical: **.005290, .013883 and .0001423** for the three regions. E is effectively constant. The selected witnesses attribute this observed noise to changing stored irradiance, rather than changing visibility weights. This result does not cover diagonal visibility, the doorway, moving occluders, door transitions, or other unsampled surfaces.

## Measured attribution versus remaining hypotheses

Correcting donor irradiance removes some negative-z overbrightness and much of the corner's underlighting. It does not fix positive-z brightness: its dominant donor, probe 197 at `[-.5,.5,.5]`, receives about **80.1%** of the normalized patch weight; the probe's measured irradiance is only about **2.6% below** its independently integrated value. The high surface value is therefore not explained by a grossly overbright estimate at that donor. Only 1–3 of its 64 rays hit the emitter in each captured refresh, consistent with a noisy bright-source estimate. The corner's four probes record no emitter hits during their eight captured refreshes each; finite sampling/history error remains substantial there.

Removing angular discretization with EU makes both bright-patch errors slightly worse. Thus the 8×8 atlas's upward directional interpolation is not responsible for the measured doubling. With accurate exact-normal irradiance still producing +34%/+112%, the remaining error belongs to the donor-to-receiver approximation under these recorded weights.

The grid starts at y=.5 m; biased floor lookups are at y=.14, outside the lower probe-center boundary. Their out-of-bounds lower neighbors are skipped, so only the elevated y=.5 layer contributes. That geometry is verified, and the source is much closer to that layer than to the floor.

A later [reference-only donor-height comparison](https://github.com/tylerstuff/strata/issues/15#issuecomment-5549891535) isolates a strong height contribution while retaining the frozen production weights and denominators. At donor y=.14, physical-floor biases change from +34%/+112%/−39% to +1%/+25%/−12%. The +1% case reflects cancellation; both bright patches retain horizontal interpolation error, and the corner's horizontal contribution remains unresolved within empirical sampling variation. This supports investigating placement and interpolation together, not a deployable relocated grid: neighborhoods, weights, visibility, invalid-probe placement, finite-ray noise, temporal behavior and GPU cost were not recomputed. No runtime or exposure setting changed. These results do not justify a moment-filtering patch for these witnesses, nor a global exposure correction.

## Reproduction and provenance

Run from the repository after `npm ci`:

```sh
STRATA_TEST_BROWSER_CHANNEL=chrome STRATA_TEST_HEADED=1 node scripts/test-probe-quality.mjs
```

The default browser follows the repository's Chromium convention if the channel is omitted. `STRATA_TEST_SOFTWARE_GPU=1` selects the same software flags as other harnesses. The browser/server close before the higher-sample CPU integration. Results remain outside Git under `~/Downloads/Strata-Benchmark-Results/`. No asset collection is read or copied; the only scene is the analytic fixture already in source.

Reanalyze an existing immutable capture without opening a browser:

```sh
node scripts/test-probe-quality.mjs --analyze /absolute/external/path/capture.json
```

Optional `--samples` and `--corner-samples` select 1,024–1,048,576 samples, divisible by eight. Low-count runs are diagnostic smoke only. Reports retain capture source/module hashes separately from later analysis source and reference-bundle hashes. Six focused CPU tests run with `npx vitest run tests/unit/probe-quality-reference.test.ts` and are included in ordinary unit-test discovery. Both TypeScript configs pass. The full attribution browser diagnostic is explicit; it is not added to routine CI time.

Observed capture source was `eb0bebccaaa01dcb8afd79e710a11eb5baee6591` with uncommitted test files, accurately reported as dirty. A later test-only commit does not retroactively change that provenance. The captured runtime is the committed motion fix; no runtime algorithms were edited for this diagnostic.

External files under `/Users/tyler/Downloads/Strata-Benchmark-Results/`:

| Artifact | Directory/file | SHA-256 |
|---|---|---|
| Immutable hardware capture | `2026-09-05T05-13-29.922Z-probe-quality/capture.json` | `8052d836ffc2b118d4db1f30cf2aa82fd8ab51c3b8537513b3f648d82472af7f` |
| Initial uniform-count report | `2026-09-05T05-13-29.922Z-probe-quality/report.json` | `aceac52a6bc68205cd57c1e82c64671f6eb60a960c6f2e76ae407a4eab79335a` |
| Refined CPU-only analysis | `2026-09-05T05-17-29.681Z-probe-quality/report.json` | `ac33efc0d740a840239b84a925247a5e9037b42f013179d96a40dbb4dec414c7` |
