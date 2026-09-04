export const CPU_ABI_VERSION = 1;
export const WORKER_PROTOCOL_VERSION = 1;

export interface CpuRuntimeInfo {
  readonly abiVersion: number;
  readonly memoryBytes: number;
}

export type WorkerFailureCode =
  | 'WASM_LOAD_FAILED'
  | 'WASM_INCOMPATIBLE'
  | 'WORKER_FAILED';

export interface InitializeWorkerMessage {
  readonly type: 'initialize';
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly wasmUrl?: string;
}

export type WorkerResponse =
  | { readonly type: 'ready'; readonly info: CpuRuntimeInfo }
  | { readonly type: 'error'; readonly code: WorkerFailureCode; readonly message: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!isRecord(value)) return false;
  if (value.type === 'error') {
    return (
      (value.code === 'WASM_LOAD_FAILED' ||
        value.code === 'WASM_INCOMPATIBLE' ||
        value.code === 'WORKER_FAILED') &&
      typeof value.message === 'string'
    );
  }
  return (
    value.type === 'ready' &&
    isRecord(value.info) &&
    value.info.abiVersion === CPU_ABI_VERSION &&
    typeof value.info.memoryBytes === 'number' &&
    Number.isSafeInteger(value.info.memoryBytes) &&
    value.info.memoryBytes > 0
  );
}
