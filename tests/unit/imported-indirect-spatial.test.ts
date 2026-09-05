import { describe, expect, it } from 'vitest';
import {
  decodeSpatialGuideMetadata, makeSpatialTruthFixture, referenceSpatialPixel, roundSpatialPixelToF32,
  spatialGuideWeight, spatialTruthGates, spatialTruthMetrics, spatialTruthSeeds, tangentPlaneFootprint,
  type ReferenceSpatialGuide, type ReferenceSpatialPixel, type SpatialVector,
} from '../helpers/imported-indirect-spatial-reference.js';

function pixel(x = 0, y = 0, overrides: Partial<ReferenceSpatialPixel> = {}): ReferenceSpatialPixel {
  return { sum: [32, 32, 32], samples: 64, status: 0, direct: [.1, .2, .3],
    guide: { valid: true, rho: [.5, .5, .5], point: [x, y, 0], normal: [0, 0, 1], footprint: 1, triangleExtent: 2, materialId: 0 }, ...overrides };
}
const plane = (): ReferenceSpatialPixel[] => Array.from({ length: 25 }, (_, i) => pixel(i % 5 - 2, Math.floor(i / 5) - 2));
const changedGuide = (p: ReferenceSpatialPixel, change: Partial<ReferenceSpatialGuide>): ReferenceSpatialPixel => ({ ...p, guide: { ...p.guide, ...change } });
const solve = (pixels: readonly ReferenceSpatialPixel[]) => referenceSpatialPixel(pixels, 5, 5, 2, 2);
const closeRgb = (actual: SpatialVector, expected: SpatialVector): void => actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 12));

describe('independent spatial radiometry and status reference', () => {
  it('preserves constant irradiance and high-frequency albedo exactly, without an extra pi', () => {
    const field = plane().map((p, i) => {
      const rho: SpatialVector = [i % 2 ? .8 : 2 ** -15, i % 3 ? .4 : 0, .5];
      return changedGuide({ ...p, sum: rho.map(v => v * 3 * 64) as unknown as SpatialVector }, { rho });
    });
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
      const out = referenceSpatialPixel(field, 5, 5, x, y), p = field[y * 5 + x]!;
      closeRgb(out.indirect, p.guide.rho.map(v => 3 * v) as unknown as SpatialVector);
      closeRgb(out.composed, p.guide.rho.map((v, c) => 3 * v + p.direct[c]!) as unknown as SpatialVector);
      expect(out.fallbackChannels).toBe(0); expect(out.hdrFaultChannels).toBe(0);
    }
  });
  it('uses the analytic center impulse weight 36/256 and keeps completed zero donors in the denominator', () => {
    const field = plane().map(p => ({ ...p, sum: [0, 0, 0] as SpatialVector }));
    field[12] = { ...field[12]!, sum: [64, 128, 192] };
    closeRgb(solve(field).indirect, [36 / 256, 72 / 256, 108 / 256]);
    field[12] = { ...field[12]!, sum: [-0, 0, 0] };
    closeRgb(solve(field).indirect, [0, 0, 0]);
  });
  it('distinguishes completed-zero centers from unknown, exhausted, sky and untraced centers', () => {
    const field = plane(); field[12] = { ...field[12]!, sum: [0, 0, 0] };
    expect(solve(field).indirect[0]).toBeCloseTo(.5 * (256 - 36) / 256, 12);
    for (const status of [2, 3, 4]) {
      field[12] = { ...field[12]!, status };
      closeRgb(solve(field).composed, field[12]!.direct);
      expect(solve(field).hdrFaultChannels).toBe(0); expect(solve(field).filtered).toBe(false);
    }
    field[12] = { ...field[12]!, status: 0, samples: 0 };
    closeRgb(solve(field).composed, field[12]!.direct);
  });
  it('renormalizes only unavailable donors, and counts a raw-guide bypass independently', () => {
    const field = plane(); field[12] = { ...field[12]!, sum: [0, 0, 0] };
    field[13] = { ...field[13]!, status: 2 }; // weight 6*4=24
    expect(solve(field).indirect[0]).toBeCloseTo(.5 * (256 - 36 - 24) / (256 - 24), 12);
    field[13] = changedGuide({ ...field[13]!, status: 0 }, { valid: false });
    expect(solve(field).indirect[0]).toBeCloseTo(.5 * 196 / 232, 12);
    field[12] = changedGuide(field[12]!, { valid: false });
    expect(solve(field).guideBypass).toBe(true); expect(solve(field).fallbackChannels).toBe(0);
    closeRgb(solve(field).composed, field[12]!.direct);
  });
  it('omits zero-rho channels but falls back complete channels for tiny or unsafe positive donors', () => {
    const field = plane(); field[12] = { ...field[12]!, sum: [16, 16, 16] };
    field[13] = changedGuide(field[13]!, { rho: [0, .5, .5] });
    expect(solve(field).indirect[0]).toBeCloseTo((.25 * 36 + .5 * 196) / 232, 12);
    field[13] = changedGuide(field[13]!, { rho: [2 ** -17, .5, .5] });
    expect(solve(field).fallbackChannels).toBe(1); expect(solve(field).indirect[0]).toBe(.25);
    expect(solve(field).indirect[1]).toBeGreaterThan(.25);
    field[13] = { ...field[13]!, sum: [64 * 2 ** -100, 32, 32] };
    field[13] = changedGuide(field[13]!, { rho: [.5, .5, .5] });
    expect(solve(field).fallbackChannels).toBe(1); expect(solve(field).indirect[0]).toBe(.25);
    // Two unsafe donors still count only one fallback for the center channel.
    field[11] = field[13]!;
    expect(solve(field).fallbackChannels).toBe(1);
  });
  it('treats zero and tiny center rho before division; invalid donor sums never normalize as valid zero', () => {
    const field = plane(); field[12] = changedGuide(field[12]!, { rho: [0, 2 ** -17, .5] });
    const out = solve(field); closeRgb(out.indirect, [0, .5, .5]); expect(out.fallbackChannels).toBe(1);
    field[12] = pixel(); field[13] = { ...field[13]!, sum: [Number.NaN, -1, 64 * 2 ** -127] };
    expect(solve(field).fallbackChannels).toBe(3); closeRgb(solve(field).indirect, [.5, .5, .5]);
  });
  it('proves raw HDR composition first, including when filtering is off', () => {
    const field = plane(); field[12] = { ...field[12]!, direct: [65472, 65471.5, -1] };
    for (const enabled of [false, true]) {
      const out = referenceSpatialPixel(field, 5, 5, 2, 2, { enabled });
      expect(out.hdrFaultChannels).toBe(2); expect(out.filtered).toBe(false);
      expect(out.fallbackChannels).toBe(0); expect(out.guideBypass).toBe(false);
    }
    field[12] = { ...pixel(), direct: [65471.5, 65471.5, 65471.5] };
    closeRgb(referenceSpatialPixel(field, 5, 5, 2, 2, { enabled: false }).composed, [65472, 65472, 65472]);
    field[12] = { ...pixel(), samples: 1025 };
    expect(solve(field).hdrFaultChannels).toBe(3);
    field[12] = { ...pixel(), sum: [Infinity, 64 * 65505, 64 * 2 ** -127] };
    expect(solve(field).hdrFaultChannels).toBe(3);
  });
  it('keeps rho above one in-domain, while positive subnormal rho falls back without becoming zero', () => {
    const field = plane();
    field[12] = changedGuide(field[12]!, { rho: [2, 2 ** -149, .5] });
    const out = solve(field);
    expect(out.guideBypass).toBe(false); expect(out.fallbackChannels).toBe(1);
    expect(out.indirect[0]).toBeCloseTo((.5 * 36 + 2 * 220) / 256, 12);
    expect(out.indirect[1]).toBe(.5);
    field[12] = changedGuide({ ...field[12]!, direct: [65471, .2, .3] }, { rho: [65504, .5, .5] });
    const overflow = solve(field);
    expect(overflow.guideBypass).toBe(false); expect(overflow.hdrFaultChannels).toBe(0);
    expect(overflow.fallbackChannels).toBe(1); expect(overflow.composed[0]).toBe(65471.5);
  });
  it('falls back to the unchanged valid raw center when remodulation cannot fit', () => {
    const field = plane().map(p => ({ ...p, sum: [640, 640, 640] as SpatialVector }));
    field[12] = { ...pixel(), direct: [65470, .2, .3] };
    const out = solve(field); expect(out.fallbackChannels).toBe(1); expect(out.hdrFaultChannels).toBe(0);
    expect(out.composed[0]).toBe(65470.5); expect(out.indirect[1]).toBeGreaterThan(.5);
  });
});

describe('independent geometric and wire references', () => {
  it('checks both sides of the plane, normal and distance guards without triangle identity', () => {
    const c = pixel().guide, n = (z: number): SpatialVector => [Math.sqrt(1 - z * z), 0, z];
    expect(spatialGuideWeight(c, { ...c, point: [0, 0, .049] }, 1)).toBe(1);
    expect(spatialGuideWeight(c, { ...c, point: [0, 0, .051] }, 1)).toBe(0);
    expect(spatialGuideWeight(c, { ...c, normal: n(.9501) }, 0)).toBeCloseTo(.9501 ** 32, 12);
    expect(spatialGuideWeight(c, { ...c, normal: n(.9499) }, 0)).toBe(0);
    expect(spatialGuideWeight(c, { ...c, point: [2.499, 0, 0] }, 1)).toBe(1);
    expect(spatialGuideWeight(c, { ...c, point: [2.501, 0, 0] }, 1)).toBe(0);
    expect(spatialGuideWeight(c, { ...c, normal: [0, 0, -1] }, 0)).toBe(0);
    expect(spatialGuideWeight(c, { ...c, materialId: 1 }, 0)).toBe(0);
    expect(spatialGuideWeight(c, { ...c, footprint: 0 }, 0)).toBe(0);
    // Center plane accepts this tangent displacement, donor tilted plane rejects it.
    expect(spatialGuideWeight(c, { ...c, point: [1, 0, 0], normal: n(.99) }, 1)).toBe(0);
  });
  it('solves perspective and orthographic tangent footprints using clip rays', () => {
    const p: SpatialVector = [0, 0, -2], normal: SpatialVector = [0, 0, 1];
    // Pinhole with 90deg FOV at100px: adjacent rays move2/100 units per depth.
    expect(tangentPlaneFootprint(p, normal, [
      { near: [.002, 0, -.1], far: [.2, 0, -10] }, { near: [0, .002, -.1], far: [0, .2, -10] },
    ])).toBeCloseTo(.04, 12);
    expect(tangentPlaneFootprint(p, normal, [
      { near: [.03, 0, -.1], far: [.03, 0, -10] }, { near: [0, .03, -.1], far: [0, .03, -10] },
    ])).toBeCloseTo(.03, 12);
    const tilted: SpatialVector = [Math.SQRT1_2, 0, Math.SQRT1_2];
    expect(tangentPlaneFootprint(p, tilted, [
      { near: [.03, 0, -.1], far: [.03, 0, -10] }, { near: [0, .03, -.1], far: [0, .03, -10] },
    ])).toBeCloseTo(.03 * Math.SQRT2, 12);
  });
  it('rejects out-of-clip, near-tangent and degenerate plane intersections', () => {
    const rays = [{ near: [0, 0, -.1], far: [0, 0, -1] }, { near: [0, .01, -.1], far: [0, .01, -1] }] as const;
    expect(tangentPlaneFootprint([0, 0, -2], [0, 0, 1], rays)).toBeNull();
    expect(tangentPlaneFootprint([0, 0, -.5], [Math.sqrt(1 - .09 ** 2), 0, .09], rays)).toBeNull();
    expect(tangentPlaneFootprint([0, 0, -.5], [0, 0, 0], rays)).toBeNull();
  });
  it('decodes packed BVH endpoints and orientation while rejecting every reserved bit', () => {
    expect(decodeSpatialGuideMetadata(0x00100000)).toEqual({ triangle: 0, flipped: false });
    expect(decodeSpatialGuideMetadata(0x003fffff)).toEqual({ triangle: 0xfffff, flipped: true });
    expect(decodeSpatialGuideMetadata(0)).toBeNull(); expect(decodeSpatialGuideMetadata(0x00200000)).toBeNull();
    for (let bit = 22; bit < 32; bit++) expect(decodeSpatialGuideMetadata((0x00100000 | (2 ** bit)) >>> 0)).toBeNull();
    expect(decodeSpatialGuideMetadata(0xffffffff)).toBeNull();
    // Reordering requires a new packed BVH index; source identity is not the key.
    expect(decodeSpatialGuideMetadata(0x00100007)?.triangle).not.toBe(decodeSpatialGuideMetadata(0x00100009)?.triangle);
  });
});

describe('predeclared independent linear-truth and edge fixtures', () => {
  for (const seed of spatialTruthSeeds) it(`reduces truth MSE without excessive mean bias on retained seed ${seed}`, () => {
    const fixture = makeSpatialTruthFixture(seed), rounded = { ...fixture, pixels: fixture.pixels.map(roundSpatialPixelToF32) };
    const result = spatialTruthMetrics(rounded);
    expect(result.mseRatio).toBeLessThan(spatialTruthGates.maxMseRatio);
    expect(result.varianceRatio).toBeLessThanOrEqual(spatialTruthGates.maxVarianceRatio);
    expect(result.rawResidualVariance + result.rawMeanError ** 2).toBeCloseTo(result.rawMse, 12);
    expect(result.filteredResidualVariance + result.filteredMeanError ** 2).toBeCloseTo(result.filteredMse, 12);
    expect(result.relativeMeanError).toBeLessThan(spatialTruthGates.maxRelativeMeanError);
  });
  it('preserves a resolved depth boundary exactly, but exposes the same-plane light-edge bias', () => {
    const width = 9, height = 5;
    const stepped = Array.from({ length: width * height }, (_, index) => {
      const x = index % width, y = Math.floor(index / width), incident = x < 4 ? 1 : 3;
      return changedGuide(pixel(x, y, { sum: [32 * incident, 32 * incident, 32 * incident] }), { point: [x, y, x < 4 ? 0 : .2] });
    });
    for (let x = 0; x < width; x++) closeRgb(referenceSpatialPixel(stepped, width, height, x, 2).indirect, x < 4 ? [.5, .5, .5] : [1.5, 1.5, 1.5]);
    const coplanar = stepped.map(p => changedGuide(p, { point: [p.guide.point[0], p.guide.point[1], 0] }));
    // Adjacent brighter half contributes (4+1)/16. This is a limitation witness,
    // not a threshold to waive: geometry-only guards cannot detect this edge.
    closeRgb(referenceSpatialPixel(coplanar, width, height, 3, 2).indirect, [.8125, .8125, .8125]);
    closeRgb(referenceSpatialPixel(coplanar, width, height, 4, 2).indirect, [1.1875, 1.1875, 1.1875]);
  });
});
