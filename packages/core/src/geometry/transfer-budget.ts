import { StrataError } from '../errors.js';

const pageBytes = 65_536;

function integer(value: number, minimum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new StrataError('INVALID_OPTIONS', `${name} must be a safe integer of at least ${minimum}.`);
  }
  return value;
}

/** State changes are immediate; subscribers are observational and run in a coalesced microtask. */
export class GeometryChangeSignal {
  private current = 0;
  private readonly listeners = new Set<() => void>();
  private readonly waiters = new Set<() => void>();
  private queued = false;

  get revision(): number { return this.current; }

  notify(): void {
    this.current++;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      for (const listener of [...this.listeners]) {
        if (!this.listeners.has(listener)) continue;
        // A failed observer must not strand another initializer or alter ownership.
        try { listener(); } catch { /* Subscribers do not participate in state transitions. */ }
      }
    });
  }

  subscribe(listener: () => void): () => void {
    if (typeof listener !== 'function') throw new StrataError('INVALID_OPTIONS', 'A geometry change listener must be a function.');
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  wait(afterRevision: number): Promise<void> {
    integer(afterRevision, 0, 'afterRevision');
    if (afterRevision !== this.current) return Promise.resolve();
    return new Promise(resolve => this.waiters.add(resolve));
  }
}

export interface GeometryTransferLimits {
  readonly maxRequests: number;
  readonly pageStagingBytes: number;
  readonly transientBytes: number;
  readonly residentBytes: number;
  readonly gpuBufferBytes: number;
  readonly uploadBytesPerFrame: number;
}

export interface GeometryResourceRequest {
  readonly transientBytes?: number;
  readonly residentBytes?: number;
  readonly gpuBufferBytes?: number;
}

export interface GeometryResourceLease {
  readonly budget: GeometryTransferBudget;
  readonly amounts: Readonly<Required<GeometryResourceRequest>>;
  readonly released: boolean;
  release(): void;
}
export interface GeometryRequestLease {
  /** Request settlement frees its slot; validated payload bytes remain reserved until release. */
  finishRequest(): void;
  release(): void;
}

/** A host-issued allowance with no renewal method. Budget identity is for trusted internal callers. */
export interface GeometryUploadFrame {
  readonly budget: GeometryTransferBudget;
  readonly remainingBytes: number;
  readonly writtenBytes: number;
  /** Validate before initialization side effects even when this advance performs no writes. */
  assertCurrent(): void;
  /** False means temporary frame pressure. Counts successful queue calls, not GPU completion. */
  write(device: GPUDevice, buffer: GPUBuffer, offset: number, bytes: Uint8Array<ArrayBuffer>): boolean;
}

export type GeometryInitializationStatus = 'pending' | 'ready' | 'failed' | 'taken' | 'disposed';
export interface GeometryInitialization<T> {
  readonly status: GeometryInitializationStatus;
  readonly error: unknown;
  readonly revision: number;
  advance(frame: GeometryUploadFrame): { readonly status: GeometryInitializationStatus; readonly uploadBytes: number };
  waitForChange(afterRevision: number): Promise<void>;
  /**
   * Wait for terminal ownership end and settlement of every retained async operation.
   * A taken handle has transferred ownership; await the provider separately when retiring it.
   * Does not dispose, advance initialization, or imply GPU execution completion.
   */
  whenDisposedAndSettled(): Promise<void>;
  takeReady(): T;
  dispose(): void;
}

type ResourceKey = 'transientBytes' | 'residentBytes' | 'gpuBufferBytes';
const resourceKeys: readonly ResourceKey[] = ['transientBytes', 'residentBytes', 'gpuBufferBytes'];

/** Logical owned payloads and requested GPUBuffer sizes; excludes total JS/driver/network memory. */
export class GeometryTransferBudget {
  readonly limits: Readonly<GeometryTransferLimits>;
  private readonly changes = new GeometryChangeSignal();
  private readonly used = { transientBytes: 0, residentBytes: 0, gpuBufferBytes: 0 };
  private readonly peaks = { transientBytes: 0, residentBytes: 0, gpuBufferBytes: 0 };
  private requests = 0;
  private peakRequests = 0;
  private staging = 0;
  private peakStaging = 0;
  private uploads = 0;
  private frameId: number | null = null;
  private frame: GeometryUploadFrame | undefined;

  constructor(limits: GeometryTransferLimits) {
    if (!limits || typeof limits !== 'object') throw new StrataError('INVALID_OPTIONS', 'Geometry transfer limits are required.');
    this.limits = Object.freeze({
      maxRequests: integer(limits.maxRequests, 1, 'maxRequests'),
      pageStagingBytes: integer(limits.pageStagingBytes, pageBytes, 'pageStagingBytes'),
      transientBytes: integer(limits.transientBytes, 0, 'transientBytes'),
      residentBytes: integer(limits.residentBytes, 0, 'residentBytes'),
      gpuBufferBytes: integer(limits.gpuBufferBytes, 0, 'gpuBufferBytes'),
      uploadBytesPerFrame: integer(limits.uploadBytesPerFrame, pageBytes, 'uploadBytesPerFrame'),
    });
    if (this.limits.uploadBytesPerFrame % 4) throw new StrataError('INVALID_OPTIONS', 'uploadBytesPerFrame must be aligned to four bytes.');
  }

  get revision(): number { return this.changes.revision; }
  subscribe(listener: () => void): () => void { return this.changes.subscribe(listener); }
  waitForChange(afterRevision: number): Promise<void> { return this.changes.wait(afterRevision); }

  get telemetry() {
    return Object.freeze({
      requests: this.requests, peakRequests: this.peakRequests,
      pageStagingBytes: this.staging, peakPageStagingBytes: this.peakStaging,
      ...this.used,
      peakTransientBytes: this.peaks.transientBytes,
      peakResidentBytes: this.peaks.residentBytes,
      peakGpuBufferBytes: this.peaks.gpuBufferBytes,
      uploadBytes: this.uploads, frameId: this.frameId,
      frameWrittenBytes: this.frame?.writtenBytes ?? 0,
      frameRemainingBytes: this.frame?.remainingBytes ?? 0,
    });
  }

  beginFrame(id: number): GeometryUploadFrame {
    integer(id, 0, 'frame ID');
    if (this.frameId !== null && id <= this.frameId) throw new StrataError('INVALID_OPTIONS', 'Geometry frame IDs must strictly increase.');
    let remaining = this.limits.uploadBytesPerFrame;
    let written = 0;
    const assertCurrent = () => {
      if (this.frame !== frame) throw new StrataError('INVALID_OPTIONS', 'This geometry upload frame has expired.');
    };
    const frame: GeometryUploadFrame = Object.freeze({
      budget: this,
      get remainingBytes() { return remaining; },
      get writtenBytes() { return written; },
      assertCurrent,
      write: (device: GPUDevice, buffer: GPUBuffer, offset: number, bytes: Uint8Array<ArrayBuffer>): boolean => {
        assertCurrent();
        integer(offset, 0, 'buffer offset');
        if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || offset % 4 || bytes.byteLength % 4
          || !Number.isSafeInteger(offset + bytes.byteLength)) {
          throw new StrataError('INVALID_OPTIONS', 'Geometry uploads require an ArrayBuffer-backed byte view and four-byte aligned offset and length.');
        }
        if (bytes.byteLength > remaining) return false;
        if (!Number.isSafeInteger(this.uploads + bytes.byteLength)) throw new StrataError('INVALID_OPTIONS', 'Geometry upload accounting exceeded safe integers.');
        remaining -= bytes.byteLength;
        try { device.queue.writeBuffer(buffer, offset, bytes); }
        catch (cause) { remaining += bytes.byteLength; throw cause; }
        written += bytes.byteLength;
        this.uploads += bytes.byteLength;
        return true;
      },
    });
    this.frameId = id; this.frame = frame;
    this.changes.notify();
    return frame;
  }

  /** Reservations are atomic across all resource classes. No allocation occurs here. */
  tryReserve(request: GeometryResourceRequest): GeometryResourceLease | undefined {
    return this.tryReserveMany([request])?.[0];
  }

  /** Independent ownership leases share one all-or-nothing admission decision. */
  tryReserveMany(requests: readonly GeometryResourceRequest[]): readonly GeometryResourceLease[] | undefined {
    if (!Array.isArray(requests)) throw new StrataError('INVALID_OPTIONS', 'Geometry resource requests must be an array.');
    const totals = { transientBytes: 0, residentBytes: 0, gpuBufferBytes: 0 };
    const amounts = requests.map(request => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new StrataError('INVALID_OPTIONS', 'A geometry resource request is required.');
      const values = { transientBytes: 0, residentBytes: 0, gpuBufferBytes: 0 };
      for (const key of resourceKeys) {
        values[key] = integer(request[key] === undefined ? 0 : request[key], 0, key);
        if (values[key] > this.limits[key] - totals[key]) throw new StrataError('INVALID_OPTIONS', `${key} cannot fit the configured geometry limit.`);
        totals[key] += values[key];
      }
      return Object.freeze(values);
    });
    if (resourceKeys.some(key => totals[key] > this.limits[key] - this.used[key])) return undefined;
    for (const key of resourceKeys) {
      this.used[key] += totals[key];
      this.peaks[key] = Math.max(this.peaks[key], this.used[key]);
    }
    return Object.freeze(amounts.map(values => {
      let released = false;
      return Object.freeze({ budget: this, amounts: values, get released() { return released; }, release: () => {
        if (released) return;
        released = true;
        for (const key of resourceKeys) this.used[key] -= values[key];
        if (resourceKeys.some(key => values[key] !== 0)) this.changes.notify();
      } });
    }));
  }

  /** Callers retain canceled leases until the outstanding asynchronous work settles. */
  tryRequest(bytes: number): GeometryRequestLease | undefined {
    integer(bytes, 1, 'request staging bytes');
    if (bytes > this.limits.pageStagingBytes) throw new StrataError('INVALID_OPTIONS', 'The request cannot fit the geometry page staging limit.');
    if (this.requests >= this.limits.maxRequests || bytes > this.limits.pageStagingBytes - this.staging) return undefined;
    this.requests++; this.staging += bytes;
    this.peakRequests = Math.max(this.peakRequests, this.requests);
    this.peakStaging = Math.max(this.peakStaging, this.staging);
    let requestFinished = false;
    let released = false;
    return Object.freeze({
      finishRequest: () => {
        if (requestFinished || released) return;
        requestFinished = true; this.requests--;
        this.changes.notify();
      },
      release: () => {
        if (released) return;
        released = true;
        if (!requestFinished) this.requests--;
        this.staging -= bytes;
        this.changes.notify();
      },
    });
  }
}
