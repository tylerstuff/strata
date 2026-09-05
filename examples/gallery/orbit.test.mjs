import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitOrbitToBounds, normalizeOrbit, orbitEye } from './orbit.ts';

const limits = { minimumDistance: .15, maximumDistance: 50 };
const direction = { azimuth: .55, elevation: .24 };
const verticalFov = .84;

// Independent lookAt and perspective projection of world-space corners. This
// checks the returned camera, not the fitter's distance inequalities.
function projectedCorners(bounds, orbit, aspect, fov) {
  const subtract = (a, b) => a.map((value, axis) => value - b[axis]);
  const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = value => { const length = Math.hypot(...value); return value.map(component => component / length); };
  const eye = orbitEye(orbit), back = unit(subtract(eye, orbit.target));
  const right = unit(cross(Math.abs(back[1]) > .999 ? [0, 0, 1] : [0, 1, 0], back));
  const up = cross(back, right), focal = 1 / Math.tan(fov / 2);
  return Array.from({ length: 8 }, (_, corner) => {
    const world = bounds.min.map((minimum, axis) => ((corner >> axis) & 1) ? bounds.max[axis] : minimum);
    const relative = subtract(world, eye), depth = -dot(relative, back);
    return { x: dot(relative, right) * focal / aspect / depth, y: dot(relative, up) * focal / depth, depth };
  });
}

function assertFits(bounds, fitted, aspect, fov = verticalFov) {
  assert.ok([fitted.azimuth, fitted.elevation, fitted.distance, ...fitted.target, ...orbitEye(fitted)].every(Number.isFinite));
  assert.ok(fitted.distance >= limits.minimumDistance && fitted.distance <= limits.maximumDistance);
  const corners = projectedCorners(bounds, fitted, aspect, fov);
  for (const corner of corners) {
    assert.ok(corner.depth >= .03 - 1e-10, `Corner intersects near clearance: ${JSON.stringify(corner)}`);
    assert.ok(Math.abs(corner.x) <= .85 + 1e-10, `Horizontal corner clips frame margin: ${JSON.stringify(corner)}`);
    assert.ok(Math.abs(corner.y) <= .85 + 1e-10, `Vertical corner clips frame margin: ${JSON.stringify(corner)}`);
  }
  return corners;
}

for (const [name, bounds, aspect] of [
  ['wide viewport', { min: [-1, 0, -.7], max: [1, 1.5, .7] }, 16 / 9],
  ['portrait viewport', { min: [-1, 0, -.7], max: [1, 1.5, .7] }, 9 / 16],
  ['ordinary narrow viewport', { min: [-1, 0, -1], max: [1, 2, 1] }, 288 / 480],
  ['tall model', { min: [-.2, 0, -.1], max: [.2, 2, .1] }, 16 / 9],
  ['flat landscape', { min: [-1, 0, -.9], max: [1, 0, .9] }, 16 / 9],
  ['flat portrait', { min: [-1, 0, 0], max: [1, 2, 0] }, 9 / 16],
]) {
  test(`fits all independently projected corners with margin: ${name}`, () => {
    const fitted = fitOrbitToBounds(bounds, direction, aspect, verticalFov, limits);
    const corners = assertFits(bounds, fitted, aspect);
    assert.ok(Math.max(...corners.flatMap(corner => [Math.abs(corner.x), Math.abs(corner.y)])) > .84,
      'Ordinary fit should use the available frame instead of an unnecessarily distant bounding sphere');
    assert.equal(fitted.azimuth, normalizeOrbit({ ...direction, distance: 1, target: [0, 0, 0] }, limits).azimuth);
    assert.equal(fitted.elevation, direction.elevation);
  });
}

test('portrait aspect needs a more distant fit than the same landscape view', () => {
  const bounds = { min: [-1, 0, -.3], max: [1, 1, .3] };
  const landscape = fitOrbitToBounds(bounds, direction, 16 / 9, verticalFov, limits);
  const portrait = fitOrbitToBounds(bounds, direction, 9 / 16, verticalFov, limits);
  assert.ok(portrait.distance > landscape.distance * 1.3);
  assertFits(bounds, landscape, 16 / 9); assertFits(bounds, portrait, 9 / 16);
});

test('centers translated bounds without mutating inputs or retaining target aliases', () => {
  const bounds = { min: [123, -44, 75], max: [125, -42, 76] };
  const before = structuredClone({ bounds, direction, limits });
  const fitted = fitOrbitToBounds(bounds, direction, 1, verticalFov, limits);
  assert.deepEqual(fitted.target, [124, -43, 75.5]);
  assertFits(bounds, fitted, 1);
  assert.deepEqual({ bounds, direction, limits }, before);
  assert.ok(Object.isFrozen(fitted) && Object.isFrozen(fitted.target));
  bounds.min[0] = -100;
  assert.equal(fitted.target[0], 124);
});

for (const elevation of [Math.PI / 2, -Math.PI / 2, 1.52, -1.52]) {
  test(`matches the actual lookAt up-vector choice near elevation ${elevation}`, () => {
    const bounds = { min: [-1, 0, -.2], max: [1, .7, .2] };
    const fitted = fitOrbitToBounds(bounds, { azimuth: 2.1, elevation }, .6, verticalFov, limits);
    assertFits(bounds, fitted, .6);
  });
}

test('point bounds obey minimum orbit distance; depth-only bounds stay beyond the near plane', () => {
  const point = { min: [0, 0, 0], max: [0, 0, 0] };
  const fittedPoint = fitOrbitToBounds(point, direction, 1, verticalFov, limits);
  assert.equal(fittedPoint.distance, limits.minimumDistance);
  assertFits(point, fittedPoint, 1);
  const line = { min: [0, 0, -1], max: [0, 0, 1] };
  const fittedLine = fitOrbitToBounds(line, { azimuth: 0, elevation: 0 }, 1, verticalFov, limits);
  assertFits(line, fittedLine, 1);
  assert.ok(fittedLine.distance >= 1.03);
});

test('respects a larger minimum distance but rejects an impossible maximum without silent cropping', () => {
  const bounds = { min: [-1, 0, -1], max: [1, 2, 1] };
  const further = fitOrbitToBounds(bounds, direction, 1, verticalFov, { minimumDistance: 10, maximumDistance: 50 });
  assert.equal(further.distance, 10);
  assertFits(bounds, further, 1);
  assert.throws(() => fitOrbitToBounds(bounds, direction, .02, verticalFov, limits), /maximum camera distance/);
  assert.throws(() => fitOrbitToBounds(bounds, direction, 1, verticalFov, { minimumDistance: .15, maximumDistance: .5 }), /maximum camera distance/);
});

test('rejects invalid bounds, directions, projection parameters, limits and overflow', () => {
  const bounds = { min: [-1, 0, -1], max: [1, 2, 1] };
  for (const invalid of [null, { min: [], max: [] }, { min: [2, 0, 0], max: [1, 1, 1] },
    { min: [NaN, 0, 0], max: [1, 1, 1] }, { min: [0, 0, 0], max: [1, Infinity, 1] }]) {
    assert.throws(() => fitOrbitToBounds(invalid, direction, 1, verticalFov, limits));
  }
  for (const aspect of [0, -1, NaN, Infinity]) assert.throws(() => fitOrbitToBounds(bounds, direction, aspect, verticalFov, limits));
  for (const fov of [0, -1, Math.PI, NaN, Infinity, Number.MIN_VALUE]) assert.throws(() => fitOrbitToBounds(bounds, direction, 1, fov, limits));
  assert.throws(() => fitOrbitToBounds(bounds, { azimuth: NaN, elevation: 0 }, 1, verticalFov, limits));
  for (const invalid of [{ minimumDistance: 0, maximumDistance: 50 }, { minimumDistance: 2, maximumDistance: 1 }, { minimumDistance: .15, maximumDistance: Infinity }]) {
    assert.throws(() => fitOrbitToBounds(bounds, direction, 1, verticalFov, invalid));
  }
  assert.throws(() => fitOrbitToBounds({ min: [-1e308, -1e308, -1e308], max: [1e308, 1e308, 1e308] }, direction, 1, verticalFov, limits));
});
