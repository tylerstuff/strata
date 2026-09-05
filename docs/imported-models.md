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

Materials use linear factors and vertex colors, sRGB base-color/emissive textures, and linear metallic/roughness, normal and occlusion textures. OPAQUE and MASK materials share their alpha semantics with shadow rendering. `KHR_materials_unlit` preserves the base-color appearance without light, normal, occlusion or emissive terms. The surrounding ground still receives directional lighting and shadows. The ambient control is an explicit diffuse fill attenuated by material occlusion; it has no world-space visibility and is not indirect illumination. Emissive surfaces do not illuminate other surfaces.

Imported samplers request 8× anisotropic filtering when magnification, minification and mip filtering are all linear, to retain texture detail at oblique angles. Authored nearest filtering, non-mipmapped LOD limits and wrapping modes are preserved. Anisotropy adds sampling work without allocating additional textures; the adapter determines its effective filtering quality.

The supported diagnostic views are final, direct, shadow, depth, normal, motion and material. The existing `direct` view exposes current unfiltered shading, including explicit fill/emission or unlit output in this path. It is not an isolated direct-light energy measurement. TAA and camera cuts use the same shared temporal path as the procedural renderer.

Use the asset's warnings and clip list to drive the UI. Do not infer runtime feature support from catalog counts. Referenced texture coordinates beyond UV0, alpha blending, morph animation and unsupported required extensions need an explicit unsupported result. The loader is separate from the default runtime entry, and ordinary HTTP hosting needs neither an editor nor cross-origin isolation.

Loading is bounded by source and geometry byte limits. The default maximum uploaded texture edge is 2048; resizing occurs in memory and is visible in telemetry with source/upload dimensions, color space, mip count and estimated GPU bytes. A texture referenced in both color spaces may require separate GPU allocations. These estimates exclude driver, canvas and browser image-decoder allocations. The decoded CPU asset is reusable; callers must not mutate it during scene creation. Engine disposal and scene replacement release engine-owned GPU resources, while callers retain their CPU asset references. `setScene()` returns the same engine-local commitment receipt as other renderers, with renderer `imported`; imported telemetry separately identifies the source URL and effective clip time. Omitted imported control fields retain their prior values; explicit camera cuts reset temporal history when seeking.

Local collection files, derived assets and captures remain outside Git under the configurable external asset directory. See [the asset policy](benchmark-assets.md). CI uses small generated fixtures only. [Issue #33](https://github.com/tylerstuff/strata/issues/33) tracks implementation and validation; gallery images are not evidence of a general 60 FPS target.

The animation and skinning contracts follow the [Khronos glTF specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#animations) and its interpolation appendix.
