import { describe, expect, it } from 'vitest';
import { parseGeometryManifest } from '../../packages/core/src/geometry/format.js';
import type { GeometryManifest } from '../../packages/core/src/geometry/format.js';
import { planRetainedResidency } from '../../packages/core/src/geometry/retained-residency.js';
import type { RetainedResidencyInput } from '../../packages/core/src/geometry/retained-residency.js';

type Groups = readonly (readonly (readonly number[])[])[];
type Demand = RetainedResidencyInput['demands'][number];
const sorted = (values: Iterable<number>) => [...values].sort((a, b) => a - b);
const mask = (values: Iterable<number>) => [...values].reduce((bits, id) => bits | (1 << id), 0);
const cardinality = (bits: number) => bits.toString(2).replaceAll('0', '').length;
const bitsToSet = (bits: number) => new Set(Array.from({ length: 12 }, (_, id) => id).filter(id => bits & (1 << id)));

/** Structural dependency fixtures; their triangles are not used for rendering. Every
 * cluster is uniquely owned, packed ranges do not overlap, and roots are parsed/pinned. */
function fixture(input: Groups): GeometryManifest {
  const side = Math.ceil(Math.sqrt(input.length));
  const groups = [...input, ...Array.from({ length: side * side - input.length }, () => [[0]])];
  const pageCount = Math.max(...groups.flat(2)) + 1; const offsets = Array(pageCount).fill(0) as number[];
  const bounds = { min: [0, -1, 0], max: [8, 1, 8] };
  const clusters: object[] = [];
  const tiles = groups.map((lods, id) => ({ id, bounds, lods: lods.map((pageIds, level) => ({
    level, error: level, pageIds: [...pageIds], clusterIds: pageIds.map((pageId, pageIndex) => {
      const triangleCount = level === 0 ? (pageIndex === 0 ? 129 - pageIds.length : 1) : 1;
      const clusterId = clusters.length; const vertexOffset = offsets[pageId]!; const indexOffset = vertexOffset + 96;
      offsets[pageId] = indexOffset + triangleCount * 12;
      clusters.push({ id: clusterId, pageId, vertexOffset, vertexCount: 3, indexOffset, indexCount: triangleCount * 3, triangleCount, bounds });
      return clusterId;
    }),
  })) }));
  return parseGeometryManifest({ format: 'strata-geometry', version: 1, pageBytes: 65536, vertexStride: 32, indexFormat: 'uint32',
    source: { kind: 'analytic-heightfield-v1', seed: 1, tilesPerSide: side, cellsPerTile: 8, cellSize: 1, triangleCount: side * side * 128 },
    bounds, rootPageIds: [0], pages: Array.from({ length: pageCount }, (_, id) => ({ id, url: `pages/${String(id).padStart(6, '0')}.bin`,
      byteLength: 65536, sha256: '0'.repeat(64), pinned: id === 0 })), clusters, tiles });
}

function input(resident: number[], capacityPages: number, demands: Demand[], failed: number[] = []): RetainedResidencyInput {
  return { residentPageIds: new Set(resident), capacityPages, demands, terminalFailedPageIds: new Set(failed) };
}

/** Independent exhaustive reference: enumerate every physically complete choice and
 * every legal whole target, then rank sets. This does not follow the planner's loops
 * or retain a previously planned/observed selected level. Small fixtures use bit sets. */
function reference(manifest: GeometryManifest, state: RetainedResidencyInput) {
  const resident = mask(state.residentPageIds); const failed = mask(state.terminalFailedPageIds);
  const choices = state.demands.map(demand => {
    const complete = manifest.tiles[demand.tileId]!.lods.filter(lod => (mask(lod.pageIds) & resident) === mask(lod.pageIds));
    const rank = (level: number) => level === demand.lod ? 0 : level < demand.lod ? 100 + demand.lod - level : 200 + level - demand.lod;
    const selected = complete.reduce((best, lod) => rank(lod.level) < rank(best.level) ? lod : best);
    return { demand, selected };
  });
  const protectedBits = choices.reduce((bits, choice) => bits | mask(choice.selected.pageIds), mask(manifest.rootPageIds));
  const candidates = choices.flatMap(({ demand, selected }) => manifest.tiles[demand.tileId]!.lods
    .filter(lod => selected.level > demand.lod ? lod.level >= demand.lod && lod.level < selected.level : selected.level < demand.lod && lod.level === demand.lod)
    .map(lod => {
      const missing = mask(lod.pageIds) & ~resident;
      return { demand, lod, missing, blocked: (missing & failed) !== 0, union: protectedBits | mask(lod.pageIds) };
    }));
  const eligible = candidates.filter(candidate => !candidate.blocked && candidate.missing !== 0 && cardinality(candidate.union) <= state.capacityPages);
  const order = (a: typeof eligible[number], b: typeof eligible[number]) => b.demand.priority - a.demand.priority || a.demand.tileId - b.demand.tileId || a.lod.level - b.lod.level;
  const target = eligible.length ? [...eligible].sort(order)[0]! : null;
  return { choices, protectedBits, candidates, eligible, target };
}

function assertReference(manifest: GeometryManifest, state: RetainedResidencyInput) {
  const expected = reference(manifest, state); const actual = planRetainedResidency(manifest, state);
  expect([...actual.selectedLods]).toEqual(expected.choices.map(choice => [choice.demand.tileId, choice.selected.level]));
  expect(sorted(actual.protectedPageIds)).toEqual(sorted(bitsToSet(expected.protectedBits)));
  const wanted = expected.target?.union ?? expected.protectedBits;
  expect(sorted(actual.wantedPageIds)).toEqual(sorted(bitsToSet(wanted)));
  expect(new Set(actual.pageOrder)).toEqual(actual.wantedPageIds);
  expect(actual.pageOrder.length).toBe(actual.wantedPageIds.size);
  expect(actual.wantedPageIds.size).toBeLessThanOrEqual(state.capacityPages);
  expect([...actual.protectedPageIds].every(pageId => state.residentPageIds.has(pageId))).toBe(true);
  if (expected.target) {
    expect(actual.target).toMatchObject({ tileId: expected.target.demand.tileId, lod: expected.target.lod.level });
    expect(sorted(actual.target!.pageIds)).toEqual(sorted(expected.target.lod.pageIds));
    expect(sorted(actual.target!.missingPageIds)).toEqual(sorted(bitsToSet(expected.target.missing)));
    expect(actual.target!.missingPageIds.length).toBeGreaterThan(0);
  } else expect(actual.target).toBeNull();
  expect(actual.unsatisfiedDemandCount).toBe(expected.choices.filter(choice => choice.selected.level !== choice.demand.lod).length);
  const feasibleTiles = new Set(expected.eligible.map(candidate => candidate.demand.tileId));
  expect(actual.deferredDemandCount).toBe(feasibleTiles.size - Number(expected.target !== null));
  const blocked = expected.choices.filter(choice => choice.selected.level !== choice.demand.lod && !feasibleTiles.has(choice.demand.tileId));
  expect(actual.blockedDemands.map(item => item.tileId)).toEqual(blocked.map(item => item.demand.tileId));
  for (const item of actual.blockedDemands) {
    const options = expected.candidates.filter(candidate => candidate.demand.tileId === item.tileId && !candidate.blocked);
    expect(item.reason).toBe(options.length ? 'capacity' : 'failed');
    expect(item.minimumRequiredPages).toBe(options.length ? Math.min(...options.map(candidate => cardinality(candidate.union))) : null);
    expect(item.desiredLod).toBe(state.demands.find(demand => demand.tileId === item.tileId)!.lod);
    expect(item.selectedLod).toBe(actual.selectedLods.get(item.tileId));
  }
  return actual;
}

describe('retained residency against independent complete-set enumeration', () => {
  it('exhaustively matches GPU preference and feasible whole-target ranking on shared pages', () => {
    const manifest = fixture([[[1, 2], [3], [0]], [[2, 4], [1, 4], [0]]]);
    let cases = 0;
    for (let bits = 1; bits < 32; bits += 2) {
      const residents = sorted(bitsToSet(bits));
      for (let capacity = residents.length; capacity <= 5; capacity++) {
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
          for (const demands of [
            [{ tileId: 0, lod: a, priority: 2 }, { tileId: 1, lod: b, priority: 1 }],
            [{ tileId: 1, lod: b, priority: 2 }, { tileId: 0, lod: a, priority: 1 }],
            [{ tileId: 0, lod: a, priority: 1 }, { tileId: 1, lod: b, priority: 1 }],
          ]) {
            assertReference(manifest, input(residents, capacity, demands)); cases++;
          }
        }
      }
    }
    expect(cases).toBe(1296);
  });

  it('immediately protects an incidental better choice completed by another tile target', () => {
    const manifest = fixture([[[3, 4], [1], [0]], [[4, 5], [2], [0]]]);
    const demands = [{ tileId: 0, lod: 0, priority: 2 }, { tileId: 1, lod: 0, priority: 1 }];
    const initial = assertReference(manifest, input([0, 1, 2, 5], 6, demands));
    expect(initial.target).toMatchObject({ tileId: 0, lod: 0 });
    expect(sorted(initial.protectedPageIds)).toEqual([0, 1, 2]);
    const partial = assertReference(manifest, input([0, 1, 2, 3, 5], 6, demands));
    expect([...partial.selectedLods.values()]).toEqual([1, 1]);
    const complete = assertReference(manifest, input([0, 1, 2, 3, 4, 5], 6, demands));
    expect([...complete.selectedLods.values()]).toEqual([0, 0]);
    expect(sorted(complete.protectedPageIds)).toEqual([0, 3, 4, 5]);
    expect(complete.protectedPageIds.has(5)).toBe(true);
    expect(complete.target).toBeNull();
  });

  it('abandons a partial target when incidental completion expands the protected union', () => {
    const manifest = fixture([[[3, 4, 5], [1], [0]], [[3, 6, 7], [2], [0]]]);
    const demands = [{ tileId: 0, lod: 0, priority: 2 }, { tileId: 1, lod: 0, priority: 1 }];
    const initial = assertReference(manifest, input([0, 1, 2, 6, 7], 6, demands));
    expect(initial.target).toMatchObject({ tileId: 0, lod: 0, missingPageIds: [3, 4, 5] });
    expect(sorted(initial.wantedPageIds)).toEqual([0, 1, 2, 3, 4, 5]);

    // One admitted upload completes B using its two previously unprotected pages.
    // They must now stay pinned, even though that prevents finishing A's target.
    const afterUpload = assertReference(manifest, input([0, 1, 2, 3, 6, 7], 6, demands));
    expect([...afterUpload.selectedLods.values()]).toEqual([1, 0]);
    expect(sorted(afterUpload.protectedPageIds)).toEqual([0, 1, 3, 6, 7]);
    expect(afterUpload.target).toBeNull();
    expect(afterUpload.blockedDemands).toEqual([
      { tileId: 0, desiredLod: 0, selectedLod: 1, reason: 'capacity', minimumRequiredPages: 7 },
    ]);
    expect(afterUpload.wantedPageIds.has(4)).toBe(false);
    expect(afterUpload.wantedPageIds.has(5)).toBe(false);
  });

  it('preserves selected dependencies when a direct transition cannot overlap', () => {
    const manifest = fixture([[[1, 2], [3, 4], [0]]]);
    const plan = assertReference(manifest, input([0, 3, 4], 3, [{ tileId: 0, lod: 0, priority: 1 }]));
    expect(plan.target).toBeNull(); expect(sorted(plan.wantedPageIds)).toEqual([0, 3, 4]);
    expect(plan.blockedDemands).toEqual([{ tileId: 0, desiredLod: 0, selectedLod: 1, reason: 'capacity', minimumRequiredPages: 5 }]);
  });

  it('admits a feasible intermediate without claiming the unavailable exact target is ready', () => {
    const manifest = fixture([[[1, 2, 3], [4], [5], [0]]]); const demand = [{ tileId: 0, lod: 0, priority: 1 }];
    const plan = assertReference(manifest, input([0, 5], 3, demand));
    expect(plan.selectedLods.get(0)).toBe(2); expect(plan.target).toMatchObject({ tileId: 0, lod: 1, missingPageIds: [4] });
    expect(plan.unsatisfiedDemandCount).toBe(1); expect(sorted(plan.wantedPageIds)).toEqual([0, 4, 5]);
    const arrived = assertReference(manifest, input([0, 4, 5], 3, demand));
    expect(arrived.selectedLods.get(0)).toBe(1); expect(arrived.target).toBeNull();
    expect(sorted(arrived.protectedPageIds)).toEqual([0, 4]);
  });

  it('never coarsens a retained finer fallback beyond its exact new desired level', () => {
    const manifest = fixture([[[1, 2], [3, 4], [5], [0]]]);
    const fine = assertReference(manifest, input([0, 1, 2], 4, [{ tileId: 0, lod: 1, priority: 1 }]));
    expect(fine.selectedLods.get(0)).toBe(0); expect(fine.target).toBeNull();
    expect(fine.unsatisfiedDemandCount).toBe(1); // Exact-target demand differs from GPU detail shortfall.
    const room = assertReference(manifest, input([0, 1, 2], 5, [{ tileId: 0, lod: 1, priority: 1 }]));
    expect(room.target).toMatchObject({ tileId: 0, lod: 1, missingPageIds: [3, 4] });
    const changed = assertReference(manifest, input([0, 1, 2], 4, [{ tileId: 0, lod: 2, priority: 1 }]));
    expect(changed.target).toMatchObject({ tileId: 0, lod: 2, missingPageIds: [5] });
  });

  it('prioritizes feasible demands deterministically and defers only feasible alternatives', () => {
    const manifest = fixture([[[1, 2], [0]], [[3], [0]]]);
    const equal = [{ tileId: 0, lod: 0, priority: 1 }, { tileId: 1, lod: 0, priority: 1 }];
    const plan = assertReference(manifest, input([0], 3, equal));
    expect(plan.target!.tileId).toBe(0); expect(plan.deferredDemandCount).toBe(1);
    expect(plan.blockedDemands).toEqual([]);
    const smaller = assertReference(manifest, input([0], 2, equal));
    expect(smaller.target!.tileId).toBe(1); expect(smaller.deferredDemandCount).toBe(0);
    expect(smaller.blockedDemands[0]!.tileId).toBe(0);
    expect(planRetainedResidency(manifest, input([0], 3, equal))).toEqual(plan);
  });

  it('gates failed missing requests while preserving physically resident failed-marked pages', () => {
    const manifest = fixture([[[1, 2], [3], [0]]]); const demand = [{ tileId: 0, lod: 0, priority: 1 }];
    const skip = assertReference(manifest, input([0], 4, demand, [1]));
    expect(skip.target).toMatchObject({ tileId: 0, lod: 1 });
    const blocked = assertReference(manifest, input([0], 4, demand, [1, 3]));
    expect(blocked.target).toBeNull(); expect(blocked.blockedDemands[0]!.reason).toBe('failed');
    const resident = assertReference(manifest, input([0, 1, 2], 3, demand, [0, 1, 2]));
    expect(resident.selectedLods.get(0)).toBe(0); expect(sorted(resident.protectedPageIds)).toEqual([0, 1, 2]);
    const mixed = assertReference(manifest, input([0, 1], 3, demand, [1]));
    expect(mixed.target).toMatchObject({ tileId: 0, lod: 0, missingPageIds: [2] });
  });

  it('enumerates failure flags independently of physical completeness across shared targets', () => {
    const manifest = fixture([[[1, 2], [3], [0]], [[2, 4], [1, 4], [0]]]);
    let cases = 0;
    for (let residents = 1; residents < 32; residents += 2) {
      for (let failed = 0; failed < 32; failed++) {
        for (let desired = 0; desired < 3; desired++) {
          const demands = [{ tileId: 0, lod: desired, priority: 1 }, { tileId: 1, lod: desired, priority: 1 }];
          assertReference(manifest, input(sorted(bitsToSet(residents)), cardinality(residents), demands, sorted(bitsToSet(failed))));
          cases++;
        }
      }
    }
    expect(cases).toBe(1536);
  });

  it('protects only roots when demand disappears and never fabricates progress from spare pages', () => {
    const manifest = fixture([[[1, 2], [3], [0]]]); const state = input([0, 1, 3], 3, []);
    const before = { resident: sorted(state.residentPageIds), failed: sorted(state.terminalFailedPageIds), demands: JSON.stringify(state.demands), manifest: JSON.stringify(manifest) };
    const plan = assertReference(manifest, state);
    expect(sorted(plan.protectedPageIds)).toEqual([0]); expect(plan.target).toBeNull(); expect(plan.unsatisfiedDemandCount).toBe(0);
    expect({ resident: sorted(state.residentPageIds), failed: sorted(state.terminalFailedPageIds), demands: JSON.stringify(state.demands), manifest: JSON.stringify(manifest) }).toEqual(before);
    const noSpace = assertReference(manifest, input([0], 1, [{ tileId: 0, lod: 0, priority: 1 }]));
    expect(noSpace.selectedLods.get(0)).toBe(2); expect(noSpace.target).toBeNull();
    expect(sorted(noSpace.pageOrder)).toEqual([0]);
  });

  it('rejects inconsistent capacity, IDs and noncanonical demand order', () => {
    const manifest = fixture([[[1, 2], [0]], [[3], [0]]]); const a = { tileId: 0, lod: 0, priority: 1 }; const b = { tileId: 1, lod: 0, priority: 1 };
    for (const state of [input([], 2, []), input([0, 1], 1, []), input([0], 1.5, []), input([0], 0, []),
      input([0, 9], 2, []), input([0], 2, [], [9]), input([0], 2, [a, a]), input([0], 2, [b, a]),
      input([0], 2, [{ ...a, lod: 9 }]), input([0], 2, [{ ...a, tileId: 9 }]), input([0], 2, [{ ...a, priority: NaN }])]) {
      expect(() => planRetainedResidency(manifest, state)).toThrow();
    }
  });
});
