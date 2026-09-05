import { canonicalJson } from '@strata-engine/authoring';
import { prepareAuthoredPreviewLoad } from './adapter.js';
import type { CapturePublication } from './artifacts.js';
import type { CreatePreviewSessionOptions } from './browser-driver.js';
import type { PreviewDriverObservation } from './driver.js';
import { PreviewError } from './errors.js';
import type { OperationOptions } from './operation.js';
import type { CaptureRequest, PreviewReadyReceipt } from './session.js';
import { createConnectionRoots, type ConnectionRoots } from './connection-files.js';
import {
  PREVIEW_CONNECTION_LIMITS as LIMITS, connectionErrorResponse, connectionFailure,
  type ConnectionResponse, type PreviewConnectionHandler,
} from './connection-protocol.js';

export { PREVIEW_CONNECTION_LIMITS, PREVIEW_CONNECTION_VERSION } from './connection-protocol.js';
export type { ConnectionDiagnostic, ConnectionResponse, PreviewConnectionHandler } from './connection-protocol.js';
export { runPreviewConnectionStdio } from './connection-stdio.js';

export interface PreviewConnectionOptions extends CreatePreviewSessionOptions {
  projectRoot: string;
  outputRoot: string;
}

export interface PreviewConnectionObservation {
  sessionId: string;
  state: 'ready' | 'unready' | 'busy' | 'lost' | 'disposed' | 'faulted';
  ready: PreviewReadyReceipt<unknown> | null;
  driver: PreviewDriverObservation<unknown>;
}

/** Existing public session operations; doubles must obey their ownership contracts. */
export interface PreviewConnectionSession {
  load(input: unknown, options?: OperationOptions): Promise<PreviewReadyReceipt<unknown>>;
  observe(): Promise<PreviewConnectionObservation>;
  resize(width: number, height: number, options?: OperationOptions): Promise<PreviewReadyReceipt<unknown>>;
  capture(request: CaptureRequest, options?: OperationOptions): Promise<CapturePublication>;
  /** Actual mutation/artifact settlement, including after disposal/fault; no deadline. */
  whenIdle(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PreviewConnectionDependencies {
  /** Rejection must clean partial resources. A late returned session is always disposed. */
  createSession(options: CreatePreviewSessionOptions): PreviewConnectionSession | Promise<PreviewConnectionSession>;
}

type Method = 'discover' | 'load' | 'inspect' | 'capture' | 'resize' | 'cancel' | 'dispose';
type WorkMethod = 'load' | 'inspect' | 'capture' | 'resize';
interface Work {
  id: number;
  method: WorkMethod;
  controller: AbortController;
  terminal: boolean;
  cancelRequested: boolean;
  abortCode: 'PREVIEW_ABORTED' | 'CONNECTION_TIMEOUT' | 'CONNECTION_CLOSED' | null;
  timeout: ReturnType<typeof setTimeout> | undefined;
  cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
  finish(error: unknown): void;
}

const methods = Object.freeze({
  discover: { required: [], optional: [], result: 'Protocol, roots, profile, methods and limits; no browser launch.' },
  load: { required: ['scenePath', 'expectedRevision', 'view'], optional: [], result: 'Existing PreviewReadyReceipt. scenePath is project-relative; view is AuthoredPreviewViewInput.' },
  inspect: { required: [], optional: [], result: 'Current session observation, connection state, active requests and bounded recent terminal summaries.' },
  capture: { required: ['expectedRevision', 'expectedLoadId', 'expectedViewRevision'], optional: ['captureId', 'frames'], result: 'Existing capture publication plus publicationOccurred:true; startup output root only.' },
  resize: { required: ['width', 'height'], optional: [], result: 'Existing PreviewReadyReceipt for the physical viewport.' },
  cancel: { required: ['requestId'], optional: [], result: 'Cancellation-request acknowledgement; does not assert rollback or settlement.' },
  dispose: { required: [], optional: [], result: 'Permanent bounded owned cleanup; connection closes after terminal responses drain.' },
});

function object(value: unknown, allowed: readonly string[], required: readonly string[], stage: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw connectionFailure('CONNECTION_INVALID_REQUEST', stage, 'Expected an object with exactly the documented fields.');
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, maximum: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw connectionFailure('CONNECTION_INVALID_PARAMS', 'parameters', `Invalid bounded positive integer: ${field}.`, { field, maximum });
  }
  return value;
}

function text(value: unknown, field: string, maximum = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximum) {
    throw connectionFailure('CONNECTION_INVALID_PARAMS', 'parameters', `Expected a bounded nonempty string: ${field}.`, { field });
  }
  return value;
}

function clone<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }

async function bounded<T>(promise: Promise<T>, milliseconds: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(connectionFailure('CONNECTION_UNSETTLED', stage,
        'Owned work did not settle before the cleanup deadline.', { outcomeUnknown: true })), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** One local process, one optional session, and a bounded set of correlated requests. */
class LocalPreviewConnection implements PreviewConnectionHandler {
  readonly #roots: ConnectionRoots;
  readonly #options: CreatePreviewSessionOptions;
  readonly #dependencies: PreviewConnectionDependencies;
  readonly #timeoutMs: number;
  readonly #cleanupMs: number;
  readonly #work = new Map<number, Work>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #recent: { id: number; method: string; status: 'succeeded' | 'failed'; code?: string }[] = [];
  #session: PreviewConnectionSession | null = null;
  #lastId = 0;
  #outstanding = 0;
  #ordinary = 0;
  #mutation: number | null = null;
  #inspection: number | null = null;
  #observation: Promise<PreviewConnectionObservation> | null = null;
  #closing = false;
  #fault: PreviewError | null = null;
  #closePromise: Promise<void> | null = null;
  #lateSessionCleanup: Promise<void> | null = null;
  readonly #cleanupErrors: PreviewError[] = [];
  #removeSignal: (() => void) | undefined;

  constructor(roots: ConnectionRoots, options: CreatePreviewSessionOptions, dependencies: PreviewConnectionDependencies) {
    this.#roots = roots;
    this.#options = options;
    this.#dependencies = dependencies;
    this.#timeoutMs = options.timeoutMs!;
    this.#cleanupMs = options.cleanupTimeoutMs!;
    if (options.signal) {
      const signal = options.signal;
      const abort = () => { void this.close().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      this.#removeSignal = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    }
  }

  get closing(): boolean { return this.#closing; }

  async request(value: unknown): Promise<ConnectionResponse> {
    let id: number | null = null;
    let method: string | undefined;
    let admitted = false;
    let ordinary = false;
    try {
      const encoded = canonicalJson(value);
      if (Buffer.byteLength(encoded) > LIMITS.inputLineBytes) throw connectionFailure('CONNECTION_FRAME_TOO_LARGE', 'request', 'Request exceeds the connection byte limit.');
      const request = object(JSON.parse(encoded) as unknown, ['version', 'id', 'method', 'params'], ['version', 'id', 'method', 'params'], 'request');
      if (request.version !== 1) throw connectionFailure('CONNECTION_VERSION', 'request', 'Only connection protocol version 1 is supported.');
      const candidate = integer(request.id, Number.MAX_SAFE_INTEGER, 'id');
      if (candidate <= this.#lastId) throw connectionFailure('CONNECTION_ID_ORDER', 'request', 'Request IDs must increase strictly within a connection.');
      ordinary = request.method !== 'cancel' && request.method !== 'dispose';
      if (this.#outstanding >= LIMITS.outstandingRequests || (ordinary && this.#ordinary >= LIMITS.ordinaryRequests)) {
        throw connectionFailure('CONNECTION_BUSY', 'request', 'Request capacity is exhausted; two slots are reserved for cancellation/disposal.');
      }
      this.#lastId = candidate;
      id = candidate;
      this.#outstanding++;
      if (ordinary) this.#ordinary++;
      admitted = true;
      method = text(request.method, 'method', 64);
      if (!Object.hasOwn(methods, method)) throw connectionFailure('CONNECTION_METHOD', 'request', 'Unknown connection method.');
      if (this.#closing && method !== 'dispose') throw this.#fault ?? connectionFailure('CONNECTION_CLOSED', 'request', 'Connection admission is permanently closed.');
      const definition = methods[method as Method];
      const params = object(request.params, [...definition.required, ...definition.optional], definition.required, 'parameters');
      const result = await this.#dispatch(id, method as Method, params);
      const response: ConnectionResponse = { version: 1, id, ok: true, result: clone(result) };
      this.#remember(id, method, response);
      return response;
    } catch (error) {
      const response = connectionErrorResponse(id, error);
      if (id !== null) this.#remember(id, method ?? 'unknown', response);
      return response;
    } finally { if (admitted) { this.#outstanding--; if (ordinary) this.#ordinary--; } }
  }

  #remember(id: number, method: string, response: ConnectionResponse): void {
    this.#recent.push({ id, method, status: response.ok ? 'succeeded' : 'failed', ...(response.ok ? {} : { code: response.error.code }) });
    if (this.#recent.length > LIMITS.recentRequests) this.#recent.shift();
  }

  #summary(): object {
    return {
      state: this.#fault ? 'faulted' : this.#closing ? 'closing' : this.#session ? 'initialized' : 'uninitialized',
      activeRequests: [...this.#work.values()].map(work => ({ requestId: work.id, method: work.method, cancelRequested: work.cancelRequested, terminalResponseSettled: work.terminal })),
      recentRequests: this.#recent.slice(),
    };
  }

  #dispatch(id: number, method: Method, params: Record<string, unknown>): Promise<unknown> | unknown {
    if (method === 'discover') return {
      protocol: 'strata.preview.connection', version: 1, transport: 'stdio-jsonl', methods, limits: LIMITS,
      projectRoot: this.#roots.projectRoot, outputRoot: this.#roots.outputRoot,
      deadlines: { timeoutMs: this.#timeoutMs, cleanupTimeoutMs: this.#cleanupMs },
      profile: 'opaque procedural authored root boxes; existing AuthoredPreviewViewInput; no external assets',
      browser: { lazy: true, channel: this.#options.channel, headless: this.#options.headless, softwareGpu: this.#options.softwareGpu },
    };
    if (method === 'cancel') {
      const target = integer(params.requestId, Number.MAX_SAFE_INTEGER, 'requestId');
      const work = this.#work.get(target);
      if (!work || work.terminal) return { requestId: target, cancellationRequested: false, reason: work ? 'terminal-response-settled' : 'not-active' };
      this.#abort(work, 'PREVIEW_ABORTED');
      return { requestId: target, cancellationRequested: true, settled: false };
    }
    if (method === 'dispose') return this.close().then(() => ({ disposed: true }));
    if (method === 'inspect') return this.#run(id, method, async () => {
      const observation = this.#session ? await this.#observe() : null;
      return { ...this.#summary(), observation };
    });
    if (this.#mutation !== null) throw connectionFailure('PREVIEW_BUSY', method, 'Another request or unsettled session operation retains mutation ownership.', { requestId: this.#mutation });
    if (method === 'load') {
      const scenePath = text(params.scenePath, 'scenePath');
      const expectedRevision = text(params.expectedRevision, 'expectedRevision', 128);
      const view = params.view;
      return this.#run(id, method, async signal => {
        const snapshot = await this.#roots.readScene(scenePath, signal);
        const input = { scene: snapshot.scene, revision: expectedRevision, view };
        prepareAuthoredPreviewLoad(input);
        this.#checkAbort(signal);
        if (!this.#session) {
          const session = await this.#dependencies.createSession({ ...this.#options, signal });
          if (this.#closing || signal.aborted) {
            // This candidate is never adopted, but its cleanup still belongs to
            // this process, including rejection after shutdown has already begun.
            this.#lateSessionCleanup = this.#disposeSession(session).catch(cause => {
              const error = connectionFailure('CONNECTION_DISPOSE_FAILED', 'initialize', 'A late-created session could not be disposed.', {
                unresolvedResources: ['late-created-session'], errors: [connectionErrorResponse(null, cause)],
              });
              this.#cleanupErrors.push(error);
              this.#faultConnection(error);
              throw error;
            });
            await this.#lateSessionCleanup;
            this.#checkAbort(signal);
            throw connectionFailure('CONNECTION_CLOSED', 'initialize', 'Connection closed before the session could be adopted.');
          }
          this.#session = session;
        }
        return this.#session.load(input, { signal, timeoutMs: this.#timeoutMs });
      });
    }
    if (!this.#session) throw connectionFailure('PREVIEW_NOT_READY', method, 'Load a validated scene before this operation.');
    if (method === 'resize') {
      const width = integer(params.width, 16_384, 'width'), height = integer(params.height, 16_384, 'height');
      if (width * height > 64 * 1024 * 1024) throw connectionFailure('CONNECTION_INVALID_PARAMS', 'resize', 'Viewport exceeds the preview pixel limit.');
      return this.#run(id, method, signal => this.#session!.resize(width, height, { signal, timeoutMs: this.#timeoutMs }));
    }
    const capture: CaptureRequest = {
      expectedRevision: text(params.expectedRevision, 'expectedRevision'),
      expectedLoadId: text(params.expectedLoadId, 'expectedLoadId'),
      expectedViewRevision: text(params.expectedViewRevision, 'expectedViewRevision'),
      outputDirectory: this.#roots.outputRoot,
      ...(params.captureId === undefined ? {} : { captureId: text(params.captureId, 'captureId', 128) }),
      ...(params.frames === undefined ? {} : { frames: integer(params.frames, 8, 'frames') }),
    };
    return this.#run(id, method, async signal => {
      await this.#roots.verifyOutput();
      this.#checkAbort(signal);
      const publication = await this.#session!.capture(capture, { signal, timeoutMs: this.#timeoutMs });
      // Do not check cancellation or await more work after successful publication.
      return { ...publication, publicationOccurred: true };
    });
  }

  #checkAbort(signal: AbortSignal): void {
    if (signal.aborted) throw connectionFailure('PREVIEW_ABORTED', 'connection', 'Connection operation was canceled.');
  }

  #observe(): Promise<PreviewConnectionObservation> {
    if (!this.#session) throw connectionFailure('PREVIEW_NOT_READY', 'inspect', 'No session has been created.');
    if (!this.#observation) {
      const observation = Promise.resolve().then(() => this.#session!.observe()).then(value => clone(value));
      this.#observation = observation;
      void observation.finally(() => { if (this.#observation === observation) this.#observation = null; }).catch(() => {});
    }
    return this.#observation;
  }

  #run(id: number, method: WorkMethod, execute: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
    if (method === 'inspect' && this.#inspection !== null) throw connectionFailure('CONNECTION_BUSY', method, 'An inspection is already pending.');
    if (method === 'inspect') this.#inspection = id;
    else this.#mutation = id;
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
    const response = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    const work: Work = {
      id, method, controller: new AbortController(), terminal: false, cancelRequested: false, abortCode: null,
      timeout: undefined, cleanupTimeout: undefined,
      finish: error => { if (!work.terminal) { work.terminal = true; reject(error); } },
    };
    this.#work.set(id, work);
    work.timeout = setTimeout(() => this.#abort(work, 'CONNECTION_TIMEOUT'), this.#timeoutMs);
    let failed = false;
    const task = Promise.resolve().then(() => execute(work.controller.signal)).then(
      value => {
        // Successful public API resolution means its operation settled. Release
        // admission before delivering success so sequential clients need no poll.
        if (this.#mutation === id) this.#mutation = null;
        if (this.#inspection === id) this.#inspection = null;
        if (!work.terminal) { work.terminal = true; resolve(value); }
      },
      error => {
        failed = true;
        work.finish(error instanceof PreviewError && error.code === 'PREVIEW_ABORTED' && work.abortCode
          ? new PreviewError(work.abortCode, error.stage, work.abortCode === 'CONNECTION_TIMEOUT' ? 'Connection operation deadline expired.' : error.message, { ...error.details }) : error);
        if (error instanceof PreviewError && error.code === 'CONNECTION_ROOT_CHANGED') this.#faultConnection(error);
      },
    ).then(async () => {
      clearTimeout(work.timeout);
      if (failed && method !== 'inspect' && this.#session && !this.#closing) {
        // API cancellation may reject before the session's gate releases its work.
        this.#watchCleanup(work);
        while (!this.#closing) {
          const observation = await bounded(this.#observe(), this.#cleanupMs, 'settlement');
          if (observation.state !== 'busy') {
            if (observation.state === 'lost' || observation.state === 'faulted' || observation.state === 'disposed') {
              throw connectionFailure('CONNECTION_SESSION_UNAVAILABLE', 'settlement', 'The owned preview session is permanently unavailable.', { state: observation.state });
            }
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
    }).catch(error => { this.#faultConnection(error); }).finally(() => {
      clearTimeout(work.timeout);
      clearTimeout(work.cleanupTimeout);
      this.#work.delete(id);
      if (this.#mutation === id) this.#mutation = null;
      if (this.#inspection === id) this.#inspection = null;
      this.#tasks.delete(task);
    });
    this.#tasks.add(task);
    return response;
  }

  #watchCleanup(work: Work): void {
    if (work.cleanupTimeout) return;
    work.cleanupTimeout = setTimeout(() => {
      const error = connectionFailure('CONNECTION_UNSETTLED', work.method, 'Owned work exceeded the cleanup deadline; admission is closed.', { requestId: work.id, outcomeUnknown: !work.terminal });
      work.finish(error);
      this.#faultConnection(error);
    }, this.#cleanupMs);
  }

  #abort(work: Work, code: NonNullable<Work['abortCode']>): void {
    work.abortCode ??= code;
    work.cancelRequested = true;
    work.controller.abort();
    clearTimeout(work.timeout);
    this.#watchCleanup(work);
  }

  #faultConnection(error: unknown): void {
    this.#fault ??= error instanceof PreviewError ? error : connectionFailure('CONNECTION_FAILED', 'settlement', 'Owned session settlement failed.');
    void this.close().catch(() => {});
  }

  async #disposeSession(session: PreviewConnectionSession): Promise<void> {
    // dispose() owns driver teardown, while whenIdle() retains pre-publication
    // artifact I/O after an early canceled caller result. Neither replaces the
    // connection's request/publication tracking or its absolute cleanup deadline.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => session.dispose()),
      Promise.resolve().then(() => session.whenIdle()),
    ]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [connectionErrorResponse(null, result.reason)] : []);
    if (errors.length) throw connectionFailure('CONNECTION_DISPOSE_FAILED', 'dispose', 'Owned session teardown or settlement failed.', { errors });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#removeSignal?.();
    for (const work of this.#work.values()) this.#abort(work, 'CONNECTION_CLOSED');
    this.#closePromise = Promise.resolve().then(async () => {
      const cleanup = this.#session ? this.#disposeSession(this.#session) : Promise.resolve();
      const results = await bounded(Promise.allSettled([cleanup, ...this.#tasks, ...(this.#lateSessionCleanup ? [this.#lateSessionCleanup] : [])]), this.#cleanupMs, 'dispose');
      const errors = [...this.#cleanupErrors, ...results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])];
      if (errors.length) throw connectionFailure('CONNECTION_DISPOSE_FAILED', 'dispose', 'Owned session cleanup failed.', { errors: errors.map(error => connectionErrorResponse(null, error)) });
    });
    void this.#closePromise.catch(error => {
      for (const work of this.#work.values()) work.finish(error);
    });
    return this.#closePromise;
  }
}

/** Validate fixed roots/options without creating a browser. */
export async function createPreviewConnection(options: PreviewConnectionOptions, dependencies?: PreviewConnectionDependencies): Promise<PreviewConnectionHandler> {
  const value = object(options, ['projectRoot', 'outputRoot', 'width', 'height', 'headless', 'softwareGpu', 'channel', 'timeoutMs', 'cleanupTimeoutMs', 'signal'], ['projectRoot', 'outputRoot'], 'initialize');
  const projectRoot = text(value.projectRoot, 'projectRoot'), outputRoot = text(value.outputRoot, 'outputRoot');
  const width = integer(value.width ?? 512, 16_384, 'width'), height = integer(value.height ?? 512, 16_384, 'height');
  if (width * height > 64 * 1024 * 1024) throw connectionFailure('CONNECTION_INVALID_PARAMS', 'initialize', 'Viewport exceeds the preview pixel limit.');
  const timeoutMs = integer(value.timeoutMs ?? LIMITS.defaultTimeoutMs, LIMITS.maximumTimeoutMs, 'timeoutMs');
  const cleanupTimeoutMs = integer(value.cleanupTimeoutMs ?? LIMITS.defaultCleanupTimeoutMs, LIMITS.maximumTimeoutMs, 'cleanupTimeoutMs');
  const headless = value.headless ?? true, softwareGpu = value.softwareGpu ?? false, channel = value.channel ?? 'chromium';
  if (typeof headless !== 'boolean' || typeof softwareGpu !== 'boolean' || (channel !== 'chrome' && channel !== 'chromium')
    || (value.signal !== undefined && !(value.signal instanceof AbortSignal))) throw connectionFailure('CONNECTION_INVALID_PARAMS', 'initialize', 'Invalid browser or cancellation options.');
  const signal = value.signal as AbortSignal | undefined;
  if (signal?.aborted) throw connectionFailure('PREVIEW_ABORTED', 'initialize', 'Connection initialization was canceled.');
  const roots = await createConnectionRoots(projectRoot, outputRoot);
  if (signal?.aborted) throw connectionFailure('PREVIEW_ABORTED', 'initialize', 'Connection initialization was canceled.');
  if (dependencies !== undefined && (!dependencies || typeof dependencies.createSession !== 'function'
    || Object.keys(dependencies).some(key => key !== 'createSession'))) throw connectionFailure('CONNECTION_INVALID_PARAMS', 'initialize', 'Invalid session factory dependency.');
  return new LocalPreviewConnection(roots, {
    width, height, headless, softwareGpu, channel, timeoutMs, cleanupTimeoutMs,
    ...(signal ? { signal } : {}),
  }, dependencies ?? { createSession: async settings => (await import('./browser-driver.js')).createPreviewSession(settings) });
}
