# Agent-driven authoring foundation

`@strata-engine/authoring` is a separate optional Node.js package for creating,
inspecting and editing versioned scene documents through JSON, TypeScript and the
`strata-scene` CLI. This is the first independent slice of
[#8](https://github.com/tylerstuff/strata/issues/8). Its shared data contract is also
used by the separate optional [preview package](preview.md), which lowers supported
opaque procedural root boxes into Core and provides browser capture tooling.
The optional [stdio connection](preview-connection.md) loads these files through
the same authoring validation before controlling a preview session.

**This authoring package handles documents, not browser execution.** It does not
cook geometry, import models or launch a viewport. External asset records alone
do not establish runtime support, and the authored preview profile rejects them.
The restricted [integrated courtyard](integrated.md) retains its own runtime
contract.

## Install and run

The package is unpublished. With repository dependencies installed, a contributor
can build and pack only the authoring package:

```sh
npm run build:authoring
npm pack --workspace @strata-engine/authoring
```

In an ordinary Node.js 22.13+ consumer project, install that archive:

```sh
npm install /absolute/path/to/strata-engine-authoring-0.0.0.tgz
npx --no-install strata-scene --help
npx --no-install strata-scene schema scene
npx --no-install strata-scene schema batch
npx --no-install strata-scene create scene.json --id demo --name "Authoring demo" --fixture boxes
npx --no-install strata-scene inspect scene.json --entity box-1
npx --no-install strata-scene validate scene.json
```

`create` without `--fixture boxes` writes an empty valid scene. It refuses to
overwrite an existing path. Consumers install prebuilt JavaScript and declarations
with no install build hooks or Rust tooling. Authoring does not depend on
`@strata-engine/core`, and the runtime does not depend on authoring. The runtime's
[precompiled WASM delivery](runtime.md#asset-delivery-and-the-cpu-boundary) is
unchanged. This Node package is for development tools; it is not a browser scene
loader or a runtime bundle dependency.

## Version 1 scene contract

The document uses strict UTF-8 JSON, with no byte-order mark, invalid UTF-8 bytes, comments, trailing commas, unknown fields
or implicit coercion. `strata-scene schema scene` returns the JSON Schema inside
its structured result. Semantic validation also checks finite numbers, duplicate
IDs, references and quaternion length; the JSON Schema alone is not the complete
validator. Use `parseScene`/`validateScene` or `strata-scene validate` before use.

```json
{
  "format": "strata.scene",
  "version": 1,
  "id": "demo",
  "name": "Authoring demo",
  "coordinateSystem": "strata-world-v1",
  "assets": [
    { "id": "unit-box", "kind": "procedural-box", "size": [1, 1, 1] }
  ],
  "materials": [
    { "id": "warm-stone", "kind": "pbr", "baseColor": [0.7, 0.5, 0.3, 1], "metallic": 0, "roughness": 0.8 }
  ],
  "entities": [
    {
      "id": "box-1",
      "name": "Procedural box",
      "assetId": "unit-box",
      "materialId": "warm-stone",
      "transform": { "position": [0, 0.5, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] }
    }
  ]
}
```

| Record | Accepted fields and behavior |
| --- | --- |
| Scene | Required `format`, `version`, `id`, `name`, `coordinateSystem`, `assets`, `materials`, `entities`. Unknown versions and coordinate markers fail validation. |
| Procedural asset | `id`, `kind: "procedural-box"`, `size: [x,y,z]`; positive finite full extents in metres, centered at the local origin. |
| External asset | `id`, `kind: "external"`, `uri`, `mediaType`; an explicit reference only. It does not certify an importer, material conversion or runtime support. |
| Material | `id`, `kind: "pbr"`, linear `baseColor: [r,g,b,1]`, `metallic`, `roughness`; color, metallic and roughness components are in `[0,1]`. Alpha must be `1`. |
| Entity | `id`, optional `name`, existing `assetId` and `materialId`, required root `transform`. |

IDs match `^[a-z][a-z0-9._-]{0,63}$`. They are explicit, unique within their
collection and independent of names, positions and array indices. Preserve an ID
when changing a record. References use IDs, never collection offsets. Names are
nonempty strings with at most 256 characters.

The coordinate boundary agreed with
[#18](https://github.com/tylerstuff/strata/issues/18) is
`coordinateSystem: "strata-world-v1"`: metres, right-handed axes, +Y up and local
forward -Z. This scene subset contains root entities only, so position is global.
Positions are finite binary64 JavaScript/JSON numbers with each component in
`[-2**30, 2**30]`. Rotation is `[x,y,z,w]` with
`abs(hypot(x,y,z,w) - 1) <= 1e-6`; validation and serialization do not silently
normalize it. Scale components are in `[1e-6, 1e6]`. Positive scale is an initial
authoring restriction. The transform contract is `T * R * S` for column vectors:
local scale, then rotation, then translation.

The position guard is a CPU numeric boundary, not evidence of huge-world GPU
precision or rendering support. Parenting, local child transforms, cells, cameras,
render settings, lights, animation, textures and arbitrary components are not
accepted in this scene version. Future support must extend the contract
explicitly; tools must not guess the meaning of unknown data.

`serializeScene` validates, sorts object keys lexically, sorts each record
collection by ID, uses two-space indentation and ends with one newline. Other
arrays preserve their order. Negative zero becomes zero. Serialization does not
change IDs, transform values or the caller's object. This produces deterministic
files and small diffs after direct text edits.

## File, code and CLI workflow

After creating `scene.json` above, save the following as `plan-edit.mjs` in the
consumer project. The file API returns the scene and its semantic content revision.
This script prepares a typed-contract batch without changing the scene file:

```js
import { writeFile } from 'node:fs/promises';
import { inspectScene, readSceneFile } from '@strata-engine/authoring';

const { scene, revision } = await readSceneFile('scene.json');
const selected = inspectScene(scene, { entityId: 'box-1' });
if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));
const box = selected.value.selection.value;
const material = scene.materials.find(item => item.id === box.materialId);
const batch = {
  format: 'strata.scene-edit',
  version: 1,
  expectedRevision: revision,
  operations: [
    { op: 'set-entity', value: { ...box, transform: { ...box.transform, position: [3, 0.5, -2] } } },
    { op: 'set-material', value: { ...material, baseColor: [0.2, 0.6, 0.9, 1], roughness: 0.35 } }
  ]
};
await writeFile('edit.json', JSON.stringify(batch, null, 2) + '\n');
```

Run the noninteractive workflow:

```sh
node plan-edit.mjs
npx --no-install strata-scene diff scene.json --batch edit.json
npx --no-install strata-scene edit scene.json --batch edit.json
npx --no-install strata-scene validate scene.json
npx --no-install strata-scene inspect scene.json --entity box-1
npx --no-install strata-scene inspect scene.json --material warm-stone
```

`diff` previews the final changes without writing. `edit` validates and writes the
same result if the expected revision still matches. Read the saved file through
`readSceneFile` or `parseScene` to continue from the new revision. Running the old
batch again produces `SCENE_STALE`; inspect and review current data before making
a fresh batch. Submitting the same explicit set values against the new current
revision succeeds with `changed: false` and creates no duplicate records.

TypeScript consumers import `SceneDocument`, `SceneEntity`, `SceneAsset`,
`SceneMaterial`, `SceneBatch`, `InspectionQuery`, `Result` and the corresponding
operations from the same package. For example:

```ts
import {
  createProceduralScene, applySceneBatch, sceneRevision, serializeScene,
  type SceneBatch,
} from '@strata-engine/authoring';

const scene = createProceduralScene('code-demo');
const box = scene.entities[0]!;
const batch: SceneBatch = {
  format: 'strata.scene-edit', version: 1, expectedRevision: sceneRevision(scene),
  operations: [{ op: 'set-entity', value: { ...box, name: 'Renamed box' } }],
};
const result = applySceneBatch(scene, batch);
if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
const text = serializeScene(result.value.scene);
```

`parseScene`, `validateScene`, `parseBatch`, `validateBatch`, `inspectScene` and
`applySceneBatch` return `{ok: true, value}` or `{ok: false, diagnostics}`. Factory
and serialization errors throw `AuthoringError`; asynchronous file operations
also throw `AuthoringError` with the same diagnostics. `createSceneFile`,
`readSceneFile`, `previewSceneFile` and `editSceneFile` provide the shared file
behavior used by the CLI. No renderer internals are accessed.

## Edits, revisions and recovery

A batch requires `format: "strata.scene-edit"`, `version: 1`, an
`expectedRevision` and an ordered `operations` array of up to 10,000 operations.
`set-entity`, `set-asset` and `set-material` each take a complete `value` record;
they create or replace that ID. `remove-entity`, `remove-asset` and
`remove-material` take an `id`. Removing an absent ID is a no-op. Multiple sets
of one ID follow operation order; the last set wins.

The complete final graph must pass validation before writing. A batch may remove
an old material, create its replacement and redirect all entities in any order;
an unresolved reference at the end rejects the entire batch. No partial changes
are saved. In-memory operations preserve the input scene.

Revisions are `sha256:<64 lowercase hexadecimal characters>` over canonical
scene text. Whitespace, object-key order and collection order do not change the
revision. The revision is returned separately and is not embedded in the scene.
Preview results contain `baseRevision`, resulting `revision`, `changed` and
`changes`; each change names a collection and ID with complete `before`/`after`
records (`null` for creation or removal). The code API also returns the resulting
scene. CLI diff/edit output omits that full scene.

Scene files are limited to 16 MiB. The parent directory must already exist.
Edits retain existing file permission bits, including under a restrictive writer
umask. New scenes use mode `0600` subject to that umask.
The file API accepts regular files with one hard link, rejects leaf symlinks and
resolves parent-directory symlinks to a common path. Edit writers use an adjacent
`<scene>.strata-lock` and a temporary file followed by atomic rename. Creation
publishes exclusively so an existing target cannot be overwritten.
Cooperating CLI/API writers receive `FILE_BUSY` while another writer holds the
lock. Before replacement, the writer rechecks the original bytes, catching
external changes observed during its write. This is not a transaction with an
uncooperative text editor that ignores the lock: an editor may still race after
the final check. Use one writer for a scene while saving. Preview does not reserve
a revision or acquire a lasting write lease.

A rejected stale, invalid or busy edit leaves the scene unchanged. Read the
current scene and diagnostics, rebuild the batch, preview it and retry. A crashed
process can leave a lock or temporary file. Inspect the file and confirm no writer
is active before manually removing a stale lock; there is no automatic lock
stealing. Atomic replacement does not provide an edit history or undo log, so
review and commit ordinary scene files in the consuming project's version control
as appropriate.

## Bounded inspection and diagnostics

`inspect` can select one entity, asset or material by ID. Without a selector it
returns counts and an entity page in stable ID order; the default limit is 100
and the maximum is 1,000. Use its `nextCursor` as `--after` for the next page:

```sh
npx --no-install strata-scene inspect scene.json --limit 10
npx --no-install strata-scene inspect scene.json --limit 10 --after box-1
```

Do not combine a selector with pagination flags. Pin the returned scene revision
across multiple queries, and restart pagination if it changes. An absent cursor
fails rather than silently skipping records. Output is bounded; parsing and
validation still read the complete document. This is not spatial indexing,
streamed world storage or a cell query API.

Every CLI invocation emits one JSON result to stdout and requires no prompts or
stdin. Success has `{ok: true, command, ...}`; failure has
`{ok: false, command, diagnostics}`. Help declares supported capabilities and
explicitly marks browser loading, cooking, importing, preview and local connection
support as absent from `strata-scene`. Those capability flags describe this
authoring CLI; the optional preview package supplies its own capture CLI and
[connection entry point](preview-connection.md).

| Exit code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Unexpected internal failure |
| `2` | Invalid command or arguments |
| `3` | Invalid scene, batch, asset or reference |
| `4` | Stale revision, busy writer or existing destination |
| `5` | Filesystem I/O failure |

Diagnostics contain a stable `code`, JSON Pointer `path`, human-readable
`message` and corrective `suggestion`. File parsing adds `source`; affected
records include `entityId`, `assetId` or `materialId` where available. JSON syntax
errors may also contain line and column. Semantic errors use JSON Pointers rather
than fabricated text coordinates. For example, adding `camera: {}` to the root
returns `UNSUPPORTED_FIELD` at `/camera`, and deleting a referenced asset returns
a missing-reference diagnostic with its entity context. Branch on codes and
fields, not English message text.

## External asset references

An external record can name a local asset without copying it:

```json
{ "id": "statue", "kind": "external", "uri": "statue/model.gltf", "mediaType": "model/gltf+json" }
```

Structural validation records this reference only. Optional existence checks use
`strata-scene validate scene.json --assets`. The root directory is selected in
this order: `--asset-root`, `STRATA_BENCHMARK_ASSET_DIR`, then the scene file's
directory. `--asset-root` requires `--assets`.

```sh
STRATA_BENCHMARK_ASSET_DIR=/absolute/external/assets npx --no-install strata-scene validate scene.json --assets
npx --no-install strata-scene validate scene.json --assets --asset-root /absolute/external/assets
```

Existence checking requires a relative URI path below the selected root. Percent
escapes are decoded; absolute paths, network schemes, query strings, fragments,
backslashes and control characters are rejected. Resolved paths, including
symlink targets, must stay below the root and identify regular files.

Checks report missing or unsupported local references; they do not fetch remote
URLs, import or cook asset contents, verify a declared MIME type against bytes, or
copy assets into the scene directory. A successful existence check does not mean
that the browser renderer supports the file. Follow the
[benchmark asset policy](benchmark-assets.md): all Sketchfab models, textures,
archives, converted files and cooked copies remain outside Git and every upload
destination, with their local attribution and provenance. Tests use only tiny
procedural data and temporary descriptors.

## Validation and remaining work

With dependencies installed, the focused checks are CPU-only:

```sh
npm run check:authoring
```

This runs authoring type checks, unit/CLI tests, the package build and
`npm run test:authoring:consumer`. The packed consumer runner installs an archive
into a temporary directory outside the workspace with install scripts disabled,
compiles against the installed
declarations, and runs a file/code/CLI workflow. It checks canonical reloads,
selected and paginated inspection, diff previews, transform/material edits,
idempotent sets, all-or-nothing invalid batches, stale rejection, failed-operation
recovery and local missing-asset diagnostics. It checks package separation and
uses Rust-tool sentinels to detect accidental consumer Rust invocations. Temporary
files are removed after the run; no GPU or browser is started.

The full repository check remains `npm run check`; it includes browser/GPU suites
and must be scheduled separately from hardware measurement windows. Record its
actual outcome on issue #8 rather than treating a CPU-only authoring pass as the
complete check.

The separate [preview workflow](preview.md) supplies browser readiness and
revision-linked captures for procedural boxes. The [local connection
implementation](preview-connection.md) reuses those operations; its CPU checks
passed and its browser behavior remains unverified. General asset
cooking/import in this workflow, ordinary-browser application building and broader
scene authoring remain issue #8 work. Coordinate precision and large-world
contracts continue under #18. These bounded tools do not satisfy the full issue
acceptance criteria or establish graphics performance.
