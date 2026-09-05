import type { GeometryMode, GeometryTelemetry, RasterControls } from '@strata-engine/core';

export interface Distribution {
  count: number;
  min: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

/** Nearest-rank percentiles. Empty measurements stay null, never a fabricated zero. */
export function distribution(values: readonly number[]): Distribution {
  if (values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new RangeError('Timing values must be finite and nonnegative.');
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, min: null, mean: null, p50: null, p95: null, p99: null, max: null };
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
  return {
    count: sorted.length,
    min: sorted[0]!,
    mean: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted[sorted.length - 1]!,
  };
}

export interface FrameSample {
  frameId: number;
  elapsedMs: number;
  frameIntervalMs: number;
  cpuSubmissionMs: number;
  gpuMs: number | null;
  gpuPasses?: Record<string, number>;
  drawCalls: number;
  dispatchCalls: number;
  triangles: number;
  triangleCountSourceFrameId?: number | null;
  geometry?: GeometryTelemetry;
  uploadBytes: number;
  allocatedGpuBufferBytes: number;
  allocatedGpuTextureBytes: number;
}

export function summarizeFrames(frames: readonly FrameSample[]) {
  const frameIntervalMs = distribution(frames.map(frame => frame.frameIntervalMs));
  return {
    frameIntervalMs,
    cpuSubmissionMs: distribution(frames.map(frame => frame.cpuSubmissionMs)),
    gpuPassMs: distribution(frames.flatMap(frame => frame.gpuMs === null ? [] : [frame.gpuMs])),
    meanCallbackCadenceFps: frameIntervalMs.mean ? 1000 / frameIntervalMs.mean : null,
    framesAbove20Ms: frames.filter(frame => frame.frameIntervalMs > 20).length,
    targetFrameIntervalMs: 1000 / 60,
    drawCalls: frames.reduce((total, frame) => total + frame.drawCalls, 0),
    dispatchCalls: frames.reduce((total, frame) => total + frame.dispatchCalls, 0),
    uploadBytes: frames.reduce((total, frame) => total + frame.uploadBytes, 0),
    maxTrackedGpuBufferBytes: frames.reduce((max, frame) => Math.max(max, frame.allocatedGpuBufferBytes), 0),
    maxTrackedGpuTextureBytes: frames.reduce((max, frame) => Math.max(max, frame.allocatedGpuTextureBytes), 0),
  };
}

export interface BenchmarkOptions {
  width: number;
  height: number;
  warmupSeconds: number;
  durationSeconds: number;
  seed: number;
  instanceCount: number;
  renderer: 'diffuse' | 'raster' | 'virtual';
  temporal: boolean;
  debugView: NonNullable<RasterControls['debugView']>;
  manifestUrl?: string;
  geometryMode: GeometryMode;
  poolBytes: number;
  pixelError: number;
  pageLoadDelayMs: number;
  cameraMode: 'tour' | 'coverage';
  mode: 'performance' | 'sustained' | 'smoke';
  metadata: Record<string, unknown>;
}

export function normalizeOptions(input: Partial<BenchmarkOptions> = {}): BenchmarkOptions {
  const result: BenchmarkOptions = {
    width: input.width ?? 1280,
    height: input.height ?? 720,
    warmupSeconds: input.warmupSeconds ?? 30,
    durationSeconds: input.durationSeconds ?? 60,
    seed: input.seed ?? 1337,
    instanceCount: input.instanceCount ?? 512,
    renderer: input.renderer ?? 'diffuse',
    temporal: input.temporal ?? true,
    debugView: input.debugView ?? 'final',
    ...(input.manifestUrl === undefined ? {} : { manifestUrl: input.manifestUrl }),
    geometryMode: input.geometryMode ?? 'streamed',
    poolBytes: input.poolBytes ?? 8 * 1024 * 1024,
    pixelError: input.pixelError ?? 2,
    pageLoadDelayMs: input.pageLoadDelayMs ?? 0,
    cameraMode: input.cameraMode ?? 'tour',
    mode: input.mode ?? 'performance',
    metadata: input.metadata ?? {},
  };
  if (![[1280, 720], [1920, 1080]].some(([width, height]) => result.width === width && result.height === height)) {
    throw new RangeError('The comparable benchmark resolutions are 1280×720 and 1920×1080.');
  }
  if (!Number.isFinite(result.warmupSeconds) || result.warmupSeconds < 0 || result.warmupSeconds > 600
    || !Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0 || result.durationSeconds > 1800) {
    throw new RangeError('Warm-up must be 0–600 seconds and capture must be 0–1800 seconds (exclusive of zero).');
  }
  if (!Number.isInteger(result.seed) || result.seed < 0 || result.seed > 0xffff_ffff
    || !Number.isInteger(result.instanceCount) || result.instanceCount < 1 || result.instanceCount > 16_384) {
    throw new RangeError('Use a uint32 seed and 1–16384 instances.');
  }
  if (!['performance', 'sustained', 'smoke'].includes(result.mode)) throw new RangeError('Unknown benchmark mode.');
  if (!['diffuse', 'raster', 'virtual'].includes(result.renderer) || typeof result.temporal !== 'boolean'
    || !['final', 'direct', 'shadow', 'depth', 'normal', 'motion', 'material', 'clusters', 'lod', 'residency', 'coverage'].includes(result.debugView)) {
    throw new RangeError('Unknown renderer, temporal setting, or debug view.');
  }
  if (result.renderer === 'diffuse' && result.debugView !== 'final') throw new RangeError('Debug views require the raster renderer.');
  if (result.renderer === 'virtual') {
    if (!result.manifestUrl || typeof result.manifestUrl !== 'string') throw new RangeError('Virtual geometry requires manifestUrl.');
    if (!['streamed', 'resident-lod', 'resident-full', 'mesh-lod'].includes(result.geometryMode)
      || !['tour', 'coverage'].includes(result.cameraMode)) throw new RangeError('Unknown geometry mode or camera.');
    if (!Number.isSafeInteger(result.poolBytes) || result.poolBytes < 65536
      || !Number.isFinite(result.pixelError) || result.pixelError <= 0 || result.pixelError > 1000
      || !Number.isFinite(result.pageLoadDelayMs) || result.pageLoadDelayMs < 0 || result.pageLoadDelayMs > 60000) {
      throw new RangeError('Use a positive geometry pool/error and a bounded page delay.');
    }
  }
  return result;
}
