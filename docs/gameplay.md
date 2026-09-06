# Playable character foundation

Refs #71 (M4), #47 and #8. Import the optional CPU-only helper from
`@strata-engine/core/gameplay`. Importing Core alone does not load it. Consumers
need no Rust tooling, DOM globals, physics worker or renderer to simulate it.

```ts
import { createCharacterController } from '@strata-engine/core/gameplay';
const character = createCharacterController({
  boxes: [{ min: [-10, -1, -10], max: [10, 0, 10] }],
  position: [0, 0, 0],
});
const state = character.advance(1 / 60, { x: 0, z: -1, jump: false });
// Publish state.position through the existing application transform palette.
```

Positions are Y-up foot positions in application units, normally metres. The
upright collision body has half-width 0.3 and height 1.8 by default. Movement
speed is 4 units/s, gravity 20 units/s², jump speed 7 units/s and maximum step
height 0.3 units. These are configurable. Diagonal input is normalized; there is
no acceleration, rigid-body pushing or rotation of the collision body.

The immutable collision world accepts at most 2,048 axis-aligned boxes. Geometry
is snapshotted at creation. Continuous slab sweeps of the expanded boxes prevent
thin-wall tunneling; simultaneous contact planes constrain sliding. Grounded
characters can step up where there is headroom and support, and snap down small
steps. Jumping requires a new button press while grounded; holding it does not
repeat. A press survives a render frame that executes no simulation tick.

`advance` accepts finite elapsed seconds in [0, 60] and normalized X/Z input in
[-1, 1]. It executes at most eight fixed 1/60-second ticks. Excess whole ticks are
discarded and reported in cumulative `droppedSeconds`, avoiding an unbounded
catch-up loop after suspension. Applications should reset their own wall-clock
baseline on visibility changes and pause. The helper owns no clock or listeners.
It does not promise deterministic cross-platform lockstep physics.

Snapshots contain owned copies of current/previous position, realized velocity,
grounded status, semantic idle/walk/jump/fall state, tick and interpolation alpha.
Interpolate previous to current for rendering; this intentionally adds up to one
simulation tick of visual latency. The motion state is an animation selection
signal, not a clip mixer. Input updates with invalid values reject before mutation.
Spawn/teleport overlapping solid geometry rejects; a valid teleport resets
velocity, interpolation and input/timing state. Notify Core of a camera cut when
teleporting the view. General depenetration is not implemented.

## Generated playable example

After `npm run build`, use `npm run example` and open
`/examples/character/index.html`. Click the viewport for WASD/arrow movement,
Space to jump and R to reset. The example builds its scene through public mesh
APIs and applies a single batched root transform palette without replacing the
scene each frame. It includes steps, a platform, walls, a following camera and
simple procedural limb motion. All geometry is repository-owned; the course
contains no downloaded assets. Its browser application imports runtime only.

`npm run test:character` packs/installs Core outside the workspace, resolves the
public gameplay export without a browser, then runs the same course through an
ordinary static server on software WebGPU. It checks keyboard movement/jump,
pause/reset, stable scene generation, GPU errors and disposal. The screenshot
and JSON receipt go to `STRATA_CHARACTER_RESULTS` or a temporary output directory.
`STRATA_TEST_BROWSER_CHANNEL=chrome` can select installed Chrome; otherwise the
pinned Playwright Chromium is used. This is functional evidence, not a hardware
performance result. Unit tests cover collision and time/input boundaries.

## Remaining milestone work

The original box controller is a bounded box-proxy checkpoint. Its interface does
not provide capsule/triangle collision, slope handling, a broadphase for dense imported scenes, moving
platforms, rigid-body simulation, skinned clip blending or camera obstruction.
The following camera can intersect walls, and the course has an open boundary;
falling off requires reset. Colliders must be authored separately and agree with
rendered geometry. Bistro's normalized render coordinates need an explicit unit
conversion and offline collision preparation before gameplay integration. Never
scan its millions of render triangles every simulation tick. The optional capsule path below addresses static triangle collision and slopes;
the broader imported-asset code/CLI authoring workflow remains tracked in #71/#8.

## Capsule collision for static imported geometry

The optional gameplay entry now also exports asynchronous `cookStaticCollision`
and `createCapsuleController`. These initialize the pinned Rapier 0.20.0
precompiled Rust/WASM backend internally. Its roughly 2.8 MB uncompressed JS/WASM
chunk loads only when one of these APIs is used. Core and the original box
controller do not initialize it. The package includes Rapier's Apache-2.0 license.

```ts
import { cookStaticCollision, createCapsuleController } from '@strata-engine/core/gameplay';
// Normally run this at asset preparation time, not during gameplay.
const collision = await cookStaticCollision({ positions, indices });
const character = await createCapsuleController({
  collision, position: [0, 0.02, 0], radius: 0.3, height: 1.8,
  stepHeight: 0.3, slopeLimitRadians: Math.PI / 4,
});
const state = character.advance(1 / 60, { x: 0, z: -1 });
character.dispose();
```

`positions` are packed XYZ Float32 values in application units, with Uint32
triangle indices. Source arrays are snapshotted before asynchronous initialization;
shared buffers, invalid indices/nonfinite positions and oversized meshes reject.
The current envelope is 128 MiB of source arrays, three million triangles,
coordinates within ±8192, and a cooked snapshot no larger than 256 MiB. This is an
admission ceiling, not a recommended production budget. Preparation creates a
static triangle collider with internal-edge correction and serializes its spatial
index. Loading restores that index, so each tick does not scan every triangle in
JavaScript. A tick batches movement/query work through WASM.

The version-1 collision contract names the exact `rapier3d-0.20.0` backend and
contains the snapshot and triangle count. Re-cook on backend upgrades; snapshot
compatibility across versions is not promised. Loading owns a separate world and
one kinematic capsule. It verifies the restored world contains a single static
solid triangle collider. Keep cooked content trusted and integrity-checked when
loaded from a server; the local Bistro adapter verifies the manifest SHA256.

`createCapsuleController` accepts the same speed/gravity/jump and bounded fixed
step conventions as the box controller. Its collision body is a vertical capsule
with a 0.01-unit contact offset. Slopes above the configured angle cannot be
climbed; downhill sliding and ground snapping follow that policy. Steps need
headroom and at least 0.1 units of free width. Collision is surface-based; this is
not a solid-volume inside/outside classifier for arbitrary triangle soups.
Spawns and teleports reject surface penetration exceeding 0.001 units.
`groundHeight(origin, distance)` queries the first downward surface for spawn
inspection. Use `dispose` explicitly; repeat disposal is safe and later simulation
calls reject. `diagnostics` reports owned worlds and snapshot size. The shared
WASM module retains its high-water linear memory after worlds are freed; zero
owned worlds does not mean zero process memory.

AbortSignal is checked before/after initialization and before publication during
cooking. The synchronous native restore/cook operation cannot be interrupted
mid-call. The current implementation has no worker cooking or streamed collision
cells. Dense mesh memory and load latency need further optimization.

### Offline glTF cooker

After building, run:

```sh
npm run cook:collision -- --input /external/scene.gltf --output /external/new-collision-directory
```

The output directory must be new and outside the repository. The cooker reads
static local glTF triangle geometry, applies node world transforms, ignores
textures, removes degenerate triangles and writes `world.bin` plus a final
`collision.json` success manifest. It records selected materials, exclusions,
source hashes, output hash, size and cook duration. `--include-material REGEXP`
allows an explicit collision subset. It does not generate simplified proxies.
Sparse/deformed/skinned geometry is unsupported. Keep imported files and all
cooked outputs external. Output snapshots are large and never belong in CI assets.

`/examples/character/index.html?capsule` uses the generated course with triangle
collision and an added shallow ramp. `STRATA_TEST_CAPSULE=1 npm run test:character`
validates this mode through the real packed package on software WebGPU.
`npm run test:collision:cook` exercises a generated transformed glTF and restores
the result, checking output isolation and no-overwrite behavior.

The local Bistro example now has a `playable` mode, converting metre-scale
simulation into the scene's render normalization. It keeps the existing skin and
walk clip; idle/jump do not yet blend to distinct clips. Its explicit collision
material subset includes architectural surfaces, pavement and selected furniture,
while excluding foliage. Closed doors are static geometry, not interactive doors.
Broader camera behavior, production collision simplification/streaming, and broader
route acceptance remain #71 work. This does not complete the entire M4 milestone.

### Lossless snapshot transport

Use `npm run cook:collision -- --input /external/scene.gltf --output /external/new-dir --gzip`
to write `world.bin.gz` instead of the raw snapshot. The final manifest includes
`transport` metadata with compressed/decoded lengths and SHA256 hashes. Omitting
`--gzip` preserves the original raw output. Both encoded and decoded snapshots
are limited to 256 MiB.

`decodeCollisionSnapshot(encodedBytes, manifest.transport, signal?)`, exported
from the optional gameplay entry, verifies the encoded hash, bounds streamed
output to its declared length, verifies the decoded hash and returns the raw
snapshot for `createCapsuleController`. It snapshots input and metadata before
awaiting. Cancellation rejects and releases the reader. A corrupt/truncated file,
length mismatch or over-budget output rejects before physics-world creation.
The host must provide Web Crypto and `DecompressionStream`; these APIs work in
the tested ordinary localhost browser deployment. No cross-origin isolation or
server-side automatic decompression is required. The manifest describes stored
compressed bytes, so an HTTP server must not silently decode them while keeping
that metadata.

This changes transport size only. Physics triangles, spatial index and native
world memory remain unchanged; decoding also needs temporary buffers. The local
Bistro snapshot is 218,849,397 bytes raw and 90,749,434 bytes gzip (58.5% fewer
transferred bytes). Its decoded SHA256 exactly matches the original. This is not
a measured load-time, frame-time or native-memory improvement.

`npm run test:collision:transport` runs the packed capsule course through the
public gzip decoder on software WebGPU. The cooker test compares decoded output
against the raw snapshot byte-for-byte; unit tests cover corruption, truncation,
size limits, cancellation and mutation isolation. Geometry simplification remains
separate work: the smaller experimental Bistro meshes failed route-preservation
checks and were not activated.

### Reusable camera obstruction query

The capsule controller exports `sweepSphere(origin, target, radius = 0.2)`.
It queries the existing static collision index in application units, excluding
its own character capsule. No second world, renderer dependency or asset-specific
code is required. A result is travel distance to first contact; `null` means
clear and `0` means the starting volume overlaps a triangle surface. Zero-length
segments still check initial overlap. Queries do not advance simulation.

For a follow camera, sweep from a clear head-height pivot toward the desired eye,
then shorten the distance to the hit minus a small margin. The generated capsule
course demonstrates this through the public package. Select a sphere radius that
covers your near-plane corners for your FOV, aspect ratio and near distance; the
example's 0.2-unit radius is not a universal clipping guarantee. Invalid starting
pivots require application recovery (for example, another pivot or camera mode);
a surface-based triangle world cannot classify enclosed solid volumes. The demo
collapses to 0.001 units when blocked at the pivot to keep its look direction
finite, which is not a guaranteed collision-free fallback.

This first query covers static collision surfaces only. It adds no camera
smoothing, orbit input, dynamic occluders or physics memory reduction. The local
Bistro adapter uses this query in metre units before render normalization. Unit coverage includes both wall
directions, thin walls, grazing volume hits, initial overlap, zero travel, invalid
inputs, unchanged simulation state and disposal. The packed capsule browser test
checks ground obstruction and clear travel through the exported method.
