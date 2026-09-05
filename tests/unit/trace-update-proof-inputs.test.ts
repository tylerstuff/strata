import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { GiRay } from '../../packages/core/src/gi/trace-data.js';
import type { GiTriangle } from '../../packages/core/src/gi/scene-data.js';
import { packGiRays } from '../../packages/core/src/gi/trace-data.js';
import { createIntegratedScene } from '../../packages/core/src/integrated/integrated-scene.js';
import { generatedTraceProxy, updateRayCorpus } from '../helpers/gi-trace-update-reference.js';
import { classifyReportedTriangle, traceWriteCanonicalWrites, traceWriteFailurePlan, traceWriteQueryStates, traceWriteRaySha256,
  traceWriteControlId, traceWriteReportedSourceInterval, traceWriteStates } from '../browser/trace-update-write-validation.js';
const triangle: GiTriangle = { id: 7, boxId: 2, materialId: 1, p0: [0, 0, 0], p1: [2, 0, 0], p2: [0, 2, 0], normal: [0, 0, 1] };
const ray = (x: number, y: number): GiRay => ({ origin: [x, y, 2], direction: [0, 0, -1], tMin: .001, tMax: 4 });
describe('frozen actual-write proof inputs and independent reported-primitive gates', () => {
  it('retains exact frozen f32 ray bytes and the complete preregistered edit/query sequences', () => {
    const rays = updateRayCorpus(createIntegratedScene(), createIntegratedScene).map(w => w.ray);
    expect(createHash('sha256').update(new Uint8Array(packGiRays(rays))).digest('hex')).toBe(traceWriteRaySha256);
    expect(traceWriteStates).toHaveLength(13); expect(traceWriteQueryStates).toHaveLength(8);
    expect(traceWriteQueryStates).toEqual([0, 1, 2, 4, 6, 8, 10, 11].map(index => traceWriteStates[index]));
    expect(traceWriteQueryStates).toEqual([{}, { objectOffset: -.4 }, { objectOffset: .4 }, { doorOpen: false },
      { wallColor: 'neutral' }, { wallColor: 'neutral', roughness: .3, lightIntensity: 0 },
      { objectOffset: -.4, doorOpen: false, wallColor: 'red', lightIntensity: 1, roughness: .08 }, {}]);
    expect(Object.isFrozen(traceWriteQueryStates) && traceWriteQueryStates.every(Object.isFrozen)).toBe(true);
    expect(traceWriteStates[12]).toEqual(traceWriteStates[11]);
    expect(traceWriteCanonicalWrites.reduce((s, w) => s + w.bytes, 0)).toBe(912);
    expect(traceWriteCanonicalWrites).toHaveLength(7);
  });
  it('uses plane/Gram geometry to accept interior distance and classify edges without consulting GPU values', () => {
    const interior = classifyReportedTriangle(ray(.5, .5), triangle);
    expect(interior.admissible).toBe(true); expect(interior.boundary).toBe(false);
    expect(interior.distance).toBe(2); expect(interior.weights).toEqual([.5, .25, .25]);
    const edge = classifyReportedTriangle(ray(1, 1), triangle);
    expect(edge.admissible).toBe(true); expect(edge.boundary).toBe(true); expect(edge.weights).toEqual([0, .5, .5]);
    expect(classifyReportedTriangle(ray(-.0001, .5), triangle).boundary).toBe(true);
  });
  it('does not use a boundary label to excuse an unrelated or far-outside triangle', () => {
    const outside = classifyReportedTriangle(ray(-1, .5), triangle);
    expect(outside.admissible).toBe(false); expect(outside.boundary).toBe(false);
    const unrelated = { ...triangle, p0: [20, 0, 0], p1: [22, 0, 0], p2: [20, 2, 0] } as GiTriangle;
    expect(classifyReportedTriangle(ray(.5, .5), unrelated).admissible).toBe(false);
    const parallel = classifyReportedTriangle({ ...ray(.5, .5), direction: [1, 0, 0] }, triangle);
    expect(parallel.boundary).toBe(true); expect(parallel.admissible).toBe(false); expect(parallel.distance).toBeNull();
  });
  it('accepts a nonnearest reported primitive only at that primitive’s own independently computed distance', () => {
    const farther: GiTriangle = { ...triangle, p0: [0, 0, -1], p1: [2, 0, -1], p2: [0, 2, -1] };
    const nearest = classifyReportedTriangle(ray(.5, .5), triangle), reported = classifyReportedTriangle(ray(.5, .5), farther);
    expect(nearest.distance).toBe(2); expect(reported.distance).toBe(3); expect(reported.admissible).toBe(true);
    expect(reported.boundary).toBe(false); // A nearest-only oracle would reject or misvalidate this any-hit result.
  });
  it('rejects an edge primitive outside the independent source segment even when another primitive is a valid hit', () => {
    const input = ray(1, 1);
    expect(classifyReportedTriangle(input, triangle).admissible).toBe(true);
    const after: GiTriangle = { ...triangle, p0: [0, 0, -10], p1: [2, 0, -10], p2: [0, 2, -10] };
    const outside = classifyReportedTriangle(input, after);
    expect(outside).toMatchObject({ distance: 12, weights: [0, .5, .5], boundary: true, inInterval: false, admissible: false });
    const before: GiTriangle = { ...triangle, p0: [0, 0, 3], p1: [2, 0, 3], p2: [0, 2, 3] };
    expect(classifyReportedTriangle(input, before)).toMatchObject({ distance: -1, boundary: true, inInterval: false, admissible: false });
  });
  it('bounds source endpoint rounding by the fixed distance gate without widening the returned GPU interval', () => {
    expect(traceWriteReportedSourceInterval).toMatchObject({ absolute: 2e-4, relative: 2e-5 });
    const input = ray(1, 1), allowance = 2e-4 + 2e-5 * input.tMax;
    const atDistance = (distance: number): GiTriangle => ({ ...triangle,
      p0: [0, 0, 2 - distance], p1: [2, 0, 2 - distance], p2: [0, 2, 2 - distance] });
    expect(classifyReportedTriangle(input, atDistance(input.tMax + allowance * .5))).toMatchObject({ boundary: true, inInterval: true, admissible: true });
    expect(classifyReportedTriangle(input, atDistance(input.tMax + allowance * 2))).toMatchObject({ boundary: true, inInterval: false, admissible: false });
  });
  it('freezes separate first/second/last write indices with a full-control plan distinct from incremental ranges', () => {
    const plans = traceWriteFailurePlan(generatedTraceProxy());
    expect(plans.map(p => p.arm)).toEqual(['incremental', 'full-correctness-only']);
    for (const p of plans) {
      expect(p.failureIndices).toEqual([0, 1, p.writes.length - 1]); expect(p.writes.length).toBeGreaterThanOrEqual(3);
      expect(p.writes.every(w => w.bytes > 0 && w.offset % 4 === 0 && w.bytes % 4 === 0)).toBe(true);
    }
    expect(plans[1]!.writes.map(w => w.buffer)).toEqual([0, 1, 2, 3, 4]);
    expect(plans[0]!.writes).not.toEqual(plans[1]!.writes);
  });
  it('identifies the selected bundled control without changing the default plan or numerical gates', () => {
    const original = traceWriteFailurePlan(generatedTraceProxy());
    const named = traceWriteFailurePlan(generatedTraceProxy(), 'full-performance');
    expect(named).toEqual(original.map((plan, index) => ({ ...plan, arm: index === 0 ? 'incremental' : 'full-performance' })));
    for (const id of ['full-correctness-only', 'full-performance']) expect(traceWriteControlId(id)).toBe(id);
    for (const id of [undefined, 'full', 'incremental', true]) expect(() => traceWriteControlId(id)).toThrow('control identity');
    // This test checks reporting only. The Node bundling test checks actual helper substitution.
  });
});
