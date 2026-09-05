import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeCpuRuntime } from '../../packages/core/src/internal/cpu-runtime.js';
import { isStaticBvhInput, isWorkerResponse, type StaticBvhInput, type StaticBvhResult } from '../../packages/core/src/internal/protocol.js';
import { estimateStaticBvhWorkingBytes, staticBvhLimits } from '../../packages/core/src/imported/static-trace-format.js';

class MockWorker extends EventTarget {
  static current: MockWorker;
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  constructor() { super(); MockWorker.current = this; }
  message(data: unknown): void { this.dispatchEvent(new MessageEvent('message', { data })); }
}
function input(): StaticBvhInput { return { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) }; }
function result(): StaticBvhResult { return { nodes: new ArrayBuffer(32), triangles: new ArrayBuffer(64), vertexCount: 3, triangleCount: 1,
  nodeCount: 1, maxDepth: 1, workUnits: 8, workingBytes: estimateStaticBvhWorkingBytes(3, 1), wasmMemoryBytes: 2 * 1024 * 1024 }; }
async function initialize() {
  const promise = initializeCpuRuntime(); const worker = MockWorker.current;
  worker.message({ type: 'ready', info: { abiVersion: 2, memoryBytes: 65_536 } });
  return { worker, runtime: await promise };
}
beforeEach(() => { vi.stubGlobal('Worker', MockWorker); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('CPU static BVH requests', () => {
  it('keeps listeners after ready and transfers owned copies of only the caller view', async () => {
    const { worker, runtime } = await initialize();
    const source = new Float32Array([99, 0, 0, 0, 1, 0, 0, 0, 1, 0, 99]);
    const indices = new Uint32Array([99, 0, 1, 2, 99]);
    let received: { requestId: number; input: StaticBvhInput } | undefined;
    worker.postMessage.mockImplementation((message, transfer) => { received = structuredClone(message, { transfer }); });
    const promise = runtime.buildStaticBvh({ positions: source.subarray(1, 10), indices: indices.subarray(1, 4) });
    expect(received?.input.positions).toEqual(input().positions);
    expect(received?.input.indices).toEqual(input().indices);
    expect(source.byteLength).toBe(44); expect(indices.byteLength).toBe(20);
    source.fill(7); expect(received?.input.positions[0]).toBe(0);
    const output = result(); worker.message({ type: 'static-bvh-result', requestId: received!.requestId, result: output });
    expect(await promise).toBe(output);
    runtime.dispose(); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects concurrent jobs before reading or copying their input', async () => {
    const { worker, runtime } = await initialize(); const first = runtime.buildStaticBvh(input());
    const getter = vi.fn(() => { throw new Error('Must not inspect a concurrent input.'); });
    await expect(runtime.buildStaticBvh({ get positions() { return getter(); }, indices: new Uint32Array() })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(getter).not.toHaveBeenCalled();
    worker.message({ type: 'static-bvh-result', requestId: 1, result: result() }); await first; runtime.dispose();
  });

  it('rejects cancellation promptly, retains the busy slot until acknowledgement and ignores stale results', async () => {
    const { worker, runtime } = await initialize(); const controller = new AbortController();
    const promise = runtime.buildStaticBvh(input(), { signal: controller.signal });
    const rejection = expect(promise).rejects.toMatchObject({ code: 'SCENE_LOAD_ABORTED', cause: 'replacement' });
    controller.abort('replacement'); await rejection;
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'cancel-static-bvh', requestId: 1 });
    await expect(runtime.buildStaticBvh(input())).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    worker.message({ type: 'static-bvh-cancelled', requestId: 1 });
    const next = runtime.buildStaticBvh(input()); const resolved = vi.fn(); void next.then(resolved);
    worker.message({ type: 'static-bvh-result', requestId: 1, result: result() });
    worker.message({ type: 'static-bvh-cancelled', requestId: 1 });
    await Promise.resolve(); expect(resolved).not.toHaveBeenCalled();
    const output = result(); worker.message({ type: 'static-bvh-result', requestId: 2, result: output });
    expect(await next).toBe(output); runtime.dispose();
  });

  it('accepts a completed result as cancellation acknowledgement without returning it', async () => {
    const { worker, runtime } = await initialize(); const controller = new AbortController();
    const promise = runtime.buildStaticBvh(input(), { signal: controller.signal });
    const rejection = expect(promise).rejects.toMatchObject({ code: 'SCENE_LOAD_ABORTED' });
    controller.abort(); await rejection;
    worker.message({ type: 'static-bvh-result', requestId: 1, result: result() });
    const next = runtime.buildStaticBvh(input()); worker.message({ type: 'static-bvh-result', requestId: 2, result: result() });
    await next; runtime.dispose();
  });

  it.each(['static-bvh-cancelled', 'static-bvh-result', 'static-bvh-error'] as const)(
    'shares an idle barrier across cancellation until %s, then permits replacement', async (terminal) => {
      const { worker, runtime } = await initialize();
      await expect(runtime.waitForStaticBvhIdle()).resolves.toBeUndefined();
      const first = runtime.buildStaticBvh(input()); worker.message({ type: 'static-bvh-result', requestId: 1, result: result() }); await first;
      const controller = new AbortController(); const second = runtime.buildStaticBvh(input(), { signal: controller.signal });
      const aborted = expect(second).rejects.toMatchObject({ code: 'SCENE_LOAD_ABORTED' }); controller.abort(); await aborted;
      const idle = runtime.waitForStaticBvhIdle(); expect(runtime.waitForStaticBvhIdle()).toBe(idle);
      const settled = vi.fn(); void idle.then(settled);
      worker.message({ type: 'static-bvh-result', requestId: 1, result: result() });
      worker.message({ type: 'static-bvh-cancelled', requestId: 1 });
      await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
      await expect(runtime.buildStaticBvh(input())).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
      worker.message({ type: terminal, requestId: 2,
        ...(terminal === 'static-bvh-result' ? { result: result() } : terminal === 'static-bvh-error' ? { code: 'INVALID_OPTIONS', message: 'geometry rejected before cancellation' } : {}) });
      await idle; expect(settled).toHaveBeenCalledTimes(1);
      const replacement = runtime.buildStaticBvh(input()); const replacementIdle = runtime.waitForStaticBvhIdle();
      expect(replacementIdle).not.toBe(idle);
      worker.message({ type: 'static-bvh-result', requestId: 3, result: result() });
      await replacement; await replacementIdle; runtime.dispose();
    },
  );

  it('rejects a requested idle barrier when disposal interrupts cleanup', async () => {
    const { runtime } = await initialize(); const controller = new AbortController();
    const job = runtime.buildStaticBvh(input(), { signal: controller.signal });
    const aborted = expect(job).rejects.toMatchObject({ code: 'SCENE_LOAD_ABORTED' }); controller.abort(); await aborted;
    const idle = runtime.waitForStaticBvhIdle(); const rejected = expect(idle).rejects.toMatchObject({ code: 'ENGINE_DISPOSED' });
    runtime.dispose(); await rejected;
    await expect(runtime.waitForStaticBvhIdle()).rejects.toMatchObject({ code: 'ENGINE_DISPOSED' });
  });

  it.each(['event', 'protocol', 'job'] as const)('rejects both build and idle on fatal worker failure (%s)', async (failure) => {
    const { worker, runtime } = await initialize(); const build = runtime.buildStaticBvh(input());
    const idle = runtime.waitForStaticBvhIdle();
    const rejectedBuild = expect(build).rejects.toMatchObject({ code: 'WORKER_FAILED' });
    const rejectedIdle = expect(idle).rejects.toMatchObject({ code: 'WORKER_FAILED' });
    if (failure === 'event') worker.dispatchEvent(new Event('messageerror'));
    else if (failure === 'protocol') worker.message({ type: 'unexpected' });
    else worker.message({ type: 'static-bvh-error', requestId: 1, code: 'WORKER_FAILED', message: 'WASM trapped' });
    await rejectedBuild; await rejectedIdle;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(runtime.waitForStaticBvhIdle()).rejects.toMatchObject({ code: 'ENGINE_DISPOSED' });
    runtime.dispose();
  });

  it('does not copy/post an already cancelled or malformed request', async () => {
    const { worker, runtime } = await initialize(); const controller = new AbortController(); controller.abort();
    await expect(runtime.buildStaticBvh(input(), { signal: controller.signal })).rejects.toMatchObject({ code: 'SCENE_LOAD_ABORTED' });
    await expect(runtime.buildStaticBvh({ ...input(), positions: new Float32Array(6) })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(runtime.buildStaticBvh(input(), { maxWorkingBytes: 1024 })).rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT' });
    await expect(runtime.buildStaticBvh(input(), { maxWorkingBytes: Infinity })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(runtime.buildStaticBvh(input(), { signal: {} as AbortSignal })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(worker.postMessage).toHaveBeenCalledTimes(1); runtime.dispose();
  });

  it('rejects pending work on disposal, terminates once, and ignores late completion', async () => {
    const { worker, runtime } = await initialize(); const promise = runtime.buildStaticBvh(input());
    const rejection = expect(promise).rejects.toMatchObject({ code: 'ENGINE_DISPOSED' });
    runtime.dispose(); runtime.dispose(); await rejection;
    worker.message({ type: 'static-bvh-result', requestId: 1, result: result() });
    await expect(runtime.buildStaticBvh(input())).rejects.toMatchObject({ code: 'ENGINE_DISPOSED' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'messageerror'])('handles worker %s after initialization', async (kind) => {
    const { worker, runtime } = await initialize(); const promise = runtime.buildStaticBvh(input());
    const rejection = expect(promise).rejects.toMatchObject({ code: 'WORKER_FAILED' });
    worker.dispatchEvent(Object.assign(new Event(kind, { cancelable: true }), { message: 'worker lost' }));
    await rejection; expect(worker.terminate).toHaveBeenCalledTimes(1); runtime.dispose();
  });

  it('rejects malformed result lengths and mismatched counts without leaving the promise pending', async () => {
    for (const output of [{ ...result(), nodes: new ArrayBuffer(0) }, { ...result(), vertexCount: 4, workingBytes: estimateStaticBvhWorkingBytes(4, 1) }]) {
      const { worker, runtime } = await initialize(); const promise = runtime.buildStaticBvh(input());
      const rejection = expect(promise).rejects.toMatchObject({ code: 'WORKER_FAILED' });
      worker.message({ type: 'static-bvh-result', requestId: 1, result: output });
      await rejection; expect(worker.terminate).toHaveBeenCalledTimes(1); runtime.dispose();
    }
  });

  it('preserves per-job errors and accepts a later request', async () => {
    const { worker, runtime } = await initialize(); const promise = runtime.buildStaticBvh(input());
    const idle = runtime.waitForStaticBvhIdle();
    const rejection = expect(promise).rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT' });
    worker.message({ type: 'static-bvh-error', requestId: 1, code: 'UNSUPPORTED_LIMIT', message: 'allocation failed' }); await rejection;
    await expect(idle).resolves.toBeUndefined();
    const next = runtime.buildStaticBvh(input()); worker.message({ type: 'static-bvh-result', requestId: 2, result: result() }); await next;
    expect(worker.terminate).not.toHaveBeenCalled(); runtime.dispose();
  });

  it('updates observed memory on success, failure and cancellation while retaining frozen snapshots', async () => {
    const { worker, runtime } = await initialize(); const initialInfo = runtime.info;
    const first = runtime.buildStaticBvh(input()); worker.message({ type: 'static-bvh-result', requestId: 1, result: result() }); await first;
    expect(runtime.info.memoryBytes).toBe(2 * 1024 * 1024); expect(initialInfo.memoryBytes).toBe(65_536);
    expect(Object.isFrozen(runtime.info)).toBe(true);
    const second = runtime.buildStaticBvh(input()); const rejection = expect(second).rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT' });
    worker.message({ type: 'static-bvh-error', requestId: 2, code: 'UNSUPPORTED_LIMIT', message: 'allocation failed', wasmMemoryBytes: 3 * 1024 * 1024 }); await rejection;
    expect(runtime.info.memoryBytes).toBe(3 * 1024 * 1024);
    const controller = new AbortController(); const third = runtime.buildStaticBvh(input(), { signal: controller.signal });
    const cancelled = expect(third).rejects.toMatchObject({ code: 'SCENE_LOAD_ABORTED' }); controller.abort(); await cancelled;
    worker.message({ type: 'static-bvh-cancelled', requestId: 3, wasmMemoryBytes: 4 * 1024 * 1024 });
    worker.message({ type: 'static-bvh-error', requestId: 2, code: 'UNSUPPORTED_LIMIT', message: 'stale', wasmMemoryBytes: 8 * 1024 * 1024 });
    expect(runtime.info.memoryBytes).toBe(4 * 1024 * 1024); runtime.dispose();
    expect(runtime.info.memoryBytes).toBe(4 * 1024 * 1024);
  });

  it('converts allocation failure while copying caller arrays into a bounded failure', async () => {
    const { worker, runtime } = await initialize(); const geometry = input(); const Original = Float32Array;
    vi.stubGlobal('Float32Array', new Proxy(Original, { construct(target, args) {
      if (args[0] === geometry.positions) throw new RangeError('no memory');
      return Reflect.construct(target, args);
    } }));
    await expect(runtime.buildStaticBvh(geometry)).rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT', cause: { message: 'no memory' } });
    expect(worker.postMessage).toHaveBeenCalledTimes(1); expect(geometry.positions.byteLength).toBe(36); runtime.dispose();
  });

  it('converts posting failure into a settled worker failure', async () => {
    const { worker, runtime } = await initialize(); worker.postMessage.mockImplementation(() => { throw new Error('transfer failed'); });
    await expect(runtime.buildStaticBvh(input())).rejects.toMatchObject({ code: 'WORKER_FAILED', cause: { message: 'transfer failed' } });
    expect(worker.terminate).toHaveBeenCalledTimes(1); runtime.dispose();
  });
});

describe('bounded BVH protocol validation', () => {
  it('rejects malformed views and metadata without invoking an estimator outside its domain', () => {
    expect(isStaticBvhInput({ ...input(), positions: new Float32Array(6) }, staticBvhLimits.defaultWorkingBytes)).toBe(false);
    expect(isStaticBvhInput({ ...input(), positions: new Float32Array(new SharedArrayBuffer(36)) }, staticBvhLimits.defaultWorkingBytes)).toBe(false);
    for (const invalid of [{ vertexCount: 2 }, { triangleCount: 0 }, { nodeCount: 2 }, { maxDepth: 20 }, { workUnits: NaN }, { wasmMemoryBytes: 17 }, { workingBytes: 1 }]) {
      expect(isWorkerResponse({ type: 'static-bvh-result', requestId: 1, result: { ...result(), ...invalid } })).toBe(false);
    }
    expect(isWorkerResponse({ type: 'static-bvh-result', requestId: 1, result: result() })).toBe(true);
    expect(isWorkerResponse({ type: 'static-bvh-cancelled', requestId: 1, wasmMemoryBytes: Infinity })).toBe(false);
    expect(isWorkerResponse({ type: 'static-bvh-error', requestId: 1, code: 'INVALID_OPTIONS', message: 'bad', wasmMemoryBytes: 1 })).toBe(false);
  });
});
