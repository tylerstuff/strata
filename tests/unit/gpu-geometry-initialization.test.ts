import { describe, expect, it, vi } from 'vitest';
import { GpuGeometry } from '../../packages/core/src/geometry/gpu-geometry.js';
import { GeometryTransferBudget, type GeometryTransferLimits } from '../../packages/core/src/geometry/transfer-budget.js';
import type { VirtualSceneOptions } from '../../packages/core/src/geometry/virtual-types.js';
import { geometryDevice, geometryFixture } from './geometry-fixture.js';

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function budget(overrides: Partial<GeometryTransferLimits> = {}) {
  return new GeometryTransferBudget({ maxRequests: 1, pageStagingBytes: 65536, transientBytes: 1024 * 1024,
    residentBytes: 1024 * 1024, gpuBufferBytes: 1024 * 1024, uploadBytesPerFrame: 65536, ...overrides });
}
function setup(limits: Partial<GeometryTransferLimits> = {}) {
  const { manifest } = geometryFixture(); const gpu = geometryDevice(); const shared = budget(limits);
  const url = new URL('https://geometry.test/manifest.json');
  const options: VirtualSceneOptions = { renderer: 'virtual', manifestUrl: url, poolBytes: 131072 };
  const begin = () => GpuGeometry.begin(gpu.device, manifest, url, options, shared);
  return { manifest, gpu, shared, url, options, begin };
}
function expectReleased(shared: GeometryTransferBudget) {
  expect(shared.telemetry).toMatchObject({ gpuBufferBytes: 0, residentBytes: 0, transientBytes: 0, requests: 0, pageStagingBytes: 0 });
}

describe('GPU host initialization admission and terminal ownership', () => {
  it('rejects unsupported rendering arguments and options before allocation', () => {
    const { gpu, manifest, url, shared, options } = setup();
    const begin = GpuGeometry.begin as (...args: unknown[]) => unknown;
    expect(() => begin(gpu.device, manifest, url, options, shared, undefined)).toThrow('default terrain');
    for (const extra of [{ renderOptions: {} }, { transform: {} }, { shading: 'lambert' }, { renderer: 'integrated' }]) {
      expect(() => begin(gpu.device, manifest, url, { ...options, ...extra }, shared)).toThrow('default terrain');
    }
    expect(gpu.raw.createBuffer).not.toHaveBeenCalled(); expectReleased(shared);
  });

  it('rejects metadata outside the cooked count caps in scalar preflight', () => {
    const { gpu, manifest, url, shared, options } = setup();
    const oversized = { ...manifest, pages: { length: 8193 } } as unknown as typeof manifest;
    expect(() => GpuGeometry.begin(gpu.device, oversized, url, options, shared)).toThrow('metadata count');
    expect(gpu.raw.createShaderModule).not.toHaveBeenCalled(); expect(gpu.raw.createBuffer).not.toHaveBeenCalled(); expectReleased(shared);
  });

  it('fails impossible aggregate admission before typed packing, compile, allocation or request', async () => {
    const { begin, gpu, shared } = setup({ transientBytes: 0 });
    const handle = begin();
    expect(handle.advance(shared.beginFrame(0))).toEqual({ status: 'failed', uploadBytes: 0 });
    expect(handle.error).toBeInstanceOf(Error); expect(gpu.raw.createShaderModule).not.toHaveBeenCalled();
    expect(gpu.raw.createBuffer).not.toHaveBeenCalled(); expectReleased(shared);
    await handle.waitForChange(handle.revision);
    handle.dispose(); await handle.waitForChange(handle.revision);
  });

  it('rejects foreign and expired frames before any initialization side effects', () => {
    for (const foreign of [true, false]) {
      const { begin, gpu, shared } = setup(); const handle = begin();
      const frame = (foreign ? budget() : shared).beginFrame(0);
      if (!foreign) shared.beginFrame(1);
      expect(handle.advance(frame)).toEqual({ status: 'failed', uploadBytes: 0 });
      expect(gpu.raw.createBuffer).not.toHaveBeenCalled(); expect(gpu.raw.createShaderModule).not.toHaveBeenCalled();
      expectReleased(shared); handle.dispose();
    }
  });

  it('reports one pipeline failure immediately but holds reservations until its sibling settles', async () => {
    const { begin, gpu, shared } = setup();
    const select = deferred<GPUComputePipeline>(); const compact = deferred<GPUComputePipeline>();
    gpu.raw.createComputePipelineAsync.mockImplementationOnce(() => select.promise as never)
      .mockImplementationOnce(() => compact.promise as never);
    const handle = begin(); handle.advance(shared.beginFrame(0));
    const admitted = shared.telemetry;
    expect(admitted.residentBytes).toBe(312); // Two cache maps, provider table, camera/indirect storage, and light matrix.
    expect(admitted.transientBytes).toBe(488); // Packed metadata, selections, page scratch, and two light operands.
    const failure = new Error('selection compilation failed'); select.reject(failure); await settle();
    expect(handle.status).toBe('failed'); expect(handle.error).toBe(failure);
    expect(shared.telemetry.residentBytes).toBeGreaterThan(0);
    await handle.waitForChange(handle.revision);
    compact.resolve({ getBindGroupLayout: vi.fn() } as unknown as GPUComputePipeline); await settle();
    expectReleased(shared); expect(gpu.raw.createBuffer).not.toHaveBeenCalled();
    expect(gpu.raw.queue.writeBuffer).not.toHaveBeenCalled(); expect(() => handle.takeReady()).toThrow();
    handle.dispose();
  });

  it('keeps the first started pipeline owned if starting its sibling throws synchronously', async () => {
    const { begin, gpu, shared } = setup(); const select = deferred<GPUComputePipeline>();
    gpu.raw.createComputePipelineAsync.mockImplementationOnce(() => select.promise as never)
      .mockImplementationOnce(() => { throw new Error('pipeline creation failed synchronously'); });
    const handle = begin(); expect(handle.advance(shared.beginFrame(0)).status).toBe('failed');
    expect(shared.telemetry.residentBytes).toBeGreaterThan(0);
    select.resolve({ getBindGroupLayout: vi.fn() } as unknown as GPUComputePipeline); await settle();
    expectReleased(shared); expect(gpu.raw.createBuffer).not.toHaveBeenCalled(); handle.dispose();
  });

  it('rolls back all earlier GPU buffers when an initial allocation fails', async () => {
    const { begin, gpu, shared } = setup(); const create = gpu.raw.createBuffer.getMockImplementation()!;
    let allocations = 0;
    gpu.raw.createBuffer.mockImplementation(descriptor => {
      if (++allocations === 3) throw new Error('buffer allocation failed');
      return create(descriptor);
    });
    const handle = begin(); handle.advance(shared.beginFrame(0)); await settle();
    expect(handle.advance(shared.beginFrame(1))).toEqual({ status: 'failed', uploadBytes: 0 });
    expect(gpu.buffers).toHaveLength(2); expect(gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    expectReleased(shared); handle.dispose();
    expect(gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });

  it('waits without holding partial reservations when another initializer occupies the aggregate capacity', async () => {
    const fixture = setup({ residentBytes: 312, gpuBufferBytes: 131952, transientBytes: 488 });
    const { begin, gpu, shared } = fixture; const pipeline = deferred<GPUComputePipeline>();
    gpu.raw.createComputePipelineAsync.mockImplementation(() => pipeline.promise as never);
    const first = begin(); const second = begin(); const frame = shared.beginFrame(0);
    first.advance(frame); const reserved = shared.telemetry;
    expect(second.advance(frame)).toEqual({ status: 'pending', uploadBytes: 0 });
    expect(shared.telemetry).toEqual(reserved); expect(gpu.raw.createComputePipelineAsync).toHaveBeenCalledTimes(2);
    const revision = second.revision; first.dispose();
    expect(second.advance(frame).status).toBe('pending');
    pipeline.resolve({ getBindGroupLayout: vi.fn() } as unknown as GPUComputePipeline); await settle();
    await second.waitForChange(revision);
    expectReleased(shared);
    second.advance(shared.beginFrame(1)); expect(gpu.raw.createComputePipelineAsync).toHaveBeenCalledTimes(4);
    second.dispose(); await settle(); expectReleased(shared);
  });
});
