# Integrated courtyard on Apple M2 — 2026-09-05

**Verdict: the combined rendering prototype works; the overall 60 FPS game-quality objective is not achieved.** The fixture demonstrates shared streamed geometry, diffuse GI and selected reflections. Its limited content, unavailable requested geometry detail and motion-related lighting limits prevent a Switch 2-inspired game-quality claim. The 60 FPS requirement remains unchanged.

## Source and protocol

The fixed-resolution hardware batch uses clean commit `7e43e9365c09eb07a55d071fa346d2dddc91ef83` and its rebuilt package. The preceding `98e0af46953b69d8673d6fce555cefdf2b11d4d7` has the same rendering path; the later commit adds an explicit GPU completion barrier for captures, longer software screenshot deadlines, diagnostics and tests. No GPU wait was added to normal frame submission.

Reference device: MacBook Air Mac14,15, Apple M2 with ten GPU cores, eight CPU cores and 16 GiB memory; macOS 26.5.2 / Darwin 25.5.0; headed hardware Chrome 152.0.7977.82, timestamp queries enabled, Node 22.23.0. Browser viewport: 1920×1160; CSS canvas: 1280×720; DPR: 1. The primary batch uses Battery Power with active Low Power Mode off, observed 80 times. Numeric temperature and power consumption are unavailable. Warning probes do not establish an absence of throttling.

Each configuration runs sequentially at 1280×720 and 1920×1080, with 30 seconds of warmup followed by the same recorded 60-second tour. Completed order: all on, GI off, reflections off, TAA off, resident GPU LOD. The first four use a 1 MiB streamed page pool, pixel error 2 and no artificial delivery delay. Resident GPU LOD removes streaming while retaining GPU selection. An optional sixth conventional mesh-LOD reference was not launched after the power source changed to AC. The five required comparisons are complete; the originally planned six-mode batch is explicitly incomplete. Visual triage took priority over that additional reference.

All comparisons retain the same scene, materials, camera and world events. GI updates 32 of 384 indoor probes with 64 primary rays each, plus at most the same number of shadow rays. Reflections use quarter width/height, at most 32,768 candidates, roughness 0.08, maximum distance 16 m and every-frame updates. A candidate may fail the material mask without issuing a ray. The camera starts at the mirror, crosses the doorway, visits the courtyard and distant terrain, then returns. An emissive object moves during 2–6 seconds; the door closes during 4–8 seconds; sun intensity is zero during 14–18 seconds. No imported model collection is loaded.

## Frame evidence

All times below are milliseconds. Missing samples remain unavailable; zero-duration quantized samples remain measurements.

| Mode | Resolution | Frames | CPU p95 | GPU span p50 | p95 | p99 | Max | Spans >16.667 ms | RAF p95 / p99 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| All on | 720p | 3600 | 2.400 | 5.439 | 10.879 | 14.287 | 18.612 | 2 | 17.500 / 17.700 |
| All on | 1080p | 3600 | 3.300 | 8.782 | 14.811 | 16.253 | 23.527 | 23 | 17.600 / 17.700 |
| GI off | 720p | 3601 | 2.600 | 3.736 | 6.750 | 7.143 | 9.699 | 0 | 17.700 / 17.700 |
| GI off | 1080p | 3600 | 2.400 | 5.439 | 8.913 | 11.731 | 18.940 | 4 | 17.700 / 17.700 |
| Reflections off | 720p | 3600 | 3.200 | 5.308 | 11.469 | 12.452 | 13.894 | 0 | 17.700 / 17.700 |
| Reflections off | 1080p | 3600 | 2.900 | 8.258 | 14.287 | 15.532 | 17.367 | 6 | 17.700 / 17.700 |
| TAA off | 720p | 3600 | 3.200 | 5.308 | 12.321 | 14.156 | 22.610 | 1 | 17.600 / 17.700 |
| TAA off | 1080p | 3600 | 3.300 | 8.192 | 14.680 | 15.794 | 21.627 | 12 | 17.300 / 17.600 |
| Resident GPU LOD | 720p | 3600 | 2.100 | 6.619 | 12.911 | 14.549 | 17.826 | 1 | 17.600 / 17.700 |
| Resident GPU LOD | 1080p | 3600 | 3.000 | 9.765 | 14.418 | 15.204 | 19.595 | 1 | 17.700 / 17.800 |

CPU submission, GPU execution and browser scheduling overlap; do not add their durations. GPU span is the earliest-to-latest executed pass boundary. It excludes preceding uploads/probe-preservation copies, browser composition and scanout. RAF measures callback cadence, not presented frames. Named pass durations can overlap and their sum is not elapsed GPU time.

All 36,001 captured RAF intervals were below 20 ms. There were no GPU errors, pending/dropped timestamp samples, failed page requests, missing-coverage tiles or geometry overflows. The all-on path nevertheless exceeded a 16.667 ms GPU span on 2/3,600 frames at 720p and 23/3,600 at 1080p; two 1080p spans exceeded 20 ms. These misses remain part of the result.

Disabling GI substantially reduces the measured workload. Disabling reflections or TAA does not produce a consistent whole-run percentile improvement here. Each mode was measured once per resolution in fixed order, so small differences are descriptive rather than causal pass costs. Do not subtract percentiles to estimate an isolated feature's cost.

| Height | Phase seconds | CPU p95 ms | GPU span p95/p99/max ms | Total upload MiB | Geometry fetch MiB | World changes |
|---:|---|---:|---|---:|---:|---:|
| 720 | 0–8 mirror-object-door | 3.500 | 13.959/15.729/18.612 | 49.916 | 0.688 | 240 |
| 720 | 8–26 indoor-light-transition | 1.000 | 8.978/14.615/18.547 | 5.717 | 3.938 | 3 |
| 720 | 26–57 outside | 1.100 | 7.471/12.190/14.025 | 11.726 | 10.062 | 0 |
| 720 | 57–60 return | 0.900 | 14.418/14.746/14.811 | 1.568 | 1.375 | 0 |
| 1080 | 0–8 mirror-object-door | 3.600 | 15.794/16.974/23.527 | 50.119 | 0.688 | 241 |
| 1080 | 8–26 indoor-light-transition | 0.900 | 15.139/16.581/20.644 | 5.654 | 3.875 | 3 |
| 1080 | 26–57 outside | 1.000 | 11.534/14.352/18.219 | 11.725 | 10.062 | 0 |
| 1080 | 57–60 return | 0.900 | 15.335/17.039/17.105 | 1.567 | 1.375 | 0 |

Resident GPU LOD uses a 5 MiB pool instead of 1 MiB and preloads all 80 pages. It removes all observed requested-detail fallback and steady page traffic, while preserving the GPU selection/error policy and texture allocations. Its larger worklists and higher displayed detail also affect costs. Visible tiles select finest throughout this close tour; this is not evidence of useful resident LOD savings. Offscreen shadow-caster LOD still depends on camera visibility; the quality follow-up addresses that limitation and repairs the separate resident-full reference.

Three earlier clean AC comparisons on `98e0af4` are retained separately. Their all-on GPU p95/p99 values were 12.648/14.549 ms at 720p and 14.615/15.991 ms at 1080p; 18 of 3,600 1080p GPU spans exceeded 16.667 ms. These are secondary observations, not pooled with the battery batch and not a controlled measurement of AC-versus-battery equivalence.

An earlier `2447b455` run is excluded from GPU timing evidence. Empty reflection trace passes left stale query pairs on this backend, producing false multi-second envelopes. The corrected renderer omits unexecuted trace passes and their query indices. Regression tests preserve genuinely long executed intervals; no duration filter sanitizes the results. The report validator requires trace timing exactly when that frame schedules candidates, while reconstruction remains timed. An AC-to-battery interrupted TAA comparison is also excluded.

## Representations, traffic and memory

The raster source has 131,072 terrain triangles and 156 exact room/object triangles. Terrain cooking produces 1,168 clusters in 80 pages totaling 5,242,880 bytes, with three pinned root pages totaling 196,608 bytes. Raster and shadows use the same selected geometry. Terrain and room share one camera, shadow pass, material/depth output, lighting composition and temporal presentation path.

Indirect rays retain a separate 2,048-triangle terrain proxy plus the same 156 room/object triangles. Its payload is 37,644 bytes; the combined 2,204-triangle, 1,335-node BVH uses 184,640 packed GPU buffer bytes and remains resident when raster detail pages evict. Source-manifest SHA-256: `818d7d020a608d59e83b334b1737ac655de545986e5a8a7494d76910a09c86ca`. Proxy-payload SHA-256: `84f04ccba50710badebe35de421b29bf830a113f6bfad65a18549ddea4afd3c4`.

The canonical proxy's maximum measured vertical error is 0.125506 m, with a conservative bound of 0.189596 m. Neither bounds normals, shadows, occlusion or lighting error. Raster normals are analytic; proxy normals are triangle facets. Hash linkage establishes byte identity, not the mathematical truth of arbitrary rewritten error metadata. Collision is absent. Probes cover the rooms and immediate boundary; outdoor GI is unsupported. Reflections select one metallic floor slab, one specular bounce and roughness up to 0.35.

All amounts in this table are bytes, except event/frame counts.

| Mode | Resolution | Peak GPU buffers | Peak GPU textures | Timed upload bytes | Fetched page bytes | Evictions | Frames with unavailable requested detail |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| All on | 720p | 1666964 | 75454464 | 72273936 | 16842752 | 252 | 3578/3600 |
| All on | 1080p | 1666964 | 146302464 | 72420192 | 16777216 | 251 | 3579/3600 |
| GI off | 720p | 1666964 | 75454464 | 72812976 | 17367040 | 264 | 3579/3601 |
| GI off | 1080p | 1666964 | 146302464 | 72812320 | 17367040 | 264 | 3578/3600 |
| Reflections off | 720p | 1666964 | 70385752 | 72683024 | 17170432 | 260 | 3578/3600 |
| Reflections off | 1080p | 1666964 | 134897752 | 72224592 | 16908288 | 253 | 3578/3600 |
| TAA off | 720p | 1666964 | 60708864 | 72675088 | 17104896 | 259 | 3578/3600 |
| TAA off | 1080p | 1666964 | 113124864 | 72215056 | 16842752 | 252 | 3577/3600 |
| Resident GPU LOD | 720p | 6664084 | 75454464 | 55942176 | 0 | 0 | 0/3600 |
| Resident GPU LOD | 1080p | 6664084 | 146302464 | 55942176 | 0 | 0 | 0/3600 |

Allocation counters describe requested application payloads, excluding driver/canvas/browser memory, JavaScript heap, alignment and allocator overhead. Terrain triangle counts are delayed and identify their `sourceFrameId`; total counts additionally include current room and fullscreen draws. Probe preservation copies move 983,040 bytes per submitted GI frame outside CPU upload counts and the timed pass envelope.

A frame with unavailable requested detail means at least one conservatively selected terrain tile uses fallback detail. It does not prove a visible pixel error in every such frame: terrain may be occluded and bounds can be loose. Nevertheless, coverage without holes does not establish the requested two-pixel quality target.

The streamed all-on path falls back on approximately 99.4% of captured frames and fetches about 16 MiB of terrain per minute despite a 5 MiB source. Resident LOD removes that pressure with 6,664,084 tracked buffer bytes versus 1,666,964, suggesting that the 1 MiB test budget is too aggressive for this asset's current levels and planner.

During the first eight seconds, 240/241 changed-world submissions at 720p/1080p imply 44,313,600/44,498,240 bytes of complete trace-buffer reuploads. That estimate follows the declared 184,640-byte payload; total uploads are measured at 52,340,336/52,553,088 bytes, while fetched geometry is only 720,896 bytes. Opening CPU p95 reaches 3.5/3.6 ms, compared with roughly 0.9–1.1 ms in other phases. Separating static terrain from moving-object trace updates is a concrete CPU/traffic experiment, tracked in #20.

## Functional and visual evidence

The full hardware and software harnesses on clean `98e0af4` each pass nine cases with no GPU errors/device losses and complete disposal. Fifty-nine rays through the production shared buffers agree with an independent plane/barycentric triangle oracle within 0.000001 m. A sampled analytic-heightfield witness differs by at most 0.068784 m; that sample is not the global proxy-error measurement. With 50 ms artificial page delays, a smaller 512 KiB pool and camera cuts, raster detail evicts while trace-buffer identity and ray results remain intact. Functional readbacks check primary/shadow quotas and traversal exhaustion; performance runs do not read these counters back.

A receiving-wall diagnostic contains zero visible terrain pixels. Changing only the matched raster/tracing terrain albedo from neutral to green changes the receiver's indirect color while direct lighting stays unchanged. This proves an offscreen contribution, not outdoor probe coverage. Cold-cache mirror hits and shared room/terrain material pixels are checked independently. Visible→offscreen→visible reflector tests verify omitted trace timing and resumed tracing.

A separate lighting diagnostic records 24 baseline, 240 sun-off and 240 sun-on submissions with TAA and reflections off. Camera, geometry, materials, proxy and trace buffers stay unchanged; diffuse cache epochs advance 1→2→3. The emissive object stays enabled. Last-24 indirect RGB energy averages 0.00002905 off and 0.287049 on. The first on submission exceeds the off-tail mean plus 10% of the observed on-minus-off range. Tail coefficients of variation are 8.21% off and 0.259% on. A retrospective ±20% tail criterion begins at off submission 217 with only 24 observations remaining, and at on submission 1 with 240 remaining. These bounded observations do not establish true convergence or milliseconds of latency at 60 FPS.

A separate replay records 30 PNGs across both internal resolutions at scene times 0, 3, 3.1, 4, 8, 16, 22, 26, 26.1, 27, 27.1, 40, 40.1, 53 and 59 seconds. It uses fixed 1/60-second simulation steps, the same 30-second warmup/restart and no additional held-time renders before each screenshot. Canvas CSS remains 1280×720 for both internal sizes. Screenshot pauses allow pending assets to finish; these images are visual evidence, not exact reproductions of the timed streaming schedule or performance measurements. This replay runs on AC after the battery batch, records the actual power state, and finishes with no GPU errors and zero tracked allocations after disposal.

Inspection confirms severe reflection speckling, dark loss of indirect illumination during object movement, coarse/faceted terrain and abrupt shadow boundaries. The settled mirror screenshot is also noisy. The user independently observed terrain changing shape, pervasive flicker and fuzzy lighting during the live timed tour. These are failed quality criteria, not dismissed as normal output.

Source review explains several mechanisms. The terrain switches entire 8×8 m tiles between steps 1/8/32/64 without a transition, and each topology change rejects TAA history. Offscreen terrain also changes to coarse shadow geometry when it leaves the camera frustum, including incorrectly in resident-full. Successful reflection-ray misses are excluded from accumulated history and replaced by the probe approximation, disrupting the rough-reflection estimator. Fixed 0.8 reflection history weight, quarter-axis reconstruction and camera-motion resets impose additional quality limits. These findings require independent before/after image tests; the current top-down coverage and offscreen-hit tests do not establish visual stability.

Every object/world edit currently resets the entire diffuse-probe epoch and restarts its update frontier at probe 0. At 32 updates per frame, continuous movement repeatedly updates the first 32 of 384 probes while invalidating the rest. The same update also resets whole-image TAA. This is a concrete starvation/reset defect, not just a slower convergence setting. Camera motion invalidates reflection accumulation because surface motion does not model reflected parallax. The benchmark's final time-zero screenshots separately accumulate 240 held-time updates when GI is enabled; they identify settings and must not be mistaken for moving-scene quality evidence.

## Decision and next experiments

Dynamic resolution is deferred. Only 0.64% of all-on 1080p spans exceed 16.667 ms, and even the fixed 720p run has occasional misses. Reducing resolution cannot correct shape replacement, probe starvation or invalid reflection accumulation; resize-induced history resets could aggravate those problems. The useful next experiments are visual correctness and bounded data updates, followed by a repeated integrated capture at the same target. No adaptive-resolution implementation or measured benefit is claimed here.

The remaining measured and structural blockers are tracked in [geometry refinement and churn #13](https://github.com/tylerstuff/strata/issues/13), [diffuse stability #15](https://github.com/tylerstuff/strata/issues/15), [reflection motion quality #17](https://github.com/tylerstuff/strata/issues/17), and [bounded moving-object trace updates #20](https://github.com/tylerstuff/strata/issues/20). Preserve the target and measure improvements on this same moving path instead of lowering the frame-rate requirement.

Visual stability takes priority over expanding authoring scope after the user reported terrain deformation, pervasive flicker and fuzzy lighting during the live tour. A stable full-detail reference is needed before changing streaming, and lighting changes require explicit error and lag measurements. Once those blockers improve, [agent-driven authoring #8](https://github.com/tylerstuff/strata/issues/8) can begin with an editable cooked-terrain raster profile: stable IDs, explicit assets, translation/uniform scale, opaque Lambert material, a free camera, directional shadows and optional TAA. The courtyard's fixed probe, proxy and reflector contracts cannot be silently generalized to arbitrary authored content. Files, TypeScript, CLI and a local connection should share one validated document model. [Large-world rendering #18](https://github.com/tylerstuff/strata/issues/18) remains a separate precision and bounded-residency task.

## Reproduction and external evidence

Use the cooking and runner commands in [the benchmark protocol](../benchmark.md#integrated-courtyard-comparisons), omitting `--require-ac-performance` for the declared battery profile. For each fixed comparison change only the named option above. Keep the documented camera, budgets, power profile, browser, warmup and duration. Raw JSON and PNGs remain under the local `~/Downloads/Strata-Benchmark-Results/` directory; the following hashes identify them without adding captures or asset content to Git.

| Configuration | Report relative to local results root | SHA-256 |
| --- | --- | --- |
| All on | `2026-09-05T04-07-14-586Z-26849/report.json` | `0cbe2e8b5357ff07e1dc4b7272c65780460e055f5839fa408284251b3bcd9519` |
| GI off | `2026-09-05T04-10-31-922Z-27571/report.json` | `6fdd9633e2397cfbc89c020115a30e53ec6ae9d9accca7642d9c5a3c6905fcb5` |
| Reflections off | `2026-09-05T04-13-42-091Z-28130/report.json` | `f464f5a67555f6276eb80ad16e702eddbbe6ffed7f577d9139492f0941fbb882` |
| TAA off | `2026-09-05T04-16-58-436Z-28979/report.json` | `cab345b5b0d66170b3da5d74f79a3b4878972c86e742d6701e7fdb2a20cf8344` |
| Resident GPU LOD | `2026-09-05T04-20-15-027Z-29576/report.json` | `08a5fcb997463bf1b22793555ed94cc0697edae90a5128a22ce58bdcd152772d` |
| Hardware functional | `2026-09-05T03-37-26.597Z-integrated-validation/report.json` | `41cf8553d27136bf3a2cc9b7762cfd515ae1be2bfbf50f2acafd27356c9be233` |
| Software functional | `2026-09-05T03-38-46.144Z-integrated-validation/report.json` | `20911bae7ab77eab6112a5ed60a03988919829c2ea239e8b2bd918b45350a51b` |
| Moving visual replay | `2026-09-05T04-24-51.649Z-integrated-tour-images/report.json` | `42c13eeea5ea24b2257cada9559d2a060d29454f4c2cd3fc0fb80a5937c3d759` |

Validation: 248 TypeScript unit tests, 25 Node tests, 12 Rust tests, typechecks, formatting, Clippy and package build pass. Packed HTML/Vite/SSR consumers pass. The final capture changes also pass software reflection smoke and a generated integrated 12-second smoke that reaches zero-candidate reflection frames; those local pre-commit checks are recorded as dirty source rather than mislabelled clean performance evidence. The complete remote runtime checks passed for the measured commit in [CI run 33943657629](https://github.com/tylerstuff/strata/actions/runs/33943657629), including the integrated software harness and 12-second report smoke. Subsequent report/status edits change documentation only.
