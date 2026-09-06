# Strata

Strata is a browser game engine being designed for high-quality real-time graphics through a simple JavaScript/TypeScript package.

**Status: rendering, geometry and lighting experiments.** The package initializes WebGPU and a Rust/WASM worker, renders diffuse or textured PBR scenes, and records CPU/GPU telemetry. Directional shadows, temporal anti-aliasing and bounded static-terrain streaming are implemented. The terrain prototype includes a Rust cooker, GPU LOD selection and conventional mesh comparisons; it does not yet handle arbitrary imported meshes. A separate two-room experiment adds one-bounce world-space diffuse GI through software BVH tracing and a budgeted probe cache. A selected-mirror experiment adds bounded world-space reflections with an offscreen emissive object and independent reflection history. A restricted courtyard combines streamed terrain, exact room geometry, GI and reflections, with a persistent coarse terrain tracing proxy. General scene authoring remains planned. No npm package has been published. The [first integrated M2 result](docs/benchmarks/2026-09-05-m2-integrated.md) records near-60-Hz callback cadence with occasional GPU-budget misses and substantial visible artifacts; the game-quality performance target is not achieved. Visual stability is the next priority.

Optional [authoring tooling](docs/authoring.md) provides versioned scene documents, typed edits and a noninteractive CLI. The separate [preview package](docs/preview.md) lowers supported opaque procedural root boxes into Core and captures revision-bound browser feedback. Its optional [local stdio connection](docs/preview-connection.md) controls one preview session with fixed project and capture roots; the installed connection passed restricted browser acceptance. A [saved-project builder](docs/project.md) packages that procedural profile as an ordinary static Core application; generated applications passed separate browser checks. The guides identify the tested checkpoints and environments. Imported-model rendering is available through Core, but imported assets are not supported by this authored preview profile. General project building, cooking and broader scene authoring remain outside this slice.

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

For the procedural lighting experiment, run `npm run benchmark -- --renderer gi` or see [the GI guide](docs/gi.md) for offscreen color transfer, door/light controls, quality budgets and limitations. For the selected mirror, use `npm run benchmark -- --renderer reflections`; the [reflection guide](docs/reflections.md) describes its controls and limits. The [integrated courtyard](docs/integrated.md) combines these paths in one image and documents its explicit raster, tracing and collision limits.

For local imported models and animation, configure `STRATA_BENCHMARK_ASSET_DIR` and run `npm run gallery`. The [gallery guide](docs/gallery.md) covers lighting, playback and scripted captures. Models and derived files remain outside Git. An experimental static progressive diffuse preview has a narrow source contract and has not passed actual-house visual acceptance; general imported GI and reflections remain unimplemented.

## Product requirements

- Render locally in an ordinary browser using WebGPU.
- Target 60 FPS on a representative laptop GPU, with Switch 2 games as a visual reference. The minimum GPU, browser, resolution, and test scenes still need to be defined and measured.
- Provide an ergonomic TypeScript API with precompiled Rust/WebAssembly internals and WGSL shaders. Consumers should not need Rust tooling or a custom WASM build step.
- Initialize WASM and workers through the engine API. Support ordinary hosting without mandatory shared-memory threading or cross-origin-isolation headers.
- Make files, code and noninteractive CLI commands the primary authoring interface for Codex and other agents. Keep optional visual tools separate from the embeddable runtime.
- Develop a custom renderer, combining rasterization with budgeted software-traced indirect lighting and selective reflections. Investigate streamed virtualized geometry through measurable prototypes.

## Architecture

| Layer | Planned implementation |
| --- | --- |
| Public package, browser integration, and initial WebGPU command submission | TypeScript |
| Dense CPU engine systems and asset processing | Rust compiled to WebAssembly; reuse suitable existing libraries |
| Rendering, culling, software ray traversal, and lighting filters | WGSL running through WebGPU |
| Agent authoring and optional visual tools | Separate TypeScript packages using public runtime APIs |

Read [the architecture brief](docs/architecture.md) for the design boundaries and unresolved questions. Proposed npm names such as `@strata-engine/core` and `@strata-engine/editor` have not been reserved or published.

## Development tracking

[GitHub Issues](https://github.com/tylerstuff/strata/issues) is the source of truth for tasks, acceptance criteria, dependencies, and progress. [Milestones](https://github.com/tylerstuff/strata/milestones) group the initial work:

1. **M1 — Runtime foundation:** package consumption, the TypeScript/WASM boundary, and performance measurement.
2. **M2 — Rendering feasibility:** a conventional renderer and measured geometry, lighting, and reflection prototypes.
3. **M3 — Agent-driven authoring:** file, code and CLI workflows that consume the runtime through supported APIs, with optional visual inspection.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the issue, pull-request, and validation workflow.

## Repository

- GitHub: <https://github.com/tylerstuff/strata>
- Local checkout: `~/code/strata`
- Default branch: `main`
- Working branches: `codex/<issue-number>-<short-description>`

This repository does not include copied Babylon or Unreal source. An open-source license has not yet been selected.
