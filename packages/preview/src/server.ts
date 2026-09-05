import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PreviewError } from './errors.js';

export const MAX_PREVIEW_RUNTIME_ASSET_BYTES = 64 * 1024 * 1024;
export const MAX_PREVIEW_RUNTIME_TOTAL_BYTES = 128 * 1024 * 1024;
export const MAX_PREVIEW_RUNTIME_ENTRIES = 4096;
export const MAX_PREVIEW_RUNTIME_DEPTH = 16;
export const MAX_PREVIEW_CLIENT_BYTES = 2 * 1024 * 1024;

export interface PreviewServerOptions {
  runtimeDirectory: string;
  clientSource: string;
  /** Initialization only. Abort after successful startup does not dispose the server. */
  signal?: AbortSignal;
}

export interface PreviewServer {
  /** Token-scoped document URL; client.js and runtime/ are relative to this URL. */
  readonly url: string;
  dispose(): Promise<void>;
}

interface Asset { bytes: Buffer; contentType: string }

const HTML = Buffer.from('<!doctype html>\n<html><head><meta charset="utf-8"><title>Strata preview</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block}</style><script type="importmap">{"imports":{"@strata-engine/core":"./runtime/index.js"}}</script></head><body><canvas id="preview"></canvas><script type="module" src="./client.js"></script></body></html>\n');

function aborted(signal: AbortSignal | undefined, stage: string): void {
  if (signal?.aborted) throw new PreviewError('PREVIEW_ABORTED', stage, 'Preview server initialization was canceled.');
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function unsafe(path: string): never {
  throw new PreviewError('PREVIEW_SERVER_UNSAFE_PATH', 'preload-runtime',
    'Runtime assets must stay within the selected directory and cannot use symlinks or nonregular files.', { path });
}

function limit(message: string, path: string): never {
  throw new PreviewError('PREVIEW_SERVER_LIMIT', 'preload-runtime', message, { path });
}

function normalize(error: unknown, code: string, stage: string): PreviewError {
  return error instanceof PreviewError ? error : new PreviewError(code, stage,
    error instanceof Error ? error.message : 'Preview server operation failed.');
}

async function readAsset(path: string, maxBytes: number, signal: AbortSignal | undefined): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    aborted(signal, 'preload-runtime');
    const info = await handle.stat();
    if (!info.isFile()) unsafe(path);
    if (info.size > maxBytes) limit('Runtime asset exceeds the per-file or remaining total byte limit.', path);
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      aborted(signal, 'preload-runtime');
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - bytes + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      aborted(signal, 'preload-runtime');
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maxBytes) limit('Runtime asset grew past the per-file or remaining total byte limit.', path);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, bytes);
  } finally { await handle.close(); }
}

/**
 * Serve one preloaded runtime snapshot on 127.0.0.1 and an ephemeral port.
 * Only .js and .wasm assets are exposed under <url>/runtime/, preserving subfolders.
 * The caller's signal governs preload/listen initialization only; it is checked
 * between bounded reads and after listen. Once this promise succeeds, dispose()
 * owns server lifetime. Requests never read the filesystem or reveal directory listings.
 */
export async function startPreviewServer(options: PreviewServerOptions): Promise<PreviewServer> {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['runtimeDirectory', 'clientSource', 'signal'].includes(key))
    || typeof options.runtimeDirectory !== 'string' || options.runtimeDirectory.length === 0
    || typeof options.clientSource !== 'string'
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    throw new PreviewError('PREVIEW_INVALID_OPTIONS', 'server-options', 'Provide runtimeDirectory, clientSource, and an optional AbortSignal.');
  }
  const { runtimeDirectory, clientSource, signal } = options;
  if (Buffer.byteLength(clientSource, 'utf8') > MAX_PREVIEW_CLIENT_BYTES) {
    throw new PreviewError('PREVIEW_SERVER_LIMIT', 'server-options', `clientSource exceeds ${MAX_PREVIEW_CLIENT_BYTES} UTF-8 bytes.`);
  }
  aborted(signal, 'preload-runtime');
  const assets = new Map<string, Asset>([
    ['', { bytes: HTML, contentType: 'text/html; charset=utf-8' }],
    ['client.js', { bytes: Buffer.from(clientSource), contentType: 'text/javascript; charset=utf-8' }],
  ]);
  let entries = 0;
  let totalBytes = 0;
  try {
    const lexicalRoot = resolve(runtimeDirectory);
    const rootInfo = await lstat(lexicalRoot);
    aborted(signal, 'preload-runtime');
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) unsafe(lexicalRoot);
    const root = await realpath(lexicalRoot);

    async function walk(path: string, segments: string[]): Promise<void> {
      aborted(signal, 'preload-runtime');
      if (segments.length > MAX_PREVIEW_RUNTIME_DEPTH) limit('Runtime directory nesting exceeds the supported depth.', path);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory() || !within(root, await realpath(path))) unsafe(path);
      const directory = await opendir(path);
      // The async iterator closes its directory handle on success, failure, or cancellation.
      for await (const entry of directory) {
        aborted(signal, 'preload-runtime');
        const child = join(path, entry.name);
        if (++entries > MAX_PREVIEW_RUNTIME_ENTRIES) limit('Runtime directory contains too many entries.', root);
        if (entry.isSymbolicLink() || /[\\\u0000-\u001f\u007f?#]/.test(entry.name)) unsafe(child);
        if (entry.isDirectory()) {
          await walk(child, [...segments, entry.name]);
          continue;
        }
        if (!entry.isFile()) unsafe(child);
        const contentType = entry.name.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : entry.name.endsWith('.wasm') ? 'application/wasm' : null;
        if (contentType === null) continue;
        if (!within(root, await realpath(child))) unsafe(child);
        const bytes = await readAsset(child, Math.min(MAX_PREVIEW_RUNTIME_ASSET_BYTES, MAX_PREVIEW_RUNTIME_TOTAL_BYTES - totalBytes), signal);
        // Reject a parent-directory replacement observed while the descriptor was open.
        if (!within(root, await realpath(child))) unsafe(child);
        totalBytes += bytes.byteLength;
        assets.set(['runtime', ...segments, entry.name].join('/'), { bytes, contentType });
      }
      aborted(signal, 'preload-runtime');
    }
    await walk(root, []);
  } catch (error) {
    assets.clear();
    throw normalize(error, 'PREVIEW_SERVER_ASSET_ERROR', 'preload-runtime');
  }

  aborted(signal, 'listen-server');
  const prefix = `/${randomBytes(24).toString('hex')}/`;
  let expectedHost = '';
  let disposed = false;
  let returned = false;
  let disposal: Promise<void> | null = null;
  const server = createServer((request, response) => {
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    const fail = (status: number) => { response.writeHead(status, headers).end(); };
    if (disposed) return fail(503);
    if (request.headers.host !== expectedHost) return fail(403);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end();
      return;
    }
    try {
      // Validate the raw target before URL normalization can erase dot segments.
      const raw = request.url ?? '';
      if (!raw.startsWith('/') || raw.startsWith('//')) return fail(404);
      const path = decodeURIComponent(raw.split('?')[0]!);
      if (/[\\\u0000-\u001f\u007f?#]/.test(path)
        || path.split('/').some(part => part === '.' || part === '..')
        || !path.startsWith(prefix)) return fail(404);
      const asset = assets.get(path.slice(prefix.length));
      if (!asset) return fail(404);
      response.writeHead(200, { ...headers, 'Content-Type': asset.contentType, 'Content-Length': asset.bytes.byteLength });
      response.end(request.method === 'HEAD' ? undefined : asset.bytes);
    } catch { fail(404); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;

  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true;
    assets.clear();
    disposal = new Promise<void>((complete, reject) => {
      try {
        server.close(error => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            reject(normalize(error, 'PREVIEW_SERVER_DISPOSE_ERROR', 'dispose-server'));
          } else complete();
        });
      } catch (error) { reject(normalize(error, 'PREVIEW_SERVER_DISPOSE_ERROR', 'dispose-server')); }
      finally { server.closeAllConnections(); }
    });
    return disposal;
  };
  // Initial errors are handled by the listen promise. Later server errors own cleanup too.
  server.on('error', () => { if (returned) void dispose().catch(() => {}); });
  try {
    await new Promise<void>((listening, reject) => {
      const onError = (error: Error) => { server.removeListener('listening', onListening); reject(error); };
      const onListening = () => { server.removeListener('error', onError); listening(); };
      server.once('error', onError);
      server.once('listening', onListening);
      try { server.listen(0, '127.0.0.1'); }
      catch (error) {
        server.removeListener('error', onError);
        server.removeListener('listening', onListening);
        reject(error);
      }
    });
    aborted(signal, 'listen-server');
    const address = server.address();
    if (!address || typeof address === 'string') throw new PreviewError('PREVIEW_SERVER_LISTEN_ERROR', 'listen-server', 'Loopback server did not return a TCP address.');
    expectedHost = `127.0.0.1:${address.port}`;
    returned = true;
    return Object.freeze({ url: `http://${expectedHost}${prefix}`, dispose });
  } catch (error) {
    const failure = signal?.aborted ? new PreviewError('PREVIEW_ABORTED', 'listen-server', 'Preview server initialization was canceled.')
      : normalize(error, 'PREVIEW_SERVER_LISTEN_ERROR', 'listen-server');
    try { await dispose(); }
    catch (cleanupError) {
      throw new PreviewError(failure.code, failure.stage, failure.message, {
        ...failure.details,
        cleanupError: cleanupError instanceof Error ? cleanupError.message : 'Server cleanup failed.',
      });
    }
    throw failure;
  }
}
