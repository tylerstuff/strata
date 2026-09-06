import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { PreviewError } from './errors.js';
import type { ProjectOutputFile } from './project-types.js';

/** Packaging bounds, independent of Core's renderable scene/device limits. */
export const PROJECT_DISTRIBUTION_LIMITS = Object.freeze({ files: 1024, directories: 1024, fileBytes: 16 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, depth: 16 });
export interface ProjectFileSnapshot { path: string; contents: Uint8Array }
export interface ProjectOutputIo {
  openFile(path: string): Promise<{ writeFile(data: Uint8Array): Promise<void>; sync(): Promise<void>; close(): Promise<void>; stat?(): Promise<BigIntStats> }>;
  publishCompletion(temporary: string, target: string): Promise<void>;
  removeFile(path: string): Promise<void>;
}
const nativeIo: ProjectOutputIo = { openFile: async path => {
  const handle = await open(path, 'wx', 0o600);
  return { writeFile: data => handle.writeFile(data), sync: () => handle.sync(), close: () => handle.close(), stat: () => handle.stat({ bigint: true }) };
}, publishCompletion: link, removeFile: unlink };
export const projectFileMetadata = ({ path, contents }: ProjectFileSnapshot): ProjectOutputFile => ({
  path, bytes: contents.byteLength, sha256: createHash('sha256').update(contents).digest('hex'),
});
const code = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function projectAbort(signal: AbortSignal | undefined, stage: string): void {
  if (signal?.aborted) throw new PreviewError('PROJECT_ABORTED', stage, 'Project operation was canceled before publication.');
}
function invalid(description: string): never { throw new PreviewError('PROJECT_RUNTIME_DISTRIBUTION_INVALID', 'snapshot-runtime', description); }
const sameNode = (before: BigIntStats, after: BigIntStats) => before.dev === after.dev && before.ino === after.ino;
const sameFile = (before: BigIntStats, after: BigIntStats) => sameNode(before, after) && after.isFile() && !after.isSymbolicLink()
  && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
interface FileRead { contents: Buffer; identity: BigIntStats }

async function readFileSnapshot(path: string, maxBytes: number, signal?: AbortSignal): Promise<FileRead> {
  projectAbort(signal, 'read-file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) invalid(`Expected a bounded regular file: ${path}`);
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      projectAbort(signal, 'read-file');
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - length + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      projectAbort(signal, 'read-file');
      if (!bytesRead) break;
      length += bytesRead;
      if (length > maxBytes) invalid(`File exceeded its byte limit: ${path}`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true }), current = await lstat(path, { bigint: true });
    if (!sameFile(before, after) || !sameFile(after, current) || BigInt(length) !== after.size) invalid(`File changed while being snapshotted: ${path}`);
    projectAbort(signal, 'read-file');
    return { contents: Buffer.concat(chunks, length), identity: after };
  } finally { await handle.close(); }
}

export async function readProjectFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  return (await readFileSnapshot(path, maxBytes, signal)).contents;
}

/** Private installed-file seam; no workspace or external-archive fallback. */
export async function snapshotRuntimeDistribution(packagePath: string, expectedVersion: string, signal?: AbortSignal): Promise<{
  version: string; files: ProjectFileSnapshot[];
}> {
  try {
    const manifestFile = await readFileSnapshot(packagePath, 64 * 1024, signal);
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestFile.contents)) as { name?: unknown; version?: unknown };
    if (manifest.name !== '@strata-engine/core' || manifest.version !== expectedVersion) invalid('Installed Core does not match the preview package runtime dependency.');
    const requestedRoot = dirname(packagePath), root = await realpath(requestedRoot), directory = join(root, 'dist');
    const rootIdentity = await lstat(root, { bigint: true });
    const directories = new Map<string, { identity: BigIntStats; inventory: string[] }>();
    const identities = new Map<string, BigIntStats>();
    const files: ProjectFileSnapshot[] = [];
    let total = 0;
    async function walk(relative: string, depth: number): Promise<void> {
      projectAbort(signal, 'snapshot-runtime');
      if (depth > PROJECT_DISTRIBUTION_LIMITS.depth) invalid('Core dist exceeded its directory-depth limit.');
      if (directories.size >= PROJECT_DISTRIBUTION_LIMITS.directories) invalid('Core dist exceeded its directory-count limit.');
      const folder = join(directory, relative), identity = await lstat(folder, { bigint: true });
      if (!identity.isDirectory() || identity.isSymbolicLink() || await realpath(folder) !== folder) invalid(`Core dist contains a redirected directory: ${relative}`);
      const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      directories.set(folder, { identity, inventory: entries.map(item => `${item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'other'}:${item.name}`) });
      for (const item of entries) {
        projectAbort(signal, 'snapshot-runtime');
        const path = relative ? `${relative}/${item.name}` : item.name;
        if (item.isDirectory()) { await walk(path, depth + 1); continue; }
        if (!item.isFile()) invalid(`Core dist contains a link or non-file: ${path}`);
        if (files.length >= PROJECT_DISTRIBUTION_LIMITS.files) invalid('Core dist exceeded its file-count limit.');
        const snapshot = await readFileSnapshot(join(directory, path), PROJECT_DISTRIBUTION_LIMITS.fileBytes, signal), contents = snapshot.contents;
        total += contents.length;
        if (total > PROJECT_DISTRIBUTION_LIMITS.totalBytes) invalid('Core dist exceeded its total byte limit.');
        files.push({ path, contents });
        identities.set(join(directory, path), snapshot.identity);
      }
    }
    await walk('', 0);
    for (const required of ['index.js', 'worker.js', 'strata_runtime.wasm']) if (!files.some(file => file.path === required)) invalid(`Core dist is missing ${required}.`);
    const wasm = files.find(file => file.path === 'strata_runtime.wasm')!;
    if (!Buffer.from(wasm.contents).subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) invalid('Core must ship precompiled WASM.');
    // Detect observed rebuilds/redirects across the entire bounded walk, including
    // files read early and new entries added to already visited directories.
    if (await realpath(requestedRoot) !== root || !sameNode(rootIdentity, await lstat(root, { bigint: true }))) invalid('Installed Core root changed during snapshot.');
    for (const [folder, before] of directories) {
      projectAbort(signal, 'snapshot-runtime');
      const after = await lstat(folder, { bigint: true });
      if (!after.isDirectory() || after.isSymbolicLink() || !sameNode(before.identity, after) || await realpath(folder) !== folder) invalid(`Core directory changed during snapshot: ${folder}`);
      const inventory = (await readdir(folder, { withFileTypes: true })).map(item => `${item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'other'}:${item.name}`).sort();
      if (JSON.stringify(inventory) !== JSON.stringify([...before.inventory].sort())) invalid(`Core inventory changed during snapshot: ${folder}`);
    }
    for (const [path, before] of [[packagePath, manifestFile.identity] as const, ...identities]) {
      projectAbort(signal, 'snapshot-runtime');
      if (!sameFile(before, await lstat(path, { bigint: true }))) invalid(`Core file changed during snapshot: ${path}`);
    }
    projectAbort(signal, 'snapshot-runtime');
    return { version: expectedVersion, files };
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError('PROJECT_RUNTIME_DISTRIBUTION_INVALID', 'snapshot-runtime', `Cannot snapshot installed Core: ${message(error)}`);
  }
}

export async function readProjectClient(path: string, signal?: AbortSignal): Promise<Buffer> {
  try {
    const bytes = await readProjectFile(path, 256 * 1024, signal);
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const imports = [...source.matchAll(/\b(?:import|export)\s+(?:[^;'"\n]*?\s+from\s*)?['"]([^'"]+)['"]/g)].map(match => match[1]);
    if (imports.length !== 1 || imports[0] !== '@strata-engine/core'
      || /\bimport\s*\(|\brequire\s*\(|node:|@strata-engine\/(?:authoring|preview)|playwright/.test(source)) invalid('Project browser entry must import Core alone.');
    return bytes;
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError('PROJECT_RUNTIME_DISTRIBUTION_INVALID', 'snapshot-client', `Build the preview package before project delivery: ${message(error)}`);
  }
}

/**
 * Reserve a fresh directory; closed/verified completion bytes are linked last.
 * Await actual I/O and owned cleanup on cancellation. A successful publication
 * wins a late abort. Recheck owned identities before publication and cleanup;
 * mismatched entries survive. Roots must cooperate with the operation: these
 * checks do not make a hostile final-check/syscall race a filesystem sandbox.
 */
export async function publishProjectDirectory<T>(options: {
  directory: string; files: readonly ProjectFileSnapshot[]; completionName: string; completion: Uint8Array;
  prepareResult: (temporaryCompletion: string, destination: string) => Promise<T>; signal?: AbortSignal;
}, overrides: Partial<ProjectOutputIo> = {}): Promise<{ value: T; directory: string; completionPath: string; cleanupWarnings: string[] }> {
  const { directory: requested, completionName, prepareResult, signal } = options;
  const files = options.files.map(file => ({ path: file.path, contents: Buffer.from(file.contents) }));
  const completion = Buffer.from(options.completion), io = { ...nativeIo, ...overrides };
  const ownedFiles = new Map<string, { identity: BigIntStats; verified?: BigIntStats }>();
  const ownedDirectories = new Map<string, BigIntStats>(), unclosedHandles: string[] = [];
  const unverifiedEntries = new Set<string>();
  let directory = '', completionPath = '', temporary = '', published = false, stage = 'reserve-output';
  let parent = '', requestedParent = '', parentIdentity: BigIntStats | undefined;
  const safe = (path: string) => path.length > 0 && !path.split('/').some(part => !part || part === '.' || part === '..') && !/[\\\u0000-\u001f]/.test(path);
  if (!safe(completionName) || completionName.includes('/') || files.some(file => !safe(file.path))
    || new Set(files.map(file => file.path)).size !== files.length || files.some(file => file.path === completionName)) {
    throw new PreviewError('PROJECT_INVALID_OPTIONS', stage, 'Output filenames must be unique local paths.');
  }
  function changed(path: string): never {
    throw new PreviewError('PROJECT_OUTPUT_CHANGED', 'verify-output', `Output ownership or closed bytes changed: ${path}`, { path });
  }
  async function verifyParents(path: string): Promise<void> {
    if (!parentIdentity || await realpath(requestedParent) !== parent) changed(parent);
    const currentParent = await lstat(parent, { bigint: true });
    if (!currentParent.isDirectory() || currentParent.isSymbolicLink() || !sameNode(parentIdentity, currentParent)) changed(parent);
    const containing = dirname(path);
    for (const [folder, identity] of ownedDirectories) {
      if (containing !== folder && !containing.startsWith(`${folder}/`)) continue;
      const current = await lstat(folder, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !sameNode(identity, current)) changed(folder);
    }
  }
  async function verifyFile(path: string, closed = false): Promise<BigIntStats> {
    await verifyParents(path);
    const expected = ownedFiles.get(path), current = await lstat(path, { bigint: true });
    if (!expected || !current.isFile() || current.isSymbolicLink() || !sameNode(expected.identity, current)
      || closed && (!expected.verified || !sameFile(expected.verified, current))) changed(path);
    return current;
  }
  async function reserveDirectory(path: string): Promise<void> {
    await verifyParents(path);
    await mkdir(path, { mode: 0o700 });
    unverifiedEntries.add(path);
    const identity = await lstat(path, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink()) changed(path);
    ownedDirectories.set(path, identity); unverifiedEntries.delete(path);
  }
  async function write(path: string, bytes: Uint8Array): Promise<void> {
    projectAbort(signal, stage);
    await verifyParents(path);
    const handle = await io.openFile(path);
    unverifiedEntries.add(path);
    let failure: unknown, failed = false;
    try {
      // Production captures the opened descriptor's identity. The fallback keeps
      // the narrow injected I/O seam compatible with existing file-handle tests.
      const identity = handle.stat ? await handle.stat() : await lstat(path, { bigint: true });
      ownedFiles.set(path, { identity }); unverifiedEntries.delete(path);
      await verifyFile(path);
      projectAbort(signal, stage); await handle.writeFile(bytes); await handle.sync();
    }
    catch (error) { failure = error; failed = true; }
    try { await handle.close(); }
    catch (error) {
      if (!failed) { failure = error; failed = true; }
      try { await handle.close(); } catch (second) { unclosedHandles.push(`${path}: ${message(second)}`); }
    }
    if (failed) throw failure;
    projectAbort(signal, stage);
    await verifyFile(path);
    const verified = await readFileSnapshot(path, bytes.byteLength, signal);
    if (!sameNode(ownedFiles.get(path)!.identity, verified.identity)) changed(path);
    if (!verified.contents.equals(Buffer.from(bytes))) throw new PreviewError('PROJECT_OUTPUT_IO', 'verify-output', `Closed output bytes differ: ${path}`);
    ownedFiles.get(path)!.verified = verified.identity;
    await verifyFile(path, true);
  }
  async function removeFile(path: string): Promise<string | undefined> {
    // A missing leaf is safe to forget only after its containing directories
    // were verified. Never treat a missing/replaced ancestor as owned cleanup.
    try { await verifyParents(path); } catch (error) { return `${path}: ${message(error)}`; }
    try {
      const current = await lstat(path, { bigint: true }), expected = ownedFiles.get(path);
      if (!expected || !current.isFile() || current.isSymbolicLink() || !sameNode(expected.identity, current)) changed(path);
      await io.removeFile(path); ownedFiles.delete(path);
    } catch (error) { if (code(error) === 'ENOENT') ownedFiles.delete(path); else return `${path}: ${message(error)}`; }
    return undefined;
  }
  try {
    projectAbort(signal, stage);
    const absolute = resolve(requested); requestedParent = dirname(absolute); parent = await realpath(requestedParent);
    parentIdentity = await lstat(parent, { bigint: true });
    if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()) changed(parent);
    directory = join(parent, basename(absolute)); completionPath = join(directory, completionName);
    await reserveDirectory(directory);
    for (const file of files) {
      stage = 'write-output';
      let folder = directory;
      for (const part of file.path.split('/').slice(0, -1)) {
        folder = join(folder, part);
        if (!ownedDirectories.has(folder)) await reserveDirectory(folder);
      }
      await write(join(directory, file.path), file.contents);
    }
    stage = 'stage-completion'; temporary = join(directory, `.${completionName}.${randomUUID()}.tmp`);
    await write(temporary, completion);
    const value = await prepareResult(temporary, completionPath);
    for (const path of ownedFiles.keys()) { projectAbort(signal, 'publish-output'); await verifyFile(path, true); }
    projectAbort(signal, 'publish-output'); stage = 'publish-output';
    await io.publishCompletion(temporary, completionPath); published = true;
    const warning = await removeFile(temporary);
    return { value, directory, completionPath, cleanupWarnings: warning ? [warning] : [] };
  } catch (error) {
    const cleanupErrors = [...unverifiedEntries].map(path => `${path}: Ownership could not be verified; entry preserved.`);
    for (const path of ownedFiles.keys()) { const warning = await removeFile(path); if (warning) cleanupErrors.push(warning); }
    if (!published) for (const [path, identity] of [...ownedDirectories].reverse()) {
      try { await verifyParents(path); } catch (cleanup) { cleanupErrors.push(`${path}: ${message(cleanup)}`); continue; }
      try {
        const current = await lstat(path, { bigint: true });
        if (!current.isDirectory() || current.isSymbolicLink() || !sameNode(identity, current)) changed(path);
        await rmdir(path); ownedDirectories.delete(path);
      } catch (cleanup) { if (code(cleanup) === 'ENOENT') ownedDirectories.delete(path); else cleanupErrors.push(`${path}: ${message(cleanup)}`); }
    }
    const details = { ...(error instanceof PreviewError ? error.details : {}), publicationOccurred: published,
      outputDirectory: directory || resolve(requested), completionPath: completionPath || null,
      incompleteArtifacts: [...ownedFiles.keys(), ...(!published ? ownedDirectories.keys() : []), ...unverifiedEntries], cleanupErrors, unclosedHandles };
    throw new PreviewError(error instanceof PreviewError ? error.code : code(error) === 'EEXIST' ? 'PROJECT_OUTPUT_EXISTS' : 'PROJECT_OUTPUT_IO',
      error instanceof PreviewError ? error.stage : stage, message(error), details);
  }
}
