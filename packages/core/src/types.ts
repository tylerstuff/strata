export interface CreateEngineOptions {
  /** A dedicated HTML canvas. One live engine may own it at a time. */
  canvas: HTMLCanvasElement;
  powerPreference?: GPUPowerPreference;
  /** Initialization fails if any requested WebGPU feature is unavailable. */
  requiredFeatures?: readonly GPUFeatureName[];
  /** WebGPU device requirements, validated against the selected adapter. */
  requiredLimits?: Readonly<Record<string, number>>;
  /** Override the packaged WASM location, for example when serving from a CDN. */
  wasmUrl?: string | URL;
  /** Override the packaged module worker location. */
  workerUrl?: string | URL;
  /** Cancels initialization only; use dispose() after initialization completes. */
  signal?: AbortSignal;
  /** Total initialization deadline in milliseconds. Defaults to 30,000. */
  initializationTimeoutMs?: number;
}

export type EngineState = 'ready' | 'lost' | 'disposed';

/** Immutable startup information; memoryBytes is the WASM startup allocation. */
export interface EngineInfo {
  readonly format: GPUTextureFormat;
  readonly features: readonly string[];
  readonly maxTextureDimension2D: number;
  readonly cpu: {
    readonly abiVersion: number;
    readonly memoryBytes: number;
  };
}

export interface Engine {
  readonly state: EngineState;
  readonly info: EngineInfo;
  /** Set drawing-buffer dimensions in physical pixels, leaving CSS size unchanged. */
  resize(width: number, height: number): void;
  /** Submit one clear pass. The host application owns animation scheduling. */
  render(): void;
  /** Release GPU/worker resources and canvas ownership. Safe to call repeatedly. */
  dispose(): void;
}
