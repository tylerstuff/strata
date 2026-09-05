import { describe, expect, it } from 'vitest';
import { composeTransform, relativePosition, renderTransform, transformPoint } from '../../prototypes/coordinates/coordinates.js';
import {
  getWorldCoordinateCatalog, getWorldCoordinateFixture, getWorldCoordinateFixtures, referenceBoxNormal, referenceBoxPoint,
} from '../fixtures/world-coordinates.js';
import type { FixtureBox, FixtureFrame, Vec3 } from '../fixtures/world-coordinates.js';

const OFFSETS = [0, 1_000, -1_000, 10_000, -10_000, 100_000, -100_000, 1_000_000, -1_000_000];
const POINTS: readonly Vec3[] = [[0, 0, 0], [-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]];
const TRANSLATION_TOLERANCE = 1e-9;
const PIXEL_TOLERANCE = 1e-6;
const DEPTH_TOLERANCE = 1e-9;
const offsetName = (offset: number): string => offset === 0 ? 'origin' : `${offset < 0 ? 'neg' : 'pos'}-${Math.abs(offset)}m`;

function expectVector(actual: readonly number[], expected: readonly number[], tolerance: number): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((value, axis) => expect(Math.abs(actual[axis]! - value)).toBeLessThanOrEqual(tolerance));
}

function model(box: FixtureBox) {
  return composeTransform({ ...box.transform, scale: box.transform.scale.map((value, axis) => value * box.dimensions[axis]!) as unknown as Vec3 });
}

function applyLinear(matrix: readonly number[], point: Vec3): Vec3 {
  return [0, 1, 2].map(row => matrix[row]! * point[0] + matrix[3 + row]! * point[1] + matrix[6 + row]! * point[2]) as unknown as Vec3;
}

function viewPoint(frame: FixtureFrame, point: Vec3): Vec3 {
  const camera = composeTransform({ position: [0, 0, 0], rotation: frame.camera.rotation, scale: [1, 1, 1] }).linear;
  // Invert the prototype's camera rotation by transposing its column-major matrix.
  return [0, 1, 2].map(column => camera[3 * column]! * point[0] + camera[3 * column + 1]! * point[1]
    + camera[3 * column + 2]! * point[2]) as unknown as Vec3;
}

/** Matrix form of the finite WebGPU projection, separate from the fixture's pinhole oracle. */
function project(frame: FixtureFrame, view: Vec3): { pixel: readonly number[]; depth: number; w: number } {
  const { near, far, aspect, verticalFovRadians } = frame.perspective;
  const focal = 1 / Math.tan(verticalFovRadians / 2);
  const rows = [[focal / aspect, 0, 0, 0], [0, focal, 0, 0], [0, 0, far / (near - far), near * far / (near - far)], [0, 0, -1, 0]];
  const clip = rows.map(row => row[0]! * view[0] + row[1]! * view[1] + row[2]! * view[2] + row[3]!);
  return { pixel: [(clip[0]! / clip[3]! + 1) * frame.viewport.width / 2, (1 - clip[1]! / clip[3]!) * frame.viewport.height / 2],
    depth: clip[2]! / clip[3]!, w: clip[3]! };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(value: Vec3): Vec3 {
  const length = Math.hypot(...value);
  return value.map(component => component / length) as unknown as Vec3;
}

describe('world-coordinate fixture data and independent oracle', () => {
  it('provides deterministic JSON data with all declared offsets and sequences', () => {
    const frames = getWorldCoordinateFixtures();
    expect(frames).toHaveLength(255);
    expect(new Set(frames.map(frame => frame.id)).size).toBe(frames.length);
    expect(frames.filter(frame => frame.sequence.startsWith('static-'))).toHaveLength(18);
    expect(frames.filter(frame => frame.sequence.startsWith('slow-'))).toHaveLength(192);
    expect(JSON.parse(JSON.stringify(frames))).toEqual(frames);
    expect(JSON.stringify(getWorldCoordinateFixtures())).toBe(JSON.stringify(frames));
    for (const frame of frames) {
      expect(frame.id).toBe(`${frame.sequence}/${frame.index}`);
      expect(getWorldCoordinateFixture(frame.id)).toBe(frame);
      expect(Object.isFrozen(frame)).toBe(true);
      expect(Object.isFrozen(frame.camera.position)).toBe(true);
      expect(Object.isFrozen(frame.boxes[0]!.transform.position)).toBe(true);
      expect(frame.viewport).toEqual({ width: 512, height: 512 });
      expect(frame.perspective).toEqual({ verticalFovRadians: 55 * Math.PI / 180, aspect: 1, near: 0.1, far: 32 });
      expect(frame.boxes).toHaveLength(frame.sequence === 'teleport-dyadic' ? 15 : 5);
      expect(frame.scope).toBe(frame.sequence === 'teleport-dyadic' ? 'numeric-only-far-clusters' : 'resident-preview-reference');
    }
    for (const variant of ['dyadic', 'decimal']) for (const offset of OFFSETS) {
      expect(getWorldCoordinateFixture(`static-${variant}-${offsetName(offset)}/0`).offset).toEqual([offset, offset === 0 ? 0 : -offset, offset]);
    }
  });

  it('matches hand-worked dyadic transform, pinhole and depth landmarks', () => {
    const id = 'static-dyadic-origin/0';
    const focal = 1 / Math.tan(55 * Math.PI / 360);
    const center = referenceBoxPoint(id, 'gap-left', [0, 0, 0]);
    expect(center.relative).toEqual([-17 / 2048, 0, -1]);
    expect(center.view).toEqual(center.relative);
    expect(center.clipW).toBe(1);
    expectVector(center.pixel!, [256 - 17 / 8 * focal, 256], 1e-12);
    expect(Math.abs(center.ndcDepth! - 288 / 319)).toBeLessThanOrEqual(5e-16);
    expect(center.insideClip).toBe(true);

    const corner = referenceBoxPoint(id, 'rotated', [0.5, 0.5, 0.5]);
    expect(corner.relative).toEqual([35 / 128, 1 / 4, -45 / 32]);
    expect(corner.clipW).toBe(45 / 32);
    expectVector(corner.pixel!, [256 + 448 / 9 * focal, 256 - 2048 / 45 * focal], 1e-12);
    expect(Math.abs(corner.ndcDepth! - 13_376 / 14_355)).toBeLessThanOrEqual(5e-16);
    expect(corner.insideClip).toBe(true);
  });

  it('uses inverse camera rotation, checked by an independently expanded rational yaw', () => {
    const reference = referenceBoxPoint('static-decimal-origin/0', 'gap-left', [0, 0, 0]);
    // For qY=40/401 and qW=399/401, cos=157601/160801 and sin=31920/160801.
    const denominator = 160_801 * 2_000;
    expectVector(reference.view, [(31_920 * 2_000 - 21 * 157_601) / denominator, 0,
      (-21 * 31_920 - 157_601 * 2_000) / denominator], 1e-15);
    expect(reference.view[0]).toBeGreaterThan(0);
    const wrongForwardRotationX = (-21 * 157_601 - 31_920 * 2_000) / denominator;
    expect(Math.abs(reference.view[0] - wrongForwardRotationX)).toBeGreaterThan(0.3);
  });

  it('preserves the independent exact and decimal gaps at every static offset', () => {
    for (const variant of ['dyadic', 'decimal']) for (const offset of OFFSETS) {
      const id = `static-${variant}-${offsetName(offset)}/0`;
      const left = referenceBoxPoint(id, 'gap-left', [0.5, 0, 0]);
      const right = referenceBoxPoint(id, 'gap-right', [-0.5, 0, 0]);
      const expectedGap = variant === 'dyadic' ? 1 / 1024 : 1 / 1000;
      expect(Math.abs(right.relative[0] - left.relative[0] - expectedGap)).toBeLessThanOrEqual(1e-15);
      expect(left.relative[2]).toBe(-1);
      expect(right.relative[2]).toBe(-1);
    }
  });

  for (const variant of ['dyadic', 'decimal'] as const) {
    it(`compares prototype CPU transforms and upload matrices with the ${variant} oracle`, () => {
      const frames = getWorldCoordinateFixtures().filter(frame => frame.variant === variant);
      for (const frame of frames) for (const box of frame.boxes) {
        const transform = model(box);
        const uploaded = renderTransform({ transform, origin: frame.camera.position });
        for (const point of POINTS) {
          const oracle = referenceBoxPoint(frame.id, box.id, point);
          const relative = relativePosition(transformPoint(transform, point), frame.camera.position);
          expectVector(relative, oracle.relative, TRANSLATION_TOLERANCE);
          const view = viewPoint(frame, relative);
          expectVector(view, oracle.view, TRANSLATION_TOLERANCE);
          const uploadedPoint = [0, 1, 2].map(row => uploaded[row]! * point[0] + uploaded[4 + row]! * point[1]
            + uploaded[8 + row]! * point[2] + uploaded[12 + row]!);
          for (let axis = 0; axis < 3; axis++) {
            // This budgets only CPU input and float32 storage error, not WGSL arithmetic.
            const magnitude = Math.abs(transform.position[axis]! - frame.camera.position[axis]!)
              + Math.abs(transform.linear[axis]! * point[0]) + Math.abs(transform.linear[3 + axis]! * point[1])
              + Math.abs(transform.linear[6 + axis]! * point[2]);
            expect(Math.abs(uploadedPoint[axis]! - oracle.relative[axis]!)).toBeLessThanOrEqual(TRANSLATION_TOLERANCE + magnitude * 2 ** -24);
          }
          if (oracle.pixel !== null) {
            const projected = project(frame, view);
            expectVector(projected.pixel, oracle.pixel, PIXEL_TOLERANCE);
            expect(Math.abs(projected.depth - oracle.ndcDepth!)).toBeLessThanOrEqual(DEPTH_TOLERANCE);
            expect(Math.abs(projected.w - oracle.clipW)).toBeLessThanOrEqual(TRANSLATION_TOLERANCE);
          }
        }
      }
    });
  }

  it('checks inverse-transpose normals using transformed tangent cross products', () => {
    const normalAndTangents: readonly [Vec3, Vec3, Vec3][] = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[1, 1, 0], [1, -1, 0], [0, 0, -1]],
    ];
    for (const variant of ['dyadic', 'decimal']) for (const offset of [0, 1_000_000, -1_000_000]) {
      const frame = getWorldCoordinateFixture(`static-${variant}-${offsetName(offset)}/0`);
      for (const box of frame.boxes) for (const [normal, u, v] of normalAndTangents) {
        const linear = model(box).linear;
        const expected = normalize(cross(applyLinear(linear, u), applyLinear(linear, v)));
        const oracle = referenceBoxNormal(frame.id, box.id, normal);
        expectVector(oracle, expected, 1e-14);
        expect(Math.abs(Math.hypot(...oracle) - 1)).toBeLessThanOrEqual(1e-15);
        expectVector(referenceBoxNormal(frame.id, box.id, normal.map(value => -value) as unknown as Vec3),
          oracle.map(value => -value), 1e-14);
      }
    }
    expectVector(referenceBoxNormal('static-dyadic-origin/0', 'rotated', [1, 1, 0]), [0, 3 / 5, 4 / 5], 1e-15);
    expectVector(referenceBoxNormal('static-decimal-origin/0', 'rotated', [1, 1, 0]), [-3 / 5, 4 / 5, 0], 1e-15);
    const frame = getWorldCoordinateFixture('static-dyadic-origin/0');
    const box = frame.boxes.find(value => value.id === 'rotated')!;
    const incorrectlyForwardScaled = normalize(applyLinear(model(box).linear, [1, 1, 0]));
    expect(Math.abs(incorrectlyForwardScaled[1] - 3 / 5)).toBeGreaterThan(0.1);
  });

  it('keeps slow-motion oracle frames equivalent across distant anchors without moving roots', () => {
    for (const variant of ['dyadic', 'decimal']) for (const offset of [0, 1_000_000, -1_000_000]) {
      const sequence = `slow-${variant}-${offsetName(offset)}`;
      const first = getWorldCoordinateFixture(`${sequence}/0`);
      let previousX = Infinity;
      for (let index = 0; index < 32; index++) {
        const frame = getWorldCoordinateFixture(`${sequence}/${index}`);
        expect(frame.boxes).toEqual(first.boxes);
        expect(frame.event).toBe('continuous');
        const oracle = referenceBoxPoint(frame.id, 'gap-left', [0, 0, 0]);
        expect(oracle).toEqual(referenceBoxPoint(`slow-${variant}-origin/${index}`, 'gap-left', [0, 0, 0]));
        expect(oracle.relative[0]).toBeLessThan(previousX);
        previousX = oracle.relative[0];
      }
    }
  });

  it('crosses the cell boundary in both directions with stable roots and continuity', () => {
    const first = getWorldCoordinateFixture('boundary-dyadic/0');
    for (let index = 0; index < 32; index++) {
      const frame = getWorldCoordinateFixture(`boundary-dyadic/${index}`);
      expect(frame.boxes).toEqual(first.boxes);
      expect(frame.event).toBe('continuous');
      const step = index < 16 ? index - 8 : 23 - index;
      expect(frame.camera.position[0]).toBe(999_936 + step / 1024);
      expect(Math.floor((frame.camera.position[0] + 512) / 1024)).toBe(index < 8 || index > 23 ? 976 : 977);
      expect(referenceBoxPoint(frame.id, 'gap-left', [0, 0, 0]).relative[0]).toBe(-17 / 2048 - step / 1024);
    }
  });

  it('marks cuts and camera teleports while preserving every preplaced root', () => {
    const beforeCut = getWorldCoordinateFixture('camera-cut-dyadic/0');
    const afterCut = getWorldCoordinateFixture('camera-cut-dyadic/1');
    expect(afterCut.event).toBe('camera-cut');
    expect(afterCut.boxes).toEqual(beforeCut.boxes);
    expect(afterCut.camera.rotation).not.toEqual(beforeCut.camera.rotation);
    const first = getWorldCoordinateFixture('teleport-dyadic/0');
    for (let index = 0; index < 4; index++) {
      const frame = getWorldCoordinateFixture(`teleport-dyadic/${index}`);
      expect(frame.event).toBe(index === 0 ? 'continuous' : 'teleport');
      expect(frame.boxes).toEqual(first.boxes);
      expect(frame.scope).toBe('numeric-only-far-clusters');
      // An explicit numeric witness that these snapshots exceed the later preview
      // profile's 4096 m local bound; this test does not implement that validator.
      const farRoots = frame.boxes.filter(box => referenceBoxPoint(frame.id, box.id, [0, 0, 0]).relative.some(value => Math.abs(value) > 4096));
      expect(farRoots).toHaveLength(10);
      const visibleIds = frame.boxes.filter(box => referenceBoxPoint(frame.id, box.id, [0, 0, 0]).insideClip).map(box => box.id);
      expect(visibleIds).toHaveLength(5);
      expect(visibleIds.every(id => id.startsWith(`${offsetName(frame.offset[0])}:`))).toBe(true);
    }
    const behind = referenceBoxPoint(first.id, 'pos-1000000m:gap-left', [0, 0, 0]);
    expect(behind.clipW).toBeLessThan(0);
    expect(behind.pixel).toBeNull(); expect(behind.ndcDepth).toBeNull(); expect(behind.insideClip).toBe(false);
    const beyondFar = referenceBoxPoint(first.id, 'neg-1000000m:gap-left', [0, 0, 0]);
    expect(beyondFar.clipW).toBeGreaterThan(first.perspective.far);
    expect(beyondFar.pixel).not.toBeNull(); expect(beyondFar.ndcDepth).toBeGreaterThan(1); expect(beyondFar.insideClip).toBe(false);
  });

  it('selects bounded replacement snapshots without changing the immutable global catalog', () => {
    const catalog = getWorldCoordinateCatalog();
    const original = JSON.stringify(catalog);
    expect(catalog).toHaveLength(15);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(new Set(catalog.map(box => box.id)).size).toBe(15);
    for (let index = 0; index < 4; index++) {
      const frame = getWorldCoordinateFixture(`replacement-dyadic/${index}`);
      expect(frame.event).toBe('scene-replacement');
      expect(frame.scope).toBe('resident-preview-reference');
      expect(frame.boxes).toHaveLength(5);
      for (const box of frame.boxes) {
        expect(box).toEqual(catalog.find(source => source.id === box.id));
        expect(box.id.startsWith(`${offsetName(frame.offset[0])}:`)).toBe(true);
      }
    }
    expect(getWorldCoordinateFixture('replacement-dyadic/3').boxes).toEqual(getWorldCoordinateFixture('replacement-dyadic/0').boxes);
    expect(JSON.stringify(getWorldCoordinateCatalog())).toBe(original);
  });

  it('keeps local camera teleports and every preview box corner within the declared local envelope', () => {
    const first = getWorldCoordinateFixture('local-teleport-dyadic/0');
    for (let index = 0; index < 3; index++) {
      const frame = getWorldCoordinateFixture(`local-teleport-dyadic/${index}`);
      expect(frame.event).toBe(index === 0 ? 'continuous' : 'teleport');
      expect(frame.boxes).toEqual(first.boxes);
      if (index > 0) expect(frame.camera.position).not.toEqual(first.camera.position);
    }
    for (const frame of getWorldCoordinateFixtures().filter(value => value.scope === 'resident-preview-reference')) {
      for (const box of frame.boxes) for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
        const corner = referenceBoxPoint(frame.id, box.id, [x, y, z]);
        expect(corner.relative.every(value => Math.abs(value) <= 4096)).toBe(true);
      }
    }
  });

  it('rejects unknown identities and non-oracle sample inputs', () => {
    const id = 'static-dyadic-origin/0';
    expect(() => getWorldCoordinateFixture('missing')).toThrow(RangeError);
    expect(() => referenceBoxPoint(id, 'missing', [0, 0, 0])).toThrow(RangeError);
    expect(() => referenceBoxNormal(id, 'missing', [1, 0, 0])).toThrow(RangeError);
    for (const point of [[0.1, 0, 0], [Infinity, 0, 0], [NaN, 0, 0], [0, 0]]) {
      expect(() => referenceBoxPoint(id, 'gap-left', point as unknown as Vec3)).toThrow(RangeError);
    }
    for (const normal of [[0, 0, 0], [0.5, 0, 0], [Infinity, 0, 0], [NaN, 0, 0], [1, 0]]) {
      expect(() => referenceBoxNormal(id, 'gap-left', normal as unknown as Vec3)).toThrow(RangeError);
    }
  });

  it('detects early float32 root conversion collapsing the positive gap into overlap', () => {
    for (const variant of ['dyadic', 'decimal']) for (const offset of [-1_000_000, 1_000_000]) {
      const frame = getWorldCoordinateFixture(`static-${variant}-${offsetName(offset)}/0`);
      const left = frame.boxes.find(box => box.id === 'gap-left')!;
      const right = frame.boxes.find(box => box.id === 'gap-right')!;
      const roundedCenterSeparation = Math.fround(right.transform.position[0]) - Math.fround(left.transform.position[0]);
      expect(roundedCenterSeparation).toBe(0);
      const wrongGap = roundedCenterSeparation - (left.dimensions[0] + right.dimensions[0]) / 2;
      expect(wrongGap).toBeLessThan(0);
      const correctGap = referenceBoxPoint(frame.id, right.id, [-0.5, 0, 0]).relative[0]
        - referenceBoxPoint(frame.id, left.id, [0.5, 0, 0]).relative[0];
      expect(correctGap).toBeGreaterThan(0);
    }
  });
});
