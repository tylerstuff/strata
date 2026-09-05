# Complete fallback retention experiment

This opt-in experiment for [issue #13](https://github.com/tylerstuff/strata/issues/13)
changes page-cache admission, not the cooked asset, GPU selector or default policy.
Use `residencyPolicy: 'retain-fallback'` on a streamed virtual or integrated scene.
Omitting it selects the existing `greedy` policy. Resident and conventional mesh
comparisons reject the experimental policy rather than silently ignoring it.

The pool includes the same pinned roots. Request concurrency, staging reservations,
per-frame upload budget, page validation and retry limits remain unchanged. The
integrated courtyard still defaults to a 1 MiB pool and the legacy cooked asset.

## Contract and limits

For every tile in the latest accepted CPU demand, compute the production GPU
preference over *physically resident complete* LODs: exact desired, closest finer,
then closest coarser. Protect all dependencies of these choices and every pinned
root before admitting a target. Count shared pages once.

Admit at most one target whose entire dependency set fits alongside those protected
pages. Inspect demands in descending priority and ascending tile-ID order. When
current geometry is coarser than desired, try the desired level and then intermediate
levels that improve it. When current geometry is finer, consider only the exact
requested coarsening. Do not choose an extra coarse level just to free capacity.

Recompute protection before each upload/eviction and after every successful upload.
A shared page can incidentally complete a more preferred LOD for another tile; that
choice becomes protected even if the planner did not request it. Cached stray pages
are available for reuse, but cannot displace protected dependencies.

When no useful target fits, retain the complete alternatives and report blocked
demands. This can stall refinement or prevent a requested coarsening indefinitely
while the visible demand remains unchanged. The policy is a priority heuristic,
not a global quality optimizer, fairness policy, bounded settling-time guarantee or
proof that a useful plan always exists. Removing a tile from accepted demand
releases its detail protection; its root remains pinned.

The guarantee concerns mappings and the latest accepted demand. GPU feedback is
delayed. It does not establish that a CPU-selected fallback was displayed, protect
every possible new-camera selection before feedback arrives, or promise smooth
moving-camera geometry. Even for fixed demand, completing a new preferred LOD
changes topology and correctly rejects temporal history. This does not add geometry
blending or change shadow/trace-proxy approximations.

## Upload, cancellation and failure

Downloaded/validated bytes awaiting upload do not count as resident. A synchronous
`writeBuffer` failure leaves that page's previous mapping intact. Earlier successful
writes from the same update remain physical facts; they are not rolled back when a
later upload or frame encoding fails. Replanning protects complete alternatives
through partial target arrival, while demand replacement cancels unneeded requests.
Late cancelled results cannot resurrect an abandoned target.

`GpuGeometry.prepare()` already marks residency dirty after a cache-update failure
and rewrites the complete mapping table before a later submitted frame. A cancelled
encoder does not undo queue writes. No new submission hook is necessary for this
physical-completeness contract. Submitted work, GPU-observed selection and browser
presentation remain distinct; no presentation acknowledgment is fabricated.

## Diagnostics and comparison

Geometry telemetry records `residencyPolicy`, `retainedFallbackTiles`,
`retainedProtectedPages`, `retainedTargetTile`, `retainedTargetLod`,
`retainedBlockedDemands`, `retainedDeferredDemands` and `retainedUnsatisfiedDemands`.
The last counter means selected LOD differs from the exact request; a finer fallback
is not a visual missing-detail tile. Existing GPU `missingDetailTiles` still counts
only coarser-than-requested selection and refers to its recorded source frame.

The benchmark browser API accepts `residencyPolicy` and forwards it to the engine.
Reports record both the requested policy and actual runtime policy. A retained-policy
run fails if the engine does not report it active. The normal UI/defaults remain
unchanged. Compare the same asset, fixed pool, camera, resolution and lighting
settings; retain blocked/progress counters alongside image and timing evidence.
Do not attribute a speedup to retaining less useful detail or suppressing work.

## Why admission includes transition memory

The preceding CPU study used fixed 26/33/40/47-second target plans and exact subset
search, verified independently with set BFS. Under one direct active-to-target
switch per tile, retaining each old group until its prescribed replacement is
complete requires peak page counts of 16/17/17/16 for the legacy asset and
19/17/17/19 for the certified asset. Those frozen final plans already coarsen some
tiles, so avoiding additional transient fallback is not strict preservation of all
original detail.

These minima apply only to that specified migration model. Allowing one temporary
root fallback produces a 16-slot witness for all six blocked cases. Thus 19 pages
is not a universal lower bound, and a retention timeout cannot by itself resolve
the capacity conflict. This candidate keeps current complete detail when direct
admission is impossible instead of silently applying that temporary fallback.

External study:
`~/Downloads/Strata-Benchmark-Results/2026-09-05T06-05-49.169Z-cpu-sequential-lod-migration/`.
Exact JSON SHA-256:
`b3ead2bf466e81219dcbdec0e442a39a4590554bb92de2389998975d4aff4f5d`.
Independent verification/root-relaxation JSON SHA-256:
`22c238ed7e07d9e86b069f5c31d0a3ce989100fae826e453e4d8b4191b75f0ec`.

## Validation boundary

The independent small-set reference enumerates complete LOD choices and feasible
whole targets using a separate bit-set/ranking implementation. It checks 1,296
residency/demand/capacity combinations and 1,536 failure-flag combinations, plus
explicit shared-completion, direct
deadlock, intermediate, failed-request and input cases. Cache lifecycle tests cover
real validated page payloads, controlled completion and injected upload failures.
The CPU checkpoint passes all 279 repository unit tests and both TypeScript projects.

The hardware Chrome 152 check at commit `6da4b8b97eda3ee411a5ac165c77a86969691bc7`
passes all 47 frames across four real-cache cases on Apple's Metal adapter. A fresh
certified one-tile source has 8,192 finest triangles, seven levels, one root page,
five finest pages and three pages for the requested replacement. At a six-page
pool (393,216 bytes), greedy eviction temporarily selects the 256-triangle root;
retention keeps the 8,192-triangle complete fine level and explicitly reports the
blocked target. At nine pages (589,824 bytes), both policies keep the fine level
through partial replacement uploads and switch only once all three target pages
are resident. Every depth pixel matches independent ordinary-vertex geometry,
all 50,176 covered pixels remain covered, and history rejection occurs on topology
changes rather than on mere desired-LOD changes. These are fixed-demand cases;
incidental shared-page protection is covered by the independent CPU tests.

Run this witness with `node scripts/test-geometry-retention.mjs`; it is included in
`npm run test:geometry`. Hardware evidence and all images remain external under
`~/Downloads/Strata-Benchmark-Results/2026-09-05T06-37-05.716Z-geometry-retention/`.
Report SHA-256: `88708e7418884bc92d0fd6d18fb24142641f2f9c40e20090c0760a30069564cb`.

Matched-route measurements remain required before any default-policy decision. CPU completeness alone is not evidence
that the integrated benchmark looks better or reaches 60 FPS. Images and reports
remain external, and issue #13 stays open.
