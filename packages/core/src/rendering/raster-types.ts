/** Raster foundation controls; the temporal path defaults to enabled. */
export interface RasterControls {
  /** Per-render exposure compensation in stops [-16,16], default 0. Positive brightens.
   * Applies only to tone-mapped presentation; scene-linear lighting and histories are unchanged.
   * Nonzero values require a raster-based renderer (not clear, diffuse or authored-boxes).
   */
  exposureEV?: number;
  temporal?: boolean;
  debugView?: 'final' | 'direct' | 'shadow' | 'depth' | 'normal' | 'motion' | 'material' | 'clusters' | 'lod' | 'residency' | 'coverage'
    | 'indirect' | 'trace' | 'probe-age' | 'probe-irradiance' | 'probe-visibility' | 'reflections' | 'reflection-source';
  cameraCut?: boolean;
}

export type RasterPassName = 'selection' | 'shadow' | 'raster' | 'temporal' | 'presentation' | 'gi-primary' | 'gi-trace' | 'gi-update' | 'gi-shade' | 'reflection-trace' | 'reflection-resolve';
export type RasterTimestamps = Partial<Record<RasterPassName, GPURenderPassTimestampWrites>>;

/**
 * All screen textures use upper-left origin and pixel-center UVs.
 * hdr rgba16float: linear HDR RGB, directional shadow visibility A.
 * normal rgba16float: normalized world XYZ, perceptual roughness A.
 * material rgba8unorm: linear base-color RGB, metallic A.
 * motion rgba16float: previousUV-currentUV XY, current positive view-depth Z,
 * expected previous positive view-depth W. Motion includes projection jitter.
 * depth depth32float: WebGPU zero-to-one depth, clear value 1.
 */
export interface RasterOutputs {
  readonly hdr: GPUTextureView;
  readonly normal: GPUTextureView;
  readonly material: GPUTextureView;
  readonly motion: GPUTextureView;
  readonly depth: GPUTextureView;
}

export interface TemporalInputs {
  readonly hdr: GPUTextureView;
  readonly motion: GPUTextureView;
}
