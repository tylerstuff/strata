import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { AuthoringError, type Diagnostic, type Result, type SceneDocument } from './model.js';
import { applySceneBatch, sceneRevision, type EditPreview, type SceneBatch, type SceneSnapshot } from './operations.js';
import { canonicalJson, parseScene, serializeScene, validateScene } from './schema.js';

export const MAX_SCENE_FILE_BYTES = 16 * 1024 * 1024;

function failure(code: string, source: string, message: string, suggestion: string): AuthoringError {
  return new AuthoringError([{ code, path: '', source, message, suggestion }]);
}

function ioFailure(error: unknown, source: string): AuthoringError {
  if (error instanceof AuthoringError) return new AuthoringError(error.diagnostics.map(diagnostic => ({
    ...diagnostic, source: diagnostic.source ?? source,
  })));
  return failure('IO_ERROR', source, error instanceof Error ? error.message : 'Filesystem operation failed.',
    'Check the path, parent directory, permissions, and that the target is a regular file.');
}

function errno(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

/** Resolve parent symlinks so cooperating callers share one lock name. Leaf symlinks are rejected. */
async function scenePath(path: string): Promise<string> {
  const absolute = resolve(path);
  return join(await realpath(dirname(absolute)), basename(absolute));
}

async function readSnapshot(path: string): Promise<SceneSnapshot & { text: string; mode: number }> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw failure('IO_ERROR', path,
      'Scene files must be regular files with one hard link; symlinks are not supported.',
      'Use a separate regular scene file, or invoke the command on the actual file instead of a link.');
    const tooLarge = (): never => { throw failure('FILE_TOO_LARGE', path,
      `Scene exceeds ${MAX_SCENE_FILE_BYTES} bytes.`, 'Split the authoring data into smaller independent scene documents.'); };
    if (info.size > MAX_SCENE_FILE_BYTES) tooLarge();
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_SCENE_FILE_BYTES - bytes + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAX_SCENE_FILE_BYTES) tooLarge();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, bytes)); }
    catch { throw failure('INVALID_UTF8', path, 'Scene file contains invalid UTF-8 bytes.',
      'Save the scene as valid UTF-8 JSON; invalid bytes cannot be replaced without changing its data.'); }
    const result = parseScene(text, path);
    if (!result.ok) throw new AuthoringError(result.diagnostics);
    return { scene: result.value, revision: sceneRevision(result.value), text, mode: info.mode & 0o777 };
  } catch (error) { throw ioFailure(error, path); }
  finally { await handle?.close(); }
}

export async function readSceneFile(path: string): Promise<SceneSnapshot> {
  try {
    const { scene, revision } = await readSnapshot(await scenePath(path));
    return { scene, revision };
  } catch (error) { throw ioFailure(error, path); }
}

async function withLock<T>(path: string, action: (target: string) => Promise<T>): Promise<T> {
  let lock: FileHandle | undefined;
  let lockPath: string | undefined;
  try {
    const target = await scenePath(path);
    lockPath = `${target}.strata-lock`;
    try { lock = await open(lockPath, 'wx', 0o600); } catch (error) {
      if (errno(error) === 'EEXIST') throw failure('FILE_BUSY', target,
        'A scene writer lock already exists.',
        `Retry after the other writer completes. If it crashed, confirm its PID is no longer active before manually removing ${lockPath}.`);
      throw error;
    }
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, target, startedAt: new Date().toISOString() })}\n`);
    return await action(target);
  } catch (error) { throw ioFailure(error, path); }
  finally {
    // Cleanup must never mask the original error or turn a committed write into a reported failure.
    await lock?.close().catch(() => undefined);
    if (lock && lockPath) await unlink(lockPath).catch(() => undefined);
  }
}

async function writeTemporary(target: string, text: string, mode: number, preserveMode = false): Promise<string> {
  if (Buffer.byteLength(text, 'utf8') > MAX_SCENE_FILE_BYTES) throw failure('FILE_TOO_LARGE', target,
    `Serialized scene exceeds ${MAX_SCENE_FILE_BYTES} bytes.`, 'Split the authoring data into smaller scene documents.');
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(text, 'utf8');
    // open() applies the process umask. An existing scene's permission bits must
    // survive replacement even when this writer has a more restrictive umask.
    if (preserveMode) await handle.chmod(mode);
    await handle.sync();
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally { await handle.close(); }
  return temporary;
}

/** Create exclusively; another process creating the target can never be overwritten. */
export async function createSceneFile(path: string, scene: SceneDocument): Promise<SceneSnapshot> {
  const text = serializeScene(scene);
  const revision = sceneRevision(scene);
  return withLock(path, async target => {
    try {
      await lstat(target);
      throw failure('FILE_EXISTS', target, 'Scene file already exists.', 'Choose a new path or edit the existing scene using its current revision.');
    } catch (error) { if (errno(error) !== 'ENOENT') throw error; }
    const temporary = await writeTemporary(target, text, 0o600);
    try {
      // Hard-link publication is exclusive and atomic on the same local filesystem.
      await link(temporary, target);
    } catch (error) {
      if (errno(error) === 'EEXIST') throw failure('FILE_EXISTS', target, 'Scene file already exists.', 'Read its current revision before editing it.');
      throw error;
    } finally { await unlink(temporary).catch(() => undefined); }
    return { scene: JSON.parse(text) as SceneDocument, revision };
  });
}

function preview(scene: SceneDocument, batch: SceneBatch): EditPreview {
  const result = applySceneBatch(scene, batch);
  if (!result.ok) throw new AuthoringError(result.diagnostics);
  return result.value;
}

/** Preview is read-only. A later apply still checks expectedRevision under the writer lock. */
export async function previewSceneFile(path: string, batch: SceneBatch): Promise<EditPreview> {
  try {
    const { scene } = await readSceneFile(path);
    return preview(scene, batch);
  } catch (error) { throw ioFailure(error, path); }
}

/** Atomic batches among cooperating CLI/API writers; external editors must coordinate separately. */
export async function editSceneFile(path: string, batch: SceneBatch): Promise<EditPreview> {
  return withLock(path, async target => {
    const original = await readSnapshot(target);
    const result = preview(original.scene, batch);
    if (!result.changed) return result;
    const temporary = await writeTemporary(target, serializeScene(result.scene), original.mode, true);
    try {
      // Detect even whitespace-only external writes observed during preparation. An unrelated
      // writer ignoring our lock could still race after this check; this is not a filesystem CAS.
      const current = await readSnapshot(target);
      if (current.text !== original.text) throw failure('SCENE_STALE', target,
        'Scene bytes changed while the edit was being prepared.', 'Reload the file and review a fresh batch before retrying.');
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => undefined); }
    return result;
  });
}

export interface AssetCheckOptions { scenePath: string; assetRoot?: string }

/** Checks existence only. Never reads asset contents, follows network URLs, imports, or copies. */
export async function validateSceneAssets(scene: SceneDocument, options: AssetCheckOptions): Promise<Result<{ checked: number }>> {
  const validated = validateScene(scene);
  if (!validated.ok) return validated;
  try {
    canonicalJson(options);
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['scenePath', 'assetRoot'].includes(key))
      || typeof options.scenePath !== 'string' || options.scenePath.length === 0
      || (options.assetRoot !== undefined && (typeof options.assetRoot !== 'string' || options.assetRoot.length === 0))) {
      throw new Error('Invalid asset check options.');
    }
  } catch {
    return { ok: false, diagnostics: [{ code: 'INVALID_OPTIONS', path: '', message: 'Asset check options are invalid.',
      suggestion: 'Supply a nonempty scenePath string and an optional nonempty assetRoot string.' }] };
  }
  const external = scene.assets.filter(asset => asset.kind === 'external');
  if (external.length === 0) return { ok: true, value: { checked: 0 } };
  let root: string;
  try {
    root = await realpath(resolve(options.assetRoot ?? process.env.STRATA_BENCHMARK_ASSET_DIR ?? dirname(resolve(options.scenePath))));
    if (!(await stat(root)).isDirectory()) throw new Error('Asset root is not a directory.');
  } catch (error) {
    return { ok: false, diagnostics: [{
      code: 'ASSET_ROOT_MISSING', path: '/assets', source: options.scenePath,
      message: error instanceof Error ? error.message : 'Cannot resolve asset root.',
      suggestion: 'Set --asset-root or STRATA_BENCHMARK_ASSET_DIR to an existing external directory.',
    }] };
  }
  const diagnostics: Diagnostic[] = [];
  let checked = 0;
  for (const [index, asset] of scene.assets.entries()) {
    if (asset.kind !== 'external') continue;
    const context = { path: `/assets/${index}/uri`, assetId: asset.id, source: options.scenePath };
    let uri: string;
    try { uri = decodeURIComponent(asset.uri); } catch {
      diagnostics.push({ ...context, code: 'ASSET_URI_UNSUPPORTED', message: 'Asset URI contains invalid percent encoding.',
        suggestion: 'Use a relative URI path with valid percent escapes.' });
      continue;
    }
    if (/[?#]/.test(asset.uri) || /[\\\u0000-\u001f]/.test(uri) || isAbsolute(uri) || /^[a-z][a-z0-9+.-]*:/i.test(uri)) {
      diagnostics.push({ ...context, code: 'ASSET_URI_UNSUPPORTED', message: 'Local existence checks require a relative URI path.',
        suggestion: 'Keep the asset external; set its directory as --asset-root and reference a file below it. Network URIs are not fetched.' });
      continue;
    }
    try {
      const requested = resolve(root, uri);
      const requestedRelative = relative(root, requested);
      if (requestedRelative === '..' || requestedRelative.startsWith(`..${sep}`) || isAbsolute(requestedRelative)) {
        diagnostics.push({ ...context, code: 'ASSET_OUTSIDE_ROOT', message: 'Asset reference escapes the selected asset root.',
          suggestion: 'Select the intended external root and keep relative references within it.' });
        continue;
      }
      const assetPath = await realpath(requested);
      const withinRoot = relative(root, assetPath);
      if (withinRoot === '..' || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) {
        diagnostics.push({ ...context, code: 'ASSET_OUTSIDE_ROOT', message: 'Asset reference resolves outside the selected asset root.',
          suggestion: 'Select the intended external root and keep references, including symlinks, within it.' });
      } else if (!(await stat(assetPath)).isFile()) {
        diagnostics.push({ ...context, code: 'ASSET_NOT_FILE', message: 'Asset reference does not identify a regular file.',
          suggestion: 'Reference the file entry point below the selected external root.' });
      } else checked++;
    } catch (error) {
      diagnostics.push({ ...context, code: errno(error) === 'ENOENT' ? 'ASSET_MISSING' : 'ASSET_IO_ERROR',
        message: `Cannot resolve asset ${asset.id}: ${error instanceof Error ? error.message : 'filesystem error'}`,
        suggestion: 'Correct the URI or external asset root. This command never fetches or copies missing assets.' });
    }
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, value: { checked } };
}
