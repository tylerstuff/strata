import assert from 'node:assert/strict';
import test from 'node:test';
import { buildImageReference, witnesses } from './reflection-image-reference.mjs';
import { buildMotionFrameReference, compareMotionFrame, createMotionReferencePlan, geometricMotionMasks,
  motionReferenceContract, proposedImprovementMargin, reflectionMotionProfiles, residualVariation } from './reflection-motion-reference.mjs';

// Independent two-box emissive fixture. No engine source or GPU is used by these tests.
const scene = {
  boxes: [
    { id: 0, center: [-1.5, .005, 0], halfSize: [.5, .005, 1], yaw: 0, materialId: 0 },
    { id: 1, center: [-.8, 1.12, .2], halfSize: [.18, .18, .18], yaw: 0, materialId: 1 },
  ], materials: [
    { id: 0, albedo: [.85, .85, .85], emission: [0, 0, 0], roughness: .08, metallic: 1 },
    { id: 1, albedo: [.6, .08, .03], emission: [4, .25, .08], roughness: 1, metallic: 0 },
  ], light: { direction: [0, 1, 0], radiance: [0, 0, 0] }, objectBoxId: 1, reflectorBoxId: 0,
};
function cameraFixture() {
  const eye = [-3, 2.4, .2]; const target = [-1.5, .01, .2];
  const norm = value => { const length = Math.hypot(...value); return value.map(x => x / length); };
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const back = norm(eye.map((value, axis) => value - target[axis]));
  const right = norm([back[2], 0, -back[0]]); const up = [back[1] * right[2], back[2] * right[0] - back[0] * right[2], -back[1] * right[0]];
  const view = [right[0], up[0], back[0], 0, right[1], up[1], back[1], 0, right[2], up[2], back[2], 0,
    -dot(right, eye), -dot(up, eye), -dot(back, eye), 1];
  const f = 1 / Math.tan(Math.PI / 12); const near = .05; const far = 40;
  const projection = [f / (320 / 180), 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, near * far / (near - far), 0];
  const viewProjection = Array.from({ length: 16 }, (_, i) => Math.fround([0, 1, 2, 3].reduce((sum, k) =>
    sum + projection[k * 4 + i % 4] * view[Math.floor(i / 4) * 4 + k], 0)));
  return { eye, viewProjection };
}
const camera = cameraFixture();
const capture = (plan, frame, rgb) => ({ ...plan.frames[frame - 1], planIdentity: plan.identity, resolutionScale: .25, maxRaysPerFrame: 256, rgb });
const sum = mask => mask.reduce((total, value) => total + value, 0);

test('Profiles freeze paired scale budgets, full submission schedules, continuous motion then hold, and independent owned inputs', () => {
  assert.equal(reflectionMotionProfiles().length, 14);
  assert.deepEqual(motionReferenceContract.scales, [.25, .5, 1]);
  const input = structuredClone(scene); const plan = createMotionReferencePlan(input, camera, 'object-hold-r0.08');
  input.boxes[1].center[2] = 999;
  assert.equal(plan.frames.length, 240); assert.ok(Object.isFrozen(plan.frames[0].scene.boxes[1].center));
  assert.equal(plan.frames[0].scene.boxes[1].center[2], -.2);
  assert.equal(plan.frames[89].scene.boxes[1].center[2], .2);
  assert.equal(plan.frames[119].scene.boxes[1].center[2], .2 + .4);
  assert.equal(plan.frames[119].poseKey, plan.frames[239].poseKey);
  assert.notEqual(plan.frames[59].poseKey, plan.frames[60].poseKey);
  assert.equal(plan.frames.filter(frame => frame.controls.reflections.resetHistory).length, 1);
  assert.ok(plan.evaluationFrames.includes(120) && plan.evaluationFrames.includes(121));
  assert.ok(plan.frames.every(frame => frame.controls.temporal === false && frame.controls.gi.enabled === false && frame.controls.gi.lightIntensity === 0));
});

test('Camera translation preserves projection of equally translated points and keys every changed evaluated pose', () => {
  const plan = createMotionReferencePlan(scene, camera, 'camera-hold-r0.35'); const last = plan.frames[119].camera;
  assert.deepEqual(last.eye, [-3, 2.4, .4]);
  const clip = (c, point) => [0, 1, 2, 3].map(row => c.viewProjection[12 + row]
    + point.reduce((total, value, axis) => total + c.viewProjection[axis * 4 + row] * value, 0));
  const before = clip(camera, [-1.5, .01, .2]); const after = clip(last, [-1.5, .01, .4]);
  before.forEach((value, i) => assert.ok(Math.abs(value - after[i]) < 1e-6));
  assert.equal(plan.frames[119].poseKey, plan.frames[120].poseKey);
  assert.notEqual(plan.frames[0].poseKey, plan.frames[119].poseKey);
});

test('Dense geometry-only masks cover all object endpoints and distinguish vacated from current feature pixels', () => {
  const plan = createMotionReferencePlan(scene, camera, 'object-hold-r0.08');
  assert.equal(plan.pixels.length, (plan.roi.maxX - plan.roi.minX + 1) * (plan.roi.maxY - plan.roi.minY + 1));
  for (const frame of [1, 60, 90, 120, 240]) {
    const masks = geometricMotionMasks(plan, frame);
    assert.ok(sum(masks.feature) > 0 && sum(masks.background) > 0);
    assert.ok(masks.feature.every((value, i) => !value || masks.visible[i]));
    if (frame >= 120) {
      assert.ok(sum(masks.vacated) > 0);
      assert.ok(masks.vacated.every((value, i) => !value || (!masks.feature[i] && masks.background[i])));
    }
  }
});

test('All four thin phases have dense feature coverage and known virtual-center pixel shifts; a sparse grid can miss the bar', () => {
  const projectedX = plan => {
    const frame = plan.frames[0]; const p = frame.scene.boxes[1].center; const point = [p[0], .02 - p[1], p[2]];
    const m = frame.camera.viewProjection; const x = m[12] + point.reduce((n, v, i) => n + m[i * 4] * v, 0);
    const w = m[15] + point.reduce((n, v, i) => n + m[i * 4 + 3] * v, 0); return (x / w + 1) * 160;
  };
  const sparse = new Set(witnesses().map(pixel => pixel.join(','))); let sparseMiss = false; let first;
  for (const phase of [0, 1, 2, 3]) {
    const plan = createMotionReferencePlan(scene, camera, `thin-r0.08-phase${phase}`); const masks = geometricMotionMasks(plan, 1);
    assert.ok(sum(masks.feature) > 0); assert.ok(sum(masks.background) > 0);
    const center = projectedX(plan); first ??= center; assert.ok(Math.abs(center - first - phase) < 1e-10);
    const sparseHits = plan.pixels.filter((pixel, i) => masks.feature[i] && sparse.has(pixel.join(','))).length;
    sparseMiss ||= sparseHits === 0;
  }
  assert.ok(sparseMiss, 'At least one preregistered phase must expose the sparse-grid blind spot.');
});

test('Actual quadrature integrates explicit pixels without changing legacy defaults', () => {
  const legacy = buildImageReference(scene, camera, .08, 1);
  const explicit = buildImageReference(scene, camera, .08, 1, { width: 320, height: 180, pixels: witnesses() });
  assert.deepEqual(explicit, legacy);
  const one = buildImageReference(scene, camera, .08, 4, { pixels: [[160, 90]] });
  assert.equal(one.values.length, 3); assert.equal(one.mask.length, 1);
  assert.deepEqual(buildImageReference(scene, camera, .08, 4, { width: 960, height: 540, pixels: [[481, 271]] }), one);
  for (const samples of [{ pixels: [] }, { pixels: new Array(1) }, { pixels: [[NaN, 90]] }, { width: 0 }, { pixels: [[320, 1]] }]) {
    assert.throws(() => buildImageReference(scene, camera, .08, 1, samples), /bounded reference/);
  }
});

test('Exact per-frame reference matches; stale initial references and stale observed camera/object state are rejected', () => {
  for (const kind of ['camera-hold', 'object-hold']) {
    const plan = createMotionReferencePlan(scene, camera, `${kind}-r0.35`);
    const current = buildMotionFrameReference(plan, 120, 1); const start = buildMotionFrameReference(plan, 1, 1);
    const valid = capture(plan, 120, [...current.reference.values]);
    for (const resolutionScale of [.25, .5, 1]) assert.equal(compareMotionFrame(plan, { ...valid, resolutionScale }, current).all.rmse, 0);
    assert.ok(sum(current.masks.vacated) > 0);
    assert.throws(() => compareMotionFrame(plan, valid, start), /frozen frame/);
    const stale = { ...valid, scene: plan.frames[0].scene, camera: plan.frames[0].camera };
    assert.throws(() => compareMotionFrame(plan, stale, current), /frozen frame/);
    assert.throws(() => compareMotionFrame(plan, { ...valid, controls: { ...valid.controls, temporal: true } }, current), /frozen frame/);
    assert.throws(() => compareMotionFrame(plan, { ...valid, controls: { ...valid.controls, cameraCut: true } }, current), /frozen frame/);
    assert.throws(() => compareMotionFrame(plan, { ...valid, controls: { ...valid.controls, gi: { ...valid.controls.gi, resetCache: true } } }, current), /frozen frame/);
    assert.throws(() => compareMotionFrame(plan, { ...valid, resolutionScale: .75 }, current), /frozen frame/);
    assert.throws(() => compareMotionFrame(plan, { ...valid, maxRaysPerFrame: 32768 }, current), /frozen frame/);
    const previousImage = compareMotionFrame(plan, { ...valid, rgb: [...start.reference.values] }, current);
    assert.ok(previousImage.all.rmse > 0, 'Retained initial-pose radiance must differ from current truth.');
  }
});

test('Zeroed and energy-preserving blurred thin images fail exact-reference regional controls', () => {
  const plan = createMotionReferencePlan(scene, camera, 'thin-r0.08-phase1');
  const record = buildMotionFrameReference(plan, 1, 8); const values = record.reference.values;
  const exact = compareMotionFrame(plan, capture(plan, 1, [...values]), record); assert.equal(exact.feature.rmse, 0);
  const zero = compareMotionFrame(plan, capture(plan, 1, values.map(() => 0)), record);
  assert.ok(zero.feature.rmse > 0 && zero.feature.signedBias < 0);
  // Symmetric periodic convolution preserves each channel's total energy exactly in real arithmetic.
  const width = plan.roi.maxX - plan.roi.minX + 1;
  const blurred = values.map((value, i) => {
    const pixel = Math.floor(i / 3); const row = Math.floor(pixel / width); const x = pixel % width; const channel = i % 3;
    return (values[(row * width + (x + width - 1) % width) * 3 + channel] + 2 * value
      + values[(row * width + (x + 1) % width) * 3 + channel]) / 4;
  });
  assert.ok(Math.abs(values.reduce((a, b) => a + b, 0) - blurred.reduce((a, b) => a + b, 0)) < 1e-9);
  const blur = compareMotionFrame(plan, capture(plan, 1, blurred), record);
  assert.ok(blur.feature.rmse > 0 && blur.background.rmse > 0);
  assert.throws(() => compareMotionFrame(plan, capture(plan, 1, values.slice(3)), record), /shape/);
  assert.throws(() => compareMotionFrame(plan, capture(plan, 1, values.map((v, i) => i ? v : Infinity)), record), /finite/);
  assert.throws(() => compareMotionFrame(plan, capture(plan, 1, values.map((v, i) => i ? v : 1e300)), record), /rgba16float/);
  const sparse = [...values]; delete sparse[0];
  assert.throws(() => compareMotionFrame(plan, capture(plan, 1, sparse), record), /finite/);
  assert.throws(() => compareMotionFrame(plan, capture(plan, 1, new Array(values.length)), record), /finite/);
});

test('Motion-relative residual variance excludes changing truth, retains error variation and rejects empty regions', () => {
  // Actual changing truth [0,3,6] has nonzero raw variance but zero residual variance.
  const exact = [0, 3, 6].map(value => ({ residual: [value - value, 0, 0] }));
  assert.equal(residualVariation(exact, [1]), 0);
  assert.equal(residualVariation([{ residual: [-1, 0, 0] }, { residual: [1, 0, 0] }], [1]), 1 / 3);
  assert.equal(residualVariation([{ residual: [-131008, 0, 0] }, { residual: [131008, 0, 0] }], [1]), 131008 ** 2 / 3);
  assert.throws(() => residualVariation(exact, [0]), /nonempty/);
  assert.throws(() => residualVariation([{ residual: [0] }, { residual: [0] }], [1]), /shape/);
  assert.throws(() => residualVariation([{ residual: new Array(3) }, { residual: [0, 0, 0] }], [1]), /finite/);
  assert.throws(() => residualVariation(exact, [1, , 0]), /nonempty/);
  const margin = proposedImprovementMargin([.001, .002], [.10, .11]);
  assert.ok(Math.abs(margin.absoluteRmseMargin - .014) < 1e-12);
  assert.equal(margin.status, 'proposal-not-engine-acceptance');
  assert.throws(() => proposedImprovementMargin([.001], [.1, .2]), /repeated/);
  assert.throws(() => proposedImprovementMargin(new Array(2), [.1, .2]), /finite/);
  assert.throws(() => proposedImprovementMargin([Number.MAX_VALUE, Number.MAX_VALUE], [.1, .2]), /overflowed/);
});
