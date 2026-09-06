/** Functional-only phase diagnostic. Production runtime and WGSL are never rewritten. */
import { IntegratedRenderer } from '../../packages/core/src/integrated/integrated-renderer.js';
import type { ReflectionRenderControls } from '../../packages/core/src/reflections/reflection-renderer.js';
import type { CameraFrame } from '../../packages/core/src/rendering/raster-math.js';
import { assertBytesEqual, createRecordedDevice, finishProofDevice as finishSharedProofDevice, proofSha256, proofWriteInput } from './trace-update-proof-gpu.js';

/** Diagnostic-only monotonic deadline. Promise completion cannot bypass a delayed timer callback. */
export async function traceGiPhaseDeadline<T>(operation: () => T | PromiseLike<T>, label: string, milliseconds = 15000,
  now: () => number = () => performance.now()): Promise<T> {
  const started = now();
  if (!Number.isFinite(started) || !Number.isFinite(milliseconds) || milliseconds <= 0 || !Number.isFinite(started + milliseconds)) {
    throw Error('Invalid phase diagnostic deadline.');
  }
  const expired = (elapsed: number) => !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= milliseconds;
  const failure = (outcome: string, elapsed: number, cause?: unknown) => Object.assign(
    new Error(`Phase diagnostic absolute deadline exceeded: ${label} (${milliseconds}ms; elapsed ${elapsed}ms; ${outcome})`,
      cause === undefined ? undefined : { cause }),
    { phaseDeadline: { label, milliseconds, elapsedMs: elapsed, outcome } });
  let timer: ReturnType<typeof setTimeout> | undefined, timerError: Error | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timerError = failure('timer', now() - started); reject(timerError); }, milliseconds);
    });
    let result: T;
    try {
      result = await Promise.race([Promise.resolve().then(() => {
        const elapsed = now() - started;
        if (expired(elapsed)) throw failure('before operation', elapsed);
        return operation();
      }), timeout]);
    } catch (cause) {
      if (cause === timerError) throw cause;
      const elapsed = now() - started;
      if (expired(elapsed)) throw failure('rejected operation', elapsed, cause);
      throw cause;
    }
    const elapsed = now() - started;
    if (expired(elapsed)) throw failure('resolved operation', elapsed);
    return result;
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Keep shared scope draining/disposal, but reject completion outside this diagnostic's absolute bound. */
export async function finishProofDevice(device: GPUDevice, scopes: number, beforeDestroy: () => void, milliseconds = 15000,
  now: () => number = () => performance.now()) {
  let completed: Awaited<ReturnType<typeof finishSharedProofDevice>> | undefined;
  let pending: ReturnType<typeof finishSharedProofDevice> | undefined;
  try {
    return await traceGiPhaseDeadline(async () => {
      pending = finishSharedProofDevice(device, scopes, beforeDestroy, milliseconds);
      completed = await pending; return completed;
    }, 'phase GPU error-scope cleanup', milliseconds, now);
  } catch (error) {
    // The outer timer may fire just before the shared helper's bounded scope timers.
    // Retain cleanup ownership until that helper has drained and attempted disposal.
    if (pending && !completed) {
      try { completed = await pending; }
      catch (cleanupError) { if (error instanceof Error && cleanupError !== error) Object.assign(error, { cleanupError }); }
    }
    if (completed && error instanceof Error) Object.assign(error, { proofCleanup: completed });
    throw error;
  }
}

function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export const traceGiPhasePlan = freeze({
  version: 1, kind: 'shared-lighting-sample-clock-t16-diagnostic', correctnessOnly: true, performanceEligible: false,
  width: 1280, height: 720, format: 'bgra8unorm' as const, cameraMode: 'tour' as const,
  geometry: { mode: 'resident-full' as const, requestedPoolBytes: 8 * 1024 ** 2, actualPoolBytes: 80 * 65536, pages: 80,
    pixelError: 2, maxConcurrentRequests: 4, uploadBudgetBytes: 4 * 65536 },
  lighting: { probesPerUpdate: 32, raysPerProbe: 64, probeSeed: 1337, resolutionScale: .25 as const,
    maxRaysPerFrame: 32768, roughness: .08, maxDistance: 16, updateEvery: 1 },
  initialWorld: { doorOpen: false, wallColor: 'red' as const, lightIntensity: 1, objectOffset: -.4, roughness: .08 },
  precondition: { time: 5, controls: { temporal: true, debugView: 'final' as const, exposureEV: 0, cameraCut: true,
    gi: { enabled: true, resetCache: true }, reflections: { resetHistory: true, mode: 'world' as const, roughness: .08, maxDistance: 16, updateEvery: 1 } } },
  reset: { time: 16, controls: { temporal: true, debugView: 'final' as const, exposureEV: 0, cameraCut: true,
    gi: { enabled: true, doorOpen: true, wallColor: 'red' as const, lightIntensity: 0, resetCache: true },
    reflections: { mode: 'world' as const, roughness: .08, maxDistance: 16, updateEvery: 1, objectOffset: 0, resetHistory: true } } },
  held: { time: 16, controls: { temporal: true, debugView: 'final' as const, exposureEV: 0 }, count: 240 },
  phases: [{ label: 5399, firstSampleIndex: 6123, lastSampleIndex: 6363 }, { label: 5400, firstSampleIndex: 6124, lastSampleIndex: 6364 }],
  counts: { cells: 4, submissionsPerCell: 242, captureSubmissionsPerCell: 241, totalSubmissions: 968 },
  rawCheckpoints: ['precondition', 'reset', 'final'], imageCheckpoints: ['precondition', 'reset', 'final'],
  readbackLayouts: { probeRay: '32*64*32B', probeState: '384*16B', probeConfig: '96B', probeStats: '32B', reflectionConfig: '240B', reflectionStats: '32B' },
  maxCellMs: 180000, maxRunMs: 300000, readbackDeadlineMs: 15000,
  scope: 'Fresh identical t5 history and resident-full geometry are controlled preconditions, not a reconstruction of the archived timed/streamed history. Only the shared GI/reflection sample clock is injected; local submission IDs are real. Same-phase updater comparisons are exact; cross-phase observations are descriptive.',
});
export function validateTraceGiPhasePlan(input: unknown): typeof traceGiPhasePlan {
  const snapshot: unknown = structuredClone(input);
  const compare = (a: unknown, b: unknown, path: string): void => {
    if (b === null || typeof b !== 'object') { check(Object.is(a, b), `Phase plan differs at ${path}`); return; }
    check(a !== null && typeof a === 'object' && Array.isArray(a) === Array.isArray(b), `Phase plan shape differs at ${path}`);
    if (Array.isArray(b)) check((a as unknown[]).length === b.length, `Phase plan array length differs at ${path}`);
    const keys = Object.keys(b); check(JSON.stringify(Object.keys(a)) === JSON.stringify(keys), `Phase plan keys/order differ at ${path}`);
    for (const key of keys) compare((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
  };
  compare(snapshot, traceGiPhasePlan, 'plan'); return freeze(snapshot as typeof traceGiPhasePlan);
}
/** JSON transport metadata; the archived native frame-uniform bytes remain authoritative. */
export function serializeTraceGiPhaseCamera(camera: CameraFrame) {
  return { view: [...camera.view], viewProjection: [...camera.viewProjection], eye: [...camera.eye], far: camera.far,
    ...(camera.projectionScaleY === undefined ? {} : { projectionScaleY: camera.projectionScaleY }),
    ...(camera.orthographic === undefined ? {} : { orthographic: camera.orthographic }) };
}
const injected = new WeakSet<object>();
/** Deliberate proof-only private-property seam. It changes one numeric clock, never a cache epoch/frontier/history. */
export function injectTraceGiPhaseClock(renderer: unknown, firstSampleIndex: number) {
  check(traceGiPhasePlan.phases.some(p => p.firstSampleIndex === firstSampleIndex), 'Unfrozen shared sample clock.');
  check(renderer && typeof renderer === 'object', 'Renderer is missing.');
  const effect = Object.getOwnPropertyDescriptor(renderer, 'effect')?.value as Record<string, unknown> | undefined;
  check(effect && typeof effect === 'object' && !injected.has(effect), 'Missing/already injected effect.');
  const descriptor = Object.getOwnPropertyDescriptor(effect, 'frames');
  check(descriptor && 'value' in descriptor && descriptor.writable && descriptor.value === 1, 'Clock seam requires exactly one completed precondition.');
  check(effect.pendingProbes === undefined && effect.pendingTraceUpdateCount === undefined && effect.disposed === false, 'Effect has pending/disposed work.');
  const caches = ['probeCache', 'reflectionCache'].map(key => effect[key] as Record<string, unknown>);
  for (const cache of caches) check(cache && cache.pending === undefined && cache.disposed === false, 'Cache has pending/disposed work.');
  const owners = [effect, ...caches], before = owners.map(owner => Object.getOwnPropertyDescriptors(owner));
  effect.frames = firstSampleIndex;
  owners.forEach((owner, i) => { const now = Object.getOwnPropertyDescriptors(owner), old = before[i]!;
    check(JSON.stringify(Object.keys(now)) === JSON.stringify(Object.keys(old)), 'Clock injection changed property shape.');
    for (const key of Object.keys(old)) if (!(i === 0 && key === 'frames')) {
      const a = old[key]!, b = now[key]!; check(Object.is(a.value, b.value) && a.get === b.get && a.set === b.set
        && a.writable === b.writable && a.configurable === b.configurable && a.enumerable === b.enumerable, 'Clock injection changed another property.');
    }
  });
  injected.add(effect);
  return { path: 'IntegratedRenderer.effect.frames', previousValue: descriptor.value as number, value: firstSampleIndex,
    changedPropertyCount: 1, cachesUnchanged: true, historicalSubmissionIdsSynthesized: false };
}
function clock(renderer: IntegratedRenderer): number { return (renderer as unknown as { effect: { frames: number } }).effect.frames; }
const arrays = (r: IntegratedRenderer) => [r.traceData.nodeData, r.traceData.triangleData, r.traceData.boxData, r.traceData.materialData, r.traceData.uniformData];
function b64(data: ArrayBuffer | ArrayBufferView): string {
  const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  let text = ''; for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384)); return btoa(text);
}
/** Same native copy/readback protocol as the shared helper, with this preregistration's explicit15s bound. */
async function readBuffer(device: GPUDevice, source: GPUBuffer): Promise<ArrayBuffer> {
  check(source.size > 0 && source.size % 4 === 0 && Boolean(source.usage & 4), 'Unexpected source buffer readback contract.');
  const buffer = device.createBuffer({ label: 'Strata phase diagnostic buffer copy', size: source.size, usage: 1 | 8 });
  try { const e = device.createCommandEncoder(); e.copyBufferToBuffer(source, 0, buffer, 0, source.size); device.queue.submit([e.finish()]);
    await traceGiPhaseDeadline(() => buffer.mapAsync(1), 'phase buffer mapping', 15000);
    const bytes = buffer.getMappedRange().slice(0); buffer.unmap(); return bytes;
  } finally { buffer.destroy(); }
}
async function textureBytes(device: GPUDevice, texture: GPUTexture) {
  const bpp = ({ bgra8unorm: 4, rgba8unorm: 4, rgba16float: 8, rg32float: 8, rgba32uint: 16, depth32float: 4, r32float: 4 } as Partial<Record<GPUTextureFormat, number>>)[texture.format];
  check(bpp, `Unexpected texture format ${texture.format}`);
  const row = texture.width * bpp, stride = Math.ceil(row / 256) * 256, buffer = device.createBuffer({ size: stride * texture.height, usage: 1 | 8 });
  try { const e = device.createCommandEncoder(); e.copyTextureToBuffer({ texture, ...(texture.format === 'depth32float' ? { aspect: 'depth-only' as const } : {}) },
    { buffer, bytesPerRow: stride, rowsPerImage: texture.height }, [texture.width, texture.height]); device.queue.submit([e.finish()]);
    await traceGiPhaseDeadline(() => buffer.mapAsync(1), `phase texture ${texture.label}`, 15000);
    const raw = new Uint8Array(buffer.getMappedRange()), out = new Uint8Array(row * texture.height);
    for (let y = 0; y < texture.height; y++) out.set(raw.subarray(y * stride, y * stride + row), y * row); buffer.unmap(); return out.buffer;
  } finally { buffer.destroy(); }
}
/** Diagnostic only: exact integer-coordinate depth load, no comparison sampler or source descriptor change. */
export const traceGiPhaseShadowReadShader = `@group(0) @binding(0) var source:texture_depth_2d;
@group(0) @binding(1) var output:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn readShadow(@builtin(global_invocation_id) id:vec3u){
if(any(id.xy>=textureDimensions(source))){return;}
textureStore(output,vec2i(id.xy),vec4f(textureLoad(source,vec2i(id.xy),0),0,0,0));}`;
export interface TraceGiPhaseArtifact { name: string; bytes: number; sha256: string; base64: string; format?: string; width?: number; height?: number }
export interface TraceGiPhaseOptions { plan: unknown; phaseLabel: number; manifestUrl: string; traceProxyUrl: string }
export async function runTraceGiPhaseCell(native: GPUDevice, input: TraceGiPhaseOptions,
  save: (artifact: TraceGiPhaseArtifact) => Promise<void>, event: (value: unknown) => Promise<void>) {
  const plan = validateTraceGiPhasePlan(input.plan), phase = plan.phases.find(p => p.label === input.phaseLabel);
  check(phase, 'Unfrozen phase label.');
  const recorded = createRecordedDevice(native), buffers = new Map<string, GPUBuffer>(), textures = new Map<string, GPUTexture>();
  const uniformWrites = new Map<string, Uint8Array<ArrayBuffer>>();
  const queue = new Proxy(recorded.device.queue, { get(target, key) {
    if (key === 'writeBuffer') return (...args: Parameters<GPUQueue['writeBuffer']>) => {
      const bytes = proofWriteInput(args[2], args[3], args[4]); target.writeBuffer(...args);
      if (/Strata (probe config|reflection config|current and previous transforms|presentation settings)/.test(args[0].label)) {
        check(args[1] === 0 && bytes.length === args[0].size, 'Unexpected partial diagnostic uniform upload.'); uniformWrites.set(args[0].label, bytes);
      }
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const device = new Proxy(recorded.device, { get(target, key) {
    if (key === 'queue') return queue;
    if (key === 'createBuffer') return (d: GPUBufferDescriptor) => { const b = target.createBuffer(d); buffers.set(d.label ?? '', b); return b; };
    if (key === 'createTexture') return (d: GPUTextureDescriptor) => { const t = target.createTexture(d); textures.set(d.label ?? '', t); return t; };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  let renderer: IntegratedRenderer | undefined, output: GPUTexture | undefined, localFrameId = 0;
  const frames: unknown[] = [], checkpoints: unknown[] = [], report = { status: 'running', phase, plan, frames, checkpoints,
    injection: null as ReturnType<typeof injectTraceGiPhaseClock> | null, cleanup: null as unknown };
  const writeRecord = async (name: string, data: ArrayBuffer | ArrayBufferView, texture?: GPUTexture) => {
    const record = { name, bytes: data.byteLength, sha256: await proofSha256(data), ...(texture ? { format: texture.format, width: texture.width, height: texture.height } : {}) };
    await save({ ...record, base64: b64(data) }); return record;
  };
  try {
    let abandonCreation = false, createdRenderer: IntegratedRenderer | undefined;
    try {
      renderer = await traceGiPhaseDeadline(async () => {
        createdRenderer = await IntegratedRenderer.create(device, plan.format, { renderer: 'integrated', manifestUrl: input.manifestUrl, traceProxyUrl: input.traceProxyUrl,
          cameraMode: plan.cameraMode, geometryMode: plan.geometry.mode, poolBytes: plan.geometry.requestedPoolBytes, pixelError: plan.geometry.pixelError,
          maxConcurrentRequests: plan.geometry.maxConcurrentRequests, uploadBudgetBytes: plan.geometry.uploadBudgetBytes,
          ...plan.initialWorld, probesPerUpdate: plan.lighting.probesPerUpdate, raysPerProbe: plan.lighting.raysPerProbe,
          resolutionScale: plan.lighting.resolutionScale, maxRaysPerFrame: plan.lighting.maxRaysPerFrame });
        if (abandonCreation) createdRenderer.dispose();
        return createdRenderer;
      }, 'phase renderer creation', 60000);
    } catch (error) { abandonCreation = true; createdRenderer?.dispose(); throw error; }
    const r = renderer;
    let shadowPipeline: Promise<GPUComputePipeline> | undefined;
    const nativeCopy = async (t: GPUTexture): Promise<ArrayBuffer> => {
      if (t.usage & 1) return textureBytes(native, t);
      check(t.format === 'depth32float' && Boolean(t.usage & 4), 'Unexpected noncopyable diagnostic texture.');
      const pipeline = await traceGiPhaseDeadline(() => shadowPipeline ??= native.createComputePipelineAsync({ layout: 'auto', compute: { module: native.createShaderModule({ label: 'Strata phase diagnostic exact shadow texel load', code: traceGiPhaseShadowReadShader }), entryPoint: 'readShadow' } }), 'shadow diagnostic pipeline', 15000);
      const copy = native.createTexture({ label: 'Strata phase diagnostic shadow copy', size: [t.width, t.height], format: 'r32float', usage: 8 | 1 });
      try { const group = native.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.createView() }, { binding: 1, resource: copy.createView() }] });
        const e = native.createCommandEncoder(), pass = e.beginComputePass({ label: 'Strata phase diagnostic shadow read' }); pass.setPipeline(pipeline); pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(t.width / 8), Math.ceil(t.height / 8)); pass.end(); native.queue.submit([e.finish()]); return await textureBytes(native, copy);
      } finally { copy.destroy(); }
    };
    check(r.geometryTelemetry.residentPages === 80 && r.geometryTelemetry.poolBytes === plan.geometry.actualPoolBytes, 'Diagnostic all80-page residency differs.');
    output = native.createTexture({ label: 'Strata phase native presentation', size: [plan.width, plan.height], format: plan.format, usage: 0x10 | 1 });
    const trace = [...recorded.traceBuffers.values()]; check(trace.length === 5, 'Expected five persistent source buffers.');
    const model = trace.map(b => new Uint8Array(b.size)); let applied = 0;
    const physical = async (name: string, archive: boolean) => {
      for (; applied < recorded.writes.length; applied++) { const w = recorded.writes[applied]!; check(w.returned, 'Unexpected native trace write failure.');
        const index = trace.findIndex(b => b.label === w.label); check(index >= 0, 'Unowned trace write.'); model[index]!.set(w.bytes, w.offset); }
      check([...recorded.traceBuffers.values()].every((b, i) => b === trace[i]), 'Source resource identity changed.');
      const result = [];
      for (const [i, b] of trace.entries()) { const bytes = await readBuffer(native, b); assertBytesEqual(bytes, model[i]!, `actual trace write model ${name}/${i}`);
        assertBytesEqual(bytes, arrays(r)[i]!, `actual latest CPU target ${name}/${i}`);
        result.push(archive ? await writeRecord(`${name}/trace-${i}.bin`, bytes) : { bytes: bytes.byteLength, sha256: await proofSha256(bytes) }); }
      return result;
    };
    const observe = async (id: string, archive: boolean, capture: boolean) => {
      const p = r.probeCache.diagnostics, q = r.reflectionCache.diagnostics;
      check(p.configBuffer.size === 96 && p.rayBuffer.size === 32 * 64 * 32 && p.stateBuffer.size === 384 * 16 && q.configBuffer.size === 240, 'Actual diagnostic ABI changed.');
      const resourceBuffers: Record<string, GPUBuffer> = { probeRay: p.rayBuffer, probeState: p.stateBuffer, probeStats: p.statisticsBuffer, probeConfig: p.configBuffer,
        reflectionStats: q.statisticsBuffer, reflectionConfig: q.configBuffer };
      for (const label of ['Strata current tile LOD selections', 'Strata indirect geometry arguments and counters']) {
        const b = buffers.get(label); check(b, `Missing geometry diagnostic ${label}`); resourceBuffers[label] = b;
      }
      const raw: Record<string, ArrayBuffer> = {}, records: Record<string, unknown> = {};
      for (const [key, b] of Object.entries(resourceBuffers)) { const data = await readBuffer(native, b); raw[key] = data;
        records[key] = archive ? await writeRecord(`${id}/${key.replaceAll(' ', '-')}.bin`, data) : { bytes: data.byteLength, sha256: await proofSha256(data) }; }
      const pc = new Uint32Array(raw.probeConfig!), rc = new Uint32Array(raw.reflectionConfig!);
      const expectedSample = localFrameId === 1 ? 0 : phase.firstSampleIndex + localFrameId - 2;
      check(pc[16] === expectedSample && rc[40] === expectedSample && clock(r) === expectedSample + 1, 'Actual shared-clock configuration differs.');
      check(pc[18] === plan.lighting.probeSeed && pc[9] === 32 && pc[10] === 64, 'Actual probe sampling budget or seed changed.');
      check(r.giTelemetry.hysteresis === .85 && new Float32Array(raw.probeConfig!)[12] === Math.fround(.85), 'Actual probe hysteresis differs from preregistration.');
      const sinceReset = localFrameId === 1 ? 1 : localFrameId - 1;
      check(r.giTelemetry.sampleFrameIndex === expectedSample && r.giTelemetry.framesSinceReset === sinceReset && r.giTelemetry.refreshFrontier === sinceReset * 32 % 384
        && r.giTelemetry.sourceFrameId === localFrameId && r.giTelemetry.submittedFrames === localFrameId, 'Actual probe lifecycle differs.');
      check(pc[11] === (localFrameId === 1 ? 1 : 2) && pc[17] === Number(localFrameId <= 2), 'Actual reset epoch/flag differs.');
      check(rc[41] === pc[11] && rc[52] === Number(localFrameId <= 2) && r.reflectionTelemetry.framesSinceReset === sinceReset
        && r.reflectionTelemetry.submittedFrames === localFrameId && r.reflectionTelemetry.sourceFrameId === localFrameId,
      'Actual reflection reset/history/submission differs.');
      check(r.giTelemetry.enabled === true && r.reflectionTelemetry.mode === 'world' && r.reflectionTelemetry.roughness === .08
        && r.reflectionTelemetry.resolutionScale === .25 && r.reflectionTelemetry.maxDistance === 16 && r.reflectionTelemetry.updateEvery === 1,
      'Actual enabled lighting controls differ.');
      const expectedWorld = localFrameId === 1 ? plan.initialWorld : { ...plan.initialWorld, doorOpen: true, lightIntensity: 0, objectOffset: 0 };
      check(Object.entries(expectedWorld).every(([key, value]) => Object.is((r.currentScene.state as unknown as Record<string, unknown>)[key], value)), 'Actual source world differs.');
      const states = new Uint32Array(raw.probeState!), valid = Array.from({ length: 384 }, (_, i) => states[i * 4 + 1]!);
      check(valid.every(v => v === 0 || v === 1), 'Probe validity words are malformed.');
      const rayFloats = new Float32Array(raw.probeRay!); check(rayFloats.every(Number.isFinite), 'Probe ray buffer contains nonfinite values.');
      check(new Uint32Array(raw.probeStats!)[3] === 0, 'Probe traversal exhaustion in phase diagnostic.');
      if (id === 'final') for (let i = 0; i < 384; i++) check(states[i * 4] === pc[11] && states[i * 4 + 2] === (i < 32 ? 21 : 20)
        && expectedSample >= states[i * 4 + 3]! && expectedSample - states[i * 4 + 3]! <= 11, 'Final probe epoch/update/age gate failed.');
      const uploads: Record<string, unknown> = {};
      for (const label of ['Strata current and previous transforms', 'Strata presentation settings', p.configBuffer.label, q.configBuffer.label]) {
        const data = uniformWrites.get(label); check(data, `Missing actual native uniform write ${label}`);
        uploads[label] = archive ? await writeRecord(`${id}/upload-${label.replaceAll(' ', '-')}.bin`, data) : { bytes: data.byteLength, sha256: await proofSha256(data) };
        if (label === p.configBuffer.label) assertBytesEqual(data, raw.probeConfig!, 'Actual probe upload vs GPU readback');
        if (label === q.configBuffer.label) assertBytesEqual(data, raw.reflectionConfig!, 'Actual reflection upload vs GPU readback');
      }
      const images: Record<string, unknown> = {};
      if (capture) {
        const selected: Record<string, GPUTexture> = { native: output!, probeIrradiance: p.irradianceTexture, probeVisibility: p.visibilityTexture,
          reflectionRaw: q.rawTexture, reflectionRawMetadata: q.rawMetadataTexture, reflectionRadiance: q.radianceTexture, reflectionSurface: q.surfaceTexture, reflectionMetadata: q.metadataTexture };
        for (const label of ['Strata linear HDR and shadow visibility', 'Strata world normals and roughness', 'Strata linear base color and metallic',
          'Strata motion and current/previous view depths', 'Strata raster depth', 'Strata directional shadow depth', 'Strata composed reflection HDR']) { const t = textures.get(label); check(t, `Missing MRT ${label}`); selected[label] = t; }
        for (const [key, t] of Object.entries(selected)) {
          const data = await nativeCopy(t);
          // Archive original bytes before validating radiometric integrity.
          images[key] = await writeRecord(`${id}/${key.replaceAll(' ', '-')}.bin`, data, t);
          if (t.format === 'rgba16float') check(new Uint16Array(data).every(word => (word & 0x7c00) !== 0x7c00), `Nonfinite half-float ${key}`);
          if (['rg32float', 'r32float', 'depth32float'].includes(t.format)) check(new Float32Array(data).every(Number.isFinite), `Nonfinite float ${key}`);
        }
      }
      const value = { id, localFrameId, effectFrames: clock(r), controls: structuredClone(r.currentScene.state), gi: { ...r.giTelemetry }, reflections: { ...r.reflectionTelemetry },
        geometry: { ...r.geometryTelemetry }, probeConfig: [...pc], reflectionConfig: [...rc], buffers: records, images, uploads, validProbeCount: valid.filter(Boolean).length, invalidProbeCount: valid.filter(v => !v).length,
        camera: r.currentCamera ? serializeTraceGiPhaseCamera(r.currentCamera) : null,
        ...(archive ? { trace: await physical(id, true) } : {}) };
      frames.push(value); if (archive) checkpoints.push(value); await event({ type: 'frame', ...value }); return value;
    };
    const submit = async (id: string, time: number, controls: ReflectionRenderControls, archive: boolean, capture: boolean) => {
      recorded.setPhase(id); const first = recorded.writes.length, e = native.createCommandEncoder();
      const before = { localFrameId, effectFrames: clock(r), gi: { ...r.giTelemetry }, reflections: { ...r.reflectionTelemetry }, controls: structuredClone(r.currentScene.state) };
      try {
        r.encode(e, output!.createView(), plan.width, plan.height, time, controls);
        if (id === 'reset') {
          const p = await readBuffer(native, r.probeCache.diagnostics.configBuffer), q = await readBuffer(native, r.reflectionCache.diagnostics.configBuffer), pw = new Uint32Array(p), qw = new Uint32Array(q);
          await writeRecord('reset-queued/probeConfig.bin', p); await writeRecord('reset-queued/reflectionConfig.bin', q);
          check(pw[8] === 0 && pw[17] === 1 && pw[11] === Number(before.gi.cacheEpoch) + 1 && pw[16] === phase.firstSampleIndex
            && qw[44] === 0 && qw[52] === 1 && qw[41] === Number(before.reflections.cacheEpoch) + 1 && qw[40] === phase.firstSampleIndex,
          'Precommit reset configuration differs.');
          check(r.giTelemetry.sampleFrameIndex === before.gi.sampleFrameIndex && r.giTelemetry.sourceFrameId === before.gi.sourceFrameId
            && r.giTelemetry.cacheEpoch === before.gi.cacheEpoch && r.reflectionTelemetry.cacheEpoch === before.reflections.cacheEpoch,
          'Queued reset prematurely committed cache telemetry.');
          await event({ type: 'reset-queued', before, probeConfig: [...pw], reflectionConfig: [...qw], localFrameId });
        }
        native.queue.submit([e.finish()]); r.submitted(++localFrameId);
      }
      catch (error) { r.cancelFrame(); throw error; }
      await traceGiPhaseDeadline(() => native.queue.onSubmittedWorkDone(), `phase submission ${id}`, 15000);
      await traceGiPhaseDeadline(() => r.flushFeedback(15000), `geometry feedback ${id}`, 15000);
      for (let i = first; i < recorded.writes.length; i++) { const w = recorded.writes[i]!; await writeRecord(`writes/${String(i).padStart(4, '0')}.bin`, w.bytes); }
      if (localFrameId > 2) check(recorded.writes.length === first, 'Held capture unexpectedly changed tracing source.');
      await event({ type: 'submission', id, before, requestedControls: controls, time, firstWrite: first, writes: recorded.writes.slice(first).map(w => ({ label: w.label, offset: w.offset, byteLength: w.byteLength, returned: w.returned, phase: w.phase })) });
      return observe(id, archive, capture);
    };
    for (const [i, w] of recorded.writes.entries()) await writeRecord(`writes/${String(i).padStart(4, '0')}.bin`, w.bytes);
    await event({ type: 'creation', trace: await physical('initial', true), gi: { ...r.giTelemetry }, reflections: { ...r.reflectionTelemetry }, geometry: { ...r.geometryTelemetry }, effectFrames: clock(r), controls: structuredClone(r.currentScene.state), initialWrites: recorded.writes.map(w => ({ label: w.label, offset: w.offset, bytes: w.byteLength, returned: w.returned })) });
    await submit('precondition', plan.precondition.time, plan.precondition.controls, true, true);
    const beforeInjection = { gi: { ...r.giTelemetry }, reflection: { ...r.reflectionTelemetry }, frames: clock(r) };
    report.injection = injectTraceGiPhaseClock(r, phase.firstSampleIndex);
    check(JSON.stringify(beforeInjection.gi) === JSON.stringify(r.giTelemetry) && JSON.stringify(beforeInjection.reflection) === JSON.stringify(r.reflectionTelemetry), 'Injection changed published cache telemetry.');
    const injectionTrace = await physical('post-injection', true);
    await event({ type: 'injection', trace: injectionTrace, before: beforeInjection, injection: report.injection, after: { gi: { ...r.giTelemetry }, reflection: { ...r.reflectionTelemetry }, frames: clock(r) } });
    await submit('reset', plan.reset.time, plan.reset.controls, true, true);
    for (let i = 1; i <= plan.held.count; i++) await submit(i === 240 ? 'final' : `held-${i}`, plan.held.time, plan.held.controls, i === 240, i === 240);
    check(localFrameId === 242 && r.giTelemetry.sampleFrameIndex === phase.lastSampleIndex, 'Final phase bound differs.');
    report.status = 'passed'; return report;
  } catch (error) { report.status = 'failed'; throw Object.assign(error instanceof Error ? error : Error(String(error)), { proofEvidence: report }); }
  finally {
    const before = renderer ? { buffers: renderer.gpuBufferBytes, textures: renderer.gpuTextureBytes } : null;
    const failures: string[] = [];
    try { renderer?.cancelFrame(); renderer?.dispose(); } catch (error) { failures.push(String(error)); }
    try { output?.destroy(); } catch (error) { failures.push(String(error)); }
    const after = renderer ? { buffers: renderer.gpuBufferBytes, textures: renderer.gpuTextureBytes } : null;
    report.cleanup = { before, after, outputDestroyed: true, errors: failures };
    await event({ type: 'cell-cleanup', cleanup: report.cleanup });
    if (failures.length || after && (after.buffers !== 0 || after.textures !== 0)) {
      report.status = 'failed'; throw Object.assign(Error('Phase resource cleanup failed.'), { proofEvidence: report });
    }
  }
}
