import { describe, expect, it, vi } from 'vitest';
import { buildProceduralScene, createCameraMatrix, perspectiveMatrix } from '../../packages/core/src/rendering/scene-data.js';
import { SceneRenderer } from '../../packages/core/src/rendering/scene-renderer.js';

function transform(matrix: Float32Array, point: readonly number[]): number[] {
  return Array.from({ length: 4 }, (_, row) => point.reduce(
    (sum, value, column) => sum + matrix[column * 4 + row]! * value, 0,
  ));
}

describe('versioned procedural scene', () => {
  it('reproduces the full layout for the same seed and preserves geometry across seeds', () => {
    const first = buildProceduralScene();
    const second = buildProceduralScene({ seed: 1337, instanceCount: 512 });
    const changed = buildProceduralScene({ seed: 1338, instanceCount: 512 });
    expect(first.id).toBe('procedural-boxes-v1');
    expect(first.instances).toEqual(second.instances);
    expect(first.instances).not.toEqual(changed.instances);
    expect(first.vertices).toEqual(changed.vertices);
    expect(first.indices).toEqual(changed.indices);
    expect(first.instanceCount).toBe(513);
    expect(first.instances.byteLength).toBe(513 * 48);
  });

  it('produces finite boxes above ground with positive scale and outward cube winding', () => {
    const { instances, vertices, indices, halfExtent } = buildProceduralScene({ seed: 0, instanceCount: 128 });
    expect([...instances, ...vertices].every(Number.isFinite)).toBe(true);
    expect(indices).toHaveLength(36);
    expect(vertices).toHaveLength(24 * 8);
    expect(Math.max(...indices)).toBe(23);
    for (let offset = 12; offset < instances.length; offset += 12) {
      expect(instances[offset + 1]!).toBeCloseTo(instances[offset + 5]! / 2);
      expect(instances[offset + 4]!).toBeGreaterThan(0);
      expect(instances[offset + 5]!).toBeGreaterThan(0);
      expect(instances[offset + 6]!).toBeGreaterThan(0);
      expect(Math.abs(instances[offset]!)).toBeLessThan(halfExtent);
      expect(Math.abs(instances[offset + 2]!)).toBeLessThan(halfExtent);
      expect(instances[offset + 11]).toBe(1);
    }
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      const a = indices[triangle]! * 8;
      const b = indices[triangle + 1]! * 8;
      const c = indices[triangle + 2]! * 8;
      const edgeA = [0, 1, 2].map((axis) => vertices[b + axis]! - vertices[a + axis]!);
      const edgeB = [0, 1, 2].map((axis) => vertices[c + axis]! - vertices[a + axis]!);
      const cross = [
        edgeA[1]! * edgeB[2]! - edgeA[2]! * edgeB[1]!,
        edgeA[2]! * edgeB[0]! - edgeA[0]! * edgeB[2]!,
        edgeA[0]! * edgeB[1]! - edgeA[1]! * edgeB[0]!,
      ];
      const outward = cross.reduce((sum, value, axis) => sum + value * vertices[a + 3 + axis]!, 0);
      expect(outward).toBeGreaterThan(0);
    }
  });

  it('allows a ground-only fixture and rejects unsafe options before allocation', () => {
    const empty = buildProceduralScene({ instanceCount: 0, seed: 0xffffffff });
    expect(empty.instanceCount).toBe(1);
    expect(empty.instances[1]! + empty.instances[5]! / 2).toBeCloseTo(0);
    for (const instanceCount of [-1, 1.5, 100001, NaN, Infinity]) {
      expect(() => buildProceduralScene({ instanceCount })).toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    }
    for (const seed of [-1, 0x100000000, 1.5, NaN, Infinity]) {
      expect(() => buildProceduralScene({ seed })).toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    }
  });

  it('maps the near and far planes to WebGPU depth zero and one', () => {
    const near = 0.1;
    const far = 500;
    const projection = perspectiveMatrix(16 / 9, near, far);
    const nearClip = transform(projection, [0, 0, -near, 1]);
    const farClip = transform(projection, [0, 0, -far, 1]);
    expect(nearClip[2]! / nearClip[3]!).toBeCloseTo(0, 6);
    expect(farClip[2]! / farClip[3]!).toBeCloseTo(1, 6);
    expect(nearClip[3]).toBeGreaterThan(0);
  });

  it('keeps the look-at target centered and repeats the explicit twenty-second orbit', () => {
    const camera = createCameraMatrix(16 / 9, 3, 32.2);
    expect(camera).toEqual(createCameraMatrix(16 / 9, 23, 32.2));
    expect(camera).not.toEqual(createCameraMatrix(16 / 9, 8, 32.2));
    for (const time of [0, 5, 10, 15, -5]) {
      const clip = transform(createCameraMatrix(16 / 9, time, 32.2), [0, 1, 0, 1]);
      expect(clip[0]! / clip[3]!).toBeCloseTo(0, 6);
      expect(clip[1]! / clip[3]!).toBeCloseTo(0, 6);
      expect(clip[2]! / clip[3]!).toBeGreaterThan(0);
      expect(clip[2]! / clip[3]!).toBeLessThan(1);
    }
    expect(() => createCameraMatrix(0, 0, 10)).toThrow();
    expect(() => createCameraMatrix(1, NaN, 10)).toThrow();
    expect(() => createCameraMatrix(1, 0, 0)).toThrow();
  });
});

function fixture() {
  const buffers: { destroy: ReturnType<typeof vi.fn>; size: number }[] = [];
  const textures: { destroy: ReturnType<typeof vi.fn>; createView: ReturnType<typeof vi.fn> }[] = [];
  const pipeline = { getBindGroupLayout: vi.fn(() => ({})) };
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxTextureDimension2D: 8192 },
    queue: { writeBuffer: vi.fn() },
    createShaderModule: vi.fn(() => ({})),
    createRenderPipelineAsync: vi.fn(async () => pipeline),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { size: descriptor.size, destroy: vi.fn() };
      buffers.push(buffer);
      return buffer;
    }),
    createBindGroup: vi.fn(() => ({})),
    createTexture: vi.fn(() => {
      const texture = { destroy: vi.fn(), createView: vi.fn(() => ({})) };
      textures.push(texture);
      return texture;
    }),
  };
  const pass = {
    setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(),
    setIndexBuffer: vi.fn(), drawIndexed: vi.fn(), end: vi.fn(),
  };
  const encoder = { beginRenderPass: vi.fn(() => pass) };
  return { device, buffers, textures, encoder, pass };
}

describe('scene resource ownership', () => {
  it('counts requested resource bytes, reuses depth, and destroys old depth on resize', async () => {
    const gpu = fixture();
    const scene = await SceneRenderer.create(gpu.device as unknown as GPUDevice, 'bgra8unorm', { instanceCount: 2 });
    const bufferBytes = 24 * 32 + 36 * 2 + 3 * 48 + 64;
    expect(scene.gpuBufferBytes).toBe(bufferBytes);
    expect(scene.initialUploadBytes).toBe(bufferBytes - 64);
    expect(scene.gpuTextureBytes).toBe(0);
    const timestampWrites = { querySet: {} as GPUQuerySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
    const first = scene.encode(gpu.encoder as unknown as GPUCommandEncoder, {} as GPUTextureView, 640, 360, 0, timestampWrites);
    expect(first).toEqual({ drawCalls: 1, dispatchCalls: 0, triangles: 36, uploadBytes: 64,
      gpuBufferBytes: bufferBytes, gpuTextureBytes: 640 * 360 * 4 });
    expect(gpu.pass.drawIndexed).toHaveBeenCalledWith(36, 3);
    expect(gpu.encoder.beginRenderPass).toHaveBeenCalledWith(expect.objectContaining({ timestampWrites }));
    scene.encode(gpu.encoder as unknown as GPUCommandEncoder, {} as GPUTextureView, 640, 360, 1);
    expect(gpu.device.createTexture).toHaveBeenCalledOnce();
    scene.encode(gpu.encoder as unknown as GPUCommandEncoder, {} as GPUTextureView, 1280, 720, 2);
    expect(gpu.textures[0]!.destroy).toHaveBeenCalledOnce();
    expect(scene.allocatedBytes).toBe(bufferBytes + 1280 * 720 * 4);
    scene.dispose();
    scene.dispose();
    expect(gpu.textures[1]!.destroy).toHaveBeenCalledOnce();
    for (const buffer of gpu.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    expect(scene.allocatedBytes).toBe(0);
    expect(() => scene.encode(gpu.encoder as unknown as GPUCommandEncoder, {} as GPUTextureView, 640, 360, 0))
      .toThrowError(expect.objectContaining({ code: 'ENGINE_DISPOSED' }));
  });

  it('propagates asynchronous pipeline failure without allocating buffers', async () => {
    const gpu = fixture();
    const error = new Error('Shader compilation failed');
    gpu.device.createRenderPipelineAsync.mockRejectedValueOnce(error);
    await expect(SceneRenderer.create(gpu.device as unknown as GPUDevice, 'bgra8unorm')).rejects.toBe(error);
    expect(gpu.buffers).toHaveLength(0);
  });

  it('releases partial buffer ownership after upload or bind-group failure', async () => {
    for (const failAt of ['upload', 'bind-group']) {
      const gpu = fixture();
      const error = new Error(failAt);
      if (failAt === 'upload') gpu.device.queue.writeBuffer.mockImplementationOnce(() => { throw error; });
      else gpu.device.createBindGroup.mockImplementationOnce(() => { throw error; });
      await expect(SceneRenderer.create(gpu.device as unknown as GPUDevice, 'bgra8unorm')).rejects.toBe(error);
      expect(gpu.buffers.length).toBeGreaterThan(0);
      for (const buffer of gpu.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    }
  });

  it('rejects invalid dimensions or time before creating depth or uploading a camera', async () => {
    const gpu = fixture();
    const scene = await SceneRenderer.create(gpu.device as unknown as GPUDevice, 'bgra8unorm');
    const writes = gpu.device.queue.writeBuffer.mock.calls.length;
    for (const [width, height, time] of [[0, 360, 0], [640, 8193, 0], [640, 360, Infinity]]) {
      expect(() => scene.encode(gpu.encoder as unknown as GPUCommandEncoder, {} as GPUTextureView, width!, height!, time!)).toThrow();
    }
    expect(gpu.device.createTexture).not.toHaveBeenCalled();
    expect(gpu.device.queue.writeBuffer.mock.calls).toHaveLength(writes);
    scene.dispose();
  });
});
