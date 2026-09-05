import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { compareTraceGiPhaseCells } from './trace-gi-phase-comparison.mjs';

// CPU-only loading of the held literal plan. No renderer factory or browser is invoked.
const built = await build({ stdin: { contents: "export {traceGiPhasePlan} from './tests/browser/trace-gi-phase-validation.ts';",
  resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
const { traceGiPhasePlan: plan } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const hash = data => createHash('sha256').update(data).digest('hex');
const labelName = (prefix, key) => `${prefix}/${key.replaceAll(' ', '-')}.bin`;
const raw = values => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32LE(v, i * 4)); return b; };
const bufferKeys = ['probeRay', 'probeState', 'probeStats', 'probeConfig', 'reflectionStats', 'reflectionConfig',
  'Strata current tile LOD selections', 'Strata indirect geometry arguments and counters'];
const images = ['native', 'probeIrradiance', 'probeVisibility', 'reflectionRaw', 'reflectionRawMetadata', 'reflectionRadiance',
  'reflectionSurface', 'reflectionMetadata', 'Strata linear HDR and shadow visibility', 'Strata world normals and roughness',
  'Strata linear base color and metallic', 'Strata motion and current/previous view depths', 'Strata raster depth',
  'Strata directional shadow depth', 'Strata composed reflection HDR'];
const ids = ['precondition', 'reset', ...Array.from({ length: 239 }, (_, i) => `held-${i + 1}`), 'final'];
const matrix = Array.from({ length: 16 }, (_, i) => Number(i % 5 === 0));
const cache = new Map();
function pixels(kind, changed) {
  const key = `${kind}/${changed}`;
  if (cache.has(key)) return cache.get(key);
  const hdr = kind === 'hdr', stride = hdr ? 8 : 4, b = Buffer.alloc(1280 * 720 * stride);
  for (let i = 0; i < 1280 * 720; i++) if (hdr) b.writeUInt16LE(0x3c00, i * 8 + 6); else b[i * 4 + 3] = 255;
  if (changed) {
    const wall = (100 * 1280 + 100) * stride, sky = (100 * 1280 + 1000) * stride;
    if (hdr) { [0x3800, 0x3c00, 0x4000].forEach((word, i) => b.writeUInt16LE(word, wall + i * 2)); b.writeUInt16LE(0x3800, sky + 6); }
    else { b[wall] = 30; b[wall + 1] = 20; b[wall + 2] = 10; b[sky + 2] = 5; }
  }
  cache.set(key, b); return b;
}
function rays(changed) {
  const key = `rays/${changed}`;
  if (!cache.has(key)) { const b = Buffer.alloc(65536); for (let i = 0; i < 2048; i++) b.writeFloatLE(1, i * 32 + (changed ? 24 : 16)); cache.set(key, b); }
  return cache.get(key);
}

function fixture() {
  const files = new Map();
  const cells = [['incremental', 5399], ['full', 5399], ['full', 5400], ['incremental', 5400]].map(([updater, phaseLabel], cellIndex) => {
    const id = `${cellIndex + 1}-${updater}-${phaseLabel}`, phase = structuredClone(plan.phases.find(p => p.label === phaseLabel));
    const artifacts = [], events = [], frames = [];
    function record(name, bytes, meta = {}) {
      const a = { name, bytes: bytes.length, sha256: hash(bytes), ...meta }; artifacts.push(a); files.set(`${id}/${name}`, bytes); return a;
    }
    const brief = bytes => ({ bytes: bytes.length, sha256: hash(bytes) });
    const trace = prefix => Array.from({ length: 5 }, (_, i) => record(`${prefix}/trace-${i}.bin`, raw([i + 1])));
    const telemetry = (n, clock, age, epoch) => ({ sourceFrameId: n, submittedFrames: n, sampleFrameIndex: clock, framesSinceReset: age,
      cacheEpoch: epoch, refreshFrontier: age * 32 % 384, enabled: true,
      traceUpdateCount: Number(n >= 2), traceQueuedUpdateCount: Number(n >= 2), traceLastSubmittedUpdateCount: Number(n >= 2), traceLastSubmittedFrameId: n,
      traceChangedBoxCount: n >= 2 ? 2 : 0, tracePendingRangeCount: 0, tracePendingUploadBytes: 0,
      traceRegeneratedTriangleCount: n >= 2 ? updater === 'full' ? 156 : 24 : 0,
      traceQueuedUploadBytes: n >= 2 ? updater === 'full' ? 184640 : 1800 : 0, traceMetadataBytes: updater === 'full' ? 187185 : 150801 });
    const reflection = (n, age, epoch) => ({ sourceFrameId: n, submittedFrames: n, framesSinceReset: age, cacheEpoch: epoch, mode: 'world' });
    const geo = { residentPages: 80, poolBytes: 5242880, selectedTriangles: 131228 };
    const initialGi = telemetry(0, null, 0, 0), initialReflection = reflection(0, 0, 0);
    const initialWrites = Array.from({ length: 5 }, (_, i) => ({ label: `buffer${i}`, offset: 0, bytes: 4, returned: true }));
    initialWrites.forEach((_, i) => record(`writes/${String(i).padStart(4, '0')}.bin`, raw([i + 1])));
    events.push({ type: 'creation', trace: trace('initial'), gi: initialGi, reflections: initialReflection, geometry: geo,
      effectFrames: 0, controls: structuredClone(plan.initialWorld), initialWrites });
    const injection = { path: 'IntegratedRenderer.effect.frames', previousValue: 1, value: phase.firstSampleIndex,
      changedPropertyCount: 1, cachesUnchanged: true, historicalSubmissionIdsSynthesized: false };
    ids.forEach((frameId, i) => {
      const n = i + 1, clock = i === 0 ? 0 : phase.firstSampleIndex + i - 1, age = i === 0 ? 1 : i, epoch = i === 0 ? 1 : 2;
      const pc = Array(24).fill(0), rc = Array(60).fill(0);
      pc[8] = (age - 1) * 32 % 384; pc[9] = 32; pc[10] = 64; pc[11] = epoch; pc[16] = clock; pc[17] = Number(i < 2); pc[18] = 1337;
      rc[40] = clock; rc[41] = epoch; rc[52] = Number(i < 2);
      const snapshot = ['precondition', 'reset', 'final'].includes(frameId), changed = phaseLabel === 5400 && i > 0;
      const gpu = { probeRay: rays(changed), probeState: Buffer.alloc(6144), probeStats: Buffer.alloc(32), probeConfig: raw(pc),
        reflectionStats: Buffer.alloc(32), reflectionConfig: raw(rc), 'Strata current tile LOD selections': raw([0]), 'Strata indirect geometry arguments and counters': raw([1]) };
      const buffers = Object.fromEntries(bufferKeys.map(key => [key, snapshot ? record(labelName(frameId, key), gpu[key]) : brief(gpu[key])]));
      const uploads = Object.fromEntries(['Strata current and previous transforms', 'Strata presentation settings', 'Strata probe config0', 'Strata reflection config0'].map(label => {
        const b = label.includes('probe config') ? gpu.probeConfig : label.includes('reflection config') ? gpu.reflectionConfig : raw([0]);
        return [label, snapshot ? record(labelName(frameId, `upload-${label}`), b) : brief(b)];
      }));
      const imageRecords = snapshot ? Object.fromEntries(images.map(key => {
        if (key === 'native') return [key, record(labelName(frameId, key), pixels('native', changed), { format: 'bgra8unorm', width: 1280, height: 720 })];
        if (key === 'Strata composed reflection HDR') return [key, record(labelName(frameId, key), pixels('hdr', changed), { format: 'rgba16float', width: 1280, height: 720 })];
        // Tiny unrelated textures keep these CPU protocol fixtures bounded. Real dimensions are independently bound by the frozen browser producer.
        return [key, record(labelName(frameId, key), Buffer.alloc(8), { format: 'rgba16float', width: 1, height: 1 })];
      })) : {};
      const frame = { id: frameId, localFrameId: n, effectFrames: clock + 1,
        controls: i === 0 ? structuredClone(plan.initialWorld) : { ...plan.initialWorld, doorOpen: true, lightIntensity: 0, objectOffset: 0 },
        gi: telemetry(n, clock, age, epoch), reflections: reflection(n, age, epoch), geometry: geo,
        probeConfig: pc, reflectionConfig: rc, buffers, images: imageRecords, uploads, validProbeCount: 32, invalidProbeCount: 352,
        camera: { view: [...matrix], viewProjection: [...matrix], eye: [0, 1, 0] }, ...(snapshot ? { trace: trace(frameId) } : {}) };
      const before = { localFrameId: i, effectFrames: i === 0 ? 0 : phase.firstSampleIndex + i - 1,
        gi: i === 0 ? initialGi : frames[i - 1].gi, reflections: i === 0 ? initialReflection : frames[i - 1].reflections,
        controls: i === 0 ? structuredClone(plan.initialWorld) : frames[i - 1].controls };
      if (i === 1) {
        events.push({ type: 'injection', trace: trace('post-injection'), before: { gi: frames[0].gi, reflection: frames[0].reflections, frames: 1 },
          injection, after: { gi: frames[0].gi, reflection: frames[0].reflections, frames: phase.firstSampleIndex } });
        record('reset-queued/probeConfig.bin', gpu.probeConfig); record('reset-queued/reflectionConfig.bin', gpu.reflectionConfig);
        events.push({ type: 'reset-queued', before, probeConfig: [...pc], reflectionConfig: [...rc], localFrameId: 1 });
      }
      const spec = i === 0 ? plan.precondition : i === 1 ? plan.reset : plan.held;
      const writes = i === 1 ? Array.from({ length: updater === 'full' ? 5 : 2 }, (_, j) => ({ label: `buffer${j}`, offset: 0, byteLength: 4, returned: true, phase: frameId })) : [];
      writes.forEach((_, j) => record(`writes/${String(5 + j).padStart(4, '0')}.bin`, raw([j + 2])));
      events.push({ type: 'submission', id: frameId, before, requestedControls: structuredClone(spec.controls), time: spec.time,
        firstWrite: i <= 1 ? 5 : updater === 'full' ? 10 : 7, writes });
      frames.push(frame); events.push({ type: 'frame', ...frame });
    });
    const cleanup = { before: { buffers: 200000, textures: 1000000 }, after: { buffers: 0, textures: 0 }, outputDestroyed: true, errors: [] };
    events.push({ type: 'cell-cleanup', cleanup });
    return { id, updater, phaseLabel, artifacts, events, shaderDescriptors: [{ label: 'CPU fixture shader identity', code: 'identical retained source' }],
      result: { status: 'passed', phase, plan: structuredClone(plan), frames, checkpoints: frames.filter(f => ['precondition', 'reset', 'final'].includes(f.id)), injection, cleanup } };
  });
  return { cells, files, read: async (cell, name) => { const b = files.get(`${cell.id}/${name}`); if (!b) throw Error('Missing disk artifact'); return b; } };
}
async function rejected(f, pattern) { await assert.rejects(compareTraceGiPhaseCells(f.cells, f.read), error => Boolean(error.proofDifference) && (!pattern || pattern.test(error.message))); }
function replace(f, cellIndex, name, mutate) {
  const cell = f.cells[cellIndex], key = `${cell.id}/${name}`, b = Buffer.from(f.files.get(key)); mutate(b); f.files.set(key, b);
  cell.artifacts.find(a => a.name === name).sha256 = hash(b);
}

test('strict same-phase equality permits only explicit work differences and reports exact native/HDR phase metrics', async () => {
  const f = fixture(), result = await compareTraceGiPhaseCells(f.cells, f.read);
  assert.equal(result.status, 'passed'); assert.equal(result.samePhase.length, 2); assert.equal(result.crossPhase.length, 2);
  const c = result.crossPhase[0]; assert.equal(c.changedResetDirectionWords, 4096); assert.equal(c.changedResetRays, 2048);
  assert.equal(c.metrics.nativeBgraCodeValues.full.differingByteCount, 4);
  assert.equal(c.metrics.nativeBgraCodeValues.full.differingPixelCount, 2); assert.equal(c.metrics.nativeBgraCodeValues.full.changedRgbPixels, 2);
  assert.deepEqual(c.metrics.nativeBgraCodeValues.full.maxAbsoluteDifferenceRgb, [10, 20, 30]);
  assert.equal(c.metrics.nativeBgraCodeValues.wall.changedRgbPixels, 1); assert.equal(c.metrics.nativeBgraCodeValues.sky.changedRgbPixels, 1);
  assert.equal(c.metrics.nativeBgraCodeValues.full.meanAbsoluteRgbDifference, 65 / (1280 * 720 * 3));
  assert.equal(c.metrics.linearHdr.full.differingByteCount, 4); assert.equal(c.metrics.linearHdr.full.differingPixelCount, 2);
  assert.equal(c.metrics.linearHdr.full.changedRgbPixels, 1); assert.deepEqual(c.metrics.linearHdr.full.maxAbsoluteDifferenceRgb, [.5, 1, 2]);
  assert.equal(c.metrics.linearHdr.sky.changedRgbPixels, 0); assert.equal(c.metrics.linearHdr.sky.differingPixelCount, 1);
  assert.equal(c.rawLightingDifferences.probeRay.differingByteCount, 8192);
  assert.deepEqual(c.metrics, result.crossPhase[1].metrics); assert.equal(result.interpretation.wallHdrChangedWithPhase, true);
});
test('missing and tampered files fail with proofDifference before an equality conclusion', async () => {
  const missing = fixture(); missing.files.delete(`${missing.cells[0].id}/reset/probeRay.bin`); await rejected(missing, /read failed/);
  const tampered = fixture(); tampered.files.set(`${tampered.cells[0].id}/final/native.bin`, Buffer.from('wrong')); await rejected(tampered, /identity mismatch/);
  const omitted = fixture(); omitted.cells.forEach(c => { c.artifacts = c.artifacts.filter(a => a.name !== 'final/native.bin'); }); await rejected(omitted, /Missing required/);
});
test('a rehashed same-phase one-byte difference still fails; original evidence is never rewritten', async () => {
  const f = fixture(), name = 'final/native.bin'; replace(f, 1, name, b => { b[0] = 1; }); const retained = hash(f.files.get(`${f.cells[1].id}/${name}`));
  await rejected(f, /mismatch/); assert.equal(hash(f.files.get(`${f.cells[1].id}/${name}`)), retained);
});
test('same-phase source-version or unknown trace telemetry changes cannot hide behind work exclusions', async () => {
  for (const key of ['traceUpdateCount', 'traceChangedBoxCount', 'tracePendingUploadBytes', 'traceUnrecognizedFutureField']) {
    const f = fixture(); f.cells[1].result.frames[20].gi[key] = 99; await rejected(f, /mismatch/);
  }
});
test('changed requested controls, missing frame and late event reject even if result status says passed', async () => {
  const changed = fixture(); changed.cells[0].events.find(e => e.type === 'submission' && e.id === 'held-1').requestedControls.temporal = false; await rejected(changed, /requested controls/);
  const missing = fixture(); missing.cells[0].result.frames.pop(); await rejected(missing, /frame\/event/);
  const late = fixture(); late.cells[0].events.push({ type: 'gpu-error', message: 'late error' }); await rejected(late, /frame\/event/);
});
test('clock-only and radiance-only changes cannot substitute for actual RESET direction changes', async () => {
  const f = fixture();
  for (const i of [2, 3]) replace(f, i, 'reset/probeRay.bin', b => { rays(false).copy(b); b.writeFloatLE(7, 0); });
  await rejected(f, /RESET probe directions/);
});
test('across-phase direct/depth inputs and complete precondition state remain exact', async () => {
  const changed = fixture();
  for (const i of [2, 3]) replace(changed, i, 'final/Strata-raster-depth.bin', b => { b[0] = 1; });
  await rejected(changed, /input controls|input metadata/);
  const precondition = fixture();
  for (const i of [2, 3]) { precondition.cells[i].result.frames[0].validProbeCount = 31; precondition.cells[i].result.frames[0].invalidProbeCount = 353; }
  await rejected(precondition, /frame event\/result|precondition/);
});
test('unexpected actual shaders, cleanup failure and altered clock slots cannot pass', async () => {
  const shader = fixture(); shader.cells[1].shaderDescriptors[0].code = 'different WGSL'; await rejected(shader, /shader descriptors/);
  const cleanup = fixture(); cleanup.cells[0].result.cleanup.errors.push('late scope error'); await rejected(cleanup, /cleanup/);
  const clock = fixture(); clock.cells[0].result.frames[1].probeConfig[16] = 5399; await rejected(clock, /configuration/);
});
test('nonfinite raw HDR and malformed format/length are rejected before image statistics', async () => {
  const nan = fixture(); replace(nan, 0, 'final/Strata-composed-reflection-HDR.bin', b => b.writeUInt16LE(0x7e00, 0)); await rejected(nan, /Nonfinite/);
  const dims = fixture(); dims.cells[0].artifacts.find(a => a.name === 'final/native.bin').width = 1279; await rejected(dims, /dimensions/);
});
