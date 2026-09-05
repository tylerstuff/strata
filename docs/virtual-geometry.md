# Virtual geometry experiment

The opt-in virtual renderer draws a restricted static analytic heightfield from versioned, independently fetched geometry pages. A native Rust contributor tool cooks unique terrain, cluster bounds, conservative errors and LOD dependencies. Websites consume the cooked result through the ordinary TypeScript package; Rust is not required at runtime. See [the format specification](geometry-format.md) for the source restrictions and boundary proof.

```ts
import { createEngine } from '@strata-engine/core';

const engine = await createEngine({ canvas, profiling: true });
await engine.setScene({
  renderer: 'virtual',
  manifestUrl: '/terrain/manifest.json',
  geometryMode: 'streamed',
  poolBytes: 8 * 1024 * 1024,
  pixelError: 2,
});
engine.render({ timeSeconds: 0, temporal: true });
```

The current scene API provides a deterministic terrain tour and a top-down coverage camera for this experiment. Arbitrary game cameras, transforms, imported meshes, animation, occlusion culling, geometric compression and a general simplification hierarchy remain outside this prototype. It does not reproduce Nanite.

## Selection and coverage

Each tile has complete LODs whose finest boundary vertices and edges agree exactly with neighboring tiles at every level. The cache pins the entire coarse representation before making a scene usable. A requested level becomes eligible only when every page in its dependency set is resident. Visible GPU-selected tiles choose the exact requested level first, then the closest complete finer resident level, then a complete coarser fallback. This avoids dropping to the root when a coarser target is still loading but finer geometry remains available. It can render more triangles than the requested target; actual raster/shadow counts include that cost. Offscreen tiles retain their coarse policy, and `resident-full` retains its finest reference behavior.

This selection rule does not reserve the active representation or make its replacement atomic. The existing cache may evict finer pages before a new target is ready, leaving only coarser coverage. Refinement can still pop and exceed the requested pixel error while loading. Complete coverage does not imply full requested detail. No page-pool size, upload budget or temporal reset policy changes with the fallback rule; history is invalidated when the actual selected topology changes.

The GPU calculates tile visibility and projected approximation error, selects a complete resident level, culls clusters, and compacts triangle references for two indirect draws. The hardware rasterizer pulls actual positions, normals and UVs from the page pool. There is one indirect geometry draw for the main view and one for shadows, regardless of cluster count. Two dispatches share the `selection` timing pass. Depth, materials, normals and motion use the existing PBR intermediate targets, followed by temporal resolve and presentation.

Visible tiles cast shadows at their selected level. In `streamed`, `resident-lod` and `mesh-lod`, offscreen tiles retain coarse shadow geometry. This deliberately preserves offscreen casters but approximates their shape; it is not a separate shadow error hierarchy. `resident-full` instead keeps every tile at finest detail for shadows, including tiles outside the camera frustum, so it provides a stable full-geometry reference. Camera visibility only culls its main-view work. A tile changing LOD invalidates its previous-depth history for temporal rejection. Camera cuts, failed submissions, resize and temporal changes also reset the appropriate history.

## Residency and traffic

`poolBytes` includes pinned roots and is rounded down to whole 64 KiB pages. It must fit all roots plus at least one complete refinement. Requests are prioritized from asynchronous GPU feedback. Complete dependency groups reserve capacity before requests begin. A bounded number of requests and completed pages provide backpressure; updates upload at most `uploadBudgetBytes` per frame (default 256 KiB). Eviction chooses pages outside the current planned dependency union. Pages are length/hash/content checked before upload, with finite retries and request deadlines.

Scene creation accepts an optional `AbortSignal`. Replacing a pending scene request or disposing the engine aborts its work. A successful scene detaches the creation signal; later scene replacement or engine disposal controls its lifetime. Root failures reject scene creation; failed detail groups degrade to a coarser level. Cancellation and stale completions cannot repopulate a disposed cache.

The geometry pool is only one part of GPU memory. Metadata, page mappings, triangle work lists, indirect arguments, bounded readback buffers, PBR targets and temporal histories are reported separately in total engine allocations. CPU staging counts cover page payloads/reservations, not browser network buffers, manifest objects or general JavaScript heap.

## Comparisons and telemetry

`geometryMode` selects the same source and LOD data:

| Mode | Purpose |
| --- | --- |
| `streamed` | Fixed page pool, asynchronous demand/loading/eviction, GPU selection and indirect submission. |
| `resident-lod` | Preload all pages, retaining the GPU LOD path to isolate the cost of streaming. |
| `resident-full` | Preload all pages and select finest geometry for every shadow caster; cull camera-invisible geometry only from the main view. |
| `mesh-lod` | Conventional indexed mesh buffers, CPU tile LOD selection and one indexed draw per tile. |

The conventional path repacks all source pages into vertex/index buffers at startup and retains no GPU page pool. It reports its packed allocation and temporary CPU packing/staging separately. It culls whole tiles; the GPU path additionally culls clusters inside visible tiles. This is a useful conventional reference, not identical submission work: the results must report that difference as well as timing and memory.

`engine.getTelemetry().geometry` and each frame's `geometry` report resident/root/capacity pages, pending requests, upload/fetch totals, evictions, staging reservations, selected clusters/triangles, achieved maximum visible error and missing detail/coverage. The `clusters`, `lod`, `residency` and `coverage` debug views expose the selected geometry. Coverage is white for geometry and black for background, so validation can distinguish holes from dark lighting.

`missingDetailTiles` counts visible tiles rendered coarser than their requested LOD. A complete finer fallback meets the requested detail and is not counted as missing; raw GPU feedback still distinguishes requested and selected levels. The residency view uses green for selected detail at least as fine as requested and orange for coarser fallback. Older reports had no finer selection path, so their counter values retain the same meaning.

`npm run test:geometry` includes a controlled-residency GPU transition: finest ready, coarser target missing, target ready, and incomplete finer rejection. It compares actual pulled depth against separately decoded ordinary-vertex references, checks raster/shadow counts and per-pixel history rejection, and preserves offscreen/full-reference controls. `node scripts/test-geometry-fallback.mjs` runs the same bounded witness with four LODs, including a choice between two available finer levels. These functional checks do not establish active-page retention under real eviction or a frame-performance improvement.

On 2026-09-05, headed Chrome 152 on Apple M2 and Chrome's SwiftShader backend both passed all 13 four-LOD stages. The missing-target stage retained 8,192 triangles; when the closer finer level became resident it selected 480 triangles, then 264 when the exact target arrived. Each visible stage covered all 50,176 checked interior pixels, with zero depth difference against the independent selected-LOD reference. The target-only change preserved vertex history eligibility; actual topology changes invalidated it. An external negative control using the old `ac1ca51` shader failed at `coarser-target-missing` triangle counts. The complete hardware geometry suite also passed, including streaming, resize, disposal and the offscreen shadow reference.

Evidence remains under `~/Downloads/Strata-Benchmark-Results/`: hardware `2026-09-05T05-40-16.901Z-geometry-fallback`, software `2026-09-05T05-39-32.419Z-geometry-fallback`, negative control `2026-09-05T05-39-18.657Z-geometry-fallback`, and full hardware suite `2026-09-05T05-40-13.017Z-geometry-validation`. These runs captured the uncommitted change based on `ac1ca51`; focused reports include source status, bundle/manifest hashes and adapter identity. They are functional evidence, not a speed or visual-stability claim for the moving courtyard.

GPU counters are delayed. Their `sourceFrameId` explicitly identifies the measured submission, and `triangleCountSourceFrameId` labels the geometry contribution to the frame's triangle count. Fullscreen pass triangles are included in the total. Before the first feedback arrives, the source ID is null and GPU counts are unavailable. Timestamp and geometry readbacks use bounded rings and never block the frame loop. `flushGpuTimings()` also drains outstanding geometry feedback after a capture; it does not wait for all asset requests.

## Local measurements

The resident-full offscreen fix is a prerequisite for the terrain-stability work in [#13](https://github.com/tylerstuff/strata/issues/13), not a resolution of streamed surface popping. Its browser regression runs production GPU selection, compaction, vertex pulling and shadow filtering against independently decoded ordinary finest/coarse vertex buffers. On the generated 4×4-tile, 32-cell fixture, all 32,768 finest shadow triangles remain across visible → offscreen → visible camera changes while main-view triangles change 32,768 → 0 → 32,768. Shadow depth maps match the independent finest reference exactly, and the receiver remains fully shadowed; using the 2,048-triangle coarse surface makes that receiver fully lit.

Hardware Chrome and SwiftShader passed this regression on 2026-09-05, with raw reports and shadow images retained locally under `~/Downloads/Strata-Benchmark-Results/2026-09-05T04-31-39.276Z-geometry-validation` and `2026-09-05T04-32-11.826Z-geometry-validation`. The pre-fix shader failed the new offscreen finest-shadow count assertion (`2026-09-05T04-32-35.478Z-geometry-validation`), confirming the test detects the original error. These are functional results, not performance measurements; streamed budgets and other modes are unchanged. Earlier resident-full benchmark reports retain their original coarse-offscreen policy and must not be presented as measurements of the corrected reference.

The [M2 comparison](benchmarks/2026-09-05-m2-geometry.md) records the first matched conventional/resident/streamed runs. Streaming lowers tracked buffer memory and CPU submission cost, but increases the sum of overlapping GPU pass intervals and misses requested detail in 16.47% of sampled frames. Complete coarse coverage is validated separately from refinement quality.

Cook externally using the command in [geometry-format.md](geometry-format.md), then run:

```sh
STRATA_BENCHMARK_ASSET_DIR="$HOME/Downloads/Strata-Cooked-Geometry" \
  npm run benchmark -- --require-ac-performance --renderer virtual \
  --manifest terrain-v1-s1337-t8-c128/manifest.json \
  --geometry-mode streamed --pool-mib 8 --pixel-error 2
```

Repeat with `resident-lod`, `resident-full` and `mesh-lod` using identical camera, source, shading, resolution, temporal and error settings. The runner records the manifest SHA-256 identity, source quantities, exact mode and per-frame residency/counter history. Use `--page-delay-ms` for controlled delayed-loading tests. A smoke run validates functionality only; performance evidence requires the normal headed hardware run with warm-up and named power conditions.

The normal renderer protocol and report caveats remain in [benchmark.md](benchmark.md). The default fixture exceeds the streamed pool by over nine times; actual page requests, refinement and eviction must still be observed during a run. Fresh tiny procedural CI fixtures use a separate temporary-directory route. External collections, cooked assets, captures and raw reports are never uploaded as CI artifacts.
