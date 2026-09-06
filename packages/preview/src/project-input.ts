import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AuthoringError, ID_PATTERN, MAX_SCENE_FILE_BYTES, canonicalJson, parseScene, sceneRevision, validateSceneAssets } from '@strata-engine/authoring';
import { AuthoredBoxValidationError, validateAuthoredFrameCamera } from '@strata-engine/core';
import { prepareAuthoredPreviewLoad, type AuthoredPreviewView } from './adapter.js';
import { PreviewError } from './errors.js';
import type { ProjectDocument, ProjectIdentity, ProjectInputRevisionPayload, ProjectInspection, ProjectReadOptions, ProjectRuntimeData } from './project-types.js';

export const MAX_PROJECT_FILE_BYTES = 64 * 1024;
export const MAX_PROJECT_VIEW_BYTES = 64 * 1024;
const controls = /[\\\u0000-\u001f\u007f-\u009f]/;
const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const revision = (value: unknown): string => `sha256:${hash(canonicalJson(value))}`;

function fail(code: string, stage: string, message: string, source?: string, path = ''): never {
  throw new PreviewError(code, stage, message, {
    ...(source === undefined ? {} : { source }),
    diagnostics: [{ code, path, message, suggestion: 'Review the selected project and its input files, then retry with a fresh snapshot.', ...(source === undefined ? {} : { source }) }],
  });
}
function abort(signal: AbortSignal | undefined, source: string): void {
  if (signal?.aborted) fail('PROJECT_ABORTED', 'read-project', 'Project reading was canceled.', source);
}
function wrap(error: unknown, source: string, stage: string): PreviewError {
  if (error instanceof PreviewError) return error;
  return new PreviewError(error instanceof AuthoringError ? 'PROJECT_INPUT_INVALID' : 'PROJECT_INPUT_IO', stage,
    error instanceof Error ? error.message : 'Cannot read project input.', {
      source,
      ...(error instanceof AuthoringError ? { diagnostics: error.diagnostics.map(item => ({ ...item, source: item.source ?? source })) } : {}),
    });
}
function relativeFile(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 4096 || isAbsolute(value)
    || controls.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)
    || value.split('/').some(part => part === '..' || part === '.' || part === '')) {
    fail('PROJECT_INPUT_PATH', 'project-document', 'Expected a nonempty relative file path without traversal, schemes, backslashes, or empty components.', undefined, path);
  }
  return value;
}

/** Validate only the project envelope. Scene and view validation stay with authoring/Core. */
export function validateProjectDocument(input: unknown): ProjectDocument {
  try { canonicalJson(input); }
  catch { fail('PROJECT_DOCUMENT_INVALID', 'project-document', 'Project document must contain strict JSON data.'); }
  const keys = ['format', 'version', 'id', 'name', 'scene', 'view', 'width', 'height'];
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('PROJECT_DOCUMENT_INVALID', 'project-document', 'Expected a project object.');
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail('PROJECT_DOCUMENT_INVALID', 'project-document', 'Unknown project field.', undefined, `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail('PROJECT_DOCUMENT_INVALID', 'project-document', 'Required project field is missing.', undefined, `/${key}`);
  if (value.format !== 'strata.project') fail('PROJECT_DOCUMENT_INVALID', 'project-document', 'Expected format strata.project.', undefined, '/format');
  if (value.version !== 1) fail('PROJECT_DOCUMENT_INVALID', 'project-document', 'Only project version 1 is supported.', undefined, '/version');
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) fail('PROJECT_DOCUMENT_INVALID', 'project-document', 'Expected a stable authoring-style ASCII ID.', undefined, '/id');
  if (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 256) fail('PROJECT_DOCUMENT_INVALID', 'project-document', 'Project name must contain 1 to 256 characters.', undefined, '/name');
  relativeFile(value.scene, '/scene'); relativeFile(value.view, '/view');
  for (const key of ['width', 'height']) if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > 16_384) fail('PROJECT_DOCUMENT_INVALID', 'project-document', 'Physical pixel dimensions must be integers from 1 to 16384.', undefined, `/${key}`);
  if ((value.width as number) * (value.height as number) > 64 * 1024 * 1024) fail('PROJECT_DOCUMENT_INVALID', 'project-document', 'Physical viewport exceeds 64 Mi pixels.', undefined, '/width');
  return structuredClone(value) as unknown as ProjectDocument;
}

export function defaultProjectView(): AuthoredPreviewView {
  return {
    camera: { position: [0, 0.5, 4], rotation: [0, 0, 0, 1], projection: { kind: 'perspective', verticalFovRadians: 55 * Math.PI / 180, near: 0.1, far: 32 } },
    light: { directionToLight: [0, 0, 1], radiance: [2, 2, 2] }, background: [0.002, 0.002, 0.002],
    debugView: 'final', timeSeconds: 0, temporal: false,
  };
}

interface PathIdentity { path: string; dev: bigint; ino: bigint }
interface RootIdentity extends PathIdentity { requested: string }
interface InputFile { path: string; bytes: Buffer; info: BigIntStats; parents: PathIdentity[]; maximum: number }
function sameNode(a: PathIdentity, b: { dev: bigint; ino: bigint }): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameNode({ path: '', dev: a.dev, ino: a.ino }, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
    && b.isFile() && b.nlink === 1n && !b.isSymbolicLink();
}
async function verifyRoot(root: RootIdentity): Promise<void> {
  try {
    const info = await lstat(root.path, { bigint: true });
    if (await realpath(root.requested) !== root.path || !info.isDirectory() || info.isSymbolicLink() || !sameNode(root, info)) throw new Error('Changed root.');
  } catch { fail('PROJECT_INPUT_CHANGED', 'verify-project', 'Project root was renamed, replaced, or redirected while reading.', root.path); }
}
async function parents(root: RootIdentity, file: string): Promise<PathIdentity[]> {
  await verifyRoot(root);
  const child = relative(root.path, file);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) fail('PROJECT_INPUT_PATH', 'read-project', 'Input must be a file below the project root.', file);
  let path = root.path;
  const result: PathIdentity[] = [];
  for (const component of child.split(sep).slice(0, -1)) {
    path = join(path, component);
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) fail('PROJECT_INPUT_PATH', 'read-project', 'Input parents must be real directories without symbolic links.', file, '');
    result.push({ path, dev: info.dev, ino: info.ino });
  }
  return result;
}
async function verifyFile(root: RootIdentity, file: InputFile): Promise<void> {
  try {
    await verifyRoot(root);
    for (const parent of file.parents) {
      const info = await lstat(parent.path, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory() || !sameNode(parent, info)) throw new Error('Changed parent.');
    }
    const info = await lstat(file.path, { bigint: true });
    if (!sameFile(file.info, info) || await realpath(file.path) !== file.path) throw new Error('Changed input.');
  } catch { fail('PROJECT_INPUT_CHANGED', 'verify-project', 'An input path or its bytes changed while the project was being read.', file.path); }
}
async function readInput(root: RootIdentity, path: string, maximum: number, signal?: AbortSignal): Promise<InputFile> {
  abort(signal, path);
  const directoryIdentities = await parents(root, path);
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) fail('PROJECT_INPUT_PATH', 'read-project', 'Inputs must be regular files with one hard link; symbolic links are unsupported.', path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let result: InputFile;
  try {
    const info = await handle.stat({ bigint: true });
    if (!sameFile(before, info)) fail('PROJECT_INPUT_CHANGED', 'read-project', 'Input identity changed before it could be opened.', path);
    if (info.size > BigInt(maximum)) fail('PROJECT_INPUT_TOO_LARGE', 'read-project', `Input exceeds its ${maximum}-byte limit.`, path);
    const chunks: Buffer[] = []; let bytes = 0;
    for (;;) {
      abort(signal, path);
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum - bytes + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      abort(signal, path);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maximum) fail('PROJECT_INPUT_TOO_LARGE', 'read-project', `Input exceeds its ${maximum}-byte limit.`, path);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (!sameFile(info, await handle.stat({ bigint: true })) || BigInt(bytes) !== info.size) fail('PROJECT_INPUT_CHANGED', 'read-project', 'Input bytes changed while reading.', path);
    result = { path, bytes: Buffer.concat(chunks, bytes), info, parents: directoryIdentities, maximum };
  } finally { await handle.close(); }
  await verifyFile(root, result);
  abort(signal, path);
  return result;
}
function text(file: InputFile): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes); }
  catch { fail('PROJECT_INPUT_INVALID', 'parse-project', 'Input must be valid UTF-8 JSON; invalid bytes cannot be silently replaced.', file.path); }
}
function json(file: InputFile): unknown {
  try { return JSON.parse(text(file)) as unknown; }
  catch (error) {
    if (error instanceof PreviewError) throw error;
    fail('PROJECT_INPUT_INVALID', 'parse-project', `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, file.path);
  }
}
function withSource(error: PreviewError, source: string): PreviewError {
  const diagnostics = error.details.diagnostics;
  return new PreviewError(error.code, error.stage, error.message, { ...error.details, source,
    ...(Array.isArray(diagnostics) ? { diagnostics: diagnostics.map(item => ({ ...item, source })) } : {}) });
}
function optionsSnapshot(input: ProjectReadOptions): Required<Pick<ProjectReadOptions, 'projectPath' | 'checkAssets'>> & Omit<ProjectReadOptions, 'projectPath' | 'checkAssets'> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('PROJECT_INVALID_OPTIONS', 'read-project', 'Expected project read options.');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !['projectPath', 'checkAssets', 'assetDirectory', 'signal'].includes(key))
    || Object.values(descriptors).some(item => item.get || item.set)) fail('PROJECT_INVALID_OPTIONS', 'read-project', 'Unknown fields and accessor properties are unsupported.');
  if (typeof input.projectPath !== 'string' || input.projectPath.length === 0 || Buffer.byteLength(input.projectPath) > 4096 || controls.test(input.projectPath) || /^[a-z][a-z0-9+.-]*:/i.test(input.projectPath)
    || (input.checkAssets !== undefined && typeof input.checkAssets !== 'boolean')
    || (input.assetDirectory !== undefined && (typeof input.assetDirectory !== 'string' || input.assetDirectory.length === 0 || Buffer.byteLength(input.assetDirectory) > 4096 || controls.test(input.assetDirectory)))
    || (input.signal !== undefined && !(input.signal instanceof AbortSignal)) || (input.checkAssets === false && input.assetDirectory !== undefined)) fail('PROJECT_INVALID_OPTIONS', 'read-project', 'Supply a project path, optional boolean asset check, optional external asset directory, and AbortSignal.');
  return { projectPath: resolve(input.projectPath), checkAssets: input.checkAssets ?? input.assetDirectory !== undefined,
    ...(input.assetDirectory === undefined ? {} : { assetDirectory: resolve(input.assetDirectory) }), ...(input.signal === undefined ? {} : { signal: input.signal }) };
}

/**
 * A bounded, detached snapshot for a cooperating local project. Explicit root
 * aliases resolve once; input descendants never follow symlinks. Rechecks detect
 * observed changes, but are not an OS sandbox or a multi-file writer transaction.
 */
export async function readProjectSnapshot(input: ProjectReadOptions): Promise<{ inspection: ProjectInspection; runtimeData: ProjectRuntimeData }> {
  const options = optionsSnapshot(input);
  const requestedRoot = dirname(options.projectPath);
  abort(options.signal, options.projectPath);
  let root: RootIdentity | undefined;
  const files: InputFile[] = [];
  let source = options.projectPath;
  try {
    const path = await realpath(requestedRoot), info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) fail('PROJECT_INPUT_PATH', 'read-project', 'Project parent must identify a directory.', requestedRoot);
    root = { path, requested: requestedRoot, dev: info.dev, ino: info.ino };
    source = join(root.path, basename(options.projectPath));
    const projectFile = await readInput(root, source, MAX_PROJECT_FILE_BYTES, options.signal); files.push(projectFile);
    let project: ProjectDocument;
    try { project = validateProjectDocument(json(projectFile)); }
    catch (error) { throw error instanceof PreviewError ? withSource(error, source) : error; }
    source = join(root.path, project.scene);
    const sceneFile = await readInput(root, source, MAX_SCENE_FILE_BYTES, options.signal); files.push(sceneFile);
    const parsed = parseScene(text(sceneFile), source);
    if (!parsed.ok) throw new AuthoringError(parsed.diagnostics);
    const sourceRevision = sceneRevision(parsed.value);
    source = join(root.path, project.view);
    const viewFile = await readInput(root, source, MAX_PROJECT_VIEW_BYTES, options.signal); files.push(viewFile);
    const view = json(viewFile);
    if (options.checkAssets) {
      abort(options.signal, sceneFile.path);
      const assets = await validateSceneAssets(parsed.value, { scenePath: sceneFile.path, ...(options.assetDirectory === undefined ? {} : { assetRoot: options.assetDirectory }) });
      abort(options.signal, sceneFile.path);
      if (!assets.ok) throw new PreviewError('PROJECT_ASSET_INVALID', 'check-project-assets', 'Referenced assets failed authoring existence checks.', { source: sceneFile.path, diagnostics: assets.diagnostics });
    }
    let prepared;
    try {
      prepared = prepareAuthoredPreviewLoad({ scene: parsed.value, revision: sourceRevision, view });
      validateAuthoredFrameCamera(prepared.scene, prepared.view.camera, project.width, project.height);
    }
    catch (failure) {
      const error = failure instanceof AuthoredBoxValidationError
        ? new PreviewError('PREVIEW_RUNTIME_VALIDATION_FAILED', 'prepare-frame', failure.message,
          { coreCode: failure.code, diagnostics: failure.diagnostics }) : failure;
      if (!(error instanceof PreviewError)) throw error;
      const diagnosticSource = (path: unknown): string => {
        if (typeof path === 'string' && /^\/(?:view|camera|light|background)(?:\/|$)/.test(path)) return viewFile.path;
        if (error.code === 'PREVIEW_UNSUPPORTED_ASSET'
          || (typeof path === 'string' && /^\/(?:scene|revision|boxes|coordinateSystem|sceneId|sourceRevision|format|version)(?:\/|$)/.test(path))) return sceneFile.path;
        return projectFile.path;
      };
      const diagnostics = Array.isArray(error.details.diagnostics)
        ? error.details.diagnostics.map(item => ({ ...item, source: diagnosticSource(item?.path) })) : undefined;
      const sources = new Set(diagnostics?.map(item => item.source));
      throw new PreviewError('PROJECT_PREVIEW_UNSUPPORTED', 'lower-project', error.message, { ...error.details, previewCode: error.code,
        source: sources.size === 1 ? [...sources][0] : projectFile.path,
        sceneSource: sceneFile.path, viewSource: viewFile.path,
        ...(diagnostics === undefined ? {} : { diagnostics }) });
    }
    const hashes = { projectSha256: hash(projectFile.bytes), sceneSha256: hash(sceneFile.bytes), viewSha256: hash(viewFile.bytes),
      runtimeSceneSha256: hash(canonicalJson(prepared.scene)), resolvedViewSha256: hash(canonicalJson(prepared.view)) };
    const revisionPayload: ProjectInputRevisionPayload = { format: 'strata.project.inputs', version: 1,
      projectId: project.id, width: project.width, height: project.height, ...hashes };
    const identity: ProjectIdentity = { projectRevision: revision(project), sourceRevision,
      inputRevision: revision(revisionPayload), ...hashes };
    // Re-read exact bytes after all dependent validation, then recheck every
    // recorded identity so an earlier input cannot be silently replaced mid-read.
    for (const file of files) {
      await verifyFile(root, file);
      const current = await readInput(root, file.path, file.maximum, options.signal);
      if (!current.bytes.equals(file.bytes)) fail('PROJECT_INPUT_CHANGED', 'verify-project', 'Input bytes changed before snapshot completion.', file.path);
    }
    const inspection: ProjectInspection = { projectPath: projectFile.path, projectRoot: root.path, project, identity,
      sceneId: parsed.value.id, counts: { assets: parsed.value.assets.length, materials: parsed.value.materials.length, entities: parsed.value.entities.length },
      view: prepared.view, capabilities: { profile: 'opaque-root-boxes', cooking: false, externalAssets: false } };
    const runtimeData: ProjectRuntimeData = { format: 'strata.project.runtime', version: 1, projectId: project.id, identity,
      width: project.width, height: project.height, scene: prepared.scene, view: prepared.view };
    return { inspection: structuredClone(inspection), runtimeData: structuredClone(runtimeData) };
  } catch (error) { throw wrap(error, source, 'read-project'); }
  finally {
    if (root) { await verifyRoot(root); for (const file of files) await verifyFile(root, file); }
    abort(options.signal, source);
  }
}
