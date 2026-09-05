import { describe, expect, it, vi } from 'vitest';
import { ReflectionCache, reflectionCacheLayout } from '../../packages/core/src/reflections/reflection-cache.js';
import type { ReflectionFrame, ReflectionCacheOptions } from '../../packages/core/src/reflections/reflection-cache.js';
import { acceptsReflectionHistory, normalizeReflectionControls, reflectionCandidateRegion, reflectionFresnel, sampleReflectionDirection } from '../../packages/core/src/reflections/reflection-reference.js';
import type { ReflectionVector } from '../../packages/core/src/reflections/reflection-reference.js';
import { createGiCamera } from '../../packages/core/src/gi/room-geometry.js';
import { reflectionSurface } from '../../packages/core/src/reflections/reflection-scene.js';

function fixture() {
  const buffers: { descriptor: GPUBufferDescriptor; bytes: Uint8Array<ArrayBuffer>; destroy: ReturnType<typeof vi.fn> }[] = [];
  const textures: { descriptor: GPUTextureDescriptor; destroy: ReturnType<typeof vi.fn>; createView: ReturnType<typeof vi.fn> }[] = [];
  let failView = false;
  const device = {
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 ** 2, maxStorageBufferBindingSize: 128 * 1024 ** 2 },
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => { const value = { descriptor, bytes: new Uint8Array(descriptor.size), destroy: vi.fn() }; buffers.push(value); return value; }),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const fail = failView; failView = false;
      const texture = { descriptor, destroy: vi.fn(), createView: vi.fn(() => { if (fail) throw new Error('view failed'); return {}; }) };
      textures.push(texture); return texture;
    }),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => ({ descriptor })), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createShaderModule: vi.fn(() => ({})), createComputePipelineAsync: vi.fn(async () => ({})),
    queue: { writeBuffer: vi.fn((buffer: typeof buffers[number], offset: number, source: ArrayBuffer | ArrayBufferView<ArrayBuffer>) => {
      const bytes = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
      buffer.bytes.set(bytes, offset);
    }) },
  };
  const passes: { setPipeline: ReturnType<typeof vi.fn>; setBindGroup: ReturnType<typeof vi.fn>; dispatchWorkgroups: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }[] = [];
  const encoder = { beginComputePass: vi.fn((_descriptor?: GPUComputePassDescriptor) => { const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() }; passes.push(pass); return pass; }) };
  const entries = [0, 1, 2, 3, 4].map(binding => ({ binding, resource: { buffer: {} as GPUBuffer } }));
  const frame: ReflectionFrame = { outputs: { hdr: {}, normal: {}, material: {}, depth: {}, motion: {} } as ReflectionFrame['outputs'],
    camera: createGiCamera(1280, 720, 0, [0, 0], 'receiver'), width: 1280, height: 720, frameIndex: 0, worldRevision: 1,
    controls: {}, probes: { irradiance: {}, visibility: {}, state: {}, uniform: {} } as ReflectionFrame['probes'], giEnabled: true };
  return { raw: device, device: device as unknown as GPUDevice, encoder: encoder as unknown as GPUCommandEncoder, rawEncoder: encoder, frame, passes, buffers, textures,
    create: (options: ReflectionCacheOptions = {}) => ReflectionCache.create(device as unknown as GPUDevice, entries, options),
    failNextView: () => { failView = true; } };
}

function config(cache: ReflectionCache): Uint32Array {
  return new Uint32Array((cache.diagnostics.configBuffer as unknown as { bytes: Uint8Array<ArrayBuffer> }).bytes.buffer);
}

describe('reflection estimator and history qualification', () => {
  it('returns the exact perfect-mirror direction and Fresnel weight independently of random samples', () => {
    const view: ReflectionVector = [-0.6, 0.8, 0]; const normal: ReflectionVector = [0, 1, 0];
    const expected = reflectionFresnel([0.85, 0.85, 0.85], 0.8);
    for (const random of [[0, 0], [0.9, 0.2]] as const) {
      const sample = sampleReflectionDirection(view, normal, 0, random);
      expect(sample.direction).toEqual([0.6, 0.8, 0]); expect(sample.weight).toEqual(expected);
    }
  });

  it('keeps GGX VNDF samples normalized and energy bounded at normal and grazing incidence', () => {
    for (const roughness of [0.001, 0.08, 0.35]) for (const view of [[0, 0, 1], [Math.sqrt(1 - 0.01 ** 2), 0, 0.01]] as ReflectionVector[]) {
      let energy = 0;
      for (let index = 0; index < 1024; index++) {
        const result = sampleReflectionDirection(view, [0, 0, 1], roughness, [(index + 0.5) / 1024, (index * 0.61803398875) % 1]);
        expect(Math.hypot(...result.direction)).toBeCloseTo(1, 10);
        expect(result.weight.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
        if (result.direction[2] <= 0) expect(result.weight).toEqual([0, 0, 0]);
        energy += result.weight[0];
      }
      expect(energy / 1024).toBeGreaterThan(0.2); expect(energy / 1024).toBeLessThanOrEqual(1);
    }
    expect(() => sampleReflectionDirection([0, 0, 2], [0, 0, 1], 0.1, [0, 0])).toThrow();
  });

  it('rejects history for stale epochs, disocclusion, different normals/roughness and expired samples', () => {
    const query = { epoch: 2, frameIndex: 10, maxAge: 4, depth: 3, normal: [0, 1, 0] as const, roughness: 0.08 };
    const tap = { epoch: 2, freshFrame: 8, source: 1, depth: 3, normal: [0, 1, 0] as const, roughness: 0.08, reflector: true };
    expect(acceptsReflectionHistory(query, tap)).toBe(true);
    for (const patch of [{ epoch: 1 }, { freshFrame: 11 }, { freshFrame: 5 }, { depth: 0 }, { depth: 3.1 },
      { normal: [1, 0, 0] as const }, { roughness: 0.2 }, { reflector: false }, { source: 2 }, { source: 4 }]) {
      expect(acceptsReflectionHistory(query, { ...tap, ...patch })).toBe(false);
    }
    expect(acceptsReflectionHistory(query, { ...tap, freshFrame: 6, source: 3 })).toBe(true);
  });

  it('bounds the projected reflector and handles near-plane crossings conservatively', () => {
    const camera = createGiCamera(1280, 720, 0, [0, 0], 'receiver');
    const region = reflectionCandidateRegion(camera, 320, 180, reflectionSurface);
    expect(region.width * region.height).toBeGreaterThan(0); expect(region.width * region.height).toBeLessThan(320 * 180);
    expect(region.x).toBeGreaterThanOrEqual(0); expect(region.x + region.width).toBeLessThanOrEqual(320);
    expect(region.y).toBeGreaterThanOrEqual(0); expect(region.y + region.height).toBeLessThanOrEqual(180);
    const invalid = { ...camera, viewProjection: new Float32Array(16) };
    expect(reflectionCandidateRegion(invalid, 320, 180, reflectionSurface)).toEqual({ x: 0, y: 0, width: 320, height: 180 });
  });
});

describe('bounded reflection cache ownership', () => {
  it('validates controls and capacities before allocation', async () => {
    expect(normalizeReflectionControls()).toMatchObject({ mode: 'world', roughness: 0.08, maxDistance: 16, updateEvery: 1 });
    for (const input of [{ roughness: -0.1 }, { roughness: 0.351 }, { maxDistance: 0 }, { maxDistance: 33 },
      { updateEvery: 0 }, { updateEvery: 1.5 }, { objectOffset: 0.41 }]) expect(() => normalizeReflectionControls(input)).toThrow();
    for (const name of ['mode', 'roughness', 'maxDistance', 'updateEvery', 'objectOffset', 'resetHistory']) {
      expect(() => normalizeReflectionControls({ [name]: null })).toThrow('null');
    }
    expect(normalizeReflectionControls({ roughness: undefined } as unknown as Parameters<typeof normalizeReflectionControls>[0]).roughness).toBe(0.08);
    for (const options of [{ maxRaysPerFrame: 0 }, { maxRaysPerFrame: 131073 }, { resolutionScale: 0.75 as 0.25 }]) {
      const gpu = fixture(); await expect(gpu.create(options)).rejects.toThrow(); expect(gpu.buffers).toHaveLength(0);
    }
    for (const name of ['maxRaysPerFrame', 'resolutionScale']) {
      const gpu = fixture(); await expect(gpu.create({ [name]: null })).rejects.toThrow('non-null'); expect(gpu.buffers).toHaveLength(0);
    }
  });

  it('keeps exact resource accounting, bounded windows, pass timestamps and nullable unread GPU counters', async () => {
    const gpu = fixture(); const cache = await gpu.create({ maxRaysPerFrame: 32 });
    const trace = {} as GPUComputePassTimestampWrites; const resolve = {} as GPUComputePassTimestampWrites;
    const result = cache.encode(gpu.encoder, { ...gpu.frame, timestamps: { trace, resolve } });
    expect(result.dispatchCalls).toBe(2); expect(result.uploadBytes).toBe(272);
    expect(gpu.rawEncoder.beginComputePass.mock.calls.map(call => call[0])).toEqual([
      { label: 'Strata selective reflection trace', timestampWrites: trace }, { label: 'Strata reflection temporal reconstruction', timestampWrites: resolve },
    ]);
    expect([...config(cache).subarray(44, 46)]).toEqual([0, 32]);
    expect(cache.gpuBufferBytes).toBe(512); expect(cache.gpuTextureBytes).toBe(320 * 180 * reflectionCacheLayout.textureBytesPerPixel);
    expect(result.bindings).not.toBe(cache.bindings);
    cache.submitted(1); expect(cache.bindings).toBe(result.bindings);
    expect(cache.telemetry).toMatchObject({ sourceFrameId: 1, scheduledCandidates: 32, maxPrimaryRays: 32, maxShadowRays: 32,
      actualPrimaryRays: null, actualShadowRays: null, traceFailures: null, cacheEpoch: 1, submittedFrames: 1 });
    cache.encode(gpu.encoder, { ...gpu.frame, frameIndex: 1 }); expect([...config(cache).subarray(44, 46)]).toEqual([32, 32]);
    cache.submitted(2); expect(cache.telemetry.totalScheduledCandidates).toBe(64); cache.dispose();
    expect([...gpu.buffers, ...gpu.textures].every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
  });

  it('does no tracing in disabled/probe-only modes and retains previously allocated histories', async () => {
    for (const mode of ['off', 'probe-only'] as const) {
      const gpu = fixture(); const cache = await gpu.create();
      const initial = cache.encode(gpu.encoder, { ...gpu.frame, controls: { mode } });
      expect(initial.dispatchCalls).toBe(0); expect(initial.uploadBytes).toBe(240); expect(gpu.passes).toHaveLength(0);
      expect(cache.gpuTextureBytes).toBe(88); cache.submitted(1);
      cache.encode(gpu.encoder, { ...gpu.frame, frameIndex: 1 }); cache.submitted(2); const allocated = cache.gpuTextureBytes;
      gpu.rawEncoder.beginComputePass.mockClear(); cache.encode(gpu.encoder, { ...gpu.frame, frameIndex: 2, controls: { mode } });
      cache.submitted(3); expect(gpu.rawEncoder.beginComputePass).not.toHaveBeenCalled(); expect(cache.gpuTextureBytes).toBe(allocated);
      expect(cache.telemetry).toMatchObject({ mode, maxPrimaryRays: 0, maxShadowRays: 0 }); cache.dispose();
    }
  });

  it('skips bounded update frames but continues resolve and expires history within sixteen frames', async () => {
    const gpu = fixture(); const cache = await gpu.create({ maxRaysPerFrame: 1 });
    for (let frameIndex = 0; frameIndex < 5; frameIndex++) {
      const result = cache.encode(gpu.encoder, { ...gpu.frame, frameIndex, controls: { updateEvery: 4 } });
      expect(result.dispatchCalls).toBe(frameIndex % 4 === 0 ? 2 : 1); cache.submitted(frameIndex + 1);
    }
    expect(cache.telemetry).toMatchObject({ traceFrames: 2, totalScheduledCandidates: 2, maxHistoryAge: 16 }); cache.dispose();
  });

  it('commits frontier and history only after submission and retries cancelled work unchanged', async () => {
    const gpu = fixture(); const cache = await gpu.create({ maxRaysPerFrame: 32 });
    cache.encode(gpu.encoder, gpu.frame); const pending = [...config(cache)]; cache.cancelFrame();
    expect(cache.telemetry).toMatchObject({ sourceFrameId: null, cacheEpoch: 0, submittedFrames: 0, totalScheduledCandidates: 0 });
    cache.encode(gpu.encoder, gpu.frame); expect([...config(cache)]).toEqual(pending); cache.submitted(1);
    const before = cache.bindings; cache.encode(gpu.encoder, { ...gpu.frame, frameIndex: 1, worldRevision: 2 }); cache.cancelFrame();
    expect(cache.bindings).toBe(before); expect(cache.telemetry.cacheEpoch).toBe(1);
    cache.encode(gpu.encoder, { ...gpu.frame, frameIndex: 1, worldRevision: 2 }); cache.submitted(2);
    expect(cache.telemetry).toMatchObject({ cacheEpoch: 2, framesSinceReset: 1, scheduledCandidates: 32 }); cache.dispose();
  });

  it('invalidates world/settings/camera changes while projection jitter preserves the epoch', async () => {
    const gpu = fixture(); const cache = await gpu.create();
    cache.encode(gpu.encoder, gpu.frame); cache.submitted(1);
    cache.encode(gpu.encoder, { ...gpu.frame, frameIndex: 1, camera: createGiCamera(1280, 720, 0, [0.25, -0.4], 'receiver') });
    expect(config(cache)[52]).toBe(0); cache.submitted(2); expect(cache.telemetry.cacheEpoch).toBe(1);
    cache.encode(gpu.encoder, { ...gpu.frame, frameIndex: 2, camera: createGiCamera(1280, 720, 0, [0, 0], 'tour') });
    expect(config(cache)[52]).toBe(1); cache.submitted(3); expect(cache.telemetry.cacheEpoch).toBe(2);
    cache.encode(gpu.encoder, { ...gpu.frame, frameIndex: 3, controls: { roughness: 0.3 } }); cache.submitted(4);
    expect(cache.telemetry.cacheEpoch).toBe(3); cache.dispose();
  });

  it('rotates a limited quota across moving-camera regions while invalidating history and preserving cancelled work', async () => {
    const gpu = fixture(); const cache = await gpu.create({ maxRaysPerFrame: 256 });
    let committedFrontier = 0;
    const starts: number[] = [];
    for (let frameIndex = 0; frameIndex < 12; frameIndex++) {
      const camera = createGiCamera(1280, 720, frameIndex / 60, [0, 0], 'tour');
      const frame = { ...gpu.frame, camera, frameIndex };
      const region = reflectionCandidateRegion(camera, 320, 180, reflectionSurface);
      const regionPixels = region.width * region.height;
      expect(regionPixels).toBeGreaterThan(256);
      cache.encode(gpu.encoder, frame);
      const words = [...config(cache)]; const start = words[44]!;
      expect(start).toBe(committedFrontier % regionPixels);
      expect(words.slice(45, 48)).toEqual([256, regionPixels, 1]);
      expect(words.slice(56, 60)).toEqual([region.x, region.y, region.width, region.height]);
      expect(words[41]).toBe(frameIndex + 1); expect(words[52]).toBe(1);
      if (frameIndex === 5) {
        cache.cancelFrame();
        expect(cache.telemetry).toMatchObject({ submittedFrames: 5, totalScheduledCandidates: 5 * 256, cacheEpoch: 5 });
        cache.encode(gpu.encoder, frame); expect([...config(cache)]).toEqual(words);
      }
      starts.push(start); committedFrontier = (start + 256) % regionPixels;
      cache.submitted(frameIndex + 1);
      expect(cache.telemetry).toMatchObject({ cacheEpoch: frameIndex + 1, framesSinceReset: 1, maxPrimaryRays: 256 });
    }
    expect(new Set(starts).size).toBeGreaterThan(1);
    cache.encode(gpu.encoder, { ...gpu.frame, frameIndex: 12, reset: true });
    expect(config(cache)[44]).toBe(0); cache.submitted(13);
    cache.encode(gpu.encoder, { ...gpu.frame, frameIndex: 13, worldRevision: 2 });
    expect(config(cache)[44]).toBe(0); cache.dispose();
  });

  it('refreshes after a cancelled resize even when returning to the previously committed dimensions', async () => {
    const gpu = fixture(); const cache = await gpu.create(); const controls = { updateEvery: 4 };
    cache.encode(gpu.encoder, { ...gpu.frame, controls }); cache.submitted(1);
    cache.encode(gpu.encoder, { ...gpu.frame, frameIndex: 1, width: 1920, height: 1080, controls }); cache.cancelFrame();
    const retried = cache.encode(gpu.encoder, { ...gpu.frame, frameIndex: 1, controls });
    expect(config(cache)[52]).toBe(1); expect(retried.dispatchCalls).toBe(2); cache.submitted(2);
    expect(cache.telemetry).toMatchObject({ cacheEpoch: 2, framesSinceReset: 1 }); cache.dispose();
  });

  it('preserves resources on failed resize and releases every partial or successful target once', async () => {
    const gpu = fixture(); const cache = await gpu.create(); cache.encode(gpu.encoder, gpu.frame); cache.submitted(1);
    const old = cache.bindings; const bytes = cache.gpuTextureBytes; gpu.failNextView();
    expect(() => cache.encode(gpu.encoder, { ...gpu.frame, frameIndex: 1, width: 1920, height: 1080 })).toThrow('view failed');
    expect(cache.bindings).toBe(old); expect(cache.gpuTextureBytes).toBe(bytes);
    cache.encode(gpu.encoder, { ...gpu.frame, frameIndex: 1, width: 1920, height: 1080 }); cache.submitted(2);
    expect(cache.bindings).not.toBe(old); expect(cache.gpuTextureBytes).toBe(480 * 270 * 88);
    cache.dispose(); cache.dispose(); expect(cache.gpuBufferBytes + cache.gpuTextureBytes).toBe(0);
    expect([...gpu.buffers, ...gpu.textures].every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
    expect(() => cache.encode(gpu.encoder, gpu.frame)).toThrow('disposed');
  });

  it('cleans buffers and textures after target creation fails', async () => {
    const gpu = fixture(); gpu.failNextView(); await expect(gpu.create()).rejects.toThrow('view failed');
    expect([...gpu.buffers, ...gpu.textures].every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
  });
});
