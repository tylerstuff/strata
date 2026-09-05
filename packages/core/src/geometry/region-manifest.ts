import { StrataError } from '../errors.js';
import { parseGeometryManifest } from './format.js';
import type { GeometryManifest } from './format.js';
import type { GeometryRequestLease } from './transfer-budget.js';

export interface RegionManifestDescriptor {
  readonly manifestUrl: URL;
  readonly manifestBytes: number;
  readonly manifestSha256: string;
}

export interface RegionManifestLoadOptions {
  readonly fetch?: typeof fetch;
  readonly signal: AbortSignal;
  readonly maxManifestBytes: number;
  /** Transferred once, after the caller reserves exactly descriptor.manifestBytes. */
  readonly requestLease: GeometryRequestLease;
}

export interface LoadedRegionManifest extends RegionManifestDescriptor {
  readonly manifest: GeometryManifest;
}

const transferredLeases = new WeakSet<GeometryRequestLease>();
const invalid = (message: string): StrataError => new StrataError('INVALID_OPTIONS', message);
const failed = (message: string): StrataError => new StrataError('SCENE_LOAD_FAILED', message);

/** Authenticated encoded bytes only: the cap does not measure parsed JS heap or browser
 * networking memory. The trusted internal caller admits both retained metadata and this
 * exact-size request before calling; the opaque request lease exposes no size to inspect.
 * There is no abort race: original fetch/read/hash and stream cancellation settle before
 * the transferred lease is released, and before the returned manifest can initialize GPU work. */
export async function loadRegionManifest(descriptor: RegionManifestDescriptor,
  options: RegionManifestLoadOptions): Promise<LoadedRegionManifest> {
  const lease = options?.requestLease;
  if (!lease || typeof lease.finishRequest !== 'function' || typeof lease.release !== 'function') {
    throw invalid('Region manifest loading requires an admitted request lease.');
  }
  if (transferredLeases.has(lease)) throw invalid('The region manifest request lease was already transferred.');
  transferredLeases.add(lease);
  let body: ReadableStream<Uint8Array<ArrayBuffer>> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
  let bodyEnded = false;
  let cancellation: Promise<void> | undefined;
  let detach: (() => void) | undefined;
  const cancel = (reason: unknown): void => {
    if (!body || bodyEnded || cancellation) return;
    // Observe rejection immediately, but retain ownership until the cancellation settles.
    try { cancellation = (reader ? reader.cancel(reason) : body.cancel(reason)).then(() => undefined, () => undefined); }
    catch { cancellation = Promise.resolve(); }
  };
  try {
    if (!descriptor || !(descriptor.manifestUrl instanceof URL)
      || !['http:', 'https:'].includes(descriptor.manifestUrl.protocol)
      || !Number.isSafeInteger(options.maxManifestBytes) || options.maxManifestBytes < 1
      || !Number.isSafeInteger(descriptor.manifestBytes) || descriptor.manifestBytes < 1
      || descriptor.manifestBytes > options.maxManifestBytes
      || typeof descriptor.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.manifestSha256)) {
      throw invalid('Region manifest identity must contain an HTTP(S) URL, bounded exact byte length and SHA-256.');
    }
    const manifestUrl = new URL(descriptor.manifestUrl.href);
    const manifestBytes = descriptor.manifestBytes;
    const manifestSha256 = descriptor.manifestSha256;
    const signal = options.signal;
    const fetchManifest = options.fetch ?? globalThis.fetch.bind(globalThis);
    if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function'
      || typeof fetchManifest !== 'function') throw invalid('Region manifest loading requires a fetch function and abort signal.');
    const checkAbort = (): void => {
      if (signal.aborted) throw new StrataError('INITIALIZATION_ABORTED', 'Region manifest loading was aborted.', { cause: signal.reason });
    };
    checkAbort();
    const response = await fetchManifest(manifestUrl, { signal });
    body = response.body;
    checkAbort();
    if (!response.ok) throw failed(`Region manifest request failed with HTTP ${response.status}.`);
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== manifestBytes)) {
      throw failed('Region manifest Content-Length does not match its admitted exact byte length.');
    }
    if (!body) throw failed('Region manifest response body was truncated.');
    reader = body.getReader();
    const onAbort = (): void => cancel(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    detach = () => signal.removeEventListener('abort', onAbort);
    checkAbort();
    const bytes = new Uint8Array(manifestBytes);
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      checkAbort();
      if (done) { bodyEnded = true; break; }
      if (value.byteLength > manifestBytes - received) throw failed('Region manifest response exceeded its admitted exact byte length.');
      bytes.set(value, received); received += value.byteLength;
    }
    if (received !== manifestBytes) throw failed('Region manifest response body was truncated.');
    checkAbort();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    checkAbort();
    const actualSha256 = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
    if (actualSha256 !== manifestSha256) throw failed('Region manifest SHA-256 does not match its pinned identity.');
    checkAbort();
    const manifest = parseGeometryManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    checkAbort();
    return Object.freeze({ manifest, manifestUrl, manifestBytes, manifestSha256 });
  } finally {
    try { detach?.(); }
    finally {
      cancel(undefined);
      try { await cancellation; }
      finally {
        try { reader?.releaseLock(); }
        finally { lease.release(); }
      }
    }
  }
}
