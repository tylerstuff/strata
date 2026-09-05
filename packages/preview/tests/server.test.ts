import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { request, Server } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PREVIEW_CLIENT_BYTES, MAX_PREVIEW_RUNTIME_ASSET_BYTES, MAX_PREVIEW_RUNTIME_DEPTH, startPreviewServer } from '../src/server.js';
import type { PreviewServer } from '../src/server.js';

const directories: string[] = [];
const servers: PreviewServer[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'strata-preview-server-'));
  directories.push(root);
  const runtimeDirectory = join(root, 'runtime');
  await mkdir(join(runtimeDirectory, 'chunks'), { recursive: true });
  await writeFile(join(runtimeDirectory, 'index.js'), 'export const runtime = "snapshot";');
  await writeFile(join(runtimeDirectory, 'worker.js'), 'self.onmessage = () => {};');
  await writeFile(join(runtimeDirectory, 'chunks', 'renderer.js'), 'export const renderer = 1;');
  await writeFile(join(runtimeDirectory, 'runtime.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  await writeFile(join(runtimeDirectory, 'package.json'), '{"private":true}');
  await writeFile(join(root, 'secret.js'), 'export const secret = true;');
  return { runtimeDirectory, clientSource: 'import { runtime } from "./runtime/index.js"; window.result = runtime;' };
}

async function start(options: Parameters<typeof startPreviewServer>[0]): Promise<PreviewServer> {
  const server = await startPreviewServer(options);
  servers.push(server);
  return server;
}

function get(url: string, options: { path?: string; method?: string; host?: string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: options.path ?? parsed.pathname,
      method: options.method ?? 'GET',
      headers: { Host: options.host ?? parsed.host },
      agent: false,
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.dispose()));
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('loopback preview server', () => {
  it('serves a token-scoped canvas page, external client, nested JS and WASM with fixed MIME and no-store', async () => {
    const options = await fixture();
    const server = await start(options);
    const url = new URL(server.url);
    expect(url.hostname).toBe('127.0.0.1');
    expect(Number(url.port)).toBeGreaterThan(0);
    expect(url.pathname).toMatch(/^\/[a-f0-9]{48}\/$/);
    const page = await get(server.url);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.bytes.toString()).toContain('<canvas id="preview">');
    expect(page.bytes.toString()).toContain('src="./client.js"');
    expect(page.bytes.toString()).toContain('<script type="importmap">{"imports":{"@strata-engine/core":"./runtime/index.js"}}</script>');
    expect(page.bytes.toString().indexOf('type="importmap"')).toBeLessThan(page.bytes.toString().indexOf('src="./client.js"'));
    expect(page.bytes.toString()).not.toContain(options.clientSource);
    const client = await get(server.url, { path: `${url.pathname}client.js` });
    expect(client.status).toBe(200);
    expect(client.bytes.toString()).toBe(options.clientSource);
    const nested = await get(server.url, { path: `${url.pathname}runtime/chunks/renderer.js` });
    expect(nested.status).toBe(200);
    expect(nested.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(nested.bytes.toString()).toBe('export const renderer = 1;');
    const wasm = await get(server.url, { path: `${url.pathname}runtime/runtime.wasm` });
    expect(wasm.status).toBe(200);
    expect(wasm.headers['content-type']).toBe('application/wasm');
    expect(wasm.bytes).toEqual(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    for (const response of [page, client, nested, wasm]) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(Number(response.headers['content-length'])).toBe(response.bytes.byteLength);
    }
  });

  it('answers HEAD without body and accepts only GET/HEAD', async () => {
    const server = await start(await fixture());
    const page = await get(server.url);
    const head = await get(server.url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.bytes.byteLength).toBe(0);
    expect(head.headers['content-length']).toBe(page.headers['content-length']);
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await get(server.url, { method });
      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe('GET, HEAD');
    }
  });

  it('rejects raw/encoded traversal, wrong prefixes/hosts, and non-runtime files', async () => {
    const server = await start(await fixture());
    const path = new URL(server.url).pathname;
    const targets = [
      '/', '/client.js', '/runtime/index.js', '/wrong-token/runtime/index.js',
      `${path}runtime/package.json`, `${path}runtime/`, `${path}runtime/missing.js`,
      `${path}runtime/../secret.js`, `${path}runtime/./index.js`,
      `${path}runtime/%2e%2e/secret.js`, `${path}runtime/..%2fsecret.js`,
      `${path}runtime/%252e%252e/secret.js`, `${path}runtime/%5csecret.js`,
      `${path}runtime/%00index.js`, `${path}runtime/%zz`,
      `//127.0.0.1${path}runtime/index.js`,
    ];
    const results = await Promise.all(targets.map(target => get(server.url, { path: target })));
    expect(results.map(result => result.status)).toEqual(targets.map(() => 404));
    expect(results.every(result => result.bytes.byteLength === 0)).toBe(true);
    expect((await get(server.url, { host: 'attacker.example' })).status).toBe(403);
    expect((await get(server.url, { host: 'localhost' })).status).toBe(403);
  });

  it('serves only the preloaded snapshot after runtime files are changed or deleted', async () => {
    const options = await fixture();
    const server = await start(options);
    const path = new URL(server.url).pathname;
    await writeFile(join(options.runtimeDirectory, 'index.js'), 'export const runtime = "changed";');
    await writeFile(join(options.runtimeDirectory, 'new.js'), 'export const newFile = true;');
    expect((await get(server.url, { path: `${path}runtime/index.js` })).bytes.toString()).toBe('export const runtime = "snapshot";');
    expect((await get(server.url, { path: `${path}runtime/new.js` })).status).toBe(404);
    await rm(options.runtimeDirectory, { recursive: true });
    expect((await get(server.url, { path: `${path}runtime/chunks/renderer.js` })).status).toBe(200);
  });

  it.each(['file', 'directory', 'root'] as const)('rejects a %s symlink before opening a listener', async kind => {
    const options = await fixture();
    let runtimeDirectory = options.runtimeDirectory;
    if (kind === 'file') await symlink(join(dirname(options.runtimeDirectory), 'secret.js'), join(runtimeDirectory, 'linked.js'));
    if (kind === 'directory') await symlink(dirname(options.runtimeDirectory), join(runtimeDirectory, 'outside'));
    if (kind === 'root') {
      runtimeDirectory = join(dirname(options.runtimeDirectory), 'linked-runtime');
      await symlink(options.runtimeDirectory, runtimeDirectory);
    }
    const listen = vi.spyOn(Server.prototype, 'listen');
    await expect(startPreviewServer({ ...options, runtimeDirectory })).rejects.toMatchObject({ code: 'PREVIEW_SERVER_UNSAFE_PATH', stage: 'preload-runtime' });
    expect(listen).not.toHaveBeenCalled();
  });

  it('rejects oversized sparse assets before reading them or opening a listener', async () => {
    const options = await fixture();
    const oversized = join(options.runtimeDirectory, 'oversized.wasm');
    await writeFile(oversized, '');
    await truncate(oversized, MAX_PREVIEW_RUNTIME_ASSET_BYTES + 1);
    const listen = vi.spyOn(Server.prototype, 'listen');
    await expect(startPreviewServer(options)).rejects.toMatchObject({ code: 'PREVIEW_SERVER_LIMIT', details: { path: await realpath(oversized) } });
    expect(listen).not.toHaveBeenCalled();
  });

  it('bounds runtime nesting and client source bytes', async () => {
    const options = await fixture();
    const nested = join(options.runtimeDirectory, ...Array.from({ length: MAX_PREVIEW_RUNTIME_DEPTH + 1 }, (_, index) => `depth-${index}`));
    await mkdir(nested, { recursive: true });
    await expect(startPreviewServer(options)).rejects.toMatchObject({ code: 'PREVIEW_SERVER_LIMIT' });
    await expect(startPreviewServer({ ...options, clientSource: 'x'.repeat(MAX_PREVIEW_CLIENT_BYTES + 1) })).rejects.toMatchObject({ code: 'PREVIEW_SERVER_LIMIT', stage: 'server-options' });
  });

  it('rejects invalid options, missing directories, and an already-aborted initialization', async () => {
    const options = await fixture();
    const listen = vi.spyOn(Server.prototype, 'listen');
    await expect(startPreviewServer(null as never)).rejects.toMatchObject({ code: 'PREVIEW_INVALID_OPTIONS' });
    await expect(startPreviewServer({ ...options, runtimeDirectory: join(dirname(options.runtimeDirectory), 'missing') })).rejects.toMatchObject({ code: 'PREVIEW_SERVER_ASSET_ERROR', stage: 'preload-runtime' });
    await expect(startPreviewServer({ ...options, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'PREVIEW_ABORTED' });
    expect(listen).not.toHaveBeenCalled();
  });

  it('closes a listener if cancellation arrives during listen initialization', async () => {
    const options = await fixture();
    const controller = new AbortController();
    const nativeListen = Server.prototype.listen;
    const close = vi.spyOn(Server.prototype, 'close');
    let listener!: Server;
    vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (this: Server, ...args: unknown[]) {
      listener = this;
      const result = Reflect.apply(nativeListen, this, args) as Server;
      controller.abort();
      return result;
    });
    await expect(startPreviewServer({ ...options, signal: controller.signal })).rejects.toMatchObject({ code: 'PREVIEW_ABORTED', stage: 'listen-server' });
    expect(close).toHaveBeenCalledOnce();
    expect(listener.listening).toBe(false);
    expect(listener.address()).toBeNull();
  });

  it.each(['event', 'throw'] as const)('cleans up a listen %s failure exactly once', async mode => {
    const options = await fixture();
    const close = vi.spyOn(Server.prototype, 'close');
    vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (this: Server) {
      const error = new Error('Injected listen failure.');
      if (mode === 'throw') throw error;
      queueMicrotask(() => this.emit('error', error));
      return this;
    });
    await expect(startPreviewServer(options)).rejects.toMatchObject({ code: 'PREVIEW_SERVER_LISTEN_ERROR', stage: 'listen-server', message: 'Injected listen failure.' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('treats the caller signal as initialization-only and closes active connections exactly once on disposal', async () => {
    const controller = new AbortController();
    const server = await start({ ...await fixture(), signal: controller.signal });
    controller.abort();
    expect((await get(server.url)).status).toBe(200);
    const url = new URL(server.url);
    const socket = connect(Number(url.port), '127.0.0.1');
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n`);
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    const close = vi.spyOn(Server.prototype, 'close');
    const first = server.dispose();
    expect(server.dispose()).toBe(first);
    await first;
    await closed;
    expect(close).toHaveBeenCalledOnce();
    await expect(get(server.url)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('gives separate servers distinct opaque URL prefixes', async () => {
    const options = await fixture();
    const first = await start(options);
    const second = await start(options);
    expect(new URL(first.url).pathname).not.toBe(new URL(second.url).pathname);
    expect((await get(first.url, { path: new URL(second.url).pathname })).status).toBe(404);
  });
});
