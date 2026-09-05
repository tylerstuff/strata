/** Gallery camera state. Angles are radians; distance and target use scene units. */
export interface GalleryOrbit {
  readonly azimuth: number;
  readonly elevation: number;
  readonly distance: number;
  readonly target: readonly [number, number, number];
}

export interface OrbitLimits {
  readonly minimumDistance: number;
  readonly maximumDistance: number;
}

export interface GalleryBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

const maximumElevation = Math.PI / 2 - 0.02;

export function normalizeOrbit(input: GalleryOrbit, limits: OrbitLimits): GalleryOrbit {
  if (!Number.isFinite(limits.minimumDistance) || !Number.isFinite(limits.maximumDistance)
      || limits.minimumDistance <= 0 || limits.maximumDistance < limits.minimumDistance) {
    throw new Error('Invalid gallery camera distance limits.');
  }
  if (!input || !Number.isFinite(input.azimuth) || !Number.isFinite(input.elevation)
      || !Number.isFinite(input.distance) || !Array.isArray(input.target)
      || input.target.length !== 3 || !input.target.every(Number.isFinite)) {
    throw new Error('Orbit requires finite azimuth, elevation, distance and a three-number target.');
  }
  return Object.freeze({
    azimuth: ((input.azimuth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI),
    elevation: Math.max(-maximumElevation, Math.min(maximumElevation, input.elevation)),
    distance: Math.max(limits.minimumDistance, Math.min(limits.maximumDistance, input.distance)),
    target: Object.freeze([...input.target]) as readonly [number, number, number],
  });
}

/** Eye position for a +Y-up orbit, with azimuth zero on the positive Z axis. */
export function orbitEye(orbit: GalleryOrbit): readonly [number, number, number] {
  const { azimuth, elevation, distance, target } = orbit;
  const cosElevation = Math.cos(elevation);
  return [
      target[0] + distance * Math.sin(azimuth) * cosElevation,
      target[1] + distance * Math.sin(elevation),
      target[2] + distance * Math.cos(azimuth) * cosElevation,
  ];
}

/**
 * Fit the supplied bounds at a fixed viewing direction, using both viewport axes.
 * Corners occupy at most 85% of each frame dimension (7.5% margin per edge).
 * The nearest corner stays .02 units beyond the gallery renderer's .01 near plane.
 * Reject a fit beyond the distance limit rather than silently clipping the model.
 */
export function fitOrbitToBounds(
  bounds: GalleryBounds,
  direction: Pick<GalleryOrbit, 'azimuth' | 'elevation'>,
  aspect: number,
  verticalFov: number,
  limits: OrbitLimits,
): GalleryOrbit {
  const normalized = normalizeOrbit({ ...direction, distance: 1, target: [0, 0, 0] }, limits);
  if (!bounds || !Array.isArray(bounds.min) || !Array.isArray(bounds.max)
    || bounds.min.length !== 3 || bounds.max.length !== 3
    || !bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite)
    || bounds.min.some((value, axis) => value > bounds.max[axis]!)) {
    throw new Error('Camera fit requires finite ordered three-dimensional bounds.');
  }
  if (!Number.isFinite(aspect) || aspect <= 0 || !Number.isFinite(verticalFov)
    || verticalFov <= 0 || verticalFov >= Math.PI) {
    throw new Error('Camera fit requires a positive finite aspect and a vertical FOV between zero and pi radians.');
  }
  const slope = Math.tan(verticalFov / 2);
  if (!Number.isFinite(slope) || slope <= 0) throw new Error('Camera fit FOV cannot be represented safely.');
  // Halve before adding/subtracting to avoid overflow for otherwise finite bounds.
  const center = bounds.min.map((value, axis) => value / 2 + bounds.max[axis]! / 2) as [number, number, number];
  const half = bounds.min.map((value, axis) => bounds.max[axis]! / 2 - value / 2);
  const { azimuth, elevation } = normalized;
  const back = [Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation)] as const;
  // Match the imported camera's +Y-up lookAt, including its near-pole fallback.
  const right = Math.abs(back[1]) > .999 ? [-back[1], back[0], 0] : [back[2], 0, -back[0]];
  const length = Math.hypot(...right);
  for (let axis = 0; axis < 3; axis++) right[axis] = right[axis]! / length;
  const up = [back[1] * right[2]! - back[2] * right[1]!, back[2] * right[0]! - back[0] * right[2]!, back[0] * right[1]! - back[1] * right[0]!];
  const fraction = .85;
  const minimumDepth = .01 + .02;
  let distance = limits.minimumDistance;
  for (let corner = 0; corner < 8; corner++) {
    const offset = half.map((extent, axis) => ((corner >> axis) & 1) ? extent : -extent);
    const x = offset.reduce((sum, value, axis) => sum + value * right[axis]!, 0);
    const y = offset.reduce((sum, value, axis) => sum + value * up[axis]!, 0);
    const z = offset.reduce((sum, value, axis) => sum + value * back[axis]!, 0);
    // A corner's forward depth is distance-z. Solve the horizontal/vertical
    // perspective inequalities directly; divide separately to avoid slope overflow.
    distance = Math.max(distance, z + Math.abs(x) / slope / aspect / fraction,
      z + Math.abs(y) / slope / fraction, z + minimumDepth);
  }
  if (!Number.isFinite(distance) || distance > limits.maximumDistance) {
    throw new Error('The model cannot fit this viewport within the maximum camera distance.');
  }
  const fitted = normalizeOrbit({ ...normalized, distance, target: center }, limits);
  if (!orbitEye(fitted).every(Number.isFinite)) throw new Error('Camera fit position cannot be represented safely.');
  return fitted;
}
