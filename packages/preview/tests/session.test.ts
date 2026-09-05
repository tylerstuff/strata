import { createHash } from 'node:crypto';
import { link, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publishCapture, type CapturePublication, type PublishCaptureOptions } from '../src/artifacts.js';
import type { PreviewDriver, PreviewDriverFrame } from '../src/driver.js';
import { PreviewError } from '../src/errors.js';
import { PreviewSession, type PreviewReadyReceipt } from '../src/session.js';

// These are deliberately tiny test payloads for the generic orchestration seam,
// not another runtime scene schema or a substitute for Core descriptor validation.
interface Scene { id: string; revision: string; position: number[] }
interface View { camera: { position: number[] }; debugView: 'final' | 'base-color'; timeSeconds: number }
interface Input { scene: Scene; view: View }
interface Commit {
  sceneGeneration: number;
  renderer: 'authored-boxes';
  sceneId: string;
  sourceRevision: string;
}
interface Metrics { frameId: number; scene: Commit; position: number[] }

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function input(revision = 'revision-a'): Input {
  return {
    scene: { id: 'scene-a', revision, position: [0, 0, -3] },
    view: { camera: { position: [0, 0, 0] }, debugView: 'final', timeSeconds: 0 },
  };
}

class FakeDriver implements PreviewDriver<Scene, View, Commit, Metrics> {
  events: string[] = [];
  status: 'ready' | 'lost' | 'disposed' | 'failed' = 'ready';
  active: Commit | null = null;
  generation = 0;
  frames = 0;
  lastSubmittedFrameId: number | null = null;
  width = 64;
  height = 64;
  scene: Scene | null = null;
  gpuErrorCount = 0;
  disposeCalls = 0;
  loadInputs: Scene[] = [];
  renderInputs: View[] = [];
  png = Uint8Array.from([1, 2, 3, 4]);
  gpuSamples: { frameId: number; sample: unknown }[] = [];
  gpuTimingUnavailableReason: string | undefined;
  frameOverride: Partial<PreviewDriverFrame<Commit, Metrics>> = {};
  onSetScene?: (scene: Scene, signal: AbortSignal, commit: () => Commit) => Promise<Commit>;
  onRender?: (view: View, signal: AbortSignal) => Promise<void>;
  onFence?: (signal: AbortSignal) => Promise<void>;
  onScreenshot?: (signal: AbortSignal) => Promise<void>;
  onObserve?: () => Promise<void>;
  onDispose?: () => Promise<void>;

  prepareLoad(value: unknown) {
    this.events.push('prepare');
    const prepared = value as Input;
    // Return references intentionally: the session must snapshot before its first await.
    return { scene: prepared.scene, view: prepared.view, sceneId: prepared.scene.id, sourceRevision: prepared.scene.revision };
  }

  async observe() {
    this.events.push('observe');
    await this.onObserve?.();
    return {
      status: this.status, commit: this.active === null ? null : structuredClone(this.active),
      width: this.width, height: this.height, lastSubmittedFrameId: this.lastSubmittedFrameId,
      telemetry: { submittedFrames: this.frames, gpuErrorCount: this.gpuErrorCount },
      environment: { browser: 'fake-browser', adapter: 'fake-cpu-driver' },
      gpuSamples: structuredClone(this.gpuSamples),
      ...(this.gpuTimingUnavailableReason === undefined ? {} : { gpuTimingUnavailableReason: this.gpuTimingUnavailableReason }),
    };
  }

  commit(scene: Scene): Commit {
    const receipt: Commit = {
      sceneGeneration: ++this.generation, renderer: 'authored-boxes', sceneId: scene.id, sourceRevision: scene.revision,
    };
    this.events.push(`commit:${receipt.sceneGeneration}`);
    this.active = structuredClone(receipt);
    this.scene = structuredClone(scene);
    this.lastSubmittedFrameId = null;
    return structuredClone(receipt);
  }

  async setScene(scene: Scene, signal: AbortSignal): Promise<Commit> {
    this.events.push('set-scene');
    this.loadInputs.push(scene);
    return this.onSetScene ? this.onSetScene(scene, signal, () => this.commit(scene)) : this.commit(scene);
  }

  async render(view: View, signal: AbortSignal) {
    this.events.push('render');
    this.renderInputs.push(view);
    await this.onRender?.(view, signal);
    if (this.status !== 'ready') throw new PreviewError('DEVICE_LOST', 'render', 'Fake device is unavailable.');
    if (this.active === null || this.scene === null) throw new Error('Fake driver has no committed scene.');
    // The fake only increments after the injected encode/submit failure point.
    const frameId = ++this.frames;
    this.lastSubmittedFrameId = frameId;
    return {
      commit: structuredClone(this.active), frameId, width: this.width, height: this.height,
      resolvedView: {
        camera: structuredClone(view.camera), aspect: this.width / this.height,
        width: this.width, height: this.height, debugView: view.debugView, timeSeconds: view.timeSeconds,
      },
      metrics: { frameId, scene: structuredClone(this.active), position: [...this.scene.position] },
      ...this.frameOverride,
    };
  }

  async resize(width: number, height: number, _signal: AbortSignal) {
    this.events.push('resize');
    this.width = width;
    this.height = height;
  }

  async waitForIdle(signal: AbortSignal) {
    this.events.push('fence');
    await this.onFence?.(signal);
  }

  async screenshot(signal: AbortSignal) {
    this.events.push('screenshot');
    await this.onScreenshot?.(signal);
    return this.png;
  }

  committedReceipt(error: unknown): Commit | undefined {
    return error instanceof PreviewError ? error.details.committedReceipt as Commit | undefined : undefined;
  }

  async dispose() {
    this.events.push('dispose');
    this.disposeCalls++;
    this.status = 'disposed';
    await this.onDispose?.();
  }
}

class FakePublisher {
  calls: PublishCaptureOptions[] = [];
  published: CapturePublication[] = [];
  beforePublication?: (options: PublishCaptureOptions) => Promise<void>;
  duringPublication?: () => Promise<void>;
  afterPublication?: () => Promise<void>;

  constructor(readonly driver: FakeDriver) {}

  publish = async (options: PublishCaptureOptions): Promise<CapturePublication> => {
    this.calls.push(options);
    await this.beforePublication?.(options);
    if (options.signal?.aborted) throw new PreviewError('PREVIEW_ABORTED', 'publish', 'Canceled before publication.');
    const receipt = options.createReceipt({
      relativePath: 'image.png', width: this.driver.width, height: this.driver.height,
      sha256: createHash('sha256').update(options.png).digest('hex'), bytes: options.png.byteLength,
    });
    const publication: CapturePublication = {
      imagePath: `${options.outputDirectory}/${options.captureId}/image.png`,
      receiptPath: `${options.outputDirectory}/${options.captureId}/receipt.json`, receipt, cleanupWarnings: [],
    };
    const publish = async () => {
      await this.duringPublication?.();
      this.published.push(publication);
    };
    if (options.commit) await options.commit(publish);
    else await publish();
    await this.afterPublication?.();
    return publication;
  };
}

function fixture() {
  const driver = new FakeDriver();
  const publisher = new FakePublisher(driver);
  const session = new PreviewSession(driver, { publish: publisher.publish });
  return { driver, publisher, session };
}

function captureRequest(ready: PreviewReadyReceipt<Commit>) {
  return {
    expectedRevision: ready.sourceRevision, expectedLoadId: ready.loadId, expectedViewRevision: ready.viewRevision,
    outputDirectory: '/fake-output', captureId: 'capture-a',
  };
}

async function failure(promise: Promise<unknown>): Promise<PreviewError> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(PreviewError);
    return error as PreviewError;
  }
  throw new Error('Expected this operation to fail.');
}

describe('PreviewSession with a controllable CPU driver', () => {
  it('snapshots accepted scene and view data before asynchronous driver work', async () => {
    const { driver, session } = fixture();
    const entered = deferred();
    const resume = deferred();
    driver.onSetScene = async (_scene, _signal, commit) => {
      entered.resolve();
      await resume.promise;
      return commit();
    };
    const source = input();
    const pending = session.load(source);
    source.scene.position[0] = 999;
    source.view.camera.position[0] = 888;
    await entered.promise;
    resume.resolve();
    await pending;
    expect(driver.loadInputs[0]!.position).toEqual([0, 0, -3]);
    expect(driver.renderInputs[0]!.camera.position).toEqual([0, 0, 0]);
    await session.dispose();
  });

  it('binds source, commit, effective view and every submitted frame into the capture receipt', async () => {
    const { driver, publisher, session } = fixture();
    const ready = await session.load(input());
    expect(ready.commit.sceneGeneration).toBe(1);
    expect(ready.frameId).toBe(1);
    const result = await session.capture({ ...captureRequest(ready), frames: 2 });
    expect(result.receipt).toMatchObject({
      format: 'strata.preview.capture', version: 1, sessionId: session.sessionId,
      sceneId: ready.sceneId, sourceRevision: ready.sourceRevision, commit: ready.commit,
      loadId: ready.loadId, viewRevision: ready.viewRevision, resolvedView: ready.resolvedView,
      submittedFrameIds: [2, 3], frameId: 3,
      frames: [{ frameId: 2, scene: ready.commit }, { frameId: 3, scene: ready.commit }],
      gpuCompletion: { fencedThroughFrameId: 3 }, presentedFrameId: null,
      telemetry: { submittedFrames: 3, gpuErrorCount: 0 },
      environment: { browser: 'fake-browser', adapter: 'fake-cpu-driver' },
    });
    expect(driver.events.lastIndexOf('fence')).toBeLessThan(driver.events.lastIndexOf('screenshot'));
    expect(publisher.published).toHaveLength(1);
    expect((await session.observe()).state).toBe('ready');
    await session.dispose();
  });

  it('uses distinct commit identities when the same source revision is loaded twice', async () => {
    const { session } = fixture();
    const first = await session.load(input());
    const second = await session.load(input());
    expect(second.sourceRevision).toBe(first.sourceRevision);
    expect(second.commit.sceneGeneration).toBe(first.commit.sceneGeneration + 1);
    expect(second.loadId).not.toBe(first.loadId);
    expect(second.viewRevision).toBe(first.viewRevision);
    expect((await failure(session.capture(captureRequest(first)))).code).toBe('PREVIEW_STALE_STATE');
    await session.dispose();
  });

  it('changes the effective view digest for camera and viewport changes without rewriting source identity', async () => {
    const { session } = fixture();
    const first = await session.load(input());
    const moved = input();
    moved.view.camera.position[0] = 2;
    const camera = await session.load(moved);
    expect(camera.sourceRevision).toBe(first.sourceRevision);
    expect(camera.viewRevision).not.toBe(first.viewRevision);
    const resized = await session.resize(128, 64);
    expect(resized.commit).toEqual(camera.commit);
    expect(resized.loadId).toBe(camera.loadId);
    expect(resized.sourceRevision).toBe(first.sourceRevision);
    expect(resized.viewRevision).not.toBe(camera.viewRevision);
    expect(resized.resolvedView).toMatchObject({ width: 128, height: 64, aspect: 2 });
    await session.dispose();
  });

  it('keeps the previous ready scene after a precommit load failure', async () => {
    const { driver, session } = fixture();
    const previous = await session.load(input());
    driver.onSetScene = async () => { throw new PreviewError('SCENE_LOAD_FAILED', 'allocate', 'Allocation failed.'); };
    const error = await failure(session.load(input('revision-b')));
    expect(error.details).toMatchObject({ commitOccurred: false, committedReceipt: null, lastObservedCommit: previous.commit });
    expect((await session.observe()).ready).toEqual(previous);
    expect(driver.frames).toBe(1);
    await session.dispose();
  });

  it('reports an explicit postcommit cleanup receipt instead of pretending the old scene survived', async () => {
    const { driver, session } = fixture();
    const previous = await session.load(input());
    let committed: Commit | undefined;
    driver.onSetScene = async (_scene, _signal, commit) => {
      committed = commit();
      throw new PreviewError('SCENE_CLEANUP_FAILED', 'retire', 'Old renderer cleanup failed.', { committedReceipt: committed });
    };
    const error = await failure(session.load(input('revision-b')));
    expect(error.details).toMatchObject({ commitOccurred: true, committedReceipt: committed, lastObservedCommit: committed });
    expect(driver.active).toEqual(committed);
    expect(driver.active).not.toEqual(previous.commit);
    const state = await session.observe();
    expect(state.state).toBe('unready');
    expect(state.ready).toBeNull();
    expect(driver.lastSubmittedFrameId).toBeNull();
    await session.dispose();
  });

  it('retains the exact historical commit receipt when another commit precedes its promise continuation', async () => {
    const { driver, session } = fixture();
    const committed = deferred<Commit>();
    const returnReceipt = deferred();
    driver.onSetScene = async (_scene, _signal, commit) => {
      const exact = commit();
      committed.resolve(exact);
      await returnReceipt.promise;
      return exact;
    };
    const loading = session.load(input());
    const failed = failure(loading);
    const historical = await committed.promise;
    const current = driver.commit(input('revision-b').scene);
    returnReceipt.resolve();
    const error = await failed;
    expect(error.code).toBe('PREVIEW_STALE_STATE');
    expect(error.details).toMatchObject({ commitOccurred: true, committedReceipt: historical, lastObservedCommit: current });
    expect(driver.frames).toBe(0);
    expect((await session.observe()).ready).toBeNull();
    await session.dispose();
  });

  it('supersedes a delayed load while retaining mutation ownership until it settles', async () => {
    const { driver, session } = fixture();
    const firstEntered = deferred();
    const releaseFirst = deferred();
    driver.onSetScene = async (_scene, signal, commit) => {
      if (driver.loadInputs.length === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
        if (signal.aborted) throw signal.reason;
      }
      return commit();
    };
    const first = failure(session.load(input()));
    await firstEntered.promise;
    const second = session.load(input('revision-b'));
    expect((await first).code).toBe('PREVIEW_SUPERSEDED');
    expect(driver.loadInputs).toHaveLength(1);
    releaseFirst.resolve();
    const ready = await second;
    expect(driver.loadInputs).toHaveLength(2);
    expect(ready.sourceRevision).toBe('revision-b');
    expect(driver.frames).toBe(1);
    await session.dispose();
  });

  it('does not manufacture a submitted frame when readiness rendering fails after commit', async () => {
    const { driver, session } = fixture();
    await session.load(input());
    driver.onRender = async () => { throw new PreviewError('RENDER_FAILED', 'submit', 'Queue submission failed.'); };
    const error = await failure(session.load(input('revision-b')));
    expect(error.details).toMatchObject({ commitOccurred: true, committedReceipt: driver.active });
    expect(driver.frames).toBe(1);
    expect(driver.lastSubmittedFrameId).toBeNull();
    expect((await session.observe()).ready).toBeNull();
    await session.dispose();
  });

  it('rejects stale source, load and view tokens before rendering or publishing', async () => {
    const { driver, publisher, session } = fixture();
    const ready = await session.load(input());
    for (const token of ['expectedRevision', 'expectedLoadId', 'expectedViewRevision'] as const) {
      const error = await failure(session.capture({ ...captureRequest(ready), [token]: 'stale' }));
      expect(error.code).toBe('PREVIEW_STALE_STATE');
    }
    expect(driver.frames).toBe(1);
    expect(publisher.calls).toHaveLength(0);
    expect((await session.observe()).state).toBe('ready');
    await session.dispose();
  });

  it('rejects mutations throughout screenshot and publication without queuing them', async () => {
    const { driver, publisher, session } = fixture();
    const ready = await session.load(input());
    const screenshot = deferred();
    const releaseScreenshot = deferred();
    driver.onScreenshot = async () => { screenshot.resolve(); await releaseScreenshot.promise; };
    const capturing = session.capture(captureRequest(ready));
    await screenshot.promise;
    for (const operation of [
      session.load(input('revision-b')), session.resize(128, 64), session.capture(captureRequest(ready)),
    ]) expect((await failure(operation)).code).toBe('PREVIEW_BUSY');
    expect(driver.loadInputs).toHaveLength(1);
    expect(driver.events).not.toContain('resize');
    releaseScreenshot.resolve();
    await capturing;
    expect(publisher.published).toHaveLength(1);
    await session.dispose();
  });

  it('rejects a foreign submission or resize during screenshot before publishing any receipt', async () => {
    for (const mutation of ['frame', 'viewport', 'commit'] as const) {
      const { driver, publisher, session } = fixture();
      const ready = await session.load(input());
      driver.onScreenshot = async () => {
        if (mutation === 'frame') driver.lastSubmittedFrameId = ++driver.frames;
        else if (mutation === 'viewport') driver.width = 128;
        else driver.commit(input('foreign-revision').scene);
      };
      expect((await failure(session.capture(captureRequest(ready)))).code).toBe('PREVIEW_STALE_STATE');
      expect(publisher.calls).toHaveLength(0);
      await session.dispose();
    }
  });

  it('invalidates readiness after a capture render failure and records no submitted frame', async () => {
    const { driver, publisher, session } = fixture();
    const ready = await session.load(input());
    driver.onRender = async () => { throw new PreviewError('RENDER_FAILED', 'encode', 'Encoding failed.'); };
    expect((await failure(session.capture(captureRequest(ready)))).code).toBe('RENDER_FAILED');
    expect(driver.frames).toBe(1);
    expect(driver.lastSubmittedFrameId).toBe(ready.frameId);
    expect(publisher.calls).toHaveLength(0);
    expect((await session.observe()).ready).toBeNull();
    await session.dispose();
  });

  it('invalidates readiness if submitted capture work fails at the GPU fence', async () => {
    const { driver, publisher, session } = fixture();
    const ready = await session.load(input());
    driver.onFence = async () => { throw new PreviewError('GPU_WORK_FAILED', 'fence', 'GPU work failed.'); };
    expect((await failure(session.capture(captureRequest(ready)))).code).toBe('GPU_WORK_FAILED');
    expect(driver.frames).toBe(2);
    expect(publisher.calls).toHaveLength(0);
    expect((await session.observe()).ready).toBeNull();
    await session.dispose();
  });

  it('keeps a healthy rendered session reusable after an output write failure', async () => {
    const { publisher, session } = fixture();
    const ready = await session.load(input());
    publisher.beforePublication = async () => { throw new PreviewError('PREVIEW_ARTIFACT_IO', 'write-image', 'Disk full.'); };
    expect((await failure(session.capture(captureRequest(ready)))).code).toBe('PREVIEW_ARTIFACT_IO');
    expect(publisher.published).toHaveLength(0);
    const state = await session.observe();
    expect(state.state).toBe('ready');
    delete publisher.beforePublication;
    await session.capture(captureRequest(state.ready!));
    expect(publisher.published).toHaveLength(1);
    await session.dispose();
  });

  it('does not publish when cancellation arrives before the publication barrier', async () => {
    const { publisher, session } = fixture();
    const ready = await session.load(input());
    const entered = deferred();
    const resume = deferred();
    publisher.beforePublication = async () => { entered.resolve(); await resume.promise; };
    const controller = new AbortController();
    const canceled = failure(session.capture(captureRequest(ready), { signal: controller.signal }));
    await entered.promise;
    controller.abort();
    expect((await canceled).code).toBe('PREVIEW_ABORTED');
    expect((await failure(session.resize(128, 64))).code).toBe('PREVIEW_BUSY');
    resume.resolve();
    await session.dispose();
    expect(publisher.published).toHaveLength(0);
  });

  it('lets successful atomic publication win cancellation while the publication syscall is pending', async () => {
    const { publisher, session } = fixture();
    const ready = await session.load(input());
    const publishing = deferred();
    const finishPublication = deferred();
    publisher.duringPublication = async () => { publishing.resolve(); await finishPublication.promise; };
    const controller = new AbortController();
    let settled = false;
    const capture = session.capture(captureRequest(ready), { signal: controller.signal });
    void capture.then(() => { settled = true; }, () => { settled = true; });
    await publishing.promise;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect((await failure(session.resize(128, 64))).code).toBe('PREVIEW_BUSY');
    finishPublication.resolve();
    const result = await capture;
    expect(result).toBe(publisher.published[0]);
    expect(publisher.published).toHaveLength(1);
    await session.dispose();
  });

  it('reports publication failure truthfully when cancellation races with the failed syscall', async () => {
    const { publisher, session } = fixture();
    const ready = await session.load(input());
    const publishing = deferred();
    const finishPublication = deferred();
    publisher.duringPublication = async () => {
      publishing.resolve();
      await finishPublication.promise;
      throw new PreviewError('PREVIEW_ARTIFACT_IO', 'publish-receipt', 'Receipt publication failed.');
    };
    const controller = new AbortController();
    const failed = failure(session.capture(captureRequest(ready), { signal: controller.signal }));
    await publishing.promise;
    controller.abort();
    finishPublication.resolve();
    expect((await failed).code).toBe('PREVIEW_ARTIFACT_IO');
    expect(publisher.published).toHaveLength(0);
    await session.dispose();
  });

  it('does not expose a ready receipt for a lost driver and rejects further capture', async () => {
    const { driver, publisher, session } = fixture();
    const ready = await session.load(input());
    driver.status = 'lost';
    const state = await session.observe();
    expect(state.state).toBe('lost');
    expect(state.ready).toBeNull();
    expect((await failure(session.capture(captureRequest(ready)))).code).toBe('PREVIEW_DEVICE_LOST');
    expect(publisher.calls).toHaveLength(0);
    await session.dispose();
    expect(driver.disposeCalls).toBe(1);
  });

  it('does not resurrect readiness when a previously committed load returns after disposal', async () => {
    const { driver, session } = fixture();
    const committed = deferred();
    const releaseReceipt = deferred();
    driver.onSetScene = async (_scene, _signal, commit) => {
      const receipt = commit();
      committed.resolve();
      await releaseReceipt.promise;
      return receipt;
    };
    const failed = failure(session.load(input()));
    await committed.promise;
    await session.dispose();
    await session.dispose();
    expect((await failed).code).toBe('PREVIEW_DISPOSED');
    releaseReceipt.resolve();
    await Promise.resolve();
    const state = await session.observe();
    expect(state.state).toBe('disposed');
    expect(state.ready).toBeNull();
    expect(driver.frames).toBe(0);
    expect(driver.disposeCalls).toBe(1);
  });

  it('does not let invalid preparation supersede a valid pending load', async () => {
    const { driver, session } = fixture();
    const entered = deferred<AbortSignal>();
    const resume = deferred();
    driver.onSetScene = async (_scene, signal, commit) => { entered.resolve(signal); await resume.promise; return commit(); };
    const pending = session.load(input());
    const signal = await entered.promise;
    const invalid = input();
    invalid.scene.id = '';
    expect((await failure(session.load(invalid))).code).toBe('PREVIEW_INVALID_OPTIONS');
    expect(signal.aborted).toBe(false);
    resume.resolve();
    const ready = await pending;
    expect(ready.sceneId).toBe('scene-a');
    expect(driver.loadInputs).toHaveLength(1);
    await session.dispose();
  });

  it('rejects mismatched scene, frame sequence and viewport evidence before publication', async () => {
    for (const mismatch of ['commit', 'frameId', 'width'] as const) {
      const { driver, publisher, session } = fixture();
      const ready = await session.load(input());
      driver.frameOverride = mismatch === 'commit' ? { commit: { ...ready.commit, sceneGeneration: 999 } }
        : mismatch === 'frameId' ? { frameId: ready.frameId } : { width: 128 };
      expect((await failure(session.capture(captureRequest(ready)))).code).toBe('PREVIEW_FRAME_MISMATCH');
      expect(publisher.published).toHaveLength(0);
      expect((await session.observe()).ready).toBeNull();
      await session.dispose();
    }
  });

  it('records only GPU samples belonging to captured frames and keeps missing timing explicit', async () => {
    const { driver, session } = fixture();
    const ready = await session.load(input());
    driver.gpuSamples = [
      { frameId: 1, sample: { gpuMs: 100 } },
      { frameId: 2, sample: { gpuMs: 0.25 } },
      { frameId: 999, sample: { gpuMs: 200 } },
    ];
    driver.gpuTimingUnavailableReason = 'Partial fake readback.';
    const result = await session.capture({ ...captureRequest(ready), frames: 2 });
    expect(result.receipt).toMatchObject({ gpuTimings: [
      { frameId: 2, samples: [{ gpuMs: 0.25 }], unavailableReason: 'Partial fake readback.' },
      { frameId: 3, samples: [], unavailableReason: 'Partial fake readback.' },
    ] });
    await session.dispose();
  });

  it('latches loss and driver failure while asynchronous disposal is pending', async () => {
    for (const unhealthy of ['lost', 'failed'] as const) {
      const { driver, session } = fixture();
      const ready = await session.load(input());
      const disposalEntered = deferred();
      const finishDisposal = deferred();
      driver.onDispose = async () => { disposalEntered.resolve(); await finishDisposal.promise; };
      driver.status = unhealthy;
      expect((await session.observe()).ready).toBeNull();
      await disposalEntered.promise;
      // A late driver callback must not undo the session's terminal failure latch.
      driver.status = 'ready';
      const code = unhealthy === 'lost' ? 'PREVIEW_DEVICE_LOST' : 'PREVIEW_DRIVER_FAILED';
      expect((await failure(session.load(input('revision-b')))).code).toBe(code);
      expect((await failure(session.capture(captureRequest(ready)))).code).toBe(code);
      expect(driver.loadInputs).toHaveLength(1);
      expect((await session.observe()).state).toBe(unhealthy === 'lost' ? 'lost' : 'faulted');
      finishDisposal.resolve();
      await session.dispose();
      expect(driver.disposeCalls).toBe(1);
    }
  });

  it.each(['lost', 'failed'] as const)('latches %s reported only while handling a rejected load', async unhealthy => {
    for (const commitBeforeFailure of [false, true]) {
      const { driver, session } = fixture();
      const previous = await session.load(input());
      const disposalEntered = deferred();
      const finishDisposal = deferred();
      driver.onDispose = async () => { disposalEntered.resolve(); await finishDisposal.promise; };
      let actualCommit: Commit | null = null;
      driver.onSetScene = async (_scene, _signal, commit) => {
        actualCommit = commitBeforeFailure ? commit() : null;
        driver.status = unhealthy;
        throw new PreviewError('INJECTED_SET_SCENE_FAILURE', 'set-scene', 'Failure accompanies a terminal driver observation.',
          actualCommit === null ? {} : { committedReceipt: actualCommit });
      };
      const error = await failure(session.load(input('revision-b')));
      const code = unhealthy === 'lost' ? 'PREVIEW_DEVICE_LOST' : 'PREVIEW_DRIVER_FAILED';
      expect(error.code).toBe(code);
      expect(error.stage).toBe('set-scene');
      expect(error.details).toMatchObject({
        commitOccurred: commitBeforeFailure,
        committedReceipt: actualCommit,
        lastObservedCommit: actualCommit ?? previous.commit,
      });
      await disposalEntered.promise;
      // Only the rejected-load catch observed the failure; recovery must already be forbidden.
      driver.status = 'ready';
      expect((await failure(session.load(input('revision-c')))).code).toBe(code);
      expect((await failure(session.capture(captureRequest(previous)))).code).toBe(code);
      expect(driver.loadInputs).toHaveLength(2);
      expect((await session.observe()).state).toBe(unhealthy === 'lost' ? 'lost' : 'faulted');
      finishDisposal.resolve();
      await session.dispose();
      expect(driver.disposeCalls).toBe(1);
    }
  });

  it('keeps a successful capture artifact when disposal interrupts post-publication cleanup', async () => {
    const { publisher, session } = fixture();
    const ready = await session.load(input());
    const published = deferred();
    const finishCleanup = deferred();
    publisher.afterPublication = async () => { published.resolve(); await finishCleanup.promise; };
    const capturing = session.capture(captureRequest(ready));
    await published.promise;
    await session.dispose();
    finishCleanup.resolve();
    const result = await capturing;
    expect(result).toBe(publisher.published[0]);
    expect((await session.observe()).state).toBe('disposed');
    expect((await session.observe()).ready).toBeNull();
  });

  it.each(['succeed', 'fail'] as const)('integrates native receipt publication with cancellation while the atomic syscall will %s', async outcome => {
    const directory = await mkdtemp(join(tmpdir(), 'strata-preview-session-test-'));
    const driver = new FakeDriver();
    driver.width = driver.height = 1;
    // A real one-pixel fixture; its bytes are only artifact evidence, not renderer output.
    driver.png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');
    const publicationEntered = deferred();
    const finishPublication = deferred();
    const session = new PreviewSession(driver, { publish: options => publishCapture(options, {
      publishReceipt: async (temporary, target) => {
        publicationEntered.resolve();
        await finishPublication.promise;
        if (outcome === 'fail') throw Object.assign(new Error('Injected publication failure.'), { code: 'EIO' });
        await link(temporary, target);
      },
    }) });
    try {
      const ready = await session.load(input());
      const controller = new AbortController();
      const capture = session.capture({ ...captureRequest(ready), outputDirectory: directory }, { signal: controller.signal });
      const observed = capture.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      await publicationEntered.promise;
      controller.abort();
      finishPublication.resolve();
      const result = await observed;
      if (outcome === 'succeed') {
        expect(result.ok).toBe(true);
        if (!result.ok) throw result.error;
        expect(JSON.parse(await readFile(result.value.receiptPath, 'utf8'))).toEqual(result.value.receipt);
        expect(await readFile(result.value.imagePath)).toEqual(Buffer.from(driver.png));
        expect((await readdir(join(directory, 'capture-a'))).sort()).toEqual(['image.png', 'receipt.json']);
      } else {
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('Injected receipt failure unexpectedly succeeded.');
        expect(result.error).toMatchObject({ code: 'PREVIEW_ARTIFACT_IO', details: { publicationOccurred: false } });
        expect(await readdir(directory)).toEqual([]);
      }
    } finally {
      finishPublication.resolve();
      await session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
