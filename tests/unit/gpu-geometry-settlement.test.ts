import { describe, expect, it, vi } from 'vitest';
import { GpuGeometry } from '../../packages/core/src/geometry/gpu-geometry.js';
import type { GeometryPageCacheOptions } from '../../packages/core/src/geometry/page-cache.js';
import { GeometryTransferBudget } from '../../packages/core/src/geometry/transfer-budget.js';
import type { VirtualSceneOptions } from '../../packages/core/src/geometry/virtual-types.js';
import { geometryDevice, geometryFixture } from './geometry-fixture.js';

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const microtasks = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const observed = (promise: Promise<void>) => {
  let settled = false; void promise.then(() => { settled = true; });
  return { promise, get settled() { return settled; } };
};
function setup(fetchPages?: typeof fetch) {
  const { manifest, bodies } = geometryFixture(); const gpu = geometryDevice();
  const budget = new GeometryTransferBudget({ maxRequests: 1, pageStagingBytes: 65_536, transientBytes: 1_048_576,
    residentBytes: 1_048_576, gpuBufferBytes: 1_048_576, uploadBytesPerFrame: 65_536 });
  const url = new URL('https://geometry.test/manifest.json'); const controller = new AbortController();
  const fetch = fetchPages ?? vi.fn(async (resource: Parameters<typeof globalThis.fetch>[0]) => {
    const id = Number(new URL(String(resource)).pathname.match(/(\d+)\.bin$/)![1]);
    return new Response(bodies[id]!.slice(0), { headers: { 'content-length': '65536' } });
  });
  const options: VirtualSceneOptions & GeometryPageCacheOptions = { renderer: 'virtual', manifestUrl: url, poolBytes: 131_072,
    signal: controller.signal, fetch, maxRetries: 0 };
  const begin = () => GpuGeometry.begin(gpu.device, manifest, url, options, budget);
  return { manifest, bodies, gpu, budget, url, options, controller, begin };
}
async function readyHost(fixture: ReturnType<typeof setup>) {
  const handle = fixture.begin();
  for (let frame = 0; frame < 50 && handle.status === 'pending'; frame++) {
    handle.advance(fixture.budget.beginFrame(frame));
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  expect(handle.status).toBe('ready');
  return { handle, provider: handle.takeReady() };
}
function expectReleased(fixture: ReturnType<typeof setup>) {
  expect(fixture.budget.telemetry).toMatchObject({ gpuBufferBytes: 0, residentBytes: 0, transientBytes: 0, requests: 0, pageStagingBytes: 0 });
  expect(fixture.gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
}

describe('GPU geometry disposal and original asynchronous settlement', () => {
  it('waits for disposal before admission and returns one stable settlement promise', async () => {
    const fixture = setup(); const handle = fixture.begin();
    const completion = observed(handle.whenDisposedAndSettled());
    expect(handle.whenDisposedAndSettled()).toBe(completion.promise);
    await microtasks(); expect(completion.settled).toBe(false);
    handle.dispose(); handle.dispose(); await completion.promise;
    expect(fixture.gpu.raw.createComputePipelineAsync).not.toHaveBeenCalled(); expectReleased(fixture);
  });

  it('keeps cancellation unsettled until both original sibling compilations finish', async () => {
    const fixture = setup(); const select = deferred<GPUComputePipeline>(); const compact = deferred<GPUComputePipeline>();
    fixture.gpu.raw.createComputePipelineAsync.mockImplementationOnce(() => select.promise as never)
      .mockImplementationOnce(() => compact.promise as never);
    const handle = fixture.begin(); const completion = observed(handle.whenDisposedAndSettled());
    handle.advance(fixture.budget.beginFrame(0)); fixture.controller.abort(new Error('region retired'));
    expect(handle.status).toBe('failed'); await handle.waitForChange(handle.revision);
    expect(completion.settled).toBe(false);
    select.reject(new Error('selection compilation rejected after cancellation')); await microtasks();
    expect(completion.settled).toBe(false); expect(fixture.budget.telemetry.residentBytes).toBeGreaterThan(0);
    compact.resolve({ getBindGroupLayout: vi.fn() } as unknown as GPUComputePipeline);
    await completion.promise; expectReleased(fixture); expect(() => handle.takeReady()).toThrow();
  });

  it('reports a pipeline failure before settlement while preserving its unresolved sibling', async () => {
    const fixture = setup(); const select = deferred<GPUComputePipeline>(); const compact = deferred<GPUComputePipeline>();
    fixture.gpu.raw.createComputePipelineAsync.mockImplementationOnce(() => select.promise as never)
      .mockImplementationOnce(() => compact.promise as never);
    const handle = fixture.begin(); const completion = observed(handle.whenDisposedAndSettled());
    handle.advance(fixture.budget.beginFrame(0)); const failure = new Error('selection failed');
    select.reject(failure); await microtasks();
    expect(handle.status).toBe('failed'); expect(handle.error).toBe(failure);
    handle.dispose(); await handle.waitForChange(handle.revision); expect(completion.settled).toBe(false);
    compact.reject(new Error('compact failed too')); await completion.promise;
    expectReleased(fixture); expect(fixture.gpu.raw.queue.writeBuffer).not.toHaveBeenCalled();
  });

  it('includes a started compilation when starting its sibling throws synchronously', async () => {
    const fixture = setup(); const select = deferred<GPUComputePipeline>();
    fixture.gpu.raw.createComputePipelineAsync.mockImplementationOnce(() => select.promise as never)
      .mockImplementationOnce(() => { throw new Error('second pipeline creation threw'); });
    const handle = fixture.begin(); const completion = observed(handle.whenDisposedAndSettled());
    expect(handle.advance(fixture.budget.beginFrame(0)).status).toBe('failed');
    await microtasks(); expect(completion.settled).toBe(false);
    select.resolve({ getBindGroupLayout: vi.fn() } as unknown as GPUComputePipeline);
    await completion.promise; expectReleased(fixture);
  });

  it('includes canceled child-cache response cancellation through its original finally chain', async () => {
    const response = deferred<Response>(); const canceledBody = deferred<void>();
    const fetch = vi.fn(async () => response.promise);
    const fixture = setup(fetch); const handle = fixture.begin();
    const completion = observed(handle.whenDisposedAndSettled());
    for (let frame = 0; frame < 10 && !fetch.mock.calls.length; frame++) {
      handle.advance(fixture.budget.beginFrame(frame)); await microtasks();
    }
    expect(fetch).toHaveBeenCalledTimes(1); handle.dispose(); await handle.waitForChange(handle.revision);
    await microtasks(); expect(completion.settled).toBe(false);
    const cancel = vi.fn(() => canceledBody.promise);
    response.resolve(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-length': '65536' } }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(completion.settled).toBe(false); expect(fixture.budget.telemetry.pageStagingBytes).toBe(65_536);
    canceledBody.resolve(); await completion.promise; expectReleased(fixture);
  });

  it('separates taken-handle settlement from the transferred ready provider lifetime', async () => {
    const fixture = setup(); const { handle, provider } = await readyHost(fixture);
    const providerCompletion = observed(provider.whenDisposedAndSettled());
    await handle.whenDisposedAndSettled(); handle.dispose(); fixture.controller.abort(new Error('old creation signal'));
    await microtasks(); expect(providerCompletion.settled).toBe(false);
    expect(provider.gpuBufferBytes).toBeGreaterThan(0);
    expect(fixture.gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 0)).toBe(true);
    provider.dispose(); await providerCompletion.promise; expectReleased(fixture);
  });

  it.each(['host', 'eager'] as const)('awaits original feedback completions after %s provider disposal clears slot state', async mode => {
    const fixture = setup();
    const provider = mode === 'host' ? (await readyHost(fixture)).provider
      : await GpuGeometry.create(fixture.gpu.device, fixture.manifest, fixture.url, fixture.options);
    const first = deferred<void>(); const second = deferred<void>();
    const slots = fixture.gpu.buffers.filter(buffer => buffer.label.startsWith('Strata geometry feedback'));
    slots[0]!.mapAsync.mockImplementation(() => first.promise); slots[1]!.mapAsync.mockImplementation(() => second.promise);
    const camera = provider.camera(256, 256, 0, [0, 0]);
    provider.prepare(fixture.gpu.encoder, camera, 256, 256, false, {}); provider.submitted(10);
    provider.prepare(fixture.gpu.encoder, camera, 256, 256, false, {}); provider.submitted(11);
    expect(slots[0]!.mapAsync).toHaveBeenCalledTimes(1); expect(slots[1]!.mapAsync).toHaveBeenCalledTimes(1);
    const completion = observed(provider.whenDisposedAndSettled()); provider.dispose();
    expect(provider.geometryTelemetry.pendingFeedbackFrames).toBe(0);
    await provider.flushFeedback(); await microtasks(); expect(completion.settled).toBe(false);
    first.resolve(); await microtasks();
    expect(slots[0]!.unmap).toHaveBeenCalledTimes(1); expect(completion.settled).toBe(false);
    second.reject(new Error('map rejected during disposal')); await completion.promise;
    expect(slots[1]!.unmap).toHaveBeenCalledTimes(1);
    expect(provider.geometryTelemetry.sourceFrameId).toBeNull(); expectReleased(fixture);
    expect(provider.whenDisposedAndSettled()).toBe(completion.promise);
  });
});
