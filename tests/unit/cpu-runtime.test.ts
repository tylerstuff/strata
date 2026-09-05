import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeCpuRuntime } from '../../packages/core/src/internal/cpu-runtime.js';
import { loadWasmRuntime } from '../../packages/core/src/internal/wasm-runtime.js';

class MockWorker extends EventTarget {
  static instances: MockWorker[] = [];
  readonly terminate = vi.fn();
  readonly postMessage = vi.fn();

  constructor(readonly url: URL | string, readonly options: WorkerOptions) {
    super();
    MockWorker.instances.push(this);
  }

  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

const ready = { type: 'ready', info: { abiVersion: 2, memoryBytes: 65_536 } };

function currentWorker(): MockWorker {
  const worker = MockWorker.instances.at(-1);
  if (!worker) throw new Error('Expected a worker to have been created.');
  return worker;
}

beforeEach(() => {
  MockWorker.instances = [];
  vi.stubGlobal('Worker', MockWorker);
  vi.stubGlobal('location', new URL('https://example.test/game/index.html'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CPU worker client lifecycle', () => {
  it('starts the bundled module worker and releases its heap exactly once', async () => {
    const pending = initializeCpuRuntime();
    const worker = currentWorker();
    expect(String(worker.url)).toMatch(/\/worker\.js$/);
    expect(worker.options).toEqual({ type: 'module' });
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'initialize', protocolVersion: 2 });
    worker.message(ready);
    const runtime = await pending;
    expect(runtime.info).toEqual(ready.info);
    expect(Object.isFrozen(runtime.info)).toBe(true);
    expect(worker.terminate).not.toHaveBeenCalled();
    runtime.dispose();
    runtime.dispose();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('resolves custom WASM locations relative to the embedding page', async () => {
    const pending = initializeCpuRuntime({ workerUrl: '/assets/cpu.js', wasmUrl: './engine.wasm' });
    const worker = currentWorker();
    expect(worker.url).toBe('/assets/cpu.js');
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'initialize',
      protocolVersion: 2,
      wasmUrl: 'https://example.test/game/engine.wasm',
    });
    worker.message(ready);
    (await pending).dispose();
  });

  it('rejects cancellation before allocating a worker', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    await expect(initializeCpuRuntime({ signal: controller.signal })).rejects.toMatchObject({
      code: 'INITIALIZATION_ABORTED', cause: 'cancelled',
    });
    expect(MockWorker.instances).toHaveLength(0);
  });

  it('terminates pending work on cancellation and removes startup listeners', async () => {
    const controller = new AbortController();
    const pending = initializeCpuRuntime({ signal: controller.signal });
    const worker = currentWorker();
    const remove = vi.spyOn(worker, 'removeEventListener');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'INITIALIZATION_ABORTED' });
    worker.message(ready);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls.map(([event]) => event)).toEqual(['message', 'error', 'messageerror']);
  });

  it('stops listening to initialization cancellation after becoming ready', async () => {
    const controller = new AbortController();
    const pending = initializeCpuRuntime({ signal: controller.signal });
    const worker = currentWorker();
    worker.message(ready);
    const runtime = await pending;
    controller.abort();
    expect(worker.terminate).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('bounds initialization time and cannot be revived by a late ready message', async () => {
    vi.useFakeTimers();
    const pending = initializeCpuRuntime({ timeoutMs: 20 });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'INITIALIZATION_TIMEOUT' });
    const worker = currentWorker();
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    worker.message(ready);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports unavailable workers without requiring browser globals at import time', async () => {
    vi.stubGlobal('Worker', undefined);
    await expect(initializeCpuRuntime()).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' });
  });

  it('preserves a worker-construction failure as the cause', async () => {
    const cause = new Error('Blocked by worker-src');
    vi.stubGlobal('Worker', class { constructor() { throw cause; } });
    await expect(initializeCpuRuntime()).rejects.toMatchObject({ code: 'WORKER_FAILED', cause });
  });

  it('releases the allocated worker if sending its initialization message fails', async () => {
    const cause = new Error('Unable to post initialization.');
    vi.stubGlobal('Worker', class extends MockWorker {
      constructor(url: URL | string, options: WorkerOptions) {
        super(url, options);
        this.postMessage.mockImplementation(() => { throw cause; });
      }
    });
    await expect(initializeCpuRuntime()).rejects.toMatchObject({ code: 'WORKER_FAILED', cause });
    expect(currentWorker().terminate).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, Infinity, NaN, 2_147_483_648])('rejects invalid timeout %s before creating a worker', async (timeoutMs) => {
    await expect(initializeCpuRuntime({ timeoutMs })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(MockWorker.instances).toHaveLength(0);
  });

  it.each([
    undefined,
    { type: 'ready', info: { abiVersion: 1, memoryBytes: 65_536 } },
    { type: 'ready', info: { abiVersion: 2, memoryBytes: -1 } },
    { type: 'error', code: 'unknown', message: 'bad protocol' },
  ])('rejects invalid worker responses and releases the worker', async (response) => {
    const pending = initializeCpuRuntime();
    const worker = currentWorker();
    worker.message(response);
    await expect(pending).rejects.toMatchObject({ code: 'WORKER_FAILED' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it.each(['WASM_LOAD_FAILED', 'WASM_INCOMPATIBLE'] as const)('preserves the worker failure code %s', async (code) => {
    const pending = initializeCpuRuntime();
    const worker = currentWorker();
    worker.message({ type: 'error', code, message: 'Module could not start.' });
    await expect(pending).rejects.toMatchObject({ code, message: 'Module could not start.' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('handles worker script errors and failed message deserialization', async () => {
    const first = initializeCpuRuntime();
    const failedWorker = currentWorker();
    const error = Object.assign(new Event('error', { cancelable: true }), {
      message: 'Worker script failed.', error: new Error('network'),
    });
    failedWorker.dispatchEvent(error);
    await expect(first).rejects.toMatchObject({ code: 'WORKER_FAILED', message: 'Worker script failed.' });
    expect(error.defaultPrevented).toBe(true);
    expect(failedWorker.terminate).toHaveBeenCalledTimes(1);

    const second = initializeCpuRuntime();
    const unreadableWorker = currentWorker();
    unreadableWorker.dispatchEvent(new Event('messageerror'));
    await expect(second).rejects.toMatchObject({ code: 'WORKER_FAILED' });
    expect(unreadableWorker.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('WASM asset loading', () => {
  it('initializes the compiled Rust module with independent lifecycle and memory per instance', async () => {
    const bytes = new Uint8Array(await readFile(new URL(
      '../../target/wasm32-unknown-unknown/release/strata_runtime.wasm',
      import.meta.url,
    )));
    // An octet-stream server is supported: streaming MIME configuration is optional.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(bytes, {
      headers: { 'Content-Type': 'application/octet-stream' },
    })));
    const first = await loadWasmRuntime('https://example.test/strata_runtime.wasm');
    const second = await loadWasmRuntime('https://example.test/strata_runtime.wasm');
    expect(first.info.abiVersion).toBe(2);
    expect(first.info.memoryBytes).toBe(first.exports.memory.buffer.byteLength);
    expect(first.info.memoryBytes).toBeGreaterThan(0);
    expect(first.exports.memory).not.toBe(second.exports.memory);
    expect(first.exports.strata_runtime_initialize()).toBe(1);
    expect(first.exports.strata_runtime_dispose()).toBe(0);
    expect(first.exports.strata_runtime_is_initialized()).toBe(0);
    expect(second.exports.strata_runtime_is_initialized()).toBe(1);
    expect(second.exports.strata_runtime_dispose()).toBe(0);
  });

  it('distinguishes an HTTP failure from an incompatible WASM module', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing', { status: 404 })));
    await expect(loadWasmRuntime('https://example.test/missing.wasm')).rejects.toMatchObject({
      code: 'WASM_LOAD_FAILED',
      cause: { message: 'HTTP 404 ' },
    });
  });

  it('rejects an HTML response served successfully at a missing asset path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<!doctype html>')));
    await expect(loadWasmRuntime('https://example.test/not-wasm')).rejects.toMatchObject({
      code: 'WASM_INCOMPATIBLE',
    });
  });

  it('rejects a valid WebAssembly module that lacks the runtime exports', async () => {
    const emptyModule = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(emptyModule)));
    await expect(loadWasmRuntime('https://example.test/empty.wasm')).rejects.toMatchObject({
      code: 'WASM_INCOMPATIBLE',
      cause: { message: 'Missing WASM export: strata_abi_version' },
    });
  });
});
