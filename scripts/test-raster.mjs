import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';

await build({ entryPoints: ['tests/browser/temporal-validation.ts'], outfile: 'benchmarks/browser/temporal-validation.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
const directory = resolve(homedir(), 'Downloads/Strata-Benchmark-Results', `${new Date().toISOString().replaceAll(':', '-')}-raster-validation`);
await mkdir(directory, { recursive: true });
const args = ['--enable-unsafe-webgpu'];
if (process.env.STRATA_TEST_SOFTWARE_GPU === '1') {
  args.push(...(platform() === 'linux'
    ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
}
const server = await createBenchmarkServer({ assetRoot: '' });
let browser;
const report = { kind: 'strata-raster-functional-validation', results: {} };
try {
  browser = await chromium.launch({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headless: process.env.STRATA_TEST_HEADED !== '1', args });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(server.url);
  await page.waitForFunction(() => globalThis.strataBenchmark?.ready);
  report.results.temporalShader = await page.evaluate(async () => (await import('/benchmarks/browser/temporal-validation.js')).validateTemporalShader());
  console.log('GPU shaders: GGX normalization, signed motion, valid history, depth-edge filtering, disocclusion, bounds, clamp and reset passed.');
  const images = {};
  for (const temporal of [false, true]) {
    const run = await page.evaluate(temporal => globalThis.strataBenchmark.run({ renderer: 'raster', temporal, instanceCount: 64, mode: 'smoke', warmupSeconds: 0.1, durationSeconds: 0.3 }), temporal);
    assert.equal(run.allocations.gpuErrorCount, 0);
    assert(run.frames.every(frame => frame.drawCalls === (temporal ? 4 : 3)));
    if (run.profiling.gpuTimestampAvailable) {
      assert.deepEqual(Object.keys(run.gpuPasses).sort(), (temporal ? ['shadow','raster','temporal','presentation'] : ['shadow','raster','presentation']).sort());
    }
    report.results[temporal ? 'temporalOn' : 'temporalOff'] = { profiling: run.profiling, allocations: run.allocations, passes: run.gpuPasses };
    for (const view of (temporal ? ['final','direct','shadow','depth','normal','motion','material'] : ['final'])) {
      await page.evaluate(view => globalThis.strataBenchmark.capture(0, view), view);
      const name = `${temporal ? 'taa' : 'raw'}-${view}`;
      const png = await page.locator('canvas').screenshot({ path: resolve(directory, `${name}.png`) });
      const sampled = await page.evaluate(async base64 => {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const pixels = [];
        for (let y = 8; y < canvas.height; y += 8) for (let x = 8; x < canvas.width; x += 8) {
          const offset = (y * canvas.width + x) * 4;
          pixels.push(data[offset], data[offset+1], data[offset+2]);
        }
        return pixels;
      }, png.toString('base64'));
      assert(new Set(sampled).size > 8, `${name} is blank or lacks rendered variation`);
      images[name] = sampled;
    }
  }
  for (const view of ['shadow','depth','normal','motion','material']) {
    const a = images[`taa-${view}`]; const b = images['taa-direct'];
    const meanDifference = a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length;
    assert(meanDifference > 2, `${view} debug output is indistinguishable from direct lighting`);
    report.results[`${view}Difference`] = meanDifference;
  }
  report.results.lifecycle = await page.evaluate(async () => {
    globalThis.strataBenchmark.dispose();
    const { createEngine } = await import('/packages/core/dist/index.js');
    const canvas = document.querySelector('canvas');
    const engine = await createEngine({ canvas, profiling: true });
    try {
      await engine.setScene({ renderer: 'raster', instanceCount: 16 });
      for (let index = 0; index < 12; index++) {
        engine.resize(index % 2 ? 640 : 320, index % 2 ? 360 : 180);
        engine.render({ timeSeconds: index / 60, temporal: index % 3 !== 0, cameraCut: index === 5 });
        await engine.flushGpuTimings();
        engine.drainGpuTimings();
      }
      await engine.setScene({ renderer: 'diffuse', instanceCount: 16 });
      engine.render(); await engine.flushGpuTimings();
      await engine.setScene({ renderer: 'raster', instanceCount: 16 });
      engine.render({ timeSeconds: 10, cameraCut: true }); await engine.flushGpuTimings();
      const active = engine.getTelemetry();
      engine.dispose();
      return { active, disposed: engine.getTelemetry() };
    } finally { engine.dispose(); }
  });
  assert.equal(report.results.lifecycle.active.gpuErrorCount, 0);
  assert.equal(report.results.lifecycle.disposed.allocatedGpuBufferBytes, 0);
  assert.equal(report.results.lifecycle.disposed.allocatedGpuTextureBytes, 0);
  assert.equal(report.results.lifecycle.disposed.wasmMemoryBytes, 0);
  assert.deepEqual(errors, []);
  console.log(`PBR/shadow/debug/temporal toggle/resize/disposal validation passed. Local evidence: ${directory}`);
} catch (error) {
  report.failure = error.message;
  throw error;
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2)+'\n');
  await browser?.close();
  await server.close();
}
