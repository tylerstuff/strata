import { StrataError } from '../errors.js';

/** Per-frame exposure compensation in stops; this does not alter scene radiance. */
export function normalizeExposureEV(value: number | undefined): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -16 || value > 16) {
    throw new StrataError('INVALID_OPTIONS', 'exposureEV must be finite and between -16 and 16; positive values brighten presentation.');
  }
  return value;
}
