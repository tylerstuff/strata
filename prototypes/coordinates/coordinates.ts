/** CPU-only proposed strata-world-v1 contract. Not exported by the engine package. */
export const COORDINATE_SYSTEM = 'strata-world-v1';
export const MAX_POSITION_METERS = 2 ** 30;
export const MIN_SCALE = 1e-6;
export const MAX_SCALE = 1e6;
export const QUATERNION_NORM_TOLERANCE = 1e-6;

export type Vec3 = readonly [number, number, number];
export type Quaternion = readonly [number, number, number, number];
/** Column-major linear transform; intentionally permits composed shear. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];
export interface Transform {
  readonly position: Vec3;
  readonly rotation: Quaternion;
  readonly scale: Vec3;
}
export interface GlobalTransform {
  readonly position: Vec3;
  readonly linear: Mat3;
}
export interface CoordinateSample {
  readonly transform: GlobalTransform;
  /** Camera global position for this sample, kept in binary64. */
  readonly origin: Vec3;
}

function finiteTuple(value: readonly number[], length: number, name: string): void {
  if (value.length !== length) throw new RangeError(`${name} requires ${length} components`);
  for (const component of value) {
    if (!Number.isFinite(component)) throw new RangeError(`${name} requires finite numbers`);
  }
}

export function validatePosition(position: Vec3): void {
  finiteTuple(position, 3, 'position');
  if (position.some(value => Math.abs(value) > MAX_POSITION_METERS)) {
    throw new RangeError('position exceeds the strata-world-v1 guard range');
  }
}

/** Validation does not mutate or round the source document. */
export function validateTransform(transform: Transform): void {
  validatePosition(transform.position);
  finiteTuple(transform.rotation, 4, 'rotation');
  if (Math.abs(Math.hypot(...transform.rotation) - 1) > QUATERNION_NORM_TOLERANCE) {
    throw new RangeError('rotation must be a unit XYZW quaternion within 1e-6');
  }
  finiteTuple(transform.scale, 3, 'scale');
  if (transform.scale.some(value => value < MIN_SCALE || value > MAX_SCALE)) {
    throw new RangeError('scale must be between 1e-6 and 1e6');
  }
}

const cleanZero = (value: number): number => value === 0 ? 0 : value;

/** Explicit authoring operation, separate from validation/load. */
export function canonicalTransform(transform: Transform): Transform {
  validateTransform(transform);
  const norm = Math.hypot(...transform.rotation);
  return {
    position: transform.position.map(cleanZero) as unknown as Vec3,
    rotation: transform.rotation.map(value => cleanZero(value / norm)) as unknown as Quaternion,
    scale: [...transform.scale],
  };
}

function applyLinear(matrix: Mat3, point: Vec3): Vec3 {
  return [
    matrix[0] * point[0] + matrix[3] * point[1] + matrix[6] * point[2],
    matrix[1] * point[0] + matrix[4] * point[1] + matrix[7] * point[2],
    matrix[2] * point[0] + matrix[5] * point[1] + matrix[8] * point[2],
  ];
}

function validateGlobal(transform: GlobalTransform): void {
  validatePosition(transform.position);
  finiteTuple(transform.linear, 9, 'composed linear transform');
}

/** Root T*R*S, or parent * local T*R*S. Never builds a large float32 matrix. */
export function composeTransform(local: Transform, parent?: GlobalTransform): GlobalTransform {
  const { position, rotation: [x, y, z, w], scale: [sx, sy, sz] } = canonicalTransform(local);
  const linear: Mat3 = [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz,
  ];
  if (!parent) return { position, linear };
  validateGlobal(parent);
  const delta = applyLinear(parent.linear, position);
  const result: GlobalTransform = {
    position: [parent.position[0] + delta[0], parent.position[1] + delta[1], parent.position[2] + delta[2]],
    linear: [
      ...applyLinear(parent.linear, [linear[0], linear[1], linear[2]]),
      ...applyLinear(parent.linear, [linear[3], linear[4], linear[5]]),
      ...applyLinear(parent.linear, [linear[6], linear[7], linear[8]]),
    ],
  };
  validateGlobal(result);
  return result;
}

/** Reference point evaluation only; rendering should keep vertices asset-local. */
export function transformPoint(transform: GlobalTransform, point: Vec3): Vec3 {
  validateGlobal(transform);
  validatePosition(point);
  const delta = applyLinear(transform.linear, point);
  const result: Vec3 = [transform.position[0] + delta[0], transform.position[1] + delta[1], transform.position[2] + delta[2]];
  validatePosition(result);
  return result;
}

/** Subtraction happens in binary64, before the upload boundary. */
export function relativePosition(position: Vec3, origin: Vec3): Vec3 {
  validatePosition(position);
  validatePosition(origin);
  return [position[0] - origin[0], position[1] - origin[1], position[2] - origin[2]];
}

export function renderPosition(position: Vec3, origin: Vec3): Float32Array<ArrayBuffer> {
  return new Float32Array(relativePosition(position, origin));
}

/** Column-major model matrix for an origin-relative view, not an absolute view. */
export function renderTransform(sample: CoordinateSample): Float32Array<ArrayBuffer> {
  validateGlobal(sample.transform);
  const [x, y, z] = relativePosition(sample.transform.position, sample.origin);
  const m = sample.transform.linear;
  const result = new Float32Array([
    m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, x, y, z, 1,
  ]);
  if (!result.every(Number.isFinite)) throw new RangeError('render transform overflows float32');
  return result;
}

/** No hidden distance heuristic or live history state. The caller marks discontinuities. */
export function renderTransformPair(current: CoordinateSample, previous?: CoordinateSample,
  continuity: 'continuous' | 'camera-cut' | 'object-teleport' = 'continuous',
): { current: Float32Array<ArrayBuffer>; previous: Float32Array<ArrayBuffer> | null; historyValid: boolean } {
  const historyValid = previous !== undefined && continuity === 'continuous';
  return {
    current: renderTransform(current),
    previous: historyValid ? renderTransform(previous!) : null,
    historyValid,
  };
}
