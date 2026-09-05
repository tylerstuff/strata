import { describe, expect, it, vi } from 'vitest';
import { ProbeCache, probeCacheLayout } from '../../packages/core/src/gi/probe-cache.js';
import { encodeOctahedral, integrateProbeIrradiance, octahedralDirection, probeDirection, probeHistoryWeight, probeVisibility, wrapOctahedralTexel } from '../../packages/core/src/gi/probe-cache-reference.js';
import type { ProbeVector } from '../../packages/core/src/gi/probe-cache-reference.js';

function fixture() {
  const buffers: { descriptor: GPUBufferDescriptor; bytes: Uint8Array<ArrayBuffer>; destroy: ReturnType<typeof vi.fn> }[] = [];
  const textures: { descriptor: GPUTextureDescriptor; createView: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[] = [];
  const device = {
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => { const buffer = { descriptor, bytes: new Uint8Array(descriptor.size), destroy: vi.fn() }; buffers.push(buffer); return buffer; }),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => { const texture = { descriptor, createView: vi.fn(() => ({})), destroy: vi.fn() }; textures.push(texture); return texture; }),
    createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})), createPipelineLayout: vi.fn(() => ({})),
    createComputePipelineAsync: vi.fn(async () => ({})), createBindGroup: vi.fn(() => ({})),
    queue: { writeBuffer: vi.fn((buffer: typeof buffers[number], offset: number, input: ArrayBuffer | Uint32Array<ArrayBuffer>) => {
      buffer.bytes.set(input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength), offset);
    }) },
  };
  const passes: { setPipeline: ReturnType<typeof vi.fn>; setBindGroup: ReturnType<typeof vi.fn>; dispatchWorkgroups: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }[] = [];
  const encoder = { copyTextureToTexture: vi.fn(), beginComputePass: vi.fn(() => {
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() }; passes.push(pass); return pass;
  }) };
  const entries = [0, 1, 2, 3, 4].map(binding => ({ binding, resource: { buffer: {} as GPUBuffer } }));
  const create = (options = {}) => ProbeCache.create(device as unknown as GPUDevice, entries, options);
  return { buffers, textures, device, encoder: encoder as unknown as GPUCommandEncoder, rawEncoder: encoder, passes, create };
}

describe('probe quadrature and visibility reference', () => {
  it('preserves constant radiance energy and Lambertian albedo/pi normalization', () => {
    const radiance: ProbeVector = [2, 0.5, 0.25];
    const rays = Array.from({ length: 64 }, (_, index) => ({ direction: probeDirection(index, 64), radiance }));
    for (const normal of [[1, 0, 0], [0, 1, 0], [0, 0, -1]] as const) {
      const irradiance = integrateProbeIrradiance(normal, rays);
      expect(irradiance[0]).toBeCloseTo(2 * Math.PI, 12);
      expect(irradiance[1]).toBeCloseTo(0.5 * Math.PI, 12);
      expect(irradiance[2] * 0.8 / Math.PI).toBeCloseTo(0.2, 12);
    }
    const dark = rays.map(ray => ({ ...ray, radiance: [0, 0, 0] as const }));
    expect(integrateProbeIrradiance([0, 1, 0], dark)).toEqual([0, 0, 0]);
  });

  it('roundtrips all atlas directions including the folded negative hemisphere', () => {
    for (let index = 0; index < 256; index++) {
      const direction = probeDirection(index, 256); const uv = encodeOctahedral(direction); const decoded = octahedralDirection(...uv);
      expect(Math.hypot(...decoded)).toBeCloseTo(1, 12);
      decoded.forEach((component, axis) => expect(component).toBeCloseTo(direction[axis]!, 12));
    }
  });

  it('folds octahedral border taps into the same tile with continuous edge values', () => {
    for (const size of [8, 16]) {
      for (let x = -1; x <= size; x++) for (let y = -1; y <= size; y++) {
        const tap = wrapOctahedralTexel(x, y, size);
        expect(tap.every(value => value >= 0 && value < size)).toBe(true);
      }
      expect(wrapOctahedralTexel(-1, 2, size)).toEqual([0, size - 3]);
      expect(wrapOctahedralTexel(size, 2, size)).toEqual([size - 1, size - 3]);
      expect(wrapOctahedralTexel(-1, -1, size)).toEqual([size - 1, size - 1]);
      // Opposite halves of the same octahedral edge represent the same sphere direction.
      for (let y = 0; y < size; y++) {
        const first = octahedralDirection(0, (y + 0.5) / size);
        const folded = octahedralDirection(0, 1 - (y + 0.5) / size);
        expect(first[0]).toBeCloseTo(folded[0], 12);
        expect(first[2]).toBeCloseTo(folded[2], 12);
      }
    }
  });

  it('strongly attenuates a receiver behind a thin wall and rejects stale epochs', () => {
    expect(probeVisibility(0.4, 0.5, 0.25)).toBe(1);
    expect(probeVisibility(0.51, 0.5, 0.25)).toBe(1);
    expect(probeVisibility(0.8, 0.5, 0.25)).toBeLessThan(2e-9);
    expect(probeVisibility(0.8, 0.5, 0.3)).toBeGreaterThan(probeVisibility(0.8, 0.5, 0.25));
    expect(probeVisibility(31, 32, 1024)).toBe(1);
    expect(probeHistoryWeight(1, 2, true, 0.85)).toBe(0);
    expect(probeHistoryWeight(2, 2, false, 0.85)).toBe(0);
    expect(probeHistoryWeight(2, 2, true, 0.85)).toBe(0.85);
  });
});

describe('bounded probe resources and submission state', () => {
  it('accounts every atlas/buffer allocation and encodes exactly two bounded compute passes', async () => {
    const gpu = fixture(); const cache = await gpu.create();
    expect(cache.gpuBufferBytes).toBe(2 * 96 + 384 * 16 + 32 * 64 * 32 + 32);
    expect(cache.gpuTextureBytes).toBe(1_966_080);
    expect(gpu.buffers.reduce((sum, buffer) => sum + buffer.descriptor.size, 0)).toBe(cache.gpuBufferBytes);
    expect(gpu.textures.map(texture => texture.descriptor.format)).toEqual(['rgba16float', 'rg32float', 'rgba16float', 'rg32float']);
    expect(gpu.buffers.every(buffer => (buffer.descriptor.usage & 0x4) !== 0)).toBe(true);
    expect(gpu.textures.every(texture => (texture.descriptor.usage & 0x1) !== 0)).toBe(true);
    const frame = cache.encode(gpu.encoder, { revision: 1, frameIndex: 0 });
    expect(frame).toMatchObject({ dispatchCalls: 2, uploadBytes: 128, primaryRays: 2048, probeUpdates: 32 });
    expect(gpu.passes.map(pass => pass.dispatchWorkgroups.mock.calls)).toEqual([[[32]], [[32]]]);
    expect(gpu.rawEncoder.copyTextureToTexture).toHaveBeenCalledTimes(2);
    expect(cache.initialUploadBytes).toBe(0);
    cache.dispose(); cache.dispose();
    expect([...gpu.buffers, ...gpu.textures].every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
    expect(cache.gpuBufferBytes + cache.gpuTextureBytes).toBe(0);
  });

  it('commits only submitted atlas/frontier/epoch and resets same-revision cache explicitly', async () => {
    const gpu = fixture(); const cache = await gpu.create(); const initial = cache.bindings;
    const first = cache.encode(gpu.encoder, { revision: 4, frameIndex: 1 });
    expect(first.bindings.irradiance).not.toBe(initial.irradiance);
    expect(cache.bindings).toEqual(initial);
    const config = () => new Uint32Array((cache.diagnostics.configBuffer as unknown as typeof gpu.buffers[number]).bytes.buffer);
    expect([...config().subarray(8, 12)]).toEqual([0, 32, 64, 1]);
    cache.cancelFrame();
    cache.encode(gpu.encoder, { revision: 4, frameIndex: 2 });
    expect([...config().subarray(8, 12)]).toEqual([0, 32, 64, 1]);
    cache.submitted(10);
    expect(cache.telemetry).toMatchObject({ worldRevision: 4, cacheEpoch: 1, sourceFrameId: 10, framesSinceReset: 1 });
    cache.encode(gpu.encoder, { revision: 4, frameIndex: 3 });
    expect([...config().subarray(8, 12)]).toEqual([32, 32, 64, 1]);
    cache.submitted(11);
    cache.encode(gpu.encoder, { revision: 4, frameIndex: 4, reset: true });
    expect([...config().subarray(8, 12)]).toEqual([0, 32, 64, 2]);
    cache.cancelFrame(); expect(cache.telemetry.cacheEpoch).toBe(1);
    cache.encode(gpu.encoder, { revision: 5, frameIndex: 5 }); cache.submitted(12);
    expect(cache.telemetry).toMatchObject({ worldRevision: 5, cacheEpoch: 2, framesSinceReset: 1, submittedFrames: 3 });
    cache.dispose();
  });

  it('bounds quality controls before allocation and cleans up failed construction', async () => {
    const gpu = fixture();
    await expect(gpu.create({ probesPerUpdate: 129 })).rejects.toThrow('1..128');
    await expect(gpu.create({ raysPerProbe: 0 })).rejects.toThrow('16..128');
    expect(gpu.device.createBuffer).not.toHaveBeenCalled();
    gpu.device.createBindGroup.mockImplementationOnce(() => { throw new Error('bind failure'); });
    await expect(gpu.create()).rejects.toThrow('bind failure');
    expect([...gpu.buffers, ...gpu.textures].every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
    expect(probeCacheLayout.grid.reduce((a, b) => a * b, 1)).toBe(384);
  });

  it('covers every probe during continuous soft revisions without committing canceled windows', async () => {
    const gpu = fixture(); const cache = await gpu.create(); const updates = new Uint32Array(384);
    const config = () => new Uint32Array((cache.diagnostics.configBuffer as unknown as typeof gpu.buffers[number]).bytes.buffer);
    for (let frame = 0; frame < 36; frame++) {
      const input = { revision: frame + 1, invalidationRevision: 1, frameIndex: frame };
      cache.encode(gpu.encoder, input);
      if (frame === 15) {
        const original = [...config().subarray(8, 12)]; cache.cancelFrame();
        expect(cache.telemetry.sourceFrameId).toBe(15);
        cache.encode(gpu.encoder, input); expect([...config().subarray(8, 12)]).toEqual(original);
      }
      expect([...config().subarray(8, 12)]).toEqual([(frame * 32) % 384, 32, 64, 1]);
      expect(config()[19]).toBe(12);
      for (let probe = 0; probe < 32; probe++) updates[(config()[8]! + probe) % 384]!++;
      cache.submitted(frame + 1);
      expect(cache.telemetry).toMatchObject({ worldRevision: frame + 1, diffuseInvalidationRevision: 1,
        cacheEpoch: 1, framesSinceReset: frame + 1, maxSampleAgeFrames: 11, sampleFrameIndex: frame });
      if (frame % 12 === 11) expect([...updates].every(count => count === (frame + 1) / 12)).toBe(true);
    }
    expect(cache.telemetry.refreshFrontier).toBe(0); cache.dispose();
  });

  it('retains hard invalidation across cancellation and bounds nondivisible refresh cycles', async () => {
    const gpu = fixture(); const cache = await gpu.create({ probesPerUpdate: 31 });
    const config = () => new Uint32Array((cache.diagnostics.configBuffer as unknown as typeof gpu.buffers[number]).bytes.buffer);
    cache.encode(gpu.encoder, { revision: 1, invalidationRevision: 1, frameIndex: 100 }); cache.submitted(1);
    cache.encode(gpu.encoder, { revision: 2, invalidationRevision: 2, frameIndex: 101 });
    expect([...config().subarray(8, 12)]).toEqual([0, 31, 64, 2]); cache.cancelFrame();
    expect(cache.telemetry).toMatchObject({ cacheEpoch: 1, diffuseInvalidationRevision: 1, refreshFrontier: 31 });
    cache.encode(gpu.encoder, { revision: 3, invalidationRevision: 2, frameIndex: 101 }); cache.submitted(2);
    expect(cache.telemetry).toMatchObject({ cacheEpoch: 2, diffuseInvalidationRevision: 2, framesSinceReset: 1, maxSampleAgeFrames: 12 });
    expect(config()[19]).toBe(13);
    cache.encode(gpu.encoder, { revision: 4, invalidationRevision: 2, frameIndex: 102, reset: true }); cache.submitted(3);
    expect(cache.telemetry.cacheEpoch).toBe(3);
    cache.encode(gpu.encoder, { revision: 5, invalidationRevision: 2, frameIndex: 0 }); cache.submitted(4);
    expect(cache.telemetry).toMatchObject({ cacheEpoch: 4, framesSinceReset: 1, sampleFrameIndex: 0 });
    for (const invalidationRevision of [-1, 0x100000000, NaN, null]) expect(() => cache.encode(gpu.encoder,
      { revision: 6, frameIndex: 1, invalidationRevision } as unknown as Parameters<ProbeCache['encode']>[1])).toThrow('uint32');
    cache.dispose();
  });
});
