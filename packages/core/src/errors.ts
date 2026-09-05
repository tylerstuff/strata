import type { SceneCommitReceipt } from './types.js';

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
  | 'SCENE_LOAD_ABORTED'
  | 'GPU_VALIDATION_FAILED'
  | 'GPU_TIMING_TIMEOUT'
  | 'GPU_WORK_TIMEOUT'
  | 'GPU_WORK_FAILED'
  | 'RENDER_FAILED'
  | 'PRESENTATION_HDR_FAULT';

/** A runtime failure with a stable code and, when available, its original cause. */
export class StrataError extends Error {
  readonly code: StrataErrorCode;

  constructor(code: StrataErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StrataError';
    this.code = code;
  }
}

/** Retirement failed after an atomic scene swap; the committed identity remains active. */
export class SceneCommitError extends StrataError {
  readonly stage = 'retire' as const;
  readonly commitOccurred = true;
  readonly committedScene: SceneCommitReceipt;

  constructor(committedScene: SceneCommitReceipt, cause: unknown) {
    super('SCENE_LOAD_FAILED', 'The scene committed, but retiring the previous scene failed.', { cause });
    this.name = 'SceneCommitError';
    this.committedScene = committedScene;
  }
}
