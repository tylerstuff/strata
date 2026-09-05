import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProceduralScene, sceneRevision } from '@strata-engine/authoring';
import type { AuthoredFrameMetadata, BoxSceneDescriptor, FrameMetrics, RenderOptions, SceneCommitReceipt } from '@strata-engine/core';
import type { AuthoredPreviewLoadInput } from '../src/adapter.js';
import type { PublishCaptureOptions } from '../src/artifacts.js';

const seams = vi.hoisted(() => ({
  launch: vi.fn(), startServer: vi.fn(), readClient: vi.fn(), createEngine: vi.fn(), publishCapture: vi.fn(),
  sessionConstructed: undefined as (() => void) | undefined,
}));
vi.mock('playwright', () => ({ chromium: { launch: seams.launch } }));
vi.mock('../src/server.js', () => ({ startPreviewServer: seams.startServer }));
vi.mock('../src/artifacts.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/artifacts.js')>(), publishCapture: seams.publishCapture,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: (path: Parameters<typeof actual.readFile>[0], options: Parameters<typeof actual.readFile>[1]) =>
    String(path).endsWith('/browser/client.js') ? seams.readClient(path, options) : actual.readFile(path, options) };
});
vi.mock('@strata-engine/core', async importOriginal => ({
  ...await importOriginal<typeof import('@strata-engine/core')>(), createEngine: seams.createEngine,
}));
// The session wrapper below is cached by Vitest. Keep its error class shared
// with freshly imported drivers while resetting the browser client's state.
vi.mock('../src/errors.js', async importOriginal => await importOriginal<typeof import('../src/errors.js')>());
vi.mock('../src/session.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/session.js')>();
  return {
    ...actual,
    // One narrow injection point for abort after the factory callback creates its
    // session but before the operation gate delivers that successful result.
    PreviewSession: class extends actual.PreviewSession<unknown, unknown, unknown, unknown> {
      constructor(...args: ConstructorParameters<typeof actual.PreviewSession>) {
        super(...args);
        seams.sessionConstructed?.();
      }
    },
  };
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function source(): AuthoredPreviewLoadInput {
  const scene = createProceduralScene('browser-driver-test');
  return {
    scene, revision: sceneRevision(scene),
    view: {
      camera: { position: [0, 1, 3], rotation: [0, 0, 0, 1], projection: { kind: 'perspective', verticalFovRadians: Math.PI / 3, near: 0.1, far: 32 } },
      light: { directionToLight: [0, 1, 0], radiance: [2, 2, 2] }, background: [0.1, 0.1, 0.1],
    },
  };
}

function fakeResources() {
  const pageEvents = new EventEmitter();
  const browserEvents = new EventEmitter();
  const closed = deferred<never>();
  void closed.promise.catch(() => {});
  const canvas = { width: 512, height: 512, style: { width: '', height: '' } };
  let identity: SceneCommitReceipt = { sceneGeneration: 0, renderer: 'clear', sceneId: null, sourceRevision: null };
  let scene: BoxSceneDescriptor | null = null;
  let generation = 0;
  let submitted = 0;
  let first: number | null = null;
  let last: number | null = null;
  let previous: { frameId: number; width: number; height: number } | null = null;
  const engine = {
    state: 'ready',
    info: { profiling: { gpuTimestampAvailable: false, reason: 'disabled' } },
    gpuErrorCount: 0,
    commit(next: BoxSceneDescriptor): SceneCommitReceipt {
      scene = next;
      identity = { sceneGeneration: ++generation, renderer: 'authored-boxes', sceneId: next.sceneId, sourceRevision: next.sourceRevision };
      first = last = null;
      previous = null;
      return structuredClone(identity);
    },
    setScene: vi.fn(async (options: { scene: BoxSceneDescriptor; signal: AbortSignal }) => engine.commit(options.scene)),
    render: vi.fn((options: RenderOptions): FrameMetrics => {
      if (!scene) throw new Error('No fake scene committed.');
      const camera = structuredClone(options.camera ?? scene.camera);
      const debugView = options.debugView ?? 'final';
      if (debugView !== 'final' && debugView !== 'base-color') throw new Error('Unsupported fake authored debug view.');
      const frameId = ++submitted;
      first ??= frameId;
      last = frameId;
      const resetReason: AuthoredFrameMetadata['motion']['resetReason'] = previous === null ? 'first-frame'
        : options.cameraCut ? 'camera-cut' : previous.width !== canvas.width || previous.height !== canvas.height ? 'viewport-change' : null;
      const authored: AuthoredFrameMetadata = {
        camera, origin: camera.position, aspect: canvas.width / canvas.height, width: canvas.width, height: canvas.height,
        debugView, timeSeconds: options.timeSeconds ?? 0,
        motion: { previousSubmittedFrameId: previous?.frameId ?? null, valid: resetReason === null, resetReason },
      };
      previous = { frameId, width: canvas.width, height: canvas.height };
      return {
        frameId, scene: structuredClone(identity), cpuSubmissionMs: 0, drawCalls: 1, dispatchCalls: 0, triangles: 12,
        uploadBytes: 0, allocatedGpuBufferBytes: 1, allocatedGpuTextureBytes: 1, wasmMemoryBytes: 65536,
        authored,
      };
    }),
    resize: vi.fn((width: number, height: number) => { canvas.width = width; canvas.height = height; }),
    getTelemetry: vi.fn(() => ({
      scene: { identity: structuredClone(identity), firstSubmittedFrameId: first, lastSubmittedFrameId: last },
      submittedFrames: submitted, gpuErrorCount: engine.gpuErrorCount, pendingGpuSamples: 0, droppedGpuSamples: 0,
    })),
    drainGpuTimings: vi.fn(() => []),
    waitForIdle: vi.fn(async () => {}),
    flushGpuTimings: vi.fn(async () => {}),
    dispose: vi.fn(() => { engine.state = 'disposed'; }),
  };
  const requests: { id: string; method: string; data: unknown }[] = [];
  const cancelIds: string[] = [];
  let onCancelReturn: (() => Promise<void>) | undefined;
  let onRequestAdmission: ((method: string) => Promise<void>) | undefined;
  let onRequestReturn: ((method: string) => Promise<void>) | undefined;
  const screenshot = vi.fn(async () => Buffer.from([1, 2, 3]));
  const page = {
    on: pageEvents.on.bind(pageEvents),
    setDefaultTimeout: vi.fn(), goto: vi.fn(async () => {}), waitForFunction: vi.fn(async () => {}),
    setViewportSize: vi.fn(async () => {}), locator: vi.fn(() => ({ screenshot })),
    evaluate: vi.fn(async (callback: (argument: unknown) => unknown, argument: unknown) => {
      if (typeof argument === 'string') cancelIds.push(argument);
      else if (argument !== null && typeof argument === 'object' && 'method' in argument) requests.push(argument as typeof requests[number]);
      const work = Promise.resolve().then(async () => {
        if (argument !== null && typeof argument === 'object' && 'method' in argument) await onRequestAdmission?.(String(argument.method));
        return callback(argument);
      }).then(async value => {
        if (typeof argument === 'string') await onCancelReturn?.();
        else if (argument !== null && typeof argument === 'object' && 'method' in argument) await onRequestReturn?.(String(argument.method));
        return value;
      });
      return Promise.race([work, closed.promise]);
    }),
  };
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => { closed.reject(new Error('Fake context closed.')); }),
  };
  const browser = {
    on: browserEvents.on.bind(browserEvents),
    version: vi.fn(() => 'fake-browser-version'), newContext: vi.fn(async () => context), close: vi.fn(async () => {}),
  };
  const server = { url: 'http://127.0.0.1:12345/fake-token/', dispose: vi.fn(async () => {}) };
  return {
    canvas, engine, page, context, browser, server, pageEvents, browserEvents, requests, cancelIds, screenshot,
    holdCancelReturn(callback: () => Promise<void>) { onCancelReturn = callback; },
    holdRequestAdmission(callback: (method: string) => Promise<void>) { onRequestAdmission = callback; },
    holdRequestReturn(callback: (method: string) => Promise<void>) { onRequestReturn = callback; },
  };
}

let f: ReturnType<typeof fakeResources>;
let createPreviewSession: typeof import('../src/browser-driver.js')['createPreviewSession'];
let CoreSceneCommitError: typeof import('@strata-engine/core')['SceneCommitError'];

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  seams.sessionConstructed = undefined;
  f = fakeResources();
  seams.launch.mockResolvedValue(f.browser);
  seams.startServer.mockResolvedValue(f.server);
  seams.readClient.mockResolvedValue('// CPU test: page.evaluate executes the real browser bridge below.');
  seams.createEngine.mockResolvedValue(f.engine);
  seams.publishCapture.mockRejectedValue(new Error('Capture publication must not be reached in this lifecycle test.'));
  vi.stubGlobal('document', { querySelector: () => f.canvas });
  CoreSceneCommitError = (await import('@strata-engine/core')).SceneCommitError;
  await import('../src/browser/client.js');
  createPreviewSession = (await import('../src/browser-driver.js')).createPreviewSession;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, '__strataPreview');
});

describe('browser driver with actual client RPC and CPU resource doubles', () => {
  it('captures an unchanged view as submitted motion history advances and retains the history in its receipt', async () => {
    seams.publishCapture.mockImplementationOnce(async (options: PublishCaptureOptions) => ({
      imagePath: '/unused-capture-output/stable-view/image.png', receiptPath: '/unused-capture-output/stable-view/receipt.json',
      receipt: options.createReceipt({ relativePath: 'image.png', width: f.canvas.width, height: f.canvas.height, sha256: 'a'.repeat(64), bytes: 3 }),
      cleanupWarnings: [],
    }));
    const session = await createPreviewSession();
    try {
      const ready = await session.load(source());
      expect(ready.resolvedView).not.toHaveProperty('motion');
      expect(f.engine.render.mock.results[0]!.value.authored.motion).toEqual({ previousSubmittedFrameId: null, valid: false, resetReason: 'first-frame' });
      const capture = await session.capture({
        expectedRevision: ready.sourceRevision, expectedLoadId: ready.loadId, expectedViewRevision: ready.viewRevision,
        outputDirectory: '/unused-capture-output', captureId: 'stable-view', frames: 3,
      });
      expect(capture.receipt).toMatchObject({
        viewRevision: ready.viewRevision, resolvedView: ready.resolvedView, submittedFrameIds: [2, 3, 4],
        frames: [1, 2, 3].map(predecessor => ({ frameId: predecessor + 1,
          authored: { motion: { previousSubmittedFrameId: predecessor, valid: true, resetReason: null } } })),
      });
      expect(f.engine.render).toHaveBeenCalledTimes(4);
      expect(f.screenshot).toHaveBeenCalledTimes(1);
      expect(seams.publishCapture).toHaveBeenCalledTimes(1);
      expect((await session.observe()).ready).toMatchObject({ frameId: 4, viewRevision: ready.viewRevision });
    } finally { await session.dispose(); }
  });

  it.each(['camera', 'debug-view'] as const)('still rejects a changed resolved %s before capture publication', async changed => {
    const session = await createPreviewSession();
    try {
      const ready = await session.load(source()), render = f.engine.render.getMockImplementation()!;
      f.engine.render.mockImplementationOnce(options => render(changed === 'camera'
        ? { ...options, camera: { ...options.camera!, position: [0.25, 1, 3] } }
        : { ...options, debugView: 'base-color' }));
      await expect(session.capture({
        expectedRevision: ready.sourceRevision, expectedLoadId: ready.loadId, expectedViewRevision: ready.viewRevision,
        outputDirectory: '/unused-capture-output', captureId: 'changed-view',
      })).rejects.toMatchObject({ code: 'PREVIEW_STALE_STATE' });
      expect(f.engine.render).toHaveBeenCalledTimes(2);
      expect(f.screenshot).not.toHaveBeenCalled();
      expect(seams.publishCapture).not.toHaveBeenCalled();
    } finally { await session.dispose(); }
  });

  it('owns and disposes one server/browser/context without a real browser launch', async () => {
    const session = await createPreviewSession({ width: 640, height: 480, headless: false, channel: 'chrome' });
    const ready = await session.load(source());
    expect(ready.commit).toMatchObject({ sceneGeneration: 1, renderer: 'authored-boxes', sceneId: 'browser-driver-test' });
    expect(ready.width).toBe(640);
    expect(ready.height).toBe(480);
    expect(seams.launch).toHaveBeenCalledWith(expect.objectContaining({ headless: false, channel: 'chrome' }));
    expect(f.browser.newContext).toHaveBeenCalledWith({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
    await session.dispose();
    await session.dispose();
    expect(f.context.close).toHaveBeenCalledTimes(1);
    expect(f.browser.close).toHaveBeenCalledTimes(1);
    expect(f.server.dispose).toHaveBeenCalledTimes(1);
    expect(f.engine.dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid and already-aborted initialization without acquiring resources', async () => {
    await expect(createPreviewSession({ width: 0 })).rejects.toMatchObject({ code: 'PREVIEW_INVALID_OPTIONS' });
    for (const key of ['width', 'height', 'headless', 'softwareGpu', 'channel', 'timeoutMs', 'cleanupTimeoutMs']) {
      await expect(createPreviewSession({ [key]: null } as unknown as Parameters<typeof createPreviewSession>[0]))
        .rejects.toMatchObject({ code: 'PREVIEW_INVALID_OPTIONS' });
    }
    const controller = new AbortController();
    controller.abort();
    await expect(createPreviewSession({ signal: controller.signal })).rejects.toMatchObject({ code: 'PREVIEW_ABORTED' });
    expect(seams.startServer).not.toHaveBeenCalled();
    expect(seams.launch).not.toHaveBeenCalled();
  });

  it.each(['launch', 'context', 'page', 'navigation', 'initialize'] as const)('releases acquired resources when %s fails', async stage => {
    const failure = new Error(`Injected ${stage} failure.`);
    if (stage === 'launch') seams.launch.mockRejectedValueOnce(failure);
    else if (stage === 'context') f.browser.newContext.mockRejectedValueOnce(failure);
    else if (stage === 'page') f.context.newPage.mockRejectedValueOnce(failure);
    else if (stage === 'navigation') f.page.goto.mockRejectedValueOnce(failure);
    else seams.createEngine.mockRejectedValueOnce(failure);
    await expect(createPreviewSession()).rejects.toThrow(failure.message);
    expect(f.server.dispose).toHaveBeenCalled();
    if (stage !== 'launch') expect(f.browser.close).toHaveBeenCalled();
    if (stage !== 'launch' && stage !== 'context') expect(f.context.close).toHaveBeenCalled();
  });

  it.each(['server', 'browser', 'context'] as const)('releases a late-acquired %s after factory cancellation', async stage => {
    const entered = deferred();
    const release = deferred();
    const cleaned = deferred();
    if (stage === 'server') {
      seams.startServer.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return f.server; });
      f.server.dispose.mockImplementation(async () => { cleaned.resolve(); });
    } else if (stage === 'browser') {
      seams.launch.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return f.browser; });
      f.browser.close.mockImplementation(async () => { cleaned.resolve(); });
    } else {
      f.browser.newContext.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return f.context; });
      f.context.close.mockImplementation(async () => { cleaned.resolve(); });
    }
    const controller = new AbortController();
    const pending = createPreviewSession({ signal: controller.signal });
    const failed = expect(pending).rejects.toMatchObject({ code: 'PREVIEW_ABORTED' });
    await entered.promise;
    controller.abort();
    await failed;
    release.resolve();
    await cleaned.promise;
    expect(f.server.dispose).toHaveBeenCalled();
    if (stage !== 'server') expect(f.browser.close).toHaveBeenCalled();
    if (stage === 'context') expect(f.context.close).toHaveBeenCalled();
  });

  it('closes a session when abort wins the factory result-delivery microtask', async () => {
    const controller = new AbortController();
    seams.sessionConstructed = () => { queueMicrotask(() => controller.abort()); };
    await expect(createPreviewSession({ signal: controller.signal })).rejects.toMatchObject({ code: 'PREVIEW_ABORTED' });
    expect(f.context.close).toHaveBeenCalled();
    expect(f.browser.close).toHaveBeenCalled();
    expect(f.server.dispose).toHaveBeenCalled();
  });

  it('rejects a failed initial observation instead of returning an unhealthy initialized session', async () => {
    f.engine.gpuErrorCount = 1;
    await expect(createPreviewSession()).rejects.toMatchObject({ code: 'PREVIEW_INITIALIZE_FAILED' });
    expect(f.context.close).toHaveBeenCalled();
    expect(f.browser.close).toHaveBeenCalled();
    expect(f.server.dispose).toHaveBeenCalled();
    expect(f.engine.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes an engine arriving after canceled initialization without reviving the client', async () => {
    const entered = deferred<AbortSignal>();
    const release = deferred();
    const disposed = deferred();
    seams.createEngine.mockImplementationOnce(async (options: { signal: AbortSignal }) => {
      entered.resolve(options.signal);
      await release.promise;
      return f.engine;
    });
    f.engine.dispose.mockImplementation(() => { f.engine.state = 'disposed'; disposed.resolve(); });
    const controller = new AbortController();
    const pending = createPreviewSession({ signal: controller.signal });
    const failed = expect(pending).rejects.toMatchObject({ code: 'PREVIEW_ABORTED' });
    const browserSignal = await entered.promise;
    controller.abort();
    await failed;
    expect(browserSignal.aborted).toBe(true);
    expect(f.engine.dispose).not.toHaveBeenCalled();
    expect(f.context.close).toHaveBeenCalledTimes(1);
    release.resolve();
    await disposed.promise;
    expect(f.engine.dispose).toHaveBeenCalledTimes(1);
    const bridge = (globalThis as unknown as { __strataPreview: { request(request: { id: string; method: string; data: unknown }): Promise<unknown> } }).__strataPreview;
    await expect(bridge.request({ id: 'after-disposal', method: 'initialize', data: null })).resolves.toMatchObject({
      ok: false, error: { code: 'PREVIEW_DISPOSED' },
    });
    expect(seams.createEngine).toHaveBeenCalledTimes(1);
  });

  it('remembers cancellation delivered before its browser request is admitted', async () => {
    const session = await createPreviewSession();
    const entered = deferred();
    const release = deferred();
    const canceled = deferred();
    let held = false;
    f.holdRequestAdmission(async method => {
      if (method === 'load' && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
    });
    f.holdCancelReturn(async () => { canceled.resolve(); });
    const first = session.load(source());
    const failed = expect(first).rejects.toMatchObject({ code: 'PREVIEW_SUPERSEDED' });
    await entered.promise;
    const second = session.load(source());
    await failed;
    await canceled.promise;
    expect(f.engine.setScene).not.toHaveBeenCalled();
    release.resolve();
    const ready = await second;
    expect(ready.commit.sceneGeneration).toBe(1);
    expect(f.engine.setScene).toHaveBeenCalledTimes(1);
    expect(f.requests.filter(request => request.method === 'load')).toHaveLength(2);
    await session.dispose();
  });

  it('keeps request ownership through browser work and cancellation-delivery settlement', async () => {
    const session = await createPreviewSession();
    const loadEntered = deferred<AbortSignal>();
    const releaseLoad = deferred();
    const cancelEntered = deferred();
    const releaseCancel = deferred();
    f.holdCancelReturn(async () => { cancelEntered.resolve(); await releaseCancel.promise; });
    f.engine.setScene.mockImplementationOnce(async options => {
      loadEntered.resolve(options.signal);
      await releaseLoad.promise;
      if (options.signal.aborted) throw Object.assign(new Error('Fake Core aborted its load.'), { code: 'SCENE_LOAD_ABORTED' });
      return f.engine.commit(options.scene);
    });
    const first = session.load(source());
    const failed = expect(first).rejects.toMatchObject({ code: 'PREVIEW_SUPERSEDED' });
    const browserSignal = await loadEntered.promise;
    const second = session.load(source());
    await failed;
    await cancelEntered.promise;
    expect(browserSignal.aborted).toBe(true);
    expect(f.engine.setScene).toHaveBeenCalledTimes(1);
    releaseLoad.resolve();
    await Promise.resolve();
    expect(f.engine.setScene).toHaveBeenCalledTimes(1);
    releaseCancel.resolve();
    const ready = await second;
    expect(ready.commit.sceneGeneration).toBe(1);
    expect(f.engine.setScene).toHaveBeenCalledTimes(2);
    expect(f.cancelIds).toEqual([f.requests.find(request => request.method === 'load')!.id]);
    await session.dispose();
  });

  it('carries a real SceneCommitError through client serialization and Node wrapping', async () => {
    const session = await createPreviewSession();
    const prior = await session.load(source());
    let historical: SceneCommitReceipt | undefined;
    f.engine.setScene.mockImplementationOnce(async options => {
      historical = f.engine.commit(options.scene);
      // Another identity is already current when cleanup failure is observed;
      // the error must retain the exact receipt of its own earlier commit.
      f.engine.commit(options.scene);
      throw new CoreSceneCommitError(historical, new Error('Previous renderer disposal failed.'));
    });
    const changed = source();
    changed.scene.entities[0]!.transform.position[0] = 1;
    changed.revision = sceneRevision(changed.scene);
    await expect(session.load(changed)).rejects.toMatchObject({
      code: 'SCENE_LOAD_FAILED', stage: 'set-scene',
      details: { commitOccurred: true, committedReceipt: expect.objectContaining({ sceneGeneration: 2 }), committedScene: expect.objectContaining({ sceneGeneration: 2 }) },
    });
    const state = await session.observe();
    expect(state.ready).toBeNull();
    expect(state.driver.commit).toMatchObject({ sceneGeneration: 3 });
    expect(state.driver.commit).not.toEqual(historical);
    expect(state.driver.commit).not.toEqual(prior.commit);
    expect(f.engine.render).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it.each(['pageerror', 'crash', 'disconnected'] as const)('makes %s failure permanent and releases the browser', async event => {
    const session = await createPreviewSession();
    await session.load(source());
    if (event === 'disconnected') f.browserEvents.emit(event);
    else f.pageEvents.emit(event, new Error('Injected page failure.'));
    expect((await session.observe()).state).toBe('faulted');
    await expect(session.load(source())).rejects.toMatchObject({ code: 'PREVIEW_DRIVER_FAILED' });
    await session.dispose();
    expect(f.context.close).toHaveBeenCalledTimes(1);
    expect(f.browser.close).toHaveBeenCalledTimes(1);
    expect(f.server.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(['pageerror', 'crash', 'disconnected'] as const)('keeps %s authoritative when an earlier healthy observation arrives late', async event => {
    const session = await createPreviewSession();
    await session.load(source());
    const entered = deferred();
    const release = deferred();
    f.holdRequestReturn(async method => {
      if (method === 'observe') { entered.resolve(); await release.promise; }
    });
    const pending = session.observe();
    await entered.promise;
    if (event === 'disconnected') f.browserEvents.emit(event);
    else f.pageEvents.emit(event, new Error('Failure after the browser produced a healthy observation.'));
    release.resolve();
    await expect(pending).resolves.toMatchObject({ state: 'faulted', ready: null, driver: { status: 'failed' } });
    await expect(session.load(source())).rejects.toMatchObject({ code: 'PREVIEW_DRIVER_FAILED' });
    await session.dispose();
    expect(f.engine.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'rejection'] as const)('keeps disposal authoritative when a pending observation ends in %s', async outcome => {
    const session = await createPreviewSession();
    await session.load(source());
    const entered = deferred();
    const release = deferred();
    f.holdRequestReturn(async method => {
      if (method === 'observe') { entered.resolve(); await release.promise; }
    });
    // A response already buffered by the transport can settle after close.
    f.context.close.mockResolvedValueOnce(undefined);
    const pending = session.observe();
    await entered.promise;
    await session.dispose();
    f.pageEvents.emit('pageerror', new Error('Disposal remains authoritative over concurrent page failure.'));
    if (outcome === 'success') release.resolve();
    else release.reject(new Error('The observation transport failed during disposal.'));
    await expect(pending).resolves.toMatchObject({ state: 'disposed', ready: null, driver: { status: 'disposed' } });
    await expect(session.load(source())).rejects.toMatchObject({ code: 'PREVIEW_DISPOSED' });
    expect(f.engine.dispose).toHaveBeenCalledTimes(1);
    expect(f.context.close).toHaveBeenCalledTimes(1);
  });

  it('does not publish a capture when a page failure overtakes the observation after screenshot', async () => {
    const session = await createPreviewSession();
    const ready = await session.load(source());
    const entered = deferred();
    const release = deferred();
    let screenshotTaken = false;
    f.screenshot.mockImplementationOnce(async () => { screenshotTaken = true; return Buffer.from([1, 2, 3]); });
    f.holdRequestReturn(async method => {
      if (method === 'observe' && screenshotTaken) { entered.resolve(); await release.promise; }
    });
    const pending = session.capture({
      expectedRevision: ready.sourceRevision, expectedLoadId: ready.loadId, expectedViewRevision: ready.viewRevision,
      outputDirectory: '/unused-capture-output', captureId: 'failed-after-screenshot',
    });
    const failed = expect(pending).rejects.toMatchObject({ code: 'PREVIEW_DRIVER_FAILED' });
    await entered.promise;
    expect(f.screenshot).toHaveBeenCalledTimes(1);
    f.pageEvents.emit('pageerror', new Error('Page failed after screenshot before observation settled.'));
    release.resolve();
    await failed;
    expect(seams.publishCapture).not.toHaveBeenCalled();
    expect((await session.observe()).ready).toBeNull();
    await session.dispose();
  });

  it('continues closing browser and server when context cleanup rejects', async () => {
    const session = await createPreviewSession();
    f.context.close.mockRejectedValueOnce(new Error('Context close failed.'));
    await expect(session.dispose()).rejects.toMatchObject({ code: 'PREVIEW_DISPOSE_FAILED' });
    expect(f.browser.close).toHaveBeenCalledTimes(1);
    expect(f.server.dispose).toHaveBeenCalledTimes(1);
    await expect(session.dispose()).rejects.toMatchObject({ code: 'PREVIEW_DISPOSE_FAILED' });
    expect(f.context.close).toHaveBeenCalledTimes(1);
    expect(f.engine.dispose).toHaveBeenCalledTimes(1);
  });

  it('bounds a hung context close while releasing other resources and observing its late failure', async () => {
    const session = await createPreviewSession({ cleanupTimeoutMs: 20 });
    vi.useFakeTimers();
    const closing = deferred();
    const release = deferred();
    f.context.close.mockImplementationOnce(async () => { closing.resolve(); await release.promise; });
    const pending = session.dispose();
    const failed = expect(pending).rejects.toMatchObject({
      code: 'PREVIEW_DISPOSE_FAILED', details: { unresolvedResources: ['context'] },
    });
    await closing.promise;
    expect(f.engine.dispose).toHaveBeenCalledTimes(1);
    expect(f.browser.close).toHaveBeenCalledTimes(1);
    expect(f.server.dispose).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(21);
    await failed;
    release.reject(new Error('Late context failure remains observed.'));
    await expect(session.dispose()).rejects.toMatchObject({ code: 'PREVIEW_DISPOSE_FAILED' });
    expect(f.context.close).toHaveBeenCalledTimes(1);
  });
});
