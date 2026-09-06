/** Diagnostic GPU forwarding/readback helpers. Never used by runtime or timed benchmarks. */
export type ProofBytes = ArrayBufferLike | ArrayBufferView<ArrayBufferLike>;
export function proofByteView(value: ProofBytes): Uint8Array<ArrayBufferLike> {
  return ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
}

export function assertBytesEqual(actual: ProofBytes, expected: ProofBytes, label: string): void {
  const a = proofByteView(actual), b = proofByteView(expected);
  let first = -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) { first = i; break; }
  if (first === -1 && a.length === b.length) return;
  if (first === -1) first = Math.min(a.length, b.length);
  const detail = { label, firstByte: first, actualByte: a[first] ?? null, expectedByte: b[first] ?? null,
    actualBytes: a.length, expectedBytes: b.length };
  throw Object.assign(new Error(`GPU proof byte mismatch: ${JSON.stringify(detail)}`), { proofDifference: detail });
}

export async function proofSha256(bytes: ProofBytes): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', proofByteView(bytes).slice().buffer);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}

export async function proofDeadline<T>(operation: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`GPU proof deadline exceeded: ${label} (${milliseconds}ms)`)), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** A returned failure must stop the sequence just like a thrown failure. */
export function assertCompletedProofStage(result: { status?: unknown; failures?: readonly unknown[] }, label: string): void {
  if (result.status !== 'passed' || (result.failures?.length ?? 0) !== 0) {
    throw Object.assign(new Error(`${label} failed; subsequent stages were not executed.`), { proofEvidence: result });
  }
}

/** Preserve scoped errors even when an earlier assertion already failed. */
export async function finishProofDevice(device: GPUDevice, scopes: number, beforeDestroy: () => void, milliseconds = 10_000) {
  const errors: string[] = [], pending: Promise<void>[] = [];
  try {
    for (let i = 0; i < scopes; i++) {
      try {
        pending.push(proofDeadline(device.popErrorScope(), `GPU error scope ${i}`, milliseconds)
          .then(error => { if (error) errors.push(`${error.constructor.name}: ${error.message}`); })
          .catch(error => { errors.push(`GPU error scope ${i}: ${String(error)}`); }));
      } catch (error) { errors.push(`GPU error scope ${i}: ${String(error)}`); }
    }
    await Promise.all(pending);
  } finally { beforeDestroy(); device.destroy(); }
  return { errors, destroyed: true, scopesAttempted: scopes };
}

/** Reads the actual queued GPU bytes into a new owned ArrayBuffer. */
export async function readBuffer(device: GPUDevice, source: GPUBuffer, size = source.size): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(size) || size < 4 || size % 4 || size > source.size) throw new Error('Invalid proof buffer read size.');
  const readback = device.createBuffer({ label: 'Strata incremental proof readback', size, usage: 1 | 8 });
  try {
    const encoder = device.createCommandEncoder({ label: 'Strata incremental proof buffer copy' });
    encoder.copyBufferToBuffer(source, 0, readback, 0, size);
    device.queue.submit([encoder.finish()]);
    await proofDeadline(readback.mapAsync(1), 'buffer mapping');
    const result = readback.getMappedRange().slice(0); readback.unmap(); return result;
  } finally { readback.destroy(); }
}

export interface RecordedTraceWrite {
  readonly label: string;
  readonly offset: number;
  readonly byteLength: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly phase: string;
  returned: boolean;
}
export interface RecordedProofDevice {
  readonly device: GPUDevice;
  readonly traceBuffers: Map<string, GPUBuffer>;
  readonly writes: RecordedTraceWrite[];
  setPhase(phase: string): void;
  /** One-based trace-write ordinal from this call; a one-shot throw BEFORE native forwarding. */
  failTraceWrite(ordinal?: number): void;
}

/** Normalize native writeBuffer's element-based view offsets into copied byte evidence. */
export function proofWriteInput(data: Parameters<GPUQueue['writeBuffer']>[2], dataOffset = 0, size?: number): Uint8Array<ArrayBuffer> {
  const view = proofByteView(data);
  const unit = ArrayBuffer.isView(data) && 'BYTES_PER_ELEMENT' in data ? Number(data.BYTES_PER_ELEMENT) : 1;
  const start = dataOffset * unit, length = size === undefined ? view.byteLength - start : size * unit;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > view.length) {
    throw new Error('Invalid trace proof writeBuffer source range.');
  }
  return view.slice(start, start + length);
}

/** All operations use native receivers; no shadow GPU storage or descriptor rewrite. */
export function createRecordedDevice(device: GPUDevice): RecordedProofDevice {
  const traceBuffers = new Map<string, GPUBuffer>(), labels = new Map<GPUBuffer, string>();
  const writes: RecordedTraceWrite[] = [];
  let phase = 'initialization', remaining: number | undefined;
  const methods = new Map<PropertyKey, unknown>(), queueMethods = new Map<PropertyKey, unknown>();
  const queue = new Proxy(device.queue, {
    get(target, property) {
      if (property === 'writeBuffer') {
        if (!queueMethods.has(property)) queueMethods.set(property, (...args: Parameters<GPUQueue['writeBuffer']>) => {
          const label = labels.get(args[0]);
          if (label === undefined) return target.writeBuffer(...args);
          const bytes = proofWriteInput(args[2], args[3], args[4]);
          const entry: RecordedTraceWrite = { label, offset: args[1], byteLength: bytes.byteLength, bytes, phase, returned: false };
          writes.push(entry);
          if (remaining !== undefined && --remaining === 0) {
            remaining = undefined;
            throw new Error(`Injected trace write failure before forwarding ${phase}/${label}.`);
          }
          target.writeBuffer(...args); entry.returned = true;
        });
        return queueMethods.get(property);
      }
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (!queueMethods.has(property)) queueMethods.set(property, value.bind(target));
      return queueMethods.get(property);
    },
  });
  const forwarded = new Proxy(device, {
    get(target, property) {
      if (property === 'queue') return queue;
      if (property === 'createBuffer') {
        if (!methods.has(property)) methods.set(property, (descriptor: GPUBufferDescriptor) => {
          const buffer = target.createBuffer(descriptor), label = descriptor.label ?? '';
          if (/^Strata (GI|reflection) trace data [0-4]$/.test(label)) {
            if (traceBuffers.has(label)) { buffer.destroy(); throw new Error(`Duplicate owned proof trace buffer ${label}.`); }
            traceBuffers.set(label, buffer); labels.set(buffer, label);
          }
          return buffer;
        });
        return methods.get(property);
      }
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (!methods.has(property)) methods.set(property, value.bind(target));
      return methods.get(property);
    },
  });
  return { device: forwarded, traceBuffers, writes,
    setPhase(value) { phase = value; },
    failTraceWrite(ordinal) {
      if (ordinal !== undefined && (!Number.isSafeInteger(ordinal) || ordinal < 1)) throw new Error('Proof failure ordinal must be positive.');
      remaining = ordinal;
    },
  };
}
