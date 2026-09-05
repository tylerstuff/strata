# Bounded trace updates for rigid fixtures

[Issue #20](https://github.com/tylerstuff/strata/issues/20) tracks this CPU correctness
slice for the legacy GI, selected-reflection and integrated courtyard fixtures.
Browser correctness and a matched hardware performance comparison are separate
gates. No frame-rate or elapsed CPU-cost improvement is established by the work
and byte counters described here.

## Representation and ownership

Keep the existing deterministic BVH topology, triangle order, source/material IDs,
five packed buffers and WGSL bindings. Integrated rendering shares the reflection
effect's trace owner. Imported progressive lighting, authored geometry and its
motion path are outside this implementation.

The internal updater owns fixed-capacity index maps, numeric snapshots, staging
and dirty-record metadata. It exclusively updates the supplied packed CPU data;
the effect retains GPU-buffer ownership. Construction prepares the index maps and
conservative bounds before the existing five initial buffer uploads. Initial work
and uploads are separate from incremental counters.

For a rigid transform, regenerate that box's twelve source triangles and update
their original packed slots. Recompute every affected leaf using all of its
members, including unchanged static members, then the deduplicated ancestor union
from children to parents. Unchanged terrain is neither regenerated nor scanned
in its entirety for a small object edit. Material-value and light changes avoid
geometry work; changing a box's material identity updates its triangle and box
records without changing geometric bounds.

Validate and stage the complete target before publishing packed bytes, numeric
snapshots or dirty state. Comparisons use owned numeric snapshots rather than
caller object identity. Equal-value updates do no trace work. Topology and static
source changes require recreation; no automatic rebuild is hidden in an update.

## Conservative bounds are a separate correction

The original leaf bounds enclosed source float32 corners. Packed tracing instead
stores a float32 origin and rounded float32 edges, whose mathematical endpoints
can extend beyond those corners. Each triangle's new bounds enclose both the
original source corners and the exact sums of stored origin plus stored edges.
Round minima toward negative infinity and maxima toward positive infinity in
float32; parents contain both children. Preserve the original topology words.

A plain JavaScript addition is not exact for every pair of float32 values with
widely separated exponents. The runtime must retain the addition's rounding error
when choosing outward bounds. The independent reference uses exact integer
dyadics, including tiny positive and negative endpoint terms. This containment
property does not certify the inherited ray/triangle or slab arithmetic.

Node-only differences from the original tight bounds are intentional and must be
reported separately from incremental-update results. Triangle, box, material and
uniform bytes remain exact against the original full refit. The incremental node
array must exactly match an independently recomputed conservative full refit on
the same initial topology. Later full-update performance controls must use this
same bounds policy.

## Queue writes and cancellation

Pending records are the union of every edit since the last complete successful
flush. Sort by buffer offset and coalesce only adjacent complete records. A buffer
with more than 32 resulting ranges uses one full-buffer fallback. This bounds a
complete five-buffer flush to 160 calls. Fallback traffic includes unchanged data
and is counted explicitly; the canonical moving-cube optimization gate cannot use
fallback or upload static triangle records.

The flush reads the latest canonical CPU bytes. Clear pending coverage only after
every `queue.writeBuffer` call returns. If a call throws, retain the entire union,
including ranges already written, so a subsequent edit and retry cannot leave a
mixture of old and new GPU data. Retried writes count again.

Queue writes are independent of the frame's command encoder. If a complete flush
succeeds and encoding or submission later fails, those writes are not rolled back.
The next frame may reuse them. Cancellation still clears the frame's pending
submission token and preserves the existing cache-reset behavior. No extra GPU
staging buffer, synchronous wait or worker call is introduced.

## Counter and version meanings

The existing scalar GI telemetry receives flat `trace`-prefixed fields. Its values
describe cumulative operations, current pending work and explicit source versions:

| Counter family | Meaning |
| --- | --- |
| Update count | Accepted CPU target changes; excludes equal-value no-ops and rejected edits. |
| Changed boxes, regenerated and packed triangles | Actual geometric generation and packed-record work, distinguished for material-identity edits. |
| Refitted leaves and ancestors | Deduplicated bounds computations; an unchanged result may omit its upload. |
| Attempted write calls | Calls entered, including a throwing call. |
| Queued write calls and bytes | Calls that returned, including successful calls preceding a later failure. |
| Full-buffer fallbacks | Attempted fallback writes, including failed and retried attempts. |
| Pending ranges and bytes | Current bounded upload plan; reflects fallback sizes. |
| Metadata bytes | Retained typed-array payload for maintenance; excludes JavaScript object and driver overhead. |

For `T` triangles, `N` nodes, `B` boxes and `M` materials, retained maintenance
payload is `37T + 38N + 1238B + 166M + 1433` bytes. The canonical courtyard
(`T=2204`, `N=1335`, `B=13`, `M=6`) therefore retains 150,801 bytes. This
includes 52,896 bytes of cached triangle bounds, 32,040 bytes of staged node
bounds and 9,984 bytes of dynamic triangle staging. It excludes the original
184,640-byte packed source and its borrowed views. Updates keep typed backing
stores fixed, but still create bounded per-changed-box JavaScript triangle/vector
objects and small views/results; this is not a zero-allocation claim.

The CPU target update count and fully queued update count are distinct. A partial
flush cannot advance the latter. Version zero is the creation source after its
separately counted initial upload. Each frame captures the queued version it uses;
only `submitted(frameId)` publishes that captured version and frame ID. A later
CPU edit cannot relabel an earlier encoded frame, and a cancelled frame publishes
neither field. Queue return and submission are not GPU-completion receipts.

Reflection telemetry aliases the CPU, queued and last-submitted update counts and
last-submitted frame ID. Shared work, upload and maintenance-memory counters remain
in GI telemetry only, so their cost is not counted twice.

These counters complement the existing frame upload total. Successful writes
preceding an encoding failure can be absent from a returned `FrameMetrics`, so
cumulative maintenance counters retain their attribution. Do not infer GPU work,
total-frame duration or CPU milliseconds from record counts.

## History and validation boundary

The standalone GI renderer retains reset-on-world-revision behavior. Reflection
and integrated object-only motion retain bounded diffuse rolling refresh while
advancing the world/reflection revision and resetting reflection/TAA history.
Door, material, roughness, light, explicit reset and re-enable events retain their
hard invalidation behavior. Trace maintenance does not preserve stale lighting to
reduce update cost.

The preregistered CPU checks use the original full update on the same topology,
an independently implemented conservative full-node reference, and an independent
source-triangle plane/Gram oracle. They include a fixed 512-ray corpus, rigid and
material/light edit sequences, exact containment adversaries, byte-addressed
partial-write failures and supersession, cancellation, disabled effects, disposal,
and bounded scratch/range accounting. The canonical cube must preserve all static
triangle bytes and reduce trace upload bytes by at least 90%; that is a deterministic
work gate, not a timing result.

The external CPU witness used the original seed-1337 courtyard asset (proxy JSON
SHA256 `e5341ca032a49c21591f3a47029c301ad0325e6abdde3bb1542f2e6e5cbee47c`)
and a base-only topology/ray plan frozen before candidate execution. Moving the
cube from offset zero to `0.4` regenerated and packed 12 triangles and recomputed
5 leaves plus 19 ancestors. Only three node records changed: the upload totaled
96 node bytes, 768 triangle bytes and 48 box bytes across seven calls. The
912-byte total is 99.506% below the original 184,640-byte full trace upload, with
zero static triangle writes and no fragmentation fallback. This is CPU/fake-queue
evidence of the byte plan, not a measured GPU transfer or frame-time result.

That witness matched full-reference packing and independently recomputed
conservative nodes, including physical byte-array state after writes. Its fixed
512-ray corpus across eight states met the preregistered independent-source gates:
499–511 non-boundary rays, 57 terrain hits and 16–18 selected-mirror cube hits per
state. Initial canonical node bounds needed no expansion; isolated numerical
adversaries separately demonstrate and test the bounds correction. Immutable
candidate manifest SHA256 is
`0f3e875bf09edba3161bc80f76daa0a4d904359a41f58ca0b181627513edccee`,
and result SHA256 is
`524b187a2ba8f200ee97fdd424f2aabcfb9aef60d8560dcecdcdebde4e273b0f`.
External evidence locations and subsequent validation are recorded in issue #20;
the synthetic tilted-plane unit fixture is a separate source.

The historical M2 opening-phase report motivates this task but predates later
quality fixes. After independent review and browser correctness, performance
needs a separately frozen full-update control and candidate with identical source,
bounds, shaders and cache policy: the same 60-second route, 30-second warmup,
1 MiB pool, fixed 720p/1080p resolutions and verified hardware/power conditions.
Report actual trace and total uploads, CPU distributions, GPU span, callback
stalls, retained memory and visual differences separately.

## Actual-write correctness harness

`scripts/test-trace-updates.mjs` prepares a separate diagnostic build. Preparation
is CPU-only; it loads the original external courtyard and frozen 512-ray ABI,
validates every asset hash, and writes immutable input, step, source, expanded
WGSL and bundle manifests outside the repository. A dirty draft is explicitly
non-runnable. Use a new output directory for every preparation and run.

```sh
node scripts/test-trace-updates.mjs --prepare-only \
  --asset-root /external/courtyard --rays /external/preregistered/rays.bin \
  --output /external/new-proof-preparation
```

After independent review of the clean harness and its manifest, an explicitly
allocated local GPU window can use `--run --manifest PATH --manifest-sha256 SHA
--output NEW_EXTERNAL_DIR --adapter hardware` (or separately named `software`).
Running without a mode is an error. The adapter class must match the requested
class; the runner does not silently switch to a fallback adapter. Browser
execution has a ten-minute deadline and bounded diagnostic readbacks.

The direct stage exercises the production updater on real buffers, including
partial-write prefixes, retries and the canonical byte plan. Renderer pairs use
the same GI/reflection/integrated code with separate resources on one device;
only the full-control bundle replaces the internal updater. Exact cache, source
and defined-image comparisons remain failures when they differ. A separate
candidate-only 1 MiB residency case labels missing churn coverage unexercised.

The full control uses independent BigInt bounds and brute reference work. It is
**ineligible for performance comparisons**. Preparing this harness or passing
its CPU tests establishes neither GPU correctness nor image quality or 60 FPS.
No benchmark assets, generated bundles or captured images belong in Git or CI.
CPU checks are `node --test scripts/test-trace-updates.test.mjs`, the four
`trace-update`/`full-trace-updater` unit files, and both TypeScript configurations.
## Hardware correctness receipt

The one frozen correctness run at `ed83499eb6a12f86a94073554ffd86af8c765ac5`
passed on Chrome 152.0.7977.82 with a non-fallback Apple Metal 3 adapter.
Its production runtime is byte-identical to PR #40 head `1f4cfdf`; the additional
source is diagnostic tooling and documentation. The later main wording merge
does not relabel this evidence as a new-source run.

The run verified 71 direct-update cases, 460 GPU source readbacks and 32 query
outputs, including the canonical 912-byte/seven-write update with no static
triangle writes. All eight states of the 512-ray closest/any corpus matched the
full correctness control. GI, reflection and integrated pairs passed their
cache/image, disabled-mode, moved-emitter and reset/retry checks. Candidate-only
1 MiB streaming observed 83 mapping changes in 120 records with unchanged trace
data. Browser/GPU errors were empty, the final source guard was unchanged, and
all tracked renderer resources were released. This is single-device correctness,
not elapsed-performance or general visual-quality evidence.

The realized reflection/integrated plans each contain one `soft-motion-8` offset
that differs from Node's frozen plan by one binary64 ULP, caused by cross-runtime
`Math.sin`. Both arms used the same realized value; both values round identically
to float32. An exhaustive follow-up comparison found only those two plan deltas,
and CPU reconstruction of all 126 states found identical bytes in all five trace
arrays, including node bounds. The affected GPU hashes match the frozen targets.
Literal frozen JSON identity was therefore not achieved, even though the paired
tracing inputs were equivalent. Original artifacts remain unchanged; subsequent
harness runs must consume the reviewed serialized steps directly.

Manifest SHA256: `d14e8cb97c98fc26778ce3e9696e14a4f5a44f9f73e4e71af93b422ee8c1f3e6`.
Hardware report SHA256: `f9b5e5f7cebbb397d01df526d35d2c43307f55b8fb0d6f4fc7359344450b1136`.
Complete plan-delta audit SHA256: `eaf08e2bd1f540dd733bb3c4ab5fee462e2881ae9eee8e6ecfd858e40914055a`.
The [issue receipt](https://github.com/tylerstuff/strata/issues/20#issuecomment-5553908388)
records exact source, external artifact paths, independent audits and limitations.
The BigInt full control is correctness-only. Issue #20 remains open for the
matched 30-second warmup / 60-second 720p and 1080p performance comparison using
the original 1 MiB workload and a production-policy full maintenance control.
## Matched performance preparation

`tests/helpers/full-trace-performance-updater.ts` supplies a separate diagnostic
full maintenance control using the production TwoSum/outward-float32 numerical
policy. Each changed target regenerates all dynamic triangles, packs all records
and refits all nodes once, then writes the five complete buffers. It retains the
same target/queued/submitted contracts and renderer history rules. It does not
call the old refit followed by a second bounds repair or execute independent
BigInt/ray-oracle work in the timed updater. The normal production profiler's
timestamp arithmetic remains unchanged in both arms.

CPU qualification on the original courtyard matched all five arrays across the
13 frozen targets and all 4,096 packed CPU ray results across eight states. The
controlled offset-zero-to-0.4 transition produces 184,640 bytes in five full
writes versus 912 bytes in seven incremental writes. Retained typed control
metadata is 187,185 bytes versus 150,801 bytes for incremental maintenance;
temporary JavaScript objects, borrowed packed data and GPU storage are separate.
This is CPU correctness and accounting, not measured performance. Source and
external evidence are recorded on issue #20.

Prepare from a reviewed clean commit after building the package. The performance
asset root is the external parent containing the original
`integrated-courtyard-v1-s1337-t4-c64` directory:

```sh
npm run build
node scripts/run-benchmark.mjs --trace-prepare-only --commit EXACT_COMMIT \
  --asset-root /external/cooked/root --output /external/new-performance-freeze
```

Preparation freezes two external package builds with the same production build
flags, worker/WASM and module sources, replacing only the internal updater in the
full arm. It freezes all 83 source assets, the benchmark app, settings and run
order. Assets, builds and results must remain outside Git and CI.

Before timing, prepare and independently review a separate correctness manifest
with `scripts/test-trace-updates.mjs --prepare-only`, using `--full-control
full-performance`. The original correctness-only mode remains available. An
explicit `--renderer-churn skip-unchanged-candidate-only` can omit the already
covered candidate-only Stage C; it records `skipped`, not exercised coverage.
Renderer steps now use the literal reviewed numbers and an owned, fully validated
serialized plan, preserving all original schedules and numerical/image gates.

Only a matching passed hardware direct-write and paired-renderer receipt for the
new control can admit a timing run. A separately allocated GPU window then uses:

```sh
node scripts/run-benchmark.mjs --trace-performance \
  --manifest /external/new-performance-freeze/manifest.json --manifest-sha256 SHA \
  --correctness-report /external/new-correctness/report.json --correctness-report-sha256 SHA \
  --correctness-manifest /external/new-correctness-freeze/manifest.json --correctness-manifest-sha256 SHA \
  --output /external/new-performance-result
```

The fixed order is incremental 720p, full 720p, full 1080p, incremental 1080p.
Every run uses a fresh context, 30-second warmup, original 60-second browser-time
tour, 1 MiB streamed pool, all-on GI/reflections/TAA and unchanged quality budgets.
Independent RAF timing means frame counts and sinusoidal samples can differ.
Capture-start trace counters make the first measured delta explicit; final trace
counters come from the last measured frame, separately from post-capture drains.
Images at t0/3/5/16/32 and disposal diagnostics are collected outside timing.

The offline summary reports fixed time windows, positive-target-delta opening
CPU samples, actual uploads, GPU sample coverage, cadence and tracked memory.
Its practical numerical decision is not overall acceptance: source, stable power,
errors, visual evidence, GPU coverage and cleanup require separate validation.
Canonical upload savings refer to the controlled transition, not every moving
frame. The frozen practical improvement rules are at least 25% lower opening
changed-target CPU p95 and 90% less canonical trace traffic; whole-tour CPU/GPU
tails and slow-callback shares must also stay within their reviewed bounds.
Single opposite-order pairs do not establish statistical significance, overall
visual quality, whole VRAM use or a general 60 FPS result.

CPU tooling checks are `npm run test:trace-updates:launcher`,
`npm run test:trace-performance:unit`, focused trace control/plan tests and both
TypeScript configurations. The actual asset/hardware qualification remains local.
