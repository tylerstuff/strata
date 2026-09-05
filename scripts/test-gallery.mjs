import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { arch, cpus, homedir, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';
import { createGalleryFixture } from './gallery-fixture.mjs';
import { prepareGalleryOutput } from './gallery-output.mjs';
import { runGalleryAssertions } from '../tests/browser/gallery-assertions.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const command = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let output;
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--output' && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) output = process.argv[++index];
  else throw new Error(`Unknown or incomplete gallery validation argument: ${process.argv[index]}`);
}
const outputDirectory = await prepareGalleryOutput(output ?? resolve(homedir(), 'Downloads/Strata-Gallery-Checks',
  `${new Date().toISOString().replaceAll(':', '-')}-gallery-functional`));
const report = {
  kind: 'strata-gallery-functional', status: 'running', performanceEvidence: false, externalCollectionUsed: false,
  softwareGpuRequested: process.env.STRATA_TEST_SOFTWARE_GPU === '1',
  host: { platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model ?? null, node: process.version },
  source: {}, browserErrors: [], cleanupErrors: [],
};
let browser, server, fixture;

async function bounded(work, label, timeoutMs = 180000) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms.`)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

async function revision() {
  const [head, status] = await Promise.all([
    command('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }),
    command('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }),
  ]);
  return { commit: head.stdout.trim(), status: status.stdout.trim() };
}

async function builtFiles(directory, prefix) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...await builtFiles(resolve(directory, entry.name), `${prefix}${entry.name}/`));
    else if (entry.isFile() && /\.(js|wasm)$/.test(entry.name)) files.push({ path: `${prefix}${entry.name}`, sha256: hash(await readFile(resolve(directory, entry.name))) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function identity() {
  const files = ['examples/gallery/index.html', 'examples/gallery/gallery.css', 'examples/gallery/app.js',
    'scripts/test-gallery.mjs', 'scripts/gallery-fixture.mjs', 'scripts/gallery-output.mjs', 'scripts/benchmark-server.mjs', 'scripts/gallery-catalog.mjs',
    'tests/browser/gallery-assertions.mjs'];
  return { ...await revision(), builtRuntime: await builtFiles(resolve(repository, 'packages/core/dist'), 'packages/core/dist/'),
    inputs: await Promise.all(files.map(async path => ({ path, sha256: hash(await readFile(resolve(repository, path))) }))) };
}

try {
  report.source = await identity();
  fixture = await createGalleryFixture();
  report.fixture = { manifest: JSON.parse(await readFile(resolve(fixture.directory, 'fixture.json'), 'utf8')),
    files: await Promise.all(['red.gltf', 'green.gltf', 'scene.bin', 'catalog.json'].map(async path => ({ path,
      sha256: hash(await readFile(resolve(fixture.directory, path))) }))) };
  // Always generate our own tiny fixture. This runner never opens the external collection, including in CI.
  server = await createBenchmarkServer({ assetRoot: '', galleryFixtureRoot: fixture.directory });
  const args = ['--enable-unsafe-webgpu'];
  if (report.softwareGpuRequested) args.push(...(platform() === 'linux'
    ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
  browser = await chromium.launch({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium',
    headless: process.env.STRATA_TEST_HEADED !== '1', args });
  report.host.browser = browser.version();
  report.browserArguments = args;
  const page = await browser.newPage({ viewport: { width: 1500, height: 1050 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.browserErrors.push(message.text()); });
  await page.goto(`${server.url}/gallery/`);
  await page.waitForFunction(() => window.strataGallery?.getState().engineInfo !== null && window.strataGallery?.getState().engineInfo !== undefined,
    undefined, { timeout: 60000 });
  report.engineInfo = await page.evaluate(() => window.strataGallery.getState().engineInfo);
  const adapter = report.engineInfo.adapter;
  const software = adapter.isFallbackAdapter === true || /swiftshader|llvmpipe|software rasterizer|software adapter/i.test(JSON.stringify(adapter));
  assert.equal(software, report.softwareGpuRequested, 'The selected adapter does not match the requested validation mode.');
  report.result = await bounded(runGalleryAssertions(page, { outputDirectory, firstModelId: 'fixture-red', secondModelId: 'fixture-green' }), 'Gallery validation');
  assert.deepEqual(report.browserErrors, []);
  report.sourceAfter = await identity();
  assert.deepEqual(report.sourceAfter, report.source, 'Gallery source or built runtime changed during validation.');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.stack ?? String(error); process.exitCode = 1;
} finally {
  for (const [name, resource, method] of [['browser', browser, 'close'], ['server', server, 'close'], ['fixture', fixture, 'dispose']]) {
    try { if (resource) await bounded(resource[method](), `${name} cleanup`, 15000); }
    catch (error) { report.cleanupErrors.push({ resource: name, error: error.message ?? String(error) }); }
  }
  if (report.cleanupErrors.length) { report.status = 'failed'; process.exitCode = 1; }
  await writeFile(resolve(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Gallery ${report.status}. External report: ${outputDirectory}/report.json`);
}
