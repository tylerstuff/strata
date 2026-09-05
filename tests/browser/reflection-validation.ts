import { ReflectionRenderer } from '../../packages/core/src/reflections/reflection-renderer.js';
import { runReflectionKernelValidation } from './reflection-kernel-validation.js';

type Controls = NonNullable<Parameters<ReflectionRenderer['encode']>[5]>;
function require(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function adapterDescription(adapter: GPUAdapter) {
  const info = adapter.info; return { vendor: info.vendor, architecture: info.architecture, device: info.device,
    description: info.description, isFallbackAdapter: info.isFallbackAdapter };
}

function trackDeviceLoss(device: GPUDevice, errors: string[]) {
  const health: { lost: { reason: GPUDeviceLostReason; message: string } | null } = { lost: null };
  void device.lost.then(info => {
    health.lost = { reason: info.reason, message: info.message };
    if (info.reason !== 'destroyed') errors.push(`GPU device lost (${info.reason}): ${info.message}`);
  });
  return health;
}

async function readStats(device: GPUDevice, source: GPUBuffer, size = 32): Promise<number[]> {
  const buffer = device.createBuffer({ size, usage: 0x1 | 0x8 });
  try {
    const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(source, 0, buffer, 0, size);
    device.queue.submit([encoder.finish()]); await buffer.mapAsync(1);
    const result = Array.from(new Uint32Array(buffer.getMappedRange())); buffer.unmap(); return result;
  } finally { buffer.destroy(); }
}

export async function validateReflectionSmoke() {
  const adapter = await navigator.gpu.requestAdapter(); require(adapter, 'WebGPU adapter unavailable.');
  const device = await adapter.requestDevice(); const gpuErrors: string[] = [];
  device.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
  const health = trackDeviceLoss(device, gpuErrors);
  let renderer: ReflectionRenderer | undefined; let target: GPUTexture | undefined;
  try {
    renderer = await ReflectionRenderer.create(device, 'rgba8unorm', { renderer: 'reflections', roughness: 0,
      cameraMode: 'receiver', resolutionScale: 1, maxRaysPerFrame: 32768 });
    target = device.createTexture({ size: [320, 180], format: 'rgba8unorm', usage: 0x10 });
    const encoder = device.createCommandEncoder();
    const controls: Controls = { gi: { enabled: false }, temporal: false, debugView: 'reflections', reflections: { mode: 'world', roughness: 0 } };
    const stats = renderer.encode(encoder, target.createView(), 320, 180, 0, controls);
    device.queue.submit([encoder.finish()]); renderer.submitted(1);
    const reflectionStats = await readStats(device, renderer.reflectionCache.diagnostics.statisticsBuffer);
    require(gpuErrors.length === 0, gpuErrors.join('\n'));
    require(reflectionStats[1]! > 0 && reflectionStats[5] === 0, `No valid bounded reflection work: ${reflectionStats}`);
    const kernel = await runReflectionKernelValidation(device);
    require(gpuErrors.length === 0, gpuErrors.join('\n'));
    return { adapter: adapterDescription(adapter), stats, reflectionStats, reflectionTelemetry: renderer.reflectionTelemetry, kernel, gpuErrors, deviceLoss: health.lost };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${gpuErrors.join('\n')}\nDevice loss: ${JSON.stringify(health.lost)}`);
  } finally { renderer?.dispose(); target?.destroy(); device.destroy(); }
}

type Vec3 = readonly [number, number, number];
type Pixels = { width: number; height: number; values: number[] };
const normalized = (v: readonly number[]): Vec3 => { const length = Math.hypot(...v); return [v[0]! / length, v[1]! / length, v[2]! / length]; };
const multiply = (matrix: readonly number[] | Float32Array, value: readonly number[]): number[] =>
  Array.from({ length: 4 }, (_, row) => value.reduce((sum, component, column) => sum + matrix[column * 4 + row]! * component, 0));
// Independent double-precision Gauss-Jordan inverse; this does not call the renderer's reconstruction helper.
function inverse(matrix: Float32Array): number[] {
  const rows = Array.from({ length: 4 }, (_, row) => [...Array.from({ length: 4 }, (_, column) => matrix[column * 4 + row]!),
    ...Array.from({ length: 4 }, (_, column) => Number(row === column))]);
  for (let column = 0; column < 4; column++) {
    let pivot = column; for (let row = column + 1; row < 4; row++) if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!]; const divisor = rows[column]![column]!;
    require(Math.abs(divisor) > 1e-12, 'Singular validation camera.');
    rows[column] = rows[column]!.map(value => value / divisor);
    for (let row = 0; row < 4; row++) if (row !== column) { const amount = rows[row]![column]!; rows[row] = rows[row]!.map((value, i) => value - amount * rows[column]![i]!); }
  }
  return Array.from({ length: 16 }, (_, i) => rows[i % 4]![4 + Math.floor(i / 4)]!);
}
function boxDistance(origin: Vec3, direction: Vec3, center: Vec3, half: Vec3, yaw = 0): number | null {
  const c = Math.cos(yaw); const s = Math.sin(yaw); const delta = origin.map((value, axis) => value - center[axis]!);
  const o = [c * delta[0]! - s * delta[2]!, delta[1]!, s * delta[0]! + c * delta[2]!];
  const d = [c * direction[0] - s * direction[2], direction[1], s * direction[0] + c * direction[2]];
  let lo = 0.002; let hi = 16;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis]!) < 1e-12) { if (Math.abs(o[axis]!) > half[axis]!) return null; continue; }
    const a = (-half[axis]! - o[axis]!) / d[axis]!; const b = (half[axis]! - o[axis]!) / d[axis]!;
    lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b)); if (lo > hi) return null;
  }
  return lo;
}
function halfFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1; const exponent = (bits >>> 10) & 31; const mantissa = bits & 1023;
  return sign * (exponent === 0 ? mantissa * 2 ** -24 : exponent === 31 ? Infinity : (1 + mantissa / 1024) * 2 ** (exponent - 15));
}
async function readTexture(device: GPUDevice, texture: GPUTexture): Promise<Pixels> {
  const integers = texture.format === 'rgba32uint'; const half = texture.format === 'rgba16float';
  require(integers || half || texture.format === 'rgba8unorm' || texture.format === 'bgra8unorm', `Unsupported validation texture ${texture.format}`);
  const stride = integers ? 16 : half ? 8 : 4; const bytesPerRow = Math.ceil(texture.width * stride / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * texture.height, usage: 0x1 | 0x8 });
  try {
    const encoder = device.createCommandEncoder(); encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [texture.width, texture.height]);
    device.queue.submit([encoder.finish()]); await buffer.mapAsync(1);
    const data = new DataView(buffer.getMappedRange()); const values: number[] = [];
    for (let y = 0; y < texture.height; y++) for (let x = 0; x < texture.width; x++) for (let channel = 0; channel < 4; channel++) {
      const mapped = texture.format === 'bgra8unorm' && channel < 3 ? 2 - channel : channel;
      const offset = y * bytesPerRow + x * stride + mapped * (stride / 4);
      const value = integers ? data.getUint32(offset, true) : half ? halfFloat(data.getUint16(offset, true)) : data.getUint8(offset) / 255;
      require(Number.isFinite(value), 'Reflection readback contains nonfinite values.'); values.push(value);
    }
    buffer.unmap(); return { width: texture.width, height: texture.height, values };
  } finally { buffer.destroy(); }
}
async function readViewPixel(device: GPUDevice, view: GPUTextureView, x: number, y: number): Promise<number[]> {
  const output = device.createBuffer({ size: 16, usage: 0x80 | 0x4 });
  try {
    const shader = `@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> value: vec4f;
@compute @workgroup_size(1) fn main() { value = textureLoad(source, vec2i(${x}, ${y}), 0); }`;
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: device.createShaderModule({ code: shader }), entryPoint: 'main' } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }, { binding: 1, resource: { buffer: output } }] });
    const encoder = device.createCommandEncoder(); const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end(); device.queue.submit([encoder.finish()]);
    const words = await readStats(device, output, 16); return Array.from(new Float32Array(new Uint32Array(words).buffer));
  } finally { output.destroy(); }
}
async function readReflectorMask(device: GPUDevice, view: GPUTextureView, width: number, height: number): Promise<number[]> {
  const output = device.createBuffer({ size: width * height * 4, usage: 0x80 | 0x4 });
  try {
    const code = `@group(0) @binding(0) var material: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> mask: array<u32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${width}u || id.y >= ${height}u) { return; }
  mask[id.y * ${width}u + id.x] = select(0u, 1u, textureLoad(material, vec2i(id.xy), 0).a > 0.5);
}`;
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }, { binding: 1, resource: { buffer: output } }] });
    const encoder = device.createCommandEncoder(); const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end(); device.queue.submit([encoder.finish()]);
    return await readStats(device, output, width * height * 4);
  } finally { output.destroy(); }
}
function imageMetrics(image: Pixels) {
  let energy = 0; let xSum = 0; let ySum = 0; let squareSum = 0; let maximum = 0; let brightPixels = 0; let total = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const index = (y * image.width + x) * 4; const r = image.values[index]!; const g = image.values[index + 1]!; const b = image.values[index + 2]!;
    require(Math.min(r, g, b) >= -0.00001, 'Reflection output contains negative energy.');
    const weight = Math.max(0, r - 4 * g - 0.5); energy += weight; xSum += x * weight; ySum += y * weight; squareSum += (x * x + y * y) * weight;
    maximum = Math.max(maximum, r); brightPixels += Number(r > 2); total += r + g + b;
  }
  const centroid = energy > 0 ? [xSum / energy, ySum / energy] : null;
  return { energy, centroid, variance: centroid ? squareSum / energy - centroid[0]! ** 2 - centroid[1]! ** 2 : null, maximum, brightPixels, total };
}

let session: { adapter: GPUAdapter; device: GPUDevice; context: GPUCanvasContext; canvas: HTMLCanvasElement;
  renderer: ReflectionRenderer; frame: number; width: number; height: number; gpuErrors: string[]; health: ReturnType<typeof trackDeviceLoss>; currentCase: string } | undefined;
const prior = new Map<string, { image: Pixels; metadata: Pixels; metrics: ReturnType<typeof imageMetrics>; epoch: number }>();
export async function startReflectionValidation(cameraMode: 'receiver' | 'tour' = 'receiver', budget = 32768, scale: .25 | .5 | 1 = 1) {
  disposeReflectionValidation();
  const adapter = await navigator.gpu.requestAdapter(); require(adapter, 'WebGPU unavailable.'); const device = await adapter.requestDevice();
  const gpuErrors: string[] = []; device.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
  const health = trackDeviceLoss(device, gpuErrors);
  const canvas = document.querySelector('canvas'); require(canvas, 'Reflection canvas missing.'); canvas.width = 320; canvas.height = 180;
  const context = canvas.getContext('webgpu') as GPUCanvasContext | null; require(context, 'WebGPU canvas unavailable.');
  const format = navigator.gpu.getPreferredCanvasFormat(); context.configure({ device, format, alphaMode: 'opaque', usage: 0x10 | 0x1 });
  try {
    const renderer = await ReflectionRenderer.create(device, format, { renderer: 'reflections', cameraMode,
      roughness: 0, resolutionScale: scale, maxRaysPerFrame: budget });
    session = { adapter, device, context, canvas, renderer, frame: 0, width: 320, height: 180, gpuErrors, health, currentCase: 'setup' };
    return { cameraMode, budget, resolutionScale: scale, adapter: adapterDescription(adapter), width: 320, height: 180 };
  } catch (error) { context.unconfigure(); device.destroy(); throw error; }
}
export function reflectionValidationDiagnostics() {
  return session ? { frame: session.frame, currentCase: session.currentCase, deviceLoss: session.health.lost, gpuErrors: session.gpuErrors,
    reflectionTelemetry: session.renderer.reflectionTelemetry } : null;
}
export function disposeReflectionValidation() {
  if (!session) return null;
  const before = { gpuBufferBytes: session.renderer.gpuBufferBytes, gpuTextureBytes: session.renderer.gpuTextureBytes };
  session.renderer.dispose();
  const after = { gpuBufferBytes: session.renderer.gpuBufferBytes, gpuTextureBytes: session.renderer.gpuTextureBytes };
  session.context.unconfigure(); session.device.destroy(); session = undefined;
  require(after.gpuBufferBytes === 0 && after.gpuTextureBytes === 0, 'Disposed reflection renderer retained tracked GPU allocations.');
  return { before, after };
}
async function step(patch: Controls = {}, time = 0, capture = true) {
  require(session, 'Reflection session not initialized.'); const s = session;
  const controls: Controls = { temporal: false, debugView: 'reflections', gi: { enabled: false }, ...patch };
  const encoder = s.device.createCommandEncoder(); const target = s.context.getCurrentTexture();
  const stats = s.renderer.encode(encoder, target.createView(), s.width, s.height, time, controls);
  s.device.queue.submit([encoder.finish()]); s.renderer.submitted(++s.frame);
  if (!capture) {
    // Functional accumulation is frame-count based, never throughput evidence. Keep
    // slow software backends to one queued warmup frame instead of flooding their
    // command queue with 65/240 complete render graphs before the first readback.
    await s.device.queue.onSubmittedWorkDone();
    require(s.health.lost === null, `GPU lost during ${s.currentCase}: ${JSON.stringify(s.health.lost)}`);
    return null;
  }
  const telemetry = s.renderer.reflectionTelemetry; const mode = telemetry.mode; const diagnostic = s.renderer.reflectionCache.diagnostics;
  const image = mode === 'off' && !s.renderer.giTelemetry.enabled ? await readTexture(s.device, target) : await readTexture(s.device, s.renderer.composer.outputTexture!);
  const metadata = await readTexture(s.device, diagnostic.metadataTexture); const raw = await readTexture(s.device, diagnostic.rawTexture);
  const rawMetadata = await readTexture(s.device, diagnostic.rawMetadataTexture); const counters = await readStats(s.device, diagnostic.statisticsBuffer);
  const sourceCounts = [0, 0, 0, 0, 0]; let selectedPixels = 0;
  const expectedSkipped = mode === 'world' && telemetry.scheduledCandidates === 0 ? ['reflection-trace'] : [];
  require(JSON.stringify(stats.skippedGpuPasses ?? []) === JSON.stringify(expectedSkipped),
    'Reflection skipped-query metadata disagrees with whether tracing dispatched.');
  if (mode === 'world') {
    require(counters[0] === telemetry.scheduledCandidates && counters[1]! <= counters[0]! && counters[2]! <= counters[1]!, `Reflection work exceeded declared quota: ${counters}`);
    require(counters[5] === 0 && counters[3]! + counters[4]! === counters[1], `Reflection traversal did not finish correctly: ${counters}`);
    for (let i = 0; i < metadata.values.length; i += 4) if (metadata.values[i + 3]) {
      const source = metadata.values[i]!; require(source >= 0 && source <= 3, `Unexpected reflection source ${source}`);
      require(metadata.values[i + 2] === telemetry.cacheEpoch, 'Resolved reflection retained an old epoch.');
      sourceCounts[source]!++; selectedPixels++;
    }
  }
  require(s.gpuErrors.length === 0, s.gpuErrors.join('\n'));
  return { stats, telemetry, counters, image, metadata, raw, rawMetadata, sourceCounts, selectedPixels, metrics: imageMetrics(image) };
}
function offscreenProof() {
  const s = session!; const camera = s.renderer.currentCamera!; const center: Vec3 = [-0.8, 1.12, 0.2 + Number(s.renderer.reflectionTelemetry.objectOffset)];
  const corners = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => multiply(camera.viewProjection, [center[0] + x * .18, center[1] + y * .18, center[2] + z * .18, 1]))));
  const planes = [(p: number[]) => p[0]! < -p[3]!, (p: number[]) => p[0]! > p[3]!, (p: number[]) => p[1]! < -p[3]!, (p: number[]) => p[1]! > p[3]!];
  require(planes.some(plane => corners.every(plane)), 'Emissive source is not completely offscreen.'); const virtualClip = multiply(camera.viewProjection, [center[0], .02 - center[1], center[2], 1]);
  const virtualCubePixel = [(virtualClip[0]! / virtualClip[3]! * .5 + .5) * s.width, (.5 - virtualClip[1]! / virtualClip[3]! * .5) * s.height];
  return { sourceCompletelyOffscreen: true, center, halfSize: .18, virtualCubePixel };
}
function checkMirrorOracle(raw: Pixels) {
  const s = session!; const camera = s.renderer.currentCamera!; const reconstruction = inverse(camera.viewProjection);
  const expected: boolean[] = []; let expectedHits = 0; let actualHits = 0; let falseHits = 0; let falseMisses = 0;
  const cameraEye = camera.eye; const scene = s.renderer.currentScene;
  for (let y = 0; y < raw.height; y++) for (let x = 0; x < raw.width; x++) {
    const far = multiply(reconstruction, [(x + .5) / raw.width * 2 - 1, 1 - (y + .5) / raw.height * 2, 1, 1]);
    const incident = normalized(far.slice(0, 3).map((v, axis) => v / far[3]! - cameraEye[axis]!));
    const t = (.01 - cameraEye[1]!) / incident[1]; const point = cameraEye.map((v, axis) => v + t * incident[axis]!) as unknown as Vec3;
    let nearest = Infinity; let nearestId = -1;
    if (t > 0 && point[0] > -2 && point[0] < -1 && point[2] > -1 && point[2] < 1) {
      const direction: Vec3 = [incident[0], -incident[1], incident[2]]; const origin: Vec3 = [point[0], .012, point[2]];
      for (const box of scene.boxes) { const distance = boxDistance(origin, direction, box.center, box.halfSize, box.yaw); if (distance !== null && distance < nearest) { nearest = distance; nearestId = box.id; } }
    }
    const hit = nearestId === scene.objectBoxId; const actual = raw.values[(y * raw.width + x) * 4]! > 2;
    expected.push(hit); expectedHits += Number(hit); actualHits += Number(actual); falseHits += Number(actual && !hit); falseMisses += Number(hit && !actual);
  }
  // Only allow a one-pixel silhouette band for float32 depth reconstruction and raster edges.
  let interiorFailures = 0;
  for (let y = 1; y < raw.height - 1; y++) for (let x = 1; x < raw.width - 1; x++) {
    const index = y * raw.width + x; const value = expected[index]!;
    if ([-1, 0, 1].every(dy => [-1, 0, 1].every(dx => expected[(y + dy) * raw.width + x + dx] === value))) {
      if ((raw.values[index * 4]! > 2) !== value) interiorFailures++;
    }
  }
  require(expectedHits > 25 && actualHits > 25, `Missing analytic cube reflection: expected=${expectedHits}, actual=${actualHits}`);
  require(interiorFailures === 0, `Planar/AABB oracle found ${interiorFailures} wrong interior reflection pixels (${falseHits} falsehits/${falseMisses} falsemisses).`);
  return { expectedHits, actualHits, falseHits, falseMisses, interiorFailures, silhouetteTolerancePixels: 1 };
}
export async function runReflectionCase(name: string) {
  require(session, 'Reflection session missing.'); const s = session; s.currentCase = name; let result!: NonNullable<Awaited<ReturnType<typeof step>>>;
  let evidence: Record<string, unknown> = {};
  if (name === 'cold-world') {
    result = (await step({ reflections: { mode: 'world', roughness: 0 } }))!;
    evidence = { ...offscreenProof(), oracle: checkMirrorOracle(result.raw), firstSubmittedFrame: s.frame, screenTracing: false, giEnabled: false, temporal: false };
    require(result.sourceCounts[1]! > 25 && result.sourceCounts[3] === 0, 'Cold reflection did not come from fresh world hits.');
  } else if (name === 'history') {
    await step({ reflections: { updateEvery: 4 } }, 0, false); result = (await step())!;
    require(result.counters[0] === 0 && result.counters[1] === 0 && result.sourceCounts[3]! > 25, 'Skipped trace frame did not reuse qualified history.');
  } else if (name === 'move-minus' || name === 'move-plus') {
    const offset = name === 'move-minus' ? -.4 : .4; const oldEpoch = s.renderer.reflectionTelemetry.cacheEpoch;
    result = (await step({ reflections: { objectOffset: offset, updateEvery: 1 } }))!;
    const proof = offscreenProof();
    evidence = { ...proof, oracle: checkMirrorOracle(result.raw) };
    require(Math.abs(result.metrics.centroid![0]! - proof.virtualCubePixel[0]!) < 3, 'Reflected centroid disagrees with the projected virtual image.');
    require(result.telemetry.cacheEpoch !== oldEpoch && result.sourceCounts[3] === 0, 'Moving object retained old reflection history.');
    if (name === 'move-plus') {
      const previous = prior.get('move-minus')!; const change = result.metrics.centroid![0]! - previous.metrics.centroid![0]!;
      require(Math.abs(change) > 30, 'Reflected image centroid failed to move with the offscreen object.'); evidence.centroidMovementPixels = change;
    }
  } else if (name === 'rough') {
    await step({ reflections: { objectOffset: 0, roughness: 0 } }, 0, false);
    const sharp = (await step())!; await step({ reflections: { roughness: .35 } }, 0, false);
    for (let i = 0; i < 63; i++) await step({}, 0, false); result = (await step())!;
    const normalRoughness = await readViewPixel(s.device, s.renderer.outputs!.normal, Math.floor(s.width / 2), Math.floor(s.height / 2));
    require(result.metrics.energy > 0 && result.metrics.variance! > sharp.metrics.variance! * 1.1, `GGX roughness did not broaden the reflected source: ${JSON.stringify({sharp:sharp.metrics,rough:result.metrics,counters:result.counters,normalRoughness})}`);
    const filteredPixels = result.image.values.filter((value, i) => i % 4 === 0 && Math.abs(value - result.raw.values[i]!) > .02).length;
    require(filteredPixels > 100, 'Glossy reconstruction did not filter current stochastic samples.');
    evidence = { accumulationSubmissions: 65, sharp: sharp.metrics, rough: result.metrics, filteredPixels, gbufferNormalRoughness: normalRoughness };
  } else if (name === 'camera-cut') {
    const oldEpoch = s.renderer.reflectionTelemetry.cacheEpoch;
    result = (await step({ cameraCut: true, reflections: { roughness: 0, objectOffset: 0, updateEvery: 4 } }))!;
    require(result.telemetry.cacheEpoch !== oldEpoch && result.counters[6] === 0, 'Camera cut retained old reflected history.');
    evidence.oracle = checkMirrorOracle(result.raw);
  } else if (name === 'fallback') {
    result = (await step({ debugView: 'reflection-source', reflections: { maxDistance: 1, updateEvery: 1 } }))!;
    const center = prior.get('cold-world')!.metrics.centroid!; const index = (Math.round(center[1]!) * result.image.width + Math.round(center[0]!)) * 4;
    require(result.image.values[index + 2]! > .99 && result.image.values[index + 1]! < .31, 'Max-distance miss did not display explicit blue probe fallback.');
    require(result.sourceCounts[2]! > 25 && result.raw.values.filter((v, i) => i % 4 === 0 && v > 2).length === 0, 'Short trace unexpectedly reached the emissive cube.');
    evidence.fallbackPixel = result.image.values.slice(index, index + 3);
  } else if (name === 'off') {
    result = (await step({ reflections: { mode: 'off', maxDistance: 16, updateEvery: 1, roughness: 0, objectOffset: 0 } }))!; require(result.stats.dispatchCalls === 0 && result.metrics.total === 0, 'Disabled reflection still produced tracing or a reflection debug image.');
  } else if (name === 'probe-only-cold') {
    result = (await step({ reflections: { mode: 'probe-only', maxDistance: 16 } }))!;
    require(result.stats.dispatchCalls === 1 && result.metrics.total === 0, 'GI-off probe fallback was not black or still traced.');
  } else if (name === 'probe-only-warm') {
    for (let i = 0; i < 240; i++) await step({ gi: { enabled: true }, reflections: { mode: 'probe-only' } }, 0, false);
    result = (await step({ gi: { enabled: true } }))!; require(result.stats.dispatchCalls === 3 && result.metrics.total > .01, 'Warm probe fallback remained black or traced world reflections.');
    evidence.accumulationSubmissions = 241;
  } else if (name === 'resize') {
    s.width = 400; s.height = 224; s.canvas.width = s.width; s.canvas.height = s.height;
    result = (await step({ reflections: { mode: 'world', roughness: 0, updateEvery: 1 } }))!;
    require(result.telemetry.reflectionWidth === 400 && result.telemetry.reflectionHeight === 224 && result.counters[6] === 0, 'Reflection resize did not invalidate history.');
    evidence.oracle = checkMirrorOracle(result.raw);
  } else if (name === 'camera-motion') {
    const first = (await step({ reflections: { updateEvery: 4 } }, 0))!;
    const moved = (await step({}, .4))!; result = moved;
    require(moved.telemetry.cacheEpoch !== first.telemetry.cacheEpoch && moved.counters[0]! > 0 && moved.counters[6] === 0, 'Actual camera view motion reused stale parallax.');
    evidence = { beforeEpoch: first.telemetry.cacheEpoch, afterEpoch: moved.telemetry.cacheEpoch };
  } else if (name === 'temporal-toggle') {
    const epoch = s.renderer.reflectionTelemetry.cacheEpoch;
    await step({ temporal: true, debugView: 'final' }, 0, false);
    result = (await step({ temporal: false }))!;
    require(result.telemetry.cacheEpoch === epoch, 'Screen TAA toggle reset the world reflection cache.');
    evidence.epoch = epoch;
  } else if (name.startsWith('quarter-')) {
    if (name === 'quarter-resize') { s.width = 400; s.height = 224; s.canvas.width = s.width; s.canvas.height = s.height; }
    result = (await step({ reflections: { objectOffset: name === 'quarter-cold' ? 0 : .4 } }))!;
    const proof = offscreenProof();
    require(result.metrics.energy > 0 && result.metrics.maximum < 8 && result.sourceCounts[1]! > 25, 'Quarter-resolution path lost bounded world reflection.');
    require(result.metrics.centroid!.every((value, axis) => Math.abs(value - proof.virtualCubePixel[axis]!) < 4), 'Quarter-resolution upsampling displaced the reflection centroid.');
    const source = (await step({ debugView: 'reflection-source' }))!;
    const mask = await readReflectorMask(s.device, s.renderer.outputs!.material, s.width, s.height);
    let outsideMask = 0;
    for (let i = 0; i < mask.length; i++) if (!mask[i] && source.image.values.slice(i * 4, i * 4 + 3).some(value => value > .001)) outsideMask++;
    require(outsideMask === 0, 'Quarter-resolution reconstruction painted a reflection outside the selected material mask.');
    evidence = { ...proof, reflectionResolution: [result.telemetry.reflectionWidth, result.telemetry.reflectionHeight], outsideMaskPixels: outsideMask };
  } else if (name === 'quota-tour') {
    const windows = []; let primaryRays = 0;
    for (let i = 0; i < 20; i++) {
      const current = (await step({}, i * .02))!;
      const config = await readStats(s.device, s.renderer.reflectionCache.diagnostics.configBuffer, 240);
      windows.push({ start: config[44], candidates: config[45], regionPixels: config[46], epoch: current.telemetry.cacheEpoch });
      require(current.counters[0] === 256 && current.counters[1]! <= 256 && current.counters[6] === 0, 'Moving-camera quota or history invalidation failed.');
      primaryRays += current.counters[1]!;
      result = current;
    }
    require(new Set(windows.map(window => window.start)).size > 10 && primaryRays > 0, 'Camera motion starved later candidate windows.');
    evidence = { windows, primaryRays, totalCandidateQuota: 20 * 256 };
  } else if (name === 'quota') {
    result = (await step())!; require(result.counters[0] === 256 && result.counters[1]! <= 256, 'Small-budget trace did not respect its fixed quota.');
    evidence.maxRaysPerFrame = 256;
  } else throw new Error(`Unknown reflection case ${name}.`);
  prior.set(name, { image: result.image, metadata: result.metadata, metrics: result.metrics, epoch: Number(result.telemetry.cacheEpoch) });
  // Explicit presentation boundary for screenshots, outside any performance measurement.
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  return { name, stats: result.stats, telemetry: result.telemetry,
    counters: result.telemetry.mode === 'world' ? result.counters : null,
    counterSource: result.telemetry.mode === 'world' ? 'current-submission-gpu-readback' : 'inactive-trace-buffer-not-read-as-current',
    sourceCounts: result.telemetry.mode === 'world' ? result.sourceCounts : null,
    selectedPixels: result.telemetry.mode === 'world' ? result.selectedPixels : null, metrics: result.metrics, evidence, gpuErrors: s.gpuErrors };
}
export async function showReflectionView(view: 'final' | 'reflections' | 'reflection-source') {
  const result = (await step({ debugView: view }))!; await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  return { view, metrics: result.metrics, frame: session!.frame };
}
