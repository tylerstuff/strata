import type { ImportedVec3, ImportedVec4 } from './imported-types.js';

/**
 * Internal static geometry. The caller MUST run validateImportedStaticBvh before
 * creating the effect; topology, attributes and triangle mappings are not rescanned
 * here. Arrays remain caller-owned; do not mutate during create().
 */
export interface ImportedIndirectSource {
  readonly nodes: Uint8Array<ArrayBuffer>;
  readonly triangles: Uint8Array<ArrayBuffer>;
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
}

/** Texture views and samplers are borrowed from imported geometry and must outlive this effect. */
export interface ImportedIndirectMaterial {
  readonly baseColorTexture: GPUTextureView;
  readonly baseSampler: GPUSampler;
  readonly metallicRoughnessTexture: GPUTextureView;
  readonly metallicRoughnessSampler: GPUSampler;
  readonly emissiveTexture: GPUTextureView;
  readonly emissiveSampler: GPUSampler;
  readonly baseColorFactor: ImportedVec4;
  readonly metallicFactor: number;
  readonly emissiveFactor: ImportedVec3;
  readonly emissiveStrength: number;
  readonly doubleSided: boolean;
}
export interface ImportedIndirectLighting {
  readonly directionToLight: ImportedVec3;
  readonly color: ImportedVec3;
  readonly intensity: number;
}
export interface ImportedIndirectEnvironment {
  readonly mode: 'off' | 'studio' | 'sky' | 'constant';
  readonly intensity: number;
  readonly rotationRadians: number;
  /** Constant mode is an internal diagnostic input, not a gallery preset. */
  readonly constantRadiance?: ImportedVec3;
}
export interface ImportedIndirectOptions {
  /** Explicit presentation capability: seven storage bindings and a 65,536-pixel lifetime cap. */
  readonly spatialDenoise?: boolean;
  readonly maxPixels?: number;
  readonly pixelBatch?: number;
  readonly maxSamples?: number;
  readonly maxVisits?: number;
  readonly seed?: number;
}
/** Numeric transport limits; presentation capability never participates in reset keys. */
export type ImportedIndirectTraceOptions = Omit<ImportedIndirectOptions, 'spatialDenoise'>;
export type ImportedIndirectDenoise = 'off' | 'spatial';
export interface ImportedSpatialDiagnostics {
  readonly filteredPixels: number;
  readonly fallbackChannels: number;
  readonly hdrFaultChannels: number;
  readonly guideBypassPixels: number;
}
export interface ImportedIndirectCreateOptions {
  readonly source: ImportedIndirectSource;
  readonly material: ImportedIndirectMaterial;
  readonly lighting: ImportedIndirectLighting;
  readonly environment: ImportedIndirectEnvironment;
  readonly options?: ImportedIndirectOptions;
  readonly signal?: AbortSignal;
}
export interface ImportedIndirectProgress {
  /** Changes only when a reset frame is submitted. */
  readonly revision: number;
  readonly submittedFrames: number;
  /** Engine frame identity of the last submitted composition, never a sample count. */
  readonly submittedFrameId: number | null;
  readonly spatialDenoise: boolean;
  readonly denoise: ImportedIndirectDenoise;
  /** Changes on presentation control edits, without resetting transport. */
  readonly presentationRevision: number;
  readonly batchCursor: number;
  readonly width: number;
  readonly height: number;
  readonly pendingReset: boolean;
  readonly pendingFrame: boolean;
  readonly enabled: boolean;
  readonly normalMode: 'geometric';
  readonly textureLod: 0;
  /** Scheduling limits, not measured samples per pixel. */
  readonly limits: Required<ImportedIndirectTraceOptions>;
}
export interface ImportedIndirectReadback extends ImportedIndirectProgress {
  /** Per-composition diagnostics, tagged with this readback's mode/frame/revision. */
  readonly spatialDiagnostics?: ImportedSpatialDiagnostics;
  /** GPU counters in this accumulation revision. Attempts are not accepted-only normalization. */
  readonly attempted: number;
  readonly completed: number;
  readonly exhausted: number;
  readonly invalid: number;
}
