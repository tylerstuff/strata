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
- `rootPageIds` is the exact union of all tile-root page dependencies. Its pages are pinned, and no other page is pinned. Partial LOD dependencies are never sufficient to replace a complete resident level.

`parseGeometryManifest()` builds frozen snapshots after validating these relationships. `validateGeometryPage()` checks length and SHA-256 before upload; supplying the page's clusters also checks finite vertex channels, position containment, and local-index bounds. Fetch-produced `ArrayBuffer` data is returned as a view without a second page copy; the cache owns that buffer and must not mutate it during validation. Hashes detect corruption relative to the supplied manifest; they do not authenticate a manifest obtained from an untrusted publisher.

## Boundaries and approximation error

The height is `6 sin(x/19+p) + 3 cos(z/13-p) + 2 sin((x+z)/9+p/2)`, with seed-derived phase `p`. Positions and analytic normals are evaluated from global integer grid coordinates, so neighboring tiles produce identical boundary bits. UVs repeat every 16 world units.

The default LOD cell steps are 1, 8, 32, and 128. Smaller sources retain the applicable steps and include their full tile size as the root step. Finest cells use two source triangles. Coarser cells use a center fan, retaining every finest vertex and unit-length segment on the tile perimeter. Interior edges use the chosen coarser grid. Consequently every LOD covers the full tile area and any two adjacent tile LODs share the exact same perimeter polyline. This deliberately increases coarse-root cost to avoid cracks without stitching or skirts.

The source height Hessian has spectral norm below `M = 0.07`. Taylor's theorem bounds interpolation error by `M/2` times barycentric squared-distance variance. For a triangle of diameter `d`, that variance is at most `d²/3`. Coarse center-fan triangle diameter is at most its cell step `s`; a finest source triangle has squared diameter at most two. Therefore a conservative coarse-to-finest vertical deviation is `0.07 × (s²/6 + 1/3) + 0.0001` world units. The final margin exceeds float32 height-quantization error. Finest deviation is zero because its geometry is the source itself. Vertical deviation also bounds distance to the corresponding finest surface point with the same XZ coordinates.

The parser validates finite monotonic error metadata; the cooker supplies the analytic proof and tests it against sampled finest-source interpolation. Rust tests also verify positive winding, exact projected tile area, manifold perimeter edges, identical boundaries across all levels and neighbors, compact cluster limits, deterministic bytes, and standard SHA-256 vectors. TypeScript tests parse real temporary cooker output and reject corrupt pages, invalid indices, inconsistent dependencies, and overlapping ranges.
