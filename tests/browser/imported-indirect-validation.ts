import { importedIndirectShader } from '../../packages/core/src/imported/imported-indirect-shader.js';
import { ImportedIndirectEffect } from '../../packages/core/src/imported/imported-indirect-effect.js';
import type { ImportedIndirectMaterial, ImportedIndirectSource } from '../../packages/core/src/imported/imported-indirect-types.js';
import type { CameraFrame } from '../../packages/core/src/rendering/raster-math.js';
import {
  createBlackEnclosureReferenceQuads, createIndirectReferenceQuads, directWallBounceReference,
  importedIndirectBarycentricWitness, importedIndirectFixture, wallCosineProbability,
} from '../helpers/imported-indirect-reference.js';
import type { ReferencePoint as V3, ReferenceQuad, ReferenceTriangle } from '../helpers/imported-indirect-reference.js';

const GPUBufferUsage = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 } as const;
const GPUTextureUsage = { COPY_SRC: 0x1, COPY_DST: 0x2, TEXTURE_BINDING: 0x4, STORAGE_BINDING: 0x8, RENDER_ATTACHMENT: 0x10 } as const;
const GPUShaderStage = { COMPUTE: 4 } as const;
const GPUMapMode = { READ: 1 } as const;

function require(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const n = Math.hypot(...a); return [a[0] / n, a[1] / n, a[2] / n]; };
function near(actual: number, expected: number, tolerance: number, label: string): void {
  require(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: actual=${actual}, expected=${expected}, tolerance=${tolerance}`);
}
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
type Owned = GPUBuffer | GPUTexture;
class Resources {
  readonly owned: Owned[] = [];
  constructor(readonly device: GPUDevice) {}
  buffer(size: number, usage: GPUBufferUsageFlags, data?: ArrayBuffer | ArrayBufferView<ArrayBuffer>): GPUBuffer {
    const buffer = this.device.createBuffer({ size, usage }); this.owned.push(buffer);
    if (data) this.device.queue.writeBuffer(buffer, 0, data); return buffer;
  }
  texture(format: GPUTextureFormat, width: number, height: number, usage: GPUTextureUsageFlags): GPUTexture {
    const texture = this.device.createTexture({ format, size: [width, height], usage }); this.owned.push(texture); return texture;
  }
  dispose(): void { for (const resource of this.owned.reverse()) resource.destroy(); this.owned.length = 0; }
}

interface TriangleInput { readonly positions: ReferenceTriangle; readonly colors?: readonly [V3, V3, V3]; readonly uv?: readonly [readonly [number, number], readonly [number, number], readonly [number, number]]; }
/** Independent tiny test BVH packer. Deliberately reverses leaf triangle order
 * while retaining original index-triplet IDs. This does not exercise the cooker.
 */
function packSource(input: readonly TriangleInput[]): ImportedIndirectSource {
  const vertices = new Float32Array(input.length * 3 * 16), indices = Uint32Array.from({ length: input.length * 3 }, (_, i) => i);
  const triangles = new Uint8Array(input.length * 64), records = new DataView(triangles.buffer);
  input.forEach((triangle, source) => {
    const normal = unit(cross(sub(triangle.positions[1], triangle.positions[0]), sub(triangle.positions[2], triangle.positions[0])));
    const packed = input.length - source - 1;
    triangle.positions.forEach((p, corner) => {
      vertices.set([...p, ...normal, ...(triangle.uv?.[corner] ?? [0.25, 0.25]), 1, 0, 0, 1, ...(triangle.colors?.[corner] ?? [1, 1, 1]), 1], (source * 3 + corner) * 16);
      p.forEach((value, axis) => records.setFloat32(packed * 64 + corner * 16 + axis * 4, value, true));
    });
    records.setUint32(packed * 64 + 28, source * 3, true); records.setUint32(packed * 64 + 44, source, true);
    normal.forEach((value, axis) => records.setFloat32(packed * 64 + 48 + axis * 4, value, true));
  });
  type Node = { first: number; count: number; min: number[]; max: number[] };
  const nodes: Node[] = [{ first: 0, count: 0, min: [], max: [] }];
  const fill = (id: number, first: number, count: number): void => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let t = first; t < first + count; t++) for (let c = 0; c < 3; c++) for (let a = 0; a < 3; a++) {
      const p = records.getFloat32(t * 64 + c * 16 + a * 4, true); min[a] = Math.min(min[a]!, p); max[a] = Math.max(max[a]!, p);
    }
    if (count <= 4) { nodes[id] = { first, count, min, max }; return; }
    const child = nodes.length; nodes.push({ first: 0, count: 0, min: [], max: [] }, { first: 0, count: 0, min: [], max: [] });
    nodes[id] = { first: child, count: 0, min, max }; const left = Math.floor(count / 2);
    fill(child, first, left); fill(child + 1, first + left, count - left);
  };
  fill(0, 0, input.length);
  const packedNodes = new Uint8Array(nodes.length * 32), view = new DataView(packedNodes.buffer);
  nodes.forEach((node, i) => { node.min.forEach((v, a) => view.setFloat32(i * 32 + a * 4, v, true)); node.max.forEach((v, a) => view.setFloat32(i * 32 + 16 + a * 4, v, true)); view.setUint32(i * 32 + 12, node.first, true); view.setUint32(i * 32 + 28, node.count, true); });
  return { nodes: packedNodes, triangles, vertices, indices };
}
function sourceQuads(quads: readonly ReferenceQuad[]): ImportedIndirectSource {
  return packSource(quads.flatMap(quad => [[0, 1, 2], [0, 2, 3]].map(corners => ({
    positions: corners.map(i => quad.positions[i]!) as unknown as ReferenceTriangle,
    colors: [quad.color, quad.color, quad.color] as const,
  }))));
}

const diagnosticsShader = /* wgsl */ `
struct TestRay { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, options: vec4u, };
struct TestResult { a: vec4f, b: vec4f, c: vec4f, d: vec4f, e: vec4f, f: vec4f, g: vec4f, h: vec4f, };
@group(3) @binding(0) var<storage, read> testRays: array<TestRay>;
@group(3) @binding(1) var<storage, read_write> testResults: array<TestResult>;
@compute @workgroup_size(64) fn queryImportedTrace(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&testRays)) { return; }
  let ray = testRays[id.x]; var hit: StaticTraceHit;
  if (ray.options.y == 1u) { hit = traceStaticOcclusion(ray.origin, ray.direction, ray.tMin, ray.tMax, ray.options.x); }
  else { hit = traceStaticVisible(ray.origin, ray.direction, ray.tMin, ray.tMax, ray.options.x, ray.options.y == 2u); }
  var result: TestResult; result.a = vec4f(f32(hit.status), -1.0, hit.distance, f32(hit.nodeVisits));
  result.b = vec4f(hit.barycentric, 0.0, 0.0);
  if (hit.status == 1u) {
    result.a.y = f32(staticTraceTriangles[hit.triangle].sourceTriangleId);
    result.b.z = f32(staticTraceTriangles[hit.triangle].sourceVertex0);
    result.c = vec4f(indirectDiffuse(hit), 0.0); result.d = vec4f(indirectEmission(hit), 0.0);
  }
  testResults[id.x] = result;
}
@compute @workgroup_size(64) fn queryImportedEnvironment(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&testRays)) { return; }
  let ray = testRays[id.x];
  testResults[id.x].a = vec4f(importedIndirectEnvironment(ray.origin, vec4f(ray.tMin, ray.direction), vec3f(0.0)), 0.0);
}
// Diagnostic re-evaluation emits actual production sample directions/origins.
// It does not calculate the CPU expected radiance. No hash or sampler is ported
// into the independent plane-intersection oracle on the host.
@compute @workgroup_size(64) fn inspectImportedSample(@builtin(global_invocation_id) id: vec3u) {
  let size = indirectFrame.sizeBudget.xy; if (id.x >= size.x * size.y) { return; }
  let pixel = vec2u(id.x % size.x, id.x / size.x);
  let clipXY = ((vec2f(pixel) + 0.5) / vec2f(size)) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let farH = indirectFrame.inverseViewProjection * vec4f(clipXY, 1.0, 1.0);
  let nearH = indirectFrame.inverseViewProjection * vec4f(clipXY, 0.0, 1.0);
  let nearPoint = nearH.xyz / nearH.w;
  let farVector = farH.xyz / farH.w - nearPoint;
  let primaryDirection = normalize(farVector);
  let primary = traceStaticVisible(nearPoint, primaryDirection, 0.0, length(farVector), indirectFrame.options.y, indirectFrame.options.w == 0u);
  var result: TestResult; result.e.w = f32(primary.status);
  if (primary.status != 1u) { testResults[id.x] = result; return; }
  let point = indirectPoint(primary); let normal = indirectNormal(primary, primaryDirection);
  let seed = indirectHash(id.x ^ indirectFrame.options.z);
  let direction = indirectCosineDirection(normal, seed, 1u);
  let origin = staticTraceOffset(point, normal, staticTraceTriangles[primary.triangle]);
  let secondary = traceStatic(origin, direction, 0.0, 1e30, indirectFrame.options.y);
  result.a = vec4f(direction, f32(secondary.status)); result.b = vec4f(origin, -1.0);
  result.h = vec4f(indirectDiffuse(primary), indirectRandom(seed, 1u));
  if (secondary.status == 1u) {
    result.b.w = f32(staticTraceTriangles[secondary.triangle].sourceTriangleId);
    let p = indirectPoint(secondary); let n = indirectNormal(secondary, direction);
    let o = staticTraceOffset(p, n, staticTraceTriangles[secondary.triangle]);
    let skyDirection = indirectCosineDirection(n, seed, 3u);
    let shadow = traceStaticOcclusion(o, indirectFrame.lightDirection.xyz, 0.0, 1e30, indirectFrame.options.y);
    let sky = traceStaticOcclusion(o, skyDirection, 0.0, 1e30, indirectFrame.options.y);
    result.c = vec4f(p, secondary.distance); result.d = vec4f(indirectDiffuse(secondary), f32(secondary.nodeVisits));
    result.e = vec4f(o, f32(primary.status)); result.f = vec4f(skyDirection, indirectRandom(seed, 3u)); result.g = vec4f(indirectEmission(secondary), f32(shadow.status));
  }
  testResults[id.x] = result;
}
`;

interface Pipelines { readonly layouts: readonly GPUBindGroupLayout[]; readonly trace: GPUComputePipeline; readonly compose: GPUComputePipeline; readonly inspect: GPUComputePipeline; readonly queries: GPUComputePipeline; readonly environment: GPUComputePipeline; readonly depth: GPURenderPipeline; }
async function pipelines(device: GPUDevice): Promise<Pipelines> {
  const b = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
  const layouts = [device.createBindGroupLayout({ entries: [b(0, 'uniform'), { binding: 1, visibility: 4, texture: { sampleType: 'depth' } }, { binding: 2, visibility: 4, texture: { sampleType: 'float' } }, { binding: 3, visibility: 4, storageTexture: { access: 'write-only', format: 'rgba16float' } }] }),
    device.createBindGroupLayout({ entries: Array.from({ length: 6 }, (_, binding) => b(binding, binding < 4 ? 'read-only-storage' : 'storage')) }),
    device.createBindGroupLayout({ entries: [0, 2, 4].flatMap(binding => [{ binding, visibility: 4, texture: { sampleType: 'float' as const } }, { binding: binding + 1, visibility: 4, sampler: { type: 'filtering' as const } }]) }),
    device.createBindGroupLayout({ entries: [b(0, 'read-only-storage'), b(1, 'storage')] })];
  const layout = device.createPipelineLayout({ bindGroupLayouts: layouts });
  const module = device.createShaderModule({ label: 'Generated imported indirect production+diagnostics', code: importedIndirectShader + diagnosticsShader });
  const info = await bounded(module.getCompilationInfo(), 'Imported indirect shader compilation');
  require(!info.messages.some(message => message.type === 'error'), info.messages.map(message => message.message).join('\n'));
  const entries = ['traceImportedIndirect', 'composeImportedIndirect', 'inspectImportedSample', 'queryImportedTrace', 'queryImportedEnvironment'];
  const [trace, compose, inspect, queries, environment] = await Promise.all(entries.map(entryPoint => device.createComputePipelineAsync({ layout, compute: { module, entryPoint } })));
  const depthModule = device.createShaderModule({ code: `@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f { let p=vec2f(f32((i<<1u)&2u),f32(i&2u)); return vec4f(p*2.0-1.0,0.5,1.0); }` });
  const depth = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: depthModule, entryPoint: 'vertex' }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' } });
  return { layouts, trace: trace!, compose: compose!, inspect: inspect!, queries: queries!, environment: environment!, depth };
}

function makeFrame(width: number, height: number, options: { environment?: V3; light?: boolean; visits?: number; factor?: readonly [number, number, number, number]; emission?: V3 } = {}): ArrayBuffer {
  const data = new ArrayBuffer(288), f = new Float32Array(data), u = new Uint32Array(data);
  // Explicit-point estimator fixture, NOT a valid camera. Every pixel maps to
  // the same floor point; the real effect lifecycle below uses an invertible VP.
  f[9] = -2; f[13] = 1; f[15] = 1; f[30] = 0.5; f[31] = 1; f.set([0, 1, 0], 32);
  u.set([width, height, 0, width * height], 36); u.set([1, options.visits ?? 4096, 1337, 0], 40);
  f.set(importedIndirectFixture.directionToLight, 44); f.set(options.light === false ? [0, 0, 0] : [4, 4, 4], 48);
  f.set([options.environment ? 3 : 0, options.environment ? 1 : 0, 1, 0], 52); f.set(options.environment ?? [0, 0, 0], 56);
  f.set(options.factor ?? [1, 1, 1, 1], 60); f.set(options.emission ?? [0, 0, 0], 68); return data;
}
function textureBytes(resources: Resources, bytes: Uint8Array<ArrayBuffer>, width: number, height: number, srgb = false): GPUTexture {
  const texture = resources.texture(srgb ? 'rgba8unorm-srgb' : 'rgba8unorm', width, height, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
  resources.device.queue.writeTexture({ texture }, bytes, { bytesPerRow: width * 4 }, [width, height]); return texture;
}
function material(resources: Resources, base?: Uint8Array<ArrayBuffer>, width = 1, height = 1): ImportedIndirectMaterial {
  const sampler = resources.device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', mipmapFilter: 'nearest' });
  const baseTexture = textureBytes(resources, base ?? new Uint8Array([255, 255, 255, 255]), width, height, true);
  const mr = textureBytes(resources, new Uint8Array([255, 255, 0, 255]), 1, 1);
  const emission = textureBytes(resources, new Uint8Array([128, 64, 192, 255]), 1, 1, true);
  return { baseColorTexture: baseTexture.createView(), baseSampler: sampler, metallicRoughnessTexture: mr.createView(), metallicRoughnessSampler: sampler,
    emissiveTexture: emission.createView(), emissiveSampler: sampler, emissiveFactor: [0, 0, 0], emissiveStrength: 1,
    baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, doubleSided: false };
}
interface Context { resources: Resources; width: number; height: number; source: ImportedIndirectSource; frame: GPUBuffer; states: GPUBuffer; counts: GPUBuffer; output: GPUTexture; direct: GPUTexture; depth: GPUTexture; queryResults: GPUBuffer; groups: readonly GPUBindGroup[]; material: ImportedIndirectMaterial; }
function context(device: GPUDevice, pipes: Pipelines, source: ImportedIndirectSource, width: number, height: number, frameData: ArrayBuffer, queryData?: ArrayBuffer,
  base?: Uint8Array<ArrayBuffer>, baseWidth = 1, baseHeight = 1): Context {
  const resources = new Resources(device);
  try {
    const frame = resources.buffer(288, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, frameData);
    const sourceBuffers = [source.nodes, source.triangles, source.vertices, source.indices].map(data => resources.buffer(data.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, data));
    const states = resources.buffer(width * height * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const counts = resources.buffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const output = resources.texture('rgba16float', width, height, GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING);
    const direct = resources.texture('rgba16float', width, height, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    const hdr = new Uint16Array(width * height * 4); for (let i = 0; i < width * height; i++) hdr.set([0x3000, 0x3400, 0x3800, 0x3a00], i * 4);
    device.queue.writeTexture({ texture: direct }, hdr, { bytesPerRow: width * 8 }, [width, height]);
    const depth = resources.texture('depth32float', width, height, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);
    const queryBytes = queryData ?? new ArrayBuffer(48);
    const rays = resources.buffer(queryBytes.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, queryBytes);
    const queryResults = resources.buffer(Math.max(width * height, queryBytes.byteLength / 48) * 128, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const m = material(resources, base, baseWidth, baseHeight);
    const groups = [device.createBindGroup({ layout: pipes.layouts[0]!, entries: [{ binding: 0, resource: { buffer: frame } }, { binding: 1, resource: depth.createView() }, { binding: 2, resource: direct.createView() }, { binding: 3, resource: output.createView() }] }),
      device.createBindGroup({ layout: pipes.layouts[1]!, entries: [...sourceBuffers, states, counts].map((buffer, binding) => ({ binding, resource: { buffer } })) }),
      device.createBindGroup({ layout: pipes.layouts[2]!, entries: [m.baseColorTexture, m.baseSampler, m.metallicRoughnessTexture, m.metallicRoughnessSampler, m.emissiveTexture, m.emissiveSampler].map((resource, binding) => ({ binding, resource })) }),
      device.createBindGroup({ layout: pipes.layouts[3]!, entries: [{ binding: 0, resource: { buffer: rays } }, { binding: 1, resource: { buffer: queryResults } }] })];
    return { resources, width, height, source, frame, states, counts, output, direct, depth, queryResults, groups, material: m };
  } catch (error) { resources.dispose(); throw error; }
}
function dispatch(encoder: GPUCommandEncoder, pipeline: GPUComputePipeline, groups: readonly GPUBindGroup[], x: number, y = 1): void {
  const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); groups.forEach((group, i) => pass.setBindGroup(i, group)); pass.dispatchWorkgroups(x, y); pass.end();
}
function writeDepth(encoder: GPUCommandEncoder, texture: GPUTexture, pipeline: GPURenderPipeline, clear = 0.5): void {
  const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: texture.createView(), depthClearValue: clear, depthLoadOp: 'clear', depthStoreOp: 'store' } });
  // Clear is enough for synthetic depth; draw .5 as a separate actual pipeline
  // path only when that is the intended value.
  if (clear === 0.5) { pass.setPipeline(pipeline); pass.draw(3); } pass.end();
}
async function readBuffer(device: GPUDevice, source: GPUBuffer): Promise<ArrayBuffer> {
  const buffer = device.createBuffer({ size: source.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try { const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(source, 0, buffer, 0, source.size); device.queue.submit([encoder.finish()]);
    await bounded(buffer.mapAsync(GPUMapMode.READ), 'GPU buffer readback'); const copy = buffer.getMappedRange().slice(0); buffer.unmap(); return copy;
  } finally { buffer.destroy(); }
}
function half(value: number): number { const sign = value & 0x8000 ? -1 : 1, exponent = value >> 10 & 31, mantissa = value & 1023; return sign * (exponent ? exponent === 31 ? mantissa ? NaN : Infinity : 2 ** (exponent - 15) * (1 + mantissa / 1024) : mantissa * 2 ** -24); }
async function readTexture(device: GPUDevice, source: GPUTexture, width: number, height: number): Promise<Float32Array<ArrayBuffer>> {
  const bytesPerRow = Math.ceil(width * 8 / 256) * 256, buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try { const encoder = device.createCommandEncoder(); encoder.copyTextureToBuffer({ texture: source }, { buffer, bytesPerRow }, [width, height]); device.queue.submit([encoder.finish()]);
    await bounded(buffer.mapAsync(GPUMapMode.READ), 'HDR texture readback'); const input = new Uint16Array(buffer.getMappedRange()), output = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width * 4; x++) output[y * width * 4 + x] = half(input[y * bytesPerRow / 2 + x]!);
    buffer.unmap(); return output;
  } finally { buffer.destroy(); }
}

/** Independent axis-aligned plane/rectangle classifier; no BVH, triangle
 * intersection, shader hash, cosine sampler, or production CPU oracle imports.
 */
function hitQuads(quads: readonly ReferenceQuad[], origin: V3, direction: V3): { quad: ReferenceQuad; distance: number; point: V3 } | null {
  let closest: { quad: ReferenceQuad; distance: number; point: V3 } | null = null;
  for (const quad of quads) {
    const denominator = dot(quad.normal, direction); if (denominator === 0) continue;
    const distance = dot(quad.normal, sub(quad.positions[0], origin)) / denominator;
    if (!(distance > 0) || (closest && distance >= closest.distance)) continue;
    const point: V3 = [origin[0] + direction[0] * distance, origin[1] + direction[1] * distance, origin[2] + direction[2] * distance];
    if ([0, 1, 2].some(axis => point[axis]! < Math.min(...quad.positions.map(p => p[axis]!)) - 1e-8 || point[axis]! > Math.max(...quad.positions.map(p => p[axis]!)) + 1e-8)) continue;
    closest = { quad, distance, point };
  }
  return closest;
}

interface BatchOptions { readonly name: string; readonly quads: readonly ReferenceQuad[]; readonly environment?: V3; readonly light?: boolean; readonly visits?: number; }
async function radiometricBatch(device: GPUDevice, pipes: Pipelines, options: BatchOptions) {
  const width = 128, height = 128, count = width * height;
  const c = context(device, pipes, sourceQuads(options.quads), width, height, makeFrame(width, height, options));
  try {
    const encoder = device.createCommandEncoder(); writeDepth(encoder, c.depth, pipes.depth);
    dispatch(encoder, pipes.trace, c.groups, count / 64); dispatch(encoder, pipes.inspect, c.groups, count / 64); dispatch(encoder, pipes.compose, c.groups, width / 8, height / 8);
    device.queue.submit([encoder.finish()]);
    const [stateBytes, countBytes, diagnosticBytes, output] = await Promise.all([readBuffer(device, c.states), readBuffer(device, c.counts), readBuffer(device, c.queryResults), readTexture(device, c.output, width, height)]);
    const states = new Float32Array(stateBytes), stateWords = new Uint32Array(stateBytes), counters = [...new Uint32Array(countBytes)], diagnostic = new Float32Array(diagnosticBytes);
    const sum = [0, 0, 0], expectedSum = [0, 0, 0], directionSum = [0, 0, 0];
    let maximumError = 0, sourceHits = 0, bounceWallHits = 0, primaryMisses = 0, secondarySkyMisses = 0;
    for (let pixel = 0; pixel < count; pixel++) {
      const s = pixel * 8, d = pixel * 32;
      if (options.visits === 1) {
        require(stateWords[s + 5] === 2 && stateWords[s + 3] === 0, 'Exhausted estimate was retained as a hit/miss sample.');
        for (let channel = 0; channel < 4; channel++) near(output[pixel * 4 + channel]!, [0.125, 0.25, 0.5, 0.75][channel]!, 0, 'Unknown query must preserve direct-only HDR');
        continue;
      }
      require(stateWords[s + 5] === 0 && stateWords[s + 3] === 1, `Unexpected estimate status/sample count at${pixel}: ${stateWords[s + 5]}/${stateWords[s + 3]}`);
      const direction = [...diagnostic.slice(d, d + 3)] as unknown as V3, origin = [...diagnostic.slice(d + 4, d + 7)] as unknown as V3;
      near(Math.hypot(...direction), 1, 2e-6, 'Generated primary unit direction'); require(direction[1] > 0, 'Primary hemisphere points into receiver.');
      near(direction[1], Math.sqrt(1 - diagnostic[d + 31]!), 2e-6, 'Primary cosine matches chosen sample probability');
      direction.forEach((value, axis) => { directionSum[axis]! += value; });
      near(origin[0], 0, 1e-7, 'Primary origin X'); near(origin[2], 0, 1e-7, 'Primary origin Z'); require(origin[1] > 0 && origin[1] < 1e-5, 'Primary geometric offset is not bounded/outward.');
      const hit = hitQuads(options.quads, origin, direction); const incoming = [0, 0, 0];
      if (!hit) {
        primaryMisses++; require(diagnostic[d + 3] === 0, 'GPU secondary hit disagrees with independent plane miss.');
        for (let channel = 0; channel < 3; channel++) incoming[channel] = options.environment?.[channel] ?? 0;
      } else {
        sourceHits++; require(diagnostic[d + 3] === 1, 'GPU secondary miss disagrees with independent plane hit.');
        if (hit.quad.name === 'bounce-wall') bounceWallHits++;
        const gpuPoint = [...diagnostic.slice(d + 8, d + 11)] as unknown as V3, secondaryOrigin = [...diagnostic.slice(d + 16, d + 19)] as unknown as V3;
        hit.point.forEach((value, axis) => near(gpuPoint[axis]!, value, 3e-6, 'Secondary geometric point'));
        const normal = dot(hit.quad.normal, direction) > 0 ? hit.quad.normal.map(v => -v) as unknown as V3 : hit.quad.normal;
        require(dot(sub(secondaryOrigin, gpuPoint), normal) > 0 && Math.hypot(...sub(secondaryOrigin, gpuPoint)) < 1e-5, 'Secondary origin is not geometric/outward.');
        hit.quad.color.forEach((value, channel) => near(diagnostic[d + 12 + channel]!, value, 2e-6, 'Secondary vertex-color albedo'));
        const sunVisible = !hitQuads(options.quads, secondaryOrigin, importedIndirectFixture.directionToLight);
        const cosine = Math.max(0, dot(normal, importedIndirectFixture.directionToLight));
        const skyDirection = [...diagnostic.slice(d + 20, d + 23)] as unknown as V3;
        near(Math.hypot(...skyDirection), 1, 2e-6, 'Generated secondary unit direction');
        near(dot(skyDirection, normal), Math.sqrt(1 - diagnostic[d + 23]!), 2e-6, 'Secondary cosine matches chosen sample probability');
        const skyVisible = !hitQuads(options.quads, secondaryOrigin, skyDirection);
        if (skyVisible) secondarySkyMisses++;
        for (let channel = 0; channel < 3; channel++) incoming[channel] = hit.quad.color[channel]! *
          ((options.light !== false && sunVisible ? 4 * cosine / Math.PI : 0) + (skyVisible ? options.environment?.[channel] ?? 0 : 0));
      }
      for (let channel = 0; channel < 3; channel++) {
        near(diagnostic[d + 28 + channel]!, 0.5, 1e-7, 'Primary albedo'); const expected = 0.5 * incoming[channel]!;
        maximumError = Math.max(maximumError, Math.abs(states[s + channel]! - expected));
        near(states[s + channel]!, expected, 5e-5, `${options.name} same-ray radiance`);
        near(output[pixel * 4 + channel]!, [0.125, 0.25, 0.5][channel]! + expected, 0.002, 'Direct plus indirect composition');
        sum[channel]! += states[s + channel]!; expectedSum[channel]! += expected;
      }
      near(output[pixel * 4 + 3]!, 0.75, 0, 'Sharp direct alpha preservation');
    }
    require(counters[0] === count, 'Attempt count differs from explicit point queries.');
    require(counters[2] === (options.visits === 1 ? count : 0) && counters[3] === 0 && counters[1] === (options.visits === 1 ? 0 : count), 'GPU completion/failure accounting differs.');
    const mean = sum.map(value => value / count), referenceMean = expectedSum.map(value => value / count);
    const meanDirection = directionSum.map(value => value / count);
    // Frozen before any GPU result: broad, deterministic distribution sanity,
    // not confidence intervals. These prevent a collapsed all-miss sampler from
    // passing otherwise-exact same-ray arithmetic without exercising a bounce.
    if (options.visits !== 1) [0, 2 / 3, 0].forEach((value, axis) => near(meanDirection[axis]!, value, 0.03, 'Cosine hemisphere distribution sanity'));
    let expectedHitProbability: number | undefined;
    if (options.name === 'offscreen-colored-wall' || options.name === 'aperture') {
      const wall = options.name === 'aperture' ? importedIndirectFixture.apertureWall : importedIndirectFixture.wall;
      expectedHitProbability = wallCosineProbability({ ...wall, yMin: wall.yMin - diagnostic[5]!, yMax: wall.yMax - diagnostic[5]! });
      near(bounceWallHits / count, expectedHitProbability, 0.02, 'Finite wall hit-fraction sanity');
      require(bounceWallHits > 0 && mean[0]! > 0, 'Colored offscreen source was not sampled.');
    }
    return { name: options.name, queryCount: count, counters, mean, sameRayReferenceMean: referenceMean, maximumSameRayError: maximumError, sourceHits, bounceWallHits, primaryMisses, secondarySkyMisses, meanDirection, expectedHitProbability,
      closedForm: options.name === 'offscreen-colored-wall' ? directWallBounceReference().mean : options.name === 'empty-constant-environment' ? [1, 2, 4] : undefined,
      closedFormGate: 'Same-ray agreement is authoritative; deterministic hash sequence is not assigned an IID confidence guarantee.' };
  } finally { c.resources.dispose(); }
}

interface Ray { origin: V3; direction: V3; tMin?: number; tMax?: number; visits?: number; mode?: number; expectedStatus: number; expectedSource?: number; expectedDistance?: number; expectedBarycentric?: readonly [number, number]; }
function rayBytes(rays: readonly Ray[]): ArrayBuffer {
  const bytes = new ArrayBuffer(rays.length * 48), f = new Float32Array(bytes), u = new Uint32Array(bytes);
  rays.forEach((r, i) => { f.set(r.origin, i * 12); f[i * 12 + 3] = r.tMin ?? 0; f.set(r.direction, i * 12 + 4); f[i * 12 + 7] = r.tMax ?? 100; u.set([r.visits ?? 4096, r.mode ?? 0], i * 12 + 8); }); return bytes;
}
async function traversal(device: GPUDevice, pipes: Pipelines) {
  const observations = [];
  const response = await fetch('/imported-static-bvh.json'); require(response.ok, 'Missing immutable static BVH fixture.');
  const fixture = await response.json() as { source: { vertices: number[]; indices: number[] }; packed: { nodesHex: string; trianglesHex: string }; rays: { name: string; origin: V3; direction: V3; tMin: number; tMax: number; expected: null | { sourceTriangleId: number; distance: number; barycentric: V3 } }[] };
  const hex = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(value.match(/../g)!, byte => parseInt(byte, 16));
  const fixedSource: ImportedIndirectSource = { nodes: hex(fixture.packed.nodesHex), triangles: hex(fixture.packed.trianglesHex), vertices: new Float32Array(fixture.source.vertices), indices: new Uint32Array(fixture.source.indices) };
  const fixedRays: Ray[] = fixture.rays.map(ray => ({ ...ray, expectedStatus: ray.expected ? 1 : 0 }));
  fixedRays.push({ ...fixedRays[0]!, visits: 1, expectedStatus: 2 });
  const fixed = context(device, pipes, fixedSource, 1, 1, makeFrame(1, 1), rayBytes(fixedRays));
  try {
    const encoder = device.createCommandEncoder(); dispatch(encoder, pipes.queries, fixed.groups, 1); device.queue.submit([encoder.finish()]);
    const result = new Float32Array(await readBuffer(device, fixed.queryResults));
    fixedRays.forEach((ray, i) => {
      require(result[i * 32] === ray.expectedStatus, `Immutable A traversal status ${i}`);
      const expected = fixture.rays[i]?.expected;
      if (expected) { near(result[i * 32 + 1]!, expected.sourceTriangleId, 0, 'Immutable source ID'); near(result[i * 32 + 2]!, expected.distance, 2e-6, 'Immutable distance');
        near(result[i * 32 + 4]!, expected.barycentric[1], 2e-6, 'Immutable barycentric1'); near(result[i * 32 + 5]!, expected.barycentric[2], 2e-6, 'Immutable barycentric2'); }
      else require(result[i * 32 + 1] === -1, 'Immutable miss/unknown retained source identity.');
    });
    observations.push({ fixture: 'immutable-A-seven-triangles', queries: fixedRays.length, results: Array.from({ length: fixedRays.length }, (_, i) => [...result.slice(i * 32, i * 32 + 8)]) });
  } finally { fixed.resources.dispose(); }
  for (const scale of [1, 1e-12]) {
    const triangles = Array.from({ length: 7 }, (_, i) => {
      const x = i === 6 ? 0 : i * 2, z = i === 6 ? -0.5 : 0;
      return { positions: [[x - 0.5, -0.5, z], [x + 0.5, -0.5, z], [x - 0.5, 0.5, z]].map(p => p.map(v => v * scale)) as unknown as ReferenceTriangle };
    });
    const rays: Ray[] = Array.from({ length: 6 }, (_, i) => ({ origin: [(i * 2 - 0.25) * scale, -0.125 * scale, 2 * scale], direction: [0, 0, -1], tMax: 4 * scale, expectedStatus: 1, expectedSource: i, expectedDistance: 2 * scale, expectedBarycentric: [0.25, 0.375] }));
    rays.push({ ...rays[0]!, visits: 1, expectedStatus: 2 }, { ...rays[0]!, visits: 0, expectedStatus: 2 }, { ...rays[0]!, tMax: scale, expectedStatus: 0 },
      { ...rays[0]!, origin: [100 * scale, 0, 2 * scale], expectedStatus: 0 }, { ...rays[0]!, direction: [0, 0, 0], expectedStatus: 3 },
      { ...rays[0]!, origin: [-0.25 * scale, -0.125 * scale, -2 * scale], direction: [0, 0, 1], mode: 2, expectedStatus: 0 });
    const c = context(device, pipes, packSource(triangles), 1, 1, makeFrame(1, 1), rayBytes(rays));
    try {
      const encoder = device.createCommandEncoder(); dispatch(encoder, pipes.queries, c.groups, Math.ceil(rays.length / 64)); device.queue.submit([encoder.finish()]);
      const result = new Float32Array(await readBuffer(device, c.queryResults));
      rays.forEach((ray, i) => { const offset = i * 32; require(result[offset] === ray.expectedStatus, `Traversal status ${i}/${scale}: ${result[offset]}`);
        if (ray.expectedStatus === 1) { require(result[offset + 1] === ray.expectedSource, 'Packed leaf order corrupted source triangle ID.'); near(result[offset + 2]!, ray.expectedDistance!, scale * 2e-6, 'Known triangle distance');
          near(result[offset + 4]!, ray.expectedBarycentric![0], 2e-6, 'Known triangle barycentricU'); near(result[offset + 5]!, ray.expectedBarycentric![1], 2e-6, 'Known triangle barycentricV'); }
        else require(result[offset + 1] === -1, 'Miss/unknown retained a provisional source triangle.');
      }); observations.push({ scale, triangles: 7, rays: rays.length, results: Array.from({ length: rays.length }, (_, i) => [...result.slice(i * 32, i * 32 + 8)]) });
    } finally { c.resources.dispose(); }
  }
  const w = importedIndirectBarycentricWitness, source = packSource([{ positions: w.positions, colors: w.colors, uv: w.uv }]);
  const c = context(device, pipes, source, 1, 1, makeFrame(1, 1, { factor: [...w.materialFactor, 1], emission: [2, 3, 4] }), rayBytes([{ origin: [0, 0, 0], direction: unit(w.point), expectedStatus: 1 }]),
    new Uint8Array([255, 0, 0, 255, 128, 64, 192, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]), 3, 2);
  try {
    const encoder = device.createCommandEncoder(); dispatch(encoder, pipes.queries, c.groups, 1); device.queue.submit([encoder.finish()]); const result = new Float32Array(await readBuffer(device, c.queryResults));
    require(result[0] === 1 && result[1] === 0, 'Barycentric material witness missed.'); near(result[4]!, 0.5, 2e-6, 'Original corner1 barycentric'); near(result[5]!, 0.25, 2e-6, 'Original corner2 barycentric');
    w.expectedAlbedo.forEach((value, channel) => near(result[8 + channel]!, value, 0.0003, 'Source UV/sRGB/linear vertex color/factor'));
    [0.21586050011389926 * 2, 0.05126945837404324 * 3, 0.5271151257058131 * 4].forEach((value, channel) => near(result[12 + channel]!, value, 0.003, 'Source emissive sRGB/factor'));
    observations.push({ sourceInterpolation: [...result.slice(0, 16)] });
  } finally { c.resources.dispose(); }
  return observations;
}

async function environmentQueries(device: GPUDevice, pipes: Pipelines) {
  const response = await fetch('/imported-indirect-environment.json'); require(response.ok, 'Missing immutable environment fixture.');
  const fixture = await response.json() as { sourceCommit: string; sourceSha256: string; samples: { preset: string; yaw: number; intensity: number; world: V3; expected: V3 }[] };
  require(fixture.samples.length === 144, 'Unexpected environment reference count.');
  const data = new ArrayBuffer(fixture.samples.length * 48), f = new Float32Array(data);
  fixture.samples.forEach((s, i) => { f.set(s.world, i * 12); f[i * 12 + 3] = s.preset === 'studio' ? 1 : 2; f.set([s.intensity, Math.cos(s.yaw), Math.sin(s.yaw)], i * 12 + 4); });
  const c = context(device, pipes, sourceQuads(createIndirectReferenceQuads({ wall: false })), 1, 1, makeFrame(1, 1), data);
  try {
    const encoder = device.createCommandEncoder(); dispatch(encoder, pipes.environment, c.groups, Math.ceil(fixture.samples.length / 64)); device.queue.submit([encoder.finish()]); const result = new Float32Array(await readBuffer(device, c.queryResults)); let maxError = 0;
    fixture.samples.forEach((sample, i) => sample.expected.forEach((value, channel) => { maxError = Math.max(maxError, Math.abs(result[i * 32 + channel]! - value)); near(result[i * 32 + channel]!, value, Math.max(2e-5, 2e-5 * value), 'Immutable incident environment radiance'); }));
    return { queries: fixture.samples.length, sourceCommit: fixture.sourceCommit, sourceSha256: fixture.sourceSha256, maxError, absoluteRelativeTolerance: 2e-5 };
  } finally { c.resources.dispose(); }
}

async function effectLifecycle(device: GPUDevice, pipes: Pipelines) {
  const resources = new Resources(device); let effect: ImportedIndirectEffect | undefined;
  try {
    const source = sourceQuads(createIndirectReferenceQuads({ wall: false })); const m = material(resources);
    // Linear source color makes exact orthographic X reconstruction observable;
    // a constant floor could hide eye-origin perspective-like ray mistakes.
    for (let vertex = 0; vertex < source.vertices.length; vertex += 16) source.vertices[vertex + 12] = (source.vertices[vertex]! + 1) / 2;
    effect = await ImportedIndirectEffect.create(device, { source, material: m, lighting: { directionToLight: [0, 1, 0], color: [1, 1, 1], intensity: 0 }, environment: { mode: 'constant', intensity: 1, rotationRadians: 0, constantRadiance: [2, 4, 8] }, options: { maxPixels: 4, pixelBatch: 4, maxSamples: 2, maxVisits: 4096, seed: 1337 } });
    const sourceBytes = source.nodes.byteLength + source.triangles.byteLength + source.vertices.byteLength + source.indices.byteLength;
    require(effect.initialUploadBytes === sourceBytes && effect.gpuBufferBytes === sourceBytes + 288 + 16, 'Initial effect allocation/upload accounting differs.');
    // Valid orthographic camera at[0,1,0], looking down-Y with camera up−Z.
    // WebGPU ZO near0/far2; the receiver plane has exact depth.5.
    let camera: CameraFrame = { eye: [0, 1, 0], far: 2, orthographic: true, view: new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, -1, 1]),
      viewProjection: new Float32Array([1, 0, 0, 0, 0, 0, -0.5, 0, 0, -1, 0, 0, 0, 0, 0.5, 1]) };
    const observations = [];
    const encode = (width: number, height: number, submit: boolean) => {
      const depth = resources.texture('depth32float', width, height, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);
      const direct = resources.texture('rgba16float', width, height, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
      const values = new Uint16Array(width * height * 4); for (let i = 0; i < width * height; i++) values.set([0x3000, 0x3400, 0x3800, 0x3a00], i * 4);
      device.queue.writeTexture({ texture: direct }, values, { bytesPerRow: width * 8 }, [width, height]);
      const encoder = device.createCommandEncoder(); writeDepth(encoder, depth, pipes.depth); effect!.prepare(encoder, camera, width, height, 0, {});
      const view = direct.createView(); const result = effect!.compose(encoder, { depth: depth.createView(), hdr: view, normal: view, motion: view, material: view }, camera, width, height, 0, { temporal: false }, {});
      require(result.dispatchCalls === 2 && result.uploadBytes === 288, 'Effect pass/upload accounting differs.');
      if (submit) { device.queue.submit([encoder.finish()]); effect!.submitted(); } else { effect!.cancelFrame(); }
      return result;
    };
    encode(1, 1, true); const first = await bounded(effect.readProgress(), 'Effect progress'); observations.push(first);
    require(first.revision === 1 && first.submittedFrames === 1 && first.completed === 1 && first.exhausted === 0 && first.invalid === 0, 'First valid-camera sample was not committed.');
    const pixel = await readTexture(device, effect.outputTexture!, 1, 1); [1.125, 2.25, 4.5, 0.75].forEach((v, i) => near(pixel[i]!, v, 0.002, 'Valid-camera effect sky composition'));
    encode(1, 1, false); require(effect.progress.revision === 1 && effect.progress.submittedFrames === 1 && effect.progress.pendingReset, 'Cancelled effect frame advanced revision or samples.');
    encode(1, 1, true); const reset = await bounded(effect.readProgress(), 'Post-cancel progress'); require(reset.revision === 2 && reset.completed === 1, 'Cancelled accumulation did not restart cleanly.'); observations.push(reset);
    effect.reset(); encode(2, 2, false); require(effect.progress.width === 1 && effect.progress.height === 1 && Number(effect.progress.revision) === 2, 'Cancelled resize published dimensions/revision.');
    encode(1, 1, true); require(Number(effect.progress.revision) === 3, 'Resize cancellation was not repaired by next reset.');
    encode(2, 2, true); const resized = await bounded(effect.readProgress(), 'Resized progress'); observations.push(resized);
    require(resized.width === 2 && resized.height === 2 && resized.completed === 4 && resized.revision === 4, 'Resize did not reset all pixel samples.');
    const resizedPixels = await readTexture(device, effect.outputTexture!, 2, 2);
    for (let i = 0; i < 4; i++) [i % 2 ? 1.625 : 0.625, 2.25, 4.5, 0.75].forEach((value, channel) => near(resizedPixels[i * 4 + channel]!, value, 0.002, 'Orthographic parallel-ray source color'));
    require(effect.gpuTextureBytes === 32 && effect.gpuBufferBytes === sourceBytes + 288 + 16 + 4 * 32, 'Resized effect allocations leaked old state or textures.');
    effect.updateLighting({ directionToLight: [0, 1, 0], color: [1, 1, 1], intensity: 0 }, { mode: 'off', intensity: 0, rotationRadians: 0 }); encode(1, 1, true);
    const off = await readTexture(device, effect.outputTexture!, 1, 1); [0.125, 0.25, 0.5, 0.75].forEach((v, i) => near(off[i]!, v, 0, 'All illumination off preserves sharp HDR'));
    effect.setEnabled(false); require(!effect.active, 'Disabled effect remains active.'); effect.setEnabled(true); require(effect.progress.pendingReset, 'Reenabled effect reused old state.');
    effect.dispose(); require(Number(effect.gpuBufferBytes) === 0 && Number(effect.gpuTextureBytes) === 0 && !effect.outputTexture, 'Disposed effect retains owned allocations.');
    // Borrowed textures still usable after effect disposal: an actual compute
    // read through the new effect is a stronger witness than checking handles.
    const replacement = await ImportedIndirectEffect.create(device, { source, material: m, lighting: { directionToLight: [0, 1, 0], color: [1, 1, 1], intensity: 0 }, environment: { mode: 'off', intensity: 0, rotationRadians: 0 }, options: { maxPixels: 4 } });
    effect = replacement; encode(1, 1, true); await bounded(device.queue.onSubmittedWorkDone(), 'Borrowed material reuse'); replacement.dispose();
    // Eye is above an opaque front-facing surface, but the near plane clips it.
    // Its nearest visible receiver remains the floor at depth.5. Eye-origin
    // tracing would hit the clipped surface and fail the raster-depth match.
    const clippedSource = sourceQuads([...createIndirectReferenceQuads({ wall: false }), { name: 'before-near-plane', positions: [[-1, 1.5, -1], [-1, 1.5, 1], [1, 1.5, 1], [1, 1.5, -1]], normal: [0, 1, 0], color: [0, 0, 0] }]);
    camera = { ...camera, eye: [0, 2, 0], far: 3, view: new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, -2, 1]) };
    effect = await ImportedIndirectEffect.create(device, { source: clippedSource, material: m, lighting: { directionToLight: [0, 1, 0], color: [1, 1, 1], intensity: 0 }, environment: { mode: 'off', intensity: 0, rotationRadians: 0 }, options: { maxPixels: 4 } });
    encode(1, 1, true); const clipped = await bounded(effect.readProgress(), 'Near-plane clipping progress');
    require(clipped.completed === 1 && clipped.invalid === 0 && clipped.exhausted === 0, 'Clipped pre-near geometry became the GI receiver.'); observations.push(clipped); effect.dispose();
    return { observations, firstPixel: [...pixel], resizedPixels: [...resizedPixels], lightsOffPixel: [...off], disposedBufferBytes: replacement.gpuBufferBytes, disposedTextureBytes: replacement.gpuTextureBytes, nearPlaneExcludedGeometry: true };
  } finally { effect?.dispose(); resources.dispose(); }
}

export async function validateImportedIndirect() {
  require(navigator.gpu, 'WebGPU is unavailable.'); const adapter = await navigator.gpu.requestAdapter(); require(adapter, 'WebGPU adapter unavailable.');
  require(adapter.limits.maxStorageBuffersPerShaderStage >= 8 && adapter.limits.maxBindGroups >= 4, 'Diagnostic harness needs eight storage buffers and four bind groups.');
  const device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 8, maxBindGroups: 4 } });
  const errors: string[] = []; let expectedLoss = false;
  const listener = (event: GPUUncapturedErrorEvent) => errors.push(event.error.message); device.addEventListener('uncapturederror', listener);
  void device.lost.then(info => { if (!expectedLoss) errors.push(`Device lost: ${info.reason} ${info.message}`); });
  device.pushErrorScope('validation'); device.pushErrorScope('out-of-memory'); device.pushErrorScope('internal');
  try {
    const pipes = await pipelines(device), trace = await traversal(device, pipes), environment = await environmentQueries(device, pipes);
    const batches = [];
    for (const options of [
      { name: 'offscreen-colored-wall', quads: createIndirectReferenceQuads() },
      { name: 'aperture', quads: createIndirectReferenceQuads({ opening: 'aperture' }) },
      { name: 'closed-opening', quads: createIndirectReferenceQuads({ opening: 'closed' }) },
      { name: 'secondary-sun-blocked', quads: createIndirectReferenceQuads({ sunBlocked: true }) },
      { name: 'lights-off', quads: createIndirectReferenceQuads(), light: false },
      { name: 'empty-constant-environment', quads: createIndirectReferenceQuads({ wall: false }), light: false, environment: [2, 4, 8] as V3 },
      { name: 'primary-and-secondary-environment', quads: createIndirectReferenceQuads(), light: false, environment: [2, 4, 8] as V3 },
      { name: 'closed-black-enclosure', quads: createBlackEnclosureReferenceQuads(), light: false, environment: [2, 4, 8] as V3 },
      { name: 'exhausted-not-sky', quads: createIndirectReferenceQuads({ opening: 'aperture' }), visits: 1, environment: [2, 4, 8] as V3 },
    ] satisfies BatchOptions[]) batches.push(await radiometricBatch(device, pipes, options));
    const open = batches.find(batch => batch.name === 'offscreen-colored-wall')!, aperture = batches.find(batch => batch.name === 'aperture')!, closed = batches.find(batch => batch.name === 'closed-opening')!;
    require(open.mean[0]! > aperture.mean[0]! && aperture.mean[0]! > 0 && closed.mean.every(value => value === 0), 'Open/aperture/closed source visibility did not change indirect energy.');
    const lifecycle = await effectLifecycle(device, pipes); await bounded(device.queue.onSubmittedWorkDone(), 'Final diagnostic fence');
    for (let i = 0; i < 3; i++) { const error = await bounded(device.popErrorScope(), 'Diagnostic error scope'); if (error) errors.push(error.message); }
    require(errors.length === 0, errors.join('\n'));
    return { status: 'passed', performanceEvidence: false, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter },
      trace, environment, batches, lifecycle, errors,
      tolerances: { sameRayLinearRadiance: 5e-5, composedHalfFloat: 0.002, materialSrgb: 0.0003, emissionSrgb: 0.003, geometryPoint: 3e-6, unitDirection: 2e-6 },
      distributionSanity: { frozenBeforeGpu: true, interpretation: 'Broad deterministic non-vacuity bands, not IID confidence bounds.', meanDirectionAbsoluteBand: 0.03, wallHitProbabilityAbsoluteBand: 0.02 },
      limitations: ['Generated static one-material OPAQUE geometry only. No imported assets, performance, all-scene, or visual-quality claim.',
        'Radiometric batches use singular matrices to map every synthetic pixel to the same explicit point; they test unchanged production estimator WGSL, not camera reconstruction.',
        'The separate effect case uses a valid orthographic camera and exact synthetic raster depth. It does not replace end-to-end imported raster validation.',
        'Same-ray CPU rectangle classification is the numeric oracle. Closed-form means are reported without assigning an IID confidence guarantee to the fixed shader hash sequence.',
        'The tiny BVH packer is independent test data; production cooker/worker integration is outside this harness.'],
      fixture: { wallProbability: wallCosineProbability(importedIndirectFixture.wall), sourceBarycentric: importedIndirectBarycentricWitness, geometry: 'generated-independent-axis-aligned-quads' } };
  } finally { expectedLoss = true; device.removeEventListener('uncapturederror', listener); device.destroy(); }
}
