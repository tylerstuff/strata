# Runtime foundation validation

Validation date: 2026-09-05. Scope: GitHub issue #1, package and lifecycle foundation.

## Local environment

| Component | Observed value |
| --- | --- |
| OS | macOS 26.5.2, arm64 |
| Node / npm | 22.23.0 / 12.0.2 |
| Rust | 1.98.0, pinned with wasm32-unknown-unknown |
| TypeScript | 7.0.2 |
| Browser | Installed Chrome 152.0.7977.82, isolated headless profile |
| Hardware adapter reported by WebGPU | Apple, metal-3, fallback false; detailed model unavailable |
| Separately tested software adapter | Google, SwiftShader, fallback true |
| Hosting | Local HTTP, no COOP/COEP; crossOriginIsolated false |

## Results

- Strict production TypeScript and installed-package declarations passed. The test configuration separately skips third-party declaration checking because of Vitest 5's own declaration conflicts; runtime and consumer declarations do not skip it.
- Rust formatting, Clippy with warnings denied, and two native lifecycle tests passed.
- All 46 TypeScript tests passed, covering GPU/worker lifecycle, partial initialization failure, cancellation races, late-resource disposal, device loss, actual compiled WASM, invalid ABI, and unshared per-instance state.
- A packed npm archive installed into temporary consumer projects outside the workspace, with no Rust tooling or package-install build hooks. Required JS, declarations, worker, and WASM files were present.
- Strict consumer type checking and SSR import with browser-global getters that throw both passed.
- Plain HTML ES modules and production Vite output both initialized the actual WASM module and rendered verified WebGPU clear-frame pixels. Both passed with the hardware adapter and the explicitly selected software adapter.
- Both consumers passed resizing, three initialization/disposal cycles, missing/corrupt WASM, a hanging WASM request, active cancellation, same-canvas recovery, worker-count cleanup, and unsupported-WebGPU checks.
- The standalone example initialized, disposed, and reinitialized without page errors. Its displayed WASM startup linear memory was 1,114,112 bytes.

Commands used for local checks:

```sh
npm run typecheck
npm run test:rust
npm run test:unit
npm run build
STRATA_TEST_BROWSER_CHANNEL=chrome npm run test:consumers
STRATA_TEST_BROWSER_CHANNEL=chrome STRATA_TEST_SOFTWARE_GPU=1 npm run test:consumers
```

The Playwright-managed browser download timed out locally. Installed Chrome was selected explicitly instead. GitHub Actions installs its own Chromium and selects software Vulkan/WebGPU with a virtual Xvfb display for functional checks. The image check captures the presented canvas, keeps its screenshot as evidence, and checks the expected clear color and dimensions.

Screenshots and environment JSON are generated under `test-results/` and are not committed. The CI workflow uploads consumer artifacts. These correctness tests do not measure rendering performance, establish a minimum laptop GPU, or validate the 60 FPS/visual-quality targets; those require the later benchmark and rendering tasks.
