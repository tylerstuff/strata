import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { canonicalJson } from '@strata-engine/authoring';
import {
  MAX_CAPTURE_PNG_DIMENSION,
  publishCapture,
  type CaptureArtifactIo,
  type CaptureImage,
  type PublishCaptureOptions,
} from '../src/artifacts.js';

// Tiny static procedural correctness fixture, never a benchmark or imported image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');
let outputDirectory: string;
beforeEach(async () => { outputDirectory = await mkdtemp(join(tmpdir(), 'strata-preview-artifacts-')); });
afterEach(async () => { await rm(outputDirectory, { recursive: true, force: true }); });

function options(extra: Partial<PublishCaptureOptions> = {}): PublishCaptureOptions {
  return {
    outputDirectory, captureId: 'capture-1', png: PNG,
    createReceipt: (image) => ({ format: 'test.capture', version: 1, image, metadata: { z: true, a: 'test' } }),
    ...extra,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type WriteHandle = Awaited<ReturnType<CaptureArtifactIo['openFile']>>;
function handleWith(handle: FileHandle, overrides: Partial<WriteHandle>): WriteHandle {
  return {
    writeFile: (data) => handle.writeFile(data), sync: () => handle.sync(), close: () => handle.close(),
    ...overrides,
  };
}

describe('exclusive capture publication', () => {
  test('closes and verifies PNG, publishes a canonical detached receipt, and uses private files', async () => {
    let image: CaptureImage | undefined;
    const callbackResult = { format: 'test.capture', version: 1, extra: { z: 1, a: 2 }, image: undefined as CaptureImage | undefined };
    const result = await publishCapture(options({ createReceipt: (value) => {
      image = value;
      callbackResult.image = value;
      return callbackResult;
    } }));
    const root = await realpath(outputDirectory);
    expect(result.imagePath).toBe(join(root, 'capture-1', 'image.png'));
    expect(result.receiptPath).toBe(join(root, 'capture-1', 'receipt.json'));
    expect(await readFile(result.imagePath)).toEqual(PNG);
    expect(image).toEqual({ relativePath: 'image.png', width: 1, height: 1, bytes: PNG.length, sha256: createHash('sha256').update(PNG).digest('hex') });
    expect(await readFile(result.receiptPath, 'utf8')).toBe(canonicalJson(callbackResult));
    expect((await stat(result.imagePath)).mode & 0o777).toBe(0o600);
    expect((await stat(result.receiptPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(root, 'capture-1'))).toEqual(['image.png', 'receipt.json']);
    expect(result.cleanupWarnings).toEqual([]);
    callbackResult.extra.a = 99;
    expect(result.receipt).toMatchObject({ extra: { a: 2 } });
  });

  test('copies bytes and options synchronously before awaiting filesystem work', async () => {
    const bytes = Uint8Array.from(PNG);
    const input = { ...options(), png: bytes };
    const resultPromise = publishCapture(input);
    bytes.fill(0);
    input.captureId = 'different-capture';
    const result = await resultPromise;
    expect(await readFile(result.imagePath)).toEqual(PNG);
    expect(result.imagePath).toContain('capture-1');
  });

  test('never reuses or cleans a preexisting capture directory', async () => {
    const directory = join(outputDirectory, 'capture-1');
    await mkdir(directory);
    await writeFile(join(directory, 'owned-by-user.txt'), 'preserve');
    await expect(publishCapture(options())).rejects.toMatchObject({ code: 'PREVIEW_OUTPUT_EXISTS', stage: 'reserve-output', details: { publicationOccurred: false, incompleteArtifacts: [] } });
    expect(await readdir(directory)).toEqual(['owned-by-user.txt']);
    expect(await readFile(join(directory, 'owned-by-user.txt'), 'utf8')).toBe('preserve');
  });

  test('permits exactly one concurrent publication for a capture ID', async () => {
    const results = await Promise.allSettled([publishCapture(options()), publishCapture(options())]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.code).toBe('PREVIEW_OUTPUT_EXISTS');
    expect(await readdir(join(outputDirectory, 'capture-1'))).toEqual(['image.png', 'receipt.json']);
  });

  test('does not create a missing output root', async () => {
    await expect(publishCapture(options({ outputDirectory: join(outputDirectory, 'missing') }))).rejects.toMatchObject({ code: 'PREVIEW_ARTIFACT_IO', stage: 'reserve-output' });
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  test.each(['', '.', '..', '../escape', '/absolute', 'id/child', 'id\\child', 'id\n', 'a'.repeat(129)])('rejects unsafe capture ID %j before touching outputs', async (captureId) => {
    await expect(publishCapture(options({ captureId }))).rejects.toMatchObject({ code: 'PREVIEW_ARTIFACT_INVALID', stage: 'prepare-output' });
    expect(await readdir(outputDirectory)).toEqual([]);
  });
});

describe('image and receipt failures', () => {
  test.each(['signature', 'header-length', 'header-type', 'zero-width', 'oversize', 'pixel-budget', 'encoding'])('rejects malformed PNG %s after close and removes its owned outputs', async (kind) => {
    const png = Buffer.from(PNG);
    if (kind === 'signature') png[0] = 0;
    if (kind === 'header-length') png.writeUInt32BE(12, 8);
    if (kind === 'header-type') png.write('IDAT', 12);
    if (kind === 'zero-width') png.writeUInt32BE(0, 16);
    if (kind === 'oversize') png.writeUInt32BE(MAX_CAPTURE_PNG_DIMENSION + 1, 16);
    if (kind === 'pixel-budget') { png.writeUInt32BE(MAX_CAPTURE_PNG_DIMENSION, 16); png.writeUInt32BE(MAX_CAPTURE_PNG_DIMENSION, 20); }
    if (kind === 'encoding') png[26] = 1;
    await expect(publishCapture(options({ png }))).rejects.toMatchObject({ code: 'PREVIEW_ARTIFACT_INVALID', stage: 'verify-image', details: { publicationOccurred: false, incompleteArtifacts: [] } });
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  test('detects an injected silent short image write by comparing the closed file with the source', async () => {
    await expect(publishCapture(options(), { openFile: async (path) => {
      const handle = await open(path, 'wx', 0o600);
      return handleWith(handle, { writeFile: async (data) => { await handle.writeFile(Buffer.from(data).subarray(0, 40)); } });
    } })).rejects.toMatchObject({ code: 'PREVIEW_ARTIFACT_INVALID', stage: 'verify-image' });
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  test('rejects image close failure, makes bounded handle cleanup, and never builds a success receipt', async () => {
    let closes = 0;
    let callbacks = 0;
    await expect(publishCapture(options({ createReceipt: () => { callbacks++; return {}; } }), { openFile: async (path) => {
      const handle = await open(path, 'wx', 0o600);
      return handleWith(handle, { close: async () => {
        closes++;
        if (closes === 1) throw new Error('injected close failure');
        await handle.close();
      } });
    } })).rejects.toMatchObject({ code: 'PREVIEW_ARTIFACT_IO', stage: 'write-image', details: { publicationOccurred: false, unclosedHandles: [] } });
    expect(closes).toBe(2);
    expect(callbacks).toBe(0);
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  test('cleans the image after receipt construction or serialization rejects', async () => {
    await expect(publishCapture(options({ createReceipt: () => ({ unsupported: 1n }) }))).rejects.toMatchObject({ code: 'PREVIEW_ARTIFACT_INVALID', stage: 'create-receipt' });
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  test('cleans owned files after receipt write or publication failure', async () => {
    await expect(publishCapture(options(), { openFile: async (path) => {
      const handle = await open(path, 'wx', 0o600);
      return handleWith(handle, path.endsWith('.tmp') ? { writeFile: async () => { throw new Error('receipt write failed'); } } : {});
    } })).rejects.toMatchObject({ code: 'PREVIEW_ARTIFACT_IO', stage: 'write-receipt', details: { incompleteArtifacts: [] } });
    expect(await readdir(outputDirectory)).toEqual([]);
    await expect(publishCapture(options(), { publishReceipt: async () => { throw new Error('publication failed'); } })).rejects.toMatchObject({ code: 'PREVIEW_ARTIFACT_IO', stage: 'publish-receipt', details: { incompleteArtifacts: [] } });
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  test('never publishes a silently truncated staged receipt', async () => {
    await expect(publishCapture(options(), { openFile: async (path) => {
      const handle = await open(path, 'wx', 0o600);
      return handleWith(handle, path.endsWith('.tmp') ? { writeFile: async () => { await handle.writeFile('{'); } } : {});
    } })).rejects.toMatchObject({ code: 'PREVIEW_ARTIFACT_INVALID', stage: 'verify-receipt', details: { publicationOccurred: false } });
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  test('preserves an unowned receipt collision and reports the remaining directory', async () => {
    await expect(publishCapture(options(), { publishReceipt: async (temporary, target) => {
      await writeFile(target, 'preexisting-unowned-receipt', { flag: 'wx' });
      await link(temporary, target);
    } })).rejects.toMatchObject({ code: 'PREVIEW_OUTPUT_EXISTS', stage: 'publish-receipt', details: { publicationOccurred: false, incompleteArtifacts: [await realpath(outputDirectory) + '/capture-1'] } });
    const directory = join(outputDirectory, 'capture-1');
    expect(await readdir(directory)).toEqual(['receipt.json']);
    expect(await readFile(join(directory, 'receipt.json'), 'utf8')).toBe('preexisting-unowned-receipt');
  });

  test('preserves an unowned image collision rather than recursively deleting the reserved directory', async () => {
    await expect(publishCapture(options(), { openFile: async (path) => {
      await writeFile(path, 'unowned-image', { flag: 'wx' });
      return open(path, 'wx', 0o600);
    } })).rejects.toMatchObject({ code: 'PREVIEW_OUTPUT_EXISTS', stage: 'write-image' });
    expect(await readFile(join(outputDirectory, 'capture-1', 'image.png'), 'utf8')).toBe('unowned-image');
  });
});

describe('cancellation at the publication boundary', () => {
  test('pre-aborted capture leaves the output root untouched', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(publishCapture(options({ signal: controller.signal }))).rejects.toMatchObject({ code: 'PREVIEW_ABORTED', details: { publicationOccurred: false } });
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  test('abort during a pending write waits for close and cleans before rejecting', async () => {
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    let closed = false;
    let settled = false;
    const publication = publishCapture(options({ signal: controller.signal }), { openFile: async (path) => {
      const handle = await open(path, 'wx', 0o600);
      return handleWith(handle, {
        writeFile: async (data) => { entered.resolve(); await release.promise; await handle.writeFile(data); },
        close: async () => { await handle.close(); closed = true; },
      });
    } });
    const outcome = publication.then((value) => ({ value }), (error: unknown) => ({ error }));
    void outcome.then(() => { settled = true; });
    await entered.promise;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    expect(await outcome).toMatchObject({ error: { code: 'PREVIEW_ABORTED', details: { publicationOccurred: false } } });
    expect(closed).toBe(true);
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  test('abort while closing the receipt prevents publication', async () => {
    const controller = new AbortController();
    let published = false;
    await expect(publishCapture(options({ signal: controller.signal }), {
      openFile: async (path) => {
        const handle = await open(path, 'wx', 0o600);
        return handleWith(handle, { close: async () => { await handle.close(); if (path.endsWith('.tmp')) controller.abort(); } });
      },
      publishReceipt: async () => { published = true; },
    })).rejects.toMatchObject({ code: 'PREVIEW_ABORTED', stage: 'write-receipt' });
    expect(published).toBe(false);
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  test('successful exclusive publication wins an abort arriving while the syscall is in flight', async () => {
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    let commits = 0;
    const publication = publishCapture(options({ signal: controller.signal, commit: async (publish) => { commits++; return publish(); } }), {
      publishReceipt: async (temporary, target) => { entered.resolve(); await release.promise; await link(temporary, target); },
    });
    await entered.promise;
    controller.abort();
    release.resolve();
    const result = await publication;
    expect(commits).toBe(1);
    expect(await readFile(result.imagePath)).toEqual(PNG);
    expect(JSON.parse(await readFile(result.receiptPath, 'utf8'))).toEqual(result.receipt);
    expect(await readdir(join(outputDirectory, 'capture-1'))).toEqual(['image.png', 'receipt.json']);
  });

  test('a gate delay before invoking the syscall cannot bypass prepublication cancellation', async () => {
    const controller = new AbortController();
    await expect(publishCapture(options({ signal: controller.signal, commit: async (publish) => {
      controller.abort();
      return publish();
    } }))).rejects.toMatchObject({ code: 'PREVIEW_ABORTED', stage: 'publish-receipt', details: { publicationOccurred: false } });
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  test('publication failure wins a simultaneous abort and reports the actual stage after cleanup', async () => {
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    const publication = publishCapture(options({ signal: controller.signal }), {
      publishReceipt: async () => { entered.resolve(); await release.promise; throw new Error('link failed'); },
    });
    const outcome = publication.then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    controller.abort();
    release.resolve();
    expect(await outcome).toMatchObject({ error: { code: 'PREVIEW_ARTIFACT_IO', stage: 'publish-receipt', details: { publicationOccurred: false, incompleteArtifacts: [] } } });
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  test('a wrapper/reporting failure after publication retains the success marker and image', async () => {
    await expect(publishCapture(options({ commit: async (publish) => {
      await publish();
      throw new Error('post-publication reporting failed');
    } }))).rejects.toMatchObject({ code: 'PREVIEW_ARTIFACT_IO', stage: 'publish-receipt', details: { publicationOccurred: true, incompleteArtifacts: [] } });
    expect(await readFile(join(outputDirectory, 'capture-1', 'image.png'))).toEqual(PNG);
    expect(JSON.parse(await readFile(join(outputDirectory, 'capture-1', 'receipt.json'), 'utf8'))).toMatchObject({ format: 'test.capture', version: 1 });
    expect(await readdir(join(outputDirectory, 'capture-1'))).toEqual(['image.png', 'receipt.json']);
  });
});
