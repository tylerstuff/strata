/**
 * CORRECTNESS CONTROL ONLY — INELIGIBLE FOR PERFORMANCE COMPARISONS.
 * The preserved full packer and independent BigInt bounds oracle run for every
 * changed numeric target. No production incremental updater, maps, dirty-record
 * classification or ancestor-refit implementation is imported here.
 */
import { StrataError } from '../../packages/core/src/errors.js';
import type { GiTraceUpdateTelemetry } from '../../packages/core/src/gi/gi-types.js';
import type { GiSceneData, GiVec3 } from '../../packages/core/src/gi/scene-data.js';
import { refitGiTraceData, validateGiTraceScene } from '../../packages/core/src/gi/trace-data.js';
import type { GiTraceData } from '../../packages/core/src/gi/trace-data.js';
import { conservativeNodeReference, referenceUpdateTriangles } from './gi-trace-update-reference.js';

const buffersOf = (data: GiTraceData): readonly ArrayBuffer[] =>
  [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData];
function invalid(message: string): never { throw new StrataError('INVALID_OPTIONS', `Invalid full trace control: ${message}`); }
function vector(value: GiVec3): GiVec3 {
  if (!Array.isArray(value) || value.length !== 3) invalid('expected a three-component vector.');
  const copy: GiVec3 = [value[0], value[1], value[2]];
  if (!copy.every(Number.isFinite)) invalid('expected finite vector components.');
  return copy;
}
function ownNumericScene(scene: GiSceneData, data: GiTraceData): GiSceneData {
  if (!scene || !Array.isArray(scene.boxes) || !Array.isArray(scene.materials) || !scene.light
    || scene.boxes.length !== data.boxCount || scene.materials.length !== data.materialCount) invalid('scene topology must remain fixed.');
  const owned: GiSceneData = {
    ...scene,
    boxes: Array.from(scene.boxes, box => {
      if (!box) invalid('missing box.');
      return { ...box, center: vector(box.center), halfSize: vector(box.halfSize) };
    }),
    materials: Array.from(scene.materials, material => {
      if (!material) invalid('missing material.');
      return { ...material, albedo: vector(material.albedo), emission: vector(material.emission) };
    }),
    light: { direction: vector(scene.light.direction), radiance: vector(scene.light.radiance) },
  };
  validateGiTraceScene(owned);
  return owned;
}
function numericSnapshot(scene: GiSceneData): Float64Array<ArrayBuffer> {
  return Float64Array.from([
    ...scene.boxes.flatMap(box => [...box.center, ...box.halfSize, box.yaw, box.materialId]),
    ...scene.materials.flatMap(material => [...material.albedo, material.roughness, ...material.emission, material.metallic ?? 0]),
    ...scene.light.direction, ...scene.light.radiance,
  ]);
}
function sameBytes(a: ArrayBuffer, b: ArrayBuffer, offset = 0, size = a.byteLength): boolean {
  const left = new Uint8Array(a, offset, size), right = new Uint8Array(b, offset, size);
  for (let i = 0; i < size; i++) if (left[i] !== right[i]) return false;
  return true;
}
function fullCopy(data: GiTraceData): GiTraceData {
  return { ...data, nodeData: data.nodeData.slice(0), triangleData: data.triangleData.slice(0),
    boxData: data.boxData.slice(0), materialData: data.materialData.slice(0), uniformData: data.uniformData.slice(0) };
}
function copyPacked(from: GiTraceData, to: GiTraceData): void {
  const source = buffersOf(from), target = buffersOf(to);
  for (let i = 0; i < 5; i++) new Uint8Array(target[i]!).set(new Uint8Array(source[i]!));
}
function fullPrepare(staged: GiTraceData, scene: GiSceneData): void {
  refitGiTraceData(staged, scene);
  const corrected = conservativeNodeReference(staged, referenceUpdateTriangles(scene, staged.staticTriangles));
  new Uint8Array(staged.nodeData).set(new Uint8Array(corrected));
}

/** Exact internal replacement name; callers may alias the import as FullTraceUpdater. */
export class GiTraceUpdater {
  private staged: GiTraceData | undefined;
  private snapshot: Float64Array<ArrayBuffer> | undefined;
  private pending = false;
  private readonly leafCount: number;
  private readonly sourceBytes: number;
  private readonly counters = { updateCount: 0, queuedUpdateCount: 0, changedBoxCount: 0,
    regeneratedTriangleCount: 0, packedTriangleCount: 0, refitLeafCount: 0, refitAncestorCount: 0,
    attemptedWriteCalls: 0, queuedWriteCalls: 0, queuedUploadBytes: 0, fullBufferFallbackCount: 0 };

  constructor(readonly data: GiTraceData) {
    const owned = ownNumericScene(data.scene, data), staged = fullCopy(data), snapshot = numericSnapshot(owned);
    fullPrepare(staged, owned);
    // Initial correction precedes the owner's original five creation uploads and
    // is deliberately excluded from all incremental work/version/write counters.
    copyPacked(staged, data);
    this.staged = staged; this.snapshot = snapshot;
    this.sourceBytes = buffersOf(data).reduce((sum, buffer) => sum + buffer.byteLength, 0);
    const nodes = new DataView(data.nodeData); let leaves = 0;
    for (let id = 0; id < data.nodeCount; id++) if (nodes.getUint32(id * 32 + 28, true)) leaves++;
    this.leafCount = leaves;
  }
  private live(): GiTraceData {
    if (!this.staged) throw new StrataError('ENGINE_DISPOSED', 'The full trace correctness control is disposed.');
    return this.staged;
  }
  update(scene: GiSceneData): void {
    const staged = this.live(), owned = ownNumericScene(scene, this.data), next = numericSnapshot(owned);
    if (sameBytes(next.buffer, this.snapshot!.buffer)) { this.data.scene = scene; return; }

    // Every buffer is independently staged; even a failing full preparation
    // cannot publish part of a target or erase a previously pending whole source.
    copyPacked(this.data, staged);
    fullPrepare(staged, owned);
    const changedBoxes = new Set<number>();
    for (let box = 0; box < this.data.boxCount; box++) {
      if (!sameBytes(this.data.boxData, staged.boxData, box * 48, 48)) changedBoxes.add(box);
    }
    const triangles = new DataView(staged.triangleData);
    for (let slot = 0; slot < this.data.triangleCount; slot++) {
      if (!sameBytes(this.data.triangleData, staged.triangleData, slot * 64, 64)) {
        const box = triangles.getUint32(slot * 64 + 28, true);
        if (box < this.data.boxCount) changedBoxes.add(box);
      }
    }
    copyPacked(staged, this.data); this.data.scene = scene; this.snapshot = next; this.pending = true;
    this.counters.updateCount++; this.counters.changedBoxCount += changedBoxes.size;
    // Both the full packer and independent oracle enumerate all box triangles
    // and all nodes. Static triangles are packed but are not geometrically regenerated.
    this.counters.regeneratedTriangleCount += this.data.boxCount * 12 * 2;
    this.counters.packedTriangleCount += this.data.triangleCount;
    this.counters.refitLeafCount += this.leafCount * 2;
    this.counters.refitAncestorCount += (this.data.nodeCount - this.leafCount) * 2;
  }
  flush(queue: GPUQueue, buffers: readonly GPUBuffer[]): { uploadBytes: number; writeCalls: number } {
    this.live();
    const sources = buffersOf(this.data);
    if (buffers.length !== 5) invalid('expected five adequately sized trace buffers.');
    for (let i = 0; i < 5; i++) if (!buffers[i] || buffers[i]!.size < sources[i]!.byteLength) invalid('expected five adequately sized trace buffers.');
    let uploadBytes = 0, writeCalls = 0;
    if (this.pending) for (let i = 0; i < 5; i++) {
      const source = sources[i]!;
      this.counters.attemptedWriteCalls++;
      queue.writeBuffer(buffers[i]!, 0, source, 0, source.byteLength);
      this.counters.queuedWriteCalls++; this.counters.queuedUploadBytes += source.byteLength;
      writeCalls++; uploadBytes += source.byteLength;
    }
    // All five returns are required, including after a partial flush and a new
    // target. A later discarded encoder does not undo these successful writes.
    this.pending = false; this.counters.queuedUpdateCount = this.counters.updateCount;
    return { uploadBytes, writeCalls };
  }
  get telemetry(): GiTraceUpdateTelemetry {
    return { ...this.counters, pendingRangeCount: this.pending ? 5 : 0, pendingUploadBytes: this.pending ? this.sourceBytes : 0,
      // Retained typed payload = one complete staging image plus one f64 target
      // snapshot. Temporary node copies, BigInts and JS source objects are NOT
      // retained metadata; their substantial allocation/work forbids timing use.
      metadataBytes: this.staged ? this.sourceBytes + this.snapshot!.byteLength : 0 };
  }
  dispose(): void { this.staged = undefined; this.snapshot = undefined; this.pending = false; }
}
