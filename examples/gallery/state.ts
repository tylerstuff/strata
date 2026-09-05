import type { FrameMetrics, GpuTiming } from '@strata-engine/core';

export interface GalleryFrameIdentity {
  engineEpoch: number;
  viewRevision: number;
  modelId: string | null;
}

export interface GalleryMeasurementSnapshot {
  cpuSubmissionMs: number | null;
  submittedFrameId: number | null;
  callbackIntervalMs: number | null;
  gpu: {
    frameId: number | null;
    /** Envelope of recorded pass boundaries, not frame completion or presentation. */
    spanMs: number | null;
    passCount: number;
    samples: readonly GpuTiming[];
  };
}

interface RecordedFrame {
  identity: GalleryFrameIdentity;
  cpuSubmissionMs: number;
  samples: Map<string, GpuTiming>;
  truncated: boolean;
}

const maxFrames = 256;
const maxPasses = 16;

function matches(a: GalleryFrameIdentity, b: GalleryFrameIdentity): boolean {
  return a.engineEpoch === b.engineEpoch && a.viewRevision === b.viewRevision && a.modelId === b.modelId;
}

function nonnegative(value: number): boolean { return Number.isFinite(value) && value >= 0; }

/** Bounded live telemetry. The controller remains responsible for engine ownership. */
export class GalleryMeasurements {
  readonly #frames = new Map<number, RecordedFrame>();
  #engineEpoch: number | null = null;
  #lastFrameId = 0;
  #callbackTimestamp: number | null = null;
  #callbackInterval: number | null = null;

  recordFrame(metrics: FrameMetrics, identity: GalleryFrameIdentity): void {
    if (!Number.isSafeInteger(metrics.frameId) || metrics.frameId < 1 || !nonnegative(metrics.cpuSubmissionMs)) return;
    if (this.#engineEpoch !== identity.engineEpoch) {
      this.clear();
      this.#engineEpoch = identity.engineEpoch;
    }
    // Core submission IDs increase within an engine. Repeated observations must
    // not relabel an already recorded frame with a different view or model.
    if (metrics.frameId <= this.#lastFrameId) return;
    this.#lastFrameId = metrics.frameId;
    this.#frames.set(metrics.frameId, {
      identity: { ...identity }, cpuSubmissionMs: metrics.cpuSubmissionMs,
      samples: new Map(), truncated: false,
    });
    if (this.#frames.size > maxFrames) this.#frames.delete(this.#frames.keys().next().value!);
  }

  /**
   * Feed only drains from the current engine, after recording its submissions.
   * Core samples contain no engine epoch, so the controller must discard callbacks
   * from retired engines; their reused numeric frame IDs cannot be disambiguated here.
   */
  recordGpuTimings(samples: readonly GpuTiming[]): void {
    for (const sample of samples) {
      const frame = this.#frames.get(sample.frameId);
      if (!frame || typeof sample.pass !== 'string' || !sample.pass.length || sample.pass.length > 128
        || !nonnegative(sample.gpuMs) || frame.samples.has(sample.pass)) continue;
      if (frame.samples.size >= maxPasses) { frame.truncated = true; continue; }
      const validBoundaries = sample.startOffsetMs !== undefined && sample.endOffsetMs !== undefined
        && nonnegative(sample.startOffsetMs) && nonnegative(sample.endOffsetMs)
        && sample.endOffsetMs >= sample.startOffsetMs;
      frame.samples.set(sample.pass, {
        frameId: sample.frameId, pass: sample.pass, gpuMs: sample.gpuMs,
        ...(validBoundaries ? { startOffsetMs: sample.startOffsetMs!, endOffsetMs: sample.endOffsetMs! } : {}),
      });
    }
  }

  recordCallback(timestampMs: number): void {
    if (!nonnegative(timestampMs)) { this.resetCallback(); return; }
    const interval = this.#callbackTimestamp === null ? null : timestampMs - this.#callbackTimestamp;
    this.#callbackInterval = interval !== null && interval > 0 && Number.isFinite(interval) ? interval : null;
    this.#callbackTimestamp = timestampMs;
  }

  resetCallback(): void {
    this.#callbackTimestamp = null;
    this.#callbackInterval = null;
  }

  clear(): void {
    this.#frames.clear();
    this.#engineEpoch = null;
    this.#lastFrameId = 0;
    this.resetCallback();
  }

  snapshot(identity: GalleryFrameIdentity): GalleryMeasurementSnapshot {
    let latest: { id: number; frame: RecordedFrame } | undefined;
    let timed: { id: number; frame: RecordedFrame } | undefined;
    for (const [id, frame] of this.#frames) {
      if (!matches(frame.identity, identity)) continue;
      latest = { id, frame };
      if (frame.samples.size) timed = { id, frame };
    }
    const samples = timed ? [...timed.frame.samples.values()].map(sample => Object.freeze({ ...sample })) : [];
    const spanAvailable = samples.length > 0 && !timed!.frame.truncated
      && samples.every(sample => sample.startOffsetMs !== undefined && sample.endOffsetMs !== undefined);
    return {
      cpuSubmissionMs: latest?.frame.cpuSubmissionMs ?? null,
      submittedFrameId: latest?.id ?? null,
      callbackIntervalMs: this.#callbackInterval,
      gpu: {
        frameId: timed?.id ?? null,
        spanMs: spanAvailable ? Math.max(...samples.map(sample => sample.endOffsetMs!)) - Math.min(...samples.map(sample => sample.startOffsetMs!)) : null,
        passCount: samples.length,
        samples: Object.freeze(samples),
      },
    };
  }
}
