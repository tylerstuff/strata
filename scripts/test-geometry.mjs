import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), 'strata-geometry-fixture-'));
const directory = resolve(homedir(), 'Downloads/Strata-Benchmark-Results', `${new Date().toISOString().replaceAll(':', '-')}-geometry-validation`);
await mkdir(directory, { recursive: true });
const report = { kind: 'strata-geometry-functional-validation', performanceEvidence: false, results: {} };
let server;
let browser;
try {
  // This test generates its own tiny fixture. It never reads or stages a local
  // asset collection, and removes every generated page even after a failure.
  execFileSync('cargo', ['run', '--release', '--locked', '--package', 'strata-geometry-cooker', '--',
    '--output', fixture, '--seed', '1337', '--tiles', '4', '--cells', '32'], { cwd: repository, stdio: 'pipe' });
  const manifest = JSON.parse(await readFile(join(fixture, 'manifest.json'), 'utf8'));
  const roots = new Set(manifest.rootPageIds);
  const maxDetailPages = Math.max(...manifest.tiles.map(tile => tile.lods[0].pageIds.filter(id => !roots.has(id)).length));
  const poolBytes = (roots.size + maxDetailPages) * manifest.pageBytes;
  assert(poolBytes < manifest.pages.length * manifest.pageBytes, 'Fixture must exceed the streamed page pool');
  report.fixture = { source: manifest.source, pages: manifest.pages.length, rootPages: roots.size, poolBytes };
  server = await createBenchmarkServer({ assetRoot: '', proceduralRoot: fixture });
  const args = ['--enable-unsafe-webgpu'];
  if (process.env.STRATA_TEST_SOFTWARE_GPU === '1') {
    args.push(...(platform() === 'linux'
      ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
      : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
  }
  browser = await chromium.launch({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headless: process.env.STRATA_TEST_HEADED !== '1', args });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(server.url);
  await page.waitForFunction(() => globalThis.strataBenchmark?.ready);
  report.adapter = await page.evaluate(async () => {
    globalThis.strataBenchmark.dispose();
    const { createEngine } = await import('/packages/core/dist/index.js');
    const canvas = document.querySelector('canvas');
    canvas.style.width = '640px'; canvas.style.height = '360px';
    canvas.style.maxWidth = 'none';
    const engine = await createEngine({ canvas, profiling: true });
    engine.resize(640, 360);
    globalThis.geometryTest = {
      engine,
      async scene(options) {
        await engine.setScene({ renderer: 'virtual', manifestUrl: '/procedural-assets/manifest.json', pixelError: 0.25, ...options });
        return engine.getTelemetry();
      },
      async step(options = {}) {
        const frame = engine.render({ temporal: false, debugView: 'coverage', ...options });
        await engine.flushGpuTimings();
        const timings = engine.drainGpuTimings();
        return { frame, timings, telemetry: engine.getTelemetry() };
      },
    };
    return engine.info;
  });

  function checkFrame(result, { temporal = false } = {}) {
    const { frame, telemetry } = result;
    const geometry = telemetry.geometry;
    const mesh = geometry.geometryMode === 'mesh-lod';
    assert.equal(telemetry.gpuErrorCount, 0);
    assert.equal(geometry.coverageMissingTiles, 0, 'Every tile must retain complete coarse geometry');
    assert.equal(geometry.overflowCount, 0, 'GPU work lists must remain bounded');
    assert.equal(geometry.sourceFrameId, frame.frameId, 'Flushed GPU feedback identifies the actual source submission');
    if (mesh) assert.equal(frame.triangleCountSourceFrameId, frame.frameId, 'CPU mesh counts describe the current submission');
    else assert(frame.triangleCountSourceFrameId === null || frame.triangleCountSourceFrameId < frame.frameId,
      'GPU frame metrics must label geometry counters as delayed feedback');
    assert.equal(frame.geometry.sourceFrameId, frame.triangleCountSourceFrameId);
    assert.equal(frame.triangles, frame.geometry.selectedTriangles + frame.geometry.shadowTriangles + (temporal ? 2 : 1));
    assert(geometry.selectedTriangles > 0, 'Camera must render terrain');
    assert.equal(frame.drawCalls, (mesh ? geometry.visibleTiles + manifest.tiles.length : 2) + (temporal ? 2 : 1));
    assert.equal(frame.dispatchCalls, mesh ? 0 : 2);
    if (report.adapter.profiling.gpuTimestampAvailable) {
      const passes = [...(mesh ? [] : ['selection']), 'shadow', 'raster', ...(temporal ? ['temporal'] : []), 'presentation'];
      assert.deepEqual(result.timings.map(value => value.pass).sort(), passes.sort());
    }
  }

  async function step(options, checks) {
    const result = await page.evaluate(options => globalThis.geometryTest.step(options), options);
    checkFrame(result, checks);
    return result;
  }

  async function settle(options) {
    let result;
    for (let index = 0; index < 100; index++) {
      result = await step(options);
      const geometry = result.telemetry.geometry;
      if (index >= 3 && geometry.pendingRequests === 0 && geometry.completedPages === 0) return result;
      await page.waitForTimeout(25);
    }
    assert.fail(`Geometry requests did not settle: ${JSON.stringify(result.telemetry.geometry)}`);
  }

  async function coverage(name) {
    // Top-down coverage projects the square terrain to height/1.05 pixels. Test
    // every interior pixel (not a sparse sample) to catch inter-LOD edge holes.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const png = await page.locator('canvas').screenshot({ path: join(directory, `${name}.png`) });
    const statistics = await page.evaluate(async base64 => {
      const bytes = Uint8Array.from(atob(base64), value => value.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const half = canvas.height / 2 / 1.05;
      let pixels = 0; let missing = 0; let minimum = 255;
      for (let y = Math.ceil(canvas.height / 2 - half) + 3; y < Math.floor(canvas.height / 2 + half) - 3; y++) {
        for (let x = Math.ceil(canvas.width / 2 - half) + 3; x < Math.floor(canvas.width / 2 + half) - 3; x++) {
          const offset = (y * canvas.width + x) * 4;
          const value = Math.min(data[offset], data[offset + 1], data[offset + 2]);
          minimum = Math.min(minimum, value); if (value < 240) missing++; pixels++;
        }
      }
      return { width: canvas.width, height: canvas.height, pixels, missing, minimum, corner: [...data.slice(0, 3)] };
    }, png.toString('base64'));
    assert(statistics.pixels > 10_000, 'Coverage image must contain a substantial terrain interior');
    assert.equal(statistics.missing, 0, `${name}: background leaked through terrain interior`);
    assert(statistics.corner.every(value => value < 100), 'Coverage diagnostic must distinguish background from terrain');
    report.results[name] = statistics;
  }

  const options = { geometryMode: 'streamed', poolBytes, pageLoadDelayMs: 100, maxConcurrentRequests: 2,
    uploadBudgetBytes: manifest.pageBytes, cameraMode: 'coverage' };
  const initial = await page.evaluate(options => globalThis.geometryTest.scene(options), options);
  assert.equal(initial.geometry.residentPages, roots.size);
  const coarse = await step({ timeSeconds: 0, cameraCut: true });
  assert.equal(coarse.frame.triangleCountSourceFrameId, null);
  assert(coarse.telemetry.geometry.missingDetailTiles > 0, 'Fixture must demand unavailable detail');
  await coverage('streamed-coarse-coverage');
  const refined = await settle({ timeSeconds: 0 });
  assert(refined.telemetry.geometry.uploadedPages > roots.size, 'Delayed detail pages must become resident');
  assert(refined.telemetry.geometry.residentPages <= poolBytes / manifest.pageBytes);
  await coverage('streamed-mixed-lod-coverage');
  report.results.coverageTelemetry = { coarse: coarse.telemetry.geometry, refined: refined.telemetry.geometry };
  console.log('Geometry coverage: pinned coarse and partially resident LODs have no interior holes.');

  await page.evaluate(options => globalThis.geometryTest.scene(options), { ...options, cameraMode: 'tour' });
  const cuts = [];
  for (const timeSeconds of [0, 4.8, 9.6, 14.4, 1.2]) {
    await step({ timeSeconds, cameraCut: true });
    const result = await settle({ timeSeconds });
    assert(result.telemetry.geometry.residentPages <= poolBytes / manifest.pageBytes);
    assert(result.telemetry.geometry.stagingReservedBytes <= result.telemetry.geometry.stagingBudgetBytes);
    cuts.push(result.telemetry.geometry);
  }
  assert(cuts.at(-1).evictions > 0, 'Camera tour must evict pages under a real pool constraint');
  assert(cuts.at(-1).requestsStarted > poolBytes / manifest.pageBytes, 'Camera tour must stream beyond its pool capacity');
  report.results.cameraCuts = cuts;
  console.log('Geometry streaming: delayed requests, bounded staging, and camera-cut evictions passed.');

  for (const mode of ['resident-lod', 'resident-full', 'mesh-lod']) {
    const resident = await page.evaluate(options => globalThis.geometryTest.scene(options), { geometryMode: mode, cameraMode: 'coverage' });
    if (mode === 'mesh-lod') assert(resident.geometry.packedGeometryBytes > 0);
    else assert.equal(resident.geometry.residentPages, manifest.pages.length);
    const result = await step({ timeSeconds: 0, cameraCut: true });
    assert.equal(result.telemetry.geometry.missingDetailTiles, 0);
    assert.equal(result.telemetry.geometry.requestsStarted, resident.geometry.requestsStarted);
    await coverage(`${mode}-coverage`);
    report.results[mode] = result.telemetry.geometry;
  }
  assert(report.results['resident-full'].selectedTriangles >= report.results['resident-lod'].selectedTriangles);
  assert.equal(report.results['mesh-lod'].selectedTriangles, report.results['resident-lod'].selectedTriangles);
  assert.equal(report.results['mesh-lod'].poolBytes, 0);
  assert(report.results['mesh-lod'].packedGeometryBytes > 0);
  // A second error target exercises matching CPU/GPU LOD selection, rather than
  // merely comparing the all-finest result produced by the strict target above.
  const selections = {};
  for (const mode of ['resident-lod', 'mesh-lod']) {
    await page.evaluate(options => globalThis.geometryTest.scene(options), { geometryMode: mode, cameraMode: 'coverage', pixelError: 12 });
    selections[mode] = (await step({ timeSeconds: 0, cameraCut: true })).telemetry.geometry;
    await coverage(`${mode}-coarse-selection-coverage`);
  }
  assert.equal(selections['mesh-lod'].selectedTriangles, selections['resident-lod'].selectedTriangles);
  assert.equal(selections['mesh-lod'].selectedClusters, selections['resident-lod'].selectedClusters);
  assert(selections['mesh-lod'].selectedTriangles < report.results['resident-full'].selectedTriangles);
  report.results.selectionParity = selections;
  const lifecycle = [];
  for (let index = 0; index < 8; index++) {
    await page.evaluate(index => globalThis.geometryTest.engine.resize(index % 2 ? 640 : 320, index % 2 ? 360 : 180), index);
    lifecycle.push(await step({ timeSeconds: index / 60, temporal: index % 3 !== 0, cameraCut: index === 5 }, { temporal: index % 3 !== 0 }));
  }
  const disposed = await page.evaluate(async () => {
    const engine = globalThis.geometryTest.engine;
    await engine.setScene({ renderer: 'diffuse', instanceCount: 16 });
    engine.render(); await engine.flushGpuTimings(); engine.drainGpuTimings();
    const active = engine.getTelemetry(); engine.dispose(); engine.dispose();
    return { active, disposed: engine.getTelemetry() };
  });
  assert.equal(disposed.active.gpuErrorCount, 0);
  for (const field of ['allocatedGpuBufferBytes', 'allocatedGpuTextureBytes', 'wasmMemoryBytes']) assert.equal(disposed.disposed[field], 0);
  report.results.lifecycle = { frames: lifecycle.length, ...disposed };
  assert.deepEqual(errors, []);
  console.log(`Geometry shaders, complete coverage, streaming, resident modes, source labels, resize, temporal toggles and disposal passed. Local evidence: ${directory}`);
} catch (error) {
  report.failure = error.message;
  throw error;
} finally {
  // Cleanup remains independent of result-file or browser shutdown failures.
  const cleanup = await Promise.allSettled([
    browser?.close(), server?.close(), rm(fixture, { recursive: true, force: true }),
  ]);
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const failed = cleanup.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}
