import { StrataError } from '../errors.js';
import type { StrataErrorCode } from '../errors.js';
import type { AuthoredBox, BoxCamera, BoxQuaternion, BoxSceneDescriptor, BoxVec3 } from './authored-box-types.js';

export interface AuthoredBoxDiagnostic { readonly path: string; readonly reason: string }

/** JSON-pointer diagnostics without a dependency on the optional authoring package. */
export class AuthoredBoxValidationError extends StrataError {
  readonly diagnostics: readonly AuthoredBoxDiagnostic[];

  constructor(code: StrataErrorCode, path: string, reason: string) {
    super(code, `${path || '/'}: ${reason}`);
    this.name = 'AuthoredBoxValidationError';
    this.diagnostics = Object.freeze([Object.freeze({ path, reason })]);
  }
}

const positionLimit = 2 ** 30;
const quaternionTolerance = 1e-6;
const idPattern = /^[a-z][a-z0-9._-]{0,63}(?![\s\S])/;
// Only our independent frozen snapshots bypass repeat descriptor validation in a frame.
const snapshots = new WeakSet<BoxSceneDescriptor>();
const token = (value: string): string => value.replace(/~/g, '~0').replace(/\//g, '~1');

function fail(path: string, reason: string, code: StrataErrorCode = 'INVALID_OPTIONS'): never {
  throw new AuthoredBoxValidationError(code, path, reason);
}

function record(input: unknown, fields: readonly string[], path: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(path, 'Expected a plain JSON object.');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'Expected a plain JSON object.');
  if (Object.getOwnPropertySymbols(input).length) fail(path, 'Symbol properties are not JSON data.');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(input)) {
    const fieldPath = `${path}/${token(key)}`;
    const property = Object.getOwnPropertyDescriptor(input, key)!;
    if (!('value' in property) || !property.enumerable) fail(fieldPath, 'Only enumerable own data properties are accepted.');
    if (!fields.includes(key)) fail(fieldPath, 'This field is unsupported by the opaque root-box profile.', 'UNSUPPORTED_FEATURE');
    result[key] = property.value;
  }
  for (const field of fields) if (!Object.hasOwn(result, field)) fail(`${path}/${field}`, 'Required field is missing.');
  return result;
}

function array(input: unknown, path: string, maximum: number, exact?: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail(path, 'Expected a plain JSON array.');
  const length = Object.getOwnPropertyDescriptor(input, 'length')!.value as number;
  if (exact !== undefined && length !== exact) fail(path, `Expected exactly ${exact} components.`);
  if (length > maximum) fail(path, `At most ${maximum} items are supported.`, 'UNSUPPORTED_LIMIT');
  if (Object.getOwnPropertySymbols(input).length) fail(path, 'Symbol properties are not JSON data.');
  const keys = Object.getOwnPropertyNames(input);
  if (keys.length !== length + 1) fail(path, 'Expected a dense array without extra or hidden properties.');
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const property = Object.getOwnPropertyDescriptor(input, String(index));
    if (!property || !('value' in property) || !property.enumerable) fail(`${path}/${index}`, 'Array elements must be enumerable own data properties.');
    result.push(property.value);
  }
  return result;
}

function number(input: unknown, path: string, minimum = -Infinity, maximum = Infinity,
  code: StrataErrorCode = 'INVALID_OPTIONS'): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) fail(path, 'Expected a finite number.');
  if (input < minimum || input > maximum) fail(path, `Value must be within [${minimum}, ${maximum}].`, code);
  return input;
}

function literal<T extends string | number>(input: unknown, expected: T, path: string): T {
  if (typeof input !== typeof expected) fail(path, `Expected ${typeof expected} ${String(expected)}.`);
  if (input !== expected) fail(path, `Only ${String(expected)} is supported.`, 'UNSUPPORTED_FEATURE');
  return expected;
}

function vector(input: unknown, path: string, minimum: number, maximum: number): BoxVec3 {
  return Object.freeze(array(input, path, 3, 3).map((value, index) => number(value, `${path}/${index}`, minimum, maximum))) as unknown as BoxVec3;
}

function quaternion(input: unknown, path: string): BoxQuaternion {
  const values = array(input, path, 4, 4).map((value, index) => number(value, `${path}/${index}`));
  if (Math.abs(Math.hypot(...values) - 1) > quaternionTolerance) fail(path, 'Quaternion norm must be within 1e-6 of one.');
  return Object.freeze(values) as unknown as BoxQuaternion;
}

function id(input: unknown, path: string): string {
  if (typeof input !== 'string' || !idPattern.test(input)) fail(path, 'Expected 1–64 lowercase ASCII ID characters, starting with a letter.');
  return input;
}

function cameraSnapshot(input: unknown, path: string): BoxCamera {
  const camera = record(input, ['position', 'rotation', 'projection'], path);
  const projectionPath = `${path}/projection`;
  const projection = record(camera.projection, ['kind', 'verticalFovRadians', 'near', 'far'], projectionPath);
  const kind = literal(projection.kind, 'perspective', `${projectionPath}/kind`);
  const verticalFovRadians = number(projection.verticalFovRadians, `${projectionPath}/verticalFovRadians`, Math.PI / 180, 150 * Math.PI / 180, 'UNSUPPORTED_LIMIT');
  const near = number(projection.near, `${projectionPath}/near`, 0.001, 4096, 'UNSUPPORTED_LIMIT');
  const far = number(projection.far, `${projectionPath}/far`, 0.001, 4096, 'UNSUPPORTED_LIMIT');
  if (near >= far) fail(projectionPath, 'Perspective depth requires near < far.');
  if (far / near > 100000) fail(projectionPath, 'The far/near ratio must not exceed 100000.', 'UNSUPPORTED_LIMIT');
  // Aspect is validated per frame. These ordinary-depth projection terms must survive f32 upload.
  for (const value of [1 / Math.tan(verticalFovRadians / 2), far / (near - far), near * far / (near - far)]) {
    if (!Number.isFinite(Math.fround(value)) || Math.fround(value) === 0) fail(projectionPath, 'Projection terms must be representable as finite nonzero float32 values.', 'UNSUPPORTED_LIMIT');
  }
  return Object.freeze({
    position: vector(camera.position, `${path}/position`, -positionLimit, positionLimit),
    rotation: quaternion(camera.rotation, `${path}/rotation`),
    projection: Object.freeze({ kind, verticalFovRadians, near, far }),
  });
}

/** Validate/copy a complete camera. Accepted quaternion components are not normalized or rewritten. */
export function validateBoxCamera(input: unknown): BoxCamera { return cameraSnapshot(input, ''); }

function boxSnapshot(input: unknown, path: string): AuthoredBox {
  const box = record(input, ['id', 'dimensions', 'transform', 'material'], path);
  const transform = record(box.transform, ['position', 'rotation', 'scale'], `${path}/transform`);
  const dimensions = vector(box.dimensions, `${path}/dimensions`, Number.MIN_VALUE, Number.MAX_VALUE);
  const scale = vector(transform.scale, `${path}/transform/scale`, 1e-6, 1e6);
  for (let axis = 0; axis < 3; axis++) {
    const effective = dimensions[axis]! * scale[axis]!;
    if (!Number.isFinite(effective) || effective < 1e-4 || effective > 1024) {
      fail(`${path}/dimensions/${axis}`, 'Each dimension × scale must be within [0.0001, 1024] metres.', 'UNSUPPORTED_LIMIT');
    }
  }
  const material = record(box.material, ['baseColor', 'metallic', 'roughness'], `${path}/material`);
  const base = array(material.baseColor, `${path}/material/baseColor`, 4, 4).map((value, index) => number(value, `${path}/material/baseColor/${index}`, 0, 1));
  if (base[3] !== 1) fail(`${path}/material/baseColor/3`, 'Only opaque alpha=1 is supported.', 'UNSUPPORTED_FEATURE');
  return Object.freeze({
    id: id(box.id, `${path}/id`), dimensions,
    transform: Object.freeze({ position: vector(transform.position, `${path}/transform/position`, -positionLimit, positionLimit),
      rotation: quaternion(transform.rotation, `${path}/transform/rotation`), scale }),
    material: Object.freeze({ baseColor: Object.freeze(base) as unknown as readonly [number, number, number, 1],
      metallic: number(material.metallic, `${path}/material/metallic`, 0, 1), roughness: number(material.roughness, `${path}/material/roughness`, 0, 1) }),
  });
}

/** Profile validation in f64. No large global AABB or intermediate f32 world matrix. */
function relativeBounds(boxes: readonly AuthoredBox[], camera: BoxCamera): void {
  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index]!;
    const q = box.transform.rotation; const inverseNorm = 1 / Math.hypot(...q);
    const x = q[0] * inverseNorm, y = q[1] * inverseNorm, z = q[2] * inverseNorm, w = q[3] * inverseNorm;
    // Rows of R, used to transform full local dimensions into axis-aligned half extents.
    const rotation = [
      [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ];
    for (let axis = 0; axis < 3; axis++) {
      const relative = box.transform.position[axis]! - camera.position[axis]!;
      const extent = rotation[axis]!.reduce((sum, entry, component) =>
        sum + Math.abs(entry) * (box.dimensions[component]! * box.transform.scale[component]!) / 2, 0);
      if (Math.abs(relative) + extent > 4096) {
        fail(`/boxes/${index}/transform/position/${axis}`, 'The complete transformed box must remain within ±4096 metres of the effective camera on every axis.', 'UNSUPPORTED_LIMIT');
      }
    }
  }
}

/** Returns an independent deeply frozen snapshot, retaining authored binary64 values and array order. */
export function validateAuthoredBoxScene(input: unknown): BoxSceneDescriptor {
  const value = record(input, ['format', 'version', 'coordinateSystem', 'sceneId', 'sourceRevision', 'boxes', 'camera', 'light', 'background'], '');
  const format = literal(value.format, 'strata.runtime-boxes', '/format');
  const version = literal(value.version, 1, '/version');
  const coordinateSystem = literal(value.coordinateSystem, 'strata-world-v1', '/coordinateSystem');
  const sceneId = id(value.sceneId, '/sceneId');
  if (value.sourceRevision !== null && (typeof value.sourceRevision !== 'string' || value.sourceRevision.length < 1 || value.sourceRevision.length > 256)) {
    fail('/sourceRevision', 'Expected null or a nonempty caller correlation string of at most 256 UTF-16 code units.');
  }
  const sourceRevision = value.sourceRevision as string | null;
  const boxes = array(value.boxes, '/boxes', 1024).map((box, index) => boxSnapshot(box, `/boxes/${index}`));
  const ids = new Set<string>();
  for (let index = 0; index < boxes.length; index++) {
    if (ids.has(boxes[index]!.id)) fail(`/boxes/${index}/id`, 'Box IDs must be unique.');
    ids.add(boxes[index]!.id);
  }
  const camera = cameraSnapshot(value.camera, '/camera');
  relativeBounds(boxes, camera);
  const light = record(value.light, ['directionToLight', 'radiance'], '/light');
  const directionToLight = vector(light.directionToLight, '/light/directionToLight', -Infinity, Infinity);
  if (Math.abs(Math.hypot(...directionToLight) - 1) > quaternionTolerance) fail('/light/directionToLight', 'Light direction norm must be within 1e-6 of one.');
  const result: BoxSceneDescriptor = Object.freeze({
    format, version, coordinateSystem, sceneId, sourceRevision, boxes: Object.freeze(boxes), camera,
    light: Object.freeze({ directionToLight, radiance: vector(light.radiance, '/light/radiance', 0, 64) }),
    background: vector(value.background, '/background', 0, 1),
  });
  snapshots.add(result);
  return result;
}

/** Validate the exact frame camera/aspect/local bounds before GPU writes; device-size limits remain engine-owned. */
export function validateAuthoredFrameCamera(scene: BoxSceneDescriptor, camera: unknown, width: number, height: number): BoxCamera {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) fail('', 'Viewport dimensions must be positive safe integers.', 'INVALID_SIZE');
  const aspect = width / height;
  if (aspect < 1 / 64 || aspect > 64) fail('', 'Viewport aspect must be within [1/64, 64].', 'UNSUPPORTED_LIMIT');
  const checkedScene = snapshots.has(scene) ? scene : validateAuthoredBoxScene(scene);
  const checkedCamera = cameraSnapshot(camera, '/camera');
  relativeBounds(checkedScene.boxes, checkedCamera);
  return checkedCamera;
}
