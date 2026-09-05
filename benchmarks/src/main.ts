import { createEngine, type Engine } from '@strata-engine/core';
import { normalizeOptions, summarizeFrames, type BenchmarkOptions, type FrameSample } from './metrics.js';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const status = document.querySelector<HTMLOutputElement>('output')!;
const startButton = document.querySelector<HTMLButtonElement>('#start')!;
const downloadButton = document.querySelector<HTMLButtonElement>('#download')!;
let engine: Engine | undefined;
let running = false;
let lastResult: unknown;

async function nextFrame(): Promise<number> {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

async function run(input: Partial<BenchmarkOptions> = {}) {
  if (running) throw new Error('A benchmark is already running.');
  const options = normalizeOptions(input);
  if (document.visibilityState !== 'visible') throw new Error('Keep the benchmark tab visible during measurement.');
  running = true;
  startButton.disabled = true;
  downloadButton.disabled = true;
  const visibilityChanges: Array<{ atMs: number; state: string }> = [];
  const visibilityListener = () => visibilityChanges.push({ atMs: performance.now(), state: document.visibilityState });
  document.addEventListener('visibilitychange', visibilityListener);
  const startedAt = new Date().toISOString();
  try {
    engine?.dispose();
    engine = undefined;
    canvas.width = options.width;
    canvas.height = options.height;
    status.textContent = 'Preparing the runtime and compiling the scene…';
    const coldStart = performance.now();
    engine = await createEngine({ canvas, profiling: true, powerPreference: 'high-performance' });
    const initializedAt = performance.now();
    await engine.setScene({ seed: options.seed, instanceCount: options.instanceCount });
    const compiledAt = performance.now();
    if (engine.info.adapter.isFallbackAdapter && options.mode !== 'smoke') {
      throw new Error('A software/fallback adapter is only valid for smoke tests, not performance reports.');
    }
    const initialTelemetry = engine.getTelemetry();
    const frames: FrameSample[] = [];
    const samplesById = new Map<number, FrameSample>();
    let captureStart = 0;
    let captureEnd = 0;
    let lastTimestamp = 0;
    let measuredStartTelemetry = initialTelemetry;
    let measuring = false;
    let phaseStart = 0;
    let lastHudUpdate = 0;
    let raf: number | undefined;
    let pendingFrame: FrameSample | undefined;
    const capturedTimings = new Map<string, number[]>();
    const collectGpu = () => {
      for (const timing of engine!.drainGpuTimings()) {
        const sample = samplesById.get(timing.frameId);
        if (!sample) continue;
        sample.gpuMs = (sample.gpuMs ?? 0) + timing.gpuMs;
        const values = capturedTimings.get(timing.pass) ?? [];
        values.push(timing.gpuMs);
        capturedTimings.set(timing.pass, values);
      }
    };

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (raf !== undefined) cancelAnimationFrame(raf);
        reject(new Error('The browser stopped delivering frames; capture was cancelled.'));
      }, (options.warmupSeconds + options.durationSeconds + 30) * 1000);
      const frame = (timestamp: number) => {
        try {
          if (document.visibilityState !== 'visible') throw new Error('The benchmark tab became hidden. Repeat the capture in a visible tab.');
          if (!phaseStart) phaseStart = timestamp;
          // Pair each submission with the following RAF interval, including the
          // terminal callback. This is callback cadence, not a presentation fence.
          if (pendingFrame) {
            pendingFrame.frameIntervalMs = timestamp - lastTimestamp;
            frames.push(pendingFrame);
            pendingFrame = undefined;
          }
          if (!measuring && timestamp - phaseStart >= options.warmupSeconds * 1000) {
            measuring = true;
            captureStart = timestamp;
            lastTimestamp = timestamp;
            measuredStartTelemetry = engine!.getTelemetry();
            // Warm-up camera work is excluded; every measured run starts at t=0.
            engine!.drainGpuTimings();
          }
          if (measuring && timestamp - captureStart >= options.durationSeconds * 1000) {
            captureEnd = timestamp;
            clearTimeout(timeout);
            resolve();
            return;
          }
          const timeSeconds = (timestamp - (measuring ? captureStart : phaseStart)) / 1000;
          const metrics = engine!.render({ timeSeconds });
          if (measuring) {
            const sample: FrameSample = {
              frameId: metrics.frameId,
              elapsedMs: timestamp - captureStart,
              frameIntervalMs: 0,
              cpuSubmissionMs: metrics.cpuSubmissionMs,
              gpuMs: null,
              drawCalls: metrics.drawCalls,
              dispatchCalls: metrics.dispatchCalls,
              triangles: metrics.triangles,
              uploadBytes: metrics.uploadBytes,
              allocatedGpuBufferBytes: metrics.allocatedGpuBufferBytes,
              allocatedGpuTextureBytes: metrics.allocatedGpuTextureBytes,
            };
            pendingFrame = sample;
            samplesById.set(sample.frameId, sample);
          }
          lastTimestamp = timestamp;
          collectGpu();
          if (timestamp - lastHudUpdate >= 1000) {
            const elapsed = (timestamp - (measuring ? captureStart : phaseStart)) / 1000;
            status.textContent = `${measuring ? 'Capturing' : 'Warming up'} ${options.width} × ${options.height} · ${elapsed.toFixed(0)} / ${measuring ? options.durationSeconds : options.warmupSeconds}s · ${frames.length} measured frames`;
            lastHudUpdate = timestamp;
          }
          raf = requestAnimationFrame(frame);
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      };
      raf = requestAnimationFrame(frame);
    });
    // Readback is drained after timing, never awaited in the frame loop.
    await engine.flushGpuTimings();
    collectGpu();
    const finalTelemetry = engine.getTelemetry();
    const summary = summarizeFrames(frames);
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const result = {
      schemaVersion: 1,
      startedAt,
      completedAt: new Date().toISOString(),
      mode: options.mode,
      workload: { id: 'procedural-boxes-v1', seed: options.seed, instanceCount: options.instanceCount, cameraPath: 'orbit-20s-v1', renderPath: 'diffuse-raster-v1', externalAssetsUsed: false },
      resolution: { width: options.width, height: options.height, devicePixelRatio, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, screenWidth: screen.width, screenHeight: screen.height },
      capture: { warmupSeconds: options.warmupSeconds, requestedDurationSeconds: options.durationSeconds, actualDurationMs: captureEnd - captureStart, frameCount: frames.length, visibilityChanges },
      browser: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, crossOriginIsolated, secureContext: isSecureContext },
      adapter: engine.info.adapter,
      capabilities: { adapterFeatures: engine.info.adapterFeatures, adapterLimits: engine.info.adapterLimits, deviceLimits: engine.info.deviceLimits },
      profiling: { ...engine.info.profiling, capturedGpuSamples: summary.gpuPassMs.count, droppedGpuSamples: finalTelemetry.droppedGpuSamples - measuredStartTelemetry.droppedGpuSamples, pendingGpuSamples: finalTelemetry.pendingGpuSamples },
      coldStart: { initializeMs: initializedAt - coldStart, sceneSetupMs: compiledAt - initializedAt, uploadBytes: initialTelemetry.totalUploadBytes },
      assetTraffic: { externalAssetsUsed: false, steadyUploadBytes: finalTelemetry.totalUploadBytes - measuredStartTelemetry.totalUploadBytes, documentResourceTransferBytes: entries.reduce((sum, entry) => sum + entry.transferSize, 0), documentResourceDecodedBytes: entries.reduce((sum, entry) => sum + entry.decodedBodySize, 0), note: 'Document resource totals include engine/app loading, exclude worker-internal fetch timing, and may contain cache/cross-origin zero values. They are not model-streaming traffic.' },
      allocations: { ...finalTelemetry, note: 'Explicit app-owned GPU buffers/textures and WASM linear memory. Excludes swapchain, driver allocation, browser memory, and JavaScript heap.' },
      summary,
      gpuPasses: Object.fromEntries([...capturedTimings].map(([name, values]) => [name, { sampleCount: values.length, totalMs: values.reduce((sum, value) => sum + value, 0) }])),
      metadata: options.metadata,
      limitations: [
        'RAF intervals measure browser callback cadence, not scan-out or uncapped GPU throughput.',
        'GPU pass timestamps exclude presentation and may be quantized by the browser.',
        'This small diffuse scene establishes a baseline; it does not validate the final 60 FPS graphics goal.',
        'No Sketchfab models are loaded, copied, or uploaded by this procedural run.',
      ],
      frames,
    };
    lastResult = result;
    downloadButton.disabled = false;
    status.textContent = `Complete · ${summary.meanCallbackCadenceFps?.toFixed(1) ?? 'unavailable'} callback FPS · p95 ${summary.frameIntervalMs.p95?.toFixed(2) ?? 'unavailable'} ms · GPU p95 ${summary.gpuPassMs.p95?.toFixed(3) ?? 'unavailable'} ms`;
    return result;
  } catch (error) {
    engine?.dispose();
    engine = undefined;
    throw error;
  } finally {
    running = false;
    startButton.disabled = false;
    document.removeEventListener('visibilitychange', visibilityListener);
  }
}

async function capture(timeSeconds = 0) {
  if (running || !engine) throw new Error('Capture imagery only after a benchmark completes.');
  engine.render({ timeSeconds });
  await nextFrame();
  engine.render({ timeSeconds });
  await nextFrame();
}

declare global {
  interface Window {
    strataBenchmark: { ready: boolean; run: typeof run; capture: typeof capture; dispose(): void };
  }
}
window.strataBenchmark = { ready: true, run, capture, dispose: () => engine?.dispose() };
startButton.addEventListener('click', () => {
  const resolution = document.querySelector<HTMLSelectElement>('#resolution')!.value;
  const [width, height] = resolution.split('x').map(Number);
  void run({ width: width!, height: height! }).catch(error => { status.textContent = String(error); });
});
downloadButton.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `strata-benchmark-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});
window.addEventListener('pagehide', () => engine?.dispose());
