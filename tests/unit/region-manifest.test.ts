import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadRegionManifest } from '../../packages/core/src/geometry/region-manifest.js';
import type { RegionManifestDescriptor } from '../../packages/core/src/geometry/region-manifest.js';
import { GeometryTransferBudget } from '../../packages/core/src/geometry/transfer-budget.js';
import type { GeometryRequestLease } from '../../packages/core/src/geometry/transfer-budget.js';
import { geometryFixture } from './geometry-fixture.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let count = 0; count < 8; count++) await Promise.resolve(); };
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const raw = geometryFixture().manifest;
  const manifest = { ...raw, source: { ...raw.source, triangleCount: 128 },
    clusters: raw.clusters.map(cluster => cluster.id === 1 ? { ...cluster, triangleCount: 128, indexCount: 384 } : cluster) };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const descriptor = { manifestUrl: new URL('https://geometry.test/region/manifest.json'), manifestBytes: bytes.byteLength, manifestSha256: hash(bytes) };
  return { manifest, bytes, descriptor };
}
function admitted(bytes: number) {
  const budget = new GeometryTransferBudget({ maxRequests: 1, pageStagingBytes: 65_536,
    transientBytes: 0, residentBytes: 0, gpuBufferBytes: 0, uploadBytesPerFrame: 65_536 });
  const nativeLease = budget.tryRequest(bytes)!;
  const lease = { finishRequest: vi.fn(() => nativeLease.finishRequest()), release: vi.fn(() => nativeLease.release()) };
  const controller = new AbortController();
  return { budget, lease, controller, options: { signal: controller.signal, maxManifestBytes: bytes, requestLease: lease } };
}
function released(state: ReturnType<typeof admitted>): void {
  expect(state.lease.release).toHaveBeenCalledTimes(1);
  expect(state.budget.telemetry).toMatchObject({ requests: 0, pageStagingBytes: 0 });
}

describe('authenticated region manifest request ownership', () => {
  it.each([false, true])('authenticates a chunked body with optional Content-Length: %s', async withLength => {
    const { bytes, descriptor, manifest } = fixture(); const state = admitted(bytes.byteLength);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      expect(state.budget.telemetry).toMatchObject({ requests: 1, pageStagingBytes: bytes.byteLength });
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.subarray(0, 11)); controller.enqueue(bytes.subarray(11)); controller.close();
      } }), withLength ? { headers: { 'content-length': String(bytes.byteLength) } } : {});
    });
    const result = await loadRegionManifest(descriptor, { ...state.options, fetch });
    expect(result).toEqual({ ...descriptor, manifest });
    expect(result.manifestUrl).not.toBe(descriptor.manifestUrl);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(fetch).toHaveBeenCalledWith(descriptor.manifestUrl, { signal: state.controller.signal });
    released(state);
  });

  it('rejects a missing lease without fetching', async () => {
    const { descriptor } = fixture(); const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(loadRegionManifest(descriptor, { signal: new AbortController().signal, fetch,
      maxManifestBytes: descriptor.manifestBytes, requestLease: undefined as unknown as GeometryRequestLease })).rejects.toThrow('admitted request lease');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a signal without listener removal before fetching and releases admission', async () => {
    const { descriptor } = fixture(); const state = admitted(descriptor.manifestBytes); const fetch = vi.fn<typeof globalThis.fetch>();
    const signal = { aborted: false, addEventListener: vi.fn() } as unknown as AbortSignal;
    await expect(loadRegionManifest(descriptor, { ...state.options, signal, fetch })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(fetch).not.toHaveBeenCalled(); released(state);
  });

  it('still awaits stream cancellation and releases admission when listener removal throws', async () => {
    const { descriptor } = fixture(); const state = admitted(descriptor.manifestBytes); const canceled = deferred<void>();
    const cancel = vi.fn(() => canceled.promise); const failure = new Error('listener removal failed');
    const signal = { aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn(() => { throw failure; }) } as unknown as AbortSignal;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(descriptor.manifestBytes + 1)); }, cancel });
    const pending = loadRegionManifest(descriptor, { ...state.options, signal,
      fetch: vi.fn<typeof globalThis.fetch>(async () => new Response(stream)) });
    const rejection = expect(pending).rejects.toBe(failure);
    await settle(); expect(cancel).toHaveBeenCalledTimes(1); expect(state.lease.release).not.toHaveBeenCalled();
    canceled.resolve(); await rejection; expect(stream.locked).toBe(false); released(state);
  });

  it.each(['oversize', 'unsafe', 'hash', 'url', 'quota'] as const)('rejects invalid %s metadata before fetching and releases admission', async kind => {
    const { descriptor } = fixture(); const state = admitted(descriptor.manifestBytes); const fetch = vi.fn<typeof globalThis.fetch>();
    const bad = { ...descriptor, ...(kind === 'oversize' ? { manifestBytes: descriptor.manifestBytes + 1 } : {}),
      ...(kind === 'unsafe' ? { manifestBytes: Number.MAX_SAFE_INTEGER + 1 } : {}), ...(kind === 'hash' ? { manifestSha256: 'bad' } : {}),
      ...(kind === 'url' ? { manifestUrl: new URL('data:application/json,{}') } : {}) };
    await expect(loadRegionManifest(bad, { ...state.options, fetch, ...(kind === 'quota' ? { maxManifestBytes: 0 } : {}) })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(fetch).not.toHaveBeenCalled(); released(state);
  });

  it('does not borrow or release an already transferred lease a second time', async () => {
    const { descriptor, bytes } = fixture(); const state = admitted(bytes.byteLength); const response = deferred<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(() => response.promise);
    const first = loadRegionManifest(descriptor, { ...state.options, fetch });
    await expect(loadRegionManifest(descriptor, { ...state.options, fetch })).rejects.toThrow('already transferred');
    expect(state.lease.release).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
    response.resolve(new Response(bytes)); await first; released(state);
  });

  it.each(['http', 'length', 'overflow', 'truncated', 'hash', 'json', 'structure', 'utf8'] as const)('rejects %s response and releases ownership', async kind => {
    const { descriptor, bytes } = fixture(); const state = admitted(bytes.byteLength);
    let payload = bytes;
    let expected: RegionManifestDescriptor = descriptor;
    if (kind === 'overflow') payload = new Uint8Array(bytes.byteLength + 1);
    if (kind === 'truncated') payload = bytes.subarray(1);
    if (kind === 'hash') { payload = bytes.slice(); payload[0] = payload[0]! ^ 1; }
    if (kind === 'json' || kind === 'structure' || kind === 'utf8') {
      payload = new Uint8Array(bytes.byteLength).fill(32);
      payload.set(kind === 'json' ? [123] : kind === 'structure' ? [123, 125] : [255]);
      expected = { ...descriptor, manifestSha256: hash(payload) };
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(payload, {
      status: kind === 'http' ? 503 : 200,
      ...(kind === 'length' ? { headers: { 'content-length': String(bytes.byteLength + 1) } } : {}),
    }));
    await expect(loadRegionManifest(expected, { ...state.options, fetch })).rejects.toThrow(); released(state);
  });

  it('preserves the pinned identity when the caller mutates its URL during fetch', async () => {
    const { descriptor, bytes } = fixture(); const state = admitted(bytes.byteLength); const response = deferred<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(() => response.promise);
    const pending = loadRegionManifest(descriptor, { ...state.options, fetch });
    descriptor.manifestUrl.pathname = '/different/manifest.json'; response.resolve(new Response(bytes));
    expect((await pending).manifestUrl.href).toBe('https://geometry.test/region/manifest.json'); released(state);
  });

  it('releases an already-aborted admission without starting fetch', async () => {
    const { descriptor } = fixture(); const state = admitted(descriptor.manifestBytes); const fetch = vi.fn<typeof globalThis.fetch>();
    state.controller.abort();
    await expect(loadRegionManifest(descriptor, { ...state.options, fetch })).rejects.toMatchObject({ code: 'INITIALIZATION_ABORTED' });
    expect(fetch).not.toHaveBeenCalled(); released(state);
  });

  it('retains canceled admission until an abort-ignoring fetch and returned body cancellation settle', async () => {
    const { descriptor } = fixture(); const state = admitted(descriptor.manifestBytes);
    const response = deferred<Response>(); const canceled = deferred<void>(); const cancel = vi.fn(() => canceled.promise);
    const pending = loadRegionManifest(descriptor, { ...state.options, fetch: vi.fn<typeof globalThis.fetch>(() => response.promise) });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'INITIALIZATION_ABORTED' });
    state.controller.abort(); await settle();
    expect(state.lease.release).not.toHaveBeenCalled();
    response.resolve(new Response(new ReadableStream({ cancel }))); await settle();
    expect(cancel).toHaveBeenCalledTimes(1); expect(state.lease.release).not.toHaveBeenCalled();
    expect(state.budget.tryRequest(1)).toBeUndefined();
    canceled.resolve(); await rejection; released(state);
  });

  it('retains admission through cancellation of an outstanding stream read', async () => {
    const { descriptor, bytes } = fixture(); const state = admitted(bytes.byteLength); const canceled = deferred<void>();
    const cancel = vi.fn(() => canceled.promise);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.subarray(0, 5)); }, cancel });
    const pending = loadRegionManifest(descriptor, { ...state.options, fetch: vi.fn<typeof globalThis.fetch>(async () => new Response(stream)) });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'INITIALIZATION_ABORTED' });
    await settle(); state.controller.abort(); await settle();
    expect(cancel).toHaveBeenCalledTimes(1); expect(state.lease.release).not.toHaveBeenCalled();
    canceled.resolve(); await rejection; expect(stream.locked).toBe(false); released(state);
  });

  it('awaits failed-response body cleanup before returning its admission', async () => {
    const { descriptor } = fixture(); const state = admitted(descriptor.manifestBytes); const canceled = deferred<void>();
    const cancel = vi.fn(() => canceled.promise); const stream = new ReadableStream<Uint8Array>({ cancel });
    const pending = loadRegionManifest(descriptor, { ...state.options, fetch: vi.fn<typeof globalThis.fetch>(async () => new Response(stream, { status: 503 })) });
    const rejection = expect(pending).rejects.toThrow('HTTP 503');
    await settle(); expect(cancel).toHaveBeenCalledTimes(1); expect(state.lease.release).not.toHaveBeenCalled();
    canceled.resolve(); await rejection; released(state);
  });

  it('retains admission through an in-flight digest after cancellation', async () => {
    const { descriptor, bytes } = fixture(); const state = admitted(bytes.byteLength); const digest = deferred<ArrayBuffer>();
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => digest.promise);
    const pending = loadRegionManifest(descriptor, { ...state.options, fetch: vi.fn<typeof globalThis.fetch>(async () => new Response(bytes)) });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'INITIALIZATION_ABORTED' });
    await settle(); expect(crypto.subtle.digest).toHaveBeenCalledTimes(1); state.controller.abort(); await settle();
    expect(state.lease.release).not.toHaveBeenCalled();
    digest.resolve(new Uint8Array(32).buffer); await rejection; released(state);
  });

  it('releases admission after a rejected fetch without replacing its failure', async () => {
    const { descriptor } = fixture(); const state = admitted(descriptor.manifestBytes); const failure = new Error('offline');
    await expect(loadRegionManifest(descriptor, { ...state.options, fetch: vi.fn<typeof globalThis.fetch>(async () => { throw failure; }) })).rejects.toBe(failure);
    released(state);
  });
});
