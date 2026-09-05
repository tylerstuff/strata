import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine, type Engine } from '../../packages/core/src/index.js';
import { initializeCpuRuntime } from '../../packages/core/src/internal/cpu-runtime.js';
import { GpuProfiler } from '../../packages/core/src/profiling/gpu-profiler.js';
import { SceneRenderer } from '../../packages/core/src/rendering/scene-renderer.js';
import { RasterRenderer } from '../../packages/core/src/rendering/raster-renderer.js';
import { VirtualRenderer } from '../../packages/core/src/geometry/virtual-renderer.js';
import type { RasterControls } from '../../packages/core/src/rendering/raster-types.js';

vi.mock('../../packages/core/src/internal/cpu-runtime.js', () => ({ initializeCpuRuntime: vi.fn() }));
vi.mock('../../packages/core/src/rendering/scene-renderer.js', () => ({ SceneRenderer: { create: vi.fn() } }));
vi.mock('../../packages/core/src/rendering/raster-renderer.js', () => ({ RasterRenderer: { create: vi.fn() } }));
vi.mock('../../packages/core/src/geometry/virtual-renderer.js', () => ({ VirtualRenderer: { create: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function microtasks() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

function fixture() {
  const loss = deferred<GPUDeviceLostInfo>();
  const events = new EventTarget();
  const buffers: Array<ReturnType<typeof buffer>> = [];
  const queries: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  function buffer(descriptor: GPUBufferDescriptor) {
    const mapping = deferred<void>();
    const data = new BigUint64Array(descriptor.size / 8);
    for (let index = 0; index < data.length; index += 2) {
      data[index] = 1_000_000n;
      data[index + 1] = 3_500_000n;
    }
    return {
      descriptor, mapping, data,
      mapAsync: vi.fn(() => mapping.promise),
      getMappedRange: vi.fn((offset = 0, size = descriptor.size) => data.buffer.slice(offset, offset + size)),
      unmap: vi.fn(), destroy: vi.fn(),
    };
  }
  const encoder = {
    beginRenderPass: vi.fn(() => ({ end: vi.fn() })),
    resolveQuerySet: vi.fn(), copyBufferToBuffer: vi.fn(), finish: vi.fn(() => ({})),
  };
  const device = {
    features: new Set<GPUFeatureName>(['timestamp-query']),
    limits: { maxTextureDimension2D: 8192 }, lost: loss.promise, destroy: vi.fn(),
    addEventListener: vi.fn(events.addEventListener.bind(events)),
    removeEventListener: vi.fn(events.removeEventListener.bind(events)),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const value = buffer(descriptor); buffers.push(value); return value;
    }),
    createQuerySet: vi.fn((_descriptor: GPUQuerySetDescriptor) => { const value = { destroy: vi.fn() }; queries.push(value); return value; }),
    createCommandEncoder: vi.fn(() => encoder), queue: { submit: vi.fn() },
  };
  const adapter = {
    features: new Set<GPUFeatureName>(['timestamp-query']),
    limits: { maxTextureDimension2D: 16384 },
    info: { vendor: 'test', architecture: 'mock', device: '', description: '', isFallbackAdapter: false },
    requestDevice: vi.fn(async () => device as unknown as GPUDevice),
  };
  const context = { configure: vi.fn(), unconfigure: vi.fn(), getCurrentTexture: () => ({ createView: () => ({}) }) };
  const canvas = { width: 640, height: 360, getContext: () => context } as unknown as HTMLCanvasElement;
  const gpu = { requestAdapter: vi.fn(async () => adapter), getPreferredCanvasFormat: () => 'bgra8unorm' };
  return { loss, events, buffers, queries, encoder, device, adapter, context, canvas, gpu };
}

describe('bounded GPU timestamps', () => {
  it('keeps frame identity with asynchronous completions and drops busy-ring samples without allocating', async () => {
    const f = fixture();
    const profiler = new GpuProfiler(f.device as unknown as GPUDevice, 2);
    const first = profiler.begin(10, 'raster')!;
    const second = profiler.begin(11, 'raster')!;
    expect(profiler.begin(12, 'raster')).toBeNull();
    profiler.resolve(f.encoder as unknown as GPUCommandEncoder, first);
    profiler.submitted(first);
    profiler.submitted(second);
    expect(f.encoder.resolveQuerySet).toHaveBeenCalledWith(f.queries[0], 0, 2, f.buffers[0], 0);
    expect(f.encoder.copyBufferToBuffer).toHaveBeenCalledWith(f.buffers[0], 0, f.buffers[1], 0, 16);
    expect(f.buffers).toHaveLength(4);
    expect(profiler.pendingSamples).toBe(2);
    f.buffers[3]!.mapping.resolve();
    await microtasks();
    f.buffers[1]!.mapping.resolve();
    await profiler.flush();
    expect(profiler.drain()).toEqual([
      { frameId: 11, pass: 'raster', gpuMs: 2.5 }, { frameId: 10, pass: 'raster', gpuMs: 2.5 },
    ]);
    expect(profiler.pendingSamples).toBe(0);
    expect(profiler.droppedSamples).toBe(1);
    expect(profiler.allocatedBufferBytes).toBe(512);
    profiler.dispose();
  });

  it('keeps quantized zero durations and explicitly counts unread queue overflow', async () => {
    const f = fixture();
    const profiler = new GpuProfiler(f.device as unknown as GPUDevice, 1, 1);
    f.buffers[1]!.data[1] = f.buffers[1]!.data[0]!;
    profiler.submitted(profiler.begin(1, 'clear')!);
    f.buffers[1]!.mapping.resolve();
    await profiler.flush();
    profiler.submitted(profiler.begin(2, 'clear')!);
    await profiler.flush();
    expect(profiler.drain()).toEqual([{ frameId: 2, pass: 'clear', gpuMs: 0 }]);
    expect(profiler.droppedSamples).toBe(1);
    profiler.dispose();
  });

  it('drops failed readbacks and invalid timestamp order, then reuses slots', async () => {
    const f = fixture();
    const profiler = new GpuProfiler(f.device as unknown as GPUDevice, 2);
    profiler.submitted(profiler.begin(1, 'clear')!);
    profiler.submitted(profiler.begin(2, 'clear')!);
    f.buffers[1]!.mapping.reject(new Error('Device lost'));
    f.buffers[3]!.data[1] = 0n;
    f.buffers[3]!.mapping.resolve();
    await profiler.flush();
    expect(profiler.drain()).toEqual([]);
    expect(profiler.droppedSamples).toBe(2);
    expect(profiler.begin(3, 'clear')).not.toBeNull();
    profiler.dispose();
  });

  it('destroys every owned resource once and ignores late mapping callbacks after disposal', async () => {
    const f = fixture();
    const profiler = new GpuProfiler(f.device as unknown as GPUDevice, 1);
    profiler.submitted(profiler.begin(1, 'clear')!);
    profiler.dispose();
    profiler.dispose();
    f.buffers[1]!.mapping.resolve();
    await profiler.flush();
    expect(profiler.drain()).toEqual([]);
    expect(profiler.pendingSamples).toBe(0);
    expect(profiler.droppedSamples).toBe(1);
    for (const resource of [...f.buffers, ...f.queries]) expect(resource.destroy).toHaveBeenCalledOnce();
    expect(f.buffers[1]!.getMappedRange).not.toHaveBeenCalled();
  });

  it('releases completed slots and partial resources if construction fails', () => {
    const f = fixture();
    f.device.createBuffer.mockImplementationOnce((descriptor) => {
      const resource = { descriptor, destroy: vi.fn() } as ReturnType<typeof f.device.createBuffer>;
      f.buffers.push(resource); return resource;
    }).mockImplementationOnce(() => { throw new Error('Allocation failed'); });
    expect(() => new GpuProfiler(f.device as unknown as GPUDevice)).toThrow('Allocation failed');
    expect(f.buffers[0]!.destroy).toHaveBeenCalledOnce();
    expect(f.queries[0]!.destroy).toHaveBeenCalledOnce();
  });

  it('bounds end-of-capture readback waits and clears the deadline timer on failure', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const profiler = new GpuProfiler(f.device as unknown as GPUDevice, 1);
    try {
      profiler.submitted(profiler.begin(1, 'clear')!);
      const rejection = expect(profiler.flush(25)).rejects.toMatchObject({ code: 'GPU_TIMING_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(vi.getTimerCount()).toBe(0);
      expect(profiler.pendingSamples).toBe(1);
      await expect(profiler.flush(0)).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
      profiler.dispose();
      f.buffers[1]!.mapping.reject(new Error('Disposed'));
      await microtasks();
    } finally {
      profiler.dispose();
      vi.useRealTimers();
    }
  });

  it('resolves all named passes with one copy/map and preserves zero durations without an overlapping total', async () => {
    const f = fixture();
    const profiler = new GpuProfiler(f.device as unknown as GPUDevice, 1);
    const slot = profiler.begin(7, ['shadow', 'raster', 'temporal', 'presentation'])!;
    f.buffers[1]!.data.set([1_000_000n, 2_000_000n, 3_000_000n, 5_000_000n, 6_000_000n, 6_000_000n, 7_000_000n, 7_500_000n]);
    expect(slot.timestamps.temporal).toMatchObject({ beginningOfPassWriteIndex: 4, endOfPassWriteIndex: 5 });
    expect(slot.timestamps.presentation).toMatchObject({ beginningOfPassWriteIndex: 6, endOfPassWriteIndex: 7 });
    profiler.resolve(f.encoder as unknown as GPUCommandEncoder, slot);
    profiler.submitted(slot);
    expect(profiler.pendingSamples).toBe(4);
    expect(f.encoder.resolveQuerySet).toHaveBeenCalledWith(f.queries[0], 0, 8, f.buffers[0], 0);
    expect(f.encoder.copyBufferToBuffer).toHaveBeenCalledWith(f.buffers[0], 0, f.buffers[1], 0, 64);
    expect(f.buffers[1]!.mapAsync).toHaveBeenCalledExactlyOnceWith(1, 0, 64);
    f.buffers[1]!.mapping.resolve();
    await profiler.flush();
    expect(profiler.drain()).toEqual([
      { frameId: 7, pass: 'shadow', gpuMs: 1 },
      { frameId: 7, pass: 'raster', gpuMs: 2 },
      { frameId: 7, pass: 'temporal', gpuMs: 0 },
      { frameId: 7, pass: 'presentation', gpuMs: 0.5 },
    ]);
    const withoutTemporal = profiler.begin(8, ['shadow', 'raster', 'presentation'])!;
    expect(withoutTemporal.timestamps.temporal).toBeUndefined();
    expect(withoutTemporal.timestamps.presentation).toMatchObject({ beginningOfPassWriteIndex: 4, endOfPassWriteIndex: 5 });
    profiler.cancel(withoutTemporal);
    expect(profiler.droppedSamples).toBe(3);
    profiler.dispose();
  });

  it('drops complete frame groups on queue pressure and invalid timestamp pairs', async () => {
    const f = fixture();
    const profiler = new GpuProfiler(f.device as unknown as GPUDevice, 1, 5);
    profiler.submitted(profiler.begin(1, ['shadow', 'raster', 'temporal', 'presentation'])!);
    f.buffers[1]!.mapping.resolve();
    await profiler.flush();
    profiler.submitted(profiler.begin(2, ['shadow', 'raster', 'presentation'])!);
    await profiler.flush();
    const retained = profiler.drain();
    expect(retained.map((timing) => timing.frameId)).toEqual([2, 2, 2]);
    expect(profiler.droppedSamples).toBe(4);
    f.buffers[1]!.data[3] = 0n;
    profiler.submitted(profiler.begin(3, ['shadow', 'raster', 'presentation'])!);
    await profiler.flush();
    expect(profiler.drain()).toEqual([]);
    expect(profiler.droppedSamples).toBe(7);
    profiler.dispose();
  });

  it('counts skipped and failed frame readbacks in individual pass units', async () => {
    const f = fixture();
    const profiler = new GpuProfiler(f.device as unknown as GPUDevice, 1);
    profiler.submitted(profiler.begin(1, ['shadow', 'raster', 'temporal', 'presentation'])!);
    expect(profiler.begin(2, ['shadow', 'raster', 'presentation'])).toBeNull();
    f.buffers[1]!.mapping.reject(new Error('Readback failed'));
    await profiler.flush();
    expect(profiler.droppedSamples).toBe(7);
    expect(profiler.pendingSamples).toBe(0);
    expect(() => profiler.begin(3, ['shadow', 'shadow'])).toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    profiler.dispose();
  });

  it('reuses a slot after synchronous mapping failure and can cancel its next recording', () => {
    const f = fixture();
    const profiler = new GpuProfiler(f.device as unknown as GPUDevice, 1);
    f.buffers[1]!.mapAsync.mockImplementationOnce(() => { throw new Error('Synchronous mapping failure'); });
    profiler.submitted(profiler.begin(1, 'clear')!);
    expect(profiler.pendingSamples).toBe(0);
    profiler.cancel(profiler.begin(2, 'clear')!);
    expect(profiler.pendingSamples).toBe(0);
    expect(profiler.droppedSamples).toBe(2);
    expect(profiler.begin(3, 'clear')).not.toBeNull();
    profiler.dispose();
  });
});

describe('engine telemetry and scene ownership', () => {
  let f: ReturnType<typeof fixture>;
  const engines: Engine[] = [];
  beforeEach(() => {
    vi.resetAllMocks();
    f = fixture();
    vi.stubGlobal('navigator', { gpu: f.gpu });
    vi.mocked(initializeCpuRuntime).mockResolvedValue({ info: { abiVersion: 1, memoryBytes: 65536 }, dispose: vi.fn() });
  });
  afterEach(() => {
    for (const engine of engines.splice(0)) engine.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function ready(profiling = false) {
    const engine = await createEngine({ canvas: f.canvas, profiling });
    engines.push(engine);
    return engine;
  }
  function scene() {
    return {
      initialUploadBytes: 1024, gpuBufferBytes: 2048, gpuTextureBytes: 640 * 360 * 4,
      encode: vi.fn((..._args: unknown[]) => ({ drawCalls: 1, dispatchCalls: 0, triangles: 120, uploadBytes: 64 })),
      dispose: vi.fn(),
    };
  }

  it('does not allocate a profiler by default and snapshots adapter information without inventing missing values', async () => {
    const engine = await ready();
    expect(f.device.createBuffer).not.toHaveBeenCalled();
    expect(f.adapter.requestDevice).toHaveBeenCalledWith(expect.objectContaining({ requiredFeatures: [] }));
    expect(engine.info.adapter).toEqual(f.adapter.info);
    expect(engine.info.profiling).toMatchObject({ enabled: false, gpuTimestampAvailable: false, reason: 'disabled' });
    f.adapter.info.vendor = 'changed';
    f.adapter.limits.maxTextureDimension2D = 1;
    expect(engine.info.adapter.vendor).toBe('test');
    expect(engine.info.adapterLimits.maxTextureDimension2D).toBe(16384);
    expect(Object.isFrozen(engine.info.adapter)).toBe(true);
    expect(Object.isFrozen(engine.info.deviceLimits)).toBe(true);
    const frame = engine.render();
    expect(frame).toMatchObject({ frameId: 1, drawCalls: 0, triangles: 0, uploadBytes: 0, allocatedGpuBufferBytes: 0 });
    expect(frame.cpuSubmissionMs).toBeGreaterThanOrEqual(0);
    expect(engine.drainGpuTimings()).toEqual([]);
  });

  it('requests optional timestamps and resolves them asynchronously under the submitted frame ID', async () => {
    const engine = await ready(true);
    expect(f.adapter.requestDevice).toHaveBeenCalledWith(expect.objectContaining({ requiredFeatures: ['timestamp-query'] }));
    expect(engine.info.profiling.reason).toBe('available');
    const frame = engine.render();
    expect(frame.allocatedGpuBufferBytes).toBe(1024);
    expect(engine.getTelemetry().pendingGpuSamples).toBe(1);
    expect(f.encoder.beginRenderPass).toHaveBeenCalledWith(expect.objectContaining({ timestampWrites: expect.any(Object) }));
    f.buffers[1]!.mapping.resolve();
    await engine.flushGpuTimings();
    expect(engine.drainGpuTimings()).toEqual([{ frameId: 1, pass: 'clear', gpuMs: 2.5 }]);
  });

  it('measures CPU submission separately and returns an abandoned timestamp slot after a failed frame', async () => {
    const engine = await ready(true);
    f.device.queue.submit.mockImplementationOnce(() => { throw new Error('Submission failed'); });
    expect(() => engine.render()).toThrowError(expect.objectContaining({ code: 'RENDER_FAILED' }));
    expect(engine.getTelemetry()).toMatchObject({ submittedFrames: 0, pendingGpuSamples: 0, droppedGpuSamples: 1 });
    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(103.25);
    expect(engine.render()).toMatchObject({ frameId: 1, cpuSubmissionMs: 3.25 });
    expect(engine.getTelemetry().pendingGpuSamples).toBe(1);
    f.buffers[1]!.mapping.resolve();
    await engine.flushGpuTimings();
  });

  it('releases profiling allocations on device loss and rejects rendering while late readbacks settle', async () => {
    const engine = await ready(true);
    engine.render();
    f.loss.resolve({ reason: 'unknown', message: 'Reset' } as GPUDeviceLostInfo);
    await microtasks();
    expect(engine.state).toBe('lost');
    expect(engine.getTelemetry()).toMatchObject({ allocatedGpuBufferBytes: 0, pendingGpuSamples: 0, droppedGpuSamples: 1 });
    expect(() => engine.render()).toThrowError(expect.objectContaining({ code: 'DEVICE_LOST' }));
    f.buffers[1]!.mapping.resolve();
    await expect(engine.flushGpuTimings()).rejects.toMatchObject({ code: 'DEVICE_LOST' });
    expect(engine.drainGpuTimings()).toEqual([]);
    for (const resource of [...f.buffers, ...f.queries]) expect(resource.destroy).toHaveBeenCalledOnce();
  });

  it('reports unavailable timestamps without zero-valued synthetic samples', async () => {
    f.adapter.features.clear();
    f.device.features.clear();
    const engine = await ready(true);
    expect(engine.info.profiling).toMatchObject({ enabled: true, gpuTimestampAvailable: false, reason: 'timestamp-query-unavailable' });
    engine.render();
    expect(f.device.createBuffer).not.toHaveBeenCalled();
    expect(engine.drainGpuTimings()).toEqual([]);
  });

  it('retries without an optional timestamp feature but never relaxes explicit requirements', async () => {
    f.adapter.requestDevice.mockRejectedValueOnce(new Error('Optional timestamp request failed'));
    const engine = await ready(true);
    expect(f.adapter.requestDevice).toHaveBeenCalledTimes(2);
    expect(f.adapter.requestDevice).toHaveBeenLastCalledWith(expect.objectContaining({ requiredFeatures: [] }));
    expect(engine.info.profiling.reason).toBe('timestamp-query-device-request-failed');
    engine.dispose();
    f.adapter.requestDevice.mockClear().mockRejectedValueOnce(new Error('Required feature request failed'));
    await expect(createEngine({ canvas: f.canvas, profiling: true, requiredFeatures: ['timestamp-query'] }))
      .rejects.toMatchObject({ code: 'DEVICE_REQUEST_FAILED' });
    expect(f.adapter.requestDevice).toHaveBeenCalledOnce();
  });

  it('counts cold uploads separately from frame traffic and releases scene allocations on clear/disposal', async () => {
    const value = scene();
    vi.mocked(SceneRenderer.create).mockResolvedValue(value as unknown as SceneRenderer);
    const engine = await ready();
    await engine.setScene({ seed: 7 });
    expect(engine.getTelemetry()).toMatchObject({ totalUploadBytes: 1024, allocatedGpuBufferBytes: 2048 });
    const frame = engine.render({ timeSeconds: 5 });
    expect(frame).toMatchObject({ drawCalls: 1, dispatchCalls: 0, triangles: 120, uploadBytes: 64, wasmMemoryBytes: 65536 });
    expect(value.encode).toHaveBeenCalledWith(f.encoder, expect.any(Object), 640, 360, 5, undefined);
    expect(engine.getTelemetry()).toMatchObject({ totalUploadBytes: 1088, submittedFrames: 1 });
    await engine.setScene(null);
    expect(value.dispose).toHaveBeenCalledOnce();
    expect(engine.getTelemetry()).toMatchObject({ allocatedGpuBufferBytes: 0, allocatedGpuTextureBytes: 0, totalUploadBytes: 1088 });
    engine.dispose();
    expect(engine.getTelemetry().wasmMemoryBytes).toBe(0);
  });

  it('preserves the active scene until a replacement succeeds and disposes an outdated asynchronous result', async () => {
    const original = scene();
    const late = scene();
    const replacement = scene();
    const wait = deferred<SceneRenderer>();
    vi.mocked(SceneRenderer.create).mockResolvedValueOnce(original as unknown as SceneRenderer)
      .mockReturnValueOnce(wait.promise).mockResolvedValueOnce(replacement as unknown as SceneRenderer);
    const engine = await ready();
    await engine.setScene({ seed: 1 });
    const pending = engine.setScene({ seed: 2 });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'SCENE_LOAD_SUPERSEDED' });
    await microtasks();
    engine.render();
    expect(original.encode).toHaveBeenCalledOnce();
    await engine.setScene({ seed: 3 });
    expect(original.dispose).toHaveBeenCalledOnce();
    wait.resolve(late as unknown as SceneRenderer);
    await rejection;
    expect(late.dispose).toHaveBeenCalledOnce();
    engine.render();
    expect(replacement.encode).toHaveBeenCalledOnce();
  });

  it('cleans up scene creation that completes after engine disposal', async () => {
    const late = scene();
    const wait = deferred<SceneRenderer>();
    vi.mocked(SceneRenderer.create).mockReturnValueOnce(wait.promise);
    const engine = await ready();
    const pending = engine.setScene({});
    const rejection = expect(pending).rejects.toMatchObject({ code: 'ENGINE_DISPOSED' });
    await microtasks();
    engine.dispose();
    wait.resolve(late as unknown as SceneRenderer);
    await rejection;
    expect(late.dispose).toHaveBeenCalledOnce();
    expect(engine.getTelemetry().allocatedGpuBufferBytes).toBe(0);
  });

  it('rejects invalid animation time before submission and preserves the active scene after a load error', async () => {
    const original = scene();
    vi.mocked(SceneRenderer.create).mockResolvedValueOnce(original as unknown as SceneRenderer)
      .mockRejectedValueOnce(new Error('Pipeline creation failed'));
    const engine = await ready();
    await engine.setScene({});
    await expect(engine.setScene({})).rejects.toMatchObject({ code: 'SCENE_LOAD_FAILED' });
    expect(original.dispose).not.toHaveBeenCalled();
    expect(() => engine.render({ timeSeconds: NaN })).toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    expect(f.device.queue.submit).not.toHaveBeenCalled();
  });

  it('counts uncaptured GPU errors, bounds diagnostics, and rejects affected measurements without replacing consumer listeners', async () => {
    const consumer = vi.fn();
    f.events.addEventListener('uncapturederror', consumer);
    const engine = await ready();
    f.events.dispatchEvent(Object.assign(new Event('uncapturederror'), { error: { message: 'x'.repeat(4096) } }));
    expect(engine.getTelemetry()).toMatchObject({ gpuErrorCount: 1, lastGpuError: 'x'.repeat(2048) });
    expect(() => engine.render()).toThrowError(expect.objectContaining({ code: 'GPU_VALIDATION_FAILED' }));
    await expect(engine.setScene({})).rejects.toMatchObject({ code: 'GPU_VALIDATION_FAILED' });
    await expect(engine.flushGpuTimings()).rejects.toMatchObject({ code: 'GPU_VALIDATION_FAILED' });
    engine.dispose();
    f.events.dispatchEvent(Object.assign(new Event('uncapturederror'), { error: { message: 'After disposal' } }));
    expect(engine.getTelemetry().gpuErrorCount).toBe(1);
    expect(consumer).toHaveBeenCalledTimes(2);
    expect(f.device.removeEventListener).toHaveBeenCalledWith('uncapturederror', expect.any(Function));
  });

  it('cleans up scene results when an asynchronous GPU error arrives during creation', async () => {
    const value = scene();
    const wait = deferred<SceneRenderer>();
    vi.mocked(SceneRenderer.create).mockReturnValue(wait.promise);
    const engine = await ready();
    const pending = engine.setScene({});
    const rejection = expect(pending).rejects.toMatchObject({ code: 'GPU_VALIDATION_FAILED' });
    await microtasks();
    f.events.dispatchEvent(Object.assign(new Event('uncapturederror'), { error: { message: 'Buffer invalid' } }));
    wait.resolve(value as unknown as SceneRenderer);
    await rejection;
    expect(value.dispose).toHaveBeenCalledOnce();
    expect(engine.getTelemetry().allocatedGpuBufferBytes).toBe(0);
  });

  it('rejects GPU errors during initialization and releases a late CPU runtime', async () => {
    const cpu = { info: { abiVersion: 1, memoryBytes: 65536 }, dispose: vi.fn() };
    const wait = deferred<typeof cpu>();
    vi.mocked(initializeCpuRuntime).mockReturnValue(wait.promise);
    const pending = createEngine({ canvas: f.canvas });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'GPU_VALIDATION_FAILED' });
    await microtasks();
    f.events.dispatchEvent(Object.assign(new Event('uncapturederror'), { error: { message: 'Initialization invalid' } }));
    await rejection;
    wait.resolve(cpu);
    await microtasks();
    expect(cpu.dispose).toHaveBeenCalledOnce();
    expect(f.device.destroy).toHaveBeenCalledOnce();
  });

  it('selects the raster renderer and passes controls with exactly the active named timestamps', async () => {
    const value = {
      ...scene(),
      passNames: vi.fn((controls: RasterControls) => controls.temporal === false
        ? ['shadow', 'raster', 'presentation'] as const : ['shadow', 'raster', 'temporal', 'presentation'] as const),
    };
    vi.mocked(RasterRenderer.create).mockResolvedValue(value as unknown as RasterRenderer);
    const engine = await ready(true);
    await engine.setScene({ renderer: 'raster', seed: 17 });
    expect(SceneRenderer.create).not.toHaveBeenCalled();
    expect(RasterRenderer.create).toHaveBeenCalledWith(f.device, 'bgra8unorm', { renderer: 'raster', seed: 17 });
    const controls = { timeSeconds: 3, temporal: false, debugView: 'normal' as const, cameraCut: true };
    engine.render(controls);
    expect(value.passNames).toHaveBeenCalledWith(controls);
    const timestamps = value.encode.mock.calls[0]![6] as unknown as Record<string, GPURenderPassTimestampWrites>;
    expect(Object.keys(timestamps)).toEqual(['shadow', 'raster', 'presentation']);
    expect(engine.getTelemetry().pendingGpuSamples).toBe(3);
    f.buffers[1]!.mapping.resolve();
    await engine.flushGpuTimings();
    expect(engine.drainGpuTimings().map(({ pass }) => pass)).toEqual(['shadow', 'raster', 'presentation']);
  });

  it('keeps a diffuse scene usable while raster loads and safely disposes an outdated raster result', async () => {
    const original = scene();
    const late = { ...scene(), passNames: vi.fn(() => ['shadow', 'raster', 'presentation'] as const) };
    const wait = deferred<RasterRenderer>();
    vi.mocked(SceneRenderer.create).mockResolvedValue(original as unknown as SceneRenderer);
    vi.mocked(RasterRenderer.create).mockReturnValue(wait.promise);
    const engine = await ready();
    await engine.setScene({ renderer: 'diffuse' });
    const pending = engine.setScene({ renderer: 'raster' });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'SCENE_LOAD_SUPERSEDED' });
    await microtasks();
    engine.render();
    expect(original.encode).toHaveBeenCalledOnce();
    await engine.setScene(null);
    expect(original.dispose).toHaveBeenCalledOnce();
    wait.resolve(late as unknown as RasterRenderer);
    await rejection;
    expect(late.dispose).toHaveBeenCalledOnce();
  });

  it('validates renderer/debug controls consistently while preserving the diffuse defaults', async () => {
    const engine = await ready();
    await expect(engine.setScene({ renderer: 'other' as 'diffuse' })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(() => engine.render({ temporal: 'yes' as unknown as boolean })).toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    expect(() => engine.render({ cameraCut: 1 as unknown as boolean })).toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    expect(() => engine.render({ debugView: 'other' as 'final' })).toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    const value = scene();
    vi.mocked(SceneRenderer.create).mockResolvedValue(value as unknown as SceneRenderer);
    await engine.setScene({});
    engine.render({ temporal: false, debugView: 'final' });
    expect(value.encode).toHaveBeenCalledWith(f.encoder, expect.any(Object), 640, 360, 0, undefined);
  });

  it('forces a camera cut after failed raster submission until a raster frame successfully submits', async () => {
    const value = { ...scene(), passNames: vi.fn(() => ['shadow', 'raster', 'temporal', 'presentation'] as const) };
    vi.mocked(RasterRenderer.create).mockResolvedValue(value as unknown as RasterRenderer);
    const engine = await ready();
    await engine.setScene({ renderer: 'raster' });
    const controls = { timeSeconds: 1, temporal: true, debugView: 'final' as const, cameraCut: false };
    engine.render(controls);
    f.device.queue.submit.mockImplementationOnce(() => { throw new Error('First failed submission'); });
    expect(() => engine.render(controls)).toThrowError(expect.objectContaining({ code: 'RENDER_FAILED' }));
    f.device.queue.submit.mockImplementationOnce(() => { throw new Error('Retry failed submission'); });
    expect(() => engine.render(controls)).toThrowError(expect.objectContaining({ code: 'RENDER_FAILED' }));
    engine.render(controls);
    engine.render(controls);
    const encodedControls = value.encode.mock.calls.map((call) => call[5] as RasterControls);
    expect(encodedControls.map((options) => options.cameraCut)).toEqual([false, false, true, true, false]);
    for (const options of encodedControls) expect(options).toMatchObject({ timeSeconds: 1, temporal: true, debugView: 'final' });
    expect(controls.cameraCut).toBe(false);
    expect(engine.getTelemetry().submittedFrames).toBe(3);
  });

  it('retains failed-frame invalidation across a successful clear frame', async () => {
    const value = { ...scene(), passNames: vi.fn(() => ['shadow', 'raster', 'presentation'] as const) };
    vi.mocked(RasterRenderer.create).mockResolvedValue(value as unknown as RasterRenderer);
    const engine = await ready();
    f.device.queue.submit.mockImplementationOnce(() => { throw new Error('Clear submission failed'); });
    expect(() => engine.render()).toThrowError(expect.objectContaining({ code: 'RENDER_FAILED' }));
    engine.render();
    await engine.setScene({ renderer: 'raster' });
    engine.render({ temporal: false, debugView: 'normal' });
    expect(value.encode.mock.calls[0]![5]).toEqual({ temporal: false, debugView: 'normal', cameraCut: true });
    engine.render({ temporal: false, debugView: 'normal' });
    expect(value.encode.mock.calls[1]![5]).toEqual({ temporal: false, debugView: 'normal' });
  });

  it('submits virtual feedback after the GPU commands and labels delayed geometry counts', async () => {
    const value = { ...scene(), passNames: vi.fn(() => ['selection', 'shadow', 'raster', 'temporal', 'presentation'] as const),
      submitted: vi.fn(), cancelFrame: vi.fn(), flushFeedback: vi.fn(async () => undefined), geometryTelemetry: { sourceFrameId: 0, residentPages: 2 } };
    vi.mocked(VirtualRenderer.create).mockResolvedValue(value as unknown as VirtualRenderer);
    const engine = await ready(true);
    await engine.setScene({ renderer: 'virtual', manifestUrl: '/terrain/manifest.json' });
    const result = engine.render();
    expect(value.submitted).toHaveBeenCalledWith(1);
    expect(value.submitted.mock.invocationCallOrder[0]!).toBeGreaterThan(f.device.queue.submit.mock.invocationCallOrder[0]!);
    expect(result.triangleCountSourceFrameId).toBe(0);
    expect(result.geometry).toEqual(value.geometryTelemetry);
    expect(engine.getTelemetry().pendingGpuSamples).toBe(5);
    f.buffers[1]!.mapping.resolve();
    await engine.flushGpuTimings();
    expect(value.flushFeedback).toHaveBeenCalledOnce();
    expect(engine.drainGpuTimings()).toHaveLength(5);
    f.device.queue.submit.mockImplementationOnce(() => { throw new Error('Submission failed'); });
    expect(() => engine.render()).toThrow();
    expect(value.cancelFrame).toHaveBeenCalledOnce();
    engine.render();
    expect(value.encode.mock.calls.at(-1)![5]).toMatchObject({ cameraCut: true });
  });

  it('aborts superseded virtual downloads without replacing the currently usable scene', async () => {
    const original = scene();
    vi.mocked(SceneRenderer.create).mockResolvedValue(original as unknown as SceneRenderer);
    let signal: AbortSignal | undefined;
    vi.mocked(VirtualRenderer.create).mockImplementation((_device, _format, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal!.addEventListener('abort', () => reject(new Error('Download aborted')), { once: true });
    }));
    const engine = await ready();
    await engine.setScene({});
    const pending = engine.setScene({ renderer: 'virtual', manifestUrl: '/terrain/manifest.json' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SCENE_LOAD_SUPERSEDED' });
    await microtasks();
    engine.render();
    expect(original.encode).toHaveBeenCalledOnce();
    await engine.setScene(null);
    await rejected;
    expect(signal?.aborted).toBe(true);
  });

  it('cancels pending virtual creation on disposal and disposes a late successful result', async () => {
    const late = { ...scene(), submitted: vi.fn(), cancelFrame: vi.fn(), geometryTelemetry: { sourceFrameId: null } };
    const waiting = deferred<VirtualRenderer>();
    let signal: AbortSignal | undefined;
    vi.mocked(VirtualRenderer.create).mockImplementation((_device, _format, options) => { signal = options.signal; return waiting.promise; });
    const engine = await ready();
    const pending = engine.setScene({ renderer: 'virtual', manifestUrl: '/terrain/manifest.json' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ENGINE_DISPOSED' });
    await microtasks();
    engine.dispose();
    expect(signal?.aborted).toBe(true);
    waiting.resolve(late as unknown as VirtualRenderer);
    await rejected;
    expect(late.dispose).toHaveBeenCalledOnce();
  });

  it('honors user cancellation during virtual creation and detaches it after success', async () => {
    const engine = await ready();
    const controller = new AbortController();
    vi.mocked(VirtualRenderer.create).mockImplementation((_device, _format, options) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }));
    const pending = engine.setScene({ renderer: 'virtual', manifestUrl: '/terrain/manifest.json', signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SCENE_LOAD_ABORTED' });
    await microtasks(); controller.abort(); await rejected;
    const successful = new AbortController();
    let internalSignal: AbortSignal | undefined;
    const value = { ...scene(), geometryTelemetry: { sourceFrameId: null } };
    vi.mocked(VirtualRenderer.create).mockImplementation(async (_device, _format, options) => { internalSignal = options.signal; return value as unknown as VirtualRenderer; });
    await engine.setScene({ renderer: 'virtual', manifestUrl: '/terrain/manifest.json', signal: successful.signal });
    successful.abort();
    expect(internalSignal?.aborted).toBe(false);
    expect(value.dispose).not.toHaveBeenCalled();
  });
});
