/** Independent test reference. No runtime, tracer, sampler, or shader imports.
 *
 * Radiometric convention: albedo is linear Lambertian reflectance, environment
 * values are incident radiance, and the directional light is irradiance on a
 * surface perpendicular to its direction. A cosine-primary sample contributes
 * rhoPrimary * incomingRadiance, with no additional cosine or pi factor.
 * https://pbr-book.org/4ed/Reflection_Models/Diffuse_Reflection
 * https://pbr-book.org/4ed/Monte_Carlo_Integration/Monte_Carlo_Basics
 */
export type ReferenceRgb = readonly [number, number, number];
export type ReferencePoint = readonly [number, number, number];
export type ReferenceTriangle = readonly [ReferencePoint, ReferencePoint, ReferencePoint];
export interface ReferenceWall {
  /** Plane x=distance, facing -X; receiver is the origin with normal +Y. */
  readonly distance: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly zMin: number;
  readonly zMax: number;
}
export interface ReferenceQuad {
  readonly name: string;
  /** CCW viewed from normal; triangles [0,1,2] and [0,2,3]. */
  readonly positions: readonly [ReferencePoint, ReferencePoint, ReferencePoint, ReferencePoint];
  readonly normal: ReferencePoint;
  /** One shared white material; linear COLOR_0 supplies surface variation. */
  readonly color: ReferenceRgb;
}

const BLACK: ReferenceRgb = [0, 0, 0];
const multiply = (a: ReferenceRgb, b: ReferenceRgb): ReferenceRgb => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const scale = (a: ReferenceRgb, s: number): ReferenceRgb => [a[0] * s, a[1] * s, a[2] * s];
const subtract = (a: ReferencePoint, b: ReferencePoint): ReferencePoint => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: ReferencePoint, b: ReferencePoint): ReferencePoint =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: ReferencePoint, b: ReferencePoint): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function validateWall(wall: ReferenceWall): void {
  if (![wall.distance, wall.yMin, wall.yMax, wall.zMin, wall.zMax].every(Number.isFinite)
    || wall.distance <= 0 || wall.yMin < 0 || wall.yMax <= wall.yMin || wall.zMax <= wall.zMin) {
    throw new Error('Reference wall must have positive distance, nonnegative height, and nonempty finite extents.');
  }
}
function validateUnitInterval(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Expected a finite probability in [0,1].');
}
function validateRgb(value: ReferenceRgb): void {
  if (value.some(channel => !Number.isFinite(channel) || channel < 0)) throw new Error('Radiance and reflectance must be finite and nonnegative.');
}

/** Exact view factor of a perpendicular finite rectangle to a differential
 * receiver. Derived by integrating a*y/(pi*(a*a+y*y+z*z)^2) over wall area,
 * first in y and then in z. This does not sample rays or use triangle hits.
 */
export function wallCosineProbability(wall: ReferenceWall): number {
  validateWall(wall);
  const { distance: a, yMin, yMax, zMin, zMax } = wall;
  const primitive = (y: number, z: number): number => {
    const q = Math.hypot(a, y);
    return Math.atan(z / q) / q;
  };
  return a / (2 * Math.PI) * (primitive(yMin, zMax) - primitive(yMin, zMin)
    - primitive(yMax, zMax) + primitive(yMax, zMin));
}

/** Independent composite midpoint area quadrature. Increasing resolution is a
 * consistency check, not a certified bound on this quadrature's own error.
 */
export function quadratureWallCosineProbability(wall: ReferenceWall, cells = 128): number {
  validateWall(wall);
  if (!Number.isInteger(cells) || cells < 1 || cells > 1024) throw new Error('Quadrature cells must be an integer in [1,1024].');
  const dy = (wall.yMax - wall.yMin) / cells;
  const dz = (wall.zMax - wall.zMin) / cells;
  let sum = 0;
  for (let yi = 0; yi < cells; yi++) for (let zi = 0; zi < cells; zi++) {
    const y = wall.yMin + (yi + 0.5) * dy;
    const z = wall.zMin + (zi + 0.5) * dz;
    const squaredDistance = wall.distance ** 2 + y ** 2 + z ** 2;
    sum += wall.distance * y / (Math.PI * squaredDistance ** 2);
  }
  return sum * dy * dz;
}

export const importedIndirectFixture = {
  receiver: { position: [0, 0, 0] as ReferencePoint, normal: [0, 1, 0] as ReferencePoint, albedo: [0.5, 0.5, 0.5] as ReferenceRgb },
  wall: { distance: 0.75, yMin: 0.25, yMax: 1, zMin: -0.5, zMax: 0.5 } satisfies ReferenceWall,
  wallAlbedo: [0.8, 0.1, 0.05] as ReferenceRgb,
  directionToLight: [-Math.SQRT1_2, Math.SQRT1_2, 0] as ReferencePoint,
  directionalIrradiance: [4, 4, 4] as ReferenceRgb,
  camera: { eye: [-0.8, 0.3, 0] as ReferencePoint, target: [0, 0, 0] as ReferencePoint, verticalFov: Math.PI / 6 },
  /** Occluder at half wall distance; opening projects to this wall subrectangle. */
  apertureWall: { distance: 0.75, yMin: 0.5, yMax: 0.75, zMin: -0.25, zMax: 0.25 } satisfies ReferenceWall,
} as const;

/** Generated geometry only. No imported assets, normal maps, emission, opacity,
 * animation, metallic response, or extra diffuse bounces are part of the oracle.
 * Light-only canopy is above every receiver-to-wall segment; it blocks every
 * wall-to-sun ray without hiding the wall from the receiver.
 */
export function createIndirectReferenceQuads(options: { readonly wall?: boolean; readonly opening?: 'open' | 'aperture' | 'closed'; readonly sunBlocked?: boolean } = {}): ReferenceQuad[] {
  const quads: ReferenceQuad[] = [{ name: 'receiver', normal: [0, 1, 0], color: importedIndirectFixture.receiver.albedo,
    positions: [[-1, 0, -1], [-1, 0, 1], [1, 0, 1], [1, 0, -1]] }];
  const wallQuad = (name: string, x: number, y0: number, y1: number, z0: number, z1: number, color: ReferenceRgb): ReferenceQuad =>
    ({ name, normal: [-1, 0, 0], color, positions: [[x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0]] });
  if (options.wall !== false) quads.push(wallQuad('bounce-wall', 0.75, 0.25, 1, -0.5, 0.5, importedIndirectFixture.wallAlbedo));
  if (options.opening === 'closed') quads.push(wallQuad('closed-opening', 0.375, 0.125, 0.5, -0.25, 0.25, BLACK));
  if (options.opening === 'aperture') {
    quads.push(wallQuad('aperture-bottom', 0.375, 0.125, 0.25, -0.25, 0.25, BLACK));
    quads.push(wallQuad('aperture-top', 0.375, 0.375, 0.5, -0.25, 0.25, BLACK));
    quads.push(wallQuad('aperture-left', 0.375, 0.25, 0.375, -0.25, -0.125, BLACK));
    quads.push(wallQuad('aperture-right', 0.375, 0.25, 0.375, 0.125, 0.25, BLACK));
  }
  if (options.sunBlocked) quads.push({ name: 'secondary-sun-canopy', normal: [0, -1, 0], color: BLACK,
    positions: [[-0.3, 1.25, -0.55], [0.55, 1.25, -0.55], [0.55, 1.25, 0.55], [-0.3, 1.25, 0.55]] });
  return quads;
}

/** Fully closed finite enclosure, viewed from inside. Every primary +Y
 * hemisphere query hits a black wall/ceiling, so its one-bounce indirect value
 * is exactly zero even when the environment or displayed background is bright.
 */
export function createBlackEnclosureReferenceQuads(): ReferenceQuad[] {
  return [...createIndirectReferenceQuads({ wall: false }),
    { name: 'enclosure-positive-x', normal: [-1, 0, 0], color: BLACK,
      positions: [[1, 0, -1], [1, 0, 1], [1, 1.5, 1], [1, 1.5, -1]] },
    { name: 'enclosure-negative-x', normal: [1, 0, 0], color: BLACK,
      positions: [[-1, 0, 1], [-1, 0, -1], [-1, 1.5, -1], [-1, 1.5, 1]] },
    { name: 'enclosure-positive-z', normal: [0, 0, -1], color: BLACK,
      positions: [[1, 0, 1], [-1, 0, 1], [-1, 1.5, 1], [1, 1.5, 1]] },
    { name: 'enclosure-negative-z', normal: [0, 0, 1], color: BLACK,
      positions: [[-1, 0, -1], [1, 0, -1], [1, 1.5, -1], [-1, 1.5, -1]] },
    { name: 'enclosure-ceiling', normal: [0, -1, 0], color: BLACK,
      positions: [[-1, 1.5, -1], [1, 1.5, -1], [1, 1.5, 1], [-1, 1.5, 1]] },
  ];
}

/** Black-environment, constant-color wall control. For an IID cosine direction,
 * the sample is either maximum or zero, so its variance is exactly C^2*F*(1-F).
 * The generated aperture frame ends at y=.5; default wall-to-light rays pass
 * above it. Other geometry/light combinations need their own visibility proof.
 */
export function directWallBounceReference(options: {
  readonly wall?: ReferenceWall;
  readonly primaryAlbedo?: ReferenceRgb;
  readonly wallAlbedo?: ReferenceRgb;
  readonly directionalIrradiance?: ReferenceRgb;
  readonly cosineAtWall?: number;
  readonly lightVisible?: boolean;
} = {}): { readonly probability: number; readonly mean: ReferenceRgb; readonly variance: ReferenceRgb; readonly maximum: ReferenceRgb } {
  const probability = wallCosineProbability(options.wall ?? importedIndirectFixture.wall);
  const primary = options.primaryAlbedo ?? importedIndirectFixture.receiver.albedo;
  const wall = options.wallAlbedo ?? importedIndirectFixture.wallAlbedo;
  const irradiance = options.directionalIrradiance ?? importedIndirectFixture.directionalIrradiance;
  const cosine = options.cosineAtWall ?? Math.SQRT1_2;
  [primary, wall, irradiance].forEach(validateRgb); validateUnitInterval(cosine);
  const maximum = scale(multiply(multiply(primary, wall), irradiance), options.lightVisible === false ? 0 : cosine / Math.PI);
  return { probability, maximum, mean: scale(maximum, probability), variance: scale(multiply(maximum, maximum), probability * (1 - probability)) };
}

/** Lighting environment only: displayed background is deliberately absent from
 * this interface. An unobstructed constant environment has diffuse radiance rho*L.
 */
export function constantEnvironmentReference(albedo: ReferenceRgb, incidentRadiance: ReferenceRgb, visibleCosineFraction = 1): ReferenceRgb {
  validateRgb(albedo); validateRgb(incidentRadiance); validateUnitInterval(visibleCosineFraction);
  return scale(multiply(albedo, incidentRadiance), visibleCosineFraction);
}

/** Partition oracle, with independently established geometric visibility factors.
 * This distinguishes sky seen by the primary query from sky seen after one wall
 * hit. The second term contains BOTH reflectances; the first contains only rhoP.
 * No camera/background color, ambient fill, emission, or further bounce enters.
 */
export function oneBounceConstantEnvironmentReference(primary: ReferenceRgb, secondary: ReferenceRgb, environment: ReferenceRgb,
  primaryMissFraction: number, secondarySkyFraction: number): { readonly primarySky: ReferenceRgb; readonly secondarySky: ReferenceRgb; readonly total: ReferenceRgb } {
  validateRgb(secondary); validateUnitInterval(primaryMissFraction); validateUnitInterval(secondarySkyFraction);
  const primarySky = constantEnvironmentReference(primary, environment, primaryMissFraction);
  const secondarySky = scale(multiply(multiply(primary, secondary), environment), (1 - primaryMissFraction) * secondarySkyFraction);
  return { primarySky, secondarySky, total: [primarySky[0] + secondarySky[0], primarySky[1] + secondarySky[1], primarySky[2] + secondarySky[2]] };
}

/** Integrates over solid angle using uniform cos(theta)/azimuth quadrature,
 * multiplying the physical Lambertian cosine explicitly. This is intentionally
 * not the production cosine-sampling transformation or its random sequence.
 * Returns (1/pi)*integral L(w)*visibility(w)*cos(theta) dw, before albedo.
 */
export function hemisphereRadianceQuadrature(normal: ReferencePoint, radiance: (direction: ReferencePoint) => ReferenceRgb,
  visible: (direction: ReferencePoint) => boolean = () => true, polarCells = 64, azimuthCells = 128): ReferenceRgb {
  if (![polarCells, azimuthCells].every(value => Number.isInteger(value) && value > 0 && value <= 1024)) throw new Error('Invalid hemisphere quadrature resolution.');
  const length = Math.hypot(...normal);
  if (!Number.isFinite(length) || length <= 0) throw new Error('Invalid quadrature normal.');
  const n = scale(normal, 1 / length);
  const axis: ReferencePoint = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const raw = cross(axis, n); const tangent = scale(raw, 1 / Math.hypot(...raw)); const bitangent = cross(n, tangent);
  const sum = [0, 0, 0];
  for (let p = 0; p < polarCells; p++) for (let a = 0; a < azimuthCells; a++) {
    const cosine = (p + 0.5) / polarCells; const phi = 2 * Math.PI * (a + 0.5) / azimuthCells;
    const sine = Math.sqrt(1 - cosine * cosine);
    const direction = n.map((component, channel) => component * cosine
      + sine * (tangent[channel]! * Math.cos(phi) + bitangent[channel]! * Math.sin(phi))) as unknown as ReferencePoint;
    if (!visible(direction)) continue;
    const value = radiance(direction); validateRgb(value);
    for (let channel = 0; channel < 3; channel++) sum[channel]! += value[channel]! * 2 * cosine / (polarCells * azimuthCells);
  }
  return sum as unknown as ReferenceRgb;
}

/** Every completed hit/miss consumes a Monte Carlo sample. An exhausted query
 * does NOT turn into an environment miss or a zero-valued completed sample.
 * Rejecting failures can itself bias the estimator: any nonzero failed count
 * must fail the radiometric acceptance run, even if a partial mean is recorded.
 */
export function summarizeRadianceQueries(queries: readonly ({ readonly status: 'hit' | 'miss'; readonly radiance: ReferenceRgb }
  | { readonly status: 'exhausted' })[]): { readonly mean: ReferenceRgb | null; readonly completed: number; readonly failed: number; readonly acceptable: boolean } {
  const sum = [0, 0, 0]; let completed = 0; let failed = 0;
  for (const query of queries) {
    if (query.status === 'exhausted') { failed++; continue; }
    validateRgb(query.radiance); completed++;
    for (let channel = 0; channel < 3; channel++) sum[channel]! += query.radiance[channel]!;
  }
  return { mean: completed ? scale(sum as unknown as ReferenceRgb, 1 / completed) : null, completed, failed, acceptable: completed > 0 && failed === 0 };
}

/** Conservative two-sided Bernstein bound, unioned across `comparisons` scalar
 * comparisons. Valid only for independent bounded samples, not a guarantee for
 * one deterministic hash/Halton sequence or correlated/denoised image pixels.
 * Absolute rounding/storage allowance must be set from the tested GPU format.
 */
export function iidMeanTolerance(variance: number, sampleMaximum: number, sampleCount: number,
  options: { readonly familyFailureProbability?: number; readonly comparisons?: number; readonly absoluteNumericAllowance?: number } = {}): number {
  const alpha = options.familyFailureProbability ?? 1e-6; const comparisons = options.comparisons ?? 3;
  const numerical = options.absoluteNumericAllowance ?? 0;
  if (!Number.isFinite(variance) || variance < 0 || !Number.isFinite(sampleMaximum) || sampleMaximum < 0
    || !Number.isInteger(sampleCount) || sampleCount <= 0 || !Number.isFinite(alpha) || alpha <= 0 || alpha >= 1
    || !Number.isInteger(comparisons) || comparisons <= 0 || !Number.isFinite(numerical) || numerical < 0) throw new Error('Invalid statistical tolerance inputs.');
  const logarithm = Math.log(2 * comparisons / alpha);
  const linear = sampleMaximum * logarithm / (3 * sampleCount);
  return numerical + linear + Math.sqrt(2 * variance * logarithm / sampleCount + linear * linear);
}

/** Signed area coordinates, independent of ray-triangle determinant/traversal.
 * Useful for checking source UV/COLOR interpolation at a known hit position.
 */
export function triangleAreaCoordinates(point: ReferencePoint, triangle: ReferenceTriangle): ReferencePoint {
  const [a, b, c] = triangle; const normal = cross(subtract(b, a), subtract(c, a)); const areaSquared = dot(normal, normal);
  if (!Number.isFinite(areaSquared) || areaSquared <= 0) throw new Error('Degenerate reference triangle.');
  return [dot(cross(subtract(b, point), subtract(c, point)), normal) / areaSquared,
    dot(cross(subtract(c, point), subtract(a, point)), normal) / areaSquared,
    dot(cross(subtract(a, point), subtract(b, point)), normal) / areaSquared];
}

export const importedIndirectBarycentricWitness = {
  positions: [[0.75, 0.25, -0.5], [0.75, 0.25, 0.5], [0.75, 1, -0.5]] as ReferenceTriangle,
  point: [0.75, 0.4375, 0] as ReferencePoint,
  weights: [0.25, 0.5, 0.25] as ReferencePoint,
  uv: [[0, 0], [1, 0], [0, 1]] as const,
  colors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const,
  expectedUv: [0.5, 0.25] as const,
  expectedVertexColor: [0.25, 0.5, 0.25] as ReferenceRgb,
  /** Nearest sample of a known 2x2 source at UV(.5,.25), top-right texel. */
  sourceSrgbTexel: [128, 64, 192] as const,
  materialFactor: [0.5, 0.75, 0.25] as ReferenceRgb,
  expectedAlbedo: [0.026982562514237408, 0.019226046890266215, 0.03294469535661332] as ReferenceRgb,
} as const;
