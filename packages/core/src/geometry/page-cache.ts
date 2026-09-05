import { StrataError } from '../errors.js';
import { validateGeometryPage } from './format.js';
import type { GeometryCluster, GeometryManifest, GeometryPage } from './format.js';
import type { GeometryMode } from './virtual-types.js';
import { planRetainedResidency } from './retained-residency.js';
import type { RetainedResidencyPlan } from './retained-residency.js';
import { GeometryChangeSignal } from './transfer-budget.js';
import type { GeometryInitialization, GeometryInitializationStatus, GeometryResourceLease, GeometryRequestLease,
  GeometryTransferBudget, GeometryUploadFrame } from './transfer-budget.js';

export interface GeometryPageDemand { readonly tileId: number; readonly lod: number; readonly priority: number }
export interface GeometryPageMapping { readonly pageId: number; readonly slot: number }
export interface GeometryPageUpdate {
  readonly uploaded: readonly GeometryPageMapping[];
  readonly evicted: readonly GeometryPageMapping[];
  readonly uploadBytes: number;
}
/** Explicit pool and typed-array storage only; parsed manifest/JS objects belong to the caller. */
export interface GeometryPageCacheEstimate {
  readonly capacityPages: number;
  readonly pageBytes: number;
  readonly gpuBufferBytes: number;
  readonly residentBytes: number;
}
export interface GeometryPageCacheOptions {
  geometryMode?: GeometryMode;
  /** Experimental fixed-demand fallback retention; the default planner remains greedy. */
  residencyPolicy?: 'greedy' | 'retain-fallback';
  poolBytes?: number;
  maxConcurrentRequests?: number;
  uploadBudgetBytes?: number;
  pageLoadDelayMs?: number;
  /** Bounds ready data plus reservations for requests that can complete asynchronously. */
  maxCompletedBytes?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
  /** Applies while roots/all-resident pages preload; runtime disposal owns later requests. */
  signal?: AbortSignal;
  /** Internal test/host injection; production uses fetch and performance.now. */
  fetch?: typeof fetch;
  now?: () => number;
}

interface Request {
  readonly pageId: number;
  readonly epoch: number;
  readonly controller: AbortController;
  cancelled: boolean;
  finished: boolean;
  lease?: GeometryRequestLease;
}
interface Failure { attempts: number; retryAt: number; terminal: boolean }
interface Settings {
  readonly mode: GeometryMode;
  readonly residencyPolicy: 'greedy' | 'retain-fallback';
  readonly capacityPages: number;
  readonly concurrent: number;
  readonly uploadPages: number;
  readonly reservedPages: number;
  readonly delayMs: number;
  readonly retries: number;
  readonly retryMs: number;
  readonly timeoutMs: number;
  readonly fetch: typeof fetch;
  readonly now: () => number;
}

function integer(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new StrataError('INVALID_OPTIONS', `${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function settings(device: GPUDevice, manifest: GeometryManifest, options: GeometryPageCacheOptions): Settings {
  const mode = options.geometryMode ?? 'streamed';
  if (!['streamed', 'resident-lod', 'resident-full'].includes(mode)) throw new StrataError('INVALID_OPTIONS', 'Unknown geometry residency mode.');
  const residencyPolicy = options.residencyPolicy ?? 'greedy';
  if (!['greedy', 'retain-fallback'].includes(residencyPolicy)) throw new StrataError('INVALID_OPTIONS', 'Unknown geometry residency policy.');
  if (residencyPolicy !== 'greedy' && mode !== 'streamed') throw new StrataError('INVALID_OPTIONS', 'Fallback retention applies only to streamed geometry.');
  const pageBytes = manifest.pageBytes;
  const requestedBytes = integer(options.poolBytes ?? 8 * 1024 * 1024, pageBytes, Number.MAX_SAFE_INTEGER, 'poolBytes');
  const capacityPages = mode === 'streamed' ? Math.min(manifest.pages.length, Math.floor(requestedBytes / pageBytes)) : manifest.pages.length;
  const poolBytes = capacityPages * pageBytes;
  if (poolBytes > device.limits.maxBufferSize || poolBytes > device.limits.maxStorageBufferBindingSize) {
    throw new StrataError('UNSUPPORTED_LIMIT', 'The geometry pool exceeds the device buffer/storage-binding limit.');
  }
  const roots = new Set(manifest.rootPageIds);
  if (capacityPages < roots.size) throw new StrataError('INVALID_OPTIONS', 'The geometry pool cannot hold all pinned coarse pages.');
  const refinements = manifest.tiles.flatMap(tile => tile.lods.slice(0, -1)
    .map(lod => lod.pageIds.filter(pageId => !roots.has(pageId)).length)).filter(count => count > 0);
  if (refinements.length && capacityPages < roots.size + Math.min(...refinements)) {
    throw new StrataError('INVALID_OPTIONS', 'The geometry pool must fit its coarse pages and at least one complete refinement.');
  }
  const concurrent = integer(options.maxConcurrentRequests ?? 4, 1, 32, 'maxConcurrentRequests');
  return {
    mode, residencyPolicy, capacityPages, concurrent,
    uploadPages: Math.floor(integer(options.uploadBudgetBytes ?? 4 * pageBytes, pageBytes, Number.MAX_SAFE_INTEGER, 'uploadBudgetBytes') / pageBytes),
    reservedPages: Math.floor(integer(options.maxCompletedBytes ?? concurrent * pageBytes, pageBytes, Number.MAX_SAFE_INTEGER, 'maxCompletedBytes') / pageBytes),
    delayMs: integer(options.pageLoadDelayMs ?? 0, 0, 120_000, 'pageLoadDelayMs'),
    retries: integer(options.maxRetries ?? 2, 0, 5, 'maxRetries'),
    retryMs: integer(options.retryDelayMs ?? 500, 0, 60_000, 'retryDelayMs'),
    timeoutMs: integer(options.requestTimeoutMs ?? 30_000, 1, 120_000, 'requestTimeoutMs'),
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis), now: options.now ?? (() => performance.now()),
  };
}

function aborted(): DOMException { return new DOMException('Geometry page request aborted.', 'AbortError'); }
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(aborted());
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(aborted()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, milliseconds);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** Fixed GPU slots with pinned roots, complete-LOD planning, and bounded asynchronous staging. */
export class GeometryPageCache {
  readonly buffer: GPUBuffer;
  private readonly slots: Int32Array;
  private readonly mapping: Int32Array;
  private readonly roots: ReadonlySet<number>;
  private readonly clustersByPage: readonly (readonly GeometryCluster[])[];
  private readonly pending = new Map<number, Request>();
  private readonly completed = new Map<number, Uint8Array<ArrayBuffer>>();
  private readonly completedLeases = new Map<number, GeometryRequestLease>();
  private readonly failures = new Map<number, Failure>();
  private readonly lastUsed = new Map<number, number>();
  private readonly waiters = new Set<() => void>();
  private hostChanges: GeometryChangeSignal | undefined;
  private demands: readonly GeometryPageDemand[] = [];
  private wanted: Set<number>;
  private pageOrder: number[];
  private plannedLods = new Map<number, number>();
  private retainedPlan: RetainedResidencyPlan | undefined;
  private preloading = true;
  private disposed = false;
  private epoch = 0;
  private frame = 0;
  private initialBytes = 0;
  private lastFailure: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly counts = {
    requestsStarted: 0, requestsCompleted: 0, requestsFailed: 0, requestsCancelled: 0,
    evictions: 0, uploadedPages: 0, uploadedBytes: 0, fetchedBytes: 0, discardedCompletions: 0,
  };

  private constructor(
    private readonly device: GPUDevice,
    private readonly manifest: GeometryManifest,
    private readonly manifestUrl: URL,
    private readonly settings: Settings,
    private readonly transferBudget?: GeometryTransferBudget,
    private readonly allocationLease?: GeometryResourceLease,
  ) {
    this.buffer = device.createBuffer({ label: 'Strata fixed geometry page pool', size: settings.capacityPages * manifest.pageBytes, usage: 0x80 | 0x8 });
    this.slots = new Int32Array(settings.capacityPages).fill(-1);
    this.mapping = new Int32Array(manifest.pages.length).fill(-1);
    this.roots = new Set(manifest.rootPageIds);
    this.pageOrder = settings.mode === 'streamed' ? [...manifest.rootPageIds] : manifest.pages.map(page => page.id);
    this.wanted = new Set(this.pageOrder);
    const clusters: GeometryCluster[][] = Array.from({ length: manifest.pages.length }, () => []);
    for (const cluster of manifest.clusters) clusters[cluster.pageId]!.push(cluster);
    this.clustersByPage = clusters;
  }

  static estimate(device: GPUDevice, manifest: GeometryManifest, options: GeometryPageCacheOptions = {}): GeometryPageCacheEstimate {
    const normalized = settings(device, manifest, options);
    return Object.freeze({ capacityPages: normalized.capacityPages, pageBytes: manifest.pageBytes,
      gpuBufferBytes: normalized.capacityPages * manifest.pageBytes,
      residentBytes: (normalized.capacityPages + manifest.pages.length) * Int32Array.BYTES_PER_ELEMENT });
  }

  /**
   * Internal host-driven initialization. No allocation, request or write happens
   * before advance; a supplied admission lease transfers on successful return.
   * Later ordinary update() calls retain their existing per-cache upload policy.
   */
  static begin(device: GPUDevice, manifest: GeometryManifest, manifestUrl: string | URL,
    options: GeometryPageCacheOptions, budget: GeometryTransferBudget,
    admission?: GeometryResourceLease): GeometryInitialization<GeometryPageCache> {
    options = { ...options };
    const normalized = settings(device, manifest, options);
    const estimate = GeometryPageCache.estimate(device, manifest, options);
    const url = new URL(String(manifestUrl), typeof location === 'undefined' ? undefined : location.href);
    const required = { residentBytes: estimate.residentBytes, gpuBufferBytes: estimate.gpuBufferBytes };
    if (estimate.pageBytes > budget.limits.pageStagingBytes || estimate.pageBytes > budget.limits.uploadBytesPerFrame
      || estimate.residentBytes > budget.limits.residentBytes || estimate.gpuBufferBytes > budget.limits.gpuBufferBytes) {
      throw new StrataError('INVALID_OPTIONS', 'Geometry cache initialization cannot fit the configured aggregate budget.');
    }
    if (admission && (admission.budget !== budget || admission.released
      || admission.amounts.transientBytes !== 0 || admission.amounts.residentBytes !== estimate.residentBytes
      || admission.amounts.gpuBufferBytes !== estimate.gpuBufferBytes)) {
      throw new StrataError('INVALID_OPTIONS', 'Geometry cache admission does not match its owned allocations.');
    }
    const changes = new GeometryChangeSignal();
    let status: GeometryInitializationStatus = 'pending';
    let error: unknown;
    let allocation = admission;
    let cache: GeometryPageCache | undefined;
    const unsubscribe = budget.subscribe(() => changes.notify());
    const detach = () => { unsubscribe(); options.signal?.removeEventListener('abort', abort); };
    const cleanup = () => {
      detach();
      if (cache) { cache.hostChanges = undefined; cache.dispose(); cache = undefined; }
      else allocation?.release();
      allocation = undefined;
    };
    const fail = (cause: unknown) => { error = cause; status = 'failed'; cleanup(); changes.notify(); };
    const abort = () => {
      if (status === 'taken' || status === 'disposed' || status === 'failed') return;
      error = new StrataError('INITIALIZATION_ABORTED', 'Geometry initialization was aborted.');
      status = 'disposed'; cleanup(); changes.notify();
    };
    const handle: GeometryInitialization<GeometryPageCache> = {
      get status() { return status; },
      get error() { return error; },
      get revision() { return changes.revision; },
      advance(frame) {
        const before = frame.writtenBytes;
        if (status !== 'pending') return { status, uploadBytes: 0 };
        try {
          if (frame.budget !== budget) throw new StrataError('INVALID_OPTIONS', 'Geometry initialization needs a frame from its owning budget.');
          frame.assertCurrent();
          if (options.signal?.aborted) { abort(); return { status, uploadBytes: 0 }; }
          if (!cache) {
            allocation ??= budget.tryReserve(required);
            if (!allocation) return { status, uploadBytes: 0 };
            cache = new GeometryPageCache(device, manifest, url, normalized, budget, allocation);
            cache.hostChanges = changes;
          }
          cache.update(frame);
          if (cache.pageOrder.some(pageId => cache!.failures.get(pageId)?.terminal)) {
            throw new StrataError('SCENE_LOAD_FAILED', 'A required initial geometry page failed validation or loading.');
          }
          if (cache.pageOrder.every(pageId => cache!.mapping[pageId] !== -1)) {
            cache.initialBytes = cache.counts.uploadedBytes;
            cache.preloading = false;
            cache.replan();
            status = 'ready'; changes.notify();
          }
        } catch (cause) { fail(cause); }
        return { status, uploadBytes: frame.writtenBytes - before };
      },
      waitForChange(afterRevision) {
        return status !== 'pending' ? Promise.resolve() : changes.wait(afterRevision);
      },
      takeReady() {
        if (status !== 'ready' || !cache) throw new StrataError('INVALID_OPTIONS', 'Geometry initialization is not ready for ownership transfer.');
        const result = cache; cache = undefined; allocation = undefined;
        result.hostChanges = undefined; status = 'taken'; detach(); changes.notify();
        return result;
      },
      dispose() {
        if (status === 'taken' || status === 'disposed') return;
        status = 'disposed'; cleanup(); changes.notify();
      },
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    return handle;
  }

  /** Roots (or all pages in resident modes) are ready before exposing the cache to rendering. */
  static async create(device: GPUDevice, manifest: GeometryManifest, manifestUrl: string | URL,
    options: GeometryPageCacheOptions = {}): Promise<GeometryPageCache> {
    if (options.signal?.aborted) throw new StrataError('INITIALIZATION_ABORTED', 'Geometry initialization was aborted.');
    const normalized = settings(device, manifest, options);
    const url = new URL(String(manifestUrl), typeof location === 'undefined' ? undefined : location.href);
    const cache = new GeometryPageCache(device, manifest, url, normalized);
    const abort = () => cache.dispose();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      while (cache.pageOrder.some(pageId => cache.mapping[pageId] === -1)) {
        if (cache.disposed) throw new StrataError('INITIALIZATION_ABORTED', 'Geometry initialization was aborted.');
        cache.update();
        if (cache.disposed) throw new StrataError('ENGINE_DISPOSED', 'Geometry cache initialization was cancelled.');
        if (cache.pageOrder.some(pageId => cache.failures.get(pageId)?.terminal)) {
          throw new StrataError('SCENE_LOAD_FAILED', 'A required initial geometry page failed validation or loading.');
        }
        if (cache.pageOrder.some(pageId => cache.mapping[pageId] === -1) && cache.completed.size === 0) await cache.changed();
      }
      if (cache.disposed) throw new StrataError('INITIALIZATION_ABORTED', 'Geometry initialization was aborted.');
      cache.initialBytes = cache.counts.uploadedBytes;
      cache.preloading = false;
      cache.replan();
      return cache;
    } catch (cause) { cache.dispose(); throw cause; }
    finally { options.signal?.removeEventListener('abort', abort); }
  }

  get initialUploadBytes(): number { return this.initialBytes; }
  get gpuBufferBytes(): number { return this.disposed ? 0 : this.settings.capacityPages * this.manifest.pageBytes; }
  get telemetry() {
    return {
      ...this.counts, poolBytes: this.gpuBufferBytes, capacityPages: this.settings.capacityPages,
      pageBytes: this.manifest.pageBytes, rootPages: this.roots.size,
      residentPages: this.lastUsed.size, pendingRequests: this.pending.size,
      completedPages: this.completed.size, completedBytes: this.completed.size * this.manifest.pageBytes,
      stagingReservedBytes: (this.pending.size + this.completed.size) * this.manifest.pageBytes,
      stagingBudgetBytes: this.settings.reservedPages * this.manifest.pageBytes,
      failedPages: [...this.failures.values()].filter(failure => failure.terminal).length,
      demandedTiles: this.demands.length, selectedDemandTiles: this.plannedLods.size,
      residencyPolicy: this.settings.residencyPolicy,
      retainedFallbackTiles: this.retainedPlan?.selectedLods.size ?? 0,
      retainedProtectedPages: this.retainedPlan?.protectedPageIds.size ?? 0,
      retainedTargetTile: this.retainedPlan?.target?.tileId ?? null,
      retainedTargetLod: this.retainedPlan?.target?.lod ?? null,
      retainedBlockedDemands: this.retainedPlan?.blockedDemands.length ?? 0,
      retainedDeferredDemands: this.retainedPlan?.deferredDemandCount ?? 0,
      retainedUnsatisfiedDemands: this.retainedPlan?.unsatisfiedDemandCount ?? 0,
      lastFailure: this.lastFailure,
    };
  }

  getSlot(pageId: number): number {
    integer(pageId, 0, this.manifest.pages.length - 1, 'pageId');
    return this.mapping[pageId]!;
  }
  isLodResident(tileId: number, lod: number): boolean {
    const tile = this.manifest.tiles[integer(tileId, 0, this.manifest.tiles.length - 1, 'tileId')]!;
    integer(lod, 0, tile.lods.length - 1, 'lod');
    return tile.lods[lod]!.pageIds.every(pageId => this.mapping[pageId] !== -1);
  }

  /** Replaces old camera demand; higher numeric priorities reserve complete refinements first. */
  setDemand(demands: readonly GeometryPageDemand[]): void {
    this.assertLive();
    const ids = new Set<number>();
    for (const demand of demands) {
      const tile = this.manifest.tiles[integer(demand.tileId, 0, this.manifest.tiles.length - 1, 'tileId')]!;
      integer(demand.lod, 0, tile.lods.length - 1, 'lod');
      if (!Number.isFinite(demand.priority) || ids.has(demand.tileId)) throw new StrataError('INVALID_OPTIONS', 'Geometry demand requires finite priorities and unique tile IDs.');
      ids.add(demand.tileId);
    }
    this.demands = demands.map(demand => ({ ...demand })).sort((a, b) => b.priority - a.priority || a.tileId - b.tileId);
    this.replan();
    this.pump();
  }

  private replan(): void {
    if (this.preloading || this.settings.mode !== 'streamed' || this.disposed) return;
    if (this.settings.residencyPolicy === 'retain-fallback') {
      const plan = planRetainedResidency(this.manifest, {
        demands: this.demands, residentPageIds: new Set(this.lastUsed.keys()),
        terminalFailedPageIds: new Set([...this.failures].filter(([, failure]) => failure.terminal).map(([id]) => id)),
        capacityPages: this.settings.capacityPages,
      });
      this.retainedPlan = plan;
      this.wanted = new Set(plan.wantedPageIds);
      this.pageOrder = [...plan.pageOrder];
      this.plannedLods = new Map(plan.selectedLods);
      if (plan.target) this.plannedLods.set(plan.target.tileId, plan.target.lod);
      this.cancelUnwanted();
      return;
    }
    const wanted = new Set(this.roots);
    const order = [...this.roots];
    const planned = new Map<number, number>();
    for (const demand of this.demands) {
      const tile = this.manifest.tiles[demand.tileId]!;
      for (let lod = demand.lod; lod < tile.lods.length; lod++) {
        const pages = tile.lods[lod]!.pageIds;
        if (pages.some(pageId => this.failures.get(pageId)?.terminal)) continue;
        const missing = pages.filter(pageId => !wanted.has(pageId));
        if (wanted.size + missing.length > this.settings.capacityPages) continue;
        for (const pageId of missing) { wanted.add(pageId); order.push(pageId); }
        planned.set(demand.tileId, lod);
        break;
      }
    }
    this.wanted = wanted;
    this.pageOrder = order;
    this.plannedLods = planned;
    this.cancelUnwanted();
  }

  private cancelUnwanted(): void {
    for (const pageId of this.completed.keys()) {
      if (!this.wanted.has(pageId)) {
        this.completed.delete(pageId); this.completedLeases.get(pageId)?.release(); this.completedLeases.delete(pageId);
        this.counts.discardedCompletions++;
      }
    }
    for (const request of this.pending.values()) {
      if (!this.wanted.has(request.pageId) && !request.cancelled && !request.finished) {
        request.cancelled = true;
        this.counts.requestsCancelled++;
        request.controller.abort();
      }
    }
  }

  /** Synchronous frame boundary: commit pool uploads and mapping changes before GPU encoding. */
  update(frame?: GeometryUploadFrame): GeometryPageUpdate {
    this.assertLive();
    if (this.settings.residencyPolicy === 'retain-fallback') this.replan();
    this.frame++;
    for (const pageId of this.wanted) if (this.mapping[pageId] !== -1) this.lastUsed.set(pageId, this.frame);
    const uploaded: GeometryPageMapping[] = [];
    const evicted: GeometryPageMapping[] = [];
    for (const pageId of this.pageOrder) {
      if (uploaded.length >= this.settings.uploadPages) break;
      // A shared page uploaded earlier in this batch may have completed a more
      // preferred LOD. Protect its entire dependency group before any eviction.
      if (this.settings.residencyPolicy === 'retain-fallback') {
        this.replan();
        if (!this.wanted.has(pageId)) continue;
      }
      const bytes = this.completed.get(pageId);
      if (!bytes) continue;
      let slot = this.slots.indexOf(-1);
      let victim = -1;
      if (slot === -1) {
        let age = Infinity;
        for (const [resident, used] of this.lastUsed) {
          if (!this.roots.has(resident) && !this.wanted.has(resident) && (used < age || (used === age && resident < victim))) {
            victim = resident; age = used;
          }
        }
        if (victim === -1) break;
        slot = this.mapping[victim]!;
      }
      // Keep the previous mapping intact if a synchronous upload fails.
      if (frame) {
        if (!frame.write(this.device, this.buffer, slot * this.manifest.pageBytes, bytes)) break;
      } else this.device.queue.writeBuffer(this.buffer, slot * this.manifest.pageBytes, bytes);
      if (victim !== -1) {
        this.mapping[victim] = -1; this.lastUsed.delete(victim);
        evicted.push({ pageId: victim, slot }); this.counts.evictions++;
      }
      this.slots[slot] = pageId; this.mapping[pageId] = slot; this.lastUsed.set(pageId, this.frame);
      this.completed.delete(pageId);
      this.completedLeases.get(pageId)?.release(); this.completedLeases.delete(pageId);
      uploaded.push({ pageId, slot });
      this.counts.uploadedPages++; this.counts.uploadedBytes += bytes.byteLength;
      if (this.settings.residencyPolicy === 'retain-fallback') this.replan();
    }
    this.pump();
    return { uploaded, evicted, uploadBytes: uploaded.length * this.manifest.pageBytes };
  }

  private pump(): void {
    if (this.disposed) return;
    if (this.retryTimer !== undefined) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    let retryAt = Infinity;
    for (const pageId of this.pageOrder) {
      if (this.mapping[pageId] !== -1 || this.pending.has(pageId) || this.completed.has(pageId)) continue;
      const failure = this.failures.get(pageId);
      if (failure?.terminal) continue;
      if (failure && failure.retryAt > this.settings.now()) { retryAt = Math.min(retryAt, failure.retryAt); continue; }
      if (this.pending.size >= this.settings.concurrent || this.pending.size + this.completed.size >= this.settings.reservedPages) break;
      const lease = this.transferBudget?.tryRequest(this.manifest.pageBytes);
      if (this.transferBudget && !lease) break;
      this.request(pageId, lease);
    }
    if (Number.isFinite(retryAt)) this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); this.notify(); }, Math.max(1, retryAt - this.settings.now()));
  }

  private request(pageId: number, lease?: GeometryRequestLease): void {
    const request: Request = { pageId, epoch: this.epoch, controller: new AbortController(), cancelled: false, finished: false, ...(lease ? { lease } : {}) };
    this.pending.set(pageId, request);
    this.counts.requestsStarted++;
    const timer = setTimeout(() => request.controller.abort(), this.settings.timeoutMs);
    void this.load(this.manifest.pages[pageId]!, request.controller.signal).then(bytes => {
      request.finished = true;
      if (this.disposed || request.epoch !== this.epoch || request.cancelled || !this.wanted.has(pageId)) {
        this.counts.discardedCompletions++; return;
      }
      this.failures.delete(pageId);
      // Transfer the reservation atomically: observers between promise reactions
      // must not count one validated payload as both pending and completed.
      if (this.pending.get(pageId) === request) this.pending.delete(pageId);
      this.completed.set(pageId, bytes);
      if (request.lease) {
        request.lease.finishRequest();
        this.completedLeases.set(pageId, request.lease);
        delete request.lease;
      }
      this.counts.requestsCompleted++;
    }).catch(cause => {
      request.finished = true;
      if (this.disposed || request.epoch !== this.epoch || request.cancelled) return;
      this.counts.requestsFailed++;
      this.lastFailure = cause instanceof Error ? cause.message : String(cause);
      const attempts = (this.failures.get(pageId)?.attempts ?? 0) + 1;
      this.failures.set(pageId, { attempts, retryAt: this.settings.now() + this.settings.retryMs, terminal: attempts > this.settings.retries });
      this.replan();
    }).finally(() => {
      clearTimeout(timer);
      if (this.pending.get(pageId) === request) this.pending.delete(pageId);
      request.lease?.release(); delete request.lease;
      this.notify();
      this.pump();
    });
  }

  private async load(page: GeometryPage, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    await delay(this.settings.delayMs, signal);
    if (signal.aborted) throw aborted();
    const response = await this.settings.fetch(new URL(page.url, this.manifestUrl), { signal });
    if (signal.aborted) { await response.body?.cancel(); throw aborted(); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Geometry page request failed with HTTP ${response.status}.`); }
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== page.byteLength) {
      await response.body?.cancel();
      throw new Error('Geometry response length does not match its page.');
    }
    const bytes = new Uint8Array(page.byteLength);
    let received = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (signal.aborted) { await reader.cancel(); throw aborted(); }
          if (done) break;
          this.counts.fetchedBytes += value.byteLength;
          if (received + value.byteLength > bytes.byteLength) { await reader.cancel(); throw new Error('Geometry response exceeds its page size.'); }
          bytes.set(value, received); received += value.byteLength;
        }
      } finally { reader.releaseLock(); }
    } else {
      const body = await response.arrayBuffer();
      this.counts.fetchedBytes += body.byteLength;
      if (body.byteLength !== bytes.byteLength) throw new Error('Geometry response length does not match its page.');
      bytes.set(new Uint8Array(body)); received = body.byteLength;
    }
    if (received !== page.byteLength || signal.aborted) throw new Error('Geometry page was truncated or its request was aborted.');
    const validated = await validateGeometryPage(page, bytes.buffer, this.clustersByPage[page.id]);
    if (signal.aborted) throw aborted();
    return validated;
  }

  private changed(): Promise<void> { return new Promise(resolve => this.waiters.add(resolve)); }
  private notify(): void { for (const resolve of this.waiters) resolve(); this.waiters.clear(); this.hostChanges?.notify(); }
  private assertLive(): void { if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'This geometry cache has been disposed.'); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.epoch++;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    for (const request of this.pending.values()) {
      if (!request.cancelled && !request.finished) this.counts.requestsCancelled++;
      request.cancelled = true; request.controller.abort();
    }
    this.pending.clear(); this.completed.clear(); this.lastUsed.clear();
    for (const lease of this.completedLeases.values()) lease.release();
    this.completedLeases.clear();
    this.retainedPlan = undefined;
    this.mapping.fill(-1); this.slots.fill(-1); this.wanted.clear(); this.pageOrder = [];
    this.buffer.destroy();
    this.allocationLease?.release();
    this.notify();
  }
}
