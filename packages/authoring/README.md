# @strata-engine/authoring

Optional Node.js tooling for Strata scene documents, typed edits and a
noninteractive JSON CLI. The package is experimental and unpublished. It supports
standalone authoring data; the browser runtime does not load these documents yet.

Install the prebuilt package archive in a Node.js 22.13+ project. There are no
install build hooks, Rust tools, browser or GPU requirements. The package is
independent of `@strata-engine/core` and belongs in development tooling.

```sh
npx --no-install strata-scene --help
npx --no-install strata-scene create scene.json --id demo --fixture boxes
npx --no-install strata-scene inspect scene.json --entity box-1
npx --no-install strata-scene validate scene.json
npx --no-install strata-scene schema batch
```

```ts
import {
  createProceduralScene, applySceneBatch, sceneRevision, serializeScene,
  type SceneBatch,
} from '@strata-engine/authoring';

const scene = createProceduralScene('demo');
const box = scene.entities[0]!;
const batch: SceneBatch = {
  format: 'strata.scene-edit', version: 1, expectedRevision: sceneRevision(scene),
  operations: [{
    op: 'set-entity',
    value: { ...box, transform: { ...box.transform, position: [3, 0.5, -2] } },
  }],
};
const preview = applySceneBatch(scene, batch);
if (!preview.ok) throw new Error(JSON.stringify(preview.diagnostics));
const text = serializeScene(preview.value.scene);
```

The version 1 format uses stable IDs, root transforms, procedural-box descriptors,
external asset references and opaque PBR material records. Unknown fields fail
validation. Serialization is deterministic. Batch editing validates the complete
final graph and rejects stale revisions before replacement. File APIs and CLI
commands share the same data model and diagnostics.

Use `diff <scene> --batch <batch>` before `edit <scene> --batch <batch>` to review a
change. `inspect` accepts a selected entity/asset/material or bounded entity
pagination. `validate --assets` checks local reference existence with an optional
`--asset-root`; its default is `STRATA_BENCHMARK_ASSET_DIR` or the scene directory.
It never fetches, imports, cooks or copies models. All Sketchfab benchmark content
and derived files must stay outside the repository and uploads.

Every command emits one JSON result. Exit codes are `0` success, `1` unexpected
failure, `2` usage, `3` validation, `4` stale/busy/existing conflict and `5` I/O.
Diagnostics include code, JSON Pointer, message, corrective suggestion and
source/record IDs when available. Adjacent locks coordinate CLI/API writers;
ordinary editors that ignore those locks can still race with a save. Inspect a
leftover lock after a crash before manually removing it.

See the [authoring guide](https://github.com/tylerstuff/strata/blob/main/docs/authoring.md)
for the full scene contract, file/code/CLI workflow, revision behavior, asset
policy and packed consumer validation. Browser loading, GUI, MCP/local connections,
preview/capture feedback and general asset importing remain outside this first
slice of [issue #8](https://github.com/tylerstuff/strata/issues/8).
