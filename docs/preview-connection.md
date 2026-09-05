# Local preview connection

Tracked in [issue #8](https://github.com/tylerstuff/strata/issues/8). This bounded
slice adds a persistent, process-owned stdio connection to the optional preview
package. The implementation checkpoint passed CPU checks, including its isolated
packed consumer. Independent review of the frozen candidate and browser acceptance
remain pending. It does not complete the wider authoring issue.

## Boundary and transport

The entry point is `strata-preview-connection --project-root DIR --output-root DIR`.
Both roots must exist and remain fixed for the process lifetime. Browser options
are startup-only; browser creation is lazy, after the first scene and view pass the
existing authoring and authored-preview validation. One connection owns at most
one `PreviewSession`. It uses the existing public session API and introduces no
scene schema or renderer API. The TypeScript adapter is an optional
`@strata-engine/preview/connection` export; ordinary runtime packages do not import it.

From a fresh checkout, contributors build Core before preview:

```sh
npm ci
npm run build
npm run build:preview
mkdir -p ./local-project ./local-captures
node packages/preview/dist/connection-bin.js --project-root ./local-project --output-root ./local-captures --browser chrome
```

Contributors need Node.js 22.13+ and rustup for that build. Archive consumers receive
precompiled WASM and need no Rust tooling. Use an installed Chrome browser, or
separately install Playwright Chromium and choose `--browser chromium`. Help and
discovery require neither browser initialization nor a scene file. The installed
binary is `strata-preview-connection`; `--help` returns one JSON help result.

The chosen transport is UTF-8 newline-delimited JSON over the child process's stdin
and stdout. It needs no listening control socket, port discovery, hosted service,
agent vendor or authentication scheme between the parent and its child. This is
Strata protocol version 1, not JSON-RPC or MCP. A later adapter can reuse these
operations if needed. The existing preview browser still uses its private loopback
asset server; that server is not the control transport.

Each request is one JSON object and ends with LF:

```json
{"version":1,"id":1,"method":"discover","params":{}}
```

IDs are strictly increasing positive safe integers for this process. Accepted IDs
cannot be reused. Responses may finish out of order, so a pending load or capture
does not prevent cancellation. While the output channel remains healthy, every
accepted request has one terminal response:

```json
{"version":1,"id":1,"ok":true,"result":{}}
{"version":1,"id":2,"ok":false,"error":{"code":"PREVIEW_STALE_STATE","stage":"capture","message":"...","details":{}}}
```

Framing/envelope failures use `id:null` when a request cannot be safely correlated.
Unknown fields, versions, methods and invalid parameters fail explicitly. Batches,
notifications, binary payloads, unsolicited progress on stdout and reconnect/replay
semantics are unsupported. Stderr is reserved for process/transport diagnostics.
Keep stdin open while requests are pending; EOF requests shutdown and cancellation,
so piping a load and immediately closing stdin is not a completed preview workflow.
The process exits with 0 for help or normal shutdown, 2 for startup argument errors,
and 1 for startup/transport/cleanup failure. A protocol error is an `ok:false`
response and does not by itself force a nonzero process exit.

## Operations

| Method | Parameters | Result |
| --- | --- | --- |
| `discover` | `{}` | Version, methods/parameter descriptions, roots, profile, limits and browser policy; never launches a browser. |
| `load` | `{scenePath, expectedRevision, view}` | Existing `PreviewReadyReceipt`; the relative file is read and validated through authoring, its revision must match, and the existing preview adapter validates the explicit view and root-box profile before initialization/load. |
| `inspect` | `{}` | Existing session observation when initialized, connection state, active request summaries and bounded recent terminal status. Observation is separate from any historical committed receipt. |
| `capture` | `{expectedRevision, expectedLoadId, expectedViewRevision, captureId?, frames?}` | Existing publication result with image/receipt paths and receipt; output root is fixed by startup, and PNG bytes are not sent over stdio. |
| `resize` | `{width,height}` | Existing ready receipt after the session resizes and fences its frame. |
| `cancel` | `{requestId}` | Whether cancellation was requested for that active request; this is an acknowledgement, not proof of rollback, publication failure or completed cleanup. |
| `dispose` | `{}` | Bounded owned cleanup result; permanently stops work admission and closes the connection after responses drain. |

`view` is the existing `AuthoredPreviewViewInput`. The scene file is the existing
versioned authoring document. The connection performs no scene writes, asset
fetches, importing/cooking, arbitrary shell execution or network control requests.
Use the established authoring API/CLI for edits, then load the reviewed new revision.
Obtain `expectedRevision` from authoring's `readSceneFile` or CLI validation result.
Supply the [existing explicit view](preview.md#start-a-preview), then use the returned
`sourceRevision`, `loadId` and `viewRevision` as capture's three expected tokens.
After a successful mutation, the next sequential mutation can be sent immediately.
After a canceled or rejected operation, inspection may still report owned work;
wait for it to settle before retrying a mutation.

The Node export also supports direct structured requests. This example only
discovers capabilities and creates no browser; both directories must exist:

```js
import { resolve } from 'node:path';
import { createPreviewConnection } from '@strata-engine/preview/connection';

const connection = await createPreviewConnection({
  projectRoot: resolve('./local-project'),
  outputRoot: resolve('./local-captures'),
});
try {
  const response = await connection.request({ version: 1, id: 1, method: 'discover', params: {} });
  console.log(JSON.stringify(response));
} finally {
  await connection.close();
}
```

The same export provides `runPreviewConnectionStdio({ connection, input, output,
signal?, writeTimeoutMs?, cleanupTimeoutMs? })`, protocol version/limits and public
connection types. Streams must provide raw bytes; do not set a text encoding on
the input before passing it. The transport borrows streams, pauses input and drains
output on normal shutdown, and owns closing the connection. The optional session
factory dependency is a host/test seam with the same ownership contract as the
public preview session.

## Ownership, cancellation and limits

Only one load/capture/resize request is admitted at a time; another receives a busy
error. Replacements are explicit subsequent loads. Discovery and cancellation stay
responsive, and at most one inspection is pending. The session retains its own
operation gate: a rejected caller does not mean underlying work settled. Requests
carry separate abort signals; cancel never creates a new browser or abandons an
owned initialization. Disposal/EOF/broken output abort pending work and dispose the
owned session. A late-created session after shutdown is disposed, never adopted.

The connection delegates load/frame/capture identity and publication behavior to
the existing session. Preserve source revision, load generation, resolved-view
revision, committed receipts, `commitOccurred`, `publicationOccurred`, capture paths
and incomplete-cleanup details in results/errors. Successful publication can win
a late cancellation. A hard cleanup timeout reports an unknown outcome and faults
the connection rather than asserting that no capture was published. Late results
cannot re-enable admission. `presentedFrameId` remains unobserved.

Protocol bounds are 64 KiB per input line, four MiB per response including its LF,
eight outstanding requests, one mutation, one inspection and 32 small terminal
status records. At most six ordinary requests may remain outstanding; the final
two slots are reserved for `cancel` and `dispose`. A request occupies its transport
slot until its response is written. Ordinary-capacity exhaustion stops admission
and starts bounded shutdown; at most one overflow error is attempted within the
remaining output budget, rather than producing an unbounded stream of busy errors.
The output writer honors backpressure and retains at most eight complete response
buffers and 32 MiB in total, including the currently blocked write. No request is
accepted solely to create an error beyond those bounds. Scene input retains
authoring's 16 MiB regular-file limit. Dimensions and frames retain preview's
existing limits (16,384 per axis, 64 Mi pixels total, one to eight capture frames).
Default operation/cleanup deadlines are 30 seconds/five seconds; startup overrides
are bounded to 300 seconds. Unsettled dependencies fault and close admission; a
cleanup deadline is not proof that every OS resource closed. Shutdown tracks pending
request/publication settlement separately from `PreviewSession.dispose()`, which
awaits driver cleanup alone. It also awaits `PreviewSession.whenIdle()` for actual
operation settlement after early cancellation, including pre-publication artifact
writes and their cleanup, and applies the same ownership rule to late-created
sessions. A disposed observation is not a substitute for this wait. The final
response drain shares the configured cleanup
deadline starting at shutdown; expiry stops the transport and records uncertain
delivery/outcomes without implying rollback.

Input paths must be nonempty project-relative paths without `..`, absolute paths,
URL schemes, backslashes or control characters. Canonical containment and link
checks prevent ordinary path/symlink escapes; scene leaves must be regular files
with one hard link as required by authoring. Output paths are never client-selected
per request; captures use the fixed selected output root and existing exclusive
publication. Roots must not be renamed or replaced during use. This process is a
cooperating local-project tool, not an OS sandbox against hostile concurrent
filesystem changes by another process.

## Contributor launcher cleanup

The connection browser test launcher tracks its spawned workflow and observed
descendants. On Linux, it opens and retains `/proc/<pid>/stat` descriptors after
the initial expected-label check and a live `ChildProcess` observation. Current
parent checks bracket descendant admission. Later label, parent or process-group
changes do not replace the retained identity; raw start ticks stay decimal strings
in diagnostics. Darwin continues using the existing `ps` identity checks.

The process census discovers candidates. A missing or dead census row for an
owned process requires confirmation through its retained descriptor or the
spawned root's exit state. Conflicting live evidence, inaccessible or malformed
reads, and unresolved opens, reads or closes keep cleanup uncertain. Retired
identities cannot be admitted again. Cleanup stops new admission; deadlines do
not cancel native I/O, and late handles close without regaining authority.

A narrow Linux check handles a never-admitted descendant whose first native open
actually rejects with `ENOENT` within its original admission deadline. The PID is
quarantined permanently. One follow-up can record `absent-before-admission` only
when both the discovery and fresh full census have no observed dependent chain,
the fresh census has no candidate row, a separate positive-PID signal-zero check
returns `ESRCH`, and the parent's retained identity remains live and authoritative.
Before and after that check, the checking Node process reads `/proc/self/status`
to actual EOF and requires exactly one canonical `NStgid` value equal to its own
PID. All checks and owned file cleanup must settle within the original deadline;
there is no retry or extension. This assumes a cooperating Linux host with genuine,
fixed procfs at `/proc`; it does not authenticate a hostile filesystem.

Root failures, retained-handle errors, other initial errors, observation timeouts,
namespace mismatches and shutdown interruptions remain unresolved. A later row or
dependent chain through a quarantined PID latches uncertainty without admitting
or signaling it. Confirmed absence never clears an earlier uncertainty and does
not prove the candidate's earlier lifetime or cleanup of an unseen subtree.

This remains a polling launcher, with a final identity-check-to-numeric-signal
race and a blind spot for children that fork and reparent between samples.
Abnormal shutdown always reports that uncertainty. Initial process labels are
still required; the controlled Node 24 fixture's known label does not relax
production admission.

The full cleanup report retains up to 512 native acquisition entries, reserving
each entry before provider invocation. Provider outcomes remain separate from
observation timeouts, confirmation gates and later contradictions. Raw native
errors, including an `ENOENT` followed by confirmed absence, remain recorded.
Diagnostics distinguish held process-identity and namespace descriptors and
include pending confirmation/census work alongside open/read/close counts.
The single-line formatter stays within its 1–32 KiB UTF-8 budget, whitelists only
identity metadata, and reports omitted acquisition/dependent rows with their
counts. It never includes raw status files, argv, environment or scene payloads.
Returned cleanup receipts do not change when late I/O eventually settles.

This candidate-confirmation and diagnostic work is a CPU-only checkpoint; new
Linux and browser acceptance remain pending. It does not explain or reclassify
the earlier failed CI result. None of this changes the runtime package or
establishes browser, GPU or performance acceptance.

## Validation boundary

`npm run check:preview` passed for this implementation checkpoint: 325 CPU tests,
strict type/declaration checks, the package build, and both isolated packed CPU
consumers. These tests use the existing session/driver seams and real temporary
project/output directories. They cover framing, byte limits/backpressure, monotonic IDs, discovery,
unsupported input, root escapes, lazy initialization, cancellation, late settlement,
publication truth, disposal/EOF/output failure and packed consumer operation.
The connection consumer installs Core, authoring and preview archives with scripts
disabled, checks installed declarations, drives the installed CLI without a valid
browser load, and uses a real `PreviewSession` with a delayed fake driver for
cancellation and native PNG/receipt publication. Real pre-publication write/sync,
file-close and cleanup holds verify that driver disposal cannot finish connection
shutdown early. Deadline, late-created-session and disposal-failure cases retain
actual settlement or report uncertainty. Rust/browser sentinels and an
empty browser-install location keep this a CPU workflow. Fixtures are generated in
temporary directories and removed afterward.

No connection browser/GPU run or full `npm run check` was executed for this
checkpoint. The prior API/one-shot capture browser proof covers a separate entry
point. A frozen candidate and evidence will be independently reviewed before any
scheduled connection browser validation. No GPU, quality or performance claim
follows from these CPU tests.
