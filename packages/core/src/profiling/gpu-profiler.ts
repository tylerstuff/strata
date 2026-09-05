import type { GpuTiming } from '../types.js';
import { StrataError } from '../errors.js';

// WebGPU's stable flag values avoid touching browser globals during SSR import.
const bufferUsage = { MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, QUERY_RESOLVE: 0x0200 };
const mapRead = 0x0001;

interface Slot {
  readonly querySet: GPUQuerySet;
  readonly resolveBuffer: GPUBuffer;
  readonly readBuffer: GPUBuffer;
  readonly timestampWrites: GPURenderPassTimestampWrites;
  readonly passWrites: readonly GPURenderPassTimestampWrites[];
  readonly timestamps: Record<string, GPURenderPassTimestampWrites>;
  readonly passNames: string[];
  busy: boolean;
  frameId: number;
  passCount: number;
  pending: Promise<void> | null;
}

/** One bounded readback ring. Mapping never blocks normal frame submission. */
export class GpuProfiler {
  private readonly slots: Slot[] = [];
  private readonly results: GpuTiming[][] = [];
  private resultCount = 0;
  private disposed = false;
  private dropped = 0;
  readonly allocatedBufferBytes: number;

  constructor(
    device: GPUDevice, readonly capacity = 4, private readonly resultCapacity = 256,
    private readonly maxPasses = 8,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1 || !Number.isInteger(resultCapacity) || resultCapacity < 1
      || !Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > 32) {
      throw new RangeError('GPU profiling capacities must be positive integers.');
    }
    this.allocatedBufferBytes = capacity * maxPasses * 32;
    try {
      for (let index = 0; index < capacity; index++) {
        let querySet: GPUQuerySet | undefined;
        let resolveBuffer: GPUBuffer | undefined;
        let readBuffer: GPUBuffer | undefined;
        try {
          querySet = device.createQuerySet({ label: `Strata timestamps ${index}`, type: 'timestamp', count: maxPasses * 2 });
          resolveBuffer = device.createBuffer({
            label: `Strata timestamp resolve ${index}`, size: maxPasses * 16,
            usage: bufferUsage.QUERY_RESOLVE | bufferUsage.COPY_SRC,
          });
          readBuffer = device.createBuffer({
            label: `Strata timestamp readback ${index}`, size: maxPasses * 16,
            usage: bufferUsage.COPY_DST | bufferUsage.MAP_READ,
          });
          const passWrites = Array.from({ length: maxPasses }, (_, passIndex) => ({
            querySet: querySet!, beginningOfPassWriteIndex: passIndex * 2, endOfPassWriteIndex: passIndex * 2 + 1,
          }));
          this.slots.push({
            querySet, resolveBuffer, readBuffer,
            timestampWrites: passWrites[0]!, passWrites,
            timestamps: Object.create(null) as Record<string, GPURenderPassTimestampWrites>,
            passNames: [], busy: false, frameId: 0, passCount: 0, pending: null,
          });
        } catch (error) {
          readBuffer?.destroy();
          resolveBuffer?.destroy();
          querySet?.destroy();
          throw error;
        }
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  get droppedSamples(): number { return this.dropped; }
  get pendingSamples(): number {
    return this.slots.reduce((count, slot) => count + (slot.busy ? slot.passCount : 0), 0);
  }

  begin(frameId: number, passes: string | readonly string[]): Slot | null {
    if (this.disposed) return null;
    const names = typeof passes === 'string' ? [passes] : passes;
    if (!names.length || names.length > this.maxPasses
      || names.some((name, index) => !name.length || names.indexOf(name) !== index)) {
      throw new StrataError('INVALID_OPTIONS', `GPU profiling needs 1–${this.maxPasses} unique pass names.`);
    }
    const slot = this.slots.find((candidate) => !candidate.busy);
    if (!slot) {
      this.dropped += names.length;
      return null;
    }
    for (const name of slot.passNames) delete slot.timestamps[name];
    slot.passNames.length = 0;
    names.forEach((name, index) => {
      slot.passNames.push(name);
      slot.timestamps[name] = slot.passWrites[index]!;
    });
    slot.busy = true;
    slot.frameId = frameId;
    slot.passCount = names.length;
    return slot;
  }

  resolve(encoder: GPUCommandEncoder, slot: Slot): void {
    encoder.resolveQuerySet(slot.querySet, 0, slot.passCount * 2, slot.resolveBuffer, 0);
    encoder.copyBufferToBuffer(slot.resolveBuffer, 0, slot.readBuffer, 0, slot.passCount * 16);
  }

  /** Call only after submitting the command buffer that resolves this slot. */
  submitted(slot: Slot): void {
    const complete = async (): Promise<void> => {
      try {
        await slot.readBuffer.mapAsync(mapRead, 0, slot.passCount * 16);
        if (this.disposed) return;
        const values = new BigUint64Array(slot.readBuffer.getMappedRange(0, slot.passCount * 16));
        const frame: GpuTiming[] = [];
        for (let index = 0; index < slot.passCount; index++) {
          const start = values[index * 2]!;
          const end = values[index * 2 + 1]!;
          if (start === undefined || end === undefined || end < start) {
            this.dropped += slot.passCount;
            return;
          }
          // WebGPU timestamps are nanoseconds. Quantized zero remains a valid measurement.
          frame.push({ frameId: slot.frameId, pass: slot.passNames[index]!, gpuMs: Number(end - start) / 1_000_000 });
        }
        // Keep frame groups atomic so queue pressure cannot yield misleading partial sums.
        if (frame.length > this.resultCapacity) {
          this.dropped += frame.length;
          return;
        }
        while (this.resultCount + frame.length > this.resultCapacity) {
          const removed = this.results.shift()!;
          this.resultCount -= removed.length;
          this.dropped += removed.length;
        }
        this.results.push(frame);
        this.resultCount += frame.length;
      } catch {
        if (!this.disposed) this.dropped += slot.passCount;
      } finally {
        try { slot.readBuffer.unmap(); } catch { /* The device may already be destroyed. */ }
        slot.busy = false;
        slot.pending = null;
      }
    };
    const pending = complete();
    // A synchronous mapAsync exception can complete cleanup before assignment.
    if (slot.busy) slot.pending = pending;
  }

  cancel(slot: Slot): void {
    if (slot.busy && !slot.pending) {
      slot.busy = false;
      this.dropped += slot.passCount;
    }
  }

  drain(): GpuTiming[] {
    this.resultCount = 0;
    return this.results.splice(0).flat();
  }

  /** End-of-capture synchronization; intentionally absent from the render path. */
  async flush(timeoutMs = 5000): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new StrataError('INVALID_OPTIONS', 'GPU readback timeout must be positive and at most 2147483647 ms.');
    }
    if (this.disposed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StrataError(
        'GPU_TIMING_TIMEOUT', `GPU timestamp readback exceeded ${timeoutMs} ms.`,
      )), timeoutMs);
    });
    try {
      await Promise.race([Promise.all(this.slots.map((slot) => slot.pending)), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) {
      if (slot.busy) this.dropped += slot.passCount;
      slot.busy = false;
      try { slot.readBuffer.destroy(); } catch { /* Continue releasing other slots. */ }
      try { slot.resolveBuffer.destroy(); } catch { /* Continue releasing other slots. */ }
      try { slot.querySet.destroy(); } catch { /* Continue releasing other slots. */ }
    }
  }
}
