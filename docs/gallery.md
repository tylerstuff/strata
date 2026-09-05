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
imported renderer. Model only is the default. The optional ground stays at the
rest-pose level; animated poses can cross it. Use Model only to inspect the full
pose. Lighting presets use a directional light and diffuse ambient fill; the
separate environment controls add distant illumination. Imported GI, local
reflections, virtual geometry and world streaming are outside this gallery's scope.

Material shading defaults to `authored`. Source unlit materials retain their base
color when lighting changes. The explicit `relit` mode interprets only those unlit
materials as matte dielectrics; source PBR materials keep their authored response.
Relighting preserves the base colors and animated pose, but does not reconstruct
the original author's missing material properties. The ground can still be lit
and shadowed in either mode.

The distant environment defaults to off. Studio and sky presets add generated
illumination, with intensity and rotation controls. Environment intensity is a
scene-linear multiplier from 0 to 64; rotation is about world +Y, shown in degrees
in the panel and supplied in radians through the API.
Directional, ambient and environment illumination are additive. This environment
has no local visibility or interior occlusion and does not reflect surrounding
scene geometry. Unrestricted distant light cannot account for light blocked by a
room's walls. See the
[imported material lighting guide](imported-lighting.md) for the authored/relit
policy and the precise lighting approximation.

Clip selection, play/pause and timeline scrubbing are enabled only for animation
reported as supported by the runtime. A catalog clip count does not establish
runtime support. Unsupported animation or materials, texture resizing and other
importer diagnostics remain visible in Preview limits.
Root motion is preserved. Reset fits the rest-pose
bounds, and a traveling clip can leave that framing. **Frame current pose** fits the
currently submitted pose once while keeping your viewing direction. It pauses
advancement, waits for that frame's GPU work, measures the retained model on the
CPU and fits the measured bounds to the current physical render size. Playback
then resumes with its previous preference, without advancing by the time spent
measuring. This action does not follow later animation: subsequent playback and
resizing preserve the chosen camera. Reset restores rest-pose fitting.
Scripts can also reframe by setting the orbit target and distance.
Available Idle, F_idle or idle01 clips play initially;
otherwise the gallery starts paused in the rest pose.
Catalog triangle counts describe stored source primitives; they are separate from
the runtime's actual submitted triangle count. The catalog's source SHA-256 covers
the recommended glTF JSON file only, not every buffer and texture dependency.

Texture quality requests a maximum image edge of 4096 px by default, with 2048,
4096 and 8192 options. Requested, selected and effective edges are distinct: the
device may limit an edge, and the gallery tries a lower option only when Core's
texture allocation estimate exceeds its texture budget. Decoder, validation and
renderer failures are reported instead of triggering a lower-quality retry.
Changing the texture cap recreates the scene from already loaded bytes while
retaining the camera, clip/time, live-view preference and other view settings;
temporal history resets. If no supported cap fits the budget, the operation fails.
The allocation estimate includes texture roles, mipmaps, fallback texels and the
fixed environment payload. It excludes buffers, frame/shadow targets, driver
overhead and the rest of process memory; it is not a whole-VRAM estimate. See the
[texture estimate contract](imported-lighting.md#texture-allocation-estimate) for
the budget and detailed scope.

Fit viewport (native) sizes the drawing buffer from the canvas's CSS dimensions
multiplied by the current device-pixel ratio, rounded to physical pixels. When a
device dimension limit is reached, one shared scale preserves the aspect ratio.
Layout, zoom and display-density changes update this size. Fixed render sizes
remain explicit physical pixels. Temporal AA is enabled by default and can be
disabled independently of render size and animation playback.

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
const display = gallery.getDisplay();
await gallery.setTemporal(true);
await gallery.setLightingPreset('daylight');
await gallery.setShading('authored');
await gallery.setEnvironment({ preset: 'studio', intensity: 0.5, rotationRadians: 0 });
const clips = gallery.getState().asset.clips;
if (clips.length === 0) throw new Error('The runtime exposes no playable clips.');
await gallery.setAnimation({
  clipId: clips[0].id, timeSeconds: 0.5, loop: false, playing: false,
});
const framing = await gallery.frameCurrentPose();
await gallery.setTextureCap(4096);
const frozen = await gallery.captureState(4);
// An external browser runner screenshots canvas#viewport, then verifies that
// frame/view/animation identity still matches frozen.state.
```

`setShading('authored' | 'relit')`, `setEnvironment(partial)` and
`setTextureCap(2048 | 4096 | 8192)` are asynchronous operations requiring a ready,
idle gallery. Environment updates merge `preset` (`off`, `studio` or `sky`),
`intensity` and `rotationRadians`; selecting `off` disables only the environment.
Its initial settings are off, intensity 1 and rotation 0. `getState().settings`
records `shading`, `environment`, the requested `textureCap` and the applied
`textureDecision`. The decision is null before a load; an applied decision reports
selected/effective caps, device limitation and any budget fallback. Effective
render controls are available under `settings.effective`, where
`lighting.environment` is null when the environment is off.

`frameCurrentPose()` requires a ready, idle gallery. It measures index-referenced
model geometry for the exact submitted clip/time/loop settings, including supported
rigid and skinned motion. It checks model, scene, view and frame identity before
applying one camera cut. Cancellation, stale input, an exceeded measurement budget
or an impossible fit leaves the camera unchanged; a healthy view remains ready.
Selecting another model or disposing the gallery cancels pending measurement.
A responsive resize cancels measurement and applies the requested size without
moving the camera during that handoff. A resize queued after the camera has been
applied preserves that camera and settles before returning; the receipt records
the final frame and dimensions. Other view changes reject while framing is busy.

The returned receipt records the measured `source` identity, `measurement` bounds,
work counts and timing, and the `applied` camera/frame identity.
`source.requestedAnimation` preserves the submitted controls; `source.animation`
records Core's resolved pose for that exact frame, including time zero for a
zero-duration clip.
`getState().poseFrame` retains the last successful receipt; its tags describe that
operation, even after later animation advances. `measurement.cpuMs` is elapsed
measurement time excluding deliberate task-yield waits; it is not a CPU profiler
measurement. `elapsedMs` includes those waits. The action reuses loaded bytes
and does not change lighting, materials or animation presets.

The control surface also exposes `getCatalog`, `setScenePreset`, `setDebugView`,
`setOrbit`, `resetCamera`, `renderFrames` and `dispose`. Orbit angles are radians.
`setViewport` chooses physical pixels and locks responsive resizing; CSS can scale
the canvas down to fit the page. `getDisplay()` reports `mode` (`fit` or `fixed`),
`css` and `render` width/height, `devicePixelRatio`, and `nativeScale.x/y`, calculated
as `render / (css * devicePixelRatio)` for each axis. Record these values and the screenshot
scale with capture evidence; screenshot dimensions alone do not establish native
render density. The page's Fit viewport option restores responsive native sizing.
`setTemporal(boolean)` changes AA, and `getState().settings.temporal` records it.
Explicit frame batches are bounded to 1–120 frames. `captureState` defaults to four
frames and leaves rendering and animation paused. It returns state, not PNG bytes.

State distinguishes requested and last confirmed model identity. A rejected
texture-cap replacement retains the prior ready view only when Core evidence
confirms that the scene is unchanged. A failed model selection stops rendering;
replacement failure without a commit receipt leaves active model identity
unknown. Failure after a commit can leave the candidate scene committed but the
gallery faulted.
Historical frame data does not establish a new readiness state. Device loss and
GPU errors stop the session; reload to recreate its engine.

## Validation

CPU catalog, timing and lifecycle checks use generated data and mocked engine
operations; they do not establish rendering correctness. Current-pose framing
has CPU bounds and lifecycle coverage; its actual browser behavior remains
unverified. The separate
`tests/browser/gallery-assertions.mjs` helper requires actual Strata WebGPU
submissions, two generated lit models and a visibly moving animation. It checks
model/lighting/clip pixel changes, Core-reported source and animation, fixed-size
resizing, capture stability, and disposal. Its caller owns the browser, server and
hardware report. CI uses the contained procedural fixture route and never reads
the downloaded collection. Actual-model captures require a separately scheduled
local hardware run, with results kept external.

Core's [lighting and estimator checks](imported-lighting.md#validation-scope) and
the earlier native-resolution/DPR gallery proof cover separate parts of this
system. They do not establish the combined browser behavior of the gallery's
material, environment and texture controls. Track validation of the exact gallery
revision in [issue #33](https://github.com/tylerstuff/strata/issues/33); no
performance or whole-VRAM guarantee follows from those functional checks.
