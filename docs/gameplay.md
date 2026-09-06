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

This is a bounded box-proxy checkpoint. It does not provide capsule/triangle
collision, slope handling, a broadphase for dense imported scenes, moving
platforms, rigid-body simulation, skinned clip blending or camera obstruction.
The following camera can intersect walls, and the course has an open boundary;
falling off requires reset. Colliders must be authored separately and agree with
rendered geometry. Bistro's normalized render coordinates need an explicit unit
conversion and offline collision preparation before gameplay integration. Never
scan its millions of render triangles every simulation tick. Those capabilities
and the imported-asset code/CLI authoring workflow remain tracked in #71/#8.
