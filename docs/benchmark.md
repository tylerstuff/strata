# Browser benchmark protocol

The initial workload is `procedural-boxes-v1`: 512 seeded boxes plus a ground box, one instanced draw, 6,156 triangles, diffuse directional shading and a depth buffer. Seed 1337 and `orbit-20s-v1` define the geometry and a repeating 20-second camera path. This is a renderer baseline, not a representative finished game or a demonstration of the final graphics target.

## Run locally

```sh
npm ci
npm run build
npm run benchmark
npm run benchmark:sustained
```

The runner opens installed Chrome in a separate temporary profile, headed, on the hardware WebGPU adapter. The normal run measures 1280×720 then 1920×1080. Each resolution gets 30 seconds of shader/runtime warm-up followed by 60 seconds of moving-camera capture. The sustained run measures 1080p for 180 seconds after 30 seconds of warm-up. Keep the tab visible, connect AC power, record the chosen power profile and close competing GPU workloads where practical. Never silently change the user's power settings. A hidden tab cancels the run; a known software adapter is rejected for performance runs.

See [the initial M2 baseline](benchmarks/2026-09-05-m2-baseline.md) for the first hardware evidence and [the raster guide](raster.md) for feature comparisons.

Results and camera-time-zero PNGs go to `~/Downloads/Strata-Benchmark-Results/<timestamp>/`, outside Git. Override with `--output /external/results`; `--device-label` can record a useful machine label. Capture images only after timing stops. Images identify scene settings; their CSS screenshot size is recorded separately from the internal render resolution. `--warmup`, `--duration`, `--seed` and `--instance-count` support experiments but must match between comparisons. The benchmark page can also be opened through `npm run benchmark:serve` and saves a single-run JSON from its UI.

`STRATA_TEST_BROWSER_CHANNEL=chrome npm run benchmark:smoke` uses short 0.25-second warm-up and 1-second captures for functional checks. CI explicitly selects software WebGPU and a headed Chromium virtual display. Smoke timings are never hardware performance evidence, and CI uploads no benchmark results or model files.

## What the measurements mean

- `frameIntervalMs` pairs each submitted frame with the following `requestAnimationFrame` callback, including the final callback. It measures callback cadence, not scan-out, GPU completion or uncapped throughput. Vsync can keep a very cheap scene near 60 callbacks per second; FPS alone does not indicate remaining GPU capacity.
- `cpuSubmissionMs` measures engine command encoding and queue submission. It excludes the benchmark's bookkeeping, browser event loop, compositing and GPU execution. Allocation and submission work in `render` is included.
- `gpuPassMs` uses asynchronous WebGPU pass timestamps when available. Timestamp precision and quantization depend on the browser. Zero is a valid measured value; unavailable samples stay `null`. No per-frame GPU wait is inserted. A bounded readback ring and queue report dropped samples, so sample coverage must accompany percentiles. Final readback waits occur outside the measured window.
- Percentiles use nearest rank. Reports include p50/p95/p99, mean, min, max, sample counts and callback intervals above 20 ms. The agreed 60 FPS target corresponds to 16.67 ms. The 20 ms counter tolerates normal callback jitter and is descriptive, not a substitute target.
- Cold initialization and scene creation/compilation are recorded separately. Warm-up precedes every capture, and the measured camera restarts at time zero. This is a fresh engine in a running browser process, not a cold disk/OS/driver-cache test. Browser shader caches may survive between runs.
- `steadyUploadBytes` counts explicit engine uploads during capture. Document resource-transfer totals describe page loading, may include cached zeros, and exclude worker-internal resource timing. This procedural scene has no model-streaming traffic.
- GPU allocation bytes count explicitly requested application buffers and textures, including depth and profiling buffers. WASM bytes describe linear memory. These values exclude swapchain, query-set/driver overhead, browser memory and JavaScript heap; they are not total VRAM or physical residency measurements. This baseline retains all its small geometry.

The session format is [result.schema.json](../benchmarks/result.schema.json). It contains machine/browser/source metadata and one or more runs with raw frame samples. Adapter details are preserved exactly as exposed: empty strings and `null` are unavailable values, never guessed device names. Machine metadata supplements restricted browser strings. Session metadata includes commit and dirty state, launch arguments, display and render resolutions, requested features/limits, power samples and thermal-warning observations. macOS `pmset` is a warning/limit probe, not a temperature measurement or proof that throttling did not occur. Other systems need manual power/thermal notes where automatic probes are unavailable.

## Compare later features

Preserve the baseline scene and camera version. For a new path, record a separate render-path ID and all quality controls; measure the baseline and feature path at the same resolution, seed, instance count, power state, browser version, warm-up and capture duration. Keep raw local reports. Compare callback tails, CPU submission, per-pass GPU samples/coverage, upload traffic, tracked allocations and camera-matched images. Repeat full captures when a difference is close to noise; avoid judging regressions from one screenshot or one short run. Use sustained results before making laptop claims. Later integrated geometry/GI/reflection tests must use representative scenes before deciding whether the original 60 FPS ambition is met.

## External local assets

Set `STRATA_BENCHMARK_ASSET_DIR=/absolute/external/collection` to expose a local collection through the loopback benchmark server. `/benchmark-config.json` reports whether it is available and the catalog URL. It does not expose the absolute path. The server streams from the external directory with path and symlink containment checks; it never copies source files. The current procedural scene does not import those assets.

Read [the asset policy](benchmark-assets.md), then the collection's `README.md` and `catalog.json` before choosing model entry points. Models, textures, archives, derived/converted assets and cooked copies must remain outside the repository, Git LFS, releases and CI artifacts. The server refuses external asset roots in CI. No claim about those models follows from this procedural baseline.

## Cooked geometry comparison

The [virtual geometry protocol](virtual-geometry.md#local-measurements) extends this runner with external manifests, manifest hashes, a capped streaming pool, fully resident GPU modes and a conventional mesh/LOD reference. Keep source, camera, error target, shadows, temporal filtering and resolution fixed across comparisons. Report achieved error and delayed feedback alongside timing, because streamed fallback can preserve coverage while temporarily using less detail. `npm run test:geometry` exercises fresh temporary procedural fixtures on the actual browser GPU; it is functional validation, not performance evidence.
