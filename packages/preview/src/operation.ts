import { randomUUID } from 'node:crypto';
import { PreviewError } from './errors.js';

export type OperationKind = 'load' | 'capture' | 'resize';
export type OperationGateState = 'open' | 'disposed' | 'faulted';

export interface OperationOptions {
  signal?: AbortSignal;
  /** Deadline includes time spent waiting for a superseded load to finish cleanup. */
  timeoutMs?: number;
}

export interface OperationContext {
  readonly id: string;
  readonly signal: AbortSignal;
  throwIfAborted(): void;
  /** Await the exclusive artifact-success publication; cancellation waits for its outcome. */
  commit<T>(publish: () => Promise<T>): Promise<T>;
}

export interface OperationGateOptions {
  defaultTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  /** Notify the session owner to tear down its driver; this does not release ownership. */
  onFault?: (error: PreviewError) => void;
}

export const MAX_OPERATION_TIMEOUT_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;

interface Operation {
  id: string;
  kind: OperationKind;
  controller: AbortController;
  committed: boolean;
  publicationStarted: boolean;
  publicationInFlight: boolean;
  publicationFailed: boolean;
  publicationError: unknown;
  driverOutcome: { ok: true; value: unknown } | { ok: false; error: unknown } | null;
  started: boolean;
  settled: boolean;
  abortReason: PreviewError | null;
  timeout: ReturnType<typeof setTimeout> | undefined;
  cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
  removeCallerListener: (() => void) | undefined;
  start: () => void;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

function deadline(value: number, name: string, stage: string): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_OPERATION_TIMEOUT_MS) {
    throw new PreviewError('PREVIEW_INVALID_OPTIONS', stage,
      `${name} must be an integer from 1 to ${MAX_OPERATION_TIMEOUT_MS} milliseconds.`, { field: name });
  }
  return value;
}

/**
 * One driver mutation at a time. Rejected callers do not release the driver gate.
 * Only loads queue: a newer load aborts an older one, then waits for actual settlement.
 * Drivers must await all mutation/cleanup work before returning; detached work cannot
 * be owned by this scheduler. The commit wrapper separately owns its publication
 * promise, even if a faulty driver fails to await it. A committed result survives a later abort,
 * while an actual driver error after commit is still reported as an error.
 */
export class OperationGate {
  readonly #defaultTimeoutMs: number;
  readonly #cleanupTimeoutMs: number;
  readonly #onFault: ((error: PreviewError) => void) | undefined;
  #state: OperationGateState = 'open';
  #fault: PreviewError | null = null;
  #active: Operation | null = null;
  #pending: Operation | null = null;
  #idleWaiters: (() => void)[] = [];

  constructor(options: OperationGateOptions = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['defaultTimeoutMs', 'cleanupTimeoutMs', 'onFault'].includes(key))) {
      throw new PreviewError('PREVIEW_INVALID_OPTIONS', 'operation', 'Expected operation-gate timeout and fault-notification options.');
    }
    this.#defaultTimeoutMs = deadline(options.defaultTimeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.defaultTimeoutMs, 'defaultTimeoutMs', 'operation');
    this.#cleanupTimeoutMs = deadline(options.cleanupTimeoutMs === undefined ? DEFAULT_CLEANUP_TIMEOUT_MS : options.cleanupTimeoutMs, 'cleanupTimeoutMs', 'operation');
    if (options.onFault !== undefined && typeof options.onFault !== 'function') {
      throw new PreviewError('PREVIEW_INVALID_OPTIONS', 'operation', 'onFault must be a function.', { field: 'onFault' });
    }
    this.#onFault = options.onFault;
  }

  get state(): OperationGateState { return this.#state; }
  get fault(): PreviewError | null { return this.#fault; }
  get busy(): boolean { return this.#active !== null || this.#pending !== null; }
  get activeKind(): OperationKind | null { return this.#active?.kind ?? null; }

  /** Resolves only when driver work actually settles, including after disposal/fault. */
  whenIdle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise(resolve => { this.#idleWaiters.push(resolve); });
  }

  run<T>(kind: OperationKind, options: OperationOptions, work: (context: OperationContext) => Promise<T>): Promise<T> {
    let timeoutMs: number;
    try {
      if (kind !== 'load' && kind !== 'capture' && kind !== 'resize') {
        throw new PreviewError('PREVIEW_INVALID_OPTIONS', 'operation', 'Unsupported operation kind.');
      }
      if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => key !== 'signal' && key !== 'timeoutMs')
        || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
        || typeof work !== 'function') {
        throw new PreviewError('PREVIEW_INVALID_OPTIONS', kind, 'Expected operation options with an optional AbortSignal and deadline, and an async driver callback.');
      }
      timeoutMs = deadline(options.timeoutMs === undefined ? this.#defaultTimeoutMs : options.timeoutMs, 'timeoutMs', kind);
      if (this.#state !== 'open') throw this.#unavailable(kind);
      if (options.signal?.aborted) throw new PreviewError('PREVIEW_ABORTED', kind, 'Operation was canceled before it started.');
      if (this.#active && (kind !== 'load' || this.#active.kind !== 'load')) {
        throw new PreviewError('PREVIEW_BUSY', kind, 'Another preview mutation still owns the driver.', {
          activeOperationId: this.#active.id, activeKind: this.#active.kind,
        });
      }
    } catch (error) { return Promise.reject(error); }

    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
    const operation: Operation = {
      id: randomUUID(), kind, controller: new AbortController(),
      committed: false, publicationStarted: false, publicationInFlight: false,
      publicationFailed: false, publicationError: undefined, driverOutcome: null,
      started: false, settled: false, abortReason: null,
      timeout: undefined, cleanupTimeout: undefined, removeCallerListener: undefined,
      start: () => {}, resolve: value => { resolve(value as T); }, reject,
    };
    const context: OperationContext = Object.freeze({
      id: operation.id,
      signal: operation.controller.signal,
      throwIfAborted: () => {
        if (operation.abortReason) throw operation.abortReason;
        if (operation.settled) throw new PreviewError('PREVIEW_DISPOSED', kind, 'Operation context no longer owns the driver.', { operationId: operation.id });
      },
      commit: <Value>(publish: () => Promise<Value>): Promise<Value> => {
        if (operation.abortReason) return Promise.reject(operation.abortReason);
        if (operation.settled || operation.driverOutcome) return Promise.reject(new PreviewError('PREVIEW_DISPOSED', kind,
          'Operation cannot publish after its driver has returned.', { operationId: operation.id }));
        if (typeof publish !== 'function' || operation.publicationStarted) return Promise.reject(new PreviewError('PREVIEW_INVALID_OPTIONS', kind,
          'An operation may start one artifact-success publication callback.', { operationId: operation.id }));
        operation.publicationStarted = true;
        operation.publicationInFlight = true;
        let publication: Promise<Value>;
        try { publication = Promise.resolve(publish()); }
        catch (error) { publication = Promise.reject(error); }
        const result = publication.then(
          value => {
            operation.publicationInFlight = false;
            operation.committed = true;
            this.#complete(operation);
            return value;
          },
          error => {
            operation.publicationInFlight = false;
            operation.publicationFailed = true;
            operation.publicationError = error;
            this.#complete(operation);
            throw error;
          },
        );
        // A driver bug that neglects to await commit must not create an unhandled rejection.
        void result.catch(() => undefined);
        return result;
      },
    });
    operation.start = () => {
      operation.started = true;
      let driver: Promise<T>;
      try { driver = Promise.resolve(work(context)); }
      catch (error) { driver = Promise.reject(error); }
      // Both branches observe late failures, even if cancellation already rejected the caller.
      void driver.then(
        value => {
          operation.driverOutcome = { ok: true, value };
          this.#complete(operation);
        },
        error => {
          operation.driverOutcome = { ok: false, error };
          this.#complete(operation);
        },
      );
    };
    operation.timeout = setTimeout(() => this.#abort(operation, this.#error(operation,
      'PREVIEW_TIMEOUT', 'Operation deadline expired.', { timeoutMs })), timeoutMs);
    if (options.signal) {
      const signal = options.signal;
      const onAbort = () => this.#abort(operation, this.#error(operation, 'PREVIEW_ABORTED', 'Operation was canceled by its caller.'));
      signal.addEventListener('abort', onAbort, { once: true });
      operation.removeCallerListener = () => signal.removeEventListener('abort', onAbort);
    }

    if (this.#active) {
      const previousPending = this.#pending;
      this.#pending = operation;
      if (previousPending) this.#abort(previousPending, this.#error(previousPending,
        'PREVIEW_SUPERSEDED', 'A newer load superseded this queued operation.'));
      this.#abort(this.#active, this.#error(this.#active, 'PREVIEW_SUPERSEDED', 'A newer load superseded this operation.'));
    } else {
      this.#active = operation;
      operation.start();
    }
    return result;
  }

  /** Permanent; active ownership remains until settlement or external driver teardown. */
  dispose(): void {
    if (this.#state === 'disposed') return;
    if (this.#state === 'open') this.#state = 'disposed';
    const pending = this.#pending;
    this.#pending = null;
    if (pending) this.#abort(pending, this.#error(pending, 'PREVIEW_DISPOSED', 'Preview session was disposed.'));
    if (this.#active) this.#abort(this.#active, this.#error(this.#active, 'PREVIEW_DISPOSED', 'Preview session was disposed.'));
    this.#notifyIdle();
  }

  #error(operation: Operation, code: string, message: string, details: Record<string, unknown> = {}): PreviewError {
    return new PreviewError(code, operation.kind, message, {
      operationId: operation.id, committed: operation.committed, publicationOccurred: operation.committed, ...details,
    });
  }

  #unavailable(kind: OperationKind): PreviewError {
    return this.#fault ?? new PreviewError('PREVIEW_DISPOSED', kind, 'Preview session is disposed.');
  }

  #abort(operation: Operation, error: PreviewError): void {
    if (operation.settled || operation.abortReason) return;
    operation.abortReason = error;
    clearTimeout(operation.timeout);
    operation.removeCallerListener?.();
    if (!operation.committed && !operation.publicationInFlight && !operation.publicationFailed) operation.reject(error);
    if (operation.started) {
      operation.cleanupTimeout = setTimeout(() => this.#cleanupExpired(operation), this.#cleanupTimeoutMs);
    } else {
      if (this.#pending === operation) this.#pending = null;
      operation.settled = true;
    }
    operation.controller.abort(error);
    this.#notifyIdle();
  }

  #cleanupExpired(operation: Operation): void {
    if (operation.settled) return;
    const error = this.#error(operation, 'PREVIEW_CLEANUP_TIMEOUT',
      'Canceled driver work did not settle within the cleanup deadline; the session is permanently faulted.',
      { cleanupTimeoutMs: this.#cleanupTimeoutMs });
    this.#state = 'faulted';
    this.#fault = error;
    const pending = this.#pending;
    this.#pending = null;
    if (pending) this.#abort(pending, error);
    // Once publication starts, its actual outcome (and publisher cleanup details)
    // governs the caller result. A later cleanup deadline can fault the session,
    // but cannot retroactively turn a published artifact into a canceled capture.
    if (!operation.publicationStarted) operation.reject(error);
    // Faulting forbids new mutations; the active driver remains owned until it settles.
    try { this.#onFault?.(error); } catch { /* The stored cleanup fault remains authoritative. */ }
  }

  #complete(operation: Operation): void {
    if (!operation.driverOutcome || operation.publicationInFlight) return;
    const outcome = operation.driverOutcome;
    operation.settled = true;
    clearTimeout(operation.timeout);
    clearTimeout(operation.cleanupTimeout);
    operation.removeCallerListener?.();
    if (this.#active === operation) this.#active = null;
    if (this.#state === 'open' && this.#pending) {
      const next = this.#pending;
      this.#pending = null;
      this.#active = next;
      next.start();
    }
    this.#notifyIdle();
    if (operation.publicationFailed) {
      // The publisher can enrich its syscall failure with owned-artifact cleanup
      // diagnostics. Preserve that driver error, while preventing a swallowed
      // publication failure or our cancellation reason from manufacturing success.
      operation.reject(!outcome.ok && outcome.error !== operation.abortReason ? outcome.error : operation.publicationError);
    }
    else if (!operation.committed && operation.abortReason) operation.reject(operation.abortReason);
    else if (outcome.ok) operation.resolve(outcome.value);
    else operation.reject(outcome.error);
  }

  #notifyIdle(): void {
    if (!this.busy) for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }
}
