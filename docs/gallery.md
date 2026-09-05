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
separate environment controls add distant illumination. This ordinary mode remains
the default. The experimental static progressive preview below has a narrower
source contract; general imported GI, local reflections, virtual geometry and
world streaming remain outside this gallery's scope.

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
In ordinary mode, directional, ambient and environment illumination are additive.
This environment has no local visibility or interior occlusion and does not reflect surrounding
scene geometry. Unrestricted distant light cannot account for light blocked by a
room's walls. See the
[imported material lighting guide](imported-lighting.md) for the authored/relit
policy and the precise lighting approximation.

Camera exposure compensation changes the preview's displayed brightness. The number control
uses exposure stops (EV), with a default of 0 and an **EV 0** reset. Each +1 EV
doubles the presentation multiplier; −1 EV halves it. The multiplier is `2 ** EV`,
applied during presentation of final and tone-mapped radiance views; raw debug
views are unchanged. This is a brightness offset, not calibrated camera EV100.
Use the final view for indirect on/off comparisons. Scene-linear GI and temporal AA accumulation stay
unchanged, as do lighting, environment, source materials, sampling and resolution.
Exposure is retained when a model or scene is recreated, including texture-cap
and progressive-mode changes.

Clip selection, play/pause and timeline scrubbing are enabled only for animation
reported as supported by the runtime. A catalog clip count does not establish
runtime support. Unsupported animation or materials, texture resizing and other
importer diagnostics remain visible in Preview limits.
Root motion is preserved. Reset fits the rest-pose
bounds, and a traveling clip can leave that framing. Scripts can reframe by setting
the orbit target and distance. In ordinary mode, available Idle, F_idle or idle01 clips play initially;
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
remain explicit physical pixels. Ordinary temporal AA is enabled by default and can be
disabled independently of render size and animation playback.

## Static progressive preview

Progressive preview is an explicit, experimental opt-in for a static model with
exactly one used, lit, OPAQUE material and no rig, animation clips, deformation or
ground. Unused material entries do not count. Relighting an unlit source does not
make it eligible. Core validates and prepares the complete static source before
the gallery can commit the preview. This is bounded progressive diffuse transport,
not real-time GI or support for the whole catalog.

Choose a small physical render size explicitly before activation: 640 × 360
(230,400 pixels) or 320 × 180 (57,600 pixels) fits the default `maxPixels` limit of
262,144. Other GPU limits still apply. The gallery must reject oversized admission
or resizing; it does not silently shrink Fit or HD output to make the effect fit.
The panel requires a deliberate fixed-size selection before activation and makes
Fit/oversized choices unavailable while progressive mode is active. The window
API also requires a fixed size and checks the physical pixel budget. Leaving progressive mode retains the
current fixed size; it does not automatically restore HD output or Fit. The
progressive size limits still apply while its indirect contribution is disabled.
Render size and displayed CSS size remain separate, so use `getDisplay()` when
recording a capture.

Keep the camera, model and lighting stationary while submitting more frames to
accumulate samples. Camera, resolution, lighting, environment or effect-option
changes reset accumulation. Enabling the indirect contribution after a pause also
resets it. Frame count records scheduled work, not convergence or accepted samples
per pixel.

The requested studio/sky environment becomes the incident radiance source for
visibility-tested transport. Both the indirect-on view and its matched
indirect-off comparison force temporal AA off and exclude ordinary raster ambient
and environment lighting. Turning off the indirect contribution therefore shows
the same direct baseline; it does not restore ordinary unoccluded fill. Returning
to ordinary rendering requires a scene recreation. See
[the progressive lighting contract](imported-progressive-gi.md) for the single
secondary-surface diffuse approximation, geometric normals and texture LOD limits.

Mode changes reuse loaded source bytes and retain the camera. Precommit rejection
retains the prior ready view only when Core confirms that the active scene is
unchanged. Texture-cap recreation carries the selected preview mode rather than
silently returning to ordinary rendering. A failure after commit must remain
visible as a fault; it is not a rollback to the prior scene.

Core reports scheduling progress and GPU sample counters separately. The
`attempted`, `completed`, `exhausted` and `invalid` counters carry their own
accumulation revision and submitted-frame count. Missing readback is unavailable,
not zero. Check the revision and pending-reset state before treating a snapshot as
current. A readback may lag within the same revision; retain its own submitted
count. Pair the accumulation revision with `engineEpoch` and
`sceneCommit.sceneGeneration`, because scene recreation starts new accumulation.
Unknown or traversal-exhausted paths are never counted as open sky: they
mark that pixel's indirect estimate unknown until reset and leave it direct-only.
These diagnostics belong with the scene/view identity and image in any comparison.

After selecting an eligible static model, use the explicit scene mode and
contribution controls:

```js
const gallery = window.strataGallery;
await gallery.setViewport(640, 360);
await gallery.setSceneMode('progressive');
await gallery.setEnvironment({ preset: 'sky', intensity: 1, rotationRadians: 0 });
await gallery.setIndirectEnabled(true);
const indirectOn = await gallery.captureState(120);
// Capture the canvas now and pair it with indirectOn.state and getDisplay().
await gallery.setIndirectEnabled(false);
const matchedDirect = await gallery.captureState(1);
// Capture the same view with the indirect contribution off.
await gallery.setSceneMode('ordinary');
```

The 120-frame batch is a work budget, not a convergence claim. Repeated batches in
an unchanged progressive view continue its accumulation. `setSceneMode` accepts
`ordinary` or `progressive`; `setIndirectEnabled` controls the contribution inside
a progressive scene. `settings.sceneMode` defaults to `ordinary`, and the saved
`settings.indirectEnabled` preference defaults to true. `settings.temporalRequested`
retains the ordinary AA preference while `settings.temporal` reports the effective
false value in progressive mode. Activation preserves the ordinary preference;
exit restores it. While progressive is active, `setTemporal(true)` rejects before
mutation, and an explicit `setTemporal(false)` also changes the saved preference.
Ground is rejected rather than silently removed. The panel requires returning to
ordinary rendering before selecting another model. Scripted model selection retains
the selected mode and rejects incompatible sources. A rejection from a ready
progressive scene retains that view when Core confirms the scene is unchanged;
the caller can then return to ordinary mode to inspect rigged or animated models.

`getState().progressive` exposes `maxPixels`, source/presentation/viewport
`eligibility` reasons, Core `telemetry` or null, and `countersPending`. These checks do not
establish device, memory or BVH admission; Core's scene creation is authoritative.
Use the current Core telemetry collected by the fence for counter evidence;
`state.frame` is the earlier submission snapshot and may precede GPU readback.

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
await gallery.setExposureEV(1);
const clips = gallery.getState().asset.clips;
if (clips.length === 0) throw new Error('The runtime exposes no playable clips.');
await gallery.setAnimation({
  clipId: clips[0].id, timeSeconds: 0.5, loop: false, playing: false,
});
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

`setExposureEV(number)` asynchronously sets camera exposure while the gallery is
ready and idle. It accepts finite values from −16 to 16, inclusive. Invalid input
rejects before changing the ready view or its settings. Call `setExposureEV(0)` to
reset it. `getState().settings.exposureEV` and each capture's
`state.settings.exposureEV` record the selected value, while
`state.submittedView.exposureEV` records the exact submitted value; keep it with the image when
comparing captures. A changed exposure does not reset scene-linear GI or temporal
AA history.

The control surface also exposes `getCatalog`, `setScenePreset`, `setDebugView`,
`setOrbit`, `resetCamera`, `renderFrames` and `dispose`. Orbit angles are radians.
`setViewport` chooses physical pixels and locks responsive resizing; CSS can scale
the canvas down to fit the page. `getDisplay()` reports `mode` (`fit` or `fixed`),
`css` and `render` width/height, `devicePixelRatio`, and `nativeScale.x/y`, calculated
as `render / (css * devicePixelRatio)` for each axis. Record these values and the screenshot
scale with capture evidence; screenshot dimensions alone do not establish native
render density. The page's Fit viewport option restores responsive native sizing.
`setTemporal(boolean)` controls ordinary AA; its progressive-mode restrictions are
described above. `getState().settings.temporal` records the effective setting.
Progressive scenes always use false, including the matched indirect-off comparison.
Explicit frame batches are bounded to 1–120 frames. `captureState` defaults to four
frames and leaves rendering and animation paused. It returns state, not PNG bytes.

State distinguishes requested and last confirmed model identity. A rejected
texture-cap replacement retains the prior ready view only when Core evidence
confirms that the scene is unchanged. Ordinary model-selection failure stops rendering;
replacement failure without a commit receipt leaves active model identity
unknown. Failure after a commit can leave the candidate scene committed but the
gallery faulted.
Historical frame data does not establish a new readiness state. Device loss and
GPU errors stop the session; reload to recreate its engine.

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

Core's [lighting and estimator checks](imported-lighting.md#validation-scope) and
the earlier native-resolution/DPR gallery proof cover separate parts of this
system. They do not establish the combined browser behavior of the gallery's
material, environment and texture controls. Track validation of the exact gallery
revision in [issue #33](https://github.com/tylerstuff/strata/issues/33); no
performance or whole-VRAM guarantee follows from those functional checks.

Progressive preview acceptance requires Core's generated/public-browser checks,
combined gallery validation, and an actual-house witness with a fixed interior camera, verified source
and texture identities, zero unexplained invalid/exhausted paths, and a visible
blocked/offscreen transport comparison. CPU orchestration or successful static
preparation alone does not establish rendered house lighting. Follow
[issue #15](https://github.com/tylerstuff/strata/issues/15) and the
[progressive validation boundary](imported-progressive-gi.md#validation-boundary)
for that evidence; no new GPU or performance result is claimed here.
Camera exposure is not a validated fix for the failed house-lighting witness.
