import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { publishProjectDirectory, snapshotRuntimeDistribution } from '../src/project-output.js';

// Intercept only the timing of a real file open. All fixture reads, writes,
// metadata and replacements below use the OS filesystem; no renderer executes.
const hooks = vi.hoisted(() => ({ beforeOpen: undefined as ((path: string) => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    await hooks.beforeOpen?.(String(args[0]));
    return actual.open(...args);
  } };
});

let directory: string;
beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'strata-project-output-ownership-'))); });
afterEach(async () => { hooks.beforeOpen = undefined; await rm(directory, { recursive: true, force: true }); });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
};
const completion = Buffer.from('{"complete":true}\n');
const files = [{ path: 'runtime/app.js', contents: Buffer.from('export const original = true;\n') }];

async function pausedOutput(parent = directory) {
  const entered = deferred(), release = deferred();
  let temporary = '';
  const outputDirectory = join(parent, 'delivery');
  const pending = publishProjectDirectory({ directory: outputDirectory, files, completionName: 'receipt.json', completion,
    prepareResult: async path => { temporary = path; entered.resolve(); await release.promise; return { complete: true }; },
  });
  await entered.promise;
  return { pending, outputDirectory, temporary, release: release.resolve };
}

describe('CPU-only output ownership across awaited filesystem work', () => {
  test('closes an opened handle and reports its preserved path when ownership metadata cannot be acquired', async () => {
    const outputDirectory = join(directory, 'delivery');
    let closed = false;
    const failure = Object.assign(new Error('Generated metadata read failure'), { code: 'EIO' });
    await expect(publishProjectDirectory({ directory: outputDirectory, files, completionName: 'receipt.json', completion,
      prepareResult: async () => { throw new Error('Unverified output must not be published'); },
    }, { openFile: async path => {
      const handle = await open(path, 'wx', 0o600);
      return { stat: async () => { throw failure; }, writeFile: data => handle.writeFile(data), sync: () => handle.sync(),
        close: async () => { await handle.close(); closed = true; } };
    } })).rejects.toMatchObject({ code: 'PROJECT_OUTPUT_IO', message: failure.message, details: { publicationOccurred: false,
      incompleteArtifacts: expect.arrayContaining([join(outputDirectory, 'runtime/app.js')]),
      cleanupErrors: expect.arrayContaining([expect.stringContaining('Ownership could not be verified')]), unclosedHandles: [] } });
    expect(closed).toBe(true);
    expect(await readFile(join(outputDirectory, 'runtime/app.js'))).toHaveLength(0);
    await expect(readFile(join(outputDirectory, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('preserves a leaf replacement made while the original file handle is syncing', async () => {
    const entered = deferred(), release = deferred(), outputDirectory = join(directory, 'delivery');
    let openedPath = '';
    const pending = publishProjectDirectory({ directory: outputDirectory, files, completionName: 'receipt.json', completion,
      prepareResult: async () => { throw new Error('Replacement must be detected before preparing a result'); },
    }, { openFile: async path => {
      const handle = await open(path, 'wx', 0o600);
      return { stat: () => handle.stat({ bigint: true }), writeFile: data => handle.writeFile(data), close: () => handle.close(),
        sync: async () => { openedPath = path; entered.resolve(); await release.promise; await handle.sync(); } };
    } });
    await entered.promise;
    const original = join(directory, 'moved-original.js');
    try { await rename(openedPath, original); await writeFile(openedPath, 'unrelated replacement'); }
    finally { release.resolve(); }
    await expect(pending).rejects.toMatchObject({ code: 'PROJECT_OUTPUT_CHANGED', details: { publicationOccurred: false,
      incompleteArtifacts: expect.arrayContaining([openedPath, outputDirectory]), cleanupErrors: expect.any(Array) } });
    expect(await readFile(openedPath, 'utf8')).toBe('unrelated replacement');
    expect(await readFile(original)).toEqual(files[0]!.contents);
    await expect(readFile(join(outputDirectory, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('refuses to publish or remove a substituted staged completion file', async () => {
    const output = await pausedOutput(), original = join(directory, 'original-receipt.json');
    try { await rename(output.temporary, original); await writeFile(output.temporary, 'unrelated completion source'); }
    finally { output.release(); }
    await expect(output.pending).rejects.toMatchObject({ code: 'PROJECT_OUTPUT_CHANGED', details: { publicationOccurred: false,
      incompleteArtifacts: expect.arrayContaining([output.temporary]), cleanupErrors: expect.any(Array) } });
    expect(await readFile(output.temporary, 'utf8')).toBe('unrelated completion source');
    expect(await readFile(original)).toEqual(completion);
    expect(await readdir(output.outputDirectory)).toEqual([basename(output.temporary)]);
  });

  test('preserves a replaced owned subdirectory and its unrelated matching filenames', async () => {
    const output = await pausedOutput(), nested = join(output.outputDirectory, 'runtime'), original = join(directory, 'original-runtime');
    try { await rename(nested, original); await mkdir(nested); await writeFile(join(nested, 'app.js'), 'unrelated runtime'); }
    finally { output.release(); }
    await expect(output.pending).rejects.toMatchObject({ code: 'PROJECT_OUTPUT_CHANGED', details: { publicationOccurred: false,
      incompleteArtifacts: expect.arrayContaining([nested, join(nested, 'app.js')]), cleanupErrors: expect.any(Array) } });
    expect(await readFile(join(nested, 'app.js'), 'utf8')).toBe('unrelated runtime');
    expect(await readFile(join(original, 'app.js'))).toEqual(files[0]!.contents);
    await expect(readFile(join(output.outputDirectory, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('does not traverse a substituted output parent during publication or cleanup', async () => {
    const parent = join(directory, 'parent'); await mkdir(parent);
    const output = await pausedOutput(parent), original = join(directory, 'original-parent');
    try {
      await rename(parent, original); await mkdir(join(output.outputDirectory, 'runtime'), { recursive: true });
      await writeFile(join(output.outputDirectory, 'runtime/app.js'), 'unrelated parent contents');
      await writeFile(output.temporary, 'unrelated staged receipt');
    } finally { output.release(); }
    await expect(output.pending).rejects.toMatchObject({ code: 'PROJECT_OUTPUT_CHANGED', details: { publicationOccurred: false,
      incompleteArtifacts: expect.arrayContaining([output.outputDirectory, output.temporary]), cleanupErrors: expect.any(Array) } });
    expect(await readFile(join(output.outputDirectory, 'runtime/app.js'), 'utf8')).toBe('unrelated parent contents');
    expect(await readFile(output.temporary, 'utf8')).toBe('unrelated staged receipt');
    expect(await readFile(join(original, 'delivery', basename(output.temporary)))).toEqual(completion);
    await expect(readFile(join(output.outputDirectory, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('retains known publication success and warns instead of deleting a later temporary-file replacement', async () => {
    let temporary = '';
    const result = await publishProjectDirectory({ directory: join(directory, 'delivery'), files,
      completionName: 'receipt.json', completion, prepareResult: async () => ({ complete: true }),
    }, { publishCompletion: async (source, target) => {
      await link(source, target); temporary = source;
      await rename(source, join(directory, 'original-linked-receipt'));
      await writeFile(source, 'unrelated postpublication replacement');
    } });
    expect(result.value).toEqual({ complete: true });
    expect(result.cleanupWarnings).toHaveLength(1);
    expect(result.cleanupWarnings[0]).toContain('ownership');
    expect(await readFile(result.completionPath)).toEqual(completion);
    expect(await readFile(temporary, 'utf8')).toBe('unrelated postpublication replacement');
    expect(await readFile(join(result.directory, 'runtime/app.js'))).toEqual(files[0]!.contents);
  });
});

describe('CPU-only complete runtime distribution snapshot', () => {
  test.each(['earlier-file', 'new-entry'] as const)('rejects an observed %s mutation after that directory was read', async mutation => {
    const root = join(directory, 'generated-core'), dist = join(root, 'dist');
    await mkdir(dist, { recursive: true });
    const manifest = join(root, 'package.json');
    await writeFile(manifest, JSON.stringify({ name: '@strata-engine/core', version: '0.0.0' }));
    await writeFile(join(dist, 'index.js'), 'export const original = true;\n');
    await writeFile(join(dist, 'strata_runtime.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    await writeFile(join(dist, 'worker.js'), '// generated CPU fixture\n');
    let changed = false;
    hooks.beforeOpen = async path => {
      // Lexically last file: index.js and the root inventory are already read.
      if (path !== join(dist, 'worker.js') || changed) return;
      changed = true;
      if (mutation === 'earlier-file') await writeFile(join(dist, 'index.js'), 'export const newerBuild = true;\n');
      else await writeFile(join(dist, 'new-build-chunk.js'), 'export const newChunk = true;\n');
    };
    await expect(snapshotRuntimeDistribution(manifest, '0.0.0')).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_DISTRIBUTION_INVALID',
      stage: 'snapshot-runtime', message: expect.stringContaining(mutation === 'earlier-file' ? 'file changed' : 'inventory changed') });
    expect(changed).toBe(true);
  });
});
