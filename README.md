# Strata

Strata is a browser game engine being designed for high-quality real-time graphics through a simple JavaScript/TypeScript package.

**Status: rendering, geometry and lighting experiments.** The package initializes WebGPU and a Rust/WASM worker, renders diffuse or textured PBR scenes, and records CPU/GPU telemetry. Directional shadows, temporal anti-aliasing and bounded static-terrain streaming are implemented. The terrain prototype includes a Rust cooker, GPU LOD selection and conventional mesh comparisons; it does not yet handle arbitrary imported meshes. A separate two-room experiment adds one-bounce world-space diffuse GI through software BVH tracing and a budgeted probe cache. A selected-mirror experiment adds bounded world-space reflections with an offscreen emissive object and independent reflection history. General scene integration and the editor remain planned. No npm package has been published and the final graphics performance target remains unverified.

## Try the foundation

With Node.js 22.13+ and rustup installed:

```sh
npm ci
npm run build
npm run example
```

Open `http://127.0.0.1:4173` in a browser with WebGPU. The example uses the built package directly; it needs no cross-origin-isolation headers. To create an archive for another website, run `npm pack --workspace @strata-engine/core` after building. Consumers receive precompiled WASM and need no Rust tools.

See [the runtime guide](docs/runtime.md) for the API, packaging, ownership, device loss, and validation commands. The API is experimental; TypeScript declarations currently target TypeScript 7+.

Run `npm run benchmark` for the hardware browser baseline or read [the benchmark protocol](docs/benchmark.md). Results and captures remain outside the repository. See [the raster guide](docs/raster.md) for PBR and [the virtual geometry guide](docs/virtual-geometry.md) for cooking, streaming and comparisons.

For the procedural lighting experiment, run `npm run benchmark -- --renderer gi` or see [the GI guide](docs/gi.md) for offscreen color transfer, door/light controls, quality budgets and limitations. For the selected mirror, use `npm run benchmark -- --renderer reflections`; the [reflection guide](docs/reflections.md) describes its controls and limits. The geometry and lighting experiments currently use different scenes.

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for the issue, pull-request, and validation workflow.

## Repository

- GitHub: <https://github.com/tylerstuff/strata>
- Local checkout: `~/code/strata`
- Default branch: `main`
- Working branches: `codex/<issue-number>-<short-description>`

This repository does not include copied Babylon or Unreal source. An open-source license has not yet been selected.
