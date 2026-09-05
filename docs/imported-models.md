# Imported models and animation

The optional glTF path renders conventional, fully resident meshes through Strata's shared PBR, directional shadow, intermediate-buffer and temporal rendering path. It is intended for inspecting real assets and their animation. Imported geometry does not participate in the experimental GI, reflection tracing or virtual-geometry systems.

```ts
import { createEngine } from '@strata-engine/core';
import { loadGltf } from '@strata-engine/core/gltf';

const engine = await createEngine({ canvas, profiling: true });
const abort = new AbortController();
const asset = await loadGltf('/models/character/scene.gltf', {
  signal: abort.signal,
  maxTextureDimension: 2048,
});
await engine.setScene({ renderer: 'imported', asset, signal: abort.signal });
engine.resize(1280, 720);
engine.render({
  timeSeconds: 0,
  temporal: true,
  imported: {
    camera: { eye: [3, 2, 3], target: [0, 1, 0], verticalFov: Math.PI / 3 },
    lighting: { directionToLight: [0.35, 0.8, 0.4], color: [1, 0.95, 0.875], intensity: 4, ambient: [0.08, 0.08, 0.08] },
    background: [0.02, 0.035, 0.055],
    presentation: 'ground',
    animation: { clipId: asset.clips[0]?.id ?? null, timeSeconds: 0, loop: true },
  },
});
```

The host owns scheduling and play/pause. Clip time is explicit and independent of scene time. A null clip selects the authored rest pose; a looping clip wraps at its duration, and a non-looping clip holds its endpoint. Translation, rotation and scale channels support LINEAR, STEP and CUBICSPLINE interpolation. Rotation uses shortest-path quaternion interpolation. Negative rest scales are preserved; animation that collapses a node scale axis or changes that node scale's handedness is rejected. General weighted-skin determinant changes are not guaranteed to preserve winding or shading. Nodes retain their authored hierarchy, and skinned geometry uses joint-world transforms and inverse bind matrices without reapplying the mesh-node transform. CPU work updates pose matrices; the GPU transforms vertices in the raster and shadow passes.

The loader centers the complete rest-pose asset in X/Z, places its bottom at Y=0, and scales its largest extent to two units. It reports original and normalized bounds plus the exact scale/translation. This placement applies once to static and animated geometry. It preserves authored root motion: travel clips can leave a camera fitted to rest bounds, and looping can jump from the final position to the initial position. The renderer does not silently remove that motion or follow it with the camera. Conservative current-pose joint bounds fit the shadow volume and camera far plane. The optional ground is a finite six-unit square; a traveling model can leave it.

For an explicit camera-framing action, the optional importer also exports
`measureImportedPoseBounds(asset, animation, { signal? })`. It returns a promise
with `bounds`, `unpaddedBounds`, per-axis `padding`, the resolved `animation`
receipt, `work`, `cpuMs` and `elapsedMs`. The animation receipt uses the same
clamping/wrapping rules as rendering. Stop animation advancement and retain the
submitted clip/time/loop and owning scene identity while measuring; revalidate
that identity before applying a camera change.

```ts
import { measureImportedPoseBounds } from '@strata-engine/core/gltf';

const measured = await measureImportedPoseBounds(asset, submittedAnimation, {
  signal: abort.signal,
});
// Fit a host-owned camera to measured.bounds after checking scene ownership.
```

This on-demand CPU operation visits positions referenced by triangle indices,
deduplicating within each primitive instance. Unreferenced accessor vertices and
the renderer's generated ground are excluded. Static positions already contain
normalization and are read directly; `asset.bounds` is not used as a shortcut.
Rigid and skinned positions use `createImportedPoseEvaluator`'s authoritative
float32 node/joint palettes. A skin combines its four weights after normalization
and does not reapply the mesh-node transform. The operation copies bounded pose
data and allocates deduplication bitsets, but does not copy transformed geometry,
fetch data, initialize an engine, query a GPU, or change a scene. Keep the borrowed
asset buffers immutable until it settles. Bounds cover indexed geometry,
including masked or culled triangles; they are not visible-pixel bounds.

`importedPoseBoundsLimits` exposes fixed admission limits: 1,500,000 traversed
index entries, 250,000 unique primitive-instance vertices, 1,000,000 joint
contributions (four per skinned vertex, including zero weights), and 1 MiB of
cumulative deduplication allocations. Each primitive allocates one bit per
accessor vertex; shared-buffer instances have separate visited sets. Pose
preflight also limits primitives and nodes to 4,096 each, skins to 1,024, total
skin joints to 32,768, clips to 256, channels to 4,096 and accounted node
transform, matrix and animation-array bytes to 8 MiB. The byte budget excludes
copied skin joint-index lists, which are bounded separately by the joint-count
limit. These bound the synchronous evaluator stage; its JS object and allocation
overhead are not a process-memory estimate. Cancellation is checked
before/after evaluation and at task yields after approximately 4,096 index or
joint-contribution work units. `SCENE_LOAD_ABORTED` reports cancellation,
`UNSUPPORTED_LIMIT` reports budget or unsafe float32-magnitude rejection, and
`INVALID_OPTIONS` reports invalid geometry/animation inputs. Rejection publishes
no partial measurement.

`unpaddedBounds` evaluates the exact retained float32 positions, weights and
palettes in double precision. For each transformed coordinate the padding uses
`gamma64 * S + 64 * m * X * (1 + R)`, where `u = 2^-24`,
`gamma64 = 64*u/(1-64*u)`, `m = 2^-126`, `X = 1+|x|+|y|+|z|`,
`S` sums absolute weighted palette-times-position contributions and `R` sums
absolute unweighted palette entries for that coordinate. Sixty-four relative
rounding steps conservatively cover four-weight normalization, palette blending
and affine evaluation. The absolute term allows subnormal flushing, including a
tiny weight or position multiplied by a large matrix. Using `S` rather than the
final coordinate magnitude protects cancellation. Intermediate absolute
magnitudes that cannot be bounded below finite float32 range are rejected.
The maximum per-axis allowance expands both ends of the nominal bounds; static
positions have zero transform padding. This is a conservative arithmetic
estimate, checked against independent scalar float32 operation models, not a
claim of exact GPU results or raster coverage.

Generated CPU measurements on an Apple M2, macOS Darwin 25.5.0, Node 22.23.0
used six indices per unique vertex, 163 pose nodes for deformed cases and four
skin influences. The table gives median main-thread elapsed time excluding
explicit task-yield waits, followed by total elapsed time, in milliseconds; each
size used three runs after a 5,000-vertex warmup. Asset generation is excluded.

| Unique vertices | Static CPU / elapsed | Rigid CPU / elapsed | Skinned CPU / elapsed |
| --- | ---: | ---: | ---: |
| 5,000 | 1.7 / 12.1 | 3.3 / 13.6 | 3.3 / 20.1 |
| 50,000 | 13.9 / 108.0 | 19.3 / 115.0 | 33.5 / 191.4 |
| 250,000 | 116.0 / 575.8 | 168.0 / 630.1 | 306.8 / 1081.4 |

These are generated Node measurements of this optional action, not a CPU
profiler, browser latency guarantee, GPU timing or frame-rate result. Task-timer
clamping and competing work can change browser elapsed time. The 250,000-vertex
skin case reaches the joint-work cap and yields 611 times; this work is intended
for explicit framing, not the per-frame animation loop.

Materials use linear factors and vertex colors, sRGB base-color/emissive textures, and linear metallic/roughness, normal and occlusion textures. OPAQUE and MASK materials share their alpha semantics with shadow rendering. `KHR_materials_unlit` preserves the base-color appearance without light, normal, occlusion or emissive terms. The surrounding ground still receives directional lighting and shadows. The ambient control is an explicit diffuse fill attenuated by material occlusion; it has no world-space visibility and is not indirect illumination. Emissive surfaces do not illuminate other surfaces.

Imported samplers request 8× anisotropic filtering when magnification, minification and mip filtering are all linear, to retain texture detail at oblique angles. Authored nearest filtering, non-mipmapped LOD limits and wrapping modes are preserved. Anisotropy adds sampling work without allocating additional textures; the adapter determines its effective filtering quality.

The supported diagnostic views are final, direct, shadow, depth, normal, motion and material. The existing `direct` view exposes current unfiltered shading, including explicit fill/emission or unlit output in this path. It is not an isolated direct-light energy measurement. TAA and camera cuts use the same shared temporal path as the procedural renderer.

Use the asset's warnings and clip list to drive the UI. Do not infer runtime feature support from catalog counts. Referenced texture coordinates beyond UV0, alpha blending, morph animation and unsupported required extensions need an explicit unsupported result. The loader is separate from the default runtime entry, and ordinary HTTP hosting needs neither an editor nor cross-origin isolation.

Loading is bounded by source and geometry byte limits. The default maximum uploaded texture edge is 2048; resizing occurs in memory and is visible in telemetry with source/upload dimensions, color space, mip count and estimated GPU bytes. A texture referenced in both color spaces may require separate GPU allocations. These estimates exclude driver, canvas and browser image-decoder allocations. The decoded CPU asset is reusable; callers must not mutate it during scene creation. Engine disposal and scene replacement release engine-owned GPU resources, while callers retain their CPU asset references. `setScene()` returns the same engine-local commitment receipt as other renderers, with renderer `imported`; imported telemetry separately identifies the source URL and effective clip time. Omitted imported control fields retain their prior values; explicit camera cuts reset temporal history when seeking.

Local collection files, derived assets and captures remain outside Git under the configurable external asset directory. See [the asset policy](benchmark-assets.md). CI uses small generated fixtures only. [Issue #33](https://github.com/tylerstuff/strata/issues/33) tracks implementation and validation; gallery images are not evidence of a general 60 FPS target.

The animation and skinning contracts follow the [Khronos glTF specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#animations) and its interpolation appendix.
