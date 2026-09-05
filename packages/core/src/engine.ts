import { StrataError } from './errors.js';
import { initializeCpuRuntime } from './internal/cpu-runtime.js';
import { GpuProfiler } from './profiling/gpu-profiler.js';
import type { SceneRenderer } from './rendering/scene-renderer.js';
import type { RasterRenderer } from './rendering/raster-renderer.js';
import type { VirtualRenderer } from './geometry/virtual-renderer.js';
import type { IntegratedRenderer } from './integrated/integrated-renderer.js';
import type { ReflectionRenderer } from './reflections/reflection-renderer.js';
import type { GiRenderer } from './gi/gi-renderer.js';
import type { CreateEngineOptions, Engine, EngineInfo, EngineState, EngineTelemetry, FrameMetrics, RenderOptions } from './types.js';

type OwnedScene = { kind: 'diffuse'; value: SceneRenderer } | { kind: 'raster'; value: RasterRenderer } | { kind: 'virtual'; value: VirtualRenderer } | { kind: 'gi'; value: GiRenderer } | { kind: 'reflections'; value: ReflectionRenderer } | { kind: 'integrated'; value: IntegratedRenderer };

// Module evaluation is intentionally safe without navigator, document or Worker.
const ownedCanvases = new WeakSet<HTMLCanvasElement>();
const defaultTimeoutMs = 30_000;
const debugViews = ['final', 'direct', 'shadow', 'depth', 'normal', 'motion', 'material', 'clusters', 'lod', 'residency', 'coverage', 'indirect', 'trace', 'probe-age', 'probe-irradiance', 'probe-visibility', 'reflections', 'reflection-source'] as const;
const defaultRenderOptions: RenderOptions = Object.freeze({});

function validateRenderOptions(options: RenderOptions): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || (options.temporal !== undefined && typeof options.temporal !== 'boolean')
    || (options.cameraCut !== undefined && typeof options.cameraCut !== 'boolean')
    || (options.debugView !== undefined && !debugViews.includes(options.debugView))) {
    throw new StrataError('INVALID_OPTIONS', 'Use boolean temporal/cameraCut controls and a supported debugView.');
  }
}

function snapshotLimits(limits: GPUSupportedLimits): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  // WebIDL values normally live on prototype getters, unlike the test adapters.
  let current: object | null = limits;
  while (current && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      const value = (limits as unknown as Record<string, unknown>)[key];
      if (typeof value === 'number') result[key] = value;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return Object.freeze(result);
}

function validateSize(width: number, height: number, maximum: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height)
    || width < 1 || height < 1 || width > maximum || height > maximum) {
    throw new StrataError(
      'INVALID_SIZE',
      `Canvas dimensions must be integers between 1 and ${maximum} physical pixels.`,
    );
  }
}

function validateRequirements(adapter: GPUAdapter, options: CreateEngineOptions): void {
  for (const feature of options.requiredFeatures ?? []) {
    if (!adapter.features.has(feature)) {
      throw new StrataError('UNSUPPORTED_FEATURE', `The GPU adapter does not support ${feature}.`);
    }
  }
  for (const [name, required] of Object.entries(options.requiredLimits ?? {})) {
    const supported = (adapter.limits as unknown as Record<string, unknown>)[name];
    if (!Number.isSafeInteger(required) || required < 0 || typeof supported !== 'number') {
      throw new StrataError('UNSUPPORTED_LIMIT', `Invalid or unknown WebGPU limit: ${name}.`);
    }
    // Alignment requirements are ceilings on required alignment; all other limits
    // are minimum requested capacities. WebGPU validates the descriptor again.
    const isAlignment = name === 'minUniformBufferOffsetAlignment'
      || name === 'minStorageBufferOffsetAlignment';
    if (isAlignment ? supported > required : supported < required) {
      throw new StrataError(
        'UNSUPPORTED_LIMIT',
        `WebGPU limit ${name} requires ${required}; the adapter supports ${supported}.`,
      );
    }
  }
}

/** Initialize one browser-only runtime. Failed initialization releases all ownership. */
export async function createEngine(options: CreateEngineOptions): Promise<Engine> {
  if (!options || typeof options !== 'object') {
    throw new StrataError('INVALID_OPTIONS', 'createEngine requires a canvas and an options object.');
  }
  if (options.profiling !== undefined && typeof options.profiling !== 'boolean') {
    throw new StrataError('INVALID_OPTIONS', 'profiling must be a boolean.');
  }
  const timeoutMs = options.initializationTimeoutMs ?? defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new StrataError('INVALID_OPTIONS', 'initializationTimeoutMs must be positive and at most 2147483647.');
  }
  if (options.signal?.aborted) {
    throw new StrataError('INITIALIZATION_ABORTED', 'Engine initialization was aborted.', {
      cause: options.signal.reason,
    });
  }
  const gpu = typeof navigator === 'undefined' ? undefined : navigator.gpu;
  if (!gpu) {
    throw new StrataError('WEBGPU_UNAVAILABLE', 'WebGPU is unavailable. Use a supported browser on HTTPS or localhost.');
  }
  const canvas = options.canvas;
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new StrataError('CANVAS_UNAVAILABLE', 'A dedicated HTML canvas is required.');
  }
  if (ownedCanvases.has(canvas)) {
    throw new StrataError('CANVAS_IN_USE', 'This canvas already belongs to a Strata engine.');
  }
  ownedCanvases.add(canvas);

  const initialization = new AbortController();
  let device: GPUDevice | undefined;
  let context: GPUCanvasContext | undefined;
  let contextConfigured = false;
  let cpu: Awaited<ReturnType<typeof initializeCpuRuntime>> | undefined;
  let scene: OwnedScene | undefined;
  let sceneGeneration = 0;
  let pendingSceneAbort: AbortController | undefined;
  let profiler: GpuProfiler | undefined;
  let submittedFrames = 0;
  let totalUploadBytes = 0;
  let forceRasterCameraCut = false;
  let gpuErrorCount = 0;
  let lastGpuError: string | null = null;
  let ownsCanvas = true;
  let initialized = false;
  let state: EngineState = 'ready';
  let loss: unknown;
  let cancellation: StrataError | undefined;
  let rejectCancellation!: (reason: StrataError) => void;
  const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  // Cancellation may arrive between phases, before the next race attaches.
  void cancelled.catch(() => undefined);

  function cleanup(): void {
    sceneGeneration++;
    pendingSceneAbort?.abort();
    pendingSceneAbort = undefined;
    const ownedScene = scene;
    scene = undefined;
    const ownedCpu = cpu;
    cpu = undefined;
    const ownedDevice = device;
    device = undefined;
    try { ownedDevice?.removeEventListener('uncapturederror', handleGpuError); } catch { /* Continue cleanup. */ }
    try { ownedScene?.value.dispose(); } catch { /* Continue releasing profiler/device resources. */ }
    try { profiler?.dispose(); } catch { /* Continue releasing the canvas and worker. */ }
    if (contextConfigured) {
      contextConfigured = false;
      try { context?.unconfigure(); } catch { /* Continue releasing other resources. */ }
    }
    try { ownedCpu?.dispose(); } catch { /* Continue releasing the GPU. */ }
    try { ownedDevice?.destroy(); } catch { /* Canvas ownership must still be released. */ }
    if (ownsCanvas) {
      ownsCanvas = false;
      ownedCanvases.delete(canvas);
    }
  }

  function cancel(error: StrataError): void {
    if (cancellation || initialized) return;
    cancellation = error;
    initialization.abort(error);
    cleanup();
    rejectCancellation(error);
  }

  const onAbort = (): void => cancel(new StrataError(
    'INITIALIZATION_ABORTED', 'Engine initialization was aborted.', { cause: options.signal?.reason },
  ));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => cancel(new StrataError(
    'INITIALIZATION_TIMEOUT', `Engine initialization exceeded ${timeoutMs} ms.`,
  )), timeoutMs);

  async function phase<T>(operation: Promise<T>, releaseLate?: (value: T) => void): Promise<T> {
    return Promise.race([
      operation.then((value) => {
        if (cancellation) {
          releaseLate?.(value);
          throw cancellation;
        }
        return value;
      }),
      cancelled,
    ]);
  }

  function handleDeviceLoss(reason: unknown): void {
    if (!ownsCanvas || state === 'disposed' || state === 'lost') return;
    loss = reason;
    if (!initialized) {
      cancel(new StrataError('DEVICE_LOST', 'The WebGPU device was lost during initialization.', { cause: reason }));
      return;
    }
    state = 'lost';
    cleanup();
  }

  function handleGpuError(event: GPUUncapturedErrorEvent): void {
    if (!ownsCanvas || state === 'disposed' || state === 'lost') return;
    gpuErrorCount++;
    lastGpuError = String(event.error?.message ?? 'Uncaptured GPU error').slice(0, 2048);
    if (!initialized) {
      cancel(new StrataError('GPU_VALIDATION_FAILED', 'WebGPU reported an error during initialization.', { cause: lastGpuError }));
    }
  }

  try {
    try {
      context = (canvas.getContext('webgpu') as GPUCanvasContext | null) ?? undefined;
    } catch (cause) {
      throw new StrataError('CANVAS_UNAVAILABLE', 'The canvas could not create a WebGPU context.', { cause });
    }
    if (!context) {
      throw new StrataError('CANVAS_UNAVAILABLE', 'The canvas has no available WebGPU context.');
    }

    let adapter: GPUAdapter | null;
    try {
      adapter = await phase(gpu.requestAdapter({
        ...(options.powerPreference === undefined ? {} : { powerPreference: options.powerPreference }),
      }));
    } catch (cause) {
      if (cancellation) throw cancellation;
      throw new StrataError('ADAPTER_UNAVAILABLE', 'WebGPU adapter selection failed.', { cause });
    }
    if (cancellation) throw cancellation;
    if (!adapter) {
      throw new StrataError('ADAPTER_UNAVAILABLE', 'No suitable WebGPU adapter is available.');
    }
    validateRequirements(adapter, options);
    const requiredFeatures = [...new Set(options.requiredFeatures ?? [])];
    const optionalTimestamp = options.profiling === true
      && adapter.features.has('timestamp-query') && !requiredFeatures.includes('timestamp-query');
    let timestampRequestFailed = false;
    try {
      const request = (features: GPUFeatureName[]): Promise<GPUDevice> => phase(adapter.requestDevice({
        label: 'Strata device', requiredFeatures: features, requiredLimits: { ...options.requiredLimits },
      }), (lateDevice) => lateDevice.destroy());
      try {
        device = await request(optionalTimestamp ? [...requiredFeatures, 'timestamp-query'] : requiredFeatures);
      } catch (cause) {
        if (cancellation || !optionalTimestamp) throw cause;
        // Profiling is optional; an explicitly required timestamp feature never falls back.
        timestampRequestFailed = true;
        device = await request(requiredFeatures);
      }
    } catch (cause) {
      if (cancellation) throw cancellation;
      throw new StrataError('DEVICE_REQUEST_FAILED', 'The WebGPU device could not be created.', { cause });
    }
    if (cancellation) throw cancellation;
    device.addEventListener('uncapturederror', handleGpuError);
    void device.lost.then(handleDeviceLoss, handleDeviceLoss);
    validateSize(canvas.width, canvas.height, device.limits.maxTextureDimension2D);

    cpu = await phase(initializeCpuRuntime({
      ...(options.wasmUrl === undefined ? {} : { wasmUrl: options.wasmUrl }),
      ...(options.workerUrl === undefined ? {} : { workerUrl: options.workerUrl }),
      signal: initialization.signal,
      timeoutMs,
    }), (lateCpu) => lateCpu.dispose());
    if (cancellation) throw cancellation;

    const format = gpu.getPreferredCanvasFormat();
    try {
      contextConfigured = true;
      context.configure({ device, format, alphaMode: 'opaque' });
    } catch (cause) {
      throw new StrataError('CANVAS_UNAVAILABLE', 'The WebGPU canvas could not be configured.', { cause });
    }
    const profilingEnabled = options.profiling === true;
    const gpuTimestampAvailable = profilingEnabled && device.features.has('timestamp-query') && !timestampRequestFailed;
    if (gpuTimestampAvailable) profiler = new GpuProfiler(device);
    const adapterInfo = adapter.info;
    const info: EngineInfo = Object.freeze({
      format,
      features: Object.freeze([...device.features]),
      maxTextureDimension2D: device.limits.maxTextureDimension2D,
      adapter: Object.freeze({
        vendor: adapterInfo?.vendor ?? '',
        architecture: adapterInfo?.architecture ?? '',
        device: adapterInfo?.device ?? '',
        description: adapterInfo?.description ?? '',
        isFallbackAdapter: adapterInfo?.isFallbackAdapter ?? null,
      }),
      adapterFeatures: Object.freeze([...adapter.features]),
      adapterLimits: snapshotLimits(adapter.limits),
      deviceLimits: snapshotLimits(device.limits),
      profiling: Object.freeze({
        enabled: profilingEnabled,
        gpuTimestampAvailable,
        reason: !profilingEnabled ? 'disabled' : timestampRequestFailed ? 'timestamp-query-device-request-failed'
          : gpuTimestampAvailable ? 'available' : 'timestamp-query-unavailable',
        timestampPrecision: 'browser-dependent',
      }),
      cpu: Object.freeze({ abiVersion: cpu.info.abiVersion, memoryBytes: cpu.info.memoryBytes }),
    });

    function assertReady(): void {
      if (state === 'disposed') {
        throw new StrataError('ENGINE_DISPOSED', 'This engine has been disposed.');
      }
      if (state === 'lost') {
        throw new StrataError('DEVICE_LOST', 'The WebGPU device was lost. Create a new engine to recover.', { cause: loss });
      }
      if (gpuErrorCount) {
        throw new StrataError('GPU_VALIDATION_FAILED', 'WebGPU reported an uncaptured error. Dispose this engine before retrying.', { cause: lastGpuError });
      }
    }

    function telemetry(): EngineTelemetry {
      return {
        submittedFrames, totalUploadBytes,
        allocatedGpuBufferBytes: device ? (scene?.value.gpuBufferBytes ?? 0) + (profiler?.allocatedBufferBytes ?? 0) : 0,
        allocatedGpuTextureBytes: scene?.value.gpuTextureBytes ?? 0,
        wasmMemoryBytes: cpu?.info.memoryBytes ?? 0,
        pendingGpuSamples: profiler?.pendingSamples ?? 0,
        droppedGpuSamples: profiler?.droppedSamples ?? 0,
        gpuErrorCount, lastGpuError,
        ...(scene?.kind === 'virtual' || scene?.kind === 'integrated' ? { geometry: scene.value.geometryTelemetry } : {}),
        ...(scene?.kind === 'gi' || scene?.kind === 'reflections' || scene?.kind === 'integrated' ? { gi: scene.value.giTelemetry } : {}),
        ...(scene?.kind === 'reflections' || scene?.kind === 'integrated' ? { reflections: scene.value.reflectionTelemetry } : {}),
        ...(scene?.kind === 'integrated' ? { integrated: scene.value.integratedTelemetry } : {}),
      };
    }

    const engine: Engine = {
      get state() { return state; },
      info,
      resize(width, height) {
        assertReady();
        validateSize(width, height, info.maxTextureDimension2D);
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
      },
      async setScene(sceneOptions) {
        assertReady();
        if (sceneOptions !== null && (!sceneOptions || typeof sceneOptions !== 'object' || Array.isArray(sceneOptions)
          || (sceneOptions.renderer !== undefined && !['diffuse', 'raster', 'virtual', 'gi', 'reflections', 'integrated'].includes(sceneOptions.renderer)))) {
          throw new StrataError('INVALID_OPTIONS', 'Scene options require renderer diffuse, raster, virtual, gi, reflections or integrated, or null to clear.');
        }
        if ((sceneOptions?.renderer === 'virtual' || sceneOptions?.renderer === 'integrated') && sceneOptions.signal?.aborted) throw new StrataError('SCENE_LOAD_ABORTED', 'Scene creation was aborted.');
        const generation = ++sceneGeneration;
        pendingSceneAbort?.abort();
        pendingSceneAbort = undefined;
        if (sceneOptions === null) {
          scene?.value.dispose();
          scene = undefined;
          return;
        }
        const snapshot = { ...sceneOptions };
        const requestAbort = new AbortController();
        pendingSceneAbort = requestAbort;
        const userSignal = snapshot.renderer === 'virtual' || snapshot.renderer === 'integrated' ? snapshot.signal : undefined;
        const abortRequest = () => requestAbort.abort(userSignal?.reason);
        userSignal?.addEventListener('abort', abortRequest, { once: true });
        if (snapshot.renderer === 'virtual' || snapshot.renderer === 'integrated') snapshot.manifestUrl = String(snapshot.manifestUrl);
        if (snapshot.renderer === 'integrated') snapshot.traceProxyUrl = String(snapshot.traceProxyUrl);
        const ownedDevice = device!;
        const assertCurrentRequest = (): void => {
          assertReady();
          if (generation !== sceneGeneration) {
            throw new StrataError('SCENE_LOAD_SUPERSEDED', 'A newer scene request superseded this request.');
          }
        };
        let next: OwnedScene;
        try {
          if (snapshot.renderer === 'integrated') {
            const { IntegratedRenderer } = await import('./integrated/integrated-renderer.js');
            assertCurrentRequest();
            next = { kind: 'integrated', value: await IntegratedRenderer.create(ownedDevice, format, { ...snapshot, signal: requestAbort.signal }) };
          } else if (snapshot.renderer === 'virtual') {
            const { VirtualRenderer } = await import('./geometry/virtual-renderer.js');
            assertCurrentRequest();
            next = { kind: 'virtual', value: await VirtualRenderer.create(ownedDevice, format, { ...snapshot, signal: requestAbort.signal }) };
          } else if (snapshot.renderer === 'reflections') {
            const { ReflectionRenderer } = await import('./reflections/reflection-renderer.js');
            assertCurrentRequest();
            next = { kind: 'reflections', value: await ReflectionRenderer.create(ownedDevice, format, snapshot) };
          } else if (snapshot.renderer === 'gi') {
            const { GiRenderer } = await import('./gi/gi-renderer.js');
            assertCurrentRequest();
            next = { kind: 'gi', value: await GiRenderer.create(ownedDevice, format, snapshot) };
          } else if (snapshot.renderer === 'raster') {
            const { RasterRenderer } = await import('./rendering/raster-renderer.js');
            assertCurrentRequest();
            next = { kind: 'raster', value: await RasterRenderer.create(ownedDevice, format, snapshot) };
          } else {
            const { SceneRenderer } = await import('./rendering/scene-renderer.js');
            assertCurrentRequest();
            next = { kind: 'diffuse', value: await SceneRenderer.create(ownedDevice, format, snapshot) };
          }
        } catch (cause) {
          assertCurrentRequest();
          if (requestAbort.signal.aborted) throw new StrataError('SCENE_LOAD_ABORTED', 'Scene creation was aborted.', { cause });
          if (cause instanceof StrataError) throw cause;
          throw new StrataError('SCENE_LOAD_FAILED', 'The scene could not be initialized.', { cause });
        } finally {
          userSignal?.removeEventListener('abort', abortRequest);
          if (pendingSceneAbort === requestAbort) pendingSceneAbort = undefined;
        }
        totalUploadBytes += next.value.initialUploadBytes;
        if (generation !== sceneGeneration || state !== 'ready' || gpuErrorCount || requestAbort.signal.aborted) {
          next.value.dispose();
          assertReady();
          if (generation === sceneGeneration && requestAbort.signal.aborted) throw new StrataError('SCENE_LOAD_ABORTED', 'Scene creation was aborted.');
          throw new StrataError('SCENE_LOAD_SUPERSEDED', 'A newer scene request superseded this request.');
        }
        const previous = scene;
        scene = next;
        previous?.value.dispose();
      },
      render(renderOptions) {
        assertReady();
        const requestedControls = renderOptions ?? defaultRenderOptions;
        validateRenderOptions(requestedControls);
        const controls = forceRasterCameraCut && scene && scene.kind !== 'diffuse'
          ? { ...requestedControls, cameraCut: true } : requestedControls;
        const timeSeconds = renderOptions?.timeSeconds ?? 0;
        if (!Number.isFinite(timeSeconds)) {
          throw new StrataError('INVALID_OPTIONS', 'timeSeconds must be finite.');
        }
        const started = performance.now();
        const frameId = submittedFrames + 1;
        const passNames = scene && scene.kind !== 'diffuse' ? scene.value.passNames(controls) : scene ? 'procedural' : 'clear';
        const timing = profiler?.begin(frameId, passNames);
        try {
          const encoder = device!.createCommandEncoder({ label: 'Strata frame' });
          const view = context!.getCurrentTexture().createView();
          let drawCalls = 0;
          let dispatchCalls = 0;
          let triangles = 0;
          let uploadBytes = 0;
          if (scene && scene.kind !== 'diffuse') {
            ({ drawCalls, dispatchCalls, triangles, uploadBytes } = scene.value.encode(
              encoder, view, canvas.width, canvas.height, timeSeconds, controls, timing?.timestamps,
            ));
          } else if (scene) {
            ({ drawCalls, dispatchCalls, triangles, uploadBytes } = scene.value.encode(
              encoder, view, canvas.width, canvas.height, timeSeconds, timing?.timestampWrites,
            ));
          } else {
            const pass = encoder.beginRenderPass({
              label: 'Strata clear',
              ...(timing ? { timestampWrites: timing.timestampWrites } : {}),
              colorAttachments: [{
                view,
                clearValue: { r: 0.04, g: 0.06, b: 0.09, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
              }],
            });
            pass.end();
          }
          totalUploadBytes += uploadBytes;
          if (timing) profiler!.resolve(encoder, timing);
          device!.queue.submit([encoder.finish()]);
          if (scene && scene.kind !== 'diffuse') forceRasterCameraCut = false;
          submittedFrames++;
          if (scene?.kind === 'virtual' || scene?.kind === 'gi' || scene?.kind === 'reflections' || scene?.kind === 'integrated') scene.value.submitted(frameId);
          if (timing) profiler!.submitted(timing);
          const stats = telemetry();
          const metrics: FrameMetrics = {
            frameId, cpuSubmissionMs: performance.now() - started,
            drawCalls, dispatchCalls, triangles, uploadBytes,
            allocatedGpuBufferBytes: stats.allocatedGpuBufferBytes,
            allocatedGpuTextureBytes: stats.allocatedGpuTextureBytes,
            wasmMemoryBytes: stats.wasmMemoryBytes,
            triangleCountSourceFrameId: scene?.kind === 'virtual' || scene?.kind === 'integrated' ? scene.value.geometryTelemetry.sourceFrameId : frameId,
            ...(stats.geometry ? { geometry: stats.geometry } : {}),
            ...(stats.gi ? { gi: stats.gi } : {}),
            ...(stats.reflections ? { reflections: stats.reflections } : {}),
            ...(stats.integrated ? { integrated: stats.integrated } : {}),
          };
          return metrics;
        } catch (cause) {
          // Encoding can advance ping-pong histories before a later pass or submission fails.
          forceRasterCameraCut = true;
          if (scene?.kind === 'virtual' || scene?.kind === 'gi' || scene?.kind === 'reflections' || scene?.kind === 'integrated') scene.value.cancelFrame();
          if (timing) profiler!.cancel(timing);
          throw new StrataError('RENDER_FAILED', 'WebGPU frame submission failed.', { cause });
        }
      },
      getTelemetry: telemetry,
      drainGpuTimings() { return profiler?.drain() ?? []; },
      async flushGpuTimings(timeoutMs) {
        assertReady();
        try {
        await profiler?.flush(timeoutMs);
        if (scene?.kind === 'virtual' || scene?.kind === 'integrated') await scene.value.flushFeedback(timeoutMs);
        } catch (cause) {
          assertReady();
          throw cause;
        }
        assertReady();
      },
      dispose() {
        if (state === 'disposed') return;
        state = 'disposed';
        cleanup();
      },
    };
    initialized = true;
    return engine;
  } catch (cause) {
    // Abort the CPU initialization even when a failure originated in the GPU path.
    initialization.abort(cause);
    cleanup();
    throw cause;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
