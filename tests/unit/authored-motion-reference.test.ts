import { describe, expect, it } from 'vitest';
import { AUTHORED_MOTION_GATES, getAuthoredMotionFixtures, motionFixturePairs } from '../fixtures/authored-motion.js';
import { compareAuthoredMotion, packAuthoredMotionReference, prepareAuthoredMotionMask, priorClipValid,
  referenceAuthoredMotionPoint, validateAuthoredMotionLandmarks } from '../helpers/authored-motion-reference.js';
import type { MotionMask, MotionReferenceCapture } from '../helpers/authored-motion-reference.js';

const fixtures = getAuthoredMotionFixtures();
const sequence = (id: string) => fixtures.find(s => s.id === id)!;
const bytes = (value: ArrayBuffer) => new Uint8Array(value);

describe('independent authored motion reference', () => {
  it('checks closed-form translation, downwards UV, depth and rational camera rotation landmarks', () => {
    const landmarks = validateAuthoredMotionLandmarks();
    expect(landmarks.cases).toHaveLength(3);
    expect(landmarks.cases[0]!.actual[0] * 320).toBeCloseTo(30 / 7, 13);
    expect(landmarks.cases[1]!.actual[1] * 240).toBeCloseTo(30 / 7, 13);
    expect(landmarks.cases[2]!.actual[3]).toBe(15 / 4);
    expect(landmarks.rotatedCamera.actual[3]).toBeCloseTo(28 / 25, 14);
    expect(landmarks.cyclicRoot.actual[3]).toBe(31 / 8);
    expect(landmarks.cyclicRoot.actual[0]).toBeCloseTo(-3 / 16, 14);
  });

  it('preserves exact dyadic camera-relative upload bytes through every signed offset', () => {
    const baselines = new Map<string, ArrayBuffer[]>(); let comparisons = 0;
    for (const s of fixtures) {
      const uploads = motionFixturePairs(s).map(p => packAuthoredMotionReference(s.scene, p));
      for (const [index, upload] of uploads.entries()) {
        expect(upload.byteLength).toBe(s.scene.boxes.length * 36 * 36);
        const f = new Float32Array(upload), u = new Uint32Array(upload);
        for (let v = 0; v < s.scene.boxes.length * 36; v++) {
          expect(Array.from(f.subarray(v * 9, v * 9 + 8)).every(Number.isFinite)).toBe(true);
          expect(u[v * 9 + 8]).toBe((Math.floor(v / 36) + 1) * 16 + Math.floor(v % 36 / 3));
        }
        if (s.equivalentSequence) { expect(bytes(upload)).toEqual(bytes(baselines.get(s.equivalentSequence)![index]!)); comparisons++; }
      }
      baselines.set(s.id, uploads);
    }
    expect(comparisons).toBe(40);
  });

  it('keeps the serializable catalog frozen and crosses the actual centered cell boundary', () => {
    expect(JSON.parse(JSON.stringify(fixtures))).toEqual(fixtures);
    expect(Object.isFrozen(fixtures)).toBe(true);
    expect(Object.isFrozen(fixtures[0]!.scene.boxes[0]!.transform.position)).toBe(true);
    for (const offset of [999936, -999936]) {
      const frames = sequence(`cell-boundary-${offset}`).frames;
      const cells = frames.map(f => Math.floor(f.camera.position[0] / 1024 + 0.5));
      expect(cells[0]).toBe(cells[1]); expect(cells[2]).toBe(cells[3]); expect(cells[2]! - cells[1]!).toBe(1);
    }
  });

  it('tracks successful submission rather than canceled cut or resized candidates', () => {
    const s = sequence('lifecycle'), pairs = motionFixturePairs(s);
    expect(pairs.map(p => p.previous ? s.frames.indexOf(p.previous) : null)).toEqual([null, 0, 1, 1, 3, 4, 5, 6, 7, 7]);
    expect(pairs.map(p => p.resetReason)).toEqual(['first-frame', null, 'camera-cut', null, 'camera-cut', null, 'viewport-change', null, 'viewport-change', null]);
    for (const p of pairs.filter(p => !p.valid)) {
      const point = referenceAuthoredMotionPoint(s.scene.boxes[0]!, p, [0, 0, 0.5]);
      expect(point.rgba[0]).toBe(0); expect(point.rgba[1]).toBe(0); expect(point.rgba[3]).toBe(0); expect(point.rgba[2]).toBeGreaterThan(0);
    }
  });

  it.each([
    [[0, 0, 0, 1], true], [[1, -1, 1, 1], true], [[0, 0, 0.5, 1], true],
    [[1.01, 0, 0.5, 1], false], [[0, -1.01, 0.5, 1], false],
    [[0, 0, -0.01, 1], false], [[0, 0, 1.01, 1], false],
    [[0, 0, 0, 0], false], [[0, 0, -0.5, -1], false], [[NaN, 0, 0.5, 1], false],
  ] as const)('classifies prior homogeneous clip %j as %s', (clip, expected) => {
    expect(priorClipValid(clip)).toBe(expected);
  });

  it('selects nonvacuous prior XY, near and far invalid samples before any GPU evidence', () => {
    for (const [id, region] of [['prior-frustum', 'xy'], ['prior-near-plane', 'near'], ['prior-far-plane', 'far']] as const) {
      const s = sequence(id), pairs = motionFixturePairs(s);
      expect(prepareAuthoredMotionMask(s.scene, pairs[0]!).entries.length).toBeGreaterThanOrEqual(AUTHORED_MOTION_GATES.minimumMaskPixels);
      const mask = prepareAuthoredMotionMask(s.scene, pairs[1]!);
      expect(mask.entries.filter(e => e.priorRegion === region).length).toBeGreaterThan(0);
      expect(mask.entries.filter(e => e.priorValid).length).toBeGreaterThan(0);
      expect(mask.entries.length + mask.excludedPriorMargin).toBe(mask.erodedSurfacePixels);
      expect(Object.values(mask.countsByObject).reduce((a, b) => a + b, 0)).toBe(mask.entries.length);
    }
  });

  it('checks ray/slab front-face depth and motion against scalar rational geometry', () => {
    const s = sequence('offset-dyadic-0'), pair = motionFixturePairs(s)[1]!, mask = prepareAuthoredMotionMask(s.scene, pair);
    const e = mask.entries.find(e => Math.floor(e.primitiveId / 16) === 1)!;
    const x = e.index % mask.width, y = Math.floor(e.index / mask.width);
    const depth = 45 / 16, tangent = Math.tan(0.9 / 2);
    const currentX = (2 * (x + 0.5) / mask.width - 1) * tangent * mask.width / mask.height * depth;
    const currentY = (1 - 2 * (y + 0.5) / mask.height) * tangent * depth;
    const priorDepth = 11 / 4;
    const priorU = 0.5 + (currentX + 1 / 32) / (2 * tangent * mask.width / mask.height * priorDepth);
    const priorV = 0.5 - (currentY - 1 / 64) / (2 * tangent * priorDepth);
    expect(e.ideal[2]).toBe(depth); expect(e.ideal[3]).toBe(priorDepth);
    expect(e.ideal[0]).toBeCloseTo(priorU - (x + 0.5) / mask.width, 14);
    expect(e.ideal[1]).toBeCloseTo(priorV - (y + 0.5) / mask.height, 14);
  });
});

describe('frozen motion comparison gates', () => {
  function sample(valid = true) {
    const mask: MotionMask = { width: 128, height: 1, backgroundIndices: [], currentSurfacePixels: 1, erodedSurfacePixels: 1, excludedPriorMargin: 0,
      countsByObject: { object: 1 }, entries: [{ index: 0, primitiveId: 16, priorValid: valid, priorRegion: valid ? 'valid' : 'frame-invalid', ideal: valid ? [0, 0, 4, 4] : [0, 0, 4, 0] }] };
    const reference: MotionReferenceCapture = { ids: new Uint32Array(128), motion: new Float32Array(128 * 4) };
    reference.ids[0] = 16; reference.motion.set(mask.entries[0]!.ideal);
    return { mask, reference, actual: reference.motion.slice() };
  }
  it('accepts the exact XY boundary and rejects its next binary32 value without dropping samples', () => {
    const { actual, reference, mask } = sample();
    actual[0] = 2 ** -14;
    expect(compareAuthoredMotion(actual, reference, mask).rejected).toBe(0);
    new Uint32Array(actual.buffer)[0]!++;
    const result = compareAuthoredMotion(actual, reference, mask);
    expect(result.pixels).toBe(1); expect(result.rejected).toBe(1); expect(result.maxXYPixels).toBeGreaterThan(1 / 128);
  });
  it('uses both depth channels and preserves exact invalid zeros', () => {
    for (const c of [2, 3]) {
      const { actual, reference, mask } = sample();
      actual[c] = 4 + 0.99 * (1e-4 + 2e-5 * 4); expect(compareAuthoredMotion(actual, reference, mask).rejected).toBe(0);
      actual[c] = 4 + 1.01 * (1e-4 + 2e-5 * 4); expect(compareAuthoredMotion(actual, reference, mask).rejected).toBe(1);
    }
    const { actual, reference, mask } = sample(false); actual[3] = 1e-20;
    expect(compareAuthoredMotion(actual, reference, mask).rejected).toBe(1);
  });
  it('rejects missing, nonfinite and wrong reference identity with the original denominator', () => {
    for (const mutation of ['missing', 'nonfinite', 'reference-id', 'reference-validity']) {
      const { actual, reference, mask } = sample();
      if (mutation === 'missing') actual[2] = 0;
      if (mutation === 'nonfinite') actual[1] = NaN;
      if (mutation === 'reference-id') reference.ids[0] = 17;
      if (mutation === 'reference-validity') reference.motion[3] = 0;
      const result = compareAuthoredMotion(actual, reference, mask); expect(result.pixels).toBe(1); expect(result.rejected).toBe(1);
    }
    expect(() => compareAuthoredMotion(new Float32Array(), sample().reference, sample().mask)).toThrow('dimensions');
  });
  it('makes origin, sign, older submitted frame and canceled-frame substitutions observable', () => {
    const s = sequence('offset-dyadic-1000000'), p = motionFixturePairs(s)[2]!, box = s.scene.boxes[0]!;
    const good = referenceAuthoredMotionPoint(box, p, [0, 0, 0.5]);
    const wrong = [referenceAuthoredMotionPoint(box, p, [0, 0, 0.5], { sign: -1 }),
      referenceAuthoredMotionPoint(box, p, [0, 0, 0.5], { previousOrigin: p.current.camera.position }),
      referenceAuthoredMotionPoint(box, { ...p, previous: s.frames[0]! }, [0, 0, 0.5])];
    for (const value of wrong) expect(Math.max(...[0, 1].map(c => Math.abs(value.rgba[c]! - good.rgba[c]!) * (c ? 240 : 320)))).toBeGreaterThan(1 / 128);
    const life = sequence('lifecycle'), lp = motionFixturePairs(life)[3]!;
    const actual = referenceAuthoredMotionPoint(life.scene.boxes[0]!, lp, [0, 0, 0.5]);
    const canceled = referenceAuthoredMotionPoint(life.scene.boxes[0]!, { ...lp, previous: life.frames[2]! }, [0, 0, 0.5]);
    expect(Math.abs(actual.rgba[0] - canceled.rgba[0]) * 320).toBeGreaterThan(1 / 128);
  });
});
