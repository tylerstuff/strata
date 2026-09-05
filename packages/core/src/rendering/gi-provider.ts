import type { CameraFrame } from './raster-math.js';
import type { RasterControls, RasterOutputs, RasterTimestamps } from './raster-types.js';

/** GI ownership stays separate from geometry and from screen temporal history. */
export interface RasterGiProvider {
  readonly active: boolean;
  readonly gpuBufferBytes: number;
  readonly gpuTextureBytes: number;
  readonly initialUploadBytes: number;
  prepare(encoder: GPUCommandEncoder, camera: CameraFrame, width: number, height: number,
    timeSeconds: number, timestamps: RasterTimestamps): { dispatchCalls: number; uploadBytes: number };
  compose(encoder: GPUCommandEncoder, outputs: RasterOutputs, camera: CameraFrame, width: number, height: number,
    timeSeconds: number, controls: RasterControls, timestamps: RasterTimestamps): {
      view: GPUTextureView; dispatchCalls: number; uploadBytes: number;
    };
  dispose(): void;
}
