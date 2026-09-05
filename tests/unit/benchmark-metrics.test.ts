import { describe, expect, it } from 'vitest';
import { distribution, normalizeOptions, summarizeFrames, type FrameSample } from '../../benchmarks/src/metrics.js';

describe('benchmark measurements', () => {
  it('uses nearest-rank percentiles and preserves missing GPU measurements as null', () => {
    expect(distribution([50, 10, 20, 30, 40])).toEqual({ count: 5, min: 10, mean: 30, p50: 30, p95: 50, p99: 50, max: 50 });
    expect(distribution([]).p95).toBeNull();
    expect(() => distribution([Number.NaN])).toThrow();
    expect(() => distribution([-1])).toThrow();
  });

  it('distinguishes missing samples from a measured zero and reports stalls', () => {
    const common = { elapsedMs: 0, cpuSubmissionMs: 0.5, drawCalls: 1, dispatchCalls: 0, triangles: 12, uploadBytes: 64, allocatedGpuBufferBytes: 512, allocatedGpuTextureBytes: 1024 };
    const frames: FrameSample[] = [
      { ...common, frameId: 1, frameIntervalMs: 16, gpuMs: 0 },
      { ...common, frameId: 2, frameIntervalMs: 34, gpuMs: null },
    ];
    const summary = summarizeFrames(frames);
    expect(summary.gpuPassMs.count).toBe(1);
    expect(summary.gpuPassMs.p95).toBe(0);
    expect(summary.framesAbove20Ms).toBe(1);
    expect(summary.meanCallbackCadenceFps).toBe(40);
    expect(summary.uploadBytes).toBe(128);
  });

  it('accepts only repeatable profiles and rejects unbounded capture settings', () => {
    expect(normalizeOptions().width).toBe(1280);
    expect(normalizeOptions({ width: 1920, height: 1080 }).height).toBe(1080);
    expect(() => normalizeOptions({ width: 640, height: 360 })).toThrow();
    expect(() => normalizeOptions({ durationSeconds: 0 })).toThrow();
    expect(() => normalizeOptions({ seed: -1 })).toThrow();
    expect(() => normalizeOptions({ instanceCount: 0 })).toThrow();
    expect(normalizeOptions({ renderer: 'raster', temporal: false }).temporal).toBe(false);
    expect(() => normalizeOptions({ renderer: 'diffuse', debugView: 'depth' })).toThrow();
  });

  it('summarizes a long high-refresh capture without spreading frames onto the call stack', () => {
    const frames: FrameSample[] = Array.from({ length: 216_000 }, (_, frameId) => ({
      frameId, elapsedMs: frameId * 8.33, frameIntervalMs: 8.33, cpuSubmissionMs: 0.1,
      gpuMs: null, drawCalls: 1, dispatchCalls: 0, triangles: 12, uploadBytes: 64,
      allocatedGpuBufferBytes: 512, allocatedGpuTextureBytes: 1024,
    }));
    expect(summarizeFrames(frames).maxTrackedGpuTextureBytes).toBe(1024);
  });

  it('requires an explicit cooked asset and bounded streaming settings', () => {
    expect(() => normalizeOptions({ renderer: 'virtual' })).toThrow(/manifestUrl/);
    const options = { renderer: 'virtual', manifestUrl: '/external-assets/terrain/manifest.json' } as const;
    expect(normalizeOptions(options).poolBytes).toBe(8 * 1024 ** 2);
    expect(normalizeOptions({ ...options, geometryMode: 'mesh-lod' }).geometryMode).toBe('mesh-lod');
    expect(() => normalizeOptions({ ...options, pixelError: 0 })).toThrow();
    expect(() => normalizeOptions({ ...options, pageLoadDelayMs: Infinity })).toThrow();
    expect(() => normalizeOptions({ ...options, poolBytes: 1 })).toThrow();
    expect(normalizeOptions({ ...options, instanceCount: 512 }).instanceCount).toBe(0);
  });

  it('normalizes the fixed GI scene independently of instancing and temporal filtering', () => {
    const options = normalizeOptions({ renderer: 'gi', instanceCount: 512 });
    expect(options).toMatchObject({ instanceCount: 0, seed: 1337, cameraMode: 'overview', giEnabled: true,
      probesPerUpdate: 32, raysPerProbe: 64, giScenario: 'door-light' });
    expect(normalizeOptions({ renderer: 'gi', giEnabled: false, giScenario: 'static', cameraMode: 'receiver', temporal: false }))
      .toMatchObject({ instanceCount: 0, giEnabled: false, giScenario: 'static', cameraMode: 'receiver', temporal: false });
    for (const [probesPerUpdate, raysPerProbe] of [[1, 16], [127, 17], [128, 128]] as const) {
      expect(normalizeOptions({ renderer: 'gi', probesPerUpdate, raysPerProbe }))
        .toMatchObject({ probesPerUpdate, raysPerProbe });
    }
  });

  it('rejects unsupported GI states and budgets before capture', () => {
    expect(() => normalizeOptions({ renderer: 'gi', seed: 1 })).toThrow(/fixed probe seed/);
    expect(() => normalizeOptions({ renderer: 'gi', cameraMode: 'coverage' })).toThrow(/camera\/scenario/);
    for (const probesPerUpdate of [0, 129, 1.5, Infinity]) {
      expect(() => normalizeOptions({ renderer: 'gi', probesPerUpdate })).toThrow(/probe\/ray budget/);
    }
    for (const raysPerProbe of [15, 129, 16.5, Number.NaN]) {
      expect(() => normalizeOptions({ renderer: 'gi', raysPerProbe })).toThrow(/probe\/ray budget/);
    }
    // Browser callers are JavaScript and can pass values outside the TypeScript surface.
    expect(() => normalizeOptions({ renderer: 'gi', giEnabled: 'false' as unknown as boolean })).toThrow();
    expect(() => normalizeOptions({ renderer: 'gi', giScenario: 'unknown' as 'static' })).toThrow();
  });
});
