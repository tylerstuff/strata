# Selective world-space reflection proof

The opt-in `reflections` renderer adds a selected opaque reflector to the two-room [GI experiment](gi.md). It traces a bounded number of software BVH rays in WebGPU compute, reconstructs their contribution in a separate reflection history, and combines that result with the existing raster image. The implementation covers a 156-triangle fixture, one specular bounce and a restricted roughness range. It does not establish general game-scene quality or the 60 FPS target.

The 14 cache/reference unit tests, 10 renderer integration tests and 384 GPU estimator comparisons have passed. Headed-Chrome functional checks demonstrate the initially offscreen cube's sharp reflection, discrete movement, history rejection and finite quotas in this fixture. Glossy reconstruction remains visibly noisy. Hardware and software-adapter functional validation pass. Matched frame-performance results are recorded in the [M2 reflection benchmark](benchmarks/2026-09-05-m2-reflections.md); functional readback tests do not establish rendering speed.

## Package API

The ordinary TypeScript package interface manages initialization and its precompiled WASM internally. Reflection GPU work is WGSL running through browser WebGPU; consumers do not supply GLSL, compile Rust, or access native hardware ray tracing. Package installation/build details remain in [runtime.md](runtime.md); no public npm release is implied by this example.

```ts
import { createEngine } from '@strata-engine/core';

const engine = await createEngine({ canvas, profiling: true });
engine.resize(1280, 720);
await engine.setScene({
  renderer: 'reflections',
  cameraMode: 'receiver',
  resolutionScale: 0.25,
  maxRaysPerFrame: 32768,
  roughness: 0.08,
  objectOffset: 0,
});

let animationFrame = 0;
function frame(milliseconds: number) {
  engine.render({ timeSeconds: milliseconds / 1000 });
  animationFrame = requestAnimationFrame(frame);
}
animationFrame = requestAnimationFrame(frame);

// A later submitted frame applies a persistent patch.
// engine.render({ reflections: { objectOffset: 0.4, roughness: 0 } });
// engine.render({ reflections: { mode: 'probe-only' } });
// engine.render({ reflections: { mode: 'world', resetHistory: true } });
// engine.render({ gi: { enabled: false } });

function stop() {
  cancelAnimationFrame(animationFrame);
  engine.dispose();
}
```

The host schedules frames and owns canvas sizing. `timeSeconds` animates the optional tour camera; it does not move the object or door automatically. `setScene(null)` returns to the clear-only baseline, and replacing the scene releases its resources. Importing the package does not initialize a GPU or worker.

| Reflection scene option | Default | Accepted values |
| --- | --- | --- |
| `resolutionScale` | `0.25` | `0.25`, `0.5`, or `1`, selected at scene creation |
| `maxRaysPerFrame` | `32768` | Integer 1–131072, selected at scene creation |
| `roughness` | `0.08` | Perceptual roughness 0–0.35 |
| `objectOffset` | `0` | −0.4–0.4 m along the emitter's Z axis |
| `cameraMode` | `receiver` | `receiver`, `overview`, or `tour` |

Inherited GI scene options are `doorOpen` (default `true`), `wallColor` (`red` or `neutral`, default `red`), `lightIntensity` (0–8, default 1), `probesPerUpdate` (integer 1–128, default 32), and `raysPerProbe` (integer 16–128, default 64). Probe budgets and camera mode are fixed for that scene instance.

| `render({ reflections: ... })` control | Initial default | Meaning |
| --- | --- | --- |
| `mode` | `world` | `off`, `probe-only`, or software-traced `world` |
| `roughness` | Scene value | 0–0.35; zero selects a perfect-mirror direction |
| `maxDistance` | `16` | Primary ray extent in meters, 1–32 |
| `updateEvery` | `1` | Trace on every 1–4 submitted active-effect frames |
| `objectOffset` | Scene value | Discrete emitter position, −0.4–0.4 m |
| `resetHistory` | `false` | One-frame reflection-history reset request |

Defined reflection patches persist. Omitted and `undefined` fields preserve their previous values; explicit `null` and invalid values are rejected. `resetHistory: true` applies only to that call. Sending it every frame prevents accumulation. The `gi` controls retain their [GI meanings](gi.md#package-api), including persistent enable/world patches and a one-frame `resetCache` request. GI initially runs enabled; disabling it skips probe updates and sampling while world reflections can still show emission and shadowed direct hit lighting.

Raster controls remain per-call: `temporal` defaults to `true`, `debugView` to `final`, and `cameraCut` to `false`. Disabling TAA does not disable the separate reflection history. To inspect a cold reflection, request `reflections: { resetHistory: true }` and use `temporal: false` on that frame.

## Shared fixture and material scope

The source contains the original 11 opaque room/door boxes plus two additional closed boxes: 13 boxes and 156 outward-facing triangles. The original `gi` fixture remains separate. Raster vertices, tracing triangles, transforms, normals and material identities derive from the same reflection scene data.

The mirror slab has center `(-1.5, 0.005, 0)`, half-size `(0.5, 0.005, 1)`, and top plane Y=0.01 m. Its top spans X=[−2,−1], Z=[−1,1]. Its material is metallic 1, linear base color `(0.85, 0.85, 0.85)`, no emission and the selected roughness. The emitter has center `(-0.8, 1.12, 0.2 + objectOffset)`, half-size `(0.18, 0.18, 0.18)`, emission `(4, 0.25, 0.08)`, base color `(0.6, 0.08, 0.03)`, metallic 0 and roughness 1.

The receiver camera is at `(-3, 2.4, 0.2)`, looks toward `(-1.5, 0.01, 0.2)`, and has a 30° vertical field of view. Geometric tests place every actual cube corner above that camera's image at both allowed offset endpoints, while the planar reflected image lies on the slab. The rendered pixel oracle checks this separately. At zero offset the center witness is approximately `(-1.497714, 0.01, 0.2)`.

Direct raster light and trace-hit diffuse light use the same Lambertian material model, emission and sun. Diffuse reflectance is `albedo × (1 − metallic) / π`. The raster shadow map uses PCF; hit lighting queries software shadow rays. The existing `rgba8unorm` material MRT quantizes linear base color; this is also the reflection sampler's source of metallic Fresnel F0. The source material data itself stays float32 in the trace buffers. The slab is explicit geometry in both representations, rather than a material assigned only by screen coordinates.

## Sampling, hit lighting and fallback

At each selected sample, the shader reconstructs world position from raster depth and samples the metallic surface mask. Roughness zero uses the exact mirror direction with Schlick Fresnel. Positive roughness uses isotropic GGX visible-normal sampling with `alpha = max(roughness², 10⁻⁶)`, following [Heitz, *Sampling the GGX Distribution of Visible Normals*](https://jcgt.org/published/0007/04/01/paper.pdf). Azimuth is reduced into [−π,π] and the sine/cosine pair is normalized before disk mapping, preserving the intended disk radius despite shader trigonometric error. Directions are normalized before traversal.

For this implementation's separable Smith choice `G2(V,L) = G1(V)G1(L)`, dividing `BRDF × cos` by the visible-normal reflection-direction PDF reduces the sample weight to `F(V·H) × G1(L)`. The shader stores the hit radiance multiplied by that weight. This is the derivation for Strata's chosen model, not a claim that the same weight applies to every GGX masking model. Samples below the surface hemisphere contribute zero; they do not substitute a brighter fallback.

A primary hit returns emission plus shadowed direct diffuse light and, when GI is enabled, diffuse irradiance sampled from the probe grid. The primary origin is offset 0.002 m along the surface normal, with ray `tMin` 0.002 m and the configured maximum distance. A hit can issue at most one 32 m sun-shadow query. This is one specular bounce; a secondary metallic surface does not recursively reflect another scene. Probe-lit diffuse hit shading can include the existing cached indirect diffuse contribution.

The shared triangle BVH covers the entire fixture independently of camera visibility. There are no screen-space traces or native ray-tracing calls. The existing bounded traversal limits remain 4096 triangles, 8191 nodes, a 32-entry stack and an explicit visit ceiling; those capacities do not expose an arbitrary-mesh reflection API.

A completed bounded-world miss has zero incident radiance: there is no environment map or other directional environment light outside the represented domain. For an untraced pixel or unavailable/expired history, composition instead uses the separately labelled `probeIrradiance / π × Fresnel` approximation at the reflector. `probe-only` uses this approximation without specular tracing. A diffuse irradiance grid cannot reconstruct a sharp specular environment or offscreen object image; this fallback is deliberately low frequency and is black when GI is disabled or no valid probes cover the query. Exhausted traversal stays a distinct source category with conservative fallback, never a fabricated visible hit.

## Finite work and history

The low-resolution grid is `ceil(width × resolutionScale)` by `ceil(height × resolutionScale)`. A conservative projection of the slab's top bounds the candidate rectangle, including a one-pixel margin. Near-plane uncertainty expands scheduling to the full grid. Actual raster depth, normal, front-facing view and metallic mask still decide whether a candidate traces a ray. The projection is a scheduling optimization for this selected surface.

Each update visits at most `min(maxRaysPerFrame, candidateRegionPixels)` candidate pixels, rotating through that rectangle when the quota is smaller. A candidate issues at most one primary and one shadow ray. Thus the default 32768 budget bounds primary rays, with at most another 32768 shadow rays; it is not a claim that 32768 total rays execute. Rejected candidates use no primary ray. GI's default 2048 primary and at most 2048 shadow rays are an additional, independent budget.

`reflection-trace` and `reflection-resolve` are the two reflection passes. When no trace candidates are scheduled, the trace pass and its timestamp pair are omitted; resolve still processes the low-resolution grid to qualify and expire history. Full-resolution composition remains separate. With GI and TAA enabled the order is `gi-trace`, `gi-update`, `shadow`, `raster`, `reflection-trace`, `reflection-resolve`, `gi-shade`, `temporal`, `presentation`; probe preservation copies occur before those GI pass boundaries. Normal rendering performs no readback wait.

History reprojects using raster surface motion. Each bilinear tap must match the reflector mask and epoch, positive expected depth within `max(0.02 m, 1% of depth)`, normal dot product at least 0.98, and roughness within 0.005. Fresh world hits, completed bounded-world misses and zero-contribution BSDF samples are valid measurements. Untraced/unavailable fallback and exhausted samples are not. Glossy updates keep 80% qualified history and 20% current radiance; a mixture is labelled accumulated history instead of a fresh hit. Fresh perfect-mirror samples use current radiance directly.

A completed miss now contributes zero incident radiance because the prototype has no directional environment light. This fixes the hit/miss sequence that previously discarded averaging on every miss. It deliberately changes GI-on completed misses from a diffuse-probe substitution to a black boundary outside the represented tracing domain. Unrepresented objects and the finite trace distance still introduce bias; a valid bounded sample is not a converged average or a claim that missing real-world illumination is zero. Probe-only mode and untraced/expired samples retain their separately labelled probe approximation, and traversal failures remain visible. Source 5 identifies an unblended completed miss; raw metadata retains each fresh sample's provenance, while source 3 identifies mixed or reused estimates.

This is the first isolated change for [issue #17](https://github.com/tylerstuff/strata/issues/17). The 0.8 history weight, ray budgets, resolution, hard world/camera invalidation and effect-level reset behavior are unchanged. Even uninterrupted 0.8 exponential history has a stationary variance equivalent to about nine independent samples, not a 240-sample mean. An [independent emissive-only image comparison](benchmarks/2026-09-05-m2-reflection-miss-quality.md) measured 80.5–84.8% lower stationary temporal variance across four fixed cases. The sharp quarter-resolution mean-image error barely improved, rough images remained grainy, and moving-scene quality remains unproven. The earlier functional/performance results below predate this change.

The maximum sample age is `min(16, max(updateEvery, ceil(candidateRegionPixels / maxRaysPerFrame) × updateEvery))` active-effect frames. Reuse preserves the oldest accepted sample's fresh-frame index; it does not indefinitely renew a stale sample. A new glossy measurement advances that index while retaining 80% accumulated radiance, so this bounds time since a fresh measurement, not the age of every weighted contribution. If `ceil(candidateRegionPixels / maxRaysPerFrame) × updateEvery > 16`, an entire sweep cannot remain fresh simultaneously; some pixels must fall back.

World revisions, object or roughness changes, reflection mode/distance/update settings, GI toggles, explicit resets, resolution changes and camera cuts invalidate reflection history. Any change to the unjittered camera view matrix also resets it: surface motion vectors alone cannot reproduce reflected-image parallax. Projection jitter alone does not reset it. Consequently the tour camera cannot rely on multi-frame reflection accumulation. General moving-camera reprojection remains future work.

Camera-only history resets preserve the committed candidate frontier modulo the current rectangle's pixel count. This allows a small quota to rotate beyond the first rows as the camera moves. World/settings changes, resize, explicit cuts/resets and backward frame indices may restart the frontier. Since camera motion still invalidates history, unscheduled pixels use fallback; fair scheduling does not create full simultaneous coverage or restore glossy accumulation. Any reset forces a trace update even when `updateEvery` would otherwise skip that frame.

Object, door, light and material changes update the shared trace source. Object-only motion uses the existing bounded diffuse rolling refresh described in [gi-motion.md](gi-motion.md); door, light, material and roughness changes retain hard probe invalidation and the GI coverage ramp described in [gi.md](gi.md#revisions-dark-ramp-and-history). Camera cuts and reflection-only reset requests preserve the world GI cache. Continuous animation is not a validated quality path.

[Incremental trace updates](incremental-trace-updates.md) regenerates only changed box triangles and refits their affected nodes, with separate material/light writes. The same five trace buffers serve GI and reflections; shared maintenance counters appear once in GI telemetry. A fully queued update remains queued if later encoding/submission is cancelled. The captured source version is reported as submitted only after successful frame submission.

Pending reflection banks, age and candidate-frontier bookkeeping commit only after successful submission. A cancelled frame does not advance them; the renderer forces history reset on retry. Resize allocates replacement resources before releasing old ones, cleans up partial allocation failures, and requires a fresh sample even if a cancelled resize returns to the previous dimensions. Scene disposal releases the cache, trace resources and composition targets.

## Allocation accounting and telemetry

These are application-requested resource payloads, not measured total GPU memory:

| Resource | Bytes |
| --- | ---: |
| Reflection raw radiance/distance and source metadata | `24 × lowWidth × lowHeight` |
| Two reflection history banks: radiance/depth, normal/roughness, metadata | `64 × lowWidth × lowHeight` |
| Two reflection configuration buffers and one statistics buffer | 512 |
| Shared reflection-fixture BVH, triangles, boxes, materials and light uniform | 14624 |
| Shared probe buffers, default quota | 71904 |
| Shared double-buffered probe irradiance/visibility atlases | 1966080 |
| Reflection/diffuse composition uniform | 96 |
| Shared composition HDR texture | `8 × width × height` |

The reflection cache alone is `88 × ceil(width × scale) × ceil(height × scale) + 512` bytes after a world render. At quarter-resolution 1920×1080 its textures request 11404800 bytes. Before world mode has ever rendered, one-pixel placeholders request only 88 texture bytes. Switching to `off` or `probe-only` retains previously allocated history textures; GI resources are likewise retained while disabled.

Count the scene trace data, probe cache and composition resources once: the reflection renderer shares them between GI and reflections, rather than owning an additional complete GI effect. Relative to a GI-enabled reflection-fixture baseline, the main additional world-reflection allocation is its scaled cache. Fresh off/probe-only runs and runs switched from world mode have different retained allocation histories and must be labeled when compared. The existing raster geometry/MRTs, shadow map, TAA, profiler and worker/WASM remain separate. Browser/driver allocation, alignment, canvas storage and allocator overhead are excluded.

`engine.getTelemetry().reflections` and `FrameMetrics.reflections` expose source frame, world revision, cache epoch, controls, dimensions, submitted/update counts, scheduled candidates, primary/shadow upper bounds, history age and allocation estimates. GPU-derived `actualPrimaryRays`, `actualShadowRays`, `traceFailures` and `historyReusedPixels` remain `null` without explicit diagnostic readback. Scheduled candidates are not measured hit counts. The bounded asynchronous timestamp profiler records pass intervals; overlapping pass durations must not be added and labeled elapsed GPU frame time. The [matched benchmark](benchmarks/2026-09-05-m2-reflections.md) reports CPU submission, GPU timestamp envelopes and browser frame cadence separately.

## Preview and validation

Select **Selective reflections · mirror** in the benchmark preview, then choose world tracing, probe approximation or off. The preview's receiver camera and static scenario show the fixed object; separate functional validation exercises its motion and history rejection. `reflections` displays only the reflected contribution, while `reflection-source` uses this legend:

| Source code | Preview color | Meaning |
| --- | --- | --- |
| 0 | Black | Off, no reflector, or a valid zero-contribution BSDF sample |
| 1 | Green | Fresh world-traced hit without a history blend |
| 2 | Blue | Probe approximation for probe-only mode or absent/expired samples |
| 3 | Orange | Qualified history blended with a fresh sample or reused without one |
| 4 | Magenta | Traversal exhaustion/failure fallback |
| 5 | Cyan | Completed bounded-world miss, with zero incident radiance and no history blend |

The source view reports the dominant interpolation tap, so it is a provenance diagnostic rather than a per-pixel ray-count map. Reflection and source debug views show the current unfiltered composition even when the TAA pass remains enabled. They use no indirect-light diagnostic gain. `direct`, `indirect`, `trace`, probe views and raster diagnostics remain available; GI-dependent views are black when GI is off. The `trace` debug mode launches a separate primary ray per full-resolution pixel and is outside the ordinary reflection and probe quotas.

Focused CPU checks are `npx vitest run tests/unit/reflection-cache.test.ts tests/unit/reflection-renderer.test.ts tests/unit/reflection-scene.test.ts`. Browser validation uses `node scripts/test-reflections.mjs`. The estimator kernel compares production WGSL against the CPU direction/weight reference over 384 normal/grazing and roughness cases; it checks finite weights and unit directions, not image convergence.

The clean hardware report `2026-09-05T02-44-31.335Z-reflection-validation/report.json` used Chrome 152.0.7977.82 on an Apple M2 with 16 GiB system memory and a non-fallback WebGPU adapter. It records clean implementation revision `6ebd198692ae9c2334d76ce72488387e6d4739fa`. At 320×180, reflection scale 1, roughness zero, GI disabled, TAA disabled and cold history, the independent planar-cube oracle agreed on 1234 reflected cube pixels in the first submitted frame. Discrete offsets −0.4 and +0.4 each agreed on 1286 pixels, with no false hits, false misses or reported traversal exhaustion; the reflected centroid moved about 66 pixels between those endpoints. The actual cube remained completely offscreen. The oracle allows a one-pixel silhouette tolerance, although these observations had exact hit counts.

The report also passed history reuse, explicit camera cuts, short-distance fallback, off/probe-only modes, warm probe approximation, resize, TAA toggling and camera-motion invalidation checks. A 20-frame moving-camera case with quota 256 advanced candidate starts from 0 through 4864 while advancing the history epoch each frame; it scheduled 5120 candidates and explicitly counted 2162 primary rays. There were no GPU validation or browser errors. These readback-heavy functional cases do not measure ordinary frame performance.

At roughness 0.35, the observed reflected energy spread was broader after 65 submissions, but the diagnostic image remained visibly speckled and discontinuous. That establishes roughness-dependent sampling, not a converged glossy image or denoising quality. The full software-adapter validation also passed after the numerical fixes described below. The matched off/probe-only/world performance comparisons use that same clean implementation revision. External reports and captures follow the [benchmark protocol](benchmark.md) and stay outside Git.

Unsupported scope includes roughness above 0.35, transparent or transmissive materials, alpha testing, arbitrary imported meshes, deforming/skinned geometry, general animated scenes, multiple specular bounces, arbitrary reflector selection and streamed virtual-geometry integration. Sparse tracing, low-resolution reconstruction, the approximate probe fallback and conservative camera resets can produce missing detail, blur or unstable glossy images. This bounded fixture is a proof of the rendering path, not universal mirror quality.


The full SwiftShader report `2026-09-05T02-37-38.437Z-reflection-validation/report.json` records 384 estimator checks and 18 rendered/history/quota/quarter-resolution cases on an implementation checkout. The GGX helper reduces azimuth into the guaranteed trigonometric range and normalizes its sine/cosine pair before disk mapping: approximate built-in trigonometry must not perturb the sampled radius near the disk rim. This passed the original 0.003 direction/weight comparison tolerance without widening it. The composition mask accepts binary16 rounding of the validated 0.35 roughness endpoint (`0.35009765625`), preserving the public range. Full-resolution correctness and quarter-resolution reconstruction are tested separately. The clean hardware report above also passes all 384 estimator checks and 18 functional cases. Its maximum direction/weight errors are approximately 1.25e-6 and 3.46e-6; these compare estimator math, not convergence. Quarter-resolution cases keep the reconstructed centroid within four full-resolution pixels of the independent planar witness and report zero reflection/source pixels outside the metallic mask. Tracked buffers/textures fall from 115632/22852864 bytes to zero on disposal. Coarse silhouettes and thin-feature aliasing remain visible in the quarter-resolution captures. [Issue #17](https://github.com/tylerstuff/strata/issues/17) tracks reflection quality and motion limits.
