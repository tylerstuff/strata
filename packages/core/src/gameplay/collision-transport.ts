/** Lossless transport only. Decoded physics data and native world memory are unchanged. */
export interface CollisionTransport {
  readonly encoding: 'gzip';
  readonly bytes: number;
  readonly sha256: string;
  readonly decodedBytes: number;
  readonly decodedSha256: string;
}
const limit = 256 * 1024 * 1024;
const digest = async (bytes: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
/** Decode a bounded, integrity-checked cooked snapshot before createCapsuleController. */
export async function decodeCollisionSnapshot(encoded: Uint8Array<ArrayBuffer>, transport: CollisionTransport, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  if (!transport || transport.encoding !== 'gzip' || ![transport.bytes, transport.decodedBytes].every(n => Number.isSafeInteger(n) && n > 0 && n <= limit)
    || ![transport.sha256, transport.decodedSha256].every(s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s))) throw new RangeError('Invalid collision transport metadata.');
  if (!(encoded instanceof Uint8Array) || !(encoded.buffer instanceof ArrayBuffer) || encoded.byteLength !== transport.bytes) throw new RangeError('Collision transport length mismatch.');
  const metadata = { ...transport }, source = encoded.slice();
  if (typeof DecompressionStream !== 'function') throw new Error('Gzip collision transport requires DecompressionStream.');
  if (await digest(source) !== metadata.sha256) throw new Error('Collision transport checksum mismatch.');
  signal?.throwIfAborted();
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.enqueue(source); controller.close(); } });
  const reader = stream.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > metadata.decodedBytes) throw new RangeError('Collision decode budget exceeded.');
      chunks.push(value);
    }
    if (total !== metadata.decodedBytes) throw new RangeError('Collision decoded length mismatch.');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const result = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  if (await digest(result) !== metadata.decodedSha256) throw new Error('Decoded collision checksum mismatch.');
  signal?.throwIfAborted();
  return result;
}
