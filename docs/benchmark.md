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

On macOS, `--require-ac-performance` requires confirmed AC Power with active Low Power Mode off. All performance captures reject an observed change in power source or active profile. The inactive battery profile does not determine AC behavior. Sampling cannot detect changes entirely between observations.

See [the initial M2 baseline](benchmarks/2026-09-05-m2-baseline.md) for the first hardware evidence and [the raster guide](raster.md) for feature comparisons.

Results and camera-time-zero PNGs go to `~/Downloads/Strata-Benchmark-Results/<timestamp>/`, outside Git. Override with `--output /external/results`; `--device-label` can record a useful machine label. Capture images only after timing stops. Images identify scene settings; their CSS screenshot size is recorded separately from the internal render resolution. `--warmup`, `--duration`, `--seed` and `--instance-count` support experiments but must match between comparisons. The benchmark page can also be opened through `npm run benchmark:serve` and saves a single-run JSON from its UI.

`STRATA_TEST_BROWSER_CHANNEL=chrome npm run benchmark:smoke` uses short 0.25-second warm-up and 1-second captures for functional checks. CI explicitly selects software WebGPU and a headed Chromium virtual display. Smoke timings are never hardware performance evidence, and CI uploads no benchmark results or model files.

## What the measurements mean

- `frameIntervalMs` pairs each submitted frame with the following `requestAnimationFrame` callback, including the final callback. It measures callback cadence, not scan-out, GPU completion or uncapped throughput. Vsync can keep a very cheap scene near 60 callbacks per second; FPS alone does not indicate remaining GPU capacity.
- `cpuSubmissionMs` measures engine command encoding and queue submission. It excludes the benchmark's bookkeeping, browser event loop, compositing and GPU execution. Allocation and submission work in `render` is included.
- `gpuPassMs` sums asynchronous WebGPU pass durations when available. Pass intervals can overlap, so this sum is not elapsed GPU frame time. `gpuPassIntervals` preserves each pass's start/end relative to the earliest recorded boundary; `gpuSpanMs` measures the envelope from that boundary to the latest recorded end. The envelope includes between-pass gaps but excludes uploads/copies before the earliest pass, browser composition and scan-out. It is not a presentation fence or a measurement of GPU utilization. Older reports have pass sums only and cannot retrospectively establish elapsed GPU time.
- Timestamp precision and quantization depend on the browser. Zero is a valid measured value; unavailable samples stay `null`. The profiler subtracts uint64 timestamp origins before converting offsets to JavaScript numbers, retaining small differences at large clock values. No additional GPU queries or per-frame waits are needed for intervals. A bounded readback ring and queue report dropped samples, so sample coverage must accompany percentiles. Final readback waits occur outside the measured window. The [WebGPU group's timestamp discussion](https://github.com/gpuweb/gpuweb/wiki/GPU-Web-2023-11-08#problem-measuring-time-deltas-with-writetimestamp-3952) explains ordering limitations and comparisons across dependent passes.
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

## World-space GI comparison

`npm run benchmark -- --renderer gi --gi on --require-ac-performance` captures `two-room-software-gi-v1`; repeat with `--gi off` for the identical direct-only fixture. The scene has 132 triangles, a fixed probe seed of 1337 and no external assets. `--camera overview` is the default; `receiver` and `tour` restrict the camera to the shadowed receiving room. `--probes-per-update 32 --rays-per-probe 64` sets the default 2,048 primary rays and at most 2,048 shadow rays per update. Keep these budgets in every comparison.

The default `--gi-scenario door-light` repeats every 60 seconds: start with the red wall, open door and full light; close at 10 seconds, reopen at 20, dim to 0.2 at 30, restore at 40 and switch to a neutral wall at 50. `--gi-scenario static` holds the initial state. World changes invalidate the probe epoch, temporarily darkening indirect light while the cache repopulates. Per-frame state/epoch telemetry identifies these transitions. Warm-up state precedes the measured cycle; the separate cold-cache harness measures first response and convergence. Changing callback cadence changes the number of probe updates available per second.

The three additional named compute passes are `gi-trace`, `gi-update` and `gi-shade`. Atlas preservation copies before the first pass are outside both pass sums and the recorded envelope. GI-off skips these passes but retains trace/probe allocations; a fresh off run never allocates the composition target. The performance screenshot resets the world cache at camera time zero and submits 240 held-time updates after the reset (smoke mode uses eight and is not a convergence check); that is outside the measured window, and the count is recorded. These images show the default budget's finite accumulation window, not an unbiased reference solution. Read [the GI guide](gi.md) for filtering, thin-wall/visibility limits and supported materials.

`npm run test:gi` runs the exact BVH/SDF comparison, cache tests and rendered offscreen/door/light validation. `npm run test:gi -- --measure` runs an isolated hardware representation microbenchmark with named ray distributions; its timings do not establish total-frame GI cost. CI runs functional validation only and uploads no raw GI evidence.

Smoke mode allows a bounded 30-second final timestamp flush for software adapters; performance mode retains the five-second deadline. The flush occurs after measurement. The small-resolution GI validation harness separately checks 240-frame convergence; full-resolution smoke screenshots check package/render/report operation only.
