import { describe, expect, it, vi } from 'vitest';
import { TemporalResolve } from '../../packages/core/src/rendering/temporal-resolve.js';
import { acceptsTemporalHistory, blendDepthQualifiedHistory } from '../../packages/core/src/rendering/temporal-reprojection.js';
import type { TemporalInputs } from '../../packages/core/src/rendering/raster-types.js';

describe('temporal motion and disocclusion contract', () => {
  it('reprojects with previousUV-currentUV and rejects motion leaving either image edge', () => {
    expect(acceptsTemporalHistory([0.5, 0.5], [0.2, -0.1, 10, 10], 10)).toBe(true);
    expect(acceptsTemporalHistory([0.9, 0.5], [0.2, 0, 10, 10], 10)).toBe(false);
    expect(acceptsTemporalHistory([0.1, 0.5], [-0.2, 0, 10, 10], 10)).toBe(false);
    expect(acceptsTemporalHistory([0.5, 0.9], [0, 0.2, 10, 10], 10)).toBe(false);
    expect(acceptsTemporalHistory([0.5, 0.1], [0, -0.2, 10, 10], 10)).toBe(false);
  });

  it('compares history depth against expected prior depth rather than current depth', () => {
    // A moving surface is now at depth 10 but was at 20 last frame.
    expect(acceptsTemporalHistory([0.5, 0.5], [0, 0, 10, 20], 20)).toBe(true);
    expect(acceptsTemporalHistory([0.5, 0.5], [0, 0, 10, 20], 10)).toBe(false);
    // A newly uncovered surface must reject a nearer old occluder.
    expect(acceptsTemporalHistory([0.5, 0.5], [0, 0, 100, 100], 80)).toBe(false);
    expect(acceptsTemporalHistory([0.5, 0.5], [0, 0, 100, 100], 100.3)).toBe(true);
    expect(acceptsTemporalHistory([0.5, 0.5], [0, 0, 0.2, 0.2], 0.21)).toBe(true);
  });

  it('rejects background, invalid prior geometry, and non-finite samples', () => {
    for (const motion of [[0, 0, 0, 10], [0, 0, 10, 0], [NaN, 0, 10, 10], [0, 0, 10, Infinity]] as const) {
      expect(acceptsTemporalHistory([0.5, 0.5], motion, 10)).toBe(false);
    }
    for (const historyDepth of [0, -1, NaN, Infinity]) {
      expect(acceptsTemporalHistory([0.5, 0.5], [0, 0, 10, 10], historyDepth)).toBe(false);
    }
  });
});

describe('depth-qualified history filtering', () => {
  it('preserves asymmetric bilinear weights when all four depths match', () => {
    const result = blendDepthQualifiedHistory([
      [1, 0, 0, 10], [0, 1, 0, 10], [0, 0, 1, 10], [1, 1, 1, 10],
    ], [0.25, 0.75], 10);
    expect(result).toEqual([0.375, 0.25, 0.75]);
  });

  it('excludes bright mismatched-depth taps and renormalizes the accepted colors', () => {
    const result = blendDepthQualifiedHistory([
      [1, 0, 0, 10], [0, 100, 0, 5], [0, 100, 0, 20], [0, 0, 1, 10],
    ], [0.2, 0.6], 10)!;
    expect(result[0]).toBeCloseTo(0.32 / 0.44, 10);
    expect(result[1]).toBe(0);
    expect(result[2]).toBeCloseTo(0.12 / 0.44, 10);
    // Even when the nearest texel belongs to an occluder, other valid taps can contribute.
    expect(blendDepthQualifiedHistory([
      [100, 0, 0, 5], [0, 0, 1, 10], [0, 0, 1, 10], [0, 0, 1, 10],
    ], [0.25, 0.25], 10)).toEqual([0, 0, 1]);
  });

  it('falls back when no weighted tap matches and handles duplicated clamped edge taps', () => {
    expect(blendDepthQualifiedHistory([
      [1, 1, 1, 2], [1, 1, 1, 3], [1, 1, 1, 4], [1, 1, 1, 5],
    ], [0.2, 0.8], 10)).toBeNull();
    expect(blendDepthQualifiedHistory([
      [100, 0, 0, 5], [0, 0, 1, 10], [0, 0, 1, 10], [0, 0, 1, 10],
    ], [0, 0], 10)).toBeNull();
    // At an image edge, clamping can select each texel twice; its weights still sum correctly.
    expect(blendDepthQualifiedHistory([
      [1, 0, 0, 10], [1, 0, 0, 10], [0, 100, 0, 20], [0, 100, 0, 20],
    ], [0.2, 0.25], 10)).toEqual([1, 0, 0]);
  });
});

function fixture() {
  const buffers: { destroy: ReturnType<typeof vi.fn>; size: number }[] = [];
  const textures: { destroy: ReturnType<typeof vi.fn>; createView: ReturnType<typeof vi.fn>; view: object }[] = [];
  const writes: Uint32Array[] = [];
  const groups: { descriptor: GPUBindGroupDescriptor }[] = [];
  const device = {
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024 },
    queue: { writeBuffer: vi.fn((_buffer: unknown, _offset: number, data: Uint32Array) => { writes.push(new Uint32Array(data)); }) },
    createShaderModule: vi.fn(() => ({})),
    createRenderPipelineAsync: vi.fn(async () => ({ getBindGroupLayout: vi.fn(() => ({})) })),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { size: descriptor.size, destroy: vi.fn() };
      buffers.push(buffer);
      return buffer;
    }),
    createTexture: vi.fn(() => {
      const view = {};
      const texture = { destroy: vi.fn(), createView: vi.fn(() => view), view };
      textures.push(texture);
      return texture;
    }),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => {
      const group = { descriptor };
      groups.push(group);
      return group;
    }),
  };
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn((_index: number, _group: GPUBindGroup) => {}), draw: vi.fn(), end: vi.fn() };
  const encoder = { beginRenderPass: vi.fn((_descriptor: GPURenderPassDescriptor) => pass) };
  const inputs = { hdr: {} as GPUTextureView, motion: {} as GPUTextureView } satisfies TemporalInputs;
  return { device, buffers, textures, writes, groups, encoder, pass, inputs };
}

describe('temporal history ownership and reset behavior', () => {
  it('keeps history read and write distinct, reuses bindings, and obeys first-frame/reset invalidation', async () => {
    const gpu = fixture();
    const resolve = await TemporalResolve.create(gpu.device as unknown as GPUDevice);
    expect(resolve.initialUploadBytes).toBe(0);
    expect(resolve.gpuBufferBytes).toBe(16);
    expect(resolve.gpuTextureBytes).toBe(0);
    const encoder = gpu.encoder as unknown as GPUCommandEncoder;
    const timestamps = { querySet: {} as GPUQuerySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
    const first = resolve.encode(encoder, gpu.inputs, 640, 360, true, timestamps);
    const second = resolve.encode(encoder, gpu.inputs, 640, 360, true);
    const reset = resolve.encode(encoder, gpu.inputs, 640, 360, false);
    const resumed = resolve.encode(encoder, gpu.inputs, 640, 360, true);
    expect([first.historyValid, second.historyValid, reset.historyValid, resumed.historyValid]).toEqual([false, true, false, true]);
    expect(first.view).not.toBe(second.view);
    expect(reset.view).toBe(first.view);
    expect(resumed.view).toBe(second.view);
    expect(gpu.writes.map(write => [...write])).toEqual([[640, 360, 0, 0], [640, 360, 1, 0], [640, 360, 0, 0], [640, 360, 1, 0]]);
    expect(gpu.device.createTexture).toHaveBeenCalledTimes(2);
    expect(gpu.device.createBindGroup).toHaveBeenCalledTimes(2);
    expect(resolve.gpuTextureBytes).toBe(640 * 360 * 16);
    expect(first).toMatchObject({ drawCalls: 1, dispatchCalls: 0, uploadBytes: 16 });
    expect(gpu.encoder.beginRenderPass).toHaveBeenNthCalledWith(1, expect.objectContaining({ timestampWrites: timestamps }));
    for (let index = 0; index < 4; index++) {
      const descriptor = gpu.encoder.beginRenderPass.mock.calls[index]![0] as GPURenderPassDescriptor;
      const output = Array.from(descriptor.colorAttachments)[0]!;
      const group = gpu.pass.setBindGroup.mock.calls[index]![1] as unknown as { descriptor: GPUBindGroupDescriptor };
      const historyBinding = Array.from(group.descriptor.entries).find(entry => entry.binding === 2)!;
      expect(historyBinding.resource).not.toBe(output.view);
      expect(Array.from(group.descriptor.entries).map(entry => entry.binding)).toEqual([0, 1, 2, 3]);
    }
    resolve.dispose();
  });

  it('reallocates both histories on resize and destroys every owned allocation once', async () => {
    const gpu = fixture();
    const resolve = await TemporalResolve.create(gpu.device as unknown as GPUDevice);
    const encoder = gpu.encoder as unknown as GPUCommandEncoder;
    resolve.encode(encoder, gpu.inputs, 320, 180, true);
    resolve.encode(encoder, gpu.inputs, 320, 180, true);
    const resized = resolve.encode(encoder, gpu.inputs, 1280, 720, true);
    expect(resized.historyValid).toBe(false);
    expect(resolve.gpuTextureBytes).toBe(1280 * 720 * 16);
    expect(gpu.textures).toHaveLength(4);
    expect(gpu.textures[0]!.destroy).toHaveBeenCalledOnce();
    expect(gpu.textures[1]!.destroy).toHaveBeenCalledOnce();
    expect(gpu.textures[2]!.destroy).not.toHaveBeenCalled();
    resolve.dispose();
    resolve.dispose();
    for (const buffer of gpu.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    for (const texture of gpu.textures) expect(texture.destroy).toHaveBeenCalledOnce();
    expect(resolve.gpuBufferBytes).toBe(0);
    expect(resolve.gpuTextureBytes).toBe(0);
    expect(() => resolve.encode(encoder, gpu.inputs, 1280, 720, true)).toThrowError(expect.objectContaining({ code: 'ENGINE_DISPOSED' }));
  });

  it('preserves old history and cleans partial resize resources when a new view fails', async () => {
    const gpu = fixture();
    const resolve = await TemporalResolve.create(gpu.device as unknown as GPUDevice);
    const encoder = gpu.encoder as unknown as GPUCommandEncoder;
    resolve.encode(encoder, gpu.inputs, 320, 180, true);
    const createTexture = gpu.device.createTexture.getMockImplementation()!;
    gpu.device.createTexture.mockImplementationOnce(createTexture).mockImplementationOnce(() => {
      const texture = createTexture();
      texture.createView.mockImplementationOnce(() => { throw new Error('view creation failed'); });
      return texture;
    });
    expect(() => resolve.encode(encoder, gpu.inputs, 640, 360, true)).toThrow('view creation failed');
    expect(resolve.gpuTextureBytes).toBe(320 * 180 * 16);
    expect(gpu.textures[0]!.destroy).not.toHaveBeenCalled();
    expect(gpu.textures[1]!.destroy).not.toHaveBeenCalled();
    expect(gpu.textures[2]!.destroy).toHaveBeenCalledOnce();
    expect(gpu.textures[3]!.destroy).toHaveBeenCalledOnce();
    expect(resolve.encode(encoder, gpu.inputs, 320, 180, true).historyValid).toBe(true);
    resolve.dispose();
  });

  it('validates dimensions before allocation and releases initialization failures', async () => {
    const gpu = fixture();
    const resolve = await TemporalResolve.create(gpu.device as unknown as GPUDevice);
    const encoder = gpu.encoder as unknown as GPUCommandEncoder;
    for (const [width, height] of [[0, 1], [1, 8193], [1.5, 360], [Infinity, 1]]) {
      expect(() => resolve.encode(encoder, gpu.inputs, width!, height!, true)).toThrowError(expect.objectContaining({ code: 'INVALID_SIZE' }));
    }
    expect(gpu.textures).toHaveLength(0);
    expect(gpu.writes).toHaveLength(0);
    resolve.dispose();
    const compileFailure = fixture();
    compileFailure.device.createRenderPipelineAsync.mockRejectedValueOnce(new Error('compile failed'));
    await expect(TemporalResolve.create(compileFailure.device as unknown as GPUDevice)).rejects.toThrow('compile failed');
    expect(compileFailure.buffers).toHaveLength(0);
    const bindingFailure = fixture();
    const failed = await TemporalResolve.create(bindingFailure.device as unknown as GPUDevice);
    bindingFailure.device.createBindGroup.mockImplementationOnce(() => { throw new Error('binding failed'); });
    expect(() => failed.encode(bindingFailure.encoder as unknown as GPUCommandEncoder, bindingFailure.inputs, 320, 180, false)).toThrow('binding failed');
    failed.dispose();
    for (const resource of [...bindingFailure.buffers, ...bindingFailure.textures]) expect(resource.destroy).toHaveBeenCalledOnce();
  });
});
