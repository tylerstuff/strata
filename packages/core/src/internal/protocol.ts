import { estimateStaticBvhWorkingBytes, staticBvhLimits, staticBvhNodeCapacity } from '../imported/static-trace-format.js';

export const CPU_ABI_VERSION = 2;
export const WORKER_PROTOCOL_VERSION = 2;

export interface CpuRuntimeInfo {
  readonly abiVersion: number;
  readonly memoryBytes: number;
}

export interface StaticBvhInput {
  readonly positions: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
}

export interface StaticBvhResult {
  readonly nodes: ArrayBuffer;
  readonly triangles: ArrayBuffer;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly nodeCount: number;
  readonly maxDepth: number;
  readonly workUnits: number;
  /** Reserved builder capacity estimate, including the declared allocator allowance. */
  readonly workingBytes: number;
  /** Actual unshared linear-memory byte length after the job, before releasing it. */
  readonly wasmMemoryBytes: number;
}

export type WorkerFailureCode = 'WASM_LOAD_FAILED' | 'WASM_INCOMPATIBLE' | 'WORKER_FAILED';
export type StaticBvhFailureCode = 'INVALID_OPTIONS' | 'UNSUPPORTED_LIMIT' | 'WORKER_FAILED';

export interface InitializeWorkerMessage {
  readonly type: 'initialize';
  readonly protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  readonly wasmUrl?: string;
}

export type WorkerRequest = InitializeWorkerMessage
  | { readonly type: 'build-static-bvh'; readonly requestId: number; readonly input: StaticBvhInput; readonly maxWorkingBytes: number }
  | { readonly type: 'cancel-static-bvh'; readonly requestId: number };

export type WorkerResponse =
  | { readonly type: 'ready'; readonly info: CpuRuntimeInfo }
  | { readonly type: 'error'; readonly code: WorkerFailureCode; readonly message: string; readonly wasmMemoryBytes?: number }
  | { readonly type: 'static-bvh-result'; readonly requestId: number; readonly result: StaticBvhResult }
  | { readonly type: 'static-bvh-error'; readonly requestId: number; readonly code: StaticBvhFailureCode; readonly message: string; readonly wasmMemoryBytes?: number }
  | { readonly type: 'static-bvh-cancelled'; readonly requestId: number; readonly wasmMemoryBytes?: number };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function isRequestId(value: unknown): value is number { return integer(value, 1, Number.MAX_SAFE_INTEGER); }
function isWasmMemoryBytes(value: unknown): value is number { return integer(value, 65_536, 0x100000000) && value % 65_536 === 0; }

/** Constant-work structure/capacity checks; Rust validates individual vertices and indices in stepped work. */
export function isStaticBvhInput(input: unknown, maxWorkingBytes: unknown): input is StaticBvhInput {
  if (!isRecord(input) || !(input.positions instanceof Float32Array) || !(input.indices instanceof Uint32Array)
    || !(input.positions.buffer instanceof ArrayBuffer) || !(input.indices.buffer instanceof ArrayBuffer)
    || input.positions.length % 3 !== 0 || input.indices.length % 3 !== 0
    || !integer(input.positions.length / 3, 3, staticBvhLimits.maxVertices)
    || !integer(input.indices.length / 3, 1, staticBvhLimits.maxTriangles)
    || !integer(maxWorkingBytes, 1, staticBvhLimits.maxWorkingBytes)) return false;
  return estimateStaticBvhWorkingBytes(input.positions.length / 3, input.indices.length / 3) <= maxWorkingBytes;
}

export function isStaticBvhMetadata(value: unknown): value is Omit<StaticBvhResult, 'nodes' | 'triangles'> {
  if (!isRecord(value) || !integer(value.vertexCount, 3, staticBvhLimits.maxVertices)
    || !integer(value.triangleCount, 1, staticBvhLimits.maxTriangles)
    || !integer(value.nodeCount, 1, staticBvhNodeCapacity(value.triangleCount))
    || !integer(value.maxDepth, 1, 19) || !integer(value.workUnits, 1, 0xffffffff)
    || !integer(value.workingBytes, 1, staticBvhLimits.maxWorkingBytes)
    || value.workingBytes !== estimateStaticBvhWorkingBytes(value.vertexCount, value.triangleCount)
    || !isWasmMemoryBytes(value.wasmMemoryBytes)) return false;
  return true;
}

export function isStaticBvhResult(value: unknown): value is StaticBvhResult {
  if (!isRecord(value)) return false;
  const { nodes, triangles } = value;
  return isStaticBvhMetadata(value)
    && nodes instanceof ArrayBuffer && nodes.byteLength === value.nodeCount * 32
    && triangles instanceof ArrayBuffer && triangles.byteLength === value.triangleCount * 64;
}

export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!isRecord(value)) return false;
  if (value.wasmMemoryBytes !== undefined && !isWasmMemoryBytes(value.wasmMemoryBytes)) return false;
  if (value.type === 'error') return (value.code === 'WASM_LOAD_FAILED' || value.code === 'WASM_INCOMPATIBLE'
    || value.code === 'WORKER_FAILED') && typeof value.message === 'string';
  if (value.type === 'ready') return isRecord(value.info) && value.info.abiVersion === CPU_ABI_VERSION
    && integer(value.info.memoryBytes, 1, 0x100000000);
  if (!isRequestId(value.requestId)) return false;
  if (value.type === 'static-bvh-cancelled') return true;
  if (value.type === 'static-bvh-result') return isStaticBvhResult(value.result);
  return value.type === 'static-bvh-error' && (value.code === 'INVALID_OPTIONS'
    || value.code === 'UNSUPPORTED_LIMIT' || value.code === 'WORKER_FAILED') && typeof value.message === 'string';
}
