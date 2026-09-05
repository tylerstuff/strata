import { StrataError } from '../errors.js';
import type { GiTraceUpdateTelemetry } from './gi-types.js';
import { triangulateGiBox } from './scene-data.js';
import type { GiBox, GiSceneData, GiTriangle } from './scene-data.js';
import { giTraceLimits, validateGiTraceScene } from './trace-data.js';
import type { GiTraceData } from './trace-data.js';

const rangeLimit = 32;
const missing = 0xffff_ffff;
const strides = [32, 64, 48, 32, 48] as const;
function invalid(message: string): never { throw new StrataError('INVALID_OPTIONS', `Invalid GI trace update: ${message}`); }

/** A bounded union of complete records. Failed writes never remove records from this union. */
class DirtyRecords {
  readonly marks: Uint8Array;
  readonly ids: Uint32Array;
  readonly ranges = new Uint32Array(rangeLimit * 2);
  count = 0;
  rangeCount = 0;
  uploadBytes = 0;
  fallback = false;
  private stale = false;
  constructor(readonly capacity: number, readonly stride: number) {
    this.marks = new Uint8Array(capacity); this.ids = new Uint32Array(capacity);
  }
  add(id: number): void {
    if (this.marks[id]) return;
    this.marks[id] = 1; this.ids[this.count++] = id; this.stale = true;
  }
  plan(): void {
    if (!this.stale) return;
    this.ids.subarray(0, this.count).sort();
    this.rangeCount = 0; this.uploadBytes = 0; this.fallback = false;
    for (let i = 0; i < this.count;) {
      const first = this.ids[i++]!; let end = first + 1;
      while (i < this.count && this.ids[i] === end) { i++; end++; }
      if (this.rangeCount === rangeLimit) {
        this.fallback = true; this.rangeCount = 1;
        this.ranges[0] = 0; this.ranges[1] = this.capacity * this.stride;
        this.uploadBytes = this.ranges[1]!; break;
      }
      this.ranges[this.rangeCount * 2] = first * this.stride;
      const bytes = (end - first) * this.stride;
      this.ranges[this.rangeCount * 2 + 1] = bytes;
      this.rangeCount++; this.uploadBytes += bytes;
    }
    this.stale = false;
  }
  clear(): void {
    for (let i = 0; i < this.count; i++) this.marks[this.ids[i]!] = 0;
    this.count = 0; this.rangeCount = 0; this.uploadBytes = 0; this.fallback = false; this.stale = false;
  }
  get byteLength(): number { return this.marks.byteLength + this.ids.byteLength + this.ranges.byteLength; }
}

interface Cache {
  readonly sourceToPacked: Uint32Array;
  readonly packedToLeaf: Uint32Array;
  readonly parents: Int32Array;
  readonly triangleBounds: Float32Array;
  readonly stagedTriangleBounds: Float32Array;
  readonly stagedNodeBounds: Float32Array;
  readonly nodeMarks: Uint8Array;
  readonly nodeIds: Uint32Array;
  readonly boxFlags: Uint8Array;
  readonly materialFlags: Uint8Array;
  readonly snapshot: Float64Array;
  readonly candidate: Float64Array;
  readonly staged: readonly ArrayBuffer[];
  readonly stagedWords: readonly Uint32Array[];
  readonly stagedFloats: readonly Float32Array[];
  readonly buffers: readonly ArrayBuffer[];
  readonly words: readonly Uint32Array[];
  readonly floats: readonly Float32Array[];
  readonly dirty: readonly DirtyRecords[];
  readonly roundFloat: Float32Array;
  readonly roundWord: Uint32Array;
  readonly metadataBytes: number;
  nodeWorkCount: number;
}

function validateShape(scene: GiSceneData, data: GiTraceData): void {
  if (!scene || !Array.isArray(scene.boxes) || !Array.isArray(scene.materials)
    || scene.boxes.length !== data.boxCount || scene.materials.length !== data.materialCount || !scene.light) invalid('fixed scene topology is required.');
  const vector = (v: unknown): boolean => Array.isArray(v) && v.length === 3
    && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
  for (let id = 0; id < scene.boxes.length; id++) {
    const box = scene.boxes[id];
    if (!box || !vector(box.center) || !vector(box.halfSize)) invalid('box vectors require three finite components.');
  }
  for (let id = 0; id < scene.materials.length; id++) {
    const material = scene.materials[id];
    if (!material || !vector(material.albedo) || !vector(material.emission)) invalid('material vectors require three finite components.');
  }
  if (!vector(scene.light.direction) || !vector(scene.light.radiance)) invalid('light vectors require three finite components.');
  validateGiTraceScene(scene);
}

function snapshotScene(scene: GiSceneData, into: Float64Array): void {
  let at = 0;
  for (const box of scene.boxes) {
    for (let axis = 0; axis < 3; axis++) into[at++] = box.center[axis]!;
    for (let axis = 0; axis < 3; axis++) into[at++] = box.halfSize[axis]!;
    into[at++] = box.yaw; into[at++] = box.materialId;
  }
  for (const material of scene.materials) {
    for (let axis = 0; axis < 3; axis++) into[at++] = material.albedo[axis]!;
    into[at++] = material.roughness;
    for (let axis = 0; axis < 3; axis++) into[at++] = material.emission[axis]!;
    into[at++] = material.metallic ?? 0;
  }
  for (let axis = 0; axis < 3; axis++) into[at++] = scene.light.direction[axis]!;
  for (let axis = 0; axis < 3; axis++) into[at++] = scene.light.radiance[axis]!;
}

function different(a: Float64Array, b: Float64Array, at: number, count: number): boolean {
  for (let i = at; i < at + count; i++) if (!Object.is(a[i], b[i])) return true;
  return false;
}

/** Directed f32 enclosure of hi+lo. TwoSum supplies lo when binary64 addition loses an endpoint bit. */
function outward(cache: Cache, hi: number, lo: number, upper: boolean): number {
  cache.roundFloat[0] = hi;
  const rounded = cache.roundFloat[0]!;
  const advance = upper ? rounded < hi || (rounded === hi && lo > 0) : rounded > hi || (rounded === hi && lo < 0);
  if (advance) {
    if (rounded === 0) cache.roundWord[0] = upper ? 1 : 0x8000_0001;
    else cache.roundWord[0] = cache.roundWord[0]! + ((rounded > 0) === upper ? 1 : -1);
  }
  // Bounds describe real intervals; canonicalize their exact zero, but never source/triangle words.
  return cache.roundFloat[0] === 0 ? 0 : cache.roundFloat[0]!;
}

function triangleBounds(cache: Cache, triangle: GiTriangle, packed: Float32Array, packedAt: number, target: Float32Array, at: number): void {
  for (let axis = 0; axis < 3; axis++) {
    let min = Math.min(triangle.p0[axis]!, triangle.p1[axis]!, triangle.p2[axis]!);
    let max = Math.max(triangle.p0[axis]!, triangle.p1[axis]!, triangle.p2[axis]!);
    const origin = packed[packedAt + axis]!;
    for (const edgeAt of [4, 8]) {
      const edge = packed[packedAt + edgeAt + axis]!;
      const hi = origin + edge;
      const split = hi - origin;
      const lo = (origin - (hi - split)) + (edge - split);
      min = Math.min(min, outward(cache, hi, lo, false));
      max = Math.max(max, outward(cache, hi, lo, true));
    }
    target[at + axis] = min === 0 ? 0 : min;
    target[at + 3 + axis] = max === 0 ? 0 : max;
  }
}

function packTriangle(cache: Cache, triangle: GiTriangle, packedId: number): void {
  const at = triangle.id * 16; const words = cache.stagedWords[1]!; const floats = cache.stagedFloats[1]!;
  // Preserve every reserved/source-identity byte from the original fixed record.
  for (let i = 0; i < 16; i++) words[at + i] = cache.words[1]![packedId * 16 + i]!;
  for (let axis = 0; axis < 3; axis++) {
    floats[at + axis] = triangle.p0[axis]!;
    floats[at + 4 + axis] = triangle.p1[axis]! - triangle.p0[axis]!;
    floats[at + 8 + axis] = triangle.p2[axis]! - triangle.p0[axis]!;
    floats[at + 12 + axis] = triangle.normal[axis]!;
  }
  words[at + 3] = triangle.materialId; words[at + 7] = triangle.boxId; words[at + 11] = triangle.id;
}

function stageNode(cache: Cache, id: number, dynamicCount: number): void {
  const first = cache.words[0]![id * 8 + 3]!; const count = cache.words[0]![id * 8 + 7]!;
  for (let axis = 0; axis < 3; axis++) {
    let min = Infinity; let max = -Infinity;
    if (count) {
      for (let packed = first; packed < first + count; packed++) {
        const source = cache.words[1]![packed * 16 + 11]!;
        const staged = source < dynamicCount && (cache.boxFlags[Math.floor(source / 12)]! & 1) !== 0;
        const bounds = staged ? cache.stagedTriangleBounds : cache.triangleBounds;
        const at = (staged ? source : packed) * 6;
        min = Math.min(min, bounds[at + axis]!); max = Math.max(max, bounds[at + 3 + axis]!);
      }
    } else {
      for (let child = first; child <= first + 1; child++) {
        const staged = cache.nodeMarks[child] !== 0;
        min = Math.min(min, staged ? cache.stagedNodeBounds[child * 6 + axis]! : cache.floats[0]![child * 8 + axis]!);
        max = Math.max(max, staged ? cache.stagedNodeBounds[child * 6 + 3 + axis]! : cache.floats[0]![child * 8 + 4 + axis]!);
      }
    }
    cache.stagedNodeBounds[id * 6 + axis] = min === 0 ? 0 : min;
    cache.stagedNodeBounds[id * 6 + 3 + axis] = max === 0 ? 0 : max;
  }
}

function commitNode(cache: Cache, id: number): boolean {
  let changed = false;
  for (let axis = 0; axis < 3; axis++) for (let side = 0; side < 2; side++) {
    const value = cache.stagedNodeBounds[id * 6 + side * 3 + axis]!;
    const at = id * 8 + side * 4 + axis;
    if (!Object.is(cache.floats[0]![at], value)) { cache.floats[0]![at] = value; changed = true; }
  }
  return changed;
}

function commitRecord(cache: Cache, buffer: number, sourceRecord: number, targetRecord: number): boolean {
  const stride = strides[buffer]! / 4; const source = cache.stagedWords[buffer]!; const target = cache.words[buffer]!;
  let changed = false;
  for (let word = 0; word < stride; word++) {
    const value = source[sourceRecord * stride + word]!;
    if (target[targetRecord * stride + word] !== value) { target[targetRecord * stride + word] = value; changed = true; }
  }
  if (changed) cache.dirty[buffer]!.add(targetRecord);
  return changed;
}

function makeCache(data: GiTraceData): Cache {
  validateShape(data.scene, data);
  const counts = [data.nodeCount, data.triangleCount, data.boxCount, data.materialCount, 1];
  const buffers = [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData];
  if (!Number.isInteger(data.nodeCount) || data.nodeCount < 1 || data.nodeCount > giTraceLimits.nodes
    || !Number.isInteger(data.triangleCount) || data.triangleCount !== data.boxCount * 12 + data.staticTriangles.length
    || data.triangleCount > giTraceLimits.triangles || data.triangleOrder.length !== data.triangleCount) invalid('inconsistent fixed counts.');
  for (let i = 0; i < buffers.length; i++) if (buffers[i]!.byteLength !== counts[i]! * strides[i]!) invalid('inconsistent buffer length.');
  const sourceToPacked = new Uint32Array(data.triangleCount); sourceToPacked.fill(missing);
  const packedToLeaf = new Uint32Array(data.triangleCount); packedToLeaf.fill(missing);
  const parents = new Int32Array(data.nodeCount); parents.fill(-1);
  const words = buffers.map(buffer => new Uint32Array(buffer)); const floats = buffers.map(buffer => new Float32Array(buffer));
  for (let packed = 0; packed < data.triangleCount; packed++) {
    const source = data.triangleOrder[packed]!;
    if (!Number.isInteger(source) || source < 0 || source >= data.triangleCount || sourceToPacked[source] !== missing
      || words[1]![packed * 16 + 11] !== source) invalid('triangle order must be a fixed permutation.');
    sourceToPacked[source] = packed;
  }
  for (let id = 0; id < data.nodeCount; id++) {
    if (id !== 0 && parents[id] === -1) invalid('disconnected node.');
    let depth = 1;
    for (let parent = parents[id]!; parent !== -1; parent = parents[parent]!) {
      if (++depth >= giTraceLimits.stack) invalid('fixed topology exceeds the traversal depth bound.');
    }
    const first = words[0]![id * 8 + 3]!; const count = words[0]![id * 8 + 7]!;
    if (!count) {
      if (first <= id || first + 1 >= data.nodeCount || parents[first] !== -1 || parents[first + 1] !== -1) invalid('invalid fixed child topology.');
      parents[first] = id; parents[first + 1] = id;
    } else {
      if (count > giTraceLimits.leafSize || first + count > data.triangleCount) invalid('invalid fixed leaf interval.');
      for (let packed = first; packed < first + count; packed++) {
        if (packedToLeaf[packed] !== missing) invalid('overlapping leaf intervals.');
        packedToLeaf[packed] = id;
      }
    }
  }
  if (packedToLeaf.includes(missing)) invalid('unreferenced packed triangle.');
  const dynamicCount = data.boxCount * 12;
  const snapshot = new Float64Array(data.boxCount * 8 + data.materialCount * 8 + 6);
  snapshotScene(data.scene, snapshot);
  const staged = [new ArrayBuffer(0), new ArrayBuffer(dynamicCount * 64), new ArrayBuffer(data.boxCount * 48),
    new ArrayBuffer(data.materialCount * 32), new ArrayBuffer(48)];
  const roundFloat = new Float32Array(1);
  const cache: Cache = {
    sourceToPacked, packedToLeaf, parents, snapshot, candidate: new Float64Array(snapshot.length),
    triangleBounds: new Float32Array(data.triangleCount * 6), stagedTriangleBounds: new Float32Array(dynamicCount * 6),
    stagedNodeBounds: new Float32Array(data.nodeCount * 6), nodeMarks: new Uint8Array(data.nodeCount), nodeIds: new Uint32Array(data.nodeCount),
    boxFlags: new Uint8Array(data.boxCount), materialFlags: new Uint8Array(data.materialCount),
    staged, stagedWords: staged.map(buffer => new Uint32Array(buffer)), stagedFloats: staged.map(buffer => new Float32Array(buffer)),
    buffers, words, floats, dirty: counts.map((count, i) => new DirtyRecords(count, strides[i]!)),
    roundFloat, roundWord: new Uint32Array(roundFloat.buffer), metadataBytes: 0, nodeWorkCount: 0,
  };
  for (const box of data.scene.boxes) for (const triangle of triangulateGiBox(box)) {
    const packed = sourceToPacked[triangle.id]!;
    triangleBounds(cache, triangle, floats[1]!, packed * 16, cache.triangleBounds, packed * 6);
  }
  for (const triangle of data.staticTriangles) {
    const packed = sourceToPacked[dynamicCount + triangle.id]!;
    triangleBounds(cache, triangle, floats[1]!, packed * 16, cache.triangleBounds, packed * 6);
  }
  // Stage the complete correction before publishing any node bounds. Topology words stay untouched.
  cache.nodeMarks.fill(1);
  for (let id = data.nodeCount - 1; id >= 0; id--) stageNode(cache, id, dynamicCount);
  for (let id = 0; id < data.nodeCount; id++) commitNode(cache, id);
  cache.nodeMarks.fill(0);
  const typed = [sourceToPacked, packedToLeaf, parents, snapshot, cache.candidate, cache.triangleBounds,
    cache.stagedTriangleBounds, cache.stagedNodeBounds, cache.nodeMarks, cache.nodeIds, cache.boxFlags, cache.materialFlags, roundFloat];
  // Counts retained typed payload only, excluding existing packed buffers, borrowed views and JS headers.
  return { ...cache, metadataBytes: typed.reduce((bytes, array) => bytes + array.byteLength, 0)
    + staged.reduce((bytes, buffer) => bytes + buffer.byteLength, 0) + cache.dirty.reduce((bytes, records) => bytes + records.byteLength, 0) };
}

/**
 * Fixed-topology maintenance with exclusive CPU ownership of data until dispose.
 * Construction corrects bounds before the owner's initial five uploads; initialization is not update work.
 * A successful flush queues the current target. Submission/cancellation does not roll those writes back.
 */
export class GiTraceUpdater {
  private cache: Cache | undefined;
  private readonly counters = { updateCount: 0, queuedUpdateCount: 0, changedBoxCount: 0, regeneratedTriangleCount: 0,
    packedTriangleCount: 0, refitLeafCount: 0, refitAncestorCount: 0, attemptedWriteCalls: 0,
    queuedWriteCalls: 0, queuedUploadBytes: 0, fullBufferFallbackCount: 0 };
  constructor(readonly data: GiTraceData) { this.cache = makeCache(data); }
  private live(): Cache {
    if (!this.cache) throw new StrataError('ENGINE_DISPOSED', 'The GI trace updater is disposed.');
    return this.cache;
  }
  update(scene: GiSceneData): void {
    const cache = this.live(); validateShape(scene, this.data); snapshotScene(scene, cache.candidate);
    const next = cache.candidate; const previous = cache.snapshot; const dynamicCount = this.data.boxCount * 12;
    cache.boxFlags.fill(0); cache.materialFlags.fill(0);
    let anyChange = false; let regenerated = 0; let packedCount = 0; let leaves = 0; let ancestors = 0;
    const materialStart = this.data.boxCount * 8; const lightStart = materialStart + this.data.materialCount * 8;
    for (let id = 0; id < this.data.boxCount; id++) {
      const geometry = different(next, previous, id * 8, 7);
      const material = !Object.is(next[id * 8 + 7], previous[id * 8 + 7]);
      cache.boxFlags[id] = (geometry ? 1 : 0) | (material ? 2 : 0); anyChange ||= geometry || material;
    }
    for (let id = 0; id < this.data.materialCount; id++) {
      cache.materialFlags[id] = different(next, previous, materialStart + id * 8, 8) ? 1 : 0;
      anyChange ||= cache.materialFlags[id] !== 0;
    }
    const lightChanged = different(next, previous, lightStart, 6); anyChange ||= lightChanged;
    if (!anyChange) { this.data.scene = scene; return; }
    try {
      for (let id = 0; id < this.data.boxCount; id++) {
        const flags = cache.boxFlags[id]!; if (!flags) continue;
        const at = id * 8;
        if (flags & 1) {
          const box: GiBox = { id, name: '', center: [next[at]!, next[at + 1]!, next[at + 2]!],
            halfSize: [next[at + 3]!, next[at + 4]!, next[at + 5]!], yaw: next[at + 6]!, materialId: next[at + 7]! };
          for (const triangle of triangulateGiBox(box)) {
            const packed = cache.sourceToPacked[triangle.id]!; packTriangle(cache, triangle, packed);
            triangleBounds(cache, triangle, cache.stagedFloats[1]!, triangle.id * 16, cache.stagedTriangleBounds, triangle.id * 6);
            let node = cache.packedToLeaf[packed]!;
            while (node !== -1 && !cache.nodeMarks[node]) {
              cache.nodeMarks[node] = 1; cache.nodeIds[cache.nodeWorkCount++] = node; node = cache.parents[node]!;
            }
          }
          regenerated += 12;
        } else {
          for (let source = id * 12; source < id * 12 + 12; source++) {
            const packed = cache.sourceToPacked[source]!;
            for (let word = 0; word < 16; word++) cache.stagedWords[1]![source * 16 + word] = cache.words[1]![packed * 16 + word]!;
            cache.stagedWords[1]![source * 16 + 3] = next[at + 7]!;
          }
        }
        packedCount += 12;
        for (let word = 0; word < 12; word++) cache.stagedWords[2]![id * 12 + word] = cache.words[2]![id * 12 + word]!;
        for (let axis = 0; axis < 3; axis++) {
          cache.stagedFloats[2]![id * 12 + axis] = next[at + axis]!;
          cache.stagedFloats[2]![id * 12 + 4 + axis] = next[at + 3 + axis]!;
        }
        cache.stagedWords[2]![id * 12 + 3] = next[at + 7]!;
        cache.stagedFloats[2]![id * 12 + 8] = Math.cos(next[at + 6]!);
        cache.stagedFloats[2]![id * 12 + 9] = Math.sin(next[at + 6]!);
      }
      cache.nodeIds.subarray(0, cache.nodeWorkCount).sort();
      for (let i = cache.nodeWorkCount - 1; i >= 0; i--) {
        const id = cache.nodeIds[i]!; stageNode(cache, id, dynamicCount);
        if (cache.words[0]![id * 8 + 7]) leaves++; else ancestors++;
      }
      for (let id = 0; id < this.data.materialCount; id++) if (cache.materialFlags[id]) {
        for (let word = 0; word < 8; word++) cache.stagedFloats[3]![id * 8 + word] = next[materialStart + id * 8 + word]!;
      }
      if (lightChanged) {
        cache.stagedWords[4]!.set(cache.words[4]!);
        for (let axis = 0; axis < 3; axis++) {
          cache.stagedFloats[4]![axis] = next[lightStart + axis]!;
          cache.stagedFloats[4]![4 + axis] = next[lightStart + 3 + axis]!;
        }
      }
      // All validation and geometry/bounds preparation precede publication of canonical bytes or work counters.
      let changedBoxes = 0;
      for (let id = 0; id < this.data.boxCount; id++) if (cache.boxFlags[id]) {
        let changed = commitRecord(cache, 2, id, id);
        for (let source = id * 12; source < id * 12 + 12; source++) {
          const packed = cache.sourceToPacked[source]!;
          changed = commitRecord(cache, 1, source, packed) || changed;
          if (cache.boxFlags[id]! & 1) for (let component = 0; component < 6; component++) {
            cache.triangleBounds[packed * 6 + component] = cache.stagedTriangleBounds[source * 6 + component]!;
          }
        }
        if (changed) changedBoxes++;
      }
      for (let i = 0; i < cache.nodeWorkCount; i++) {
        const id = cache.nodeIds[i]!; if (commitNode(cache, id)) cache.dirty[0]!.add(id);
      }
      for (let id = 0; id < this.data.materialCount; id++) if (cache.materialFlags[id]) commitRecord(cache, 3, id, id);
      if (lightChanged) commitRecord(cache, 4, 0, 0);
      cache.snapshot.set(next); this.data.scene = scene;
      this.counters.updateCount++; this.counters.changedBoxCount += changedBoxes;
      this.counters.regeneratedTriangleCount += regenerated; this.counters.packedTriangleCount += packedCount;
      this.counters.refitLeafCount += leaves; this.counters.refitAncestorCount += ancestors;
    } finally {
      for (let i = 0; i < cache.nodeWorkCount; i++) cache.nodeMarks[cache.nodeIds[i]!] = 0;
      cache.nodeWorkCount = 0;
    }
  }
  flush(queue: GPUQueue, buffers: readonly GPUBuffer[]): { uploadBytes: number; writeCalls: number } {
    const cache = this.live();
    if (buffers.length !== 5) invalid('flush requires the five original GPU buffers in trace layout order.');
    for (let i = 0; i < 5; i++) if (!buffers[i] || buffers[i]!.size < cache.buffers[i]!.byteLength) invalid('flush buffer is too small.');
    let uploadBytes = 0; let writeCalls = 0;
    for (let i = 0; i < 5; i++) {
      const dirty = cache.dirty[i]!; dirty.plan();
      for (let range = 0; range < dirty.rangeCount; range++) {
        const offset = dirty.ranges[range * 2]!; const bytes = dirty.ranges[range * 2 + 1]!;
        this.counters.attemptedWriteCalls++;
        if (dirty.fallback) this.counters.fullBufferFallbackCount++;
        queue.writeBuffer(buffers[i]!, offset, cache.buffers[i]!, offset, bytes);
        this.counters.queuedWriteCalls++; this.counters.queuedUploadBytes += bytes;
        writeCalls++; uploadBytes += bytes;
      }
    }
    for (const dirty of cache.dirty) dirty.clear();
    this.counters.queuedUpdateCount = this.counters.updateCount;
    return { uploadBytes, writeCalls };
  }
  get telemetry(): GiTraceUpdateTelemetry {
    let pendingRangeCount = 0; let pendingUploadBytes = 0;
    if (this.cache) for (const dirty of this.cache.dirty) {
      dirty.plan(); pendingRangeCount += dirty.rangeCount; pendingUploadBytes += dirty.uploadBytes;
    }
    return { ...this.counters, pendingRangeCount, pendingUploadBytes, metadataBytes: this.cache?.metadataBytes ?? 0 };
  }
  dispose(): void { this.cache = undefined; }
}
