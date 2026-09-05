import type { CameraFrame } from './raster-math.js';
import type { RasterControls } from './raster-types.js';

/** Providers draw into one shared camera, shadow map and MRT set. At most one owns selection timestamps. */
export interface RasterGeometryGroup {
  readonly providers: readonly RasterGeometryProvider[];
  readonly halfExtent: number;
  readonly lightMatrix: Float32Array<ArrayBuffer>;
  /** Linear HDR clear color; the existing raster fixture keeps its default. */
  readonly background?: readonly [number, number, number];
  camera(width: number, height: number, time: number, jitter: readonly [number, number]): CameraFrame;
}

/** Internal geometry boundary: lighting, intermediate targets, and temporal ownership stay in RasterRenderer. */
export interface RasterGeometryProvider {
  readonly shaderSource: string;
  readonly vertexEntryPoint: string;
  readonly shadowEntryPoint: string;
  readonly shadowFragmentEntryPoint?: string;
  readonly cullMode?: GPUCullMode;
  readonly fragmentEntryPoint?: string;
  readonly usesMaterialTextures?: boolean;
  readonly halfExtent: number;
  readonly selectionPass: boolean;
  readonly vertexBuffers?: GPUVertexBufferLayout[];
  readonly lightMatrix: Float32Array<ArrayBuffer>;
  readonly gpuBufferBytes: number;
  readonly gpuTextureBytes?: number;
  readonly background?: readonly [number, number, number];
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
