import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// CPU orchestration proof only. Stub the two runtime imports in an OS-temp bundle;
// no real Core renderer, browser, WASM, model file, or GPU is loaded by this suite.
const temporary = await mkdtemp(join(tmpdir(), 'strata-gallery-runtime-cpu-'));
const output = join(temporary, 'runtime.mjs');
const hookKey = '__strataGalleryRuntimeCpuHooks';
try {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./runtime.ts', import.meta.url))], outfile: output,
    bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent', metafile: true,
    plugins: [{
      name: 'gallery-cpu-runtime-imports',
      setup(plugin) {
        plugin.onResolve({ filter: /^@strata-engine\/core(?:\/gltf)?$/ }, args => ({ path: args.path, namespace: 'gallery-cpu' }));
        plugin.onLoad({ filter: /.*/, namespace: 'gallery-cpu' }, args => ({
          loader: 'js', contents: args.path.endsWith('/gltf')
            ? `export const loadGltf = (...args) => globalThis[${JSON.stringify(hookKey)}].loadGltf(...args);`
            : `export const createEngine = (...args) => globalThis[${JSON.stringify(hookKey)}].createEngine(...args);`,
        }));
      },
    }],
  });
  assert.ok(Object.keys(result.metafile.inputs).every(path => path.startsWith('gallery-cpu:') || /(?:^|\/)examples\/gallery\/(?:runtime|orbit|state)\.ts$/.test(path)),
    'CPU suite must not bundle real Core implementation code');
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
const { GalleryRuntime } = await import(pathToFileURL(output).href);
after(async () => { await rm(temporary, { recursive: true, force: true }); });

const deferreds = new Set();
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const value = { promise, resolve, reject };
  deferreds.add(value);
  return value;
}
function model(id = 'fixture') {
  return {
    id, title: id, category: 'test', benchmarkUse: 'CPU orchestration', author: 'Fixture', license: 'Fixture',
    sourceUrl: null, licenseUrl: null, entryUrl: `http://localhost/external-assets/${id}/scene.gltf`,
    sourceSha256: 'a'.repeat(64), triangles: 12, meshCount: 1, textureMaxEdge: null,
    features: { requiredExtensions: [], usedExtensions: [], alphaModes: ['OPAQUE'], skins: 0, animations: 0, morphTargets: 0 },
    notes: [], unavailableReason: null,
  };
}
function asset(sourceUrl, clips = []) {
  return {
    version: 1, sourceUrl, bounds: { min: [-1, 0, -1], max: [1, 2, 1] },
    sourceBounds: { min: [-1, 0, -1], max: [1, 2, 1] }, normalization: { scale: 1, translation: [0, 0, 0] },
    maxTextureDimension: 2048, warnings: [], clips,
    stats: { meshInstances: 1, primitives: 1, vertices: 8, triangles: 12, materials: 1, images: 0,
      encodedBytes: 0, geometryBytes: 0, skinnedMeshInstances: 0, animationClips: clips.length },
  };
}

function assertFrameFits(frame, bounds) {
  const { eye, target, verticalFov } = frame.options.imported.camera;
  const unit = vector => { const length = Math.hypot(...vector); return vector.map(value => value / length); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
  const back = unit(eye.map((value, axis) => value - target[axis]));
  const right = unit(cross(Math.abs(back[1]) > .999 ? [0, 0, 1] : [0, 1, 0], back));
  const up = cross(back, right);
  for (let corner = 0; corner < 8; corner++) {
    const fromEye = eye.map((value, axis) => (((corner >> axis) & 1) ? bounds.max[axis] : bounds.min[axis]) - value);
    const depth = -dot(fromEye, back);
    const x = dot(fromEye, right) / depth / Math.tan(verticalFov / 2) / (frame.width / frame.height);
    const y = dot(fromEye, up) / depth / Math.tan(verticalFov / 2);
    assert.ok(depth >= .03 - 1e-12 && Math.abs(x) <= .85 + 1e-12 && Math.abs(y) <= .85 + 1e-12,
      `Bounds corner ${corner} must fit the actual submitted ${frame.width}x${frame.height} camera: ${x}, ${y}, depth ${depth}`);
  }
}

class FakeEngine {
  state = 'ready';
  info = { maxTextureDimension2D: 4096, profiling: { enabled: true, gpuTimestampAvailable: false, reason: 'CPU fake engine' } };
  frames = [];
  sceneCalls = [];
  resizeCalls = [];
  gpuSamples = [];
  fenceQueue = [];
  sceneQueue = [];
  holds = [];
  fenceCalls = 0;
  flushCalls = 0;
  disposeCalls = 0;
  gpuErrorCount = 0;
  lastGpuError = null;
  scene = null;
  constructor(canvas) { this.canvas = canvas; }
  hold(queue) {
    const entry = { entered: deferred(), done: deferred() };
    queue.push(entry); this.holds.push(entry);
    return entry;
  }
  holdFence() { return this.hold(this.fenceQueue); }
  holdScene() { return this.hold(this.sceneQueue); }
  async setScene(options) {
    this.sceneCalls.push(options);
    const hold = this.sceneQueue.shift();
    if (hold) { hold.entered.resolve(); await hold.done.promise; }
    // Deliberately resolve even after an abort: host guards must reject late work.
    this.scene = options.asset;
    return { generation: this.sceneCalls.length, sourceUrl: options.asset.sourceUrl };
  }
  render(options) {
    assert.equal(this.state, 'ready', 'Host must not submit after disposal/loss');
    const frameId = this.frames.length + 1;
    this.frames.push({ frameId, sourceUrl: this.scene?.sourceUrl ?? null, options: structuredClone(options), width: this.canvas.width, height: this.canvas.height });
    return { frameId, cpuSubmissionMs: 0.1, drawCalls: 1, dispatchCalls: 0, triangles: 12,
      uploadBytes: 0, allocatedGpuBufferBytes: 0, allocatedGpuTextureBytes: 0, wasmMemoryBytes: 0 };
  }
  async waitForIdle() {
    this.fenceCalls++;
    const hold = this.fenceQueue.shift();
    if (hold) { hold.entered.resolve(); await hold.done.promise; }
  }
  async flushGpuTimings() { this.flushCalls++; }
  drainGpuTimings() { return this.gpuSamples.splice(0); }
  getTelemetry() { return { submittedFrames: this.frames.length, gpuErrorCount: this.gpuErrorCount, lastGpuError: this.lastGpuError, source: 'CPU fake engine' }; }
  resize(width, height) {
    assert.equal(this.state, 'ready');
    this.resizeCalls.push([width, height]); this.canvas.width = width; this.canvas.height = height;
  }
  dispose() { this.disposeCalls++; this.state = 'disposed'; }
}

describe('Gallery runtime — CPU orchestration only; no browser/GPU rendering proof', { concurrency: false, timeout: 5000 }, () => {
  let canvas, engine, runtime, loadCalls, loadHook, onChanged, raf, nextRafId, savedGlobals;
  beforeEach(async () => {
    canvas = { width: 512, height: 512 }; engine = new FakeEngine(canvas);
    loadCalls = []; loadHook = async url => asset(url); onChanged = () => {};
    raf = new Map(); nextRafId = 0;
    savedGlobals = new Map(['document', 'requestAnimationFrame', 'cancelAnimationFrame', hookKey].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const globals = {
      document: { hidden: false },
      requestAnimationFrame: callback => { const id = ++nextRafId; raf.set(id, callback); return id; },
      cancelAnimationFrame: id => { raf.delete(id); },
      [hookKey]: {
        createEngine: async options => { assert.equal(options.canvas, canvas); return engine; },
        loadGltf: (url, options) => { loadCalls.push({ url, options }); return loadHook(url, options); },
      },
    };
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    runtime = new GalleryRuntime(canvas, () => onChanged());
    await runtime.initialize();
  });
  afterEach(async () => {
    runtime.dispose();
    for (const hold of engine.holds) hold.done.resolve();
    // Release deliberately noncooperative fake work even when an assertion fails,
    // so no abandoned host load keeps its 120-second deadline alive after a test.
    for (const gate of deferreds) gate.resolve();
    deferreds.clear();
    await new Promise(resolve => setImmediate(resolve));
    for (const [key, descriptor] of savedGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  function tick(timestamp) {
    const callbacks = [...raf.values()]; raf.clear();
    for (const callback of callbacks) callback(timestamp);
  }

  test('snapshots mutable catalog metadata before awaiting a load and after readiness', async () => {
    const gate = deferred(), input = model('original'), original = structuredClone(input);
    loadHook = () => gate.promise;
    const loading = runtime.selectModel(input);
    input.id = 'mutated'; input.entryUrl = 'http://localhost/external-assets/other.gltf'; input.sourceSha256 = 'b'.repeat(64);
    assert.equal(runtime.getState().requestedModelId, original.id);
    gate.resolve(asset(original.entryUrl));
    await loading;
    input.id = 'mutated-again';
    const state = runtime.getState();
    assert.equal(state.modelId, original.id);
    assert.deepEqual(state.source, { entryUrl: original.entryUrl, catalogGltfSha256: original.sourceSha256 });
    assert.equal(loadCalls[0].url, original.entryUrl);
    assert.equal(engine.frames[0].sourceUrl, original.entryUrl);
    assert.equal(state.phase, 'ready');
  });

  test('first model frame fits the portrait viewport queued while its loader is pending', async () => {
    const gate = deferred(); loadHook = () => gate.promise;
    const loading = runtime.selectModel(model());
    runtime.resize(288, 480);
    gate.resolve(asset(model().entryUrl));
    await loading;
    assert.equal(engine.frames.length, 1);
    assert.deepEqual([engine.frames[0].width, engine.frames[0].height], [288, 480]);
    assertFrameFits(engine.frames[0], engine.scene.bounds);
    assert.ok(Math.abs(runtime.getState().settings.orbit.azimuth - .55) < 1e-12);
    assert.equal(runtime.getState().settings.orbit.elevation, .24);
  });

  test('resizing refits a fitted camera, preserves a manual camera, and Reset fits the current aspect', async () => {
    await runtime.selectModel(model());
    const square = runtime.getState().settings.orbit;
    runtime.resize(288, 480);
    const portrait = runtime.getState().settings.orbit;
    assert.ok(portrait.distance > square.distance);
    assertFrameFits(engine.frames.at(-1), engine.scene.bounds);
    const manual = { azimuth: 1.2, elevation: -.2, distance: 9, target: [1, 2, 3] };
    await runtime.setOrbit(manual);
    const appliedManual = runtime.getState().settings.orbit;
    runtime.resize(960, 480);
    assert.deepEqual(runtime.getState().settings.orbit, appliedManual);
    await runtime.resetCamera();
    const reset = runtime.getState().settings.orbit;
    assert.equal(reset.azimuth, square.azimuth); assert.equal(reset.elevation, square.elevation);
    assert.deepEqual(reset.target, square.target);
    assert.ok(reset.distance < portrait.distance);
    assertFrameFits(engine.frames.at(-1), engine.scene.bounds);
    runtime.resize(288, 480);
    assert.deepEqual(runtime.getState().settings.orbit, portrait, 'Reset restores automatic fitting on subsequent resize');
    assertFrameFits(engine.frames.at(-1), engine.scene.bounds);
  });

  test('same-size resize submits nothing and cancels a queued resize during capture', async () => {
    await runtime.selectModel(model());
    const before = runtime.getState();
    runtime.resize(512, 512);
    assert.deepEqual(runtime.getState(), before);
    const gate = engine.holdFence();
    const capture = runtime.captureState(2);
    await gate.entered.promise;
    const submitted = engine.frames.length, fences = engine.fenceCalls;
    runtime.resize(288, 480);
    runtime.resize(512, 512);
    gate.done.resolve();
    const result = await capture;
    assert.deepEqual(result.state.viewport, { width: 512, height: 512 });
    assert.equal(engine.frames.length, submitted);
    assert.equal(engine.fenceCalls, fences, 'Canceled resize does not require another submission or fence');
    assert.deepEqual(engine.resizeCalls, []);
    assert.ok(engine.frames.every(frame => frame.width === 512 && frame.height === 512));
  });

  test('an impossible fit rejects viewport or Reset input without faulting a healthy manual view', async () => {
    await runtime.selectModel(model());
    const fitted = runtime.getState();
    await assert.rejects(runtime.setViewport(1, 4096), /maximum camera distance/);
    assert.deepEqual(runtime.getState(), fitted);
    await runtime.setOrbit({ distance: 9 });
    await runtime.setViewport(1, 4096);
    const manual = runtime.getState();
    await assert.rejects(runtime.resetCamera(), /maximum camera distance/);
    assert.deepEqual(runtime.getState(), manual);
    assert.equal(manual.phase, 'ready');
  });

  test('a superseded loader resolving late cannot commit, submit or relabel the newer model', async () => {
    const gate = deferred(), older = model('older'), newer = model('newer');
    loadHook = url => url === older.entryUrl ? gate.promise : Promise.resolve(asset(url));
    const oldLoad = runtime.selectModel(older);
    const oldRejected = assert.rejects(oldLoad, { name: 'AbortError' });
    await runtime.selectModel(newer);
    assert.equal(loadCalls[0].options.signal.aborted, true);
    const committedState = runtime.getState();
    gate.resolve(asset(older.entryUrl));
    await oldRejected;
    assert.deepEqual(runtime.getState(), committedState);
    assert.deepEqual(engine.sceneCalls.map(call => call.asset.sourceUrl), [newer.entryUrl]);
    assert.deepEqual(engine.frames.map(frame => frame.sourceUrl), [newer.entryUrl]);
  });

  test('a superseded first-frame fence cannot make its older scene ready or submit late work', async () => {
    const gate = engine.holdFence();
    const oldLoad = runtime.selectModel(model('older'));
    const oldRejected = assert.rejects(oldLoad, { name: 'AbortError' });
    await gate.entered.promise;
    await runtime.selectModel(model('newer'));
    const newest = runtime.getState(), submitted = engine.frames.length;
    gate.done.resolve();
    await oldRejected;
    assert.deepEqual(runtime.getState(), newest);
    assert.equal(engine.frames.length, submitted);
    assert.equal(newest.modelId, 'newer');
    assert.equal(newest.phase, 'ready');
  });

  for (const stage of ['loader', 'scene-creation', 'first-frame-fence', 'capture-fence']) {
    test(`disposal during ${stage} prevents late readiness or submissions`, async () => {
      let pending, gate;
      if (stage === 'loader') {
        gate = { done: deferred() }; loadHook = () => gate.done.promise;
        pending = runtime.selectModel(model());
      } else if (stage === 'scene-creation') {
        gate = engine.holdScene(); pending = runtime.selectModel(model()); await gate.entered.promise;
      } else if (stage === 'first-frame-fence') {
        gate = engine.holdFence(); pending = runtime.selectModel(model()); await gate.entered.promise;
      } else {
        await runtime.selectModel(model()); gate = engine.holdFence(); pending = runtime.captureState(2); await gate.entered.promise;
      }
      const rejected = assert.rejects(pending);
      const frameCount = engine.frames.length;
      runtime.dispose(); runtime.dispose();
      if (stage === 'loader') gate.done.resolve(asset(model().entryUrl)); else gate.done.resolve();
      await rejected;
      assert.equal(runtime.getState().phase, 'disposed');
      assert.equal(runtime.getState().asset, null);
      assert.equal(engine.disposeCalls, 1);
      assert.equal(engine.frames.length, frameCount);
      assert.equal(raf.size, 0);
      if (stage !== 'capture-fence') assert.equal(loadCalls[0].options.signal.aborted, true);
    });
  }

  for (const health of ['device-lost', 'uncaptured-gpu-error']) {
    test(`a paused ${health} engine latches error when capture checks readiness`, async () => {
      await runtime.selectModel(model());
      assert.equal(runtime.getState().live, false);
      if (health === 'device-lost') engine.state = 'lost';
      else { engine.gpuErrorCount = 1; engine.lastGpuError = 'CPU fixture GPU failure'; }
      const before = engine.frames.length;
      await assert.rejects(runtime.captureState(1));
      const state = runtime.getState();
      assert.equal(state.phase, 'error'); assert.ok(state.error.message.length > 0);
      assert.equal(state.live, false); assert.equal(engine.frames.length, before);
    });
  }

  test('observing a paused lost engine latches error even when changed callback reads state', async () => {
    await runtime.selectModel(model());
    let changes = 0;
    onChanged = () => { changes++; assert.equal(runtime.getState().phase, 'error'); };
    engine.state = 'lost';
    assert.equal(runtime.getState().phase, 'error');
    assert.equal(changes, 1, 'Fault notification must not recurse through state observation');
    onChanged = () => {};
  });

  test('capture blocks mutation and snapshots exact submitted controls before an unlock callback changes the view', async () => {
    loadHook = async url => asset(url, [{ id: 'walk', name: 'Walk', duration: 4 }]);
    await runtime.selectModel(model());
    await runtime.setAnimation({ clipId: 'walk', timeSeconds: 1.25, loop: false, playing: false });
    const gate = engine.holdFence();
    const capture = runtime.captureState(3);
    await gate.entered.promise;
    assert.equal(runtime.getState().busy, 'capture');
    const capturedFrame = structuredClone(engine.frames.at(-1));
    const beforeRejected = engine.frames.length;
    await assert.rejects(runtime.selectModel(model('other')), /still settling/);
    await assert.rejects(runtime.setLightingPreset('daylight'), /ready and idle/);
    await assert.rejects(runtime.setOrbit({ azimuth: 2 }), /ready and idle/);
    await assert.rejects(runtime.setAnimation({ timeSeconds: 2 }), /ready and idle/);
    await assert.rejects(runtime.renderFrames(1), /ready and idle/);
    assert.throws(() => runtime.setLive(true), /ready and idle/);
    assert.equal(engine.frames.length, beforeRejected);
    let nextChange;
    onChanged = () => {
      if (runtime.getState().busy !== null || nextChange) return;
      onChanged = () => {};
      nextChange = runtime.setLightingPreset('daylight');
    };
    gate.done.resolve();
    const result = await capture;
    await nextChange;
    assert.equal(result.format, 'strata.gallery.capture-state');
    assert.equal(result.presentedFrameId, null);
    assert.equal(result.state.busy, null);
    assert.equal(result.state.settings.lightingPreset, 'studio');
    assert.equal(result.state.frame.frameId, capturedFrame.frameId);
    assert.equal(result.state.submittedView.frameId, capturedFrame.frameId);
    assert.deepEqual(result.state.submittedView.controls, capturedFrame.options.imported);
    assert.deepEqual(result.state.submittedView.controls.animation, { clipId: 'walk', timeSeconds: 1.25, loop: false });
    assert.equal(result.state.settings.animation.playing, false);
    assert.equal(runtime.getState().settings.lightingPreset, 'daylight');
    assert.ok(runtime.getState().frame.frameId > result.state.frame.frameId);
    result.state.submittedView.controls.animation.timeSeconds = 99;
    result.state.settings.orbit.target[0] = 99;
    assert.equal(runtime.getState().submittedView.controls.animation.timeSeconds, 1.25);
    assert.notEqual(runtime.getState().settings.orbit.target[0], 99, 'Returned snapshots must not alias retained runtime data');
  });

  for (const operation of ['load', 'settings', 'capture']) {
    test(`resize queued during a ${operation} fence is submitted and fenced before return`, async () => {
      if (operation !== 'load') await runtime.selectModel(model());
      const first = engine.holdFence();
      const pending = operation === 'load' ? runtime.selectModel(model())
        : operation === 'settings' ? runtime.setLightingPreset('daylight') : runtime.captureState(2);
      let settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
      await first.entered.promise;
      runtime.resize(288, 480);
      assert.deepEqual([canvas.width, canvas.height], [512, 512]);
      const second = engine.holdFence();
      first.done.resolve();
      await second.entered.promise;
      assert.equal(settled, false, 'Resize submission still needs its own GPU fence');
      assert.deepEqual(engine.resizeCalls.at(-1), [288, 480]);
      assert.deepEqual([engine.frames.at(-1).width, engine.frames.at(-1).height], [288, 480]);
      assertFrameFits(engine.frames.at(-1), engine.scene.bounds);
      second.done.resolve();
      const result = await pending;
      const state = operation === 'capture' ? result.state : runtime.getState();
      assert.equal(state.phase, 'ready'); assert.equal(state.busy, null);
      assert.deepEqual(state.viewport, { width: 288, height: 480 });
      assert.equal(state.frame.frameId, engine.frames.at(-1).frameId);
      assert.equal(state.submittedView.frameId, state.frame.frameId);
    });
  }

  test('continuous clip time preserves delayed timing identity and submits deterministic looped time', async () => {
    loadHook = async url => asset(url, [{ id: 'idle', name: 'Idle', duration: 2 }]);
    await runtime.selectModel(model());
    const revision = runtime.getState().viewRevision;
    assert.equal(runtime.getState().settings.animation.playing, true);
    tick(1000);
    const timedFrame = engine.frames.at(-1).frameId;
    engine.gpuSamples.push({ frameId: timedFrame, pass: 'fake-pass', gpuMs: 0.2, startOffsetMs: 0, endOffsetMs: 0.2 });
    tick(1100);
    const state = runtime.getState();
    assert.equal(state.viewRevision, revision);
    assert.equal(state.measurements.gpu.frameId, timedFrame);
    assert.equal(state.submittedView.controls.animation.timeSeconds, 0.1);
    assert.deepEqual(state.submittedView.controls, engine.frames.at(-1).options.imported);
    await runtime.setAnimation({ timeSeconds: 2.5, loop: true, playing: false });
    assert.equal(runtime.getState().submittedView.controls.animation.timeSeconds, 0.5);
    runtime.setLive(false);
    assert.equal(raf.size, 0);
  });
});
