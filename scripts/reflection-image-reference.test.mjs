import assert from 'node:assert/strict';
import test from 'node:test';
import { ggxBrdf, intersectBox, inverseMatrix, witnesses, imageError, summarizeImageFrames } from './reflection-image-reference.mjs';
test('Independent slabs handle outside hits, misses, parallel axes, clipping and rotated boxes', () => {
  const box = { center: [0, 0, 0], halfSize: [1, 2, 3], yaw: 0 };
  assert.equal(intersectBox([0, 0, 5], [0, 0, -1], box), 2);
  assert.equal(intersectBox([2, 0, 5], [0, 0, -1], box), null);
  assert.equal(intersectBox([0, 0, 5], [0, 0, -1], box, .002, 1.9), null);
  assert.equal(intersectBox([0, 0, 5], [0, 0, -1], { ...box, yaw: Math.PI / 2 }), 4);
});
test('BRDF agrees with independently reduced normal-incidence expression and reciprocity', () => {
  const roughness = .35; const f0 = .85; const expected = f0 / (4 * Math.PI * roughness ** 4);
  assert.ok(Math.abs(ggxBrdf([0, 1, 0], [0, 1, 0], roughness, f0) - expected) < 1e-10);
  assert.equal(ggxBrdf([.6, .8, 0], [0, .8, .6], roughness, f0), ggxBrdf([0, .8, .6], [.6, .8, 0], roughness, f0));
  assert.equal(ggxBrdf([0, 1, 0], [0, -1, 0], roughness, f0), 0);
});
test('GGX unit-F0 directional albedo remains finite and energy-conserving under independent hemisphere quadrature', () => {
  const divisions = 256; let integral = 0;
  for (let i = 0; i < divisions; i++) for (let j = 0; j < divisions; j++) {
    const cosine = (i + .5) / divisions; const phi = (j + .5) / divisions * 2 * Math.PI; const sin = Math.sqrt(1 - cosine * cosine);
    integral += ggxBrdf([0, 1, 0], [sin * Math.cos(phi), cosine, sin * Math.sin(phi)], .35, 1) * cosine * 2 * Math.PI / divisions ** 2;
  }
  assert.ok(integral > .95 && integral <= 1.001, `${integral}`);
});
test('Fixed witness corpus and linear error/variance ledger are deterministic', () => {
  assert.equal(witnesses().length, 576); assert.deepEqual(witnesses()[0], [112, 63]); assert.deepEqual(witnesses().at(-1), [205, 114]);
  assert.deepEqual(inverseMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.equal(imageError([2, 0, 0], [1, 0, 0], [1]).mae, 1 / 3);
  const frames = Array.from({ length: 60 }, (_, i) => ({ frame: 181 + i, rgb: [i % 2 ? 2 : 0, 0, 0] }));
  const result = summarizeImageFrames(frames, { values: [1, 0, 0], mask: [1] });
  assert.equal(result.meanImageError.rmse, 0); assert.equal(result.temporalVariance, 1 / 3); assert.ok(Math.abs(result.meanInstantaneousMse - 1 / 3) < 1e-12);
});
