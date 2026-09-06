import { describe, expect, it } from 'vitest';
import { StrataError } from '../../packages/core/src/errors.js';
import { importedEnvironmentTextureBytes, importedTextureBudget } from '../../packages/core/src/imported/imported-limits.js';
import { estimateImportedTextureAllocation, importedTextureExtent } from '../../packages/core/src/imported/imported-texture-plan.js';
import type { ImportedTextureAllocationOptions } from '../../packages/core/src/imported/imported-texture-plan.js';
import type { ImportedAsset, ImportedImage, ImportedMaterial, ImportedTexture } from '../../packages/core/src/imported/imported-types.js';

type Input = Pick<ImportedAsset, 'materials' | 'images'>;
const material: ImportedMaterial = { name: 'generated', baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: .5,
  emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1, occlusionStrength: 1, alphaMode: 'OPAQUE', alphaCutoff: .5, doubleSided: false };
const options: ImportedTextureAllocationOptions = { maxTextureDimension: 8192, maxTextureDimension2D: 16384 };
const image = (width: number, height: number): ImportedImage => ({ name: 'generated metadata', mimeType: 'image/png', bytes: new Uint8Array(), width, height });
const texture = (index: number): ImportedTexture => ({ image: index, sampler: { magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 } });
const empty: Input = { materials: [], images: [] };
function invalid(run: () => unknown): void {
  expect(run).toThrow(StrataError);
  expect(run).toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
}

describe('CPU imported texture allocation plan', () => {
  it('includes both fixed generated environments, the lookup and two white fallbacks with no material images', () => {
    // Two six-face RGBA16F cubes at edges 64 through 1, plus one 64-square RG16F lookup.
    const fixedBytes = 2 * 6 * 8 * (4096 + 1024 + 256 + 64 + 16 + 4 + 1) + 64 * 64 * 4;
    expect(importedEnvironmentTextureBytes).toBe(fixedBytes);
    expect(importedTextureBudget).toBe(536870912);
    expect(estimateImportedTextureAllocation(empty, options)).toEqual({
      requestedMaxTextureDimension: 8192, effectiveMaxTextureDimension: 8192, gpuTextureBytes: fixedBytes + 8,
      textureBudgetBytes: 536870912, fitsBudget: true, textures: [],
    });
  });

  it('reports two 8192-square role copies over budget and a 4096 cap that fits, without allocating image pixels', () => {
    const asset: Input = { materials: [{ ...material, baseColorTexture: texture(0), normalTexture: texture(1) }],
      images: [image(8192, 8192), image(8192, 8192)] };
    const full = estimateImportedTextureAllocation(asset, options);
    expect(full.gpuTextureBytes).toBe(716368528);
    expect(full.fitsBudget).toBe(false);
    expect(full.textures.map(t => [t.colorSpace, t.mipLevels, t.gpuBytes])).toEqual([
      ['srgb', 14, 357913940], ['linear', 14, 357913940],
    ]);
    const capped = estimateImportedTextureAllocation(asset, { ...options, maxTextureDimension: 4096 });
    expect(capped.gpuTextureBytes).toBe(179497616);
    expect(capped.fitsBudget).toBe(true);
    expect(capped.textures.map(t => [t.sourceWidth, t.uploadWidth, t.mipLevels, t.gpuBytes])).toEqual([
      [8192, 4096, 13, 89478484], [8192, 4096, 13, 89478484],
    ]);
    expect(asset.images[0]!.width).toBe(8192);
    expect(asset.images[0]!.bytes.byteLength).toBe(0);
  });

  it('deduplicates by image and color space across materials and sampler choices, including unlit materials', () => {
    const a = texture(0), b = { ...texture(0), sampler: { ...a.sampler, minFilter: 9728 as const } };
    const asset: Input = { materials: [
      { ...material, baseColorTexture: a, metallicRoughnessTexture: b, normalTexture: a, occlusionTexture: b, emissiveTexture: a },
      { ...material, unlit: true, baseColorTexture: b, metallicRoughnessTexture: a, emissiveTexture: b },
    ], images: [image(8, 4)] };
    const plan = estimateImportedTextureAllocation(asset, { ...options, maxTextureDimension: 4 });
    expect(plan.textures).toEqual([
      { image: 0, sourceWidth: 8, sourceHeight: 4, uploadWidth: 4, uploadHeight: 2, colorSpace: 'srgb', mipLevels: 3, gpuBytes: 44 },
      { image: 0, sourceWidth: 8, sourceHeight: 4, uploadWidth: 4, uploadHeight: 2, colorSpace: 'linear', mipLevels: 3, gpuBytes: 44 },
    ]);
    expect(plan.gpuTextureBytes).toBe(540736);
  });

  it('uses the smaller device cap, preserves aspect ratio and does not count unreferenced images', () => {
    const asset: Input = { materials: [{ ...material, occlusionTexture: texture(0) }], images: [image(1, 16384), image(16384, 16384)] };
    const plan = estimateImportedTextureAllocation(asset, { maxTextureDimension: 4096, maxTextureDimension2D: 1024 });
    expect(plan.requestedMaxTextureDimension).toBe(4096);
    expect(plan.effectiveMaxTextureDimension).toBe(1024);
    expect(plan.textures).toEqual([
      { image: 0, sourceWidth: 1, sourceHeight: 16384, uploadWidth: 1, uploadHeight: 1024, colorSpace: 'linear', mipLevels: 11, gpuBytes: 8188 },
    ]);
    expect(plan.gpuTextureBytes).toBe(548836);
  });

  it('does not upscale images or depend on encoded bytes, samplers or unrelated material values', () => {
    const metadataOnly = { materials: [{ baseColorTexture: { image: 0 } }], images: [{ width: 3, height: 5 }] } as unknown as Input;
    const plan = estimateImportedTextureAllocation(metadataOnly, options);
    expect(plan.textures[0]).toEqual({ image: 0, sourceWidth: 3, sourceHeight: 5, uploadWidth: 3, uploadHeight: 5,
      colorSpace: 'srgb', mipLevels: 3, gpuBytes: 72 }); // 3x5, 1x2, 1x1 RGBA8.
  });

  it.each([
    null, [], {}, { materials: {}, images: [] }, { materials: [], images: {} },
    { materials: new Array(4097), images: [] }, { materials: [], images: new Array(1025) },
    { materials: [null], images: [] }, { materials: [[]], images: [] }, { materials: new Array(1), images: [] },
  ])('rejects malformed or unbounded allocation containers: %j', value => {
    invalid(() => estimateImportedTextureAllocation(value as unknown as Input, options));
  });

  it.each([null, [], {}, { maxTextureDimension: 4 }, { maxTextureDimension2D: 4 }])('rejects malformed edge options: %j', value => {
    invalid(() => estimateImportedTextureAllocation(empty, value as unknown as ImportedTextureAllocationOptions));
  });

  it.each([0, -1, .5, NaN, Infinity, 16385, Number.MAX_SAFE_INTEGER, '4096'])('rejects invalid requested/device edges: %s', value => {
    invalid(() => estimateImportedTextureAllocation(empty, { ...options, maxTextureDimension: value as number }));
    invalid(() => estimateImportedTextureAllocation(empty, { ...options, maxTextureDimension2D: value as number }));
  });

  it.each([null, [], 0, {}, { image: -1 }, { image: .5 }, { image: NaN }, { image: '0' }, { image: 1 }])('rejects malformed image references: %j', ref => {
    const asset = { materials: [{ ...material, baseColorTexture: ref }], images: [image(2, 2)] } as unknown as Input;
    invalid(() => estimateImportedTextureAllocation(asset, options));
  });

  it.each([null, [], {}, { width: 1 }, { width: 0, height: 1 }, { width: 1, height: Infinity },
    { width: 16385, height: 1 }, { width: 1.5, height: 2 }, { width: '8', height: 8 }])('rejects invalid referenced image metadata: %j', metadata => {
    const asset = { materials: [{ ...material, normalTexture: texture(0) }], images: [metadata] } as unknown as Input;
    invalid(() => estimateImportedTextureAllocation(asset, options));
  });
});

describe('imported upload extent', () => {
  it.each([
    [8, 4, 4, { width: 4, height: 2, mipLevels: 3, bytes: 44 }],
    [1, 9, 4, { width: 1, height: 4, mipLevels: 3, bytes: 28 }],
    [7, 3, 16384, { width: 7, height: 3, mipLevels: 3, bytes: 100 }],
    [3, 5, 4, { width: 2, height: 4, mipLevels: 3, bytes: 44 }],
    [16384, 16384, 1, { width: 1, height: 1, mipLevels: 1, bytes: 4 }],
  ] as const)('accounts for %sx%s at cap %s', (width, height, edge, expected) => {
    expect(importedTextureExtent(width, height, edge)).toEqual(expected);
  });
  it.each([0, -1, .5, NaN, Infinity, 16385])('rejects invalid dimensions or caps: %s', value => {
    invalid(() => importedTextureExtent(value, 1, 1));
    invalid(() => importedTextureExtent(1, value, 1));
    invalid(() => importedTextureExtent(1, 1, value));
  });
});


describe('static RGBM lightmap allocation', () => {
  it('retains atlas resolution without mipmaps, counts its memory once', () => {
    const m = {...material, lightmapTexture: texture(0), lightmapRange: 32};
    const plan = estimateImportedTextureAllocation({materials: [m,m], images: [image(4096,4096)]}, {...options,maxTextureDimension:256});
    expect(plan.textures).toHaveLength(1);
    expect(plan.textures[0]).toMatchObject({uploadWidth:4096,uploadHeight:4096,mipLevels:1,gpuBytes:67108864,colorSpace:'linear'});
  });
  it('rejects incompatible role aliasing and unsupported device dimensions', () => {
    const m = {...material, lightmapTexture: texture(0), lightmapRange:32};
    invalid(()=>estimateImportedTextureAllocation({materials:[m,{...material,normalTexture:texture(0)}],images:[image(4096,4096)]},options));
    invalid(()=>estimateImportedTextureAllocation({materials:[m],images:[image(4096,4096)]},{...options,maxTextureDimension2D:2048}));
  });
});
