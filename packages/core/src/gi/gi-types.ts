export interface GiSceneOptions {
  renderer: 'gi';
  doorOpen?: boolean;
  wallColor?: 'red' | 'neutral';
  lightIntensity?: number;
  probesPerUpdate?: number;
  raysPerProbe?: number;
  cameraMode?: 'receiver' | 'overview' | 'tour';
}

/** Partial world-state patches persist. Camera cuts do not invalidate world lighting. */
export interface GiControls {
  enabled?: boolean;
  doorOpen?: boolean;
  wallColor?: 'red' | 'neutral';
  lightIntensity?: number;
  resetCache?: boolean;
}

export interface GiTelemetry {
  readonly [name: string]: number | string | boolean | null;
}

/** Incremental tracing work only; initial normalization/uploads are excluded. */
export interface GiTraceUpdateTelemetry {
  /** Accepted changed CPU targets; value-equivalent no-ops do not advance it. */
  readonly updateCount: number;
  /** Latest target whose whole write plan returned successfully; not GPU completion. */
  readonly queuedUpdateCount: number;
  readonly changedBoxCount: number;
  /** Source geometry generated, excluding material-ID-only edits. */
  readonly regeneratedTriangleCount: number;
  /** Triangle records serialized/compared, including byte-identical results. */
  readonly packedTriangleCount: number;
  readonly refitLeafCount: number;
  readonly refitAncestorCount: number;
  /** Includes a throwing writeBuffer call. */
  readonly attemptedWriteCalls: number;
  /** Calls that returned, including writes preceding a later frame failure. */
  readonly queuedWriteCalls: number;
  readonly queuedUploadBytes: number;
  /** Attempted full-buffer fragmentation fallbacks, including failed attempts. */
  readonly fullBufferFallbackCount: number;
  readonly pendingRangeCount: number;
  readonly pendingUploadBytes: number;
  /** Current retained updater metadata, excluding the existing packed source. */
  readonly metadataBytes: number;
}

/** Preserve the public scalar telemetry bag and count shared trace storage once. */
export function giTraceUpdateFields(update: GiTraceUpdateTelemetry,
  lastSubmittedUpdateCount: number, lastSubmittedFrameId: number | null): GiTelemetry {
  return {
    traceUpdateCount: update.updateCount,
    traceQueuedUpdateCount: update.queuedUpdateCount,
    traceLastSubmittedUpdateCount: lastSubmittedUpdateCount,
    traceLastSubmittedFrameId: lastSubmittedFrameId,
    traceChangedBoxCount: update.changedBoxCount,
    traceRegeneratedTriangleCount: update.regeneratedTriangleCount,
    tracePackedTriangleCount: update.packedTriangleCount,
    traceRefitLeafCount: update.refitLeafCount,
    traceRefitAncestorCount: update.refitAncestorCount,
    traceAttemptedWriteCalls: update.attemptedWriteCalls,
    traceQueuedWriteCalls: update.queuedWriteCalls,
    traceQueuedUploadBytes: update.queuedUploadBytes,
    traceFullBufferFallbackCount: update.fullBufferFallbackCount,
    tracePendingRangeCount: update.pendingRangeCount,
    tracePendingUploadBytes: update.pendingUploadBytes,
    traceMetadataBytes: update.metadataBytes,
  };
}
