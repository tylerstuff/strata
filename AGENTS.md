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

The repository currently contains planning and workflow files only. Do not describe proposed APIs, packages, tools, or rendering features as implemented.
