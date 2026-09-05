export type { ProceduralSceneOptions } from './rendering/scene-renderer.js';
import type { ProceduralSceneOptions } from './rendering/scene-renderer.js';
export type { RasterControls } from './rendering/raster-types.js';
import type { RasterControls } from './rendering/raster-types.js';
export type { VirtualSceneOptions, GeometryTelemetry, GeometryMode } from './geometry/virtual-types.js';
import type { VirtualSceneOptions, GeometryTelemetry } from './geometry/virtual-types.js';
export type { GiSceneOptions, GiControls, GiTelemetry } from './gi/gi-types.js';
import type { GiSceneOptions, GiControls, GiTelemetry } from './gi/gi-types.js';

export type { ReflectionSceneOptions, ReflectionControls, ReflectionTelemetry, ReflectionMode } from './reflections/reflection-types.js';
import type { ReflectionSceneOptions, ReflectionControls, ReflectionTelemetry } from './reflections/reflection-types.js';

export type { IntegratedSceneOptions, IntegratedTelemetry, IntegratedCameraMode } from './integrated/integrated-types.js';
import type { IntegratedSceneOptions, IntegratedTelemetry } from './integrated/integrated-types.js';

export type { ImportedAsset, ImportedSceneOptions, ImportedControls, ImportedTelemetry, ImportedBounds, ImportedAnimationClip } from './imported/imported-types.js';
import type { ImportedSceneOptions, ImportedControls, ImportedTelemetry } from './imported/imported-types.js';

export type SceneOptions = ProceduralSceneOptions | VirtualSceneOptions | GiSceneOptions | ReflectionSceneOptions | IntegratedSceneOptions | ImportedSceneOptions;

export interface RenderOptions extends RasterControls {
  /** Deterministic scene time, independent of wall-clock scheduling. */
  timeSeconds?: number;
  gi?: GiControls;
  reflections?: ReflectionControls;
  imported?: ImportedControls;
}

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
  /** Virtual geometry counts are delayed; this identifies their GPU feedback frame. */
  readonly triangleCountSourceFrameId?: number | null;
  readonly geometry?: GeometryTelemetry;
  readonly gi?: GiTelemetry;
  readonly reflections?: ReflectionTelemetry;
  readonly integrated?: IntegratedTelemetry;
  readonly imported?: ImportedTelemetry;
  readonly uploadBytes: number;
  readonly allocatedGpuBufferBytes: number;
  /** Texture payload estimates exclude canvas/driver allocations and alignment. */
  readonly allocatedGpuTextureBytes: number;
  readonly wasmMemoryBytes: number;
}

export interface GpuTiming {
  readonly frameId: number;
  readonly pass: string;
  /** One named pass duration, excluding between-pass gaps and display scanout; may be quantized to zero. */
  readonly gpuMs: number;
  /** Pass boundaries relative to the earliest recorded boundary in this frame; passes may overlap. */
  readonly startOffsetMs?: number;
  readonly endOffsetMs?: number;
}

export interface EngineTelemetry {
  readonly submittedFrames: number;
  readonly totalUploadBytes: number;
  readonly allocatedGpuBufferBytes: number;
  readonly allocatedGpuTextureBytes: number;
  readonly wasmMemoryBytes: number;
  /** Pending individual pass samples, not frames. */
  readonly pendingGpuSamples: number;
  /** Dropped individual pass samples from full rings, failed readbacks, or unread queue overflow. */
  readonly droppedGpuSamples: number;
  readonly gpuErrorCount: number;
  /** Most recent uncaptured GPU error, capped at 2048 characters. */
  readonly lastGpuError: string | null;
  readonly geometry?: GeometryTelemetry;
  readonly gi?: GiTelemetry;
  readonly reflections?: ReflectionTelemetry;
  readonly integrated?: IntegratedTelemetry;
  readonly imported?: ImportedTelemetry;
}

export interface Engine {
  readonly state: EngineState;
  readonly info: EngineInfo;
  /** Set drawing-buffer dimensions in physical pixels, leaving CSS size unchanged. */
  resize(width: number, height: number): void;
  /** Replace the deterministic benchmark scene, or return to the clear-only baseline. */
  setScene(options: SceneOptions | null): Promise<void>;
  /** Submit a frame; the host owns scheduling. timeSeconds is deterministic scene time. */
  render(options?: RenderOptions): FrameMetrics;
  getTelemetry(): EngineTelemetry;
  /** Consume available results without waiting for the GPU. The queue is bounded. */
  drainGpuTimings(): GpuTiming[];
  /** Wait for timestamp readbacks after capture, bounded by timeoutMs (default 5000). */
  flushGpuTimings(timeoutMs?: number): Promise<void>;
  /** Fence GPU work submitted before this call, even without profiling. No presentation guarantee. Default timeout: 5000 ms. */
  waitForIdle(timeoutMs?: number): Promise<void>;
  /** Release GPU/worker resources and canvas ownership. Safe to call repeatedly. */
  dispose(): void;
}
