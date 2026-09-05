/** Test-owned ordinary indexed-depth input. No production selector, packing, shader or loader imports. */
export const ORIGINAL_FINEST_REFERENCE = Object.freeze({
  manifestSha256: '12e3946f079ae252d79509710631ea70b5abe14ce8f0119a04b4eb544eab0adf',
  pageBytes: 65536, manifestMaxBytes: 8 * 1024 * 1024, pages: 1199, finestPages: 1093,
  tiles: 64, clusters: 17728, finestClusters: 16384, vertices: 1327104, indices: 6291456,
  triangles: 2097152, positionBytes: 15925248, indexBytes: 25165824, outputBytes: 41091072,
});
export interface ReferencePage { readonly id: number; readonly url: string; readonly byteLength: number; readonly sha256: string; }
export interface ReferenceCluster {
  readonly id: number; readonly pageId: number; readonly vertexOffset: number; readonly vertexCount: number;
  readonly indexOffset: number; readonly indexCount: number; readonly triangleCount: number;
  readonly bounds: { readonly min: readonly number[]; readonly max: readonly number[] };
}
interface ReferenceLod { level: number; error: number; clusterIds: number[]; pageIds: number[]; }
interface ReferenceManifest {
  format: string; version: number; pageBytes: number; vertexStride: number; indexFormat: string;
  source: { kind: string; seed: number; tilesPerSide: number; cellsPerTile: number; cellSize: number; triangleCount: number };
  pages: ReferencePage[]; clusters: ReferenceCluster[]; tiles: { id: number; lods: ReferenceLod[] }[];
  rootPageIds: number[];
}
function check(value: unknown, label: string): asserts value { if (!value) throw new Error(`Finest reference: ${label}`); }
function integer(value: number, low: number, high: number, label: string) {
  check(Number.isSafeInteger(value) && value >= low && value <= high, label);
}
function abort(signal?: AbortSignal) { signal?.throwIfAborted(); }
async function hash(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer)), x => x.toString(16).padStart(2, '0')).join('');
}
function pageShape(page: ReferencePage) {
  integer(page.id, 0, 8191, 'page ID');
  check(page.byteLength === 65536 && page.url === `pages/${String(page.id).padStart(6, '0')}.bin`, 'page layout/URL');
  check(typeof page.sha256 === 'string' && /^[a-f0-9]{64}$/.test(page.sha256), 'page SHA-256');
}
function clusterShape(c: ReferenceCluster, pageId: number) {
  integer(c.id, 0, 262143, 'cluster ID'); check(c.pageId === pageId, 'cluster page ownership');
  integer(c.vertexCount, 3, 384, 'vertex count'); integer(c.triangleCount, 1, 128, 'triangle count');
  check(c.indexCount === c.triangleCount * 3, 'index/triangle count');
  integer(c.vertexOffset, 0, 65536 - c.vertexCount * 32, 'vertex byte range');
  integer(c.indexOffset, 0, 65536 - c.indexCount * 4, 'index byte range');
  check(c.vertexOffset % 4 === 0 && c.indexOffset % 4 === 0, 'unaligned byte offset');
  check(c.bounds?.min?.length === 3 && c.bounds?.max?.length === 3, 'bounds shape');
  for (let axis = 0; axis < 3; axis++) check(Number.isFinite(c.bounds.min[axis]) && Number.isFinite(c.bounds.max[axis])
    && c.bounds.min[axis]! <= c.bounds.max[axis]! && Math.abs(c.bounds.min[axis]!) <= 1e6 && Math.abs(c.bounds.max[axis]!) <= 1e6, 'bounds values');
}
function nonoverlap(clusters: readonly ReferenceCluster[]) {
  const ranges = clusters.flatMap(c => [[c.vertexOffset, c.vertexOffset + c.vertexCount * 32], [c.indexOffset, c.indexOffset + c.indexCount * 4]]);
  ranges.sort((a, b) => a[0]! - b[0]!);
  for (let i = 1; i < ranges.length; i++) check(ranges[i]![0]! >= ranges[i - 1]![1]!, 'overlapping cluster byte ranges');
}
/** Small procedural fixtures may use this page decoder. It does NOT admit a page as the original terrain asset. */
export async function decodeFinestReferencePage(pageInput: ReferencePage, clusterInputs: readonly ReferenceCluster[], input: Uint8Array,
  signal?: AbortSignal) {
  abort(signal); check(input instanceof Uint8Array && input.byteLength === 65536, 'page byte length');
  check(Array.isArray(clusterInputs) && clusterInputs.length > 0 && clusterInputs.length <= 1024, 'page cluster count');
  // Copy both metadata and byte view before the first await; hashed bytes are the decoded bytes.
  const page = structuredClone(pageInput), clusters = structuredClone(clusterInputs), bytes = new Uint8Array(input);
  pageShape(page); const ids = new Set<number>();
  for (const c of clusters) { clusterShape(c, page.id); check(!ids.has(c.id), 'duplicate cluster'); ids.add(c.id); }
  nonoverlap(clusters);
  const sha256 = await hash(bytes); abort(signal); check(sha256 === page.sha256, 'page hash mismatch');
  const positions = new Float32Array(clusters.reduce((n, c) => n + c.vertexCount * 3, 0));
  const indices = new Uint32Array(clusters.reduce((n, c) => n + c.indexCount, 0));
  const data = new DataView(bytes.buffer); let vertexStart = 0, indexStart = 0, minProjectedCrossY = Infinity;
  const ranges = [] as { clusterId: number; vertexStart: number; vertexCount: number; indexStart: number; indexCount: number }[];
  for (const c of clusters) {
    for (let v = 0; v < c.vertexCount; v++) {
      const offset = c.vertexOffset + v * 32;
      for (let channel = 0; channel < 8; channel++) {
        const x = data.getFloat32(offset + channel * 4, true); check(Number.isFinite(x), 'nonfinite vertex channel');
        if (channel < 3) {
          check(x >= c.bounds.min[channel]! && x <= c.bounds.max[channel]!, 'position outside cluster bounds');
          positions[(vertexStart + v) * 3 + channel] = x;
        }
      }
      const nx = data.getFloat32(offset + 12, true), ny = data.getFloat32(offset + 16, true), nz = data.getFloat32(offset + 20, true);
      check(ny > 0 && Math.abs(nx * nx + ny * ny + nz * nz - 1) <= 1e-5, 'terrain normal must be unit and upward');
    }
    for (let i = 0; i < c.indexCount; i++) {
      const local = data.getUint32(c.indexOffset + i * 4, true); check(local < c.vertexCount, 'local index out of range');
      indices[indexStart + i] = vertexStart + local;
    }
    for (let i = 0; i < c.indexCount; i += 3) {
      const a = indices[indexStart + i]! * 3, b = indices[indexStart + i + 1]! * 3, d = indices[indexStart + i + 2]! * 3;
      // Independent XZ determinant: positive Y orientation, no reordering/repair or normal-based substitute.
      const crossY = (positions[b + 2]! - positions[a + 2]!) * (positions[d]! - positions[a]!)
        - (positions[b]! - positions[a]!) * (positions[d + 2]! - positions[a + 2]!);
      check(Number.isFinite(crossY) && crossY > 0, 'degenerate or reversed terrain winding');
      minProjectedCrossY = Math.min(minProjectedCrossY, crossY);
    }
    ranges.push({ clusterId: c.id, vertexStart, vertexCount: c.vertexCount, indexStart, indexCount: c.indexCount });
    vertexStart += c.vertexCount; indexStart += c.indexCount;
  }
  abort(signal);
  return { positions, indices, ranges, pageId: page.id, sha256, minProjectedCrossY,
    typedBytes: positions.byteLength + indices.byteLength, pageSnapshotBytes: bytes.byteLength };
}

export async function decodeOriginalTerrainFinest(manifestInput: Uint8Array,
  readPage: (page: Readonly<ReferencePage>, signal?: AbortSignal) => Promise<Uint8Array>, options: { signal?: AbortSignal } = {}) {
  const { signal } = options; abort(signal);
  check(manifestInput instanceof Uint8Array && manifestInput.byteLength > 0 && manifestInput.byteLength <= ORIGINAL_FINEST_REFERENCE.manifestMaxBytes, 'manifest byte length');
  check(typeof readPage === 'function', 'page reader required');
  const manifestBytes = new Uint8Array(manifestInput), manifestSha256 = await hash(manifestBytes); abort(signal);
  check(manifestSha256 === ORIGINAL_FINEST_REFERENCE.manifestSha256, 'original manifest hash required');
  const m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as ReferenceManifest;
  check(m.format === 'strata-geometry' && m.version === 1 && m.pageBytes === 65536 && m.vertexStride === 32 && m.indexFormat === 'uint32', 'original layout');
  check(m.source.kind === 'analytic-heightfield-v1' && m.source.seed === 1337 && m.source.tilesPerSide === 8 && m.source.cellsPerTile === 128
    && m.source.cellSize === 1 && m.source.triangleCount === 2097152, 'original source identity');
  check(m.pages.length === 1199 && m.clusters.length === 17728 && m.tiles.length === 64 && m.rootPageIds.length === 24, 'original counts');
  const byPage = Array.from({ length: m.pages.length }, () => [] as ReferenceCluster[]);
  m.pages.forEach((p, id) => { pageShape(p); check(p.id === id, 'contiguous page IDs'); });
  m.clusters.forEach((c, id) => {
    check(c.id === id, 'contiguous cluster IDs'); integer(c.pageId, 0, m.pages.length - 1, 'cluster page ID');
    clusterShape(c, c.pageId); byPage[c.pageId]!.push(c);
  });
  byPage.forEach(nonoverlap);
  const plan = new Map<number, { vertexStart: number; indexStart: number }>(); let vertexCount = 0, indexCount = 0;
  m.tiles.forEach((tile, id) => {
    check(tile.id === id && tile.lods.length === 4, 'original tile layout'); const finest = tile.lods[0]!;
    check(finest.level === 0 && finest.error === 0 && finest.clusterIds.length === 256, 'original finest LOD');
    const pages = new Set<number>(); let triangles = 0;
    for (const clusterId of finest.clusterIds) {
      integer(clusterId, 0, m.clusters.length - 1, 'finest cluster ID'); check(!plan.has(clusterId), 'duplicate finest ownership');
      const c = m.clusters[clusterId]!; check(c.vertexCount === 81 && c.indexCount === 384 && c.triangleCount === 128, 'original finest cluster counts');
      plan.set(clusterId, { vertexStart: vertexCount, indexStart: indexCount }); vertexCount += c.vertexCount; indexCount += c.indexCount;
      pages.add(c.pageId); triangles += c.triangleCount;
    }
    check(triangles === 32768 && finest.pageIds.length === pages.size && new Set(finest.pageIds).size === pages.size
      && finest.pageIds.every(p => pages.has(p)), 'finest tile count/dependencies');
  });
  const needed = byPage.map(cs => cs.filter(c => plan.has(c.id)));
  check(plan.size === ORIGINAL_FINEST_REFERENCE.finestClusters && needed.filter(cs => cs.length).length === ORIGINAL_FINEST_REFERENCE.finestPages, 'finest ownership/page count');
  check(vertexCount === ORIGINAL_FINEST_REFERENCE.vertices && indexCount === ORIGINAL_FINEST_REFERENCE.indices, 'finest output counts');
  const positions = new Float32Array(vertexCount * 3), indices = new Uint32Array(indexCount);
  check(positions.byteLength + indices.byteLength === ORIGINAL_FINEST_REFERENCE.outputBytes, 'output byte budget');
  const pages = [] as { id: number; sha256: string; bytes: number }[]; let peakPageTypedBytes = 0, minProjectedCrossY = Infinity;
  // Read/decode at most one source page at a time. No page pool or complete source-byte corpus is retained.
  for (let id = 0; id < needed.length; id++) {
    if (!needed[id]!.length) continue; abort(signal);
    const page = Object.freeze({ id, url: m.pages[id]!.url, byteLength: 65536, sha256: m.pages[id]!.sha256 });
    const input = await readPage(page, signal); abort(signal);
    const decoded = await decodeFinestReferencePage(page, needed[id]!, input, signal);
    for (const range of decoded.ranges) {
      const target = plan.get(range.clusterId)!;
      positions.set(decoded.positions.subarray(range.vertexStart * 3, (range.vertexStart + range.vertexCount) * 3), target.vertexStart * 3);
      for (let i = 0; i < range.indexCount; i++) indices[target.indexStart + i] = target.vertexStart + decoded.indices[range.indexStart + i]! - range.vertexStart;
    }
    peakPageTypedBytes = Math.max(peakPageTypedBytes, decoded.typedBytes); minProjectedCrossY = Math.min(minProjectedCrossY, decoded.minProjectedCrossY);
    pages.push({ id, sha256: decoded.sha256, bytes: 65536 });
  }
  // Finest triangles occupy unit grid cells. Reject rather than normalize winding or topology.
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3;
    const ax = positions[a]!, bx = positions[b]!, cx = positions[c]!, az = positions[a + 2]!, bz = positions[b + 2]!, cz = positions[c + 2]!;
    check(Number.isInteger(ax) && Number.isInteger(bx) && Number.isInteger(cx) && Number.isInteger(az) && Number.isInteger(bz) && Number.isInteger(cz)
      && Math.max(ax, bx, cx) - Math.min(ax, bx, cx) === 1 && Math.max(az, bz, cz) - Math.min(az, bz, cz) === 1
      && (bz - az) * (cx - ax) - (bx - ax) * (cz - az) === 1, 'original unit-cell triangle/winding');
  }
  abort(signal);
  return { positions, indices, manifestSha256, pages, counts: { clusters: plan.size, vertices: vertexCount, indices: indexCount, triangles: indexCount / 3 },
    bytes: { positions: positions.byteLength, indices: indices.byteLength, retainedTypedArrays: positions.byteLength + indices.byteLength,
      sourcePagesRead: pages.length * 65536, maxSourcePagesInFlight: 1, ownedPageSnapshot: 65536, peakDecodedPageTypedArrays: peakPageTypedBytes },
    minProjectedCrossY, qualification: 'Independent original LOD0 indexed-depth input; no raster, shading, temporal or visual acceptance proof. Byte ledger excludes manifest/JS objects, caller reader storage and hash implementation memory.' };
}
