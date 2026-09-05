# Static imported tracing preparation

Tracked in [issue #15](https://github.com/tylerstuff/strata/issues/15). This is an
internal CPU preparation contract for a later imported lighting implementation.
It does **not** connect imported geometry to GI, add a shader estimator, or change
the gallery image. Existing imported rendering remains separate from the room GI
experiments.

## Source and ownership

`preflightImportedStaticTrace` checks structure, supported participation, device
buffer limits and requested CPU payload estimates before allocating source copies.
The initial subset is static geometry using exactly one lit OPAQUE material. Unused
material entries, including the loader's appended default, do not participate.
`sourceMaterialIndex` identifies the selected asset material; packed material zero
maps to that index without changing the caller's material table. Rigs, clips,
deformation, MASK and authored-unlit materials are rejected. Ground participation
is outside this source API: it accepts the model's indexed primitives only.
Material participation checks do not replace the renderer's validation of material
factors, texture references and texture resources.

`prepareImportedStaticTrace` copies the already-normalized source positions and
indexed attributes, with dense validation and copying split into cancellable host
tasks. It does not normalize, fetch, simplify, drop triangles, or transfer the
caller's buffers. The caller must keep the asset unchanged during preparation.
The returned arrays are an internal immutable snapshot by ownership; do not mutate
them while building, validating or uploading their result.

The internal `CpuRuntime.buildStaticBvh` copies only packed positions and indices
into transferable job inputs. A single worker owns one job and one unshared WASM
instance. Concurrent jobs reject before copying. Abort rejects the caller promptly;
the worker slot remains occupied until a terminal acknowledgement arrives, so a
replacement awaits `waitForStaticBvhIdle()` for worker cleanup. This internal
barrier resolves after the current job terminates, including cancellation or a
recoverable input error; worker failure and disposal reject it. Late results cannot
complete another request. Runtime disposal terminates the worker and rejects pending
work. The ordinary package still provides version-matched precompiled WASM; no
consumer Rust build, shared memory, or cross-origin isolation is required.

`validateImportedStaticBvh` checks the returned metadata, original vertex words,
stable source IDs, normals, full leaf coverage, tree depth and conservative bounds
against the prepared snapshot before GPU upload. It also yields between bounded
chunks. No GPU allocation or dispatch occurs in these helpers.

## Packed format version 1

All words are little-endian. Nodes occupy 32 bytes:

| Bytes | Type | Meaning |
| --- | --- | --- |
| 0–11 | f32 ×3 | Minimum source bounds |
| 12–15 | u32 | First consecutive child, or first packed triangle for a leaf |
| 16–27 | f32 ×3 | Maximum source bounds |
| 28–31 | u32 | Zero for an internal node; 1–4 triangles for a leaf |

The root is node zero. Internal children are `first` and `first + 1`. Median
partitioning is deterministic, with original triangle identity breaking equal
centroid keys. A balanced tree is bounded to depth 19 at the current triangle cap.
The layout permits a 32-entry traversal stack, but a GPU tracer must still validate
its actual ranges and traversal budgets.

Triangles occupy 64 bytes:

| Bytes | Type | Meaning |
| --- | --- | --- |
| 0–11 | f32 ×3 | Original source position p0 |
| 12–15 | u32 | Material zero in the initial single-material subset |
| 16–27 | f32 ×3 | Original source position p1 |
| 28–31 | u32 | Original global vertex index of p0 |
| 32–43 | f32 ×3 | Original source position p2 |
| 44–47 | u32 | Original global source triangle ID |
| 48–59 | f32 ×3 | Unit geometric normal with source winding |
| 60–63 | u32 | Zero padding |

Positions are stored directly, rather than as rounded precomputed edges. Distinct
small endpoints can otherwise collapse after subtracting a distant p0. The future
tracer can select a scale-safe intersection using the original binary32 positions.
Zero-area source triangles are rejected explicitly; no fixed minimum-area cutoff
discards small triangles. Normal construction sums exact binary32-coordinate
products in binary64 expansions before normalization.

BVH leaf order is independent of source order. `sourceTriangleId * 3` addresses the
original global index triplet. These indices select retained 64-byte imported
vertex records: position at byte 0, normal at 12, UV0 at 24, tangent at 32 and linear
vertex color at 48. Barycentrics weight those three records in their original order.
`primitiveTriangleOffsets` contains each source primitive's start and a final total
sentinel. No 64-byte vertex record is expanded three times per triangle.

## CPU job ABI and budgets

CPU ABI and worker protocol version 2 add a stepped job. `begin` reserves bounded
buffers and exposes input pointers; the worker copies position and index arrays
once. `step` performs finite geometry validation, bounds scans, deterministic
median-of-medians partition work and output packing. It never recursively sorts an
entire input range in one call. Output pointers are available only after completion
and remain valid until job disposal. The worker copies results before releasing
Rust ownership; it never transfers WASM linear memory.

The worker runs 8,192-unit calls, yielding after at most 32 calls or 8 ms of elapsed
work, and yields separately before allocation and result copying. Preparation and
source-agreement validation also check cancellation in bounded chunks and yield on
an 8 ms or 32-chunk schedule. These are requested scheduling budgets: individual
WASM calls, bulk typed-array allocations/copies and browser scheduling are not
interruptible deadlines.

Hard caps are 2,097,152 indexed vertices and 1,048,576 triangles. For `V` vertices
and `T` triangles, the reserved node capacity is
`N = 2 * nextPowerOfTwo(ceil(T / 4)) - 1`. The logical Rust reservation estimate is
`12V + 116T + 32N + 1 MiB`: packed inputs, 40-byte sortable records, packed output,
node capacity and fixed bookkeeping/allocator headroom. The default working limit
is 256 MiB; the maximum configurable limit is 512 MiB.

Each prospective GPU buffer is checked separately against both `maxBufferSize` and
`maxStorageBufferBindingSize` before source copies are made. The estimates include
the retained source vertex/index streams and packed tracing geometry; they do not
claim those resources have been uploaded.

The default preparation CPU planning limit is 768 MiB. Its conservative estimate
includes the distinct retained caller buffers (including encoded images), prepared
source arrays, the worker input copy, maximum result copies, validation bookkeeping,
and a WASM growth allowance of `max(2 * workingBytes, retainedWasmBytes +
workingBytes) + 16 MiB`. When reusing a worker, pass its current
`cpu.info.memoryBytes` as `retainedWasmBytes`; pass other retained scene/job CPU
buffers as `additionalResidentCpuBytes`. Terminal worker replies update the actual
linear-memory byte length in `cpu.info`, including cancelled and failed jobs. WASM
memory can retain its high water mark after a job; disposal releases the whole
instance. These are requested payload and copy/heap estimates, **not** a process
RSS bound. Browser image decoding, garbage-collector delays, driver and GPU
allocations remain additional costs and must be measured by the integration owner.

## Validation boundary

The focused source tests use generated indexed geometry and an independent
plane-intersection/signed-area reference. They exercise source identity, original
vertex preservation, tree containment, primitive coverage, hand-computed
barycentrics, more than 4,096 triangles and malformed output rejection. Rust checks
also cover adversarial median partitions, quota-independent bytes, exact tiny areas
and an explicitly invoked maximum-triangle smoke case. Worker tests cover ownership,
yielded cancellation, stale requests/results, failures and disposal.

The small generated input/output fixture in `tests/fixtures/imported-static-bvh.json`
is intended for the GPU lane's independent reader. A CPU packed-tree comparison is
not GPU intersection evidence. Imported GI remains unimplemented until a bounded
WGSL estimator, material/environment energy contract, renderer integration and
occlusion/transport validation are completed. Collection models and any future
derived tracing data must remain outside the repository.
