import { validateBlockCompression } from './imported-compression.js';
import { StrataError } from '../errors.js';
import type { ImportedAsset } from './imported-types.js';
import { importedEnvironmentTextureBytes, importedTextureBudget } from './imported-limits.js';

export interface ImportedTextureAllocationOptions {
  /** Optional six-face local shadow edge, including immutable and working depth. */
  readonly pointShadowMapSize?: 512 | 1024;
  /** True only when the requested device enabled texture-compression-bc. */
  readonly textureCompressionBC?: boolean;
  /** Requested upload edge, a positive integer up to 16384. */
  readonly maxTextureDimension: number;
  /** Device texture edge limit, a positive integer up to 16384. */
  readonly maxTextureDimension2D: number;
}

export interface ImportedTextureAllocationRecord {
  readonly format?: GPUTextureFormat;
  readonly sourceMip?: number;
  readonly image: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly uploadWidth: number;
  readonly uploadHeight: number;
  readonly colorSpace: 'srgb' | 'linear';
  readonly mipLevels: number;
  readonly gpuBytes: number;
}

export interface ImportedTextureAllocationEstimate {
  readonly requestedMaxTextureDimension: number;
  readonly effectiveMaxTextureDimension: number;
  /** Texture payload only: all role copies and mip levels, white fallbacks, disabled point-light placeholder and generated environments. */
  readonly gpuTextureBytes: number;
  readonly textureBudgetBytes: number;
  readonly fitsBudget: boolean;
  /** One record per referenced image/color-space pair, in first material/role encounter order. */
  readonly textures: readonly ImportedTextureAllocationRecord[];
}

function fail(message: string): never { throw new StrataError('INVALID_OPTIONS', `Invalid imported scene: ${message}`); }
function validEdge(value: number): boolean { return Number.isSafeInteger(value) && value > 0 && value <= 16384; }

/** Aspect-preserving upload dimensions and complete RGBA8 mip-chain payload; no image decoding or GPU access. */
export function importedTextureExtent(width: number, height: number, edge: number): { width: number; height: number; mipLevels: number; bytes: number } {
  if (![width, height, edge].every(validEdge)) fail('image dimensions/texture cap must be positive integers up to 16384.');
  const scale = Math.min(1, edge / Math.max(width, height)); const w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale));
  const mipLevels = Math.floor(Math.log2(Math.max(w, h))) + 1; let bytes = 0;
  for (let level = 0; level < mipLevels; level++) bytes += Math.max(1, w >> level) * Math.max(1, h >> level) * 4;
  return { width: w, height: h, mipLevels, bytes };
}

const textureRoles = ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'occlusionTexture', 'emissiveTexture', 'lightmapTexture'] as const;

/**
 * Estimates retained imported-scene texture payload without decoding, allocating GPU resources or importing environment data.
 * Validates bounded material/image arrays, texture references, referenced image dimensions and both edge limits.
 * Does not validate encoded image bytes/MIME, samplers, PBR values or geometry; scene creation validates those separately.
 * Unreferenced images allocate nothing. Sampler settings do not change the complete mip chains that the renderer allocates.
 * Valid inputs that exceed the budget return fitsBudget=false. Driver padding, buffers and render targets are excluded.
 */
export function estimateImportedTextureAllocation(
  asset: Pick<ImportedAsset, 'materials' | 'images'>,
  options: ImportedTextureAllocationOptions,
): ImportedTextureAllocationEstimate {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset) || !Array.isArray(asset.materials) || !Array.isArray(asset.images)
    || asset.materials.length > 4096 || asset.images.length > 1024) fail('texture allocation needs bounded material and image arrays.');
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || !validEdge(options.maxTextureDimension) || !validEdge(options.maxTextureDimension2D)) fail('texture edge limits must be positive integers up to 16384.');
  if (options.textureCompressionBC !== undefined && typeof options.textureCompressionBC !== 'boolean') fail('textureCompressionBC must be boolean.');
  const requestedMaxTextureDimension = options.maxTextureDimension;
  const effectiveMaxTextureDimension = Math.min(requestedMaxTextureDimension, options.maxTextureDimension2D);
  const textures: ImportedTextureAllocationRecord[] = [], seen = new Set<string>();
  if (options.pointShadowMapSize !== undefined && options.pointShadowMapSize !== 512 && options.pointShadowMapSize !== 1024) fail('point shadow edge must be 512 or 1024.');
  let gpuTextureBytes = 8 + importedEnvironmentTextureBytes + (options.pointShadowMapSize ? options.pointShadowMapSize ** 2 * 48 : 24);
  const lightmaps = new Set(asset.materials.flatMap(m => m?.lightmapTexture ? [m.lightmapTexture.image] : []));
  for (const material of asset.materials) {
    if (!material || typeof material !== 'object' || Array.isArray(material)) fail('material must be an object.');
    for (const role of textureRoles) {
      const ref = material[role];
      if (ref === undefined) continue;
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail('material texture reference must be an object.');
      if (!Number.isSafeInteger(ref.image) || ref.image < 0 || ref.image >= asset.images.length) fail('material references an absent image.');
      const isLightmap = role === 'lightmapTexture';
      if (!isLightmap && lightmaps.has(ref.image)) fail('lightmap images cannot be reused by other texture roles.');
      const colorSpace = role === 'baseColorTexture' || role === 'emissiveTexture' ? 'srgb' : 'linear';
      const key = `${ref.image}/${colorSpace}`;
      const image = asset.images[ref.image];
      if (!image || typeof image !== 'object' || Array.isArray(image)) fail('referenced image metadata must be an object.');
      if (image.compressed?.format === 'bc5-rg-unorm' && role !== 'normalTexture') fail('BC5 variants may only be bound as normal maps.');
      if (seen.has(key)) continue;
      let extent = importedTextureExtent(image.width, image.height, effectiveMaxTextureDimension);
      if (isLightmap) {
        if (image.compressed || Math.max(image.width, image.height) > options.maxTextureDimension2D) fail('lightmaps require uncompressed PNGs within the device edge limit.');
        extent = { width: image.width, height: image.height, mipLevels: 1, bytes: image.width * image.height * 4 };
      }
      let format: GPUTextureFormat | undefined, sourceMip: number | undefined;
      if (image.compressed) {
        validateBlockCompression(image.compressed, image.width, image.height);
        if (image.compressed.format === 'bc5-rg-unorm' && role !== 'normalTexture') fail('BC5 variants may only be bound as normal maps.');
        if (options.textureCompressionBC && effectiveMaxTextureDimension >= 4) {
          sourceMip = Math.max(0, Math.ceil(Math.log2(Math.max(image.width, image.height) / effectiveMaxTextureDimension)));
          const w = Math.max(1, image.width >> sourceMip), h = Math.max(1, image.height >> sourceMip);
          if (w >= 4 && h >= 4) {
            const base = image.compressed.format;
            format = (colorSpace === 'srgb' ? `${base}-srgb` : base) as GPUTextureFormat;
            const mips = image.compressed.mips.slice(sourceMip);
            extent = { width: w, height: h, mipLevels: mips.length, bytes: mips.reduce((sum: number, mip: Uint8Array) => sum + mip.byteLength, 0) };
          } else sourceMip = undefined;
        }
      }
      textures.push({ image: ref.image, sourceWidth: image.width, sourceHeight: image.height,
        ...(format === undefined ? {} : { format, sourceMip: sourceMip! }), uploadWidth: extent.width, uploadHeight: extent.height, colorSpace, mipLevels: extent.mipLevels, gpuBytes: extent.bytes });
      gpuTextureBytes += extent.bytes;
      seen.add(key);
    }
  }
  return { requestedMaxTextureDimension, effectiveMaxTextureDimension, gpuTextureBytes,
    textureBudgetBytes: importedTextureBudget, fitsBudget: gpuTextureBytes <= importedTextureBudget, textures };
}
