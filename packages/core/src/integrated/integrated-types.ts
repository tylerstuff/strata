import type { VirtualSceneOptions } from '../geometry/virtual-types.js';
import type { ReflectionSceneOptions } from '../reflections/reflection-types.js';

export type IntegratedCameraMode = 'tour' | 'receiver' | 'overview' | 'terrain-witness';
/** Restricted courtyard feasibility fixture, with an explicit persistent tracing proxy. */
export interface IntegratedSceneOptions extends Omit<VirtualSceneOptions, 'renderer' | 'cameraMode'>,
  Omit<ReflectionSceneOptions, 'renderer' | 'cameraMode'> {
  renderer: 'integrated';
  traceProxyUrl: string | URL;
  cameraMode?: IntegratedCameraMode;
  /** Matched flat albedo for raster terrain and its tracing proxy. */
  terrainColor?: 'green' | 'neutral';
}
export interface IntegratedTelemetry {
  readonly [name: string]: number | string | boolean | null;
}
