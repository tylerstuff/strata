import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { GiTraceUpdater as FullTraceUpdater } from '../helpers/full-trace-performance-updater.js';
import { GiTraceUpdater as IncrementalUpdater } from '../../packages/core/src/gi/trace-updates.js';
import { buildGiTraceData, refitGiTraceData } from '../../packages/core/src/gi/trace-data.js';
import type { GiTraceData } from '../../packages/core/src/gi/trace-data.js';
import type { GiSceneData, GiTriangle, GiVec3 } from '../../packages/core/src/gi/scene-data.js';
import { createGiScene } from '../../packages/core/src/gi/scene-data.js';
import { createReflectionScene } from '../../packages/core/src/reflections/reflection-scene.js';
import type { ReflectionSceneOptions } from '../../packages/core/src/reflections/reflection-scene.js';
import { createIntegratedScene } from '../../packages/core/src/integrated/integrated-scene.js';
import { assertConservativeContainment, conservativeNodeReference, generatedTraceProxy, referenceUpdateTriangles } from '../helpers/gi-trace-update-reference.js';

const arrays = (data: GiTraceData): readonly ArrayBuffer[] =>
  [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData];
const clone = (data: GiTraceData): GiTraceData => ({ ...data, nodeData: data.nodeData.slice(0), triangleData: data.triangleData.slice(0),
  boxData: data.boxData.slice(0), materialData: data.materialData.slice(0), uniformData: data.uniformData.slice(0) });
function equalBytes(a: ArrayBuffer, b: ArrayBuffer, label = 'packed bytes'): void {
  expect(a.byteLength, label).toBe(b.byteLength);
  const actual = new Uint8Array(a), expected = new Uint8Array(b);
  const first = actual.findIndex((value, i) => value !== expected[i]);
  expect(first === -1 ? null : { offset: first, actual: actual[first], expected: expected[first] }, label).toBeNull();
}
function equalData(a: GiTraceData, b: GiTraceData): void {
  arrays(a).forEach((buffer, i) => equalBytes(buffer, arrays(b)[i]!, `buffer ${i}`));
}
function oracle(data: GiTraceData, scene: GiSceneData): GiTraceData {
  const expected = clone(data); refitGiTraceData(expected, scene);
  new Uint8Array(expected.nodeData).set(new Uint8Array(conservativeNodeReference(expected, referenceUpdateTriangles(scene, expected.staticTriangles))));
  return expected;
}
function gpuFixture(data: GiTraceData) {
  const physical = arrays(data).map((source, index) => ({ index, size: source.byteLength, bytes: source.slice(0), destroys: 0,
    destroy() { this.destroys++; } }));
  const calls: { index: number; offset: number; sourceOffset: number; bytes: ArrayBuffer; returned: boolean }[] = [];
  let failureCall = -1;
  const queue = { writeBuffer(buffer: typeof physical[number], offset: number, source: ArrayBuffer, sourceOffset: number, size: number) {
    const call = { index: buffer.index, offset, sourceOffset, bytes: source.slice(sourceOffset, sourceOffset + size), returned: false };
    calls.push(call);
    if (calls.length - 1 === failureCall) throw Error('injected write failure');
    new Uint8Array(buffer.bytes).set(new Uint8Array(call.bytes), offset); call.returned = true;
  } };
  return { queue: queue as unknown as GPUQueue, buffers: physical as unknown as readonly GPUBuffer[], physical, calls,
    failAfterReturned(count: number) { failureCall = calls.length + count; }, recover() { failureCall = -1; },
    assertCurrent(expected: GiTraceData) { physical.forEach((buffer, i) => equalBytes(buffer.bytes, arrays(expected)[i]!, `physical buffer ${i}`)); } };
}
const changes: readonly ReflectionSceneOptions[] = [{}, { objectOffset: -.4 }, { objectOffset: .4 }, {}, { doorOpen: false }, {},
  { wallColor: 'neutral' }, { wallColor: 'neutral', roughness: .3 }, { wallColor: 'neutral', roughness: .3, lightIntensity: 0 },
  { wallColor: 'neutral', roughness: .3, lightIntensity: 2 }, { objectOffset: -.4, doorOpen: false, roughness: .08 }, {}, {}];

describe('full trace performance control using the production numerical policy', () => {
  it('corrects initial bounds before uploads, preserves five array identities and excludes creation work', () => {
    const scene = createReflectionScene(), data = buildGiTraceData(scene), original = clone(data);
    const identities = arrays(data), order = data.triangleOrder, persistent = data.staticTriangles;
    const full = new FullTraceUpdater(data), candidateData = clone(original), candidate = new IncrementalUpdater(candidateData);
    equalData(data, candidateData); equalData(data, oracle(original, scene));
    arrays(data).forEach((buffer, i) => expect(buffer).toBe(identities[i]));
    expect(data.triangleOrder).toBe(order); expect(data.staticTriangles).toBe(persistent); expect(data.scene).toBe(scene);
    const numericBytes = 8 * (8 * data.boxCount + 8 * data.materialCount + 6);
    expect(full.telemetry).toEqual({ updateCount: 0, queuedUpdateCount: 0, changedBoxCount: 0, regeneratedTriangleCount: 0,
      packedTriangleCount: 0, refitLeafCount: 0, refitAncestorCount: 0, attemptedWriteCalls: 0, queuedWriteCalls: 0,
      queuedUploadBytes: 0, fullBufferFallbackCount: 0, pendingRangeCount: 0, pendingUploadBytes: 0,
      metadataBytes: data.gpuBufferBytes + 2 * numericBytes + data.boxCount + 4 });
    const gpu = gpuFixture(data); expect(full.flush(gpu.queue, gpu.buffers)).toEqual({ uploadBytes: 0, writeCalls: 0 });
    expect(gpu.calls).toHaveLength(0); full.dispose(); candidate.dispose();
  });

  it('exactly matches incremental arrays, source IDs and independent bounds through all frozen supported reflection edits', () => {
    const initial = createReflectionScene(), source = buildGiTraceData(initial), data = clone(source), candidateData = clone(source);
    const full = new FullTraceUpdater(data), candidate = new IncrementalUpdater(candidateData), gpu = gpuFixture(data);
    const identity = arrays(data), order = data.triangleOrder, nodes = new DataView(source.nodeData), metadata = full.telemetry.metadataBytes;
    for (const input of changes) {
      const scene = createReflectionScene(input); full.update(scene); candidate.update(scene);
      equalData(data, candidateData); equalData(data, oracle(source, scene));
      assertConservativeContainment(data, referenceUpdateTriangles(scene));
      arrays(data).forEach((buffer, i) => expect(buffer).toBe(identity[i])); expect(data.triangleOrder).toBe(order);
      const actualNodes = new DataView(data.nodeData), triangles = new DataView(data.triangleData);
      for (let id = 0; id < data.nodeCount; id++) for (const offset of [12, 28]) expect(actualNodes.getUint32(id * 32 + offset, true)).toBe(nodes.getUint32(id * 32 + offset, true));
      for (let slot = 0; slot < data.triangleCount; slot++) expect(triangles.getUint32(slot * 64 + 44, true)).toBe(order[slot]);
      const pending = full.telemetry.pendingRangeCount, result = full.flush(gpu.queue, gpu.buffers);
      expect(result).toEqual(pending ? { uploadBytes: data.gpuBufferBytes, writeCalls: 5 } : { uploadBytes: 0, writeCalls: 0 });
      gpu.assertCurrent(data); expect(full.telemetry.queuedUpdateCount).toBe(full.telemetry.updateCount);
      expect(full.telemetry.metadataBytes).toBe(metadata); expect(full.telemetry.fullBufferFallbackCount).toBe(0);
    }
    full.dispose(); candidate.dispose();
  });

  it('preserves the generated 2048-triangle persistent source and mixed leaves across full integrated targets', () => {
    const initial = createIntegratedScene(), source = buildGiTraceData(initial, generatedTraceProxy()), data = clone(source), other = clone(source);
    const full = new FullTraceUpdater(data), candidate = new IncrementalUpdater(other), sourceWords = new DataView(source.triangleData);
    const persistent = data.staticTriangles, originalTriangleBytes = source.triangleData;
    for (const options of [{ objectOffset: .4 }, { doorOpen: false, wallColor: 'neutral' as const, lightIntensity: 0 }, {}]) {
      const scene = createIntegratedScene(options); full.update(scene); candidate.update(scene); equalData(data, other);
      assertConservativeContainment(data, referenceUpdateTriangles(scene, persistent)); expect(data.staticTriangles).toBe(persistent);
      for (let slot = 0; slot < data.triangleCount; slot++) if (sourceWords.getUint32(slot * 64 + 28, true) === 0xfffffffe) {
        equalBytes(data.triangleData.slice(slot * 64, slot * 64 + 64), originalTriangleBytes.slice(slot * 64, slot * 64 + 64));
      }
    }
    full.dispose(); candidate.dispose();
  });

  it('records one full maintenance pass and exact retained capacity for the canonical-sized generated fixture', () => {
    // The synthetic tilted plane has canonical counts; it is not the external terrain asset.
    const data = buildGiTraceData(createIntegratedScene(), generatedTraceProxy()), full = new FullTraceUpdater(data), gpu = gpuFixture(data);
    expect([data.boxCount, data.materialCount, data.triangleCount, data.nodeCount, data.gpuBufferBytes]).toEqual([13, 6, 2204, 1335, 184640]);
    expect(full.telemetry.metadataBytes).toBe(187185);
    full.update(createIntegratedScene({ objectOffset: .4 }));
    expect(full.telemetry).toMatchObject({ updateCount: 1, queuedUpdateCount: 0, changedBoxCount: 1,
      regeneratedTriangleCount: 156, packedTriangleCount: 2204, refitLeafCount: 668, refitAncestorCount: 667,
      pendingRangeCount: 5, pendingUploadBytes: 184640, fullBufferFallbackCount: 0, metadataBytes: 187185 });
    expect(full.flush(gpu.queue, gpu.buffers)).toEqual({ uploadBytes: 184640, writeCalls: 5 });
    expect(full.telemetry).toMatchObject({ attemptedWriteCalls: 5, queuedWriteCalls: 5, queuedUploadBytes: 184640, queuedUpdateCount: 1 });
    equalData(data, oracle(data, data.scene)); gpu.assertCurrent(data);
    full.dispose(); expect(full.telemetry.metadataBytes).toBe(0);
  });

  it('preserves all reserved words and initial topology while matching independent full packing', () => {
    const source = buildGiTraceData(createReflectionScene());
    const triangleWords = new Uint32Array(source.triangleData), boxWords = new Uint32Array(source.boxData);
    for (let slot = 0; slot < source.triangleCount; slot++) triangleWords[slot * 16 + 15] = (0xa5a50000 | slot) >>> 0;
    for (let box = 0; box < source.boxCount; box++) { boxWords[box * 12 + 10] = 0x7fc00001 + box; boxWords[box * 12 + 11] = 0x80000000 + box; }
    const data = clone(source), other = clone(source), full = new FullTraceUpdater(data), incremental = new IncrementalUpdater(other);
    for (const options of [{ objectOffset: .4, doorOpen: false }, { wallColor: 'neutral' as const }, {}]) {
      const scene = createReflectionScene(options); full.update(scene); incremental.update(scene);
      equalData(data, other); equalData(data, oracle(source, scene));
      for (let slot = 0; slot < data.triangleCount; slot++) expect(new Uint32Array(data.triangleData)[slot * 16 + 15]).toBe(triangleWords[slot * 16 + 15]);
      for (let box = 0; box < data.boxCount; box++) for (const word of [10, 11]) {
        expect(new Uint32Array(data.boxData)[box * 12 + word]).toBe(boxWords[box * 12 + word]);
      }
    }
    full.dispose(); incremental.dispose();
  });

  it('includes tiny mathematical endpoint terms and keeps signed-zero source words unchanged', () => {
    for (const sign of [-1, 1]) {
      const p0: GiVec3 = [sign * 2 ** -100, 0, -0], p1: GiVec3 = [sign, 1, 0], p2: GiVec3 = [sign * 2 ** -100, 0, 1];
      const n = [1, -sign, 0], length = Math.hypot(...n);
      const triangle: GiTriangle = { id: 0, boxId: 0xfffffffe, materialId: 0, p0, p1, p2, normal: n.map(v => Math.fround(v / length)) as unknown as GiVec3 };
      const source = buildGiTraceData(createGiScene(), [triangle]), data = clone(source), other = clone(source);
      const full = new FullTraceUpdater(data), candidate = new IncrementalUpdater(other); equalData(data, other);
      equalBytes(data.triangleData, source.triangleData); assertConservativeContainment(data, referenceUpdateTriangles(data.scene, data.staticTriangles));
      full.dispose(); candidate.dispose();
    }
  });

  it('encloses cancellation and extreme exponent-gap endpoints after changed targets', () => {
    for (const [origin, end] of [[1, 2 ** -25], [-1, -(2 ** -25)], [2 ** -100, 1], [-(2 ** -100), -1],
      [999.9999389648438, -999.9999389648438], [-999.9999389648438, 999.9999389648438]]) {
      const p0: GiVec3 = [origin!, 0, -0], p1: GiVec3 = [end!, 1, 0], p2: GiVec3 = [origin!, 0, 1];
      const edgeX = end! - origin!, length = Math.hypot(1, edgeX);
      const triangle: GiTriangle = { id: 0, boxId: 0xfffffffe, materialId: 0, p0, p1, p2,
        normal: [Math.fround(1 / length), Math.fround(-edgeX / length), 0] };
      const initial = buildGiTraceData(createGiScene(), [triangle]), data = clone(initial), other = clone(initial);
      const full = new FullTraceUpdater(data), candidate = new IncrementalUpdater(other);
      for (const options of [{ doorOpen: false }, { lightIntensity: 0 }, {}]) {
        const scene = createGiScene(options); full.update(scene); candidate.update(scene);
        equalData(data, other); equalData(data, oracle(initial, scene));
        assertConservativeContainment(data, referenceUpdateTriangles(scene, data.staticTriangles));
      }
      full.dispose(); candidate.dispose();
    }
  });

  it('matches independent node enclosures and all production bytes for 32 fixed-seed valid transform targets', () => {
    const initial = createIntegratedScene(), source = buildGiTraceData(initial, generatedTraceProxy().slice(0, 32));
    const data = clone(source), other = clone(source), full = new FullTraceUpdater(data), candidate = new IncrementalUpdater(other);
    let seed = 0x20200906;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let step = 0; step < 32; step++) {
      const scene: GiSceneData = { ...initial, boxes: initial.boxes.map(box => ({ ...box,
        center: [random() * 24 - 12, random() * 8 - 3, random() * 24 - 12],
        halfSize: [.01 + random() * 2, .01 + random() * 2, .01 + random() * 2], yaw: random() * Math.PI * 4 - Math.PI * 2,
        materialId: Math.floor(random() * initial.materials.length) })) };
      full.update(scene); candidate.update(scene); equalData(data, other); equalData(data, oracle(source, scene));
      expect(full.telemetry.updateCount).toBe(step + 1);
      assertConservativeContainment(data, referenceUpdateTriangles(scene, data.staticTriangles));
    }
    full.dispose(); candidate.dispose();
  });

  it('always does honest full work for a material or light change, while equivalent numeric targets do nothing', () => {
    const scene = createReflectionScene(), data = buildGiTraceData(scene), full = new FullTraceUpdater(data), gpu = gpuFixture(data);
    const original = { ...full.telemetry }; full.update(createReflectionScene()); expect(full.telemetry).toEqual(original);
    const nodes = new DataView(data.nodeData); let leaves = 0;
    for (let id = 0; id < data.nodeCount; id++) if (nodes.getUint32(id * 32 + 28, true)) leaves++;
    for (const [i, options] of [{ roughness: .3 }, { roughness: .3, lightIntensity: 0 }].entries()) {
      full.update(createReflectionScene(options)); expect(full.telemetry).toMatchObject({ updateCount: i + 1,
        regeneratedTriangleCount: (i + 1) * 12 * data.boxCount, packedTriangleCount: (i + 1) * data.triangleCount,
        refitLeafCount: (i + 1) * leaves, refitAncestorCount: (i + 1) * (data.nodeCount - leaves),
        changedBoxCount: 0, pendingRangeCount: 5, pendingUploadBytes: data.gpuBufferBytes });
      const before = gpu.calls.length; expect(full.flush(gpu.queue, gpu.buffers)).toEqual({ uploadBytes: data.gpuBufferBytes, writeCalls: 5 });
      expect(gpu.calls.slice(before).map(call => [call.index, call.offset, call.sourceOffset, call.bytes.byteLength]))
        .toEqual(arrays(data).map((buffer, index) => [index, 0, 0, buffer.byteLength]));
      gpu.assertCurrent(data);
    }
    full.dispose();
  });

  it.each([0, 1, 4])('retains whole pending target after %i successful prefix writes, a newer target, retry and reversal', returned => {
    const initial = createReflectionScene(), data = buildGiTraceData(initial), full = new FullTraceUpdater(data), gpu = gpuFixture(data);
    const initialBytes = arrays(data).map(buffer => buffer.slice(0)); full.update(createReflectionScene({ objectOffset: -.4, wallColor: 'neutral' }));
    const firstTarget = arrays(data).map(buffer => buffer.slice(0)); gpu.failAfterReturned(returned);
    expect(() => full.flush(gpu.queue, gpu.buffers)).toThrow('injected write failure');
    gpu.physical.forEach((buffer, i) => equalBytes(buffer.bytes, i < returned ? firstTarget[i]! : initialBytes[i]!, 'accepted physical prefix'));
    expect(full.telemetry).toMatchObject({ updateCount: 1, queuedUpdateCount: 0, attemptedWriteCalls: returned + 1,
      queuedWriteCalls: returned, queuedUploadBytes: firstTarget.slice(0, returned).reduce((sum, buffer) => sum + buffer.byteLength, 0),
      pendingRangeCount: 5, pendingUploadBytes: data.gpuBufferBytes });
    full.update(createReflectionScene({ doorOpen: false, objectOffset: .4, lightIntensity: 0 }));
    expect(full.telemetry).toMatchObject({ updateCount: 2, queuedUpdateCount: 0, pendingRangeCount: 5 });
    gpu.recover(); expect(full.flush(gpu.queue, gpu.buffers)).toEqual({ uploadBytes: data.gpuBufferBytes, writeCalls: 5 }); gpu.assertCurrent(data);
    expect(full.telemetry).toMatchObject({ updateCount: 2, queuedUpdateCount: 2, pendingRangeCount: 0 });
    full.update(initial); full.flush(gpu.queue, gpu.buffers); gpu.assertCurrent(data);
    arrays(data).forEach((buffer, i) => equalBytes(buffer, initialBytes[i]!));
    expect(full.telemetry.attemptedWriteCalls).toBe(gpu.calls.length);
    expect(full.telemetry.queuedWriteCalls).toBe(gpu.calls.filter(call => call.returned).length);
    expect(full.telemetry.queuedUploadBytes).toBe(gpu.calls.filter(call => call.returned).reduce((sum, call) => sum + call.bytes.byteLength, 0));
    full.dispose();
  });

  it('retains disabled edits without writes and does not reupload a successful flush after encoder cancellation', () => {
    const data = buildGiTraceData(createReflectionScene()), full = new FullTraceUpdater(data), gpu = gpuFixture(data);
    for (const [i, objectOffset] of [.2, -.4, .4].entries()) {
      full.update(createReflectionScene({ objectOffset }));
      expect(full.telemetry).toMatchObject({ updateCount: i + 1, queuedUpdateCount: 0, pendingRangeCount: 5, queuedWriteCalls: 0 });
    }
    expect(gpu.calls).toHaveLength(0); full.flush(gpu.queue, gpu.buffers); gpu.assertCurrent(data);
    const queued = { ...full.telemetry }; // Discarding an encoder does not roll back queue writes.
    expect(full.flush(gpu.queue, gpu.buffers)).toEqual({ uploadBytes: 0, writeCalls: 0 }); expect(full.telemetry).toEqual(queued);
    full.dispose();
  });

  it('owns accepted numeric snapshots when the same caller object is mutated later', () => {
    const scene = structuredClone(createReflectionScene()), data = buildGiTraceData(scene), full = new FullTraceUpdater(data), gpu = gpuFixture(data);
    const box = scene.boxes[12]!; (box.center as unknown as number[])[2]! += .2;
    full.update(scene); expect(full.telemetry.updateCount).toBe(1); full.flush(gpu.queue, gpu.buffers);
    (box.center as unknown as number[])[2]! -= .4; (scene.light.radiance as unknown as number[])[0] = 0;
    full.update(scene); expect(full.telemetry).toMatchObject({ updateCount: 2, queuedUpdateCount: 1, pendingRangeCount: 5 });
    full.flush(gpu.queue, gpu.buffers); gpu.assertCurrent(data); equalData(data, oracle(data, scene));
    full.dispose();
  });

  it('rejects invalid targets and GPU buffer lists without changing canonical bytes, queued target or pending work', () => {
    const scene = createReflectionScene(), data = buildGiTraceData(scene), full = new FullTraceUpdater(data), gpu = gpuFixture(data);
    const valid = createReflectionScene({ objectOffset: .4 }); full.update(valid);
    const before = clone(data), state = { ...full.telemetry }, receipt = data.scene;
    const invalid: GiSceneData[] = [
      { ...scene, boxes: scene.boxes.slice(1) },
      { ...scene, boxes: scene.boxes.map((box, i) => i === 12 ? { ...box, center: [NaN, 0, 0] } : box) },
      { ...scene, materials: scene.materials.map((material, i) => i === 1 ? { ...material, emission: [0, -1, 0] } : material) },
      { ...scene, light: { ...scene.light, direction: [0, 0, 0] } },
    ];
    for (const input of invalid) {
      expect(() => full.update(input)).toThrow(); equalData(data, before);
      expect(data.scene).toBe(receipt); expect(full.telemetry).toEqual(state);
    }
    expect(() => full.flush(gpu.queue, gpu.buffers.slice(1))).toThrow(); expect(gpu.calls).toHaveLength(0); expect(full.telemetry).toEqual(state);
    expect(() => full.flush(gpu.queue, new Array<GPUBuffer>(5))).toThrow(); expect(gpu.calls).toHaveLength(0); expect(full.telemetry).toEqual(state);
    full.update(valid); expect(full.telemetry).toEqual(state); full.flush(gpu.queue, gpu.buffers); gpu.assertCurrent(data); full.dispose();
  });

  it('preserves signed-zero distinctions in numeric target comparison', () => {
    const scene = createGiScene(), data = buildGiTraceData(scene), full = new FullTraceUpdater(data), candidateData = clone(data), candidate = new IncrementalUpdater(candidateData);
    const next = { ...scene, boxes: scene.boxes.map((box, i) => i === 0 ? { ...box, yaw: -0 } : box) };
    full.update(next); candidate.update(next); equalData(data, candidateData);
    expect(full.telemetry.updateCount).toBe(1); expect(candidate.telemetry.updateCount).toBe(1); expect(full.telemetry.pendingRangeCount).toBe(5);
    full.dispose(); candidate.dispose();
  });

  it('writes all five buffers for a changed binary64 target even when its packed f32 source is identical', () => {
    const scene = createReflectionScene(), data = buildGiTraceData(scene), full = new FullTraceUpdater(data), gpu = gpuFixture(data), before = clone(data);
    const next = { ...scene, boxes: scene.boxes.map((box, i) => i === 12
      ? { ...box, center: [box.center[0] + 2 ** -40, box.center[1], box.center[2]] as GiVec3 } : box) };
    full.update(next); equalData(data, before);
    expect(full.telemetry).toMatchObject({ updateCount: 1, changedBoxCount: 0, pendingRangeCount: 5 });
    expect(full.flush(gpu.queue, gpu.buffers)).toEqual({ uploadBytes: data.gpuBufferBytes, writeCalls: 5 });
    gpu.assertCurrent(data); full.dispose();
  });

  it('releases retained metadata, blocks reuse and never destroys externally owned GPU buffers', () => {
    const data = buildGiTraceData(createReflectionScene()), full = new FullTraceUpdater(data), gpu = gpuFixture(data);
    full.update(createReflectionScene({ objectOffset: .4 })); const counts = { ...full.telemetry };
    full.dispose(); full.dispose();
    expect(full.telemetry).toEqual({ ...counts, metadataBytes: 0, pendingRangeCount: 0, pendingUploadBytes: 0 });
    expect(() => full.update(data.scene)).toThrow(/disposed/); expect(() => full.flush(gpu.queue, gpu.buffers)).toThrow(/disposed/);
    expect(gpu.physical.every(buffer => buffer.destroys === 0)).toBe(true); expect(gpu.calls).toHaveLength(0);
  });

  it('rejects malformed initial topology without publishing a partial correction', () => {
    for (const damage of [(data: GiTraceData) => new DataView(data.nodeData).setUint32(12, 0, true),
      (data: GiTraceData) => new DataView(data.triangleData).setUint32(44, data.triangleCount, true)]) {
      const data = buildGiTraceData(createReflectionScene()); damage(data); const before = clone(data);
      expect(() => new FullTraceUpdater(data)).toThrow(); equalData(data, before);
    }
  });

  it('has no incremental updater, independent oracle or GPU diagnostic dependency in its browser bundle', async () => {
    const result = await build({ entryPoints: ['tests/helpers/full-trace-performance-updater.ts'], bundle: true, write: false,
      platform: 'browser', format: 'esm', target: 'es2022', metafile: true });
    const paths = Object.keys(result.metafile!.inputs);
    expect(paths).not.toContain('packages/core/src/gi/trace-updates.ts');
    expect(paths.some(path => /gi-trace-update-reference|full-trace-updater|trace-update-proof-gpu|trace-update-write-validation/.test(path))).toBe(false);
    const module = readFileSync(new URL('../helpers/full-trace-performance-updater.ts', import.meta.url), 'utf8');
    expect(module).not.toMatch(/import[^;]*(?:gi-trace-update-reference|trace-updates|full-trace-updater)/);
    expect(result.outputFiles[0]!.text).not.toMatch(/\bBigInt\s*\(|\b\d+n\b|\bbruteUpdateOracle\b|\bconservativeNodeReference\b|\brefitGiTraceData\b/);
  });
});
