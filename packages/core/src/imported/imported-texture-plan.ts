import { StrataError } from '../errors.js';
import type { ImportedAsset } from './imported-types.js';
import { importedEnvironmentTextureBytes, importedTextureBudget } from './imported-limits.js';

export interface ImportedTextureAllocationOptions {
  /** Requested upload edge, a positive integer up to 16384. */
  readonly maxTextureDimension: number;
  /** Device texture edge limit, a positive integer up to 16384. */
  readonly maxTextureDimension2D: number;
}

export interface ImportedTextureAllocationRecord {
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
  /** Texture payload only: all role copies and mip levels, white fallbacks and generated environments. */
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

const textureRoles = ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'occlusionTexture', 'emissiveTexture'] as const;

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
  const requestedMaxTextureDimension = options.maxTextureDimension;
  const effectiveMaxTextureDimension = Math.min(requestedMaxTextureDimension, options.maxTextureDimension2D);
  const textures: ImportedTextureAllocationRecord[] = [], seen = new Set<string>();
  let gpuTextureBytes = 8 + importedEnvironmentTextureBytes;
  for (const material of asset.materials) {
    if (!material || typeof material !== 'object' || Array.isArray(material)) fail('material must be an object.');
    for (const role of textureRoles) {
      const ref = material[role];
      if (ref === undefined) continue;
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail('material texture reference must be an object.');
      if (!Number.isSafeInteger(ref.image) || ref.image < 0 || ref.image >= asset.images.length) fail('material references an absent image.');
      const colorSpace = role === 'baseColorTexture' || role === 'emissiveTexture' ? 'srgb' : 'linear';
      const key = `${ref.image}/${colorSpace}`;
      if (seen.has(key)) continue;
      const image = asset.images[ref.image];
      if (!image || typeof image !== 'object' || Array.isArray(image)) fail('referenced image metadata must be an object.');
      const extent = importedTextureExtent(image.width, image.height, effectiveMaxTextureDimension);
      textures.push({ image: ref.image, sourceWidth: image.width, sourceHeight: image.height,
        uploadWidth: extent.width, uploadHeight: extent.height, colorSpace, mipLevels: extent.mipLevels, gpuBytes: extent.bytes });
      gpuTextureBytes += extent.bytes;
      seen.add(key);
    }
  }
  return { requestedMaxTextureDimension, effectiveMaxTextureDimension, gpuTextureBytes,
    textureBudgetBytes: importedTextureBudget, fitsBudget: gpuTextureBytes <= importedTextureBudget, textures };
}
