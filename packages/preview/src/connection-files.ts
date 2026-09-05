import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AuthoringError, readSceneFile, type SceneSnapshot } from '@strata-engine/authoring';
import { PreviewError } from './errors.js';

export interface ConnectionRoots {
  readonly projectRoot: string;
  readonly outputRoot: string;
  readScene(scenePath: string, signal?: AbortSignal): Promise<SceneSnapshot>;
  verifyOutput(): Promise<void>;
}

interface DirectoryIdentity {
  path: string;
  kind: 'project' | 'output';
  dev: bigint;
  ino: bigint;
}

interface PathIdentity { path: string; dev: bigint; ino: bigint }

function aborted(signal: AbortSignal | undefined, source: string): void {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new PreviewError('CONNECTION_SCENE_INPUT', 'read-scene', 'Expected an AbortSignal.', { source });
  }
  if (signal?.aborted) {
    throw new PreviewError('PREVIEW_ABORTED', 'read-scene', 'Scene input was canceled.', { source });
  }
}

function inputError(error: unknown, source: string): PreviewError {
  if (error instanceof PreviewError) return error;
  return new PreviewError('CONNECTION_SCENE_INPUT', 'read-scene',
    error instanceof Error ? error.message : 'Cannot read the selected scene file.', {
      source,
      ...(error instanceof AuthoringError
        ? { diagnostics: error.diagnostics.map(diagnostic => ({ ...diagnostic, source: diagnostic.source ?? source })) }
        : {}),
    });
}

async function directory(input: string, kind: DirectoryIdentity['kind']): Promise<DirectoryIdentity> {
  try {
    if (typeof input !== 'string' || input.length === 0 || /[\u0000-\u001f\u007f-\u009f]/.test(input)) {
      throw new Error('Supply a nonempty existing directory path.');
    }
    // Explicit startup aliases are resolved once; subsequent access uses this fixed path.
    const path = await realpath(resolve(input));
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The selected root must be a directory.');
    return { path, kind, dev: info.dev, ino: info.ino };
  } catch (error) {
    throw new PreviewError('CONNECTION_ROOT_INVALID', 'connection-roots',
      error instanceof Error ? error.message : 'Cannot open the selected root.',
      { root: kind, ...(typeof input === 'string' ? { source: input } : {}) });
  }
}

async function verify(root: DirectoryIdentity): Promise<void> {
  try {
    const path = await realpath(root.path);
    const info = await lstat(root.path, { bigint: true });
    if (path !== root.path || info.isSymbolicLink() || !info.isDirectory()
      || info.dev !== root.dev || info.ino !== root.ino) {
      throw new Error('Root directory identity changed.');
    }
  } catch {
    throw new PreviewError('CONNECTION_ROOT_CHANGED', 'connection-roots',
      'The selected root was removed, replaced, renamed, or redirected. Start a new connection with the intended roots.',
      { root: root.kind, source: root.path });
  }
}

function sceneFile(root: string, input: string): string {
  if (typeof input !== 'string' || input.length === 0 || Buffer.byteLength(input, 'utf8') > 4096
    || isAbsolute(input) || /[\\\u0000-\u001f\u007f-\u009f]/.test(input)
    || /^[a-z][a-z0-9+.-]*:/i.test(input) || input.split('/').includes('..')) {
    throw new PreviewError('CONNECTION_SCENE_PATH', 'read-scene',
      'Use a nonempty project-relative scene path of at most 4096 UTF-8 bytes, without traversal, schemes, backslashes or control characters.');
  }
  const path = resolve(root, input);
  const child = relative(root, path);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new PreviewError('CONNECTION_SCENE_PATH', 'read-scene', 'Scene files must be below the selected project root.', { source: input });
  }
  return path;
}

async function inspectPath(root: string, file: string): Promise<PathIdentity[]> {
  const components = relative(root, file).split(sep);
  const identities: PathIdentity[] = [];
  let path = root;
  for (const [index, component] of components.entries()) {
    path = join(path, component);
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink()) {
      throw new PreviewError('CONNECTION_SCENE_PATH', 'read-scene',
        'Scene path components and leaves must not be symbolic links.', { source: file, component: path });
    }
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new PreviewError('CONNECTION_SCENE_PATH', 'read-scene',
        'Every scene path parent must be a directory.', { source: file, component: path });
    }
    identities.push({ path, dev: info.dev, ino: info.ino });
  }
  if (await realpath(file) !== file) {
    throw new PreviewError('CONNECTION_SCENE_PATH', 'read-scene',
      'Scene path resolves outside its checked canonical location.', { source: file });
  }
  return identities;
}

/**
 * Fixed roots for a cooperating local project, not an OS sandbox against hostile
 * concurrent directory replacement. No scene or asset contents are written.
 */
export async function createConnectionRoots(projectRoot: string, outputRoot: string): Promise<ConnectionRoots> {
  const project = await directory(projectRoot, 'project');
  const output = await directory(outputRoot, 'output');
  async function verifyRoots(): Promise<void> { await verify(project); await verify(output); }
  await verifyRoots();
  return Object.freeze({
    projectRoot: project.path,
    outputRoot: output.path,
    async readScene(scenePath: string, signal?: AbortSignal): Promise<SceneSnapshot> {
      aborted(signal, typeof scenePath === 'string' ? scenePath : project.path);
      const file = sceneFile(project.path, scenePath);
      let result: SceneSnapshot | undefined;
      let failure: PreviewError | undefined;
      try {
        await verifyRoots();
        aborted(signal, file);
        const before = await inspectPath(project.path, file);
        aborted(signal, file);
        // Authoring owns byte bounds, regular/single-link checks, UTF-8, schema and revision.
        result = await readSceneFile(file);
        aborted(signal, file);
        const after = await inspectPath(project.path, file);
        if (before.some((entry, index) => entry.dev !== after[index]?.dev || entry.ino !== after[index]?.ino)) {
          throw new PreviewError('CONNECTION_SCENE_INPUT', 'read-scene',
            'Scene path changed while it was being read. Read the reviewed file again.', { source: file });
        }
      } catch (error) { failure = inputError(error, file); }
      // Root replacement remains a connection fault even if scene reading also failed.
      await verifyRoots();
      aborted(signal, file);
      if (failure) throw failure;
      return result!;
    },
    async verifyOutput(): Promise<void> { await verifyRoots(); },
  });
}
