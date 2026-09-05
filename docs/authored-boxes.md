# Authored opaque root boxes

`@strata-engine/core` can load a small, explicit box scene without the optional Node authoring package. The renderer is lazy-loaded by `setScene({renderer: 'authored-boxes', scene})`; ordinary Core import stays browser-global-safe and does not start a worker or GPU. Website consumers install the prebuilt package, including WASM, without a Rust toolchain.

```ts
import { createEngine, validateAuthoredBoxScene } from '@strata-engine/core';

const engine = await createEngine({ canvas });
const scene = validateAuthoredBoxScene({
  format: 'strata.runtime-boxes', version: 1, coordinateSystem: 'strata-world-v1',
  sceneId: 'example', sourceRevision: null,
  boxes: [{
    id: 'red-box', dimensions: [1, 1, 1],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    material: { baseColor: [0.8, 0.1, 0.04, 1], metallic: 0, roughness: 0.5 },
  }],
  camera: {
    position: [0, 0, 3], rotation: [0, 0, 0, 1],
    projection: { kind: 'perspective', verticalFovRadians: Math.PI / 3, near: 0.1, far: 32 },
  },
  light: { directionToLight: [0, 0, 1], radiance: [2, 2, 2] },
  background: [0.02, 0.03, 0.05],
});
const committed = await engine.setScene({ renderer: 'authored-boxes', scene });
const frame = engine.render();
await engine.waitForIdle();
// A scheduler must also keep the scene, frame settings and canvas frozen while capturing.
console.log(committed, frame.scene, frame.authored, engine.getTelemetry().scene);
```

This first profile supports 0–1024 resident, opaque, root boxes, full quaternion rotation and positive nonuniform scale. Dimensions are full local lengths; each box is centered at its transform position. Coordinates use metres, right-handed +Y up and camera-local -Z forward; quaternions are XYZW. Camera-relative subtraction occurs in binary64 before GPU packing. This keeps a bounded local scene precise even when its world anchor is far from the origin; it does not make arbitrarily spread-out scene contents valid.

There are no parents, external mesh/material registries, imports, textures, emission, transparency, skinning, animation, shadow maps, GI, reflections or temporal accumulation in this profile. Unsupported descriptor fields reject with path diagnostics rather than disappearing. Empty scenes are valid and clear the background with no box allocations/draws. Existing procedural and integrated experimental renderers remain separate.

## Values and validation

The descriptor is plain JSON data. `validateAuthoredBoxScene(unknown)`, `validateBoxCamera(unknown)` and `validateAuthoredFrameCamera(scene, camera, width, height)` return independent, deeply frozen snapshots. They preserve accepted source doubles and quaternion components. Normalization happens only in evaluation copies. Unknown fields, accessors, hidden/symbol properties, class instances, sparse arrays and nonfinite numbers reject; no Node/Ajv dependency is used. `AuthoredBoxValidationError` extends `StrataError` and exposes frozen `{path,reason}` diagnostics.

- IDs are 1–64 lowercase ASCII characters, begin with a letter, and otherwise use letters, digits, `.`, `_` or `-`. Box IDs are unique. `sourceRevision` is null or a nonempty string of at most 256 UTF-16 code units: opaque caller correlation, not a verified document hash.
- Root and camera positions are finite and within ±2^30 metres on each axis. Quaternion norms must be within 1e-6 of one. Scale components are within [1e-6, 1e6]; dimensions are positive finite, and each dimension×scale is within [0.0001,1024] metres.
- Every complete transformed box AABB must lie within ±4096 metres of the effective camera on each world axis. Far-away content rejects; it is not silently removed. Geometric f64 AABBs are not claimed conservative bounds for all rounded GPU operations.
- Perspective vertical FOV is 1–150 degrees in radians; 0.001≤near<far≤4096, far/near≤100000, physical viewport aspect in [1/64,64]. Device texture limits also apply.
- Base color and background are linear RGB in [0,1], base alpha exactly one. Metallic and perceptual roughness are in [0,1]. The world-space direction towards the light is unit length within 1e-6; radiance RGB is in [0,64].

Final shading uses unshadowed GGX/Smith/Schlick direct lighting, no ambient/IBL term, fixed exposure one, the existing presentation curve and sRGB transfer. The same effective minimum roughness 0.06 applies to distribution and visibility; authored zero does not become a perfect mirror. `debugView: 'base-color'` uses the actual box transforms/depth but bypasses lighting and tone mapping for box colors. The background retains final presentation mapping in both views. No 60 FPS or general scene complexity guarantee follows from these validation caps.

## Atomic loads and frame identity

All renderers now return `Promise<SceneCommitReceipt>` from `setScene`; callers that ignore the awaited result continue working, but explicit `Promise<void>` wrappers must change. The immutable receipt contains `sceneGeneration`, exact renderer kind (or `clear`), and authored `sceneId/sourceRevision` (null for legacy/clear). Initial clear is generation0. Each accepted request gets an engine-local monotonic generation; gaps are allowed and identical source revisions still receive different generations.

Authored input is deeply checked/copied before it can supersede a valid pending request. The active scene continues to render while its replacement builds. New accepted loads, clear and disposal supersede pending loads; an optional load `signal` rejects promptly and late resources remain engine-owned for cleanup. Pre-commit failure retains the old scene. A committed scene and its identity swap atomically; generation-specific submitted frame IDs reset to null. `setScene(null)` commits its own clear identity without submitting a frame.

If retiring the old renderer throws after the swap, `SceneCommitError` reports `stage: 'retire'`, `commitOccurred: true`, and the historical `committedScene` receipt. Current telemetry still identifies the new scene; a rejected load promise alone does not prove rollback. Failed retirement remains owned for cleanup. A returned receipt can also be historical if another load commits before the caller resumes; compare generations.

Only a successful `queue.submit` advances `frameId` and `getTelemetry().scene.firstSubmittedFrameId/lastSubmittedFrameId`. `FrameMetrics.scene` identifies that submission; `FrameMetrics.authored` captures its effective camera, binary64 origin, aspect, physical width/height, debug view and time. Load success means committed resources, not rendered pixels, GPU completion or presentation. GPU errors may still arrive asynchronously.

A complete `render({camera})` override applies to one authored frame without changing the descriptor or generation. It is checked before resource writes. The next frame defaults back to the descriptor camera. Camera overrides on legacy paths reject. Authored rendering defaults to temporal=false and final; explicit true, GI/reflection controls and other debug views reject. `timeSeconds` records a value without animating anything. `cameraCut` explicitly invalidates submitted-camera correspondence for this frame. Object, material and light edits use another atomic `setScene`.

For a capture, serialize mutations/submissions/resizes, verify the committed generation, render the explicit frame(s), freeze scheduling, fence with `waitForIdle`, then recheck ready/error state, current generation and last submitted frame before and after screenshot. Record an external engine/session ID, image hash and effective frame settings. A screenshot is a browser-composited capture associated with frozen submitted state, not an observed compositor frame ID. `waitForIdle` neither locks the engine nor verifies revision or presentation.

## Submitted-camera motion

The authored raster pass also writes an internal, unblended `rgba32float` attachment. XY stores `previousUV-currentUV` in top-left normalized image coordinates. Z is current positive view depth in metres; W is expected previous positive view depth. The previous point uses its own submitted model/origin, camera rotation and projection. Interpolation happens in homogeneous clip coordinates before division. This is geometric correspondence, not evidence that the point was visible in the previous depth buffer. TAA, jitter, object motion and cross-generation matching remain unsupported.

`FrameMetrics.authored.motion` reports `previousSubmittedFrameId`, frame-level `valid` and `resetReason`. A first frame has a null previous ID and reason `first-frame`. An explicit cut has reason `camera-cut`; a viewport differing from the last submitted viewport has reason `viewport-change`. These reasons have that precedence. Resets retain the prior submitted ID when one exists. Invalid frame pairs, and individual prior points outside the prior clip volume or behind its camera, write exact zero XY/W while preserving current Z. Background motion is all zero. A valid frame may therefore still have rejected pixels.

Only a returning `queue.submit` commits the staged view. Validation, encode, command-buffer finish and submission failures do not become previous state. The next attempt restores all current/prior uploads, including after partial queue writes. Failed cuts do not persist. Failed resizes are compared against the last submitted viewport, so returning to its original size preserves correspondence. A successful cut or resize becomes the next baseline. A later telemetry failure cannot roll back a submitted view; asynchronous GPU/device errors follow the Engine lifecycle and are not a presentation receipt.

Camera translation, rotation, lens changes and origin changes preserve raw correspondence. Each view keeps its actual lens; jitter is exactly zero. An override followed by the descriptor camera compares against the submitted override. Pending or rejected scene replacement retains the old renderer's state; a committed replacement starts a new baseline even with identical box IDs. Each renderer owns its own current/prior data; there is no global origin or history. This does not add runtime world partitioning or multi-camera rendering within one engine.

The internal direct-renderer validation API must acknowledge each successful encode with `submitted(frameId)` immediately after queue submission, or discard it with `cancelFrame()`. A second encode with an unresolved candidate rejects. Texture ownership remains with the renderer; readback must be serialized with mutation/submission/disposal. Applications continue through the public Engine API, which owns acknowledgement.

## Resource scope and verification

A nonempty scene uses one instanced raster draw, 12 triangles per box, `824 + 208*N` requested GPU buffer bytes, `648 + 80*N` initial upload bytes and `176 + 128*N` upload bytes per frame. Depth and motion use width×height×20 bytes together. The two color attachments require 24 bytes/sample of the WebGPU render-target limit, distinct from texture storage bytes. The pipeline uses 15 vertex attributes and five vertex buffers, with no optional float32 blending/filtering feature. These counts exclude browser/driver padding and swapchain memory. Empty scenes have no geometry/depth/motion resources. There is no hidden settling loop.

Validation covers frozen descriptors, numerical caps and independent packing references; lifecycle tests cover request races, aborts, cleanup failure and submitted identity. The browser witness and packed HTML/Vite consumer checks must pass before claiming rendered correctness. Keep capture evidence external. This profile does not close the larger authoring, coordinate integration, lighting or performance tasks.

Motion acceptance was fixed on [issue #18 before implementation](https://github.com/tylerstuff/strata/issues/18#issuecomment-5552209232). An independent CPU ray mask, eroded two pixels from primitive boundaries, fixes each sample denominator. An ordinary-vertex GPU reference independently computes clips using binary64 Hamilton transforms; sharing fixed-function rasterization/interpolation does not certify the backend itself. Every selected sample must have the intended identity and finite values. Maximum component errors are 1/128 pixel for XY and `1e-4 + 2e-5*abs(expected)` metres for Z/W, with zero rejected samples. These are bounded-fixture thresholds. Equivalent dyadic sequences at signed offsets through 1000 km require complete motion-byte equality. Wrong prior origin, sign and prior frame must fail these same gates; existing color/depth/PBR thresholds remain unchanged. Historical hardware results below do not validate the new motion path.

Run `npm run test:authored-motion -- --prepare-only` for CPU landmarks, predetermined masks and fault sensitivity, or `npm run test:authored-motion` for actual production/reference GPU readbacks. Both write hashed evidence to a fresh external directory; `--output /absolute/external/directory` selects one. The motion harness exercises the internal renderer. Separately, `npm run build && npm run test:authored-boxes` exercises the built public Engine's motion metadata, cuts and scene receipts together with the original color/depth/PBR checks, and `npm run test:consumers` verifies packed HTML/Vite playback. Prior behind-camera rejection has CPU coverage; the GPU fixture's explicit rejection regions cover XY and near/far planes.

### Motion hardware checkpoint

At frozen source `dbccb6bd643b4996746168c21d044b4b69a78659`, installed Chrome 152.0.7977.82 on an Apple M2 using the non-fallback Apple `metal-3` adapter passed 106 production submissions and 110 independent-reference submissions, including four fault controls. All 602,890 selected positive samples passed. Maximum observed component errors were 0.003286936 pixels for motion and 0.000003100 metres for view depth, within the preregistered gates. Forty equivalent dyadic offset comparisons had byte-identical complete motion attachments. Each wrong-sign, wrong-prior-origin, older-prior-frame and canceled-frame control rejected every selected sample while preserving the current primitive-ID bytes.

The original authored color/coverage/depth/PBR gates, seven built public-Engine submissions and actual packed HTML/Vite WebGPU/WASM playback also passed. There were no reported GPU, device-loss, browser, cleanup or identity failures; all 138 built-runtime files still matched the motion-run manifest after packed-consumer cleanup. This is hardware functional correctness for the declared small fixtures, not performance or general temporal-rendering evidence.

Evidence remains external under `~/Downloads/Strata-Benchmark-Results/2026-09-05T14-10-21.426Z-authored-motion-validation/` (report SHA-256 `fc2aa396ddb59d9c4e3574b88a1b6178cdf8926028cc1ff5ce0f36fbc8fa2d50`) and `2026-09-05T14-10-45.209Z-authored-box-validation/` (report SHA-256 `ce19b1460b9e2f3c8a9d5a2d33c75a32beb501c4d86a896824ec83430b53685e`). The motion report records fixture/mask/gate hashes, every submitted pair, rejection regions and negative controls. The subsequent main-integration merge `f4f8f16dfadc84e1d18847ecd4474c2cd7ff6fef` has exactly the same Git tree as the measured source.

### Hardware correctness checkpoint

At immutable source `2ec49d4a4eb3d2266829a224c376ea191a3e32eb`, Chrome 152.0.7977.82 on the Apple Metal adapter passed 154 offscreen production-renderer frames plus three built-public-Engine submissions. The fixture has 16 boxes at 512×512, 55-degree vertical FOV, near 0.1/far 32: 15 independently predicted visible boxes and one intentionally occluded box. This is a functional test, with no performance claim.

| Check | Observed result |
| --- | --- |
| Static reference coverage | Minimum per-object IoU 0.996422 for the dyadic fixture and 1.0 for the decimal fixture |
| Reference depth on eroded object interiors | 9,247/13,288 tested pixels; zero rejected pixels; maximum errors 1.25838e-6/7.06473e-7 |
| Signed common offsets through 1,000 km | Both fixture variants produced bit-identical color/depth to their origin captures in this run |
| Camera motion at origin and 1,000 km | 32 paired steps per variant, 31 visible changes each; every near/far pair had identical color/depth |
| Early-f32 negative control at 1,000 km | The right small box lost all of its 64/100 predicted visible pixels; the left witness also moved |
| Direct PBR, edited materials and reversed light | 360 independently computed samples each, zero 8-bit channel differences; zero radiance was black |
| Public Engine | Commit/submission receipts, per-frame camera override, resize/aspect, repeated revision, clear and disposal passed |

The checkpoint's acceptance thresholds remain distinct from those observations. Coverage IoU thresholds were 0.98 against the independent oracle and 0.995 for offset comparisons; centroid limits were 0.5/0.25 pixels. The ideal-ray depth threshold was 2e-6 over eroded interior samples with an aggregate allowed rejection fraction of 0.1%; this was not a per-object maximum-error guarantee. Paired motion tests establish offset equivalence and visible motion, not an independently verified camera trajectory at every step. The PBR sample oracle covers the dyadic origin fixture. Box axis normals test orientation/sign/stride; the need for inverse-transpose normals under nonuniform scale is established by the separate oblique CPU reference.

The 100 km negative control is reported without a mandatory visible failure: the dyadic gap changed geometrically but remained between the same pixel centers, whereas the decimal witness changed pixels. The 1,000 km negative control must fail both fixtures. No positive threshold was relaxed for these results.

The source/built-runtime hashes remained unchanged throughout the run, with zero GPU, browser, device-loss or cleanup errors. Reports and GPU-readback PNGs are external at `~/Downloads/Strata-Benchmark-Results/2026-09-05T06-52-41.359Z-authored-box-validation/`; report SHA-256 is `f5b284a2b0f14a77228d103a0852d4488488f5ec8aa2387356ce4af367bfd6ef`. These PNGs are encoded GPU readbacks, not compositor presentation receipts. Separately, the packed b17b8ac implementation passed ordinary HTML and production Vite hardware playback.

### Independent raster-depth reference

The current harness compares the two static origin captures against a test-only ordinary-vertex GPU reference. It expands each scene into 576 homogeneous clip vertices using independent CPU Hamilton quaternion products, camera-relative subtraction and scalar perspective equations, then rounds once to float32. A pass-through shader sends those positions to the same device's fixed-function rasterizer. Integer object/face/triangle IDs and depth32float are read back. The reference preserves the declared winding and face diagonals without importing production geometry, packing or shader helpers; its camera comes from the intended test descriptor. Its clip generator is checked against the existing rational landmarks during CPU preparation.

Both renderers still face the analytic coverage, centroid and occlusion checks. Production-versus-reference depth uses the unchanged 2e-6 threshold and 0.1% aggregate rejection limit on the original analytic foreground interiors, including internal face seams. Missing or mismatched reference GPU IDs count as failures; they never reduce the sample denominator. Raw ideal-ray depth errors remain in the report as diagnostics, since fixed-function rasterization need not interpolate the ideal unsnapped triangle plane. This is a different origin depth reference, not an increased tolerance or an adapter-specific exception.

Both paths must preserve background depth exactly 1 and the applicable dyadic front depth 36544/40513 within 2e-6. The decimal static camera is rotated, so that constant-front sentinel does not apply there. A third reference submission changes only clip Z by `0.001*w`; its primitive-ID coverage must remain byte-identical and the same real depth assertion must reject it on the complete analytic interior mask. CPU preparation separately checks upload-word isolation and that missing reference IDs cannot remove samples.

The report distinguishes 154 production submissions from the three reference submissions. Origin/offset comparisons, dyadic byte equality, paired camera motion, early-float32 controls and the analytic PBR oracle retain their previous gates. Sharing the backend's rasterizer means this reference does not independently certify backend interpolation, nor does it add an independent reference for every motion step. The historical hardware checkpoint above does not validate this new reference; a fresh complete GPU run is required. No renderer behavior or performance target follows from this test change.

Run `npm run build && npm run test:authored-boxes` for the complete functional witness, or `node scripts/test-authored-boxes.mjs --prepare-only` for its CPU reference preparation. `node scripts/test-consumers.mjs --cpu-only` checks the built archive, TypeScript/SSR contract and Vite output without launching a browser; omit the flag for actual packed browser playback.
