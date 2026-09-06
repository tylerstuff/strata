import { link, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createProceduralScene, sceneRevision, serializeScene } from '@strata-engine/authoring';
import type { BoxSceneDescriptor, SceneCommitReceipt } from '@strata-engine/core';
import { describe, expect, it, vi } from 'vitest';
import { prepareAuthoredPreviewLoad, type AuthoredPreviewView } from '../src/adapter.js';
import { publishCapture, type CapturePublication } from '../src/artifacts.js';
import { createPreviewConnection } from '../src/connection.js';
import type { PreviewDriver } from '../src/driver.js';
import { PreviewSession, type PreviewReadyReceipt } from '../src/session.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');
const scene = createProceduralScene('connection-settlement');
const revision = sceneRevision(scene);
const view = {
  camera: { position: [0, 1, 3], rotation: [0, 0, 0, 1], projection: { kind: 'perspective', verticalFovRadians: Math.PI / 3, near: 0.1, far: 100 } },
  light: { directionToLight: [0, 1, 0], radiance: [2, 2, 2] }, background: [0.1, 0.1, 0.1],
};
function request(id: number, method: string, params: object = {}) { return { version: 1, id, method, params }; }

// Only rendering is a CPU double. Source validation, the session gate, controller,
// filesystem writes, exclusive receipt publication and owned cleanup are real.
class CpuDriver implements PreviewDriver<BoxSceneDescriptor, AuthoredPreviewView, SceneCommitReceipt, unknown> {
  status: 'ready' | 'disposed' = 'ready';
  commit: SceneCommitReceipt | null = null;
  generation = 0;
  frame = 0;
  width = 1;
  height = 1;
  disposed = 0;
  disposeError: Error | undefined;
  prepareLoad = prepareAuthoredPreviewLoad;
  async observe() {
    return { status: this.status, commit: this.commit, width: this.width, height: this.height,
      lastSubmittedFrameId: this.frame || null, telemetry: { gpuErrorCount: 0 }, environment: { purpose: 'cpu-settlement-proof' } };
  }
  async setScene(value: BoxSceneDescriptor) {
    this.commit = { sceneGeneration: ++this.generation, renderer: 'authored-boxes', sceneId: value.sceneId, sourceRevision: value.sourceRevision };
    return this.commit;
  }
  async render(value: AuthoredPreviewView) {
    if (this.commit === null) throw new Error('Expected a committed CPU scene.');
    const frameId = ++this.frame;
    return { commit: this.commit, frameId, width: this.width, height: this.height,
      resolvedView: { ...value, width: this.width, height: this.height }, metrics: { frameId, scene: this.commit } };
  }
  async resize(width: number, height: number) { this.width = width; this.height = height; }
  async waitForIdle() {}
  async screenshot() { return png; }
  async dispose() { this.disposed++; this.status = 'disposed'; if (this.disposeError) throw this.disposeError; }
}

async function fixture(held: 'writeFile' | 'sync' | 'publication', cleanupTimeoutMs = 500, lateCreation = false) {
  const directory = await mkdtemp(join(tmpdir(), 'strata-real-connection-settlement-'));
  const projectRoot = join(directory, 'project'), outputRoot = join(directory, 'output');
  await mkdir(projectRoot); await mkdir(outputRoot);
  await writeFile(join(projectRoot, 'scene.json'), serializeScene(scene));
  const entered = deferred(), release = deferred(), factoryEntered = deferred(), returnSession = deferred();
  const completed = deferred<{ publication?: CapturePublication; error?: unknown }>();
  const driver = new CpuDriver();
  let publisherStarted = false, publisherSettled = false, openHandles = 0, receiptLinks = 0;
  async function pause() { entered.resolve(); await release.promise; }
  const session = new PreviewSession(driver, {
    defaultTimeoutMs: 2000, cleanupTimeoutMs,
    publish: async options => {
      publisherStarted = true;
      try {
        const publication = await publishCapture(options, {
          openFile: async path => {
            const handle = await open(path, 'wx', 0o600);
            openHandles++;
            return {
              writeFile: async data => { if (held === 'writeFile' && basename(path) === 'image.png') await pause(); await handle.writeFile(data); },
              sync: async () => { if (held === 'sync' && basename(path) === 'image.png') await pause(); await handle.sync(); },
              close: async () => { await handle.close(); openHandles--; },
            };
          },
          publishReceipt: async (temporary, target) => { if (held === 'publication') await pause(); await link(temporary, target); receiptLinks++; },
        });
        completed.resolve({ publication });
        return publication;
      } catch (error) { completed.resolve({ error }); throw error; }
      finally { publisherSettled = true; }
    },
  });
  const connection = await createPreviewConnection({ projectRoot, outputRoot, width: 1, height: 1, timeoutMs: 2000, cleanupTimeoutMs }, { createSession: async () => {
    factoryEntered.resolve();
    if (lateCreation) await returnSession.promise;
    return session;
  } });
  const loaded = lateCreation ? { ok: true, result: await session.load({ scene, revision, view }) }
    : await connection.request(request(1, 'load', { scenePath: 'scene.json', expectedRevision: revision, view }));
  if (!loaded.ok) { await connection.close(); await rm(directory, { recursive: true, force: true }); throw new Error(JSON.stringify(loaded)); }
  const ready = loaded.result as PreviewReadyReceipt<SceneCommitReceipt>;
  return {
    connection, driver, session, ready, outputRoot, entered, release, completed, factoryEntered, returnSession,
    get publisherSettled() { return publisherSettled; },
    get openHandles() { return openHandles; },
    get receiptLinks() { return receiptLinks; },
    capture: () => connection.request(request(2, 'capture', { expectedRevision: ready.sourceRevision,
      expectedLoadId: ready.loadId, expectedViewRevision: ready.viewRevision, captureId: 'held-capture' })),
    async cleanup() {
      release.resolve(); returnSession.resolve();
      if (publisherStarted) await completed.promise;
      await connection.close().catch(() => {});
      await session.dispose().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe('connection shutdown with real session and real artifact ownership (CPU only)', () => {
  it.each(['writeFile', 'sync'] as const)('waits for cancelled precommit %s and owned cleanup after the public capture rejects', async held => {
    const test = await fixture(held);
    try {
      const capture = test.capture();
      await test.entered.promise;
      expect(test.openHandles).toBe(1);
      expect(await test.connection.request(request(3, 'cancel', { requestId: 2 }))).toMatchObject({ ok: true });
      expect(await capture).toMatchObject({ ok: false, error: { code: 'PREVIEW_ABORTED' } });
      let closeSettled = false;
      const close = test.connection.close().then(() => { closeSettled = true; }, error => { closeSettled = true; throw error; });
      // Driver disposal is deliberately immediate; publisher ownership is separate.
      await vi.waitFor(() => expect(test.driver.disposed).toBe(1));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(test.publisherSettled).toBe(false);
      expect(test.openHandles).toBe(1);
      expect(closeSettled, 'close must not claim disposal while a real file handle remains owned').toBe(false);
      test.release.resolve();
      expect(await test.completed.promise).toMatchObject({ error: { code: 'PREVIEW_ABORTED' } });
      await close;
      expect(test.openHandles).toBe(0);
      expect(test.receiptLinks).toBe(0);
      expect(await readdir(test.outputRoot)).toEqual([]);
    } finally { await test.cleanup(); }
  });

  it('reports an unsettled close deadline truthfully while cancelled precommit I/O remains owned', async () => {
    const test = await fixture('writeFile', 100);
    try {
      const capture = test.capture();
      await test.entered.promise;
      await test.connection.request(request(3, 'cancel', { requestId: 2 }));
      expect(await capture).toMatchObject({ ok: false, error: { code: 'PREVIEW_ABORTED' } });
      await expect(test.connection.close()).rejects.toMatchObject({ code: 'CONNECTION_UNSETTLED', details: { outcomeUnknown: true } });
      expect(test.publisherSettled).toBe(false);
      expect(test.openHandles).toBe(1);
      expect(test.receiptLinks).toBe(0);
      expect(await test.connection.request(request(4, 'discover'))).toMatchObject({ ok: false });
      test.release.resolve();
      expect(await test.completed.promise).toMatchObject({ error: { code: 'PREVIEW_ABORTED' } });
      expect(test.openHandles).toBe(0);
      expect(await readdir(test.outputRoot)).toEqual([]);
    } finally { await test.cleanup(); }
  });

  it('preserves known publication success when cancellation and close arrive during the exclusive receipt link', async () => {
    const test = await fixture('publication');
    try {
      let captureSettled = false, closeSettled = false;
      const capture = test.capture().then(result => { captureSettled = true; return result; });
      await test.entered.promise;
      await test.connection.request(request(3, 'cancel', { requestId: 2 }));
      const close = test.connection.close().then(() => { closeSettled = true; });
      await vi.waitFor(() => expect(test.driver.disposed).toBe(1));
      expect(captureSettled).toBe(false);
      expect(closeSettled).toBe(false);
      test.release.resolve();
      const response = await capture;
      expect(response).toMatchObject({ ok: true, result: { publicationOccurred: true } });
      await close;
      const { publication } = await test.completed.promise;
      expect(publication).toBeDefined();
      expect(JSON.parse(await readFile(publication!.receiptPath, 'utf8'))).toEqual(publication!.receipt);
      expect(await readFile(publication!.imagePath)).toEqual(png);
      expect(test.receiptLinks).toBe(1);
      expect(test.openHandles).toBe(0);
      expect(test.driver.disposed).toBe(1);
    } finally { await test.cleanup(); }
  });

  it('retains precommit I/O owned by a real late-created session after initialization cancellation', async () => {
    const test = await fixture('writeFile', 500, true);
    try {
      // The host factory has created a session but has not transferred ownership
      // yet. Its late cleanup must await all owned work, not only driver.dispose.
      const capture = test.session.capture({ expectedRevision: test.ready.sourceRevision,
        expectedLoadId: test.ready.loadId, expectedViewRevision: test.ready.viewRevision,
        outputDirectory: test.outputRoot, captureId: 'late-session-capture' }).catch(error => error);
      await test.entered.promise;
      const loading = test.connection.request(request(1, 'load', { scenePath: 'scene.json', expectedRevision: revision, view }));
      await test.factoryEntered.promise;
      await test.connection.request(request(2, 'cancel', { requestId: 1 }));
      let closeSettled = false;
      const close = test.connection.close().then(() => { closeSettled = true; });
      test.returnSession.resolve();
      await vi.waitFor(() => expect(test.driver.disposed).toBe(1));
      expect(await capture).toMatchObject({ code: 'PREVIEW_DISPOSED' });
      expect(test.publisherSettled).toBe(false);
      expect(test.openHandles).toBe(1);
      expect(closeSettled).toBe(false);
      test.release.resolve();
      expect(await test.completed.promise).toMatchObject({ error: { code: 'PREVIEW_ABORTED' } });
      expect(await loading).toMatchObject({ ok: false, error: { code: 'PREVIEW_ABORTED' } });
      await close;
      expect(test.openHandles).toBe(0);
      expect(test.receiptLinks).toBe(0);
      expect(test.driver.disposed).toBe(1);
      expect(await readdir(test.outputRoot)).toEqual([]);
    } finally { await test.cleanup(); }
  });

  it('does not let driver teardown failure short-circuit real artifact settlement, and preserves that failure afterward', async () => {
    const test = await fixture('sync');
    try {
      const capture = test.capture();
      await test.entered.promise;
      await test.connection.request(request(3, 'cancel', { requestId: 2 }));
      expect(await capture).toMatchObject({ ok: false, error: { code: 'PREVIEW_ABORTED' } });
      test.driver.disposeError = new Error('CPU driver teardown failed.');
      let closeSettled = false;
      const close = test.connection.close().then(
        () => { closeSettled = true; return { ok: true }; },
        error => { closeSettled = true; return { ok: false, error }; },
      );
      await vi.waitFor(() => expect(test.driver.disposed).toBe(1));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(closeSettled).toBe(false);
      expect(test.openHandles).toBe(1);
      expect(test.publisherSettled).toBe(false);
      test.release.resolve();
      expect(await test.completed.promise).toMatchObject({ error: { code: 'PREVIEW_ABORTED' } });
      expect(await close).toMatchObject({ ok: false, error: { code: 'CONNECTION_DISPOSE_FAILED' } });
      expect(test.openHandles).toBe(0);
      expect(test.receiptLinks).toBe(0);
      expect(await readdir(test.outputRoot)).toEqual([]);
    } finally { await test.cleanup(); }
  });
});
