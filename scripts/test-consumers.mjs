import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const giModuleMarker = 'Strata one-bounce software probe trace';
const reflectionModuleMarker = 'Strata bounded software reflections';
const authoredModuleMarker = 'Strata authored root boxes direct PBR';
const integratedModuleMarker = 'Integrated scenes require cooked terrain/proxy URLs';
const importedModuleMarker = 'Strata imported directional light and explicit fill';
const gltfModuleMarker = 'glTF source/decoded data exceeds maxSourceBytes.';
const integratedFixture = join(temporary, 'integrated-fixture');
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
  // The test's procedural cooker output stays outside both the package and uploaded artifacts.
  await page.route('**/__integrated__/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/__integrated__/')[1];
    if (!path || !/^(manifest\.json|trace-proxy\.json|trace-proxy\.bin|pages\/\d{6}\.bin)$/.test(path)) {
      await route.fulfill({ status: 404, body: 'Unknown generated fixture asset' }); return;
    }
    await route.fulfill({ contentType: path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      body: await readFile(join(integratedFixture, path)) });
  });
  page.setDefaultTimeout(30_000);
  const modules = []; const moduleReads = [];
  context.on('response', (response) => {
    if (new URL(response.url()).pathname.endsWith('.js')) {
      moduleReads.push(response.text().then((source) => modules.push({ url: response.url(), source })).catch(() => undefined));
    }
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.goto(url);
  assert.equal(response.headers()['cross-origin-opener-policy'], undefined);
  assert.equal(response.headers()['cross-origin-embedder-policy'], undefined);
  await page.waitForFunction(() => Boolean(globalThis.strataTest));
  return { context, page, errors, async loadedModules() { await Promise.all(moduleReads); return modules; } };
}

const expectedClearPixel = [10, 15, 23, 255];
function isClearPixel(pixel) {
  return pixel.every((channel, index) => Math.abs(channel - expectedClearPixel[index]) <= (index === 3 ? 0 : 2));
}

async function presentedCanvas(page) {
  // Verify browser-composited output while frames render, rather than depending
  // on an immediate cross-context Canvas2D snapshot of a WebGPU canvas.
  // Allow a bounded wait for the first presented frame; incorrect colors still fail.
  const deadline = Date.now() + 5_000;
  let result;
  do {
    const png = await page.locator('canvas').screenshot({ timeout: 5_000 });
    const decoded = await page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const sample = document.createElement('canvas');
      sample.width = sample.height = 1;
      const context = sample.getContext('2d');
      context.drawImage(image, Math.floor(image.naturalWidth / 2), Math.floor(image.naturalHeight / 2), 1, 1, 0, 0, 1, 1);
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        pixel: [...context.getImageData(0, 0, 1, 1).data],
      };
    }, png.toString('base64'));
    result = { png, ...decoded };
    if (isClearPixel(result.pixel)) break;
    await page.evaluate(() => new Promise(requestAnimationFrame));
  } while (Date.now() < deadline);
  return result;
}

async function checkConsumer(kind, url) {
  const { context, page, errors, loadedModules } = await openConsumer(url);
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
      assert.equal(initialized.info.cpu.abiVersion, 2);
      assert.ok(initialized.info.cpu.memoryBytes >= 65_536);
      assert.equal(initialized.workers, 1);
      assert.equal(initialized.crossOriginIsolated, false);
      const resized = await page.evaluate(() => strataTest.resize(128, 96));
      assert.equal(resized.width, 128);
      assert.equal(resized.height, 96);
      await page.evaluate(() => strataTest.startRendering());
      const { pixel, width, height, png } = await presentedCanvas(page);
      // Preserve the exact evidence used by the assertions, including failed runs.
      if (cycle === 0 || !isClearPixel(pixel)) {
        await writeFile(join(artifacts, `${kind}${artifactSuffix}.png`), png);
      }
      assert.equal(width, 128);
      assert.equal(height, 96);
      assert.equal(pixel[3], 255, `Rendered canvas must be opaque: ${pixel}`);
      assert.ok(isClearPixel(pixel), `Expected presented WebGPU clear pixel ${expectedClearPixel}, got ${pixel}`);
      const disposed = await page.evaluate(() => strataTest.dispose());
      assert.equal(disposed.state, 'disposed');
      assert.equal(disposed.workers, 0);
      assert.equal(await page.evaluate(() => strataTest.renderAfterDispose()), 'ENGINE_DISPOSED');
    }

    // Dynamic import must remain lazy in both the native ESM package and Vite's production output.
    const defaultModules = await loadedModules();
    assert.equal(defaultModules.some(module => module.source.includes(importedModuleMarker)), false, `${kind}: default consumer fetched imported rendering`);
    assert.equal(defaultModules.some(module => module.source.includes(gltfModuleMarker)), false, `${kind}: default consumer fetched glTF parsing`);
    assert.equal(defaultModules.some(module => module.source.includes(authoredModuleMarker)), false, `${kind}: default consumer fetched authored rendering`);
    assert.equal(defaultModules.some(module => module.source.includes(integratedModuleMarker)), false, `${kind}: default consumer fetched integrated geometry`);
    assert.equal(defaultModules.some(module => module.source.includes(giModuleMarker)), false,
      `${kind}: the default consumer eagerly fetched GI implementation code`);
    assert.equal(defaultModules.some(module => module.source.includes(reflectionModuleMarker)), false,
      `${kind}: the default consumer eagerly fetched reflection implementation code`);
    assert.equal((await page.evaluate(() => strataTest.start())).state, 'ready');
    const diffuse = await page.evaluate(() => strataTest.exerciseScene({ renderer: 'diffuse', instanceCount: 8 }));
    assert.equal(diffuse.metrics.drawCalls, 1);
    assert.equal(diffuse.telemetry.gpuErrorCount, 0);
    assert.equal((await loadedModules()).some(module => module.source.includes(giModuleMarker)), false,
      `${kind}: choosing the diffuse baseline fetched the optional GI implementation`);
    assert.equal((await loadedModules()).some(module => module.source.includes(reflectionModuleMarker)), false,
      `${kind}: choosing the diffuse baseline fetched the optional reflection implementation`);
    const gi = await page.evaluate(() => strataTest.exerciseScene({ renderer: 'gi', cameraMode: 'overview', probesPerUpdate: 16, raysPerProbe: 32 }));
    assert.equal(gi.metrics.dispatchCalls, 3, `${kind}: optional GI trace/update/shade did not execute`);
    assert.equal(gi.metrics.drawCalls, 3);
    assert.equal(gi.telemetry.gpuErrorCount, 0, gi.telemetry.lastGpuError ?? undefined);
    assert.equal(gi.telemetry.gi?.enabled, true);
    assert.equal(gi.telemetry.gi?.primaryRaysPerFrame, 512);
    assert.equal(gi.telemetry.gi?.cacheEpoch, 1);
    assert.equal(gi.telemetry.gi?.sourceFrameId, gi.metrics.frameId);
    const giModules = (await loadedModules()).filter(module => module.source.includes(giModuleMarker));
    assert.ok(giModules.length > 0, `${kind}: opting into GI did not load its separate implementation`);
    assert.equal((await loadedModules()).some(module => module.source.includes(reflectionModuleMarker)), false,
      `${kind}: choosing GI fetched the optional reflection implementation`);
    const reflection = await page.evaluate(() => strataTest.exerciseScene({ renderer: 'reflections', cameraMode: 'receiver',
      probesPerUpdate: 16, raysPerProbe: 32, resolutionScale: 0.25, maxRaysPerFrame: 32768, roughness: 0.08, objectOffset: 0 },
    { gi: { enabled: true }, reflections: { mode: 'world', roughness: 0.08, maxDistance: 16, updateEvery: 1 } }));
    assert.equal(reflection.metrics.dispatchCalls, 5, `${kind}: GI and selective reflection trace/resolve did not execute`);
    assert.equal(reflection.metrics.drawCalls, 3);
    assert.equal(reflection.metrics.triangles, 313);
    assert.equal(reflection.telemetry.gpuErrorCount, 0, reflection.telemetry.lastGpuError ?? undefined);
    assert.equal(reflection.telemetry.gi?.enabled, true);
    assert.equal(reflection.telemetry.gi?.primaryRaysPerFrame, 512);
    assert.equal(reflection.telemetry.gi?.traceGeometryBytes, 14624);
    assert.equal(reflection.telemetry.gi?.sourceFrameId, reflection.metrics.frameId);
    const reflected = reflection.telemetry.reflections;
    assert.ok(reflected, `${kind}: the optional renderer did not expose reflection telemetry`);
    assert.equal(reflected.mode, 'world');
    assert.equal(reflected.cacheEpoch, 1);
    assert.equal(reflected.framesSinceReset, 1);
    assert.equal(reflected.sourceFrameId, reflection.metrics.frameId);
    assert.equal(reflected.worldRevision, reflection.telemetry.gi.worldRevision);
    assert.equal(reflected.giEnabled, true);
    assert.equal(reflected.traceGeometryBytes, 14624);
    assert.equal(reflected.screenTracing, false);
    assert.equal(reflected.resolutionScale, 0.25);
    assert.equal(reflected.roughness, 0.08);
    assert.equal(reflected.maxRaysPerFrame, 32768);
    assert.ok(reflected.scheduledCandidates > 0 && reflected.scheduledCandidates <= reflected.maxRaysPerFrame);
    assert.equal(reflected.gpuBufferBytes, 512);
    assert.equal(reflected.gpuTextureBytes, 32 * 24 * 88);
    assert.equal(reflected.composeTextureBytes, 128 * 96 * 8);
    for (const name of ['actualPrimaryRays', 'actualShadowRays', 'traceFailures', 'historyReusedPixels']) {
      assert.equal(reflected[name], null, `${kind}: unread reflection counter ${name} must remain null`);
    }
    assert.deepEqual(reflection.metrics.reflections, reflected);
    const reflectionModules = (await loadedModules()).filter(module => module.source.includes(reflectionModuleMarker));
    assert.ok(reflectionModules.length > 0, `${kind}: opting into reflections did not load its separate implementation`);
    assert.equal((await loadedModules()).some(module => module.source.includes(integratedModuleMarker)), false,
      `${kind}: separate reflection proof fetched integrated geometry`);
    const integrated = await page.evaluate(() => strataTest.exerciseScene({ renderer: 'integrated',
      manifestUrl: '/__integrated__/manifest.json', traceProxyUrl: '/__integrated__/trace-proxy.json',
      cameraMode: 'receiver', poolBytes: 1024 * 1024, probesPerUpdate: 16, raysPerProbe: 32 },
    { gi: { enabled: true }, reflections: { mode: 'world' } }));
    assert.equal(integrated.metrics.drawCalls, 5); assert.equal(integrated.metrics.dispatchCalls, 7);
    assert.equal(integrated.telemetry.gpuErrorCount, 0, integrated.telemetry.lastGpuError ?? undefined);
    assert.equal(integrated.telemetry.geometry.sourceTriangleCount, 131072);
    assert.equal(integrated.telemetry.geometry.sourceRootPageCount, 3);
    assert.equal(integrated.telemetry.geometry.coverageMissingTiles, 0);
    assert.equal(integrated.telemetry.gi.traceGeometryBytes, 184640);
    assert.equal(integrated.telemetry.reflections.traceGeometryBytes, 184640);
    assert.equal(integrated.telemetry.integrated.persistentProxyTriangles, 2048);
    assert.equal(integrated.telemetry.integrated.totalTraceTriangles, 2204);
    assert.equal(integrated.telemetry.integrated.collisionRepresentation, 'none');
    assert.ok((await loadedModules()).some(module => module.source.includes(integratedModuleMarker)),
      `${kind}: integrated scene did not load its optional implementation`);
    const authored = await page.evaluate(() => strataTest.exerciseScene({ renderer: 'authored-boxes', scene: {
      format: 'strata.runtime-boxes', version: 1, coordinateSystem: 'strata-world-v1',
      sceneId: 'packed-box', sourceRevision: 'opaque-caller-revision',
      boxes: [{ id: 'box', dimensions: [1, 1, 1],
        transform: { position: [1000000.01, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        material: { baseColor: [0.8, 0.2, 0.1, 1], metallic: 0, roughness: 0.5 } }],
      camera: { position: [1000000.01, 0, 3], rotation: [0, 0, 0, 1],
        projection: { kind: 'perspective', verticalFovRadians: 1, near: 0.1, far: 32 } },
      light: { directionToLight: [0, 0, 1], radiance: [2, 2, 2] }, background: [0, 0, 0],
    } }, { debugView: 'base-color' }));
    assert.equal(authored.metrics.drawCalls, 1); assert.equal(authored.metrics.triangles, 12);
    assert.equal(authored.telemetry.gpuErrorCount, 0, authored.telemetry.lastGpuError ?? undefined);
    assert.equal(authored.metrics.scene.renderer, 'authored-boxes');
    assert.equal(authored.metrics.scene.sourceRevision, 'opaque-caller-revision');
    assert.deepEqual(authored.metrics.scene, authored.telemetry.scene.identity);
    assert.equal(authored.telemetry.scene.lastSubmittedFrameId, authored.metrics.frameId);
    assert.deepEqual(authored.metrics.authored.origin, [1000000.01, 0, 3]);
    assert.ok((await loadedModules()).some(module => module.source.includes(authoredModuleMarker)), `${kind}: authored renderer did not load`);
    const cleared = await page.evaluate(() => strataTest.exerciseScene(null));
    assert.equal(cleared.metrics.dispatchCalls, 0);
    assert.equal(cleared.telemetry.allocatedGpuBufferBytes, 0);
    assert.equal(cleared.telemetry.allocatedGpuTextureBytes, 0);
    assert.equal(cleared.telemetry.reflections, undefined);
    assert.equal(cleared.telemetry.integrated, undefined);
    assert.equal(cleared.telemetry.geometry, undefined);
    assert.equal((await page.evaluate(() => strataTest.dispose())).workers, 0);
    console.log(`${kind}: default/diffuse skipped GI and reflections; GI skipped reflections; opt-in GI loaded ${giModules.length} module(s) and reflections loaded ${reflectionModules.length} module(s), rendered, and released resources`);

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
    return { kind, adapter, softwareGpu, browser: browser.version(), platform: process.platform, headed: process.env.STRATA_TEST_HEADED === '1' };
  } finally {
    await context.close();
  }
}

try {
  await mkdir(artifacts, { recursive: true });
  // Contributor-side fixture generation; the installed runtime has no Rust/build dependency.
  run('cargo', ['run', '--locked', '--release', '--quiet', '--package', 'strata-geometry-cooker', '--',
    '--output', integratedFixture, '--tiles', '4', '--cells', '64', '--seed', '1337', '--trace-proxy'], root);
  const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], join(root, 'packages', 'core')));
  const files = new Set(packed.files.map((file) => file.path));
  for (const required of ['dist/index.js', 'dist/index.d.ts', 'dist/gltf.js', 'dist/gltf.d.ts', 'dist/worker.js', 'dist/strata_runtime.wasm']) {
    assert.ok(files.has(required), `Packed package is missing ${required}`);
  }
  const optionalGiFiles = [...files].filter(file => /^dist\/gi-renderer-[A-Za-z0-9_-]+\.js$/.test(file));
  assert.equal(optionalGiFiles.length, 1, 'Packed ESM distribution must contain one separate GI entry chunk');
  const optionalReflectionFiles = [...files].filter(file => /^dist\/reflection-renderer-[A-Za-z0-9_-]+\.js$/.test(file));
  assert.equal(optionalReflectionFiles.length, 1, 'Packed ESM distribution must contain one separate reflection entry chunk');
  const optionalIntegratedFiles = [...files].filter(file => /^dist\/integrated-renderer-[A-Za-z0-9_-]+\.js$/.test(file));
  assert.equal(optionalIntegratedFiles.length, 1, 'Packed ESM distribution must contain one separate integrated entry chunk');
  const optionalImportedFiles = [...files].filter(file => /^dist\/imported-renderer-[A-Za-z0-9_-]+\.js$/.test(file));
  assert.equal(optionalImportedFiles.length, 1, 'Packed distribution must contain a separate imported renderer chunk');
  const archive = join(temporary, packed.filename);
  const indexSource = run('tar', ['-xOf', archive, 'package/dist/index.js'], root);
  assert.ok(indexSource.includes(`import("./${optionalGiFiles[0].slice('dist/'.length)}")`), 'Package entry must dynamically import the shipped GI chunk');
  assert.equal(indexSource.includes(giModuleMarker), false, 'Package entry must not inline GI implementation code');
  assert.ok(indexSource.includes(`import("./${optionalReflectionFiles[0].slice('dist/'.length)}")`), 'Package entry must dynamically import the shipped reflection chunk');
  assert.equal(indexSource.includes(reflectionModuleMarker), false, 'Package entry must not inline reflection implementation code');
  assert.ok(indexSource.includes(`import("./${optionalIntegratedFiles[0].slice('dist/'.length)}")`), 'Package entry must dynamically import its integrated chunk');
  assert.equal(indexSource.includes(integratedModuleMarker), false, 'Package entry must not inline integrated geometry');
  assert.ok(indexSource.includes(`import("./${optionalImportedFiles[0].slice('dist/'.length)}")`), 'Imported renderer must load dynamically');
  assert.equal(indexSource.includes(importedModuleMarker), false);
  assert.equal(indexSource.includes(gltfModuleMarker), false);
  const manifest = JSON.parse(run('tar', ['-xOf', archive, 'package/package.json'], root));
  assert.equal(manifest.exports['./gltf'].import, './dist/gltf.js');
  assert.equal(manifest.exports['./gltf'].types, './dist/gltf.d.ts');
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
    assert.equal('loadGltf' in api, false);
    const gltf = await import('@strata-engine/core/gltf');
    assert.equal(typeof gltf.loadGltf, 'function');
  `], plain);
  console.log('Packed package: distributable assets, installation without build hooks, consumer TypeScript declarations, and SSR import passed');

  // The bundler runs against the isolated archive installation, never workspace sources.
  run(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], vite);
  if (process.argv.includes('--cpu-only')) {
    console.log('Packed CPU and Vite-build checks complete; browser checks explicitly skipped.');
  } else {
  const plainServer = await serveConsumer(plain);
  servers.push(plainServer);
  const viteServer = await serveConsumer(join(vite, 'dist'));
  servers.push(viteServer);
  const args = ['--enable-unsafe-webgpu'];
  if (softwareGpu && process.platform === 'linux') {
    // Keep WebGPU and canvas composition on the same software Vulkan backend.
    args.push('--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader',
      '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface');
  } else if (softwareGpu) {
    args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  }
  browser = await chromium.launch({
    headless: process.env.STRATA_TEST_HEADED !== '1',
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
  }
} finally {
  await browser?.close();
  for (const server of servers) await server.close();
  await rm(temporary, { recursive: true, force: true });
}
