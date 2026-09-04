import { StrataError } from './errors.js';
import { initializeCpuRuntime } from './internal/cpu-runtime.js';
import type { CreateEngineOptions, Engine, EngineInfo, EngineState } from './types.js';

// Module evaluation is intentionally safe without navigator, document or Worker.
const ownedCanvases = new WeakSet<HTMLCanvasElement>();
const defaultTimeoutMs = 30_000;

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
    const ownedCpu = cpu;
    cpu = undefined;
    const ownedDevice = device;
    device = undefined;
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
    try {
      device = await phase(adapter.requestDevice({
        label: 'Strata device',
        requiredFeatures: [...(options.requiredFeatures ?? [])],
        requiredLimits: { ...options.requiredLimits },
      }), (lateDevice) => lateDevice.destroy());
    } catch (cause) {
      if (cancellation) throw cancellation;
      throw new StrataError('DEVICE_REQUEST_FAILED', 'The WebGPU device could not be created.', { cause });
    }
    if (cancellation) throw cancellation;
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
    const info: EngineInfo = Object.freeze({
      format,
      features: Object.freeze([...device.features]),
      maxTextureDimension2D: device.limits.maxTextureDimension2D,
      cpu: Object.freeze({ abiVersion: cpu.info.abiVersion, memoryBytes: cpu.info.memoryBytes }),
    });

    function assertReady(): void {
      if (state === 'disposed') {
        throw new StrataError('ENGINE_DISPOSED', 'This engine has been disposed.');
      }
      if (state === 'lost') {
        throw new StrataError('DEVICE_LOST', 'The WebGPU device was lost. Create a new engine to recover.', { cause: loss });
      }
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
      render() {
        assertReady();
        try {
          const encoder = device!.createCommandEncoder({ label: 'Strata frame' });
          const pass = encoder.beginRenderPass({
            label: 'Strata clear',
            colorAttachments: [{
              view: context!.getCurrentTexture().createView(),
              clearValue: { r: 0.04, g: 0.06, b: 0.09, a: 1 },
              loadOp: 'clear',
              storeOp: 'store',
            }],
          });
          pass.end();
          device!.queue.submit([encoder.finish()]);
        } catch (cause) {
          throw new StrataError('RENDER_FAILED', 'WebGPU frame submission failed.', { cause });
        }
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
