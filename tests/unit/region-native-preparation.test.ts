import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cookRegionSource, type CookedRegionSource } from '../helpers/region-initialization-fixture.js';
import { removeInitializationSource } from '../helpers/cooked-geometry-initialization.js';

const cooked: CookedRegionSource[] = [];
type PreparationModule = typeof import('../browser/region-initialization-validation.js');
let prepare: PreparationModule['prepareRegionInitializationValidation'];
beforeAll(async () => {
  for (const seed of [51, 52, 53, 54]) cooked.push(await cookRegionSource(seed));
  ({ prepareRegionInitializationValidation: prepare } = await withoutBrowserCapabilities(() => import('../browser/region-initialization-validation.js')));
}, 120_000);
afterAll(async () => { await Promise.all(cooked.map(removeInitializationSource)); });

function fixture() {
  return { sources: cooked.map(source => ({ id: `seed-${source.manifest.source.seed}`,
    manifestUrl: `/__region-init__/seed-${source.manifest.source.seed}/manifest.json`,
    manifest: structuredClone(source.manifest), manifestBytes: source.manifestBytes.byteLength,
    manifestSha256: source.manifestSha256, pageHashes: source.manifest.pages.map(page => ({ id: page.id, sha256: page.sha256 })),
    rootPageIndices: [...source.manifest.rootPageIds], poolPages: 2 })) };
}

async function withoutBrowserCapabilities<T>(action: () => Promise<T>): Promise<T> {
  const forbidden = ['navigator', 'document', 'window', 'requestAnimationFrame', 'GPUDevice', 'GPUBuffer', 'GPUTexture', 'fetch'] as const;
  const descriptors = new Map(forbidden.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const touched: string[] = [];
  try {
    for (const name of forbidden) Object.defineProperty(globalThis, name, { configurable: true, get() {
      touched.push(name); throw new Error(`Pure preparation touched ${name}`);
    } });
    const result = await action();
    expect(touched).toEqual([]);
    return result;
  } finally {
    for (const name of forbidden) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

describe('pure preparation of the bounded region WebGPU witness', () => {
  it('imports and prepares without browser, DOM, GPU or network access', async () => {
    await withoutBrowserCapabilities(async () => {
      vi.resetModules();
      const module = await import('../browser/region-initialization-validation.js');
      const input = fixture(); const before = structuredClone(input);
      const plan = module.prepareRegionInitializationValidation(input);
      expect(plan).not.toBeInstanceOf(Promise);
      expect(plan.schema).toBe('strata-region-initialization-webgpu-preparation-v1');
      expect(input).toEqual(before);
    });
  });

  it('pins four distinct real-cooker identities and derives nonempty coarse output before GPU work', () => {
    const input = fixture(); const plan = prepare(input);
    expect(plan.sources).toHaveLength(4);
    expect(plan.sources.map(source => source.id)).toEqual(['seed-51', 'seed-52', 'seed-53', 'seed-54']);
    expect(new Set(plan.sources.map(source => source.manifestSha256)).size).toBe(4);
    for (const [index, source] of plan.sources.entries()) {
      const real = cooked[index]!;
      expect(source.manifestBytes).toBe(real.manifestBytes.byteLength);
      expect(source.manifestSha256).toBe(real.manifestSha256);
      expect(source.pageHashes).toEqual(real.manifest.pages.map(page => ({ id: page.id, sha256: page.sha256 })));
      expect(source).toMatchObject({ pages: 2, tiles: 4, poolPages: 2, rootPageIndices: [0], coarseTriangles: 128, coarseClusters: 4 });
      expect(source.source).toEqual(real.manifest.source);
      expect(source.expectedInitialUploadBytes).toBe(66_760);
      expect(source.metadataBytes + source.selectionBytes + source.residencyBytes + 65_536).toBe(source.expectedInitialUploadBytes);
      expect(source.maximumCoarseProjectedError).toBeGreaterThan(0);
      expect(source.maximumCoarseProjectedError).toBeLessThan(plan.pixelError);
    }
    expect(plan.coordinatorLimits).toEqual({ maxDesiredRegions: 4, maxLiveRegions: 2, maxManifestBytes: 2768, maxRetainedManifestBytes: 5536 });
    expect(plan.transferLimits).toMatchObject({ maxRequests: 2, pageStagingBytes: 65_536, uploadBytesPerFrame: 65_536 });
  });

  it('freezes the exact eight-frame render work and comparison thresholds independently of input object identity', () => {
    const plan = prepare(fixture());
    expect(prepare(fixture())).toEqual(plan);
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
    expect(plan.pixelError).toBe(1000); expect(plan.cameraMode).toBe('coverage');
    expect(plan.frames).toEqual([{ name: 'final', width: 256, height: 256, debugView: 'final', cameraCut: true, temporal: false, timeSeconds: 0 }]);
    expect(plan.gates).toMatchObject({ directRenderSubmissions: 8, expectedDrawCalls: 24, expectedDispatchCalls: 16,
      expectedInteriorSamples: 55_696, maximumDepthDifference: 0.000002, maximumColorChannelDifference: 1,
      successfulCoordinatorUploadBytes: 267_040, heldRetirementFrames: 3, maximumInitializationFrames: 600,
      initializationDeadlineMs: 60_000, totalDeadlineMs: 180_000 });
  });

  it.each(['missing', 'extra', 'order', 'duplicate'] as const)('rejects %s source catalogs before rendering', kind => {
    const input = fixture();
    if (kind === 'missing') input.sources.pop();
    if (kind === 'extra') input.sources.push(structuredClone(input.sources[0]!));
    if (kind === 'order') input.sources.reverse();
    if (kind === 'duplicate') input.sources[1] = structuredClone(input.sources[0]!);
    expect(() => prepare(input)).toThrow();
  });

  it.each(['id', 'route', 'absolute-route', 'manifest-hash', 'page-hash', 'page-id', 'pool', 'roots', 'bytes'] as const)(
    'rejects changed %s source identity/options', kind => {
      const input = fixture(); const source = input.sources[0]!;
      if (kind === 'id') source.id = 'another-source';
      if (kind === 'route') source.manifestUrl = '/__region-init__/seed-54/manifest.json';
      if (kind === 'absolute-route') source.manifestUrl = 'https://other.test/__region-init__/seed-51/manifest.json';
      if (kind === 'manifest-hash') source.manifestSha256 = '0'.repeat(64);
      if (kind === 'page-hash') source.pageHashes[0]!.sha256 = '0'.repeat(64);
      if (kind === 'page-id') source.pageHashes[0]!.id = 1;
      if (kind === 'pool') source.poolPages = 3;
      if (kind === 'roots') source.rootPageIndices = [1];
      if (kind === 'bytes') source.manifestBytes--;
      expect(() => prepare(input)).toThrow();
    });

  it.each(['seed', 'page-count', 'triangle-count', 'coarse-margin'] as const)('rejects %s geometry drift in the verified-fixture plan', kind => {
    const input = fixture(); const source = input.sources[0]!; const manifest = source.manifest;
    if (kind === 'seed') source.manifest = { ...manifest, source: { ...manifest.source, seed: 52 } };
    if (kind === 'page-count') source.manifest = { ...manifest, pages: manifest.pages.slice(0, 1) };
    if (kind === 'triangle-count') source.manifest = { ...manifest, source: { ...manifest.source, triangleCount: 1 } };
    if (kind === 'coarse-margin') source.manifest = { ...manifest, tiles: manifest.tiles.map(tile => ({ ...tile,
      lods: tile.lods.map((lod, index) => index === tile.lods.length - 1 ? { ...lod, error: 1_000_000 } : lod) })) };
    expect(() => prepare(input)).toThrow();
  });
});
