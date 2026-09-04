import { StrataError } from './errors.js';
import { isRecord, WORKER_PROTOCOL_VERSION, type WorkerResponse } from './internal/protocol.js';
import { loadWasmRuntime, type WasmRuntime } from './internal/wasm-runtime.js';

// A narrow worker type avoids mixing conflicting DOM and WebWorker lib declarations.
const scope = globalThis as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: WorkerResponse): void;
};

let initializing = false;
let runtime: WasmRuntime | undefined;

scope.addEventListener('message', (event) => {
  const request = event.data;
  if (!isRecord(request) || request.type !== 'initialize' ||
      request.protocolVersion !== WORKER_PROTOCOL_VERSION ||
      (request.wasmUrl !== undefined && typeof request.wasmUrl !== 'string')) {
    scope.postMessage({ type: 'error', code: 'WORKER_FAILED', message: 'Invalid CPU worker protocol.' });
    return;
  }
  if (initializing || runtime !== undefined) {
    scope.postMessage({ type: 'error', code: 'WORKER_FAILED', message: 'CPU worker is already initialized.' });
    return;
  }
  initializing = true;
  void loadWasmRuntime(request.wasmUrl ?? new URL('./strata_runtime.wasm', import.meta.url))
    .then((result) => {
      runtime = result;
      scope.postMessage({ type: 'ready', info: runtime.info });
    })
    .catch((cause: unknown) => {
      const code = cause instanceof StrataError &&
        (cause.code === 'WASM_LOAD_FAILED' || cause.code === 'WASM_INCOMPATIBLE')
        ? cause.code
        : 'WORKER_FAILED';
      const detail = cause instanceof Error
        ? `${cause.message}${cause.cause instanceof Error ? ` ${cause.cause.message}` : ''}`
        : 'Unexpected CPU worker failure.';
      scope.postMessage({ type: 'error', code, message: detail });
    });
});
