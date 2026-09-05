import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, homedir, platform, release, totalmem } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';
import { validateBenchmarkReport } from './validate-benchmark.mjs';

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArguments(args) {
  const options = { smoke: false, sustained: false, output: resolve(homedir(), 'Downloads/Strata-Benchmark-Results') };
  const numeric = new Set(['duration', 'warmup', 'seed', 'instance-count', 'pool-mib', 'pixel-error', 'page-delay-ms']);
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--smoke') options.smoke = true;
    else if (name === '--require-ac-performance') options.requireAcPerformance = true;
    else if (name === '--sustained') options.sustained = true;
    else if (name === '--help') options.help = true;
    else if (numeric.has(name.slice(2)) || ['--output', '--device-label', '--renderer', '--temporal', '--debug-view', '--manifest', '--geometry-mode', '--camera'].includes(name)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`);
      options[name.slice(2)] = numeric.has(name.slice(2)) ? Number(value) : value;
    } else throw new Error(`Unknown option: ${name}`);
  }
  if (options.smoke && options.sustained) throw new Error('--smoke and --sustained are separate run types.');
  options.duration ??= options.smoke ? 1 : options.sustained ? 180 : 60;
  options.warmup ??= options.smoke ? 0.25 : 30;
  options.seed ??= 1337;
  options.renderer ??= 'diffuse';
  options.temporal ??= 'on';
  options['debug-view'] ??= 'final';
  options['geometry-mode'] ??= 'streamed';
  options['pool-mib'] ??= 8;
  options['pixel-error'] ??= 2;
  options['page-delay-ms'] ??= 0;
  options.camera ??= 'tour';
  if (!['diffuse', 'raster', 'virtual'].includes(options.renderer) || !['on', 'off'].includes(options.temporal)
    || !['final', 'direct', 'shadow', 'depth', 'normal', 'motion', 'material', 'clusters', 'lod', 'residency', 'coverage'].includes(options['debug-view'])) {
    throw new Error('Use --renderer diffuse|raster|virtual, --temporal on|off and a supported --debug-view.');
  }
  if (!['streamed', 'resident-lod', 'resident-full', 'mesh-lod'].includes(options['geometry-mode']) || !['tour', 'coverage'].includes(options.camera)) throw new Error('Unknown geometry mode or camera.');
  if (!Number.isFinite(options['pool-mib']) || options['pool-mib'] < 0.0625 || !Number.isSafeInteger(options['pool-mib'] * 1024 ** 2)
    || !Number.isFinite(options['pixel-error']) || options['pixel-error'] <= 0 || options['pixel-error'] > 1000
    || !Number.isFinite(options['page-delay-ms']) || options['page-delay-ms'] < 0 || options['page-delay-ms'] > 60000) throw new Error('Invalid geometry pool, error or page delay.');
  if (options.renderer === 'virtual' && (!options.manifest || !process.env.STRATA_BENCHMARK_ASSET_DIR)) throw new Error('Virtual benchmarks require --manifest relative/path/manifest.json and STRATA_BENCHMARK_ASSET_DIR pointing to the external cooked asset root.');
  for (const name of ['duration', 'warmup', 'seed', 'instance-count']) {
    const value = options[name];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`--${name} must be a nonnegative finite number.`);
  }
  if (options.duration <= 0 || options.duration > 1800 || options.warmup > 600) throw new Error('Capture duration must be >0 and <=1800 seconds; warmup must be <=600 seconds.');
  for (const name of ['seed', 'instance-count']) if (options[name] !== undefined && !Number.isSafeInteger(options[name])) throw new Error(`--${name} must be an integer.`);
  if (options['instance-count'] === 0) throw new Error('--instance-count must be positive.');
  if (options.seed > 0xffff_ffff) throw new Error('--seed must be a uint32 integer (0–4294967295).');
  if (options['instance-count'] > 16_384) throw new Error('--instance-count must be at most 16384.');
  return options;
}

async function command(file, args) {
  try {
    const { stdout } = await exec(file, args, { cwd: repository, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch { return null; }
}

function within(directory, candidate) {
  const path = relative(directory, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

// Resolve existing ancestors before mkdir so symlinks cannot place results in Git.
async function canonicalDestination(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonicalDestination(parent), relative(parent, path));
  }
}

async function outputDirectory(path) {
  const destination = await canonicalDestination(resolve(path));
  if (within(await realpath(repository), destination)) throw new Error('Benchmark reports and captures must be written outside the repository.');
  if (process.env.STRATA_BENCHMARK_ASSET_DIR && within(await realpath(resolve(process.env.STRATA_BENCHMARK_ASSET_DIR)), destination)) {
    throw new Error('Use a results directory separate from the source asset collection.');
  }
  await mkdir(destination, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const runDirectory = resolve(destination, `${timestamp}-${process.pid}`);
  await mkdir(runDirectory);
  return runDirectory;
}

async function hostMetadata() {
  const result = {
    os: `${platform()} ${release()}`, architecture: arch(), nodeVersion: process.version,
    cpu: cpus()[0]?.model ?? null, logicalCpuCount: cpus().length,
    memoryGiB: Math.round(totalmem() / 1024 ** 3 * 100) / 100, hardware: null,
  };
  if (platform() !== 'darwin') return result;
  const raw = await command('system_profiler', ['-json', 'SPHardwareDataType', 'SPDisplaysDataType']);
  if (!raw) return result;
  try {
    const data = JSON.parse(raw);
    const hardware = data.SPHardwareDataType?.[0];
    // Never persist the full profiler output: it contains serial numbers and UUIDs.
    result.hardware = {
      model: hardware?.machine_name ?? null, modelIdentifier: hardware?.machine_model ?? null,
      chip: hardware?.chip_type ?? hardware?.cpu_type ?? null, memory: hardware?.physical_memory ?? null,
      displays: (data.SPDisplaysDataType ?? []).map((gpu) => ({
        gpu: gpu.sppci_model ?? gpu._name ?? null, vendor: gpu.spdisplays_vendor ?? null,
        cores: gpu.sppci_cores ?? null, vram: gpu.spdisplays_vram ?? gpu.spdisplays_vram_shared ?? null,
        screens: (gpu.spdisplays_ndrvs ?? []).map((display) => ({
          name: display._name ?? null, resolution: display._spdisplays_resolution ?? display.spdisplays_resolution ?? null,
          refreshRate: display.spdisplays_refresh_rate ?? null,
        })),
      })),
    };
  } catch { /* Other operating systems and unavailable probes remain explicit nulls. */ }
  return result;
}

async function powerSnapshot() {
  const snapshot = { recordedAt: new Date().toISOString(), source: null, batteryPercent: null, charging: null, lowPowerMode: null, thermal: null };
  if (platform() !== 'darwin') return { ...snapshot, availability: 'Automatic power and thermal probes are implemented for macOS only; record other systems manually.' };
  const [battery, settings, thermal] = await Promise.all([
    command('pmset', ['-g', 'batt']), command('pmset', ['-g', 'custom']), command('pmset', ['-g', 'therm']),
  ]);
  snapshot.source = battery?.match(/Now drawing from '([^']+)'/)?.[1] ?? null;
  const percent = battery?.match(/(\d+)%/);
  snapshot.batteryPercent = percent ? Number(percent[1]) : null;
  snapshot.charging = battery?.match(/\d+%;\s*([^;]+)/)?.[1] ?? null;
  if (settings) {
    const modes = {};
    let section = 'unknown';
    for (const line of settings.split('\n')) {
      if (/^[^\s].*:$/.test(line)) section = line.replace(/:$/, '').trim();
      const value = line.match(/^\s*lowpowermode\s+(\d+)/);
      if (value) modes[section] = Number(value[1]);
    }
    snapshot.lowPowerMode = Object.keys(modes).length ? modes : null;
  }
  if (thermal) {
    const limits = {};
    for (const line of thermal.split('\n')) {
      const pair = line.match(/(CPU_Scheduler_Limit|CPU_Available_CPUs|CPU_Speed_Limit|Thermal_Level|GPU_Speed_Limit)\s*=\s*(\d+)/);
      if (pair) limits[pair[1]] = Number(pair[2]);
    }
    snapshot.thermal = {
      noThermalWarningRecorded: /No thermal warning level has been recorded/.test(thermal),
      noPerformanceWarningRecorded: /No performance warning level has been recorded/.test(thermal),
      limits, temperatureCelsius: null,
      note: 'pmset warning/limit indicators are not a temperature measurement or proof that no throttling occurred.',
    };
  }
  return snapshot;
}

function powerProfile(snapshot) {
  return { source: snapshot.source, lowPowerMode: snapshot.lowPowerMode?.[snapshot.source] ?? null };
}

function checkPower(snapshot, expected, requireAcPerformance) {
  const profile = powerProfile(snapshot);
  if (requireAcPerformance && (profile.source !== 'AC Power' || profile.lowPowerMode !== 0)) {
    throw new Error('This capture requires AC power with the active Low Power Mode profile off. The power probe did not confirm both conditions.');
  }
  if (expected && (profile.source !== expected.source || profile.lowPowerMode !== expected.lowPowerMode)) {
    throw new Error('The active power source or Low Power Mode changed during this session. Repeat all comparison runs under a stable profile.');
  }
  return profile;
}

function isSoftwareAdapter(adapter) {
  return adapter?.isFallbackAdapter === true || /swiftshader|llvmpipe|software rasterizer|software adapter/i.test(JSON.stringify(adapter));
}

async function captureEvidence(page, path) {
  // Capture the intrinsic render resolution after measurement, independently
  // from the responsive CSS size recorded during the timed window.
  await page.locator('canvas').evaluate((canvas) => {
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
  });
  const png = await page.locator('canvas').screenshot({ path, timeout: 15_000 });
  const content = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const sample = document.createElement('canvas');
    sample.width = 64;
    sample.height = 36;
    const context = sample.getContext('2d');
    context.drawImage(image, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    const colors = new Set();
    const luminance = [];
    let opaque = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      colors.add(`${pixels[offset] >> 4},${pixels[offset + 1] >> 4},${pixels[offset + 2] >> 4}`);
      luminance.push(0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2]);
      if (pixels[offset + 3] >= 250) opaque++;
    }
    const mean = luminance.reduce((sum, value) => sum + value, 0) / luminance.length;
    return {
      screenshotWidth: image.naturalWidth, screenshotHeight: image.naturalHeight,
      sampleWidth: sample.width, sampleHeight: sample.height,
      quantizedColorCount: colors.size, opaqueFraction: opaque / luminance.length,
      luminanceRange: Math.max(...luminance) - Math.min(...luminance),
      luminanceStandardDeviation: Math.sqrt(luminance.reduce((sum, value) => sum + (value - mean) ** 2, 0) / luminance.length),
    };
  }, png.toString('base64'));
  const passed = content.opaqueFraction > 0.99 && content.quantizedColorCount >= 4
    && content.luminanceRange >= 12 && content.luminanceStandardDeviation >= 2;
  return {
    passed, ...content,
    method: 'Browser-composited PNG sampled at 64×36; reject transparent, uniform, or near-uniform captures. This checks visible scene content, not a pixel-exact visual regression.',
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: npm run benchmark -- [--smoke | --sustained] [--duration seconds] [--warmup seconds] [--seed integer] [--instance-count integer] [--output external-directory] [--device-label label] [--renderer diffuse|raster|virtual] [--temporal on|off] [--debug-view view]');
    console.log('Virtual terrain: STRATA_BENCHMARK_ASSET_DIR=/external/cooked/root plus --manifest relative/manifest.json [--geometry-mode streamed|resident-lod|resident-full|mesh-lod] [--pool-mib 8] [--pixel-error 2] [--page-delay-ms 0] [--camera tour|coverage].');
    console.log('Default: headed Chrome, 720p + 1080p, 30s warmup and 60s capture per resolution. Sustained: 1080p, 30s warmup + 180s capture. Smoke timings are never performance evidence.');
    console.log('--require-ac-performance requires a confirmed macOS AC profile with Low Power Mode off. All measured sessions reject a detected power-profile change.');
    return;
  }
  const softwareGpu = process.env.STRATA_TEST_SOFTWARE_GPU === '1';
  if (!options.smoke && softwareGpu) throw new Error('Software GPU execution is restricted to --smoke functional validation.');
  if (!options.smoke && process.env.CI && !['0', 'false'].includes(process.env.CI.toLowerCase())) throw new Error('CI can run --smoke only; use a foreground hardware browser for performance evidence.');
  await stat(resolve(repository, 'packages/core/dist/index.js')).catch(() => { throw new Error('Run npm run build first.'); });
  await stat(resolve(repository, 'benchmarks/browser/app.js')).catch(() => { throw new Error('Run npm run build first to compile the benchmark application.'); });
  const directory = await outputDirectory(options.output);
  let geometryAsset;
  if (options.renderer === 'virtual') {
    const root = await realpath(resolve(process.env.STRATA_BENCHMARK_ASSET_DIR));
    const manifest = await realpath(resolve(root, options.manifest));
    if (!within(root, manifest) || isAbsolute(options.manifest)) throw new Error('--manifest must identify a file inside the external asset root.');
    const bytes = await readFile(manifest);
    geometryAsset = { manifestSha256: createHash('sha256').update(bytes).digest('hex'), source: JSON.parse(bytes).source };
  }
  const host = await hostMetadata();
  const [commit, gitChanges] = await Promise.all([
    command('git', ['rev-parse', 'HEAD']), command('git', ['status', '--porcelain']),
  ]);
  const source = { commit, dirty: gitChanges === null ? null : gitChanges.length > 0 };
  const mode = options.smoke ? 'smoke' : options.sustained ? 'sustained' : 'performance';
  const channel = options.smoke ? process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium' : 'chrome';
  const headed = !options.smoke || process.env.STRATA_TEST_HEADED === '1';
  const args = [];
  if (options.smoke) args.push('--enable-unsafe-webgpu');
  if (softwareGpu && platform() === 'linux') {
    args.push('--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface');
  } else if (softwareGpu) args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  let server;
  let browser;
  const report = { schemaVersion: 1, kind: 'strata-local-benchmark-session', createdAt: new Date().toISOString(), mode, host, source, browser: null, runs: [] };
  const reportPath = resolve(directory, 'report.json');
  const save = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  try {
    server = await createBenchmarkServer();
    browser = await chromium.launch({ channel, headless: !headed, args });
    report.browser = { version: browser.version(), channel, headed, softwareGpu, launchArguments: args };
    console.log(`${mode}: ${host.cpu}; ${channel} ${browser.version()}; ${headed ? 'headed' : 'headless'}; reports outside repository.`);
    if (options.smoke) console.log('Functional smoke validation only. These timings are not hardware-performance evidence.');
    const context = await browser.newContext({ viewport: { width: 1920, height: 1160 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.setDefaultTimeout(30_000);
    await page.goto(server.url);
    await page.bringToFront();
    await page.waitForFunction(() => globalThis.strataBenchmark?.ready === true);
    const adapter = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
      return adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter ?? null } : null;
    });
    if (!adapter) throw new Error('The browser has no WebGPU adapter. Performance runs require a supported installed Chrome and hardware driver.');
    if (!options.smoke && isSoftwareAdapter(adapter)) throw new Error('The selected adapter is software/fallback; refusing to record it as hardware performance.');
    const resolutions = options.sustained ? [[1920, 1080]] : [[1280, 720], [1920, 1080]];
    let sessionPower;
    for (const [width, height] of resolutions) {
      await page.bringToFront();
      if (await page.evaluate(() => document.visibilityState !== 'visible')) throw new Error('Benchmark tab must be visible.');
      const powerAtStart = await powerSnapshot();
      sessionPower = checkPower(powerAtStart, sessionPower, options.requireAcPerformance);
      console.log(`Power: ${sessionPower.source ?? 'unavailable'}; active Low Power Mode ${sessionPower.lowPowerMode ?? 'unavailable'}.`);
      const metadata = { host, source, browser: report.browser, powerAtStart, deviceLabel: options['device-label'] ?? null, ...(geometryAsset ? { geometryAsset } : {}) };
      const samples = [{ phase: 'before', ...powerAtStart }];
      let sampling = null;
      const start = Date.now();
      const interval = setInterval(() => {
        console.log(`${width}x${height}: ${Math.floor((Date.now() - start) / 1000)}s of ${options.warmup + options.duration}s warmup + capture.`);
        if (!sampling) sampling = powerSnapshot().then((sample) => samples.push({ phase: 'during', ...sample })).finally(() => { sampling = null; });
      }, 15_000);
      console.log(`${width}x${height}: warming ${options.warmup}s, measuring ${options.duration}s; keep this browser tab foreground.`);
      let result;
      try {
        result = await page.evaluate((runOptions) => globalThis.strataBenchmark.run(runOptions), {
          width, height, warmupSeconds: options.warmup, durationSeconds: options.duration,
          seed: options.seed, mode, metadata, renderer: options.renderer, temporal: options.temporal === 'on', debugView: options['debug-view'],
          ...(options['instance-count'] === undefined ? {} : { instanceCount: options['instance-count'] }),
          ...(options.renderer === 'virtual' ? {
            manifestUrl: `/external-assets/${options.manifest.split('/').map(encodeURIComponent).join('/')}`,
            geometryMode: options['geometry-mode'], poolBytes: options['pool-mib'] * 1024 ** 2,
            pixelError: options['pixel-error'], pageLoadDelayMs: options['page-delay-ms'], cameraMode: options.camera,
          } : {}),
        });
      } finally {
        clearInterval(interval);
        await sampling;
      }
      if (!options.smoke && isSoftwareAdapter(result.adapter)) throw new Error('Runtime selected a software/fallback adapter; refusing to record hardware performance.');
      if (result.allocations?.gpuErrorCount > 0) throw new Error(`The runtime reported ${result.allocations.gpuErrorCount} GPU error(s); this capture is invalid.`);
      if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
      samples.push({ phase: 'after', ...await powerSnapshot() });
      for (const sample of samples) checkPower(sample, sessionPower, options.requireAcPerformance);
      const captureFilename = `${width}x${height}.png`;
      // The measured window has completed. Capture a known camera time separately.
      await page.evaluate(() => globalThis.strataBenchmark.capture(0));
      const captureValidation = await captureEvidence(page, resolve(directory, captureFilename));
      result.runner = { powerSamples: samples, captureFilename, captureTimeSeconds: 0, captureValidation };
      report.runs.push(result);
      if (errors.length) throw new Error(`Browser errors during capture: ${errors.join('; ')}`);
      if (!captureValidation.passed) throw new Error(`The ${width}x${height} procedural scene capture is blank or lacks visible geometry; the failed image and measurements were retained locally.`);
      if (!result.frames?.length || !result.frames.every((frame) => frame.drawCalls > 0
        && (frame.triangles > 0 || (options.renderer === 'virtual' && frame.triangleCountSourceFrameId === null)))) throw new Error('The scene did not record geometry submissions or explicitly unavailable GPU counters.');
      validateBenchmarkReport(report);
      await save();
      console.log(`${width}x${height}: completed; ${samples.length} power/thermal observations and a deterministic capture recorded.`);
    }
    await context.close();
    validateBenchmarkReport(report);
    await save();
    console.log(`Saved local report: ${reportPath}`);
  } catch (error) {
    report.failure = error.message;
    await save();
    throw error;
  } finally {
    await browser?.close();
    await server?.close();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
