# Strata

Strata is a browser game engine being designed for high-quality real-time graphics through a simple JavaScript/TypeScript package.

**Status: project initialization.** This repository records the architecture and development workflow. There is no implemented engine, runnable demo, published npm package, or measured performance result yet.

## Product requirements

- Render locally in an ordinary browser using WebGPU.
- Target 60 FPS on a representative laptop GPU, with Switch 2 games as a visual reference. The minimum GPU, browser, resolution, and test scenes still need to be defined and measured.
- Provide an ergonomic TypeScript API with precompiled Rust/WebAssembly internals and WGSL shaders. Consumers should not need Rust tooling or a custom WASM build step.
- Initialize WASM and workers through the engine API. Support ordinary hosting without mandatory shared-memory threading or cross-origin-isolation headers.
- Keep the visual editor separate from the embeddable runtime.
- Develop a custom renderer, combining rasterization with budgeted software-traced indirect lighting and selective reflections. Investigate streamed virtualized geometry through measurable prototypes.

## Architecture

| Layer | Planned implementation |
| --- | --- |
| Public package, browser integration, and initial WebGPU command submission | TypeScript |
| Dense CPU engine systems and asset processing | Rust compiled to WebAssembly; reuse suitable existing libraries |
| Rendering, culling, software ray traversal, and lighting filters | WGSL running through WebGPU |
| Editor | Separate TypeScript application/package |

Read [the architecture brief](docs/architecture.md) for the design boundaries and unresolved questions. Proposed npm names such as `@strata-engine/core` and `@strata-engine/editor` have not been reserved or published.

## Development tracking

[GitHub Issues](https://github.com/tylerstuff/strata/issues) is the source of truth for tasks, acceptance criteria, dependencies, and progress. [Milestones](https://github.com/tylerstuff/strata/milestones) group the initial work:

1. **M1 — Runtime foundation:** package consumption, the TypeScript/WASM boundary, and performance measurement.
2. **M2 — Rendering feasibility:** a conventional renderer and measured geometry, lighting, and reflection prototypes.
3. **M3 — Editor prototype:** an editor that consumes the runtime through supported APIs.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the issue and pull-request workflow. Build and installation instructions will be added when the runtime foundation exists.

## Repository

- GitHub: <https://github.com/tylerstuff/strata>
- Local checkout: `~/code/strata`
- Default branch: `main`
- Working branches: `codex/<issue-number>-<short-description>`

This repository does not include copied Babylon or Unreal source. An open-source license has not yet been selected.
