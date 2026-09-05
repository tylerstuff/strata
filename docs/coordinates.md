# Global coordinate foundation

Status: selected coordinate contract and deterministic CPU prototype for
[issue #18](https://github.com/tylerstuff/strata/issues/18), with a restricted
[authored-box production integration](authored-boxes.md). That path uses the
camera-relative packer and submitted-camera motion. General scene integration,
world streaming, physics and browser multi-view rendering remain unfinished.
The terrain format/cooker/cache, lighting histories and restricted
[integrated courtyard](integrated.md) keep their existing coordinates.

## Decision and authoring boundary

Use CPU binary64 global positions as the authoritative representation. JavaScript
`Number` already supplies binary64; a future batched Rust implementation should
retain `f64` positions. GPU upload uses camera-relative float32 values. Integer
cells are a derived partition/index candidate, not an additional serialized truth.
This is sufficient for the tested offsets through ±1,000 km and avoids cell carry
rules in every entity edit and parent transform. It does not establish a maximum
renderable world size.

The owners of #18 and [#8](https://github.com/tylerstuff/strata/issues/8) agreed this
serialization boundary before implementing their separate foundations:

```json
{
  "coordinateSystem": "strata-world-v1",
  "transform": {
    "position": [1000000.001, 2, -3],
    "rotation": [0, 0, 0, 1],
    "scale": [1, 1, 1]
  }
}
```

This is a coordinate fragment, not a complete scene document. #8 owns scene schema
versions, document/entity/asset IDs, references, edits and CLI behavior. Its first
slice supports **root transforms only** and rejects parents. #18 owns the proposed
coordinate semantics and tests future parent composition here. No code from one
worktree is imported into the other. The prototype is outside all packages and is
not exported or bundled; #8 owns any authoring workspace/build registration.

| Field or convention | `strata-world-v1` meaning |
| --- | --- |
| Units and basis | Metres, right-handed Cartesian XYZ, +Y up, +X right, +Z backward. A camera at identity looks down local -Z with local +Y up. No geographic datum or latitude/longitude meaning. |
| Position | Three finite binary64 numbers. Each component has absolute value ≤ `2**30` metres, including composed global translations. This is an input rejection guard, not a precision/performance guarantee. |
| Tested envelope | Offsets 0, ±1, ±10, ±100 and ±1,000 km with small nearby detail. Componentwise offsets also exercise mixed signs/axes. The guard permits local fixtures around the ±1,000 km anchors. |
| Rotation | Finite XYZW quaternion, `abs(hypot(q)-1) <= 1e-6`; zero quaternion is invalid. Normalize accepted quaternions when evaluating transforms. |
| Scale | Three finite values in `[1e-6, 1e6]`, inclusive, dimensionless. Positive scales are an initial authoring restriction; imported meshes may require other handling. |
| Transform order | Column vectors, `T * R * S`; scale first, then rotation, then translation. |
| Parent semantics | A root position is global. A child's position is parent-local, measured before the parent's rotation/scale. Root and child positions are never both interpreted as global. |

Validation does not rewrite values. A deterministic document writer preserves
accepted numbers, except JSON serialization canonicalizes negative zero to zero.
It must not round decimal places, convert through float32, or silently renormalize
quaternions during load/save. The prototype's separate `canonicalTransform()` is
an explicit construction operation that normalizes quaternion length and negative
zero. Quaternion `q` and `-q` remain equally valid; sign canonicalization is not a
document requirement. Numbers that cannot be represented in binary64 cannot be
recovered by this contract. JSON round-trip tests start from valid binary64 values.

The coordinate marker and scene schema version are independent. Changes to units,
basis, position encoding/frame, ranges, normalization acceptance, or transform
semantics require a new coordinate marker and explicit document migration. Unknown
markers must be rejected, never interpreted heuristically. Adding hierarchy to the
root-only scene subset requires #8's scene-schema/capability change even though
future parent semantics are described here. Cells never replace stable IDs; a move
across a partition changes the derived membership, not an entity's identity.

## Parents and the precision boundary

Represent a composed CPU transform as binary64 `(L, t)`, where `L` is a 3×3 linear
matrix and `t` is a global translation. For parent `(Lp, tp)` and child local
`(Lc, tc)`:

```text
Lworld = Lp * Lc
tworld = tp + Lp * tc
worldPoint = tworld + Lworld * assetLocalPoint
```

Nonuniform scale followed by a differently oriented child produces shear. Keep
the affine product; decomposing it into a new rotation and diagonal scale loses
information. Arbitrary matrix/shear input is not part of the authored TRS schema.
Individual scale limits do not bound the conditioning or accumulated scale of a
deep hierarchy. The prototype rejects nonfinite composed entries, out-of-range
translations and float32 upload overflow; it does not certify arbitrary hierarchy
depth, inversion, normal transforms or microscopic composed scales.

Keep source vertices asset-local. A future importer/cooker must convert units and
asset basis explicitly, transform normals and winding appropriately, and subtract
an asset anchor in binary64 **before** quantizing positions/bounds to float32. A
camera offset cannot restore detail already rounded out of a large global vertex.
The current analytic terrain v1 has float32 world-space vertices/bounds inside its
small source domain; no bytes or interpretation of that format change here. A
placed-asset/anchor format needs a separate versioned proposal and validation.

CPU global bounds likewise need a high-precision center/translation and local
extents or equivalent conservative representation. Subtract the camera/region
origin before float32 bound upload. Apply rotation/scale to extents conservatively;
do not subtract an origin from dimensions, directions, normals or LOD error values.

## Per-view render frames and history

For this prototype each view uses its camera's binary64 global position as the
render origin. This keeps camera translation zero in the corresponding local view
matrix. Moving the camera changes the origin without mutating public positions:

```text
modelCurrent.translation  = f32(tCurrent  - originCurrent)   // subtraction in f64
modelPrevious.translation = f32(tPrevious - originPrevious)  // subtraction in f64
clipCurrent  = projectionCurrent  * viewRotationCurrent  * modelCurrent  * localVertex
clipPrevious = projectionPrevious * viewRotationPrevious * modelPrevious * previousLocalVertex
```

Only the resulting small translation and linear part become float32. Do not first
construct a large float32 world/view matrix and then subtract the camera. Asset
vertices remain local through the GPU model multiplication. At large camera-relative
distance, float32 precision still degrades; origin-relative arithmetic does not
provide arbitrary detail on distant geometry or solve depth precision.

Keep each previous model paired with the **previous** origin, camera rotation,
projection and temporal jitter convention. Pairing it with the current origin
erases or invents camera motion. Previous deformation/rigid-object transforms must
also match the previous submission. Origin/cell changes alone are continuous and
must not clear history. Submission/view identity and atomic camera snapshot storage
belong to future renderer integration, not this stateless prototype.

`renderTransformPair()` exposes `historyValid=false` and `previous=null` on the
first frame, an explicit camera cut, or an explicit object teleport. There is no
automatic distance threshold. Callers must declare discontinuities: a large
continuous step is not automatically classified as a cut. Camera cuts invalidate
screen histories for that view; object teleports invalidate the affected object's
reprojection and any dependent spatial caches under their own future policy. The
prototype does not reset, transport or update any live GI/reflection/TAA data.

Origins are per-view inputs, with no singleton or global rebasing state. CPU tests
exercise independent views, but production multiple cameras, stereo and portals
are not implemented by this slice. Future picking can add a view origin to a
local hit in binary64. Physics regions and tracing cache anchors need explicit
stable-global mappings and epoch/ownership rules; origin movement alone must not
imply moving physical objects or evicting valid world-space cache contents.

## Binary64 versus cells

The comparison candidate uses 1024 m cells, signed int32 cell XYZ and binary64 local
XYZ in `[-512,512)`. Normalization carries `+512` to the next cell's `-512`, keeps
`-512` in the same cell, and applies floor semantics in negative space. Cell overflow
is rejected. Input local offsets are bounded by `2**30`; a carry is computed in
one step, with comparisons against exact boundaries before computing the residual. Cells
are subtracted before reconstruction:

```text
relative = (cellObject - cellCamera) * 1024 + (localObject - localCamera)
```

This candidate can retain fine local precision over a much wider address range
when values remain split throughout the system. Splitting an already-rounded
binary64 global value cannot recover its lost digits. Adding float32 locals loses
precision even before upload (near a 512 m local boundary, rounding error can
approach 15.3 micrometres per input). Cell arithmetic complicates rotations,
parenting, carry/overflow validation and serialization without a demonstrated need
in the current test envelope. Derived spatial indexing remains useful regardless
of which representation owns positions.

| Position storage in packed separate arrays | Input bytes/position | Arithmetic before upload |
| --- | --- | --- |
| Binary64 XYZ (selected) | 24 | Three binary64 subtracts |
| Int32 cell XYZ + binary64 local XYZ | 36 | Three integer differences, three power-of-two multiplies, three local differences and three additions; normalization on edits |
| Int32 cell XYZ + float32 local XYZ | 24 | Same cell arithmetic with earlier local rounding |

These are typed-array payload sizes, not JavaScript object heap or total memory.
Both selected and candidate forms upload 12 bytes per relative XYZ. A binary64
3×3 linear matrix plus translation uses 96 payload bytes versus 128 for a full
4×4 binary64 matrix. This prototype allocates small objects/arrays for clarity;
it is not a throughput implementation. Future dense CPU work should use coarse
jobs and packed transferable buffers, avoiding per-entity TypeScript/WASM calls.

At 1,000,000 m, adjacent binary64 values are `2^-33` m apart (~0.116 nm), while
float32 spacing is 0.0625 m. At the `2**30` guard, binary64 spacing reaches
`2^-22` m (~0.238 micrometres), so the test tolerances below must not be extrapolated
to the entire permitted range. GPU float64, native wgpu features and shared-memory
threading are unnecessary for this approach. This follows the
[ECMAScript Number definition](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-ecmascript-language-types-number-type)
and [WGSL floating-point types](https://www.w3.org/TR/WGSL/#floating-point-types),
checked September 5, 2026; WGSL's abstract numeric evaluation is not runtime GPU
double-precision storage or arithmetic.

## Deterministic validation and optional cost experiment

Run the isolated CPU checks after `npm ci`:

```sh
npx vitest run tests/unit/coordinates.test.ts tests/unit/coordinate-frames.test.ts
npm run typecheck
node prototypes/coordinates/measure.mjs
```

The tests use procedural numeric fixtures only. BigInt micrometre ticks derive
ideal differences independently of binary64 subtraction. Binary boundary neighbors
and independently specified rational matrices cover normalization and noncommuting
parent transforms. An intentionally wrong early-float32 path must lose a 1 mm
displacement at 100 and 1,000 km, demonstrating that the tests can distinguish the
required conversion order. JSON, invalid numbers/ranges/scales/quaternions, carry
overflow, affine overflow, teleports and equivalent near-origin frames are covered.

Tolerances fixed for these fixtures:

| Check | Absolute error budget |
| --- | --- |
| Binary64 translation against ideal tick differences | `1e-9` m per component at offsets through ±1,000 km |
| Float32 relative upload against ideal difference `d` | `1e-9 + abs(d) * 2^-24` m per component |
| Bounded short rational parent fixture | `1e-8` m per component; exact binary fixtures use exact equality where possible |
| CPU projected current/previous positions vs near-origin reference | `1e-7` normalized-device-coordinate units per component |
| CPU motion difference vs near-origin reference | `2e-7` normalized-device-coordinate units per component |

The projection test uses an independent ordinary-depth CPU camera matrix, two
different frame orientations, nearby 1 mm vertices and matched current/previous
origins. It is **not** an image, shader arithmetic, raster jitter or depth-buffer
test. No rendered-stability or 60 FPS claim follows from it.

`measure.mjs` reports machine/Node details, seven alternating-order samples after
32 warmup passes, 32,768 active positions and 16 passes per sample. Its preallocated
typed-array kernels isolate the three representations and compare errors against
the procedural decimal offsets. Setup conversion is separately reported. They
exclude prototype validation/allocation, hierarchy traversal, rendering, WASM
interop and streaming. Timings have no pass/fail threshold and must be coordinated
with other hardware work. They are not the engine's browser benchmark protocol.

Recorded September 5, 2026 after the rendering task released its hardware window:
**45/45 scoped CPU tests and repository typecheck passed**. One cost-script run on
Apple M2, macOS Darwin 25.5.0 arm64, Node 22.23.0 produced:

| Kernel | Median ns/position | Maximum absolute upload error |
| --- | --- | --- |
| Global binary64 XYZ | 3.53 | 3.784 micrometres |
| Int32 cells + binary64 local XYZ | 5.41 | 3.784 micrometres |
| Int32 cells + float32 local XYZ | 5.12 | 29.297 micrometres |

The active differences are within ±100 m around signed 1,000 km anchors. Seven
sample durations ranged 1.848–1.934 ms, 2.833–2.971 ms and 2.374–3.014 ms respectively
for 524,288 positions per sample. JIT/timing variability makes this a local
arithmetic-cost observation, not a universal performance ranking. Cell setup took
2.168 ms including both local-array conversions; it is not included in the kernels.
The post-run power snapshot showed AC and Low Power Mode off; power was not sampled
continuously during this CPU experiment. Raw JSON remains outside Git. Script
SHA-256: `413bebd44dc85c0b38fdfe623b0be873258db719722200c68c960407c27ee8c3`.
The smaller selected payload, simpler semantics and equal tested precision support
binary64 XYZ for this foundation. No GPU run, build/packed-consumer test or full
`npm run check` was run locally; shared renderer regressions remain for CI and
coordinated integration.

## Deferred integration acceptance

The bounded production authored-box path now consumes the selected coordinate
packer and retains each last submitted camera/origin/model pack for motion
vectors. Its independent error gates, reset semantics and submission ownership
are described in [authored-boxes.md](authored-boxes.md#submitted-camera-motion).
It has no temporal resolve or jitter; the broader renderer integration below
remains unfinished.

1. Replace early float32 world/view construction at the production camera/model
   boundary (for example `rendering/raster-math.ts`) with matched binary64 scene
   evaluation and per-view relative upload. Preserve asset-local vertices and
   agree a versioned placed-asset/bounds contract without reinterpreting terrain v1.
2. Pair current/previous model, camera, projection/jitter, view ID and submission
   atomically. Integrate cuts and teleports with motion vectors and histories.
   Prove origin changes do not rewrite all world entities or cause recurring resets;
   measure work against active content, not world size.
3. Make culling, shadow receiver/caster bounds, raster, depth, picking and every
   supported lighting representation agree on frames and anchors. Evaluate reversed
   depth/near/far choices independently. GI and reflection cache transport/epochs
   require their own acceptance, including the courtyard's coarse tracing proxy.
4. Before implementing browser regressions, agree numeric image-space tolerances
   and run matched local scenes at the listed signed offsets, slow camera motion,
   parents, boundary crossings, cuts and teleports. Capture temporal, shadow and
   depth behavior, including nearby detail and distant landmarks; do not substitute
   this CPU projection budget for a rendered acceptance budget.
5. Run the complete `npm run check` and a built-package ordinary-browser WebGPU
   consumer, then coordinate named-hardware total-frame evidence under
   [the benchmark protocol](benchmark.md). A pinned Babylon Large World Rendering
   comparison, world partition/residency/traversal fixture, and end-to-end frame
   targets remain later #18 work. This foundation uses `Refs #18`, never closes it.

All fixtures here are numeric and procedural. No Sketchfab source, derived/cooked
assets or captures are included. Full-check/GPU availability and actual CPU results
are recorded on #18 and the implementation PR; the shared contract is also recorded
on #8.
