import { describe, expect, it } from 'vitest';
import { createReflectionScene } from '../../packages/core/src/reflections/reflection-scene.js';
import { combineQuality, contributors, decodeQualityConfig, finiteRayIrradiance, halfFloat, integrateQualityReference, octTaps, qualityHit, qualityIncoming, visibilityWeight } from '../browser/probe-quality-reference.js';
import type { ProbeQualityConfig, QualityNeighbor, QualityProbe } from '../browser/probe-quality-reference.js';

const config: ProbeQualityConfig = { origin: [-5.5, .5, -3.5], spacing: 1, grid: [12, 4, 8], probeCount: 384, start: 0, count: 32, rays: 64,
  epoch: 1, hysteresis: .85, normalBias: .12, frame: 240, maxAge: 12, columns: 24, irradianceSize: 8, momentSize: 16 };

describe('independent probe attribution reference', () => {
  it('intersects known entry, rotated-box and inside-exit witnesses', () => {
    const base = createReflectionScene(); const box = { id: 0, name: 'oracle cube', center: [0, 0, 0] as const, halfSize: [1, 1, 1] as const, yaw: 0, materialId: 0 };
    const scene = { ...base, boxes: [box] };
    expect(qualityHit(scene, [-2, 0, 0], [1, 0, 0])).toMatchObject({ distance: 1, normal: [-1, 0, 0] });
    expect(qualityHit(scene, [0, 0, 0], [1, 0, 0])).toMatchObject({ distance: 1, normal: [1, 0, 0] });
    expect(qualityHit(scene, [-2, 2, 0], [1, 0, 0])).toBeUndefined();
    expect(qualityHit(scene, [-2, 0, 0], [1, 0, 0], .002, .9)).toBeUndefined();
    expect(qualityHit({ ...scene, boxes: [{ ...box, yaw: Math.PI / 4 }] }, [-2, 0, 0], [1, 0, 0])!.distance).toBeCloseTo(2 - Math.SQRT2, 12);
  });

  it('integrates at the requested height and preserves irradiance/pi normalization', () => {
    const base = createReflectionScene(); const scene = { ...base, light: { ...base.light, radiance: [0, 0, 0] as const },
      boxes: [{ id: 0, name: 'large emissive ceiling', center: [0, 2, 0] as const, halfSize: [100000, .005, 100000] as const, yaw: 0, materialId: 0 }],
      materials: [{ id: 0, albedo: [0, 0, 0] as const, emission: [2, .5, .25] as const, roughness: 1 }] };
    const below = integrateQualityReference(scene, [[0, 1.9, 0]], [0, 1, 0], 1024);
    expect(below.irradiance[0]! / Math.PI).toBeCloseTo(2, 10);
    expect(below.irradiance[1]! * .72 / Math.PI).toBeCloseTo(.36, 10);
    expect(below.directIrradiance).toEqual([0, 0, 0]);
    expect(integrateQualityReference(scene, [[0, 2.1, 0]], [0, 1, 0], 1024).irradiance).toEqual([0, 0, 0]);
    expect(qualityIncoming(scene, [0, 2, 0], [0, 1, 0]).status).toBe(-1);
  });

  it('identifies the elevated floor contributors and patch-cell boundary', () => {
    const negative = contributors([-.45, 0, -.3], config); const positive = contributors([-.45, 0, .75], config);
    expect(negative.map(item => item.id)).toEqual([149, 150, 197, 198]);
    expect(positive.map(item => item.id)).toEqual([197, 198, 245, 246]);
    expect(negative.every(item => item.position[1] === .5 && Math.abs(item.point[1] - .14) < 1e-12)).toBe(true);
    expect(contributors([-.51, 0, -.3], config).map(item => item.id)).toEqual([148, 149, 196, 197]);
  });

  it('folds actual upward octahedral taps and keeps all directions in their tile', () => {
    const up = octTaps([0, 1, 0], 8);
    expect(up.map(tap => [tap.x, tap.y, tap.weight])).toEqual([[3, 7, .5], [4, 7, .5]]);
    expect(up[0]!.direction[1]).toBeCloseTo(7 / Math.sqrt(50), 12);
    for (const direction of [[1, 0, 0], [-1, 0, 0], [0, -1, 0], [0, 0, -1], [-.2, -.8, -.5]] as const) {
      const taps = octTaps(direction, 16);
      expect(taps.reduce((sum, tap) => sum + tap.weight, 0)).toBeCloseTo(1, 12);
      expect(taps.every(tap => tap.x >= 0 && tap.x < 16 && tap.y >= 0 && tap.y < 16)).toBe(true);
      taps.forEach(tap => expect(Math.hypot(...tap.direction)).toBeCloseTo(1, 12));
    }
  });

  it('decodes binary16 observations without converting moments through half precision', () => {
    expect(halfFloat(0x3c00)).toBe(1); expect(halfFloat(0xc000)).toBe(-2); expect(halfFloat(1)).toBe(2 ** -24);
    expect(halfFloat(0x7c00)).toBe(Infinity); expect(Number.isNaN(halfFloat(0x7e00))).toBe(true);
    const bytes = new ArrayBuffer(96); const f = new Float32Array(bytes); const u = new Uint32Array(bytes);
    f.set([-5.5, .5, -3.5, 1]); u.set([12, 4, 8, 384], 4); u.set([160, 32, 64, 9], 8); f.set([.85, 32, .12, 32], 12); u.set([252, 0, 1337, 12, 24, 8, 16, 0], 16);
    expect(decodeQualityConfig(bytes)).toMatchObject({ frame: 252, epoch: 9, start: 160, maxAge: 12, grid: [12, 4, 8], momentSize: 16 });
  });

  it('separates finite irradiance and weighted receiver normalization', () => {
    const rays = [[2, .5, .25, 1, 0, 1, 0, 1], [2, .5, .25, 1, 0, -1, 0, 1]];
    expect(finiteRayIrradiance(rays, [0, 1, 0])[0]).toBeCloseTo(2 * Math.PI, 12);
    const probes = [1, 3].map((value, id) => ({ id, position: [0, .5, 0], state: [1, 1, 1, 240], taps: [], irradiance: [Math.PI * value, 0, 0] } as QualityProbe));
    const neighbors = [{ id: 0, weight: .75 }, { id: 1, weight: .25 }] as QualityNeighbor[];
    expect(combineQuality(probes, neighbors)[0]).toBeCloseTo(1.08, 12);
    expect(combineQuality(probes, neighbors, new Map([[0, [Math.PI, 0, 0]], [1, [Math.PI, 0, 0]]]))[0]).toBeCloseTo(.72, 12);
    expect(combineQuality(probes, neighbors.map(item => ({ ...item, weight: 0 })))).toEqual([0, 0, 0]);
    expect(visibilityWeight(.9, [1, 1])).toBe(1);
    expect(visibilityWeight(2, [1, 1])).toBeLessThan(1e-10);
  });
});
