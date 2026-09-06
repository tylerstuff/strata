/**
 * Diagnostic full-maintenance timing control, never a published runtime entry.
 * Packing follows trace-data.ts; endpoint enclosure follows trace-updates.ts's
 * TwoSum/outward-f32 policy. Each changed target has ONE complete bounds pass.
 * No independent reference, BigInt, dirty maps or extra bounds repair runs here.
 */
import { StrataError } from '../../packages/core/src/errors.js';
import type { GiTraceUpdateTelemetry } from '../../packages/core/src/gi/gi-types.js';
import { triangulateGiScene } from '../../packages/core/src/gi/scene-data.js';
import type { GiSceneData, GiTriangle } from '../../packages/core/src/gi/scene-data.js';
import { giTraceLimits, validateGiTraceScene } from '../../packages/core/src/gi/trace-data.js';
import type { GiTraceData } from '../../packages/core/src/gi/trace-data.js';

const strides = [32, 64, 48, 32, 48] as const;
const buffersOf = (data: GiTraceData): readonly ArrayBuffer[] =>
  [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData];
function invalid(message: string): never { throw new StrataError('INVALID_OPTIONS', `Invalid full trace timing control: ${message}`); }

function validateShape(scene: GiSceneData, data: GiTraceData): void {
  if (!scene || !Array.isArray(scene.boxes) || !Array.isArray(scene.materials) || !scene.light
    || scene.boxes.length !== data.boxCount || scene.materials.length !== data.materialCount) invalid('fixed scene topology is required.');
  const vector = (value: unknown): boolean => Array.isArray(value) && value.length === 3
    && Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2]);
  for (const box of scene.boxes) if (!box || !vector(box.center) || !vector(box.halfSize)) invalid('invalid box vector.');
  for (const material of scene.materials) if (!material || !vector(material.albedo) || !vector(material.emission)) invalid('invalid material vector.');
  if (!vector(scene.light.direction) || !vector(scene.light.radiance)) invalid('invalid light vector.');
  validateGiTraceScene(scene);
}

/** Initialization-only topology checks; these temporary arrays are not retained. */
function validateData(data: GiTraceData, buffers: readonly ArrayBuffer[]): number {
  if (!Number.isInteger(data.nodeCount) || data.nodeCount < 1 || data.nodeCount > giTraceLimits.nodes
    || !Number.isInteger(data.triangleCount) || data.triangleCount !== data.boxCount * 12 + data.staticTriangles.length
    || data.triangleCount > giTraceLimits.triangles || data.triangleOrder.length !== data.triangleCount) invalid('inconsistent fixed counts.');
  const counts = [data.nodeCount, data.triangleCount, data.boxCount, data.materialCount, 1];
  for (let i = 0; i < 5; i++) if (buffers[i]!.byteLength !== counts[i]! * strides[i]!) invalid('inconsistent packed buffer length.');
  const sourceSeen = new Uint8Array(data.triangleCount), packedSeen = new Uint8Array(data.triangleCount);
  const parents = new Int32Array(data.nodeCount); parents.fill(-1);
  const triangles = new Uint32Array(data.triangleData), nodes = new Uint32Array(data.nodeData);
  for (let packed = 0; packed < data.triangleCount; packed++) {
    const source = data.triangleOrder[packed]!;
    if (!Number.isInteger(source) || source < 0 || source >= data.triangleCount || sourceSeen[source]
      || triangles[packed * 16 + 11] !== source) invalid('triangle order must preserve fixed source identities.');
    sourceSeen[source] = 1;
  }
  let leaves = 0;
  for (let id = 0; id < data.nodeCount; id++) {
    if (id !== 0 && parents[id] === -1) invalid('disconnected node.');
    let depth = 1;
    for (let parent = parents[id]!; parent !== -1; parent = parents[parent]!) {
      if (++depth >= giTraceLimits.stack) invalid('fixed topology exceeds the traversal depth bound.');
    }
    const first = nodes[id * 8 + 3]!, count = nodes[id * 8 + 7]!;
    if (count) {
      if (count > giTraceLimits.leafSize || first + count > data.triangleCount) invalid('invalid leaf interval.');
      for (let packed = first; packed < first + count; packed++) {
        if (packedSeen[packed]) invalid('overlapping leaves.'); packedSeen[packed] = 1;
      }
      leaves++;
    } else {
      if (first <= id || first + 1 >= data.nodeCount || parents[first] !== -1 || parents[first + 1] !== -1) invalid('invalid child topology.');
      parents[first] = id; parents[first + 1] = id;
    }
  }
  if (packedSeen.includes(0)) invalid('unreferenced packed triangle.');
  return leaves;
}

function snapshotScene(scene: GiSceneData, target: Float64Array): void {
  let at = 0;
  for (const box of scene.boxes) {
    for (let axis = 0; axis < 3; axis++) target[at++] = box.center[axis]!;
    for (let axis = 0; axis < 3; axis++) target[at++] = box.halfSize[axis]!;
    target[at++] = box.yaw; target[at++] = box.materialId;
  }
  for (const material of scene.materials) {
    for (let axis = 0; axis < 3; axis++) target[at++] = material.albedo[axis]!;
    target[at++] = material.roughness;
    for (let axis = 0; axis < 3; axis++) target[at++] = material.emission[axis]!;
    target[at++] = material.metallic ?? 0;
  }
  for (let axis = 0; axis < 3; axis++) target[at++] = scene.light.direction[axis]!;
  for (let axis = 0; axis < 3; axis++) target[at++] = scene.light.radiance[axis]!;
}

interface Cache {
  readonly buffers: readonly ArrayBuffer[];
  readonly words: readonly Uint32Array[];
  readonly staged: readonly ArrayBuffer[];
  readonly stagedWords: readonly Uint32Array[];
  readonly stagedFloats: readonly Float32Array[];
  readonly snapshot: Float64Array;
  readonly candidate: Float64Array;
  readonly changedBoxes: Uint8Array;
  readonly roundFloat: Float32Array;
  readonly roundWord: Uint32Array;
  readonly leafCount: number;
  readonly sourceBytes: number;
  readonly metadataBytes: number;
}

/** Same directed rounding and signed-zero bound convention as production. */
function outward(cache: Cache, hi: number, lo: number, upper: boolean): number {
  cache.roundFloat[0] = hi;
  const rounded = cache.roundFloat[0]!;
  const advance = upper ? rounded < hi || (rounded === hi && lo > 0) : rounded > hi || (rounded === hi && lo < 0);
  if (advance) {
    if (rounded === 0) cache.roundWord[0] = upper ? 1 : 0x8000_0001;
    else cache.roundWord[0] = cache.roundWord[0]! + ((rounded > 0) === upper ? 1 : -1);
  }
  return cache.roundFloat[0] === 0 ? 0 : cache.roundFloat[0]!;
}

function sourceTriangle(data: GiTraceData, dynamic: readonly GiTriangle[], source: number): GiTriangle {
  return source < dynamic.length ? dynamic[source]! : data.staticTriangles[source - dynamic.length]!;
}

/** Each leaf derives its members' bounds once, then each parent unions its children once. */
function refitAllBounds(data: GiTraceData, cache: Cache, dynamic: readonly GiTriangle[]): void {
  const nodes = cache.stagedWords[0]!, bounds = cache.stagedFloats[0]!, packed = cache.stagedFloats[1]!;
  for (let id = data.nodeCount - 1; id >= 0; id--) {
    const first = nodes[id * 8 + 3]!, count = nodes[id * 8 + 7]!;
    for (let axis = 0; axis < 3; axis++) {
      let minimum = Infinity, maximum = -Infinity;
      if (count) {
        for (let slot = first; slot < first + count; slot++) {
          const triangle = sourceTriangle(data, dynamic, data.triangleOrder[slot]!);
          minimum = Math.min(minimum, triangle.p0[axis]!, triangle.p1[axis]!, triangle.p2[axis]!);
          maximum = Math.max(maximum, triangle.p0[axis]!, triangle.p1[axis]!, triangle.p2[axis]!);
          const origin = packed[slot * 16 + axis]!;
          for (let edgeAt = 4; edgeAt <= 8; edgeAt += 4) {
            const edge = packed[slot * 16 + edgeAt + axis]!, hi = origin + edge;
            const split = hi - origin, lo = (origin - (hi - split)) + (edge - split);
            minimum = Math.min(minimum, outward(cache, hi, lo, false));
            maximum = Math.max(maximum, outward(cache, hi, lo, true));
          }
        }
      } else {
        minimum = Math.min(bounds[first * 8 + axis]!, bounds[(first + 1) * 8 + axis]!);
        maximum = Math.max(bounds[first * 8 + 4 + axis]!, bounds[(first + 1) * 8 + 4 + axis]!);
      }
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) invalid('non-finite prepared bounds.');
      bounds[id * 8 + axis] = minimum === 0 ? 0 : minimum;
      bounds[id * 8 + 4 + axis] = maximum === 0 ? 0 : maximum;
    }
  }
}

function packAll(data: GiTraceData, cache: Cache, scene: GiSceneData): void {
  const dynamic = triangulateGiScene(scene), triangleWords = cache.stagedWords[1]!, triangles = cache.stagedFloats[1]!;
  cache.changedBoxes.fill(0);
  for (let slot = 0; slot < data.triangleCount; slot++) {
    const source = data.triangleOrder[slot]!, triangle = sourceTriangle(data, dynamic, source), at = slot * 16;
    for (let axis = 0; axis < 3; axis++) {
      triangles[at + axis] = triangle.p0[axis]!;
      triangles[at + 4 + axis] = triangle.p1[axis]! - triangle.p0[axis]!;
      triangles[at + 8 + axis] = triangle.p2[axis]! - triangle.p0[axis]!;
      triangles[at + 12 + axis] = triangle.normal[axis]!;
    }
    triangleWords[at + 3] = triangle.materialId; triangleWords[at + 7] = triangle.boxId; triangleWords[at + 11] = source;
    if (source < dynamic.length) for (let word = 0; word < 16; word++) {
      if (triangleWords[at + word] !== cache.words[1]![at + word]) { cache.changedBoxes[triangle.boxId] = 1; break; }
    }
  }
  refitAllBounds(data, cache, dynamic);
  const boxes = cache.stagedFloats[2]!, boxWords = cache.stagedWords[2]!;
  for (let id = 0; id < data.boxCount; id++) {
    const box = scene.boxes[id]!, at = id * 12;
    for (let axis = 0; axis < 3; axis++) { boxes[at + axis] = box.center[axis]!; boxes[at + 4 + axis] = box.halfSize[axis]!; }
    boxWords[at + 3] = box.materialId; boxWords[at + 7] = box.id;
    boxes[at + 8] = Math.cos(box.yaw); boxes[at + 9] = Math.sin(box.yaw);
    for (let word = 0; word < 12; word++) if (boxWords[at + word] !== cache.words[2]![at + word]) { cache.changedBoxes[id] = 1; break; }
  }
  const materials = cache.stagedFloats[3]!;
  for (let id = 0; id < data.materialCount; id++) {
    const material = scene.materials[id]!, at = id * 8;
    for (let axis = 0; axis < 3; axis++) { materials[at + axis] = material.albedo[axis]!; materials[at + 4 + axis] = material.emission[axis]!; }
    materials[at + 3] = material.roughness; materials[at + 7] = material.metallic ?? 0;
  }
  const uniform = cache.stagedFloats[4]!, uniformWords = cache.stagedWords[4]!;
  for (let axis = 0; axis < 3; axis++) { uniform[axis] = scene.light.direction[axis]!; uniform[4 + axis] = scene.light.radiance[axis]!; }
  uniform[3] = giTraceLimits.epsilon; uniform[7] = giTraceLimits.maxDistance;
  uniformWords[8] = data.nodeCount; uniformWords[9] = data.triangleCount; uniformWords[10] = data.boxCount; uniformWords[11] = data.materialCount;
}

/** Full strategy with the production updater's source/queued-version lifecycle. */
export class GiTraceUpdater {
  private cache: Cache | undefined;
  private pending = false;
  private readonly counters = { updateCount: 0, queuedUpdateCount: 0, changedBoxCount: 0, regeneratedTriangleCount: 0,
    packedTriangleCount: 0, refitLeafCount: 0, refitAncestorCount: 0, attemptedWriteCalls: 0,
    queuedWriteCalls: 0, queuedUploadBytes: 0, fullBufferFallbackCount: 0 };

  constructor(readonly data: GiTraceData) {
    validateShape(data.scene, data);
    const buffers = buffersOf(data), leafCount = validateData(data, buffers), staged = buffers.map(buffer => buffer.slice(0));
    const snapshot = new Float64Array(data.boxCount * 8 + data.materialCount * 8 + 6), candidate = new Float64Array(snapshot.length);
    snapshotScene(data.scene, snapshot);
    const changedBoxes = new Uint8Array(data.boxCount), roundFloat = new Float32Array(1);
    const sourceBytes = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
    const cache: Cache = { buffers, words: buffers.map(buffer => new Uint32Array(buffer)), staged,
      stagedWords: staged.map(buffer => new Uint32Array(buffer)), stagedFloats: staged.map(buffer => new Float32Array(buffer)),
      snapshot, candidate, changedBoxes, roundFloat, roundWord: new Uint32Array(roundFloat.buffer), leafCount, sourceBytes,
      metadataBytes: sourceBytes + snapshot.byteLength + candidate.byteLength + changedBoxes.byteLength + roundFloat.byteLength };
    // Initial normalization uses existing packed triangles and stages node bounds
    // before the owner's five uploads. It creates no pending update/work counters.
    refitAllBounds(data, cache, triangulateGiScene(data.scene));
    cache.words[0]!.set(cache.stagedWords[0]!);
    this.cache = cache;
  }
  private live(): Cache {
    if (!this.cache) throw new StrataError('ENGINE_DISPOSED', 'The full trace performance control is disposed.');
    return this.cache;
  }
  update(scene: GiSceneData): void {
    const cache = this.live(); validateShape(scene, this.data); snapshotScene(scene, cache.candidate);
    let changed = false;
    for (let i = 0; i < cache.snapshot.length; i++) if (!Object.is(cache.snapshot[i], cache.candidate[i])) { changed = true; break; }
    if (!changed) { this.data.scene = scene; return; }
    packAll(this.data, cache, scene);
    // The entire next target is valid before canonical buffers/snapshot/counters
    // change. Staging is retained, not reallocated or copied from the old target.
    for (let i = 0; i < 5; i++) cache.words[i]!.set(cache.stagedWords[i]!);
    cache.snapshot.set(cache.candidate); this.data.scene = scene; this.pending = true;
    this.counters.updateCount++;
    for (const boxChanged of cache.changedBoxes) this.counters.changedBoxCount += boxChanged;
    this.counters.regeneratedTriangleCount += this.data.boxCount * 12;
    this.counters.packedTriangleCount += this.data.triangleCount;
    this.counters.refitLeafCount += cache.leafCount;
    this.counters.refitAncestorCount += this.data.nodeCount - cache.leafCount;
  }
  flush(queue: GPUQueue, buffers: readonly GPUBuffer[]): { uploadBytes: number; writeCalls: number } {
    const cache = this.live();
    if (buffers.length !== 5) invalid('expected five adequately sized GPU buffers.');
    for (let i = 0; i < 5; i++) if (!buffers[i] || buffers[i]!.size < cache.buffers[i]!.byteLength) invalid('expected five adequately sized GPU buffers.');
    let uploadBytes = 0, writeCalls = 0;
    if (this.pending) for (let i = 0; i < 5; i++) {
      const source = cache.buffers[i]!; this.counters.attemptedWriteCalls++;
      queue.writeBuffer(buffers[i]!, 0, source, 0, source.byteLength);
      this.counters.queuedWriteCalls++; this.counters.queuedUploadBytes += source.byteLength;
      uploadBytes += source.byteLength; writeCalls++;
    }
    this.pending = false; this.counters.queuedUpdateCount = this.counters.updateCount;
    return { uploadBytes, writeCalls };
  }
  get telemetry(): GiTraceUpdateTelemetry {
    return { ...this.counters, pendingRangeCount: this.pending ? 5 : 0, pendingUploadBytes: this.pending ? this.cache!.sourceBytes : 0,
      // Retained typed payload only: S+16*(8B+8M+6)+B+4. Existing source buffers,
      // JS/view headers and temporary dynamic triangles/vector objects are excluded.
      metadataBytes: this.cache?.metadataBytes ?? 0 };
  }
  dispose(): void { this.cache = undefined; this.pending = false; }
}
