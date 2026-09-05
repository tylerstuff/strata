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
