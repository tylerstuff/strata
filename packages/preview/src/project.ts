import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { canonicalJson, createProceduralScene, serializeScene } from '@strata-engine/authoring';
import { PreviewError } from './errors.js';
import { defaultProjectView, readProjectSnapshot, validateProjectDocument } from './project-input.js';
import {
  projectAbort, projectFileMetadata, publishProjectDirectory, readProjectClient,
  readProjectFile, snapshotRuntimeDistribution, type ProjectFileSnapshot,
} from './project-output.js';
import type {
  ProjectBuildOptions, ProjectBuildReceipt, ProjectBuildResult, ProjectInitOptions,
  ProjectInitResult, ProjectInspection, ProjectReadOptions,
} from './project-types.js';

export type * from './project-types.js';
export { PreviewError } from './errors.js';

const json = (value: unknown): Buffer => Buffer.from(`${canonicalJson(value)}\n`);
const controls = /[\\\u0000-\u001f\u007f-\u009f]/;
function invalid(message: string): never {
  throw new PreviewError('PROJECT_INVALID_OPTIONS', 'project-options', message);
}
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid('Expected plain project options.');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key))
    || Object.values(descriptors).some(item => item.get || item.set)) invalid('Unknown option fields and accessor properties are unsupported.');
  const result = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])) as Record<string, unknown>;
  if (result.signal !== undefined && !(result.signal instanceof AbortSignal)) invalid('Expected an AbortSignal.');
  return result;
}
function path(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096 || controls.test(value)
    || /^[a-z][a-z0-9+.-]*:/i.test(value)) invalid('Expected a nonempty local path without controls, schemes, or backslashes.');
  // Snapshot relative paths before any awaited file or package work.
  return resolve(value);
}
function readOptions(input: Record<string, unknown>): ProjectReadOptions {
  return {
    projectPath: path(input.projectPath),
    ...(input.checkAssets === undefined ? {} : { checkAssets: input.checkAssets as boolean }),
    ...(input.assetDirectory === undefined ? {} : { assetDirectory: path(input.assetDirectory) }),
    ...(input.signal === undefined ? {} : { signal: input.signal as AbortSignal }),
  };
}

/** Create a new saved procedural fixture; project.json is the last publication. */
export async function initProject(input: ProjectInitOptions): Promise<ProjectInitResult> {
  const options = record(input, ['directory', 'id', 'name', 'signal']);
  const directory = path(options.directory), signal = options.signal as AbortSignal | undefined;
  if (options.name !== undefined && typeof options.name !== 'string') invalid('Project name must be a string when supplied.');
  const project = validateProjectDocument({ format: 'strata.project', version: 1,
    id: options.id, name: options.name ?? options.id, scene: 'scene.json', view: 'view.json', width: 512, height: 512 });
  // The authoring package owns scene IDs/materials/transforms; no second schema.
  const scene = createProceduralScene(project.id, project.name), view = defaultProjectView();
  const result = await publishProjectDirectory({ directory,
    files: [{ path: project.scene, contents: Buffer.from(serializeScene(scene)) }, { path: project.view, contents: json(view) }],
    completionName: 'project.json', completion: json(project),
    ...(signal === undefined ? {} : { signal }),
    prepareResult: async (temporary, destination) => {
      const snapshot = await readProjectSnapshot({ projectPath: temporary, ...(signal === undefined ? {} : { signal }) });
      return { ...snapshot.inspection, projectPath: destination };
    },
  });
  return { ...result.value, publicationOccurred: true,
    ...(result.cleanupWarnings.length ? { cleanupWarnings: result.cleanupWarnings } : {}) };
}

/** Read, validate and lower through the existing authoring/Core contracts. */
export async function inspectProject(options: ProjectReadOptions): Promise<ProjectInspection> {
  return (await readProjectSnapshot(options)).inspection;
}

/** Asset checks remain opt-in and never fetch, copy, parse or cook assets. */
export async function validateProject(options: ProjectReadOptions): Promise<ProjectInspection> {
  return (await readProjectSnapshot(options)).inspection;
}

// Dynamic values live in project-runtime.json, not executable HTML or script.
const projectHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Strata saved project</title>
  <style>body{margin:0;background:#171c1b;color:#f3f4ef;font:16px system-ui,sans-serif}main{max-width:100%;padding:1rem}canvas{display:block;max-width:100%;height:auto}#project-error{color:#ffb5ad;white-space:pre-wrap}</style>
  <script type="importmap">{"imports":{"@strata-engine/core":"./runtime/index.js"}}</script>
</head>
<body><main>
  <p id="project-status" role="status">Loading saved project…</p>
  <p id="project-error" role="alert" hidden></p>
  <canvas id="project-canvas" aria-label="Saved Strata scene"></canvas>
</main><script type="module" src="./app.js"></script></body>
</html>
`;

/** Package a validated input snapshot; this function never launches a browser. */
export async function buildProject(input: ProjectBuildOptions): Promise<ProjectBuildResult> {
  const options = record(input, ['projectPath', 'checkAssets', 'assetDirectory', 'signal', 'expectedInputRevision', 'outputDirectory']);
  const source = readOptions(options), outputDirectory = path(options.outputDirectory);
  const expected = options.expectedInputRevision;
  if (typeof expected !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(expected)) invalid('Supply the exact expectedInputRevision from project inspection.');
  const snapshot = await readProjectSnapshot(source);
  if (snapshot.inspection.identity.inputRevision !== expected) {
    throw new PreviewError('PROJECT_INPUT_STALE', 'build-project', 'Saved project inputs differ from the expected revision.', {
      expectedInputRevision: expected, actualInputRevision: snapshot.inspection.identity.inputRevision, publicationOccurred: false,
    });
  }
  let runtime;
  try {
    const ownManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      await readProjectFile(fileURLToPath(new URL('../package.json', import.meta.url)), 64 * 1024, source.signal),
    )) as { name?: unknown; dependencies?: Record<string, unknown> };
    const version = ownManifest.dependencies?.['@strata-engine/core'];
    if (ownManifest.name !== '@strata-engine/preview' || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error('Preview must declare an exact matching Core runtime dependency.');
    }
    runtime = await snapshotRuntimeDistribution(fileURLToPath(import.meta.resolve('@strata-engine/core/package.json')), version, source.signal);
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError('PROJECT_RUNTIME_DISTRIBUTION_INVALID', 'snapshot-runtime', error instanceof Error ? error.message : 'Cannot resolve the installed Core runtime.');
  }
  const client = await readProjectClient(fileURLToPath(new URL('./browser/project-client.js', import.meta.url)), source.signal);
  projectAbort(source.signal, 'build-project');
  const files: ProjectFileSnapshot[] = [
    { path: 'index.html', contents: Buffer.from(projectHtml) }, { path: 'app.js', contents: client },
    { path: 'project-runtime.json', contents: json(snapshot.runtimeData) },
    ...runtime.files.map(file => ({ ...file, path: `runtime/${file.path}` })),
  ];
  const receipt: ProjectBuildReceipt = {
    format: 'strata.project.build', version: 1, projectId: snapshot.inspection.project.id,
    identity: snapshot.inspection.identity, width: snapshot.runtimeData.width, height: snapshot.runtimeData.height,
    runtime: { package: '@strata-engine/core', version: runtime.version, files: runtime.files.map(projectFileMetadata) },
    files: files.map(projectFileMetadata),
  };
  const result = await publishProjectDirectory({ directory: outputDirectory, files,
    completionName: 'build-receipt.json', completion: json(receipt),
    ...(source.signal === undefined ? {} : { signal: source.signal }),
    prepareResult: async () => {
      // The deployed data remains the first immutable, validated snapshot. This
      // second read only rejects source changes observed before publication.
      const current = await readProjectSnapshot(source);
      if (current.inspection.identity.inputRevision !== expected) {
        throw new PreviewError('PROJECT_INPUT_CHANGED', 'verify-project', 'Saved inputs changed while the build was being written.', {
          expectedInputRevision: expected, actualInputRevision: current.inspection.identity.inputRevision,
        });
      }
      return structuredClone(receipt);
    },
  });
  return { publicationOccurred: true, outputDirectory: result.directory, receiptPath: result.completionPath, receipt: result.value,
    ...(result.cleanupWarnings.length ? { cleanupWarnings: result.cleanupWarnings } : {}) };
}
