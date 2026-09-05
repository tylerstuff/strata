import { IntegratedRenderer } from '../../packages/core/src/integrated/integrated-renderer.js';
import type { IntegratedSceneOptions } from '../../packages/core/src/integrated/integrated-types.js';
import { giTraceShader } from '../../packages/core/src/gi/trace-shaders.js';
import { triangulateGiScene } from '../../packages/core/src/gi/scene-data.js';
import type { GiTriangle, GiVec3 } from '../../packages/core/src/gi/scene-data.js';
import type { GeometryTelemetry } from '../../packages/core/src/geometry/virtual-types.js';
import type { GiRay } from '../../packages/core/src/gi/trace-data.js';
import { projectGiValidationPoint, readGiLinearRoi } from './gi-validation.js';

type Controls = NonNullable<Parameters<IntegratedRenderer['encode']>[5]>;
type Options = Pick<IntegratedSceneOptions, 'manifestUrl' | 'traceProxyUrl'> & Partial<IntegratedSceneOptions>;
type Vec3 = GiVec3;
function require(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => a.map(v => v / Math.hypot(...a)) as unknown as Vec3;
const clip = (m: ArrayLike<number>, p: Vec3) => [0, 1, 2, 3].map(i => m[i]! * p[0] + m[i + 4]! * p[1] + m[i + 8]! * p[2] + m[i + 12]!);
function sourceHeight(x: number, z: number): number {
  const phase = (1337 % 1024) * Math.PI * 2 / 1024;
  return Math.fround(6 * Math.sin(x * 8 / 19 + phase) + 3 * Math.cos(z * 8 / 13 - phase) + 2 * Math.sin((x + z) * 8 / 9 + phase / 2)) * .125 - 1.625;
}
/** Independent scalar plane/barycentric intersection; no BVH traversal helper is used. */
function brute(ray: GiRay, triangles: readonly GiTriangle[]) {
  let result: { distance: number; triangle: GiTriangle } | null = null;
  for (const triangle of triangles) {
    const u = sub(triangle.p1, triangle.p0); const v = sub(triangle.p2, triangle.p0); const normal = cross(u, v);
    const denominator = dot(normal, ray.direction); if (Math.abs(denominator) < 1e-10) continue;
    const distance = dot(normal, sub(triangle.p0, ray.origin)) / denominator;
    if (distance < ray.tMin || distance > ray.tMax || (result && distance >= result.distance)) continue;
    const point = ray.origin.map((value, i) => value + ray.direction[i]! * distance) as unknown as Vec3;
    const delta = sub(point, triangle.p0); const uu = dot(u, u); const uv = dot(u, v); const vv = dot(v, v);
    const du = dot(delta, u); const dv = dot(delta, v); const determinant = uu * vv - uv * uv;
    const a = (du * vv - dv * uv) / determinant; const b = (dv * uu - du * uv) / determinant;
    if (a >= -1e-9 && b >= -1e-9 && a + b <= 1 + 1e-9) result = { distance, triangle };
  }
  return result;
}
async function readBuffer(device: GPUDevice, source: GPUBuffer, size: number): Promise<ArrayBuffer> {
  const readback = device.createBuffer({ size, usage: 1 | 8 });
  try {
    const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(source, 0, readback, 0, size);
    device.queue.submit([encoder.finish()]); await readback.mapAsync(1);
    const result = readback.getMappedRange().slice(0); readback.unmap(); return result;
  } finally { readback.destroy(); }
}
/** Sampling reads actual MRT views without requiring the underlying texture to be exposed. */
async function readView(device: GPUDevice, view: GPUTextureView, width: number, height: number, integers = false): Promise<Float32Array | Uint32Array> {
  const output = device.createBuffer({ size: width * height * 16, usage: 0x80 | 4 });
  try {
    const type = integers ? 'u32' : 'f32';
    const code = `@group(0) @binding(0) var source: texture_2d<${type}>;
@group(0) @binding(1) var<storage,read_write> result: array<vec4<${type}>>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
if(id.x < ${width}u && id.y < ${height}u) { result[id.y * ${width}u + id.x] = textureLoad(source,vec2i(id.xy),0); } }`;
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }, { binding: 1, resource: { buffer: output } }] });
    const encoder = device.createCommandEncoder(); const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end(); device.queue.submit([encoder.finish()]);
    const data = await readBuffer(device, output, width * height * 16);
    const values = integers ? new Uint32Array(data) : new Float32Array(data);
    require(values.every(Number.isFinite), 'Integrated texture contains nonfinite values.'); return values;
  } finally { output.destroy(); }
}

let session: { adapter: GPUAdapter; device: GPUDevice; renderer: IntegratedRenderer; canvas: HTMLCanvasElement; context: GPUCanvasContext;
  frame: number; width: number; height: number; gpuErrors: string[]; losses: string[]; options: Options } | undefined;
let greenEvidence: { mean: number[]; direct: number[] } | undefined;

export async function startIntegratedValidation(options: Options) {
  disposeIntegratedValidation();
  const adapter = await navigator.gpu.requestAdapter(); require(adapter, 'WebGPU adapter unavailable.'); const device = await adapter.requestDevice();
  const gpuErrors: string[] = []; const losses: string[] = [];
  device.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
  void device.lost.then(info => { if (info.reason !== 'destroyed') losses.push(`${info.reason}: ${info.message}`); });
  const canvas = document.querySelector('canvas'); require(canvas, 'Validation canvas missing.'); canvas.width = 320; canvas.height = 180;
  const context = canvas.getContext('webgpu') as GPUCanvasContext | null; require(context, 'WebGPU canvas context unavailable.'); const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  try {
    const renderer = await IntegratedRenderer.create(device, format, { renderer: 'integrated', cameraMode: 'receiver', geometryMode: 'streamed',
      poolBytes: 8 * 65536, pixelError: .25, maxConcurrentRequests: 2, uploadBudgetBytes: 65536, pageLoadDelayMs: 50,
      wallColor: 'neutral', roughness: 0, resolutionScale: 1, maxRaysPerFrame: 32768, ...options });
    session = { adapter, device, renderer, canvas, context, frame: 0, width: 320, height: 180, gpuErrors, losses, options };
    const info = adapter.info;
    return { adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
      isFallbackAdapter: info.isFallbackAdapter }, integrated: renderer.integratedTelemetry, geometry: renderer.geometryTelemetry };
  } catch (error) { context.unconfigure(); device.destroy(); throw error; }
}
export function disposeIntegratedValidation() {
  if (!session) return null; const s = session;
  const before = { buffers: s.renderer.gpuBufferBytes, textures: s.renderer.gpuTextureBytes };
  s.renderer.dispose(); s.renderer.dispose(); const after = { buffers: s.renderer.gpuBufferBytes, textures: s.renderer.gpuTextureBytes };
  s.context.unconfigure(); s.device.destroy(); session = undefined;
  require(after.buffers === 0 && after.textures === 0, 'Disposed integrated scene retains tracked allocations.');
  return { before, after, gpuErrors: s.gpuErrors, deviceLosses: s.losses };
}
async function step(controls: Controls = {}, time = 0) {
  require(session, 'Integrated validation session missing.'); const s = session; const effective = { temporal: false, ...controls };
  const passes = s.renderer.passNames(effective); const encoder = s.device.createCommandEncoder();
  const stats = s.renderer.encode(encoder, s.context.getCurrentTexture().createView(), s.width, s.height, time, effective);
  s.device.queue.submit([encoder.finish()]); s.renderer.submitted(++s.frame);
  // Functional checks deliberately keep at most one renderer submission in flight.
  await s.device.queue.onSubmittedWorkDone(); await s.renderer.flushFeedback();
  require(s.losses.length === 0 && s.gpuErrors.length === 0, [...s.losses, ...s.gpuErrors].join('\n'));
  const geometry: GeometryTelemetry = s.renderer.geometryTelemetry;
  require(geometry.coverageMissingTiles === 0 && geometry.overflowCount === 0, `Incomplete or overflowing terrain selection: ${JSON.stringify(geometry)}`);
  require(Number(geometry.residentPages) * 65536 <= Number(geometry.poolBytes), 'Render page pool exceeds its fixed cap.');
  require(Number(geometry.stagingReservedBytes) <= Number(geometry.stagingBudgetBytes), 'Page staging exceeds its fixed cap.');
  require(passes.filter(name => name === 'selection').length === 1 && passes.filter(name => name === 'raster').length === 1 && passes.filter(name => name === 'shadow').length === 1,
    'Integrated rendering duplicated the selection, shadow, or shared MRT pass.');
  const giEnabled = Boolean(s.renderer.giTelemetry.enabled); const reflectionMode = s.renderer.reflectionTelemetry.mode;
  const hasTrace = Number(s.renderer.reflectionTelemetry.scheduledCandidates) > 0;
  const expectedDispatches = 2 + (giEnabled ? 2 : 0) + (reflectionMode === 'world' ? 1 + Number(hasTrace) : 0) + (giEnabled || reflectionMode !== 'off' ? 1 : 0);
  const skipped = stats.skippedGpuPasses ?? [];
  require(JSON.stringify(skipped) === JSON.stringify(reflectionMode === 'world' && !hasTrace ? ['reflection-trace'] : []),
    `Skipped reflection query metadata differs from actual dispatched work: ${skipped}`);
  require(stats.dispatchCalls === expectedDispatches && stats.drawCalls === 5 + Number(effective.temporal),
    `Integrated providers/pass counters disagree: ${JSON.stringify({ stats, passes, expectedDispatches })}`);
  return { frame: s.frame, passes: passes.filter(pass => !skipped.includes(pass)), stats, geometry, gi: s.renderer.giTelemetry, reflections: s.renderer.reflectionTelemetry,
    allocations: { buffers: s.renderer.gpuBufferBytes, textures: s.renderer.gpuTextureBytes } };
}

async function traceProxyProof() {
  const s = session!; const rays: GiRay[] = [];
  // Off-axis, non-grid-edge downward rays span all four outdoor sides.
  for (let z = -14.7; z < 16; z += 4) for (let x = -14.3; x < 16; x += 4) {
    if (Math.abs(x) < 6.2 && Math.abs(z) < 4.2) continue;
    rays.push({ origin: [x, 3, z], direction: normalize([.013, -1, -.007]), tMin: .0005, tMax: 32 });
  }
  rays.push({ origin: [5.5, 1.5, -3.5], direction: normalize([2.5, -4.18542041344715, 0]), tMin: .0005, tMax: 32 });
  const rayData = new Float32Array(rays.length * 8);
  rays.forEach((ray, i) => { rayData.set([...ray.origin, ray.tMin, ...ray.direction, ray.tMax], i * 8); });
  const packedRays: GiRay[] = rays.map((_, i) => ({ origin: Array.from(rayData.slice(i * 8, i * 8 + 3)) as unknown as Vec3,
    tMin: rayData[i * 8 + 3]!, direction: Array.from(rayData.slice(i * 8 + 4, i * 8 + 7)) as unknown as Vec3, tMax: rayData[i * 8 + 7]! }));
  const rayBuffer = s.device.createBuffer({ size: rayData.byteLength, usage: 0x80 | 8 });
  const output = s.device.createBuffer({ size: rays.length * 48, usage: 0x80 | 4 });
  try {
    s.device.queue.writeBuffer(rayBuffer, 0, rayData);
    const code = giTraceShader({ group: 0 }) + `\n@group(0) @binding(5) var<storage,read> inputRays:array<GiRay>;
@group(0) @binding(6) var<storage,read_write> hits:array<GiTraceHit>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) { if(id.x < arrayLength(&inputRays)) { hits[id.x]=giTraceBvh(inputRays[id.x]); } }`;
    const layout = s.device.createBindGroupLayout({ entries: Array.from({ length: 7 }, (_, binding) => ({ binding, visibility: 4,
      buffer: { type: binding === 4 ? 'uniform' as const : binding === 6 ? 'storage' as const : 'read-only-storage' as const } })) });
    const pipeline = await s.device.createComputePipelineAsync({ layout: s.device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module: s.device.createShaderModule({ code }), entryPoint: 'main' } });
    const group = s.device.createBindGroup({ layout, entries: [...s.renderer.traceBindings, { binding: 5, resource: { buffer: rayBuffer } }, { binding: 6, resource: { buffer: output } }] });
    const encoder = s.device.createCommandEncoder(); const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(rays.length / 64)); pass.end();
    s.device.queue.submit([encoder.finish()]); const data = await readBuffer(s.device, output, rays.length * 48); const floats = new Float32Array(data); const words = new Uint32Array(data);
    const triangles = [...triangulateGiScene(s.renderer.currentScene), ...s.renderer.proxy.triangles]; let maximumDistanceError = 0; let maximumHeightError = 0;
    const results = packedRays.map((ray, i) => {
      const expected = brute(ray, triangles); const offset = i * 12;
      require(expected && expected.triangle.boxId === 0xfffffffe, `Independent ray ${i} failed to reach the terrain proxy.`);
      require(words[offset + 7] === 1 && words[offset + 2] === 5 && words[offset + 3] === 0xfffffffe, `GPU ray ${i} missed persistent material-5 terrain or exhausted traversal.`);
      const error = Math.abs(floats[offset]! - expected.distance); maximumDistanceError = Math.max(maximumDistanceError, error);
      require(error < .0002, `Production BVH differs from independent proxy ray ${i}: ${error}`);
      const normal = [floats[offset + 4]!, floats[offset + 5]!, floats[offset + 6]!] as Vec3;
      require(dot(normal, expected.triangle.normal) > .9999, 'Terrain ray normal differs from independent source triangles.');
      const point = ray.origin.map((v, axis) => v + ray.direction[axis]! * floats[offset]!) as unknown as Vec3;
      maximumHeightError = Math.max(maximumHeightError, Math.abs(point[1] - sourceHeight(point[0], point[2])));
      return { distance: floats[offset]!, triangleId: words[offset + 1], materialId: words[offset + 2], objectId: words[offset + 3] };
    });
    require(maximumHeightError <= s.renderer.proxy.manifest.error.maxVertical + .0002, 'Persistent proxy exceeds its declared analytic-source height error.');
    require(s.renderer.traceData.triangleCount === 2204 && s.renderer.traceData.staticTriangles.length === 2048, 'Shared trace scene lost persistent triangles.');
    return { rays: results.length, maximumDistanceError, maximumHeightError, analyticSourceErrorBound: s.renderer.proxy.manifest.error.maxVertical,
      productionGpuBuffers: true, oracle: 'independent plane/barycentric source-triangle intersection', sdfUsed: false, results };
  } finally { rayBuffer.destroy(); output.destroy(); }
}

async function coldMirror() {
  const s = session!; const frame = await step({ debugView: 'reflections', gi: { enabled: false }, reflections: { mode: 'world', roughness: 0 } });
  const camera = s.renderer.currentCamera!; const cube = s.renderer.currentScene.boxes[s.renderer.currentScene.objectBoxId]!;
  const corners = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => clip(camera.viewProjection,
    [cube.center[0] + x * .18, cube.center[1] + y * .18, cube.center[2] + z * .18]))));
  require(corners.every(p => p[1]! > p[3]!), 'The integrated emissive cube is not completely above the camera frustum.');
  const virtual = [cube.center[0], .02 - cube.center[1], cube.center[2]] as Vec3;
  const pixel = projectGiValidationPoint(camera.viewProjection, virtual, s.width, s.height);
  const raw = s.renderer.reflectionCache.diagnostics.rawTexture;
  const roi = await readGiLinearRoi(s.device, raw, pixel, 2);
  require(roi.mean[0]! > 2 && roi.mean[0]! > 4 * roi.mean[1]!, `Offscreen emitter missing in cold integrated world reflection: ${roi.mean}`);
  const metadata = await readView(s.device, s.renderer.reflectionCache.diagnostics.metadataTexture.createView(), raw.width, raw.height, true);
  const index = (pixel[1] * raw.width + pixel[0]) * 4;
  require(metadata[index] === 1 && metadata[index + 2] === frame.reflections.cacheEpoch, 'Cold reflected witness did not originate from a fresh world hit.');
  const material = await readView(s.device, s.renderer.outputs!.material, s.width, s.height);
  const normal = await readView(s.device, s.renderer.outputs!.normal, s.width, s.height);
  require(material[index + 3]! > .99 && normal[index + 1]! > .99 && normal[index + 3] === 0, 'Shared MRT lost mirror metallic/normal/roughness material.');
  return { frame, sourceCompletelyOffscreen: true, firstSubmission: s.frame, pixel, coldLinearReflection: roi, freshWorldSource: true,
    mirrorMaterial: Array.from(material.slice(index, index + 4)), mirrorNormalRoughness: Array.from(normal.slice(index, index + 4)), screenTracing: false };
}
async function materialProof() {
  const s = session!; const frame = await step({ gi: { enabled: false }, reflections: { mode: 'off' }, debugView: 'material' });
  const material = await readView(s.device, s.renderer.outputs!.material, s.width, s.height);
  const normal = await readView(s.device, s.renderer.outputs!.normal, s.width, s.height);
  const expected = s.renderer.currentScene.materials[5]!.albedo; let terrainPixels = 0; let roomPixels = 0; let maximumNormalError = 0;
  for (let i = 0; i < material.length; i += 4) {
    if (expected.every((value, channel) => Math.abs(material[i + channel]! - value) <= 1 / 255)) {
      terrainPixels++; require(material[i + 3] === 0 && normal[i + 3] === 1, 'Terrain MRT differs from opaque Lambert trace material.');
      maximumNormalError = Math.max(maximumNormalError, Math.abs(Math.hypot(normal[i]!, normal[i + 1]!, normal[i + 2]!) - 1));
      require(normal[i + 1]! > 0, 'Terrain transform inverted the world normal.');
    } else if (Math.hypot(normal[i]!, normal[i + 1]!, normal[i + 2]!) > .9) roomPixels++;
  }
  require(terrainPixels > 1000 && roomPixels > 20 && maximumNormalError < .002, `Shared MRT did not contain both aligned providers: ${terrainPixels}/${roomPixels}`);
  return { frame, terrainPixels, roomPixels, terrainMaterial: expected, maximumNormalError, oneSharedMrt: true };
}

async function terrainLighting() {
  const s = session!; const patch: Vec3 = [5.5, 1.5, -4];
  const initialSubmittedFrames = s.renderer.probeCache.telemetry.submittedFrames;
  require(initialSubmittedFrames === 0, 'Terrain GI comparison must start before any world-cache submission.');
  const cold = await step({ gi: { enabled: true }, reflections: { mode: 'off' }, debugView: 'indirect' });
  const pixel = projectGiValidationPoint(s.renderer.currentCamera!.viewProjection, patch, s.width, s.height);
  const coldRoi = await readGiLinearRoi(s.device, s.renderer.composer.outputTexture!, pixel);
  const direct = await readGiLinearRoi(s.device, s.renderer.directTexture!, pixel);
  require(cold.gi.framesSinceReset === 1, 'Initial terrain lighting did not use a fresh world epoch.');
  const witness: Vec3 = [8, -2.68542041344715, -3.5]; const witnessClip = clip(s.renderer.currentCamera!.viewProjection, witness);
  require(witnessClip[1]! < -witnessClip[3]!, 'Terrain source witness entered the image.');
  // Record conservative AABB separation separately. The bound may intersect
  // the frustum even when the wall occludes every actual terrain raster pixel.
  const terrainCorners = [-16, 16].flatMap(x => [-3, -.25].flatMap(y => [-16, 16].map(z => clip(s.renderer.currentCamera!.viewProjection, [x, y, z]))));
  const entireTerrainOffscreen = terrainCorners.every(p => p[1]! < -p[3]!);
  const receiverMaterial = await readView(s.device, s.renderer.outputs!.material, s.width, s.height);
  const receiverNormals = await readView(s.device, s.renderer.outputs!.normal, s.width, s.height);
  const terrainAlbedo = s.renderer.currentScene.materials[5]!.albedo; let visibleTerrainPixels = 0;
  for (let i = 0; i < receiverMaterial.length; i += 4) {
    if (receiverNormals[i + 1]! > .1 && terrainAlbedo.every((v, channel) => Math.abs(v - receiverMaterial[i + channel]!) <= 1 / 255)) visibleTerrainPixels++;
  }
  require(visibleTerrainPixels === 0, `Terrain material entered the receiver image (${visibleTerrainPixels} pixels).`);
  const samples: number[][] = [];
  for (let i = 1; i < 240; i++) {
    await step({ debugView: 'indirect' });
    if (i >= 216) samples.push((await readGiLinearRoi(s.device, s.renderer.composer.outputTexture!, pixel)).mean);
  }
  const mean = [0, 1, 2].map(channel => samples.reduce((sum, value) => sum + value[channel]!, 0) / samples.length);
  const chroma = mean[1]! - (mean[0]! + mean[2]!) / 2;
  require(mean.some(v => v > 1e-5), `Terrain receiver has no measurable indirect energy: ${mean}`);
  let comparison: unknown = null;
  if ((s.options.terrainColor ?? 'green') === 'green') greenEvidence = { mean, direct: direct.mean };
  else {
    require(greenEvidence, 'Neutral comparison requires preceding green evidence.');
    const greenChroma = greenEvidence.mean[1]! - (greenEvidence.mean[0]! + greenEvidence.mean[2]!) / 2;
    const shift = greenChroma - chroma;
    require(shift > 1e-5, `Changing offscreen terrain green→neutral did not shift receiver chroma: ${JSON.stringify({ green: greenEvidence.mean, neutral: mean, shift })}`);
    require(direct.mean.every((v, i) => Math.abs(v - greenEvidence!.direct[i]!) < .0001), 'Matched terrain colors changed direct-only receiver lighting.');
    comparison = { green: greenEvidence.mean, neutral: mean, greenChroma, neutralChroma: chroma, signedChromaShift: shift, directUnchanged: true };
  }
  return { cold, initialSubmittedFrames, firstSubmissionLinear: coldRoi, directOnly: direct, receiverWorld: patch, pixel, tailMean: mean, terrainColor: s.options.terrainColor ?? 'green',
    observationSubmissions: 240, tailSubmissions: 24, temporal: false, screenTracing: false, entireTerrainAabbOffscreen: entireTerrainOffscreen,
    witnessWorld: witness, witnessNdc: witnessClip.slice(0, 3).map(v => v / witnessClip[3]!), witnessOffscreen: true,
    visibleTerrainMaterialPixels: visibleTerrainPixels, viewportPixels: s.width * s.height, comparison, limitation: 'Finite-grid room GI; proxy surface and finite observation tail are approximations, not ground truth convergence.' };
}

async function lightingLatency() {
  const s = session!; const receiver: Vec3 = [5.5, 1.5, -4];
  require(s.options.cameraMode === 'terrain-witness' && s.options.terrainColor === 'neutral'
    && Number(s.renderer.giTelemetry.framesSinceReset) >= 240, 'Latency must follow the matched warm neutral-terrain comparison.');
  const pixel = projectGiValidationPoint(s.renderer.currentCamera!.viewProjection, receiver, s.width, s.height);
  const originalCamera = Array.from(s.renderer.currentCamera!.viewProjection); const originalBoxes = JSON.stringify(s.renderer.currentScene.boxes);
  const originalMaterials = JSON.stringify(s.renderer.currentScene.materials);
  const originalProxy = s.renderer.traceData.staticTriangles;
  const originalBuffers = s.renderer.traceBindings.map(entry => (entry.resource as GPUBufferBinding).buffer);
  const originalEpoch = Number(s.renderer.giTelemetry.cacheEpoch);
  const sample = async (controls: Controls = {}) => {
    const frame = await step({ debugView: 'indirect', ...controls });
    require(originalCamera.every((value, index) => value === s.renderer.currentCamera!.viewProjection[index])
      && JSON.stringify(s.renderer.currentScene.boxes) === originalBoxes && JSON.stringify(s.renderer.currentScene.materials) === originalMaterials
      && s.renderer.traceData.staticTriangles === originalProxy,
    'Lighting latency changed camera, source boxes, or the persistent terrain proxy.');
    require(s.renderer.traceBindings.every((entry, i) => (entry.resource as GPUBufferBinding).buffer === originalBuffers[i]),
      'Lighting state change replaced shared tracing resources.');
    const direct = await readGiLinearRoi(s.device, s.renderer.directTexture!, pixel);
    const indirect = await readGiLinearRoi(s.device, s.renderer.composer.outputTexture!, pixel);
    return { submittedFrame: s.frame, framesSinceReset: Number(frame.gi.framesSinceReset), epoch: Number(frame.gi.cacheEpoch),
      direct: direct.mean, indirect: indirect.mean, indirectEnergy: indirect.mean.reduce((sum, value) => sum + value, 0) };
  };
  type Sample = Awaited<ReturnType<typeof sample>>;
  const collect = async (count: number, first: Controls = {}) => {
    const samples: Sample[] = [];
    for (let i = 0; i < count; i++) samples.push(await sample(i === 0 ? first : {}));
    return samples;
  };
  const summarize = (samples: Sample[]) => {
    const tail = samples.slice(-24); const mean = tail.reduce((sum, value) => sum + value.indirectEnergy, 0) / tail.length;
    const variance = tail.reduce((sum, value) => sum + (value.indirectEnergy - mean) ** 2, 0) / tail.length;
    const tolerance = Math.max(Math.abs(mean) * .2, 1e-6);
    const firstStable = samples.findIndex((_, i) => samples.slice(i).every(value => Math.abs(value.indirectEnergy - mean) <= tolerance));
    const average = (field: 'direct' | 'indirect') => [0, 1, 2].map(channel => tail.reduce((sum, value) => sum + value[field][channel]!, 0) / tail.length);
    return { samples: samples.length, tailSubmissions: tail.length, directTailMean: average('direct'), indirectTailMean: average('indirect'),
      indirectTailEnergyMean: mean, indirectTailEnergyVariance: variance, indirectTailEnergyStandardDeviation: Math.sqrt(variance),
      tailCoefficientOfVariation: mean > 0 ? Math.sqrt(variance) / mean : null,
      retrospectiveStability: { definition: 'Earliest observation after which every remaining observed energy lies within +/-20% of the last24 mean, with absolute floor1e-6.',
        firstSubmission: firstStable < 0 ? null : firstStable + 1, censored: firstStable < 0, observationLimit: samples.length,
        remainingObservedSubmissions: firstStable < 0 ? 0 : samples.length - firstStable,
        absoluteTolerance: tolerance, referenceIsGroundTruth: false } };
  };
  const baseline = await collect(24);
  const off = await collect(240, { gi: { lightIntensity: 0 } });
  require(off[0]!.epoch === originalEpoch + 1 && off.every(value => value.epoch === off[0]!.epoch), 'Light-off did not start exactly one new GI epoch.');
  const on = await collect(240, { gi: { lightIntensity: 1 } });
  require(on[0]!.epoch === off[0]!.epoch + 1 && on.every(value => value.epoch === on[0]!.epoch), 'Light-on did not start exactly one new GI epoch.');
  const baselineSummary = summarize(baseline); const offSummary = summarize(off); const onSummary = summarize(on);
  const range = onSummary.indirectTailEnergyMean - offSummary.indirectTailEnergyMean;
  const threshold = offSummary.indirectTailEnergyMean + .1 * range;
  const firstResponse = range > 1e-6 ? on.findIndex(value => value.indirectEnergy > threshold) : -1;
  return { receiverWorld: receiver, receiverPixel: pixel, units: 'submitted frames; no wall-clock or 60FPS latency claim',
    cameraAndSourceGeometryUnchanged: true, persistentProxyAndTraceBuffersUnchanged: true,
    temporal: false, reflections: 'off', directionalIntensitySequence: [1, 0, 1], emissiveObjectRemainsEnabled: true,
    initialEpoch: originalEpoch, offEpoch: off[0]!.epoch, onEpoch: on[0]!.epoch,
    firstOnResponse: { definition: 'First observed on-phase energy above off-tail mean plus10% of the measured on-minus-off tail range.',
      firstSubmission: firstResponse < 0 ? null : firstResponse + 1, censored: firstResponse < 0, observationLimit: on.length,
      measurableRange: range > 1e-6, measuredTailRange: range, threshold },
    summaries: { baseline: baselineSummary, off: offSummary, on: onSummary }, samples: { baseline, off, on },
    limitation: 'A finite retrospective response to full-cache epoch resets. Tail statistics are observations, not proof of convergence or an age bound on every hysteresis contribution.' };
}

async function lifecycle() {
  const s = session!; await step({ gi: { enabled: true }, reflections: { mode: 'world', roughness: 0 } });
  const before = { gi: s.renderer.giTelemetry.cacheEpoch, reflection: s.renderer.reflectionTelemetry.cacheEpoch };
  const cut = await step({ cameraCut: true });
  require(cut.gi.cacheEpoch === before.gi && cut.reflections.cacheEpoch !== before.reflection, 'Camera cut invalidated persistent GI or retained reflection history.');
  const bindingBuffers = s.renderer.traceBindings.map(entry => (entry.resource as GPUBufferBinding).buffer);
  const proxy = s.renderer.traceData.staticTriangles; const motions = [];
  for (const offset of [.05, .1, .15, .2]) {
    const previousGi = s.renderer.giTelemetry; const previousReflection = s.renderer.reflectionTelemetry;
    const result = await step({ reflections: { objectOffset: offset } });
    require(result.gi.cacheEpoch === previousGi.cacheEpoch
      && result.gi.diffuseInvalidationRevision === previousGi.diffuseInvalidationRevision
      && result.gi.framesSinceReset === Number(previousGi.framesSinceReset) + 1
      && result.gi.refreshFrontier === (Number(previousGi.refreshFrontier) + Number(previousGi.probesPerUpdate)) % 384,
    'Rigid-object motion restarted the integrated diffuse cache instead of advancing its bounded refresh.');
    require(result.reflections.worldRevision === Number(previousReflection.worldRevision) + 1
      && result.reflections.worldRevision === result.gi.worldRevision
      && result.reflections.cacheEpoch === Number(previousReflection.cacheEpoch) + 1,
    'Rigid-object motion failed to refit the shared world and invalidate reflection history.');
    require(s.renderer.traceData.staticTriangles === proxy && s.renderer.traceBindings.every((entry, i) => (entry.resource as GPUBufferBinding).buffer === bindingBuffers[i]), 'Rigid refit replaced persistent trace allocations.');
    motions.push({ offset, worldRevision: result.gi.worldRevision, giEpoch: result.gi.cacheEpoch,
      diffuseInvalidationRevision: result.gi.diffuseInvalidationRevision, refreshFrontier: result.gi.refreshFrontier,
      reflectionEpoch: result.reflections.cacheEpoch });
  }
  const proof = await traceProxyProof(); const epoch = s.renderer.giTelemetry.cacheEpoch; const frame = s.frame;
  const encoder = s.device.createCommandEncoder(); s.renderer.encode(encoder, s.context.getCurrentTexture().createView(), s.width, s.height, 0, { temporal: false });
  s.renderer.cancelFrame(); require(s.renderer.giTelemetry.sourceFrameId === frame, 'Cancelled encode advanced submitted lighting frame.');
  const retry = await step(); require(retry.gi.cacheEpoch === epoch, 'Cancelled unchanged frame introduced a world epoch.');
  const sizes = [];
  for (const [width, height] of [[160, 90], [320, 180]]) {
    s.canvas.width = s.width = width!; s.canvas.height = s.height = height!;
    const result = await step({ temporal: true, cameraCut: true });
    require(result.gi.cacheEpoch === epoch, 'Resize invalidated the world-space GI cache.'); sizes.push(result.allocations);
  }
  require(sizes[1]!.textures > sizes[0]!.textures, 'Resize did not update allocation accounting.');
  return { cameraCut: cut, motions, cancellationRetried: true, sizes, persistentProxy: proof };
}
async function streaming() {
  const s = session!; const before = await step({ gi: { enabled: false }, reflections: { mode: 'off' } });
  const firstProof = await traceProxyProof(); const bindings = s.renderer.traceBindings.map(entry => (entry.resource as GPUBufferBinding).buffer);
  const frames = [];
  for (const time of [0, 26, 33, 40, 47, 53, 18]) {
    let result = await step({ cameraCut: true }, time);
    for (let i = 0; i < 80; i++) {
      if (i >= 3 && result.geometry.pendingRequests === 0 && result.geometry.completedPages === 0) break;
      await new Promise(resolve => setTimeout(resolve, 15)); result = await step({}, time);
    }
    require(result.geometry.pendingRequests === 0 && result.geometry.completedPages === 0, 'Delayed geometry requests did not settle in the bounded functional window.'); frames.push(result.geometry);
  }
  require(Number(frames.at(-1)!.evictions) > 0 && Number(frames.at(-1)!.uploadedPages) > 8, 'Tour failed to exercise actual eviction beyond page-pool capacity.');
  const afterProof = await traceProxyProof();
  require(JSON.stringify(firstProof.results) === JSON.stringify(afterProof.results), 'Render-page eviction changed persistent terrain trace results.');
  require(s.renderer.traceBindings.every((entry, i) => (entry.resource as GPUBufferBinding).buffer === bindings[i]), 'Page streaming replaced shared trace allocations.');
  return { coarse: before.geometry, cameraCuts: frames, proxyBefore: firstProof, proxyAfter: afterProof,
    unchangedProductionTraceBuffers: true, delayedPageLoadsMs: 50, completeTerrainCoverageFromGpuCounters: true };
}
async function emptyReflectionPass() {
  require(session!.options.cameraMode === 'tour', 'Empty reflection pass regression requires the integrated tour.');
  const first = await step({ gi: { enabled: false }, reflections: { mode: 'world', updateEvery: 1 } }, 0);
  require(Number(first.reflections.scheduledCandidates) > 0 && first.passes.includes('reflection-trace'), 'Visible mirror did not submit a trace.');
  let outside: Awaited<ReturnType<typeof step>> | undefined; let outsideTime = 0;
  for (let time = 1; time < 60; time++) {
    const current = await step({}, time);
    if (current.reflections.scheduledCandidates === 0) { outside = current; outsideTime = time; break; }
  }
  require(outside && !outside.passes.includes('reflection-trace') && outside.passes.includes('reflection-resolve'),
    'Tour never omitted the empty trace while retaining reconstruction.');
  const repeated = await step({}, outsideTime);
  require(repeated.reflections.scheduledCandidates === 0 && !repeated.passes.includes('reflection-trace'), 'Held offscreen camera resurrected an empty queried pass.');
  const returned = await step({ cameraCut: true }, 0);
  require(Number(returned.reflections.scheduledCandidates) > 0 && returned.passes.includes('reflection-trace'), 'Returning to the mirror did not restore tracing.');
  return { first, outside, outsideTime, repeated, returned, emptyPassOmitted: true, dummyDispatchUsed: false };
}
export async function runIntegratedCase(name: string) {
  require(session, 'Integrated validation session missing.');
  try {
    const result = name === 'cold-mirror' ? await coldMirror() : name === 'shared-materials' ? await materialProof()
      : name === 'terrain-trace' ? await traceProxyProof() : name === 'terrain-lighting' ? await terrainLighting()
      : name === 'empty-reflection-pass' ? await emptyReflectionPass() : name === 'lighting-latency' ? await lightingLatency()
      : name === 'lifecycle' ? await lifecycle() : name === 'streaming' ? await streaming() : null;
    require(result, `Unknown integrated case ${name}.`); require(session.gpuErrors.length === 0 && session.losses.length === 0, [...session.gpuErrors, ...session.losses].join('\n'));
    const gpuCounters: { probes?: number[]; reflections?: number[] } = {};
    if (session.renderer.giTelemetry.enabled) {
      const counters = Array.from(new Uint32Array(await readBuffer(session.device, session.renderer.probeCache.diagnostics.statisticsBuffer, 32)));
      const telemetry = session.renderer.giTelemetry;
      require(counters[0] === telemetry.primaryRaysPerFrame && counters[7] === telemetry.probesPerUpdate
        && counters[4]! <= Number(telemetry.maxShadowRaysPerFrame) && counters[3] === 0, `Integrated probe GPU work exceeded budget or failed: ${counters}`);
      gpuCounters.probes = counters;
    }
    if (session.frame > 0 && session.renderer.reflectionTelemetry.mode === 'world') {
      const counters = Array.from(new Uint32Array(await readBuffer(session.device, session.renderer.reflectionCache.diagnostics.statisticsBuffer, 32)));
      const telemetry = session.renderer.reflectionTelemetry;
      require(counters[0] === telemetry.scheduledCandidates && counters[1]! <= counters[0]! && counters[2]! <= counters[1]!
        && counters[3]! + counters[4]! === counters[1]! && counters[5] === 0, `Integrated reflection GPU work exceeded budget or failed: ${counters}`);
      gpuCounters.reflections = counters;
    }
    return { name, result, gpuCounters, integrated: session.renderer.integratedTelemetry, gpuErrors: session.gpuErrors, deviceLosses: session.losses };
  } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}\n${[...session.gpuErrors, ...session.losses].join('\n')}`); }
}
export async function showIntegratedView(view: NonNullable<Controls['debugView']>) { await step({ debugView: view }); }
