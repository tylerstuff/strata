# Runtime foundation

The package implements WebGPU device/canvas initialization, an isolated Rust/WASM worker, diffuse/PBR rendering, bounded static-terrain streaming, experimental two-room world-space GI and selective reflections, an integrated streamed courtyard with a persistent tracing proxy, CPU/GPU telemetry, physical-pixel resizing, and disposal. General imported virtual geometry, general integrated lighting, game systems and the editor remain planned. See [the raster guide](raster.md), [virtual geometry guide](virtual-geometry.md), [GI guide](gi.md) and [reflection guide](reflections.md), and [integrated courtyard guide](integrated.md) for each restricted scene path. The final graphics performance target is unverified.

## Build and run

Engine contributors need Node.js 22.13 or newer, npm, and [rustup](https://rustup.rs/). `rust-toolchain.toml` pins the compiler and WASM target. The repository lockfiles pin JavaScript and Rust dependencies. TypeScript consumers use TypeScript 7+ and its built-in WebGPU DOM types; no separate WebGPU declaration package is needed.

```sh
npm ci
rustup show
npm run build
npm run example
```

Open `http://127.0.0.1:4173`. The example imports the built ESM package directly, starts a module worker, and exercises initialization and disposal. Its resize listener belongs to the example application.

To build an installable archive:

```sh
npm run build
npm pack --workspace @strata-engine/core
```

Install the resulting `.tgz` in the consuming website. Installing the archive does not run Rust, generate bindings, or compile WASM. The npm package name remains unreserved and unpublished.

## API and ownership

```ts
import { createEngine } from '@strata-engine/core';

const engine = await createEngine({
  canvas,
  powerPreference: 'high-performance',
  initializationTimeoutMs: 30_000,
});

engine.resize(1280, 720);
engine.render();
console.log(engine.state, engine.info);
engine.dispose();
```

`createEngine` is asynchronous. Optional `requiredFeatures` and `requiredLimits` are requested from WebGPU and may cause initialization to fail when unsupported. `signal` cancels initialization; the deadline bounds the whole initialization process. An import has no browser side effects.

The application owns the canvas element, its CSS layout, and its animation/resize callbacks. Strata exclusively owns the canvas's WebGPU configuration while an engine is active, creates and owns its GPU device, and owns one CPU worker with unshared WASM memory. A second concurrent engine cannot claim the same canvas. Do not reconfigure that canvas or change its backing dimensions behind the engine.

`resize(width, height)` takes positive integer physical pixels, subject to the requested device's maximum texture dimension. The application chooses resolution and pixel ratio. `render()` submits a clear pass when no scene is selected. `await engine.setScene({seed: 1337, instanceCount: 512})` installs the procedural diffuse baseline; `render({timeSeconds})` then renders its deterministic camera path. `setScene(null)` releases scene resources and returns to clear rendering. Scene replacement is atomic and superseded asynchronous requests fail explicitly. `setScene` now returns an immutable `SceneCommitReceipt`; this changes explicitly typed `Promise<void>` wrappers. A receipt means committed, not rendered. `FrameMetrics.scene` and `getTelemetry().scene` separately identify submitted frames. See [authored-boxes.md](authored-boxes.md) for generation, cancellation and post-commit retirement semantics. The application owns the animation loop. `dispose()` is synchronous and idempotent: it unconfigures the canvas, destroys the device, terminates the worker, and releases the canvas claim. The application may initialize a new engine on the same canvas afterward.

`setScene({ renderer: 'virtual', manifestUrl })` loads a cooked analytic terrain scene. It fetches and validates the manifest plus pinned coarse pages before replacing the active scene, then streams optional detail asynchronously. Its optional `signal` cancels scene creation; replacement or engine disposal cancels owned loading work. Geometry counters in `getTelemetry()` identify their `sourceFrameId`; GPU feedback can lag the current submitted frame. See the geometry guide for pool, LOD, debug and comparison settings.

Initialization failures release partially created resources. A device request that resolves after cancellation is destroyed when it arrives. Aborting the initialization signal after successful creation does not dispose a running engine; call `dispose()` explicitly.

`setScene({ renderer: 'gi', probesPerUpdate: 32, raysPerProbe: 64 })` creates the shared two-room raster/trace fixture. `render({ gi: { doorOpen: false, lightIntensity: 1 } })` patches its persistent world state. Changes invalidate the world cache and temporal history; camera cuts reset only screen history. `gi.enabled: false` pauses tracing/composition while retaining owned allocations. This experiment has a small exact triangle BVH built/refitted in TypeScript; its 132-triangle CPU work does not justify a WASM job boundary. GPU tracing, directional probe updates and shading run in WGSL. Debug views and per-frame `gi` telemetry expose budgets and epochs, with unmeasured GPU quantities explicitly null.

`engine.info` describes the selected canvas format, enabled features, texture dimension limit, and CPU ABI/linear-memory size. WASM linear-memory bytes are not total browser memory or GPU memory.

`setScene({ renderer: 'reflections', resolutionScale: 0.25, maxRaysPerFrame: 32768 })` creates the shared room plus a selected metallic floor mirror and an offscreen emissive cube. `render({ reflections: { mode: 'world', objectOffset: 0.4, roughness: 0.08 } })` patches persistent reflection/world controls; modes `off` and `probe-only` provide matched baselines. `gi.enabled` independently controls diffuse probe work. Reflection-only and source debug views bypass screen TAA. Object/roughness changes reset world and reflection histories; camera cuts reset screen/specular history while retaining diffuse probes. `FrameMetrics.reflections` and `getTelemetry().reflections` identify budgets, allocations and the source submission. This remains a restricted opaque-scene proof, with no arbitrary scene-authoring API.

`setScene({ renderer: 'integrated', manifestUrl, traceProxyUrl })` loads the fixed courtyard source and hash-linked coarse tracing sidecar. Both load paths are bounded before parsing. Terrain and room share one camera, shadow map, MRT set, lighting composition and TAA; render-detail eviction never removes the persistent trace proxy. Existing GI/reflection controls remain available. `FrameMetrics.integrated` describes representation counts, proxy identity/error metadata and absent collision support. Terrain triangle counts are delayed GPU feedback; their source frame does not date the current room/fullscreen contribution. See [integrated.md](integrated.md) for the fixed source/transform/material/probe restrictions. This path does not expose arbitrary scene editing.

## Device loss and errors

Device loss ends the current engine's usable lifetime. It releases the GPU configuration and CPU worker, changes `state` to `lost`, and prevents further rendering. Strata does not automatically reconstruct resources; the application creates a fresh instance. Explicit disposal changes the state to `disposed`.

`StrataError` exposes a stable `code` for unsupported WebGPU, adapter/device creation problems, invalid options, worker/WASM failures, initialization cancellation/deadline, and operations on a lost or disposed engine. Its message provides context; some underlying failures also retain an `Error.cause`. Applications should branch on `code`, not parse messages.

## Asset delivery and the CPU boundary

The distribution contains `index.js`, TypeScript declarations, `worker.js`, `strata_runtime.wasm`, and ESM chunks for optional renderers/shared code. Publish or copy the complete `dist` directory: renderer modules load on first use, so copying only `index.js` is insufficient. The default engine/diffuse path does not fetch the GI or reflection renderer; selecting GI also leaves reflections unloaded. Selecting any separate proof leaves the integrated terrain adapter unloaded. Default worker/WASM URLs are module-relative, including when installed as a package. The package is tested through a production Vite build and a plain HTML ES-module import. Other bundlers need equivalent support for dynamic ESM imports, module workers and static `new URL(..., import.meta.url)` assets.

Keep the worker same-origin with the page. Applications with a custom asset pipeline may set `workerUrl` and `wasmUrl`; relative overrides resolve against the document URL. Preserve the worker/WASM version pairing. A cross-origin WASM URL also needs a CORS response. Serving WASM as `application/wasm` is recommended, but the initial byte-buffer loader does not depend on that MIME type.

Sites with a Content Security Policy must allow their worker and WASM URLs and WebAssembly compilation. No CDN, third-party requests, COOP/COEP headers, shared memory, or native extension is required by default.

TypeScript owns WebGPU and browser orchestration. A module worker instantiates the precompiled Rust module, validates its ABI, and owns its unshared linear memory. CPU ABI and worker protocol version 2 support an internal, cancellable static imported BVH job using coarse batches and copied transferable buffers. Its source restrictions, packed format, ownership and memory estimates are documented in [static tracing preparation](imported-static-bvh.md); this preparation alone does not enable imported GI. Future dense CPU jobs should use the same coarse ownership boundary. Terminating the worker releases its entire WASM instance and heap. No threaded/shared-memory acceleration mode exists yet.

## Validation

```sh
npx playwright install chromium
npm run check
```

The checks cover type declarations, Rust formatting/Clippy/tests, actual WASM loading, browser/worker lifecycle and failure cleanup, and installation of a packed archive into isolated plain HTML and Vite consumers. Contributor tests cook a fresh small procedural terrain fixture outside the repository; installed consumers still receive precompiled WASM and need no Rust tooling. Consumer tests verify ordinary hosting without cross-origin isolation, worker termination, real WebGPU clear-frame pixels, optional GI/reflection/integrated package rendering and disposal, and SSR import without touching browser globals.

`npm run test:consumers` expects an existing build. It saves screenshots and browser/adapter details in `test-results/consumers/`. Linux CI explicitly uses a software WebGPU adapter with `STRATA_TEST_SOFTWARE_GPU=1` and headed Chromium on an Xvfb virtual display for canvas presentation; that validates functionality, not hardware performance. The benchmark smoke test validates real geometry pixels and JSON contracts; its screenshots/reports stay outside the repository and CI artifacts. Read [the benchmark protocol](benchmark.md) for hardware performance runs.

If downloading the Playwright browser is unavailable, select installed Chrome with `STRATA_TEST_BROWSER_CHANNEL=chrome npm run check`. This uses a separate temporary browser profile.

Platform references: [WebGPU adapter creation](https://developer.mozilla.org/en-US/docs/Web/API/GPU/requestAdapter), [device loss](https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/lost), [Vite asset handling](https://vite.dev/guide/assets), and [Rust's browser WASM target](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html).

## Profiling

Pass `profiling: true` to request optional timestamp queries. An unsupported optional feature falls back to CPU/counter telemetry with an explicit reason in `engine.info.profiling`; explicitly required features never silently fall back. `render` returns per-frame CPU submission time, draw/dispatch/triangle counts, upload bytes and requested GPU buffer/texture bytes. `getTelemetry()` reports cumulative counters, WASM memory, GPU readback drops and uncaptured GPU errors. Uncaptured errors prevent further rendering; dispose and recreate the engine.

`drainGpuTimings()` returns completed `{frameId, pass, gpuMs, startOffsetMs, endOffsetMs}` values without waiting. Offsets are relative to the earliest recorded GPU boundary for that frame and preserve overlapping passes; summing durations does not yield elapsed frame time. Call it regularly to avoid overflowing the bounded result queue. `flushGpuTimings(timeoutMs?)` waits for pending samples only at capture boundaries, with a 5-second default deadline. GPU measurements can be quantized to zero. Missing samples must remain unavailable. Profiling overhead is part of the selected configuration; tracked buffers/textures are not total VRAM. Adapter features, adapter/device limits and available browser adapter strings are preserved in `engine.info`.

`waitForIdle(timeoutMs?)` waits for GPU work submitted before the call, including when profiling is disabled. Its default deadline is 5 seconds. Use it at capture or shutdown boundaries; it does not submit frames or guarantee browser presentation. Invalid deadlines, timeouts, and queue failures have distinct error codes, and disposal or device loss during the wait still rejects.

The profiler has four asynchronous slots, each supporting up to ten named passes (1,280 bytes of requested resolve/readback buffer payload in total). The default GI + world-reflection + TAA path records up to nine passes; the integrated GPU geometry path adds selection for up to ten. Frames without reflection candidates omit the trace pass and its timestamps. Unused capacity does not create additional passes or waits.
