# Finite probe volume and the exterior-wall correction

The courtyard's exterior north-facing wall showed repeating red/dark lobes around tour seconds 32–34. On clean source `8fc2d4adc46548f6c9d51b453d17fb7759ee0021`, the wall normal was uniformly -Z, direct lighting was black, and the isolated indirect image contained the pattern. It persisted with TAA off and in a sequential camera replay. The separate near-black view around second 16 matched the scripted light-off interval at seconds 14–18; forcing the light on at the same camera restored the wall and ground.

The probe sampler previously accepted surviving boundary donors outside the finite room volume. Their common orientation/visibility attenuation could cancel during normalization when total weight exceeded the denominator floor. The correction rejects a normal/view-biased query outside the closed cell volume derived from origin, spacing and dimensions. For this grid the volume is `[-6,0,-4]` through `[6,4,4]` metres. Accepted queries retain the same sampling arithmetic and budgets.

This is a hard support cutoff. Near a boundary, normal/view bias can move a query between supported and unsupported positions. It does not fix visibility error inside the volume or add outdoor illumination. The exterior wall remains dark because it receives neither direct sunlight nor supported probe lighting. Nearest-clamped probe-age diagnostics are not a surface-support test.

## Validation

The frozen runtime/harness checkpoint is `4472512c134cb2bcb7759477c0abcdd7c6af7268`; its exact parent is `46fca5e239a900484056336e12a5703a78a0703d`. Later command registration and documentation changes do not change the shader or tested runtime bytes.

- All 354 unit tests, both TypeScript configurations and the package build passed. Independent production/harness source reviews found no remaining issue in the finite-volume contract.
- The production-WGSL test passed on actual Apple Metal hardware and Google SwiftShader: 484 query evaluations in eight dispatches each. It tests constant HDR, nonuniform probe colors, all six faces, edges/corners, closed boundaries, normal/view bias, physical room points, and a translated grid with two-metre spacing. The negative control removes only the guard. Accepted nonuniform outputs were identical; known-HDR maximum absolute error was `9.537e-7` on hardware and zero on SwiftShader. GPU/browser/cleanup errors were zero.
- Eight hardware PNGs formed four matched comparisons of the parent and candidate at 1280×720 with identical frame IDs and controls, TAA off, one reset plus 240 held submissions per case. At t=34 the checked 14,400-pixel exterior region changed from false red lighting to RGB zero throughout, in final and indirect views. At t=18 the 120,000-pixel interior region remained RGB-identical in both views. The indirect diagnostic retains its existing ×20 display gain; these are display-code region checks, not linear-light or whole-image error bounds.
- A separate candidate replay submitted 721 frames at fixed 1/60-second scene steps from t=22 to t=34 with TAA enabled. Both t=32 and t=34 captures had RGB zero throughout the same exterior region, and the pattern was absent on visual inspection. This is a bounded scripted history check, not wall-clock performance or arbitrary-camera coverage.
- Existing full hardware GI and integrated suites passed, including door/light rejection, offscreen transfer, green/neutral terrain-to-indoor lighting, streaming, mirror and lifecycle controls.

All scene captures used installed Chrome 152.0.7977.82 / Apple Metal on the M2 host. The matched image experiment kept legacy streamed greedy geometry with a 1 MiB pool, pixel error 2, green terrain, GI 32×64 rays, quarter-resolution world reflections with 32768 candidates, roughness .08 and distance 16. Source/build/asset hashes and cleanup were checked; no power settings or defaults changed. Queue completion does not identify a compositor presentation frame.

An independent artifact audit recomputed the image-region statistics and verified the eight PNG hashes, 34 built files, 94 mapped-source entries and 83 asset files. The older GI/integrated report formats record clean source commits and their functional results, but do not have the same detailed module-hash records as the new kernel and image comparison reports. Full CI is a separate merge gate.

## External evidence

Reports and images remain local under `~/Downloads/`; no assets or captures are committed:

| Directory | Scope |
| --- | --- |
| `Strata-Benchmark-Results/2026-09-05T07-44-56.790Z-probe-volume-validation` | Hardware synthetic shader check |
| `Strata-Benchmark-Results/2026-09-05T07-45-21.513Z-probe-volume-validation` | SwiftShader synthetic shader check |
| `Strata-Visual-Reports/2026-09-05T07-45-36.538Z-wall-volume-comparison` | Eight exact-parent matched images |
| `Strata-Visual-Reports/2026-09-05T07-52-59.286Z-wall-volume-motion` | Candidate TAA-on replay |
| `Strata-Benchmark-Results/2026-09-05T07-46-29.498Z-gi-validation` | Existing full GI suite |
| `Strata-Benchmark-Results/2026-09-05T07-46-59.955Z-integrated-validation` | Existing full integrated suite |

Use `npm run test:probe-volume` for the focused synthetic check; it is independently registered in `npm run check` and CI. These results address the reproduced exterior pattern. [Issue #15](https://github.com/tylerstuff/strata/issues/15) remains open for broader GI bias, visibility and stability work.
