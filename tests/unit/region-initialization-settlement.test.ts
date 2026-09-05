import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GpuGeometry } from '../../packages/core/src/geometry/gpu-geometry.js';
import { RegionInitializationCoordinator } from '../../packages/core/src/geometry/region-initialization.js';
import type { RegionDescriptor } from '../../packages/core/src/geometry/region-initialization.js';
import { GeometryTransferBudget } from '../../packages/core/src/geometry/transfer-budget.js';
import { geometryDevice, geometryFixture } from './geometry-fixture.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 1));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Structural fixture for lifecycle controls; the companion four-source suite uses
 * unchanged production cooker output. Only the valid coarse page is requested here. */
function setup() {
  const raw = geometryFixture();
  const manifest = { ...raw.manifest, source: { ...raw.manifest.source, triangleCount: 128 },
    clusters: raw.manifest.clusters.map(cluster => cluster.id === 1 ? { ...cluster, triangleCount: 128, indexCount: 384 } : cluster) };
  const encoded = new TextEncoder().encode(JSON.stringify(manifest));
  const descriptor = (id: string): RegionDescriptor => ({ id, manifestUrl: new URL(`https://geometry.test/${id}/manifest.json`),
    manifestBytes: encoded.byteLength, manifestSha256: createHash('sha256').update(encoded).digest('hex'),
    bounds: manifest.bounds, options: { poolBytes: 131_072 } });
  const gpu = geometryDevice();
  const budget = new GeometryTransferBudget({ maxRequests: 2, pageStagingBytes: 65_536, uploadBytesPerFrame: 65_536,
    transientBytes: 1_048_576, residentBytes: 1_048_576, gpuBufferBytes: 4_194_304 });
  const fetch = vi.fn<typeof globalThis.fetch>(async input => {
    const url = new URL(String(input));
    return new Response(url.pathname.endsWith('manifest.json') ? encoded.slice() : raw.bodies[0]!.slice(0));
  });
  const coordinator = new RegionInitializationCoordinator(gpu.device, budget, { maxDesiredRegions: 4, maxLiveRegions: 1,
    maxManifestBytes: encoded.byteLength, maxRetainedManifestBytes: encoded.byteLength }, { fetch });
  let frame = 0;
  return { gpu, budget, encoded, descriptor, fetch, coordinator,
    advance: () => coordinator.advance(budget.beginFrame(frame++)) };
}
async function drive(state: ReturnType<typeof setup>, done: () => boolean): Promise<void> {
  for (let iteration = 0; iteration < 60 && !done(); iteration++) { state.advance(); await turn(); }
  expect(done()).toBe(true);
}
function held(state: ReturnType<typeof setup>): void {
  expect(state.coordinator.snapshot()).toMatchObject({ liveEntries: 1, retiringEntries: 1, retainedManifestBytes: state.encoded.byteLength });
}
async function disposed(state: ReturnType<typeof setup>): Promise<void> {
  state.coordinator.dispose(); await state.coordinator.whenDisposedAndSettled();
  expect(state.coordinator.snapshot()).toMatchObject({ liveEntries: 0, retainedManifestBytes: 0 });
  expect(state.budget.telemetry).toMatchObject({ requests: 0, pageStagingBytes: 0, transientBytes: 0, residentBytes: 0, gpuBufferBytes: 0 });
  expect(state.gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
}

describe('region retirement uses original child settlement', () => {
  it('holds a failed initializer slot and manifest quota until every pipeline sibling settles', async () => {
    const state = setup(); const first = deferred<GPUComputePipeline>(); const second = deferred<GPUComputePipeline>();
    state.gpu.raw.createComputePipelineAsync.mockImplementationOnce(() => first.promise as never).mockImplementationOnce(() => second.promise as never);
    state.coordinator.replaceDesired(1, [state.descriptor('a')]);
    await drive(state, () => state.gpu.raw.createComputePipelineAsync.mock.calls.length === 2);
    first.reject(new Error('first compilation failed')); await turn();
    expect(state.coordinator.snapshot().regions[0]).toMatchObject({ status: 'failed', error: 'first compilation failed' });
    state.coordinator.replaceDesired(2, [state.descriptor('b')]); state.advance(); await turn(); held(state);
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(state.coordinator.snapshot().regions[0]!.status).toBe('queued');
    second.resolve({ getBindGroupLayout: vi.fn() } as unknown as GPUComputePipeline);
    await vi.waitFor(() => expect(state.coordinator.snapshot().liveEntries).toBe(0));
    await drive(state, () => state.coordinator.snapshot().regions[0]!.status === 'ready');
    expect(state.fetch.mock.calls.filter(([input]) => String(input).endsWith('manifest.json'))).toHaveLength(2);
    await disposed(state);
  });

  it('retains the region through an aborted root digest after scheduling state has been cleared', async () => {
    const state = setup(); const digest = deferred<ArrayBuffer>(); const original = globalThis.crypto;
    const realDigest = original.subtle.digest.bind(original.subtle);
    let rootHashStarted = false;
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn((algorithm: AlgorithmIdentifier, data: BufferSource) => {
      if (data.byteLength === 65_536 && !rootHashStarted) { rootHashStarted = true; return digest.promise; }
      return realDigest(algorithm, data);
    }) } });
    state.coordinator.replaceDesired(1, [state.descriptor('a')]);
    await drive(state, () => rootHashStarted);
    state.coordinator.replaceDesired(2, [state.descriptor('b')]); state.advance(); await turn(); held(state);
    expect(state.budget.telemetry).toMatchObject({ requests: 1, pageStagingBytes: 65_536 });
    const writes = state.gpu.raw.queue.writeBuffer.mock.calls.length;
    // Even a wrong digest must finish the original validation/finally chain after abort.
    digest.resolve(new ArrayBuffer(32));
    await vi.waitFor(() => expect(state.coordinator.snapshot().liveEntries).toBe(0));
    expect(state.gpu.raw.queue.writeBuffer).toHaveBeenCalledTimes(writes);
    expect(state.gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    await drive(state, () => state.coordinator.snapshot().regions[0]!.status === 'ready');
    await disposed(state);
  });

  it('awaits the taken provider itself when original feedback survives disposal', async () => {
    const state = setup(); state.coordinator.replaceDesired(1, [state.descriptor('a')]);
    await drive(state, () => state.coordinator.snapshot().regions[0]!.status === 'ready');
    // The coordinator intentionally exposes no provider. This white-box lifetime
    // control begins feedback on its real taken provider to distinguish the two barriers.
    const ownership = state.coordinator as unknown as { live: Set<{ provider?: GpuGeometry }> };
    const provider = [...ownership.live][0]!.provider!;
    const map = deferred<void>();
    const feedback = state.gpu.buffers.find(buffer => buffer.label === 'Strata geometry feedback 0')!;
    feedback.mapAsync.mockImplementation(() => map.promise);
    provider.prepare(state.gpu.encoder, provider.camera(256, 256, 0, [0, 0]), 256, 256, false, {});
    provider.submitted(7); expect(feedback.mapAsync).toHaveBeenCalledTimes(1);
    state.coordinator.replaceDesired(2, [state.descriptor('b')]); await provider.flushFeedback();
    state.advance(); await turn(); held(state);
    expect(state.budget.telemetry).toMatchObject({ requests: 0, pageStagingBytes: 0, transientBytes: 0, residentBytes: 0, gpuBufferBytes: 0 });
    expect(state.coordinator.snapshot().regions[0]!.status).toBe('queued');
    // Negative control: zero budget counters and post-disposal flushFeedback both
    // say nothing about the still-owned map; releasing the slot here admits B early.
    expect(state.budget.telemetry.gpuBufferBytes === 0).toBe(true);
    const before = state.fetch.mock.calls.length;
    map.resolve(); await vi.waitFor(() => expect(state.coordinator.snapshot().liveEntries).toBe(0));
    expect(feedback.unmap).toHaveBeenCalledTimes(1);
    expect(state.fetch).toHaveBeenCalledTimes(before);
    await drive(state, () => state.coordinator.snapshot().regions[0]!.status === 'ready');
    await disposed(state);
  });

  it('records the original manifest operation before a reentrant injected fetch disposes the coordinator', async () => {
    const state = setup(); const response = deferred<Response>(); const cancel = deferred<void>();
    state.fetch.mockImplementationOnce(async () => { state.coordinator.dispose(); return response.promise; });
    state.coordinator.replaceDesired(1, [state.descriptor('a')]); state.advance(); await turn(); held(state);
    let settled = false; void state.coordinator.whenDisposedAndSettled().then(() => { settled = true; });
    response.resolve(new Response(new ReadableStream<Uint8Array>({ cancel: () => cancel.promise })));
    await turn(); expect(settled).toBe(false); held(state);
    cancel.resolve(); await disposed(state);
  });
});
