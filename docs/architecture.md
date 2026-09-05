# Strata architecture

Status: accepted direction. The lifecycle, package and procedural benchmark foundation is implemented; advanced rendering systems and their performance remain to be demonstrated. See [the runtime guide](runtime.md) for the current implementation boundary.

## Product boundary

Strata is a standalone browser game engine built from scratch for WebGPU. It is not a Babylon Lite fork or compatibility layer. The engine should provide an integrated runtime for rendering, assets, scenes, animation, input and game systems behind a TypeScript package facade. An optional editor is a separate application using that runtime and its asset tools.

The deployment target is the browser. There are no planned native graphics backends or WebGL fallback. WebGPU availability and required device limits must be checked at startup, with a clear unsupported-device result. Hosting should work without mandatory cross-origin isolation or special shared-memory headers.

The name `@strata-engine/core` is a proposed package name. It has not been reserved or published. The runtime guide describes the current API; the broader systems described here remain design direction.

## Runtime responsibilities

| Layer | Responsibility |
| --- | --- |
| TypeScript | Public API, browser integration, lifecycle, scene orchestration, asset requests, worker scheduling and direct WebGPU resource/command management. |
| Rust compiled to WebAssembly | Dense CPU work where profiling justifies it: decoding, decompression, geometry processing, spatial structures and other batched algorithms. |
| WGSL | GPU visibility, raster rendering, lighting, reflection/GI tracing, filtering, temporal reconstruction and other compute passes. |

The TypeScript renderer owns the WebGPU device, queues, resource lifetimes and frame submission. Rust is not a second graphics abstraction or a native-backend strategy. Cross-language calls operate on coarse jobs and packed buffers; avoid per-object calls in hot loops. Keep data ownership, cancellation, transfer and disposal explicit.

The published package should include version-matched, prebuilt WASM and worker assets. Initialization locates those assets and starts workers automatically. Application developers should not need Rust, Cargo or a separate WASM compilation step. Engine contributors and the release pipeline will need the toolchain. Rust's browser-oriented [WASM target](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html) does not supply native filesystem or thread behavior, so browser services belong in the host layer.

The default worker model uses messages and transferable buffers. Each worker can own its WASM instance and memory. Shared memory is an optional future optimization behind capability checks; correctness must not depend on it. [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers) provide background execution, while browser [shared-memory access](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer) carries cross-origin-isolation requirements.

## Assets and virtualized geometry

Strata owns its cooked asset format and offline asset compiler. Common interchange assets are compiler inputs; a large source model should not require full preprocessing or full residency during gameplay.

The intended geometry pipeline produces spatial clusters, a hierarchy of simplification choices, error metrics, bounds and independently streamable pages. The runtime manages request priorities, residency, upload budgets and bounded caches. GPU traversal and culling select the geometry to draw for the current view. A cluster is an entry in packed data, not an individual high-level scene object.

This is a direction to prototype, not a claim of Nanite equivalence. Cluster layout, compression, hierarchy construction and raster strategy require experiments. A conventional mesh path remains necessary for the initial implementation and content that does not yet fit virtualized geometry, including animated and transparent objects.

## Integrated rendering and lighting

Use a hybrid raster renderer with software techniques for indirect lighting and reflections. The initial design does not depend on hardware ray-tracing APIs. Screen-space traces can provide useful detail, but the intended lighting system also needs a world-space representation to answer queries about offscreen or occluded surfaces. Candidate representations and update policies must be selected through measured prototypes.

Virtual geometry, conventional meshes and lighting share contracts for transforms, materials, depth, normals, motion vectors and visibility. Establish those contracts before building separate effects. Shadows, picking and temporal history must agree with the geometry actually displayed. Define how animated and transparent content participates, including deliberate approximations where necessary.

The renderer owns a frame graph that describes render/compute/copy ordering and resource dependencies. It also owns transient targets, persistent histories, resize behavior, asynchronous resource retirement and device-loss recovery. Temporal accumulation, denoising and reconstruction are part of the lighting architecture rather than optional finishing touches. Scalability controls should adjust resolution, trace density, update frequency and residency budgets within a coherent quality profile.

## Performance evidence and milestones

The ambition is a visually rich laptop experience at 60 fps, with Switch 2-inspired quality as a reference for scope. Neither the visual comparison nor the frame rate is verified. The actual target GPU, resolution, power mode, browser and representative content remain unresolved. A previously discussed 2–3 ms GI allocation is illustrative, not a measured cost or guarantee.

Begin with a reproducible browser benchmark and a conventional rendering baseline. Add one independently measurable capability at a time: cooked assets and streaming; cluster selection; shared geometry outputs; world-space indirect lighting/reflections; temporal reconstruction; integrated scene stress tests. GitHub Issues track implementation tasks and their acceptance evidence.

Record CPU and GPU timings separately where supported, alongside frame-time distributions, memory, upload traffic, startup time and visible artifacts. Declare the device and workload for every performance claim. Retain simpler rendering and lighting modes so experiments can demonstrate their quality and cost against a stable baseline.

Editor work follows usable runtime and asset contracts. The editor may author scenes, inspect assets and launch previews, but games must build and run without it.
