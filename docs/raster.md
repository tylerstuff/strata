# Raster PBR foundation

The opt-in raster renderer adds textured opaque materials, a shadowed directional light, linear HDR targets, tone mapping, motion vectors and temporal anti-aliasing. It renders a deterministic procedural test scene. Arbitrary mesh/material import, animation assets, GI, reflections, virtual geometry and the editor remain separate tasks.

```ts
const engine = await createEngine({ canvas, profiling: true });
await engine.setScene({ renderer: 'raster', seed: 1337, instanceCount: 512 });
engine.render({ timeSeconds: 0, temporal: true, debugView: 'final', cameraCut: true });
// The application advances time and owns its requestAnimationFrame loop.
engine.render({ timeSeconds: 1 / 60, temporal: true });
```

`renderer: 'diffuse'` remains the default and preserves the original benchmark. Both paths use the same seeded box layout and 20-second orbit; the raster scene adds one moving box, generated material textures and shadowing. This is a controlled rendering fixture, not a generic scene-authoring interface. Current bundling includes both renderers in `index.js`; deferred initialization does not yet mean a separate network download.

## Materials, light and color

The fixture uploads a 64×64 `rgba8unorm-srgb` base-color texture and a separate linear `rgba8unorm` metallic/roughness texture. The shader multiplies sampled linear base color by the instance's linear color factor. Metallic uses the B channel; perceptual roughness uses G, multiplied by instance factors and clamped to 0.06–1.0. Dielectric and metallic objects use different factors. UVs repeat with linear filtering; mipmaps, normal maps, emissive inputs, alpha masking/blending and arbitrary user texture loading are not implemented.

Direct lighting uses GGX normal distribution, correlated Smith visibility, Schlick Fresnel and an energy-reduced Lambertian diffuse term. The directional light is fixed at normalized `(0.35, 0.8, 0.4)` with RGB intensity `(4.0, 3.8, 3.5)`. A 2048² `depth32float` shadow map uses a scene-sized orthographic camera, hardware comparison filtering and a 3×3 PCF kernel. Raster bias is 2 with slope scale 2, plus a 0.00025 comparison offset. There are no cascades or area-light penumbrae; finite resolution and bias can cause aliasing, acne or detached shadows at some scales.

Lighting and temporal history remain linear in `rgba16float`. Presentation applies an ACES-style fitted tone curve after multiplying by `2 ** exposureEV`, then the explicit sRGB transfer function to an ordinary unorm canvas format. This is not a full ACES color-management implementation or HDR display output. There is no indirect ambient lighting: unlit surfaces and metals without a direct highlight can be black. The blue background does not illuminate or reflect on objects.

`render({ exposureEV: 4 })` applies +4 stops (16×) of exposure compensation to this frame. Positive values brighten; this is compensation, not calibrated photographic EV100. The finite range is [-16,16], and omission means 0 (1×), including after a previously exposed frame. Final, direct, indirect-only and reflection radiance views apply this multiplier. Raw depth, normal, motion, material, shadow, geometry and trace diagnostics do not. The indirect-only room diagnostic retains its existing additional 20× display gain (about +4.322 stops); use **final** for matched GI-on/off comparisons.

Exposure changes neither scene-linear lighting nor temporal/progressive accumulation, source uploads or reset keys. Invalid values reject before frame preparation. Clear, legacy diffuse and authored-boxes do not use this shared raster presentation control and explicitly reject nonzero exposure. This is a manual display control: it does not repair dark baked-in scan textures, increase traced samples, reduce variance or provide automatic exposure adaptation.

## Shared outputs and ordering

The renderer owns all resources. Passes execute in this fixed order: directional shadow → PBR geometry/MRT → optional temporal resolve → presentation. This is the initial explicit ordering, not a general-purpose frame-graph scheduler. Internal `RasterOutputs` views are valid until resize or disposal; later effects must consume them within that lifetime.

| Output | Format | Channels |
| --- | --- | --- |
| HDR | rgba16float | Linear direct-light RGB, directional shadow visibility A |
| Normal | rgba16float | Normalized world normal XYZ, perceptual roughness A |
| Material | rgba8unorm | Linear base color RGB, metallic A |
| Motion | rgba16float | Previous UV minus current UV in XY; current positive view depth Z; expected previous positive view depth W |
| Depth | depth32float | WebGPU 0–1 depth; clear value 1 |
| Two temporal histories | rgba16float | Resolved linear RGB and current positive view depth A |

UVs have an upper-left origin and refer to pixel centers. Cameras use a right-handed view convention and column-major matrices. Motion uses the current and previous camera projections, their jitter and the current/previous object transforms. Normal transformation accounts for nonuniform instance scale. The moving box also uses the same animated transform in the shadow pass.

The MRT colors require 28 bytes per pixel and depth adds 4. Histories add 16 bytes per pixel after temporal rendering first runs. Shadow/material texture payload is 16,809,984 bytes. Histories remain allocated when temporal processing is disabled and are recreated when next used at a different size. Telemetry includes retained allocations; it never treats them as freed by a toggle. Driver alignment, swapchain storage and query-set overhead are excluded.

## Temporal processing and debug views

Temporal processing defaults on for the raster path. Final output uses an eight-sample Halton projection jitter. History reprojects with `previousUV = currentUV + motion.xy`; motion includes the previous and current projection jitter. A 4×4 Catmull–Rom filter preserves more history detail than repeated bilinear reconstruction. Every contributing cubic tap must have positive depth and agree with expected previous depth within `max(0.02, 0.02 × expectedDepth)`. Otherwise reconstruction falls back to the four central, positive bilinear weights that pass the depth check. Only those positive weights are renormalized; a partially accepted signed cubic kernel is never used.

A 3×3 current-color min/max clamp limits reconstructed history. Its blend weight is `0.9 × acceptedBilinearWeight`, so a complete valid footprint uses 90% history, partial support reduces historical confidence, and no valid support uses current color alone. This adds history texture reads (16 instead of 4), without adding history allocations or changing the motion/depth contract. Its performance cost needs a matched measurement.

First use, resize, a camera cut, temporal/jitter transitions, time reversal and time jumps above 0.25 seconds invalidate history. A synchronous failed submission forces a reset before the next successful raster frame. Debug views disable projection jitter; switching back to final output resets history. A camera cut should be signaled once, not every frame. Sky pixels have zero depth and reject history.

`debugView` accepts `final`, `direct`, `shadow`, `depth`, `normal`, `motion` and `material`. Direct shows current-frame direct light without temporal presentation; shadow shows visibility; depth shows normalized linear distance; normal shows encoded world normals; motion maps UV velocity around neutral 0.5; material displays metallic in red and roughness in green. When `temporal: true`, debug runs still execute the temporal pass but present the selected raw diagnostic. Set it false to omit that pass from a comparison.

This TAA can still soften detail or ghost when depth alone cannot distinguish surfaces. It has no normal/material history rejection, reactive mask, luminance variance model, exposure adaptation or temporal upscaler. Its jittered history samples do not guarantee exact integration over a fixed pixel footprint. FP16 motion/depth and fixed depth thresholds limit scale and precision. Geometry changes beyond the fixture's known motion need a deliberate history invalidation policy.

## Measurement and validation

```sh
npm run build
npm run benchmark -- --renderer raster --temporal off
npm run benchmark -- --renderer raster --temporal on
STRATA_TEST_BROWSER_CHANNEL=chrome STRATA_TEST_HEADED=1 npm run test:raster
```

The benchmark retains fixed 720p/1080p, seed, orbit, warm-up and capture duration. The [initial M2 raster report](benchmarks/2026-09-05-m2-raster.md) records the first matched measurements. The raster workload ID distinguishes its added motion/materials from the diffuse baseline. Reports include named shadow/raster/temporal/presentation samples and percentiles, plus their per-frame sum, callback intervals, CPU submission and allocations. Pass sums exclude gaps, presentation/compositing and other GPU activity. `timedFrameCount` counts complete timed frames; `capturedPassSampleCount` and dropped/pending counters count individual pass samples. The legacy `capturedGpuSamples` field remains an alias of timed frame count for schema-v1 readers. Complete frame groups are retained or dropped together.

Unit checks cover camera/light matrices, motion conventions, reset rules, resource ownership and failed submissions. Browser checks execute the production GGX function numerically and exercise actual temporal WGSL with signed fractional motion, analytic cubic reconstruction, foreign-depth rejection and partial support. A generated detail harness reports separate point-sample and pixel-box reference errors for static textures, translation, zoom and a slanted edge; its correctness checks alone do not accept visual quality. Browser checks also capture every required debug view and exercise toggles, resize, renderer replacement and disposal. These checks verify the supported foundation; they do not establish a representative game's 60 FPS result. All fixture imagery is procedural, and browser reports/captures remain outside Git and CI artifacts.
