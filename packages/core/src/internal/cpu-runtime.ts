import { StrataError } from '../errors.js';
import {
  isWorkerResponse,
  WORKER_PROTOCOL_VERSION,
  type CpuRuntimeInfo,
  type InitializeWorkerMessage,
} from './protocol.js';

export interface CpuRuntime {
  readonly info: CpuRuntimeInfo;
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

/** Starts an isolated CPU module; importing this file does not access browser APIs. */
export async function initializeCpuRuntime(options: CpuRuntimeOptions = {}): Promise<CpuRuntime> {
  if (options.signal?.aborted) {
    throw new StrataError('INITIALIZATION_ABORTED', 'CPU runtime initialization was aborted.', {
      cause: options.signal.reason,
    });
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new StrataError('INVALID_OPTIONS', 'timeoutMs must be a positive, finite timer duration.');
  }
  const wasmUrl = wasmOverride(options.wasmUrl);
  if (typeof Worker === 'undefined') {
    throw new StrataError('WORKER_UNAVAILABLE', 'Strata requires browser module workers.');
  }

  let worker: Worker;
  try {
    worker = options.workerUrl === undefined
      ? new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
      : new Worker(options.workerUrl, { type: 'module' });
  } catch (cause) {
    throw new StrataError('WORKER_FAILED', 'Unable to create the Strata CPU worker.', { cause });
  }

  return new Promise<CpuRuntime>((resolve, reject) => {
    let settled = false;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      // Termination releases the module and its entire unshared linear memory.
      worker.terminate();
    };

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
    };

    const fail = (error: StrataError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      dispose();
      reject(error);
    };

    const onAbort = (): void => fail(new StrataError(
      'INITIALIZATION_ABORTED',
      'CPU runtime initialization was aborted.',
      { cause: options.signal?.reason },
    ));

    const onError = (event: ErrorEvent): void => {
      event.preventDefault();
      fail(new StrataError('WORKER_FAILED', event.message || 'The Strata CPU worker failed.', {
        cause: event.error,
      }));
    };

    const onMessageError = (): void => fail(new StrataError(
      'WORKER_FAILED',
      'The Strata CPU worker sent an unreadable message.',
    ));

    const onMessage = (event: MessageEvent<unknown>): void => {
      if (settled) return;
      const response = event.data;
      if (!isWorkerResponse(response)) {
        fail(new StrataError('WORKER_FAILED', 'The Strata CPU worker sent an invalid response.'));
        return;
      }
      if (response.type === 'error') {
        fail(new StrataError(response.code, response.message));
        return;
      }
      settled = true;
      cleanup();
      resolve({ info: Object.freeze({ ...response.info }), dispose });
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => fail(new StrataError(
      'INITIALIZATION_TIMEOUT',
      `The Strata CPU worker did not initialize within ${timeoutMs} ms.`,
    )), timeoutMs);
    const request: InitializeWorkerMessage = {
      type: 'initialize',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      ...(wasmUrl === undefined ? {} : { wasmUrl }),
    };
    try {
      worker.postMessage(request);
    } catch (cause) {
      fail(new StrataError('WORKER_FAILED', 'Unable to initialize the Strata CPU worker.', { cause }));
    }
  });
}
