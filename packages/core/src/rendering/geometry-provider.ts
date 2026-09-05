import type { CameraFrame } from './raster-math.js';
import type { RasterControls } from './raster-types.js';

/** Internal geometry boundary: lighting, intermediate targets, and temporal ownership stay in RasterRenderer. */
export interface RasterGeometryProvider {
  readonly shaderSource: string;
  readonly vertexEntryPoint: string;
  readonly shadowEntryPoint: string;
  readonly fragmentEntryPoint?: string;
  readonly usesMaterialTextures?: boolean;
  readonly halfExtent: number;
  readonly selectionPass: boolean;
  readonly vertexBuffers?: GPUVertexBufferLayout[];
  readonly lightMatrix: Float32Array<ArrayBuffer>;
  readonly gpuBufferBytes: number;
  readonly initialUploadBytes: number;
  camera(width: number, height: number, time: number, jitter: readonly [number, number]): CameraFrame;
  attachPipelines(raster: GPURenderPipeline, shadow: GPURenderPipeline): void;
  prepare(encoder: GPUCommandEncoder, camera: CameraFrame, width: number, height: number,
    reset: boolean, controls: RasterControls, timestampWrites?: GPUComputePassTimestampWrites): {
      dispatchCalls: number; uploadBytes: number; triangles: number; drawCalls?: number;
    };
  draw(pass: GPURenderPassEncoder, phase: 'raster' | 'shadow'): void;
  dispose(): void;
}
