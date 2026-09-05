import { StrataError } from '../errors.js';
import type { StaticBvhResult } from '../internal/protocol.js';
import type { ImportedAsset } from './imported-types.js';
import { estimateStaticBvhWorkingBytes, staticBvhLimits, staticBvhNodeCapacity } from './static-trace-format.js';

export interface StaticTraceDeviceLimits { readonly maxBufferSize: number; readonly maxStorageBufferBindingSize: number }
export interface StaticTracePreparationOptions {
  readonly maxWorkingBytes?: number;
  /** Requested CPU payload estimate, including the retained input asset and WASM growth allowance. */
  readonly maxPeakCpuBytes?: number;
  /** Pass CpuRuntime.info.memoryBytes when reusing an initialized worker. */
  readonly retainedWasmBytes?: number;
  /** Other retained scene/job CPU buffers, excluding this asset and the WASM heap. */
  readonly additionalResidentCpuBytes?: number;
  readonly signal?: AbortSignal;
}
export interface StaticTracePreflight {
  /** The one used asset material; packed triangle material zero maps to this index. */
  readonly sourceMaterialIndex: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly maxNodeCount: number;
  readonly vertexBytes: number;
  readonly indexBytes: number;
  readonly nodeBytes: number;
  readonly triangleBytes: number;
  readonly workingBytes: number;
  readonly maxWorkingBytes: number;
  readonly callerBytes: number;
  readonly preparedBytes: number;
  readonly workerInputBytes: number;
  readonly resultBytes: number;
  readonly wasmGrowthAllowanceBytes: number;
  readonly validationBytes: number;
  readonly estimatedPeakCpuBytes: number;
  readonly additionalResidentCpuBytes: number;
  readonly traceGpuBytes: number;
}
export interface PreparedImportedStaticTrace extends StaticTracePreflight {
  /** Indexed 64-byte records, retaining source normal, UV0, tangent and color. */
  readonly vertices: Float32Array<ArrayBuffer>;
  /** Original source order; packed triangle IDs address triplets in this array. */
  readonly indices: Uint32Array<ArrayBuffer>;
  readonly positions: Float32Array<ArrayBuffer>;
  /** One start per primitive, followed by the final triangle count. */
  readonly primitiveTriangleOffsets: Uint32Array<ArrayBuffer>;
}

function invalid(message: string): never { throw new StrataError('INVALID_OPTIONS', `Invalid static trace source: ${message}`); }
function unsupported(message: string): never { throw new StrataError('UNSUPPORTED_FEATURE', `Static imported tracing: ${message}`); }
function limited(message: string): never { throw new StrataError('UNSUPPORTED_LIMIT', `Static imported tracing: ${message}`); }
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StrataError('SCENE_LOAD_ABORTED', 'Static trace preparation was cancelled.', { cause: signal.reason });
}
const taskYield = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
const chunkSize = 16_384;
const mib = 1024 * 1024;

function checkpoint(signal?: AbortSignal): () => Promise<void> | undefined {
  let deadline = performance.now() + 8, chunks = 0;
  return () => {
    checkAbort(signal);
    if (++chunks < 32 && performance.now() < deadline) return;
    return taskYield().then(() => { checkAbort(signal); chunks = 0; deadline = performance.now() + 8; });
  };
}

// Products of binary32 coordinates are exact in binary64. Sum their expansion
// before rounding, so a tiny nonzero source area survives cancellation.
function determinantComponent(p0a: number, p0b: number, p1a: number, p1b: number, p2a: number, p2b: number,
  scratch: Float64Array<ArrayBuffer>): number {
  let length = 0;
  for (let product = 0; product < 6; product++) {
    let q: number;
    switch (product) {
      case 0: q = p1a * p2b; break;
      case 1: q = -p1a * p0b; break;
      case 2: q = -p0a * p2b; break;
      case 3: q = -p1b * p2a; break;
      case 4: q = p1b * p0a; break;
      default: q = p0b * p2a;
    }
    let nextLength = 0;
    for (let index = 0; index < length; index++) {
      const e = scratch[index]!;
      const sum = q + e, b = sum - q;
      const error = (q - (sum - b)) + (e - b);
      if (error) scratch[nextLength++] = error;
      q = sum;
    }
    scratch[nextLength++] = q; length = nextLength;
  }
  let sum = 0;
  for (let index = 0; index < length; index++) sum += scratch[index]!;
  return sum;
}

/** Cheap structural/device/memory eligibility. Dense validation runs in cancellable chunks. */
export function preflightImportedStaticTrace(asset: ImportedAsset, limits: StaticTraceDeviceLimits,
  options: StaticTracePreparationOptions = {}): StaticTracePreflight {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || (options.signal !== undefined && (!options.signal || typeof options.signal.aborted !== 'boolean'))) invalid('invalid preparation options.');
  checkAbort(options.signal);
  if (!limits || ![limits.maxBufferSize, limits.maxStorageBufferBindingSize].every(v => Number.isSafeInteger(v) && v > 0)) invalid('invalid device buffer limits.');
  if (!asset || asset.version !== 1 || !Array.isArray(asset.primitives) || !asset.primitives.length
    || asset.primitives.length > 65_536 || !Array.isArray(asset.materials) || !Array.isArray(asset.clips) || !Array.isArray(asset.images)) invalid('invalid asset structure.');
  if (asset.rig !== undefined || asset.clips.length || asset.primitives.some(p => p?.deformation !== undefined)) unsupported('only immutable static geometry without a rig, clips or deformation is supported.');
  let sourceMaterialIndex = -1;
  let vertexCount = 0, triangleCount = 0;
  const callerBuffers = new Set<ArrayBuffer>();
  for (const primitive of asset.primitives) {
    if (!primitive || !Number.isInteger(primitive.material) || primitive.material < 0 || primitive.material >= asset.materials.length
      || !(primitive.vertices instanceof Float32Array)
      || !(primitive.vertices.buffer instanceof ArrayBuffer) || !primitive.vertices.length || primitive.vertices.length % 16
      || !(primitive.indices instanceof Uint32Array) || !(primitive.indices.buffer instanceof ArrayBuffer)
      || !primitive.indices.length || primitive.indices.length % 3) invalid('invalid indexed primitive buffers or material.');
    if (sourceMaterialIndex !== -1 && primitive.material !== sourceMaterialIndex) unsupported('the initial tracing contract requires one used material.');
    sourceMaterialIndex = primitive.material;
    vertexCount += primitive.vertices.length / 16;
    triangleCount += primitive.indices.length / 3;
    callerBuffers.add(primitive.vertices.buffer); callerBuffers.add(primitive.indices.buffer);
  }
  const material = asset.materials[sourceMaterialIndex];
  if (!material || material.alphaMode !== 'OPAQUE' || material.unlit === true) unsupported('the initial tracing contract requires a lit OPAQUE material.');
  for (const image of asset.images) {
    if (!image || !(image.bytes instanceof Uint8Array) || !(image.bytes.buffer instanceof ArrayBuffer)) invalid('invalid retained image data.');
    callerBuffers.add(image.bytes.buffer);
  }
  if (vertexCount < 3 || vertexCount > staticBvhLimits.maxVertices || triangleCount > staticBvhLimits.maxTriangles) limited('source vertex or triangle count exceeds the static job capacity.');
  const maxWorkingBytes = options.maxWorkingBytes ?? staticBvhLimits.defaultWorkingBytes;
  const maxPeakCpuBytes = options.maxPeakCpuBytes ?? staticBvhLimits.defaultPeakCpuBytes;
  const retainedWasmBytes = options.retainedWasmBytes ?? 0;
  const additionalResidentCpuBytes = options.additionalResidentCpuBytes ?? 0;
  if (!Number.isSafeInteger(maxWorkingBytes) || maxWorkingBytes < 1 || maxWorkingBytes > staticBvhLimits.maxWorkingBytes
    || !Number.isSafeInteger(maxPeakCpuBytes) || maxPeakCpuBytes < 1 || maxPeakCpuBytes > 2 ** 31
    || !Number.isSafeInteger(retainedWasmBytes) || retainedWasmBytes < 0 || retainedWasmBytes > 2 ** 32
    || !Number.isSafeInteger(additionalResidentCpuBytes) || additionalResidentCpuBytes < 0 || additionalResidentCpuBytes > 2 ** 31) invalid('invalid CPU memory budget.');
  const maxNodeCount = staticBvhNodeCapacity(triangleCount);
  const vertexBytes = vertexCount * 64, indexBytes = triangleCount * 12;
  const nodeBytes = maxNodeCount * 32, triangleBytes = triangleCount * 64;
  for (const [label, bytes] of Object.entries({ vertices: vertexBytes, indices: indexBytes, nodes: nodeBytes, triangles: triangleBytes })) {
    if (bytes > limits.maxBufferSize || bytes > limits.maxStorageBufferBindingSize) limited(`${label} exceed the device's buffer binding limit.`);
  }
  const workingBytes = estimateStaticBvhWorkingBytes(vertexCount, triangleCount);
  if (workingBytes > maxWorkingBytes) limited('the Rust job reservation exceeds maxWorkingBytes.');
  let callerBytes = 0;
  for (const buffer of callerBuffers) callerBytes += buffer.byteLength;
  const preparedBytes = vertexBytes + indexBytes + vertexCount * 12 + (asset.primitives.length + 1) * 4;
  const workerInputBytes = vertexCount * 12 + indexBytes;
  const resultBytes = nodeBytes + triangleBytes;
  // Linear memory is retained after a job and allocators may grow it in larger chunks.
  // This is a conservative planning allowance, not an RSS or browser/driver bound.
  const wasmGrowthAllowanceBytes = Math.max(workingBytes * 2, retainedWasmBytes + workingBytes) + 16 * mib;
  const validationBytes = 2 * triangleCount + maxNodeCount;
  const estimatedPeakCpuBytes = callerBytes + preparedBytes + workerInputBytes + resultBytes + wasmGrowthAllowanceBytes + validationBytes + additionalResidentCpuBytes;
  if (!Number.isSafeInteger(estimatedPeakCpuBytes) || estimatedPeakCpuBytes > maxPeakCpuBytes) limited('estimated retained CPU payload and copy/heap allowance exceed maxPeakCpuBytes.');
  return { sourceMaterialIndex, vertexCount, triangleCount, maxNodeCount, vertexBytes, indexBytes, nodeBytes, triangleBytes,
    workingBytes, maxWorkingBytes, callerBytes, preparedBytes, workerInputBytes, resultBytes, wasmGrowthAllowanceBytes,
    validationBytes, estimatedPeakCpuBytes, additionalResidentCpuBytes, traceGpuBytes: vertexBytes + indexBytes + nodeBytes + triangleBytes };
}

/** Keeps caller buffers reusable. No source fetch, GPU creation or model normalization occurs here. */
export async function prepareImportedStaticTrace(asset: ImportedAsset, limits: StaticTraceDeviceLimits,
  options: StaticTracePreparationOptions = {}): Promise<PreparedImportedStaticTrace> {
  const plan = preflightImportedStaticTrace(asset, limits, options);
  // Give an immediately superseded request a cancellation point before copies.
  await taskYield();
  checkAbort(options.signal);
  let vertices: Float32Array<ArrayBuffer>, positions: Float32Array<ArrayBuffer>, indices: Uint32Array<ArrayBuffer>, primitiveTriangleOffsets: Uint32Array<ArrayBuffer>;
  try {
    vertices = new Float32Array(plan.vertexCount * 16); positions = new Float32Array(plan.vertexCount * 3);
    indices = new Uint32Array(plan.triangleCount * 3); primitiveTriangleOffsets = new Uint32Array(asset.primitives.length + 1);
  } catch (cause) { throw new StrataError('UNSUPPORTED_LIMIT', 'Static trace source allocation failed.', { cause }); }
  const pause = checkpoint(options.signal);
  let vertexBase = 0, indexBase = 0;
  for (let primitiveIndex = 0; primitiveIndex < asset.primitives.length; primitiveIndex++) {
    const primitive = asset.primitives[primitiveIndex]!;
    const count = primitive.vertices.length / 16;
    primitiveTriangleOffsets[primitiveIndex] = indexBase / 3;
    for (let start = 0; start < primitive.vertices.length; start += chunkSize) {
      checkAbort(options.signal);
      const end = Math.min(primitive.vertices.length, start + chunkSize);
      for (let i = start; i < end; i++) {
        const value = primitive.vertices[i]!;
        if (!Number.isFinite(value)) invalid('nonfinite vertex attribute.');
        vertices[vertexBase * 16 + i] = value;
        const component = i % 16;
        if (component < 3) {
          if (Math.abs(value) > 8192) invalid('position exceeds the finite normalized preview range.');
          positions[(vertexBase + Math.floor(i / 16)) * 3 + component] = value;
        }
      }
      const yielding = pause(); if (yielding) await yielding;
    }
    for (let start = 0; start < primitive.indices.length; start += chunkSize) {
      checkAbort(options.signal);
      const end = Math.min(primitive.indices.length, start + chunkSize);
      for (let i = start; i < end; i++) {
        const value = primitive.indices[i]!;
        if (value >= count) invalid('triangle index is outside its source primitive.');
        indices[indexBase + i] = value + vertexBase;
      }
      const yielding = pause(); if (yielding) await yielding;
    }
    vertexBase += count; indexBase += primitive.indices.length;
    // Even many small primitives cannot monopolize the host's task queue.
    if ((primitiveIndex + 1) % 64 === 0) { const yielding = pause(); if (yielding) await yielding; }
  }
  checkAbort(options.signal);
  primitiveTriangleOffsets[asset.primitives.length] = plan.triangleCount;
  return { ...plan, vertices, positions, indices, primitiveTriangleOffsets };
}

/** Validate worker results against the immutable prepared source before any GPU upload. */
export async function validateImportedStaticBvh(source: PreparedImportedStaticTrace, result: StaticBvhResult,
  signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  if (!result || result.vertexCount !== source.vertexCount || result.triangleCount !== source.triangleCount
    || !Number.isInteger(result.nodeCount) || result.nodeCount < 1 || result.nodeCount > source.maxNodeCount
    || !(result.nodes instanceof ArrayBuffer) || result.nodes.byteLength !== result.nodeCount * 32
    || !(result.triangles instanceof ArrayBuffer) || result.triangles.byteLength !== source.triangleBytes
    || !Number.isInteger(result.maxDepth) || result.maxDepth < 1 || result.maxDepth > staticBvhLimits.maxDepth
    || result.workingBytes !== source.workingBytes || !Number.isSafeInteger(result.workUnits) || result.workUnits < 1
    || !Number.isSafeInteger(result.wasmMemoryBytes) || result.wasmMemoryBytes < 1) invalid('invalid worker result metadata.');
  const triangles = new DataView(result.triangles), nodes = new DataView(result.nodes);
  const sourceSeen = new Uint8Array(source.triangleCount), leafSeen = new Uint8Array(source.triangleCount), nodeSeen = new Uint8Array(result.nodeCount);
  // Owned by this invocation, so concurrent validators may safely yield between chunks.
  const determinantScratch = new Float64Array(6);
  const pause = checkpoint(signal);
  for (let index = 0; index < source.triangleCount; index++) {
    if (index % 1024 === 0) { const yielding = pause(); if (yielding) await yielding; }
    const at = index * 64, id = triangles.getUint32(at + 44, true);
    if (id >= source.triangleCount || sourceSeen[id]) invalid('duplicated or invalid source triangle identity.');
    sourceSeen[id] = 1;
    if (triangles.getUint32(at + 12, true) !== 0 || triangles.getUint32(at + 28, true) !== source.indices[id * 3]
      || triangles.getUint32(at + 60, true) !== 0) invalid('invalid triangle material, vertex identity or padding.');
    for (let corner = 0; corner < 3; corner++) for (let axis = 0; axis < 3; axis++) {
      const expected = source.positions[source.indices[id * 3 + corner]! * 3 + axis]!;
      if (!Object.is(triangles.getFloat32(at + corner * 16 + axis * 4, true), expected)) invalid('packed triangle differs from its original source position.');
    }
    const p0x = triangles.getFloat32(at, true), p0y = triangles.getFloat32(at + 4, true), p0z = triangles.getFloat32(at + 8, true);
    const p1x = triangles.getFloat32(at + 16, true), p1y = triangles.getFloat32(at + 20, true), p1z = triangles.getFloat32(at + 24, true);
    const p2x = triangles.getFloat32(at + 32, true), p2y = triangles.getFloat32(at + 36, true), p2z = triangles.getFloat32(at + 40, true);
    const geometricX = determinantComponent(p0y, p0z, p1y, p1z, p2y, p2z, determinantScratch);
    const geometricY = determinantComponent(p0z, p0x, p1z, p1x, p2z, p2x, determinantScratch);
    const geometricZ = determinantComponent(p0x, p0y, p1x, p1y, p2x, p2y, determinantScratch);
    const normalX = triangles.getFloat32(at + 48, true), normalY = triangles.getFloat32(at + 52, true), normalZ = triangles.getFloat32(at + 56, true);
    const length = Math.hypot(geometricX, geometricY, geometricZ);
    if (!(length > 0) || !Number.isFinite(normalX) || !Number.isFinite(normalY) || !Number.isFinite(normalZ)
      || Math.abs(Math.hypot(normalX, normalY, normalZ) - 1) > 1e-5
      || (normalX * geometricX + normalY * geometricY + normalZ * geometricZ) / length < 0.99999) invalid('invalid geometric normal or degenerate source triangle.');
  }
  const stack: { id: number; depth: number }[] = [{ id: 0, depth: 1 }];
  let visits = 0, maxDepth = 0, covered = 0;
  while (stack.length) {
    if (visits % 1024 === 0) { const yielding = pause(); if (yielding) await yielding; }
    const { id, depth } = stack.pop()!;
    if (id >= result.nodeCount || nodeSeen[id] || depth > staticBvhLimits.maxDepth) invalid('invalid BVH topology.');
    nodeSeen[id] = 1; visits++; maxDepth = Math.max(maxDepth, depth);
    const at = id * 32, first = nodes.getUint32(at + 12, true), count = nodes.getUint32(at + 28, true);
    for (let axis = 0; axis < 3; axis++) {
      const min = nodes.getFloat32(at + axis * 4, true), max = nodes.getFloat32(at + 16 + axis * 4, true);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) invalid('invalid node bounds.');
    }
    if (count) {
      if (count > 4 || first > source.triangleCount - count) invalid('invalid leaf range.');
      for (let triangle = first; triangle < first + count; triangle++) {
        if (leafSeen[triangle]) invalid('overlapping leaf ranges.');
        leafSeen[triangle] = 1; covered++;
        for (let corner = 0; corner < 3; corner++) for (let axis = 0; axis < 3; axis++) {
          const value = triangles.getFloat32(triangle * 64 + corner * 16 + axis * 4, true);
          if (value < nodes.getFloat32(at + axis * 4, true) || value > nodes.getFloat32(at + 16 + axis * 4, true)) invalid('node bounds exclude a source vertex.');
        }
      }
    } else {
      if (first >= result.nodeCount - 1) invalid('invalid consecutive children.');
      for (const child of [first, first + 1]) {
        for (let axis = 0; axis < 3; axis++) {
          if (nodes.getFloat32(child * 32 + axis * 4, true) < nodes.getFloat32(at + axis * 4, true)
            || nodes.getFloat32(child * 32 + 16 + axis * 4, true) > nodes.getFloat32(at + 16 + axis * 4, true)) invalid('parent bounds exclude a child.');
        }
        stack.push({ id: child, depth: depth + 1 });
      }
    }
  }
  checkAbort(signal);
  if (visits !== result.nodeCount || covered !== source.triangleCount || maxDepth !== result.maxDepth) invalid('BVH has unreachable nodes, missing leaves or incorrect depth.');
}
