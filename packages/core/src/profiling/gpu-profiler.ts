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
  busy: boolean;
  frameId: number;
  pass: string;
  pending: Promise<void> | null;
}

/** One bounded readback ring. Mapping never blocks normal frame submission. */
export class GpuProfiler {
  private readonly slots: Slot[] = [];
  private readonly results: GpuTiming[] = [];
  private disposed = false;
  private dropped = 0;
  readonly allocatedBufferBytes: number;

  constructor(device: GPUDevice, readonly capacity = 4, private readonly resultCapacity = 256) {
    if (!Number.isInteger(capacity) || capacity < 1 || !Number.isInteger(resultCapacity) || resultCapacity < 1) {
      throw new RangeError('GPU profiling capacities must be positive integers.');
    }
    this.allocatedBufferBytes = capacity * 32;
    try {
      for (let index = 0; index < capacity; index++) {
        let querySet: GPUQuerySet | undefined;
        let resolveBuffer: GPUBuffer | undefined;
        let readBuffer: GPUBuffer | undefined;
        try {
          querySet = device.createQuerySet({ label: `Strata timestamps ${index}`, type: 'timestamp', count: 2 });
          resolveBuffer = device.createBuffer({
            label: `Strata timestamp resolve ${index}`, size: 16,
            usage: bufferUsage.QUERY_RESOLVE | bufferUsage.COPY_SRC,
          });
          readBuffer = device.createBuffer({
            label: `Strata timestamp readback ${index}`, size: 16,
            usage: bufferUsage.COPY_DST | bufferUsage.MAP_READ,
          });
          this.slots.push({
            querySet, resolveBuffer, readBuffer,
            timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
            busy: false, frameId: 0, pass: '', pending: null,
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
  get pendingSamples(): number { return this.slots.filter((slot) => slot.busy).length; }

  begin(frameId: number, pass: string): Slot | null {
    if (this.disposed) return null;
    const slot = this.slots.find((candidate) => !candidate.busy);
    if (!slot) {
      this.dropped++;
      return null;
    }
    slot.busy = true;
    slot.frameId = frameId;
    slot.pass = pass;
    return slot;
  }

  resolve(encoder: GPUCommandEncoder, slot: Slot): void {
    encoder.resolveQuerySet(slot.querySet, 0, 2, slot.resolveBuffer, 0);
    encoder.copyBufferToBuffer(slot.resolveBuffer, 0, slot.readBuffer, 0, 16);
  }

  /** Call only after submitting the command buffer that resolves this slot. */
  submitted(slot: Slot): void {
    const complete = async (): Promise<void> => {
      try {
        await slot.readBuffer.mapAsync(mapRead, 0, 16);
        if (this.disposed) return;
        const values = new BigUint64Array(slot.readBuffer.getMappedRange(0, 16));
        const start = values[0]!;
        const end = values[1]!;
        if (end < start) {
          this.dropped++;
          return;
        }
        // WebGPU timestamps are nanoseconds. Zero is valid after browser quantization.
        const gpuMs = Number(end - start) / 1_000_000;
        if (this.results.length >= this.resultCapacity) {
          this.results.shift();
          this.dropped++;
        }
        this.results.push({ frameId: slot.frameId, pass: slot.pass, gpuMs });
      } catch {
        if (!this.disposed) this.dropped++;
      } finally {
        try { slot.readBuffer.unmap(); } catch { /* The device may already be destroyed. */ }
        slot.busy = false;
        slot.pending = null;
      }
    };
    slot.pending = complete();
  }

  cancel(slot: Slot): void {
    if (slot.busy && !slot.pending) {
      slot.busy = false;
      this.dropped++;
    }
  }

  drain(): GpuTiming[] { return this.results.splice(0); }

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
      if (slot.busy) this.dropped++;
      slot.busy = false;
      try { slot.readBuffer.destroy(); } catch { /* Continue releasing other slots. */ }
      try { slot.resolveBuffer.destroy(); } catch { /* Continue releasing other slots. */ }
      try { slot.querySet.destroy(); } catch { /* Continue releasing other slots. */ }
    }
  }
}
