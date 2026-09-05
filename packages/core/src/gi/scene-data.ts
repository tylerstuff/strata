import { StrataError } from '../errors.js';

export type GiVec3 = readonly [number, number, number];
export interface GiSceneOptions { doorOpen?: boolean; wallColor?: 'red' | 'neutral'; lightIntensity?: number }
export interface GiMaterial { readonly id: number; readonly albedo: GiVec3; readonly emission: GiVec3; readonly roughness: number; readonly metallic?: number }
export interface GiBox {
  readonly id: number; readonly name: string; readonly center: GiVec3; readonly halfSize: GiVec3;
  readonly yaw: number; readonly materialId: number;
}
export interface GiSceneData {
  readonly state: Readonly<Required<GiSceneOptions>>;
  readonly boxes: readonly GiBox[];
  readonly materials: readonly GiMaterial[];
  readonly light: { readonly direction: GiVec3; readonly radiance: GiVec3 };
  readonly bounds: { readonly min: GiVec3; readonly max: GiVec3 };
  readonly doorBoxId: number;
  readonly coloredWallBoxId: number;
}
export interface GiTriangle {
  readonly id: number; readonly boxId: number; readonly materialId: number;
  readonly p0: GiVec3; readonly p1: GiVec3; readonly p2: GiVec3; readonly normal: GiVec3;
}

function vector(x: number, y: number, z: number): GiVec3 { return Object.freeze([x, y, z]) as GiVec3; }

/** Analytic opaque fixture in metres. All colors/radiance are linear, with no ambient term. */
export function createGiScene(options: GiSceneOptions = {}): GiSceneData {
  if (!options || typeof options !== 'object'
    || (options.doorOpen !== undefined && typeof options.doorOpen !== 'boolean')
    || (options.wallColor !== undefined && !['red', 'neutral'].includes(options.wallColor))
    || (options.lightIntensity !== undefined && (!Number.isFinite(options.lightIntensity) || options.lightIntensity < 0 || options.lightIntensity > 8))) {
    throw new StrataError('INVALID_OPTIONS', 'Invalid GI scene controls.');
  }
  const state = Object.freeze({ doorOpen: options.doorOpen ?? true, wallColor: options.wallColor ?? 'red', lightIntensity: options.lightIntensity ?? 1 });
  const materials: GiMaterial[] = [
    { id: 0, albedo: vector(0.72, 0.72, 0.72), emission: vector(0, 0, 0), roughness: 1 },
    { id: 1, albedo: state.wallColor === 'red' ? vector(0.8, 0.045, 0.025) : vector(0.45, 0.45, 0.45), emission: vector(0, 0, 0), roughness: 1 },
    { id: 2, albedo: vector(0.28, 0.31, 0.34), emission: vector(0, 0, 0), roughness: 1 },
  ];
  const boxes: GiBox[] = [];
  const box = (name: string, center: GiVec3, halfSize: GiVec3, materialId = 0, yaw = 0): number => {
    const id = boxes.length;
    boxes.push(Object.freeze({ id, name, center: vector(...center), halfSize: vector(...halfSize), yaw, materialId }));
    return id;
  };
  box('floor', [0, -0.1, 0], [6.1, 0.1, 4.1]);
  box('receiver room outer wall', [-6.05, 2, 0], [0.05, 2, 4.1]);
  box('source room outer wall', [6.05, 2, 0], [0.05, 2, 4.1]);
  box('front wall', [0, 2, 4.05], [6, 2, 0.05]);
  box('receiver back wall', [-3, 2, -4.05], [3, 2, 0.05]);
  const coloredWallBoxId = box('sunlit colored wall', [3, 2, -4.05], [3, 2, 0.05], 1);
  box('receiver roof', [-3.05, 4.05, 0], [3.05, 0.05, 4.1]);
  box('divider left jamb', [0, 2, -2.5], [0.06, 2, 1.5]);
  box('divider right jamb', [0, 2, 2.5], [0.06, 2, 1.5]);
  box('divider lintel', [0, 3.4, 0], [0.06, 0.6, 1]);
  // Hinge is (x=0,z=+1). Open slab faces away from the red-wall transport path.
  const doorBoxId = box('rigid door', state.doorOpen ? [1, 1.4, 1] : [0, 1.4, 0], [0.04, 1.4, 1], 2, state.doorOpen ? -Math.PI / 2 : 0);
  const length = Math.hypot(0.35, 0.8, 0.4);
  return Object.freeze({ state, boxes: Object.freeze(boxes), materials: Object.freeze(materials.map(material => Object.freeze(material))),
    light: Object.freeze({ direction: vector(0.35 / length, 0.8 / length, 0.4 / length), radiance: vector(4 * state.lightIntensity, 3.8 * state.lightIntensity, 3.5 * state.lightIntensity) }),
    bounds: Object.freeze({ min: vector(-6.1, -0.2, -4.1), max: vector(6.1, 4.1, 4.1) }), doorBoxId, coloredWallBoxId });
}

/** The same Y rotation is used by packed boxes, triangle tracing and raster vertices. */
export function giBoxToWorld(box: GiBox, local: GiVec3): GiVec3 {
  const c = Math.cos(box.yaw); const s = Math.sin(box.yaw);
  return vector(Math.fround(c * local[0] + s * local[2] + box.center[0]), Math.fround(local[1] + box.center[1]), Math.fround(-s * local[0] + c * local[2] + box.center[2]));
}

/** Exact outward-CCW faces. Float32 positions keep the CPU source identical to GPU input. */
export function triangulateGiScene(scene: GiSceneData): readonly GiTriangle[] {
  const result: GiTriangle[] = [];
  for (const box of scene.boxes) {
    for (let axis = 0; axis < 3; axis++) {
      const u = (axis + 1) % 3; const v = (axis + 2) % 3;
      for (const sign of [-1, 1]) {
        const points = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
          const point = [0, 0, 0]; point[axis] = sign * box.halfSize[axis]!;
          point[u] = a! * box.halfSize[u]!; point[v] = b! * box.halfSize[v]!;
          return giBoxToWorld(box, point as unknown as GiVec3);
        });
        const localNormal = [0, 0, 0]; localNormal[axis] = sign;
        const c = Math.cos(box.yaw); const s = Math.sin(box.yaw);
        const normal = vector(Math.fround(c * localNormal[0]! + s * localNormal[2]!), localNormal[1]!, Math.fround(-s * localNormal[0]! + c * localNormal[2]!));
        const order = sign > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
        for (let i = 0; i < 6; i += 3) result.push(Object.freeze({ id: result.length, boxId: box.id, materialId: box.materialId,
          p0: points[order[i]!]!, p1: points[order[i + 1]!]!, p2: points[order[i + 2]!]!, normal }));
      }
    }
  }
  return Object.freeze(result);
}
