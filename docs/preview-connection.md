# Local preview connection

Tracked in [issue #8](https://github.com/tylerstuff/strata/issues/8). This bounded
slice adds a persistent, process-owned stdio connection to the optional preview
package. Its implementation and CPU acceptance are in progress; browser acceptance
has not been run. It does not complete the wider authoring issue.

## Boundary and transport

The entry point is `strata-preview-connection --project-root DIR --output-root DIR`.
Both roots must exist and remain fixed for the process lifetime. Browser options
are startup-only; browser creation is lazy, after the first scene and view pass the
existing authoring and authored-preview validation. One connection owns at most
one `PreviewSession`. It uses the existing public session API and introduces no
scene schema or renderer API. The TypeScript adapter is an optional
`@strata-engine/preview/connection` export; ordinary runtime packages do not import it.

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
does not prevent cancellation. Every accepted request has one terminal response:

```json
{"version":1,"id":1,"ok":true,"result":{}}
{"version":1,"id":2,"ok":false,"error":{"code":"PREVIEW_STALE_STATE","stage":"capture","message":"...","details":{}}}
```

Framing/envelope failures use `id:null` when a request cannot be safely correlated.
Unknown fields, versions, methods and invalid parameters fail explicitly. Batches,
notifications, binary payloads, unsolicited progress on stdout and reconnect/replay
semantics are unsupported. Stderr is reserved for process/transport diagnostics.

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

Protocol bounds are 64 KiB per input line, four MiB per response, eight outstanding
requests, one mutation, one inspection and 32 small terminal status records. The
output writer honors backpressure and has a bounded queue. Scene input retains
authoring's 16 MiB regular-file limit. Dimensions and frames retain preview's
existing limits (16,384 per axis, 64 Mi pixels total, one to eight capture frames).
Default operation/cleanup deadlines are 30 seconds/five seconds; startup overrides
are bounded to 300 seconds. Unsettled dependencies fault and close admission; a
cleanup deadline is not proof that every OS resource closed.

Input paths must be nonempty project-relative paths without `..`, absolute paths,
URL schemes, backslashes or control characters. Canonical containment and link
checks prevent ordinary path/symlink escapes; scene leaves must be regular files
with one hard link as required by authoring. Output paths are never client-selected
per request; captures use the fixed selected output root and existing exclusive
publication. Roots must not be renamed or replaced during use. This process is a
cooperating local-project tool, not an OS sandbox against hostile concurrent
filesystem changes by another process.

## Validation boundary

CPU tests use the existing session/driver seams and real temporary project/output
directories. They cover framing, byte limits/backpressure, monotonic IDs, discovery,
unsupported input, root escapes, lazy initialization, cancellation, late settlement,
publication truth, disposal/EOF/output failure and packed consumer operation. They
must not launch a browser or require consumer Rust tools. A frozen candidate and
evidence will be independently reviewed before any scheduled browser validation.
No GPU, quality or performance claim follows from these CPU tests.
