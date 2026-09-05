# Integrated courtyard feasibility fixture

This experimental renderer combines streamed terrain, conventional room geometry, world-space diffuse GI and selected software reflections in one camera image. It is a restricted integration test, not a general scene graph or an established 60 FPS game-quality result. Hardware evidence is pending.

## Loading the fixture

The Rust cooker produces the fixed seed-1337 terrain with four tiles per side and 64 cells per tile. `--trace-proxy` additionally creates a separately hashed proxy sidecar. The canonical fixture contains 80 pages (5242880 bytes), including three pinned root pages, and 1168 clusters. Its persistent proxy payload is 37644 bytes. Serve the render manifest, its pages and both proxy files through HTTP(S), from outside this repository when benchmarking. Consumers use the prebuilt package and do not run Rust.

```ts
const engine = await createEngine({ canvas, profiling: true });
engine.resize(1280, 720);
await engine.setScene({
  renderer: 'integrated',
  manifestUrl: '/assets/courtyard/manifest.json',
  traceProxyUrl: '/assets/courtyard/trace-proxy.json',
  geometryMode: 'streamed',
  poolBytes: 1024 * 1024,
  cameraMode: 'tour',
  resolutionScale: 0.25,
  maxRaysPerFrame: 32768,
  probesPerUpdate: 32,
  raysPerProbe: 64,
});
engine.render({ timeSeconds: 0 });
```

The host owns scheduling, resize and disposal, as with the other renderers. The scene also accepts the existing geometry pixel-error/request/upload/delivery-delay settings, GI world/probe options and reflection settings. `terrainColor` selects matched green (default) or neutral raster/tracing albedo for validation. `cameraMode` selects the recorded 60-second `tour`, stationary mirror `receiver`, `overview`, or `terrain-witness`. These are fixed fixture cameras; no collision or input controller is provided. `timeSeconds` advances the camera only. The benchmark applies explicit object/door/light patches from its recorded scenario; ordinary package consumers can send their own supported patches.

Scene replacement accepts an AbortSignal and keeps the prior scene until the replacement completes successfully. Raster/trace resources share one ownership tree and are released together. A failed load releases all resources acquired by that load. Existing diffuse, PBR, virtual-terrain, GI and reflection entry points remain available as independent experiments.

## Three distinct representations

| Purpose | Representation |
| --- | --- |
| Raster and shadow rendering | 131,072 finest source terrain triangles, selected through cooked tile LODs/pages; 156 exact room/mirror/object triangles |
| Indirect queries | Permanent 2,048-triangle terrain proxy plus the same 156 exact room/mirror/object triangles in one bounded triangle BVH |
| Collision | Absent |

Terrain uses uniform scale 0.125 and translation `[0,-1.625,0]`. The same transform applies to rendered vertices, shadow positions, selection bounds and LOD errors. World X/Z spans [-16,16] metres. Its conservative height range [-3,-0.25] stays below the room floor underside at -0.2. The room's east wall becomes a curb with top at 0.3 metres, creating a real courtyard opening; the separate GI and reflection proof rooms are unchanged.

The proxy is sampled from the cooker's same analytic heightfield, with a separate source-manifest hash, payload hash, topology and approximation-error metadata. It remains resident even when primary-view detail pages are absent or evicted. Hash linkage establishes matching bytes and integrity; it does not mathematically verify the claimed error for an arbitrarily rewritten sidecar. The error proof applies to the canonical cooker output. It is a deliberate coarse representation, not exact finest-triangle coverage. For the canonical source, the measured maximum vertical error is 0.125506 m and the conservative bound is 0.189596 m. This vertical error bound does not bound normals, shadows, occlusion or radiometric error. The raster terrain retains analytic heightfield normals, while proxy rays use coarse triangle normals. A flat Lambertian terrain material and the sun's direction/radiance agree across both paths; the raster material attachment still quantizes albedo to RGBA8. The shared BVH has 2204 triangles and 1335 nodes, with 184640 bytes of packed buffers. A CPU source witness from `[5.5,1.5,-3.5]` toward courtyard terrain agrees with the independent triangle scan at about 4.875217 m. This checks geometric reachability; rendered contribution requires the separate GPU validation. The box-only SDF comparison reports this combined representation as unsupported.

The fixed 384-probe room grid covers the indoor experiment and its immediate boundary. Outdoor diffuse GI is unsupported; there is no outdoor probe clipmap or environment light. Reflection selection remains the one metallic floor slab, one specular bounce and roughness <=0.35. The permanent trace representation keeps offscreen contributors available; it does not make these effects general or photorealistic.

## Shared rendering and frame accounting

Terrain and room use separate pipelines and geometry bindings inside one shadow pass and one four-attachment raster pass. One frame uniform supplies the same current/previous camera and light matrix to both. A single composition, temporal resolve and presentation process the combined result.

The full GPU geometry path plans up to ten timed passes: `gi-trace`, `gi-update`, `selection`, `shadow`, `raster`, `reflection-trace`, `reflection-resolve`, `gi-shade`, `temporal`, `presentation`. Probe preservation copies precede the measured GI boundaries. Selection performs two compute dispatches. With all effects active and a nonempty reflection quota, the frame contains seven compute dispatches and six render draws. Conventional mesh comparisons can use more tile draws and omit GPU selection. When no reflection candidates are scheduled, the trace pass and its timing sample are omitted; reconstruction still executes. The profiler excludes explicitly omitted query indices before calculating the frame's timestamp origin, so unwritten or stale queries cannot inflate the envelope.

GPU terrain triangle counters describe a delayed `geometry.sourceFrameId`; the current room contributes 312 triangles across the raster and shadow draws, and the fullscreen passes contribute their own current triangles. `triangleCountSourceFrameId` identifies the delayed terrain portion rather than implying that every component of the combined total came from that older frame. `FrameMetrics.integrated` labels the persistent proxy, source counts, supported probe volume and missing collision representation. Resource counts are requested application payloads, not total browser/driver memory.

The same frame-profiler caveat applies: named pass durations can overlap. Use the measured start/end envelope and CPU/RAF distributions; never sum pass durations and call that elapsed GPU frame time. No readback wait is inserted into ordinary render submission.

## Recorded stress and quality limits

The 60-second tour holds the mirror view, traverses the open doorway, views the courtyard receiver, visits distant terrain tiles and returns. An emissive object moves continuously for four seconds. The door closes/reopens and the sun switches off/on at fixed times. The scene's camera path is inspected for intersection with the explicit source boxes, but no physical locomotion or collision system is implied.

Every object/world change currently refits the BVH and resets the entire diffuse probe epoch. Continuous movement can therefore repeatedly prevent lighting stabilization. Specular camera motion resets reflection history because surface motion alone does not model reflected parallax. These are expected limitations to measure in the integrated result, not artifacts to hide by choosing only still frames. Follow-up issues [#15](https://github.com/tylerstuff/strata/issues/15) and [#17](https://github.com/tylerstuff/strata/issues/17) track diffuse and reflection quality.

Integration validation must show offscreen terrain affecting an indoor vertical receiver while render-detail residency changes, source agreement under room refits, camera cuts, delayed page delivery, resize, mode changes and complete disposal. Compare the same timed path at fixed 720p and 1080p with GI, world reflections, TAA and virtual-geometry behavior independently ablated. Dynamic resolution is a separate policy experiment only if the fixed-resolution evidence justifies it. A limited fixture completing near 60 browser callbacks per second does not establish Switch 2-level visual quality or the performance of arbitrary games.
