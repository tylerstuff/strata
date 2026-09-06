import { buildGiTraceData, packGiRays } from '../../packages/core/src/gi/trace-data.js';
import type { GiRay, GiTraceData } from '../../packages/core/src/gi/trace-data.js';
import type { GiSceneData, GiTriangle, GiVec3 } from '../../packages/core/src/gi/scene-data.js';
import { GiTraceUpdater } from '../../packages/core/src/gi/trace-updates.js';
import { giTraceShader } from '../../packages/core/src/gi/trace-shaders.js';
import { createIntegratedScene } from '../../packages/core/src/integrated/integrated-scene.js';
import type { ReflectionSceneOptions } from '../../packages/core/src/reflections/reflection-scene.js';
import { GiTraceUpdater as FullTraceUpdater } from '../helpers/full-trace-updater.js';
import { analyticBoxUpdateOracle, assertConservativeContainment, bruteUpdateOracle, dirtyTopology,
  generatedTraceProxy, referenceUpdateTriangles, updateOracleGates } from '../helpers/gi-trace-update-reference.js';
import { assertBytesEqual, proofDeadline, readBuffer } from './trace-update-proof-gpu.js';

export const traceWriteReadbackLayouts = Object.freeze({
  byteOrder: 'little-endian', sourceOrder: ['nodes', 'triangles', 'boxes', 'materials', 'uniform'],
  sourceStrides: [32, 64, 48, 32, 48], canonicalSourceCounts: [1335, 2204, 13, 6, 1],
  canonicalSourceBytes: [42720, 141056, 624, 192, 48], sourcePadding: 'All bytes defined and compared; no bytes stripped.',
  rays: { count: 512, stride: 32, bytes: 16384, origin: 0, tMin: 12, direction: 16, tMax: 28 },
  hits: { count: 512, stride: 48, bytes: 24576, distance: 0, sourceId: 4, materialId: 8, boxId: 12,
    normal: 16, status: 28, nodeVisits: 32, primitiveTests: 36, steps: 40, padding: 44 },
  hitPadding: 'Final u32 is defined zero by function-scope WGSL initialization and compared explicitly.',
  syntheticFallback: 'Uses the same source strides; record counts/byte sizes come from its separately labelled source.',
});
export const traceWriteRaySha256 = '95540b1eaeb1468a89c622cab00f87e07d544c2bf55d4f432e076a24f26e06d7';
export const traceWriteStates: readonly ReflectionSceneOptions[] = Object.freeze([
  {}, { objectOffset: -.4 }, { objectOffset: .4 }, {}, { doorOpen: false }, {}, { wallColor: 'neutral' },
  { wallColor: 'neutral', roughness: .3 }, { wallColor: 'neutral', roughness: .3, lightIntensity: 0 },
  { wallColor: 'neutral', roughness: .3, lightIntensity: 2 },
  { objectOffset: -.4, doorOpen: false, wallColor: 'red', lightIntensity: 1, roughness: .08 }, {}, {},
].map(Object.freeze));
export const traceWriteQueryStates: readonly ReflectionSceneOptions[] = Object.freeze(
  [0, 1, 2, 4, 6, 8, 10, 11].map(index => traceWriteStates[index]!),
);
export const traceWriteReportedSourceInterval = Object.freeze({
  source: 'Independent plane distance must lie within each ray endpoint expanded only by the existing absolute-plus-relative distance gate evaluated at that endpoint.',
  returned: 'The actual GPU hit distance must lie in the strict closed [tMin,tMax] interval, including boundary cases.',
  absolute: updateOracleGates.distanceAbsolute, relative: updateOracleGates.distanceRelative,
});
export const traceWriteCanonicalWrites = Object.freeze([
  { buffer: 0, offset: 10752, bytes: 32 }, { buffer: 0, offset: 18336, bytes: 32 }, { buffer: 0, offset: 18400, bytes: 32 },
  { buffer: 1, offset: 35072, bytes: 192 }, { buffer: 1, offset: 59456, bytes: 64 }, { buffer: 1, offset: 59968, bytes: 512 },
  { buffer: 2, offset: 576, bytes: 48 },
]);
export const traceWriteQueryShader = giTraceShader({ group: 0 }) + /* wgsl */ `
@group(1) @binding(0) var<storage, read> proofRays: array<GiRay>;
@group(1) @binding(1) var<storage, read_write> proofHits: array<GiTraceHit>;
@compute @workgroup_size(64) fn closest(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < 512u) { proofHits[id.x] = giTraceBvh(proofRays[id.x]); }
}
@compute @workgroup_size(64) fn any(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < 512u) { proofHits[id.x] = giTraceAnyBvh(proofRays[id.x]); }
}`;

const failureTarget: ReflectionSceneOptions = { objectOffset: -.4, doorOpen: false, wallColor: 'neutral', lightIntensity: 0 };
const retryTarget: ReflectionSceneOptions = { objectOffset: .4, doorOpen: true, wallColor: 'red', lightIntensity: 2 };
const arrays = (d: GiTraceData): readonly ArrayBuffer[] => [d.nodeData, d.triangleData, d.boxData, d.materialData, d.uniformData];
const clone = (d: GiTraceData): GiTraceData => ({ ...d, nodeData: d.nodeData.slice(0), triangleData: d.triangleData.slice(0),
  boxData: d.boxData.slice(0), materialData: d.materialData.slice(0), uniformData: d.uniformData.slice(0) });
function check(condition: unknown, label: string): asserts condition { if (!condition) throw Error(label); }
const category = (id: number) => id < 256 ? 'broad' : id < 384 ? 'rigid' : id < 448 ? 'terrain' : 'mirror';
const unitDot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, x, i) => sum + x * b[i]!, 0) / Math.hypot(...a);
const tolerance = (distance: number) => updateOracleGates.distanceAbsolute + updateOracleGates.distanceRelative * Math.abs(distance);
function viewBytes(input: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
  return input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
}
async function digest(input: ArrayBuffer | ArrayBufferView): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', viewBytes(input)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
function base64(input: ArrayBuffer | ArrayBufferView): string {
  const bytes = viewBytes(input); let result = ''; for (let i = 0; i < bytes.length; i += 16384) result += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(result);
}

/** Source-only classification: it never consumes the returned GPU distance/normal.
 * Near-edge bands are bounded on BOTH sides; an arbitrarily outside primitive
 * cannot be labelled boundary merely because one barycentric weight is negative. */
export function classifyReportedTriangle(ray: GiRay, t: GiTriangle) {
  const sub = (a: GiVec3, b: GiVec3) => a.map((x, i) => x - b[i]!);
  const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
  const e = sub(t.p1, t.p0), f = sub(t.p2, t.p0), n = [e[1]! * f[2]! - e[2]! * f[1]!, e[2]! * f[0]! - e[0]! * f[2]!, e[0]! * f[1]! - e[1]! * f[0]!];
  const den = dot(n, ray.direction), cosine = Math.abs(den) / Math.hypot(...n);
  if (!Number.isFinite(cosine) || den === 0) return { distance: null, weights: null, boundary: true, admissible: false, cosine };
  const distance = dot(n, sub(t.p0, ray.origin)) / den;
  const q = ray.origin.map((x, i) => x + ray.direction[i]! * distance - t.p0[i]!);
  const a = dot(e, e), b = dot(e, f), c = dot(f, f), d = dot(q, e), g = dot(q, f), determinant = a * c - b * b;
  const u = (c * d - b * g) / determinant, v = (a * g - b * d) / determinant, weights = [1 - u - v, u, v];
  const band = updateOracleGates.barycentricMargin;
  // Edge/parallel classification never excuses a primitive beyond the segment.
  // The source and packed triangle may differ only within the already-frozen
  // distance gate; evaluate its allowance at each fixed endpoint, not the hit.
  const inInterval = Number.isFinite(distance) && distance >= ray.tMin - tolerance(ray.tMin)
    && distance <= ray.tMax + tolerance(ray.tMax);
  const admissible = inInterval && weights.every(w => Number.isFinite(w) && w >= -band && w <= 1 + band);
  const boundary = cosine < updateOracleGates.parallelCosine || weights.some(w => Math.abs(w) < band || Math.abs(w - 1) < band);
  return { distance, weights, boundary, admissible, inInterval, cosine };
}

export type TraceProofFullControlId = 'full-correctness-only' | 'full-performance';
export function traceWriteControlId(value: unknown): TraceProofFullControlId {
  check(value === 'full-correctness-only' || value === 'full-performance', 'Unknown frozen full-control identity.');
  return value;
}

/** Pure CPU dry plan. Runner must serialize/hash this before requesting a GPU window. */
export function traceWriteFailurePlan(staticTriangles: readonly GiTriangle[], selectedControl: TraceProofFullControlId = 'full-correctness-only') {
  const fullControl = traceWriteControlId(selectedControl);
  const initial = buildGiTraceData(createIntegratedScene(), staticTriangles);
  return [GiTraceUpdater, FullTraceUpdater].map((Constructor, arm) => {
    const data = clone(initial), updater = new Constructor(data), writes: { buffer: number; offset: number; bytes: number }[] = [];
    try {
      updater.update(createIntegratedScene(failureTarget));
      const buffers = arrays(data).map((a, id) => ({ id, size: a.byteLength }));
      updater.flush({ writeBuffer(target: { id: number }, offset: number, _source: ArrayBuffer, _sourceOffset: number, bytes: number) {
        writes.push({ buffer: target.id, offset, bytes });
      } } as unknown as GPUQueue, buffers as unknown as GPUBuffer[]);
      check(writes.length >= 2, 'Failure plan needs at least two writes.');
      return { arm: arm === 0 ? 'incremental' : fullControl, writes, failureIndices: [0, 1, writes.length - 1] };
    } finally { updater.dispose(); }
  });
}

interface WriteRecord { arm: string; step: string; targetVersion: number; buffer: number; bufferIdentity: number; offset: number;
  sourceOffsetBytes: number; bytes: number; dataBase64: string; returned: boolean; injected: boolean }
interface Arm { name: string; identity: number; bufferIdentities: number[]; data: GiTraceData; updater: GiTraceUpdater | FullTraceUpdater; buffers: GPUBuffer[];
  physical: Uint8Array[]; queue: GPUQueue; failIndex: number | null; attemptedInStep: number; step: string; writes: WriteRecord[]; disposed: boolean }

/** Stage A alone: actual native GPU sources, two maintenance paths and one query shader. */
export async function runTraceWriteValidation(device: GPUDevice, inputs: { staticTriangles: readonly GiTriangle[]; rays: readonly GiRay[] },
  onProgress?: (event: unknown) => Promise<void>, selectedControl: TraceProofFullControlId = 'full-correctness-only') {
  const fullControl = traceWriteControlId(selectedControl);
  const report = { status: 'running', stage: 'A-actual-trace-writes', correctnessOnly: true, fullControl, cases: [] as unknown[],
    writes: [] as WriteRecord[], readbacks: [] as unknown[], queries: [] as unknown[], failures: [] as unknown[],
    input: {} as Record<string, unknown>, cleanup: { createdBuffers: 0, destroyedBuffers: 0, liveArms: 0 } };
  const cursor = { cases: 0, writes: 0, readbacks: 0, queries: 0, failures: 0 }; let progressSequence = 0;
  const checkpoint = async (step: string) => {
    if (!onProgress) return;
    const event = { stage: report.stage, sequence: progressSequence++, step, status: report.status, input: report.input,
      cases: report.cases.slice(cursor.cases), writes: report.writes.slice(cursor.writes), readbacks: report.readbacks.slice(cursor.readbacks),
      queries: report.queries.slice(cursor.queries), failures: report.failures.slice(cursor.failures), cleanup: { ...report.cleanup } };
    await proofDeadline(onProgress(event), `Stage A progress ${step}`);
    for (const key of ['cases', 'writes', 'readbacks', 'queries', 'failures'] as const) cursor[key] = report[key].length;
  };
  const owned = new Set<GPUBuffer>(), arms = new Set<Arm>(); let nextIdentity = 0, nextArmIdentity = 0; const started = Date.now();
  const live = () => check(Date.now() - started < 600000, 'Stage A exceeded its finite ten-minute deadline.');
  const makeBuffer = (descriptor: GPUBufferDescriptor) => { const b = device.createBuffer(descriptor); owned.add(b); report.cleanup.createdBuffers++; return b; };
  const destroy = (b: GPUBuffer) => { if (owned.delete(b)) { b.destroy(); report.cleanup.destroyedBuffers++; } };
  const makeArm = (name: string, data: GiTraceData, full: boolean): Arm => {
    const updater = full ? new FullTraceUpdater(data) : new GiTraceUpdater(data), buffers: GPUBuffer[] = [], physical = arrays(data).map(a => new Uint8Array(a.byteLength));
    const arm: Arm = { name, identity: nextArmIdentity++, bufferIdentities: [], data, updater, buffers, physical, queue: device.queue, failIndex: null, attemptedInStep: 0, step: 'initial-upload', writes: [], disposed: false };
    arms.add(arm); report.cleanup.liveArms++;
    const identities = arm.bufferIdentities;
    const queue = { writeBuffer(target: GPUBuffer, offset: number, src: ArrayBuffer | ArrayBufferView, dataOffset = 0, size?: number) {
      const index = buffers.indexOf(target); check(index >= 0, 'Unknown trace buffer in forwarding recorder.');
      const unit = ArrayBuffer.isView(src) ? ((src as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1) : 1;
      const source = viewBytes(src), sourceOffsetBytes = dataOffset * unit, byteCount = size === undefined ? source.length - sourceOffsetBytes : size * unit;
      const snapshot = source.slice(sourceOffsetBytes, sourceOffsetBytes + byteCount);
      check(snapshot.length === byteCount && offset % 4 === 0 && byteCount % 4 === 0 && offset + byteCount <= target.size, 'Invalid recorded write range.');
      const injected = arm.failIndex !== null && arm.attemptedInStep === arm.failIndex; arm.attemptedInStep++;
      const record: WriteRecord = { arm: name, step: arm.step, targetVersion: updater.telemetry.updateCount, buffer: index,
        bufferIdentity: identities[index]!, offset, sourceOffsetBytes, bytes: byteCount, dataBase64: base64(snapshot), returned: false, injected };
      arm.writes.push(record); report.writes.push(record);
      if (injected) throw Error('Injected trace write failure before native forwarding.');
      // Pass the original source and units, retaining the real queue receiver.
      device.queue.writeBuffer(target, offset, src as ArrayBuffer, dataOffset, size);
      record.returned = true; physical[index]!.set(snapshot, offset);
    } };
    arm.queue = queue as unknown as GPUQueue;
    arrays(data).forEach((a, i) => { const b = makeBuffer({ label: `Stage A ${name} trace data ${i}`, size: a.byteLength, usage: (i === 4 ? 0x40 : 0x80) | 0x8 | 0x4 }); buffers.push(b); identities.push(nextIdentity++); arm.queue.writeBuffer(b, 0, a); });
    return arm;
  };
  const pair = (scene: GiSceneData = createIntegratedScene(), persistent = inputs.staticTriangles) => {
    const initial = buildGiTraceData(scene, persistent); return [makeArm('incremental', clone(initial), false), makeArm(fullControl, clone(initial), true)] as const;
  };
  const release = (arm: Arm) => {
    if (arm.disposed) return; arm.disposed = true; arm.updater.dispose();
    report.cases.push({ step: 'dispose-arm', arm: arm.name, armIdentity: arm.identity, bufferIdentities: [...arm.bufferIdentities], telemetry: { ...arm.updater.telemetry } });
    arm.buffers.forEach(destroy); arms.delete(arm); report.cleanup.liveArms--;
    if (arm.updater.telemetry.metadataBytes !== 0 || arm.updater.telemetry.pendingRangeCount !== 0) {
      report.status = 'failed'; report.failures.push({ message: 'Disposed updater retained metadata/pending work.', armIdentity: arm.identity });
    }
  };
  const begin = (arm: Arm, step: string, failure: number | null = null) => { arm.step = step; arm.failIndex = failure; arm.attemptedInStep = 0; };
  const compareCpu = (a: Arm, b: Arm) => { arrays(a.data).forEach((x, i) => assertBytesEqual(x, arrays(b.data)[i]!, `CPU canonical buffer${i}`));
    check(a.data.triangleOrder.every((x, i) => x === b.data.triangleOrder[i]), 'Source-to-slot order changed.');
    assertConservativeContainment(a.data, referenceUpdateTriangles(a.data.scene, a.data.staticTriangles)); };
  const snapshot = async (arm: Arm, expectation: 'full-target' | 'accepted-prefix') => {
    live(); const actuals: ArrayBuffer[] = [];
    for (let i = 0; i < 5; i++) {
      const actual = await readBuffer(device, arm.buffers[i]!); actuals.push(actual);
      const expected = expectation === 'full-target' ? arrays(arm.data)[i]! : arm.physical[i]!;
      report.readbacks.push({ arm: arm.name, armIdentity: arm.identity, bufferIdentity: arm.bufferIdentities[i], step: arm.step, buffer: i, expectation, targetVersion: arm.updater.telemetry.updateCount,
        queuedVersion: arm.updater.telemetry.queuedUpdateCount, bytes: actual.byteLength, sha256: await digest(actual), dataBase64: base64(actual) });
      await checkpoint(`${arm.name}/${arm.step}/buffer${i}`);
      assertBytesEqual(actual, arm.physical[i]!, `${arm.name}/${arm.step}/forwarded-prefix${i}`);
      assertBytesEqual(actual, expected, `${arm.name}/${arm.step}/${expectation}${i}`);
    }
    return actuals;
  };
  const whole = async (p: readonly [Arm, Arm], step: string, scene: GiSceneData) => {
    for (const arm of p) { if (arm.step === 'initial-upload') await snapshot(arm, 'full-target'); begin(arm, step); arm.updater.update(scene); }
    compareCpu(...p); const states: unknown[] = [];
    for (const arm of p) { const before = { ...arm.updater.telemetry }, first = arm.writes.length, result = arm.updater.flush(arm.queue, arm.buffers);
      const written = arm.writes.slice(first); check(written.every(w => w.returned), 'Whole flush has unreturned write.');
      check(result.writeCalls === written.length && result.uploadBytes === written.reduce((s, w) => s + w.bytes, 0), 'Flush result differs from native forwarding.');
      const physical = await snapshot(arm, 'full-target'); states.push({ arm: arm.name, result, before, after: { ...arm.updater.telemetry }, hashes: await Promise.all(physical.map(digest)) }); }
    report.cases.push({ step, states }); await checkpoint(step);
  };
  try {
    check(inputs.staticTriangles.length === 2048 && inputs.rays.length === 512, 'Canonical proxy/ray count differs.');
    for (const ray of inputs.rays) check([...ray.origin, ...ray.direction, ray.tMin, ray.tMax].every(x => Number.isFinite(x) && Object.is(x, Math.fround(x))), 'Ray ABI must contain exact transferred f32 values.');
    const rayBytes = packGiRays(inputs.rays); check(await digest(rayBytes) === traceWriteRaySha256, 'Frozen ray ABI hash differs.');
    const failurePlan = traceWriteFailurePlan(inputs.staticTriangles, fullControl);
    report.input = { raySha256: traceWriteRaySha256, rayBytes: rayBytes.byteLength, rayCount: 512, staticTriangleCount: 2048,
      states: traceWriteStates, queryStates: traceWriteQueryStates, readbackLayouts: traceWriteReadbackLayouts, readbackOrdering: 'Copy submission and map complete before the next CPU source mutation; queued target version is sampled in that interval.', failureTarget, retryTarget, failurePlan, gates: updateOracleGates,
      reportedSourceInterval: traceWriteReportedSourceInterval };
    await checkpoint('frozen-inputs');
    // Fresh canonical gate is separate from the S0-S12 sequence.
    const canonical = pair(); await whole(canonical, 'fresh-canonical-plus-point4', createIntegratedScene({ objectOffset: .4 }));
    const fresh = canonical[0].writes.filter(w => w.step === 'fresh-canonical-plus-point4');
    check(JSON.stringify(fresh.map(({ buffer, offset, bytes }) => ({ buffer, offset, bytes }))) === JSON.stringify(traceWriteCanonicalWrites), 'Canonical exact912B/7-write plan differs.');
    const t = canonical[0].updater.telemetry;
    check(t.regeneratedTriangleCount === 12 && t.packedTriangleCount === 12 && t.refitLeafCount === 5 && t.refitAncestorCount === 19 && t.fullBufferFallbackCount === 0, 'Canonical fixed work counters differ.');
    check(fresh.reduce((s, w) => s + w.bytes, 0) === 912 && t.queuedUploadBytes === 912, 'Canonical traffic differs.'); canonical.forEach(release);
    const sequence = pair();
    for (const [id, state] of traceWriteStates.entries()) await whole(sequence, `S${id}`, createIntegratedScene(state));
    sequence.forEach(release);
    const material = pair();
    for (const [step, scene, buffer, bytes] of [
      ['no-op', createIntegratedScene(), -1, 0], ['roughness-only', createIntegratedScene({ roughness: .3 }), 3, 32],
      ['light-only', createIntegratedScene({ roughness: .3, lightIntensity: 0 }), 4, 48],
    ] as const) {
      const first = material[0].writes.length, before = { ...material[0].updater.telemetry }; await whole(material, step, scene);
      const writes = material[0].writes.slice(first); check(writes.reduce((s, w) => s + w.bytes, 0) === bytes && writes.every(w => w.buffer === buffer), `${step} write restriction failed.`);
      for (const key of ['regeneratedTriangleCount', 'packedTriangleCount', 'refitLeafCount', 'refitAncestorCount'] as const) check(material[0].updater.telemetry[key] === before[key], `${step} touched geometry work.`);
    }
    material.forEach(release);
    for (const failure of [0, 1, 2]) {
      const p = pair();
      for (const [index, arm] of p.entries()) {
        await snapshot(arm, 'full-target');
        begin(arm, `partial-${failure}`, failurePlan[index]!.failureIndices[failure]!); arm.updater.update(createIntegratedScene(failureTarget));
        const before = { ...arm.updater.telemetry }, first = arm.writes.length; let threw = false;
        try { arm.updater.flush(arm.queue, arm.buffers); } catch (error) { check(String(error).includes('Injected trace write failure'), 'Unexpected native failure.'); threw = true; }
        check(threw, 'Injected first/second/last failure was not reached.');
        const writes = arm.writes.slice(first), returned = writes.filter(w => w.returned);
        check(arm.updater.telemetry.attemptedWriteCalls - before.attemptedWriteCalls === writes.length, 'Attempted counter mismatch.');
        check(arm.updater.telemetry.queuedWriteCalls - before.queuedWriteCalls === returned.length, 'Returned counter mismatch.');
        check(arm.updater.telemetry.queuedUploadBytes - before.queuedUploadBytes === returned.reduce((s, w) => s + w.bytes, 0), 'Returned byte counter mismatch.');
        check(arm.updater.telemetry.queuedUpdateCount === before.queuedUpdateCount, 'Partial flush advanced queued target.');
        await snapshot(arm, 'accepted-prefix');
        report.cases.push({ step: arm.step, arm: arm.name, failureIndex: arm.failIndex, before, after: { ...arm.updater.telemetry } });
      }
      await whole(p, `retry-new-target-${failure}`, createIntegratedScene(retryTarget));
      await whole(p, `reverse-initial-${failure}`, createIntegratedScene());
      for (const arm of p) { const encoder = device.createCommandEncoder(); encoder.clearBuffer(arm.buffers[0]!, 0, 4); /* deliberately discard encoder */
        begin(arm, `discard-encoder-no-redundant-flush-${failure}`); const before = arm.writes.length, result = arm.updater.flush(arm.queue, arm.buffers);
        check(result.uploadBytes === 0 && result.writeCalls === 0 && arm.writes.length === before, 'Discarded encoding caused redundant trace upload.'); await snapshot(arm, 'full-target'); }
      p.forEach(release);
    }
    const base = createIntegratedScene(), fragmented: GiSceneData = { ...base, boxes: Array.from({ length: 66 }, (_, id) => ({ id, name: `fragment-box-${id}`,
      center: [id * 2 - 66, 50, 0] as GiVec3, halfSize: [.2, .2, .2] as GiVec3, yaw: 0, materialId: 1 })) };
    const fragmentation = pair(fragmented, generatedTraceProxy()), slots = dirtyTopology(fragmentation[0].data, fragmented.boxes.filter(b => b.id % 2 === 0).map(b => b.id)).slots;
    check(slots.filter((slot, i) => i === 0 || slot !== slots[i - 1]! + 1).length > 32, 'Fragmentation fixture did not exceed32 separated ranges.');
    const fragmentedNext = { ...fragmented, boxes: fragmented.boxes.map(b => b.id % 2 === 0 ? { ...b, materialId: 0 } : b) };
    const firstFragment = fragmentation[0].writes.length; await whole(fragmentation, 'synthetic-static-fragmentation', fragmentedNext);
    const fragmentWrites = fragmentation[0].writes.slice(firstFragment), fragmentData = fragmentation[0].data;
    check(JSON.stringify(fragmentWrites.map(({ buffer, offset, bytes }) => ({ buffer, offset, bytes }))) === JSON.stringify([
      { buffer: 1, offset: 0, bytes: fragmentData.triangleData.byteLength }, { buffer: 2, offset: 0, bytes: fragmentData.boxData.byteLength },
    ]), 'Full fragmented buffer fallback is not explicit.');
    check(fragmentation[0].updater.telemetry.fullBufferFallbackCount === 2 && fragmentData.staticTriangles.length * 64 === 131072, 'Static fallback byte accounting differs.');
    fragmentation.forEach(release);
    report.input.queryWgslSha256 = await digest(new TextEncoder().encode(traceWriteQueryShader));
    const module = device.createShaderModule({ label: 'Stage A unchanged production closest/any helpers', code: traceWriteQueryShader });
    const sourceLayout = device.createBindGroupLayout({ entries: Array.from({ length: 5 }, (_, binding) => ({ binding, visibility: 4,
      buffer: { type: binding === 4 ? 'uniform' as const : 'read-only-storage' as const } })) });
    const queryLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } }, { binding: 1, visibility: 4, buffer: { type: 'storage' } },
    ] });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [sourceLayout, queryLayout] });
    const pipelines = await proofDeadline(Promise.all(['closest', 'any'].map(entryPoint => device.createComputePipelineAsync({ layout, compute: { module, entryPoint } }))), 'closest/any pipeline compilation');
    const rayBuffer = makeBuffer({ label: 'Stage A frozen immutable512 rays', size: rayBytes.byteLength, usage: 0x80 | 0x8 }); device.queue.writeBuffer(rayBuffer, 0, rayBytes);
    const queryPair = pair();
    const outputBuffers = queryPair.map(arm => makeBuffer({ label: `Stage A ${arm.name} actual48-byte hits`, size: 512 * 48, usage: 0x80 | 0x4 }));
    const sourceGroups = queryPair.map(arm => device.createBindGroup({ layout: sourceLayout, entries: arm.buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    const queryGroups = outputBuffers.map(buffer => device.createBindGroup({ layout: queryLayout, entries: [
      { binding: 0, resource: { buffer: rayBuffer } }, { binding: 1, resource: { buffer } },
    ] }));
    type Worst = { value: number; state: number; ray: number; mode: string; sourceId: number };
    let maxDistance: Worst | null = null;
    let minNormal: Worst | null = null;
    for (const [stateId, state] of traceWriteQueryStates.entries()) {
      const scene = createIntegratedScene(state); await whole(queryPair, `query-source-${stateId}`, scene);
      const source = referenceUpdateTriangles(scene, inputs.staticTriangles), reference = inputs.rays.map(ray => bruteUpdateOracle(ray, source));
      let nonBoundary = 0, terrain = 0, mirror = 0, slabs = 0, yawedDoor = 0;
      reference.forEach((hit, id) => {
        if (!hit || !hit.boundary) nonBoundary++;
        if (hit && !hit.boundary && category(id) === 'terrain' && hit.triangle.boxId === 0xfffffffe) terrain++;
        if (hit && !hit.boundary && category(id) === 'mirror' && hit.triangle.boxId === scene.objectBoxId) mirror++;
        if (category(id) !== 'rigid' && category(id) !== 'mirror') return;
        const ray = inputs.rays[id]!, boxed = bruteUpdateOracle(ray, source.slice(0, scene.boxes.length * 12));
        if (boxed?.boundary) return;
        const slab = analyticBoxUpdateOracle(ray, scene); slabs++; check(Boolean(slab) === Boolean(boxed), 'Analytic slab/source existence differs.');
        if (slab && boxed) {
          check(slab.boxId === boxed.triangle.boxId && Math.abs(slab.distance - boxed.distance) <= tolerance(boxed.distance)
            && unitDot(slab.normal, boxed.triangle.normal) >= updateOracleGates.normalDot, 'Analytic slab/source geometry differs.');
          if (slab.boxId === scene.doorBoxId && scene.boxes[scene.doorBoxId]!.yaw !== 0) yawedDoor++;
        }
      });
      check(nonBoundary >= 384 && terrain >= 48 && mirror >= 16 && slabs >= 160, 'Frozen nonvacuity quotas were not exercised.');
      for (const [modeId, mode] of ['closest', 'any'].entries()) {
        const results: ArrayBuffer[] = [];
        for (const [armId, arm] of queryPair.entries()) {
          live(); const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass({ label: `Stage A ${mode}/${arm.name}` });
          pass.setPipeline(pipelines[modeId]!); pass.setBindGroup(0, sourceGroups[armId]!); pass.setBindGroup(1, queryGroups[armId]!);
          pass.dispatchWorkgroups(8); pass.end(); device.queue.submit([encoder.finish()]);
          const result = await readBuffer(device, outputBuffers[armId]!); results.push(result);
          report.queries.push({ state: stateId, mode, arm: arm.name, armIdentity: arm.identity, sourceBufferIdentities: [...arm.bufferIdentities], targetVersion: arm.updater.telemetry.updateCount,
            queuedVersion: arm.updater.telemetry.queuedUpdateCount, bytes: result.byteLength, sha256: await digest(result), dataBase64: base64(result) });
          await checkpoint(`query-${stateId}-${mode}-${arm.name}`);
        }
        assertBytesEqual(results[0]!, results[1]!, `All48-byte ${mode} hit/work records state${stateId}`);
        const data = new DataView(results[0]!); const boundaryRecords: unknown[] = []; let hits = 0, misses = 0;
        for (let id = 0; id < 512; id++) {
          const at = id * 48, distance = data.getFloat32(at, true), triangleId = data.getUint32(at + 4, true), materialId = data.getUint32(at + 8, true), boxId = data.getUint32(at + 12, true);
          const normal = [16, 20, 24].map(offset => data.getFloat32(at + offset, true)), status = data.getUint32(at + 28, true);
          const ray = inputs.rays[id]!, expected = reference[id];
          check(status <= 1 && Number.isFinite(distance) && normal.every(Number.isFinite), `Unknown/nonfinite ${mode} result state${stateId}/ray${id}.`);
          check(data.getUint32(at + 32, true) <= queryPair[0].data.nodeCount && data.getUint32(at + 36, true) <= source.length
            && data.getUint32(at + 40, true) === 0 && data.getUint32(at + 44, true) === 0, 'Invalid defined work/padding words.');
          if (mode === 'any' || !expected?.boundary) check((status === 1) === Boolean(expected), `${mode} independent hit/miss existence differs at state${stateId}/ray${id}.`);
          if (status === 0) { if (expected?.boundary) boundaryRecords.push({ ray: id, status, closestBoundary: true, referenceSourceId: expected.triangle.id, referenceDistance: expected.distance }); misses++; check(triangleId === 0xffffffff && boxId === 0xffffffff && materialId === 0xffffffff && distance === ray.tMax, 'Invalid miss identity/interval.'); continue; }
          hits++; const triangle = source[triangleId]; check(triangle && triangle.id === triangleId, 'Reported source ID is out of range.');
          check(boxId === triangle.boxId && materialId === triangle.materialId && distance >= ray.tMin && distance <= ray.tMax, 'Reported identity or closed ray interval is invalid.');
          const primitive = classifyReportedTriangle(ray, triangle);
          check(primitive.admissible, `Reported triangle is outside its frozen plane/Gram band at state${stateId}/ray${id}.`);
          const isBoundary = mode === 'any' ? primitive.boundary : Boolean(expected?.boundary);
          if (isBoundary) boundaryRecords.push({ ray: id, sourceId: triangleId, closestBoundary: Boolean(expected?.boundary), reportedPrimitive: primitive });
          else {
            const target = mode === 'any' ? primitive.distance : expected?.distance;
            check(target !== null && target !== undefined, 'Missing independent primitive distance.');
            if (mode === 'closest') check(triangleId === expected!.triangle.id, 'Closest nonboundary source identity differs.');
            const error = Math.abs(distance - target), dot = unitDot(normal, triangle.normal);
            check(error <= tolerance(target) && dot >= updateOracleGates.normalDot, `Independent ${mode} distance/normal gate failed at state${stateId}/ray${id}.`);
            if (!maxDistance || error > maxDistance.value) maxDistance = { value: error, state: stateId, ray: id, mode, sourceId: triangleId };
            if (!minNormal || dot < minNormal.value) minNormal = { value: dot, state: stateId, ray: id, mode, sourceId: triangleId };
          }
        }
        report.cases.push({ step: `query-${mode}-${stateId}`, sourceGate: { nonBoundary, terrain, mirror, slabs, yawedDoor }, hits, misses,
          boundaryRecords, maxDistance: maxDistance ? { ...maxDistance } : null, minNormal: minNormal ? { ...minNormal } : null });
      }
    }
    queryPair.forEach(release); outputBuffers.forEach(destroy); destroy(rayBuffer);
    report.cases.push({ step: 'complete-source-oracles', maxDistance, minNormal });
    if (report.failures.length === 0) report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failures.push({ message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null,
      difference: (error as { proofDifference?: unknown })?.proofDifference ?? null });
  } finally {
    for (const arm of arms) release(arm); for (const buffer of owned) destroy(buffer);
  }
  try { await checkpoint('stage-A-complete'); } catch (error) { report.status = 'failed'; report.failures.push({ message: `Progress persistence failed: ${String(error)}` }); }
  return report;
}
