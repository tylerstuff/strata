import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RegionInitializationCoordinator } from '../../packages/core/src/geometry/region-initialization.js';
import { GeometryTransferBudget } from '../../packages/core/src/geometry/transfer-budget.js';
import { deferred, initializationSourceReceipt, recordingGeometryDevice, removeInitializationSource, writeInitializationReceipt } from '../helpers/cooked-geometry-initialization.js';
import { controlledRegionFetch, cookRegionSource, type ControlledRegionRequest, type CookedRegionSource } from '../helpers/region-initialization-fixture.js';

const pageBytes = 65_536;
type Descriptor = Parameters<RegionInitializationCoordinator['replaceDesired']>[1][number];
type Snapshot = ReturnType<RegionInitializationCoordinator['snapshot']>;
const sources: CookedRegionSource[] = [];
beforeAll(async () => {
  for (const seed of [51, 52, 53, 54]) sources.push(await cookRegionSource(seed));
}, 120_000);
afterAll(async () => { await Promise.all(sources.map(removeInitializationSource)); });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1));
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function descriptor(index: number, id = `region-${index}`, options: Partial<Descriptor['options']> = {}): Descriptor {
  const source = sources[index]!;
  return { id, manifestUrl: new URL(source.url), manifestBytes: source.manifestBytes.byteLength,
    manifestSha256: source.manifestSha256, bounds: { min: [-20, -20, -20], max: [20, 20, 20] },
    options: { poolBytes: 2 * pageBytes, ...options } };
}
interface FrameReceipt {
  readonly frame: number;
  readonly actualQueueBytes: number;
  readonly returnedUploadBytes: number;
  readonly advancedIncarnations: readonly number[];
  readonly liveEntries: number;
  readonly retiringEntries: number;
  readonly requestBytes: number;
  readonly retainedManifestBytes: number;
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });

function harness() {
  const gpu = recordingGeometryDevice(); const network = controlledRegionFetch(sources);
  const budget = new GeometryTransferBudget({ maxRequests: 2, pageStagingBytes: pageBytes,
    transientBytes: 1024 * 1024, residentBytes: 1024 * 1024, gpuBufferBytes: 4 * 1024 * 1024, uploadBytesPerFrame: pageBytes });
  const maxManifestBytes = Math.max(...sources.map(source => source.manifestBytes.byteLength));
  const limits = { maxDesiredRegions: 4, maxLiveRegions: 2, maxManifestBytes, maxRetainedManifestBytes: 2 * maxManifestBytes };
  const coordinator = new RegionInitializationCoordinator(gpu.device, budget, limits,
    { fetch: network.fetch, requestTimeoutMs: 120_000 });
  const frames: FrameReceipt[] = [];
  let frameId = 0;
  const queueBytes = () => gpu.receipts.reduce((sum, receipt) => sum + receipt.bytes.byteLength, 0);
  const advance = () => {
    const frame = budget.beginFrame(++frameId); const before = queueBytes();
    const result = coordinator.advance(frame); const actual = queueBytes() - before; const state = coordinator.snapshot();
    expect(result.uploadBytes).toBe(actual);
    expect(frame.writtenBytes).toBe(actual);
    expect(actual).toBeLessThanOrEqual(pageBytes);
    expect(new Set(result.advancedIncarnations).size).toBe(result.advancedIncarnations.length);
    expect(state.liveEntries).toBeLessThanOrEqual(limits.maxLiveRegions);
    expect(state.retainedManifestBytes).toBeLessThanOrEqual(limits.maxRetainedManifestBytes);
    expect(budget.telemetry.requests).toBeLessThanOrEqual(budget.limits.maxRequests);
    expect(budget.telemetry.pageStagingBytes).toBeLessThanOrEqual(pageBytes);
    frames.push({ frame: frameId, actualQueueBytes: actual, returnedUploadBytes: result.uploadBytes,
      advancedIncarnations: result.advancedIncarnations, liveEntries: state.liveEntries, retiringEntries: state.retiringEntries,
      requestBytes: budget.telemetry.pageStagingBytes, retainedManifestBytes: state.retainedManifestBytes });
    return result;
  };
  const drive = async (complete: (state: Snapshot) => boolean,
    respond: (request: ControlledRegionRequest) => boolean = () => true) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (complete(coordinator.snapshot())) return;
      advance();
      for (const request of network.pending) if (respond(request)) request.respond();
      const before = queueBytes();
      await tick();
      expect(queueBytes()).toBe(before); // Network/pipeline completion cannot write behind the host.
    }
    throw new Error(`Region initialization did not reach its gate: ${JSON.stringify(coordinator.snapshot())}`);
  };
  const dispose = async () => {
    coordinator.dispose(); network.settleForCleanup(); await coordinator.whenDisposedAndSettled();
    expect(budget.telemetry).toMatchObject({ requests: 0, pageStagingBytes: 0, transientBytes: 0, residentBytes: 0, gpuBufferBytes: 0 });
    expect(coordinator.snapshot()).toMatchObject({ liveEntries: 0, retiringEntries: 0, retainedManifestBytes: 0 });
    expect(gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  };
  cleanup.push(dispose);
  return { gpu, network, budget, limits, coordinator, frames, advance, drive, queueBytes, dispose };
}
const allReady = (state: Snapshot) => state.regions.length > 0 && state.regions.every(region => region.status === 'ready');
function noOwnership(h: ReturnType<typeof harness>): void {
  expect(h.budget.telemetry).toMatchObject({ requests: 0, pageStagingBytes: 0, transientBytes: 0, residentBytes: 0, gpuBufferBytes: 0 });
  expect(h.coordinator.snapshot()).toMatchObject({ disposed: true, liveEntries: 0, retiringEntries: 0, retainedManifestBytes: 0 });
  expect(h.gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
}

describe('region initialization with real cooked sources and bounded ownership', () => {
  it('reverses the initialization advance order across two turns while both regions remain eligible', async () => {
    const h = harness();
    const compiled = await h.gpu.raw.createComputePipelineAsync.getMockImplementation()!();
    const firstCompilation = deferred<typeof compiled>(); const secondCompilation = deferred<typeof compiled>();
    let compilations = 0;
    // Each provider starts two pipeline promises. Holding both providers keeps
    // the same eligible pair present across consecutive host advance turns.
    h.gpu.raw.createComputePipelineAsync.mockImplementation(() => ++compilations <= 2 ? firstCompilation.promise : secondCompilation.promise);
    h.coordinator.replaceDesired(1, [descriptor(0), descriptor(1)]);
    try {
      await h.drive(() => h.network.requests.length === 2, () => false);
      for (const request of h.network.pending) request.respond();
      // Do not advance one early authentication ahead of the other; digest
      // completion order must not affect the fixed eligible-pair witness.
      for (let attempt = 0; attempt < 300 && !h.coordinator.snapshot().regions.every(region => region.status === 'authenticated'); attempt++) await tick();
      expect(h.coordinator.snapshot().regions.map(region => region.status)).toEqual(['authenticated', 'authenticated']);
      const first = h.advance().advancedIncarnations;
      expect(first).toHaveLength(2);
      expect(h.coordinator.snapshot().regions.every(region => region.status === 'initializing')).toBe(true);
      const second = h.advance().advancedIncarnations;
      expect(second).toEqual([...first].reverse());
      expect(compilations).toBe(4);
      expect(h.network.requests.every(request => request.kind === 'manifest')).toBe(true);
    } finally {
      firstCompilation.resolve(compiled); secondCompilation.resolve(compiled);
    }
    await h.drive(allReady);
  });

  it('rotates four distinct sources through two live slots and records actual shared-budget queue writes', async () => {
    const h = harness(); const desired = sources.map((_, index) => descriptor(index));
    expect(new Set(sources.map(source => source.manifestSha256)).size).toBe(4);
    expect(new Set(sources.map(source => hash(source.pages[0]!))).size).toBe(4);
    h.coordinator.replaceDesired(1, desired);
    await h.drive(state => state.regions.filter(region => region.status === 'ready').length === 2);
    const first = h.coordinator.snapshot();
    expect(first.regions.map(region => region.status)).toEqual(['ready', 'ready', 'queued', 'queued']);
    expect(first.liveEntries).toBe(2);
    expect(first.regions.slice(0, 2).map(region => region.sourceBounds)).toEqual(sources.slice(0, 2).map(source => source.manifest.bounds));
    expect(h.network.requests.filter(request => request.kind === 'manifest').map(request => request.source.manifest.source.seed)).toEqual([51, 52]);
    h.coordinator.replaceDesired(2, desired.slice(2));
    await h.drive(allReady);
    const ready = h.coordinator.snapshot();
    expect(ready.regions.map(region => region.id)).toEqual(['region-2', 'region-3']);
    expect(ready.startedEntries).toBe(4);
    expect(ready.peakLiveEntries).toBe(2);
    const manifestSeeds = h.network.requests.filter(request => request.kind === 'manifest').map(request => request.source.manifest.source.seed);
    expect(manifestSeeds.slice(0, 2)).toEqual([51, 52]);
    // Admission turns rotate while retired providers settle. Either order for
    // the second pair is valid; this is no request-order/fairness contract.
    expect(manifestSeeds.slice(2).sort()).toEqual([53, 54]);
    const pages = h.network.requests.filter(request => request.kind === 'page');
    expect(pages).toHaveLength(4);
    expect(pages.every(request => request.source.manifest.rootPageIds.includes(request.pageId!))).toBe(true);
    const rootWrites = h.gpu.receipts.filter(receipt => receipt.label === 'Strata fixed geometry page pool');
    expect(rootWrites.map(receipt => hash(receipt.bytes)).sort()).toEqual(sources.map(source => hash(source.pages[0]!)).sort());
    expect(rootWrites.every(receipt => receipt.bytes.byteLength === pageBytes)).toBe(true);
    expect(h.budget.telemetry.peakPageStagingBytes).toBe(pageBytes);
    expect(ready.uploadBytes).toBe(h.queueBytes());
    expect(h.budget.telemetry.uploadBytes).toBe(h.queueBytes());
    await h.dispose(); noOwnership(h);
    await writeInitializationReceipt('four-region-two-slot-coordinator', {
      sources: sources.map(source => ({ ...initializationSourceReceipt(source), manifestBytes: source.manifestBytes.byteLength })),
      coordinatorLimits: h.limits, transferLimits: h.budget.limits, frames: h.frames, firstReady: first, finalReady: ready,
      queueWrites: h.gpu.receipts.map(receipt => ({ label: receipt.label, offset: receipt.offset, bytes: receipt.bytes.byteLength, sha256: hash(receipt.bytes) })),
      finalCoordinator: h.coordinator.snapshot(), finalBudget: h.budget.telemetry, allBuffersDestroyedExactlyOnce: true,
      scope: 'CPU recording fake queue over real manifests and pages; no browser or GPU completion evidence',
    });
  });

  it('reuses normalized options while replacing scheduling bounds independently of source bounds', async () => {
    const h = harness(); h.coordinator.replaceDesired(1, [descriptor(0)]); await h.drive(allReady);
    const first = h.coordinator.snapshot(); const requests = h.network.requests.length; const writes = h.queueBytes();
    const bounds: Descriptor['bounds'] = { min: [1000, -100, 2000], max: [1040, 100, 2040] };
    h.coordinator.replaceDesired(2, [{ ...descriptor(0, 'region-0', { pixelError: 2, cameraMode: 'tour', residencyPolicy: 'greedy' }), bounds }]);
    h.advance(); await tick();
    const second = h.coordinator.snapshot();
    expect(second.regions[0]!.incarnation).toBe(first.regions[0]!.incarnation);
    expect(second.regions[0]!.bounds).toEqual(bounds);
    expect(second.regions[0]!.sourceBounds).toEqual(sources[0]!.manifest.bounds);
    expect(second.regions[0]!.status).toBe('ready');
    expect(second.startedEntries).toBe(1);
    expect(second.reusedEntries).toBeGreaterThan(first.reusedEntries);
    expect(h.network.requests).toHaveLength(requests); expect(h.queueBytes()).toBe(writes);
    expect(h.gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 0)).toBe(true);
  });

  it.each([
    ['poolBytes', { poolBytes: 3 * pageBytes }],
    ['cameraMode', { cameraMode: 'coverage' }],
    ['pixelError', { pixelError: 8 }],
    ['residencyPolicy', { residencyPolicy: 'retain-fallback' }],
  ] as const)('invalidates reuse when %s changes', async (_name, change) => {
    const h = harness(); h.coordinator.replaceDesired(1, [descriptor(0)]); await h.drive(allReady);
    const old = h.coordinator.snapshot().regions[0]!; const oldBuffers = [...h.gpu.buffers];
    h.coordinator.replaceDesired(2, [descriptor(0, 'region-0', change)]);
    await h.drive(allReady);
    const current = h.coordinator.snapshot().regions[0]!;
    expect(current.incarnation).not.toBe(old.incarnation);
    expect(current.options).toMatchObject(change);
    expect(oldBuffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    expect(h.network.requests.filter(request => request.kind === 'manifest')).toHaveLength(2);
  });

  it('invalidates reuse for a new source under the same region ID', async () => {
    const h = harness(); h.coordinator.replaceDesired(1, [descriptor(0, 'same-id')]); await h.drive(allReady);
    const old = h.coordinator.snapshot().regions[0]!;
    h.coordinator.replaceDesired(2, [descriptor(1, 'same-id')]); await h.drive(allReady);
    const current = h.coordinator.snapshot().regions[0]!;
    expect(current.incarnation).not.toBe(old.incarnation);
    expect(current.manifestSha256).toBe(sources[1]!.manifestSha256);
    expect(current.manifestUrl).toBe(sources[1]!.url.href);
    const rootWrites = h.gpu.receipts.filter(receipt => receipt.label === 'Strata fixed geometry page pool');
    expect(rootWrites.map(receipt => hash(receipt.bytes))).toEqual(sources.slice(0, 2).map(source => hash(source.pages[0]!)));
  });

  it.each(['manifestUrl', 'manifestBytes', 'manifestSha256'] as const)('reauthenticates changed %s independently instead of reusing a ready source', async key => {
    const h = harness(); const original = descriptor(0, 'same-id');
    h.coordinator.replaceDesired(1, [original]); await h.drive(allReady);
    const old = h.coordinator.snapshot().regions[0]!;
    // Each single-field mismatch remains admissible but no longer describes the
    // real response identity, so fresh authentication must fail closed.
    const changed = { ...original, ...(key === 'manifestUrl' ? { manifestUrl: new URL(sources[1]!.url) }
      : key === 'manifestBytes' ? { manifestBytes: original.manifestBytes - 1 } : { manifestSha256: '0'.repeat(64) }) };
    h.coordinator.replaceDesired(2, [changed]);
    await h.drive(state => state.regions[0]!.status === 'failed');
    const current = h.coordinator.snapshot().regions[0]!;
    expect(current.incarnation).not.toBe(old.incarnation);
    expect(current.error).toMatch(/Content-Length|SHA-256/);
    expect(h.network.requests.filter(request => request.kind === 'manifest')).toHaveLength(2);
    expect(h.gpu.receipts.filter(receipt => receipt.label === 'Strata fixed geometry page pool')).toHaveLength(1);
  });

  it('holds both A→B→A manifest incarnations through original cancellation and rejects premature-slot/quota accounting', async () => {
    const h = harness(); h.coordinator.replaceDesired(1, [descriptor(0, 'region')]);
    await h.drive(() => h.network.requests.length === 1, () => false);
    const a = h.network.requests[0]!; const aIncarnation = h.coordinator.snapshot().regions[0]!.incarnation;
    h.coordinator.replaceDesired(2, [descriptor(1, 'region')]);
    await h.drive(() => h.network.requests.length === 2, () => false);
    const b = h.network.requests[1]!;
    h.coordinator.replaceDesired(3, [descriptor(0, 'region')]);
    h.advance(); await tick();
    const blocked = h.coordinator.snapshot();
    expect(blocked).toMatchObject({ liveEntries: 2, retiringEntries: 2, startedEntries: 2 });
    expect(blocked.regions[0]!.status).toBe('queued');
    expect(a.signal!.aborted && b.signal!.aborted).toBe(true);
    expect(h.network.requests).toHaveLength(2); expect(h.queueBytes()).toBe(0);
    const cancellation = a.respondWithHeldCancellation(); await cancellation.started;
    h.advance(); await tick();
    expect(h.coordinator.snapshot().liveEntries).toBe(2);
    expect(h.budget.tryRequest(sources[0]!.manifestBytes.byteLength)).toBeUndefined();
    expect(blocked.retainedManifestBytes).toBe(sources[0]!.manifestBytes.byteLength + sources[1]!.manifestBytes.byteLength);
    expect(blocked.retainedManifestBytes + sources[0]!.manifestBytes.byteLength).toBeGreaterThan(h.limits.maxRetainedManifestBytes);
    // Deliberately wrong accounting drops canceled entries and releases request
    // leases at disposal. It admits a third source while the real response's
    // cancellation is still pending, unlike the production coordinator above.
    const premature = new GeometryTransferBudget(h.budget.limits);
    const leases = [premature.tryRequest(sources[0]!.manifestBytes.byteLength)!, premature.tryRequest(sources[1]!.manifestBytes.byteLength)!];
    leases.forEach(lease => lease.release());
    const incorrectLiveEntries = blocked.liveEntries - blocked.retiringEntries;
    const incorrectRetainedBytes = blocked.retainedManifestBytes
      - blocked.retiring.reduce((bytes, region) => bytes + region.manifestBytes, 0);
    expect(incorrectLiveEntries + 1).toBeLessThanOrEqual(h.limits.maxLiveRegions);
    expect(incorrectRetainedBytes).toBe(0);
    expect(incorrectRetainedBytes + sources[0]!.manifestBytes.byteLength).toBeLessThanOrEqual(h.limits.maxRetainedManifestBytes);
    const improperlyAdmitted = premature.tryRequest(sources[0]!.manifestBytes.byteLength);
    expect(improperlyAdmitted).toBeDefined(); improperlyAdmitted!.release();
    const negativeControl = { actualLiveEntries: blocked.liveEntries, actualPendingRequests: h.budget.telemetry.requests,
      discardedRetiringEntries: blocked.retiringEntries, incorrectlyReportedLiveEntries: incorrectLiveEntries,
      actualRetainedManifestBytes: blocked.retainedManifestBytes, incorrectlyReleasedRetainedManifestBytes: blocked.retainedManifestBytes,
      incorrectlyReportedRetainedManifestBytes: incorrectRetainedBytes, prematureRetainedAccountingWouldFitThird: true,
      prematureAccountingWouldAdmitThird: true, actualCoordinatorAdmittedThird: false, originalCancellationPending: true };
    cancellation.release(); b.respond();
    await h.drive(allReady);
    const current = h.coordinator.snapshot().regions[0]!;
    expect(current.incarnation).not.toBe(aIncarnation);
    expect(current.manifestSha256).toBe(sources[0]!.manifestSha256);
    expect(h.network.requests.filter(request => request.kind === 'manifest')).toHaveLength(3);
    expect(h.gpu.receipts.filter(receipt => receipt.label === 'Strata fixed geometry page pool')).toHaveLength(1);
    await h.dispose(); noOwnership(h);
    await writeInitializationReceipt('region-stale-manifest-negative-control', { negativeControl, frames: h.frames,
      finalCoordinator: h.coordinator.snapshot(), finalBudget: h.budget.telemetry });
  });

  it('blocks a replacement manifest behind an old root and never publishes stale A→B→A root bytes', async () => {
    const h = harness(); h.coordinator.replaceDesired(1, [descriptor(0, 'region')]);
    await h.drive(() => h.network.requests.some(request => request.kind === 'page'), request => request.kind === 'manifest');
    const old = h.coordinator.snapshot().regions[0]!;
    const oldRoot = h.network.requests.find(request => request.kind === 'page')!;
    expect(h.budget.telemetry.pageStagingBytes).toBe(pageBytes);
    const oldWrites = h.queueBytes();
    h.coordinator.replaceDesired(2, [descriptor(1, 'region')]); h.advance(); await tick();
    h.coordinator.replaceDesired(3, [descriptor(0, 'region')]); h.advance(); await tick();
    const cancellation = oldRoot.respondWithHeldCancellation(); await cancellation.started;
    h.advance(); await tick();
    expect(oldRoot.signal!.aborted).toBe(true);
    expect(h.budget.telemetry.pageStagingBytes).toBe(pageBytes);
    expect(h.network.requests.filter(request => request.kind === 'manifest')).toHaveLength(1);
    expect(h.queueBytes()).toBe(oldWrites);
    expect(h.coordinator.snapshot().regions.every(region => region.status !== 'ready')).toBe(true);
    cancellation.release(); await h.drive(allReady);
    const current = h.coordinator.snapshot().regions[0]!;
    expect(current.incarnation).not.toBe(old.incarnation);
    const roots = h.gpu.receipts.filter(receipt => receipt.label === 'Strata fixed geometry page pool');
    expect(roots).toHaveLength(1); expect(roots[0]!.bytes).toEqual(sources[0]!.pages[0]);
    expect(h.network.requests.filter(request => request.kind === 'manifest').map(request => request.source.manifest.source.seed)).toEqual([51, 51]);
  });

  it('authenticates manifests before GPU allocation and releases manifest staging before root requests', async () => {
    const h = harness(); h.coordinator.replaceDesired(1, [descriptor(0)]);
    await h.drive(() => h.network.requests.length === 1, () => false);
    expect(h.gpu.buffers).toHaveLength(0);
    expect(h.budget.telemetry.pageStagingBytes).toBe(sources[0]!.manifestBytes.byteLength);
    h.network.requests[0]!.respond();
    await h.drive(() => h.network.requests.some(request => request.kind === 'page'), () => false);
    expect(h.coordinator.snapshot().regions[0]!.sourceBounds).toEqual(sources[0]!.manifest.bounds);
    expect(h.budget.telemetry).toMatchObject({ requests: 1, pageStagingBytes: pageBytes });
    expect(h.gpu.receipts.some(receipt => receipt.label === 'Strata cooked geometry metadata')).toBe(true);
    expect(h.gpu.receipts.some(receipt => receipt.label === 'Strata fixed geometry page pool')).toBe(false);
    await h.drive(allReady);
    expect(h.budget.telemetry.pageStagingBytes).toBe(0);
    expect(h.budget.telemetry.peakPageStagingBytes).toBe(pageBytes);
  });

  it('retains terminal manifest failures without publishing or automatically retrying the same desired source', async () => {
    const h = harness(); h.coordinator.replaceDesired(1, [descriptor(0)]);
    await h.drive(() => h.network.requests.length === 1, () => false);
    h.network.requests[0]!.respond({ corrupt: true });
    await h.drive(state => state.regions[0]!.status === 'failed', () => false);
    const failed = h.coordinator.snapshot().regions[0]!;
    expect(failed.error).toMatch(/SHA-256/);
    expect(h.gpu.buffers).toHaveLength(0);
    h.coordinator.replaceDesired(2, [descriptor(0)]); h.advance(); await tick();
    expect(h.coordinator.snapshot().regions[0]!.status).toBe('failed');
    expect(h.coordinator.snapshot().regions[0]!.incarnation).toBe(failed.incarnation);
    expect(h.network.requests).toHaveLength(1);
  });
});
