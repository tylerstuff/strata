import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createBenchmarkServer } from './benchmark-server.mjs';

const command = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Use --prepare-only --asset-root PATH --rays PATH --output NEW_EXTERNAL_DIR [--allow-dirty-draft], or --run --manifest PATH --manifest-sha256 SHA --output NEW_EXTERNAL_DIR --adapter hardware|software.';
export const traceProofInputs = Object.freeze({
  'manifest.json': '818d7d020a608d59e83b334b1737ac655de545986e5a8a7494d76910a09c86ca',
  'trace-proxy.json': 'e5341ca032a49c21591f3a47029c301ad0325e6abdde3bb1542f2e6e5cbee47c',
  'trace-proxy.bin': '84f04ccba50710badebe35de421b29bf830a113f6bfad65a18549ddea4afd3c4',
  'rays.bin': '95540b1eaeb1468a89c622cab00f87e07d544c2bf55d4f432e076a24f26e06d7',
});
export const proofHash = bytes => createHash('sha256').update(bytes).digest('hex');
async function bounded(operation, label, milliseconds = 10000) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} deadline exceeded.`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const json = value => `${JSON.stringify(value, null, 2)}\n`;
export const proofInputJson = value => JSON.stringify(value, (_key, item) => Object.is(item, -0) ? { $strataF32: '-0' } : item);
export const parseProofInputJson = text => JSON.parse(text, (_key, item) => item && typeof item === 'object'
  && Object.keys(item).length === 1 && item.$strataF32 === '-0' ? -0 : item);
const within = (root, path) => { const p = relative(root, path); return p === '' || (!isAbsolute(p) && p !== '..' && !p.startsWith(`..${sep}`)); };
export function parseProofArguments(args) {
  const flags = new Set(['--prepare-only', '--run', '--allow-dirty-draft']);
  const values = new Set(['--asset-root', '--rays', '--output', '--manifest', '--manifest-sha256', '--adapter']);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    assert(!Object.hasOwn(result, key), `Duplicate ${key}. ${usage}`);
    if (flags.has(key)) result[key] = true;
    else {
      assert(values.has(key) && args[i + 1] && !args[i + 1].startsWith('--'), usage);
      result[key] = args[++i];
    }
  }
  const prepare = result['--prepare-only'] === true;
  assert(prepare !== (result['--run'] === true), usage);
  const required = prepare ? ['--asset-root', '--rays', '--output'] : ['--manifest', '--manifest-sha256', '--output', '--adapter'];
  const allowed = new Set([...required, prepare ? '--prepare-only' : '--run', ...(prepare ? ['--allow-dirty-draft'] : [])]);
  assert(required.every(key => typeof result[key] === 'string') && Object.keys(result).every(key => allowed.has(key)), usage);
  if (!prepare) {
    assert(/^[a-f0-9]{64}$/.test(result['--manifest-sha256']), 'The independently reviewed manifest SHA-256 is required.');
    assert(['hardware', 'software'].includes(result['--adapter']), usage);
  }
  return result;
}

export function decodeProofRays(input) {
  assert.equal(input.byteLength, 512 * 32, 'Frozen ray ABI must contain all 512 records.');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  return Array.from({ length: 512 }, (_, id) => {
    const at = (n) => view.getFloat32(id * 32 + n * 4, true);
    const ray = { origin: [at(0), at(1), at(2)], tMin: at(3), direction: [at(4), at(5), at(6)], tMax: at(7) };
    assert([...ray.origin, ...ray.direction, ray.tMin, ray.tMax].every(Number.isFinite), `Non-finite ray ${id}.`);
    // Preserve original f32 words: in particular, do not normalize directions.
    return ray;
  });
}

async function sourceState() {
  const git = async (...args) => (await command('git', ['-C', repository, ...args])).stdout.trim();
  return { root: repository, commit: await git('rev-parse', 'HEAD'), tree: await git('rev-parse', 'HEAD^{tree}'),
    status: await git('status', '--porcelain'), trackedDiffSha256: proofHash(await git('diff', 'HEAD')) };
}
async function newExternalDirectory(path) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const parent = await realpath(dirname(target)), canonicalRepo = await realpath(repository);
  assert(!within(canonicalRepo, resolve(parent, target.split(sep).at(-1))), 'Proof artifacts must remain outside the repository.');
  await mkdir(target); // Existing evidence is never overwritten.
  return realpath(target);
}
async function frozenFile(path, expected) {
  const bytes = await readFile(path);
  assert.equal(proofHash(bytes), expected, `Frozen input hash differs: ${path}`);
  return bytes;
}
async function externalAssets(assetRoot) {
  const root = await realpath(resolve(assetRoot)), canonicalRepo = await realpath(repository);
  assert(!within(canonicalRepo, root) && !within(root, canonicalRepo), 'Asset root must remain outside the repository.');
  assert((await stat(root)).isDirectory());
  const files = [];
  for (const name of ['manifest.json', 'trace-proxy.json', 'trace-proxy.bin']) {
    const path = await realpath(resolve(root, name)); assert(within(root, path), 'External asset symlink escapes its root.');
    const bytes = await frozenFile(path, traceProofInputs[name]);
    files.push({ name, bytes: bytes.byteLength, sha256: proofHash(bytes) });
  }
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  for (const page of manifest.pages) {
    assert(/^pages\/\d{6}\.bin$/.test(page.url), 'Unexpected canonical page path.');
    const path = await realpath(resolve(root, page.url)); assert(within(root, path), 'External page symlink escapes its root.');
    const bytes = await frozenFile(path, page.sha256); assert.equal(bytes.byteLength, page.byteLength);
    files.push({ name: page.url, bytes: bytes.byteLength, sha256: page.sha256 });
  }
  return { root, files };
}

async function bundle(entry, output, name, substituteFull = false) {
  const modules = {}, substitutions = [];
  const production = resolve(repository, 'packages/core/src/gi/trace-updates.ts');
  const helper = resolve(repository, 'tests/helpers/full-trace-updater.ts');
  const result = await build({ absWorkingDir: repository, ...(typeof entry === 'string' ? { entryPoints: [entry] } : { stdin: entry }),
    outfile: resolve(output, name), bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    sourcemap: 'external', sourcesContent: true, metafile: true,
    plugins: [{ name: 'frozen-explicit-diagnostic-control', setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
        const actual = substituteFull && path === production ? helper : path;
        const contents = await readFile(actual, 'utf8');
        modules[relative(repository, actual)] = proofHash(contents);
        if (actual !== path) substitutions.push({ requested: relative(repository, path), actual: relative(repository, actual), sha256: proofHash(contents) });
        return { contents, loader: 'ts', resolveDir: dirname(actual) };
      });
    } }],
  });
  assert.equal(substitutions.length, substituteFull ? 1 : 0, 'Only the explicit full renderer bundle may replace the updater.');
  const files = [];
  for (const file of result.outputFiles) {
    await writeFile(file.path, file.contents, { flag: 'wx' });
    files.push({ name: relative(output, file.path), bytes: file.contents.byteLength, sha256: proofHash(file.contents) });
  }
  return { entry: typeof entry === 'string' ? entry : entry.sourcefile, modules, substitutions, files,
    performanceEligible: false };
}

/** CPU descriptor collection only: no browser, native adapter or GPU resource. */
async function collectShaderSources(api, stageA, stageB) {
  const sources = { directQuery: stageA.traceWriteQueryShader, diagnosticStorage: stageB.rendererProofReadStorageShader,
    probeTrace: api.probeTraceShader(), probeUpdate: api.probeUpdateShader,
    reflectionTrace: api.reflectionTraceShader, reflectionResolve: api.reflectionResolveShader,
    geometrySelection: api.geometrySelectionShader, presentation: api.presentationShader, temporal: api.temporalShader };
  const owned = new Set();
  const fake = { limits: { maxBufferSize: 1 << 28 }, queue: { writeBuffer() {} },
    createBuffer(descriptor) { const result = { ...descriptor, destroy() { owned.delete(result); } }; owned.add(result); return result; },
    createBindGroupLayout: descriptor => descriptor, createPipelineLayout: descriptor => descriptor,
    createBindGroup: descriptor => descriptor, createComputePipelineAsync: async descriptor => descriptor,
    createShaderModule(descriptor) { sources[descriptor.label] = descriptor.code; return descriptor; } };
  const scene = api.createIntegratedScene();
  const room = new api.RoomGeometry(fake, api.createGiScene(), 'receiver');
  const reflection = new api.ReflectionGeometry(fake, scene);
  const terrain = new api.TerrainRendering(fake, { transform: api.integratedTerrainTransform,
    shading: 'lambert', albedo: scene.materials[5].albedo, light: scene.light });
  try {
    sources.roomRaster = api.rasterShader + room.shaderSource;
    sources.reflectionRaster = api.rasterShader + reflection.shaderSource;
    sources.terrainRaster = api.rasterShader + api.geometryVertexShader + terrain.shader(5);
    const gi = await api.GiComposer.create(fake, []); gi.dispose();
    const specular = await api.ReflectionComposer.create(fake, [], {}); specular.dispose();
  } finally { room.dispose(); reflection.dispose(); terrain.dispose(); }
  assert.equal(owned.size, 0, 'CPU shader descriptor collection leaked fake resources.');
  assert(Object.values(sources).every(value => typeof value === 'string' && value.length > 0));
  return sources;
}

export async function prepareProof(args) {
  const before = await sourceState();
  assert(!before.status || args['--allow-dirty-draft'], 'Freeze a clean harness commit, or explicitly create a non-runnable dirty draft.');
  const output = await newExternalDirectory(args['--output']);
  const assets = await externalAssets(args['--asset-root']);
  const rayPath = await realpath(resolve(args['--rays']));
  const rayBytes = await frozenFile(rayPath, traceProofInputs['rays.bin']);
  const rays = decodeProofRays(rayBytes);
  const direct = await bundle({ contents: `
    export * from './tests/browser/trace-update-write-validation.ts';
    export { assertCompletedProofStage, finishProofDevice } from './tests/browser/trace-update-proof-gpu.ts';
  `, resolveDir: repository, sourcefile: 'direct-proof-entry.ts', loader: 'ts' }, output, 'direct.mjs');
  const candidate = await bundle('tests/browser/trace-update-renderer-validation.ts', output, 'candidate.mjs');
  const full = await bundle('tests/browser/trace-update-renderer-validation.ts', output, 'full-correctness-only.mjs', true);
  for (const [path, sha] of Object.entries(candidate.modules)) {
    if (path !== 'packages/core/src/gi/trace-updates.ts') assert.equal(full.modules[path], sha, `Renderer arm module changed: ${path}`);
  }
  const cpu = await bundle({ contents: `
    export { parseGeometryManifest } from './packages/core/src/geometry/format.ts';
    export { parseTraceProxyManifest, validateTraceProxy } from './packages/core/src/geometry/trace-proxy.ts';
    export { packGiRays, giTraceStrides } from './packages/core/src/gi/trace-data.ts';
    export { createIntegratedScene } from './packages/core/src/integrated/integrated-scene.ts';
    export { bruteUpdateOracle, referenceUpdateTriangles, updateOracleGates } from './tests/helpers/gi-trace-update-reference.ts';
    export { createGiScene } from './packages/core/src/gi/scene-data.ts';
    export { RoomGeometry } from './packages/core/src/gi/room-geometry.ts';
    export { ReflectionGeometry } from './packages/core/src/reflections/reflection-geometry.ts';
    export { TerrainRendering } from './packages/core/src/geometry/terrain-rendering.ts';
    export { integratedTerrainTransform } from './packages/core/src/geometry/trace-proxy.ts';
    export { GiComposer } from './packages/core/src/gi/gi-composer.ts';
    export { ReflectionComposer } from './packages/core/src/reflections/reflection-composer.ts';
    export { probeTraceShader, probeUpdateShader } from './packages/core/src/gi/probe-cache-shaders.ts';
    export { reflectionTraceShader, reflectionResolveShader } from './packages/core/src/reflections/reflection-shaders.ts';
    export { geometrySelectionShader, geometryVertexShader } from './packages/core/src/geometry/gpu-geometry-shaders.ts';
    export { rasterShader, presentationShader } from './packages/core/src/rendering/raster-shaders.ts';
    export { temporalShader } from './packages/core/src/rendering/temporal-shader.ts';
  `, resolveDir: repository, sourcefile: 'frozen-input-exports.ts', loader: 'ts' }, output, 'cpu-inputs.mjs');
  const api = await import(pathToFileURL(resolve(output, 'cpu-inputs.mjs')));
  const sourceBytes = await readFile(resolve(assets.root, 'manifest.json'));
  const geometry = api.parseGeometryManifest(JSON.parse(sourceBytes));
  const proxyManifest = api.parseTraceProxyManifest(JSON.parse(await readFile(resolve(assets.root, 'trace-proxy.json'))), geometry);
  const payload = await readFile(resolve(assets.root, 'trace-proxy.bin'));
  const owned = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const proxy = await api.validateTraceProxy(proxyManifest, owned(payload), owned(sourceBytes));
  assert.equal(proxy.triangles.length, 2048);
  assert.deepEqual(Buffer.from(api.packGiRays(rays)), rayBytes, 'CPU decode must preserve every frozen ray word.');
  const stageA = await import(pathToFileURL(resolve(output, 'direct.mjs')));
  const stageB = await import(pathToFileURL(resolve(output, 'candidate.mjs')));
  const shaders = await collectShaderSources(api, stageA, stageB);
  const labels = stageA.traceWriteQueryStates.map((state, stateId) => {
    const scene = api.createIntegratedScene(state), source = api.referenceUpdateTriangles(scene, proxy.triangles);
    return { stateId, state, rays: rays.map((ray, id) => {
      const hit = api.bruteUpdateOracle(ray, source);
      return { id, category: id < 256 ? 'broad' : id < 384 ? 'rigid' : id < 448 ? 'terrain' : 'mirror',
        hit: hit ? { sourceId: hit.triangle.id, boxId: hit.triangle.boxId, distance: hit.distance, boundary: hit.boundary } : null };
    }) };
  });
  const inputs = { staticTriangles: proxy.triangles, rays };
  assert.deepEqual(parseProofInputJson(proofInputJson(inputs)), inputs, 'Frozen input transport must preserve signed zero.');
  const plan = { correctnessOnly: true, performanceEligible: false, totalDeadlineMs: 600000, readbackDeadlineMs: 10000,
    traceStrides: api.giTraceStrides, directReadbackLayouts: stageA.traceWriteReadbackLayouts,
    reportedSourceInterval: stageA.traceWriteReportedSourceInterval,
    sourceGates: api.updateOracleGates, rayLabels: labels,
    states: stageA.traceWriteStates, queryStates: stageA.traceWriteQueryStates, canonicalWrites: stageA.traceWriteCanonicalWrites,
    failurePlan: stageA.traceWriteFailurePlan(proxy.triangles), renderer: stageB.rendererProofPlan,
    shaderSha256: Object.fromEntries(Object.entries(shaders).map(([name, source]) => [name, proofHash(source)])) };
  const artifacts = [];
  for (const [name, contents] of [['inputs.json', proofInputJson(inputs)], ['steps.json', json(plan)], ['shaders.json', json(shaders)], ['rays.bin', rayBytes]]) {
    await writeFile(resolve(output, name), contents, { flag: 'wx' });
    artifacts.push({ name, bytes: Buffer.byteLength(contents), sha256: proofHash(contents) });
  }
  const after = await sourceState(); assert.deepEqual(after, before, 'Source changed during preparation.');
  // Also guard untracked draft sources, which are not represented by git diff.
  const modules = Object.assign({}, direct.modules, candidate.modules, full.modules, cpu.modules);
  for (const [path, sha] of Object.entries(modules)) assert.equal(proofHash(await readFile(resolve(repository, path))), sha, `Source changed: ${path}`);
  const manifest = { schemaVersion: 1, kind: 'strata-issue20-frozen-correctness-proof', createdAt: new Date().toISOString(),
    correctnessOnly: true, performanceEligible: false, runnable: !before.status && !args['--allow-dirty-draft'],
    source: before, runnerSha256: proofHash(await readFile(fileURLToPath(import.meta.url))), assets,
    raySource: { path: rayPath, sha256: proofHash(rayBytes), bytes: rayBytes.byteLength },
    bundles: { direct, candidate, full, cpu }, artifacts };
  const bytes = json(manifest); await writeFile(resolve(output, 'manifest.json'), bytes, { flag: 'wx' });
  return { path: resolve(output, 'manifest.json'), sha256: proofHash(bytes), runnable: manifest.runnable };
}

export async function verifyProof(path, sha256) {
  const manifestPath = await realpath(resolve(path)), directory = dirname(manifestPath);
  const manifest = JSON.parse(await frozenFile(manifestPath, sha256));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, 'strata-issue20-frozen-correctness-proof');
  assert.equal(manifest.runnable, true, 'Draft manifests cannot request a GPU.');
  assert.equal(manifest.performanceEligible, false);
  assert.deepEqual(await sourceState(), manifest.source, 'Run from the exact clean reviewed source.');
  assert.equal(proofHash(await readFile(fileURLToPath(import.meta.url))), manifest.runnerSha256);
  for (const artifact of [...manifest.artifacts, ...Object.values(manifest.bundles).flatMap(b => b.files)]) {
    const file = await realpath(resolve(directory, artifact.name)); assert(within(directory, file));
    const bytes = await frozenFile(file, artifact.sha256); assert.equal(bytes.byteLength, artifact.bytes);
  }
  for (const b of Object.values(manifest.bundles)) for (const [module, sha] of Object.entries(b.modules)) {
    assert.equal(proofHash(await readFile(resolve(repository, module))), sha, `Reviewed module changed: ${module}`);
  }
  assert.deepEqual(await externalAssets(manifest.assets.root), manifest.assets);
  await frozenFile(manifest.raySource.path, traceProofInputs['rays.bin']);
  return { manifest, directory };
}

export async function runProof(args) {
  const frozen = await verifyProof(args['--manifest'], args['--manifest-sha256']);
  const output = await newExternalDirectory(args['--output']);
  const report = { kind: 'strata-issue20-gpu-correctness', correctnessOnly: true, performanceEligible: false,
    manifest: { path: resolve(args['--manifest']), sha256: args['--manifest-sha256'] }, requestedAdapter: args['--adapter'],
    startedAt: new Date().toISOString(), browserErrors: [], events: 0, cleanup: {} };
  let browser, server, timer, stopped = false, pendingEvents = Promise.resolve();
  const active = () => { assert(!stopped, 'Proof execution already terminated.'); };
  const event = value => {
    pendingEvents = pendingEvents.then(() => appendFile(resolve(output, 'events.jsonl'), JSON.stringify({ sequence: report.events++, at: new Date().toISOString(), value }) + '\n'));
    return pendingEvents;
  };
  const work = async () => {
    // Import/launch occurs only after --run admission and frozen-file verification.
    const { chromium } = await import('playwright');
    active();
    server = await createBenchmarkServer({ assetRoot: frozen.manifest.assets.root });
    if (stopped) { await server.close(); throw Error('Proof terminated during server creation.'); }
    const flags = ['--enable-unsafe-webgpu'];
    if (args['--adapter'] === 'software') flags.push(...(platform() === 'linux'
      ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
      : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']));
    browser = await chromium.launch({ channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headless: process.env.STRATA_TEST_HEADED !== '1', args: flags });
    if (stopped) { await browser.close(); throw Error('Proof terminated during browser launch.'); }
    report.browser = browser.version();
    const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => report.browserErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.browserErrors.push(message.text()); });
    await page.exposeFunction('recordTraceProofEvent', event);
    await page.route(`${server.url}/proof.html`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Strata issue20 correctness proof</title>' }));
    for (const name of ['direct.mjs', 'candidate.mjs', 'full-correctness-only.mjs', 'inputs.json', 'steps.json', 'shaders.json']) {
      const body = await readFile(resolve(frozen.directory, name));
      await page.route(`${server.url}/proof/${name}`, route => route.fulfill({ contentType: name.endsWith('.json') ? 'application/json' : 'text/javascript', body }));
    }
    await page.goto(`${server.url}/proof.html`);
    const result = await page.evaluate(async requestedAdapter => {
      let device, proofApi; let expectedDestroy = false, openScopes = 0;
      const errors = [], result = { stages: {}, shaders: [], cleanup: { deviceDestroyed: false } };
      const emit = async value => {
        await globalThis.recordTraceProofEvent(value);
        if (errors.length) throw Error(errors.join('\n'));
      };
      try {
        const [direct, candidate, full, inputs] = await Promise.all([import('/proof/direct.mjs'), import('/proof/candidate.mjs'), import('/proof/full-correctness-only.mjs'),
          fetch('/proof/inputs.json').then(r => r.text()).then(text => JSON.parse(text, (_key, item) => item && typeof item === 'object'
            && Object.keys(item).length === 1 && item.$strataF32 === '-0' ? -0 : item))]);
        proofApi = direct;
        if (!navigator.gpu) throw Error('WebGPU unavailable.');
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance', forceFallbackAdapter: requestedAdapter === 'software' });
        if (!adapter) throw Error(`No ${requestedAdapter} adapter available; no fallback substitution allowed.`);
        const info = adapter.info;
        if (typeof info.isFallbackAdapter !== 'boolean') throw Error('Adapter fallback classification unavailable.');
        if (info.isFallbackAdapter !== (requestedAdapter === 'software')) throw Error('Actual adapter differs from requested hardware/software mode.');
        const limits = object => Object.fromEntries(Object.keys(Object.getPrototypeOf(object)).map(key => [key, object[key]]).filter(([, v]) => typeof v === 'number'));
        result.adapter = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
          isFallbackAdapter: info.isFallbackAdapter, features: [...adapter.features].sort(), limits: limits(adapter.limits) };
        device = await adapter.requestDevice({ requiredFeatures: [] });
        device.addEventListener('uncapturederror', e => errors.push(`${e.error.constructor.name}: ${e.error.message}`));
        device.lost.then(info => { if (!expectedDestroy) errors.push(`Device lost: ${info.reason}: ${info.message}`); });
        result.device = { features: [...device.features].sort(), limits: limits(device.limits) };
        for (const type of ['internal', 'out-of-memory', 'validation']) { device.pushErrorScope(type); openScopes++; }
        const frozenShaders = new Set(Object.values(await fetch('/proof/shaders.json').then(r => r.json())));
        const native = device, functions = new Map();
        // Record actual descriptors in addition to pre-run source/WGSL hashes.
        const recorded = new Proxy(native, { get(target, key) {
          if (key === 'createShaderModule') return descriptor => {
            result.shaders.push({ label: descriptor.label ?? '', code: descriptor.code });
            if (!frozenShaders.has(descriptor.code)) throw Error(`Shader descriptor was not frozen: ${descriptor.label ?? '(unlabelled)'}`);
            return native.createShaderModule(descriptor);
          };
          const value = Reflect.get(target, key, target);
          if (typeof value !== 'function') return value;
          if (!functions.has(key)) functions.set(key, value.bind(target));
          return functions.get(key);
        } });
        await emit({ stage: 'A', status: 'start', adapter: result.adapter, device: result.device });
        result.stages.A = await direct.runTraceWriteValidation(recorded, inputs, emit);
        await emit({ stage: 'A', status: 'complete', evidence: result.stages.A });
        direct.assertCompletedProofStage(result.stages.A, 'Stage A');
        await emit({ stage: 'B/C', status: 'start' });
        result.stages.BC = await candidate.runRendererPairValidation(recorded, candidate.createRendererProofArm, full.createRendererProofArm,
          { manifestUrl: new URL('/external-assets/manifest.json', location.href).href, traceProxyUrl: new URL('/external-assets/trace-proxy.json', location.href).href }, emit);
        await emit({ stage: 'B/C', status: 'complete', evidence: result.stages.BC });
        direct.assertCompletedProofStage(result.stages.BC, 'Renderer stages');
        await device.queue.onSubmittedWorkDone();
        if (errors.length) throw Error(errors.join('\n'));
        result.status = 'pass';
      } catch (error) {
        result.status = 'fail'; result.failure = { message: error.message, stack: error.stack,
          proofEvidence: error.proofEvidence, proofDifference: error.proofDifference };
      } finally {
        if (device) {
          result.cleanup = await proofApi.finishProofDevice(device, openScopes, () => { expectedDestroy = true; });
          errors.push(...result.cleanup.errors);
        }
        result.errors = errors;
        if (errors.length) { result.status = 'fail'; result.failure ??= { message: errors.join('\n') }; }
      }
      return result;
    }, args['--adapter']);
    active();
    report.result = result;
    assert.equal(report.result.status, 'pass', report.result.failure?.message ?? 'GPU correctness proof failed.');
    assert.deepEqual(report.browserErrors, []);
    report.status = 'pass';
  };
  try {
    await event({ status: 'start', manifestSha256: args['--manifest-sha256'], correctnessOnly: true });
    await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { stopped = true; reject(Error('Whole proof exceeded ten minutes.')); }, 600000); })]);
  } catch (error) { report.status = 'fail'; report.failure = { message: error.message, stack: error.stack, proofEvidence: error.proofEvidence, proofDifference: error.proofDifference }; }
  finally {
    stopped = true;
    clearTimeout(timer);
    const cleanup = await Promise.allSettled([bounded(browser?.close(), 'Browser cleanup'), bounded(server?.close(), 'Server cleanup')]);
    report.cleanup = { browser: { status: cleanup[0].status, ...(cleanup[0].status === 'rejected' ? { error: String(cleanup[0].reason) } : {}) },
      server: { status: cleanup[1].status, ...(cleanup[1].status === 'rejected' ? { error: String(cleanup[1].reason) } : {}) } };
    if (cleanup.some(item => item.status === 'rejected')) report.status = 'fail';
    try { await bounded(verifyProof(args['--manifest'], args['--manifest-sha256']), 'Final source verification', 30000); report.sourceGuard = 'unchanged'; }
    catch (error) { report.status = 'fail'; report.sourceGuard = { failure: error.message }; }
    try { await bounded(pendingEvents, 'Event persistence'); }
    catch (error) { report.status = 'fail'; report.eventPersistenceFailure = String(error); }
    report.completedAt = new Date().toISOString();
    if (report.result?.shaders) for (const shader of report.result.shaders) shader.sha256 = proofHash(shader.code);
    await writeFile(resolve(output, 'report.json'), json(report), { flag: 'wx' });
  }
  assert.equal(report.status, 'pass', `Proof failed; evidence retained at ${output}/report.json`);
  return { path: resolve(output, 'report.json'), status: report.status };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const args = parseProofArguments(process.argv.slice(2)); console.log(json(await (args['--prepare-only'] ? prepareProof(args) : runProof(args)))); }
  catch (error) { console.error(error.stack ?? String(error)); process.exitCode = 1; }
}
