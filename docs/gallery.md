# Local model gallery

Tracked in [issue #33](https://github.com/tylerstuff/strata/issues/33). The gallery
is an optional browser page for inspecting local models with Strata. The model
catalog, original files, derived inputs and capture results stay outside this
repository. Read [the asset policy](benchmark-assets.md) before using the local
collection.

The page consumes the contained loopback server's `/api/gallery/catalog` response.
It never reads filesystem paths or copies assets into its build. A missing
collection, unavailable entry or unsupported material must produce a visible
diagnostic instead of a substitute model. Attribution comes from the local
catalog and remains beside the selected model.

Start the local tool from a built contributor checkout with the external
collection configured:

```sh
STRATA_BENCHMARK_ASSET_DIR="$HOME/Downloads/Strata-Benchmark-Assets" npm run gallery
```

The launcher prints its loopback `/gallery/` URL. Ordinary runtime consumers
receive precompiled WASM; only engine contributors build Rust. The gallery imports
the optional `@strata-engine/core/gltf` entry separately from the runtime facade.

## Inspection controls

The gallery offers whole-model selection, orbit and reset, model-only or ground
presentation, explicit scene lighting, and only the debug views supported by the
imported renderer. Lighting presets use a directional light and ambient fill with
material AO only. That fill is not global illumination or image-based
lighting. Imported GI/reflections, virtual geometry and world streaming are
outside this gallery's scope.

Clip selection, play/pause and timeline scrubbing are enabled only for animation
reported as supported by the runtime. A catalog clip count does not establish
runtime support. Unsupported animation or materials, texture resizing and other
importer diagnostics remain visible in Preview limits.
Authored unlit materials retain their own color when lights change; the ground
can still be lit and shadowed. Root motion is preserved. Reset fits the rest-pose
bounds, and a traveling clip can leave that framing. Scripts can reframe by setting
the orbit target and distance. Available Idle, F_idle or idle01 clips play initially;
otherwise the gallery starts paused in the rest pose.
Catalog triangle counts describe stored source primitives; they are separate from
the runtime's actual submitted triangle count. The catalog's source SHA-256 covers
the recommended glTF JSON file only, not every buffer and texture dependency.

## Measurements and automation

CPU submission is the engine's CPU work for a submission. Callback interval is the
time between browser animation callbacks. Measured GPU span covers the available
timestamped passes from one actual frame, without summing overlapping durations.
GPU results arrive asynchronously and retain their engine, model, view and frame
identity. Missing measurements stay unavailable; zero is a valid measurement.
None of these numbers measures presented FPS or establishes a performance target.

The `window.strataGallery` control surface is intended for scripted selection,
repeatable views, explicit animation time and explicit frame submission. Capture preparation pauses ordinary
submissions, fences a fixed view and returns state for an external browser runner
to pair with a canvas screenshot. A GPU fence does not identify a compositor
presentation frame. Captures and reports must be saved outside the repository.

```js
const gallery = window.strataGallery;
await gallery.selectModel('light_fury');
gallery.setLive(false);
await gallery.setViewport(1280, 720);
await gallery.setLightingPreset('daylight');
const clips = gallery.getState().asset.clips;
await gallery.setAnimation({
  clipId: clips[0].id, timeSeconds: 0.5, loop: false, playing: false,
});
const frozen = await gallery.captureState(4);
// An external browser runner screenshots canvas#viewport, then verifies that
// frame/view/animation identity still matches frozen.state.
```

The control surface also exposes `getCatalog`, `setScenePreset`, `setDebugView`,
`setOrbit`, `resetCamera`, `renderFrames` and `dispose`. Orbit angles are radians.
`setViewport` chooses physical pixels and locks responsive resizing; CSS can scale
the canvas down to fit the page, so the browser runner must size its window for an
unscaled screenshot. The page's Fit viewport option restores responsive sizing.
Explicit frame batches are bounded to 1–120 frames. `captureState` defaults to four
frames and leaves rendering and animation paused. It returns state, not PNG bytes.

State distinguishes requested and last confirmed model identity. A rejected scene
replacement without a Core commit receipt leaves the active model identity unknown
and rendering stopped. Historical frame data does not establish a new readiness
state. Device loss and GPU errors stop the session; reload to recreate its engine.

## Validation

CPU catalog, timing and lifecycle checks use generated data and mocked engine
operations; they do not establish rendering correctness. The separate
`tests/browser/gallery-assertions.mjs` helper requires actual Strata WebGPU
submissions, two generated lit models and a visibly moving animation. It checks
model/lighting/clip pixel changes, Core-reported source and animation, fixed-size
resizing, capture stability, and disposal. Its caller owns the browser, server and
hardware report. CI uses the contained procedural fixture route and never reads
the downloaded collection. Actual-model captures require a separately scheduled
local hardware run, with results kept external.
