/** This describes editable data only; the browser runtime does not load these documents yet. */
export const SCENE_SCHEMA_VERSION = 1 as const;
// The final negative lookahead is a strict end anchor (unlike $, which permits a trailing newline).
export const ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}(?![\s\S])/;
export const WORLD_POSITION_LIMIT = 2 ** 30;
export const MIN_SCALE = 1e-6;
export const MAX_SCALE = 1e6;
export const QUATERNION_NORM_TOLERANCE = 1e-6;

export interface Diagnostic {
  code: string;
  /** JSON Pointer; the empty string identifies the whole input. */
  path: string;
  message: string;
  suggestion: string;
  source?: string;
  entityId?: string;
  assetId?: string;
  materialId?: string;
  line?: number;
  column?: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; diagnostics: Diagnostic[] };

export class AuthoringError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.path || '/'}: ${diagnostic.message}`).join('\n'));
    this.name = 'AuthoringError';
    this.diagnostics = diagnostics;
  }
}

export type Vec3 = [number, number, number];
export type Quaternion = [number, number, number, number];

/** Root transform in strata-world-v1: metres, right-handed, +Y up, -Z forward. */
export interface Transform {
  /** Float64 JSON/JavaScript numbers, bounded to +/-2^30 metres per axis. */
  position: Vec3;
  /** Unit quaternion in [x,y,z,w] order; the document is never silently normalized. */
  rotation: Quaternion;
  /** Positive local scale; each component is in [1e-6, 1e6]. */
  scale: Vec3;
}

export type SceneAsset = {
  id: string;
  kind: 'procedural-box';
  /** Positive finite full extents in metres for a box centered at its local origin. */
  size: Vec3;
} | {
  id: string;
  kind: 'external';
  /** Reference only. Authoring never fetches, imports, copies, or cooks its contents. */
  uri: string;
  mediaType: string;
};

export interface SceneMaterial {
  id: string;
  kind: 'pbr';
  /** Linear RGBA in [0,1]; this initial format supports alpha=1 only. */
  baseColor: [number, number, number, 1];
  metallic: number;
  roughness: number;
}

export interface SceneEntity {
  id: string;
  name?: string;
  assetId: string;
  materialId: string;
  transform: Transform;
}

export interface SceneDocument {
  format: 'strata.scene';
  version: typeof SCENE_SCHEMA_VERSION;
  id: string;
  name: string;
  coordinateSystem: 'strata-world-v1';
  assets: SceneAsset[];
  materials: SceneMaterial[];
  entities: SceneEntity[];
}

export function createScene(id: string, name: string = id): SceneDocument {
  const diagnostics: Diagnostic[] = [];
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    diagnostics.push({
      code: 'INVALID_ID', path: '/id',
      message: 'Scene ID must start with a lowercase ASCII letter and contain at most 64 lowercase letters, digits, dots, underscores, or hyphens.',
      suggestion: 'Pass an explicit stable ID such as "courtyard-demo".',
    });
  }
  if (typeof name !== 'string' || [...name].length < 1 || [...name].length > 256) {
    diagnostics.push({
      code: 'INVALID_VALUE', path: '/name',
      message: 'Scene name must contain between 1 and 256 characters.',
      suggestion: 'Pass a nonempty scene name no longer than 256 characters.',
    });
  }
  if (diagnostics.length > 0) throw new AuthoringError(diagnostics);
  return {
    format: 'strata.scene', version: SCENE_SCHEMA_VERSION, id, name,
    coordinateSystem: 'strata-world-v1', assets: [], materials: [], entities: [],
  };
}

/** Tiny authoring fixture with no imported files or renderer-demo configuration. */
export function createProceduralScene(id = 'procedural-demo', name: string = id): SceneDocument {
  return {
    ...createScene(id, name),
    assets: [{ id: 'unit-box', kind: 'procedural-box', size: [1, 1, 1] }],
    materials: [{ id: 'warm-stone', kind: 'pbr', baseColor: [0.7, 0.5, 0.3, 1], metallic: 0, roughness: 0.8 }],
    entities: [{
      id: 'box-1', name: 'Procedural box', assetId: 'unit-box', materialId: 'warm-stone',
      transform: { position: [0, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    }],
  };
}
