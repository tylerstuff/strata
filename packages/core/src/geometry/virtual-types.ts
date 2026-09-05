/** Restricted static terrain proof; all modes consume the same cooked asset. */
export type GeometryMode = 'streamed' | 'resident-lod' | 'resident-full' | 'mesh-lod';

export interface VirtualSceneOptions {
  renderer: 'virtual';
  manifestUrl: string | URL;
  geometryMode?: GeometryMode;
  /** Fixed page-pool bytes INCLUDING pinned coarse pages. Streamed default: 8 MiB. */
  poolBytes?: number;
  pixelError?: number;
  pageLoadDelayMs?: number;
  maxConcurrentRequests?: number;
  uploadBudgetBytes?: number;
  cameraMode?: 'tour' | 'coverage';
  /** Cancel scene creation; disposal controls the loaded scene's later lifetime. */
  signal?: AbortSignal;
}

/** GPU-derived values describe sourceFrameId, not necessarily the current submission. */
export interface GeometryTelemetry {
  readonly sourceFrameId: number | null;
  readonly [name: string]: number | string | boolean | null;
}
