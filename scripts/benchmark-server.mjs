import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ktx2': 'image/ktx2', '.svg': 'image/svg+xml',
};

function isWithin(directory, candidate) {
  const path = relative(directory, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function containedFile(directory, path) {
  const lexical = resolve(directory, path);
  if (!isWithin(directory, lexical)) return null;
  const canonical = await realpath(lexical);
  if (!isWithin(directory, canonical)) return null;
  const info = await stat(canonical);
  return info.isFile() ? { path: canonical, size: info.size } : null;
}

/** Read-only localhost server. External collections are never copied or exposed to CI. */
export async function createBenchmarkServer({ port = 0, assetRoot = process.env.STRATA_BENCHMARK_ASSET_DIR } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
  const canonicalRepository = await realpath(repository);
  let canonicalAssets = null;
  if (assetRoot) {
    if (process.env.CI && !['0', 'false'].includes(process.env.CI.toLowerCase())) {
      throw new Error('External benchmark assets are local only and cannot be served in CI. Unset STRATA_BENCHMARK_ASSET_DIR.');
    }
    try { canonicalAssets = await realpath(resolve(assetRoot)); }
    catch { throw new Error('The configured external benchmark asset directory is unavailable.'); }
    if (isWithin(canonicalRepository, canonicalAssets) || isWithin(canonicalAssets, canonicalRepository)) {
      throw new Error('The benchmark asset directory must be outside the repository.');
    }
    if (!(await stat(canonicalAssets)).isDirectory()) throw new Error('The benchmark asset root must be a directory.');
  }
  const roots = [
    ['/packages/core/dist/', resolve(canonicalRepository, 'packages/core/dist')],
    ['/benchmarks/browser/', resolve(canonicalRepository, 'benchmarks/browser')],
  ];
  // Canonicalizing the allowed roots prevents a symlink in a served file from
  // escaping its own package/fixture directory, including into the repository.
  for (const entry of roots) {
    try { entry[1] = await realpath(entry[1]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!isWithin(canonicalRepository, entry[1])) throw new Error('The benchmark browser and runtime directories must remain inside the repository.');
  }
  if (canonicalAssets) roots.push(['/external-assets/', canonicalAssets]);
  let catalogAvailable = false;
  if (canonicalAssets) {
    try { catalogAvailable = Boolean(await containedFile(canonicalAssets, 'catalog.json')); }
    catch { /* An absent catalog does not prevent serving procedural fixtures. */ }
  }
  const server = createServer(async (request, response) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const fail = (status) => response.writeHead(status, headers).end();
    // Binding to loopback alone does not protect against DNS rebinding.
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host ?? '')) return fail(403);
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405);
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const path = decodeURIComponent(url.pathname === '/' ? '/benchmarks/browser/index.html' : url.pathname);
      if (path.includes('\0') || path.includes('\\')) return fail(404);
      if (path === '/favicon.ico') return response.writeHead(204, headers).end();
      if (path === '/benchmark-config.json') {
        const body = JSON.stringify({ externalAssets: { available: catalogAvailable, catalogUrl: catalogAvailable ? '/external-assets/catalog.json' : null } });
        response.writeHead(200, { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        return response.end(request.method === 'HEAD' ? undefined : body);
      }
      const root = roots.find(([prefix]) => path.startsWith(prefix));
      if (!root) return fail(404);
      const file = await containedFile(root[1], path.slice(root[0].length));
      if (!file) return fail(404);
      response.writeHead(200, { ...headers, 'Content-Type': mimeTypes[extname(file.path)] ?? 'application/octet-stream', 'Content-Length': file.size });
      if (request.method === 'HEAD') return response.end();
      const stream = createReadStream(file.path);
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } catch {
      // Filesystem paths and exceptions remain local, never returned over HTTP.
      if (!response.headersSent) fail(404);
      else response.destroy();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
      server.closeAllConnections();
    }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = await createBenchmarkServer({ port: Number(process.env.PORT ?? 4174) });
    console.log(`Strata benchmark: ${server.url}`);
    console.log('Ordinary browser headers; external assets stay on this machine. Run npm run build first.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
