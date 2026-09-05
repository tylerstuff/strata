import { describe, expect, it } from 'vitest';
import { createGiScene } from '../../packages/core/src/gi/scene-data.js';
import type { GiSceneData, GiTriangle, GiVec3 } from '../../packages/core/src/gi/scene-data.js';
import { buildGiTraceData, refitGiTraceData, traceGiBvh } from '../../packages/core/src/gi/trace-data.js';
import type { GiTraceData } from '../../packages/core/src/gi/trace-data.js';
import { GiTraceUpdater } from '../../packages/core/src/gi/trace-updates.js';
import { createIntegratedScene } from '../../packages/core/src/integrated/integrated-scene.js';
import { createReflectionScene } from '../../packages/core/src/reflections/reflection-scene.js';
import type { ReflectionSceneOptions } from '../../packages/core/src/reflections/reflection-scene.js';
import { analyticBoxUpdateOracle, assertConservativeContainment, bruteUpdateOracle, conservativeNodeReference, directedF32, dirtyTopology, f32Dyadic,
  generatedTraceProxy, referenceUpdateTriangles, updateOracleGates, updateRayCorpus } from '../helpers/gi-trace-update-reference.js';

const arrays = (data: GiTraceData) => [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData];
const clone = (data: GiTraceData): GiTraceData => ({ ...data, nodeData: data.nodeData.slice(0), triangleData: data.triangleData.slice(0),
  boxData: data.boxData.slice(0), materialData: data.materialData.slice(0), uniformData: data.uniformData.slice(0) });
function bytesEqual(actual: ArrayBuffer | Uint8Array, expected: ArrayBuffer | Uint8Array, label: string) {
  const a = new Uint8Array(actual instanceof ArrayBuffer ? actual : actual.buffer, actual instanceof ArrayBuffer ? 0 : actual.byteOffset, actual.byteLength);
  const b = new Uint8Array(expected instanceof ArrayBuffer ? expected : expected.buffer, expected instanceof ArrayBuffer ? 0 : expected.byteOffset, expected.byteLength);
  expect(a.length, label).toBe(b.length); const first = a.findIndex((value, i) => value !== b[i]);
  expect(first === -1 ? null : { at: first, actual: a[first], expected: b[first] }, label).toBeNull();
}
function compareFull(actual: GiTraceData, oldFull: GiTraceData, scene: GiSceneData) {
  refitGiTraceData(oldFull, scene);
  arrays(actual).slice(1).forEach((bytes, i) => bytesEqual(bytes, arrays(oldFull)[i + 1]!, `full-reference-buffer${i + 1}`));
  expect(actual.triangleOrder).toEqual(oldFull.triangleOrder);
  const source = referenceUpdateTriangles(scene, actual.staticTriangles);
  const canonical = conservativeNodeReference(oldFull, source); bytesEqual(actual.nodeData, canonical, 'independent conservative full nodes');
  assertConservativeContainment(actual, source);
  const actualNodes = new DataView(actual.nodeData), oldNodes = new DataView(oldFull.nodeData);
  for (let i = 0; i < actual.nodeCount; i++) for (const offset of [12, 28]) expect(actualNodes.getUint32(i * 32 + offset, true)).toBe(oldNodes.getUint32(i * 32 + offset, true));
}
function gpuBytes(data: GiTraceData) {
  const buffers = arrays(data).map((a, id) => ({ id, size: a.byteLength, bytes: new Uint8Array(a.byteLength).fill(0xa5), destroyed: 0,
    destroy() { this.destroyed++; } }));
  // Complete creation uploads are deliberately outside incremental counters.
  buffers.forEach((b, i) => b.bytes.set(new Uint8Array(arrays(data)[i]!)));
  const calls: { buffer: number; offset: number; bytes: Uint8Array; returned: boolean }[] = [];
  let failAt: number | undefined;
  const queue = { writeBuffer(target: typeof buffers[number], offset: number, source: ArrayBuffer | ArrayBufferView,
    dataOffset = 0, size?: number) {
    const unit = ArrayBuffer.isView(source) ? ((source as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1) : 1;
    const base = ArrayBuffer.isView(source) ? source.buffer : source;
    const start = (ArrayBuffer.isView(source) ? source.byteOffset : 0) + dataOffset * unit;
    const length = size === undefined ? source.byteLength - dataOffset * unit : size * unit;
    expect(offset % 4).toBe(0); expect(length % 4).toBe(0); expect(offset + length).toBeLessThanOrEqual(target.size);
    const copy = new Uint8Array(base, start, length).slice(), call = { buffer: target.id, offset, bytes: copy, returned: false }; calls.push(call);
    if (failAt === calls.length - 1) throw new Error('Injected partial queue write failure.');
    target.bytes.set(copy, offset); call.returned = true;
  } };
  return { buffers: buffers as unknown as readonly GPUBuffer[], queue: queue as unknown as GPUQueue, calls,
    failAfterReturned(count: number) { failAt = calls.length + count; }, recover() { failAt = undefined; },
    assertCurrent(target: GiTraceData) { buffers.forEach((b, i) => bytesEqual(b.bytes, arrays(target)[i]!, `physical GPU buffer${i}`)); },
    assertBorrowedAlive() { expect(buffers.every(b => b.destroyed === 0)).toBe(true); } };
}
const acceptedBytes = (calls: ReturnType<typeof gpuBytes>['calls']) => calls.filter(c => c.returned).reduce((sum, c) => sum + c.bytes.length, 0);
const mutations: readonly ReflectionSceneOptions[] = [
  {}, { objectOffset: -.4 }, { objectOffset: .4 }, {}, { doorOpen: false }, {}, { wallColor: 'neutral' },
  { wallColor: 'neutral', roughness: .3 }, { wallColor: 'neutral', roughness: .3, lightIntensity: 0 },
  { wallColor: 'neutral', roughness: .3, lightIntensity: 2 }, { objectOffset: -.4, doorOpen: false, wallColor: 'red', lightIntensity: 1, roughness: .08 }, {}, {},
];

describe('independent exact-dyadic conservative node contract', () => {
  it('preserves exact endpoints and rounds every inexact bound outward, including tiny terms lost by binary64', () => {
    for (const x of [-1000, -1, -(2 ** -100), 0, 2 ** -100, 1, 1000]) {
      expect(directedF32(f32Dyadic(Math.fround(x)), false)).toBe(Math.fround(x));
      expect(directedF32(f32Dyadic(Math.fround(x)), true)).toBe(Math.fround(x));
    }
    expect(directedF32(f32Dyadic(1) + f32Dyadic(2 ** -100), true)).toBe(1 + 2 ** -23);
    expect(directedF32(f32Dyadic(-1) + f32Dyadic(-(2 ** -100)), false)).toBe(-1 - 2 ** -23);
    expect(1 + 2 ** -100).toBe(1); // Negative control: naive binary64 addition loses this endpoint expansion.
  });
  it('encloses source and rounded-edge endpoints with minimal directed bounds on all axes; old tight nodes intentionally differ', () => {
    const cases = [[1, -1 + 2 ** -24], [-1, 1 - 2 ** -24], [1 - 2 ** -24, -1], [-1 + 2 ** -24, 1], [2 ** -100, 1], [-(2 ** -100), -1]];
    for (const [start, end] of cases) for (let axis = 0; axis < 3; axis++) {
      const rotate = (p: readonly number[]): GiVec3 => [p[(3 - axis) % 3]!, p[(4 - axis) % 3]!, p[(5 - axis) % 3]!];
      const p0 = rotate([start!, 0, 0]), p1 = rotate([end!, 1, 0]), p2 = rotate([start!, 0, 1]);
      const e1 = p1.map((v, i) => v - p0[i]!), e2 = p2.map((v, i) => v - p0[i]!);
      const normal = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const triangle: GiTriangle = { id: 0, boxId: 0xfffffffe, materialId: 0, p0, p1, p2,
        normal: normal.map(v => Math.fround(v / Math.hypot(...normal))) as unknown as GiVec3 };
      const base = createGiScene(), scene: GiSceneData = { ...base, boxes: [{ ...base.boxes[0]!, center: [100, 100, 100], halfSize: [1, 1, 1] }] };
      const copies = Array.from({ length: 4 }, (_, id) => ({ ...triangle, id }));
      const data = buildGiTraceData(scene, copies), full = clone(data), oldNodes = data.nodeData.slice(0);
      const updater = new GiTraceUpdater(data); compareFull(data, full, scene);
      const packed = data.triangleOrder.indexOf(12), nodes = new DataView(data.nodeData), old = new DataView(oldNodes);
      let isolated = 0;
      for (let node = 0; node < data.nodeCount; node++) {
        const first = nodes.getUint32(node * 32 + 12, true), count = nodes.getUint32(node * 32 + 28, true);
        if (!count || packed < first || packed >= first + count) continue;
        expect(data.triangleOrder.slice(first, first + count).every(id => id >= 12)).toBe(true);
        const minimum = directedF32([p0, p1, p2].map(p => f32Dyadic(p[axis]!)).concat([
          f32Dyadic(p0[axis]!) + f32Dyadic(Math.fround(p1[axis]! - p0[axis]!)),
          f32Dyadic(p0[axis]!) + f32Dyadic(Math.fround(p2[axis]! - p0[axis]!)),
        ]).reduce((a, b) => a < b ? a : b), false);
        const maximum = directedF32([p0, p1, p2].map(p => f32Dyadic(p[axis]!)).concat([
          f32Dyadic(p0[axis]!) + f32Dyadic(Math.fround(p1[axis]! - p0[axis]!)),
          f32Dyadic(p0[axis]!) + f32Dyadic(Math.fround(p2[axis]! - p0[axis]!)),
        ]).reduce((a, b) => a > b ? a : b), true);
        expect(nodes.getFloat32(node * 32 + axis * 4, true)).toBe(minimum);
        expect(nodes.getFloat32(node * 32 + 16 + axis * 4, true)).toBe(maximum);
        expect(minimum !== old.getFloat32(node * 32 + axis * 4, true) || maximum !== old.getFloat32(node * 32 + 16 + axis * 4, true)).toBe(true);
        isolated++;
      }
      expect(isolated).toBe(1);
      updater.dispose();
    }
  });
});

describe('incremental trace source/reference equivalence', () => {
  it('matches the unchanged full non-node packing and independent conservative bounds through object/door/material/light/composite/reverse edits', () => {
    const initial = createIntegratedScene(), data = buildGiTraceData(initial, generatedTraceProxy()), full = clone(data), buffers = arrays(data), staticSource = data.staticTriangles;
    const updater = new GiTraceUpdater(data), gpu = gpuBytes(data), metadata = updater.telemetry.metadataBytes;
    for (const patch of mutations) {
      const next = createIntegratedScene(patch); updater.update(next); compareFull(data, full, next);
      arrays(data).forEach((buffer, i) => expect(buffer).toBe(buffers[i])); expect(data.staticTriangles).toBe(staticSource); expect(updater.telemetry.metadataBytes).toBe(metadata);
      updater.flush(gpu.queue, gpu.buffers); gpu.assertCurrent(data);
      expect(updater.telemetry.pendingRangeCount).toBe(0); expect(updater.telemetry.pendingUploadBytes).toBe(0);
    }
    updater.dispose(); gpu.assertBorrowedAlive();
  });
  it('checks fixed512 rays against separately constructed plane/Gram source geometry and preserves offscreen terrain/selected mirror witnesses', () => {
    const initial = createIntegratedScene(), data = buildGiTraceData(initial, generatedTraceProxy()), full = clone(data), updater = new GiTraceUpdater(data);
    const rays = updateRayCorpus(initial, createIntegratedScene); expect(rays).toHaveLength(512);
    expect(rays).toEqual(updateRayCorpus(initial, createIntegratedScene));
    const terrainBefore = new Map<number, ReturnType<typeof traceGiBvh>>(); let changedRigidHits = 0;
    let previous: ReturnType<typeof traceGiBvh>[] | undefined;
    for (const patch of [mutations[0]!, mutations[1]!, mutations[2]!, mutations[4]!, mutations[6]!, mutations[8]!, mutations[10]!, mutations[11]!]) {
      const scene = createIntegratedScene(patch); updater.update(scene); compareFull(data, full, scene);
      const fullConservative = clone(full); new Uint8Array(fullConservative.nodeData).set(new Uint8Array(conservativeNodeReference(full, referenceUpdateTriangles(scene, full.staticTriangles))));
      const source = referenceUpdateTriangles(scene, data.staticTriangles); let safe = 0, terrainHits = 0, mirrorHits = 0; const actuals = [];
      for (const [index, witness] of rays.entries()) {
        const actual = traceGiBvh(data, witness.ray), control = traceGiBvh(fullConservative, witness.ray), expected = bruteUpdateOracle(witness.ray, source); actuals.push(actual);
        expect(actual).toEqual(control);
        if (!expected || !expected.boundary) {
          safe++; expect(actual.status).toBe(expected ? 1 : 0);
          if (expected) {
            expect(actual.triangleId).toBe(expected.triangle.id); expect(actual.boxId).toBe(expected.triangle.boxId); expect(actual.materialId).toBe(expected.triangle.materialId);
            expect(Math.abs(actual.distance - expected.distance)).toBeLessThanOrEqual(updateOracleGates.distanceAbsolute + updateOracleGates.distanceRelative * Math.abs(expected.distance));
            const normalDot = actual.normal.reduce((sum, v, i) => sum + v * expected.triangle.normal[i]!, 0) / Math.hypot(...actual.normal);
            expect(normalDot).toBeGreaterThanOrEqual(updateOracleGates.normalDot);
          }
        }
        if (witness.category === 'terrain' && expected?.triangle.boxId === 0xfffffffe && !expected.boundary) {
          terrainHits++; expect(actual.boxId).toBe(0xfffffffe); expect(actual.materialId).toBe(5);
          const before = terrainBefore.get(index); if (before) expect(actual).toMatchObject({ distance: before.distance, triangleId: before.triangleId, materialId: before.materialId, boxId: before.boxId, status: before.status });
          else terrainBefore.set(index, actual);
        }
        if (witness.category === 'mirror' && expected?.triangle.boxId === scene.objectBoxId && !expected.boundary) mirrorHits++;
        if (previous && witness.category === 'rigid' && (actual.status !== previous[index]!.status || actual.triangleId !== previous[index]!.triangleId)) changedRigidHits++;
      }
      expect(safe).toBeGreaterThanOrEqual(updateOracleGates.minNonBoundary); expect(terrainHits).toBeGreaterThanOrEqual(48); expect(mirrorHits).toBeGreaterThanOrEqual(16); previous = actuals;
    }
    expect(changedRigidHits).toBeGreaterThan(24); updater.dispose();
  });
  it('cross-checks fixed targeted cube/door/mirror rays with analytic local-box slabs, including the yawed door', () => {
    const rays = updateRayCorpus(createIntegratedScene(), createIntegratedScene);
    let yawedDoorHits = 0;
    for (const patch of [mutations[0]!, mutations[1]!, mutations[2]!, mutations[4]!, mutations[6]!, mutations[8]!, mutations[10]!, mutations[11]!]) {
      const scene = createIntegratedScene(patch), boxesOnly = referenceUpdateTriangles(scene); let checked = 0, mirrorHits = 0;
      for (const witness of rays.filter(w => w.category === 'rigid' || w.category === 'mirror')) {
        const triangle = bruteUpdateOracle(witness.ray, boxesOnly), slab = analyticBoxUpdateOracle(witness.ray, scene);
        if (triangle?.boundary) continue;
        checked++; expect(slab === null).toBe(triangle === null);
        if (triangle && slab) {
          expect(slab.boxId).toBe(triangle.triangle.boxId);
          expect(Math.abs(slab.distance - triangle.distance)).toBeLessThanOrEqual(updateOracleGates.distanceAbsolute + updateOracleGates.distanceRelative * Math.abs(triangle.distance));
          expect(slab.normal.reduce((sum, n, i) => sum + n * triangle.triangle.normal[i]!, 0)).toBeGreaterThanOrEqual(updateOracleGates.normalDot);
          if (slab.boxId === scene.doorBoxId && scene.boxes[scene.doorBoxId]!.yaw !== 0) yawedDoorHits++;
          if (witness.category === 'mirror' && slab.boxId === scene.objectBoxId) mirrorHits++;
        }
      }
      expect(checked).toBeGreaterThanOrEqual(160); expect(mirrorHits).toBeGreaterThanOrEqual(16);
    }
    expect(yawedDoorHits).toBeGreaterThanOrEqual(24);
  });
  it('does no work for value-equivalent scenes; material-only and light-only edits do not repack geometry', () => {
    const initial = createReflectionScene(), data = buildGiTraceData(initial), updater = new GiTraceUpdater(data), gpu = gpuBytes(data), before = { ...updater.telemetry };
    updater.update(createReflectionScene()); expect(updater.telemetry).toEqual(before); expect(updater.flush(gpu.queue, gpu.buffers)).toEqual({ uploadBytes: 0, writeCalls: 0 });
    for (const [patch, expectedBuffer, expectedBytes] of [[{ roughness: .3 }, 3, 32], [{ roughness: .3, lightIntensity: 0 }, 4, 48]] as const) {
      const prior = { ...updater.telemetry }, start = gpu.calls.length; updater.update(createReflectionScene(patch)); const result = updater.flush(gpu.queue, gpu.buffers);
      expect(gpu.calls.slice(start).every(call => call.buffer === expectedBuffer)).toBe(true); expect(result.uploadBytes).toBe(expectedBytes);
      expect(updater.telemetry.regeneratedTriangleCount).toBe(prior.regeneratedTriangleCount); expect(updater.telemetry.packedTriangleCount).toBe(prior.packedTriangleCount);
      expect(updater.telemetry.refitLeafCount).toBe(prior.refitLeafCount); expect(updater.telemetry.refitAncestorCount).toBe(prior.refitAncestorCount); gpu.assertCurrent(data);
    }
    updater.dispose();
  });
  it('changes material identity without regenerating positions or refitting any bounds', () => {
    const scene = createReflectionScene(), data = buildGiTraceData(scene), full = clone(data), updater = new GiTraceUpdater(data), gpu = gpuBytes(data);
    const next = { ...scene, boxes: scene.boxes.map(b => b.id === scene.objectBoxId ? { ...b, materialId: 0 } : b) };
    const nodes = data.nodeData.slice(0), before = { ...updater.telemetry }; updater.update(next); compareFull(data, full, next);
    bytesEqual(data.nodeData, nodes, 'material identity retains all bounds');
    expect(updater.telemetry.changedBoxCount - before.changedBoxCount).toBe(1);
    expect(updater.telemetry.packedTriangleCount - before.packedTriangleCount).toBe(12);
    for (const key of ['regeneratedTriangleCount', 'refitLeafCount', 'refitAncestorCount'] as const) expect(updater.telemetry[key]).toBe(before[key]);
    expect(updater.flush(gpu.queue, gpu.buffers).uploadBytes).toBe(816);
    expect(gpu.calls.every(c => c.buffer === 1 || c.buffer === 2)).toBe(true); gpu.assertCurrent(data); updater.dispose();
  });
  it('compares owned numeric snapshots when callers mutate and reuse the same scene object', () => {
    const scene = structuredClone(createReflectionScene()), data = buildGiTraceData(scene), full = clone(data), updater = new GiTraceUpdater(data), gpu = gpuBytes(data);
    const center = scene.boxes[scene.objectBoxId]!.center as unknown as number[];
    center[2]! += .4; updater.update(scene); compareFull(data, full, scene);
    expect(updater.telemetry.updateCount).toBe(1); expect(updater.telemetry.regeneratedTriangleCount).toBe(12);
    const accepted = arrays(data).map(a => a.slice(0)); center[2]! += .4;
    arrays(data).forEach((a, i) => bytesEqual(a, accepted[i]!, 'caller mutation does not mutate canonical bytes'));
    updater.update(scene); compareFull(data, full, scene); expect(updater.telemetry.updateCount).toBe(2);
    updater.flush(gpu.queue, gpu.buffers); gpu.assertCurrent(data); updater.dispose();
  });
  it('regenerates exactly one cube and its unique ancestor closure, with no static triangle writes and over90% fewer bytes on generated2048-proxy stress', () => {
    const scene = createIntegratedScene(), data = buildGiTraceData(scene, generatedTraceProxy()), updater = new GiTraceUpdater(data), gpu = gpuBytes(data);
    const topology = dirtyTopology(data, [scene.objectBoxId]), before = { ...updater.telemetry }; updater.update(createIntegratedScene({ objectOffset: .4 }));
    const work = updater.telemetry;
    expect(work.changedBoxCount - before.changedBoxCount).toBe(1); expect(work.regeneratedTriangleCount - before.regeneratedTriangleCount).toBe(12); expect(work.packedTriangleCount - before.packedTriangleCount).toBe(12);
    expect(work.refitLeafCount - before.refitLeafCount).toBe(topology.leaves.length); expect(work.refitAncestorCount - before.refitAncestorCount).toBe(topology.ancestors.length);
    const result = updater.flush(gpu.queue, gpu.buffers); expect(updater.telemetry.fullBufferFallbackCount).toBe(before.fullBufferFallbackCount);
    expect(result.uploadBytes).toBeLessThanOrEqual(768 + 48 + 32 * (topology.leaves.length + topology.ancestors.length));
    expect(result.uploadBytes).toBeLessThan(data.gpuBufferBytes * .1);
    for (const call of gpu.calls.filter(c => c.buffer === 1)) for (let offset = call.offset; offset < call.offset + call.bytes.length; offset += 64) expect(topology.slots).toContain(offset / 64);
    expect(gpu.calls.filter(c => c.buffer === 1).reduce((sum, c) => sum + c.bytes.length, 0)).toBe(768); gpu.assertCurrent(data); updater.dispose();
  });
});

describe('byte-addressed queued update failure, coalescing and ownership', () => {
  it.each(['first', 'second', 'last'] as const)('retains latest canonical coverage after failure at the %s planned call, different-target supersession and retry', failure => {
    const scene = createIntegratedScene(), data = buildGiTraceData(scene, generatedTraceProxy()), full = clone(data), updater = new GiTraceUpdater(data), gpu = gpuBytes(data);
    updater.update(createIntegratedScene({ objectOffset: -.4, doorOpen: false, wallColor: 'neutral', lightIntensity: 0 }));
    const returned = failure === 'last' ? updater.telemetry.pendingRangeCount - 1 : failure === 'second' ? 1 : 0;
    expect(updater.telemetry.pendingRangeCount).toBeGreaterThan(returned); gpu.failAfterReturned(returned);
    const before = { ...updater.telemetry }; expect(() => updater.flush(gpu.queue, gpu.buffers)).toThrow('partial queue write');
    expect(updater.telemetry.attemptedWriteCalls - before.attemptedWriteCalls).toBe(returned + 1);
    expect(updater.telemetry.queuedWriteCalls - before.queuedWriteCalls).toBe(returned); expect(updater.telemetry.queuedUploadBytes - before.queuedUploadBytes).toBe(acceptedBytes(gpu.calls));
    expect(updater.telemetry.pendingRangeCount).toBeGreaterThan(0); expect(updater.telemetry.queuedUpdateCount).toBe(0);
    const latest = createIntegratedScene({ objectOffset: .4, doorOpen: true, lightIntensity: 2 }); updater.update(latest); compareFull(data, full, latest);
    gpu.recover(); updater.flush(gpu.queue, gpu.buffers); gpu.assertCurrent(data);
    expect(updater.telemetry.queuedUpdateCount).toBe(updater.telemetry.updateCount);
    expect(updater.telemetry.queuedUploadBytes).toBe(acceptedBytes(gpu.calls)); updater.dispose();
  });
  it('preserves successfully queued state across a cancelled encoded frame without redundant writes', () => {
    const scene = createReflectionScene(), data = buildGiTraceData(scene), updater = new GiTraceUpdater(data), gpu = gpuBytes(data);
    updater.update(createReflectionScene({ objectOffset: .4 })); updater.flush(gpu.queue, gpu.buffers);
    const before = { ...updater.telemetry }; // Effect cancels its pending frame; queue writes are not rolled back.
    expect(updater.flush(gpu.queue, gpu.buffers)).toEqual({ uploadBytes: 0, writeCalls: 0 }); expect(updater.telemetry).toEqual(before); gpu.assertCurrent(data); updater.dispose();
  });
  it('bounds256 unsubmitted edits and preserves reverse-to-original bytes without per-edit GPU writes', () => {
    const initial = createIntegratedScene(), data = buildGiTraceData(initial, generatedTraceProxy()), full = clone(data), updater = new GiTraceUpdater(data), gpu = gpuBytes(data), bytes = updater.telemetry.metadataBytes;
    for (let i = 0; i < 256; i++) {
      updater.update(createIntegratedScene({ objectOffset: i % 2 ? -.4 : .4, doorOpen: i % 3 !== 0, lightIntensity: i % 5 ? 1 : 0, wallColor: i % 7 ? 'red' : 'neutral' }));
      expect(updater.telemetry.pendingRangeCount).toBeLessThanOrEqual(160); expect(updater.telemetry.pendingUploadBytes).toBeLessThanOrEqual(data.gpuBufferBytes); expect(updater.telemetry.metadataBytes).toBe(bytes);
    }
    updater.update(initial); compareFull(data, full, initial); expect(gpu.calls).toHaveLength(0); updater.flush(gpu.queue, gpu.buffers); gpu.assertCurrent(data); updater.dispose();
  });
  it('rejects invalid or changed-topology updates atomically while an earlier valid target remains pending', () => {
    const initial = createReflectionScene(), data = buildGiTraceData(initial), updater = new GiTraceUpdater(data), gpu = gpuBytes(data);
    updater.update(createReflectionScene({ objectOffset: .4 })); const before = arrays(data).map(a => a.slice(0)), telemetry = { ...updater.telemetry }, previousScene = data.scene;
    const bad: GiSceneData[] = [
      { ...initial, boxes: initial.boxes.slice(1) },
      { ...initial, boxes: initial.boxes.map((b, i) => i === 12 ? { ...b, center: [NaN, 0, 0] } : b) },
      { ...initial, materials: initial.materials.map((m, i) => i === 1 ? { ...m, emission: [Infinity, 0, 0] } : m) },
      { ...initial, light: { ...initial.light, radiance: [-1, 0, 0] } },
    ];
    for (const scene of bad) { expect(() => updater.update(scene)).toThrow(); arrays(data).forEach((a, i) => bytesEqual(a, before[i]!, 'rejected atomic buffer')); expect(data.scene).toBe(previousScene); expect(updater.telemetry).toEqual(telemetry); }
    updater.flush(gpu.queue, gpu.buffers); gpu.assertCurrent(data); updater.dispose();
  });
  it.each([32, 33])('coalesces only adjacent records and uses one complete buffer only beyond %d fragmented material ranges', count => {
    const base = createGiScene(), scene = { ...base, materials: Array.from({ length: 70 }, (_, id) => ({ ...base.materials[id % base.materials.length]!, id })) };
    const data = buildGiTraceData(scene), full = clone(data), updater = new GiTraceUpdater(data), gpu = gpuBytes(data);
    const next = { ...scene, materials: scene.materials.map((m, id) => id % 2 === 0 && id < 2 * count ? { ...m, roughness: .123 } : m) };
    updater.update(next); compareFull(data, full, next);
    expect(updater.telemetry.pendingRangeCount).toBe(count === 32 ? 32 : 1);
    expect(updater.telemetry.pendingUploadBytes).toBe(count === 32 ? 32 * 32 : 70 * 32);
    if (count === 33) {
      gpu.failAfterReturned(0); expect(() => updater.flush(gpu.queue, gpu.buffers)).toThrow('partial queue write');
      expect(updater.telemetry.fullBufferFallbackCount).toBe(1); expect(updater.telemetry.queuedUploadBytes).toBe(0);
      const latest = { ...next, materials: next.materials.map((m, id) => id === 0 ? { ...m, roughness: .321 } : m) };
      updater.update(latest); compareFull(data, full, latest); gpu.recover();
    }
    const result = updater.flush(gpu.queue, gpu.buffers), calls = gpu.calls.filter(c => c.returned);
    expect(calls).toHaveLength(count === 32 ? 32 : 1); expect(calls.every(c => c.buffer === 3)).toBe(true);
    if (count === 32) calls.forEach((c, i) => { expect(c.offset).toBe(i * 64); expect(c.bytes.length).toBe(32); });
    else { expect(calls[0]!.offset).toBe(0); expect(calls[0]!.bytes.length).toBe(data.materialData.byteLength); }
    expect(updater.telemetry.fullBufferFallbackCount).toBe(count === 32 ? 0 : 2);
    expect(result.writeCalls).toBeLessThanOrEqual(160); gpu.assertCurrent(data); updater.dispose();
  });
  it('bounds fragmented box assignments with explicit full-triangle fallback including static bytes', () => {
    const base = createIntegratedScene(), scene: GiSceneData = { ...base, boxes: Array.from({ length: 66 }, (_, id) => ({
      id, name: `fragment-box-${id}`, center: [id * 2 - 66, 50, 0] as GiVec3, halfSize: [.2, .2, .2] as GiVec3, yaw: 0, materialId: 1,
    })) };
    const data = buildGiTraceData(scene, generatedTraceProxy()), full = clone(data);
    const changedIds = scene.boxes.filter(b => b.id % 2 === 0).map(b => b.id), frozenSlots = dirtyTopology(data, changedIds).slots;
    const ranges = frozenSlots.filter((slot, i) => i === 0 || slot !== frozenSlots[i - 1]! + 1).length;
    // Fixture prerequisite is checked from the original source-to-slot plan before mutation.
    expect(ranges).toBeGreaterThan(32); expect(changedIds).toHaveLength(33);
    const updater = new GiTraceUpdater(data), gpu = gpuBytes(data), prior = { ...updater.telemetry };
    const next = { ...scene, boxes: scene.boxes.map(b => b.id % 2 === 0 ? { ...b, materialId: 0 } : b) };
    updater.update(next); compareFull(data, full, next); const result = updater.flush(gpu.queue, gpu.buffers);
    expect(gpu.calls.map(c => ({ buffer: c.buffer, offset: c.offset, bytes: c.bytes.length }))).toEqual([
      { buffer: 1, offset: 0, bytes: data.triangleData.byteLength }, { buffer: 2, offset: 0, bytes: data.boxData.byteLength },
    ]);
    expect(updater.telemetry.fullBufferFallbackCount - prior.fullBufferFallbackCount).toBe(2);
    expect(result.uploadBytes).toBe(data.triangleData.byteLength + data.boxData.byteLength);
    expect(result.writeCalls).toBe(2); expect(updater.telemetry.regeneratedTriangleCount).toBe(0);
    expect(updater.telemetry.refitLeafCount).toBe(0); expect(updater.telemetry.refitAncestorCount).toBe(0);
    const staticSlots = data.triangleOrder.flatMap((source, slot) => source >= 66 * 12 ? [slot] : []);
    expect(staticSlots).toHaveLength(2048); // Exception is deliberate and accounted, never the canonical cube path.
    expect(result.uploadBytes).toBeGreaterThan(staticSlots.length * 64); gpu.assertCurrent(data); updater.dispose();
  });
  it('disposes idempotently, refuses further mutation/upload and never destroys borrowed GPU buffers', () => {
    const scene = createReflectionScene(), data = buildGiTraceData(scene), updater = new GiTraceUpdater(data), gpu = gpuBytes(data);
    updater.update(createReflectionScene({ objectOffset: .4 })); updater.dispose(); updater.dispose();
    expect(() => updater.update(scene)).toThrow(/disposed/i); expect(() => updater.flush(gpu.queue, gpu.buffers)).toThrow(/disposed/i);
    expect(gpu.calls).toHaveLength(0); gpu.assertBorrowedAlive(); expect(updater.telemetry.metadataBytes).toBe(0);
  });
});
