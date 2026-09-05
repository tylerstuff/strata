# Authored preview tooling

Tracked in [issue #8](https://github.com/tylerstuff/strata/issues/8). The optional
`@strata-engine/preview` package implements authoring-to-Core lowering, a browser
session factory, one-shot capture CLI, orchestration and local capture publication.
It supports opaque procedural root boxes with explicit perspective camera and
directional direct PBR or a base-color diagnostic. Imported assets, parents,
textures, animation, shadows, temporal accumulation, GI and reflections are
unsupported. The initial real CLI smoke verifies basic capture transport; the
packed revision/pixel checks provide the broader integration gate. CPU fake-driver
checks alone do not prove rendering, browser compatibility, precision or performance.

## Start a preview

After building the workspace and optional preview package, use an installed
Chrome browser or separately install Playwright Chromium. Runtime consumers
receive precompiled WASM and never need Rust. The optional Node preview tool owns
its browser, loopback server and scheduling; it installs no animation loop.

```sh
npm run build:preview
node packages/preview/dist/bin.js capture --scene scene.json --view view.json --output captures --browser chrome
```

`view.json` is explicit, for example:

```json
{
  "camera": {
    "position": [0, 0.5, 4],
    "rotation": [0, 0, 0, 1],
    "projection": { "kind": "perspective", "verticalFovRadians": 0.9599310885968813, "near": 0.1, "far": 32 }
  },
  "light": { "directionToLight": [0, 0, 1], "radiance": [3, 3, 3] },
  "background": [0.01, 0.02, 0.03],
  "debugView": "final",
  "timeSeconds": 0,
  "temporal": false
}
```

The API `createPreviewSession({ width, height, channel })` returns a reusable
session. Load with `{ scene, revision: sceneRevision(scene), view }`, then pass
the returned source/load/view tokens to `capture`. Always await `dispose()`.
The CLI creates its output root; API capture roots must already exist. CLI
stdout is one JSON result, including errors and help. Exit code 2 identifies
rejected input, 1 identifies runtime/output/cleanup/reporting failure, and 0
indicates successful capture or help. A published artifact remains identified as
captured even if later cleanup or reporting fails.

## Ownership and identity

The runtime owns its scene descriptor, structural types, validation, committed
receipt and frame metrics. Preview's generic driver seam transports those values
without defining another scene schema. The production adapter validates the
complete authoring document, verifies its canonical source revision, rejects every
unsupported external descriptor, preserves entity order and float64 transforms,
then calls Core's exported validator before any asynchronous load/supersession.

`PreviewSession.load(input)` asks that adapter to prepare a detached snapshot
synchronously. The runtime commit receipt returned by `setScene` is historical
evidence, not a read of mutable current telemetry. Preview checks it against the
current scene, submits one matching frame, fences GPU work, and rechecks the
scene, physical dimensions and submitted frame ID. Only then does it return a
`PreviewReadyReceipt`. Its `loadId` is an opaque session-local alias derived from
the actual commit receipt; reloading the same source revision produces a distinct
load token when Core commits a new generation. `viewRevision` hashes complete
effective view data and stays independent of source revision and timing data.

Failures retain their stage. Load errors expose `commitOccurred` (`null` means
commit evidence is still unknown), `committedReceipt`, and `lastObservedCommit`.
A precommit failure can retain prior readiness. A committed scene followed by a
render/fence failure stays committed but unready. An output I/O failure after
confirmed capture leaves the renderer ready. Device loss or observed driver/GPU
failure permanently invalidates the session and starts resource teardown.

## Capturing a frozen view

`capture({ expectedRevision, expectedLoadId, expectedViewRevision,
outputDirectory, captureId?, frames? })` requires all three ready tokens. It
submits one to eight explicit frames of the same resolved view, fences them,
screenshots the canvas, and checks identity, viewport and frame counters again.
There is no background animation loop. `resize` resubmits/fences the existing
scene at new physical dimensions and returns a new view revision.

The version 1 `strata.preview.capture` receipt contains source/commit/view
identity, complete resolved view, frame metrics, submitted IDs, cumulative
telemetry, environment, and PNG dimensions/bytes/SHA-256. GPU samples are matched
to their actual frame IDs; missing/delayed/disabled samples carry a reason. Pass
durations are not summed. `presentedFrameId` is `null`: the image is a
browser-composited capture of frozen canvas state after a GPU fence, not evidence
of a specific compositor frame.

Output roots preexist. Captures reserve a unique child directory with private
permissions, verify the closed image bytes and header, write and verify a
canonical receipt, then publish the receipt exclusively and atomically last.
Existing output is never overwritten. Image validation here is not a full PNG
decoder or a pixel-correctness test. Failed prepublication attempts remove only
their owned paths and report incomplete cleanup. Once the publication syscall
starts, cancellation waits for its actual outcome; successful publication wins a
late abort. Later reporting failure cannot undo that success.

## Cancellation and validation

The default operation deadline is 30 seconds, with 5 seconds for canceled work to
settle. Overrides are positive integer milliseconds bounded to 300 seconds.
New loads supersede older loads while retaining the gate until actual settlement.
Capture/resize conflicts return `PREVIEW_BUSY`. An uncooperative driver faults
the session after the cleanup deadline and triggers teardown; late work never
regains permission to mutate a fresh session. `dispose()` releases driver-owned
resources exactly once and remains safe to call repeatedly.

After `npm run build` produces Core's distribution, `npm run check:preview`
builds authoring, typechecks/tests/builds preview and runs
an isolated packed CPU consumer with Rust command guards. The suites cover
supersession, deep snapshots, historical/current commit disagreement, readiness,
stale tokens, explicit frame evidence, disposal, cancellation through publication,
short writes, output collisions, and cleanup failure. Browser/GPU execution must
be scheduled with the coordinating task. Captures/results remain external to the
repository under the [benchmark policy](benchmark.md); no external benchmark
assets are required for this slice.
