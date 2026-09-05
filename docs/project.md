# Saved procedural projects

Tracked in [issue #8](https://github.com/tylerstuff/strata/issues/8). The optional
preview package can initialize, inspect, validate and build a saved procedural
project. Its generated website consumes Core alone and includes precompiled
WASM. Building requires no browser or Rust tooling when using installed packages.
Browser rendering acceptance remains pending for this generated-app entry point.

## Create and build

From built packages, use the `strata-project` binary. In a built checkout its
equivalent entry is `node packages/preview/dist/project-bin.js`.

```sh
strata-project init ./demo --id demo
strata-project inspect ./demo/project.json
strata-project build ./demo/project.json --expected-input-revision TOKEN_FROM_INSPECTION --out ./site
```

Initialization requires a new directory and writes `scene.json`, `view.json` and
`project.json`. The last file is the completion marker. Project documents contain
`format: "strata.project"`, `version: 1`, an ID/name, project-relative scene/view
paths, and physical pixel width/height. The default project is 512 × 512.

Edit the scene through the shared [authoring API or CLI](authoring.md), then
inspect again. Build requires the exact latest `identity.inputRevision` token;
stale inputs are rejected before output creation. Whitespace changes affect file
identity even when the canonical authoring scene revision is unchanged. Entity
order remains part of the lowered runtime identity. The project ID and physical
viewport are also bound into the revision checked by the generated app.

Serve the resulting site directory with an ordinary static HTTP server and open
it in a browser with WebGPU on localhost or HTTPS. The generated app loads the
saved view and submits one explicit frame. It installs no animation loop. The
status text reports ready or an error; a private validation bridge retains actual
commit/frame evidence after a GPU fence. It does not claim compositor presentation
or performance, and the build receipt contains no rendered-frame evidence.

## Node API

```ts
import { initProject, inspectProject, buildProject } from '@strata-engine/preview/project';

const project = await initProject({ directory: './demo', id: 'demo' });
const current = await inspectProject({ projectPath: project.projectPath });
const result = await buildProject({
  projectPath: current.projectPath,
  expectedInputRevision: current.identity.inputRevision,
  outputDirectory: './site',
});
console.log(result.receiptPath);
```

`validateProject` uses the same detached snapshot as inspection. `signal` cancels
owned work in all four operations. Optional `checkAssets` asks authoring to check
external asset existence; `assetDirectory` supplies its external root and implies
that check. No assets are fetched, copied, parsed or cooked. Missing-file
diagnostics remain distinct from rejection by the current renderer profile.

Supported content is the [authored preview profile](preview.md): opaque procedural
root boxes, explicit perspective camera and directional direct PBR or base-color
diagnostic view. Core validates geometry, material, camera and viewport limits.
Imported assets and the broader engine's optional rendering systems are outside
this builder profile.

## Publication and diagnostics

The output contains `index.html`, a standalone `app.js`, `project-runtime.json`,
the complete matching Core distribution under `runtime/`, and
`build-receipt.json`. The receipt records exact input identity and output file
sizes/hashes. Core package version, bounded distribution inventory and file
identities are checked before publication. The browser separately validates its
scene/view hashes and supported Core descriptor before initialization.

Build requires a new output directory and publishes the completion receipt
exclusively last. Existing output is never overwritten. Observed input or runtime
distribution changes reject the attempt. Owned file/directory identities are
checked before publication and cleanup; replaced paths are preserved and reported
as incomplete artifacts. These checks support cooperating local files and do not
provide a multi-file writer transaction or an OS sandbox against hostile races.

Cancellation waits for actual owned I/O and publication outcomes. Confirmed
publication survives a late abort or cleanup warning. A cleanup failure cannot
turn a known published result into a reported rollback. CLI stdout is one terminal
JSON object. If that write fails, stderr preserves known publication/path and
unknown-outcome evidence; stdout is not retried because it may already have
delivered a prefix.

CLI exit codes are 0 for success/help, 1 for unexpected failure/cancellation or
reporting failure, 2 for usage, 3 for invalid inputs, 4 for revision/output
conflicts, and 5 for input/output I/O failures. Use `strata-project --help` or
`discover` for structured command discovery. CPU tests and installed-package
delivery checks do not establish browser, graphics-quality or performance results.
