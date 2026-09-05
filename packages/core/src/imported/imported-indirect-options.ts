import { StrataError } from '../errors.js';
import type { ImportedIndirectOptions, ImportedIndirectTraceOptions } from './imported-indirect-types.js';

const defaults: Required<ImportedIndirectTraceOptions> = { maxPixels: 262144, pixelBatch: 4096, maxSamples: 64, maxVisits: 4096, seed: 1337 };

/** Pure preflight shared by preview activation and the effect; imports no shaders. */
export function normalizeImportedIndirectOptions(options: ImportedIndirectOptions = {}): Required<ImportedIndirectTraceOptions> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new StrataError('INVALID_OPTIONS', 'Imported indirect: options must be an object.');
  const next = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof ImportedIndirectTraceOptions)[]) {
    if (Object.prototype.hasOwnProperty.call(options, key)) next[key] = options[key]!;
  }
  for (const [key, min, max] of [['maxPixels', 1, 1048576], ['pixelBatch', 1, 65536], ['maxSamples', 1, 1024], ['maxVisits', 1, 524287], ['seed', 0, 0xffffffff]] as const) {
    const value = next[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new StrataError('INVALID_OPTIONS', `Imported indirect: ${key} is outside [${min}, ${max}].`);
    if (!Number.isInteger(value)) throw new StrataError('INVALID_OPTIONS', `Imported indirect: ${key} must be an integer.`);
  }
  return next;
}

/** Call with normalized options before CPU scene preparation or any GPU allocation. */
export function validateImportedIndirectSize(
  limits: Pick<GPUSupportedLimits, 'maxTextureDimension2D' | 'maxBufferSize' | 'maxStorageBufferBindingSize' | 'maxComputeWorkgroupsPerDimension'>,
  width: number, height: number, normalizedOptions: Required<ImportedIndirectTraceOptions>,
): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > limits.maxTextureDimension2D || height > limits.maxTextureDimension2D) throw new StrataError('INVALID_SIZE', 'Imported indirect dimensions must fit GPU texture limits.');
  const pixels = width * height;
  if (pixels > normalizedOptions.maxPixels) throw new StrataError('UNSUPPORTED_LIMIT', `Imported indirect preview exceeds maxPixels=${normalizedOptions.maxPixels}; choose a smaller explicit preview resolution.`);
  if (pixels * 32 > Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize)) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported indirect pixel state exceeds GPU storage limits.');
  if (Math.ceil(width / 8) > limits.maxComputeWorkgroupsPerDimension || Math.ceil(height / 8) > limits.maxComputeWorkgroupsPerDimension || Math.ceil(Math.min(pixels, normalizedOptions.pixelBatch) / 64) > limits.maxComputeWorkgroupsPerDimension) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported indirect dispatch exceeds GPU workgroup limits.');
}

/** Independently normalized creation capability; never part of transport keys. */
export function normalizeImportedSpatialDenoise(options: ImportedIndirectOptions = {}): boolean {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new StrataError('INVALID_OPTIONS', 'Imported indirect: options must be an object.');
  if (options.spatialDenoise !== undefined && typeof options.spatialDenoise !== 'boolean') throw new StrataError('INVALID_OPTIONS', 'Imported indirect: spatialDenoise must be boolean.');
  return options.spatialDenoise ?? false;
}

/** The capability has a lifetime limit, including while its display mode is off. */
export function validateImportedIndirectCapability(
  limits: Pick<GPUSupportedLimits, 'maxStorageBuffersPerShaderStage' | 'maxBufferSize' | 'maxStorageBufferBindingSize'>,
  width: number, height: number, spatialDenoise: boolean,
): void {
  if (!spatialDenoise) return;
  if (limits.maxStorageBuffersPerShaderStage < 7) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported spatial denoising requires seven storage buffers per shader stage.');
  if (width * height > 65536) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported spatial denoising has a 65,536-pixel lifetime viewport limit, including while filtering is off.');
  if (16 + width * height * 32 > Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize)) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported spatial denoising guides exceed GPU storage limits.');
}
