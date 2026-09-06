import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.map': 'application/json' };
const allowedDirectories = ['examples/minimal', 'examples/meshes', 'examples/character', 'packages/core/dist'].map(path => `${resolve(root, path)}${sep}`);

try {
  await stat(resolve(root, 'packages/core/dist/index.js'));
} catch {
  console.error('Run npm run build before npm run example.');
  process.exit(1);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname === '/' ? '/examples/minimal/index.html' : url.pathname);
    if (!path.startsWith('/examples/minimal/') && !path.startsWith('/examples/meshes/') && !path.startsWith('/examples/character/') && !path.startsWith('/packages/core/dist/')) {
      response.writeHead(404).end();
      return;
    }
    const file = resolve(root, `.${path}`);
    if (!allowedDirectories.some(directory => file.startsWith(directory))) {
      response.writeHead(404).end();
      return;
    }
    const bytes = await readFile(file);
    response.writeHead(200, { 'Content-Type': mimeTypes[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Strata lifecycle example: http://127.0.0.1:${port}`);
  console.log('Serves the built package with ordinary headers (no cross-origin isolation).');
});
