import { describe, expect, it, vi } from 'vitest';
import { GeometryPageCache } from '../../packages/core/src/geometry/page-cache.js';
import { GeometryTransferBudget } from '../../packages/core/src/geometry/transfer-budget.js';
import { geometryDevice, geometryFixture } from './geometry-fixture.js';

const pageBytes = 65_536;
function transfer(overrides: Partial<ConstructorParameters<typeof GeometryTransferBudget>[0]> = {}) {
  return new GeometryTransferBudget({ maxRequests: 1, pageStagingBytes: pageBytes, transientBytes: pageBytes,
    residentBytes: 1024, gpuBufferBytes: 4 * pageBytes, uploadBytesPerFrame: pageBytes, ...overrides });
}
function setup() {
  const gpu = geometryDevice(); const fixture = geometryFixture();
  const options = { poolBytes: 2 * pageBytes, maxRetries: 0,
    fetch: vi.fn(async () => new Response(fixture.bodies[0]!.slice(0))) as typeof fetch };
  return { ...gpu, ...fixture, options };
}

describe('host-driven page-cache ownership', () => {
  it('admits the complete pool before allocation and wakes when another lease releases capacity', async () => {
    const f = setup();
    const estimate = GeometryPageCache.estimate(f.device, f.manifest, f.options);
    const budget = transfer({ gpuBufferBytes: estimate.gpuBufferBytes, residentBytes: estimate.residentBytes });
    const blocker = budget.tryReserve({ gpuBufferBytes: estimate.gpuBufferBytes })!;
    const handle = GeometryPageCache.begin(f.device, f.manifest, 'https://geometry.test/manifest.json', f.options, budget);
    expect(f.raw.createBuffer).not.toHaveBeenCalled();
    expect(f.options.fetch).not.toHaveBeenCalled();
    handle.advance(budget.beginFrame(0));
    expect(f.raw.createBuffer).not.toHaveBeenCalled();
    const revision = handle.revision;
    const changed = handle.waitForChange(revision);
    blocker.release(); await changed;
    handle.advance(budget.beginFrame(1));
    expect(f.raw.createBuffer).toHaveBeenCalledOnce();
    expect(f.buffers[0]!.bytes.byteLength).toBe(estimate.gpuBufferBytes);
    expect(budget.telemetry.residentBytes).toBe(estimate.residentBytes);
    handle.dispose();
    await vi.waitFor(() => expect(budget.telemetry.pageStagingBytes).toBe(0));
    expect(budget.telemetry.gpuBufferBytes).toBe(0);
  });

  it('holds canceled request capacity until the ignored abort settles, then lets another cache progress', async () => {
    const f = setup(); const budget = transfer(); const aborter = new AbortController();
    const pending: ((response: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => pending.push(resolve)));
    const first = GeometryPageCache.begin(f.device, f.manifest, 'https://geometry.test/a/manifest.json',
      { ...f.options, fetch: fetcher, signal: aborter.signal }, budget);
    first.advance(budget.beginFrame(0));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    aborter.abort();
    expect(first.status).toBe('disposed');
    expect(first.error).toMatchObject({ code: 'INITIALIZATION_ABORTED' });
    expect(budget.telemetry).toMatchObject({ requests: 1, pageStagingBytes: pageBytes, gpuBufferBytes: 0 });
    const second = GeometryPageCache.begin(f.device, f.manifest, 'https://geometry.test/b/manifest.json',
      { ...f.options, fetch: fetcher }, budget);
    second.advance(budget.beginFrame(1));
    expect(pending).toHaveLength(1);
    pending[0]!(new Response(f.bodies[0]!.slice(0)));
    await vi.waitFor(() => expect(budget.telemetry.pageStagingBytes).toBe(0));
    second.advance(budget.beginFrame(2));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!(new Response(f.bodies[0]!.slice(0)));
    await vi.waitFor(() => expect(budget.telemetry.requests).toBe(0));
    second.advance(budget.beginFrame(3));
    expect(second.status).toBe('ready');
    expect(f.raw.queue.writeBuffer).toHaveBeenCalledOnce();
    const cache = second.takeReady();
    second.dispose(); expect(second.status).toBe('taken');
    expect(cache.isLodResident(0, 1)).toBe(true);
    expect(f.buffers[1]!.destroy).not.toHaveBeenCalled();
    expect(() => second.takeReady()).toThrow('not ready');
    cache.dispose(); cache.dispose();
    expect(f.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    expect(budget.telemetry).toMatchObject({ requests: 0, pageStagingBytes: 0, residentBytes: 0, gpuBufferBytes: 0 });
  });

  it('never publishes a cache after a synchronous initial write failure and counts no failed bytes', async () => {
    const f = setup(); const budget = transfer();
    const handle = GeometryPageCache.begin(f.device, f.manifest, 'https://geometry.test/manifest.json', f.options, budget);
    handle.advance(budget.beginFrame(0));
    await vi.waitFor(() => expect(budget.telemetry.requests).toBe(0));
    expect(budget.telemetry.pageStagingBytes).toBe(pageBytes);
    f.raw.queue.writeBuffer.mockImplementationOnce(() => { throw new Error('queue write failed'); });
    const frame = budget.beginFrame(1);
    expect(handle.advance(frame)).toEqual({ status: 'failed', uploadBytes: 0 });
    expect(handle.error).toEqual(new Error('queue write failed'));
    await handle.waitForChange(handle.revision);
    expect(() => handle.takeReady()).toThrow('not ready');
    expect(frame.writtenBytes).toBe(0);
    expect(budget.telemetry).toMatchObject({ pageStagingBytes: 0, residentBytes: 0, gpuBufferBytes: 0 });
    handle.dispose();
    expect(f.buffers[0]!.destroy).toHaveBeenCalledOnce();
  });

  it('rejects foreign admission and frame capabilities without unbudgeted allocations or writes', () => {
    const f = setup(); const budget = transfer(); const foreign = transfer();
    const estimate = GeometryPageCache.estimate(f.device, f.manifest, f.options);
    const receipt = foreign.tryReserve({ residentBytes: estimate.residentBytes, gpuBufferBytes: estimate.gpuBufferBytes })!;
    expect(() => GeometryPageCache.begin(f.device, f.manifest, 'https://geometry.test/manifest.json', f.options, budget, receipt))
      .toThrow('admission does not match');
    expect(receipt.released).toBe(false); receipt.release();
    const handle = GeometryPageCache.begin(f.device, f.manifest, 'https://geometry.test/manifest.json', f.options, budget);
    handle.advance(foreign.beginFrame(0));
    expect(handle.status).toBe('failed');
    expect(handle.error).toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(f.raw.createBuffer).not.toHaveBeenCalled();
    expect(f.raw.queue.writeBuffer).not.toHaveBeenCalled();
  });

  it('keeps legacy creation eager and independent of the host budget', async () => {
    const f = setup(); const cache = await GeometryPageCache.create(f.device, f.manifest,
      'https://geometry.test/manifest.json', f.options);
    expect(cache.initialUploadBytes).toBe(pageBytes);
    expect(cache.isLodResident(0, 1)).toBe(true);
    expect(f.raw.queue.writeBuffer).toHaveBeenCalledOnce();
    cache.dispose();
  });

  it('rejects an expired first frame before allocating or requesting', () => {
    const f = setup(); const budget = transfer();
    const stale = budget.beginFrame(0); budget.beginFrame(1);
    const handle = GeometryPageCache.begin(f.device, f.manifest, 'https://geometry.test/manifest.json', f.options, budget);
    handle.advance(stale);
    expect(handle.status).toBe('failed');
    expect(handle.error).toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(f.raw.createBuffer).not.toHaveBeenCalled();
    expect(f.options.fetch).not.toHaveBeenCalled();
    expect(budget.telemetry.gpuBufferBytes).toBe(0);
  });
});
