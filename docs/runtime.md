# Runtime foundation

The initial package implements WebGPU device/canvas initialization, an isolated Rust/WASM worker, one clear render pass, physical-pixel resizing, and disposal. It does not yet implement scenes, game systems, geometry rendering, lighting, or an editor. No performance target has been validated.

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

`resize(width, height)` takes positive integer physical pixels, subject to the requested device's maximum texture dimension. The application chooses resolution and pixel ratio. `render()` submits one clear pass; it creates no animation loop or persistent scene resources. `dispose()` is synchronous and idempotent: it unconfigures the canvas, destroys the device, terminates the worker, and releases the canvas claim. The application may initialize a new engine on the same canvas afterward.

Initialization failures release partially created resources. A device request that resolves after cancellation is destroyed when it arrives. Aborting the initialization signal after successful creation does not dispose a running engine; call `dispose()` explicitly.

`engine.info` describes the selected canvas format, enabled features, texture dimension limit, and CPU ABI/linear-memory size. WASM linear-memory bytes are not total browser memory or GPU memory.

## Device loss and errors

Device loss ends the current engine's usable lifetime. It releases the GPU configuration and CPU worker, changes `state` to `lost`, and prevents further rendering. Strata does not automatically reconstruct resources; the application creates a fresh instance. Explicit disposal changes the state to `disposed`.

`StrataError` exposes a stable `code` for unsupported WebGPU, adapter/device creation problems, invalid options, worker/WASM failures, initialization cancellation/deadline, and operations on a lost or disposed engine. Its message provides context; some underlying failures also retain an `Error.cause`. Applications should branch on `code`, not parse messages.

## Asset delivery and the CPU boundary

The distribution contains `index.js`, TypeScript declarations, `worker.js`, and `strata_runtime.wasm`. Default URLs are module-relative, including when installed as a package. The package is tested through a production Vite build and a plain HTML ES-module import. Other bundlers need equivalent support for module workers and static `new URL(..., import.meta.url)` assets.

Keep the worker same-origin with the page. Applications with a custom asset pipeline may set `workerUrl` and `wasmUrl`; relative overrides resolve against the document URL. Preserve the worker/WASM version pairing. A cross-origin WASM URL also needs a CORS response. Serving WASM as `application/wasm` is recommended, but the initial byte-buffer loader does not depend on that MIME type.

Sites with a Content Security Policy must allow their worker and WASM URLs and WebAssembly compilation. No CDN, third-party requests, COOP/COEP headers, shared memory, or native extension is required by default.

TypeScript owns WebGPU and browser orchestration. A module worker instantiates the precompiled Rust module, validates its ABI, and owns its unshared linear memory. The current ABI only establishes lifecycle and diagnostics. Future CPU jobs should cross this boundary in batches using packed transferable buffers, with explicit transfer and ownership; per-entity interop and computational features are deferred. Terminating the worker releases its entire WASM instance and heap. No threaded/shared-memory acceleration mode exists yet.

## Validation

```sh
npx playwright install chromium
npm run check
```

The checks cover type declarations, Rust formatting/Clippy/tests, actual WASM loading, browser/worker lifecycle and failure cleanup, and installation of a packed archive into isolated plain HTML and Vite consumers. Consumer tests verify ordinary hosting without cross-origin isolation, worker termination, real WebGPU clear-frame pixels, and SSR import without touching browser globals.

`npm run test:consumers` expects an existing build. It saves screenshots and browser/adapter details in `test-results/consumers/`. Linux CI explicitly uses a software WebGPU adapter with `STRATA_TEST_SOFTWARE_GPU=1` and headed Chromium on an Xvfb virtual display for canvas presentation; that validates functionality, not hardware performance. Real performance measurement belongs to GitHub issue #2.

If downloading the Playwright browser is unavailable, select installed Chrome with `STRATA_TEST_BROWSER_CHANNEL=chrome npm run check`. This uses a separate temporary browser profile.

Platform references: [WebGPU adapter creation](https://developer.mozilla.org/en-US/docs/Web/API/GPU/requestAdapter), [device loss](https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/lost), [Vite asset handling](https://vite.dev/guide/assets), and [Rust's browser WASM target](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html).
