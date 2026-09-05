import { describe, expect, it } from 'vitest';
import {
  constantEnvironmentReference, createBlackEnclosureReferenceQuads, createIndirectReferenceQuads, directWallBounceReference, hemisphereRadianceQuadrature,
  iidMeanTolerance, importedIndirectBarycentricWitness, importedIndirectFixture, oneBounceConstantEnvironmentReference,
  quadratureWallCosineProbability, summarizeRadianceQueries, triangleAreaCoordinates, wallCosineProbability,
} from '../helpers/imported-indirect-reference.js';

describe('independent imported indirect radiometry', () => {
  it('agrees with smooth area quadrature and geometric partition identities', () => {
    const wall = importedIndirectFixture.wall;
    const exact = wallCosineProbability(wall);
    expect(exact).toBeGreaterThan(0.05); expect(exact).toBeLessThan(0.2);
    const coarse = quadratureWallCosineProbability(wall, 32); const fine = quadratureWallCosineProbability(wall, 128);
    expect(Math.abs(fine - exact)).toBeLessThan(2e-6);
    expect(Math.abs(fine - exact)).toBeLessThan(Math.abs(coarse - exact) / 10);
    expect(wallCosineProbability({ ...wall, zMax: 0 }) + wallCosineProbability({ ...wall, zMin: 0 })).toBeCloseTo(exact, 14);
    expect(wallCosineProbability({ distance: 1.5, yMin: 0.5, yMax: 2, zMin: -1, zMax: 1 })).toBeCloseTo(exact, 14);
    // A semi-infinite perpendicular wall occupies half the cosine hemisphere.
    expect(wallCosineProbability({ distance: 1, yMin: 0, yMax: 1e8, zMin: -1e8, zMax: 1e8 })).toBeCloseTo(0.5, 7);
  });

  it('separates cosine-primary throughput from the secondary Lambertian pi', () => {
    const reference = directWallBounceReference();
    const maximum = [0.5 * 0.8 * 4 / (Math.PI * Math.SQRT2), 0.5 * 0.1 * 4 / (Math.PI * Math.SQRT2), 0.5 * 0.05 * 4 / (Math.PI * Math.SQRT2)];
    reference.maximum.forEach((value, c) => expect(value).toBeCloseTo(maximum[c]!, 14));
    reference.mean.forEach((value, c) => expect(value).toBeCloseTo(maximum[c]! * reference.probability, 14));
    reference.variance.forEach((value, c) => expect(value).toBeCloseTo(maximum[c]! ** 2 * reference.probability * (1 - reference.probability), 14));
    expect(directWallBounceReference({ lightVisible: false }).mean).toEqual([0, 0, 0]);
    expect(directWallBounceReference({ directionalIrradiance: [0, 0, 0] }).mean).toEqual([0, 0, 0]);
    expect(directWallBounceReference({ wall: importedIndirectFixture.apertureWall }).mean[0]).toBeLessThan(reference.mean[0]);
  });

  it('preserves constant sky and separates primary sky from sky reflected at a secondary hit', () => {
    expect(constantEnvironmentReference([0.5, 0.25, 0.75], [2, 4, 8])).toEqual([1, 1, 6]);
    expect(constantEnvironmentReference([0.5, 0.25, 0.75], [2, 4, 8], 0)).toEqual([0, 0, 0]);
    const visible = oneBounceConstantEnvironmentReference([0.5, 0.25, 0.75], [0.8, 0.1, 0.05], [2, 4, 8], 1, 1);
    expect(visible.primarySky).toEqual([1, 1, 6]); expect(visible.secondarySky).toEqual([0, 0, 0]);
    const bounced = oneBounceConstantEnvironmentReference([0.5, 0.25, 0.75], [0.8, 0.1, 0.05], [2, 4, 8], 0, 1);
    expect(bounced.primarySky).toEqual([0, 0, 0]); expect(bounced.secondarySky[0]).toBe(0.8);
    expect(bounced.total[1]).toBe(0.1); expect(bounced.total[2]).toBeCloseTo(0.3, 14);
    // Closed black secondary surfaces return no energy even under a bright sky.
    expect(oneBounceConstantEnvironmentReference([0.5, 0.5, 0.5], [0, 0, 0], [2, 4, 8], 0, 1).total).toEqual([0, 0, 0]);
    expect(oneBounceConstantEnvironmentReference([0.5, 0.5, 0.5], [0.8, 0.1, 0.05], [2, 4, 8], 0, 0).total).toEqual([0, 0, 0]);
  });

  it('independently integrates constant and directional sky radiance with explicit visibility', () => {
    for (const normal of [[0, 1, 0], [1, 0, 0], [0, 0, -1]] as const) {
      hemisphereRadianceQuadrature(normal, () => [2, 4, 8]).forEach((value, c) => expect(value).toBeCloseTo([2, 4, 8][c]!, 11));
    }
    const linearSky = hemisphereRadianceQuadrature([0, 1, 0], direction => [direction[1], 2 * direction[1], 1]);
    // (1/pi) integral cos(theta)^2 dOmega = 2/3. Composite midpoint
    // quadrature of 2*mu^2 has the independently exact error 1/(6*N^2).
    expect(linearSky[0]).toBeCloseTo(2 / 3 - 1 / (6 * 64 ** 2), 11);
    expect(linearSky[1]).toBeCloseTo(4 / 3 - 1 / (3 * 64 ** 2), 11);
    expect(Math.abs(linearSky[0] - 2 / 3)).toBeLessThan(1 / (6 * 64 ** 2) + 1e-12);
    expect(linearSky[2]).toBeCloseTo(1, 11);
    const half = hemisphereRadianceQuadrature([0, 1, 0], () => [2, 4, 8], direction => direction[0] > 0);
    half.forEach((value, c) => expect(value).toBeCloseTo([1, 2, 4][c]!, 11));
    expect(hemisphereRadianceQuadrature([0, 1, 0], () => [2, 4, 8], () => false)).toEqual([0, 0, 0]);
  });

  it('keeps exhausted queries unknown and disqualifies a radiometric run instead of inventing sky energy', () => {
    expect(summarizeRadianceQueries([{ status: 'exhausted' }])).toEqual({ mean: null, completed: 0, failed: 1, acceptable: false });
    expect(summarizeRadianceQueries([{ status: 'hit', radiance: [0.2, 0.4, 0.6] }, { status: 'exhausted' }]))
      .toEqual({ mean: [0.2, 0.4, 0.6], completed: 1, failed: 1, acceptable: false });
    expect(summarizeRadianceQueries([{ status: 'miss', radiance: [2, 4, 8] }, { status: 'hit', radiance: [0, 0, 0] }]))
      .toEqual({ mean: [1, 2, 4], completed: 2, failed: 0, acceptable: true });
  });

  it('derives predeclared IID error bands from sample variance and bounded throughput', () => {
    const reference = directWallBounceReference();
    const n1 = iidMeanTolerance(reference.variance[0], reference.maximum[0], 4096);
    const n2 = iidMeanTolerance(reference.variance[0], reference.maximum[0], 16384);
    expect(n2).toBeGreaterThan(0); expect(n2).toBeLessThan(n1);
    expect(n2 / n1).toBeGreaterThan(0.4); expect(n2 / n1).toBeLessThan(0.51);
    expect(iidMeanTolerance(0, 0, 4096, { absoluteNumericAllowance: 0.002 })).toBe(0.002);
    expect(() => iidMeanTolerance(1, 1, 0)).toThrow();
  });

  it('uses independent signed areas and known source UV/color values at a barycentric witness', () => {
    const witness = importedIndirectBarycentricWitness;
    expect(triangleAreaCoordinates(witness.point, witness.positions)).toEqual([0.25, 0.5, 0.25]);
    const uv = [0, 1].map(channel => witness.weights.reduce((sum, weight, i) => sum + weight * witness.uv[i]![channel]!, 0));
    expect(uv).toEqual([0.5, 0.25]);
    const vertexColor = [0, 1, 2].map(channel => witness.weights.reduce((sum, weight, i) => sum + weight * witness.colors[i]![channel]!, 0));
    expect(vertexColor).toEqual([0.25, 0.5, 0.25]);
    // Independently tabulated IEC sRGB EOTF values for bytes128,64,192. Linear
    // COLOR_0/factor multiply AFTER decoding the interpolated source texel.
    const linearTexel = [0.21586050011389926, 0.05126945837404324, 0.5271151257058131];
    const albedo = linearTexel.map((value, c) => value * vertexColor[c]! * witness.materialFactor[c]!);
    expect(albedo[0]).toBeCloseTo(0.026982562514237408, 14);
    expect(albedo[1]).toBeCloseTo(0.019226046890266215, 14);
    expect(albedo[2]).toBeCloseTo(0.03294469535661332, 14);
    albedo.forEach((value, c) => expect(value).toBeCloseTo(witness.expectedAlbedo[c]!, 14));
  });

  it('constructs correctly wound offscreen geometry and isolated shadow/opening controls', () => {
    const quads = createIndirectReferenceQuads({ opening: 'aperture', sunBlocked: true });
    for (const quad of [...quads, ...createBlackEnclosureReferenceQuads()]) {
      const [a, b, c] = quad.positions;
      const u = b.map((value, i) => value - a[i]!); const v = c.map((value, i) => value - a[i]!);
      const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      expect(cross.reduce((sum, value, i) => sum + value * quad.normal[i]!, 0)).toBeGreaterThan(0);
    }
    // Independent X/Y camera-angle bound: camera up/forward have no Z
    // component, so this vertical-frustum exclusion holds for every wall Z.
    const wall = quads.find(quad => quad.name === 'bounce-wall')!;
    const { eye, verticalFov } = importedIndirectFixture.camera;
    const forwardX = 0.8 / Math.hypot(0.8, 0.3); const forwardY = -0.3 / Math.hypot(0.8, 0.3);
    for (const position of wall.positions) {
      const dx = position[0] - eye[0]; const dy = position[1] - eye[1];
      const depth = dx * forwardX + dy * forwardY;
      const up = dx * -forwardY + dy * forwardX;
      expect(up / depth).toBeGreaterThan(Math.tan(verticalFov / 2));
      const sunXAtCanopy = position[0] - (1.25 - position[1]);
      expect(sunXAtCanopy).toBeGreaterThan(-0.3); expect(sunXAtCanopy).toBeLessThan(0.55);
      expect(position[2]).toBeGreaterThan(-0.55); expect(position[2]).toBeLessThan(0.55);
      expect(position[1]).toBeLessThan(1.25);
      // At x=.375 the light ray is already above the opening frame's y=.5
      // maximum, so the aperture controls do not also shadow the source wall.
      expect(position[1] + (position[0] - 0.375)).toBeGreaterThan(0.5);
    }
    expect(createIndirectReferenceQuads({ opening: 'closed' }).some(quad => quad.name === 'closed-opening')).toBe(true);
    expect(createIndirectReferenceQuads({ wall: false })).toHaveLength(1);
    expect(createBlackEnclosureReferenceQuads()).toHaveLength(6);
  });
});
