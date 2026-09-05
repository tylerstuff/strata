import type { Engine, FrameMetrics, ImportedAsset, ImportedControls, RenderOptions } from '../../packages/core/src/index.js';

// The only executable engine import is the ordinary built package URL below.
// No renderer, effect, BVH builder, shader or internal device is substituted.
type Vec3 = readonly [number, number, number];
type WorkerEvent = { sequence: number; direction: 'request' | 'response' | 'terminate'; type: string; requestId?: number };
type Capture = { name: string; width: number; height: number; png: string; pixels: number[]; meanRgb: number[]; minRgb: number[]; maxRgb: number[] };
const require = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const code = (error: unknown): string => String((error as { code?: string })?.code ?? error);
const limits = { maxPixels: 1024, pixelBatch: 1024, maxSamples: 64, maxVisits: 64, seed: 1337 };
const camera = { eye: [0, 1.5, 0.2] as Vec3, target: [0, 0, 0] as Vec3, verticalFov: 0.5 };
const controls: ImportedControls = { camera, presentation: 'model-only', background: [0, 0, 0],
  lighting: { directionToLight: [0, 1, 0], color: [1, 1, 1], intensity: 0, ambient: [4, 3, 2],
    environment: { preset: 'sky', intensity: 1, rotationRadians: 0 } } };

/** Exactly two upward-facing triangles, wholly covering the small perspective viewport. */
function floorAsset(emission: Vec3 = [0, 0, 0]): ImportedAsset {
  const vertices = new Float32Array(64);
  const corners = [[-1, 0, -1], [-1, 0, 1], [1, 0, 1], [1, 0, -1]];
  for (let i = 0; i < corners.length; i++) vertices.set([...corners[i]!, 0, 1, 0, (i >> 1), (i & 1), 1, 0, 0, 1, 1, 1, 1, 1], i * 16);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const bounds = { min: [-1, 0, -1] as Vec3, max: [1, 0, 1] as Vec3 };
  return { version: 1, sourceUrl: 'generated:public-progressive-floor-v1', primitives: [{ name: 'upward-floor', vertices, indices, material: 0 }],
    materials: [{ name: 'one-opaque-diffuse-material', baseColorFactor: [0.5, 0.5, 0.5, 1], metallicFactor: 0, roughnessFactor: 1,
      emissiveFactor: emission, emissiveStrength: 2, normalScale: 1, occlusionStrength: 1, alphaMode: 'OPAQUE', alphaCutoff: 0.5, doubleSided: false }],
    images: [], clips: [], warnings: [], sourceBounds: bounds, bounds, normalization: { scale: 1, translation: [0, 0, 0] }, maxTextureDimension: 4,
    stats: { meshInstances: 1, primitives: 1, vertices: 4, triangles: 2, materials: 1, images: 0, encodedBytes: 0,
      geometryBytes: vertices.byteLength + indices.byteLength, skinnedMeshInstances: 0, animationClips: 0 } };
}

function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs); })])
    .finally(() => clearTimeout(timer));
}

function summarize(name: string, canvas: HTMLCanvasElement): Capture {
  const context = canvas.getContext('2d')!;
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const meanRgb = [0, 0, 0], minRgb = [255, 255, 255], maxRgb = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    require(data[i + 3] === 255, 'The model-only public frame must be opaque.');
    for (let c = 0; c < 3; c++) {
      const value = data[i + c]!;
      meanRgb[c] = meanRgb[c]! + value; minRgb[c] = Math.min(minRgb[c]!, value); maxRgb[c] = Math.max(maxRgb[c]!, value);
    }
  }
  return { name, width: canvas.width, height: canvas.height, png: canvas.toDataURL('image/png'), pixels: [...data],
    meanRgb: meanRgb.map(v => v / (canvas.width * canvas.height)), minRgb, maxRgb };
}

/** Freeze the current presented source before the RAF callback returns; fence the same submission afterwards. */
async function frame(engine: Engine, canvas: HTMLCanvasElement, options: RenderOptions, captureName?: string) {
  const copy = captureName ? document.createElement('canvas') : undefined;
  if (copy) { copy.width = canvas.width; copy.height = canvas.height; }
  let metrics!: FrameMetrics;
  await bounded(new Promise<void>((resolve, reject) => requestAnimationFrame(() => {
    try {
      metrics = engine.render(options);
      // Browser canvas interop snapshots this WebGPU frame without requesting the internal GPU device.
      copy?.getContext('2d')!.drawImage(canvas, 0, 0);
      resolve();
    } catch (error) { reject(error); }
  })), 'Public frame RAF');
  await engine.waitForIdle(15_000);
  require(engine.getTelemetry().gpuErrorCount === 0, `Public engine GPU error: ${engine.getTelemetry().lastGpuError}`);
  return { metrics, capture: copy ? summarize(captureName!, copy) : undefined, telemetry: engine.getTelemetry() };
}

function counters(engine: Engine, expected: number) {
  const indirect = engine.getTelemetry().imported?.indirect;
  require(indirect !== undefined, 'The committed scene must expose progressive telemetry.');
  const value = indirect!.sampleCounters;
  require(value !== null, 'waitForIdle must publish the submitted accumulation counters.');
  require(value!.revision === indirect!.progress.revision && value!.submittedFrames === indirect!.progress.submittedFrames,
    'Fresh idle counters must identify their own current accumulation revision and submitted-frame count.');
  require(value!.attempted === value!.completed + value!.exhausted + value!.invalid, 'Attempt accounting must be exhaustive.');
  require(value!.attempted === expected && value!.completed === expected && value!.exhausted === 0 && value!.invalid === 0,
    `All covered perspective pixels must trace their visible raster receiver: ${JSON.stringify(value)}; expected ${expected}.`);
  return value!;
}

// Independent one-dimensional integral, not a copy of the shader sampler:
// p(mu)=2mu and L(mu)=horizon+(zenith-horizon)*mu^0.6 imply E[L]=horizon+(zenith-horizon)*2/2.6.
// Presentation is separately specified ACES fitted tone mapping followed by the IEC sRGB transfer.
function display(linear: number): number {
  const mapped = Math.min(1, Math.max(0, linear * (2.51 * linear + 0.03) / (linear * (2.43 * linear + 0.59) + 0.14)));
  return 255 * (mapped <= 0.0031308 ? 12.92 * mapped : 1.055 * mapped ** (1 / 2.4) - 0.055);
}
const referenceHdr = [0.55, 0.65, 0.8].map((horizon, c) => 0.5 * (horizon + ([0.24, 0.48, 0.95][c]! - horizon) * 2 / 2.6));
const referenceDisplay = referenceHdr.map(display);
function imageError(capture: Capture) {
  let squared = 0;
  for (let i = 0; i < capture.pixels.length; i += 4) for (let c = 0; c < 3; c++) squared += (capture.pixels[i + c]! - referenceDisplay[c]!) ** 2;
  return { rmseDisplayBytes: Math.sqrt(squared / (capture.width * capture.height * 3)),
    meanErrorDisplayBytes: capture.meanRgb.map((v, c) => v - referenceDisplay[c]!) };
}

/** Executes only the public built package and real generated geometry; radiometric B tests remain separate. */
export async function validateImportedProgressive() {
  const entry = '/packages/core/dist/index.js';
  const { createEngine }: typeof import('../../packages/core/src/index.js') = await import(/* @vite-ignore */ entry);
  const stage = async (name: string) => {
    const hook = (globalThis as typeof globalThis & { __strataProgressiveStage?: (name: string) => Promise<void> }).__strataProgressiveStage;
    if (hook) await hook(name);
  };
  const workerEvents: WorkerEvent[] = [], workers = new Set<Worker>();
  const listeners = new Map<Worker, (event: MessageEvent) => void>();
  const originalPost = Worker.prototype.postMessage, originalTerminate = Worker.prototype.terminate;
  let onBuildPosted: ((requestId: number) => void) | undefined;
  const record = (direction: WorkerEvent['direction'], type: string, requestId?: number) => {
    const event: WorkerEvent = { sequence: workerEvents.length, direction, type };
    if (requestId !== undefined) event.requestId = requestId;
    workerEvents.push(event);
  };
  Worker.prototype.postMessage = function(this: Worker, message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
    if (!workers.has(this)) {
      workers.add(this);
      const listener = (event: MessageEvent<{ type?: string; requestId?: number }>) => record('response', event.data?.type ?? 'unknown', event.data?.requestId);
      listeners.set(this, listener); this.addEventListener('message', listener);
    }
    const data = message as { type?: string; requestId?: number };
    record('request', data?.type ?? 'unknown', data?.requestId);
    // Forward the original buffers and transfer semantics unchanged. No worker response is fabricated or delayed.
    (originalPost as (this: Worker, message: unknown, options?: Transferable[] | StructuredSerializeOptions) => void).call(this, message, transferOrOptions);
    if (data?.type === 'build-static-bvh' && data.requestId !== undefined) onBuildPosted?.(data.requestId);
  } as Worker['postMessage'];
  Worker.prototype.terminate = function() { record('terminate', 'terminate'); originalTerminate.call(this); };
  const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16; document.body.append(canvas);
  let engine: Engine | undefined;
  const captures: Capture[] = [], cases: Record<string, unknown>[] = [];
  let outcome: Record<string, unknown> | undefined;
  try {
    engine = await createEngine({ canvas, profiling: false });
    const instance = engine;
    require(!crossOriginIsolated, 'Ordinary hosting proof must not silently use cross-origin isolation.');
    require(engine.info.cpu.abiVersion >= 2 && engine.getTelemetry().wasmMemoryBytes > 0, 'Public initialization must start the packaged WASM worker.');
    await frame(engine, canvas, {}, 'empty'); await stage('empty');
    const asset = floorAsset();
    const sourceVertices = [...asset.primitives[0]!.vertices], sourceIndices = [...asset.primitives[0]!.indices];
    await engine.setScene({ renderer: 'imported', asset });
    const ordinary = await frame(engine, canvas, { temporal: false, imported: controls }, 'ordinary-direct');
    captures.push(ordinary.capture!); await stage('direct');
    require(engine.getTelemetry().imported?.indirect === undefined, 'Ordinary imported startup must remain direct-only.');

    const receipt = await engine.setScene({ renderer: 'imported', asset, indirect: limits });
    const offOptions: RenderOptions = { temporal: true, imported: { ...controls, indirect: { enabled: false } } };
    const onOptions: RenderOptions = { temporal: true, imported: { ...controls, indirect: { enabled: true } } };
    const off = await frame(engine, canvas, offOptions, 'progressive-off'); captures.push(off.capture!); await stage('progressive');
    require(off.capture!.maxRgb.every(v => v <= 1), 'Requested ambient and environment must both be excluded from the progressive direct-only baseline.');
    const metadata = engine.getTelemetry().imported!.indirect!;
    require(metadata.temporal === false && metadata.rasterAmbient === 'disabled' && metadata.rasterEnvironment === 'disabled', 'Progressive baseline policy must be explicit.');
    require(same(metadata.progress.limits, limits) && metadata.preparedTraceGpuBytes > 0 && metadata.estimatedPeakCpuBytes > 0,
      'Requested options and real worker-prepared source accounting must be reported.');
    require(metadata.sampleCounters === null, 'Disabled cold accumulation must not invent GPU counters.');
    require(off.metrics.drawCalls === 3 && off.metrics.dispatchCalls === 0, 'Disabled progressive path must omit GI compute and requested TAA.');

    const checkpoints: Record<string, unknown>[] = [];
    for (let submitted = 1; submitted <= limits.maxSamples; submitted++) {
      const checkpoint = [1, 8, 32, 64].includes(submitted);
      const value = await frame(engine, canvas, onOptions, checkpoint ? `sky-${submitted}` : undefined);
      require(value.metrics.drawCalls === 3 && value.metrics.dispatchCalls === 2, 'Enabled progressive path must execute trace+compose, without requested TAA.');
      const measured = counters(engine, submitted * 16 * 16);
      if (checkpoint) {
        captures.push(value.capture!);
        checkpoints.push({ submitted, counters: measured, image: imageError(value.capture!), meanRgb: value.capture!.meanRgb });
      }
    }
    const first = captures.find(value => value.name === 'sky-1')!, settled = captures.find(value => value.name === 'sky-64')!;
    // Frozen before any GPU observation. Broad deterministic finite-sample sanity gates, not IID confidence statements.
    require(settled.minRgb.every(v => v > 32), 'Every covered receiver pixel must receive nonzero visible-sky diffuse light.');
    require(imageError(settled).rmseDisplayBytes < imageError(first).rmseDisplayBytes,
      'The 64-sample public image must be closer to the independent sky integral than its first sample.');
    require(imageError(settled).rmseDisplayBytes < 6 && imageError(settled).meanErrorDisplayBytes.every(v => Math.abs(v) < 3),
      'The aggregate 64-sample image must approach the single-counted sky reference within the predeclared display-space bounds.');
    const atCap = counters(engine, 16 * 16 * limits.maxSamples);
    for (let i = 0; i < 3; i++) await frame(engine, canvas, onOptions);
    const capped = await frame(engine, canvas, onOptions, 'sky-capped'); captures.push(capped.capture!);
    const capCounters = counters(engine, 16 * 16 * limits.maxSamples);
    require(same(settled.pixels, capped.capture!.pixels), 'A static capped accumulation must not continue changing its image.');
    require(capCounters.submittedFrames === atCap.submittedFrames + 4, 'Submitted frames must remain distinct from completed per-pixel samples.');
    const direct = await frame(engine, canvas, { ...onOptions, debugView: 'direct' }, 'progressive-direct-debug'); captures.push(direct.capture!);
    require(same(direct.capture!.pixels, off.capture!.pixels), 'The direct debug image must not include accumulated sky or ambient.');
    cases.push({ name: 'public-perspective-sky-progress', receipt, referenceHdr, referenceDisplay, checkpoints, atCap, capCounters,
      interpretation: 'Exactly one scheduled update per covered pixel per frame is independently established by complete counters; general public counters do not expose per-pixel spp.' });

    // Exposure is presentation-only. Keep the same capped HDR accumulation while
    // varying EV and raw diagnostic views, so new stochastic samples cannot hide a reset.
    const exposureBefore = counters(engine, 16 * 16 * limits.maxSamples);
    const exposureAllocations = [engine.getTelemetry().allocatedGpuBufferBytes, engine.getTelemetry().allocatedGpuTextureBytes];
    const zeroEv = await frame(engine, canvas, { ...onOptions, exposureEV: 0 }, 'exposure-ev-zero'); captures.push(zeroEv.capture!);
    require(same(zeroEv.capture!.pixels, capped.capture!.pixels), 'Explicit EV0 must be byte-identical to the omitted exposure default.');
    const plusTwoEv = await frame(engine, canvas, { ...onOptions, exposureEV: 2 }, 'exposure-ev-plus-two'); captures.push(plusTwoEv.capture!);
    require(plusTwoEv.capture!.meanRgb.every((value, c) => value > zeroEv.capture!.meanRgb[c]! + 10),
      'Two stops must visibly brighten every channel of the nonzero final GI image.');
    const exposureRestored = await frame(engine, canvas, onOptions, 'exposure-default-restored'); captures.push(exposureRestored.capture!);
    require(same(exposureRestored.capture!.pixels, capped.capture!.pixels), 'Exposure must default to EV0 per render, rather than persist the last explicit EV.');
    const rawViews: Record<string, unknown>[] = [];
    for (const debugView of ['normal', 'material', 'depth', 'shadow'] as const) {
      const rawZero = await frame(engine, canvas, { ...onOptions, debugView, exposureEV: 0 }, `exposure-${debugView}-zero`);
      const rawNegative = await frame(engine, canvas, { ...onOptions, debugView, exposureEV: -2 }, `exposure-${debugView}-minus-two`);
      captures.push(rawZero.capture!, rawNegative.capture!);
      require(rawZero.capture!.maxRgb.some(value => value > 8), `${debugView} exposure witness must contain nonblack values.`);
      require(same(rawZero.capture!.pixels, rawNegative.capture!.pixels), `${debugView} contains raw diagnostic quantities and must be byte-identical across exposure changes.`);
      rawViews.push({ debugView, meanRgb: rawZero.capture!.meanRgb, identical: true });
    }
    const invalidExposure: Record<string, unknown>[] = [];
    for (const [name, exposureEV] of [['nan', NaN], ['positive-infinity', Infinity], ['negative-infinity', -Infinity],
      ['above-range', 16.01], ['below-range', -16.01], ['string', '2'], ['null', null]] as const) {
      const before = engine.getTelemetry(), size = [canvas.width, canvas.height]; let rejection = '';
      try { engine.render({ ...onOptions, exposureEV } as unknown as RenderOptions); } catch (error) { rejection = code(error); }
      require(rejection === 'INVALID_OPTIONS', `Invalid exposure ${name} must reject with INVALID_OPTIONS.`);
      require(same(engine.getTelemetry(), before) && same([canvas.width, canvas.height], size),
        `Invalid exposure ${name} must preserve all public counters, allocations, receipt, progress and canvas dimensions.`);
      invalidExposure.push({ name, rejection });
    }
    const afterInvalidExposure = await frame(engine, canvas, onOptions, 'exposure-after-invalid'); captures.push(afterInvalidExposure.capture!);
    require(same(afterInvalidExposure.capture!.pixels, capped.capture!.pixels), 'A valid default render after rejected EV values must preserve the capped image.');
    const exposureAfter = counters(engine, 16 * 16 * limits.maxSamples);
    require(exposureAfter.revision === exposureBefore.revision && exposureAfter.attempted === exposureBefore.attempted
      && exposureAfter.completed === exposureBefore.completed, 'EV changes and raw debug views must not reset, resample or mutate the capped GI accumulation.');
    require(same([engine.getTelemetry().allocatedGpuBufferBytes, engine.getTelemetry().allocatedGpuTextureBytes], exposureAllocations),
      'Exposure and raw-view changes must not allocate replacement GI or raster targets.');
    cases.push({ name: 'public-presentation-exposure-preserves-capped-gi', exposureBefore, exposureAfter, rawViews, invalidExposure,
      defaultMeanRgb: zeroEv.capture!.meanRgb, plusTwoMeanRgb: plusTwoEv.capture!.meanRgb,
      scope: 'Actual public presentation and capped progressive GI; progressive mode deliberately disables TAA, so this case makes no TAA-history claim.' });

    const beforeRejected = engine.getTelemetry(); const beforeSize = [canvas.width, canvas.height];
    let resizeError = '';
    try { engine.resize(33, 33); } catch (error) { resizeError = code(error); }
    require(resizeError === 'UNSUPPORTED_LIMIT', 'Resize above maxPixels must reject with UNSUPPORTED_LIMIT.');
    require(same([canvas.width, canvas.height], beforeSize) && same(engine.getTelemetry(), beforeRejected), 'Rejected resize must preserve canvas, receipt, allocations and progress.');
    await frame(engine, canvas, onOptions);
    const priorResize = engine.getTelemetry().imported!.indirect!.progress;
    engine.resize(32, 32);
    require(same(engine.getTelemetry().imported!.indirect!.progress, priorResize), 'Resize must not fabricate a submitted accumulation reset.');
    const resized = await frame(engine, canvas, onOptions, 'resized-32'); captures.push(resized.capture!);
    const resizedCounters = counters(engine, 32 * 32);
    require(resizedCounters.revision > priorResize.revision && resizedCounters.submittedFrames === 1, 'First resized submission must commit one new accumulation revision.');
    require(resizedCounters.width === 32 && resizedCounters.height === 32, 'Counter dimensions must identify the resized accumulation.');
    cases.push({ name: 'resize-preflight-and-commit', resizeError, beforeSize, priorResize, resizedCounters });

    const beforeInvalid = engine.getTelemetry(); const jobsBeforeInvalid = workerEvents.filter(v => v.type === 'build-static-bvh').length;
    let invalidOptions = '', invalidSource = '';
    try { await engine.setScene({ renderer: 'imported', asset, indirect: { ...limits, maxSamples: 0 } }); } catch (error) { invalidOptions = code(error); }
    const bad = floorAsset(); bad.primitives[0]!.indices[2] = 99;
    try { await engine.setScene({ renderer: 'imported', asset: bad, indirect: limits }); } catch (error) { invalidSource = code(error); }
    require(invalidOptions === 'INVALID_OPTIONS' && invalidSource === 'INVALID_OPTIONS', 'Invalid options and source indices must reject before worker construction.');
    require(workerEvents.filter(v => v.type === 'build-static-bvh').length === jobsBeforeInvalid, 'Rejected preflight/source must not post a BVH build.');
    require(same(engine.getTelemetry().scene, beforeInvalid.scene), 'Failed scene preparation must retain the committed receipt.');
    await frame(engine, canvas, onOptions); counters(engine, 2 * 32 * 32);
    cases.push({ name: 'public-options-source-preflight', invalidOptions, invalidSource });

    // No secondary surface exists in this fixture, so GI cannot add this primary surface's emission again.
    engine.resize(16, 16);
    const emissive = floorAsset([0.12, 0.03, 0.015]);
    await engine.setScene({ renderer: 'imported', asset: emissive, indirect: limits });
    const noSky: ImportedControls = { ...controls, lighting: { ...controls.lighting!, environment: null } };
    const emissionOff = await frame(engine, canvas, { temporal: true, imported: { ...noSky, indirect: { enabled: false } } }, 'emission-off');
    captures.push(emissionOff.capture!);
    require(emissionOff.capture!.minRgb.every(v => v > 8), 'Primary emission witness must be visibly nonzero.');
    for (let i = 0; i < 8; i++) await frame(engine, canvas, { temporal: true, imported: { ...noSky, indirect: { enabled: true } } });
    const emissionOn = await frame(engine, canvas, { temporal: true, imported: { ...noSky, indirect: { enabled: true } } }, 'emission-on');
    captures.push(emissionOn.capture!); const emissionCounters = counters(engine, 9 * 16 * 16);
    require(same(emissionOff.capture!.pixels, emissionOn.capture!.pixels), 'Primary emission must remain identical with zero incoming indirect lighting.');
    cases.push({ name: 'primary-emission-counted-once', emissionCounters, meanRgb: emissionOn.capture!.meanRgb });

    // A known nonzero direct HDR value verifies exposure's numeric 2**EV scale,
    // without relying on sky sampling or comparing two near-black images.
    const emissionOptions: RenderOptions = { temporal: true, imported: { ...noSky, indirect: { enabled: true } } };
    const emissionDirectZero = await frame(engine, canvas, { ...emissionOptions, debugView: 'direct', exposureEV: 0 }, 'exposure-emission-direct-zero');
    const emissionDirectTwo = await frame(engine, canvas, { ...emissionOptions, debugView: 'direct', exposureEV: 2 }, 'exposure-emission-direct-plus-two');
    const emissionFinalTwo = await frame(engine, canvas, { ...emissionOptions, exposureEV: 2 }, 'exposure-emission-final-plus-two');
    const emissionDefault = await frame(engine, canvas, emissionOptions, 'exposure-emission-default');
    captures.push(emissionDirectZero.capture!, emissionDirectTwo.capture!, emissionFinalTwo.capture!, emissionDefault.capture!);
    const expectedEmissionTwo = [0.12, 0.03, 0.015].map(value => display(value * 2 * (2 ** 2)));
    require(same(emissionDirectZero.capture!.pixels, emissionOff.capture!.pixels), 'Direct EV0 must preserve the original emission image.');
    require(emissionDirectTwo.capture!.meanRgb.every((value, c) => Math.abs(value - expectedEmissionTwo[c]!) < 1.5),
      'Direct output must apply exactly fourfold linear exposure before the specified tone and sRGB transfers, within half-float and 8-bit rounding.');
    require(same(emissionDirectTwo.capture!.pixels, emissionFinalTwo.capture!.pixels), 'Final and direct views must expose the same known emission identically when indirect energy is zero.');
    require(same(emissionDefault.capture!.pixels, emissionOff.capture!.pixels), 'Default exposure must return emission to its original byte values.');
    cases.push({ name: 'public-direct-final-exposure-numeric', expectedEmissionTwo, actualMeanRgb: emissionDirectTwo.capture!.meanRgb,
      absoluteDisplayByteTolerance: 1.5, definedBeforeGpuObservation: true });

    let posted!: (id: number) => void;
    const observedPost = new Promise<number>(resolve => { posted = resolve; });
    onBuildPosted = id => { onBuildPosted = undefined; posted(id); };
    const abort = new AbortController();
    const pending = engine.setScene({ renderer: 'imported', asset, indirect: limits, signal: abort.signal })
      .then(() => { throw new Error('Aborted posted worker build unexpectedly committed.'); }, error => code(error));
    const requestId = await bounded(Promise.race([observedPost, pending.then(value => { throw new Error(`Creation ended before a worker job: ${value}`); })]), 'Observed worker build');
    abort.abort();
    const replacement = await bounded(engine.setScene({ renderer: 'imported', asset }), 'Direct replacement after worker cancellation');
    const replacementSequence = workerEvents.length;
    const cancellation = await pending;
    require(cancellation === 'SCENE_LOAD_ABORTED' || cancellation === 'SCENE_LOAD_SUPERSEDED', 'Cancelled candidate must report an explicit cancellation/supersession code.');
    const terminal = workerEvents.find(value => value.direction === 'response' && value.requestId === requestId
      && ['static-bvh-result', 'static-bvh-cancelled', 'static-bvh-error'].includes(value.type));
    require(terminal !== undefined && terminal.sequence < replacementSequence, 'Direct replacement must wait until the real posted worker job terminates.');
    require(workerEvents.some(value => value.direction === 'request' && value.type === 'cancel-static-bvh' && value.requestId === requestId), 'Cancellation must reach the real worker.');
    require(same([...asset.primitives[0]!.vertices], sourceVertices) && same([...asset.primitives[0]!.indices], sourceIndices), 'Worker transfer/cancellation must not detach or mutate caller geometry.');
    const replaced = await frame(engine, canvas, { temporal: false, imported: controls }, 'replacement-direct'); captures.push(replaced.capture!);
    require(engine.getTelemetry().imported?.indirect === undefined && replaced.metrics.scene?.sceneGeneration === replacement.sceneGeneration,
      'The direct replacement must submit its own generation without stale indirect telemetry.');
    await engine.waitForIdle();
    require(engine.getTelemetry().imported?.indirect === undefined, 'Late cancelled completion must never restore progressive telemetry.');
    cases.push({ name: 'posted-worker-cancellation-direct-replacement', cancellation, requestId, terminal, replacement,
      boundary: 'Abort after forwarding a real worker job, before main-thread delivery of its terminal response; no assertion about which WASM step had begun.' });
    require(workerEvents.some(value => value.type === 'ready') && workerEvents.filter(value => value.type === 'static-bvh-result').length >= 2,
      'Successful scenes must execute the packaged real WASM worker builder.');
    await stage('complete');
    engine.dispose(); const disposed = instance.getTelemetry();
    require(disposed.allocatedGpuBufferBytes === 0 && disposed.allocatedGpuTextureBytes === 0 && disposed.wasmMemoryBytes === 0, 'Disposal must release reported GPU/worker allocations.');
    require(workerEvents.filter(value => value.direction === 'terminate').length === workers.size, 'Disposal must terminate every observed engine worker.');
    outcome = { status: 'passed', adapter: instance.info.adapter, ordinaryHosting: { crossOriginIsolated }, cases, captures, workerEvents, disposed,
      fixture: { kind: 'self-contained-opaque-floor-v1', bounds: asset.bounds, camera, limits, vertexFloats: sourceVertices, indices: sourceIndices },
      captureMethod: 'Public render in requestAnimationFrame; same-size 2D drawImage snapshot before callback return; waitForIdle fences that submission and reads counters.',
      acceptance: { settledDisplayRmseBelow: 6, settledMeanAbsoluteDisplayErrorBelow: 3, settledRmseLowerThanFirst: true, definedBeforeGpuObservation: true },
      limitations: ['No raw GPU depth or HDR access through the public API: complete zero-invalid perspective counters establish receiver agreement but do not independently reconstruct depth.',
        'The fixed hash samples are deterministic; finite-sample image gates are sanity bounds, not IID confidence intervals.',
        'Independent B tests cover secondary radiometry, offscreen colored bounce, visibility and exhausted traversal. This harness covers public package/worker/raster integration.',
        'Generated static single-material fixture, small viewport and fixed camera; no real-asset quality, general convergence or performance claim.'] };
    return outcome;
  } catch (error) {
    outcome = { status: 'failed', failure: error instanceof Error ? error.stack : String(error), cases, captures, workerEvents,
      adapter: engine?.info.adapter, ordinaryHosting: { crossOriginIsolated }, failedTelemetry: engine?.getTelemetry() };
    return outcome;
  } finally {
    onBuildPosted = undefined;
    try { engine?.dispose(); if (outcome) outcome.disposed = engine?.getTelemetry(); }
    catch (error) { if (outcome) { outcome.status = 'failed'; outcome.cleanupFailure = String(error); } else throw error; }
    canvas.remove();
    for (const [worker, listener] of listeners) worker.removeEventListener('message', listener);
    Worker.prototype.postMessage = originalPost; Worker.prototype.terminate = originalTerminate;
  }
}
