# Application mesh assets

Refs #47. This is the first fixed-topology conventional mesh slice, using the
existing optional imported geometry renderer. It does not implement the complete
general scene API in that issue.

`createMeshAsset({ meshes, materials, images?, maxTextureDimension? })` accepts
application-generated geometry without a glTF file. The returned `ImportedAsset`
can be passed to `engine.setScene({ renderer: 'imported', asset })`. No network,
GPU or worker operation occurs in the helper. The regular engine lifecycle owns
creation, supersession, cancellation, replacement and disposal.

Each mesh contains `name`, `material`, `vertices: Float32Array` and
`indices: Uint32Array`. Vertices are interleaved object-local position3, normal3,
UV2, tangent4 and linear vertex color4, with a 64-byte stride. Indices describe
triangle lists. One independent rigid root is generated per mesh, in array order.
The helper snapshots geometry, materials and images, preserves application units,
and computes bounds. It does not normalize everything to a two-unit object.
Material and encoded PNG/JPEG compatibility is validated during `setScene`.

Pass a complete `Float32Array` or `Float64Array` as
`engine.render({ imported: { transforms } })`. It contains one column-major 4×4
object-to-world matrix per root. Matrices use final scene coordinates, bypass
asset normalization, and must be finite and affine, with absolute f32 determinant
at least 1e-8. Nonuniform scales are supported. Reflected roots require every attached primitive
to use a double-sided material; single-sided reflections reject before submission. Values are copied
synchronously before palette upload; callers can reuse their buffer after render.
Shared-memory input palettes are rejected. Omission selects the normal rest or
animation pose for that frame; it does not retain the last application palette.

Transforms are a single batch: the whole candidate and resulting scene bounds
are checked before publishing any of it. A rejected candidate submits no frame.
The shared geometry path reuses current/previous GPU palettes; it does not reload
meshes or textures for movement. Only successful submission advances the previous
pose. Abandoned encodes invalidate temporal history safely on retry. Scene
commit receipts identify resource replacement, not per-frame pose revisions;
frame metrics identify submitted poses. Use `cameraCut` for application teleports.

This path shares directional shadows, PBR, material/depth/normal/motion outputs
and temporal resolve with imported rendering. Cameras, lights, unlit materials,
texture color spaces and filters use `ImportedControls`/`ImportedMaterial`.
Texture uploads and all GPU objects remain Core-owned. No raw device or encoder
is part of the public application contract. CPU palette validation runs in one
batch; dense vertex transforms and inverse-transpose normals execute on the GPU.

## Current limits

- 1–4096 meshes and materials; up to 1024 encoded images. Geometry and encoded
  images each have a 128 MiB source budget before copies. Normal GPU geometry,
  texture and adapter limits also apply.
- Local positions are within ±1024 units, transformed bounds within ±8192;
  camera eye/target remain within ±1024. This is not the large-world coordinate
  solution. Applications must choose units explicitly.
- Geometry, indices and materials are fixed after creation. Each instance has
  its own mesh allocation; shared geometry handles and dynamic vertices remain
  future work. Full palettes upload every frame, including unchanged roots.
- Only rigid root palettes are accepted: no hierarchies, skins or active clips
  combined with an application palette. glTF animation continues to work through
  the separate existing animation controls.
- Opaque and alpha-masked materials only. Blended sprites, transparent sorting,
  HUD passes, arbitrary viewport/scissor and raw texture updates remain pending.
- Dynamic application palettes explicitly reject static progressive tracing.
  This slice does not provide general world-space GI or scene-traced reflections.

## Example and validation

Run `npm run build && npm run example`, then open
`http://127.0.0.1:4173/examples/meshes/index.html`. The repository-owned example
contains a floor, wall and animated cube, with lighting/shadow/normal/motion views.
It imports the built Core package, keeps one scene generation throughout movement,
and has no external assets or game-port source.

`npm run test:consumers` exercises real archive installs in plain HTML and Vite:
mesh creation, batched movement, unchanged scene identity/allocation, invalid
update rejection, camera changes, temporal rendering, resize and retirement.
`npm run test:imported` additionally compares application palettes against analytic
normal/depth/motion and moving-shadow witnesses in generated GPU fixtures.
CPU tests cover snapshots, limits, rejection atomicity and submitted history.
These are functional checks, not image-quality or frame-performance acceptance.

The local SM64 example still uses a separate Fast3D adapter. Its existing packets
contain projected positions and baked combiner inputs, not the world-space mesh,
normal and material data needed here. Migrating that boundary is subsequent work;
creating this helper does not automatically upgrade the game's lighting.
