import { AuthoredBoxRenderer } from '../../packages/core/src/rendering/authored-box-renderer.js';
import { AUTHORED_MOTION_GATES, getAuthoredMotionFixtures, motionFixturePairs } from '../fixtures/authored-motion.js';
import type { MotionFixtureSequence, MotionPair } from '../fixtures/authored-motion.js';
import { captureAuthoredMotionReference, compareAuthoredMotion, packAuthoredMotionReference, prepareAuthoredMotionMask,
  referenceAuthoredMotionPoint, validateAuthoredMotionLandmarks } from '../helpers/authored-motion-reference.js';
import type { MotionMask, MotionReferenceCapture, MotionReferenceFault } from '../helpers/authored-motion-reference.js';

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function equalBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return x.every((v, i) => v === y[i]);
}
async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
}
function maskSummary(mask: MotionMask) {
  const priorRegions: Record<string, number> = {}, countsByPrimitive: Record<string, number> = {};
  for (const e of mask.entries) {
    priorRegions[e.priorRegion] = (priorRegions[e.priorRegion] ?? 0) + 1;
    countsByPrimitive[e.primitiveId] = (countsByPrimitive[e.primitiveId] ?? 0) + 1;
  }
  return { pixels: mask.entries.length, currentSurfacePixels: mask.currentSurfacePixels, erodedSurfacePixels: mask.erodedSurfacePixels,
    excludedPriorMargin: mask.excludedPriorMargin, priorRegions, countsByObject: mask.countsByObject, countsByPrimitive,
    backgroundIndices: mask.backgroundIndices };
}

/** CPU only. Every mask and margin is fixed before any browser GPU readback. */
export async function prepareAuthoredMotionValidation() {
  const fixtures = getAuthoredMotionFixtures(), landmarks = validateAuthoredMotionLandmarks();
  const frames = [], uploadBaselines = new Map<string, ArrayBuffer[]>();
  let selectedPixels = 0, exactOffsetUploads = 0;
  for (const sequence of fixtures) {
    const uploads = [];
    for (const [index, pair] of motionFixturePairs(sequence).entries()) {
      const mask = prepareAuthoredMotionMask(sequence.scene, pair), summary = maskSummary(mask);
      selectedPixels += mask.entries.length;
      const upload = packAuthoredMotionReference(sequence.scene, pair); uploads.push(upload);
      if (sequence.equivalentSequence) {
        const baseline = uploadBaselines.get(sequence.equivalentSequence)?.[index];
        check(baseline && equalBytes(new Uint8Array(upload), new Uint8Array(baseline)), `${pair.current.id}: independent dyadic upload changed at offset`);
        exactOffsetUploads++;
      }
      frames.push({ id: pair.current.id, submit: pair.current.submit, previousSubmittedFrameId: pair.previous?.frameId ?? null,
        valid: pair.valid, resetReason: pair.resetReason, ...summary,
        maskSha256: await hash({ entries: mask.entries, backgroundIndices: mask.backgroundIndices }) });
    }
    uploadBaselines.set(sequence.id, uploads);
  }
  for (const [sequence, region] of [['prior-frustum', 'xy'], ['prior-near-plane', 'near'], ['prior-far-plane', 'far']] as const) {
    const frame = frames.find(f => f.id === `${sequence}/1`);
    check(frame && (frame.priorRegions[region] ?? 0) > 0 && (frame.priorRegions.valid ?? 0) > 0, `Vacuous prior ${region} fixture`);
  }
  const sequence = fixtures.find(s => s.id === 'offset-dyadic-1000000')!, pair = motionFixturePairs(sequence)[2]!;
  const point = referenceAuthoredMotionPoint(sequence.scene.boxes[0]!, pair, [0, 0, 0.5]);
  const faults = [
    { name: 'wrong-sign', pair, fault: { sign: -1 } as MotionReferenceFault },
    { name: 'wrong-prior-origin', pair, fault: { previousOrigin: pair.current.camera.position } as MotionReferenceFault },
    { name: 'wrong-prior-frame', pair: { ...pair, previous: sequence.frames[0]! }, fault: {} },
  ].map(c => {
    const wrong = referenceAuthoredMotionPoint(sequence.scene.boxes[0]!, c.pair, [0, 0, 0.5], c.fault);
    const xyPixels = Math.max(Math.abs(point.rgba[0] - wrong.rgba[0]) * pair.current.width, Math.abs(point.rgba[1] - wrong.rgba[1]) * pair.current.height);
    check(xyPixels > AUTHORED_MOTION_GATES.xyPixels, `Vacuous ${c.name} control`); return { name: c.name, landmarkXYPixels: xyPixels };
  });
  return { schema: 'strata.authored-motion-validation.v1', cpuOnly: true, gates: AUTHORED_MOTION_GATES,
    gatesSha256: await hash(AUTHORED_MOTION_GATES), fixtureSha256: await hash(fixtures), masksSha256: await hash(frames),
    sequenceCount: fixtures.length, requestCount: frames.length, submittedCount: frames.filter(f => f.submit).length,
    selectedPixels, exactOffsetUploads, frames, landmarks, faults,
    limitations: ['Ordinary-vertex GPU reference shares fixed-function rasterization and interpolation with production.',
      'CPU ray/slab ideal values are diagnostics, not backend depth-plane acceptance values.',
      'Prior behind-camera rejection has CPU controls; GPU fixtures cover XY, near and far rejection.',
      'Static opaque roots, no TAA, jitter, animation, object motion or history resolve.'] };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Authored motion GPU operation timed out')), 15000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function capture(device: GPUDevice, renderer: AuthoredBoxRenderer, pair: MotionPair) {
  const f = pair.current, texture = device.createTexture({ size: [f.width, f.height], format: 'rgba8unorm', usage: 0x10 });
  let staging: GPUBuffer | undefined;
  try {
    const encoder = device.createCommandEncoder();
    const stats = renderer.encode(encoder, texture.createView(), f.width, f.height, f.frameId / 60,
      { camera: f.camera, cameraCut: f.cameraCut, debugView: 'base-color', temporal: false });
    const expected = { previousSubmittedFrameId: pair.previous?.frameId ?? null, valid: pair.valid, resetReason: pair.resetReason };
    check(JSON.stringify(stats.authored.motion) === JSON.stringify(expected), `${f.id}: submitted metadata mismatch: ${JSON.stringify(stats.authored.motion)}`);
    if (!f.submit) { renderer.cancelFrame(); return { authored: stats.authored, motion: null }; }
    const motionTexture = renderer.motionTexture; check(motionTexture, `${f.id}: missing motion texture`);
    const row = Math.ceil(f.width * 16 / 256) * 256;
    staging = device.createBuffer({ size: row * f.height, usage: 0x01 | 0x08 });
    encoder.copyTextureToBuffer({ texture: motionTexture }, { buffer: staging, bytesPerRow: row }, [f.width, f.height]);
    device.queue.submit([encoder.finish()]); renderer.submitted(f.frameId);
    await bounded(staging.mapAsync(0x01));
    try {
      const mapped = staging.getMappedRange(), motion = new Float32Array(f.width * f.height * 4);
      for (let y = 0; y < f.height; y++) motion.set(new Float32Array(mapped, y * row, f.width * 4), y * f.width * 4);
      return { authored: stats.authored, motion };
    } finally { staging.unmap(); }
  } catch (error) { renderer.cancelFrame(); throw error; }
  finally { staging?.destroy(); texture.destroy(); }
}
function idealDiagnostics(actual: Float32Array, mask: MotionMask) {
  let maxXYPixels = 0, maxDepthError = 0;
  for (const e of mask.entries) {
    const at = e.index * 4;
    maxXYPixels = Math.max(maxXYPixels, Math.abs(actual[at]! - e.ideal[0]) * mask.width, Math.abs(actual[at + 1]! - e.ideal[1]) * mask.height);
    maxDepthError = Math.max(maxDepthError, Math.abs(actual[at + 2]! - e.ideal[2]), Math.abs(actual[at + 3]! - e.ideal[3]));
  }
  return { diagnosticOnly: true, maxXYPixels, maxDepthError };
}

/** Explicit browser invocation only; importing this file never starts a GPU operation. */
export async function runAuthoredMotionValidation({ software = false } = {}) {
  const preparation = await prepareAuthoredMotionValidation();
  const report = { schema: preparation.schema, preparation, software, stage: 'adapter', adapter: {} as Record<string, unknown>,
    browser: navigator.userAgent, gpuErrors: [] as string[], deviceLost: null as unknown,
    frames: [] as unknown[], negatives: [] as unknown[], interleaved: [] as unknown[], failedEncodeControls: 0, exactOffsetByteComparisons: 0 };
  let device: GPUDevice | undefined, expectedDestroy = false;
  try {
    check(navigator.gpu, 'WebGPU is unavailable');
    const adapter = await bounded(navigator.gpu.requestAdapter({ powerPreference: 'low-power' })); check(adapter, 'No WebGPU adapter');
    const info = adapter.info;
    report.adapter = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter };
    device = await bounded(adapter.requestDevice());
    device.addEventListener('uncapturederror', event => report.gpuErrors.push(event.error.message));
    void device.lost.then(loss => { if (!expectedDestroy) report.deviceLost = { reason: loss.reason, message: loss.message }; });
    device.pushErrorScope('validation');
    const fixtures = getAuthoredMotionFixtures(), baselines = new Map<string, Float32Array[]>();
    const checkFrame = async (renderer: AuthoredBoxRenderer, sequence: MotionFixtureSequence, pair: MotionPair) => {
      report.stage = pair.current.id;
      const mask = prepareAuthoredMotionMask(sequence.scene, pair); // Always before readback, never selected from GPU values.
      const actual = await capture(device!, renderer, pair);
      if (!actual.motion) return { ...actual, mask, reference: null, comparison: null };
      const reference = await captureAuthoredMotionReference(device!, sequence.scene, pair);
      const comparison = compareAuthoredMotion(actual.motion, reference, mask);
      const wholeReadbackFinite = actual.motion.every(Number.isFinite) && reference.motion.every(Number.isFinite);
      const backgroundZero = mask.backgroundIndices.every(i => reference.ids[i] === 0
        && [0, 1, 2, 3].every(c => actual.motion![i * 4 + c] === 0 && reference.motion[i * 4 + c] === 0));
      report.frames.push({ id: pair.current.id, authored: actual.authored, ...maskSummary(mask), comparison,
        wholeReadbackFinite, backgroundZero, ideal: idealDiagnostics(actual.motion, mask) });
      check(wholeReadbackFinite && backgroundZero, `${pair.current.id}: nonfinite readback or nonzero fixed background`);
      check(comparison.rejected === 0, `${pair.current.id}: ${comparison.rejected}/${comparison.pixels} selected motion samples failed`);
      return { ...actual, mask, reference, comparison };
    };
    const negative = async (name: string, sequence: MotionFixtureSequence, pair: MotionPair, actual: Float32Array,
      reference: MotionReferenceCapture, mask: MotionMask, fault: MotionReferenceFault = {}) => {
      report.stage = `negative/${name}`;
      const wrong = await captureAuthoredMotionReference(device!, sequence.scene, pair, fault);
      check(equalBytes(wrong.ids, reference.ids), `${name}: fault changed current ID coverage`);
      const comparison = compareAuthoredMotion(actual, wrong, mask);
      report.negatives.push({ name, currentIdBytesIdentical: true, ...comparison });
      check(comparison.rejected > 0 && comparison.referenceMismatch === 0 && comparison.nonfinite === 0 && comparison.missing === 0,
        `${name}: fault did not fail the unchanged numeric gate cleanly`);
    };
    for (const sequence of fixtures) {
      report.stage = `create/${sequence.id}`;
      const renderer = await bounded(AuthoredBoxRenderer.create(device, 'rgba8unorm', sequence.scene)), outputs: Float32Array[] = [];
      try {
        for (const [index, pair] of motionFixturePairs(sequence).entries()) {
          const result = await checkFrame(renderer, sequence, pair);
          if (!result.motion || !result.reference) { report.frames.push({ id: pair.current.id, canceled: true, authored: result.authored }); continue; }
          outputs[index] = result.motion;
          if (sequence.equivalentSequence) {
            const baseline = baselines.get(sequence.equivalentSequence)?.[index];
            check(baseline && equalBytes(baseline, result.motion), `${pair.current.id}: complete dyadic motion bytes differ from origin`);
            report.exactOffsetByteComparisons++;
          }
          if (sequence.id === 'offset-dyadic-1000000' && index === 2) {
            await negative('wrong-sign', sequence, pair, result.motion, result.reference, result.mask, { sign: -1 });
            await negative('wrong-prior-origin', sequence, pair, result.motion, result.reference, result.mask, { previousOrigin: pair.current.camera.position });
            await negative('wrong-prior-frame', sequence, { ...pair, previous: sequence.frames[0]! }, result.motion, result.reference, result.mask);
          }
          if (sequence.id === 'lifecycle' && index === 3) {
            await negative('canceled-cut-as-prior', sequence, { ...pair, previous: sequence.frames[2]! }, result.motion, result.reference, result.mask);
          }
          if (sequence.id === 'lifecycle' && index === 1) {
            const target = device.createTexture({ size: [320, 240], format: 'rgba8unorm', usage: 0x10 });
            try {
              let rejected = false;
              try { renderer.encode(device.createCommandEncoder(), target.createView(), 320, 240, 0,
                { cameraCut: true, camera: { ...pair.current.camera, projection: { ...pair.current.camera.projection, near: 32, far: 32 } } }); }
              catch { rejected = true; }
              check(rejected, 'Invalid cut encode was accepted'); report.failedEncodeControls++;
            } finally { target.destroy(); }
          }
        }
        baselines.set(sequence.id, outputs);
      } finally { renderer.dispose(); }
    }
    const interleavedSequences = ['offset-dyadic-0', 'offset-dyadic-1000000'].map(id => fixtures.find(s => s.id === id)!);
    const renderers: AuthoredBoxRenderer[] = [];
    try {
      for (const s of interleavedSequences) renderers.push(await bounded(AuthoredBoxRenderer.create(device, 'rgba8unorm', s.scene)));
      for (let index = 0; index < 3; index++) for (let r = 0; r < renderers.length; r++) {
        const sequence = interleavedSequences[r]!, pair = motionFixturePairs(sequence)[index]!;
        const result = await checkFrame(renderers[r]!, sequence, pair);
        report.interleaved.push({ renderer: r, id: pair.current.id, motion: result.authored.motion });
      }
    } finally { renderers.forEach(r => r.dispose()); }
    report.stage = 'error-scope';
    await bounded(device.queue.onSubmittedWorkDone());
    const error = await bounded(device.popErrorScope()); if (error) report.gpuErrors.push(error.message);
    check(report.gpuErrors.length === 0 && report.deviceLost === null, 'GPU error or device loss');
    report.stage = 'complete'; return report;
  } catch (cause) {
    const error = new Error(`Authored motion validation failed at ${report.stage}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    Object.assign(error, { details: report }); throw error;
  } finally { expectedDestroy = true; device?.destroy(); }
}
