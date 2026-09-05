# World-space diffuse GI proof

The opt-in `gi` renderer implements a small two-room lighting experiment with software triangle tracing and a fixed irradiance-probe cache. Hardware and software-WebGPU checks demonstrate offscreen color transfer, cache invalidation and finite update budgets. Matched GI-off/on performance evidence is being collected. The room remains dim and probe interpolation has visible artifacts; this does not establish a game's 60 FPS performance or Lumen-equivalent quality.

The experiment depends on the [raster foundation](raster.md), not on streamed virtual geometry. It uses ordinary WebGPU compute, storage buffers and textures. There are no native ray-tracing APIs, screen-space ray traces, screen-space reflections, baked indirect lightmaps, or camera-visible-surface requirements for probe updates.

## Package API

```ts
import { createEngine } from '@strata-engine/core';

const engine = await createEngine({ canvas, profiling: true });
await engine.setScene({
  renderer: 'gi',
  doorOpen: true,
  wallColor: 'red',
  lightIntensity: 1,
  probesPerUpdate: 32,
  raysPerProbe: 64,
  cameraMode: 'receiver',
});

// The host schedules each frame. Cache updates require successive render calls.
engine.render({ timeSeconds: 0, temporal: false, debugView: 'indirect' });

// Apply a persistent world-state patch on a later frame.
engine.render({ timeSeconds: 1 / 60, temporal: false, gi: { doorOpen: false } });
engine.render({ timeSeconds: 2 / 60, temporal: false }); // Door remains closed.

const { gi } = engine.getTelemetry();
```

Scene options are `doorOpen` (default `true`), `wallColor` (`red` or `neutral`, default `red`), `lightIntensity` (0–8, default 1), `probesPerUpdate` (integer 1–128, default 32), `raysPerProbe` (integer 16–128, default 64), and `cameraMode` (`receiver`, `overview`, or `tour`, default `receiver`). Probe budgets and camera mode are selected at scene creation. `timeSeconds` moves the optional tour camera; it does not continuously animate the door or light.

Per-frame `gi` controls accept `enabled`, `doorOpen`, `wallColor`, `lightIntensity`, and `resetCache`. Defined world-state patches persist; omitted or `undefined` fields preserve the previous values. `resetCache: true` is a one-frame reset request: sending it every frame restarts the update sweep every frame. `enabled: false` skips the three GI compute passes; re-enabling starts a fresh cache epoch. Toggling GI retains its allocations until scene replacement or disposal. `cameraCut` and `temporal` keep their raster meanings.

## Shared scene and tracing representation

The fixture contains 11 opaque boxes, 132 triangles and three flat diffuse materials. Room A occupies negative X and has a roof. Room B occupies positive X and has an open roof and a red or neutral back wall at Z≈−4. A divider separates the rooms, with a 2 m wide, 2.8 m high doorway. The 8 cm thick rigid door has only open and closed states; its hinge is at Z=+1. The open door rotates into room B, away from the intended red-wall transport path.

Raster and tracing geometry come from the same outward-CCW triangles, transforms and material IDs. Raster direct light and probe-hit shading both use flat Lambertian `albedo × incident irradiance / π`, with the same linear albedos and directional sun. Sun direction is normalized `(0.35, 0.8, 0.4)` and base radiance is `(4.0, 3.8, 3.5) × lightIntensity`. Raster direct visibility uses its existing shadow map and PCF; probe-hit direct visibility uses a software any-hit shadow ray. The material MRT retains its existing 8-bit linear albedo quantization. No procedural material texture or GGX highlight is substituted into this fixture's traced lighting.

A useful geometric witness is receiver `(-1.5, 0.01, 0.2)` and source point `(4.5, 1.5, -3.999)` on the colored wall. CPU intersection tests verify that the open doorway connects them, the closed door blocks that segment, the receiver's sun ray is blocked, and the source point's sun ray is clear. The rendered test separately checks a linear-HDR pixel region around the receiver, with the colored source outside the camera view and both histories cold.

The selected implementation is a deterministic median-split triangle BVH with at most four triangles per leaf. Its nodes occupy 32 bytes and triangles 64 bytes. A discrete door change refits bounds and triangle data without changing primitive identity or buffer sizes. The current scene has 71 nodes. Limits are 4,096 triangles, 8,191 nodes, a 32-entry traversal stack and an explicit node-visit ceiling. Closest-hit and any-hit routines report hit, miss, or invalid/exhausted traversal separately. Probe tracing counts traversal failure and treats it conservatively, instead of allowing light through a fabricated miss.

An analytic oriented-box SDF is retained as a comparison candidate on the exact same box source. It uses at most 128 sphere-tracing steps, a 0.2 mm surface threshold, and a conservative 0.9 step multiplier. Grazing rays can consume the complete budget; the result then remains an explicit exhaustion. This simple candidate has neither a spatial SDF hierarchy nor a baked distance-field volume, and its results do not establish the limits of all SDF methods.

## Observed tracing correctness

The initial 2026-09-05 browser validation used Chrome 152.0.7977.82 on an Apple M2 host; WebGPU reported vendor `apple`, architecture `metal-3`, and a non-fallback adapter. Each door state used 4,096 identical input rays for BVH closest-hit, BVH any-hit, and SDF tracing: 1,024 each of coherent, incoherent, grazing, and axis-aligned/finite-interval rays.

Across 8,192 rays, the BVH closest-hit checks had zero false hits, false misses, exhausted traversals, or distance/normal disagreements under the test tolerances. The distance threshold is `max(0.002 m, referenceDistance × 0.0002)`; the largest observed BVH closest-distance error was below 0.00000162 m. Unambiguous nearby-hit normals require dot product ≥0.98. Any-hit results also agreed on visibility and validated the returned hit's source identity and ray interval; any-hit is not required to return the nearest surface. GPU validation errors were zero.

| SDF ray distribution, 1,024 rays per row/state | Open-door exhaustions | Closed-door exhaustions | Other completed-hit discrepancies |
| --- | ---: | ---: | --- |
| Coherent | 0 | 0 | None |
| Incoherent | 3 | 3 | Three distance discrepancies in each state |
| Grazing | 743 | 757 | Seven normal discrepancies with closed door |
| Axes and finite intervals | 20 | 19 | None |

The SDF recorded no false hit/miss classifications among completed queries in this corpus; exhausted queries are a separate failure category and must not be discarded when comparing reliability. These findings support using the BVH for this thin-wall/door proof. Millisecond comparisons remain pending; no performance ranking is inferred from the correctness counts. The local report is `2026-09-05T01-15-54.071Z-gi-validation/report.json` under `~/Downloads/Strata-Benchmark-Results/` and is not committed.

## Probe layout, integration and visibility

The fixed grid has 12×4×8 = 384 probes, 1 m spacing, and first center `(-5.5, 0.5, -3.5)`. The default update advances through 32 probes per submitted GI frame, each tracing 64 deterministic Fibonacci directions with an azimuth phase that changes across probes and frames. That is 2,048 closest-hit rays and at most 2,048 shadow rays per update, with 32 m ray extent. The update is independent of camera resolution and frustum. One complete initial grid sweep takes 12 submitted GI frames at the default budget.

Each hit evaluates emission plus shadowed direct Lambertian light. Misses contribute no environment radiance. The cache does not sample its own irradiance when shading hits, so this version computes **one indirect diffuse bounce**, without iterative multi-bounce feedback. Excess backface hits or closest-hit traversal failure invalidate the affected probe update. Shadow traversal failure blocks that light contribution and increments the failure counter. There is no probe relocation.

Irradiance uses an 8×8 octahedral tile per probe in a 192×128 `rgba16float` atlas. Visibility stores directional mean distance and mean squared distance in 16×16 tiles in a 384×256 `rg32float` atlas. Both atlases have two copies. Bilinear sampling manually folds out-of-tile taps across octahedral edges into the same probe, preserving edge continuity without allocating physical atlas gutters or reading another probe's texels.

Surface shading combines up to eight neighboring valid probes with trilinear, normal-facing and distance-moment visibility weights. Out-of-grid and old-epoch probes do not contribute; surviving weights are normalized. The current query offsets the surface by 0.12 m along its normal and 0.02 m toward the viewer. Visibility uses a 0.02 m distance allowance, a variance floor, and a cubed visibility probability. These are deliberate approximations with potential thin-wall, corner and low-probe-density artifacts; rendered leakage quality remains to be measured.

Pass order is probe-atlas preservation copies → `gi-trace` → `gi-update` → `shadow` → `raster` → `gi-shade` → optional `temporal` → `presentation`. GI composition reconstructs world position from raster depth and the inverse current camera transform, then consumes world normals, linear material albedo and direct HDR. A separate composed HDR texture feeds TAA; the original direct HDR and its shadow-visibility alpha remain available for comparison.

## Revisions, dark ramp and history

Door, wall-color and light changes increment a world revision and invalidate both cached radiance and visibility through a new probe epoch. Old texels may remain physically present, but their old-epoch probe states exclude them from shading. Until newly updated probes cover a receiver, its indirect light is dark. A probe's first valid sample in the new epoch uses no irradiance history; subsequent samples keep 85% of the previous irradiance and blend 15% of the new estimate. Distance moments update immediately whenever that probe is sampled.

The 85% history weight applies **per probe update**, not per displayed frame. For a probe updated every 12 submitted frames, retaining `0.85^k` of an existing error takes about 15 updates to fall below 10%—roughly 180 submitted frames. At an actual 60 Hz this would be about 3 s; it is an analytical illustration, not measured latency. Full resets bypass old irradiance on each probe's first new-epoch update, but still incur the coverage ramp and subsequent sampling stabilization. The first 12-frame sweep would take 200 ms only if the application actually submits at 60 Hz.

Camera movement, resize and `cameraCut` reset screen temporal history as appropriate without invalidating world-space GI. A world-state change also resets screen history. Failed submission cancels the pending probe sweep and atlas index; only a successful submit commits their CPU bookkeeping. Continuously moving doors/lights, local dirty-region updates, scrolling grids and prioritized propagation are unsupported. Repeated world changes can repeatedly restart the dark ramp.

## Allocations and diagnostics

Default application-requested GI allocations, in addition to the existing raster/room geometry resources, are:

| Resource | Bytes |
| --- | ---: |
| Trace nodes, triangles, boxes, materials and uniform | 11,392 |
| Probe ray results, states, statistics and two uniforms | 71,904 |
| Two irradiance atlases plus two visibility atlases | 1,966,080 |
| Composition uniform | 96 |
| Composition HDR texture | `width × height × 8` |

The fixed subtotal is 2,049,472 bytes. Composition adds 7,372,800 bytes at 1280×720 or 16,588,800 bytes at 1920×1080. Probe-buffer allocation is `6,368 + probesPerUpdate × raysPerProbe × 32` bytes; atlas and scene allocation do not change with the ray quota. Retained textures still count while GI is disabled. These estimates exclude browser, driver, canvas, alignment and allocator overhead; they are not total GPU memory usage. The existing raster MRTs, shadow map, TAA, worker/WASM memory and profiling resources remain separate.

Each active update also copies 983,040 bytes between atlas pairs to preserve probes outside its update window. Those copy commands precede the `gi-trace` timestamp. The sum of `gi-trace`, `gi-update` and `gi-shade` therefore measures named passes, not all GI overhead; compare GI-on/off total-frame distributions as well. Normal frames do not wait for GPU readback.

`engine.getTelemetry().gi` and `FrameMetrics.gi` expose the active state, scene controls, world revision/cache epoch, submitted update counts, ray budgets and allocation estimates. Unread GPU-derived values such as `validProbeCount` and `traceFailures` are `null`, not a claimed zero. Browser validation reads explicit diagnostic buffers separately. GPU timestamp samples use the existing bounded asynchronous profiler; missing or quantized samples retain their existing meaning.

| Debug view | Meaning |
| --- | --- |
| `final` | Direct plus indirect, with optional TAA and tone mapping |
| `direct` | Current raster direct HDR only |
| `indirect` | Current indirect diffuse contribution with ×20 diagnostic display gain, then tone mapped; linear HDR values and final rendering are unchanged |
| `trace` | Closest software-traced surface normals; magenta marks traversal failure |
| `probe-age` | Nearest-probe validity and submitted-frame age |
| `probe-irradiance` | Raw atlas energy with display compression |
| `probe-visibility` | Atlas mean distance and distance standard deviation |

The GI diagnostic views present the current unfiltered composition, even when the temporal pass remains enabled. They do not display TAA-blended ages, trace normals or atlas values. Atlas views mask invalid and old-epoch tiles to black, matching their exclusion from surface shading; inspect validity/age alongside them. `trace` launches a diagnostic ray per screen pixel and is outside the normal probe-ray budget, so its cost is not representative of final-image GI shading. Existing raster depth, normal, motion, material and shadow views remain available.

## Validation and pending evidence

Run the focused CPU checks with `npx vitest run tests/unit/gi-trace.test.ts tests/unit/gi-probe.test.ts`. Browser checks use `node scripts/test-gi.mjs`; `--measure` additionally requests a local hardware representation microbenchmark and rejects software-GPU/CI measurement mode. Generated reports and captures stay outside Git under `~/Downloads/Strata-Benchmark-Results/`, as described in the [benchmark protocol](benchmark.md).

The completed checks cover source winding and refit, bounded traversal and independent triangle agreement, finite probe budgets, cache epochs, cancelled submissions, complete grid updates, light-off behavior and disposal. The following still require rendered/hardware evidence before issue acceptance: initially offscreen red-wall influence with both histories cold and TAA disabled; closed-door and thin-wall leakage; light/door convergence measured from linear-HDR receiver values; disocclusion/stale-light inspection; and matched GI-off/on 720p/1080p frame distributions with trace/update/shading cost. The rendered test exists but its success is not claimed here.

This implementation excludes imported meshes, deforming geometry, transparency, alpha testing, transmissive materials, indirect specular/reflections, multiple diffuse bounces, environment lighting, arbitrary scene extents and automatic probe placement. Passing this restricted fixture will not establish those capabilities.

The algorithmic starting points are [Dynamic Diffuse Global Illumination with Ray-Traced Irradiance Fields](https://jcgt.org/published/0008/02/01/paper-lowres.pdf), the [RTXGI DDGI volume documentation](https://github.com/NVIDIAGameWorks/RTXGI-DDGI/blob/main/docs/DDGIVolume.md), and the [PBRT BVH chapter](https://pbr-book.org/4ed/Primitives_and_Intersection_Acceleration/Bounding_Volume_Hierarchies). Strata's finite budgets, layouts, software traversal and restricted scene are its own proof choices. Hardware timings in those references are not browser performance forecasts.
