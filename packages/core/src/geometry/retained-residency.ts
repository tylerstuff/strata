import { StrataError } from '../errors.js';
import type { GeometryManifest, GeometryTile } from './format.js';

export interface RetainedResidencyDemand {
  readonly tileId: number;
  readonly lod: number;
  readonly priority: number;
}

export interface RetainedResidencyInput {
  /** Unique tiles, ordered by descending priority and then ascending tile ID. */
  readonly demands: readonly RetainedResidencyDemand[];
  /** Physical GPU mappings only; completed requests awaiting upload do not count. */
  readonly residentPageIds: ReadonlySet<number>;
  /** Prevents missing-page requests, but does not invalidate resident contents. */
  readonly terminalFailedPageIds: ReadonlySet<number>;
  readonly capacityPages: number;
}

export interface RetainedResidencyTarget {
  readonly tileId: number;
  readonly lod: number;
  /** Complete target dependency, including pages already physically resident. */
  readonly pageIds: readonly number[];
  readonly missingPageIds: readonly number[];
}

export interface RetainedResidencyBlockedDemand {
  readonly tileId: number;
  readonly desiredLod: number;
  readonly selectedLod: number;
  readonly reason: 'capacity' | 'failed';
  /** Smallest protected-plus-target union among nonfailed useful candidates. */
  readonly minimumRequiredPages: number | null;
}

export interface RetainedResidencyPlan {
  /** Current GPU-preferred complete LOD for every demanded tile, before uploads. */
  readonly selectedLods: ReadonlyMap<number, number>;
  readonly target: RetainedResidencyTarget | null;
  readonly protectedPageIds: ReadonlySet<number>;
  /** Protected pages plus the sole admitted target; always within capacity. */
  readonly wantedPageIds: ReadonlySet<number>;
  /** Roots, current dependencies in demand order, then new target dependencies. */
  readonly pageOrder: readonly number[];
  /** selected !== desired, including finer fallback; not a missing-detail count. */
  readonly unsatisfiedDemandCount: number;
  /** Individually feasible demands deferred by the one-target admission limit. */
  readonly deferredDemandCount: number;
  readonly blockedDemands: readonly RetainedResidencyBlockedDemand[];
}

function invalid(message: string): never {
  throw new StrataError('INVALID_OPTIONS', `Invalid retained residency input: ${message}`);
}

function validateInput(manifest: GeometryManifest, input: RetainedResidencyInput): void {
  if (!Number.isSafeInteger(input.capacityPages) || input.capacityPages < 1) {
    invalid('capacityPages must be a positive safe integer.');
  }
  for (const pages of [input.residentPageIds, input.terminalFailedPageIds]) {
    for (const pageId of pages) {
      if (!Number.isSafeInteger(pageId) || pageId < 0 || pageId >= manifest.pages.length) {
        invalid('page IDs must belong to the manifest.');
      }
    }
  }
  if (input.residentPageIds.size > input.capacityPages) invalid('physical residency exceeds capacity.');
  if (manifest.rootPageIds.some(pageId => !input.residentPageIds.has(pageId))) {
    invalid('all pinned roots must be physically resident.');
  }
  const seen = new Set<number>();
  let previous: RetainedResidencyDemand | undefined;
  for (const demand of input.demands) {
    if (!Number.isSafeInteger(demand.tileId) || demand.tileId < 0 || demand.tileId >= manifest.tiles.length) {
      invalid('tile IDs must belong to the manifest.');
    }
    const tile = manifest.tiles[demand.tileId]!;
    if (!Number.isSafeInteger(demand.lod) || demand.lod < 0 || demand.lod >= tile.lods.length) {
      invalid('desired LOD must belong to its tile.');
    }
    if (!Number.isFinite(demand.priority) || seen.has(demand.tileId)) {
      invalid('demands require finite priorities and unique tile IDs.');
    }
    if (previous && (previous.priority < demand.priority
      || (previous.priority === demand.priority && previous.tileId > demand.tileId))) {
      invalid('demands must be sorted by descending priority, then ascending tile ID.');
    }
    seen.add(demand.tileId);
    previous = demand;
  }
}

/** Matches visible streamed selection: exact, closest complete finer, then coarser. */
function preferredLod(tile: GeometryTile, desired: number, resident: ReadonlySet<number>): number {
  const complete = (lod: number) => tile.lods[lod]!.pageIds.every(pageId => resident.has(pageId));
  if (complete(desired)) return desired;
  for (let lod = desired - 1; lod >= 0; lod--) if (complete(lod)) return lod;
  for (let lod = desired + 1; lod < tile.lods.length; lod++) if (complete(lod)) return lod;
  // A parsed manifest has a complete root LOD made entirely of pinned pages.
  return invalid('a demanded tile has no complete resident LOD.');
}

/**
 * Plan one useful transition without evicting any currently selected dependency.
 *
 * The manifest must already be parsed. Recompute from physical mappings before
 * each upload and after it commits: shared pages can complete a newly preferred
 * LOD of another tile, which then needs protection even if it was not a target.
 * This is a priority heuristic, not a global optimizer or an eventual-progress
 * guarantee. A full protected pool may legitimately prevent all transitions.
 */
export function planRetainedResidency(
  manifest: GeometryManifest, input: RetainedResidencyInput,
): RetainedResidencyPlan {
  validateInput(manifest, input);
  const selectedLods = new Map<number, number>();
  const protectedPageIds = new Set(manifest.rootPageIds);
  // Establish every active dependency before considering even the first target.
  for (const demand of input.demands) {
    const tile = manifest.tiles[demand.tileId]!;
    const selected = preferredLod(tile, demand.lod, input.residentPageIds);
    selectedLods.set(demand.tileId, selected);
    for (const pageId of tile.lods[selected]!.pageIds) protectedPageIds.add(pageId);
  }

  let target: RetainedResidencyTarget | null = null;
  let unsatisfiedDemandCount = 0;
  let deferredDemandCount = 0;
  const blockedDemands: RetainedResidencyBlockedDemand[] = [];
  for (const demand of input.demands) {
    const selected = selectedLods.get(demand.tileId)!;
    if (selected === demand.lod) continue;
    unsatisfiedDemandCount++;
    const tile = manifest.tiles[demand.tileId]!;
    // Refine toward desired, permitting an intermediate level strictly better
    // than current. If current is finer, only the actual desired coarsening is
    // useful; do not degrade another level merely to make the pool fit.
    const end = selected > demand.lod ? selected : demand.lod + 1;
    let candidate: RetainedResidencyTarget | null = null;
    let minimumRequiredPages = Infinity;
    for (let lod = demand.lod; lod < end; lod++) {
      const pages = tile.lods[lod]!.pageIds;
      const missingPageIds = pages.filter(pageId => !input.residentPageIds.has(pageId));
      if (missingPageIds.some(pageId => input.terminalFailedPageIds.has(pageId))) continue;
      let requiredPages = protectedPageIds.size;
      for (const pageId of pages) if (!protectedPageIds.has(pageId)) requiredPages++;
      minimumRequiredPages = Math.min(minimumRequiredPages, requiredPages);
      if (requiredPages <= input.capacityPages) {
        candidate = { tileId: demand.tileId, lod, pageIds: [...pages], missingPageIds };
        break;
      }
    }
    if (candidate) {
      if (target === null) target = candidate;
      else deferredDemandCount++;
    } else {
      blockedDemands.push({
        tileId: demand.tileId, desiredLod: demand.lod, selectedLod: selected,
        reason: Number.isFinite(minimumRequiredPages) ? 'capacity' : 'failed',
        minimumRequiredPages: Number.isFinite(minimumRequiredPages) ? minimumRequiredPages : null,
      });
    }
  }

  const wantedPageIds = new Set(protectedPageIds);
  if (target) for (const pageId of target.pageIds) wantedPageIds.add(pageId);
  return {
    selectedLods, target, protectedPageIds, wantedPageIds, pageOrder: [...wantedPageIds],
    unsatisfiedDemandCount, deferredDemandCount, blockedDemands,
  };
}
