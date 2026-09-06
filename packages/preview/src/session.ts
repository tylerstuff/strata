import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '@strata-engine/authoring';
import { publishCapture } from './artifacts.js';
import type { PreviewDriver, PreviewDriverFrame, PreviewDriverObservation, PreparedPreviewLoad } from './driver.js';
import { PreviewError } from './errors.js';
import { OperationGate } from './operation.js';
import type { OperationContext, OperationOptions } from './operation.js';

export interface PreviewReadyReceipt<Commit> {
  sessionId: string;
  loadId: string;
  sceneId: string;
  sourceRevision: string;
  commit: Commit;
  viewRevision: string;
  resolvedView: unknown;
  frameId: number;
  width: number;
  height: number;
}

export interface CaptureRequest {
  expectedRevision: string;
  expectedLoadId: string;
  expectedViewRevision: string;
  outputDirectory: string;
  captureId?: string;
  /** Explicit bounded submissions, with no animation loop. Defaults to one. */
  frames?: number;
}

export interface PreviewSessionOptions {
  defaultTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  /** Test/host seam; must preserve publishCapture's exclusive commit semantics. */
  publish?: typeof publishCapture;
}

interface LoadProgress<Commit> {
  stage: string;
  commitOccurred: boolean | null;
  committedReceipt: Commit | null;
  lastObservedCommit: Commit | null;
}

function frozen<T>(value: T): T {
  const copy = JSON.parse(canonicalJson(value)) as T;
  function freeze(item: unknown): void {
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  }
  freeze(copy);
  return copy;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }

function dimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 16_384 || height > 16_384 || width * height > 64 * 1024 * 1024) {
    throw new PreviewError('PREVIEW_INVALID_OPTIONS', 'viewport', 'Expected positive bounded physical pixel dimensions.');
  }
}

/** CPU orchestration kernel; production browser creation is supplied by a runtime adapter. */
export class PreviewSession<Scene, View, Commit, Frame> {
  readonly sessionId = randomUUID();
  readonly #driver: PreviewDriver<Scene, View, Commit, Frame>;
  readonly #gate: OperationGate;
  readonly #publish: typeof publishCapture;
  #loaded: PreparedPreviewLoad<Scene, View> | null = null;
  #ready: PreviewReadyReceipt<Commit> | null = null;
  #disposePromise: Promise<void> | null = null;
  #terminalError: PreviewError | null = null;

  constructor(driver: PreviewDriver<Scene, View, Commit, Frame>, options: PreviewSessionOptions = {}) {
    this.#driver = driver;
    this.#publish = options.publish ?? publishCapture;
    this.#gate = new OperationGate({
      ...(options.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: options.defaultTimeoutMs }),
      ...(options.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: options.cleanupTimeoutMs }),
      onFault: () => { void this.#disposeDriver().catch(() => {}); },
    });
  }

  async observe(): Promise<{
    sessionId: string; state: 'ready' | 'unready' | 'busy' | 'lost' | 'disposed' | 'faulted';
    ready: PreviewReadyReceipt<Commit> | null; driver: PreviewDriverObservation<Commit>;
  }> {
    const driver = frozen(await this.#driver.observe());
    if (driver.status === 'lost' || driver.status === 'failed') this.#failDriver(driver.status);
    const matches = this.#gate.state === 'open' && this.#terminalError === null && driver.status === 'ready'
      && this.#ready !== null && same(driver.commit, this.#ready.commit)
      && driver.width === this.#ready.width && driver.height === this.#ready.height
      && driver.lastSubmittedFrameId === this.#ready.frameId;
    const state = this.#terminalError ? this.#terminalError.code === 'PREVIEW_DEVICE_LOST' ? 'lost' : 'faulted' : this.#gate.state !== 'open' ? this.#gate.state
      : driver.status !== 'ready' ? driver.status === 'failed' ? 'faulted' : driver.status
        : this.#gate.busy ? 'busy' : matches ? 'ready' : 'unready';
    return frozen({ sessionId: this.sessionId, state, ready: matches ? this.#ready : null, driver });
  }

  load(input: unknown, options: OperationOptions = {}): Promise<PreviewReadyReceipt<Commit>> {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    let prepared: PreparedPreviewLoad<Scene, View>;
    try {
      prepared = frozen(this.#driver.prepareLoad(input));
      if (typeof prepared.sceneId !== 'string' || prepared.sceneId.length === 0
        || typeof prepared.sourceRevision !== 'string' || prepared.sourceRevision.length === 0) {
        throw new PreviewError('PREVIEW_INVALID_OPTIONS', 'prepare-load', 'Adapter must return source identity and revision.');
      }
    } catch (error) { return Promise.reject(error); }
    const progress: LoadProgress<Commit> = {
      stage: 'observe-before-load', commitOccurred: false, committedReceipt: null, lastObservedCommit: null,
    };
    return this.#gate.run('load', options, async context => {
      const before = await this.#observeHealthy(context);
      progress.lastObservedCommit = before.commit;
      progress.stage = 'set-scene';
      progress.commitOccurred = null;
      let commit: Commit;
      try {
        commit = frozen(await this.#driver.setScene(prepared.scene, context.signal));
        progress.commitOccurred = true;
        progress.committedReceipt = commit;
        this.#ready = null;
        this.#loaded = prepared;
      } catch (error) {
        const committed = this.#driver.committedReceipt?.(error);
        if (committed !== undefined) {
          progress.committedReceipt = frozen(committed);
          progress.commitOccurred = true;
          this.#ready = null;
          this.#loaded = prepared;
        }
        const observed = frozen(await this.#driver.observe());
        progress.lastObservedCommit = observed.commit;
        if (progress.commitOccurred === null && same(before.commit, observed.commit)) progress.commitOccurred = false;
        if (!same(before.commit, observed.commit)) this.#ready = null;
        if (observed.status === 'lost' || observed.status === 'failed') {
          this.#failDriver(observed.status);
          throw this.#terminalError;
        }
        throw error;
      }
      context.throwIfAborted();
      progress.stage = 'observe-commit';
      const current = await this.#observeHealthy(context);
      progress.lastObservedCommit = current.commit;
      this.#requireCommit(current, commit);
      progress.stage = 'first-frame';
      const frame = await this.#render(context, prepared.view, commit, current);
      progress.stage = 'gpu-fence';
      await this.#driver.waitForIdle(context.signal);
      context.throwIfAborted();
      const fenced = await this.#observeHealthy(context);
      progress.lastObservedCommit = fenced.commit;
      this.#requireFrozen(fenced, frame);
      this.#ready = this.#receipt(prepared, frame);
      return this.#ready;
    }).catch(error => {
      throw new PreviewError(error instanceof PreviewError ? error.code : 'PREVIEW_LOAD_FAILED', progress.stage,
        error instanceof Error ? error.message : 'Preview load failed.', {
          ...(error instanceof PreviewError ? error.details : {}), ...progress,
        });
    });
  }

  resize(width: number, height: number, options: OperationOptions = {}): Promise<PreviewReadyReceipt<Commit>> {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    try { dimensions(width, height); } catch (error) { return Promise.reject(error); }
    return this.#gate.run('resize', options, async context => {
      const { loaded, ready } = this.#requireReady();
      const before = await this.#observeHealthy(context);
      this.#requireCommit(before, ready.commit);
      this.#ready = null;
      await this.#driver.resize(width, height, context.signal);
      context.throwIfAborted();
      const resized = await this.#observeHealthy(context);
      this.#requireCommit(resized, ready.commit);
      if (resized.width !== width || resized.height !== height) {
        throw new PreviewError('PREVIEW_STALE_STATE', 'resize', 'Driver did not apply the requested physical viewport.');
      }
      const frame = await this.#render(context, loaded.view, ready.commit, resized);
      await this.#driver.waitForIdle(context.signal);
      context.throwIfAborted();
      this.#requireFrozen(await this.#observeHealthy(context), frame);
      this.#ready = this.#receipt(loaded, frame);
      return this.#ready;
    });
  }

  capture(request: CaptureRequest, options: OperationOptions = {}): ReturnType<typeof publishCapture> {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    let capture: Required<CaptureRequest>;
    try {
      const copy = frozen(request);
      if (!copy || typeof copy !== 'object' || Array.isArray(copy)
        || Object.keys(copy).some(key => !['expectedRevision', 'expectedLoadId', 'expectedViewRevision', 'outputDirectory', 'captureId', 'frames'].includes(key))
        || [copy.expectedRevision, copy.expectedLoadId, copy.expectedViewRevision, copy.outputDirectory].some(value => typeof value !== 'string' || value.length === 0)
        || (copy.captureId !== undefined && (typeof copy.captureId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\s\S])/.test(copy.captureId)))
        || (copy.frames !== undefined && (!Number.isInteger(copy.frames) || copy.frames < 1 || copy.frames > 8))) {
        throw new PreviewError('PREVIEW_INVALID_OPTIONS', 'capture', 'Capture requires source, load and view tokens, output directory, and one to eight frames.');
      }
      capture = { ...copy, captureId: copy.captureId ?? randomUUID(), frames: copy.frames ?? 1 };
    } catch (error) {
      return Promise.reject(error instanceof PreviewError ? error
        : new PreviewError('PREVIEW_INVALID_OPTIONS', 'capture', error instanceof Error ? error.message : 'Invalid capture request.'));
    }
    return this.#gate.run('capture', options, async context => {
      const { loaded, ready } = this.#requireReady();
      if (capture.expectedRevision !== ready.sourceRevision || capture.expectedLoadId !== ready.loadId
        || capture.expectedViewRevision !== ready.viewRevision) {
        throw new PreviewError('PREVIEW_STALE_STATE', 'capture', 'Capture tokens do not match the ready scene and view.');
      }
      let state = await this.#observeHealthy(context);
      this.#requireCommit(state, ready.commit);
      if (state.width !== ready.width || state.height !== ready.height || state.lastSubmittedFrameId !== ready.frameId) {
        throw new PreviewError('PREVIEW_STALE_STATE', 'capture', 'Viewport or submitted frame changed outside the session.');
      }
      this.#ready = null;
      const frames: PreviewDriverFrame<Commit, Frame>[] = [];
      for (let index = 0; index < capture.frames; index++) {
        const frame = await this.#render(context, loaded.view, ready.commit, state);
        if (digest(frame.resolvedView) !== ready.viewRevision) {
          throw new PreviewError('PREVIEW_STALE_STATE', 'capture', 'Rendered view does not match the expected view revision.');
        }
        frames.push(frame);
        state = await this.#observeHealthy(context);
        this.#requireFrozen(state, frame);
      }
      const last = frames[frames.length - 1]!;
      await this.#driver.waitForIdle(context.signal);
      context.throwIfAborted();
      const fenced = await this.#observeHealthy(context);
      this.#requireFrozen(fenced, last);
      const screenshot = await this.#driver.screenshot(context.signal);
      if (!(screenshot instanceof Uint8Array)) {
        throw new PreviewError('PREVIEW_IMAGE_MISMATCH', 'capture', 'Driver did not return PNG bytes.');
      }
      const png = Uint8Array.from(screenshot);
      context.throwIfAborted();
      const captured = await this.#observeHealthy(context);
      this.#requireFrozen(captured, last);
      const captureReady = this.#receipt(loaded, last);
      this.#ready = captureReady;
      return this.#publish({
        outputDirectory: capture.outputDirectory, captureId: capture.captureId, png,
        signal: context.signal, commit: publish => context.commit(publish),
        createReceipt: image => {
          if (image.width !== last.width || image.height !== last.height) {
            throw new PreviewError('PREVIEW_IMAGE_MISMATCH', 'capture', 'PNG dimensions do not match the frozen submitted frame.');
          }
          return {
            format: 'strata.preview.capture', version: 1,
            ...captureReady, captureId: capture.captureId,
            submittedFrameIds: frames.map(frame => frame.frameId), frames: frames.map(frame => frame.metrics),
            gpuCompletion: { fencedThroughFrameId: last.frameId },
            gpuTimings: frames.map(frame => {
              const samples = (captured.gpuSamples ?? []).filter(sample => sample.frameId === frame.frameId).map(sample => sample.sample);
              return { frameId: frame.frameId, samples,
                unavailableReason: captured.gpuTimingUnavailableReason ?? (samples.length === 0 ? 'No matching GPU samples were available when the frozen capture was recorded.' : null) };
            }),
            presentedFrameId: null,
            imageEvidence: 'browser-composited frozen canvas after GPU fence; compositor frame identity unobserved',
            telemetry: captured.telemetry, environment: captured.environment, image,
          };
        },
      });
    });
  }

  /**
   * Wait for actual mutation/artifact settlement, even after disposal or fault.
   * Early caller rejection is not settlement. This has no deadline and does not
   * dispose the driver or assert operation success; shutdown hosts own those steps.
   */
  whenIdle(): Promise<void> { return this.#gate.whenIdle(); }

  /** Idempotent; interrupts pending work instead of waiting indefinitely for it. */
  dispose(): Promise<void> {
    this.#gate.dispose();
    this.#ready = null;
    return this.#disposeDriver();
  }

  #disposeDriver(): Promise<void> {
    this.#disposePromise ??= Promise.resolve().then(() => this.#driver.dispose());
    return this.#disposePromise;
  }

  #requireReady(): { loaded: PreparedPreviewLoad<Scene, View>; ready: PreviewReadyReceipt<Commit> } {
    if (!this.#loaded || !this.#ready) throw new PreviewError('PREVIEW_NOT_READY', 'capture', 'Load and fence a scene before this operation.');
    return { loaded: this.#loaded, ready: this.#ready };
  }

  async #observeHealthy(context: OperationContext): Promise<PreviewDriverObservation<Commit>> {
    if (this.#terminalError) throw this.#terminalError;
    context.throwIfAborted();
    const state = frozen(await this.#driver.observe());
    context.throwIfAborted();
    if (state.status !== 'ready') {
      this.#ready = null;
      if (state.status === 'lost' || state.status === 'failed') this.#failDriver(state.status);
      throw this.#terminalError ?? new PreviewError('PREVIEW_DISPOSED', 'observe', 'Preview driver is unavailable.');
    }
    dimensions(state.width, state.height);
    return state;
  }

  #failDriver(status: 'lost' | 'failed'): void {
    this.#terminalError ??= new PreviewError(status === 'lost' ? 'PREVIEW_DEVICE_LOST' : 'PREVIEW_DRIVER_FAILED', 'observe', 'The preview driver failed; create a new session.');
    this.#ready = null;
    void this.#disposeDriver().catch(() => {});
  }

  #requireCommit(state: PreviewDriverObservation<Commit>, commit: Commit): void {
    if (!same(state.commit, commit)) throw new PreviewError('PREVIEW_STALE_STATE', 'observe', 'Committed runtime identity changed.');
  }

  #requireFrozen(state: PreviewDriverObservation<Commit>, frame: PreviewDriverFrame<Commit, Frame>): void {
    this.#requireCommit(state, frame.commit);
    if (state.width !== frame.width || state.height !== frame.height || state.lastSubmittedFrameId !== frame.frameId) {
      throw new PreviewError('PREVIEW_STALE_STATE', 'observe', 'The submitted frame or viewport changed during capture.');
    }
  }

  async #render(context: OperationContext, view: View, commit: Commit, before: PreviewDriverObservation<Commit>): Promise<PreviewDriverFrame<Commit, Frame>> {
    context.throwIfAborted();
    const frame = frozen(await this.#driver.render(view, context.signal));
    context.throwIfAborted();
    if (!same(frame.commit, commit) || !Number.isSafeInteger(frame.frameId) || frame.frameId < 1
      || (before.lastSubmittedFrameId !== null && frame.frameId <= before.lastSubmittedFrameId)
      || frame.width !== before.width || frame.height !== before.height) {
      throw new PreviewError('PREVIEW_FRAME_MISMATCH', 'render', 'Driver returned mismatched scene, viewport or submission evidence.');
    }
    return frame;
  }

  #receipt(loaded: PreparedPreviewLoad<Scene, View>, frame: PreviewDriverFrame<Commit, Frame>): PreviewReadyReceipt<Commit> {
    return frozen({
      sessionId: this.sessionId, loadId: `${this.sessionId}:${digest(frame.commit)}`,
      sceneId: loaded.sceneId, sourceRevision: loaded.sourceRevision, commit: frame.commit,
      viewRevision: digest(frame.resolvedView), resolvedView: frame.resolvedView,
      frameId: frame.frameId, width: frame.width, height: frame.height,
    });
  }
}
