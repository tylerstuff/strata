export type { ProceduralSceneOptions } from './rendering/scene-renderer.js';
import type { ProceduralSceneOptions } from './rendering/scene-renderer.js';

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
  /** Collect asynchronous GPU timestamps when supported. Defaults to false. */
  profiling?: boolean;
}

export type EngineState = 'ready' | 'lost' | 'disposed';

/** Immutable startup information; memoryBytes is the WASM startup allocation. */
export interface EngineInfo {
  readonly format: GPUTextureFormat;
  readonly features: readonly string[];
  readonly maxTextureDimension2D: number;
  readonly adapter: {
    readonly vendor: string;
    readonly architecture: string;
    readonly device: string;
    readonly description: string;
    readonly isFallbackAdapter: boolean | null;
  };
  readonly adapterFeatures: readonly string[];
  readonly adapterLimits: Readonly<Record<string, number>>;
  readonly deviceLimits: Readonly<Record<string, number>>;
  readonly profiling: {
    readonly enabled: boolean;
    readonly gpuTimestampAvailable: boolean;
    readonly reason: 'disabled' | 'available' | 'timestamp-query-unavailable' | 'timestamp-query-device-request-failed';
    readonly timestampPrecision: 'browser-dependent';
  };
  readonly cpu: {
    readonly abiVersion: number;
    readonly memoryBytes: number;
  };
}

/** Work submitted by Strata, not total browser/device memory or presented FPS. */
export interface FrameMetrics {
  readonly frameId: number;
  readonly cpuSubmissionMs: number;
  readonly drawCalls: number;
  readonly dispatchCalls: number;
  readonly triangles: number;
  readonly uploadBytes: number;
  readonly allocatedGpuBufferBytes: number;
  /** Texture payload estimates exclude canvas/driver allocations and alignment. */
  readonly allocatedGpuTextureBytes: number;
  readonly wasmMemoryBytes: number;
}

export interface GpuTiming {
  readonly frameId: number;
  readonly pass: string;
  /** Nanosecond timestamp difference converted to milliseconds, possibly quantized to zero. */
  readonly gpuMs: number;
}

export interface EngineTelemetry {
  readonly submittedFrames: number;
  readonly totalUploadBytes: number;
  readonly allocatedGpuBufferBytes: number;
  readonly allocatedGpuTextureBytes: number;
  readonly wasmMemoryBytes: number;
  readonly pendingGpuSamples: number;
  /** Includes full-ring skips, failed readbacks, and unread queue overflow. */
  readonly droppedGpuSamples: number;
  readonly gpuErrorCount: number;
  /** Most recent uncaptured GPU error, capped at 2048 characters. */
  readonly lastGpuError: string | null;
}

export interface Engine {
  readonly state: EngineState;
  readonly info: EngineInfo;
  /** Set drawing-buffer dimensions in physical pixels, leaving CSS size unchanged. */
  resize(width: number, height: number): void;
  /** Replace the deterministic benchmark scene, or return to the clear-only baseline. */
  setScene(options: ProceduralSceneOptions | null): Promise<void>;
  /** Submit a frame; the host owns scheduling. timeSeconds is deterministic scene time. */
  render(options?: { timeSeconds?: number }): FrameMetrics;
  getTelemetry(): EngineTelemetry;
  /** Consume available results without waiting for the GPU. The queue is bounded. */
  drainGpuTimings(): GpuTiming[];
  /** Wait for timestamp readbacks after capture, bounded by timeoutMs (default 5000). */
  flushGpuTimings(timeoutMs?: number): Promise<void>;
  /** Release GPU/worker resources and canvas ownership. Safe to call repeatedly. */
  dispose(): void;
}
