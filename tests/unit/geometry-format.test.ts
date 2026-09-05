import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseGeometryManifest, validateGeometryPage, type GeometryManifest } from '../../packages/core/src/geometry/format.js';

let directory: string;
let raw: ReturnType<typeof JSON.parse>;
let manifest: GeometryManifest;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'strata-cooker-format-'));
  execFileSync('cargo', ['run', '--quiet', '--locked', '--package', 'strata-geometry-cooker', '--',
    '--output', directory, '--tiles', '2', '--cells', '8', '--seed', '42'], { cwd: resolve(import.meta.dirname, '../..'), timeout: 30_000 });
  raw = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  manifest = parseGeometryManifest(raw);
}, 35_000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe('cooker and geometry manifest contract', () => {
  it('parses real cooker output with complete unique source and packed coarse pages', () => {
    expect(manifest.source.triangleCount).toBe(512);
    expect(manifest.tiles).toHaveLength(4);
    expect(manifest.pages).toHaveLength(2);
    expect(manifest.rootPageIds).toEqual([0]);
    expect(manifest.pages[0]!.pinned).toBe(true);
    expect(manifest.tiles.every((tile) => tile.lods[0]!.error === 0 && tile.lods[1]!.error > 0)).toBe(true);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.tiles[0]!.lods[0]!.clusterIds)).toBe(true);
    expect(manifest.clusters.every((cluster) => cluster.triangleCount <= 128)).toBe(true);
  });

  it('validates all emitted padded page hashes, positions and local indices before upload', async () => {
    for (const page of manifest.pages) {
      const buffer = new Uint8Array(await readFile(join(directory, page.url))).buffer;
      const bytes = await validateGeometryPage(page, buffer, manifest.clusters);
      expect(bytes.buffer).toBe(buffer);
      expect(bytes.byteLength).toBe(65536);
    }
  });

  it.each([
    ['version', (value: typeof raw) => { value.version = 2; }],
    ['source count', (value: typeof raw) => { value.source.triangleCount--; }],
    ['source scale', (value: typeof raw) => { value.source.cellSize = 2; }],
    ['page size', (value: typeof raw) => { value.pages[0].byteLength = 65540; }],
    ['page URL', (value: typeof raw) => { value.pages[0].url = '../private-file'; }],
    ['page hash', (value: typeof raw) => { value.pages[0].sha256 = 'bad'; }],
    ['page ID', (value: typeof raw) => { value.pages[0].id = 1; }],
    ['oversized cluster', (value: typeof raw) => { value.clusters[0].triangleCount = 129; }],
    ['index count', (value: typeof raw) => { value.clusters[0].indexCount--; }],
    ['misaligned offset', (value: typeof raw) => { value.clusters[0].vertexOffset++; }],
    ['page overflow', (value: typeof raw) => { value.clusters[0].indexOffset = 65536; }],
    ['overlapping ranges', (value: typeof raw) => { value.clusters[0].indexOffset = value.clusters[0].vertexOffset; }],
    ['cluster bounds', (value: typeof raw) => { value.clusters[0].bounds.min[0] = -100000; }],
    ['nonfinite bounds', (value: typeof raw) => { value.bounds.max[1] = Infinity; }],
    ['error ordering', (value: typeof raw) => { value.tiles[0].lods[0].error = 1; }],
    ['missing dependency', (value: typeof raw) => { value.tiles[0].lods[0].pageIds = [0]; }],
    ['duplicate ownership', (value: typeof raw) => { value.tiles[1].lods[0].clusterIds = value.tiles[0].lods[0].clusterIds; }],
    ['missing tile', (value: typeof raw) => { value.tiles.pop(); }],
    ['root mismatch', (value: typeof raw) => { value.rootPageIds = [1]; }],
    ['unpinned root', (value: typeof raw) => { value.pages[0].pinned = false; }],
  ])('rejects invalid %s metadata', (_label, mutate) => {
    const changed = structuredClone(raw);
    mutate(changed);
    expect(() => parseGeometryManifest(changed)).toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
  });

  it('rejects corruption and invalid authenticated index/vertex contents', async () => {
    const page = manifest.pages[0]!;
    const original = new Uint8Array(await readFile(join(directory, page.url)));
    await expect(validateGeometryPage(page, original.slice(1))).rejects.toThrow('wrong byte length');
    const corrupt = original.slice();
    corrupt[0] = corrupt[0]! ^ 1;
    await expect(validateGeometryPage(page, corrupt)).rejects.toThrow('SHA-256');
    const cluster = manifest.clusters.find((cluster) => cluster.pageId === page.id)!;
    const badIndex = original.slice();
    new DataView(badIndex.buffer).setUint32(cluster.indexOffset, cluster.vertexCount, true);
    const indexedPage = { ...page, sha256: createHash('sha256').update(badIndex).digest('hex') };
    await expect(validateGeometryPage(indexedPage, badIndex, manifest.clusters)).rejects.toThrow('out-of-range local index');
    const badVertex = original.slice();
    new DataView(badVertex.buffer).setFloat32(cluster.vertexOffset, NaN, true);
    const vertexPage = { ...page, sha256: createHash('sha256').update(badVertex).digest('hex') };
    await expect(validateGeometryPage(vertexPage, badVertex, manifest.clusters)).rejects.toThrow('invalid vertex data');
  });
});
