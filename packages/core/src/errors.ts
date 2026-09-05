/** Stable failure categories for application-level fallback and error reporting. */
export type StrataErrorCode =
  | 'WEBGPU_UNAVAILABLE'
  | 'ADAPTER_UNAVAILABLE'
  | 'UNSUPPORTED_FEATURE'
  | 'UNSUPPORTED_LIMIT'
  | 'DEVICE_REQUEST_FAILED'
  | 'CANVAS_UNAVAILABLE'
  | 'CANVAS_IN_USE'
  | 'WORKER_UNAVAILABLE'
  | 'WORKER_FAILED'
  | 'WASM_LOAD_FAILED'
  | 'WASM_INCOMPATIBLE'
  | 'INITIALIZATION_ABORTED'
  | 'INITIALIZATION_TIMEOUT'
  | 'DEVICE_LOST'
  | 'ENGINE_DISPOSED'
  | 'INVALID_SIZE'
  | 'INVALID_OPTIONS'
  | 'SCENE_LOAD_FAILED'
  | 'SCENE_LOAD_SUPERSEDED'
  | 'GPU_VALIDATION_FAILED'
  | 'GPU_TIMING_TIMEOUT'
  | 'RENDER_FAILED';

/** A runtime failure with a stable code and, when available, its original cause. */
export class StrataError extends Error {
  readonly code: StrataErrorCode;

  constructor(code: StrataErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StrataError';
    this.code = code;
  }
}
