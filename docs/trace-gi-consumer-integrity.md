# Shared-lighting diagnostic consumer integrity

The Issue20 shared-lighting diagnostic now supports a separately named,
**instrumented consumer-integrity correctness proof**. It changes only test
instrumentation and result admission. It changes no Core source, renderer
workload, WGSL, updater substitution, exact same-phase comparison, ownership,
cleanup or time budget. It provides no performance evidence.

The previously frozen ffca0d4 run remains failed: its 97 raw browser request
failures were fatal under its contract, despite successful server terminals and
same-phase rendering comparisons. A generated transport-only reproduction
later observed complete EOF/length/hash-verified bodies alongside
`net::ERR_ABORTED` under both fixed-length and chunked framing. That observation
does not identify a Chrome internal cause or justify a production workaround.

New manifests require the consumer contract and newly pinned plan SHA
`218b91b6362a570ea5cb9aec3c43c9d5357e2be5fb870e7f04738f662f8a1d53`.
The external plan preserves original plan SHA
`590b30bae791b4654c92e9e633a8c4e965d9f8f9af87dd1545459f3bdb5e942d`
and appends the explicit admission revision. Old manifests and reports cannot
be interpreted under the new contract retrospectively.

## Evidence and admission

`scripts/phase-consumer-observer.mjs` is served separately from the unchanged
functional renderer bundles. Per cell it declares all 83 frozen assets:
manifest, trace-proxy JSON/binary and 80 pages. These source paths all use an
explicit native reader loop. The wrapper forwards native receivers, arguments,
objects and returned promises, preserves errors, and observes only chunks the
actual consumer reads. It does not make an extra read, clone or retry.

Receipts record one reader and EOF, exact consumed length/SHA256, response
URL/status, release, abort/cancel/error state, and browser monotonic timestamps.
EOF time is the observation reaction on the consumer's actual `read()` promise,
not an independently instrumented engine statement. Fixed scratch is bounded
by each declared size (8 MiB per asset, 16 MiB of total copy capacity per cell);
these are copy limits, not a claim about all browser or digest heap allocation.
All hooks must be restored and fetch/read/cancel/digest work settled before the
cell receipt returns. The browser clock is never compared directly to host
network-event timestamps.

`scripts/phase-consumer-admission.mjs` reconstructs native browser and server
request groups after owned cleanup. Each cell/URL must be unique on each side,
with one matching consumer record. Repeated/retried URLs are fatal; native IDs
correlate events within one side and are not assumed shared between sides.
Every server request must finish and close normally. Every proof/non-asset
request must finish without a failure. Missing EOF, partial or wrong bytes,
wrong hash, redirects, cancellation/abort/errors, missing or duplicate request
identity, pending work, stale source, evidence overflow and incomplete cleanup
remain fatal.

The raw network observer is unchanged: every request failure remains in its
raw events and counters, `network.admissible` remains false and
`rawTransportStatus` remains `failed`. Raw request error strings are retained in
`browserRequestFailures`; console/page/GPU errors remain fatal `browserErrors`.
Only an eligible asset's exact `net::ERR_ABORTED`, following response200 and
paired with all complete consumer and normal server evidence, may coexist with
a passing **separate** `consumerIntegrity` result. Other failures cannot qualify.

The child status is `consumer-integrity-collected` for that case, and `collected`
when raw transport also passes. Either is a provisional artifact requiring
independent supervisor receipt reconstruction, output hashes, child exit0,
source/asset postflight, exact owned process retirement and the original total
deadline. A child summary alone is not an accepted run.

## Interpretation limits

Wrappers, promise reactions, retained response/reader objects, copies and hashes
can change lifetime and timing. The [Fetch garbage collection section](https://fetch.spec.whatwg.org/#garbage-collection)
qualifies non-observability examples on unmodified built-ins. This proof does
not establish garbage collection as the cause of earlier cancellations or
performance equivalence to uninstrumented execution. Historical raw failures
remain failed. A new source/plan freeze and separately allocated run are needed
before any instrumented same-phase result can be claimed. The subsequent
[c74ae66 M2 result](benchmarks/2026-09-06-m2-trace-phase.md) records the separately
frozen run, independent audit, exact same-phase result and preserved raw failures.
