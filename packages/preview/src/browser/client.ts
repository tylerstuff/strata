// Browser-only entry point: imports Core and receives immutable runtime data.
import { createEngine, SceneCommitError, validateAuthoredBoxScene } from '@strata-engine/core';
import type { BoxSceneDescriptor, Engine, FrameMetrics, GpuTiming, RenderOptions } from '@strata-engine/core';
import type { AuthoredPreviewView } from '../adapter.js';

interface Request { id: string; method: string; data: unknown }
interface ErrorData {
  code: string; message: string; stage?: string; commitOccurred?: true;
  committedScene?: SceneCommitError['committedScene'];
}

let engine: Engine | null = null;
let scene: BoxSceneDescriptor | null = null;
const canvas = document.querySelector<HTMLCanvasElement>('#preview')!;
const requests = new Map<string, AbortController>();
const canceledBeforeAdmission = new Set<string>();
let disposed = false;
const gpuSamples: GpuTiming[] = [];
let timingFailure: string | null = null;

function abort(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error('Browser request was canceled.'), { code: 'PREVIEW_ABORTED' });
}

function runtime(): Engine {
  if (!engine) throw Object.assign(new Error('Preview runtime is not initialized.'), { code: 'PREVIEW_NOT_READY' });
  return engine;
}

function serializeError(error: unknown): ErrorData {
  const value: ErrorData = {
    code: error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'PREVIEW_BROWSER_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
  if (error instanceof SceneCommitError) {
    value.stage = error.stage;
    value.commitOccurred = true;
    value.committedScene = error.committedScene;
  }
  return value;
}

async function dispatch(method: string, data: unknown, signal: AbortSignal): Promise<unknown> {
  abort(signal);
  if (method === 'initialize') {
    const options = data as { width: number; height: number; timeoutMs: number };
    if (engine) throw new Error('Preview runtime is already initialized.');
    canvas.width = options.width;
    canvas.height = options.height;
    canvas.style.width = `${options.width}px`;
    canvas.style.height = `${options.height}px`;
    const candidate = await createEngine({ canvas, signal, initializationTimeoutMs: options.timeoutMs, profiling: true });
    if (signal.aborted || disposed) {
      candidate.dispose();
      throw Object.assign(new Error('Preview initialization was canceled before ownership transfer.'), { code: 'PREVIEW_ABORTED' });
    }
    engine = candidate;
    return null;
  }
  if (method === 'dispose') {
    dispose();
    return null;
  }
  const current = runtime();
  if (method === 'observe') {
    const telemetry = current.getTelemetry();
    gpuSamples.push(...current.drainGpuTimings());
    const minimumFrame = Math.max(0, telemetry.submittedFrames - 64);
    while (gpuSamples.length > 4096 || (gpuSamples[0]?.frameId ?? Infinity) < minimumFrame) gpuSamples.shift();
    return {
      status: current.state === 'ready' && telemetry.gpuErrorCount > 0 ? 'failed' : current.state,
      commit: telemetry.scene.identity, width: canvas.width, height: canvas.height,
      lastSubmittedFrameId: telemetry.scene.lastSubmittedFrameId, telemetry,
      environment: { engine: current.info },
      gpuSamples: gpuSamples.map(sample => ({ frameId: sample.frameId, sample })),
      ...(timingFailure !== null ? { gpuTimingUnavailableReason: timingFailure }
        : !current.info.profiling.gpuTimestampAvailable ? { gpuTimingUnavailableReason: current.info.profiling.reason }
          : telemetry.pendingGpuSamples > 0 || telemetry.droppedGpuSamples > 0
            ? { gpuTimingUnavailableReason: 'GPU timing readbacks are pending or samples were dropped; available samples retain their own frame IDs.' } : {}),
    };
  }
  if (method === 'load') {
    const snapshot = validateAuthoredBoxScene(data);
    try {
      const receipt = await current.setScene({ renderer: 'authored-boxes', scene: snapshot, signal });
      scene = snapshot;
      return receipt;
    } catch (error) {
      if (error instanceof SceneCommitError) scene = snapshot;
      throw error;
    }
  }
  if (method === 'resize') {
    const size = data as { width: number; height: number };
    current.resize(size.width, size.height);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    return null;
  }
  if (method === 'render') {
    const view = data as AuthoredPreviewView;
    const options: RenderOptions = { camera: view.camera, debugView: view.debugView, timeSeconds: view.timeSeconds, temporal: false };
    const metrics: FrameMetrics = current.render(options);
    if (!metrics.authored || !scene) throw new Error('Authored submission metadata is missing.');
    return {
      commit: metrics.scene, frameId: metrics.frameId,
      width: metrics.authored.width, height: metrics.authored.height,
      resolvedView: {
        // Submission history changes each frame while the rendered view remains
        // fixed. Preserve that history in metrics, outside the view revision.
        camera: metrics.authored.camera, origin: metrics.authored.origin, aspect: metrics.authored.aspect,
        width: metrics.authored.width, height: metrics.authored.height,
        debugView: metrics.authored.debugView, timeSeconds: metrics.authored.timeSeconds,
        light: scene.light, background: scene.background,
        renderer: 'authored-boxes', sceneFormatVersion: scene.version, temporal: false,
      },
      metrics,
    };
  }
  if (method === 'fence') {
    await current.waitForIdle();
    abort(signal);
    try { await current.flushGpuTimings(1000); }
    catch (error) { timingFailure = `GPU timing readback unavailable: ${error instanceof Error ? error.message : String(error)}`; }
    abort(signal);
    return null;
  }
  throw new Error('Unknown preview browser method.');
}

const bridge = {
  async request(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; error: ErrorData }> {
    if (disposed) return { ok: false, error: { code: 'PREVIEW_DISPOSED', message: 'Preview browser was disposed.' } };
    if (requests.has(request.id)) return { ok: false, error: { code: 'PREVIEW_BUSY', message: 'Duplicate browser request.' } };
    const controller = new AbortController();
    requests.set(request.id, controller);
    if (canceledBeforeAdmission.delete(request.id)) controller.abort();
    try { return { ok: true, value: await dispatch(request.method, request.data, controller.signal) }; }
    catch (error) { return { ok: false, error: serializeError(error) }; }
    finally { requests.delete(request.id); }
  },
  cancel(id: string): void {
    const active = requests.get(id);
    if (active) active.abort();
    else if (!disposed) {
      canceledBeforeAdmission.add(id);
      if (canceledBeforeAdmission.size > 256) canceledBeforeAdmission.delete(canceledBeforeAdmission.values().next().value!);
    }
  },
  dispose,
};

function dispose(): void {
  disposed = true;
  canceledBeforeAdmission.clear();
  for (const controller of requests.values()) controller.abort();
  engine?.dispose();
}

Object.assign(globalThis, { __strataPreview: bridge });
