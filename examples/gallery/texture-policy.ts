export const galleryTextureCaps = Object.freeze([2048, 4096, 8192] as const);
export type GalleryTextureCap = typeof galleryTextureCaps[number];
export const defaultGalleryTextureCap: GalleryTextureCap = 4096;

/** Structural subset of Core's reserved optional glTF allocation estimate. */
export interface TextureAllocationEstimate {
  readonly requestedMaxTextureDimension: number;
  readonly effectiveMaxTextureDimension: number;
  readonly gpuTextureBytes: number;
  readonly textureBudgetBytes: number;
  readonly fitsBudget: boolean;
}

export interface TextureBudgetAttempt {
  readonly cap: GalleryTextureCap;
  readonly effectiveCap: number;
  readonly gpuTextureBytes: number;
  readonly withinBudget: boolean;
}

interface TextureBudgetEvidence {
  readonly requestedCap: GalleryTextureCap;
  readonly deviceLimited: boolean;
  readonly budgetBytes: number;
  readonly attempts: readonly TextureBudgetAttempt[];
}

export type TextureCapDecision = TextureBudgetEvidence & (
  | { readonly status: 'ready'; readonly selectedCap: GalleryTextureCap; readonly effectiveCap: number; readonly budgetFallback: boolean }
  | { readonly status: 'unsupported'; readonly selectedCap: null; readonly effectiveCap: null; readonly reason: 'texture-budget' }
);

/**
 * Select at most three progressively lower caps before any scene/GPU mutation.
 * Core must provide complete texture byte estimates; this policy does not parse
 * assets, infer GPU allocation rules, catch renderer failures, or raise budgets.
 * Estimates include role copies, mipmaps, fallbacks and environment allocations.
 * Every estimate in one decision must use the same asset, device limit and budget.
 * This accounts for Core's modeled texture budget, not total process/driver VRAM.
 */
export function chooseTextureCap(options: {
  readonly requestedCap?: GalleryTextureCap;
  readonly estimate: (cap: GalleryTextureCap) => TextureAllocationEstimate;
}): TextureCapDecision {
  const requestedCap = options.requestedCap === undefined ? defaultGalleryTextureCap : options.requestedCap;
  if (!galleryTextureCaps.includes(requestedCap)) throw new Error('Gallery texture cap must be 2048, 4096 or 8192.');
  if (typeof options.estimate !== 'function') throw new Error('Texture policy requires a Core allocation estimator.');
  const attempts: TextureBudgetAttempt[] = [];
  let maximumEffectiveCap = requestedCap as number;
  let budgetBytes: number | null = null;
  const evidence = () => ({ requestedCap, deviceLimited: maximumEffectiveCap < requestedCap, budgetBytes: budgetBytes! });
  const visited = new Set<number>();
  for (const cap of [...galleryTextureCaps].reverse()) {
    if (cap > requestedCap) continue;
    if (visited.has(Math.min(cap, maximumEffectiveCap))) continue;
    // A validation/decoder/estimator error propagates unchanged. Only a numeric
    // budget excess permits trying a lower texture cap.
    const allocation = options.estimate(cap);
    if (!allocation || allocation.requestedMaxTextureDimension !== cap
      || !Number.isSafeInteger(allocation.effectiveMaxTextureDimension) || allocation.effectiveMaxTextureDimension < 1
      || allocation.effectiveMaxTextureDimension > cap
      || !Number.isSafeInteger(allocation.gpuTextureBytes) || allocation.gpuTextureBytes < 0
      || !Number.isSafeInteger(allocation.textureBudgetBytes) || allocation.textureBudgetBytes < 1
      || allocation.fitsBudget !== (allocation.gpuTextureBytes <= allocation.textureBudgetBytes)) {
      throw new Error('Core texture allocation estimate has inconsistent caps, budget or byte counts.');
    }
    const { effectiveMaxTextureDimension: effectiveCap, gpuTextureBytes, fitsBudget: withinBudget } = allocation;
    if (budgetBytes === null) {
      budgetBytes = allocation.textureBudgetBytes;
      maximumEffectiveCap = effectiveCap;
    } else if (allocation.textureBudgetBytes !== budgetBytes || effectiveCap !== Math.min(cap, maximumEffectiveCap)) {
      throw new Error('Core texture estimates must use the same device limit and budget.');
    }
    visited.add(effectiveCap);
    attempts.push(Object.freeze({ cap, effectiveCap, gpuTextureBytes, withinBudget }));
    if (withinBudget) return Object.freeze({ ...evidence(), attempts: Object.freeze(attempts),
      status: 'ready', selectedCap: cap, effectiveCap, budgetFallback: cap !== requestedCap });
  }
  return Object.freeze({ ...evidence(), attempts: Object.freeze(attempts),
    status: 'unsupported', selectedCap: null, effectiveCap: null, reason: 'texture-budget' });
}
