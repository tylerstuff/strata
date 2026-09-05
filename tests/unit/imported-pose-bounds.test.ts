import { describe, expect, it } from 'vitest';
import { importedPoseBoundsLimits, measureImportedPoseBounds } from '../../packages/core/src/imported/imported-pose-bounds.js';
import type { ImportedAsset, ImportedBounds, ImportedNode, ImportedPrimitive, ImportedVec3 } from '../../packages/core/src/imported/imported-types.js';

// Generated CPU geometry only. Expected positions below are analytic; these
// tests deliberately do not import the production animation/matrix evaluator.
const rest = { clipId: null, timeSeconds: 0, loop: false } as const;
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const node = (patch: Partial<ImportedNode> = {}): ImportedNode => ({
  parent: null, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], ...patch,
});
function vertices(points: readonly ImportedVec3[]): Float32Array<ArrayBuffer> {
  return new Float32Array(points.flatMap(point => [...point, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1]));
}
function primitive(points: readonly ImportedVec3[], indices = [0, 1, 2]): ImportedPrimitive {
  return { name: 'Generated triangle', vertices: vertices(points), indices: new Uint32Array(indices), material: 0 };
}
function asset(primitives: readonly ImportedPrimitive[], patch: Partial<ImportedAsset> = {}): ImportedAsset {
  return {
    version: 1, sourceUrl: 'https://generated.invalid/pose-bounds.gltf', primitives,
    materials: [{ name: 'Generated opaque', baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1,
      emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1, occlusionStrength: 1, alphaMode: 'OPAQUE', alphaCutoff: .5, doubleSided: false }],
    images: [], bounds: { min: [-100, -100, -100], max: [100, 100, 100] },
    sourceBounds: { min: [-100, -100, -100], max: [100, 100, 100] },
    normalization: { scale: 1, translation: [0, 0, 0] }, maxTextureDimension: 2048, warnings: [], clips: [],
    stats: { meshInstances: primitives.length, primitives: primitives.length,
      vertices: primitives.reduce((sum, value) => sum + value.vertices.length / 16, 0),
      triangles: primitives.reduce((sum, value) => sum + value.indices.length / 3, 0), materials: 1, images: 0,
      encodedBytes: 0, geometryBytes: primitives.reduce((sum, value) => sum + value.vertices.byteLength + value.indices.byteLength, 0),
      skinnedMeshInstances: primitives.filter(value => value.deformation?.skin !== undefined).length, animationClips: 0 },
    ...patch,
  };
}
function tightBounds(actual: ImportedBounds, min: ImportedVec3, max: ImportedVec3) {
  for (let axis = 0; axis < 3; axis++) {
    // Enclosure permits the separately exposed f32 rounding pad; the bound must
    // still be tight enough to distinguish a posed model from rest/joint boxes.
    expect(actual.min[axis]).toBeLessThanOrEqual(min[axis]! + 1e-7);
    expect(actual.max[axis]).toBeGreaterThanOrEqual(max[axis]! - 1e-7);
    expect(Math.abs(actual.min[axis]! - min[axis]!)).toBeLessThan(.002);
    expect(Math.abs(actual.max[axis]! - max[axis]!)).toBeLessThan(.002);
  }
}

describe('CPU imported pose bounds from indexed model geometry', () => {
  it('ignores unused accessor extremes and asset rest bounds, and counts repeated indices once per vertex', async () => {
    const mesh = primitive([[-1, 0, 0], [1, 0, 0], [0, 2, 0], [1000, -1000, 1000]], [2, 0, 1, 2, 1, 0]);
    // Static positions are already normalized world coordinates. Normalization
    // must not be applied for a second time on this fast path.
    const source = asset([mesh], { normalization: { scale: 7, translation: [100, 200, 300] } });
    const before = structuredClone(source);
    const measured = await measureImportedPoseBounds(source, rest);
    tightBounds(measured.bounds, [-1, 0, 0], [1, 2, 0]);
    expect(measured.unpaddedBounds).toEqual(measured.bounds);
    expect(measured.padding).toEqual([0, 0, 0]);
    expect(measured.work).toMatchObject({ primitives: 1, indexEntries: 6, uniqueVertices: 3,
      staticVertices: 3, rigidVertices: 0, skinnedVertices: 0, jointContributions: 0 });
    expect(source).toEqual(before);
    expect(measured.animation).toEqual(rest);
    expect(measured.cpuMs).toBeGreaterThanOrEqual(0);
    expect(measured.elapsedMs).toBeGreaterThanOrEqual(measured.cpuMs);
  });

  it('does not deduplicate rendered instances merely because they share vertex and index buffers', async () => {
    const first = primitive([[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
    const second: ImportedPrimitive = { ...first, deformation: { node: 0, vertices: first.vertices } };
    const source = asset([first, second], { rig: { nodes: [node({ translation: [10, 0, 0] })], skins: [] } });
    const measured = await measureImportedPoseBounds(source, rest);
    tightBounds(measured.bounds, [0, 0, 0], [11, 1, 0]);
    expect(measured.work).toMatchObject({ primitives: 2, indexEntries: 6, uniqueVertices: 6, staticVertices: 3, rigidVertices: 3 });
  });

  it('uses hierarchy rotation, nonuniform scale, root motion and normalization once at the normalized clip time', async () => {
    const mesh = primitive([[0, 0, 0], [1, 0, 0], [0, 1, 2]]);
    const source = asset([{ ...mesh, deformation: { node: 1, vertices: mesh.vertices } }], {
      normalization: { scale: .5, translation: [-5, 2, -1] },
      rig: { nodes: [node({ translation: [10, 0, 0] }), node({ parent: 0, translation: [0, 2, 0], scale: [2, 3, 1] })], skins: [] },
      clips: [{ id: 'turn', name: 'Generated turn', duration: 2, channels: [
        { node: 0, path: 'translation', interpolation: 'LINEAR', times: new Float32Array([0, 2]), values: new Float32Array([10, 0, 0, 14, 0, 0]) },
        { node: 1, path: 'rotation', interpolation: 'LINEAR', times: new Float32Array([0, 2]), values: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0]) },
      ] }],
    });
    // t=1: (x,y,z) -> (1-1.5*y, 3+x, -1+.5*z).
    const middle = await measureImportedPoseBounds(source, { clipId: 'turn', timeSeconds: 1, loop: false });
    tightBounds(middle.bounds, [-.5, 3, -1], [1, 4, 0]);
    const wrapped = await measureImportedPoseBounds(source, { clipId: 'turn', timeSeconds: 5, loop: true });
    expect(wrapped.bounds).toEqual(middle.bounds);
    expect(wrapped.animation).toEqual({ clipId: 'turn', timeSeconds: 1, loop: true });
    // Held endpoint t=2: (x,y,z) -> (2-x, 3-1.5*y, -1+.5*z).
    const held = await measureImportedPoseBounds(source, { clipId: 'turn', timeSeconds: 5, loop: false });
    tightBounds(held.bounds, [1, 1.5, -1], [2, 3, 0]);
    expect(held.animation).toEqual({ clipId: 'turn', timeSeconds: 2, loop: false });
  });

  it('measures actual weighted skin vertices with inverse binds and reflected scale instead of per-joint boxes', async () => {
    const mesh = primitive([[0, 0, 0], [2, 0, 0], [0, 2, 2]]);
    const firstBind = identity(); firstBind[12] = -1;
    const secondBind = identity(); secondBind[13] = -2;
    const source = asset([{ ...mesh, deformation: { node: 2, vertices: mesh.vertices, skin: 0,
      joints: new Uint32Array([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]),
      weights: new Float32Array([.25, .75, 0, 0, .25, .75, 0, 0, .25, .75, 0, 0]) } }], {
      normalization: { scale: .25, translation: [1, -1, 2] },
      rig: { nodes: [node({ translation: [4, 0, 0] }), node({ translation: [0, 4, 0], scale: [-2, 3, .5] }),
        node({ translation: [1000, 1000, 1000] })], skins: [{ joints: [0, 1], inverseBindMatrices: new Float32Array([...firstBind, ...secondBind]) }] },
    });
    // The unrelated mesh-node translation must not be reapplied to a skin.
    // Weighted world position is (1.1875-.3125*x, -1.375+.625*y, 2+.15625*z).
    const measured = await measureImportedPoseBounds(source, rest);
    tightBounds(measured.bounds, [.5625, -1.375, 2], [1.1875, -.125, 2.3125]);
    // The shader reads all four palette slots, including the two zero weights.
    expect(measured.work).toMatchObject({ uniqueVertices: 3, skinnedVertices: 3, jointContributions: 12 });
  });
});

describe('CPU rounding enclosure for the published f32 pose palettes', () => {
  it('pads by absolute affine contributions when a small result hides large cancellation', async () => {
    const offset = 2 ** 24;
    const points: ImportedVec3[] = [[offset, 1, 0], [offset, 3, 0], [offset, 1, 1]];
    const mesh = primitive(points);
    const matrix = new Float32Array([1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, -offset, 0, 0, 1]);
    const measured = await measureImportedPoseBounds(asset([{ ...mesh, deformation: { node: 0, vertices: mesh.vertices } }], {
      rig: { nodes: [node({ matrix })], skins: [] },
    }), rest);
    expect(measured.unpaddedBounds).toEqual({ min: [1, 1, 0], max: [3, 3, 1] });
    // Explicit f32 add-then-translate loses/rounds the small local Y: x=0 or 4.
    // This operation model is independent of the production pose evaluator;
    // other permitted hardware arithmetic orders need not match it exactly.
    const rounded = points.map(([x, y, z]) => [Math.fround(Math.fround(x + y) - offset), y, z] as ImportedVec3);
    expect(rounded.map(point => point[0])).toEqual([0, 4, 0]);
    encloses(measured.bounds, rounded);
    expect(measured.padding[0]).toBeGreaterThanOrEqual(1);
    expect(measured.padding[0]).toBeGreaterThan(1000 * measured.padding[1]);
    paddedExactly(measured);
  });

  it('encloses independently rounded normalized-weight blending without changing the analytic nominal bounds', async () => {
    const points: ImportedVec3[] = [[100, 0, 0], [101, 1, 0], [100, 0, 1]];
    const mesh = primitive(points), translations = [1000, -1000, 333, -333];
    const weights = new Float32Array([.1, .2, .3, .4]);
    const source = asset([{ ...mesh, deformation: { node: 0, vertices: mesh.vertices, skin: 0,
      joints: new Uint32Array([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]),
      weights: new Float32Array([...weights, ...weights, ...weights]) } }], {
      rig: { nodes: translations.map(x => node({ translation: [x, 0, 0] })),
        skins: [{ joints: [0, 1, 2, 3], inverseBindMatrices: new Float32Array([...identity(), ...identity(), ...identity(), ...identity()]) }] },
    });
    const measured = await measureImportedPoseBounds(source, rest);
    const sum = [...weights].reduce((total, weight) => total + weight, 0);
    const translation = [...weights].reduce((total, weight, index) => total + weight * translations[index]!, 0) / sum;
    expect(measured.unpaddedBounds.min[0]).toBeCloseTo(100 + translation, 10);
    expect(measured.unpaddedBounds.max[0]).toBeCloseTo(101 + translation, 10);
    for (const order of [[0, 1, 2, 3], [3, 2, 1, 0]]) {
      const sumF32 = order.reduce((total, index) => Math.fround(total + weights[index]!), 0);
      const normalized = [...weights].map(weight => Math.fround(weight / sumF32));
      const linearF32 = order.reduce((total, index) => Math.fround(total + normalized[index]!), 0);
      const translationF32 = order.reduce((total, index) => Math.fround(total + Math.fround(normalized[index]! * translations[index]!)), 0);
      encloses(measured.bounds, points.map(([x, y, z]) => [
        Math.fround(Math.fround(linearF32 * x) + translationF32), Math.fround(linearF32 * y), Math.fround(linearF32 * z),
      ]));
    }
    expect(measured.work.jointContributions).toBe(12);
    paddedExactly(measured);
  });

  it('accounts for a subnormal skin weight being flushed before multiplication by a large finite palette', async () => {
    const mesh = primitive([[0, 0, 0], [0, 0, 0], [0, 0, 0]]), tiny = 2 ** -127;
    const source = asset([{ ...mesh, deformation: { node: 0, vertices: mesh.vertices, skin: 0,
      joints: new Uint32Array([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0]),
      weights: new Float32Array([1, tiny, 0, 0, 1, tiny, 0, 0, 1, tiny, 0, 0]) } }], {
      rig: { nodes: [node(), node({ translation: [2 ** 100, 0, 0] })],
        skins: [{ joints: [0, 1], inverseBindMatrices: new Float32Array([...identity(), ...identity()]) }] },
    });
    const measured = await measureImportedPoseBounds(source, rest);
    expect(measured.unpaddedBounds.min[0]).toBe(2 ** -27);
    expect(measured.unpaddedBounds.max[0]).toBe(2 ** -27);
    // Flushing the positive tiny weight gives x=0, outside the nominal point.
    encloses(measured.bounds, [[0, 0, 0]]);
    expect(measured.padding[0]).toBeGreaterThanOrEqual(2 ** -27);
  });
});

function encloses(bounds: ImportedBounds, points: readonly ImportedVec3[]) {
  for (const point of points) for (let axis = 0; axis < 3; axis++) {
    expect(bounds.min[axis]).toBeLessThanOrEqual(point[axis]!);
    expect(bounds.max[axis]).toBeGreaterThanOrEqual(point[axis]!);
  }
}
function paddedExactly(result: Awaited<ReturnType<typeof measureImportedPoseBounds>>) {
  for (let axis = 0; axis < 3; axis++) {
    expect(result.padding[axis]).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.padding[axis])).toBe(true);
    expect(result.bounds.min[axis]).toBe(result.unpaddedBounds.min[axis]! - result.padding[axis]!);
    expect(result.bounds.max[axis]).toBe(result.unpaddedBounds.max[axis]! + result.padding[axis]!);
  }
}

describe('CPU admission, cancellation and ownership', () => {
  it('rejects malformed geometry, unknown clips and invalid animation controls without mutating input', async () => {
    const mesh = primitive([[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
    for (const source of [asset([]), asset([{ ...mesh, indices: new Uint32Array([0, 1]) }]),
      asset([{ ...mesh, indices: new Uint32Array([0, 1, 99]) }]),
      asset([{ ...mesh, vertices: new Float32Array(15) }]),
      asset([primitive([[NaN, 0, 0], [1, 0, 0], [0, 1, 0]])]),
    ]) await expect(measureImportedPoseBounds(source, rest)).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    const source = asset([mesh]), before = structuredClone(source);
    for (const animation of [{ ...rest, clipId: 'missing' }, { ...rest, timeSeconds: -1 },
      { ...rest, timeSeconds: Infinity }, { ...rest, timeSeconds: NaN }, { ...rest, loop: 1 as never }]) {
      await expect(measureImportedPoseBounds(source, animation)).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    }
    expect(source).toEqual(before);
  });

  it('rejects invalid skin weights and even a zero-weight out-of-range palette slot', async () => {
    const mesh = primitive([[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
    const create = (joints: Uint32Array<ArrayBuffer>, weights: Float32Array<ArrayBuffer>) => asset([{ ...mesh,
      deformation: { node: 0, skin: 0, vertices: mesh.vertices, joints, weights },
    }], { rig: { nodes: [node()], skins: [{ joints: [0], inverseBindMatrices: identity() }] } });
    for (const first of [NaN, -.1, 0, .5, 2]) {
      const weights = new Float32Array([first, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
      await expect(measureImportedPoseBounds(create(new Uint32Array(12), weights), rest)).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    }
    const joints = new Uint32Array(12); joints[3] = 1;
    await expect(measureImportedPoseBounds(create(joints, new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])), rest))
      .rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
  });

  it('rejects unsafe affine intermediate magnitude even if the final sum would cancel', async () => {
    const large = Math.fround(2 ** 127), mesh = primitive([[large, 1, 0], [large, 2, 0], [large, 1, 1]]);
    const matrix = new Float32Array([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -large, 0, 0, 1]);
    await expect(measureImportedPoseBounds(asset([{ ...mesh, deformation: { node: 0, vertices: mesh.vertices } }], {
      rig: { nodes: [node({ matrix })], skins: [] },
    }), rest)).rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT' });
  });

  it('honors pre-abort and cancellation during duplicate-index traversal at bounded task yields', async () => {
    const indices = new Uint32Array(3 * importedPoseBoundsLimits.yieldWorkUnits * 8);
    const source = asset([{ ...primitive([[0, 0, 0], [1, 0, 0], [0, 1, 0]]), indices }]);
    const reason = new Error('Generated caller cancellation'), early = new AbortController();
    early.abort(reason);
    await expect(measureImportedPoseBounds(source, rest, { signal: early.signal }))
      .rejects.toMatchObject({ code: 'SCENE_LOAD_ABORTED', cause: reason });
    const active = new AbortController(); let taskTurns = 0;
    const pulse = setInterval(() => { if (++taskTurns === 3) active.abort(reason); }, 0);
    try {
      await expect(measureImportedPoseBounds(source, rest, { signal: active.signal }))
        .rejects.toMatchObject({ code: 'SCENE_LOAD_ABORTED', cause: reason });
      expect(taskTurns).toBeGreaterThanOrEqual(3);
    } finally { clearInterval(pulse); }
    expect(indices.every(value => value === 0)).toBe(true);
  });

  it('accounts for duplicate-index work and exposes timings without retaining result aliases', async () => {
    const indices = new Uint32Array(3 * importedPoseBoundsLimits.yieldWorkUnits);
    const mesh = { ...primitive([[0, 0, 0], [1, 0, 0], [0, 1, 0]]), indices };
    const source = asset([mesh]);
    const first = await measureImportedPoseBounds(source, rest), snapshot = structuredClone(first);
    expect(first.work.indexEntries).toBe(indices.length); expect(first.work.uniqueVertices).toBe(1);
    expect(first.work.yields).toBeGreaterThanOrEqual(3);
    expect(first.cpuMs).toBeGreaterThanOrEqual(0); expect(first.elapsedMs).toBeGreaterThan(first.cpuMs);
    // Borrowed input may be changed after settlement; old result arrays must not
    // alias it or the following query's scratch bounds.
    mesh.vertices[0] = 2;
    const second = await measureImportedPoseBounds(source, rest);
    expect(second.unpaddedBounds.min[0]).toBe(2);
    expect(first).toEqual(snapshot);
  });

  it('preflights aggregate indices and dedup memory with real shared buffers', async () => {
    const mesh = primitive([[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
    const excessiveIndices = new Uint32Array(Math.ceil((importedPoseBoundsLimits.maxIndexEntries + 1) / 3) * 3);
    await expect(measureImportedPoseBounds(asset([{ ...mesh, indices: excessiveIndices }]), rest))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT', message: expect.stringContaining('index entries') });
    const accessorCount = 8192, shared = { ...mesh, vertices: new Float32Array(accessorCount * 16) };
    const instances = Math.floor(importedPoseBoundsLimits.maxDedupBytes / Math.ceil(accessorCount / 8)) + 1;
    expect(instances).toBeLessThanOrEqual(importedPoseBoundsLimits.maxPrimitives);
    await expect(measureImportedPoseBounds(asset(Array.from({ length: instances }, () => shared)), rest))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT', message: expect.stringContaining('deduplication bytes') });
  });

  it('caps actual referenced unique vertices independently of repeated index count', async () => {
    const count = Math.ceil((importedPoseBoundsLimits.maxUniqueVertices + 1) / 3) * 3;
    const indices = Uint32Array.from({ length: count }, (_, index) => index);
    const mesh = { ...primitive([[0, 0, 0], [1, 0, 0], [0, 1, 0]]), vertices: new Float32Array(count * 16), indices };
    expect(indices.length).toBeLessThanOrEqual(importedPoseBoundsLimits.maxIndexEntries);
    await expect(measureImportedPoseBounds(asset([mesh]), rest))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT', message: expect.stringContaining('unique vertices') });
  }, 15_000);

  it('enforces the first applicable public limit for four-slot skin work', async () => {
    const jointVertexLimit = Math.floor(importedPoseBoundsLimits.maxJointContributions / 4);
    const count = Math.ceil((Math.min(jointVertexLimit, importedPoseBoundsLimits.maxUniqueVertices) + 1) / 3) * 3;
    // A joint cap may intentionally equal or exceed the general vertex cap.
    // Test that public policy instead of requiring artificial branch coverage.
    const limitName = jointVertexLimit < importedPoseBoundsLimits.maxUniqueVertices ? 'joint contributions' : 'unique vertices';
    const data = new Float32Array(count * 16), weights = new Float32Array(count * 4).fill(.25);
    const mesh: ImportedPrimitive = { name: 'Generated bounded skin work', vertices: data, material: 0,
      indices: Uint32Array.from({ length: count }, (_, index) => index),
      deformation: { node: 0, vertices: data, skin: 0, joints: new Uint32Array(count * 4), weights } };
    await expect(measureImportedPoseBounds(asset([mesh], { rig: { nodes: [node()], skins: [{ joints: [0], inverseBindMatrices: identity() }] } }), rest))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT', message: expect.stringContaining(limitName) });
  }, 15_000);

  it('bounds the synchronous pose-evaluator input before copying large curves', async () => {
    const mesh = primitive([[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
    await expect(measureImportedPoseBounds(asset([mesh], { rig: {
      nodes: Array.from({ length: importedPoseBoundsLimits.maxPoseNodes + 1 }, () => node()), skins: [],
    } }), rest)).rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT', message: expect.stringContaining('node count') });
    const keys = Math.floor(importedPoseBoundsLimits.maxPoseArrayBytes / 16) + 1;
    const source = asset([mesh], { rig: { nodes: [node()], skins: [] }, clips: [{ id: 'bounded', name: 'Generated large curve', duration: keys,
      channels: [{ node: 0, path: 'translation', interpolation: 'LINEAR',
        times: Float32Array.from({ length: keys }, (_, index) => index), values: new Float32Array(keys * 3) }] }] });
    await expect(measureImportedPoseBounds(source, rest))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT', message: expect.stringContaining('pose array bytes') });
  });
});
