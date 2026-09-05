# Diffuse refresh during rigid motion

This is a narrow scheduling fix for [issue #15](https://github.com/tylerstuff/strata/issues/15). Continuous motion of the restricted emissive object previously changed the diffuse epoch every submission and restarted its frontier at zero. Only the first 32 of 384 probes could remain current. The fix preserves the frontier during object-only motion. General GI quality and issue #15 remain open.

## Revision and age contract

`ReflectionEffect` still increments the tracing world revision, refits/uploads the world representation, and resets reflection and raster TAA history when the object moves. A separate diffuse invalidation revision controls `ProbeCache`:

- Object-offset changes retain the diffuse epoch and advance its round-robin frontier.
- Door, wall/material, roughness and directional-light changes hard-invalidate the diffuse epoch. Explicit GI reset and GI re-enable also hard-invalidate it.
- Cancellation commits neither the diffuse revision nor its atlas/frontier. A pending hard change still invalidates the retry if its scene-control patch is omitted on that retry.
- The independent GI renderer omits the new invalidation argument and retains its existing reset-on-world-revision behavior.

The budget remains 32 probes × 64 primary rays per submission, at most one shadow ray per primary ray, and 384 probes. Every probe is revisited within 12 submitted frame ticks. The sampler accepts a latest observation age of at most 11 ticks, rejects older observations and future timestamps, and rejects previous epochs immediately. Irradiance integration may reuse its previous observation at the normal 12-tick revisit; a larger gap drops that history.

**The 11-tick limit measures the latest observation, not the age of all contributing radiance.** Irradiance hysteresis remains 0.85, so older weighted light can persist across many updates. Visibility moments remain unfiltered. Neither a 12-frame radiometric freshness guarantee nor zero moving-light lag is claimed. Broad TAA/reflection resets and full tracing-buffer reuploads remain unchanged.

Telemetry distinguishes `worldRevision`, `diffuseInvalidationRevision`, `objectMotionRollingRefresh`, `refreshFrontier`, `sampleFrameIndex`, and `maxSampleAgeFrames`. Per-probe GPU states retain epoch, validity, update count and latest frame index. Actual GPU validity counts remain unavailable in ordinary frame telemetry until read back.

The default cache still owns 71,904 buffer bytes and 1,966,080 texture bytes. No runtime allocations, rays, dispatches or uploads were added. The age bound uses a reserved word in the existing 96-byte uniform; this internal shader/config pair must use matching versions.

## Production-GPU evidence

The diagnostic reads all 384 probe states and five diffuse surface patches after every submission. TAA and reflections are disabled to isolate diffuse behavior. It covers 36 cold moving submissions, 240 static, 96 warm moving, 240 after motion stops, 48 light-off, 48 light-on, 240 closed-door and 240 reopened-door submissions. The closed-door transition discards its first encoded frame and retries. A final test advances only the sampling clock to verify stale observations contribute zero.

The baseline is clean `72523508f1eb714c03bfca77bd61cf1b934e7fc2`, with documentation-only changes after `7e43e936`. The candidate is an uncommitted patch on `7e43e936`; reports retain actual source state and bundled module hashes. These are functional diagnostics, not total-frame performance evidence.

- Baseline motion retained 32 current-epoch probes and made four sampled regions exactly black. The candidate reached all 384 by submission 12 and never exceeded latest observation age 11 during continuous motion.
- Candidate stale-clock sampling returned exactly zero. Legacy sampling still returned a maximum channel of 0.226705.
- Static-open, light-off/on and closed/reopened-door regional RGB arrays matched baseline exactly. This preserves the measured reset behavior; it does not establish absence of leakage everywhere.
- Full hardware and software motion diagnostics passed. The existing complete GI tracing/probe/rendering harness passed on both backends. The automatic software smoke also passed cancellation and stale-clock checks.

## Reference bias remains

The independent reference uses oriented-box slab intersections and shadow rays without production BVH/probe traversal. It integrates 8,192 cosine-weighted hemisphere samples over each 3×3 surface patch and records four deterministic block estimates. Incoming emission and shadowed Lambertian outgoing light use physical fixture values. The reference computes receiver radiance as `0.72 × mean(incoming radiance)`; production computes `0.72 × probe irradiance / π`. Both use linear radiance and display gain one. Probe interpolation, normal bias, directional discretization and history therefore remain part of the observed approximation error.

Matching frozen configurations at eight warm-motion checkpoints yielded these RGB-energy RMS errors:

| Diffuse region | Legacy | Rolling refresh |
|---|---:|---:|
| Near emitter, negative z | 0.11817 | 0.05237 |
| Near emitter, positive z | 0.11911 | 0.13396 |
| Right side of doorway | 0.10013 | 0.01136 |
| Right-room wall | 0.00998 | 0.00124 |

The positive-z emitter region becomes worse against the reference when its previously missing lighting is restored. Static near-emitter tail biases were already approximately +32% and +105%; the corresponding reference standard errors are approximately 4–5%. After 240 stopped-motion submissions, candidate near-emitter biases remained approximately +25% and +95%. These regions did not stay within ±20% of the reference during the observed window.

The dark-corner 8,192-sample reference has standard error approximately 0.00117 against mean 0.00259 (45%), so its apparent relative bias and small RMS difference are unresolved at that sample count. Do not present them as reliable accuracy evidence. A separate 524,288-sample CPU extension completed in 5.4 seconds without rerunning or modifying GPU captures. Its open-zero reference energy is 0.00192461 with block standard error 0.00010315 (5.4%). Against that improved estimate, the captured static tail is approximately 71% low and the stopped-motion tail 46% high. This also shows why the original low-sample corner bias should not guide conclusions.

The derived `corner-reference-extension.json` sits beside the hardware candidate report, links its immutable report hash, and has SHA-256 `bfec4a9f01b07ca4b0e033f08c3fc0916d0156bb0bb152b8959aa814677bb9f8`. The pure test helper `computeGiMotionReferences(524288, 'left-room-corner')` reproduces those reference samples without WebGPU. Finite reference blocks and retrospective stability observations are not convergence guarantees. Restoring coverage does not satisfy the broader spatial-quality acceptance criteria.

Reports remain external under `~/Downloads/Strata-Benchmark-Results/`:

| Evidence | Directory | Report SHA-256 |
|---|---|---|
| Hardware baseline | `2026-09-05T04-45-10.428Z-gi-motion-validation` | `c15fa76eeb634559ec328f3a2c489ca5d243ae2ef602e4f993020b4de96c6db7` |
| Hardware candidate | `2026-09-05T04-45-18.921Z-gi-motion-validation` | `f244b864654bd7d3b8699122e750f5ad370af9569ba1ca70933bdf9d55af8603` |
| Software candidate | `2026-09-05T04-43-25.222Z-gi-motion-validation` | `0bb97073b4b22bb571aa4a03baf8f7d6b016e4432382db80810be9211dc94d17` |
| Software automatic smoke | `2026-09-05T04-45-27.934Z-gi-motion-validation` | `c2e56fae5d99abf9adcdcb0568ed138cacb646c8eee1b1a81dbc4fe9abeada4a` |

Run the full independent diagnostic with `node scripts/test-gi-motion.mjs`. Add `--source-root /path/to/baseline-worktree` to bundle a separately verified baseline without copying source or assets. `npm run test:gi-motion` runs a 120-submission subset in `npm run check` and CI. Local Chrome runs use `STRATA_TEST_BROWSER_CHANNEL=chrome STRATA_TEST_HEADED=1`; software runs additionally set `STRATA_TEST_SOFTWARE_GPU=1`. Each frame has a readback fence to prevent unbounded queued software work.
