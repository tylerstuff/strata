import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateStaticBvhWorkingBytes, staticBvhLimits } from '../../packages/core/src/imported/static-trace-format.js';
import { loadWasmRuntime } from '../../packages/core/src/internal/wasm-runtime.js';
import { isWorkerResponse, type StaticBvhInput, type StaticBvhResult } from '../../packages/core/src/internal/protocol.js';
vi.mock('../../packages/core/src/internal/wasm-runtime.js', () => ({ loadWasmRuntime: vi.fn() }));

function input(): StaticBvhInput { return { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) }; }
function wasmExports() {
  const memory = new WebAssembly.Memory({ initial: 32 });
  new Uint8Array(memory.buffer, 256, 32).fill(7); new Uint8Array(memory.buffer, 512, 64).fill(9);
  return { memory, strata_abi_version: vi.fn(() => 2), strata_runtime_initialize: vi.fn(() => 0), strata_runtime_dispose: vi.fn(() => 0), strata_runtime_is_initialized: vi.fn(() => 1),
    strata_bvh_begin: vi.fn(() => 0), strata_bvh_positions_ptr: vi.fn(() => 64), strata_bvh_indices_ptr: vi.fn(() => 128), strata_bvh_step: vi.fn((_workUnits: number) => 1),
    strata_bvh_nodes_ptr: vi.fn(() => 256), strata_bvh_triangles_ptr: vi.fn(() => 512), strata_bvh_node_count: vi.fn(() => 1),
    strata_bvh_max_depth: vi.fn(() => 1), strata_bvh_work_units: vi.fn(() => 8), strata_bvh_working_bytes: vi.fn(() => estimateStaticBvhWorkingBytes(3, 1)), strata_bvh_dispose: vi.fn() };
}
let listener: (event: MessageEvent<unknown>) => void;
let post: ReturnType<typeof vi.fn>;
function message(data: unknown): void { listener(new MessageEvent('message', { data })); }
function build(id = 1, geometry = input(), maxWorkingBytes = staticBvhLimits.defaultWorkingBytes): void { message({ type: 'build-static-bvh', requestId: id, input: geometry, maxWorkingBytes }); }
async function start() {
  const wasm = wasmExports();
  vi.mocked(loadWasmRuntime).mockResolvedValue({ info: { abiVersion: 2, memoryBytes: wasm.memory.buffer.byteLength }, exports: wasm });
  await import('../../packages/core/src/worker.js');
  message({ type: 'initialize', protocolVersion: 2 }); await Promise.resolve();
  expect(post).toHaveBeenLastCalledWith({ type: 'ready', info: { abiVersion: 2, memoryBytes: wasm.memory.buffer.byteLength } });
  post.mockClear(); return wasm;
}
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); post = vi.fn();
  vi.stubGlobal('addEventListener', vi.fn((_type: string, fn: typeof listener) => { listener = fn; }));
  vi.stubGlobal('postMessage', post);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('stepped worker BVH scheduling', () => {
  it('yields before allocation, uses bounded quotas and yields before copying results', async () => {
    const wasm = await start(); wasm.strata_bvh_step.mockReturnValueOnce(0).mockReturnValueOnce(1);
    const geometry = input(); build();
    expect(wasm.strata_bvh_begin).not.toHaveBeenCalled();
    await vi.advanceTimersToNextTimerAsync();
    expect(wasm.strata_bvh_begin).toHaveBeenCalledWith(3, 1, staticBvhLimits.defaultWorkingBytes);
    expect(new Float32Array(wasm.memory.buffer, 64, 9)).toEqual(geometry.positions);
    expect(new Uint32Array(wasm.memory.buffer, 128, 3)).toEqual(geometry.indices);
    expect(wasm.strata_bvh_step).not.toHaveBeenCalled();
    await vi.advanceTimersToNextTimerAsync();
    expect(wasm.strata_bvh_step).toHaveBeenCalledTimes(2); expect(wasm.strata_bvh_step).toHaveBeenLastCalledWith(8192);
    expect(post).not.toHaveBeenCalled();
    await vi.advanceTimersToNextTimerAsync();
    const [response, transfers] = post.mock.calls[0]!;
    expect(response).toMatchObject({ type: 'static-bvh-result', requestId: 1, result: { nodeCount: 1, triangleCount: 1, wasmMemoryBytes: 2 * 1024 * 1024 } });
    expect(transfers).toEqual([response.result.nodes, response.result.triangles]);
    expect(response.result.nodes).not.toBe(wasm.memory.buffer); expect(new Uint8Array(response.result.nodes)).toEqual(new Uint8Array(32).fill(7));
    expect(new Uint8Array(response.result.triangles)).toEqual(new Uint8Array(64).fill(9));
    expect(wasm.strata_bvh_dispose).toHaveBeenCalledTimes(1);
    new Uint8Array(wasm.memory.buffer).fill(0); expect(new Uint8Array(response.result.nodes)[0]).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps a worker turn at 32 calls even when its clock does not advance', async () => {
    const wasm = await start(); wasm.strata_bvh_step.mockReturnValue(0);
    vi.spyOn(performance, 'now').mockReturnValue(0);
    build(); await vi.advanceTimersToNextTimerAsync(); await vi.advanceTimersToNextTimerAsync();
    expect(wasm.strata_bvh_step).toHaveBeenCalledTimes(32);
    expect(wasm.strata_bvh_step.mock.calls.every(([quota]) => quota === 8192)).toBe(true);
    message({ type: 'cancel-static-bvh', requestId: 1 }); await vi.runAllTimersAsync();
    expect(wasm.strata_bvh_step).toHaveBeenCalledTimes(32); expect(vi.getTimerCount()).toBe(0);
  });

  it('yields after the time budget is reached before the maximum call count', async () => {
    const wasm = await start(); let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    wasm.strata_bvh_step.mockImplementation(() => { elapsed += 3; return 0; });
    build(); await vi.advanceTimersToNextTimerAsync(); await vi.advanceTimersToNextTimerAsync();
    expect(wasm.strata_bvh_step).toHaveBeenCalledTimes(3);
    message({ type: 'cancel-static-bvh', requestId: 1 }); await vi.runAllTimersAsync();
    expect(wasm.strata_bvh_step).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels before allocating or copying any input', async () => {
    const wasm = await start(); build(); message({ type: 'cancel-static-bvh', requestId: 1 });
    await vi.runAllTimersAsync();
    expect(wasm.strata_bvh_begin).not.toHaveBeenCalled(); expect(wasm.strata_bvh_dispose).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledExactlyOnceWith({ type: 'static-bvh-cancelled', requestId: 1, wasmMemoryBytes: 2 * 1024 * 1024 });
  });

  it('cancels between steps and prevents a queued completed result from allocating copies', async () => {
    const wasm = await start(); build();
    await vi.advanceTimersToNextTimerAsync(); await vi.advanceTimersToNextTimerAsync();
    expect(wasm.strata_bvh_step).toHaveBeenCalledTimes(1);
    message({ type: 'cancel-static-bvh', requestId: 1 }); await vi.runAllTimersAsync();
    expect(wasm.strata_bvh_nodes_ptr).not.toHaveBeenCalled(); expect(wasm.strata_bvh_dispose).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledExactlyOnceWith({ type: 'static-bvh-cancelled', requestId: 1, wasmMemoryBytes: 2 * 1024 * 1024 });
  });

  it('ignores stale cancellation/duplicate builds and rejects concurrency without disturbing the active job', async () => {
    const wasm = await start(); build(); build(2); build(1); message({ type: 'cancel-static-bvh', requestId: 2 });
    expect(post).toHaveBeenCalledExactlyOnceWith({ type: 'static-bvh-error', requestId: 2, code: 'INVALID_OPTIONS', message: expect.any(String), wasmMemoryBytes: 2 * 1024 * 1024 });
    await vi.runAllTimersAsync();
    expect(wasm.strata_bvh_begin).toHaveBeenCalledTimes(1); expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'static-bvh-result', requestId: 1 }), expect.any(Array));
    build(3); message({ type: 'cancel-static-bvh', requestId: 1 }); await vi.runAllTimersAsync();
    expect(wasm.strata_bvh_begin).toHaveBeenCalledTimes(2); expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'static-bvh-result', requestId: 3 }), expect.any(Array));
  });

  it('rejects malformed/count/budget protocol inputs before Rust allocation', async () => {
    const wasm = await start(); build(1, { ...input(), positions: new Float32Array(6) }); build(2, input(), 1024);
    message({ type: 'build-static-bvh', requestId: 3, input: { positions: new Float32Array(9), indices: new Uint8Array(3) }, maxWorkingBytes: staticBvhLimits.defaultWorkingBytes });
    await vi.runAllTimersAsync(); expect(wasm.strata_bvh_begin).not.toHaveBeenCalled();
    expect(post.mock.calls.map(([response]) => response.code)).toEqual(['INVALID_OPTIONS', 'UNSUPPORTED_LIMIT', 'INVALID_OPTIONS']);
  });

  it('checks returned metadata before even requesting output pointers or copying buffers', async () => {
    const wasm = await start(); wasm.strata_bvh_node_count.mockReturnValue(0x7fffffff); build(); await vi.runAllTimersAsync();
    expect(post).toHaveBeenCalledExactlyOnceWith({ type: 'static-bvh-error', requestId: 1, code: 'WORKER_FAILED', message: expect.any(String), wasmMemoryBytes: 2 * 1024 * 1024 });
    expect(wasm.strata_bvh_nodes_ptr).not.toHaveBeenCalled(); expect(wasm.strata_bvh_dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects out-of-range memory pointers before constructing a typed view', async () => {
    const wasm = await start(); wasm.strata_bvh_positions_ptr.mockReturnValue(wasm.memory.buffer.byteLength - 4); build(); await vi.runAllTimersAsync();
    expect(wasm.strata_bvh_step).not.toHaveBeenCalled(); expect(wasm.strata_bvh_dispose).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledExactlyOnceWith({ type: 'static-bvh-error', requestId: 1, code: 'WORKER_FAILED', message: expect.any(String), wasmMemoryBytes: 2 * 1024 * 1024 });
  });

  it.each([[2, 'INVALID_OPTIONS'], [3, 'UNSUPPORTED_LIMIT'], [4, 'WORKER_FAILED']] as const)('maps Rust step status %s and releases ownership', async (status, code) => {
    const wasm = await start(); wasm.strata_bvh_step.mockReturnValue(status); build(); await vi.runAllTimersAsync();
    expect(post).toHaveBeenCalledExactlyOnceWith({ type: 'static-bvh-error', requestId: 1, code, message: expect.any(String), wasmMemoryBytes: 2 * 1024 * 1024 });
    expect(wasm.strata_bvh_dispose).toHaveBeenCalledTimes(1);
  });
});

describe('compiled WASM through the worker protocol', () => {
  async function startCompiled() {
    const bytes = new Uint8Array(await readFile(new URL('../../target/wasm32-unknown-unknown/release/strata_runtime.wasm', import.meta.url)));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
    const actual = await vi.importActual<typeof import('../../packages/core/src/internal/wasm-runtime.js')>('../../packages/core/src/internal/wasm-runtime.js');
    const runtime = await actual.loadWasmRuntime('https://example.test/runtime.wasm');
    vi.mocked(loadWasmRuntime).mockResolvedValue(runtime);
    await import('../../packages/core/src/worker.js'); message({ type: 'initialize', protocolVersion: 2 }); await Promise.resolve(); post.mockClear();
    return runtime;
  }

  it('builds known triangles, preserves source identity in reordered records and reuses the worker', async () => {
    const runtime = await startCompiled();
    const positions = new Float32Array([-4, 0, 2, -3, 0, 2, -4, 1, 2, 2, 0, 3, 3, 0, 3, 2, 1, 3]);
    const indices = new Uint32Array([3, 4, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5]);
    build(1, { positions, indices }); await vi.runAllTimersAsync();
    const response = post.mock.calls.at(-1)![0]; expect(isWorkerResponse(response)).toBe(true); expect(response.type).toBe('static-bvh-result');
    const result = response.result as StaticBvhResult; expect(result).toMatchObject({ vertexCount: 6, triangleCount: 5, nodeCount: 3, maxDepth: 2 });
    const nodes = new DataView(result.nodes);
    expect([nodes.getFloat32(0, true), nodes.getFloat32(4, true), nodes.getFloat32(8, true)]).toEqual([-4, 0, 2]);
    expect([nodes.getFloat32(16, true), nodes.getFloat32(20, true), nodes.getFloat32(24, true)]).toEqual([3, 1, 3]);
    const triangles = new DataView(result.triangles); const seen = new Set<number>();
    for (let record = 0; record < 5; record++) {
      const offset = record * 64, source = triangles.getUint32(offset + 44, true); seen.add(source);
      expect(triangles.getUint32(offset + 28, true)).toBe(indices[source * 3]);
      for (let corner = 0; corner < 3; corner++) for (let axis = 0; axis < 3; axis++) {
        expect(triangles.getFloat32(offset + corner * 16 + axis * 4, true)).toBe(positions[indices[source * 3 + corner]! * 3 + axis]);
      }
      expect([0, 1, 2].map(axis => triangles.getFloat32(offset + 48 + axis * 4, true))).toEqual([0, 0, 1]);
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(runtime.exports.strata_bvh_node_count()).toBe(0);
    build(2); await vi.runAllTimersAsync(); expect(post.mock.calls.at(-1)![0]).toMatchObject({ type: 'static-bvh-result', requestId: 2 });
    expect(result.wasmMemoryBytes).toBeLessThanOrEqual(runtime.exports.memory.buffer.byteLength);
    runtime.exports.strata_runtime_dispose();
  });

  it('cancels allocated Rust state and subsequently rejects invalid geometry without a leak', async () => {
    const runtime = await startCompiled(); build(); await vi.advanceTimersToNextTimerAsync();
    message({ type: 'cancel-static-bvh', requestId: 1 }); await vi.runAllTimersAsync();
    expect(post.mock.calls.at(-1)![0]).toMatchObject({ type: 'static-bvh-cancelled', requestId: 1, wasmMemoryBytes: runtime.exports.memory.buffer.byteLength });
    expect(runtime.exports.strata_bvh_step(1)).toBe(4);
    build(2, { ...input(), indices: new Uint32Array([0, 1, 99]) }); await vi.runAllTimersAsync();
    expect(post.mock.calls.at(-1)![0]).toMatchObject({ type: 'static-bvh-error', requestId: 2, code: 'INVALID_OPTIONS' });
    expect(runtime.exports.strata_bvh_step(1)).toBe(4);
    runtime.exports.strata_runtime_dispose();
  });
});
