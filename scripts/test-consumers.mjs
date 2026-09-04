import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serveConsumer } from '../tests/consumer-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'strata-consumers-'));
const artifacts = join(root, 'test-results', 'consumers');
const softwareGpu = process.env.STRATA_TEST_SOFTWARE_GPU === '1';
const artifactSuffix = softwareGpu ? '-software' : '';
let browser;
const servers = [];

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed (${error.status ?? error.code}):\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
}

async function prepareConsumer(kind, archive) {
  const directory = join(temporary, kind);
  await cp(join(root, 'tests', 'consumers', kind), directory, { recursive: true });
  await cp(join(root, 'tests', 'consumers', 'harness.js'), join(directory, 'harness.js'));
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: `strata-${kind}-consumer`,
    private: true,
    type: 'module',
    dependencies: { '@strata-engine/core': `file:${archive}` },
  }, null, 2));
  // A real archive install, outside the workspace: no source aliases or links.
  run('npm', ['install', '--no-audit', '--no-fund'], directory);
  assert.equal((await lstat(join(directory, 'node_modules', '@strata-engine', 'core'))).isSymbolicLink(), false);
  return directory;
}

async function openConsumer(url, options = {}) {
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  await context.addInitScript(({ unsupported }) => {
    globalThis.__strataWorkers = new Set();
    const NativeWorker = globalThis.Worker;
    globalThis.Worker = class TrackedWorker extends NativeWorker {
      constructor(...args) {
        super(...args);
        globalThis.__strataWorkers.add(this);
      }
      terminate() {
        globalThis.__strataWorkers.delete(this);
        return super.terminate();
      }
    };
    if (unsupported) Object.defineProperty(navigator, 'gpu', { value: undefined });
  }, options);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.goto(url);
  assert.equal(response.headers()['cross-origin-opener-policy'], undefined);
  assert.equal(response.headers()['cross-origin-embedder-policy'], undefined);
  await page.waitForFunction(() => Boolean(globalThis.strataTest));
  return { context, page, errors };
}

async function checkConsumer(kind, url) {
  const { context, page, errors } = await openConsumer(url);
  try {
    const adapter = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return null;
      return { ...adapter.info.toJSON?.(),
        vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description,
        isFallbackAdapter: adapter.info.isFallbackAdapter,
      };
    });
    assert.ok(adapter, 'Chromium has no WebGPU adapter. Install a compatible browser/driver, or explicitly use STRATA_TEST_SOFTWARE_GPU=1 for functional CI validation.');
    console.log(`${kind}: WebGPU adapter ${JSON.stringify(adapter)}; ${softwareGpu ? 'software validation only' : 'default adapter; no performance claim'}`);

    for (let cycle = 0; cycle < 3; cycle++) {
      const initialized = await page.evaluate(() => strataTest.start());
      assert.equal(initialized.state, 'ready');
      assert.equal(initialized.info.cpu.abiVersion, 1);
      assert.ok(initialized.info.cpu.memoryBytes >= 65_536);
      assert.equal(initialized.workers, 1);
      assert.equal(initialized.crossOriginIsolated, false);
      const resized = await page.evaluate(() => strataTest.resize(128, 96));
      assert.equal(resized.width, 128);
      assert.equal(resized.height, 96);
      const pixel = await page.evaluate(() => strataTest.renderPixel());
      assert.equal(pixel[3], 255, `Rendered canvas must be opaque: ${pixel}`);
      assert.ok(pixel[0] > 0 && pixel[0] < pixel[1] && pixel[1] < pixel[2] && pixel[2] < 128,
        `Expected the dark blue WebGPU clear color, got ${pixel}`);
      if (cycle === 0) await page.screenshot({ path: join(artifacts, `${kind}${artifactSuffix}.png`) });
      const disposed = await page.evaluate(() => strataTest.dispose());
      assert.equal(disposed.state, 'disposed');
      assert.equal(disposed.workers, 0);
      assert.equal(await page.evaluate(() => strataTest.renderAfterDispose()), 'ENGINE_DISPOSED');
    }

    for (const fixture of ['missing', 'corrupt']) {
      const failure = await page.evaluate((wasmUrl) => strataTest.fail({ wasmUrl }), `${url}/__fixtures__/${fixture}.wasm`);
      assert.equal(failure.code, fixture === 'missing' ? 'WASM_LOAD_FAILED' : 'WASM_INCOMPATIBLE', failure.message);
      assert.equal(await page.evaluate(() => __strataWorkers.size), 0);
      assert.equal((await page.evaluate(() => strataTest.start())).state, 'ready');
      await page.evaluate(() => strataTest.dispose());
    }

    const timeout = await page.evaluate((wasmUrl) => strataTest.fail({ wasmUrl, initializationTimeoutMs: 500 }), `${url}/__fixtures__/hanging.wasm`);
    assert.equal(timeout.code, 'INITIALIZATION_TIMEOUT', timeout.message);
    assert.equal(await page.evaluate(() => __strataWorkers.size), 0);
    const aborted = await page.evaluate((wasmUrl) => strataTest.abortDuringStart(wasmUrl), `${url}/__fixtures__/hanging.wasm`);
    assert.equal(aborted.code, 'INITIALIZATION_ABORTED', aborted.message);
    assert.equal(await page.evaluate(() => __strataWorkers.size), 0);
    assert.equal((await page.evaluate(() => strataTest.start())).state, 'ready');
    await page.evaluate(() => strataTest.dispose());
    assert.deepEqual(errors, [], 'Consumer should not produce uncaught browser errors');
    console.log(`${kind}: packed WASM initialization, rendering, resize, repeated disposal, load failure, timeout, cancellation, and recovery passed`);
    return { kind, adapter, softwareGpu, browser: browser.version() };
  } finally {
    await context.close();
  }
}

try {
  await mkdir(artifacts, { recursive: true });
  const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], join(root, 'packages', 'core')));
  const files = new Set(packed.files.map((file) => file.path));
  for (const required of ['dist/index.js', 'dist/index.d.ts', 'dist/worker.js', 'dist/strata_runtime.wasm']) {
    assert.ok(files.has(required), `Packed package is missing ${required}`);
  }
  const archive = join(temporary, packed.filename);
  const manifest = JSON.parse(run('tar', ['-xOf', archive, 'package/package.json'], root));
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(manifest.scripts?.[lifecycle], undefined, `Consumers must not need a ${lifecycle} build`);
  }

  const plain = await prepareConsumer('plain', archive);
  const vite = await prepareConsumer('vite', archive);
  await cp(join(root, 'tests', 'consumers', 'typecheck.ts'), join(plain, 'typecheck.ts'));
  await writeFile(join(plain, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2022', 'DOM'],
      types: [],
    },
    files: ['typecheck.ts'],
  }));
  run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(plain, 'tsconfig.json')], plain);
  // Importing the package must not access any browser global, including in SSR.
  run(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    for (const name of ['navigator', 'document', 'window', 'Worker']) {
      Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error('SSR touched ' + name); } });
    }
    const api = await import('@strata-engine/core');
    assert.equal(typeof api.createEngine, 'function');
  `], plain);
  console.log('Packed package: distributable assets, installation without build hooks, consumer TypeScript declarations, and SSR import passed');

  // The bundler runs against the isolated archive installation, never workspace sources.
  run(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], vite);
  const plainServer = await serveConsumer(plain);
  servers.push(plainServer);
  const viteServer = await serveConsumer(join(vite, 'dist'));
  servers.push(viteServer);
  const args = ['--enable-unsafe-webgpu'];
  if (softwareGpu) args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  browser = await chromium.launch({
    headless: true,
    args,
    channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium',
  });

  const results = [];
  for (const [kind, server] of [['plain', plainServer], ['vite', viteServer]]) {
    results.push(await checkConsumer(kind, server.url));
  }
  const unsupported = await openConsumer(plainServer.url, { unsupported: true });
  try {
    const failure = await unsupported.page.evaluate(() => strataTest.fail());
    assert.equal(failure.code, 'WEBGPU_UNAVAILABLE', failure.message);
    assert.equal(await unsupported.page.evaluate(() => __strataWorkers.size), 0);
    assert.deepEqual(unsupported.errors, []);
  } finally {
    await unsupported.context.close();
  }
  console.log('Unsupported browser: actionable error and no worker allocation passed');
  await writeFile(join(artifacts, `environment${artifactSuffix}.json`), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  await browser?.close();
  for (const server of servers) await server.close();
  await rm(temporary, { recursive: true, force: true });
}
