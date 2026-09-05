import { describe, expect, it } from 'vitest';
import { normalizeImportedIndirectOptions, validateImportedIndirectSize } from '../../packages/core/src/imported/imported-indirect-options.js';
import type { ImportedIndirectOptions } from '../../packages/core/src/imported/imported-indirect-types.js';

const limits = { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024, maxComputeWorkgroupsPerDimension: 65535 };

describe('pure imported indirect preflight', () => {
  it('returns independent normalized options without modifying the caller', () => {
    const defaults = normalizeImportedIndirectOptions();
    expect(defaults).toEqual({ maxPixels: 262144, pixelBatch: 4096, maxSamples: 64, maxVisits: 4096, seed: 1337 });
    expect(normalizeImportedIndirectOptions()).not.toBe(defaults);
    const input = Object.freeze({ maxSamples: 8 });
    expect(normalizeImportedIndirectOptions(input)).toEqual({ ...defaults, maxSamples: 8 });
    expect(input).toEqual({ maxSamples: 8 });
  });

  it('accepts exact option bounds and rejects invalid values without a device', () => {
    for (const [key, min, max] of [['maxPixels', 1, 1048576], ['pixelBatch', 1, 65536], ['maxSamples', 1, 1024], ['maxVisits', 1, 524287], ['seed', 0, 0xffffffff]] as const) {
      expect(normalizeImportedIndirectOptions({ [key]: min })[key]).toBe(min);
      expect(normalizeImportedIndirectOptions({ [key]: max })[key]).toBe(max);
      for (const value of [min - 1, max + 1, min + .5, NaN, Infinity, '1', undefined]) {
        expect(() => normalizeImportedIndirectOptions({ [key]: value } as ImportedIndirectOptions)).toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
      }
    }
    for (const value of [null, [], 3, 'options']) expect(() => normalizeImportedIndirectOptions(value as ImportedIndirectOptions)).toThrow(/options must be an object/);
  });

  it('rejects invalid dimensions and enforces the explicit pixel cap independently of aspect', () => {
    const options = normalizeImportedIndirectOptions({ maxPixels: 64 });
    for (const [width, height] of [[0, 1], [1, -1], [1.5, 2], [1, NaN], [Infinity, 1], [8193, 1], [1, 8193]]) {
      expect(() => validateImportedIndirectSize(limits, width!, height!, options)).toThrow(expect.objectContaining({ code: 'INVALID_SIZE' }));
    }
    expect(() => validateImportedIndirectSize(limits, 8, 8, options)).not.toThrow();
    expect(() => validateImportedIndirectSize(limits, 64, 1, options)).not.toThrow();
    expect(() => validateImportedIndirectSize(limits, 65, 1, options)).toThrow(/maxPixels=64/);
    expect(() => validateImportedIndirectSize(limits, 8, 9, options)).toThrow(/smaller explicit preview/);
  });

  it('enforces both storage bounds and both compute dispatch dimensions before allocation', () => {
    const options = normalizeImportedIndirectOptions({ maxPixels: 256, pixelBatch: 64 });
    const exact = { ...limits, maxBufferSize: 4096, maxStorageBufferBindingSize: 4096 };
    expect(() => validateImportedIndirectSize(exact, 16, 8, options)).not.toThrow();
    expect(() => validateImportedIndirectSize({ ...exact, maxBufferSize: 4095 }, 16, 8, options)).toThrow(/storage limits/);
    expect(() => validateImportedIndirectSize({ ...exact, maxStorageBufferBindingSize: 4095 }, 16, 8, options)).toThrow(/storage limits/);
    const workgroups = { ...limits, maxComputeWorkgroupsPerDimension: 2 };
    expect(() => validateImportedIndirectSize(workgroups, 16, 16, options)).not.toThrow();
    expect(() => validateImportedIndirectSize(workgroups, 17, 8, options)).toThrow(/workgroup limits/);
    expect(() => validateImportedIndirectSize(workgroups, 8, 17, options)).toThrow(/workgroup limits/);
    expect(() => validateImportedIndirectSize(workgroups, 16, 16, normalizeImportedIndirectOptions({ pixelBatch: 256 }))).toThrow(/workgroup limits/);
    // A configured batch larger than this viewport only dispatches its existing pixels.
    expect(() => validateImportedIndirectSize(workgroups, 8, 8, normalizeImportedIndirectOptions({ pixelBatch: 65536 }))).not.toThrow();
  });
});
