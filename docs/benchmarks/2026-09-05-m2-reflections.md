# Apple M2 selective reflections — 2026-09-05

The restricted selected-reflector experiment renders an initially offscreen object and completes at approximately 60 browser callbacks per second in these captures. It does **not** establish the integrated 60 FPS game-quality target: the 1080p world-reflection GPU envelope reaches 17.695 ms at p99 and 20.185 ms maximum, and rough/moving reflections still have visible quality limitations. Continue with the combined streaming/lighting workload in [#7](https://github.com/tylerstuff/strata/issues/7); [#17](https://github.com/tylerstuff/strata/issues/17) tracks reflection quality.

## Source, host and protocol

Clean implementation revision: `6ebd198692ae9c2334d76ce72488387e6d4739fa`. The three reports and clean hardware functional check all record this source with no uncommitted files. Built shader/cache/composer source-map contents were checked against committed source. Subsequent test-harness/documentation changes do not alter the measured renderer.

MacBook Air Mac14,15, Apple M2 (10 GPU cores, 8 CPU cores), 16 GiB memory; macOS 26.5.2 / Darwin 25.5.0; headed Chrome 152.0.7977.82 with hardware WebGPU and timestamp-query; Node 22.23.0. AC power and the active Low Power Mode setting of 0 were verified before, during and after each capture: all 48 observations agree. The inactive battery profile is not the active power mode. No numeric temperature samples were available; this does not establish an absence of throttling.

Each mode ran sequentially, off → probe-only → world, at 1280×720 then 1920×1080: 30 seconds of warmup followed by 60 seconds of capture. DPR was 1, CSS canvas 1280×720, browser viewport 1920×1160. GI remained on at 32 probes ×64 rays per update, TAA on, static receiver camera, door open, red wall, unit light intensity, zero object offset. Reflection roughness was 0.08, internal scale 0.25, candidate quota 32768, distance 16 m and update interval one frame. No imported assets were used; the source fixture contains 13 opaque boxes /156 triangles.

Performance runs keep the camera/world fixed. Motion, cold history, roughness endpoints, fallback and resize are separate functional cases. Final captures are taken after held settling frames outside the timed interval. Do not compare these results directly with the earlier GI overview-camera workload: screen coverage, fixture and composition differ.

## Measured distributions

All values below are milliseconds. GPU span is the interval from the earliest sampled pass boundary to the latest, not total device work or display scanout. Probe-atlas preservation copies precede the timed GI boundaries. CPU submission and GPU intervals overlap and must not be added as sequential frame cost.

| Mode | Resolution | Frames | CPU p95 | GPU span p50 | p95 | p99 | Maximum | RAF p95 / p99 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| off | 720p | 3600 | 0.800 | 7.406 | 7.668 | 8.389 | 12.124 | 17.600 / 17.700 |
| off | 1080p | 3601 | 0.700 | 12.648 | 15.008 | 15.598 | 17.695 | 17.700 / 17.700 |
| probe-only | 720p | 3600 | 0.700 | 7.406 | 7.733 | 7.864 | 12.190 | 17.700 / 17.800 |
| probe-only | 1080p | 3600 | 0.700 | 12.648 | 15.073 | 15.729 | 17.170 | 17.700 / 17.700 |
| world | 720p | 3600 | 0.900 | 12.583 | 13.107 | 13.369 | 19.137 | 17.600 / 17.700 |
| world | 1080p | 3600 | 0.800 | 13.304 | 15.532 | 17.695 | 20.185 | 17.600 / 17.700 |

Every timed frame has overlapping pass intervals. Adding their durations produces misleading p95 totals of 22–45 ms; those sums are retained only as diagnostics. No capture reports GPU validation errors, hidden intervals, missing/dropped/pending timestamp samples, or RAF intervals above 20 ms. The observed approximately 60 callbacks/s is scheduling cadence, not a measurement of presented frames.

The off and probe-only modes have similar envelopes in this fixture. World tracing increases the 720p p95 envelope by about 5.44 ms relative to off; the corresponding 1080p difference is about 0.52 ms. These are differences between sequential whole-workload distributions, not isolated shader costs or evidence that 1080p tracing is intrinsically cheaper. Candidate coverage differs: the final 720p state covers its entire 27664-pixel rectangle, while 1080p rotates 32768 candidates across a 61932-pixel rectangle with a two-frame freshness bound. Actual primary/shadow rays are not read back during performance capture. Browser/GPU scheduling also changes individual pass boundaries.

| World mode named pass | 720p p95 | 1080p p95 |
| --- | ---: | ---: |
| gi-trace | 1.114 | 0.721 |
| gi-update | 0.197 | 0.328 |
| shadow | 0.262 | 0.131 |
| raster | 0.918 | 1.245 |
| reflection-trace | 3.146 | 2.621 |
| reflection-resolve | 0.262 | 0.459 |
| gi-shade | 7.471 | 10.289 |
| temporal | 12.714 | 14.942 |
| presentation | 12.780 | 14.877 |

The long composition and late render-pass intervals identify a screen-space processing path worth investigating; they do not isolate execution cost. In particular, the TAA/presentation interval can include overlap and dependency stalls. A future optimization must compare the full GPU envelope and output quality, not subtract or sum these rows.

## Resources and work

All modes issue four render draws /314 submitted triangles per frame, including TAA and presentation. Off/probe-only issue three compute dispatches; world issues five. GI contributes 2048 primary rays and at most 2048 shadow rays per frame. World reflections add at most one primary and one shadow ray per selected candidate; the 32768 setting is not a total primary-plus-shadow ray count.

| Mode | Resolution | Tracked GPU buffers | Tracked GPU textures | Timed upload bytes |
| --- | --- | ---: | ---: | ---: |
| off | 720p | 116912 | 70385752 | 3052800 |
| off | 1080p | 116912 | 134897752 | 3053648 |
| probe-only | 720p | 116912 | 70385752 | 3052800 |
| probe-only | 1080p | 116912 | 134897752 | 3052800 |
| world | 720p | 116912 | 75454464 | 3168000 |
| world | 1080p | 116912 | 146302464 | 3168000 |

These are application-requested payload estimates. Canvas, driver/browser memory, alignment, JavaScript heap and allocator overhead are excluded. WASM linear memory is 1114112 bytes. Initial uploads are 75504 bytes. The profiler requests 1280 buffer bytes (four slots, ten passes). Shared scene trace data uses 14624 bytes; probe buffers/atlases use 71904/1966080 bytes; composition uses a 96-byte uniform plus eight bytes per full-resolution pixel. Those shared resources are counted once.

The reflection cache adds 512 buffer bytes and 88 bytes per low-resolution pixel: 5068800 texture bytes at 720p or 11404800 at 1080p. Fresh off/probe-only scenes retain only 88-byte placeholder textures; switching from world mode would retain the larger allocation and is a different memory comparison. Probe-atlas preservation also copies 983040 bytes per submitted GI frame, outside the timed pass envelope and CPU upload counter. Initialization measured 10.4–16.1 ms; first scene creation per browser was 30.3–49.7 ms and the second resolution 6.6–6.9 ms. These startup samples are not cold-network guarantees.

## Correctness and visible limits

The clean hardware report `2026-09-05T02-44-31.335Z-reflection-validation/report.json` passes 384 estimator comparisons and 18 rendering/history/quota/quarter-resolution cases. With a cold cache, GI/TAA off and perfect-mirror roughness, an independent planar/oriented-box oracle agrees on all 1234 reflected-source pixels in the first submitted frame. Both movement endpoints agree on 1286 pixels with zero false hits/misses. The real emissive cube remains outside the camera frustum, while its reflected centroid moves 66.02 pixels. Trace counters report no traversal exhaustion in these diagnostic cases.

Quarter-resolution reconstruction stays inside the metallic mask and within four output pixels of the projected reflection centroid, including motion and resize. A 20-frame moving-camera test with quota 256 advances its frontier, counting 2162 primary rays within 5120 scheduled candidates while rejecting stale history. Disposal returns tracked buffers/textures from 115632/22852864 bytes to zero. These readback-heavy tests are correctness evidence, not the performance workload above.

The quarter-resolution image has coarse silhouette edges and thin-feature aliasing. At roughness 0.35, the reflected lobe broadens but remains visibly speckled after 65 submissions. Camera motion currently prevents multi-frame specular accumulation; object changes restart diffuse GI. The low-frequency probe fallback cannot reproduce a sharp offscreen image. The experiment establishes bounded offscreen coverage, not a production denoiser, arbitrary scene support or Switch 2 visual equivalence.

## External evidence

All report JSON and PNGs remain under the local `~/Downloads/Strata-Benchmark-Results/` directory. No benchmark image/model content is uploaded to this repository or CI artifacts.

| Mode | Local report relative to results root | SHA-256 |
| --- | --- | --- |
| off | `2026-09-05T02-44-56-515Z-7493/report.json` | `745fbd6fcd2b6e14d35d0dcdefae1727c81c5df1649f7765a359bcdc7c4aa6ba` |
| probe-only | `2026-09-05T02-48-24-976Z-8247/report.json` | `0b50db4dd41079ee97cd9ff53bc6dbe97b423644068f6b2805c47e1b1f516c75` |
| world | `2026-09-05T02-51-58-003Z-8961/report.json` | `e75a3581ed16832ff268f70e8c0fefde839fe107fd6eb25c7316474d9d35fc56` |
| Hardware functional | `2026-09-05T02-44-31.335Z-reflection-validation/report.json` | `f6b81f0c44efe9613bda2d2942cbc6b72325d6e88984c4849aae19ec2970ff50` |

The [implementation guide](../reflections.md) documents controls, material/tracing assumptions, numerical fixes, source diagnostics and unsupported scope. [Issue #7](https://github.com/tylerstuff/strata/issues/7) evaluates the combined workload; the engine-wide performance objective remains unverified.
