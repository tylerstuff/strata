import { GiRenderer } from '../../packages/core/src/gi/gi-renderer.js';
import { ReflectionRenderer } from '../../packages/core/src/reflections/reflection-renderer.js';
import { IntegratedRenderer } from '../../packages/core/src/integrated/integrated-renderer.js';
import type { ReflectionRenderControls } from '../../packages/core/src/reflections/reflection-renderer.js';
import type { GiTraceData } from '../../packages/core/src/gi/trace-data.js';
import { assertBytesEqual, createRecordedDevice, proofDeadline, proofSha256, readBuffer } from './trace-update-proof-gpu.js';

export type RendererProofKind = 'gi' | 'reflections' | 'integrated';
export interface RendererProofOptions {
  kind: RendererProofKind; manifestUrl?: string; traceProxyUrl?: string;
  /** Test-only selection of existing production residency controls. */
  residency?: 'resident-full' | 'streamed';
}
export interface RendererProofStep {
  readonly id: string; readonly action: 'submit' | 'cancel' | 'fail-write';
  readonly controls: ReflectionRenderControls; readonly time: number;
  readonly width: number; readonly height: number; readonly checkpoint: boolean;
  readonly failWriteOrdinal?: number;
}
const baseWorld = { doorOpen: true, wallColor: 'red' as const, lightIntensity: 1, objectOffset: 0, roughness: .08 };
const mutations = [ {}, { objectOffset: -.4 }, { objectOffset: .4 }, {}, { doorOpen: false }, {}, { wallColor: 'neutral' },
  { wallColor: 'neutral', roughness: .3 }, { wallColor: 'neutral', roughness: .3, lightIntensity: 0 },
  { wallColor: 'neutral', roughness: .3, lightIntensity: 2 },
  { objectOffset: -.4, doorOpen: false, wallColor: 'red', lightIntensity: 1, roughness: .08 }, {}, {},
] as const;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function steps(kind: RendererProofKind): readonly RendererProofStep[] {
  const result: RendererProofStep[] = [];
  const add = (id: string, controls: ReflectionRenderControls = {}, checkpoint = false,
    action: RendererProofStep['action'] = 'submit', width = 320, height = 180) => {
    const effective = { ...controls, temporal: false };
    if (kind === 'gi') delete effective.reflections;
    result.push({ id, action, controls: effective, time: 0, width, height, checkpoint,
      ...(action === 'fail-write' ? { failWriteOrdinal: 2 } : {}) });
  };
  for (let i = 0; i < 12; i++) add(`sharp-warm-${i + 1}`, {}, i === 0 || i === 11);
  if (kind !== 'gi') add('sharp-moved-point4', { reflections: { objectOffset: .4, roughness: 0 } }, true);
  for (const [index, patch] of mutations.entries()) {
    const world = { ...baseWorld, ...patch };
    add(`world-S${index}`, { gi: { doorOpen: world.doorOpen, wallColor: world.wallColor, lightIntensity: world.lightIntensity },
      reflections: { objectOffset: world.objectOffset, roughness: world.roughness } }, index > 0);
  }
  for (let i = 0; i < 12; i++) add(`${kind === 'gi' ? 'steady' : 'soft-motion'}-${i + 1}`,
    { reflections: { objectOffset: .4 * Math.sin((i + 1) * Math.PI * 2 / 12) } }, i === 11);
  for (let i = 0; i < 12; i++) add(`stopped-${i + 1}`, { reflections: { objectOffset: 0 } }, i === 11);
  add('hard-reset-cancel', { gi: { resetCache: true } }, false, 'cancel');
  add('hard-reset-retry', {}, true);
  add('disabled-edit-1', { gi: { enabled: false, lightIntensity: .5 }, reflections: { mode: 'off', objectOffset: .2 } });
  add('disabled-edit-2', { gi: { doorOpen: false }, reflections: { objectOffset: -.2 } });
  add('disabled-edit-3', { gi: { wallColor: 'neutral', lightIntensity: 1.25 }, reflections: { objectOffset: .4 } });
  add('reenable', { gi: { enabled: true }, reflections: { mode: 'world' } }, true);
  add('queued-upload-cancel', { gi: { lightIntensity: 1.75 }, reflections: { objectOffset: -.4 } }, false, 'cancel');
  add('queued-upload-retry', {}, false);
  add('partial-write-failure', { gi: { doorOpen: true, wallColor: 'red', lightIntensity: .75 }, reflections: { objectOffset: .4 } }, false, 'fail-write');
  add('new-target-retry', { gi: { doorOpen: false, wallColor: 'neutral', lightIntensity: 2 }, reflections: { objectOffset: .1 } }, true);
  add('reverse-to-initial', { gi: { doorOpen: true, wallColor: 'red', lightIntensity: 1 }, reflections: { objectOffset: 0, roughness: .08 } });
  add('camera-cut', { cameraCut: true }, true);
  add('resize', {}, true, 'submit', 384, 216);
  return freeze(result);
}
export const rendererProofPlan = freeze({
  version: 'issue20-renderer-pair-v2', format: 'rgba8unorm' as GPUTextureFormat,
  settings: { temporal: false, probesPerUpdate: 32, raysPerProbe: 64, seed: 1337, roughness: 0,
    resolutionScale: 1, maxRaysPerFrame: 32768, maxDistance: 16, screenTracing: false, requestedResidentPoolBytes: 8 * 1024 ** 2,
    allocatedCanonicalResidentPoolBytes: 80 * 65536, streamedPoolBytes: 1024 ** 2 },
  limits: { successfulFramesPerArm: 96, textureCheckpointsPerFixture: 24, streamedFramesPerPose: 30,
    streamedDeadlineMs: 90_000, totalDeadlineMs: 600_000 },
  streamedTimes: [0, 34, 46, 0],
  exactCounts: { gi: { steps: 62, submissions: 59, checkpoints: 21 }, reflections: { steps: 63, submissions: 60, checkpoints: 22 },
    integrated: { steps: 63, submissions: 60, checkpoints: 22 } },
  modeTransitions: Object.fromEntries((['gi', 'reflections', 'integrated'] as const).map(kind => {
    let modes: RendererProofModes = { gi: true, reflections: kind === 'gi' ? null : 'world' };
    return [kind, steps(kind).map(step => { modes = advanceRendererProofModes(modes, step.controls); return { id: step.id, ...modes }; })];
  })),
  sharpGeometry: { mirrorMin: [-2, .01, -1], mirrorMax: [-1, .01, 1], planeY: .01,
    initialEmitterCenter: [-.8, 1.12, .2], emitterHalfSize: [.18, .18, .18], emitterEmission: [4, .25, .08],
    objectBoxId: 12, initialOffset: 0, movedOffset: .4, normalBias: .002, tMin: .002, tMax: 16 },
  readbackLayouts: { probeState: '384×16B u32(epoch,valid,updates,lastFrame)', probeRays: '32×64×32B', probeStats: '8u32', probeConfig: '96B',
    reflectionStats: '8u32', reflectionConfig: '240B', irradiance: '192×128 rgba16float, valid current-epoch8×8 tiles',
    visibility: '384×256 rg32float, same16×16 tiles', rawReflection: 'viewport rgba16float/current frame+epoch rgba32uint tags',
    resolvedReflection: 'viewport rgba16float radiance+surface and rgba32uint metadata', hdr: 'viewport rgba16float',
    geometrySelection: 'tileId-ordered8u32 records', geometryResidency: 'pageId-ordered u32 physical slot,0xffffffff absent' },
  steps: { gi: steps('gi'), reflections: steps('reflections'), integrated: steps('integrated') },
  textureScope: 'Current-epoch valid probe tiles; current-frame raw reflection texels; full resolved metadata/radiance and linear HDR. Padding stripped.',
  limitations: 'Correctness only. Full-control BigInt maintenance is ineligible for performance. Streamed churn is candidate-only and can be unexercised.',
});

type Renderer = GiRenderer | ReflectionRenderer | IntegratedRenderer;
type Bag = Readonly<Record<string, number | string | boolean | null>>;
function requireProof(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export interface RendererProofModes { gi: boolean; reflections: 'off' | 'probe-only' | 'world' | null }
export function advanceRendererProofModes(previous: RendererProofModes, controls: ReflectionRenderControls): RendererProofModes {
  return { gi: controls.gi?.enabled ?? previous.gi,
    reflections: previous.reflections === null ? null : controls.reflections?.mode ?? previous.reflections };
}
export function assertRendererProofModes(expected: RendererProofModes, gi: Bag, reflections: Bag | null): void {
  requireProof(gi.enabled === expected.gi && (expected.reflections === null ? reflections === null : reflections?.mode === expected.reflections),
    'Observed effect modes differ from harness-owned requested modes.');
}
export function assertDisabledRendererCaches(before: { probe: Bag; reflection: Bag | null }, after: { probe: Bag; reflection: Bag | null },
  dispatches: readonly { label: string }[]): void {
  requireProof(!dispatches.some(pass => /\bGI\b|reflection/i.test(pass.label)), 'Both-disabled frame encoded a GI/reflection pass.');
  equalJson(after, before, 'Both-disabled frame advanced cache epoch/frontier/sample/source/submission telemetry');
}

/** Diagnostic read of real STORAGE-only buffers; resource descriptors stay unchanged. */
export const rendererProofReadStorageShader = `@group(0) @binding(0) var<storage,read> source:array<u32>;
@group(0) @binding(1) var<storage,read_write> output:array<u32>;
@compute @workgroup_size(64) fn readStorage(@builtin(global_invocation_id) id:vec3u) {
if(id.x < arrayLength(&source)) { output[id.x] = source[id.x]; } }`;
const arrays = (data: GiTraceData) => [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData];
function bytes64(bytes: ArrayBuffer | ArrayBufferView): string {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let result = ''; for (let i = 0; i < view.length; i += 16384) result += String.fromCharCode(...view.subarray(i, i + 16384));
  return btoa(result);
}
async function byteRecord(bytes: ArrayBuffer | ArrayBufferView, includeBytes = false) {
  return { bytes: bytes.byteLength, sha256: await proofSha256(bytes), ...(includeBytes ? { base64: bytes64(bytes) } : {}) };
}
function equal(actual: ArrayBuffer | ArrayBufferView, expected: ArrayBuffer | ArrayBufferView, label: string): void {
  try { assertBytesEqual(actual, expected, label); }
  catch (error) { throw Object.assign(error as Error, { proofByteEvidence: { label, actual: bytes64(actual), expected: bytes64(expected) } }); }
}
function equalJson(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Object.assign(new Error(`${label} differs`), { proofDifference: { label, actual, expected } });
}
/** Independent reset/cancel oracle: the queued config is observable even when its encoder is discarded. */
export function assertProbeResetLifecycle(phase: 'cancel' | 'retry', before: Bag, after: Bag,
  config: ArrayBuffer, beforeState: ArrayBuffer, afterState: ArrayBuffer): void {
  const words = new Uint32Array(config), epoch = Number(before.cacheEpoch) + 1;
  requireProof(Number(before.framesSinceReset) > 1, 'Reset witness lacks prior accumulated history.');
  requireProof(words[8] === 0 && words[9] === 32 && words[10] === 64 && words[11] === epoch && words[17] === 1,
    'Hard reset did not queue epoch+1 and the first32-probe window with reset flag.');
  requireProof(words[16] === Number(before.sampleFrameIndex) + 1, 'Hard reset changed the next unsubmitted sample index.');
  if (phase === 'cancel') {
    equalJson(after, before, 'Cancelled hard reset committed probe telemetry');
    equal(afterState, beforeState, 'Cancelled hard reset changed actual probe state');
    return;
  }
  requireProof(after.cacheEpoch === epoch && after.refreshFrontier === 32 && after.framesSinceReset === 1
    && after.probeUpdatesSinceReset === 32 && after.submittedFrames === Number(before.submittedFrames) + 1
    && after.sampleFrameIndex === words[16] && after.sourceFrameId === Number(before.sourceFrameId) + 1,
  'Retried hard reset did not commit exactly one new epoch/first window/submission.');
  const states = new Uint32Array(afterState);
  for (let probe = 0; probe < 32; probe++) requireProof(states[probe * 4] === epoch && states[probe * 4 + 1] === 1
    && states[probe * 4 + 2] === 1 && states[probe * 4 + 3] === words[16], 'Retried hard reset did not initialize its selected GPU probe record.');
  equal(afterState.slice(32 * 16), beforeState.slice(32 * 16), 'Retried hard reset changed unscheduled GPU probe records');
}
/** Maintenance work differs deliberately; cache/source/submission metadata must agree. */
function semanticTelemetry(telemetry: Bag): Bag {
  const versions = new Set(['traceUpdateCount', 'traceQueuedUpdateCount', 'traceLastSubmittedUpdateCount', 'traceLastSubmittedFrameId']);
  return Object.fromEntries(Object.entries(telemetry).filter(([key]) => !key.startsWith('trace') || versions.has(key)
    || ['traceRepresentation', 'traceGeometryBytes', 'traceFrames', 'traceFailures'].includes(key)));
}
function half(value: number): number {
  const sign = value & 0x8000 ? -1 : 1, exponent = value >>> 10 & 31, mantissa = value & 1023;
  return exponent === 31 ? (mantissa ? NaN : sign * Infinity) : sign * (exponent ? 1 + mantissa / 1024 : mantissa / 1024) * 2 ** (exponent ? exponent - 15 : -14);
}
function finiteRgb(data: ArrayBuffer, label: string): { nonzeroPixels: number; maxRgb: number } {
  const words = new Uint16Array(data); let nonzeroPixels = 0, maxRgb = 0;
  for (let i = 0; i < words.length; i += 4) {
    let nonzero = false;
    for (let channel = 0; channel < 3; channel++) { const value = half(words[i + channel]!);
      requireProof(Number.isFinite(value), `${label} nonfinite RGB at ${i / 4}:${channel}`); nonzero ||= value !== 0; maxRgb = Math.max(maxRgb, value); }
    if (nonzero) nonzeroPixels++;
  }
  return { nonzeroPixels, maxRgb };
}
async function readTexture(device: GPUDevice, texture: GPUTexture): Promise<ArrayBuffer> {
  const bpp = ({ rgba16float: 8, rg32float: 8, rgba32uint: 16, rgba8unorm: 4, depth32float: 4 } as Partial<Record<GPUTextureFormat, number>>)[texture.format];
  requireProof(bpp, `Unsupported proof texture ${texture.format}`);
  const row = texture.width * bpp, stride = Math.ceil(row / 256) * 256;
  const buffer = device.createBuffer({ label: 'Strata renderer proof texture readback', size: stride * texture.height, usage: 1 | 8 });
  try {
    const encoder = device.createCommandEncoder(); encoder.copyTextureToBuffer({ texture, ...(texture.format === 'depth32float' ? { aspect: 'depth-only' as const } : {}) },
      { buffer, bytesPerRow: stride, rowsPerImage: texture.height }, [texture.width, texture.height]);
    device.queue.submit([encoder.finish()]); await proofDeadline(buffer.mapAsync(1), `texture ${texture.label}`);
    const mapped = new Uint8Array(buffer.getMappedRange()), result = new Uint8Array(row * texture.height);
    for (let y = 0; y < texture.height; y++) result.set(mapped.subarray(y * stride, y * stride + row), y * row);
    buffer.unmap(); return result.buffer;
  } finally { buffer.destroy(); }
}
function definedProbeTiles(data: ArrayBuffer, tile: number, states: Uint32Array, epoch: number): ArrayBuffer {
  const source = new Uint8Array(data), result = source.slice(), width = 24 * tile;
  for (let probe = 0; probe < 384; probe++) if (states[probe * 4] !== epoch || states[probe * 4 + 1] === 0) {
    const x = probe % 24 * tile, y = Math.floor(probe / 24) * tile;
    for (let row = 0; row < tile; row++) result.fill(0, ((y + row) * width + x) * 8, ((y + row) * width + x + tile) * 8);
  }
  return result.buffer;
}
function currentRaw(data: ArrayBuffer, metadata: ArrayBuffer, config: Uint32Array, stride: number): ArrayBuffer {
  const result = new Uint8Array(data).slice(), tags = new Uint32Array(metadata);
  for (let i = 0; i < tags.length; i += 4) if (tags[i + 1] !== config[40] || tags[i + 2] !== config[41] || !config[47]) result.fill(0, i / 4 * stride, (i / 4 + 1) * stride);
  return result.buffer;
}
/** Test oracle uses frozen literal geometry; actual scene data never defines the expected hit. */
export function rendererSharpRay(viewProjection: ArrayLike<number>, config: ArrayBuffer, objectOffset: 0 | .4) {
  const geometry = rendererProofPlan.sharpGeometry, center = [...geometry.initialEmitterCenter]; center[2]! += objectOffset;
  const virtual = [center[0]!, 2 * geometry.planeY - center[1]!, center[2]!];
  const transform = (m: ArrayLike<number>, p: readonly number[]) => [0, 1, 2, 3].map(row => m[row]! * p[0]! + m[row + 4]! * p[1]! + m[row + 8]! * p[2]! + m[row + 12]!);
  const clip = transform(viewProjection, virtual), words = new Uint32Array(config), f = new Float32Array(config);
  requireProof(words[36] === 320 && words[37] === 180 && words[38] === 320 && words[39] === 180 && words[42] === 2,
    'Sharp witness dimensions/world mode differ from the frozen checkpoint.');
  if (objectOffset === .4) requireProof(words[44] === 0 && words[52] === 1, 'Moved sharp source did not reset the scheduled window.');
  const x = Math.floor((clip[0]! / clip[3]! * .5 + .5) * words[36]!), y = Math.floor((.5 - clip[1]! / clip[3]! * .5) * words[37]!);
  requireProof(x >= 0 && y >= 0 && x < words[36]! && y < words[37]!, 'Sharp virtual emitter is outside the viewport.');
  requireProof(f[48] === 0 && f[49] === geometry.tMax, 'Sharp witness requires the frozen perfect mirror and ray extent.');
  const realCorners = [-1, 1].flatMap(a => [-1, 1].flatMap(b => [-1, 1].map(c => transform(viewProjection,
    [center[0]! + a * geometry.emitterHalfSize[0]!, center[1]! + b * geometry.emitterHalfSize[1]!, center[2]! + c * geometry.emitterHalfSize[2]!]))));
  requireProof(realCorners.every(p => p[1]! / p[3]! > 1), 'Expected emitter is no longer entirely above the camera frustum.');
  const localX = x - words[56]!, localY = y - words[57]!, regionPixels = words[46]!;
  requireProof(localX >= 0 && localY >= 0 && localX < words[58]! && localY < words[59]! && regionPixels === words[58]! * words[59]!,
    'Sharp witness pixel lies outside the scheduled candidate region.');
  const candidate = localY * words[58]! + localX, scheduledOffset = (candidate + regionPixels - words[44]!) % regionPixels;
  requireProof(words[47] === 1 && scheduledOffset < words[45]!, 'Sharp witness pixel is not in this current scheduled window.');
  const q = transform(f, [(x + .5) / words[36]! * 2 - 1, 1 - (y + .5) / words[37]! * 2, .5]);
  const delta = q.slice(0, 3).map((v, i) => v / q[3]! - f[32 + i]!), t = (geometry.planeY - f[33]!) / delta[1]!;
  const point = delta.map((v, i) => f[32 + i]! + t * v), length = Math.hypot(...delta);
  requireProof(point[0]! > geometry.mirrorMin[0]! && point[0]! < geometry.mirrorMax[0]!
    && point[2]! > geometry.mirrorMin[2]! && point[2]! < geometry.mirrorMax[2]!, 'Sharp ray does not hit the frozen mirror interior.');
  const direction: [number, number, number] = [delta[0]! / length, -delta[1]! / length, delta[2]! / length];
  const origin: [number, number, number] = [point[0]!, geometry.planeY + geometry.normalBias, point[2]!];
  const slab = (boxCenter: readonly number[]): number | null => {
    let enter = geometry.tMin, exit = geometry.tMax;
    for (let axis = 0; axis < 3; axis++) {
      const low = boxCenter[axis]! - geometry.emitterHalfSize[axis]!, high = boxCenter[axis]! + geometry.emitterHalfSize[axis]!;
      if (direction[axis] === 0) { if (origin[axis]! < low || origin[axis]! > high) return null; }
      else { const a = (low - origin[axis]!) / direction[axis]!, b = (high - origin[axis]!) / direction[axis]!; enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b)); }
    }
    return enter <= exit ? enter : null;
  };
  const expectedDistance = slab(center), initialEmitterDistance = slab(geometry.initialEmitterCenter);
  requireProof(expectedDistance !== null, 'Sharp independent AABB ray misses the expected emitter.');
  if (objectOffset === .4) requireProof(initialEmitterDistance === null, 'Moved sharp witness also intersects the stale initial emitter.');
  return { x, y, objectOffset, center, origin, direction, expectedDistance, initialEmitterDistance, candidate, scheduledOffset,
    allEightRealCornersAboveFrustum: true, distanceBound: 2 * 2 ** (Math.floor(Math.log2(expectedDistance)) - 10) };
}
export function assertRendererSharpSample(witness: ReturnType<typeof rendererSharpRay>, config: ArrayBuffer, expectedFrameIndex: number,
  sample: { source: number; frame: number; epoch: number; mask: number; distance: number; rgb: readonly number[] }): void {
  const words = new Uint32Array(config);
  requireProof(words[40] === expectedFrameIndex && sample.source === 1 && sample.frame === expectedFrameIndex && sample.epoch === words[41] && sample.mask === 1,
    'Sharp emitter pixel lacks a current-frame completed hit.');
  // Two binary16 ulps are the unchanged storage bound, not the exact cross-arm image gate.
  requireProof(Math.abs(sample.distance - witness.expectedDistance) <= witness.distanceBound
    && sample.rgb[0]! >= rendererProofPlan.sharpGeometry.emitterEmission[0]! * .84,
    'Sharp pixel does not match the expected emitter distance/emission witness.');
}
function sharpWitness(owner: ReflectionRenderer | IntegratedRenderer, raw: ArrayBuffer, metadata: ArrayBuffer, config: ArrayBuffer,
  objectOffset: 0 | .4, expectedFrameIndex: number) {
  const camera = owner.currentCamera; requireProof(camera, 'Sharp witness camera is unavailable.');
  const witness = rendererSharpRay(camera.viewProjection, config, objectOffset);
  const words = new Uint32Array(config), at = witness.y * words[36]! + witness.x, tags = new Uint32Array(metadata), colors = new Uint16Array(raw);
  const sample = { source: tags[at * 4]!, frame: tags[at * 4 + 1]!, epoch: tags[at * 4 + 2]!, mask: tags[at * 4 + 3]!,
    distance: half(colors[at * 4 + 3]!), rgb: [0, 1, 2].map(c => half(colors[at * 4 + c]!)) };
  assertRendererSharpSample(witness, config, expectedFrameIndex, sample);
  return { ...witness, ...sample, objectBoxId: rendererProofPlan.sharpGeometry.objectBoxId };
}
export interface RendererProofFrame {
  id: string; action: RendererProofStep['action']; submitted: boolean; frameId: number;
  gi: Bag; reflections: Bag | null; geometry: Bag | null; stats: unknown;
  writes: { label: string; offset: number; byteLength: number; returned: boolean; phase: string; sha256: string }[];
  dispatches: { label: string; traceWriteCount: number }[];
  cpuTrace: ArrayBuffer[]; gpuTrace: ArrayBuffer[]; buffers: Record<string, ArrayBuffer>; textures: Record<string, ArrayBuffer>;
  activity: Record<string, unknown>; captured: boolean;
}
export interface RendererProofArm {
  readonly options: RendererProofOptions;
  readonly initial: { gi: Bag; geometry: Bag | null; trace: ArrayBuffer[]; resources: { label: string; size: number }[] };
  step(step: RendererProofStep): Promise<RendererProofFrame>;
  diagnostics(): Promise<unknown>;
  writeLog(): Promise<unknown>;
  dispose(): { before: { buffers: number; textures: number }; after: { buffers: number; textures: number } };
}
export type RendererProofFactory = (device: GPUDevice, options: RendererProofOptions) => Promise<RendererProofArm>;

/** Each bundle resolves the real renderer classes and its explicitly selected updater implementation. */
export async function createRendererProofArm(native: GPUDevice, options: RendererProofOptions): Promise<RendererProofArm> {
  const recorded = createRecordedDevice(native), buffers = new Map<string, GPUBuffer>(), textures = new Map<string, GPUTexture>();
  const device = new Proxy(recorded.device, { get(target, key) {
    if (key === 'createBuffer') return (descriptor: GPUBufferDescriptor) => { const buffer = target.createBuffer(descriptor); buffers.set(descriptor.label ?? '', buffer); return buffer; };
    if (key === 'createTexture') return (descriptor: GPUTextureDescriptor) => { const texture = target.createTexture(descriptor); textures.set(descriptor.label ?? '', texture); return texture; };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  let renderer: Renderer | undefined, output: GPUTexture | undefined;
  const streamed = options.residency === 'streamed';
  const common = { probesPerUpdate: 32, raysPerProbe: 64, roughness: 0, resolutionScale: 1 as const, maxRaysPerFrame: 32768 };
  try {
    if (options.kind === 'gi') renderer = await GiRenderer.create(device, rendererProofPlan.format, { renderer: 'gi', cameraMode: 'receiver', ...common });
    else if (options.kind === 'reflections') renderer = await ReflectionRenderer.create(device, rendererProofPlan.format, { renderer: 'reflections', cameraMode: 'receiver', ...common });
    else {
      requireProof(options.manifestUrl && options.traceProxyUrl, 'Integrated proof requires canonical asset URLs.');
      renderer = await IntegratedRenderer.create(device, rendererProofPlan.format, { renderer: 'integrated', manifestUrl: options.manifestUrl,
        traceProxyUrl: options.traceProxyUrl, cameraMode: streamed ? 'tour' : 'receiver', geometryMode: streamed ? 'streamed' : 'resident-full',
        poolBytes: streamed ? 1024 ** 2 : 8 * 1024 ** 2, maxConcurrentRequests: 4, uploadBudgetBytes: 4 * 65536, pixelError: 2,
        ...common });
      const geometry = renderer.geometryTelemetry;
      requireProof(geometry.poolBytes === (streamed ? 1024 ** 2 : 80 * 65536), 'Canonical pool payload differs from the frozen requested/allocated contract.');
      if (!streamed) requireProof(geometry.residentPages === 80, 'Resident-full proof did not preload all80 pages.');
    }
  } catch (error) { renderer?.dispose(); output?.destroy(); throw error; }
  const owner = renderer;
  const traceBuffers = [...recorded.traceBuffers.values()];
  if (traceBuffers.length !== 5) { owner.dispose(); throw new Error('Renderer did not create exactly five trace buffers.'); }
  const initialIds = [...traceBuffers], initialWriteCount = recorded.writes.length, model = arrays(owner.traceData).map(bytes => new Uint8Array(bytes).slice());
  // Creation is checked against the actual initial writes, not assumed from CPU arrays.
  model.forEach(bytes => bytes.fill(0));
  let consumedWrites = 0, frameId = 0, disposed = false, successfulFrames = 0, checkpoints = 0;
  let expectedModes: RendererProofModes = { gi: true, reflections: options.kind === 'gi' ? null : 'world' };
  const applyWrites = () => {
    for (; consumedWrites < recorded.writes.length; consumedWrites++) {
      const write = recorded.writes[consumedWrites]!; if (!write.returned) continue;
      const buffer = recorded.traceBuffers.get(write.label), index = initialIds.indexOf(buffer!);
      requireProof(index >= 0, 'Trace buffer was replaced.'); model[index]!.set(write.bytes, write.offset);
    }
  };
  applyWrites();
  const initial = { gi: { ...owner.giTelemetry }, geometry: 'geometryTelemetry' in owner ? { ...owner.geometryTelemetry } : null,
    trace: arrays(owner.traceData).map(bytes => bytes.slice(0)), resources: traceBuffers.map(buffer => ({ label: buffer.label, size: buffer.size })) };
  let storagePipeline: Promise<GPUComputePipeline> | undefined;
  let cancelledReset: { probe: Bag; reflection: Bag | null; state: ArrayBuffer; config: ArrayBuffer; reflectionConfig?: ArrayBuffer } | undefined;
  const storageRead = async (source: GPUBuffer) => {
    storagePipeline ??= proofDeadline(native.createComputePipelineAsync({ label: 'Strata proof storage read', layout: 'auto',
      compute: { module: native.createShaderModule({ code: rendererProofReadStorageShader }), entryPoint: 'readStorage' } }), 'diagnostic storage pipeline');
    const pipeline = await storagePipeline;
    requireProof(!disposed, 'Diagnostic arm was disposed while its pipeline was pending.');
    const output = native.createBuffer({ size: source.size, usage: 0x80 | 4 });
    try {
      const group = native.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: source } }, { binding: 1, resource: { buffer: output } }] });
      const encoder = native.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(source.size / 256)); pass.end(); native.queue.submit([encoder.finish()]); return await readBuffer(native, output);
    } finally { output.destroy(); }
  };
  const physical = async () => {
    applyWrites(); requireProof([...recorded.traceBuffers.values()].every((buffer, i) => buffer === initialIds[i]), 'Persistent trace allocation identity changed.');
    const values = await Promise.all(traceBuffers.map(buffer => readBuffer(native, buffer)));
    values.forEach((bytes, i) => equal(bytes, model[i]!, `actual queued/prefix GPU model buffer${i}`)); return values;
  };
  const geometryBuffers = async (includeStorage = false) => {
    const result: Record<string, ArrayBuffer> = {};
    for (const label of ['Strata current tile LOD selections', 'Strata indirect geometry arguments and counters']) {
      requireProof(!disposed, 'Diagnostic arm disposed.');
      const buffer = buffers.get(label); if (buffer) result[label] = await readBuffer(native, buffer);
    }
    if (includeStorage) for (const label of ['Strata page residency table', 'Strata camera and shadow triangle references', 'Strata cooked geometry metadata']) {
      requireProof(!disposed, 'Diagnostic arm disposed.');
      const buffer = buffers.get(label); if (buffer) result[label] = await storageRead(buffer);
    }
    return result;
  };
  const diagnostics = async () => {
    const image: Record<string, unknown> = {};
    for (const label of ['Strata linear HDR and shadow visibility', 'Strata world normals and roughness', 'Strata linear base color and metallic',
      'Strata motion and current/previous view depths', 'Strata raster depth']) {
      requireProof(!disposed, 'Diagnostic arm disposed.');
      const texture = textures.get(label); if (texture) image[label] = { format: texture.format, width: texture.width, height: texture.height, ...await byteRecord(await readTexture(native, texture), true) };
    }
    const selection = await geometryBuffers(true);
    return { images: image, selection: Object.fromEntries(await Promise.all(Object.entries(selection).map(async ([key, bytes]) => [key, await byteRecord(bytes, true)]))),
      resources: [...buffers.entries()].filter(([label]) => /geometry|residency|triangle references/.test(label)).map(([label, buffer]) => ({ label, size: buffer.size, usage: buffer.usage })) };
  };
  return { options: { ...options }, initial, diagnostics,
    async writeLog() { return Promise.all(recorded.writes.map(async write => ({ ...write, bytes: await byteRecord(write.bytes, true) }))); },
    async step(step) {
      requireProof(!disposed, 'Proof arm disposed.'); recorded.setPhase(step.id); const firstWrite = recorded.writes.length;
      expectedModes = advanceRendererProofModes(expectedModes, step.controls);
      const expectedDisabled = !expectedModes.gi && (expectedModes.reflections === null || expectedModes.reflections === 'off');
      const cachesBefore = expectedDisabled ? { probe: { ...owner.probeCache.telemetry },
        reflection: 'reflectionCache' in owner ? { ...owner.reflectionCache.telemetry } : null } : undefined;
      const disabledSources: Record<string, GPUBuffer> = {};
      if (step.id.startsWith('disabled-edit-')) {
        requireProof(expectedDisabled, 'Frozen disabled step did not request both effects off.');
        const p = owner.probeCache.diagnostics;
        Object.assign(disabledSources, { disabledProbeState: p.stateBuffer, disabledProbeRays: p.rayBuffer, disabledProbeStats: p.statisticsBuffer, disabledProbeConfig: p.configBuffer });
        if ('reflectionCache' in owner) { const r = owner.reflectionCache.diagnostics; Object.assign(disabledSources, { disabledReflectionStats: r.statisticsBuffer, disabledReflectionConfig: r.configBuffer }); }
      }
      const disabledBefore = Object.fromEntries(await Promise.all(Object.entries(disabledSources).map(async ([key, buffer]) => [key, await readBuffer(native, buffer)])));
      const before = { ...owner.giTelemetry }, dispatches: RendererProofFrame['dispatches'] = [];
      const resetBefore = step.id === 'hard-reset-cancel' ? { probe: { ...owner.probeCache.telemetry },
        reflection: 'reflectionCache' in owner ? { ...owner.reflectionCache.telemetry } : null,
        state: await readBuffer(native, owner.probeCache.diagnostics.stateBuffer) } : undefined;
      let resetConfig: GPUBuffer | undefined, reflectionResetConfig: GPUBuffer | undefined;
      if (!output || output.width !== step.width || output.height !== step.height) { output?.destroy(); output = native.createTexture({ label: 'Strata renderer-pair output', size: [step.width, step.height], format: rendererProofPlan.format, usage: 0x10 | 1 }); }
      const encoder = native.createCommandEncoder();
      const observed = new Proxy(encoder, { get(target, key) {
        if (key === 'beginComputePass') return (descriptor?: GPUComputePassDescriptor) => {
          dispatches.push({ label: descriptor?.label ?? '', traceWriteCount: recorded.writes.length }); return target.beginComputePass(descriptor);
        };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      let stats: unknown = null, submitted = false, failed = false;
      if (step.action === 'fail-write') recorded.failTraceWrite(step.failWriteOrdinal);
      try {
        stats = owner.encode(observed, output.createView(), step.width, step.height, step.time, step.controls);
        assertRendererProofModes(expectedModes, owner.giTelemetry, 'reflectionTelemetry' in owner ? owner.reflectionTelemetry : null);
        if (resetBefore) {
          resetConfig = owner.probeCache.diagnostics.configBuffer;
          if ('reflectionCache' in owner) reflectionResetConfig = owner.reflectionCache.diagnostics.configBuffer;
        }
        requireProof(step.action !== 'fail-write', 'Expected trace write failure was not reached.');
        if (step.action === 'submit') {
          native.queue.submit([encoder.finish()]); owner.submitted(++frameId); submitted = true; successfulFrames++;
          requireProof(streamed || successfulFrames <= rendererProofPlan.limits.successfulFramesPerArm, 'Successful frame cap exceeded.');
        } else owner.cancelFrame();
      } catch (error) {
        owner.cancelFrame();
        const thrown = recorded.writes.slice(firstWrite).filter(write => !write.returned);
        if (step.action !== 'fail-write' || thrown.length !== 1) throw error;
        failed = true;
      } finally { recorded.failTraceWrite(); }
      requireProof(step.action !== 'fail-write' || failed, 'Injected write failure did not occur.');
      await proofDeadline(native.queue.onSubmittedWorkDone(), `renderer ${step.id}`);
      if ('flushFeedback' in owner && submitted) await owner.flushFeedback();
      const gi = { ...owner.giTelemetry }, reflections = 'reflectionTelemetry' in owner ? { ...owner.reflectionTelemetry } : null;
      assertRendererProofModes(expectedModes, gi, reflections);
      const activeGi = expectedModes.gi, activeReflection = expectedModes.reflections === 'world';
      const writes = recorded.writes.slice(firstWrite);
      const updateWrites = recorded.writes.slice(initialWriteCount), returned = updateWrites.filter(write => write.returned);
      requireProof(gi.traceAttemptedWriteCalls === updateWrites.length && gi.traceQueuedWriteCalls === returned.length
        && gi.traceQueuedUploadBytes === returned.reduce((sum, write) => sum + write.byteLength, 0), 'Maintenance telemetry differs from actual attempted/returned trace writes.');
      if (step.id === 'queued-upload-retry') requireProof(writes.length === 0, 'Successful cancelled flush was redundantly uploaded on retry.');
      if (expectedDisabled) {
        requireProof(writes.length === 0 && gi.traceQueuedUpdateCount === before.traceQueuedUpdateCount, 'Disabled effects flushed tracing source.');
        assertDisabledRendererCaches(cachesBefore!, { probe: owner.probeCache.telemetry,
          reflection: 'reflectionCache' in owner ? owner.reflectionCache.telemetry : null }, dispatches);
      }
      if (!submitted) {
        requireProof(gi.traceLastSubmittedUpdateCount === before.traceLastSubmittedUpdateCount && gi.traceLastSubmittedFrameId === before.traceLastSubmittedFrameId, 'Cancelled frame advanced submitted trace attribution.');
      } else requireProof(gi.traceLastSubmittedFrameId === frameId && gi.traceLastSubmittedUpdateCount === gi.traceQueuedUpdateCount, 'Submitted trace source token differs from queued source.');
      for (const event of dispatches) requireProof(event.traceWriteCount === recorded.writes.length, 'A trace source write occurred after a dispatch was encoded.');
      const gpuTrace = await physical(), cpuTrace = arrays(owner.traceData).map(bytes => bytes.slice(0));
      if (!gi.tracePendingRangeCount) gpuTrace.forEach((bytes, i) => equal(bytes, cpuTrace[i]!, `fully queued target buffer${i}`));
      const gpuBuffers: Record<string, ArrayBuffer> = {}, images: Record<string, ArrayBuffer> = {}, activity: Record<string, unknown> = {};
      for (const [key, buffer] of Object.entries(disabledSources)) {
        gpuBuffers[key] = await readBuffer(native, buffer); equal(gpuBuffers[key]!, disabledBefore[key]!, `Both-disabled actual cache ${key}`);
      }
      if (expectedDisabled) activity.disabled = { expectedModes: { ...expectedModes }, cachesBefore, cachesAfter: { probe: { ...owner.probeCache.telemetry },
        reflection: 'reflectionCache' in owner ? { ...owner.reflectionCache.telemetry } : null }, unchangedActualBuffers: Object.keys(disabledSources), giReflectionPasses: 0 };
      if (resetBefore) {
        requireProof(resetConfig, 'Cancelled reset did not expose its queued configuration.');
        const config = await readBuffer(native, resetConfig), state = await readBuffer(native, owner.probeCache.diagnostics.stateBuffer);
        assertProbeResetLifecycle('cancel', resetBefore.probe, owner.probeCache.telemetry, config, resetBefore.state, state);
        cancelledReset = { ...resetBefore, config, ...(reflectionResetConfig ? { reflectionConfig: await readBuffer(native, reflectionResetConfig) } : {}) };
        gpuBuffers.cancelledProbeConfig = config; gpuBuffers.cancelledProbeState = state;
        if (cancelledReset.reflectionConfig && 'reflectionCache' in owner) {
          equalJson(owner.reflectionCache.telemetry, resetBefore.reflection, 'Cancelled hard reset committed reflection telemetry');
          const r = new Uint32Array(cancelledReset.reflectionConfig);
          requireProof(r[41] === Number(resetBefore.reflection!.cacheEpoch) + 1 && r[44] === 0 && r[47] === 1 && r[52] === 1,
            'Cancelled reflection reset did not queue epoch+1/start0/reset.');
          gpuBuffers.cancelledReflectionConfig = cancelledReset.reflectionConfig;
        }
        activity.reset = { stage: 'cancel', committedProbe: { ...owner.probeCache.telemetry }, queuedEpoch: new Uint32Array(config)[11] };
      }
      if (submitted && activeGi) {
        const p = owner.probeCache.diagnostics;
        for (const [key, buffer] of Object.entries({ probeState: p.stateBuffer, probeRay: p.rayBuffer, probeStats: p.statisticsBuffer, probeConfig: p.configBuffer })) gpuBuffers[key] = await readBuffer(native, buffer);
        const counts = new Uint32Array(gpuBuffers.probeStats!);
        requireProof(counts[0] === 2048 && counts[3] === 0 && counts[7] === 32, 'Probe work/unknown counters differ from fixed32×64 budget.');
        activity.probeHits = counts[1];
      }
      if (submitted && activeReflection && 'reflectionCache' in owner) {
        const r = owner.reflectionCache.diagnostics;
        gpuBuffers.reflectionStats = await readBuffer(native, r.statisticsBuffer); gpuBuffers.reflectionConfig = await readBuffer(native, r.configBuffer);
        requireProof(new Uint32Array(gpuBuffers.reflectionStats)[5] === 0, 'Reflection tracing reported an unknown result.');
      }
      if (step.id === 'hard-reset-retry') {
        requireProof(cancelledReset, 'Hard reset retry has no cancelled-reset witness.');
        equal(gpuBuffers.probeConfig!, cancelledReset.config, 'Hard reset retry changed its cancelled queued probe configuration');
        assertProbeResetLifecycle('retry', cancelledReset.probe, owner.probeCache.telemetry, gpuBuffers.probeConfig!, cancelledReset.state, gpuBuffers.probeState!);
        if (cancelledReset.reflectionConfig && 'reflectionCache' in owner) {
          const r = new Uint32Array(gpuBuffers.reflectionConfig!), c = new Uint32Array(cancelledReset.reflectionConfig), t = owner.reflectionCache.telemetry;
          for (const at of [40, 41, 44, 45, 46, 47, 52]) requireProof(r[at] === c[at], 'Reflection hard-reset retry lost its cancelled epoch/window/reset.');
          requireProof(t.cacheEpoch === Number(cancelledReset.reflection!.cacheEpoch) + 1 && t.framesSinceReset === 1
            && t.submittedFrames === Number(cancelledReset.reflection!.submittedFrames) + 1 && t.sourceFrameId === frameId,
          'Reflection hard-reset retry did not commit exactly one fresh epoch/submission.');
        }
        activity.reset = { stage: 'retry', committedProbe: { ...owner.probeCache.telemetry }, cancelledQueuedEpoch: new Uint32Array(cancelledReset.config)[11] };
        cancelledReset = undefined;
      }
      if (submitted && 'geometryTelemetry' in owner) {
        Object.assign(gpuBuffers, await geometryBuffers());
        if (streamed) { const residency = buffers.get('Strata page residency table'); requireProof(residency, 'Streamed residency buffer missing.'); gpuBuffers.geometryResidency = await storageRead(residency); }
      }
      const captured = step.checkpoint && submitted;
      if (captured) {
        requireProof(++checkpoints <= rendererProofPlan.limits.textureCheckpointsPerFixture, 'Texture checkpoint cap exceeded.');
        if (activeGi) {
          const p = owner.probeCache.diagnostics, state = new Uint32Array(gpuBuffers.probeState!), epoch = new Uint32Array(gpuBuffers.probeConfig!)[11]!;
          images.probeIrradiance = definedProbeTiles(await readTexture(native, p.irradianceTexture), 8, state, epoch);
          images.probeVisibility = definedProbeTiles(await readTexture(native, p.visibilityTexture), 16, state, epoch);
          requireProof(new Float32Array(images.probeVisibility).every(Number.isFinite), 'Probe visibility contains nonfinite values.');
          activity.irradiance = finiteRgb(images.probeIrradiance, 'probe irradiance');
        }
        if (activeReflection && 'reflectionCache' in owner) {
          const r = owner.reflectionCache.diagnostics, config = new Uint32Array(gpuBuffers.reflectionConfig!);
          const metadata = await readTexture(native, r.rawMetadataTexture);
          images.reflectionRaw = currentRaw(await readTexture(native, r.rawTexture), metadata, config, 8);
          images.reflectionRawMetadata = currentRaw(metadata, metadata, config, 16);
          images.reflectionResolved = await readTexture(native, r.radianceTexture);
          images.reflectionSurface = await readTexture(native, r.surfaceTexture);
          images.reflectionMetadata = await readTexture(native, r.metadataTexture);
          activity.reflectionRaw = finiteRgb(images.reflectionRaw, 'reflection raw'); finiteRgb(images.reflectionResolved, 'reflection resolved');
        }
        const hdr = textures.get(options.kind === 'gi' ? 'Strata composed GI HDR' : 'Strata composed reflection HDR');
        if (activeGi || activeReflection) { requireProof(hdr, 'Active linear HDR composition resource missing.'); images.hdr = await readTexture(native, hdr); activity.hdr = finiteRgb(images.hdr, 'composed HDR'); }
        if (step.id === 'sharp-warm-12' || step.id === 'sharp-moved-point4') {
          requireProof(Number(activity.probeHits) > 0 && (activity.irradiance as { nonzeroPixels: number }).nonzeroPixels > 0, 'Warm GI activity is vacuous.');
          if (activeReflection && 'reflectionCache' in owner) {
            requireProof(new Uint32Array(gpuBuffers.reflectionStats!)[3]! > 0 && (activity.reflectionRaw as { maxRgb: number }).maxRgb > 1, 'Sharp offscreen emitter phase is vacuous.');
            activity.sharpWitness = sharpWitness(owner, images.reflectionRaw!, images.reflectionRawMetadata!, gpuBuffers.reflectionConfig!,
              step.id === 'sharp-moved-point4' ? .4 : 0, frameId - 1);
          }
        }
      }
      return { id: step.id, action: step.action, submitted, frameId, gi, reflections,
        geometry: 'geometryTelemetry' in owner ? { ...owner.geometryTelemetry } : null, stats,
        writes: await Promise.all(writes.map(async write => ({ label: write.label, offset: write.offset, byteLength: write.byteLength, returned: write.returned, phase: write.phase, sha256: await proofSha256(write.bytes) }))),
        dispatches, cpuTrace, gpuTrace, buffers: gpuBuffers, textures: images, activity, captured };
    },
    dispose() { const before = { buffers: owner.gpuBufferBytes, textures: owner.gpuTextureBytes };
      owner.dispose(); output?.destroy(); disposed = true; const after = { buffers: owner.gpuBufferBytes, textures: owner.gpuTextureBytes };
      requireProof(after.buffers === 0 && after.textures === 0, 'Renderer retains tracked GPU allocations after disposal.'); return { before, after }; },
  };
}

async function summarize(frame: RendererProofFrame) {
  const resources = async (values: Record<string, ArrayBuffer>) => Object.fromEntries(await Promise.all(Object.entries(values).map(async ([key, bytes]) => [key, await byteRecord(bytes)])));
  return { ...frame, cpuTrace: await Promise.all(frame.cpuTrace.map(bytes => byteRecord(bytes))), gpuTrace: await Promise.all(frame.gpuTrace.map(bytes => byteRecord(bytes))),
    buffers: await resources(frame.buffers), textures: await resources(frame.textures) };
}
export async function runRendererPairValidation(device: GPUDevice, candidateFactory: RendererProofFactory, fullFactory: RendererProofFactory,
  assetUrls: { manifestUrl: string; traceProxyUrl: string }, onProgress?: (event: unknown) => Promise<void>) {
  const report: { version: string; plan: typeof rendererProofPlan; pairs: unknown[]; streamed: unknown; cleanup: unknown[]; status: string } =
    { version: rendererProofPlan.version, plan: rendererProofPlan, pairs: [], streamed: null, cleanup: [], status: 'running' };
  const started = performance.now(); let arms: RendererProofArm[] = [], last: unknown;
  const progress = (event: unknown) => onProgress ? proofDeadline(onProgress(event), 'renderer proof progress persistence') : Promise.resolve();
  try {
    for (const kind of ['gi', 'reflections', 'integrated'] as const) {
      const options = { kind, ...assetUrls, residency: 'resident-full' as const };
      const candidate = await candidateFactory(device, options); arms.push(candidate);
      const full = await fullFactory(device, options); arms.push(full);
      candidate.initial.trace.forEach((bytes, i) => equal(bytes, full.initial.trace[i]!, `${kind} initial CPU trace${i}`));
      const pair: { kind: RendererProofKind; initial: unknown; frames: unknown[]; writeLogs?: unknown } = { kind,
        initial: { candidate: { ...candidate.initial, trace: await Promise.all(candidate.initial.trace.map(bytes => byteRecord(bytes))) },
          full: { ...full.initial, trace: await Promise.all(full.initial.trace.map(bytes => byteRecord(bytes))) } }, frames: [] };
      report.pairs.push(pair);
      await progress({ stage: 'renderer-pair-start', kind, initial: pair.initial });
      for (const step of rendererProofPlan.steps[kind]) {
        requireProof(performance.now() - started < rendererProofPlan.limits.totalDeadlineMs, 'Renderer pair overall deadline exceeded.');
        const a = await candidate.step(step), b = await full.step(step); last = { kind, step, candidate: await summarize(a), full: await summarize(b) };
        pair.frames.push(last);
        a.cpuTrace.forEach((bytes, i) => equal(bytes, b.cpuTrace[i]!, `${kind}/${step.id} full CPU target${i}`));
        if (step.action !== 'fail-write') a.gpuTrace.forEach((bytes, i) => equal(bytes, b.gpuTrace[i]!, `${kind}/${step.id} queued GPU source${i}`));
        equalJson(semanticTelemetry(a.gi), semanticTelemetry(b.gi), `${kind}/${step.id} GI semantics`);
        if (a.reflections && b.reflections) equalJson(semanticTelemetry(a.reflections), semanticTelemetry(b.reflections), `${kind}/${step.id} reflection semantics`);
        if (a.stats && b.stats) {
          const fields = (stats: unknown) => Object.fromEntries(Object.entries(stats as Record<string, unknown>).filter(([key]) => key !== 'uploadBytes'));
          equalJson(fields(a.stats), fields(b.stats), `${kind}/${step.id} renderer submission counts`);
        }
        equalJson(Object.keys(a.buffers), Object.keys(b.buffers), 'active buffer names');
        for (const key of Object.keys(a.buffers)) equal(a.buffers[key]!, b.buffers[key]!, `${kind}/${step.id}/${key}`);
        equalJson(Object.keys(a.textures), Object.keys(b.textures), 'defined texture names');
        for (const key of Object.keys(a.textures)) equal(a.textures[key]!, b.textures[key]!, `${kind}/${step.id}/${key}`);
        await progress({ stage: 'renderer-pair-step', ...last as Record<string, unknown> });
      }
      pair.writeLogs = { candidate: await candidate.writeLog(), full: await full.writeLog() };
      report.cleanup.push(candidate.dispose(), full.dispose()); arms = [];
      await progress({ stage: 'renderer-pair-finish', kind, frames: pair.frames.length, cleanup: report.cleanup.slice(-2) });
    }
    const arm = await candidateFactory(device, { kind: 'integrated', ...assetUrls, residency: 'streamed' }); arms.push(arm);
    const before = arm.initial.gi, start = performance.now(), records: unknown[] = []; let initialGpu: ArrayBuffer[] | undefined, churn = false;
    let previousResidency: Uint32Array | undefined, mappingChanges = 0, deadlineReached = false;
    stream: for (const [pose, time] of rendererProofPlan.streamedTimes.entries()) for (let frame = 0; frame < rendererProofPlan.limits.streamedFramesPerPose; frame++) {
      if (performance.now() - start >= rendererProofPlan.limits.streamedDeadlineMs || performance.now() - started >= rendererProofPlan.limits.totalDeadlineMs) { deadlineReached = true; break stream; }
      const value = await arm.step({ id: `streamed-${pose}-${frame}`, action: 'submit', controls: { temporal: false, gi: { enabled: false }, reflections: { mode: 'off' } },
        time, width: 320, height: 180, checkpoint: false });
      initialGpu ??= value.gpuTrace; value.gpuTrace.forEach((bytes, i) => equal(bytes, initialGpu![i]!, 'streamed persistent trace source'));
      for (const key of Object.keys(before).filter(key => key.startsWith('trace') && !key.startsWith('traceLastSubmitted'))) requireProof(value.gi[key] === before[key], `Streamed camera/page activity changed ${key}`);
      const residency = new Uint32Array(value.buffers.geometryResidency!), changedMappings = [...residency.entries()]
        .filter(([pageId, slot]) => previousResidency !== undefined && previousResidency[pageId] !== slot)
        .map(([pageId, slot]) => ({ pageId, previousSlot: previousResidency![pageId]!, slot }));
      mappingChanges += changedMappings.length;
      churn ||= mappingChanges > 0 && Number(value.geometry?.evictions) > 0 && Number(value.geometry?.uploadedPages) > Number(arm.initial.geometry?.uploadedPages);
      const initialMappings = previousResidency === undefined ? Array.from(residency) : undefined; previousResidency = residency;
      const record = { id: value.id, frameId: value.frameId, geometry: value.geometry, gi: value.gi, changedMappings,
        ...(initialMappings ? { initialMappings } : {}),
        trace: await Promise.all(value.gpuTrace.map(bytes => byteRecord(bytes))), buffers: await summarize(value).then(v => v.buffers) };
      records.push(record); await progress({ stage: 'streamed-step', ...record });
    }
    const exercised = churn && !deadlineReached;
    report.streamed = { status: exercised ? 'exercised' : 'unexercised', churnObserved: churn, mappingChanges, deadlineReached,
      requestedPoolBytes: 1024 ** 2, records,
      claim: exercised ? 'Observed camera/page churn preserves persistent trace buffers and maintenance counters.' : 'Full bounded pose/churn coverage was not established; retained records describe only observed activity.' };
    report.cleanup.push(arm.dispose()); arms = []; report.status = 'passed'; return report;
  } catch (error) {
    const attribution = await Promise.all(arms.map(arm => proofDeadline(arm.diagnostics(), 'first-difference attribution').catch(cause => ({ diagnosticFailure: String(cause) }))));
    const logs = await Promise.all(arms.map(arm => proofDeadline(arm.writeLog(), 'first-difference write log').catch(cause => ({ logFailure: String(cause) }))));
    report.status = 'failed';
    for (const arm of arms) { try { report.cleanup.push(arm.dispose()); } catch (cause) { report.cleanup.push({ disposalFailure: String(cause) }); } }
    throw Object.assign(error as Error, { proofEvidence: { ...report, last, firstDifferenceAttribution: attribution, writeLogs: logs,
      byteDifference: (error as Error & { proofByteEvidence?: unknown }).proofByteEvidence,
      limitation: 'An integrated image mismatch may originate in unordered terrain compaction/rasterization; the exact gate remains a failure.' } });
  }
}
