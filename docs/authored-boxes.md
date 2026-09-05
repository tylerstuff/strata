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

There are no parents, external mesh/material registries, imports, textures, emission, transparency, skinning, animation, shadow maps, GI, reflections or temporal histories in this profile. Unsupported descriptor fields reject with path diagnostics rather than disappearing. Empty scenes are valid and clear the background with no box allocations/draws. Existing procedural and integrated experimental renderers remain separate.

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

A complete `render({camera})` override applies to one authored frame without changing the descriptor or generation. It is checked before resource writes. The next frame defaults back to the descriptor camera. Camera overrides on legacy paths reject. Authored rendering defaults to temporal=false and final; explicit true, GI/reflection controls and other debug views reject. `timeSeconds` records a value without animating anything; `cameraCut` is a no-history no-op. Object, material and light edits use another atomic `setScene`.

For a capture, serialize mutations/submissions/resizes, verify the committed generation, render the explicit frame(s), freeze scheduling, fence with `waitForIdle`, then recheck ready/error state, current generation and last submitted frame before and after screenshot. Record an external engine/session ID, image hash and effective frame settings. A screenshot is a browser-composited capture associated with frozen submitted state, not an observed compositor frame ID. `waitForIdle` neither locks the engine nor verifies revision or presentation.

## Resource scope and verification

A nonempty scene uses one instanced raster draw, 12 triangles per box, `760 + 144*N` requested GPU buffer bytes, `648 + 80*N` initial upload bytes and `112 + 64*N` upload bytes per frame. Depth uses width×height×4 bytes. These counts exclude browser/driver padding and swapchain memory. Empty scenes have no geometry/depth resources. There is no hidden settling loop.

Validation covers frozen descriptors, numerical caps and independent packing references; lifecycle tests cover request races, aborts, cleanup failure and submitted identity. The browser witness and packed HTML/Vite consumer checks must pass before claiming rendered correctness. Keep capture evidence external. This profile does not close the larger authoring, coordinate integration, lighting or performance tasks.

### Hardware correctness checkpoint

At immutable source `2ec49d4a4eb3d2266829a224c376ea191a3e32eb`, Chrome152.0.7977.82 on the Apple Metal adapter passed 154 offscreen production-renderer frames plus three built-public-Engine submissions. The fixture has16 boxes at512×512, 55-degree vertical FOV, near0.1/far32:15 independently predicted visible boxes and one intentionally occluded box. This is a functional test, with no performance claim.

| Check | Observed result |
| --- | --- |
| Static reference coverage | Minimum per-object IoU0.996422 for the dyadic fixture and1.0 for the decimal fixture |
| Reference depth on eroded object interiors | 9,247/13,288 tested pixels; zero rejected pixels; maximum errors1.25838e-6/7.06473e-7 |
| Signed common offsets through1,000km | Both fixture variants produced bit-identical color/depth to their origin captures in this run |
| Camera motion at origin and1,000km | 32 paired steps per variant,31 visible changes each; each near/far pair had identical color/depth |
| Early-f32 negative control at1,000km | The right small box lost all of its64/100 predicted visible pixels; the left witness also moved |
| Direct PBR, edited materials and reversed light | 360 independently computed samples each, zero8-bit channel differences; zero radiance was black |
| Public Engine | Commit/submission receipts, per-frame camera override, resize/aspect, repeated revision, clear and disposal passed |

Acceptance thresholds remain distinct from those observations. Coverage IoU thresholds are0.98 against the independent oracle and0.995 for offset comparisons; centroid limits are0.5/0.25pixels. The depth threshold is2e-6 over eroded interior samples with an aggregate allowed rejection fraction of0.1%; this is not a per-object maximum-error guarantee. Paired motion tests establish offset equivalence and visible motion, not an independently verified camera trajectory at every step. The PBR sample oracle covers the dyadic origin fixture. Box axis normals test orientation/sign/stride; the need for inverse-transpose normals under nonuniform scale is established by the separate oblique CPU reference.

The100km negative control is reported without a mandatory visible failure: the dyadic gap changed geometrically but remained between the same pixel centers, whereas the decimal witness changed pixels. The1,000km negative control must fail both fixtures. No positive threshold was relaxed for these results.

The source/built-runtime hashes remained unchanged throughout the run, with zero GPU, browser, device-loss or cleanup errors. Reports and GPU-readback PNGs are external at `~/Downloads/Strata-Benchmark-Results/2026-09-05T06-52-41.359Z-authored-box-validation/`; report SHA-256 is `f5b284a2b0f14a77228d103a0852d4488488f5ec8aa2387356ce4af367bfd6ef`. These PNGs are encoded GPU readbacks, not compositor presentation receipts. Separately, the packed b17b8ac implementation passed ordinary HTML and production Vite hardware playback.

Run `npm run build && npm run test:authored-boxes` for the complete functional witness, or `node scripts/test-authored-boxes.mjs --prepare-only` for its CPU reference preparation. `node scripts/test-consumers.mjs --cpu-only` checks the built archive, TypeScript/SSR contract and Vite output without launching a browser; omit the flag for actual packed browser playback.
