# Incremental trace maintenance on Apple M2 — 2026-09-06

The comparison meets the preregistered numerical targets for issue #20. During
opening frames with changed trace targets, CPU submission p95 fell by 34.3% at
720p and 36.4% at 1080p. The controlled canonical update queued 99.506% fewer
trace bytes. Separate deterministic hardware pairs passed before timing.
Independent 720p screenshots contain lighting differences, so this result does
not establish equality of every performance capture or completion of the visual
quality work.

## Source and workload

Measured source is clean `c91c285489a9befe8ce27d7264dfc56a295d12d5`, tree
`f5663aae5f35d488be42d43a13240060386869ed`, Core subtree
`2d978dca2fdfafea4dab92670a52665c0fdf58ac`. This predates main's initialization
integration at `4599d0475e7c46e79f698c60a951f34da3961c84`; these results must not
be presented as measurements of that later source.

Both arms use identical renderer, shaders, bounds policy, assets, package flags,
worker and release WASM. Only the full arm substitutes the diagnostic
`full-trace-performance-updater.ts`. That control performs one complete dynamic
regeneration, packing and reverse BVH refit per changed target. It uses the same
conservative arithmetic as production, without the independent correctness
oracle in its measured path. Both arms preserve the same history-reset contracts.

The reference device is a MacBook Air Mac14,15, Apple M2 with ten GPU cores,
eight CPU cores and 16 GiB memory; Darwin 25.5.0, Node 22.23.0 and headed Chrome
152.0.7977.82. Both resolutions use a non-fallback hardware adapter. All 32 power
observations report AC power and Low Power Mode off. Warning probes reported no
thermal/performance limit; they provide neither temperatures nor proof that
throttling never occurred. This is not an AC-versus-battery experiment.

One bounded session ran fresh hardware correctness, receipt admission and the
four performance arms sequentially. It finished in 482.221 seconds, within one
720-second outer deadline, with owned-process cleanup confirmed. There were no
retries or workload changes. Each fresh context used 30 seconds of warmup and
the original 60-second browser-time tour. Order: incremental 720p, full 720p,
full 1080p, incremental 1080p.

The seed-1337 courtyard retains its original 83 assets, 4×64 terrain source,
1 MiB streamed pool, greedy residency, pixel error 2 and zero artificial delivery
delay. GI updates 32 probes with 64 rays each; world reflections use quarter
resolution, at most 32,768 candidates, roughness 0.08, distance 16 and every-frame
updates. TAA is on, terrain is green and the view is final. Motion, door and
sun-off events are unchanged. This 1 MiB comparison is separate from issue #13's
original 8 MiB terrain acceptance.

## Measured result

The opening subset is `[0, 8000)` milliseconds with positive per-frame change in
the cumulative trace-update count. Its first delta uses the capture-start
snapshot. Percentiles are nearest-rank observations, not an isolated timer for
the updater itself. All times below are milliseconds; full → incremental.

| Resolution | Opening changed-target frames | Opening CPU p95 | Reduction | Whole-tour CPU p95 | Whole-tour GPU span p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 720p | 241 → 240 | 3.500 → 2.300 | 34.3% | 2.600 → 1.400 | 13.894 → 13.959 |
| 1080p | 240 → 241 | 3.300 → 2.100 | 36.4% | 2.500 → 1.000 | 14.877 → 14.025 |

Both exceed the required 25% opening CPU-p95 reduction and 90% canonical byte
reduction. Neither exceeds the reviewed regression limits: whole-tour CPU p95
increase greater than max(10%, 0.25 ms), GPU span p95 increase greater than
max(5%, 0.3 ms), or a greater-than-one-percentage-point increase in callbacks
over 20 ms. Small GPU differences from these single pairs are descriptive and
are not isolated measurements of the updater's GPU cost.

| Arm | Resolution | Captured frames | Total uploads, bytes | Trace uploads, bytes | Geometry uploads, bytes |
| --- | --- | ---: | ---: | ---: | ---: |
| Incremental | 720p | 3,600 | 27,627,152 | 221,696 | 16,515,072 |
| Full | 720p | 3,600 | 72,419,232 | 45,052,160 | 16,449,536 |
| Full | 1080p | 3,601 | 71,945,440 | 44,867,520 | 16,187,392 |
| Incremental | 1080p | 3,600 | 27,589,680 | 222,608 | 16,449,536 |

Independent browser-time runs have different target sample and streaming counts;
their whole-tour totals are not identical-work transfer comparisons. The separate
hardware-controlled offset-zero-to-0.4 update is the canonical gate: full queues
184,640 bytes in five writes, incremental queues 912 bytes in seven writes, with
no static triangle writes or fallback in the incremental arm. Retained typed
maintenance metadata is 187,185 versus 150,801 bytes. These counters exclude
temporary JavaScript objects, browser/driver overhead and whole-device memory.

All 14,401 captured frames have GPU-span observations, with zero measured
pending/dropped samples and zero RAF intervals over 20 ms. GPU spans still reach
16.777 ms at 720p and 23.724 ms at 1080p. RAF cadence is not presented-frame
delivery; GPU intervals exclude uploads, browser composition and scanout, and
named passes can overlap. This does not establish general 60 FPS or the intended
game-quality target.

| Arm | Resolution | GPU spans >16.667 ms | GPU spans >20 ms | Maximum span, ms |
| --- | --- | ---: | ---: | ---: |
| Incremental | 720p | 3 | 0 | 16.777 |
| Full | 720p | 1 | 0 | 16.777 |
| Full | 1080p | 7 | 1 | 23.724 |
| Incremental | 1080p | 2 | 1 | 23.658 |

All 295 recorded request failures are external-asset `ERR_ABORTED` cancellations
classified as allowed by the frozen runner; their individual causes cannot be
recovered without per-cancellation timestamps/reasons. Unexpected request,
browser and GPU errors are absent. Each run's
11,800 lifetime dropped timestamp records occur after the timed capture, during
the rapid held-image submissions. They are separate from the complete measured
samples. Runtime GI/reflection trace-failure counters are unavailable (`null`),
not measured zero. Final tracked buffers, textures and WASM allocations are zero.

## Correctness and visual boundary

The new full-performance control passed hardware direct-write and paired GI,
reflection and integrated-renderer gates before timing. The literal serialized
renderer plan replaces cross-runtime trigonometric regeneration. Candidate-only
Stage C is explicitly skipped because that source was unchanged; it is not
claimed as new coverage. Earlier correctness-only artifacts remain separate.

Independent audit reconstructed all 460 raw source readbacks from logged writes,
including partial-failure prefixes. All 16,384 paired GPU query records matched;
4,096 source-oracle labels were independently regenerated, with no unknown GPU
status and maximum distance error 8.56e-6. The realized renderer plan has zero
literal/f64 deltas. All 1,084 paired cache-buffer identities and 415 texture
identities agree; moved-emitter, disabled-mode and reset/retry witnesses passed.
These renderer comparisons retain hashes and selected samples, rather than full
raw cache/image payloads for independent decoding.

All 20 PNG files have verified hashes, dimensions and slots t0/3/5/16/32, with
240 held submissions each and explicit engine disposal. The original t0
nonblank gate remains the admission check; brightness at the other four slots is
diagnostic. The t16 scenario intentionally disables the sun.

At 1080p, paired t0/3/5/16 pixels are identical; t32 differs by at most one code
value per channel. The 720p pairs differ in reflection/noise and red indirect
lighting. At t16, a wall region's mean red is about 3.42 for incremental and
16.81 for full, with green and blue zero; the full-image mean absolute RGB
difference is about 2.25/255 and maximum channel difference is 39. The cause is
not established by the nonblank gate or the passing performance thresholds.
The 720p t32 terrain masks match, with at most one code-value difference.

There is a concrete capture-input confound. Before the held images, saved GI
frame indices are 5,399 for incremental 720p and 5,400 for full 720p, while both
1080p runs have 5,400. Aggregate submissions advance from 5,400 to 6,605 and from
5,401 to 6,606 respectively, consistent with five captures of one reset submission
plus 240 held submissions. `capture()` resets caches and the camera but reuses
the engine. The reflection effect's monotonic frame count feeds the GI ray phase
with seed 1337; cache reset does not restart that count. TAA camera cuts do reset
their jitter index, so this evidence does not support blaming unmatched TAA
jitter.

The one-frame GI sampling-phase difference plausibly explains the correlated
720p mismatch, but the retained PNG records lack per-image GI frame/frontier,
epoch, reflection-history and resident-page snapshots. Its exact contribution
cannot be recovered from these artifacts. The deterministic hardware pairs and
the independent RAF performance captures therefore have different visual
comparison boundaries. No rerun or post-hoc threshold change is used here.

Persistent noisy reflections, very dark sun-off surfaces and limited outdoor GI
remain visible. The performance optimization does not close the user-reported
wall/lighting defects. Single opposite-order pairs also do not establish
statistical significance or performance on typical laptops in general.

## Retained evidence

All generated artifacts remain outside Git under
`/Users/tyler/Downloads/Strata-Benchmark-Results/`. The measured session directory
is `2026-09-06-issue20-performance-hardware-c91c285-v1`.

| Artifact | SHA256 |
| --- | --- |
| `correctness/report.json` | `7c9cc30d189a3c8513456d0a9a9f98c86dbd3ba0840a36de8ae891170ab2a28e` |
| `performance/report.json` | `cb26d7ee3054c567ffb40b1b62fe262f42f630b43aa1c0718d64706b9b687e27` |
| `driver-report.json` | `c381c2a20376ba79b117392b0158378048eddac31130d0e2b28aa540e05c2371` |
| `root-numeric-image-audit.json` | `28d57dd33ba8445cec22ea66c89508427779c04633cace5666768571e609d04a` |

The separate `2026-09-06-issue20-performance-audit-c91c285-v1` directory retains
the numerical audit (`numerical-audit.json`, SHA256
`6a8ca5d588daa777a577562d42e06bfc7d325515f8cc69ab6d1b0135f4f94915`)
and session/timestamp audit (`session-audit.json`, SHA256
`7cb758e096bbc6fea3f8f7c3ff462ea49d76738f6777a058ae8f6dfee1c75bca`).
It also retains the controlled correctness audit (`correctness-audit.json`, SHA256
`d36794cb3585f3504ba4d5cfec85323799af00bc8fa126f07f5b7ad0f12ff0b1`)
and qualified visual audit (`visual-audit.json`, SHA256
`06e703a116421a35617eeb0a131aeaee28f8a694b8ce53437a1ca10d6cc18056`).

Correctness manifest:
`2026-09-06-issue20-performance-proof-c91c285-v1/manifest.json`, SHA256
`6f1cbabe3a5c69865faff26125c30c278e7491959db47497ced935550a0c25d3`.
Performance manifest:
`2026-09-06-issue20-performance-freeze-c91c285-v1/manifest.json`, SHA256
`eaccbdaf4d469cc910edf92a81f032ebd3125c5a708a8ba31ceadec892ce2f24`.
External driver:
`2026-09-06-issue20-window-driver-c91c285-v1/window.py`, SHA256
`e8839412750cc6857e299f23cb0b674c6450676525af53ffd42446d13601aaac`.
