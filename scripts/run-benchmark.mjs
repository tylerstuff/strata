import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, homedir, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createBenchmarkServer } from './benchmark-server.mjs';
import { validateBenchmarkReport } from './validate-benchmark.mjs';
import { checkPower } from './benchmark-power.mjs';
import { newExternalDirectory, finalizeProofReport, proofHash } from './test-trace-updates.mjs';
import { assertTracePerformanceFrozen, frozenTraceRoute, loadTraceCorrectnessReceipt, loadTracePerformanceManifest,
  parseTracePerformanceArguments, prepareTracePerformance, TRACE_CAPTURE_TIMES, TRACE_PERFORMANCE_OPTIONS,
  TRACE_PERFORMANCE_RUNS, verifyTraceFile } from './trace-performance-bundles.mjs';
import { summarizeTracePerformance } from './summarize-trace-performance.mjs';

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArguments(args) {
  const options = { smoke: false, sustained: false, output: resolve(homedir(), 'Downloads/Strata-Benchmark-Results') };
  const numeric = new Set(['duration', 'warmup', 'seed', 'instance-count', 'pool-mib', 'pixel-error', 'page-delay-ms', 'probes-per-update', 'rays-per-probe', 'reflection-scale', 'reflection-rays', 'roughness', 'reflection-distance', 'reflection-update']);
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--smoke') options.smoke = true;
    else if (name === '--generated-fixture') options['generated-fixture'] = true;
    else if (name === '--require-ac-performance') options.requireAcPerformance = true;
    else if (name === '--sustained') options.sustained = true;
    else if (name === '--help') options.help = true;
    else if (numeric.has(name.slice(2)) || ['--output', '--device-label', '--renderer', '--temporal', '--debug-view', '--manifest', '--trace-proxy', '--terrain-color', '--geometry-mode', '--camera', '--gi', '--gi-scenario', '--reflections'].includes(name)) {
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
  if (options['generated-fixture'] && (!options.smoke || options.renderer !== 'integrated' || options.manifest || options['trace-proxy'])) {
    throw new Error('--generated-fixture requires --smoke --renderer integrated and no external source paths.');
  }
  options.temporal ??= 'on';
  options['debug-view'] ??= 'final';
  options['geometry-mode'] ??= 'streamed';
  options['pool-mib'] ??= options.renderer === 'integrated' ? 1 : 8;
  options['pixel-error'] ??= 2;
  options['page-delay-ms'] ??= 0;
  options.camera ??= options.renderer === 'reflections' ? 'receiver' : options.renderer === 'gi' ? 'overview' : 'tour';
  options.gi ??= 'on'; options['gi-scenario'] ??= options.renderer === 'integrated' ? 'integrated-tour' : options.renderer === 'reflections' ? 'static' : 'door-light'; options['probes-per-update'] ??= 32; options['rays-per-probe'] ??= 64;
  options['terrain-color'] ??= 'green';
  if (options.renderer === 'integrated' && options.manifest) options['trace-proxy'] ??= options.manifest.replace(/[^/]+$/, 'trace-proxy.json');
  options.reflections ??= 'world'; options['reflection-scale'] ??= 0.25; options['reflection-rays'] ??= 32768;
  options.roughness ??= 0.08; options['reflection-distance'] ??= 16; options['reflection-update'] ??= 1;
  if (!['diffuse', 'raster', 'virtual', 'gi', 'reflections', 'integrated'].includes(options.renderer) || !['on', 'off'].includes(options.temporal)
    || !['final', 'direct', 'shadow', 'depth', 'normal', 'motion', 'material', 'clusters', 'lod', 'residency', 'coverage', 'indirect', 'trace', 'probe-age', 'probe-irradiance', 'probe-visibility', 'reflections', 'reflection-source'].includes(options['debug-view'])) {
    throw new Error('Use --renderer diffuse|raster|virtual|gi|reflections|integrated, --temporal on|off and a supported --debug-view.');
  }
  if (!['streamed', 'resident-lod', 'resident-full', 'mesh-lod'].includes(options['geometry-mode'])
    || !(options.renderer === 'integrated' ? ['overview', 'receiver', 'tour', 'terrain-witness'] : (options.renderer === 'gi' || options.renderer === 'reflections') ? ['overview', 'receiver', 'tour'] : ['tour', 'coverage']).includes(options.camera)) throw new Error('Unknown geometry mode or camera.');
  if (!['on', 'off'].includes(options.gi) || !(options.renderer === 'integrated' ? ['integrated-tour'] : ['static', 'door-light']).includes(options['gi-scenario'])
    || !Number.isInteger(options['probes-per-update']) || options['probes-per-update'] < 1 || options['probes-per-update'] > 128
    || !Number.isInteger(options['rays-per-probe']) || options['rays-per-probe'] < 16 || options['rays-per-probe'] > 128) throw new Error('Invalid GI mode, scenario or probe/ray budget.');
  if (!['off', 'probe-only', 'world'].includes(options.reflections) || ![0.25, 0.5, 1].includes(options['reflection-scale'])
    || !Number.isInteger(options['reflection-rays']) || options['reflection-rays'] < 1 || options['reflection-rays'] > 131072
    || !Number.isFinite(options.roughness) || options.roughness < 0 || options.roughness > 0.35
    || !Number.isFinite(options['reflection-distance']) || options['reflection-distance'] < 1 || options['reflection-distance'] > 32
    || !Number.isInteger(options['reflection-update']) || options['reflection-update'] < 1 || options['reflection-update'] > 4) throw new Error('Invalid reflection mode, resolution, ray quota, roughness, distance or frequency.');
  if (!Number.isFinite(options['pool-mib']) || options['pool-mib'] < 0.0625 || !Number.isSafeInteger(options['pool-mib'] * 1024 ** 2)
    || !Number.isFinite(options['pixel-error']) || options['pixel-error'] <= 0 || options['pixel-error'] > 1000
    || !Number.isFinite(options['page-delay-ms']) || options['page-delay-ms'] < 0 || options['page-delay-ms'] > 60000) throw new Error('Invalid geometry pool, error or page delay.');
  if (['virtual', 'integrated'].includes(options.renderer) && !options['generated-fixture'] && (!options.manifest || !process.env.STRATA_BENCHMARK_ASSET_DIR)) throw new Error('Cooked benchmarks require --manifest relative/path/manifest.json and STRATA_BENCHMARK_ASSET_DIR pointing to the external cooked asset root.');
  if (options.renderer === 'integrated' && ((!options['generated-fixture'] && !options['trace-proxy']) || !['green', 'neutral'].includes(options['terrain-color']))) throw new Error('Integrated benchmarks require a trace proxy and green|neutral terrain color.');
  for (const name of ['duration', 'warmup', 'seed', 'instance-count']) {
    const value = options[name];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`--${name} must be a nonnegative finite number.`);
  }
  if (options.duration <= 0 || options.duration > 1800 || options.warmup > 600) throw new Error('Capture duration must be >0 and <=1800 seconds; warmup must be <=600 seconds.');
  for (const name of ['seed', 'instance-count']) if (options[name] !== undefined && !Number.isSafeInteger(options[name])) throw new Error(`--${name} must be an integer.`);
  if (options['instance-count'] === 0) throw new Error('--instance-count must be positive.');
  if (options.seed > 0xffff_ffff) throw new Error('--seed must be a uint32 integer (0–4294967295).');
  if (['gi', 'reflections', 'integrated'].includes(options.renderer) && options.seed !== 1337) throw new Error('The GI fixture uses fixed probe seed 1337.');
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

function isSoftwareAdapter(adapter) {
  return adapter?.isFallbackAdapter === true || /swiftshader|llvmpipe|software rasterizer|software adapter/i.test(JSON.stringify(adapter));
}

async function captureEvidence(page, path, timeoutMs) {
  // Capture the intrinsic render resolution after measurement, independently
  // from the responsive CSS size recorded during the timed window.
  await page.locator('canvas').evaluate((canvas) => {
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
  });
  const png = await page.locator('canvas').screenshot({ path, timeout: timeoutMs });
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

async function captureDiagnostics(page, browserErrors) {
  const diagnostics = { pageClosed: page.isClosed(), browserErrors: browserErrors.slice(-8) };
  if (diagnostics.pageClosed) return diagnostics;
  let timer;
  try {
    diagnostics.runtime = await Promise.race([
      page.evaluate(() => ({
        visibility: document.visibilityState,
        canvas: (() => { const canvas = document.querySelector('canvas'); return canvas ? { width: canvas.width, height: canvas.height } : null; })(),
        ...globalThis.strataBenchmark?.diagnostics?.(),
      })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser diagnostics did not respond within 2 seconds.')), 2000); }),
    ]);
  } catch (error) {
    diagnostics.error = error.message;
  } finally {
    clearTimeout(timer);
  }
  return diagnostics;
}

async function main() {
  if (process.argv.some(value => value === '--trace-prepare-only' || value === '--trace-performance')) {
    const args = parseTracePerformanceArguments(process.argv.slice(2));
    if (args['trace-prepare-only']) console.log(JSON.stringify(await prepareTracePerformance({ commit: args.commit, assetRoot: args['asset-root'], output: args.output }), null, 2));
    else await runTracePerformance(args);
    return;
  }
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: npm run benchmark -- [--smoke | --sustained] [--duration seconds] [--warmup seconds] [--seed integer] [--instance-count integer] [--output external-directory] [--device-label label] [--renderer diffuse|raster|virtual] [--temporal on|off] [--debug-view view]');
    console.log('Virtual terrain: STRATA_BENCHMARK_ASSET_DIR=/external/cooked/root plus --manifest relative/manifest.json [--geometry-mode streamed|resident-lod|resident-full|mesh-lod] [--pool-mib 8] [--pixel-error 2] [--page-delay-ms 0] [--camera tour|coverage].');
    console.log('World-space GI: --renderer gi [--gi on|off] [--gi-scenario door-light|static] [--probes-per-update 32] [--rays-per-probe 64] [--camera overview|receiver|tour].');
    console.log('Selective reflections: --renderer reflections [--reflections world|probe-only|off] [--reflection-scale 0.25|0.5|1] [--reflection-rays 32768] [--roughness 0..0.35] [--reflection-distance 1..32] [--reflection-update 1|2|3|4].');
    console.log('Integrated courtyard: --renderer integrated --manifest relative/manifest.json [--trace-proxy relative/trace-proxy.json] [--pool-mib 1] [--camera tour|receiver|overview|terrain-witness] [--terrain-color green|neutral]. Requires STRATA_BENCHMARK_ASSET_DIR; the fixed 60-second motion/door/light scenario is shared by every feature ablation.');
    console.log('CI functional smoke: --smoke --renderer integrated --generated-fixture cooks a fresh bounded temporary fixture without reading any external asset collection.');
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
  if (['virtual', 'integrated'].includes(options.renderer) && !options['generated-fixture']) {
    const root = await realpath(resolve(process.env.STRATA_BENCHMARK_ASSET_DIR));
    const manifest = await realpath(resolve(root, options.manifest));
    if (!within(root, manifest) || isAbsolute(options.manifest)) throw new Error('--manifest must identify a file inside the external asset root.');
    const bytes = await readFile(manifest);
    geometryAsset = { manifestSha256: createHash('sha256').update(bytes).digest('hex'), source: JSON.parse(bytes).source };
    if (options.renderer === 'integrated') {
      const path = await realpath(resolve(root, options['trace-proxy']));
      if (!within(root, path) || isAbsolute(options['trace-proxy'])) throw new Error('--trace-proxy must identify a file inside the external asset root.');
      const proxyBytes = await readFile(path);
      geometryAsset.traceProxy = { manifestSha256: createHash('sha256').update(proxyBytes).digest('hex'), ...JSON.parse(proxyBytes) };
    }
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
  let generatedRoot;
  let generatedProxy;
  const report = { schemaVersion: 1, kind: 'strata-local-benchmark-session', createdAt: new Date().toISOString(), mode, host, source, browser: null, runs: [] };
  const reportPath = resolve(directory, 'report.json');
  const save = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  try {
    if (options['generated-fixture']) {
      generatedRoot = await mkdtemp(resolve(tmpdir(), 'strata-benchmark-courtyard-'));
      await exec('cargo', ['run', '--package', 'strata-geometry-cooker', '--release', '--locked', '--',
        '--seed', '1337', '--tiles', '4', '--cells', '64', '--trace-proxy', '--output', generatedRoot],
      { cwd: repository, timeout: 120_000, maxBuffer: 1024 * 1024 });
      const sourceBytes = await readFile(resolve(generatedRoot, 'manifest.json'));
      const proxyJson = await readFile(resolve(generatedRoot, 'trace-proxy.json'));
      generatedProxy = { json: proxyJson, binary: await readFile(resolve(generatedRoot, 'trace-proxy.bin')) };
      geometryAsset = { manifestSha256: createHash('sha256').update(sourceBytes).digest('hex'), source: JSON.parse(sourceBytes).source,
        traceProxy: { manifestSha256: createHash('sha256').update(proxyJson).digest('hex'), ...JSON.parse(proxyJson) } };
    }
    server = await createBenchmarkServer(generatedRoot ? { assetRoot: '', proceduralRoot: generatedRoot } : {});
    browser = await chromium.launch({ channel, headless: !headed, args });
    report.browser = { version: browser.version(), channel, headed, softwareGpu, launchArguments: args };
    console.log(`${mode}: ${host.cpu}; ${channel} ${browser.version()}; ${headed ? 'headed' : 'headless'}; reports outside repository.`);
    if (options.smoke) console.log('Functional smoke validation only. These timings are not hardware-performance evidence.');
    const context = await browser.newContext({ viewport: { width: 1920, height: 1160 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    if (generatedProxy) {
      // Only these two files from this invocation's fresh cooker output bypass
      // the procedural page allowlist. External asset roots remain forbidden in CI.
      await page.route(`${server.url}/procedural-assets/trace-proxy.json`, route => route.fulfill({ contentType: 'application/json', body: generatedProxy.json }));
      await page.route(`${server.url}/procedural-assets/trace-proxy.bin`, route => route.fulfill({ contentType: 'application/octet-stream', body: generatedProxy.binary }));
    }
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('crash', () => errors.push('The benchmark browser page crashed.'));
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
          ...(['virtual', 'integrated'].includes(options.renderer) ? {
            manifestUrl: generatedRoot ? '/procedural-assets/manifest.json' : `/external-assets/${options.manifest.split('/').map(encodeURIComponent).join('/')}`,
            geometryMode: options['geometry-mode'], poolBytes: options['pool-mib'] * 1024 ** 2,
            pixelError: options['pixel-error'], pageLoadDelayMs: options['page-delay-ms'], cameraMode: options.camera,
          } : {}),
          ...(options.renderer === 'integrated' ? { traceProxyUrl: generatedRoot ? '/procedural-assets/trace-proxy.json' : `/external-assets/${options['trace-proxy'].split('/').map(encodeURIComponent).join('/')}`, terrainColor: options['terrain-color'] } : {}),
          ...(['gi', 'reflections', 'integrated'].includes(options.renderer) ? { giEnabled: options.gi === 'on', giScenario: options['gi-scenario'],
            probesPerUpdate: options['probes-per-update'], raysPerProbe: options['rays-per-probe'], cameraMode: options.camera } : {}),
          ...(['reflections', 'integrated'].includes(options.renderer) ? { reflectionMode: options.reflections, reflectionResolutionScale: options['reflection-scale'],
            reflectionMaxRays: options['reflection-rays'], reflectionRoughness: options.roughness, reflectionMaxDistance: options['reflection-distance'], reflectionUpdateEvery: options['reflection-update'] } : {}),
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
      // Retain the completed measurements even if a later queue fence or
      // browser compositor screenshot fails. A failure is never a valid run.
      report.runs.push(result);
      // The measured window has completed. Capture a known camera time separately.
      let captureState;
      let captureValidation;
      try {
        captureState = await page.evaluate(() => globalThis.strataBenchmark.capture(0));
        // Software smoke runs can drain substantial queued work and need a
        // longer compositor deadline; this never changes measured frame data.
        captureValidation = await captureEvidence(page, resolve(directory, captureFilename), options.smoke ? 120_000 : 15_000);
      } catch (error) {
        const diagnostics = await captureDiagnostics(page, errors);
        result.runner = { powerSamples: samples, captureFilename, captureTimeSeconds: 0,
          captureFailure: { message: error.message, diagnostics } };
        throw new Error(`The ${width}x${height} post-measurement capture failed: ${error.message}\nCapture diagnostics: ${JSON.stringify(diagnostics)}`, { cause: error });
      }
      result.runner = { powerSamples: samples, captureFilename, captureTimeSeconds: 0, captureValidation, ...captureState };
      if (errors.length) throw new Error(`Browser errors during capture: ${errors.join('; ')}`);
      if (!captureValidation.passed) throw new Error(`The ${width}x${height} procedural scene capture is blank or lacks visible geometry; the failed image and measurements were retained locally.`);
      if (!result.frames?.length || !result.frames.every((frame) => frame.drawCalls > 0
        && (frame.triangles > 0 || (['virtual', 'integrated'].includes(options.renderer) && frame.triangleCountSourceFrameId === null)))) throw new Error('The scene did not record geometry submissions or explicitly unavailable GPU counters.');
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
    const cleanup = await Promise.allSettled([browser?.close(), server?.close(),
      generatedRoot ? rm(generatedRoot, { recursive: true, force: true }) : undefined]);
    const failed = cleanup.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}

const bounded = async (promise, label, milliseconds = 30000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} exceeded ${milliseconds} ms.`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
};

export function assertTracePower(snapshot, expected) {
  const profile = checkPower(snapshot, expected);
  if (!['AC Power', 'Battery Power'].includes(profile.source) || ![0, 1].includes(profile.lowPowerMode)) throw Error('This matched capture requires an observed power source and active Low Power Mode profile.');
  const thermal = snapshot.thermal;
  if (!thermal || thermal.noThermalWarningRecorded !== true || thermal.noPerformanceWarningRecorded !== true
    || ['CPU_Scheduler_Limit', 'CPU_Speed_Limit', 'GPU_Speed_Limit'].some(key => thermal.limits[key] !== undefined && thermal.limits[key] < 100)
    || (thermal.limits.Thermal_Level ?? 0) > 0) throw Error('Thermal/power indicators are unavailable or report a warning/limit; preserve this unmatched comparison for review.');
  return profile;
}
/** Validate completed measured data while this run's later image evidence is still pending. */
export function validatePendingTraceRun(report) {
  const runs = report.runs.map((run, index) => {
    if (index !== report.runs.length - 1) return run;
    const { runner: _pendingImages, ...measured } = run; return measured;
  });
  validateBenchmarkReport({ ...report, runs });
}
export function completeTraceCaptureRecord(record) {
  if (record.captures.length !== TRACE_CAPTURE_TIMES.length || record.captures.some((capture, i) =>
    capture.timeSeconds !== TRACE_CAPTURE_TIMES[i] || capture.settleFrames !== 240 || capture.status !== 'complete'
    || capture.admissionRequired !== (i === 0) || typeof capture.validation?.passed !== 'boolean'
    || (i === 0 && capture.validation.passed !== true) || !/^[a-f0-9]{64}$/.test(capture.sha256 ?? '')
    || !Number.isSafeInteger(capture.bytes) || capture.bytes < 24 || typeof capture.filename !== 'string' || !capture.filename.endsWith('.png')
    || capture.validation.screenshotWidth !== record.width || capture.validation.screenshotHeight !== record.height)) {
    throw Error('All five frozen captures must be complete with matching dimensions/time/settle count/hash; t0 must pass the original nonblank gate.');
  }
  const first = record.captures[0];
  // Existing validator/tooling keeps its representative t0 fields; the full series remains explicit.
  record.captureValidation = first.validation; record.captureFilename = first.filename;
  record.captureTimeSeconds = first.timeSeconds; record.settleFrames = first.settleFrames;
}
/** Watchdog closes the actual browser on expiry; it never abandons a live GPU work promise. */
export async function withTracePerformanceDeadline(work, forceTeardown, milliseconds) {
  const ends = Date.now() + milliseconds;
  let expired = false, teardown, teardownError;
  const deadlineError = Error(`Frozen GPU window exceeded ${milliseconds} ms; forced browser teardown.`);
  const expire = () => {
    if (expired) return;
    expired = true;
    teardown = Promise.resolve().then(forceTeardown).catch(error => { teardownError = error; });
  };
  const live = () => { if (Date.now() >= ends) expire(); if (expired) throw deadlineError; };
  const timer = setTimeout(expire, milliseconds);
  try { const result = await work(live); live(); return result; }
  catch (error) { throw expired ? deadlineError : error; }
  finally {
    clearTimeout(timer); await teardown;
    if (teardownError) throw Error(`${deadlineError.message} Teardown failed: ${teardownError.message}`, { cause: teardownError });
  }
}

/** The ordinary browser RAF/render/reset loop is reused without instrumentation. */
async function runTracePerformance(args) {
  if (process.env.STRATA_TEST_SOFTWARE_GPU === '1' || (process.env.CI && !['0', 'false'].includes(process.env.CI.toLowerCase()))) {
    throw Error('The frozen trace comparison requires a local headed hardware session.');
  }
  const frozen = await loadTracePerformanceManifest({ manifestPath: args.manifest, manifestSha256: args['manifest-sha256'] });
  const firstGuard = await assertTracePerformanceFrozen(frozen);
  const receipt = await loadTraceCorrectnessReceipt(args, frozen.manifest);
  // Guard canonical ancestors, including other worktrees. Source assets stay read-only.
  const destination = await canonicalDestination(resolve(args.output));
  if (within(frozen.manifest.assets.root, destination) || within(frozen.directory, destination)) throw Error('Capture output must be separate from assets and frozen preparation.');
  const directory = await newExternalDirectory(destination);
  const source = { commit: frozen.manifest.source.commit, tree: frozen.manifest.source.tree, dirty: false };
  const report = { schemaVersion: 1, kind: 'strata-local-benchmark-session', comparisonKind: 'strata-trace-maintenance-performance',
    createdAt: new Date().toISOString(), mode: 'performance', status: 'running', host: null, source, browser: null,
    frozen: { manifestPath: frozen.manifestPath, manifestSha256: frozen.manifestSha256, source: frozen.manifest.source,
      control: frozen.manifest.control, bundles: frozen.manifest.bundles, assets: frozen.manifest.assets },
    correctnessReceipt: receipt, expectedRuns: TRACE_PERFORMANCE_RUNS, options: TRACE_PERFORMANCE_OPTIONS, gpuDeadlineMs: frozen.manifest.gpuDeadlineMs,
    runs: [], browserErrors: [], requestFailures: [], guardChecks: [{ phase: 'admission', ...firstGuard }], cleanup: {} };
  let server, browser, context, page, powerProfile;
  const checkFrozen = async phase => {
    const guard = await assertTracePerformanceFrozen(frozen);
    await verifyTraceFile(receipt.report.path, receipt.report); await verifyTraceFile(receipt.manifest.path, receipt.manifest);
    report.guardChecks.push({ phase, ...guard });
  };
  const errorCount = () => { if (report.browserErrors.length) throw Error(`Browser errors: ${report.browserErrors.join('; ')}`); };
  try {
    report.host = await hostMetadata(); // Once, outside every warmup/capture.
    server = await createBenchmarkServer({ assetRoot: frozen.manifest.assets.root });
    await withTracePerformanceDeadline(async live => {
      live();
      browser = await chromium.launch({ channel: 'chrome', headless: false, args: [], timeout: 30000 });
      report.browser = { version: browser.version(), channel: 'chrome', headed: true, softwareGpu: false, launchArguments: [] };
      console.log(`Frozen trace maintenance comparison: ${source.commit}; ${directory}`);
      for (const [index, spec] of TRACE_PERFORMANCE_RUNS.entries()) {
        live();
        await checkFrozen(`run-${index}-before`);
        live();
        const name = `${index + 1}-${spec.arm}-${spec.width}x${spec.height}`;
        const record = { index, ...spec, loaded: [], powerSamples: [], captures: [], cleanup: null };
        const artifacts = new Map(), served = new Map();
        // Package bytes are read and checked once BEFORE timing. Route handling never hashes.
        for (const item of [...frozen.manifest.app.files, ...frozen.manifest.bundles[spec.arm].files]) {
          artifacts.set(item.name, await verifyTraceFile(resolve(frozen.directory, item.name), item));
        }
        let disposed = false, closing = false, result;
        live();
        context = await browser.newContext({ viewport: { width: 1920, height: 1160 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin === server.url && url.pathname === '/favicon.ico' && !url.search) return route.fulfill({ status: 204 });
          const item = url.origin === server.url && !url.search && !url.hash ? frozenTraceRoute(frozen.manifest, spec.arm, url.pathname) : null;
          if (!item || !['GET', 'HEAD'].includes(route.request().method())) {
            report.browserErrors.push(`Unfrozen route in ${name}: ${route.request().url()}`); return route.abort('blockedbyclient');
          }
          const entry = served.get(item.url) ?? { url: item.url, kind: item.kind, sha256: item.sha256, bytes: item.bytes, requests: 0 };
          entry.requests++; served.set(item.url, entry);
          if (item.kind === 'asset') return route.continue(); // Original benchmark server/page fetching behavior.
          const contentType = item.url.endsWith('.wasm') ? 'application/wasm' : item.url.endsWith('.map') ? 'application/json' : item.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8';
          return route.fulfill({ status: 200, contentType, headers: { 'Cache-Control': 'no-store' }, body: artifacts.get(item.name) });
        });
        context.on('requestfailed', request => {
          const failure = { run: name, url: request.url(), error: request.failure()?.errorText ?? null,
            expectedAbort: (closing || (request.url().includes('/external-assets/') && request.failure()?.errorText === 'net::ERR_ABORTED')) };
          report.requestFailures.push(failure);
          if (!failure.expectedAbort) report.browserErrors.push(`Request failed: ${failure.url}: ${failure.error}`);
        });
        context.on('response', response => { if (response.status() >= 400) report.browserErrors.push(`HTTP ${response.status()} ${response.url()}`); });
        context.on('page', p => {
          p.on('pageerror', error => report.browserErrors.push(`${name}: ${error.message}`));
          p.on('crash', () => report.browserErrors.push(`${name}: page crashed`));
          p.on('console', message => { if (message.type() === 'error') report.browserErrors.push(`${name}: ${message.text()}`); });
        });
        try {
          live();
          page = await context.newPage(); page.setDefaultTimeout(30000);
          await page.goto(server.url); await page.bringToFront();
          await page.waitForFunction(() => globalThis.strataBenchmark?.ready === true);
          if (await page.evaluate(() => document.visibilityState !== 'visible')) throw Error('The hardware tab must be visible.');
          record.preflightAdapter = await bounded(page.evaluate(async () => {
            const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
            return adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device,
              description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter ?? null } : null;
          }), 'Hardware adapter admission');
          if (record.preflightAdapter?.isFallbackAdapter !== false || isSoftwareAdapter(record.preflightAdapter)) throw Error('Hardware adapter admission failed before warmup.');
          const startPower = await powerSnapshot(); record.powerSamples.push({ phase: 'before', ...startPower });
          powerProfile = assertTracePower(startPower, powerProfile);
          const metadata = { traceMaintenanceArm: spec.arm, traceMaintenanceRunIndex: index, source, host: report.host, browser: report.browser,
            manifestSha256: frozen.manifestSha256, powerAtStart: startPower, geometryAsset: frozen.manifest.assets.geometryAsset };
          let sampling, samplingError;
          const interval = setInterval(() => {
            console.log(`${name}: measuring/warming; ${record.powerSamples.length} power observations.`);
            if (!sampling) sampling = powerSnapshot().then(sample => {
              record.powerSamples.push({ phase: 'during', ...sample });
              try { assertTracePower(sample, powerProfile); } catch (error) { samplingError ??= error; }
            }).catch(error => { samplingError ??= error; }).finally(() => { sampling = null; });
          }, 15000);
          try {
            result = await bounded(page.evaluate(options => globalThis.strataBenchmark.run(options),
              { ...TRACE_PERFORMANCE_OPTIONS, width: spec.width, height: spec.height, metadata }), 'Warmup, capture and existing timing drain', 150000);
          } finally { clearInterval(interval); await sampling; }
          result.runner = record; report.runs.push(result); // Preserve all completed raw frames before later gates/captures.
          record.powerSamples.push({ phase: 'after', ...await powerSnapshot() });
          for (const sample of record.powerSamples) assertTracePower(sample, powerProfile);
          if (samplingError) throw samplingError;
          if (result.adapter?.isFallbackAdapter !== false || isSoftwareAdapter(result.adapter)) throw Error('Runtime did not positively identify a hardware adapter.');
          if (result.allocations?.gpuErrorCount !== 0) throw Error('GPU errors were reported during the capture.');
          for (const url of ['/packages/core/dist/index.js', '/packages/core/dist/worker.js', '/packages/core/dist/strata_runtime.wasm', ...frozen.manifest.bundles[spec.arm].updaterOutputs]) {
            if (!served.has(url)) throw Error(`Required frozen runtime artifact was not requested: ${url}`);
          }
          if (result.assetTraffic?.giAtCaptureStart?.traceMetadataBytes !== (spec.arm === 'incremental' ? 150801 : 187185)) {
            throw Error('The actual maintenance metadata allocation differs from the selected canonical arm.');
          }
          errorCount(); validatePendingTraceRun(report);
          for (const timeSeconds of TRACE_CAPTURE_TIMES) {
            live();
            const capture = { timeSeconds, filename: `${name}-t${timeSeconds}.png`, debugView: 'final', temporal: true, admissionRequired: timeSeconds === 0,
              brightnessScope: timeSeconds === 0 ? 'original nonblank admission gate' : 'diagnostic only; sun is intentionally off at t16',
              method: 'existing held-time capture from reset; one reset submission followed by 240 held submissions, then waitForIdle; outside timing' };
            record.captures.push(capture);
            Object.assign(capture, await bounded(page.evaluate(time => globalThis.strataBenchmark.capture(time), timeSeconds), 'Post-timing held capture', 60000));
            if (capture.settleFrames !== 240) throw Error('Held screenshot submission count differs from the frozen comparison.');
            capture.validation = await captureEvidence(page, resolve(directory, capture.filename), 15000);
            Object.assign(capture, await fileRecordForCapture(directory, capture.filename));
            capture.status = 'complete';
            if (capture.admissionRequired && !capture.validation.passed) throw Error(`Post-timing t0 image is blank: ${capture.filename}`);
          }
          completeTraceCaptureRecord(record); validateBenchmarkReport(report);
          errorCount();
        } finally {
          record.loaded = [...served.values()];
          if (page && !page.isClosed()) {
            try {
              record.cleanup = await bounded(page.evaluate(() => { globalThis.strataBenchmark.dispose(); return globalThis.strataBenchmark.diagnostics(); }), 'Explicit engine disposal', 15000);
              const telemetry = record.cleanup.telemetry;
              disposed = telemetry?.allocatedGpuBufferBytes === 0 && telemetry?.allocatedGpuTextureBytes === 0 && telemetry?.wasmMemoryBytes === 0 && telemetry?.gpuErrorCount === 0;
            } catch (error) { report.browserErrors.push(`${name}: disposal failed: ${error.message}`); }
          }
          if (!disposed) report.browserErrors.push(`${name}: explicit disposal did not establish zero buffers/textures/WASM and zero GPU errors.`);
          record.explicitDisposalPassed = disposed; closing = true;
          try { await bounded(context.close(), 'Fresh context cleanup'); } finally { context = undefined; page = undefined; }
          if (result) {
            const runBytes = `${JSON.stringify(result)}\n`; const filename = `${name}.json`;
            await writeFile(resolve(directory, filename), runBytes, { flag: 'wx' });
            record.resultArtifact = { filename, bytes: Buffer.byteLength(runBytes), sha256: proofHash(runBytes) };
          } else { report.failedRun = record; }
        }
        errorCount(); await checkFrozen(`run-${index}-after`);
        console.log(`${name}: captured, five held-time images archived, engine and fresh context closed.`);
      }
      validateBenchmarkReport(report);
      report.summary = summarizeTracePerformance(report, receipt.canonicalUpdate ? { canonicalUpdate: receipt.canonicalUpdate } : {});
      live();
      await bounded(browser.close(), 'Completed comparison browser cleanup');
      live();
      report.status = 'pass';
    }, async () => {
      report.deadlineExpiredAt = new Date().toISOString();
      await bounded(browser?.close(), 'Deadline-forced browser teardown');
      report.deadlineBrowserClosed = true;
    }, frozen.manifest.gpuDeadlineMs);
  } catch (error) { report.status = 'fail'; report.failure = { message: error.message, stack: error.stack }; }
  finally {
    await finalizeProofReport(report, directory, async () => {
      const cleanup = await Promise.allSettled([bounded(context?.close(), 'Context cleanup'), bounded(browser?.close(), 'Browser cleanup'), bounded(server?.close(), 'Server cleanup')]);
      report.cleanup = Object.fromEntries(['context', 'browser', 'server'].map((key, i) => [key, { status: cleanup[i].status,
        ...(cleanup[i].status === 'rejected' ? { error: String(cleanup[i].reason) } : {}) }]));
      if (cleanup.some(item => item.status === 'rejected')) throw Error('Comparison teardown failed.');
      await checkFrozen('after-all-teardown');
    });
  }
  console.log(`Trace comparison ${report.status}: ${resolve(directory, 'report.json')}`);
  if (report.status !== 'pass') throw Error(report.failure?.message ?? report.finalizationFailure ?? 'Trace comparison failed.');
}

async function fileRecordForCapture(directory, filename) {
  const bytes = await readFile(resolve(directory, filename)); return { bytes: bytes.byteLength, sha256: proofHash(bytes) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
