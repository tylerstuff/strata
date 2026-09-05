import { createEngine, type Engine } from '@strata-engine/core';
import { distribution, normalizeOptions, summarizeFrames, type BenchmarkOptions, type FrameSample } from './metrics.js';
import { initializeBenchmarkControls, readGiBenchmarkControls, readReflectionBenchmarkControls } from './ui-controls.js';
import { integratedScenario, integratedEvents } from './integrated-scenario.js';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const status = document.querySelector<HTMLOutputElement>('output')!;
const startButton = document.querySelector<HTMLButtonElement>('#start')!;
const downloadButton = document.querySelector<HTMLButtonElement>('#download')!;
initializeBenchmarkControls();
let engine: Engine | undefined;
let running = false;
let lastResult: unknown;
let lastOptions: BenchmarkOptions | undefined;

async function nextFrame(): Promise<number> {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

async function run(input: Partial<BenchmarkOptions> = {}) {
  if (running) throw new Error('A benchmark is already running.');
  const options = normalizeOptions(input);
  const integrated = options.renderer === 'integrated';
  const reflections = options.renderer === 'reflections' || integrated;
  const lighting = options.renderer === 'gi' || reflections;
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
    await engine.setScene(options.renderer === 'virtual' ? {
      renderer: 'virtual', manifestUrl: options.manifestUrl!, geometryMode: options.geometryMode,
      residencyPolicy: options.residencyPolicy,
      poolBytes: options.poolBytes, pixelError: options.pixelError,
      pageLoadDelayMs: options.pageLoadDelayMs, cameraMode: options.cameraMode as 'tour' | 'coverage',
    } : integrated ? {
      renderer: 'integrated', manifestUrl: options.manifestUrl!, traceProxyUrl: options.traceProxyUrl!,
      geometryMode: options.geometryMode, poolBytes: options.poolBytes, pixelError: options.pixelError,
      residencyPolicy: options.residencyPolicy,
      pageLoadDelayMs: options.pageLoadDelayMs, cameraMode: options.cameraMode as 'tour' | 'receiver' | 'overview' | 'terrain-witness',
      terrainColor: options.terrainColor, probesPerUpdate: options.probesPerUpdate, raysPerProbe: options.raysPerProbe,
      resolutionScale: options.reflectionResolutionScale, maxRaysPerFrame: options.reflectionMaxRays, roughness: options.reflectionRoughness,
    } : lighting ? {
      renderer: reflections ? 'reflections' : 'gi', cameraMode: options.cameraMode as 'overview' | 'receiver' | 'tour',
      probesPerUpdate: options.probesPerUpdate, raysPerProbe: options.raysPerProbe,
      ...(reflections ? { resolutionScale: options.reflectionResolutionScale, maxRaysPerFrame: options.reflectionMaxRays, roughness: options.reflectionRoughness } : {}),
    } : { seed: options.seed, instanceCount: options.instanceCount, renderer: options.renderer as 'diffuse' | 'raster' });
    const compiledAt = performance.now();
    if (engine.info.adapter.isFallbackAdapter && options.mode !== 'smoke') {
      throw new Error('A software/fallback adapter is only valid for smoke tests, not performance reports.');
    }
    const initialTelemetry = engine.getTelemetry();
    if (options.residencyPolicy === 'retain-fallback' && initialTelemetry.geometry?.residencyPolicy !== 'retain-fallback') {
      throw new Error('The requested fallback-retention policy was not activated by the runtime.');
    }
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
        sample.gpuPasses![timing.pass] = timing.gpuMs;
        if (timing.startOffsetMs !== undefined && timing.endOffsetMs !== undefined) {
          sample.gpuPassIntervals![timing.pass] = { startMs: timing.startOffsetMs, endMs: timing.endOffsetMs };
          sample.gpuSpanMs = Math.max(sample.gpuSpanMs ?? 0, timing.endOffsetMs);
        }
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
          const phase = options.giScenario === 'static' ? 0 : Math.floor(timeSeconds % 60 / 10);
          const scenario = integrated ? integratedScenario(timeSeconds) : {};
          const metrics = engine!.render({ timeSeconds, temporal: options.temporal, debugView: options.debugView,
            ...(lighting ? { gi: { enabled: options.giEnabled, ...(integrated ? scenario.gi : { doorOpen: phase !== 1, wallColor: phase === 5 ? 'neutral' as const : 'red' as const, lightIntensity: phase === 3 ? 0.2 : 1 }) } } : {}),
            ...(reflections ? { reflections: { mode: options.reflectionMode, roughness: options.reflectionRoughness, maxDistance: options.reflectionMaxDistance, updateEvery: options.reflectionUpdateEvery, ...scenario.reflections } } : {}),
          });
          if (measuring) {
            const sample: FrameSample = {
              frameId: metrics.frameId,
              elapsedMs: timestamp - captureStart,
              frameIntervalMs: 0,
              cpuSubmissionMs: metrics.cpuSubmissionMs,
              gpuMs: null,
              gpuPasses: {},
              gpuSpanMs: null,
              gpuPassIntervals: {},
              drawCalls: metrics.drawCalls,
              dispatchCalls: metrics.dispatchCalls,
              triangles: metrics.triangles,
              ...(metrics.triangleCountSourceFrameId === undefined ? {} : { triangleCountSourceFrameId: metrics.triangleCountSourceFrameId }),
              ...(metrics.geometry === undefined ? {} : { geometry: metrics.geometry }),
              ...(metrics.gi === undefined ? {} : { gi: metrics.gi }),
              ...(metrics.reflections === undefined ? {} : { reflections: metrics.reflections }),
              ...(metrics.integrated === undefined ? {} : { integrated: metrics.integrated }),
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
    await engine.flushGpuTimings(options.mode === 'smoke' ? 30_000 : undefined);
    collectGpu();
    const finalTelemetry = engine.getTelemetry();
    const summary = summarizeFrames(frames);
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const virtual = options.renderer === 'virtual' || integrated;
    const gi = lighting;
    const geometry = finalTelemetry.geometry;
    const result = {
      schemaVersion: 1,
      startedAt,
      completedAt: new Date().toISOString(),
      mode: options.mode,
      workload: {
        id: integrated ? 'integrated-streamed-courtyard-v1' : reflections ? 'selected-software-reflections-v1' : gi ? 'two-room-software-gi-v1' : virtual ? 'cooked-analytic-terrain-v1' : options.renderer === 'diffuse' ? 'procedural-boxes-v1' : 'procedural-pbr-boxes-v1',
        seed: virtual ? geometry?.sourceSeed : options.seed, instanceCount: virtual || gi ? 0 : options.instanceCount,
        cameraPath: integrated ? `integrated-${options.cameraMode}-v1` : gi ? `${reflections ? 'reflections' : 'gi'}-${options.cameraMode}-v1` : virtual ? geometry?.cameraPath : 'orbit-20s-v1',
        renderPath: integrated ? 'integrated-raster-streaming-gi-reflections-v1' : reflections ? 'world-space-selective-reflections-v1' : gi ? 'world-space-diffuse-gi-v1' : virtual ? 'virtual-pbr-shadow-temporal-v1' : options.renderer === 'diffuse' ? 'diffuse-raster-v1' : 'pbr-shadow-temporal-v1',
        renderer: options.renderer, temporal: options.renderer !== 'diffuse' && options.temporal, debugView: options.debugView,
        externalAssetsUsed: virtual, ...(virtual ? { geometryMode: options.geometryMode, residencyPolicy: geometry?.residencyPolicy ?? 'greedy', sourceTriangleCount: geometry?.sourceTriangleCount, uniqueCompiledBytes: geometry?.uniqueCompiledBytes } : {}),
        ...(gi ? { giEnabled: options.giEnabled, giScenario: options.giScenario, sourceTriangleCount: integrated ? 131228 : reflections ? 156 : 132, ...(reflections ? { reflectionMode: options.reflectionMode } : {}) } : {}),
        ...(integrated ? { terrainSourceTriangleCount: 131072, rigidSourceTriangleCount: 156, traceTriangleCount: 2204, terrainColor: options.terrainColor } : {}),
      },
      quality: options.renderer !== 'diffuse' ? {
        shadowMapSize: 2048, shadowKernel: '3x3-comparison', materialFixture: integrated ? 'shared-courtyard-lambert-metallic-v1' : reflections ? 'shared-metallic-reflector-v1' : gi ? 'shared-flat-lambertian-v1' : virtual ? 'terrain-checker-v1' : 'checker-metal-rough-v1', exposure: 1,
        temporalFilter: 'depth-qualified-bilinear-clamped-v1', temporalHistoryWeight: 0.9, jitterSequenceLength: 8,
        ...(virtual ? { geometryMode: options.geometryMode, residencyPolicy: options.residencyPolicy, poolBytes: options.poolBytes, pixelError: options.pixelError, pageLoadDelayMs: options.pageLoadDelayMs,
          shadowGeometry: 'selected-visible-lod-and-offscreen-roots', manifestUrl: options.manifestUrl } : {}),
        ...(integrated ? { traceProxyUrl: options.traceProxyUrl, terrainColor: options.terrainColor,
          representation: finalTelemetry.integrated, scenario: 'courtyard-60s-v1', dynamicResolution: false } : {}),
        ...(reflections ? { reflectionMode: options.reflectionMode, resolutionScale: options.reflectionResolutionScale, maxRaysPerFrame: options.reflectionMaxRays,
          roughness: options.reflectionRoughness, maxDistance: options.reflectionMaxDistance, updateEvery: options.reflectionUpdateEvery } : {}),
        ...(gi ? { giEnabled: options.giEnabled, probesPerUpdate: options.probesPerUpdate, raysPerProbe: options.raysPerProbe,
          traceRepresentation: 'triangle-bvh-v1', grid: [12, 4, 8], maxTraceDistance: 32, screenTracing: false,
          giScenario: options.giScenario, scenarioPeriodSeconds: 60, events: integrated ? integratedEvents : options.giScenario === 'static' ? [] : [
            { atSeconds: 10, doorOpen: false }, { atSeconds: 20, doorOpen: true }, { atSeconds: 30, lightIntensity: 0.2 },
            { atSeconds: 40, lightIntensity: 1 }, { atSeconds: 50, wallColor: 'neutral' },
          ] } : {}),
      } : { shading: 'diffuse-directional' },
      resolution: { width: options.width, height: options.height, devicePixelRatio, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, screenWidth: screen.width, screenHeight: screen.height },
      capture: { warmupSeconds: options.warmupSeconds, requestedDurationSeconds: options.durationSeconds, actualDurationMs: captureEnd - captureStart, frameCount: frames.length, visibilityChanges },
      browser: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, crossOriginIsolated, secureContext: isSecureContext },
      adapter: engine.info.adapter,
      capabilities: { adapterFeatures: engine.info.adapterFeatures, adapterLimits: engine.info.adapterLimits, deviceLimits: engine.info.deviceLimits },
      profiling: { ...engine.info.profiling, capturedGpuSamples: summary.gpuPassMs.count, timedFrameCount: summary.gpuPassMs.count, capturedPassSampleCount: [...capturedTimings.values()].reduce((sum, values) => sum + values.length, 0), droppedGpuSamples: finalTelemetry.droppedGpuSamples - measuredStartTelemetry.droppedGpuSamples, pendingGpuSamples: finalTelemetry.pendingGpuSamples },
      coldStart: { initializeMs: initializedAt - coldStart, sceneSetupMs: compiledAt - initializedAt, uploadBytes: initialTelemetry.totalUploadBytes },
      assetTraffic: {
        externalAssetsUsed: virtual, steadyUploadBytes: finalTelemetry.totalUploadBytes - measuredStartTelemetry.totalUploadBytes,
        documentResourceTransferBytes: entries.reduce((sum, entry) => sum + entry.transferSize, 0), documentResourceDecodedBytes: entries.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
        ...(virtual ? { geometryAtCaptureStart: measuredStartTelemetry.geometry, geometryAtCaptureEnd: geometry } : {}),
        note: 'Document resource totals can omit worker/cache traffic. Geometry counters separately record completed page bytes and uploads; final counters may include requests completing during the bounded post-capture GPU readback flush.',
      },
      allocations: { ...finalTelemetry, note: 'Explicit app-owned GPU buffers/textures and WASM linear memory. Excludes swapchain, driver allocation, browser memory, and JavaScript heap.' },
      summary,
      gpuPasses: Object.fromEntries([...capturedTimings].map(([name, values]) => [name, { ...distribution(values), sampleCount: values.length, totalMs: values.reduce((sum, value) => sum + value, 0) }])),
      metadata: options.metadata,
      limitations: [
        'RAF intervals measure browser callback cadence, not scan-out or uncapped GPU throughput.',
        'GPU pass intervals may overlap; their sum is not elapsed frame time. GPU span covers the earliest to latest recorded pass boundary, including gaps but excluding earlier copies/uploads, browser composition and scan-out.',
        integrated ? 'This bounded courtyard combines streamed terrain, exact room geometry, a permanent coarse terrain tracing proxy, local diffuse GI and selected reflections. It does not establish general game complexity or Switch 2-equivalent visual quality.' : reflections ? 'This selected mirror and offscreen emissive cube test bounded software reflections. They do not establish general scenes, arbitrary materials, or the integrated 60 FPS target.' : gi ? 'This flat two-room scene tests one-bounce world-space diffuse GI and discrete changes. It does not validate general scenes or integrated graphics.' : virtual ? 'This static analytic terrain tests geometry streaming; it does not validate arbitrary meshes or the integrated graphics target.' : 'This small procedural scene establishes a rendering baseline; it does not validate the final 60 FPS graphics goal.',
        'No Sketchfab models are loaded, copied, or uploaded by this run.',
        ...(virtual ? ['Triangle and GPU selection counters describe their explicit sourceFrameId, which can lag the submitted frame. Missing counters stay labelled null.'] : []),
        ...(reflections ? ['Probe-only reflections are a Fresnel-weighted diffuse-irradiance approximation, not a sharp specular environment. Off and probe-only retain allocated reflection histories; a fresh never-world run has only one-pixel placeholders.', ...(integrated ? ['The 60-second scenario includes rigid-object motion and door/light changes; each invalidates world lighting history. The fixed probe volume does not provide general outdoor GI. Collision is not implemented.', 'Proxy error bounds describe vertical geometry, not normal, shadow or radiometric error. Render-page eviction never evicts the tracing proxy.'] : ['This benchmark holds the object and roughness fixed. Separate functional tests exercise object motion, camera cuts and disocclusion.'])] : []),
        ...(gi ? ['Named pass sums exclude between-pass work, including atlas preservation copies. Use GI-on/off callback and submission measurements alongside pass sums.', 'Disabling GI pauses its work but retains the scene-owned trace/cache allocations.'] : []),
      ],
      frames,
    };
    lastResult = result;
    lastOptions = options;
    downloadButton.disabled = false;
    status.textContent = `Complete · ${summary.meanCallbackCadenceFps?.toFixed(1) ?? 'unavailable'} callback FPS · p95 ${summary.frameIntervalMs.p95?.toFixed(2) ?? 'unavailable'} ms · GPU span p95 ${summary.gpuSpanMs.p95?.toFixed(3) ?? 'unavailable'} ms`;
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

async function capture(timeSeconds = 0, debugView = lastOptions?.debugView ?? 'final') {
  if (running || !engine) throw new Error('Capture imagery only after a benchmark completes.');
  const integrated = lastOptions?.renderer === 'integrated';
  const lighting = lastOptions?.renderer === 'gi' || lastOptions?.renderer === 'reflections' || integrated;
  const reflections = lastOptions?.renderer === 'reflections' || integrated;
  const scenario = integrated ? integratedScenario(timeSeconds) : {};
  engine.render({ timeSeconds, temporal: lastOptions?.temporal ?? true, debugView, cameraCut: true,
    ...(lighting ? { gi: { enabled: lastOptions!.giEnabled, doorOpen: true, wallColor: 'red', lightIntensity: 1, ...scenario.gi, resetCache: true } } : {}),
    ...(reflections ? { reflections: { mode: lastOptions!.reflectionMode, roughness: lastOptions!.reflectionRoughness,
      maxDistance: lastOptions!.reflectionMaxDistance, updateEvery: lastOptions!.reflectionUpdateEvery, objectOffset: 0, ...scenario.reflections, resetHistory: true } } : {}),
  });
  if (lastOptions?.mode === 'smoke') await engine.waitForIdle(120_000);
  await nextFrame();
  // Accumulate a fixed number of held-time frames after the single reset.
  const settleFrames = lastOptions?.mode !== 'smoke' && lighting && lastOptions!.giEnabled ? 240 : reflections && lastOptions?.mode !== 'smoke' ? 32 : 8;
  for (let frame = 0; frame < settleFrames; frame++) {
    engine.render({ timeSeconds: timeSeconds + (debugView === 'motion' ? (frame + 1) / 60 : 0), temporal: lastOptions?.temporal ?? true, debugView });
    if (lastOptions?.mode === 'smoke') await engine.waitForIdle(120_000);
    await nextFrame();
  }
  // Screenshots run after timing and fence all submissions, including unprofiled ones.
  await engine.waitForIdle(120_000);
  return { settleFrames };
}

declare global {
  interface Window {
    strataBenchmark: { ready: boolean; run: typeof run; capture: typeof capture;
      diagnostics(): { engineState: string; telemetry: ReturnType<Engine['getTelemetry']> | null }; dispose(): void };
  }
}
window.strataBenchmark = { ready: true, run, capture,
  diagnostics: () => ({ engineState: engine?.state ?? 'uninitialized', telemetry: engine?.getTelemetry() ?? null }),
  dispose: () => engine?.dispose() };
startButton.addEventListener('click', () => {
  const resolution = document.querySelector<HTMLSelectElement>('#resolution')!.value;
  const [width, height] = resolution.split('x').map(Number);
  const renderer = document.querySelector<HTMLSelectElement>('#renderer')!.value as BenchmarkOptions['renderer'];
  const debugView = document.querySelector<HTMLSelectElement>('#debug')!.value as BenchmarkOptions['debugView'];
  const temporal = document.querySelector<HTMLInputElement>('#temporal')!.checked;
  const manifestUrl = document.querySelector<HTMLInputElement>('#manifest')!.value;
  const traceProxyUrl = document.querySelector<HTMLInputElement>('#trace-proxy')!.value;
  const geometryMode = document.querySelector<HTMLSelectElement>('#geometry-mode')!.value as BenchmarkOptions['geometryMode'];
  void run({ width: width!, height: height!, renderer, debugView, temporal, manifestUrl, traceProxyUrl, geometryMode,
    ...(renderer === 'gi' || renderer === 'reflections' || renderer === 'integrated' ? readGiBenchmarkControls() : {}),
    ...(renderer === 'reflections' || renderer === 'integrated' ? readReflectionBenchmarkControls() : {}),
  }).catch(error => { status.textContent = String(error); });
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
