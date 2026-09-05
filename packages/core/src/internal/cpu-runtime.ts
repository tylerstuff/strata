import { StrataError } from '../errors.js';
import { estimateStaticBvhWorkingBytes, staticBvhLimits } from '../imported/static-trace-format.js';
import {
  isRecord, isRequestId, isStaticBvhInput, isWorkerResponse, WORKER_PROTOCOL_VERSION,
  type CpuRuntimeInfo, type InitializeWorkerMessage, type StaticBvhInput, type StaticBvhResult,
} from './protocol.js';

export interface StaticBvhBuildOptions {
  readonly signal?: AbortSignal;
  readonly maxWorkingBytes?: number;
}

export interface CpuRuntime {
  readonly info: CpuRuntimeInfo;
  /**
   * One job at a time; concurrent calls reject before copying inputs. Cancellation
   * rejects promptly, but the slot stays busy until the worker acknowledges it.
   * Input views are copied: this call never transfers the caller's own buffers.
   */
  buildStaticBvh(input: StaticBvhInput, options?: StaticBvhBuildOptions): Promise<StaticBvhResult>;
  /** Waits for worker acknowledgement/cleanup, including after a prompt build abort.
   * Recoverable job errors leave the runtime idle; worker failure/disposal rejects. */
  waitForStaticBvhIdle(): Promise<void>;
  dispose(): void;
}

export interface CpuRuntimeOptions {
  readonly wasmUrl?: URL | string;
  readonly workerUrl?: URL | string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function wasmOverride(value: URL | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const base = typeof document !== 'undefined' ? document.baseURI : globalThis.location?.href;
    return new URL(value, base).href;
  } catch (cause) {
    throw new StrataError('INVALID_OPTIONS', 'wasmUrl must be a valid asset URL.', { cause });
  }
}

interface PendingBvh {
  readonly id: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly maxWorkingBytes: number;
  readonly resolve: (result: StaticBvhResult) => void;
  readonly reject: (error: StrataError) => void;
  readonly removeAbort: () => void;
  cancelled: boolean;
  sent: boolean;
}

/** Starts an isolated CPU module; importing this file does not access browser APIs. */
export async function initializeCpuRuntime(options: CpuRuntimeOptions = {}): Promise<CpuRuntime> {
  if (options.signal?.aborted) throw new StrataError('INITIALIZATION_ABORTED', 'CPU runtime initialization was aborted.', { cause: options.signal.reason });
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new StrataError('INVALID_OPTIONS', 'timeoutMs must be a positive, finite timer duration.');
  const wasmUrl = wasmOverride(options.wasmUrl);
  if (typeof Worker === 'undefined') throw new StrataError('WORKER_UNAVAILABLE', 'Strata requires browser module workers.');
  let worker: Worker;
  try {
    worker = options.workerUrl === undefined
      ? new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
      : new Worker(options.workerUrl, { type: 'module' });
  } catch (cause) {
    throw new StrataError('WORKER_FAILED', 'Unable to create the Strata CPU worker.', { cause });
  }

  return new Promise<CpuRuntime>((resolve, reject) => {
    let ready = false;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: PendingBvh | undefined;
    let lastRequestId = 0;
    let runtimeInfo: CpuRuntimeInfo | undefined;
    let idle: { promise: Promise<void>; resolve: () => void; reject: (error: StrataError) => void } | undefined;

    const waitForStaticBvhIdle = (): Promise<void> => {
      if (disposed) return Promise.reject(new StrataError('ENGINE_DISPOSED', 'The CPU runtime is disposed.'));
      if (!pending) return Promise.resolve();
      if (!idle) {
        let resolveIdle!: () => void;
        let rejectIdle!: (error: StrataError) => void;
        const promise = new Promise<void>((resolve, reject) => { resolveIdle = resolve; rejectIdle = reject; });
        idle = { promise, resolve: resolveIdle, reject: rejectIdle };
      }
      return idle.promise;
    };

    const observeMemory = (memoryBytes: number | undefined): void => {
      if (runtimeInfo && memoryBytes !== undefined && memoryBytes > runtimeInfo.memoryBytes) {
        runtimeInfo = Object.freeze({ abiVersion: runtimeInfo.abiVersion, memoryBytes });
      }
    };

    const cleanupStartup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finishJob = (error?: StrataError, result?: StaticBvhResult, idleError?: StrataError): void => {
      const job = pending;
      pending = undefined;
      const waiting = idle;
      idle = undefined;
      if (idleError) waiting?.reject(idleError);
      else waiting?.resolve();
      if (!job) return;
      job.removeAbort();
      if (!job.cancelled) {
        if (error) job.reject(error);
        else if (result) job.resolve(result);
      }
    };
    const close = (error: StrataError): void => {
      if (disposed) return;
      disposed = true;
      cleanupStartup();
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
      // Termination releases the module and its entire unshared linear memory.
      worker.terminate();
      finishJob(error, undefined, error);
      if (!ready) reject(error);
    };
    const dispose = (): void => close(new StrataError('ENGINE_DISPOSED', 'The CPU runtime is disposed.'));
    const onAbort = (): void => close(new StrataError('INITIALIZATION_ABORTED', 'CPU runtime initialization was aborted.', { cause: options.signal?.reason }));
    const onError = (event: ErrorEvent): void => {
      event.preventDefault();
      close(new StrataError('WORKER_FAILED', event.message || 'The Strata CPU worker failed.', { cause: event.error }));
    };
    const onMessageError = (): void => close(new StrataError('WORKER_FAILED', 'The Strata CPU worker sent an unreadable message.'));

    const buildStaticBvh = async (input: StaticBvhInput, buildOptions: StaticBvhBuildOptions = {}): Promise<StaticBvhResult> => {
      if (disposed) throw new StrataError('ENGINE_DISPOSED', 'The CPU runtime is disposed.');
      if (!buildOptions || typeof buildOptions !== 'object' || Array.isArray(buildOptions)) throw new StrataError('INVALID_OPTIONS', 'BVH options must be an object.');
      const { signal } = buildOptions;
      if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
        throw new StrataError('INVALID_OPTIONS', 'Static BVH cancellation requires an AbortSignal.');
      }
      if (signal?.aborted) throw new StrataError('SCENE_LOAD_ABORTED', 'Static BVH construction was aborted.', { cause: signal.reason });
      if (pending) throw new StrataError('INVALID_OPTIONS', 'The CPU runtime already has an active static BVH job; cancellation must be acknowledged before starting another.');
      const maxWorkingBytes = buildOptions.maxWorkingBytes ?? staticBvhLimits.defaultWorkingBytes;
      if (!Number.isSafeInteger(maxWorkingBytes) || maxWorkingBytes < 1 || maxWorkingBytes > staticBvhLimits.maxWorkingBytes
        || !isStaticBvhInput(input, staticBvhLimits.maxWorkingBytes)) throw new StrataError('INVALID_OPTIONS', 'Static BVH input layout, counts or working-memory limit are invalid.');
      if (estimateStaticBvhWorkingBytes(input.positions.length / 3, input.indices.length / 3) > maxWorkingBytes) {
        throw new StrataError('UNSUPPORTED_LIMIT', 'The static BVH input exceeds its working-memory budget.');
      }
      if (lastRequestId === Number.MAX_SAFE_INTEGER) throw new StrataError('WORKER_FAILED', 'CPU worker request IDs are exhausted.');
      let positions: Float32Array<ArrayBuffer>, indices: Uint32Array<ArrayBuffer>;
      try {
        positions = new Float32Array(input.positions);
        indices = new Uint32Array(input.indices);
      } catch (cause) {
        throw new StrataError('UNSUPPORTED_LIMIT', 'Unable to copy static BVH inputs within available memory.', { cause });
      }
      const id = ++lastRequestId;
      return new Promise<StaticBvhResult>((resolveJob, rejectJob) => {
        const onCancel = (): void => {
          const job = pending;
          if (!job || job.id !== id || job.cancelled) return;
          job.cancelled = true;
          job.removeAbort();
          rejectJob(new StrataError('SCENE_LOAD_ABORTED', 'Static BVH construction was aborted.', { cause: signal?.reason }));
          if (!job.sent) { finishJob(); return; }
          try { worker.postMessage({ type: 'cancel-static-bvh', requestId: id }); }
          catch (cause) { close(new StrataError('WORKER_FAILED', 'Unable to cancel the CPU worker job.', { cause })); }
        };
        pending = { id, vertexCount: positions.length / 3, triangleCount: indices.length / 3, maxWorkingBytes,
          resolve: resolveJob, reject: rejectJob, cancelled: false, sent: false,
          removeAbort: () => signal?.removeEventListener('abort', onCancel) };
        signal?.addEventListener('abort', onCancel, { once: true });
        if (signal?.aborted) { onCancel(); return; }
        pending.sent = true;
        try {
          worker.postMessage({ type: 'build-static-bvh', requestId: id, input: { positions, indices }, maxWorkingBytes }, [positions.buffer, indices.buffer]);
        } catch (cause) {
          close(new StrataError('WORKER_FAILED', 'Unable to send the static BVH job to the CPU worker.', { cause }));
        }
      });
    };

    const onMessage = (event: MessageEvent<unknown>): void => {
      if (disposed) return;
      const response = event.data;
      // Late terminal replies from a cancelled or completed request cannot settle a newer job.
      if (ready && isRecord(response) && isRequestId(response.requestId)
        && response.requestId <= lastRequestId && response.requestId !== pending?.id) return;
      if (!isWorkerResponse(response)) { close(new StrataError('WORKER_FAILED', 'The Strata CPU worker sent an invalid response.')); return; }
      if (response.type === 'error') { observeMemory(response.wasmMemoryBytes); close(new StrataError(response.code, response.message)); return; }
      if (!ready) {
        if (response.type !== 'ready') { close(new StrataError('WORKER_FAILED', 'The CPU worker sent a job response before initialization.')); return; }
        ready = true;
        cleanupStartup();
        runtimeInfo = Object.freeze({ ...response.info });
        resolve({ get info() { return runtimeInfo!; }, buildStaticBvh, waitForStaticBvhIdle, dispose });
        return;
      }
      if (response.type === 'ready' || !pending || response.requestId !== pending.id) {
        close(new StrataError('WORKER_FAILED', 'The CPU worker sent an unexpected response.')); return;
      }
      if (response.type === 'static-bvh-error') {
        observeMemory(response.wasmMemoryBytes);
        const error = new StrataError(response.code, response.message);
        if (response.code === 'WORKER_FAILED') close(error);
        else finishJob(error);
        return;
      }
      if (response.type === 'static-bvh-cancelled') {
        if (!pending.cancelled) { close(new StrataError('WORKER_FAILED', 'The CPU worker cancelled a job without a cancellation request.')); return; }
        observeMemory(response.wasmMemoryBytes); finishJob(); return;
      }
      if (response.result.vertexCount !== pending.vertexCount || response.result.triangleCount !== pending.triangleCount
        || response.result.workingBytes > pending.maxWorkingBytes) {
        close(new StrataError('WORKER_FAILED', 'The CPU worker returned mismatched BVH metadata.')); return;
      }
      observeMemory(response.result.wasmMemoryBytes); finishJob(undefined, response.result);
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) { onAbort(); return; }
    timer = setTimeout(() => close(new StrataError('INITIALIZATION_TIMEOUT', `The Strata CPU worker did not initialize within ${timeoutMs} ms.`)), timeoutMs);
    const request: InitializeWorkerMessage = { type: 'initialize', protocolVersion: WORKER_PROTOCOL_VERSION, ...(wasmUrl === undefined ? {} : { wasmUrl }) };
    try { worker.postMessage(request); }
    catch (cause) { close(new StrataError('WORKER_FAILED', 'Unable to initialize the Strata CPU worker.', { cause })); }
  });
}
