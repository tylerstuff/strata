import { describe, expect, it } from 'vitest';
import {
  decodePrimaryRecord, packPrimaryRecord, primaryCompositionConsistent, primaryFirstConsumption, primaryFloatBits,
  primaryWire, referenceClipSegment, referencePrimaryCamera, referencePrimaryHit, referenceRho, referenceSrgb,
  referenceUnproject, referenceWeights, type PrimaryVec3,
} from '../helpers/imported-primary-reference.js';

const ready = (change: Partial<Parameters<typeof packPrimaryRecord>[0]> = {}) => packPrimaryRecord({
  state: 1, issued: true, triangle: 0, rho: [.25, .5, .75], point: [0, 0, 0], guide: true, footprint: 1, ...change,
});
const adjacent = (value: number, sign: 1 | -1): number => new Float32Array(new Uint32Array([primaryFloatBits(value) + sign]).buffer)[0]!;

describe('independent shared-primary packed state contract', () => {
  it('admits every20-bit endpoint, including trianglezero and0xfffff without a sentinel', () => {
    for (const id of [0, 1, 0xfffff]) for (const flipped of [false, true]) {
      const words = ready({ state: 1, triangle: id, flipped });
      expect(decodePrimaryRecord(words, 1048576)).toMatchObject({ state: 1, issued: true, triangle: id, flipped, guide: true });
      expect(decodePrimaryRecord(words, Math.max(1, id))).toEqual(id === 0 ? expect.any(Object) : null);
    }
  });
  it('maps primaryterminal outcomes to distinct rawstatuses and counts first consumption once', () => {
    expect(primaryFirstConsumption(packPrimaryRecord({ state: 2 }), 1)).toEqual({ rawStatus: 4, attempted: 0, exhausted: 0, invalid: 0, transport: false });
    expect(primaryFirstConsumption(packPrimaryRecord({ state: 3, issued: true }), 1)).toEqual({ rawStatus: 2, attempted: 1, exhausted: 1, invalid: 0, transport: false });
    for (const words of [packPrimaryRecord({ state: 0 }), packPrimaryRecord({ state: 4 }), packPrimaryRecord({ state: 4, issued: true })]) {
      expect(primaryFirstConsumption(words, 1)).toEqual({ rawStatus: 3, attempted: 1, exhausted: 0, invalid: 1, transport: false });
    }
    expect(primaryFirstConsumption(ready(), 1)).toMatchObject({ rawStatus: 0, attempted: 1, transport: true });
  });
  it('rejects reservedstates5–7, eachreservedbit, missingREADYquery and contradictoryterminal payloads', () => {
    for (const state of [5, 6, 7]) {
      const words = new Array<number>(8).fill(0); words[3] = state << 22;
      expect(decodePrimaryRecord(words, 1)).toBeNull(); expect(primaryFirstConsumption(words, 1).invalid).toBe(1);
    }
    for (let bit = 26; bit < 32; bit++) {
      const words = ready(); words[3] = (words[3]! | 2 ** bit) >>> 0;
      expect(decodePrimaryRecord(words, 1)).toBeNull();
    }
    expect(decodePrimaryRecord(ready({ state: 1, issued: false }), 1)).toBeNull();
    for (const state of [0, 2, 3, 4] as const) {
      const valid = packPrimaryRecord({ state, issued: state === 3 });
      expect(decodePrimaryRecord(valid, 1)).not.toBeNull();
      for (const at of [0, 1, 2, 4, 5, 6, 7]) { const corrupt = [...valid]; corrupt[at] = 1; expect(decodePrimaryRecord(corrupt, 1)).toBeNull(); }
      for (const flag of [1, primaryWire.flip, primaryWire.guide]) { const corrupt = [...valid]; corrupt[3]! |= flag; expect(decodePrimaryRecord(corrupt, 1)).toBeNull(); }
    }
    expect(decodePrimaryRecord(packPrimaryRecord({ state: 2, issued: true }), 1)).toBeNull();
    expect(decodePrimaryRecord(packPrimaryRecord({ state: 3, issued: false }), 1)).toBeNull();
  });
  it('keeps guide rejection separate fromREADY and rejects stale/malformed completion', () => {
    const words = ready({ state: 1, guide: false, point: [2 ** 20 + 1, 0, 0] });
    expect(decodePrimaryRecord(words, 1)).toMatchObject({ state: 1, guide: false, footprint: 0 });
    expect(primaryFirstConsumption(words, 1).transport).toBe(true);
    expect(primaryCompositionConsistent(words, 1, 0, 64)).toBe(true);
    for (const status of [2, 3, 4]) expect(primaryCompositionConsistent(words, 1, status, 64)).toBe(false);
    expect(primaryCompositionConsistent(words, 1, 0, 0)).toBe(false);
    expect(primaryCompositionConsistent(packPrimaryRecord({ state: 2 }), 1, 0, 64)).toBe(false);
    const negativeZeroFootprint = [...words]; negativeZeroFootprint[7] = 0x80000000;
    expect(decodePrimaryRecord(negativeZeroFootprint, 1)).toBeNull();
    expect(decodePrimaryRecord(ready({ state: 1, guide: true, point: [2 ** 20 + 1, 0, 0] }), 1)).toBeNull();
  });
});

describe('independent explicit primary-domain preconditions', () => {
  it('guards homogeneous divide before operation and admits either sign ofw', () => {
    expect(referenceUnproject([1, 0, 0, 2 ** -30])).toEqual([2 ** 30, 0, 0]);
    expect(referenceUnproject([-1, 0, 0, -(2 ** -30)])).toEqual([2 ** 30, -0, -0]);
    expect(referenceUnproject([1, 0, 0, adjacent(2 ** -30, -1)])).toBeNull();
    expect(referenceUnproject([adjacent(1, 1), 0, 0, 2 ** -30])).toBeNull();
    expect(referenceUnproject([0, 0, 0, 0])).toBeNull();
    for (const v of [NaN, Infinity, -Infinity, adjacent(2 ** 33, 1)]) expect(referenceUnproject([v, 0, 0, 1])).toBeNull();
  });
  it('bounds normalization and rejects degenerate/too-small rays independently ofguidecosine', () => {
    expect(referenceClipSegment([0, 0, 0], [2 ** -30, 0, 0])).toEqual({ direction: [1, 0, 0], distance: 2 ** -30 });
    expect(referenceClipSegment([0, 0, 0], [adjacent(2 ** -30, -1), 0, 0])).toBeNull();
    expect(referenceClipSegment([0, 0, 0], [0, 0, 0])).toBeNull();
    expect(referenceClipSegment([-(2 ** 30), 0, 0], [2 ** 30, 0, 0])).toEqual({ direction: [1, 0, 0], distance: 2 ** 31 });
    expect(referenceClipSegment([0, 0, 0], [adjacent(2 ** 30, 1), 0, 0])).toBeNull();
  });
  it('checks barycentricboundaries before interpolation withoutclamping', () => {
    const e = 2 ** -20;
    expect(referenceWeights(-e, .5)).toEqual([.5 + e, -e, .5]);
    expect(referenceWeights(-adjacent(e, 1), .5)).toBeNull();
    expect(referenceWeights(1 + e, 0)).toEqual([-e, 1 + e, 0]);
    expect(referenceWeights(adjacent(1 + e, 1), 0)).toBeNull();
    expect(referenceWeights(NaN, 0)).toBeNull(); expect(referenceWeights(3, -2)).toBeNull();
  });
  it('keeps sourcebounds and finalrho admission distinct, preserving signedsourcecolor policy', () => {
    const white: PrimaryVec3 = [1, 1, 1], colors = [white, white, white];
    expect(referenceRho(white, white, colors, [.25, .5, .25], 1, .25)).toEqual([.75, .75, .75]);
    expect(referenceRho(white, white, [[-1, -1, -1], white, white], [.25, .5, .25], 0, 0)).toEqual([.5, .5, .5]);
    expect(referenceRho(white, white, [[2 ** 30, 0, 0], white, white], [1, 0, 0], 0, 0)).toBeNull();
    expect(referenceRho(white, white, [[65504, 0, 0], white, white], [1, 0, 0], 0, 0)).toEqual([65504, 0, 0]);
    expect(referenceRho(white, white, [[adjacent(65504, 1), 0, 0], white, white], [1, 0, 0], 0, 0)).toBeNull();
    expect(referenceRho([1.01, 0, 0], white, colors, [.25, .5, .25], 0, 0)).toBeNull();
    expect(referenceRho(white, white, [[adjacent(2 ** 30, 1), 0, 0], white, white], [0, .5, .5], 0, 0)).toBeNull();
    expect(referenceSrgb(0)).toBe(0); expect(referenceSrgb(255)).toBe(1);
    expect(referenceSrgb(128)).toBeCloseTo(.21586050011389926, 14);
  });
});

describe('independent camera/triangle/orientation witnesses', () => {
  const triangle: readonly [PrimaryVec3, PrimaryVec3, PrimaryVec3] = [[-8, 0, -8], [0, 0, 8], [8, 0, -8]];
  it('solves analyticperspective andorthographic rays without runtime matrices', () => {
    const options = { eye: [0, 4, 0] as const, target: [0, 0, 0] as const, up: [0, 0, -1] as const, near: 1, far: 8 };
    for (const [centerDepth, camera] of [[3 / 7, referencePrimaryCamera({ ...options, halfHeight: 2 })],
      [6 / 7, referencePrimaryCamera({ ...options, verticalFov: Math.PI / 2 })]] as const) {
      const center = camera.ray(1, 1, 3, 3); expect(center.near).toEqual([0, 3, 0]); expect(center.far).toEqual([0, -4, 0]);
      const hit = referencePrimaryHit(center, triangle, false)!;
      expect(hit.point).toEqual([0, 0, 0]); expect(hit.weights).toEqual([.25, .5, .25]); expect(hit.normal).toEqual([0, 1, 0]); expect(hit.flipped).toBe(false);
      const p = camera.projection;
      expect(p[14]! / p[15]!).toBeCloseTo(centerDepth, 14);
      const projectedDepth = (y: number) => (p[6]! * y + p[14]!) / (p[7]! * y + p[15]!);
      expect(projectedDepth(3)).toBeCloseTo(0, 14); expect(projectedDepth(-4)).toBeCloseTo(1, 14);
    }
  });
  it('rejects backfaces and near-clippedhits; flippednormal changes a realblocker intersection', () => {
    const front = { near: [0, 3, 0] as const, far: [0, -4, 0] as const }, back = { near: [0, -3, 0] as const, far: [0, 4, 0] as const };
    expect(referencePrimaryHit(back, triangle, false)).toBeNull();
    const hit = referencePrimaryHit(back, triangle, true)!; expect(hit.flipped).toBe(true); expect(hit.normal).toEqual([-0, -1, -0]);
    expect(referencePrimaryHit({ near: [0, -.1, 0], far: [0, -4, 0] }, triangle, true)).toBeNull();
    expect(referencePrimaryHit(front, triangle, true)?.flipped).toBe(false);
    const blocker = triangle.map(p => [p[0], 1, p[2]] as PrimaryVec3) as unknown as readonly [PrimaryVec3, PrimaryVec3, PrimaryVec3];
    expect(referencePrimaryHit({ near: [0, 1e-6, 0], far: [0, 2, 0] }, blocker, true)).not.toBeNull();
    expect(referencePrimaryHit({ near: [0, -1e-6, 0], far: [0, -2, 0] }, blocker, true)).toBeNull();
  });
});
