import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProceduralScene, sceneRevision, serializeScene } from '@strata-engine/authoring';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreviewConnection, type PreviewConnectionSession, type PreviewConnectionObservation } from '../src/connection.js';
import type { PreviewConnectionHandler, ConnectionResponse } from '../src/connection-protocol.js';
import type { OperationOptions } from '../src/operation.js';
import type { CaptureRequest, PreviewReadyReceipt } from '../src/session.js';
import type { CapturePublication } from '../src/artifacts.js';
import { PreviewError } from '../src/errors.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const source = createProceduralScene('connection-test');
const revision = sceneRevision(source);
const view = {
  camera: { position: [0, 1, 3], rotation: [0, 0, 0, 1], projection: { kind: 'perspective', verticalFovRadians: Math.PI / 3, near: 0.1, far: 100 } },
  light: { directionToLight: [0, 1, 0], radiance: [2, 2, 2] }, background: [0.1, 0.1, 0.1],
};
const ready: PreviewReadyReceipt<unknown> = {
  sessionId: 'test-session', loadId: 'load-1', sceneId: source.id, sourceRevision: revision,
  commit: { sceneGeneration: 1, sceneId: source.id, sourceRevision: revision, renderer: 'authored-boxes' },
  viewRevision: 'view-1', resolvedView: view, frameId: 1, width: 512, height: 512,
};
function request(id: number, method: string, params: object = {}) { return { version: 1, id, method, params }; }
function load(id: number) { return request(id, 'load', { scenePath: 'scene.json', expectedRevision: revision, view }); }
const tokens = { expectedRevision: revision, expectedLoadId: 'load-1', expectedViewRevision: 'view-1' };

class Session implements PreviewConnectionSession {
  state: PreviewConnectionObservation['state'] = 'ready';
  loads: unknown[] = [];
  captures: CaptureRequest[] = [];
  disposed = 0;
  onLoad?: (options: OperationOptions) => Promise<PreviewReadyReceipt<unknown>>;
  onCapture?: (options: OperationOptions) => Promise<CapturePublication>;
  onObserve?: () => Promise<void>;
  onDispose?: () => Promise<void>;
  async load(input: unknown, options: OperationOptions = {}) {
    this.loads.push(input); return this.onLoad ? this.onLoad(options) : structuredClone(ready);
  }
  async observe(): Promise<PreviewConnectionObservation> {
    await this.onObserve?.();
    return { sessionId: ready.sessionId, state: this.state, ready: this.state === 'ready' ? structuredClone(ready) : null,
      driver: { status: this.state === 'disposed' ? 'disposed' : 'ready', commit: ready.commit, width: 512, height: 512,
        lastSubmittedFrameId: 1, telemetry: { gpuErrorCount: 0 }, environment: { purpose: 'cpu-double' } } };
  }
  async capture(capture: CaptureRequest, options: OperationOptions = {}) {
    this.captures.push(capture);
    return this.onCapture ? this.onCapture(options) : publication(capture.outputDirectory);
  }
  async resize(width: number, height: number) { return { ...structuredClone(ready), width, height, frameId: 2, viewRevision: 'view-2' }; }
  async dispose() { this.disposed++; this.state = 'disposed'; await this.onDispose?.(); }
}
function publication(root: string): CapturePublication { return { imagePath: join(root, 'capture/image.png'), receiptPath: join(root, 'capture/receipt.json'), receipt: { ...ready, presentedFrameId: null }, cleanupWarnings: [] }; }

let directory: string, projectRoot: string, outputRoot: string;
let connections: PreviewConnectionHandler[];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'strata-connection-controller-'));
  projectRoot = join(directory, 'project'); outputRoot = join(directory, 'output');
  await mkdir(projectRoot); await mkdir(outputRoot); await writeFile(join(projectRoot, 'scene.json'), serializeScene(source));
  connections = [];
});
afterEach(async () => {
  await Promise.allSettled(connections.map(connection => connection.close()));
  vi.useRealTimers(); await rm(directory, { recursive: true, force: true });
});
async function connection(session = new Session(), overrides: object = {}, factory = vi.fn(async () => session)) {
  const value = await createPreviewConnection({ projectRoot, outputRoot, timeoutMs: 1000, cleanupTimeoutMs: 100, ...overrides }, { createSession: factory });
  connections.push(value); return { value, session, factory };
}

describe('local preview controller: existing session ownership and result identity', () => {
  it('discovers fixed roots and contract without creating a browser, then uses one lazy session for sequential operations', async () => {
    const { value, session, factory } = await connection();
    const discovery = await value.request(request(1, 'discover'));
    expect(discovery).toMatchObject({ ok: true, result: { version: 1, limits: { ordinaryRequests: 6, reservedControlRequests: 2 }, browser: { lazy: true } } });
    expect(factory).not.toHaveBeenCalled();
    expect(await value.request(request(2, 'inspect'))).toMatchObject({ ok: true, result: { observation: null } });
    expect(await value.request(load(3))).toMatchObject({ ok: true, result: ready });
    expect(await value.request(request(4, 'capture', tokens))).toMatchObject({ ok: true, result: { publicationOccurred: true, receipt: { presentedFrameId: null } } });
    expect(await value.request(request(5, 'resize', { width: 640, height: 360 }))).toMatchObject({ ok: true, result: { width: 640, height: 360, viewRevision: 'view-2' } });
    expect(await value.request(load(6))).toMatchObject({ ok: true });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(session.captures[0]).toEqual({ ...tokens, outputDirectory: expect.stringContaining('/output') });
    expect(await readFile(join(projectRoot, 'scene.json'), 'utf8')).toBe(serializeScene(source));
    expect(await value.request(request(7, 'dispose'))).toMatchObject({ ok: true, result: { disposed: true } });
    expect(session.disposed).toBe(1);
    expect(await value.request(request(8, 'discover'))).toMatchObject({ ok: false, error: { code: 'CONNECTION_CLOSED' } });
    expect(await value.request(request(9, 'dispose'))).toMatchObject({ ok: true });
    expect(session.disposed).toBe(1);
  });

  it('rejects invalid revisions, unsupported assets and unsafe paths before session creation', async () => {
    const { value, factory } = await connection();
    expect(await value.request(request(1, 'load', { ...load(1).params, expectedRevision: 'stale' }))).toMatchObject({ ok: false, error: { code: 'PREVIEW_SOURCE_REVISION_MISMATCH' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await value.request(request(2, 'load', { ...load(2).params, scenePath: '../scene.json' }))).toMatchObject({ ok: false, error: { code: 'CONNECTION_SCENE_PATH' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    const external = structuredClone(source); external.assets.push({ id: 'unused', kind: 'external', uri: 'secret.glb', mediaType: 'model/gltf-binary' });
    await writeFile(join(projectRoot, 'scene.json'), serializeScene(external));
    expect(await value.request(request(3, 'load', { ...load(3).params, expectedRevision: sceneRevision(external) }))).toMatchObject({ ok: false, error: { code: 'PREVIEW_UNSUPPORTED_ASSET' } });
    expect(factory).not.toHaveBeenCalled();
  });

  it('validates envelope/ID order and never accepts a replay or unsupported parameter', async () => {
    const { value } = await connection();
    for (const bad of [null, [], { version: 2, id: 1, method: 'discover', params: {} }, request(0, 'discover')]) {
      expect(await value.request(bad)).toMatchObject({ id: null, ok: false });
    }
    expect(await value.request(request(4, 'unknown'))).toMatchObject({ id: 4, ok: false, error: { code: 'CONNECTION_METHOD' } });
    expect(await value.request(request(4, 'discover'))).toMatchObject({ id: null, ok: false, error: { code: 'CONNECTION_ID_ORDER' } });
    expect(await value.request(request(3, 'discover'))).toMatchObject({ id: null, ok: false });
    expect(await value.request(request(5, 'capture', { ...tokens, outputDirectory: '/elsewhere' }))).toMatchObject({ ok: false, error: { code: 'CONNECTION_INVALID_REQUEST' } });
    expect(await value.request({ ...request(6, 'discover'), extra: true })).toMatchObject({ id: null, ok: false });
  });

  it('keeps inspect/cancel responsive while one initialization is pending and disposes a late canceled session', async () => {
    const created = deferred<Session>(), session = new Session();
    const factory = vi.fn(() => created.promise);
    const { value } = await connection(session, {}, factory);
    const loading = value.request(load(1));
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    expect(await value.request(load(2))).toMatchObject({ ok: false, error: { code: 'PREVIEW_BUSY' } });
    expect(await value.request(request(3, 'inspect'))).toMatchObject({ ok: true, result: { observation: null, activeRequests: expect.arrayContaining([expect.objectContaining({ requestId: 1 })]) } });
    expect(await value.request(request(4, 'cancel', { requestId: 1 }))).toMatchObject({ ok: true, result: { cancellationRequested: true, settled: false } });
    created.resolve(session);
    expect(await loading).toMatchObject({ ok: false, error: { code: 'PREVIEW_ABORTED' } });
    expect(session.disposed).toBe(1); expect(session.loads).toHaveLength(0);
  });

  it('retains mutation admission after a rejected API call until the session gate becomes idle', async () => {
    const { value, session } = await connection(); await value.request(load(1));
    session.onCapture = async () => { session.state = 'busy'; throw new PreviewError('PREVIEW_ABORTED', 'capture', 'Canceled while settling.'); };
    expect(await value.request(request(2, 'capture', tokens))).toMatchObject({ ok: false, error: { code: 'PREVIEW_ABORTED' } });
    expect(await value.request(request(3, 'resize', { width: 16, height: 16 }))).toMatchObject({ ok: false, error: { code: 'PREVIEW_BUSY' } });
    expect(await value.request(request(4, 'inspect'))).toMatchObject({ ok: true, result: { observation: { state: 'busy' } } });
    session.state = 'ready';
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(await value.request(request(5, 'resize', { width: 16, height: 16 }))).toMatchObject({ ok: true });
  });

  it.each([false, true])('retains late-created disposal failure and faults admission (shutdown already started: %s)', async shutdown => {
    const created = deferred<Session>(), session = new Session();
    const factory = vi.fn(() => created.promise);
    const { value } = await connection(session, {}, factory);
    const loading = value.request(load(1));
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    await value.request(request(2, 'cancel', { requestId: 1 }));
    const disposal = shutdown ? value.request(request(3, 'dispose')) : undefined;
    session.onDispose = async () => { throw new PreviewError('PREVIEW_DISPOSE_FAILED', 'dispose', 'Browser cleanup failed.', { unresolvedResources: ['browser'] }); };
    created.resolve(session);
    expect(await loading).toMatchObject({ ok: false, error: { code: 'CONNECTION_DISPOSE_FAILED', details: { unresolvedResources: ['late-created-session'] } } });
    expect(value.closing).toBe(true);
    if (disposal) expect(await disposal).toMatchObject({ ok: false, error: { code: 'CONNECTION_DISPOSE_FAILED' } });
    await expect(value.close()).rejects.toMatchObject({ code: 'CONNECTION_DISPOSE_FAILED' });
    expect(await value.request(load(4))).toMatchObject({ ok: false });
    expect(factory).toHaveBeenCalledTimes(1); expect(session.disposed).toBe(1);
  });

  it('samples request summaries after a delayed inspection observes capture cancellation and settlement', async () => {
    const { value, session } = await connection(); await value.request(load(1));
    const pending = deferred<CapturePublication>(), observed = deferred<void>();
    session.onCapture = () => pending.promise;
    const capture = value.request(request(2, 'capture', tokens));
    await vi.waitFor(() => expect(session.captures).toHaveLength(1));
    session.onObserve = vi.fn(() => observed.promise);
    const inspection = value.request(request(3, 'inspect'));
    await vi.waitFor(() => expect(session.onObserve).toHaveBeenCalled());
    await value.request(request(4, 'cancel', { requestId: 2 }));
    pending.resolve(publication(outputRoot));
    expect(await capture).toMatchObject({ ok: true });
    observed.resolve();
    const response = await inspection;
    expect(response).toMatchObject({ ok: true, result: {
      observation: { state: 'ready' },
      recentRequests: expect.arrayContaining([
        { id: 2, method: 'capture', status: 'succeeded' },
        { id: 4, method: 'cancel', status: 'succeeded' },
      ]),
    } });
    if (!response.ok) throw new Error('Expected inspection.');
    expect((response.result as { activeRequests: { requestId: number }[] }).activeRequests.some(work => work.requestId === 2)).toBe(false);
  });

  it('preserves a successful publication after cancellation and during shutdown, awaiting request settlement separately from dispose', async () => {
    const { value, session } = await connection(); await value.request(load(1));
    const pending = deferred<CapturePublication>(); session.onCapture = () => pending.promise;
    const capture = value.request(request(2, 'capture', tokens));
    await vi.waitFor(() => expect(session.captures).toHaveLength(1));
    expect(await value.request(request(3, 'cancel', { requestId: 2 }))).toMatchObject({ ok: true, result: { cancellationRequested: true } });
    let disposedResponse = false;
    const disposal = value.request(request(4, 'dispose')).then(result => { disposedResponse = true; return result; });
    await vi.waitFor(() => expect(session.disposed).toBe(1));
    expect(disposedResponse).toBe(false);
    pending.resolve(publication(outputRoot));
    expect(await capture).toMatchObject({ ok: true, result: { publicationOccurred: true, receiptPath: join(outputRoot, 'capture/receipt.json') } });
    expect(await disposal).toMatchObject({ ok: true, result: { disposed: true } });
  });

  it('retains committed and published evidence in structured API errors', async () => {
    const { value, session } = await connection(); await value.request(load(1));
    session.onCapture = async () => { throw new PreviewError('PREVIEW_REPORT_FAILED', 'publication', 'Reported after commit.', { publicationOccurred: true, receiptPath: 'known/receipt.json', receipt: ready, commitOccurred: true, committedReceipt: ready.commit }); };
    expect(await value.request(request(2, 'capture', tokens))).toMatchObject({ ok: false, error: { code: 'PREVIEW_REPORT_FAILED', details: { publicationOccurred: true, receiptPath: 'known/receipt.json', commitOccurred: true, committedReceipt: ready.commit } } });
  });

  it('faults on an uncooperative pending capture with unknown outcome, without claiming rollback or reopening admission', async () => {
    const { value, session } = await connection(new Session(), { timeoutMs: 20, cleanupTimeoutMs: 20 });
    await value.request(load(1));
    const pending = deferred<CapturePublication>(); session.onCapture = () => pending.promise;
    const capture = value.request(request(2, 'capture', tokens));
    expect(await capture).toMatchObject({ ok: false, error: { code: 'CONNECTION_UNSETTLED', details: { outcomeUnknown: true } } });
    expect(value.closing).toBe(true);
    expect(await value.request(load(3))).toMatchObject({ ok: false });
    pending.resolve(publication(outputRoot));
    await value.close().catch(() => {});
    expect(session.disposed).toBe(1);
  });

  it('bounds one pending inspection and reports unknown cleanup when observation never settles', async () => {
    const { value, session } = await connection(new Session(), { timeoutMs: 20, cleanupTimeoutMs: 20 });
    await value.request(load(1));
    const observed = deferred<void>(); session.onObserve = () => observed.promise;
    const first = value.request(request(2, 'inspect'));
    expect(await value.request(request(3, 'inspect'))).toMatchObject({ ok: false, error: { code: 'CONNECTION_BUSY' } });
    expect(await first).toMatchObject({ ok: false, error: { code: 'CONNECTION_UNSETTLED' } });
    observed.resolve(); await value.close().catch(() => {});
  });

  it('limits status retention and does not return historical full request payloads', async () => {
    const { value } = await connection();
    for (let id = 1; id <= 40; id++) await value.request(request(id, 'discover'));
    const result = await value.request(request(41, 'inspect'));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('Expected inspection.');
    const recent = (result.result as { recentRequests: unknown[] }).recentRequests;
    expect(recent).toHaveLength(32); expect(recent[0]).toEqual({ id: 9, method: 'discover', status: 'succeeded' });
  });

  it('supports host cancellation and rejects canceled or invalid startup without invoking a factory', async () => {
    const signal = new AbortController(); signal.abort();
    await expect(createPreviewConnection({ projectRoot, outputRoot, signal: signal.signal })).rejects.toMatchObject({ code: 'PREVIEW_ABORTED' });
    for (const options of [{ width: 0 }, { width: 16_384, height: 16_384 }, { channel: 'arbitrary' }, { timeoutMs: 300_001 }]) {
      await expect(createPreviewConnection({ projectRoot, outputRoot, ...options } as Parameters<typeof createPreviewConnection>[0])).rejects.toMatchObject({ code: 'CONNECTION_INVALID_PARAMS' });
    }
    const host = new AbortController(), { value, session } = await connection(new Session(), { signal: host.signal });
    await value.request(load(1)); host.abort(); await value.close(); expect(session.disposed).toBe(1);
  });
});
