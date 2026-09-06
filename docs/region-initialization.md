# Bounded region initialization

This internal [issue #18](https://github.com/tylerstuff/strata/issues/18) prerequisite coordinates authenticated manifests and the existing [host-driven geometry initializers](geometry-initialization.md). It handles initialization and retirement of a bounded set of cooked terrain sources. It does not provide world placement, region visibility, composite rendering, a spatial world index, or general scene streaming. Its validation is CPU-only.

## Internal API

`RegionInitializationCoordinator(device, budget, limits, options?)` owns its providers privately. It exposes no renderer or provider-transfer API. The host calls `replaceDesired(revision, descriptors)` with a strictly increasing positive safe-integer revision and a complete desired set; an empty set retires all current entries. The entire update is validated before any previous ownership is retired.

Each `RegionDescriptor` contains `id`, `manifestUrl`, `manifestBytes`, `manifestSha256`, `bounds`, and `options`. IDs are unique within the desired set and contain 1–128 characters. Manifest URLs are HTTP(S), at most 2,048 characters, and contain no embedded credentials. Bounds contain ordered finite three-component `min` and `max` endpoints. They are host scheduling metadata, not placement transforms, and are not required to equal the authenticated terrain's bounds. `snapshot()` reports those parsed bounds separately as `sourceBounds` once available.

The same ID, URL, byte length, SHA-256 and normalized provider options reuse an existing incarnation. Updating scheduling bounds alone also reuses it. A changed identity or provider option retires the previous incarnation and queues a new one. An unchanged failed descriptor remains failed; this layer does not retry it merely because a newer desired-set revision repeats it. Removing it and later adding it creates a fresh incarnation.

`advance(frame)` rotates initializer advance/upload turns among eligible entries, returning that call's `uploadBytes` and `advancedIncarnations`. It also attempts queued manifest admission and requires a current allowance from the coordinator's own shared budget. There is no request-admission fairness guarantee: the existing page-cache request pumps independently compete for shared request/staging capacity.

`snapshot()` exposes immutable desired-region and retiring-region receipts, their incarnation/status/error, and logical accounting. Desired statuses are `queued`, `manifest`, `authenticated`, `initializing`, `ready`, and `failed`; the separate retiring list uses `retiring`. A failed desired receipt can remain while its old live entry is retiring. Its `revision` works with `waitForChange(revision)`; `desiredRevision` identifies the last accepted host update. Accounting includes `liveEntries`, `retiringEntries`, `retainedManifestBytes`, their peaks, initialization `uploadBytes`, and entry start/reuse/settlement counters. Error messages are capped at 512 characters.

The host ends ownership with `dispose()` and then awaits `whenDisposedAndSettled()`. Disposal is idempotent. A change wait resolving after disposal does not replace that settlement wait.

The host supplies each manifest's URL, exact encoded byte length, and lowercase SHA-256. The coordinator checks retained encoded-content capacity, obtains a request/payload lease from the shared `GeometryTransferBudget`, and charges the live entry and retained quota before invoking the manifest loader. Manifest requests and geometry page requests therefore compete for the same configured request and staging capacities. Failure to obtain temporary capacity leaves work pending; it does not start an uncharged request.

The manifest loader requires the already-admitted request lease and an explicit `maxManifestBytes` cap. It reads into one exact-sized byte buffer, checks an optional `Content-Length`, rejects overflow or truncation, verifies SHA-256, then decodes UTF-8 and runs `parseGeometryManifest()`. Authentication precedes JSON/geometry parsing. It snapshots the URL, length and hash before asynchronous work. The loader releases its request/payload lease only after parsing or failure and original fetch, body, digest and cancellation cleanup have settled. Root initialization starts after that release.

## Ownership and limits

| Coordinator limit | Contract |
| --- | --- |
| `maxDesiredRegions` | 1–64 descriptors, including queued or failed receipts. |
| `maxLiveRegions` | 1 through `maxDesiredRegions`; includes active and retiring entries. |
| `maxManifestBytes` | Positive integer up to 2,147,483,647; a cap on each encoded manifest. |
| `maxRetainedManifestBytes` | Positive safe integer; shared encoded-content quota for live and retiring manifests. |

Each descriptor must also fit the retained-content quota and the transfer budget's `pageStagingBytes` by itself. An impossible descriptor is rejected before replacing the desired set. Manifest-dependent pool/geometry admission remains the responsibility of `GpuGeometry.begin()` after authentication; failures become bounded failed receipts and retire the entry.

The encoded-content quota charges the manifest's declared byte length while its parsed metadata remains owned. This is a bound on admitted encoded content, not a measurement of parsed objects, strings, general JS heap, browser network buffering or physical garbage collection. The host initializer separately accounts for owned typed-array storage and requested GPU buffer sizes through `GeometryTransferBudget`.

Both live and retiring entries retain their charges until their original asynchronous operations settle. Removing a source from the desired set or disposing the coordinator begins retirement; clearing a scheduling map or observing a terminal status is insufficient to release its retained metadata charge. A fetch that ignores cancellation, an unfinished digest, an uncancelable pipeline compilation, or a pending feedback map can keep an entry charged until it actually settles.

The coordinator uses fixed streamed geometry and default terrain rendering. Provider options are snapshotted explicitly: required `poolBytes` in whole 65,536-byte pages, `pixelError` (default 2, positive and at most 1,000), `cameraMode` (`tour` by default, or `coverage`), and `residencyPolicy` (`greedy` by default, or `retain-fallback`). Descriptor, provider-option and coordinator-option objects reject unsupported fields.

Manifest and page transport use the coordinator-wide `fetch` option (global fetch by default) and `requestTimeoutMs` (30,000 by default, range 1–120,000). A manifest deadline triggers retirement; it does not release ownership while an abort-ignoring operation remains outstanding. Page retries are disabled with `maxRetries: 0`. The page cache still owns each provider's page scheduling and residency policy. Its per-provider concurrency is at most 32 and never exceeds the shared request limit; its completed-byte and upload settings derive from the shared staging/frame limits.

Ready providers can occupy capacity indefinitely. A desired set must fit the configured capacities, or the host must retire providers to admit more work. Pending work has no promise of eventual readiness while other owners retain the required capacity. Entry-count and metadata charges also include retiring entries, so cancellation cannot bypass admission limits by immediately replacing a still-owned source.

The host supplies one current `GeometryUploadFrame` per physical frame. All initializers advanced in that frame share its upload allowance; asynchronous completion does not renew it or upload geometry. Ordinary provider `prepare()` writes remain outside this initialization-only upload cap.

## Settlement barrier

`GeometryInitialization.whenDisposedAndSettled()` waits for terminal ownership end and every retained asynchronous operation. It does not dispose the handle or advance initialization. `waitForChange()` and terminal `status` observation remain separate operations; neither is a disposal barrier.

After `takeReady()`, the handle has transferred ownership and can settle while its provider remains usable. The new owner must dispose that provider and await its own `whenDisposedAndSettled()` when retiring it. `GpuGeometry` waits for its cache and for every begun feedback operation, even after disposal clears the mutable feedback-slot state. `GeometryPageCache` retains the original request/body/hash/finally chains independently of its cleared scheduling map. Repeated disposal does not shorten these waits or destroy resources again.

These barriers establish release of the tracked asynchronous ownership. They are not a GPU queue-completion fence, a claim that a destroyed buffer's physical allocation has already been reclaimed, or a timing guarantee for a transport that ignores cancellation.

## Validation scope

Focused CPU tests exercise authenticated manifest loading, exact byte caps, malformed or corrupt input, ownership transfer, cancellation that outlives its signal, stream-cleanup failure, delayed hash completion, pipeline siblings and feedback disposal. Fake devices provide ownership evidence without a WebGPU execution claim.

The coordinator test cases use four distinct sources from the unchanged cooker, seeds 51–54, moving through two live slots by explicit host retirement. A companion control checks alternating initializer advance turns. Frame receipts compare actual recording-queue bytes with the returned upload count and shared allowance, including checks against asynchronous writes. The premature-release negative control is a separate **accounting model**: it demonstrates that discarding retiring entry/quota charges and releasing request leases early would admit replacement work while original cancellation remains pending. It is not a modified production coordinator or a request-fairness result.

The earlier [recorded hardware result](geometry-initialization.md#recorded-hardware-result) remains a result for the frozen host-driven initializer and its generated coarse-terrain comparison. It did not execute this coordinator or the subsequently added settlement barriers. This slice establishes no rendered world composition, temporal/shadow/depth integration, placement correctness, performance target, or completion of issue #18.
