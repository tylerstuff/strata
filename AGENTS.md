# Working on Strata

Read README.md and docs/architecture.md before changing engine design. This is a standalone browser engine, not a Babylon fork or a native desktop engine.

- Use GitHub Issues as the task tracker. Reference the relevant issue in implementation PRs and record validation there. Do not replace the tracker with a separate local backlog.
- Preserve the simple TypeScript package interface. Ship precompiled WASM and manage initialization internally; consumers must not need Rust tooling.
- Keep dense CPU work in Rust/WASM where appropriate, GPU work in WGSL, and browser/editor integration in TypeScript. Benchmark language boundaries and avoid fine-grained per-entity interop.
- Default to ordinary browser deployment. Shared-memory threading is an optional mode, not a hidden prerequisite.
- Keep the editor out of runtime bundles and large optional systems independently loadable.
- Treat 60 FPS on a representative laptop and Switch 2-inspired visual quality as unverified targets. Record named hardware and total-frame evidence before making performance claims.
- Browser WebGPU feature support determines available GPU functionality. Native-only Rust wgpu or graphics API features do not become available through WASM.
- Use `codex/<issue-number>-<description>` working branches. Do not overwrite unrelated work. Run meaningful checks for the change; document unavailable checks honestly.
- Keep the Sketchfab benchmark collection local and outside this repository. Never commit or upload its models, textures, archives, converted/derived files, or cooked copies to GitHub, Git LFS, releases, or CI artifacts. Future benchmark tooling must accept a configurable external asset path; read docs/benchmark-assets.md before asset work.

The runtime currently implements initialization, a Rust/WASM worker, optional procedural raster rendering, CPU/GPU telemetry, resize, and disposal. Advanced graphics remain planned. Read docs/benchmark.md for measurement and external-result rules. Read docs/runtime.md for build, package, ownership, and validation details. Use `npm run check` for the complete checks; consumer tests require a browser with WebGPU and a built package. Do not describe planned graphics features or performance targets as implemented or achieved.
