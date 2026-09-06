# @strata-engine/preview

Optional Node tooling for Strata preview sessions. `createPreviewSession()` starts
an ordinary WebGPU browser; `strata-preview capture` performs a one-shot capture.
The supported profile is opaque procedural root boxes, perspective camera,
directional direct PBR, and a base-color diagnostic. External assets, textures,
parents, animation, shadows, TAA, GI and reflections are rejected.

The package exports `createPreviewSession`, `prepareAuthoredPreviewLoad`,
`PreviewSession`, `publishCapture` and `PreviewError`. Scene descriptors,
validation and commit receipts belong to Core. The advanced `PreviewDriver`
integration seam must return detached JSON data, validate
load input synchronously, expose the actual committed identity, submit frames
only when asked, and await all work it owns. Driver `status: 'ready'` asserts that
the browser/runtime is initialized and has no observed GPU or browser errors.

`load` submits and fences a first matching frame. `resize` keeps the committed
identity and establishes readiness for the new physical viewport. `capture`
requires the ready source, load and view tokens and performs one to eight explicit
submissions, a GPU fence, and a screenshot while holding the mutation gate.
Source revisions and resolved view digests are separate. A load ID aliases an
actual returned commit receipt within the unique session; it is never a pending
request counter. Device/driver failure permanently invalidates the session.

API output roots must already exist; the one-shot capture CLI creates its output
root. Each capture reserves a new child directory, writes and verifies `image.png`, then atomically
publishes `receipt.json` last without overwriting an existing capture. PNG
verification checks the header,
dimensions and exact written bytes; it does not decode pixels or prove visual
correctness. The receipt records an unobserved compositor frame ID (`null`).
Cancellation before publication rejects; cancellation during publication waits
for the real result. Once published, a capture remains published even if later
reporting fails. Cleanup warnings identify incomplete owned artifacts.

Operations default to a 30-second deadline and a separate 5-second cancellation
cleanup deadline. On `PreviewSession`, new loads supersede older loads but wait for
their actual settlement before taking ownership. Other concurrent mutations fail with
`PREVIEW_BUSY`. A rejected caller does not release unfinished work. Cleanup
expiry faults the session and starts driver teardown. `dispose()` is idempotent;
bounded cleanup can reject with `PREVIEW_DISPOSE_FAILED` and identify unresolved
resources.

`whenIdle()` waits for actual mutation/artifact settlement even after disposal or
fault, independently of an early rejected caller. It has no timeout and does not
dispose the driver or assert successful work. Hosts that need shutdown settlement
await both `dispose()` and `whenIdle()` under their own cleanup deadline.

This package is separate from browser runtime bundles and requires Node.js
22.13+. It has no consumer install/build hooks and requires no Rust tooling.
Use an installed Chrome browser with `--browser chrome`, or install Playwright
Chromium separately with `npx playwright install chromium`. The tool never
downloads a browser automatically. No package has been published.

```sh
strata-preview capture --scene scene.json --view view.json --output captures --browser chrome
```

From a fresh repository checkout, contributors need Node.js 22.13+ and rustup.
Build Core before the optional package so its declarations, worker and WASM are
available; `build:preview` also builds authoring:

```sh
npm ci
npm run build
npm run build:preview
```

Run the repository CLI with `node packages/preview/dist/bin.js` in place of
`strata-preview`, supplying authoring scene and view JSON files.

`view.json` supplies `camera`, `light` and `background`. Optional `debugView`
defaults to `final`; `timeSeconds` defaults to zero; `temporal` may only be false.
The one-shot capture CLI returns one JSON result and closes its engine, worker,
browser and server.

```js
import { sceneRevision } from '@strata-engine/authoring';
import { createPreviewSession } from '@strata-engine/preview';

const session = await createPreviewSession({ width: 512, height: 512, channel: 'chrome' });
try {
  const ready = await session.load({ scene, revision: sceneRevision(scene), view });
  const capture = await session.capture({
    expectedRevision: ready.sourceRevision,
    expectedLoadId: ready.loadId,
    expectedViewRevision: ready.viewRevision,
    outputDirectory: existingOutputDirectory,
  });
  console.log(capture.receiptPath);
} finally {
  await session.dispose();
}
```

The separate `strata-preview-connection` binary and
`@strata-engine/preview/connection` export provide a persistent local stdio
connection to one session. Both selected roots must already exist:

```sh
strata-preview-connection --project-root ./project --output-root ./captures --browser chrome
```

Use `node packages/preview/dist/connection-bin.js` from a built checkout. The
protocol is UTF-8 JSON objects terminated by LF; `discover`, `load`, `inspect`,
`capture`, `resize`, `cancel` and `dispose` share existing preview operations.
The browser is created only after a valid rooted scene load. Scene edits remain
in the authoring API/CLI. This connection admits one mutation at a time and rejects
overlap; it does not supersede a pending load. Six ordinary request slots and two
reserved control slots keep cancellation available. Output is bounded to eight
response buffers and 32 MiB including the active write, with at most four MiB per
response including LF. Cancellation acknowledges a request; it does not prove
rollback, failed publication or completed cleanup. EOF and broken output close
admission and start bounded cleanup. See the [connection guide](https://github.com/tylerstuff/strata/blob/main/docs/preview-connection.md)
for envelopes, root rules and uncertain-delivery handling.

After the Core build, `npm run check:preview` runs the preview CPU suites and
isolated packed CPU consumers. Separately scheduled `npm run test:preview:browser`
installs the built Core/authoring/preview archives and exercises 14 submitted
frames and seven captures across sequential API and installed-CLI sessions. It
checks visible transform/material edits, input snapshots, same-source commit
generations, stale tokens, resize, PNG pixels and receipt identities, zero reported
GPU errors, disposal and CLI output. This is procedural-box correctness evidence,
not a performance or cross-device determinism claim. The
[integrated workflow passed](https://github.com/tylerstuff/strata/issues/8#issuecomment-5552354035)
on frozen preview checkpoint `1289583`, using its built workspace Core from
candidate `ea877dc`, headed Chrome 152.0.7977.82 and an Apple `metal-3` nonfallback
adapter. The linked record identifies the executed source and archive hashes;
later documentation edits are outside that checkpoint. Captures and reports stay
outside the repository.

The stdio connection passed CPU lifecycle, transport and packed-consumer checks,
plus separate installed-connection browser acceptance. The
[connection validation record](https://github.com/tylerstuff/strata/blob/main/docs/preview-connection.md#validation-boundary)
distinguishes Linux CI checkpoint `1d627b0` from the Darwin launcher correction
tested on Apple M2 hardware at `f60c3b5`.

The separate `strata-project` binary and `@strata-engine/preview/project` Node
export initialize, inspect, validate and build saved procedural projects. Build
pins an inspected input revision and publishes a new static site with a complete
Core distribution and a completion receipt. The browser app imports Core alone;
it does not install authoring or preview code. Consumers receive precompiled WASM
and need no Rust tools. Imported assets and cooking remain unsupported by this
profile. See the [saved-project guide](https://github.com/tylerstuff/strata/blob/main/docs/project.md)
for commands, output ownership, cancellation and validation limits. Separate
generated-app browser acceptance passed for two frozen procedural scenes; it does
not establish general scene support or rendering performance.
