import { StrataError } from '../errors.js';
import type { ImportedIndirectOptions } from './imported-indirect-types.js';

const defaults: Required<ImportedIndirectOptions> = { maxPixels: 262144, pixelBatch: 4096, maxSamples: 64, maxVisits: 4096, seed: 1337 };

/** Pure preflight shared by preview activation and the effect; imports no shaders. */
export function normalizeImportedIndirectOptions(options: ImportedIndirectOptions = {}): Required<ImportedIndirectOptions> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new StrataError('INVALID_OPTIONS', 'Imported indirect: options must be an object.');
  const next = { ...defaults, ...options };
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
  width: number, height: number, normalizedOptions: Required<ImportedIndirectOptions>,
): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > limits.maxTextureDimension2D || height > limits.maxTextureDimension2D) throw new StrataError('INVALID_SIZE', 'Imported indirect dimensions must fit GPU texture limits.');
  const pixels = width * height;
  if (pixels > normalizedOptions.maxPixels) throw new StrataError('UNSUPPORTED_LIMIT', `Imported indirect preview exceeds maxPixels=${normalizedOptions.maxPixels}; choose a smaller explicit preview resolution.`);
  if (pixels * 32 > Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize)) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported indirect pixel state exceeds GPU storage limits.');
  if (Math.ceil(width / 8) > limits.maxComputeWorkgroupsPerDimension || Math.ceil(height / 8) > limits.maxComputeWorkgroupsPerDimension || Math.ceil(Math.min(pixels, normalizedOptions.pixelBatch) / 64) > limits.maxComputeWorkgroupsPerDimension) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported indirect dispatch exceeds GPU workgroup limits.');
}
