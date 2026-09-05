import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';
import { buildImageReference, imageError, imageOracleSettings, summarizeImageFrames, witnesses } from './reflection-image-reference.mjs';

const command = promisify(execFile); const hash = value => createHash('sha256').update(value).digest('hex');
const baseline = '7e43e9365c09eb07a55d071fa346d2dddc91ef83';
if (process.argv.slice(2).some(value => value !== '--help')) throw new Error('This frozen experiment accepts only --help. Use the standard STRATA_TEST_* browser environment.');
if (process.argv.includes('--help')) { console.log('Compare original7e43 and current reflection output against independent area-quadrature reference. Four fixed240-submission cases per version, frame-count quality only; all evidence external.'); process.exit(0); }
const directory = resolve(homedir(), 'Downloads/Strata-Benchmark-Results', `${new Date().toISOString().replaceAll(':', '-')}-reflection-image-oracle`);
await mkdir(directory, { recursive: true }); const temporary = await mkdtemp(resolve(tmpdir(), 'strata-reflection-original-'));
const report = { kind: 'strata-reflection-image-oracle-v1', timingEvidence: false, settings: imageOracleSettings,
  referenceDomain: '156-triangle closed-box scene, one glossy bounce, zero sun, GI disabled, black outside16m represented domain; no environment lighting.',
  independence: 'Reference uses analytic box slabs plus emitter-face area quadrature of GGX BRDF. It imports no production direction sampler, BVH, shader, or reflection reference helper.',
  pixelScope: '576 frozen pixel-center witnesses in a96x54 central rectangle at320x180; sampled grid images are nearest-expanded witnesses, not dense reference renders.',
  fixedControls: { gi: false, sunIntensity: 0, temporal: false, camera: 'receiver', timeSeconds: 0, objectOffset: 0,
    maxDistance: 16, maxRaysPerFrame: 32768, updateEvery: 1, historyWeight: .8, maxHistoryAgeCap: 16, exposure: 1 },
  softwareGpu: process.env.STRATA_TEST_SOFTWARE_GPU === '1', variants: [], comparisons: [] };
let browser; let server; let page;
try {
  const archive = resolve(temporary, 'runtime.tar');
  await command('git', ['archive', '--format=tar', `--output=${archive}`, baseline, 'packages/core/src']);
  await command('tar', ['-xf', archive, '-C', temporary]);
  const [revision, status, diff] = await Promise.all([command('git', ['rev-parse', 'HEAD']), command('git', ['status', '--porcelain']), command('git', ['diff', '--binary'], { maxBuffer: 8 * 1024 ** 2 })]);
  report.source = { baselineCommit: baseline, currentCommit: revision.stdout.trim(), currentDirty: Boolean(status.stdout.trim()), currentDiffSha256: hash(diff.stdout) };
  report.experimentSources = await Promise.all(['scripts/test-reflection-image.mjs', 'scripts/reflection-image-reference.mjs', 'tests/browser/reflection-image-validation.ts'].map(async path => ({ path, sha256: hash(await readFile(path)) })));
  await writeFile(resolve(directory, 'current.patch'), diff.stdout);
  const modules = {};
  for (const variant of ['original', 'patched']) {
    const rendererPath = resolve(variant === 'original' ? temporary : '.', 'packages/core/src/reflections/reflection-renderer.ts');
    const bundled = await build({ entryPoints: ['tests/browser/reflection-image-validation.ts'], bundle: true, platform: 'browser', target: 'es2022', format: 'esm', write: false,
      plugins: [{ name: 'runtime-under-comparison', setup(builder) { builder.onResolve({ filter: /reflection-renderer\.js$/ }, args =>
        args.importer.endsWith('/tests/browser/reflection-image-validation.ts') ? { path: rendererPath } : undefined); } }],
    });
    modules[variant] = bundled.outputFiles[0].text; await writeFile(resolve(directory, `${variant}-bundle.js`), modules[variant]);
    assert.ok(modules[variant].includes('GiRay(world + normal * 0.002, 0.002, sample.direction, reflectionConfig.settings.y)'),
      `${variant} ray-bias/tMin contract changed; update the independent reference explicitly.`);
  }
  server = await createBenchmarkServer({ assetRoot: '' }); const args = ['--enable-unsafe-webgpu'];
  if (report.softwareGpu) args.push(...(platform() === 'linux' ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
  browser = await chromium.launch({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headless: process.env.STRATA_TEST_HEADED !== '1', args });
  report.browser = browser.version(); page = await browser.newPage({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 1 });
  const errors = []; report.browserErrors = errors; page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Image page crashed.'));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route(`${server.url}/reflection-image.html`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Strata bounded reflection image oracle</title><canvas width="320" height="180"></canvas>' }));
  for (const variant of ['original', 'patched']) await page.route(`${server.url}/${variant}.js`, route => route.fulfill({ contentType: 'text/javascript', body: modules[variant] }));
  await page.goto(`${server.url}/reflection-image.html`);
  const references = new Map(); const results = new Map();
  for (const roughness of [.08, .35]) for (const scale of [1, .25]) {
    const caseName = `r${roughness}-scale${scale}`; let matching; let originalFrames;
    for (const variant of ['original', 'patched']) {
      console.log(`Image oracle ${caseName}: ${variant},240 bounded submissions.`);
      const setup = await page.evaluate(async ({ variant, roughness, scale }) => (await import(`/${variant}.js`)).startReflectionImage(roughness, scale), { variant, roughness, scale });
      assert.equal(setup.first.telemetry.giEnabled, false); assert.equal(setup.first.telemetry.maxDistance, 16);
      assert.equal(setup.first.telemetry.maxRaysPerFrame, 32768); assert.equal(setup.first.telemetry.updateEvery, 1);
      assert.ok(Math.abs(setup.configSettings[2] - .8) < 1e-7);
      assert.equal(setup.first.telemetry.maxHistoryAge, Math.min(16, Math.max(1, Math.ceil(setup.first.telemetry.candidateRegionPixels / 32768))));
      const sceneInput = { scene: setup.scene, camera: setup.camera };
      if (matching) assert.deepEqual(sceneInput, matching, 'Original/patched scene or camera mismatch.'); else matching = sceneInput;
      if (!references.has(roughness)) {
        const coarse = buildImageReference(setup.scene, setup.camera, roughness, imageOracleSettings.quadratureCoarse);
        const fine = buildImageReference(setup.scene, setup.camera, roughness, imageOracleSettings.quadratureFine);
        const precision = imageError(coarse.values, fine.values, fine.mask);
        // Empirical quadrature resolution evidence, not certified ground truth or
        // a tuned acceptance threshold on the engine.
        assert.ok(precision.rmse < .01 && precision.maxAbsoluteError < .05, `Area-quadrature reference not resolved: ${JSON.stringify(precision)}`);
        assert.ok(fine.mask.filter(Boolean).length > 400, 'Frozen ROI does not contain enough visible mirror witnesses.');
        references.set(roughness, { ...fine, precision, input: sceneInput });
        await writeFile(resolve(directory, `reference-r${roughness}.json`), JSON.stringify({ ...fine, precision, input: sceneInput, witnessPixels: witnesses() }));
        await saveGrid(fine.values, `reference-r${roughness}-sampled-grid.png`);
      }
      const reference = references.get(roughness); assert.deepEqual(sceneInput, reference.input);
      const frames = [setup.first];
      for (const frame of [8, 32, 65, ...Array.from({ length: 60 }, (_, i) => 181 + i)]) {
        frames.push(await page.evaluate(async ({ variant, frame }) => (await import(`/${variant}.js`)).captureReflectionImage(frame), { variant, frame }));
      }
      await page.locator('canvas').screenshot({ path: resolve(directory, `${variant}-${caseName}-frame240.png`), timeout: 120000 });
      const summary = summarizeImageFrames(frames, reference);
      const sourceCounts = frames.reduce((total, frame) => total.map((value, i) => value + frame.rawSources[i]), [0, 0, 0, 0, 0, 0]);
      let mixedEmissiveMissWitnesses = 0;
      for (let i = 0; i < 576; i++) {
        const hasMiss = frames.some(frame => frame.rawSelectedSources[i] === (variant === 'original' ? 2 : 5));
        const hasEmissive = frames.some(frame => frame.rawSelectedEmissive[i]);
        mixedEmissiveMissWitnesses += Number(hasMiss && hasEmissive);
      }
      const entry = { variant, caseName, roughness, scale, adapter: setup.adapter, bundleSha256: hash(modules[variant]),
        sourceCounts, mixedEmissiveMissWitnesses, referencePrecision: reference.precision, ...summary };
      if (variant === 'original') originalFrames = frames;
      else {
        let sourceDisagreements = 0; let emissiveDisagreements = 0;
        for (let f = 0; f < frames.length; f++) for (let pixel = 0; pixel < 576; pixel++) {
          const previous = originalFrames[f].rawSelectedSources[pixel];
          sourceDisagreements += Number((previous === 2 ? 5 : previous) !== frames[f].rawSelectedSources[pixel]);
          emissiveDisagreements += Number(originalFrames[f].rawSelectedEmissive[pixel] !== frames[f].rawSelectedEmissive[pixel]);
        }
        entry.samplingAgreement = { sourceDisagreements, emissiveDisagreements, capturedFrames: frames.length, witnessesPerFrame: 576 };
        assert.equal(sourceDisagreements, 0, 'Compared versions changed the underlying ray-source classification.');
        assert.equal(emissiveDisagreements, 0, 'Compared versions changed the underlying emissive-ray classification.');
      }
      report.variants.push(entry); results.set(`${variant}-${caseName}`, entry);
      await writeFile(resolve(directory, `${variant}-${caseName}-frames.json`), JSON.stringify({ setup, frames }));
      await saveGrid(summary.mean, `${variant}-${caseName}-tailmean-sampled-grid.png`);
      await saveGrid(frames.at(-1).rgb, `${variant}-${caseName}-frame240-sampled-grid.png`);
      const disposal = await page.evaluate(async variant => (await import(`/${variant}.js`)).finishReflectionImage(), variant); assert.deepEqual(disposal, { buffers: 0, textures: 0 });
      assert.deepEqual(errors, []);
      console.log(`${variant} ${caseName}: RMSE(mean)=${summary.meanImageError.rmse.toFixed(6)}, temporalVariance=${summary.temporalVariance.toFixed(6)}, mixed witnesses=${mixedEmissiveMissWitnesses}.`);
    }
    const original = results.get(`original-${caseName}`); const patched = results.get(`patched-${caseName}`);
    report.comparisons.push({ caseName, meanImageRmseRatio: patched.meanImageError.rmse / original.meanImageError.rmse,
      temporalVarianceRatio: patched.temporalVariance / original.temporalVariance,
      meanInstantaneousMseRatio: patched.meanInstantaneousMse / original.meanInstantaneousMse,
      interpretation: 'Ratios below1 favor the patch. No pass threshold is imposed on quality; preserve weak/negative outcomes.' });
  }
  assert.ok(report.variants.filter(value => value.variant === 'patched').some(value => value.mixedEmissiveMissWitnesses > 0), 'No actual witness mixed emissive hits and completed world misses: experiment cannot test the hypothesized cause.');
  report.limitations = ['Static camera/object only; hard motion invalidation and diffuse/TAA reset behavior unchanged.',
    'Quadrature integrates the finite represented emissive-box scene, not missing distant/environment/multiple-bounce light.',
    'Pixel-center reference has no footprint filtering; quarter-resolution results deliberately include existing reconstruction error.',
    'Fixed0.8 exponential history has about9 effective independent samples, not240; valid samples do not imply converged images.',
    'No quality threshold tuned after observation; report raw linear errors, temporal variance, mixture and quadrature residuals.'];
  console.log(`Independent image evidence: ${directory}`);
  async function saveGrid(rgb, filename) {
    const encoded = await page.evaluate(values => {
      const canvas = document.createElement('canvas'); canvas.width = 32 * 6; canvas.height = 18 * 6;
      const context = canvas.getContext('2d'); if (!context) throw new Error('2D image context unavailable.');
      const encode = value => { const x = Math.max(0, value); const mapped = Math.min(1, (x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14));
        return Math.round(255 * (mapped <= .0031308 ? mapped * 12.92 : 1.055 * mapped ** (1 / 2.4) - .055)); };
      for (let i = 0; i < 576; i++) { context.fillStyle = `rgb(${encode(values[i * 3])},${encode(values[i * 3 + 1])},${encode(values[i * 3 + 2])})`; context.fillRect(i % 32 * 6, Math.floor(i / 32) * 6, 6, 6); }
      return canvas.toDataURL('image/png').split(',')[1];
    }, rgb); await writeFile(resolve(directory, filename), Buffer.from(encoded, 'base64'));
  }
} catch (error) { report.failure = error.message; throw error; }
finally {
  await Promise.allSettled([browser?.close(), server?.close()]);
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
}
