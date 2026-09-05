import { StrataError } from '../errors.js';
import { GpuGeometry } from './gpu-geometry.js';
import { loadRegionManifest } from './region-manifest.js';
import type { LoadedRegionManifest } from './region-manifest.js';
import { GeometryChangeSignal } from './transfer-budget.js';
import type { GeometryInitialization, GeometryInitializationStatus, GeometryTransferBudget, GeometryUploadFrame } from './transfer-budget.js';

export interface RegionBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}
export interface RegionInitializationOptions {
  readonly poolBytes: number;
  readonly pixelError?: number;
  readonly cameraMode?: 'tour' | 'coverage';
  readonly residencyPolicy?: 'greedy' | 'retain-fallback';
}
export interface RegionDescriptor {
  readonly id: string;
  readonly manifestUrl: URL;
  readonly manifestBytes: number;
  readonly manifestSha256: string;
  /** Host scheduling metadata only. This coordinator applies no placement transform. */
  readonly bounds: RegionBounds;
  readonly options: RegionInitializationOptions;
}
export interface RegionInitializationLimits {
  readonly maxDesiredRegions: number;
  /** Includes active and retiring entries until their original operations settle. */
  readonly maxLiveRegions: number;
  readonly maxManifestBytes: number;
  /** Encoded source content, not a measurement of parsed JavaScript heap. */
  readonly maxRetainedManifestBytes: number;
}
export interface RegionCoordinatorOptions {
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
}
export type RegionStatus = 'queued' | 'manifest' | 'authenticated' | 'initializing' | 'ready' | 'failed';
interface NormalizedDescriptor {
  readonly id: string;
  readonly manifestUrl: string;
  readonly manifestBytes: number;
  readonly manifestSha256: string;
  readonly bounds: RegionBounds;
  readonly options: Readonly<Required<RegionInitializationOptions>>;
  readonly key: string;
}
export interface RegionSnapshot extends Omit<NormalizedDescriptor, 'key'> {
  readonly incarnation: number;
  readonly status: RegionStatus | 'retiring';
  readonly sourceBounds?: RegionBounds;
  readonly error?: string;
}
interface DesiredRegion {
  descriptor: NormalizedDescriptor;
  readonly incarnation: number;
  status: RegionStatus;
  error?: string;
  entry?: LiveRegion | undefined;
}
interface LiveRegion {
  readonly owner: DesiredRegion;
  readonly controller: AbortController;
  retiring: boolean;
  manifestOperation?: Promise<void> | undefined;
  watchOperation?: Promise<void> | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
  loaded?: LoadedRegionManifest | undefined;
  sourceBounds?: RegionBounds;
  handle?: GeometryInitialization<GpuGeometry> | undefined;
  provider?: GpuGeometry | undefined;
}

const invalid = (message: string): StrataError => new StrataError('INVALID_OPTIONS', message);
function integer(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}
function shape(value: unknown, keys: readonly string[], name: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw invalid(`${name} contains unsupported fields or is not an object.`);
  }
}
function bounds(value: RegionBounds): RegionBounds {
  shape(value, ['min', 'max'], 'Region bounds');
  const lower = value.min; const upper = value.max;
  if (!Array.isArray(lower) || !Array.isArray(upper) || lower.length !== 3 || upper.length !== 3) {
    throw invalid('Region bounds require three finite ordered coordinates per endpoint.');
  }
  // Read the three numeric slots explicitly: neither holes nor a caller-supplied
  // iterator may bypass validation or expand this bounded descriptor.
  const min = [lower[0], lower[1], lower[2]] as const;
  const max = [upper[0], upper[1], upper[2]] as const;
  if (![...min, ...max].every(component => typeof component === 'number' && Number.isFinite(component) && Math.abs(component) <= Number.MAX_SAFE_INTEGER)
    || min.some((component, index) => component > max[index]!)) {
    throw invalid('Region bounds require three finite ordered coordinates per endpoint.');
  }
  return Object.freeze({ min: Object.freeze(min), max: Object.freeze(max) });
}
function receipt(cause: unknown): string {
  // Do not retain an arbitrary response/error object in the bounded desired set.
  try { return (cause instanceof Error ? cause.message : String(cause)).slice(0, 512); }
  catch { return 'Region initialization failed.'; }
}

/** Internal initialization orchestration only. Owns providers without exposing a renderer
 * or scene-composition API. The host still owns the selected set and physical frame clock. */
export class RegionInitializationCoordinator {
  readonly limits: Readonly<RegionInitializationLimits>;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly changes = new GeometryChangeSignal();
  private readonly unsubscribe: () => void;
  private desired = new Map<string, DesiredRegion>();
  private readonly live = new Set<LiveRegion>();
  private desiredRevision = 0;
  private nextIncarnation = 0;
  private admissionTurn = 0;
  private advanceTurn = 0;
  private disposed = false;
  private retainedBytes = 0;
  private peakLiveEntries = 0;
  private peakRetainedBytes = 0;
  private uploadBytes = 0;
  private startedEntries = 0;
  private reusedEntries = 0;
  private settledEntries = 0;
  private resolveSettlement!: () => void;
  private readonly settlement = new Promise<void>(resolve => { this.resolveSettlement = resolve; });

  constructor(private readonly device: GPUDevice, private readonly budget: GeometryTransferBudget,
    limits: RegionInitializationLimits, options: RegionCoordinatorOptions = {}) {
    shape(limits, ['maxDesiredRegions', 'maxLiveRegions', 'maxManifestBytes', 'maxRetainedManifestBytes'], 'Region limits');
    const desired = integer(limits.maxDesiredRegions, 1, 64, 'maxDesiredRegions');
    this.limits = Object.freeze({ maxDesiredRegions: desired,
      maxLiveRegions: integer(limits.maxLiveRegions, 1, desired, 'maxLiveRegions'),
      maxManifestBytes: integer(limits.maxManifestBytes, 1, 2_147_483_647, 'maxManifestBytes'),
      maxRetainedManifestBytes: integer(limits.maxRetainedManifestBytes, 1, Number.MAX_SAFE_INTEGER, 'maxRetainedManifestBytes') });
    shape(options, ['fetch', 'requestTimeoutMs'], 'Region coordinator options');
    if (options.fetch !== undefined && typeof options.fetch !== 'function') throw invalid('Region fetch must be a function.');
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = integer(options.requestTimeoutMs === undefined ? 30_000 : options.requestTimeoutMs, 1, 120_000, 'requestTimeoutMs');
    this.unsubscribe = budget.subscribe(() => { if (!this.disposed) this.changes.notify(); });
  }

  private normalize(value: RegionDescriptor): NormalizedDescriptor {
    shape(value, ['id', 'manifestUrl', 'manifestBytes', 'manifestSha256', 'bounds', 'options'], 'Region descriptor');
    if (typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 128) throw invalid('Region ID must contain 1 to 128 characters.');
    if (!(value.manifestUrl instanceof URL) || !['http:', 'https:'].includes(value.manifestUrl.protocol)
      || value.manifestUrl.href.length > 2048 || value.manifestUrl.username || value.manifestUrl.password) {
      throw invalid('Region manifest URL must be an HTTP(S) URL of at most 2048 characters without embedded credentials.');
    }
    const manifestBytes = integer(value.manifestBytes, 1, this.limits.maxManifestBytes, 'manifestBytes');
    if (manifestBytes > this.limits.maxRetainedManifestBytes || manifestBytes > this.budget.limits.pageStagingBytes) {
      throw invalid('One region manifest cannot fit the configured retained-content or request-staging capacity.');
    }
    if (typeof value.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifestSha256)) throw invalid('Region manifest SHA-256 must be 64 lowercase hexadecimal characters.');
    shape(value.options, ['poolBytes', 'pixelError', 'cameraMode', 'residencyPolicy'], 'Region initialization options');
    const poolBytes = integer(value.options.poolBytes, 65_536, Number.MAX_SAFE_INTEGER, 'poolBytes');
    if (poolBytes % 65_536) throw invalid('Region poolBytes must contain whole 65536-byte pages.');
    const pixelError = value.options.pixelError === undefined ? 2 : value.options.pixelError;
    const cameraMode = value.options.cameraMode === undefined ? 'tour' : value.options.cameraMode;
    const residencyPolicy = value.options.residencyPolicy === undefined ? 'greedy' : value.options.residencyPolicy;
    if (typeof pixelError !== 'number' || !Number.isFinite(pixelError) || pixelError <= 0 || pixelError > 1000
      || !['tour', 'coverage'].includes(cameraMode) || !['greedy', 'retain-fallback'].includes(residencyPolicy)) {
      throw invalid('Region pixel error, camera mode or residency policy is invalid.');
    }
    const options = Object.freeze({ poolBytes, pixelError, cameraMode, residencyPolicy });
    const manifestUrl = value.manifestUrl.href;
    return Object.freeze({ id: value.id, manifestUrl, manifestBytes, manifestSha256: value.manifestSha256,
      bounds: bounds(value.bounds), options,
      key: JSON.stringify([manifestUrl, manifestBytes, value.manifestSha256, poolBytes, pixelError, cameraMode, residencyPolicy]) });
  }

  /** Validate the entire bounded update before retiring any existing ownership. */
  replaceDesired(revision: number, descriptors: readonly RegionDescriptor[]): void {
    if (this.disposed) throw invalid('The region coordinator is disposed.');
    integer(revision, 1, Number.MAX_SAFE_INTEGER, 'Desired revision');
    if (revision <= this.desiredRevision) throw invalid('Desired revisions must strictly increase.');
    if (!Array.isArray(descriptors)) throw invalid('The desired region set must be an array.');
    const count = integer(descriptors.length, 0, this.limits.maxDesiredRegions, 'Desired descriptor count');
    // Visit each bounded numeric index before mutation. map skips holes, while
    // Array.from would let a supplied iterator expand beyond the admitted count.
    const normalized: NormalizedDescriptor[] = [];
    for (let index = 0; index < count; index++) normalized.push(this.normalize(descriptors[index]!));
    if (new Set(normalized.map(value => value.id)).size !== normalized.length) throw invalid('Desired region IDs must be unique.');
    const fresh = normalized.filter(value => this.desired.get(value.id)?.descriptor.key !== value.key).length;
    integer(this.nextIncarnation + fresh, 0, Number.MAX_SAFE_INTEGER, 'Region incarnation');
    integer(this.reusedEntries + normalized.length - fresh, 0, Number.MAX_SAFE_INTEGER, 'Region reuse count');
    const next = new Map<string, DesiredRegion>();
    for (const descriptor of normalized) {
      const previous = this.desired.get(descriptor.id);
      if (previous?.descriptor.key === descriptor.key) {
        previous.descriptor = descriptor; next.set(descriptor.id, previous); this.reusedEntries++;
      } else next.set(descriptor.id, { descriptor, incarnation: ++this.nextIncarnation, status: 'queued' });
    }
    const previous = this.desired; this.desired = next; this.desiredRevision = revision;
    for (const [id, record] of previous) if (next.get(id) !== record && record.entry) this.retire(record.entry);
    this.changes.notify();
  }

  private current(entry: LiveRegion): boolean {
    return !this.disposed && !entry.retiring && this.desired.get(entry.owner.descriptor.id) === entry.owner;
  }
  private clearTimer(entry: LiveRegion): void { clearTimeout(entry.timer); entry.timer = undefined; }
  private fail(entry: LiveRegion, cause: unknown): void {
    if (!this.current(entry)) return;
    entry.owner.status = 'failed'; entry.owner.error = receipt(cause);
    this.retire(entry); this.changes.notify();
  }
  private retire(entry: LiveRegion): void {
    if (entry.retiring) return;
    entry.retiring = true; this.clearTimer(entry); entry.controller.abort();
    const operations: Promise<unknown>[] = [];
    if (entry.manifestOperation) operations.push(entry.manifestOperation);
    if (entry.watchOperation) operations.push(entry.watchOperation);
    if (entry.provider) {
      entry.provider.dispose(); operations.push(entry.provider.whenDisposedAndSettled());
    }
    if (entry.handle) {
      entry.handle.dispose(); operations.push(entry.handle.whenDisposedAndSettled());
    }
    // Status, zero resource counters and disposed slot maps are not lifetime barriers.
    // No replacement may spend this slot or retained-content quota before these originals settle.
    void Promise.allSettled(operations).then(() => {
      entry.loaded = undefined; entry.handle = undefined; entry.provider = undefined;
      entry.manifestOperation = undefined; entry.watchOperation = undefined;
      entry.owner.entry = undefined; this.live.delete(entry);
      this.retainedBytes -= entry.owner.descriptor.manifestBytes; this.settledEntries++;
      this.changes.notify();
      if (this.disposed && this.live.size === 0) this.resolveSettlement();
    });
  }

  private admit(): void {
    const candidates = [...this.desired.values()].filter(record => record.status === 'queued');
    if (!candidates.length) return;
    const start = this.admissionTurn % candidates.length;
    this.admissionTurn = (start + 1) % candidates.length;
    for (let index = 0; index < candidates.length; index++) {
      const record = candidates[(start + index) % candidates.length]!;
      if (this.live.size >= this.limits.maxLiveRegions) break;
      const descriptor = record.descriptor;
      if (descriptor.manifestBytes > this.limits.maxRetainedManifestBytes - this.retainedBytes) continue;
      const lease = this.budget.tryRequest(descriptor.manifestBytes);
      if (!lease) continue;
      // Both charges precede fetching. Queued descriptors have no catalog or handle.
      const entry: LiveRegion = { owner: record, controller: new AbortController(), retiring: false };
      record.entry = entry; record.status = 'manifest'; this.live.add(entry);
      this.retainedBytes += descriptor.manifestBytes; this.startedEntries++;
      this.peakLiveEntries = Math.max(this.peakLiveEntries, this.live.size);
      this.peakRetainedBytes = Math.max(this.peakRetainedBytes, this.retainedBytes);
      // Defer the injected fetch until its original operation is recorded, even if the
      // fetch implementation synchronously causes a desired-set update or disposal.
      entry.manifestOperation = Promise.resolve().then(() => loadRegionManifest({
        manifestUrl: new URL(descriptor.manifestUrl), manifestBytes: descriptor.manifestBytes, manifestSha256: descriptor.manifestSha256,
      }, { fetch: this.fetch, signal: entry.controller.signal, requestLease: lease, maxManifestBytes: this.limits.maxManifestBytes }))
        .then(loaded => {
          if (!this.current(entry)) return;
          // loadRegionManifest's finally has already released request/staging before
          // authentication can be observed here or a later advance can start roots.
          entry.loaded = loaded; entry.sourceBounds = bounds(loaded.manifest.bounds);
          record.status = 'authenticated'; this.changes.notify();
        }).catch(cause => { this.fail(entry, cause); }).finally(() => this.clearTimer(entry));
      entry.timer = setTimeout(() => this.fail(entry, new StrataError('SCENE_LOAD_FAILED', 'Region manifest request timed out.')), this.timeoutMs);
      this.changes.notify();
    }
  }

  private async watch(entry: LiveRegion, handle: GeometryInitialization<GpuGeometry>): Promise<void> {
    while (this.current(entry) && handle.status === 'pending') {
      await handle.waitForChange(handle.revision);
      if (!this.current(entry)) return;
      if ((handle.status as GeometryInitializationStatus) === 'failed') this.fail(entry, handle.error);
      this.changes.notify();
    }
  }

  /** Rotates advance/upload turns only; existing cache request pumps remain unchanged. */
  advance(frame: GeometryUploadFrame): { readonly uploadBytes: number; readonly advancedIncarnations: readonly number[] } {
    if (frame.budget !== this.budget) throw invalid('Region initialization requires a frame from its own budget.');
    frame.assertCurrent();
    if (this.disposed) return Object.freeze({ uploadBytes: 0, advancedIncarnations: Object.freeze([]) });
    const before = frame.writtenBytes;
    this.admit();
    const entries = [...this.live].filter(entry => this.current(entry) && !entry.provider && (entry.loaded || entry.handle));
    const advanced: number[] = [];
    const start = entries.length ? this.advanceTurn % entries.length : 0;
    this.advanceTurn = entries.length ? (start + 1) % entries.length : 0;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[(start + index) % entries.length]!;
      if (!this.current(entry)) continue;
      advanced.push(entry.owner.incarnation);
      try {
        if (!entry.handle) {
          const loaded = entry.loaded!;
          entry.handle = GpuGeometry.begin(this.device, loaded.manifest, loaded.manifestUrl, {
            renderer: 'virtual', manifestUrl: loaded.manifestUrl, geometryMode: 'streamed', ...entry.owner.descriptor.options,
            fetch: this.fetch, signal: entry.controller.signal, requestTimeoutMs: this.timeoutMs,
            maxRetries: 0, maxConcurrentRequests: Math.min(32, this.budget.limits.maxRequests),
            maxCompletedBytes: this.budget.limits.pageStagingBytes, uploadBudgetBytes: this.budget.limits.uploadBytesPerFrame,
          }, this.budget);
          entry.loaded = undefined; entry.owner.status = 'initializing';
          entry.watchOperation = this.watch(entry, entry.handle).catch(cause => this.fail(entry, cause));
          this.changes.notify();
        }
        const handle = entry.handle;
        // An empty allowance still gets an admission turn, so individually impossible
        // parsed demands fail without waiting for an upload that can never fit.
        handle.advance(frame);
        if (!this.current(entry)) continue;
        if (handle.status === 'failed') this.fail(entry, handle.error);
        else if (handle.status === 'ready') {
          entry.provider = handle.takeReady(); entry.owner.status = 'ready'; this.changes.notify();
        }
      } catch (cause) { this.fail(entry, cause); }
    }
    const uploaded = frame.writtenBytes - before; this.uploadBytes += uploaded;
    return Object.freeze({ uploadBytes: uploaded, advancedIncarnations: Object.freeze(advanced) });
  }

  snapshot() {
    const view = (record: DesiredRegion, retiring = false): RegionSnapshot => {
      const { key: _key, ...descriptor } = record.descriptor;
      return Object.freeze({ ...descriptor, incarnation: record.incarnation, status: retiring ? 'retiring' : record.status,
        ...(record.entry?.sourceBounds ? { sourceBounds: record.entry.sourceBounds } : {}),
        ...(record.error === undefined ? {} : { error: record.error }) });
    };
    return Object.freeze({ revision: this.changes.revision, desiredRevision: this.desiredRevision, disposed: this.disposed,
      regions: Object.freeze([...this.desired.values()].map(record => view(record))),
      retiring: Object.freeze([...this.live].filter(entry => entry.retiring).map(entry => view(entry.owner, true))),
      liveEntries: this.live.size, retiringEntries: [...this.live].filter(entry => entry.retiring).length,
      retainedManifestBytes: this.retainedBytes, peakLiveEntries: this.peakLiveEntries, peakRetainedManifestBytes: this.peakRetainedBytes,
      uploadBytes: this.uploadBytes, startedEntries: this.startedEntries, reusedEntries: this.reusedEntries, settledEntries: this.settledEntries });
  }

  waitForChange(afterRevision: number): Promise<void> {
    integer(afterRevision, 0, Number.MAX_SAFE_INTEGER, 'Region change revision');
    return this.disposed ? Promise.resolve() : this.changes.wait(afterRevision);
  }
  whenDisposedAndSettled(): Promise<void> { return this.settlement; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.unsubscribe(); this.desired.clear();
    for (const entry of this.live) this.retire(entry);
    this.changes.notify();
    if (this.live.size === 0) this.resolveSettlement();
  }
}
