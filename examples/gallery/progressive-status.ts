import type { ImportedTelemetry } from '@strata-engine/core';

export interface ProgressiveCounterIdentity {
  readonly engineEpoch: number;
  readonly sceneGeneration: number | null;
  readonly countersPending: boolean;
}

export interface ProgressiveCounterDescription {
  readonly identity: string;
  readonly message: string;
  readonly counts: {
    readonly attempted: number | null;
    readonly completed: number | null;
    readonly exhausted: number | null;
    readonly invalid: number | null;
  };
}

/** The caller must pair telemetry with its owning engine and committed scene. */
export function describeProgressiveCounters(
  telemetry: ImportedTelemetry['indirect'] | null,
  identity: ProgressiveCounterIdentity,
): ProgressiveCounterDescription {
  const progress = telemetry?.progress;
  const sample = telemetry?.sampleCounters;
  const nonnegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0;
  const matching = Boolean(progress && sample && !progress.pendingReset && sample.revision === progress.revision
    && nonnegativeInteger(sample.submittedFrames) && sample.submittedFrames <= progress.submittedFrames
    && [sample.attempted, sample.completed, sample.exhausted, sample.invalid].every(nonnegativeInteger));
  const label = `Engine ${identity.engineEpoch} · scene ${identity.sceneGeneration ?? 'none'} · accumulation ${progress?.revision ?? 'none'} · readback ${matching ? `${sample!.submittedFrames} submissions` : 'unavailable'}`;
  const unavailable = (message: string): ProgressiveCounterDescription => ({ identity: label, message,
    counts: { attempted: null, completed: null, exhausted: null, invalid: null } });
  if (!progress) return unavailable('No progressive telemetry is available.');
  if (progress.pendingReset) return unavailable('Accumulation reset is pending; previous sample counters are unavailable.');
  if (!sample) return unavailable(identity.countersPending ? 'GPU sample readback is pending.' : 'No GPU sample readback is available.');
  if (sample.revision !== progress.revision) return unavailable('Sample counters belong to a different accumulation revision.');
  if (!matching) return unavailable('GPU sample counters have inconsistent counts or submission tags.');

  const messages = ['GPU sample counters are cumulative within this accumulation revision.'];
  if (sample.submittedFrames < progress.submittedFrames) {
    messages.push(`This snapshot follows ${sample.submittedFrames} submissions; current scheduling is at ${progress.submittedFrames}.`);
  }
  if (identity.countersPending) messages.push('A GPU readback is pending; showing the tagged snapshot.');
  if (sample.exhausted > 0 || sample.invalid > 0) {
    messages.push('Unknown paths leave affected pixels displaying direct-only lighting until reset.');
  }
  return { identity: label, message: messages.join(' '),
    counts: { attempted: sample.attempted, completed: sample.completed, exhausted: sample.exhausted, invalid: sample.invalid } };
}
