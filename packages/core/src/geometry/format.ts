import { StrataError } from '../errors.js';

export type GeometryVec3 = readonly [number, number, number];
export interface GeometryBounds { readonly min: GeometryVec3; readonly max: GeometryVec3 }
export interface GeometryPage {
  readonly id: number;
  readonly url: string;
  readonly byteLength: 65536;
  readonly sha256: string;
  readonly pinned: boolean;
}
export interface GeometryCluster {
  readonly id: number;
  readonly pageId: number;
  readonly vertexOffset: number;
  readonly vertexCount: number;
  readonly indexOffset: number;
  readonly indexCount: number;
  readonly triangleCount: number;
  readonly bounds: GeometryBounds;
}
export interface GeometryLod {
  /** Zero is finest; the final level is the complete, pinned coarse representation. */
  readonly level: number;
  /** Conservative maximum geometric deviation from the finest source, in world units. */
  readonly error: number;
  readonly clusterIds: readonly number[];
  readonly pageIds: readonly number[];
}
export interface GeometryTile { readonly id: number; readonly bounds: GeometryBounds; readonly lods: readonly GeometryLod[] }
export interface GeometryManifest {
  readonly format: 'strata-geometry';
  readonly version: 1;
  readonly pageBytes: 65536;
  readonly vertexStride: 32;
  readonly indexFormat: 'uint32';
  readonly source: {
    readonly kind: 'analytic-heightfield-v1'; readonly seed: number; readonly tilesPerSide: number;
    readonly cellsPerTile: number; readonly cellSize: 1; readonly triangleCount: number;
  };
  readonly bounds: GeometryBounds;
  readonly pages: readonly GeometryPage[];
  readonly clusters: readonly GeometryCluster[];
  readonly tiles: readonly GeometryTile[];
  readonly rootPageIds: readonly number[];
}

const pageBytes = 65536;
function fail(message: string): never { throw new StrataError('INVALID_OPTIONS', `Invalid geometry asset: ${message}`); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} is out of range.`);
  return value;
}
function array(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) fail(`${label} has an invalid length.`);
  return value;
}
function ids(value: unknown, maximum: number, label: string): readonly number[] {
  const result = array(value, maximum, label).map((id) => integer(id, 0, maximum - 1, label));
  if (new Set(result).size !== result.length) fail(`${label} contains duplicates.`);
  return Object.freeze(result);
}
function bounds(value: unknown, label: string): GeometryBounds {
  const object = record(value, label);
  const vector = (input: unknown): GeometryVec3 => {
    if (!Array.isArray(input) || input.length !== 3 || input.some((v) => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1_000_000)) fail(`${label} needs finite three-component bounds.`);
    return Object.freeze([...input]) as unknown as GeometryVec3;
  };
  const min = vector(object.min); const max = vector(object.max);
  if (min.some((v, index) => v > max[index]!)) fail(`${label} minimum exceeds maximum.`);
  return Object.freeze({ min, max });
}
function contains(outer: GeometryBounds, inner: GeometryBounds): boolean {
  return outer.min.every((value, axis) => value <= inner.min[axis]! && outer.max[axis]! >= inner.max[axis]!);
}

/** Validate structural limits, exact dependencies, offsets, ownership, and complete pinned roots. */
export function parseGeometryManifest(input: unknown): GeometryManifest {
  const value = record(input, 'manifest');
  if (value.format !== 'strata-geometry' || value.version !== 1 || value.pageBytes !== pageBytes
    || value.vertexStride !== 32 || value.indexFormat !== 'uint32') fail('unsupported format/version/layout.');
  const rawSource = record(value.source, 'source');
  if (rawSource.kind !== 'analytic-heightfield-v1' || rawSource.cellSize !== 1) fail('unsupported source kind or scale.');
  const tilesPerSide = integer(rawSource.tilesPerSide, 1, 16, 'tilesPerSide');
  const cellsPerTile = integer(rawSource.cellsPerTile, 8, 128, 'cellsPerTile');
  if ((cellsPerTile & (cellsPerTile - 1)) !== 0) fail('cellsPerTile must be a power of two.');
  const triangleCount = tilesPerSide * tilesPerSide * cellsPerTile * cellsPerTile * 2;
  if (rawSource.triangleCount !== triangleCount) fail('source triangle count disagrees with the unique grid.');
  const source = Object.freeze({ kind: 'analytic-heightfield-v1' as const,
    seed: integer(rawSource.seed, 0, 0xffff_ffff, 'seed'), tilesPerSide, cellsPerTile, cellSize: 1 as const, triangleCount });
  const assetBounds = bounds(value.bounds, 'manifest bounds');
  const pages = Object.freeze(array(value.pages, 8192, 'pages').map((input, id): GeometryPage => {
    const page = record(input, 'page');
    if (page.id !== id || page.byteLength !== pageBytes || typeof page.url !== 'string'
      || page.url !== `pages/${String(id).padStart(6, '0')}.bin` || typeof page.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(page.sha256) || typeof page.pinned !== 'boolean') fail(`page ${id} has invalid metadata.`);
    return Object.freeze({ id, url: page.url, byteLength: 65536, sha256: page.sha256, pinned: page.pinned });
  }));
  const ranges = pages.map(() => [] as Array<readonly [number, number]>);
  const clusters = Object.freeze(array(value.clusters, 262144, 'clusters').map((input, id): GeometryCluster => {
    const cluster = record(input, 'cluster');
    if (cluster.id !== id) fail('cluster IDs must be contiguous.');
    const pageId = integer(cluster.pageId, 0, pages.length - 1, 'cluster pageId');
    const vertexCount = integer(cluster.vertexCount, 3, 384, 'vertexCount');
    const triangleCount = integer(cluster.triangleCount, 1, 128, 'triangleCount');
    const indexCount = triangleCount * 3;
    if (cluster.indexCount !== indexCount) fail('cluster index count must be three times its triangle count.');
    const vertexOffset = integer(cluster.vertexOffset, 0, pageBytes - vertexCount * 32, 'vertexOffset');
    const indexOffset = integer(cluster.indexOffset, 0, pageBytes - indexCount * 4, 'indexOffset');
    if (vertexOffset % 4 || indexOffset % 4) fail('cluster byte offsets must be four-byte aligned.');
    ranges[pageId]!.push([vertexOffset, vertexOffset + vertexCount * 32], [indexOffset, indexOffset + indexCount * 4]);
    const clusterBounds = bounds(cluster.bounds, 'cluster bounds');
    if (!contains(assetBounds, clusterBounds)) fail('cluster bounds exceed asset bounds.');
    return Object.freeze({ id, pageId, vertexOffset, vertexCount, indexOffset, indexCount, triangleCount, bounds: clusterBounds });
  }));
  ranges.forEach((pageRanges) => {
    if (!pageRanges.length) fail('every page must contain clusters.');
    pageRanges.sort((a, b) => a[0] - b[0]);
    for (let index = 1; index < pageRanges.length; index++) {
      if (pageRanges[index]![0] < pageRanges[index - 1]![1]) fail('cluster vertex/index ranges overlap.');
    }
  });
  const ownerCounts = new Uint8Array(clusters.length);
  const rootClusters = new Set<number>();
  const tiles = Object.freeze(array(value.tiles, 256, 'tiles').map((input, id): GeometryTile => {
    const tile = record(input, 'tile');
    if (tile.id !== id) fail('tile IDs must be contiguous.');
    const tileBounds = bounds(tile.bounds, 'tile bounds');
    if (!contains(assetBounds, tileBounds)) fail('tile bounds exceed asset bounds.');
    let previousError = -1;
    const lods = Object.freeze(array(tile.lods, 8, 'tile LODs').map((input, level): GeometryLod => {
      const lod = record(input, 'LOD');
      if (lod.level !== level || typeof lod.error !== 'number' || !Number.isFinite(lod.error) || lod.error < previousError
        || lod.error < 0 || lod.error > 1_000_000 || (level === 0 && lod.error !== 0)) fail('LOD levels/errors must be finest-first and monotonic.');
      previousError = lod.error;
      const clusterIds = ids(lod.clusterIds, clusters.length, 'LOD clusterIds');
      const pageIds = ids(lod.pageIds, pages.length, 'LOD pageIds');
      const expectedPages = new Set<number>();
      let triangles = 0;
      for (const clusterId of clusterIds) {
        const cluster = clusters[clusterId]!;
        if (ownerCounts[clusterId] !== 0) fail('a cluster belongs to multiple tile LODs.');
        ownerCounts[clusterId] = 1;
        expectedPages.add(cluster.pageId);
        triangles += cluster.triangleCount;
        if (!contains(tileBounds, cluster.bounds)) fail('cluster bounds exceed owning tile.');
      }
      if (pageIds.length !== expectedPages.size || pageIds.some((pageId) => !expectedPages.has(pageId))) fail('LOD page dependencies are not exact.');
      if (level === 0 && triangles !== cellsPerTile * cellsPerTile * 2) fail('finest tile must preserve all source triangles.');
      return Object.freeze({ level, error: lod.error, clusterIds, pageIds });
    }));
    for (const id of lods[lods.length - 1]!.clusterIds) rootClusters.add(id);
    return Object.freeze({ id, bounds: tileBounds, lods });
  }));
  if (tiles.length !== tilesPerSide * tilesPerSide || ownerCounts.some((owners) => owners !== 1)) fail('source tiles or cluster ownership are incomplete.');
  const rootPageIds = ids(value.rootPageIds, pages.length, 'rootPageIds');
  const requiredRoots = new Set([...rootClusters].map((id) => clusters[id]!.pageId));
  if (rootPageIds.length !== requiredRoots.size || rootPageIds.some((id) => !requiredRoots.has(id))) fail('root page list is incomplete or contains extras.');
  for (const page of pages) {
    if (page.pinned !== requiredRoots.has(page.id)) fail('pinned flags disagree with root pages.');
  }
  for (const cluster of clusters) {
    if (pages[cluster.pageId]!.pinned && !rootClusters.has(cluster.id)) fail('pinned pages may contain only coarse-root clusters.');
  }
  return Object.freeze({ format: 'strata-geometry', version: 1, pageBytes: 65536, vertexStride: 32,
    indexFormat: 'uint32', source, bounds: assetBounds, pages, clusters, tiles, rootPageIds });
}

/** Validate byte identity before GPU upload; optional cluster checks cover index/vertex contents. */
export async function validateGeometryPage(
  page: GeometryPage, input: ArrayBuffer | Uint8Array, clusters?: readonly GeometryCluster[],
): Promise<Uint8Array<ArrayBuffer>> {
  // Fetch buffers are exclusively owned by the cache; preserve them without another page copy.
  const bytes = input instanceof Uint8Array ? new Uint8Array(input) : new Uint8Array(input);
  if (bytes.byteLength !== page.byteLength) fail(`page ${page.id} has the wrong byte length.`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== page.sha256) fail(`page ${page.id} failed SHA-256 validation.`);
  if (clusters) {
    const data = new DataView(bytes.buffer);
    for (const cluster of clusters) {
      if (cluster.pageId !== page.id) continue;
      for (let vertex = 0; vertex < cluster.vertexCount; vertex++) {
        const offset = cluster.vertexOffset + vertex * 32;
        for (let channel = 0; channel < 8; channel++) {
          const value = data.getFloat32(offset + channel * 4, true);
          if (!Number.isFinite(value) || (channel < 3 && (value < cluster.bounds.min[channel]! || value > cluster.bounds.max[channel]!))) fail(`page ${page.id} contains invalid vertex data.`);
        }
      }
      for (let index = 0; index < cluster.indexCount; index++) {
        if (data.getUint32(cluster.indexOffset + index * 4, true) >= cluster.vertexCount) fail(`page ${page.id} contains an out-of-range local index.`);
      }
    }
  }
  return bytes;
}
