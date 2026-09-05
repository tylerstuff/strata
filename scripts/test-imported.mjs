import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, platform } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';

if (process.argv.length !== 2) throw new Error('Usage: node scripts/test-imported.mjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = () => ({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  status: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }) });
const { PNG } = createRequire(import.meta.url)(join(root, 'node_modules/playwright-core/lib/utilsBundle.js'));
const fixtures = new Map();
function png(name, width, height, pixel) {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) image.data.set(pixel(x, y), (y * width + x) * 4);
  fixtures.set(`${name}.png`, PNG.sync.write(image));
}
png('base', 2, 2, () => [128, 64, 192, 128]);
png('normal', 2, 2, () => [191, 191, 218, 255]);
png('mask', 4, 4, x => [255, 255, 255, x < 2 ? 0 : 255]);
png('large', 8, 4, () => [128, 64, 192, 255]);
png('uv', 2, 2, (x, y) => [[192, 32, 16, 255], [16, 160, 32, 255], [32, 16, 192, 255], [160, 128, 16, 255]][y * 2 + x]);
function gltf(name, xScale) {
  const buffer = Buffer.alloc(204); const data = new Float32Array(buffer.buffer, buffer.byteOffset, 48);
  [[-1, -1, 0, 0, 1], [1, -1, 0, 1, 1], [1, 1, 0, 1, 0], [-1, 1, 0, 0, 0]].forEach((p, index) =>
    data.set([p[0], p[1], p[2], 0, 0, 1, p[3], p[4], 1, 0, 0, 1], index * 12));
  [0, 1, 2, 0, 2, 3].forEach((value, index) => buffer.writeUInt16LE(value, 192 + index * 2));
  const document = { asset: { version: '2.0', generator: 'Strata generated import test; no external model content' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ scale: [xScale, 1, 0.5], children: [1] }, { rotation: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)], mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, TANGENT: 3 }, indices: 4, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.5 } }],
    buffers: [{ uri: `${name}.bin`, byteLength: buffer.byteLength }],
    bufferViews: [{ buffer: 0, byteLength: 192, byteStride: 48, target: 34962 }, { buffer: 0, byteOffset: 192, byteLength: 12, target: 34963 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
      { bufferView: 0, byteOffset: 12, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 0, byteOffset: 24, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 0, byteOffset: 32, componentType: 5126, count: 4, type: 'VEC4' },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ] };
  fixtures.set(`${name}.gltf`, Buffer.from(JSON.stringify(document))); fixtures.set(`${name}.bin`, buffer);
}
gltf('affine', 2); gltf('mirrored', -2);
const modules = {};
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/browser/imported-validation.ts'], bundle: true, write: false,
  format: 'esm', platform: 'browser', target: 'es2022', plugins: [{ name: 'record-imported-runtime', setup(builder) {
    builder.onLoad({ filter: /packages\/core\/src\/.*\.ts$/ }, async ({ path }) => {
      const contents = await readFile(path); modules[relative(root, path)] = hash(contents); return { contents, loader: 'ts' };
    });
  } }] });
const output = join(homedir(), 'Downloads/Strata-Benchmark-Results', `${new Date().toISOString().replaceAll(':', '-')}-imported-validation`);
await mkdir(output, { recursive: true });
const report = { kind: 'strata-imported-generated-functional', status: 'running', performanceEvidence: false,
  source: source(), modules, harnessSha256: hash(await readFile(join(root, 'tests/browser/imported-validation.ts'))),
  runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))), bundleSha256: hash(bundle.outputFiles[0].contents),
  fixtures: [...fixtures].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: hash(bytes) })),
  softwareGpu: process.env.STRATA_TEST_SOFTWARE_GPU === '1', browserErrors: [], cleanupErrors: [],
  limitations: ['Generated fixtures only. No downloaded model, external asset or derived data is copied into the repository.',
    'Functional MRT/depth and lifecycle proof; no frame-performance claim. Animation covers one-hot joint162 and deterministic scale/translation only.'] };
let browser; let server; let timer;
try {
  server = await createBenchmarkServer({ assetRoot: '' });
  const args = ['--enable-unsafe-webgpu'];
  if (report.softwareGpu) args.push(...(platform() === 'linux'
    ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
  browser = await chromium.launch({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headless: process.env.STRATA_TEST_HEADED !== '1', args });
  report.browser = { version: browser.version(), args };
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  const loaded = []; const pendingModules = [];
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.startsWith('/packages/core/dist/') && pathname.endsWith('.js')) pendingModules.push(response.body().then(bytes => loaded.push({ path: pathname, sha256: hash(bytes) })));
  });
  report.publicLoadingStages = [];
  await page.exposeFunction('__strataImportedStage', async name => {
    await Promise.all(pendingModules);
    const importedRequests = loaded.filter(record => /\/imported-renderer-[^/]+\.js$/.test(record.path));
    report.publicLoadingStages.push({ name, modules: [...loaded], importedRendererRequests: importedRequests.length });
    if (name === 'empty') assert.equal(importedRequests.length, 0, 'Default public engine eagerly requested the imported renderer.');
    if (name === 'imported') assert(importedRequests.length > 0, 'Imported public scene did not request its optional renderer module.');
  });
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.browserErrors.push(message.text()); });
  await page.route(`${server.url}/imported-validation.html`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Generated Strata import checks</title>' }));
  await page.route(`${server.url}/imported-validation.js`, route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text }));
  await page.route(`${server.url}/__imported-fixtures__/*`, route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1); const bytes = fixtures.get(name);
    return bytes ? route.fulfill({ contentType: name.endsWith('.png') ? 'image/png' : name.endsWith('.gltf') ? 'model/gltf+json' : 'application/octet-stream', body: bytes }) : route.fulfill({ status: 404 });
  });
  await page.goto(`${server.url}/imported-validation.html`);
  await Promise.race([(async () => {
    report.rendering = await page.evaluate(async () => (await import('/imported-validation.js')).validateImportedRendering());
    report.lifecycle = await page.evaluate(async () => (await import('/imported-validation.js')).validateImportedPublicLifecycle());
  })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Generated imported validation exceeded120seconds.')), 120_000); })]);
  assert.equal(report.rendering.status, 'passed'); assert.equal(report.lifecycle.status, 'passed'); assert.deepEqual(report.browserErrors, []);
  if (!report.softwareGpu) {
    assert.notEqual(report.rendering.adapter.isFallbackAdapter, true);
    assert(!/swiftshader|llvmpipe|software rasterizer|software adapter/i.test(JSON.stringify(report.rendering.adapter)), 'Hardware validation selected a software adapter.');
  }
  report.sourceAfter = source(); assert.deepEqual(report.sourceAfter, report.source, 'Source changed during generated import validation.');
  const after = Object.fromEntries(await Promise.all(Object.keys(modules).map(async path => [path, hash(await readFile(join(root, path)))])));
  assert.deepEqual(after, modules, 'Imported runtime bytes changed during validation.');
  await Promise.all(pendingModules);
  for (const record of loaded) assert.equal(hash(await readFile(join(root, record.path.slice(1)))), record.sha256, `Built public module changed: ${record.path}`);
  report.publicLoadedModules = loaded;
  assert.equal(hash(await readFile(join(root, 'tests/browser/imported-validation.ts'))), report.harnessSha256);
  assert.equal(hash(await readFile(fileURLToPath(import.meta.url))), report.runnerSha256); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack ?? String(error); process.exitCode = 1; }
finally {
  clearTimeout(timer); for (const result of await Promise.allSettled([browser?.close(), server?.close()])) if (result.status === 'rejected') report.cleanupErrors.push(String(result.reason));
  if (report.cleanupErrors.length) { report.status = 'failed'; process.exitCode = 1; }
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Imported generated checks ${report.status}. External report: ${output}/report.json`);
}
