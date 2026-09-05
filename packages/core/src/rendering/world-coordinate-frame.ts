/** Internal CPU numeric boundary. Public descriptor validation/profile limits belong to Core. */
export type CoordinateVec3 = readonly [number, number, number];
export type CoordinateQuaternion = readonly [number, number, number, number];
export interface CoordinateBox {
  readonly dimensions: CoordinateVec3;
  readonly transform: {
    readonly position: CoordinateVec3;
    readonly rotation: CoordinateQuaternion;
    readonly scale: CoordinateVec3;
  };
}
export interface CoordinateCamera {
  readonly position: CoordinateVec3;
  readonly rotation: CoordinateQuaternion;
}
export interface CoordinatePerspective {
  readonly verticalFovRadians: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
}
export interface WorldCoordinateFrame {
  readonly origin: CoordinateVec3;
  /** Copied binary64 pose, with a normalized evaluation quaternion. */
  readonly camera: CoordinateCamera;
  readonly viewRotation: Float32Array<ArrayBuffer>;
  readonly viewProjection: Float32Array<ArrayBuffer>;
  /** Column-major 4x4 per root, with camera-relative translation. */
  readonly modelMatrices: Float32Array<ArrayBuffer>;
  /** Column-major inverse-transpose 3x3, padded as three [x,y,z,0] columns per root. */
  readonly normalMatrices: Float32Array<ArrayBuffer>;
  /**
   * Unrounded geometric bounds: f64 minXYZ,maxXYZ per root before f32 packing.
   * These are NOT automatically conservative bounds for rounded GPU vertices.
   * A culling integration must separately account for packing and shader error.
   */
  readonly relativeBounds: Float64Array<ArrayBuffer>;
}

/** Numeric diagnostics only; callers map these to their public StrataError code. */
export class WorldCoordinateError extends RangeError {
  constructor(readonly path: string, readonly reason: string, readonly boxIndex: number | null = null) {
    super(`${path}: ${reason}`);
    this.name = 'WorldCoordinateError';
  }
}

type Matrix3 = readonly [number, number, number, number, number, number, number, number, number];
const MAX_POSITION = 2 ** 30;
function fail(path: string, reason: string, index: number | null): never {
  throw new WorldCoordinateError(path, reason, index);
}
function tuple(value: readonly number[], length: number, path: string, index: number | null): void {
  if (!Array.isArray(value) || value.length !== length) fail(path, `Expected ${length} numeric components`, index);
  for (let axis = 0; axis < length; axis++) {
    if (!Number.isFinite(value[axis])) fail(`${path}/${axis}`, 'Expected a finite number', index);
  }
}
function position(value: CoordinateVec3, path: string, index: number | null): CoordinateVec3 {
  tuple(value, 3, path, index);
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(value[axis]!) > MAX_POSITION) fail(`${path}/${axis}`, 'Position exceeds the strata-world-v1 guard', index);
  }
  return [...value];
}
function quaternion(value: CoordinateQuaternion, path: string, index: number | null): CoordinateQuaternion {
  tuple(value, 4, path, index);
  const length = Math.hypot(...value);
  if (Math.abs(length - 1) > 1e-6) fail(path, 'Quaternion norm must be within 1e-6 of one', index);
  return [value[0] / length, value[1] / length, value[2] / length, value[3] / length];
}
function rotation([x, y, z, w]: CoordinateQuaternion): Matrix3 {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
  ];
}
function packed(value: number, path: string, index: number | null, nonzero = false): number {
  const result = Math.fround(value);
  if (!Number.isFinite(result) || (nonzero && result === 0)) fail(path, 'Value collapses or overflows float32', index);
  return result;
}

/**
 * Packs a caller-bounded resident batch without touching source objects or any GPU.
 * Extra descriptor metadata is ignored; this is not a competing JSON schema parser.
 * Array order is preserved. Returned buffers never alias inputs or earlier calls.
 * Previous frames are separate calls; no culling, history, submission or origin state.
 */
export function packWorldCoordinateFrame(boxes: readonly CoordinateBox[], camera: CoordinateCamera,
  perspective: CoordinatePerspective): WorldCoordinateFrame {
  if (!Array.isArray(boxes)) fail('/boxes', 'Expected an array of numeric box inputs', null);
  if (!camera || typeof camera !== 'object') fail('/camera', 'Expected a camera pose', null);
  const origin = position(camera.position, '/camera/position', null);
  const orientation = quaternion(camera.rotation, '/camera/rotation', null);
  if (!perspective || typeof perspective !== 'object') fail('/camera/projection', 'Expected perspective parameters', null);
  const { verticalFovRadians, aspect, near, far } = perspective;
  if (!Number.isFinite(verticalFovRadians) || verticalFovRadians <= 0 || verticalFovRadians >= Math.PI) {
    fail('/camera/projection/verticalFovRadians', 'Expected a finite angle between zero and pi', null);
  }
  if (!Number.isFinite(aspect) || aspect <= 0) fail('/viewport/aspect', 'Expected a finite positive aspect', null);
  if (!Number.isFinite(near) || near <= 0) fail('/camera/projection/near', 'Expected a finite positive near plane', null);
  if (!Number.isFinite(far) || far <= near) fail('/camera/projection/far', 'Expected a finite far plane greater than near', null);

  const cameraRotation = rotation(orientation);
  // Inverse of the normalized camera rotation. No global translation enters this matrix.
  const view = [
    cameraRotation[0], cameraRotation[3], cameraRotation[6], 0,
    cameraRotation[1], cameraRotation[4], cameraRotation[7], 0,
    cameraRotation[2], cameraRotation[5], cameraRotation[8], 0,
    0, 0, 0, 1,
  ];
  const focal = 1 / Math.tan(verticalFovRadians / 2);
  const depth = far / (near - far);
  packed(focal, '/camera/projection/verticalFovRadians', null, true);
  packed(focal / aspect, '/viewport/aspect', null, true);
  packed(depth, '/camera/projection/far', null, true);
  packed(near * depth, '/camera/projection/near', null, true);
  const projection = [focal / aspect, 0, 0, 0, 0, focal, 0, 0, 0, 0, depth, -1, 0, 0, near * depth, 0];
  const viewRotation = new Float32Array(view);
  const viewProjection = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let component = 0; component < 4; component++) sum += projection[component * 4 + row]! * view[column * 4 + component]!;
      viewProjection[column * 4 + row] = packed(sum, '/camera/projection', null);
    }
  }

  const modelMatrices = new Float32Array(boxes.length * 16);
  const normalMatrices = new Float32Array(boxes.length * 12);
  const relativeBounds = new Float64Array(boxes.length * 6);
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index]; const path = `/boxes/${index}`;
    if (!box || typeof box !== 'object' || !box.transform || typeof box.transform !== 'object') fail(path, 'Expected dimensions and a root transform', index);
    const translation = position(box.transform.position, `${path}/transform/position`, index);
    const r = rotation(quaternion(box.transform.rotation, `${path}/transform/rotation`, index));
    tuple(box.transform.scale, 3, `${path}/transform/scale`, index);
    tuple(box.dimensions, 3, `${path}/dimensions`, index);
    const effective = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      const scale = box.transform.scale[axis]!; const dimension = box.dimensions[axis]!;
      if (scale < 1e-6 || scale > 1e6) fail(`${path}/transform/scale/${axis}`, 'Scale must be within [1e-6,1e6]', index);
      if (dimension <= 0) fail(`${path}/dimensions/${axis}`, 'Dimensions must be positive', index);
      const value = scale * dimension;
      packed(value, `${path}/dimensions/${axis}`, index, true);
      packed(1 / value, `${path}/dimensions/${axis}`, index, true);
      effective[axis] = value;
    }
    const linear = new Array<number>(9);
    for (let column = 0; column < 3; column++) {
      for (let row = 0; row < 3; row++) {
        const component = column * 3 + row;
        const value = r[component]! * effective[column]!;
        linear[component] = value;
        modelMatrices[index * 16 + column * 4 + row] = packed(value, `${path}/transform`, index);
        normalMatrices[index * 12 + column * 4 + row] = packed(r[component]! / effective[column]!, `${path}/transform`, index);
      }
    }
    for (let axis = 0; axis < 3; axis++) {
      const center = translation[axis]! - origin[axis]!; // binary64 subtraction precedes packing
      const extent = (Math.abs(linear[axis]!) + Math.abs(linear[3 + axis]!) + Math.abs(linear[6 + axis]!)) * 0.5;
      const min = center - extent; const max = center + extent;
      if (!Number.isFinite(min) || !Number.isFinite(max)) fail(`${path}/dimensions`, 'Geometric bounds are nonfinite', index);
      relativeBounds[index * 6 + axis] = min;
      relativeBounds[index * 6 + 3 + axis] = max;
      modelMatrices[index * 16 + 12 + axis] = packed(center, `${path}/transform/position/${axis}`, index);
    }
    modelMatrices[index * 16 + 15] = 1;
  }
  return { origin, camera: { position: [...origin], rotation: orientation }, viewRotation, viewProjection,
    modelMatrices, normalMatrices, relativeBounds };
}
