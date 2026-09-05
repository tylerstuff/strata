import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseGeometryManifest, validateGeometryPage, type GeometryManifest } from '../../packages/core/src/geometry/format.js';
import { parseTraceProxyManifest, validateTraceProxy } from '../../packages/core/src/geometry/trace-proxy.js';

let directory: string;
const fixtures = new Map<string, { path: string; bytes: ArrayBuffer; raw: ReturnType<typeof JSON.parse>; manifest: GeometryManifest }>();
const configurations = [{ name: 'seven', tiles: 4, cells: 64, levels: 7 }, { name: 'eight', tiles: 1, cells: 128, levels: 8 }];
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'strata-certified-format-'));
  for (const fixture of configurations) {
    const path = join(directory, fixture.name);
    execFileSync('cargo', ['run', '--quiet', '--release', '--locked', '--package', 'strata-geometry-cooker', '--',
      '--output', path, '--seed', '1337', '--tiles', String(fixture.tiles), '--cells', String(fixture.cells),
      '--lod-profile', 'certified', ...(fixture.name === 'seven' ? ['--trace-proxy'] : [])],
    { cwd: resolve(import.meta.dirname, '../..'), timeout: 90_000 });
    const bytes = new Uint8Array(await readFile(join(path, 'manifest.json'))).buffer;
    const raw = JSON.parse(new TextDecoder().decode(bytes));
    fixtures.set(fixture.name, { path, bytes, raw, manifest: parseGeometryManifest(raw) });
  }
}, 180_000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe('certified cooker output consumed by the existing runtime', () => {
  it.each(configurations)('validates all $levels LODs and every generated page for $name', async ({ name, levels, tiles, cells }) => {
    const fixture = fixtures.get(name)!;
    expect(fixture.raw.cook).toEqual({ profile: 'certified-terrain-v1', lodSteps: Array.from({ length: levels }, (_, i) => 2 ** i),
      errorMetric: 'max-vertical-to-finest', monotonicEnvelope: true });
    expect(fixture.manifest.source.triangleCount).toBe(tiles * tiles * cells * cells * 2);
    for (const tile of fixture.manifest.tiles) {
      expect(tile.lods).toHaveLength(levels);
      expect(tile.lods[0]!.error).toBe(0);
      expect(tile.lods.every((lod, index) => index === 0 || lod.error >= tile.lods[index - 1]!.error)).toBe(true);
    }
    for (const page of fixture.manifest.pages) {
      const bytes = new Uint8Array(await readFile(join(fixture.path, page.url))).buffer;
      await expect(validateGeometryPage(page, bytes, fixture.manifest.clusters)).resolves.toHaveLength(65536);
    }
  });

  it('links the regenerated tracing proxy to exact certified manifest bytes', async () => {
    const fixture = fixtures.get('seven')!;
    const proxy = parseTraceProxyManifest(JSON.parse(await readFile(join(fixture.path, 'trace-proxy.json'), 'utf8')), fixture.manifest);
    const payload = new Uint8Array(await readFile(join(fixture.path, proxy.mesh.url))).buffer;
    expect(proxy.sourceManifestSha256).toBe(createHash('sha256').update(new Uint8Array(fixture.bytes)).digest('hex'));
    const validated = await validateTraceProxy(proxy, payload, fixture.bytes);
    expect(validated.triangles).toHaveLength(2048);
    expect(validated.payloadBytes).toBe(37644);
    // Even unchanged source geometry cannot authorize a sidecar against different manifest bytes.
    const otherBytes = new TextEncoder().encode(new TextDecoder().decode(fixture.bytes).trim()).buffer;
    await expect(validateTraceProxy(proxy, payload, otherBytes)).rejects.toThrow('SHA-256 linkage');
  });
});
