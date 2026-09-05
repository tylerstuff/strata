/** Plain JSON coordinates in strata-world-v1; retain binary64 numbers until frame packing. */
export type BoxVec3 = readonly [number, number, number];
export type BoxQuaternion = readonly [number, number, number, number];

export interface BoxCamera {
  readonly position: BoxVec3;
  /** XYZW; local -Z forward and +Y up. Validation preserves accepted numbers. */
  readonly rotation: BoxQuaternion;
  readonly projection: {
    readonly kind: 'perspective';
    readonly verticalFovRadians: number;
    readonly near: number;
    readonly far: number;
  };
}

export interface AuthoredBox {
  readonly id: string;
  /** Full local lengths in metres; unit box vertices are centered in [-0.5,0.5]. */
  readonly dimensions: BoxVec3;
  readonly transform: {
    readonly position: BoxVec3;
    readonly rotation: BoxQuaternion;
    readonly scale: BoxVec3;
  };
  readonly material: {
    /** Linear RGB and alpha exactly one. */
    readonly baseColor: readonly [number, number, number, 1];
    readonly metallic: number;
    /** Perceptual roughness; the renderer's effective BRDF minimum is 0.06. */
    readonly roughness: number;
  };
}

/** Resident opaque root boxes only; this is not an authoring document or an asset loader. */
export interface BoxSceneDescriptor {
  readonly format: 'strata.runtime-boxes';
  readonly version: 1;
  readonly coordinateSystem: 'strata-world-v1';
  readonly sceneId: string;
  /** Opaque caller correlation. Core does not verify an authoring document or its hash. */
  readonly sourceRevision: string | null;
  readonly boxes: readonly AuthoredBox[];
  readonly camera: BoxCamera;
  readonly light: {
    /** World-space unit direction towards the light, not the light's travel direction. */
    readonly directionToLight: BoxVec3;
    readonly radiance: BoxVec3;
  };
  /** Linear RGB before the fixed presentation transform. */
  readonly background: BoxVec3;
}

export interface AuthoredBoxSceneOptions {
  readonly renderer: 'authored-boxes';
  readonly scene: BoxSceneDescriptor;
  /** Load control stays outside the JSON descriptor. */
  readonly signal?: AbortSignal;
}

/** Effective submitted view data; the origin remains binary64. */
export interface AuthoredFrameMetadata {
  readonly camera: BoxCamera;
  readonly aspect: number;
  readonly origin: BoxVec3;
  readonly width: number;
  readonly height: number;
  readonly debugView: 'final' | 'base-color';
  readonly timeSeconds: number;
}
