import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine, StrataError, type Engine } from '../../packages/core/src/index.js';
import { initializeCpuRuntime } from '../../packages/core/src/internal/cpu-runtime.js';

vi.mock('../../packages/core/src/internal/cpu-runtime.js', () => ({
  initializeCpuRuntime: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

function gpuFixture() {
  const loss = deferred<GPUDeviceLostInfo>();
  const pass = { end: vi.fn() };
  const encoder = {
    beginRenderPass: vi.fn(() => pass),
    finish: vi.fn(() => ({ command: true })),
  };
  const device = {
    features: new Set<GPUFeatureName>(['timestamp-query']),
    limits: { maxTextureDimension2D: 4096 },
    lost: loss.promise,
    destroy: vi.fn(),
    queue: { submit: vi.fn() },
    createCommandEncoder: vi.fn(() => encoder),
  };
  const adapter = {
    features: new Set<GPUFeatureName>(['timestamp-query']),
    limits: {
      maxTextureDimension2D: 8192,
      minUniformBufferOffsetAlignment: 256,
    },
    requestDevice: vi.fn(async () => device as unknown as GPUDevice),
  };
  const gpu = {
    requestAdapter: vi.fn(async () => adapter as unknown as GPUAdapter),
    getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
  };
  const view = {};
  const context = {
    configure: vi.fn(),
    unconfigure: vi.fn(),
    getCurrentTexture: vi.fn(() => ({ createView: () => view })),
  };
  const canvas = {
    width: 640,
    height: 360,
    getContext: vi.fn(() => context),
  } as unknown as HTMLCanvasElement;
  return { loss, device, adapter, gpu, context, canvas, encoder, pass, view };
}

describe('engine lifecycle', () => {
  let fixture: ReturnType<typeof gpuFixture>;
  let cpu: { info: { abiVersion: number; memoryBytes: number }; dispose: ReturnType<typeof vi.fn<() => void>> };
  const engines: Engine[] = [];

  beforeEach(() => {
    vi.resetAllMocks();
    fixture = gpuFixture();
    cpu = { info: { abiVersion: 1, memoryBytes: 65536 }, dispose: vi.fn() };
    vi.mocked(initializeCpuRuntime).mockResolvedValue(cpu);
    vi.stubGlobal('navigator', { gpu: fixture.gpu });
  });

  afterEach(() => {
    for (const engine of engines.splice(0)) engine.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function ready() {
    const engine = await createEngine({ canvas: fixture.canvas });
    engines.push(engine);
    return engine;
  }

  it('initializes the GPU and CPU, submits only requested frames, and releases resources once', async () => {
    const engine = await ready();
    expect(engine.state).toBe('ready');
    expect(engine.info).toEqual({
      format: 'bgra8unorm', features: ['timestamp-query'], maxTextureDimension2D: 4096,
      cpu: { abiVersion: 1, memoryBytes: 65536 },
    });
    expect(Object.isFrozen(engine.info.cpu)).toBe(true);
    expect(fixture.context.configure).toHaveBeenCalledWith({
      device: fixture.device, format: 'bgra8unorm', alphaMode: 'opaque',
    });
    expect(fixture.device.queue.submit).not.toHaveBeenCalled();
    engine.resize(1920, 1080);
    expect([fixture.canvas.width, fixture.canvas.height]).toEqual([1920, 1080]);
    engine.render();
    expect(fixture.encoder.beginRenderPass).toHaveBeenCalledWith(expect.objectContaining({
      colorAttachments: [expect.objectContaining({ view: fixture.view, loadOp: 'clear', storeOp: 'store' })],
    }));
    expect(fixture.pass.end).toHaveBeenCalledOnce();
    expect(fixture.device.queue.submit).toHaveBeenCalledOnce();
    engine.dispose();
    engine.dispose();
    expect(engine.state).toBe('disposed');
    expect(cpu.dispose).toHaveBeenCalledOnce();
    expect(fixture.device.destroy).toHaveBeenCalledOnce();
    expect(fixture.context.unconfigure).toHaveBeenCalledOnce();
    expect(() => engine.render()).toThrowError(expect.objectContaining({ code: 'ENGINE_DISPOSED' }));
    expect(() => engine.resize(10, 10)).toThrowError(expect.objectContaining({ code: 'ENGINE_DISPOSED' }));
  });

  it('reports missing browser WebGPU without touching the canvas or CPU', async () => {
    vi.stubGlobal('navigator', undefined);
    await expect(createEngine({ canvas: fixture.canvas })).rejects.toMatchObject({ code: 'WEBGPU_UNAVAILABLE' });
    expect(fixture.canvas.getContext).not.toHaveBeenCalled();
    expect(initializeCpuRuntime).not.toHaveBeenCalled();
  });

  it('rejects concurrent canvas ownership, then permits reuse after disposal', async () => {
    const adapterWait = deferred<GPUAdapter | null>();
    fixture.gpu.requestAdapter.mockReturnValueOnce(adapterWait.promise as Promise<GPUAdapter>);
    const first = createEngine({ canvas: fixture.canvas });
    await expect(createEngine({ canvas: fixture.canvas })).rejects.toMatchObject({ code: 'CANVAS_IN_USE' });
    adapterWait.resolve(fixture.adapter as unknown as GPUAdapter);
    const engine = await first;
    engine.dispose();
    await ready();
    expect(fixture.gpu.requestAdapter).toHaveBeenCalledTimes(2);
  });

  it('rejects unavailable adapters and releases the canvas for retry', async () => {
    fixture.gpu.requestAdapter.mockResolvedValueOnce(null as unknown as GPUAdapter);
    await expect(createEngine({ canvas: fixture.canvas })).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    expect(initializeCpuRuntime).not.toHaveBeenCalled();
    await ready();
  });

  it('validates feature and capacity requirements before requesting a device', async () => {
    await expect(createEngine({ canvas: fixture.canvas, requiredFeatures: ['shader-f16'] }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' });
    await expect(createEngine({ canvas: fixture.canvas, requiredLimits: { maxTextureDimension2D: 16384 } }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT' });
    await expect(createEngine({ canvas: fixture.canvas, requiredLimits: { unknownLimit: 1 } }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT' });
    await expect(createEngine({ canvas: fixture.canvas, requiredLimits: { maxTextureDimension2D: NaN } }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT' });
    expect(fixture.adapter.requestDevice).not.toHaveBeenCalled();
  });

  it('treats minimum alignment as a ceiling and forwards valid device requirements', async () => {
    await expect(createEngine({ canvas: fixture.canvas, requiredLimits: { minUniformBufferOffsetAlignment: 128 } }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT' });
    const engine = await createEngine({
      canvas: fixture.canvas,
      powerPreference: 'high-performance',
      requiredFeatures: ['timestamp-query'],
      requiredLimits: { minUniformBufferOffsetAlignment: 512, maxTextureDimension2D: 4096 },
    });
    engines.push(engine);
    expect(fixture.gpu.requestAdapter).toHaveBeenLastCalledWith({ powerPreference: 'high-performance' });
    expect(fixture.adapter.requestDevice).toHaveBeenCalledWith({
      label: 'Strata device', requiredFeatures: ['timestamp-query'],
      requiredLimits: { minUniformBufferOffsetAlignment: 512, maxTextureDimension2D: 4096 },
    });
  });

  it('preserves device request causes and allows retry', async () => {
    const cause = new Error('Driver failed');
    fixture.adapter.requestDevice.mockRejectedValueOnce(cause);
    await expect(createEngine({ canvas: fixture.canvas })).rejects.toMatchObject({
      code: 'DEVICE_REQUEST_FAILED', cause,
    });
    await ready();
  });

  it('preserves CPU startup failure and destroys the acquired GPU before retry', async () => {
    const failure = new StrataError('WASM_LOAD_FAILED', 'Bad response');
    vi.mocked(initializeCpuRuntime).mockRejectedValueOnce(failure);
    await expect(createEngine({ canvas: fixture.canvas })).rejects.toBe(failure);
    expect(fixture.device.destroy).toHaveBeenCalledOnce();
    expect(fixture.context.configure).not.toHaveBeenCalled();
    await ready();
  });

  it('releases worker and device when canvas configuration fails', async () => {
    fixture.context.configure.mockImplementationOnce(() => { throw new Error('Configuration failed'); });
    await expect(createEngine({ canvas: fixture.canvas })).rejects.toMatchObject({ code: 'CANVAS_UNAVAILABLE' });
    expect(cpu.dispose).toHaveBeenCalledOnce();
    expect(fixture.device.destroy).toHaveBeenCalledOnce();
    expect(fixture.context.unconfigure).toHaveBeenCalledOnce();
    await ready();
  });

  it('validates physical sizes against the device limit without changing the previous size', async () => {
    const engine = await ready();
    for (const size of [[0, 10], [10, -1], [0.5, 10], [4097, 1], [NaN, 10], [10, Infinity]]) {
      expect(() => engine.resize(size[0]!, size[1]!)).toThrowError(expect.objectContaining({ code: 'INVALID_SIZE' }));
    }
    expect([fixture.canvas.width, fixture.canvas.height]).toEqual([640, 360]);
  });

  it('rejects invalid initial canvas dimensions and releases the acquired device', async () => {
    fixture.canvas.width = 5000;
    await expect(createEngine({ canvas: fixture.canvas })).rejects.toMatchObject({ code: 'INVALID_SIZE' });
    expect(fixture.device.destroy).toHaveBeenCalledOnce();
    expect(initializeCpuRuntime).not.toHaveBeenCalled();
  });

  it('rejects an already aborted initialization without acquiring resources', async () => {
    const controller = new AbortController();
    controller.abort('page closed');
    await expect(createEngine({ canvas: fixture.canvas, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'INITIALIZATION_ABORTED', cause: 'page closed' });
    expect(fixture.gpu.requestAdapter).not.toHaveBeenCalled();
  });

  it('aborts a pending adapter request and never requests a late device', async () => {
    const adapterWait = deferred<GPUAdapter>();
    fixture.gpu.requestAdapter.mockReturnValueOnce(adapterWait.promise);
    const controller = new AbortController();
    const pending = createEngine({ canvas: fixture.canvas, signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'INITIALIZATION_ABORTED' });
    controller.abort();
    await rejection;
    adapterWait.resolve(fixture.adapter as unknown as GPUAdapter);
    await flushMicrotasks();
    expect(fixture.adapter.requestDevice).not.toHaveBeenCalled();
    await ready();
  });

  it('destroys a device that resolves after cancellation and permits immediate canvas reuse', async () => {
    const lateDevice = { ...fixture.device, destroy: vi.fn() };
    const deviceWait = deferred<GPUDevice>();
    fixture.adapter.requestDevice.mockReturnValueOnce(deviceWait.promise);
    const controller = new AbortController();
    const pending = createEngine({ canvas: fixture.canvas, signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'INITIALIZATION_ABORTED' });
    await flushMicrotasks();
    expect(fixture.adapter.requestDevice).toHaveBeenCalledOnce();
    controller.abort();
    await rejection;
    await ready();
    deviceWait.resolve(lateDevice as unknown as GPUDevice);
    await flushMicrotasks();
    expect(lateDevice.destroy).toHaveBeenCalledOnce();
    expect(fixture.device.destroy).not.toHaveBeenCalled();
  });

  it('does not start a new GPU phase when abort arrives between promise continuations', async () => {
    const controller = new AbortController();
    fixture.gpu.requestAdapter.mockImplementationOnce(() => {
      queueMicrotask(() => queueMicrotask(() => controller.abort()));
      return Promise.resolve(fixture.adapter as unknown as GPUAdapter);
    });
    await expect(createEngine({ canvas: fixture.canvas, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'INITIALIZATION_ABORTED' });
    expect(fixture.adapter.requestDevice).not.toHaveBeenCalled();
    expect(initializeCpuRuntime).not.toHaveBeenCalled();
  });

  it('releases a device when abort arrives between its promise continuations', async () => {
    const controller = new AbortController();
    fixture.adapter.requestDevice.mockImplementationOnce(() => {
      queueMicrotask(() => queueMicrotask(() => controller.abort()));
      return Promise.resolve(fixture.device as unknown as GPUDevice);
    });
    await expect(createEngine({ canvas: fixture.canvas, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'INITIALIZATION_ABORTED' });
    expect(fixture.device.destroy).toHaveBeenCalledOnce();
    expect(initializeCpuRuntime).not.toHaveBeenCalled();
  });

  it('enforces one total deadline and releases late CPU startup results', async () => {
    vi.useFakeTimers();
    const cpuWait = deferred<typeof cpu>();
    vi.mocked(initializeCpuRuntime).mockReturnValueOnce(cpuWait.promise);
    const pending = createEngine({ canvas: fixture.canvas, initializationTimeoutMs: 25 });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'INITIALIZATION_TIMEOUT' });
    await flushMicrotasks();
    const cpuSignal = vi.mocked(initializeCpuRuntime).mock.calls[0]![0]!.signal!;
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(cpuSignal.aborted).toBe(true);
    expect(fixture.device.destroy).toHaveBeenCalledOnce();
    cpuWait.resolve(cpu);
    await flushMicrotasks();
    expect(cpu.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes the initialization abort listener and deadline once ready', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const engine = await createEngine({ canvas: fixture.canvas, signal: controller.signal });
    engines.push(engine);
    controller.abort();
    expect(engine.state).toBe('ready');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    expect(cpu.dispose).not.toHaveBeenCalled();
  });

  it('rejects device loss during startup and disposes a late CPU runtime', async () => {
    const cpuWait = deferred<typeof cpu>();
    vi.mocked(initializeCpuRuntime).mockReturnValueOnce(cpuWait.promise);
    const pending = createEngine({ canvas: fixture.canvas });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'DEVICE_LOST' });
    await flushMicrotasks();
    fixture.loss.resolve({ reason: 'unknown', message: 'GPU reset' } as GPUDeviceLostInfo);
    await rejection;
    cpuWait.resolve(cpu);
    await flushMicrotasks();
    expect(cpu.dispose).toHaveBeenCalledOnce();
    expect(fixture.device.destroy).toHaveBeenCalledOnce();
    expect(fixture.context.configure).not.toHaveBeenCalled();
  });

  it('releases resources on device loss and allows explicit reinitialization', async () => {
    const engine = await ready();
    fixture.loss.resolve({ reason: 'unknown', message: 'GPU reset' } as GPUDeviceLostInfo);
    await flushMicrotasks();
    expect(engine.state).toBe('lost');
    expect(cpu.dispose).toHaveBeenCalledOnce();
    expect(fixture.context.unconfigure).toHaveBeenCalledOnce();
    expect(fixture.device.destroy).toHaveBeenCalledOnce();
    expect(() => engine.render()).toThrowError(expect.objectContaining({ code: 'DEVICE_LOST' }));
    expect(() => engine.resize(10, 10)).toThrowError(expect.objectContaining({ code: 'DEVICE_LOST' }));
    const fresh = gpuFixture();
    fixture.gpu.requestAdapter.mockResolvedValue(fresh.adapter as unknown as GPUAdapter);
    await ready();
    engine.dispose();
    expect(engine.state).toBe('disposed');
    expect(fresh.device.destroy).not.toHaveBeenCalled();
  });

  it('keeps disposal final when its destroyed device subsequently reports loss', async () => {
    const engine = await ready();
    engine.dispose();
    fixture.loss.resolve({ reason: 'destroyed', message: 'Destroyed' } as GPUDeviceLostInfo);
    await flushMicrotasks();
    expect(engine.state).toBe('disposed');
    expect(cpu.dispose).toHaveBeenCalledOnce();
    expect(fixture.device.destroy).toHaveBeenCalledOnce();
  });
});
