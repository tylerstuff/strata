import { StrataError } from '../errors.js';
import { createGiScene } from '../gi/scene-data.js';
import type { GiBox, GiMaterial, GiSceneData, GiSceneOptions, GiVec3 } from '../gi/scene-data.js';

export interface ReflectionSceneOptions extends GiSceneOptions { objectOffset?: number; roughness?: number }
export interface ReflectionSceneData extends GiSceneData {
  readonly state: Readonly<Required<ReflectionSceneOptions>>;
  readonly reflectorBoxId: number;
  readonly objectBoxId: number;
}
export const reflectionSurface = Object.freeze({
  min: Object.freeze([-2, 0.01, -1]) as GiVec3,
  max: Object.freeze([-1, 0.01, 1]) as GiVec3,
  planeY: 0.01,
});
const vector = (x: number, y: number, z: number): GiVec3 => Object.freeze([x, y, z]) as GiVec3;

/** The original two-room fixture plus one closed mirror slab and one closed emissive cube. */
export function createReflectionScene(options: ReflectionSceneOptions = {}): ReflectionSceneData {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || (options.objectOffset !== undefined && (!Number.isFinite(options.objectOffset) || Math.abs(options.objectOffset) > 0.4))
    || (options.roughness !== undefined && (!Number.isFinite(options.roughness) || options.roughness < 0 || options.roughness > 0.35))) {
    throw new StrataError('INVALID_OPTIONS', 'Reflection fixture requires objectOffset in [-0.4,0.4] and roughness in [0,0.35].');
  }
  const base = createGiScene(options);
  const state = Object.freeze({ ...base.state, objectOffset: options.objectOffset ?? 0, roughness: options.roughness ?? 0.08 });
  const mirrorMaterial: GiMaterial = Object.freeze({ id: base.materials.length, albedo: vector(0.85, 0.85, 0.85),
    emission: vector(0, 0, 0), metallic: 1, roughness: state.roughness });
  const objectMaterial: GiMaterial = Object.freeze({ id: base.materials.length + 1, albedo: vector(0.6, 0.08, 0.03),
    emission: vector(4, 0.25, 0.08), metallic: 0, roughness: 1 });
  const mirror: GiBox = Object.freeze({ id: base.boxes.length, name: 'selected floor reflector', center: vector(-1.5, 0.005, 0),
    halfSize: vector(0.5, 0.005, 1), yaw: 0, materialId: mirrorMaterial.id });
  const object: GiBox = Object.freeze({ id: base.boxes.length + 1, name: 'offscreen emissive cube', center: vector(-0.8, 1.12, 0.2 + state.objectOffset),
    halfSize: vector(0.18, 0.18, 0.18), yaw: 0, materialId: objectMaterial.id });
  return Object.freeze({ ...base, state, boxes: Object.freeze([...base.boxes, mirror, object]),
    materials: Object.freeze([...base.materials, mirrorMaterial, objectMaterial]), reflectorBoxId: mirror.id, objectBoxId: object.id });
}

/** Independent planar witness for diagnostics: reflect the object across the actual mirror top. */
export function reflectionWitness(scene: ReflectionSceneData, eye: GiVec3 = [-3, 2.4, 0.2]): {
  point: GiVec3; origin: GiVec3; direction: GiVec3; virtualObject: GiVec3;
} {
  const object = scene.boxes[scene.objectBoxId]!.center;
  const virtualObject = vector(object[0], 2 * reflectionSurface.planeY - object[1], object[2]);
  const fraction = (eye[1] - reflectionSurface.planeY) / (eye[1] - virtualObject[1]);
  const point = vector(eye[0] + fraction * (virtualObject[0] - eye[0]), reflectionSurface.planeY,
    eye[2] + fraction * (virtualObject[2] - eye[2]));
  const incident = vector(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]);
  const length = Math.hypot(...incident);
  return { point, origin: vector(point[0], point[1] + 0.002, point[2]),
    direction: vector(incident[0] / length, -incident[1] / length, incident[2] / length), virtualObject };
}
