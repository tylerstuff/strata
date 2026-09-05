import { StrataError } from './errors.js';
import { estimateStaticBvhWorkingBytes, staticBvhLimits } from './imported/static-trace-format.js';
import { isRecord, isRequestId, isStaticBvhInput, isStaticBvhMetadata, WORKER_PROTOCOL_VERSION,
  type StaticBvhFailureCode, type StaticBvhInput, type WorkerResponse } from './internal/protocol.js';
import { loadWasmRuntime, type WasmRuntime } from './internal/wasm-runtime.js';

// A narrow worker type avoids mixing conflicting DOM and WebWorker lib declarations.
const scope = globalThis as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};
const stepQuota = 8192;
const maximumStepsPerTurn = 32;
const requestedTurnBudgetMs = 8;
let initializing = false;
let runtime: WasmRuntime | undefined;
let lastRequestId = 0;
interface Job {
  readonly id: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly maxWorkingBytes: number;
  input: StaticBvhInput | undefined;
  started: boolean;
  done: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}
let active: Job | undefined;

function release(job: Job): void {
  if (job.timer !== undefined) clearTimeout(job.timer);
  if (job.started) runtime?.exports.strata_bvh_dispose();
  job.started = false;
  job.input = undefined;
  if (active === job) active = undefined;
}
function failure(id: number, code: StaticBvhFailureCode, message: string): void {
  scope.postMessage({ type: 'static-bvh-error', requestId: id, code, message,
    ...(runtime ? { wasmMemoryBytes: runtime.exports.memory.buffer.byteLength } : {}) });
}
function statusError(status: number): StrataError {
  if (status === 2) return new StrataError('INVALID_OPTIONS', 'Static BVH input contains invalid geometry or unsupported counts.');
  if (status === 3) return new StrataError('UNSUPPORTED_LIMIT', 'The static BVH builder exceeded its allocation budget.');
  return new StrataError('WORKER_FAILED', `The static BVH builder returned invalid state/status ${status}.`);
}
function range(memory: ArrayBuffer, pointer: number, bytes: number): void {
  if (!Number.isSafeInteger(pointer) || pointer <= 0 || pointer % 4 !== 0
    || !Number.isSafeInteger(bytes) || bytes <= 0 || pointer + bytes > memory.byteLength) {
    throw new StrataError('WORKER_FAILED', 'The static BVH builder returned an invalid memory range.');
  }
}
function disjoint(a: number, aBytes: number, b: number, bBytes: number): void {
  if (a < b + bBytes && b < a + aBytes) throw new StrataError('WORKER_FAILED', 'The static BVH builder returned overlapping memory ranges.');
}
function schedule(job: Job): void { job.timer = setTimeout(() => step(job), 0); }
function step(job: Job): void {
  if (active !== job || !runtime) return;
  job.timer = undefined;
  const wasm = runtime.exports;
  try {
    if (!job.started) {
      // Starting on a later task lets cancellation run before allocating WASM storage.
      job.started = true;
      const status = wasm.strata_bvh_begin(job.vertexCount, job.triangleCount, job.maxWorkingBytes);
      if (status !== 0) throw statusError(status);
      const memory = wasm.memory.buffer;
      const positions = wasm.strata_bvh_positions_ptr(), indices = wasm.strata_bvh_indices_ptr();
      range(memory, positions, job.vertexCount * 12); range(memory, indices, job.triangleCount * 12);
      disjoint(positions, job.vertexCount * 12, indices, job.triangleCount * 12);
      new Float32Array(memory, positions, job.vertexCount * 3).set(job.input!.positions);
      new Uint32Array(memory, indices, job.triangleCount * 3).set(job.input!.indices);
      job.input = undefined;
      // Yield after the bounded bulk upload as well as between Rust work quotas.
      schedule(job); return;
    }
    if (!job.done) {
      const startedAt = performance.now();
      // This is a requested scheduling budget, not a browser deadline guarantee:
      // an individual WASM call cannot be interrupted, nor can the bounded bulk copies.
      for (let calls = 0; calls < maximumStepsPerTurn; calls++) {
        const status = wasm.strata_bvh_step(stepQuota);
        if (status !== 0 && status !== 1) throw statusError(status);
        if (status === 1) { job.done = true; break; }
        if (performance.now() - startedAt >= requestedTurnBudgetMs) break;
      }
      // A queued cancellation also gets a turn before result validation/copy/transfer.
      schedule(job); return;
    }
    const memory = wasm.memory.buffer;
    const metadata = { vertexCount: job.vertexCount, triangleCount: job.triangleCount, nodeCount: wasm.strata_bvh_node_count(),
      maxDepth: wasm.strata_bvh_max_depth(), workUnits: wasm.strata_bvh_work_units(), workingBytes: wasm.strata_bvh_working_bytes(),
      wasmMemoryBytes: memory.byteLength };
    if (!isStaticBvhMetadata(metadata) || metadata.workingBytes > job.maxWorkingBytes) throw new StrataError('WORKER_FAILED', 'The static BVH builder returned invalid metadata.');
    const nodes = wasm.strata_bvh_nodes_ptr(), triangles = wasm.strata_bvh_triangles_ptr();
    range(memory, nodes, metadata.nodeCount * 32); range(memory, triangles, metadata.triangleCount * 64);
    disjoint(nodes, metadata.nodeCount * 32, triangles, metadata.triangleCount * 64);
    // Copy out before releasing Rust ownership; never transfer the module's linear memory.
    let nodeBytes: ArrayBuffer, triangleBytes: ArrayBuffer;
    try {
      nodeBytes = memory.slice(nodes, nodes + metadata.nodeCount * 32);
      triangleBytes = memory.slice(triangles, triangles + metadata.triangleCount * 64);
    } catch (cause) { throw new StrataError('UNSUPPORTED_LIMIT', 'Unable to copy static BVH results within available memory.', { cause }); }
    release(job);
    scope.postMessage({ type: 'static-bvh-result', requestId: job.id, result: { ...metadata, nodes: nodeBytes, triangles: triangleBytes } }, [nodeBytes, triangleBytes]);
  } catch (cause) {
    release(job);
    const code = cause instanceof StrataError && (cause.code === 'INVALID_OPTIONS' || cause.code === 'UNSUPPORTED_LIMIT') ? cause.code : 'WORKER_FAILED';
    failure(job.id, code, cause instanceof Error ? cause.message : 'Unexpected static BVH worker failure.');
  }
}

scope.addEventListener('message', (event) => {
  const request = event.data;
  if (isRecord(request) && request.type === 'cancel-static-bvh' && isRequestId(request.requestId)) {
    if (active?.id === request.requestId) {
      release(active);
      scope.postMessage({ type: 'static-bvh-cancelled', requestId: request.requestId, wasmMemoryBytes: runtime!.exports.memory.buffer.byteLength });
    }
    return; // A stale cancellation must never cancel a newer job.
  }
  if (isRecord(request) && request.type === 'build-static-bvh' && isRequestId(request.requestId)) {
    if (!runtime) { failure(request.requestId, 'WORKER_FAILED', 'The CPU worker is not initialized.'); return; }
    if (request.requestId <= lastRequestId) return; // Duplicate/stale requests never reallocate input storage.
    lastRequestId = request.requestId;
    if (active) { failure(request.requestId, 'INVALID_OPTIONS', 'The CPU worker already has an active static BVH job.'); return; }
    if (!Number.isSafeInteger(request.maxWorkingBytes) || (request.maxWorkingBytes as number) < 1
      || (request.maxWorkingBytes as number) > staticBvhLimits.maxWorkingBytes
      || !isStaticBvhInput(request.input, staticBvhLimits.maxWorkingBytes)) {
      failure(request.requestId, 'INVALID_OPTIONS', 'Invalid static BVH input layout, counts or memory limit.'); return;
    }
    const vertexCount = request.input.positions.length / 3, triangleCount = request.input.indices.length / 3;
    if (estimateStaticBvhWorkingBytes(vertexCount, triangleCount) > (request.maxWorkingBytes as number)) {
      failure(request.requestId, 'UNSUPPORTED_LIMIT', 'The static BVH input exceeds its working-memory budget.'); return;
    }
    active = { id: request.requestId, vertexCount, triangleCount, maxWorkingBytes: request.maxWorkingBytes as number, input: request.input, started: false, done: false, timer: undefined };
    schedule(active); return;
  }
  if (!isRecord(request) || request.type !== 'initialize' || request.protocolVersion !== WORKER_PROTOCOL_VERSION
    || (request.wasmUrl !== undefined && typeof request.wasmUrl !== 'string')) {
    scope.postMessage({ type: 'error', code: 'WORKER_FAILED', message: 'Invalid CPU worker protocol.' }); return;
  }
  if (initializing || runtime !== undefined) {
    scope.postMessage({ type: 'error', code: 'WORKER_FAILED', message: 'CPU worker is already initialized.' }); return;
  }
  initializing = true;
  void loadWasmRuntime(request.wasmUrl ?? new URL('./strata_runtime.wasm', import.meta.url))
    .then((result) => { runtime = result; scope.postMessage({ type: 'ready', info: runtime.info }); })
    .catch((cause: unknown) => {
      const code = cause instanceof StrataError && (cause.code === 'WASM_LOAD_FAILED' || cause.code === 'WASM_INCOMPATIBLE') ? cause.code : 'WORKER_FAILED';
      const detail = cause instanceof Error ? `${cause.message}${cause.cause instanceof Error ? ` ${cause.cause.message}` : ''}` : 'Unexpected CPU worker failure.';
      scope.postMessage({ type: 'error', code, message: detail });
    });
});
