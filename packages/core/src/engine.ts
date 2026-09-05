import { SceneCommitError, StrataError } from './errors.js';
import { initializeCpuRuntime } from './internal/cpu-runtime.js';
import { GpuProfiler } from './profiling/gpu-profiler.js';
import { validateAuthoredBoxScene, validateAuthoredFrameCamera } from './rendering/authored-box-validation.js';
import type { AuthoredBoxRenderer } from './rendering/authored-box-renderer.js';
import type { AuthoredFrameMetadata, BoxSceneDescriptor } from './rendering/authored-box-types.js';
import type { RasterControls } from './rendering/raster-types.js';
import type { SceneRenderer } from './rendering/scene-renderer.js';
import type { RasterRenderer } from './rendering/raster-renderer.js';
import type { VirtualRenderer } from './geometry/virtual-renderer.js';
import type { IntegratedRenderer } from './integrated/integrated-renderer.js';
import type { ReflectionRenderer } from './reflections/reflection-renderer.js';
import type { ImportedRenderer } from './imported/imported-renderer.js';
import type { GiRenderer } from './gi/gi-renderer.js';
import type { CreateEngineOptions, Engine, EngineInfo, EngineState, EngineTelemetry, FrameMetrics, RenderOptions, SceneCommitReceipt } from './types.js';

type OwnedScene = { kind: 'authored-boxes'; value: AuthoredBoxRenderer; descriptor: BoxSceneDescriptor } | { kind: 'diffuse'; value: SceneRenderer } | { kind: 'raster'; value: RasterRenderer } | { kind: 'virtual'; value: VirtualRenderer } | { kind: 'gi'; value: GiRenderer } | { kind: 'reflections'; value: ReflectionRenderer } | { kind: 'integrated'; value: IntegratedRenderer } | { kind: 'imported'; value: ImportedRenderer };

// Module evaluation is intentionally safe without navigator, document or Worker.
const ownedCanvases = new WeakSet<HTMLCanvasElement>();
const defaultTimeoutMs = 30_000;
const debugViews = ['final', 'direct', 'shadow', 'depth', 'normal', 'motion', 'material', 'clusters', 'lod', 'residency', 'coverage', 'indirect', 'trace', 'probe-age', 'probe-irradiance', 'probe-visibility', 'reflections', 'reflection-source', 'base-color'] as const;
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
  let committedScene: SceneCommitReceipt = Object.freeze({ sceneGeneration: 0, renderer: 'clear', sceneId: null, sourceRevision: null });
  let firstSubmittedFrameId: number | null = null;
  let lastSubmittedFrameId: number | null = null;
  // A throwing disposer does not transfer resource ownership back to the caller.
  const retiredScenes = new Set<OwnedScene>();
  function retireScene(previous: OwnedScene | undefined): unknown {
    if (!previous) return undefined;
    try { previous.value.dispose(); retiredScenes.delete(previous); }
    catch (cause) { retiredScenes.add(previous); return { cause }; }
    return undefined;
  }

  let pendingSceneAbort: AbortController | undefined;
  // Serialize imported creation so a cancelled CPU preparation finishes cleanup
  // before a replacement copies the same large source or reserves another job.
  let importedBuildTail: Promise<void> = Promise.resolve();
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
    retireScene(ownedScene);
    for (const retired of [...retiredScenes]) retireScene(retired);
    retiredScenes.clear(); // The owned device is destroyed below even if disposal failed.

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
        scene: { identity: committedScene, firstSubmittedFrameId, lastSubmittedFrameId },
        allocatedGpuBufferBytes: device ? (scene?.value.gpuBufferBytes ?? 0) + [...retiredScenes].reduce((sum, item) => sum + item.value.gpuBufferBytes, 0) + (profiler?.allocatedBufferBytes ?? 0) : 0,
        allocatedGpuTextureBytes: device ? (scene?.value.gpuTextureBytes ?? 0) + [...retiredScenes].reduce((sum, item) => sum + item.value.gpuTextureBytes, 0) : 0,
        wasmMemoryBytes: cpu?.info.memoryBytes ?? 0,
        pendingGpuSamples: profiler?.pendingSamples ?? 0,
        droppedGpuSamples: profiler?.droppedSamples ?? 0,
        gpuErrorCount, lastGpuError,
        ...(scene?.kind === 'virtual' || scene?.kind === 'integrated' ? { geometry: scene.value.geometryTelemetry } : {}),
        ...(scene?.kind === 'gi' || scene?.kind === 'reflections' || scene?.kind === 'integrated' ? { gi: scene.value.giTelemetry } : {}),
        ...(scene?.kind === 'reflections' || scene?.kind === 'integrated' ? { reflections: scene.value.reflectionTelemetry } : {}),
        ...(scene?.kind === 'integrated' ? { integrated: scene.value.integratedTelemetry } : {}),
        ...(scene?.kind === 'imported' ? { imported: scene.value.importedTelemetry } : {}),
      };
    }

    const engine: Engine = {
      get state() { return state; },
      info,
      resize(width, height) {
        assertReady();
        validateSize(width, height, info.maxTextureDimension2D);
        if (scene?.kind === 'imported' && scene.value.hasIndirect) scene.value.validateSize(width, height);
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
      },
      async setScene(sceneOptions) {
        assertReady();
        if (sceneOptions !== null && (!sceneOptions || typeof sceneOptions !== 'object' || Array.isArray(sceneOptions)
          || (sceneOptions.renderer !== undefined && !['diffuse', 'raster', 'virtual', 'gi', 'reflections', 'integrated', 'authored-boxes', 'imported'].includes(sceneOptions.renderer)))) {
          throw new StrataError('INVALID_OPTIONS', 'Use a supported scene renderer, or null to clear.');
        }
        // Validate and take ownership of authored JSON before an asynchronous phase
        // or superseding an already valid pending request.
        const snapshot = sceneOptions === null ? null : sceneOptions.renderer === 'authored-boxes'
          ? { ...sceneOptions, scene: validateAuthoredBoxScene(sceneOptions.scene) } : { ...sceneOptions };
        if (snapshot?.renderer === 'imported' && snapshot.indirect !== undefined) {
          if (!snapshot.indirect || typeof snapshot.indirect !== 'object' || Array.isArray(snapshot.indirect)) throw new StrataError('INVALID_OPTIONS', 'Imported indirect options must be an object.');
          snapshot.indirect = { ...snapshot.indirect };
        }
        const userSignal = snapshot?.renderer === 'virtual' || snapshot?.renderer === 'integrated' || snapshot?.renderer === 'authored-boxes' || snapshot?.renderer === 'imported'
          ? snapshot.signal : undefined;
        if (userSignal !== undefined && (!userSignal || typeof userSignal.aborted !== 'boolean'
          || typeof userSignal.addEventListener !== 'function' || typeof userSignal.removeEventListener !== 'function')) {
          throw new StrataError('INVALID_OPTIONS', 'signal must be an AbortSignal.');
        }
        if (userSignal?.aborted) throw new StrataError('SCENE_LOAD_ABORTED', 'Scene creation was aborted.');
        if (snapshot?.renderer === 'virtual' || snapshot?.renderer === 'integrated') snapshot.manifestUrl = String(snapshot.manifestUrl);
        if (snapshot?.renderer === 'integrated') snapshot.traceProxyUrl = String(snapshot.traceProxyUrl);
        if (!Number.isSafeInteger(sceneGeneration + 1)) throw new StrataError('SCENE_LOAD_FAILED', 'Scene generation capacity exhausted.');
        const generation = ++sceneGeneration;
        pendingSceneAbort?.abort();
        pendingSceneAbort = undefined;
        function commit(next: OwnedScene | undefined): SceneCommitReceipt {
          const previous = scene;
          scene = next;
          const receipt: SceneCommitReceipt = Object.freeze({ sceneGeneration: generation, renderer: next?.kind ?? 'clear',
            sceneId: next?.kind === 'authored-boxes' ? next.descriptor.sceneId : null,
            sourceRevision: next?.kind === 'authored-boxes' ? next.descriptor.sourceRevision : null });
          committedScene = receipt;
          firstSubmittedFrameId = lastSubmittedFrameId = null;
          const failure = retireScene(previous) as { cause: unknown } | undefined;
          if (failure) throw new SceneCommitError(receipt, failure.cause);
          return receipt;
        }
        if (snapshot === null) return commit(undefined);
        const requestAbort = new AbortController();
        pendingSceneAbort = requestAbort;
        const abortRequest = () => requestAbort.abort(userSignal?.reason);
        const ownedDevice = device!;
        const assertCurrentRequest = (): void => {
          assertReady();
          if (generation !== sceneGeneration) throw new StrataError('SCENE_LOAD_SUPERSEDED', 'A newer scene request superseded this request.');
          if (requestAbort.signal.aborted) throw new StrataError('SCENE_LOAD_ABORTED', 'Scene creation was aborted.', { cause: requestAbort.signal.reason });
        };
        let rejectAbort!: (reason: unknown) => void;
        const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
        const onRequestAbort = () => {
          try { assertCurrentRequest(); } catch (cause) { rejectAbort(cause); }
        };
        requestAbort.signal.addEventListener('abort', onRequestAbort, { once: true });
        userSignal?.addEventListener('abort', abortRequest, { once: true });
        if (userSignal?.aborted) abortRequest();
        async function build(): Promise<OwnedScene> {
          if (snapshot!.renderer === 'authored-boxes') {
            const { AuthoredBoxRenderer } = await import('./rendering/authored-box-renderer.js');
            assertCurrentRequest();
            return { kind: 'authored-boxes', descriptor: snapshot!.scene, value: await AuthoredBoxRenderer.create(ownedDevice, format, snapshot!.scene) };
          } else if (snapshot!.renderer === 'imported') {
            const { ImportedRenderer } = await import('./imported/imported-renderer.js');
            assertCurrentRequest();
            const preceding = importedBuildTail;
            let release!: () => void;
            importedBuildTail = new Promise<void>(resolve => { release = resolve; });
            try {
              await preceding; assertCurrentRequest();
              // Even a direct-only replacement must wait for a cancelled tracing
              // job to release its worker inputs before decoding new textures.
              await cpu!.waitForStaticBvhIdle(); assertCurrentRequest();
              const additionalResidentCpuBytes = (scene?.kind === 'imported' ? scene.value.retainedCpuBytes ?? 0 : 0)
                + [...retiredScenes].reduce((sum, retired) => sum + (retired.kind === 'imported' ? retired.value.retainedCpuBytes ?? 0 : 0), 0);
              const value = await ImportedRenderer.create(ownedDevice, format, { ...snapshot!, signal: requestAbort.signal },
                { cpu: cpu!, width: canvas.width, height: canvas.height, additionalResidentCpuBytes });
              try { if (value.hasIndirect) value.validateSize(canvas.width, canvas.height); }
              catch (cause) { value.dispose(); throw cause; }
              return { kind: 'imported', value };
            } finally { release(); }
          } else if (snapshot!.renderer === 'integrated') {
            const { IntegratedRenderer } = await import('./integrated/integrated-renderer.js');
            assertCurrentRequest();
            return { kind: 'integrated', value: await IntegratedRenderer.create(ownedDevice, format, { ...snapshot!, signal: requestAbort.signal }) };
          } else if (snapshot!.renderer === 'virtual') {
            const { VirtualRenderer } = await import('./geometry/virtual-renderer.js');
            assertCurrentRequest();
            return { kind: 'virtual', value: await VirtualRenderer.create(ownedDevice, format, { ...snapshot!, signal: requestAbort.signal }) };
          } else if (snapshot!.renderer === 'reflections') {
            const { ReflectionRenderer } = await import('./reflections/reflection-renderer.js');
            assertCurrentRequest();
            return { kind: 'reflections', value: await ReflectionRenderer.create(ownedDevice, format, snapshot!) };
          } else if (snapshot!.renderer === 'gi') {
            const { GiRenderer } = await import('./gi/gi-renderer.js');
            assertCurrentRequest();
            return { kind: 'gi', value: await GiRenderer.create(ownedDevice, format, snapshot!) };
          } else if (snapshot!.renderer === 'raster') {
            const { RasterRenderer } = await import('./rendering/raster-renderer.js');
            assertCurrentRequest();
            return { kind: 'raster', value: await RasterRenderer.create(ownedDevice, format, snapshot!) };
          }
          const { SceneRenderer } = await import('./rendering/scene-renderer.js');
          assertCurrentRequest();
          return { kind: 'diffuse', value: await SceneRenderer.create(ownedDevice, format, snapshot!) };
        }
        let candidate: OwnedScene | undefined;
        try {
          const operation = build().then((next) => {
            totalUploadBytes += next.value.initialUploadBytes;
            try { assertCurrentRequest(); } catch (cause) { retireScene(next); throw cause; }
            candidate = next;
            return next;
          });
          const next = await Promise.race([operation, aborted]);
          assertCurrentRequest();
          candidate = undefined; // commit takes ownership, including a retirement failure.
          return commit(next);
        } catch (cause) {
          retireScene(candidate);
          if (cause instanceof SceneCommitError) throw cause;
          assertCurrentRequest();
          if (cause instanceof StrataError) throw cause;
          throw new StrataError('SCENE_LOAD_FAILED', 'The scene could not be initialized.', { cause });
        } finally {
          requestAbort.signal.removeEventListener('abort', onRequestAbort);
          userSignal?.removeEventListener('abort', abortRequest);
          if (pendingSceneAbort === requestAbort) pendingSceneAbort = undefined;
        }
      },
      render(renderOptions) {
        assertReady();
        const requestedControls = renderOptions ?? defaultRenderOptions;
        validateRenderOptions(requestedControls);
        if (requestedControls.imported !== undefined && scene?.kind !== 'imported') {
          throw new StrataError('UNSUPPORTED_FEATURE', 'Imported controls require an imported scene.');
        }
        if (scene?.kind === 'imported' && (requestedControls.gi !== undefined || requestedControls.reflections !== undefined
          || (requestedControls.debugView !== undefined && !['final', 'direct', 'shadow', 'depth', 'normal', 'motion', 'material'].includes(requestedControls.debugView)))) {
          throw new StrataError('UNSUPPORTED_FEATURE', 'Imported scenes use raster diagnostics and their own optional indirect controls; room GI and traced-reflection controls are unsupported.');
        }
        if (scene?.kind === 'authored-boxes') {
          if (requestedControls.temporal === true || requestedControls.gi !== undefined || requestedControls.reflections !== undefined
            || (requestedControls.debugView !== undefined && requestedControls.debugView !== 'final' && requestedControls.debugView !== 'base-color')) {
            throw new StrataError('UNSUPPORTED_FEATURE', 'Authored boxes support final/base-color views with temporal disabled.');
          }
        } else if (requestedControls.camera !== undefined || requestedControls.debugView === 'base-color') {
          throw new StrataError('UNSUPPORTED_FEATURE', 'Camera overrides and base-color are supported only by authored boxes.');
        }
        const effectiveCamera = scene?.kind === 'authored-boxes'
          ? validateAuthoredFrameCamera(scene.descriptor, requestedControls.camera === undefined ? scene.descriptor.camera : requestedControls.camera, canvas.width, canvas.height) : undefined;
        const controls = forceRasterCameraCut && scene && scene.kind !== 'diffuse'
          ? { ...requestedControls, cameraCut: true } : requestedControls;
        const timeSeconds = renderOptions?.timeSeconds ?? 0;
        if (!Number.isFinite(timeSeconds)) {
          throw new StrataError('INVALID_OPTIONS', 'timeSeconds must be finite.');
        }
        const started = performance.now();
        const frameId = submittedFrames + 1;
        const frameScene = committedScene;
        const passNames = scene?.kind === 'authored-boxes' ? scene.value.passNames()
          : scene && scene.kind !== 'diffuse' ? scene.value.passNames(controls as RasterControls) : scene ? 'procedural' : 'clear';
        const timing = profiler?.begin(frameId, passNames);
        try {
          const encoder = device!.createCommandEncoder({ label: 'Strata frame' });
          const view = context!.getCurrentTexture().createView();
          let drawCalls = 0;
          let dispatchCalls = 0;
          let triangles = 0;
          let uploadBytes = 0;
          let skippedGpuPasses: readonly string[] | undefined;
          let authored: AuthoredFrameMetadata | undefined;
          if (scene?.kind === 'authored-boxes') {
            ({ drawCalls, dispatchCalls, triangles, uploadBytes, authored } = scene.value.encode(
              encoder, view, canvas.width, canvas.height, timeSeconds,
              { camera: effectiveCamera!, debugView: (requestedControls.debugView ?? 'final') as 'final' | 'base-color', temporal: false }, timing?.timestamps,
            ));
          } else if (scene && scene.kind !== 'diffuse') {
            ({ drawCalls, dispatchCalls, triangles, uploadBytes, skippedGpuPasses } = scene.value.encode(
              encoder, view, canvas.width, canvas.height, timeSeconds, controls as RasterControls, timing?.timestamps,
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
          if (timing) profiler!.resolve(encoder, timing, skippedGpuPasses);
          device!.queue.submit([encoder.finish()]);
          if (scene && scene.kind !== 'diffuse') forceRasterCameraCut = false;
          submittedFrames++;
          firstSubmittedFrameId ??= frameId;
          lastSubmittedFrameId = frameId;
          if (scene?.kind === 'virtual' || scene?.kind === 'gi' || scene?.kind === 'reflections' || scene?.kind === 'integrated' || scene?.kind === 'imported') scene.value.submitted(frameId);
          if (timing) profiler!.submitted(timing);
          const stats = telemetry();
          const metrics: FrameMetrics = {
            frameId, scene: frameScene, ...(authored ? { authored } : {}), cpuSubmissionMs: performance.now() - started,
            drawCalls, dispatchCalls, triangles, uploadBytes,
            allocatedGpuBufferBytes: stats.allocatedGpuBufferBytes,
            allocatedGpuTextureBytes: stats.allocatedGpuTextureBytes,
            wasmMemoryBytes: stats.wasmMemoryBytes,
            triangleCountSourceFrameId: scene?.kind === 'virtual' || scene?.kind === 'integrated' ? scene.value.geometryTelemetry.sourceFrameId : frameId,
            ...(stats.geometry ? { geometry: stats.geometry } : {}),
            ...(stats.gi ? { gi: stats.gi } : {}),
            ...(stats.reflections ? { reflections: stats.reflections } : {}),
            ...(stats.integrated ? { integrated: stats.integrated } : {}),
            ...(stats.imported ? { imported: stats.imported } : {}),
          };
          return metrics;
        } catch (cause) {
          // Encoding can advance ping-pong histories before a later pass or submission fails.
          forceRasterCameraCut = true;
          if (scene?.kind === 'virtual' || scene?.kind === 'gi' || scene?.kind === 'reflections' || scene?.kind === 'integrated' || scene?.kind === 'imported') scene.value.cancelFrame();
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
      async waitForIdle(timeoutMs = 5000) {
        assertReady();
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
          throw new StrataError('INVALID_OPTIONS', 'GPU work timeout must be positive and at most 2147483647 ms.');
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StrataError('GPU_WORK_TIMEOUT', `GPU work exceeded ${timeoutMs} ms.`)), timeoutMs);
        });
        try {
          await Promise.race([device!.queue.onSubmittedWorkDone(), deadline]);
          assertReady();
          if (scene?.kind === 'imported' && scene.value.hasIndirect) {
            await Promise.race([scene.value.readIndirectProgress(), deadline]);
            assertReady();
          }
        } catch (cause) {
          assertReady();
          if (cause instanceof StrataError) throw cause;
          throw new StrataError('GPU_WORK_FAILED', 'Waiting for submitted GPU work failed.', { cause });
        } finally { clearTimeout(timer); }
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
