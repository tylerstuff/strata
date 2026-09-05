# Certified terrain LOD experiment — 2026-09-05

The opt-in `certified` cooker profile adds intermediate terrain surfaces and tighter certified vertical error bounds. It improves some fixed-camera views at the unchanged 1 MiB pool, but **does not uniformly improve streaming quality** with the current priority-greedy page planner. It is not a closure of [#13](https://github.com/tylerstuff/strata/issues/13). The default recipe and source assets remain legacy.

## Asset and arithmetic checks

The canonical source remains seed 1337, 4×4 tiles, 64 cells per tile, 131,072 unique finest triangles. The integrated transform remains scale 0.125 and translation `[0,-1.625,0]`.

| Property | Legacy | Certified |
| --- | ---: | ---: |
| Total pages / bytes | 80 / 5,242,880 | 137 / 8,978,432 |
| Pinned root pages / bytes | 3 / 196,608 | 3 / 196,608 |
| Clusters | 1,168 | 1,904 |
| LOD cell steps | 1, 8, 32, 64 | 1, 2, 4, 8, 16, 32, 64 |
| Finest triangles | 131,072 | 131,072 |

Legacy manifest SHA-256 remains `818d7d020a608d59e83b334b1737ac655de545986e5a8a7494d76910a09c86ca`. The certified manifest is `46b9b87d83d846f18a147cc1d8d92f478d84fb9bae55768ceea40e57eed24953`. Every ordered pulled vertex stream, including normals and UVs, is identical for the shared steps 1/8/32/64. The finest stream hash is `7a7a8401d5146965fd9aff0b3551a806ec04692e89d3051fffadd564b2d2c78f`.

The certified tracing sidecar links to the exact new manifest bytes. Its 2,048-triangle, 37,644-byte proxy payload is unchanged (`84f04ccba50710badebe35de421b29bf830a113f6bfad65a18549ddea4afd3c4`); this cooker profile does not improve that separate tracing approximation.

| Step | All-terrain triangles | Pages for that LOD | Pages including pinned roots | Certified world vertical error across tiles, meters |
| --- | ---: | ---: | ---: | --- |
| 1 | 131,072 | 69 | 72 | 0 |
| 2 | 67,584 | 41 | 44 | 0.002642–0.002651 |
| 4 | 19,456 | 12 | 15 | 0.010426–0.010574 |
| 8 | 7,680 | 5 | 8 | 0.039947–0.041470 |
| 16 | 4,864 | 4 | 7 | 0.136270–0.159906 |
| 32 | 4,224 | 3 | 6 | 0.276510–0.530621 |
| 64 | 4,096 | 3 | 3 | 0.445399–0.966471 |

All step-4 terrain plus roots fits in 15 pages (983,040 bytes), but that is a capacity control, not an implemented runtime policy or evidence that step 4 meets every camera's error target. The interval proof and its supported arithmetic range are described in [the format documentation](../geometry-format.md). A six-test certificate suite covers edge-intersection extrema, independent interior/edge samples over several seeds, maximum coordinate/root bounds, changed-topology rejection, legacy identity, and all supported profile packing counts. Existing area/manifold-boundary/neighbor tests now include every certified step. All 16 cooker tests and Clippy passed; real-cooker TypeScript tests validate seven/eight LODs, every page, and exact tracing-proxy manifest linkage. An independent code review found no concrete certificate defect.

## Controlled fixed-camera images

The local diagnostic used Chrome 152.0.7977.82 on an Apple M2 host, requesting the default WebGPU adapter. Adapter-info fields were not serialized by this harness; these are functional image observations, not timing or cross-device performance evidence. No software-GPU flags were used.

Both assets used the same bundled production renderer, selection/compaction shader, page cache, Lambert material and directional light. The source base was `c5ab592`, which contains the corrected `resident-full` offscreen shadow policy. The external test bundle SHA-256 is `6cfb588eb1097991b588bca11e4559152a91403fb6eac4e9201db46e5dc0e797`. Only cooker/tests/docs changed in the working tree. The test isolates terrain: room geometry, GI, reflections and TAA are absent. Shadows remain enabled. The production integrated camera was frozen at tour times 26, 33, 40 and 47 seconds at 1280×720, pixel error 2.

Each streamed case starts with a fresh 16-page (1,048,576-byte) pool and three pinned roots. Four page requests and four page uploads per frame are allowed, with no artificial network delay. The initial image is recorded before any detail upload. The settled image requires no pending request or completed upload and four consecutive matching actual GPU selections; one additional frame must leave depth and direct-light output exactly unchanged. Full camera matrices, per-tile desired/selected LODs, actual residency, counts and raw depth/normal/HDR buffers are saved. Every streamed settled case used exactly 16 pages; there were no failed pages, coverage failures, work-list overflows or GPU errors.

The two assets' fully resident finest depth, normal and HDR buffers are byte-identical at all four cameras. Their initial coarse buffers are also byte-identical. This establishes an unchanged base surface and a controlled reference; it does not eliminate differences caused by selecting other surfaces. Every comparison below uses the same legacy `resident-full` reference for its camera.

Depth error is absolute **view-depth difference at matching covered pixels**, not the source-space vertical certificate. Normal error is angle between interpolated world normals. Direct error is mean absolute linear HDR RGB difference, before tone mapping. Silhouette counts are pixels covered by only one of the two images; they are not evidence of cracks. Occlusion boundaries can produce large depth maxima, which are retained in the external report.

| Tour time | Asset / mode | View-depth error p95, cm | Normal error p95, degrees | Linear direct RGB MAE | Silhouette pixels | Submitted raster triangles |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 26 | Legacy / streamed | 4.427 | 1.435 | 0.0018065 | 167 | 4,928 |
| 26 | Certified / streamed | 1.012 | 0.329 | 0.0004002 | 59 | 6,336 |
| 26 | Certified / resident-lod | 0.558 | 0.169 | 0.0000571 | 22 | 12,480 |
| 33 | Legacy / streamed | 35.522 | 9.616 | 0.0037378 | 304 | 7,712 |
| 33 | Certified / streamed | 35.522 | 9.616 | 0.0037378 | 304 | 7,712 |
| 33 | Certified / resident-lod | 1.415 | 0.377 | 0.0002267 | 51 | 12,864 |
| 40 | Legacy / streamed | 6.903 | 1.701 | 0.0018459 | 405 | 6,816 |
| 40 | Certified / streamed | 4.717 | 1.588 | 0.0026807 | 2,528 | 7,104 |
| 40 | Certified / resident-lod | 1.881 | 0.480 | 0.0005989 | 225 | 10,304 |
| 47 | Legacy / streamed | 32.839 | 20.802 | 0.0254202 | 1,272 | 4,512 |
| 47 | Certified / streamed | 90.461 | 25.120 | 0.0273672 | 2,580 | 5,696 |
| 47 | Certified / resident-lod | 1.968 | 0.559 | 0.0007986 | 149 | 9,408 |

At 26 seconds, both planners keep tiles 2 and 6 finest; certified replaces visible step-8 tiles 3 and 7 with step 4. At 33 seconds the settled geometry is identical despite different error metadata. At 40 seconds certified improves some middle-distance tiles to step 4 but leaves six other visible tiles at the root instead of legacy step 8. At 47 seconds, both keep tiles 8 and 12 finest; certified spends remaining pages on step-4 tiles 5/6/9 while several visible tiles, including 13/14/15, remain at the root rather than legacy step 32. The latter frame is visibly more deformed. More submitted triangles is not sufficient evidence of a better view.

Certified `resident-lod` has no missing desired detail and provides a useful quality control, but preloads all 137 pages: it is not a 1 MiB result. The existing stateless priority plan can starve broad visible coverage, and it protects desired pages rather than retaining complete active LODs until replacements are ready. Those allocation and transition problems require separate work. This experiment does not measure moving-camera popping, improve temporal history, add retention, or increase the streamed budget.

Evidence remains external at `~/Downloads/Strata-Benchmark-Results/2026-09-05T05-17-32.710Z-certified-terrain-fixed-camera/`: `report.json` (SHA-256 `b09db16d2493413644d306f61943294294c2ed094fd3ec2902e542f90b0ed295`), the exact bundled diagnostic plus source/runner, and direct/normal/depth PNGs and raw buffers for every capture. Assets remain under `~/Downloads/Strata-Cooked-Geometry/`, outside Git. Earlier CPU overlay/dense-sample and demand ledgers are under the external `experiments/2026-09-05T04-46-43Z-terrain-lod-quality-s1337-t4-c64/` directory. None of these outputs are published by this change.
