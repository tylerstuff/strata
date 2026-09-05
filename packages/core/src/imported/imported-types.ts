import type { ImportedIndirectDenoise, ImportedIndirectOptions, ImportedIndirectProgress, ImportedIndirectReadback } from './imported-indirect-types.js';

/** Optional glTF inspection path. No virtual geometry or scene-traced reflections. */
export type ImportedVec3 = readonly [number, number, number];
export type ImportedVec4 = readonly [number, number, number, number];
export interface ImportedBounds { readonly min: ImportedVec3; readonly max: ImportedVec3; }

export interface ImportedSampler {
  readonly magFilter: 9728 | 9729;
  readonly minFilter: 9728 | 9729 | 9984 | 9985 | 9986 | 9987;
  readonly wrapS: 33071 | 33648 | 10497;
  readonly wrapT: 33071 | 33648 | 10497;
}
export interface ImportedTexture {
  readonly image: number;
  readonly sampler: ImportedSampler;
}
export interface ImportedImage {
  readonly name: string;
  readonly mimeType: 'image/png' | 'image/jpeg';
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly width: number;
  readonly height: number;
}
export interface ImportedMaterial {
  readonly name: string;
  /** KHR_materials_unlit: base color bypasses lighting, metallic/roughness, normal, AO and emission. */
  readonly unlit?: boolean;
  readonly baseColorFactor: ImportedVec4;
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  readonly emissiveFactor: ImportedVec3;
  readonly emissiveStrength: number;
  readonly normalScale: number;
  readonly occlusionStrength: number;
  readonly alphaMode: 'OPAQUE' | 'MASK';
  readonly alphaCutoff: number;
  readonly doubleSided: boolean;
  readonly baseColorTexture?: ImportedTexture;
  readonly metallicRoughnessTexture?: ImportedTexture;
  readonly normalTexture?: ImportedTexture;
  readonly occlusionTexture?: ImportedTexture;
  readonly emissiveTexture?: ImportedTexture;
}
export interface ImportedPrimitive {
  readonly name: string;
  /** Interleaved static normalized world position3, normal3, UV2, tangent4, linear vertex color4 (64-byte stride). */
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
  readonly material: number;
  /** Local pre-skin attributes for optional deterministic TRS animation. Static vertices above remain the rest pose. */
  readonly deformation?: {
    readonly node: number;
    readonly vertices: Float32Array<ArrayBuffer>;
    readonly skin?: number;
    /** Four skin-local joint indices and normalized weights per vertex. Both required for a skinned primitive. */
    readonly joints?: Uint32Array<ArrayBuffer>;
    readonly weights?: Float32Array<ArrayBuffer>;
  };
}
export interface ImportedNode {
  readonly parent: number | null;
  readonly translation: ImportedVec3;
  readonly rotation: ImportedVec4;
  readonly scale: ImportedVec3;
  /** Column-major local matrix for non-animated matrix-authored nodes. */
  readonly matrix?: Float32Array<ArrayBuffer>;
}
export interface ImportedSkin {
  readonly joints: readonly number[];
  /** One column-major 4x4 matrix per joint, in the same order. */
  readonly inverseBindMatrices: Float32Array<ArrayBuffer>;
}
export interface ImportedAnimationChannel {
  readonly node: number;
  readonly path: 'translation' | 'rotation' | 'scale';
  readonly interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
  readonly times: Float32Array<ArrayBuffer>;
  /** Cubic samples are in-tangent, value, out-tangent; other modes store values. */
  readonly values: Float32Array<ArrayBuffer>;
}
export interface ImportedAnimationClip {
  readonly id: string;
  readonly name: string;
  readonly duration: number;
  readonly channels: readonly ImportedAnimationChannel[];
}
export interface ImportedAsset {
  readonly version: 1;
  readonly sourceUrl: string;
  readonly primitives: readonly ImportedPrimitive[];
  readonly materials: readonly ImportedMaterial[];
  readonly images: readonly ImportedImage[];
  readonly sourceBounds: ImportedBounds;
  /** Largest extent is two units; X/Z center is zero and min Y is zero. */
  readonly bounds: ImportedBounds;
  readonly normalization: { readonly scale: number; readonly translation: ImportedVec3 };
  /** Explicit maximum upload edge. The renderer reports actual source/upload dimensions. */
  readonly maxTextureDimension: number;
  readonly warnings: readonly string[];
  readonly clips: readonly ImportedAnimationClip[];
  readonly rig?: { readonly nodes: readonly ImportedNode[]; readonly skins: readonly ImportedSkin[] };
  readonly stats: {
    readonly meshInstances: number; readonly primitives: number; readonly vertices: number;
    readonly triangles: number; readonly materials: number; readonly images: number;
    readonly encodedBytes: number; readonly geometryBytes: number;
    readonly skinnedMeshInstances: number; readonly animationClips: number;
  };
}
export interface LoadGltfOptions {
  readonly signal?: AbortSignal;
  /** Defaults to 2048. Larger source images are resized in memory for upload and reported. */
  readonly maxTextureDimension?: number;
  /** Aggregate fetched/decoded source limit; defaults to 256 MiB. */
  readonly maxSourceBytes?: number;
  /** Output geometry limit; defaults to 256 MiB. */
  readonly maxGeometryBytes?: number;
  /** Maximum dimension of an encoded source image; defaults to 16384. */
  readonly maxSourceImageDimension?: number;
}
export interface ImportedSceneOptions {
  readonly renderer: 'imported';
  /** CPU data remains caller-owned and reusable; do not mutate it during scene creation. */
  readonly asset: ImportedAsset;
  readonly signal?: AbortSignal;
  /** Opt-in static, single-material diffuse preview. Full-resolution accumulation has an explicit pixel budget. */
  readonly indirect?: ImportedIndirectOptions;
}
/** Generated distant incident radiance. It has no scene visibility, GI, local reflections or interior occlusion. */
export interface ImportedEnvironment {
  readonly preset: 'studio' | 'sky';
  /** Scene-linear radiance multiplier, 0–64. Zero disables illumination without releasing retained resources. */
  readonly intensity: number;
  /** Positive yaw rotates the environment around world +Y; default zero. */
  readonly rotationRadians?: number;
}
export interface ImportedControls {
  /** Requires a scene created with indirect options. Disabling retains the matching direct-only baseline. */
  readonly indirect?: { readonly enabled: boolean; readonly denoise?: ImportedIndirectDenoise };
  /** Authored is the default. Relit changes only unlit materials to geometric-normal matte dielectric (roughness .65). */
  readonly shading?: 'authored' | 'relit';
  /** verticalFov is in radians. Camera motion retains reprojection history. */
  readonly camera?: { readonly eye: ImportedVec3; readonly target: ImportedVec3; readonly verticalFov: number };
  readonly lighting?: {
    readonly directionToLight: ImportedVec3;
    readonly color: ImportedVec3;
    readonly intensity: number;
    /** Linear diffuse fill, modulated only by material AO. No world visibility, GI or image-based lighting. */
    readonly ambient: ImportedVec3;
    /** Optional distant lighting; omitted/null means off when replacing lighting. Omit lighting itself to retain all light settings. */
    readonly environment?: ImportedEnvironment | null;
  };
  readonly presentation?: 'model-only' | 'ground';
  readonly background?: ImportedVec3;
  /** Explicit deterministic clip time; the host owns play/pause and scheduling. Null selects rest pose. */
  readonly animation?: { readonly clipId: string | null; readonly timeSeconds: number; readonly loop: boolean };
}
export interface ImportedTelemetry {
  readonly indirect?: {
    readonly mode: 'progressive-diffuse';
    /** Both enabled and disabled comparisons use no TAA, ambient fill or unoccluded environment illumination. */
    readonly temporal: false;
    readonly rasterAmbient: 'disabled';
    readonly rasterEnvironment: 'disabled';
    readonly progress: ImportedIndirectProgress;
    /** Captured by waitForIdle, tagged with its own accumulation revision and submitted-frame count. */
    readonly sampleCounters: ImportedIndirectReadback | null;
    readonly estimatedPeakCpuBytes: number;
    readonly preparedTraceGpuBytes: number;
  };
  readonly sourceUrl: string;
  /** Conservative current visible bounds, including retained root motion and the optional ground. */
  readonly bounds: ImportedBounds;
  readonly triangles: number;
  readonly primitives: number;
  readonly warnings: readonly string[];
  readonly animation: { readonly clipId: string | null; readonly timeSeconds: number; readonly loop: boolean };
  readonly shading: 'authored' | 'relit';
  readonly environment: Required<ImportedEnvironment> | null;
  readonly textures: readonly {
    readonly image: number; readonly sourceWidth: number; readonly sourceHeight: number;
    readonly uploadWidth: number; readonly uploadHeight: number;
    readonly colorSpace: 'srgb' | 'linear'; readonly mipLevels: number; readonly gpuBytes: number;
  }[];
}
