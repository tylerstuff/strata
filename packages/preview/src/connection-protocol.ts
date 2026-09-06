import { canonicalJson } from '@strata-engine/authoring';
import { PreviewError } from './errors.js';

export const PREVIEW_CONNECTION_VERSION = 1 as const;
export const PREVIEW_CONNECTION_LIMITS = Object.freeze({
  inputLineBytes: 64 * 1024,
  responseBytes: 4 * 1024 * 1024,
  outputQueueBytes: 32 * 1024 * 1024,
  responseBuffers: 8,
  outstandingRequests: 8,
  ordinaryRequests: 6,
  reservedControlRequests: 2,
  recentRequests: 32,
  mutations: 1,
  inspections: 1,
  defaultTimeoutMs: 30_000,
  defaultCleanupTimeoutMs: 5_000,
  maximumTimeoutMs: 300_000,
});

export interface ConnectionDiagnostic {
  code: string;
  stage: string;
  message: string;
  details: Record<string, unknown>;
}

export type ConnectionResponse =
  | { version: 1; id: number; ok: true; result: unknown }
  | { version: 1; id: number | null; ok: false; error: ConnectionDiagnostic };

/** Host seam shared by the stdio transport and CPU-only consumers. */
export interface PreviewConnectionHandler {
  readonly closing: boolean;
  request(value: unknown): Promise<ConnectionResponse>;
  /** Permanent, idempotent and bounded. May reject with incomplete-cleanup evidence. */
  close(): Promise<void>;
}

export function connectionFailure(code: string, stage: string, message: string, details: Record<string, unknown> = {}): PreviewError {
  return new PreviewError(code, stage, message, details);
}

export function connectionDiagnostic(error: unknown): ConnectionDiagnostic {
  if (error instanceof PreviewError) {
    let details: Record<string, unknown>;
    try { details = JSON.parse(canonicalJson(error.details)) as Record<string, unknown>; }
    catch { details = { detailsUnavailable: true }; }
    return { code: error.code, stage: error.stage, message: error.message, details };
  }
  return { code: 'CONNECTION_FAILED', stage: 'connection', message: error instanceof Error ? error.message : 'Connection operation failed.', details: {} };
}

export function connectionErrorResponse(id: number | null, error: unknown): ConnectionResponse {
  return { version: 1, id, ok: false, error: connectionDiagnostic(error) };
}
