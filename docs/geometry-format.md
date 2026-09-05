# Cooked analytic terrain, format version 1

This is a restricted static heightfield experiment. It does not simplify arbitrary imported meshes, skinned meshes, overhangs, transparent geometry, or the local Sketchfab collection. The finest level contains the entire unique generated source; drawing repeated instances is not used as a substitute for source geometry.

## Cook and store externally

```sh
cargo run --release --locked --package strata-geometry-cooker -- \
  --output "$HOME/Downloads/Strata-Cooked-Geometry/terrain-v1-s1337-t8-c128" \
  --seed 1337 --tiles 8 --cells 128
```

The default output is under `~/Downloads/Strata-Cooked-Geometry/`. The cooker refuses output under any Git checkout, including worktrees, and refuses unrelated nonempty directories or symbolic-link output files/page directories. Keep manifests and binary pages external together. Do not put these outputs in Git, LFS, releases, or CI artifacts. Unit tests generate small fixtures in the operating system's temporary directory and remove them afterward. No external models are read or copied.

The native Rust cooker is a separate contributor tool; website consumers do not build Rust. It uses the standard library without new third-party dependencies. The runtime WASM ABI remains unchanged. The pinned Rust toolchain and fixed source parameters determine the asset. Repeated runs on the same platform/toolchain are byte-identical; platform math-library implementations can affect transcendental rounding, so SHA-256 identities, rather than seed alone, identify the actual compiled content.

The default source has 8×8 tiles with 128×128 cells per tile: **2,097,152 finest triangles**. The initial implementation produces 17,728 clusters and 1,199 padded pages, totaling 78,577,664 bytes. Twenty-four packed root pages consume 1,572,864 bytes. These are geometry quantities, not performance results. All-level residency fits below WebGPU's 128 MiB default storage-binding capacity; the intended 8 MiB streamed pool is much smaller than the complete geometry pack.

### Optional certified LOD profile

`--lod-profile certified` adds intermediate steps 2, 4, 16 and 64 where applicable and computes tighter per-tile surface-error bounds. The default `legacy` profile and its output bytes remain unchanged. Certified output uses a separate default directory ending in `-certified-v1`; an explicit `--output` selects the destination as usual.

```sh
cargo run --release --locked --package strata-geometry-cooker -- \
  --seed 1337 --tiles 4 --cells 64 --lod-profile certified --trace-proxy
```

This writes `~/Downloads/Strata-Cooked-Geometry/terrain-v1-s1337-t4-c64-certified-v1/`. The optional tracing sidecar retains the same restricted source geometry but is linked to the exact new manifest hash. This profile does not refine the persistent tracing proxy or change its separate error bound. Do not reuse a sidecar from the legacy directory: changing render LOD metadata changes that identity even when finest vertices agree. The Rust API keeps `cook(config)` as legacy; contributors can opt in with `cook_with_profile(config, LodProfile::Certified)`. Websites still consume ordinary cooked assets without Rust.

The certified profile is a terrain-quality experiment for [#13](https://github.com/tylerstuff/strata/issues/13), not a guarantee of stable images or sufficient streaming capacity. More LODs increase total asset size. Dimension validation alone does not promise that every profile/configuration fits the runtime's 8,192-page limit or a device's all-resident storage-binding limit; cooking rejects oversized manifests. In particular, certified 16×16 tiles with 128 cells would require 8,263 pages and is rejected; the same dimensions with the legacy profile require 4,791 pages. All smaller dimension/profile combinations fit the manifest page/cluster limits, though their all-resident buffers may exceed a device limit. A smaller surface-error bound does not certify normals, screen-space error, shadows or temporal behavior. The streamed memory budget is unchanged, and no retention policy is added by this profile.

[The controlled fixed-camera report](benchmarks/2026-09-05-certified-terrain.md) records the asset/error ledger and actual depth, normal and direct-light comparisons. At 1 MiB the current planner improves some views but makes another worse; the profile remains opt-in while allocation and retention are investigated separately.

## Binary pages

Each page is exactly 65,536 bytes. There is no binary header. Unused bytes are zero-padded and included in the SHA-256 digest. Page URLs have the exact relative form `pages/000000.bin`, where the six-digit decimal filename equals the contiguous page ID. Resolve these paths relative to the manifest URL.

A cluster has two disjoint byte ranges within one page:

| Range | Encoding |
| --- | --- |
| `vertexOffset`, `vertexCount × 32` bytes | Little-endian float32: position XYZ, unit normal XYZ, UV XY |
| `indexOffset`, `indexCount × 4` bytes | Little-endian uint32 indices local to this cluster's vertex range |

All offsets are bytes and divisible by four. Each cluster contains 1–128 triangles, 3–384 vertices, and exactly three indices per triangle. Clusters do not share byte ranges, even when vertices have equal values. Finest clusters cover coherent 8×8-cell blocks, with 81 vertices and 128 triangles. Root pages pack clusters from multiple tiles and contain no optional detail clusters.

## Manifest interfaces and limits

The executable TypeScript interfaces and validator live in `packages/core/src/geometry/format.ts`. Top-level fields are `format: "strata-geometry"`, `version: 1`, `pageBytes: 65536`, `vertexStride: 32`, `indexFormat: "uint32"`, `source`, `bounds`, `pages`, `clusters`, `tiles`, and `rootPageIds`.

- `source` records `kind: "analytic-heightfield-v1"`, uint32 `seed`, `tilesPerSide` from 1–16, power-of-two `cellsPerTile` from 8–128, fixed `cellSize: 1`, and the exact finest `triangleCount`.
- Every bound is `{ min: [x,y,z], max: [x,y,z] }` in world units. Terrain is centered in XZ; Y is up. Bounds use finite values and contain all owned cluster positions. Serialized float32 extrema are represented exactly as JavaScript numbers.
- Each page has `{ id, url, byteLength, sha256, pinned }`. IDs equal array indices. The parser permits at most 8,192 pages.
- Each cluster has `{ id, pageId, vertexOffset, vertexCount, indexOffset, indexCount, triangleCount, bounds }`. The parser permits at most 262,144 clusters and checks page ranges for overlap.
- Each tile has `{ id, bounds, lods }`; IDs are row-major in XZ. The parser permits 256 tiles, matching the source grid.
- A LOD has `{ level, error, clusterIds, pageIds }`. Level zero is finest with zero error; ascending levels are progressively coarser with nondecreasing error. `pageIds` is the exact deduplicated dependency set of that LOD's clusters. A cluster belongs to exactly one tile LOD. The final level of every tile is its root representation.
- Certified manifests additionally record `cook: { profile: "certified-terrain-v1", lodSteps, errorMetric: "max-vertical-to-finest", monotonicEnvelope: true }`. This is contributor provenance; the existing runtime consumes the standard LOD/error/dependency fields and supports up to eight levels. Legacy manifests omit `cook`. The cooker rejects results exceeding the runtime page/cluster limits.
- `rootPageIds` is the exact union of all tile-root page dependencies. Its pages are pinned, and no other page is pinned. Partial LOD dependencies are never sufficient to replace a complete resident level.

`parseGeometryManifest()` builds frozen snapshots after validating these relationships. `validateGeometryPage()` checks length and SHA-256 before upload; supplying the page's clusters also checks finite vertex channels, position containment, and local-index bounds. Fetch-produced `ArrayBuffer` data is returned as a view without a second page copy; the cache owns that buffer and must not mutate it during validation. Hashes detect corruption relative to the supplied manifest; they do not authenticate a manifest obtained from an untrusted publisher.

## Boundaries and approximation error

The height is `6 sin(x/19+p) + 3 cos(z/13-p) + 2 sin((x+z)/9+p/2)`, with seed-derived phase `p`. Positions and analytic normals are evaluated from global integer grid coordinates, so neighboring tiles produce identical boundary bits. UVs repeat every 16 world units.

The default LOD cell steps are 1, 8, 32, and 128. Smaller sources retain the applicable steps and include their full tile size as the root step. The certified profile uses every power of two from 1 through the tile size, at most 1/2/4/8/16/32/64/128. Finest cells use two source triangles. Coarser cells use a center fan, retaining every finest vertex and unit-length segment on the tile perimeter. Interior edges use the chosen coarser grid. Consequently every LOD covers the full tile area and any two adjacent tile LODs share the exact same perimeter polyline. This deliberately increases coarse-root cost to avoid cracks without stitching or skirts.

The legacy profile uses the source height Hessian's spectral-norm bound `M = 0.07`. Taylor's theorem bounds interpolation error by `M/2` times barycentric squared-distance variance. For a triangle of diameter `d`, that variance is at most `d²/3`. Coarse center-fan triangle diameter is at most its cell step `s`; a finest source triangle has squared diameter at most two. Therefore a conservative coarse-to-finest vertical deviation is `0.07 × (s²/6 + 1/3) + 0.0001` source units. The final margin exceeds float32 height-quantization error. Finest deviation is zero because its geometry is the source itself. Vertical deviation also bounds distance to the corresponding finest surface point with the same XZ coordinates.

For the certified profile, the cooker forms the common subdivision of coarse and finest triangles in XZ. Its candidates include contained triangle vertices and exact edge intersections; checking only original vertices is insufficient for the non-nested boundary fans. Height difference is affine inside every intersection polygon, so maximum absolute vertical deviation occurs at one of those candidates. Original float32 heights are evaluated as exact float64 inputs with outward-rounded interval arithmetic. Each published source-space upper bound is rounded upward to float32, then a per-tile prefix maximum ensures monotonic LOD bounds. This envelope remains conservative if another seed produces nonmonotonic tight maxima.

The arithmetic proof is restricted to the validated cooker grid: at most 16×16 tiles and 128×128 cells, centered integer XZ within ±1024, and triangle edge components at most 128. Rational intersection denominators are at most 32,768; coordinate numerators at most 37,748,736; plane-weight numerators at most 18,253,611,008 and denominators at most 1,073,741,824. Orientation products remain below `6×10^14`, inside signed 128-bit range. Every integer-to-float64 conversion used in plane evaluation checks the exact-integer limit `2^53`. The certificate verifies the assumed finest vertex grid and triangle indices before measuring, so a triangulation change fails explicitly instead of silently reusing an obsolete proof. It does not accept arbitrary imported meshes.

The parser validates finite monotonic error metadata; the cooker supplies the analytic or interval proof and tests it against independent interior/edge samples of finest-source interpolation. Certified tests include crossing diagonals whose maximum occurs at an edge intersection, topology-change rejection and the maximum supported coordinate/root-step bounds. Rust tests also verify positive winding, exact projected tile area, manifold perimeter edges, identical boundaries across all levels and neighbors, compact cluster limits, deterministic bytes, and standard SHA-256 vectors. TypeScript tests parse real temporary cooker output and reject corrupt pages, invalid indices, inconsistent dependencies, and overlapping ranges.
