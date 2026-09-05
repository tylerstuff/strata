import { describe, expect, it, vi } from 'vitest';
import { AuthoredBoxRenderer } from '../../packages/core/src/rendering/authored-box-renderer.js';
import type { AuthoredBoxControls } from '../../packages/core/src/rendering/authored-box-renderer.js';
import type { BoxSceneDescriptor } from '../../packages/core/src/rendering/authored-box-types.js';
import { authoredClearColor } from '../../packages/core/src/rendering/authored-box-shaders.js';

function scene(count = 1): BoxSceneDescriptor {
  return {
    format: 'strata.runtime-boxes', version: 1, coordinateSystem: 'strata-world-v1', sceneId: 'boxes', sourceRevision: 'revision-1',
    boxes: Array.from({ length: count }, (_, index) => ({
      id: `box-${index}`, dimensions: [2, 4, 8],
      transform: { position: [1_000_000 + 0.125 + index * 5, -1_000_000 + 0.25, 1_000_000 - 4],
        rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], scale: [2, 0.5, 0.25] },
      material: { baseColor: [0.25, 0.5, 0.75, 1], metallic: 0.6, roughness: 0.2 },
    })),
    camera: { position: [1_000_000, -1_000_000, 1_000_000], rotation: [0, 0, 0, 1],
      projection: { kind: 'perspective', verticalFovRadians: Math.PI / 3, near: 0.1, far: 32 } },
    light: { directionToLight: [0, 1, 0], radiance: [4, 3, 2] }, background: [0, 0.5, 1],
  };
}

function gpu() {
  const buffers: { label: string; size: number; bytes: Uint8Array<ArrayBuffer>; destroy: ReturnType<typeof vi.fn> }[] = [];
  const textures: { descriptor: GPUTextureDescriptor; destroy: ReturnType<typeof vi.fn>; createView: ReturnType<typeof vi.fn> }[] = [];
  const writes: { label: string; bytes: Uint8Array<ArrayBuffer> }[] = [];
  const passes: { descriptor: GPURenderPassDescriptor; drawIndexed: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }[] = [];
  const pipeline = { getBindGroupLayout: vi.fn(() => ({})) };
  let rejectView = false;
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxTextureDimension2D: 8192 },
    createShaderModule: vi.fn(() => ({})),
    createRenderPipelineAsync: vi.fn(async (_descriptor: GPURenderPipelineDescriptor) => pipeline),
    createBindGroup: vi.fn(() => ({})),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const value = { label: descriptor.label ?? '', size: descriptor.size, bytes: new Uint8Array(descriptor.size), destroy: vi.fn() };
      buffers.push(value); return value;
    }),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const value = { descriptor, destroy: vi.fn(), createView: vi.fn(() => {
        if (rejectView) { rejectView = false; throw new Error('depth view failed'); }
        return {};
      }) };
      textures.push(value); return value;
    }),
    queue: { writeBuffer: vi.fn((buffer: typeof buffers[number], offset: number, data: ArrayBufferView<ArrayBuffer>) => {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
      expect(offset + bytes.byteLength).toBeLessThanOrEqual(buffer.size);
      buffer.bytes.set(bytes, offset); writes.push({ label: buffer.label, bytes });
    }) },
  };
  const encoder = {
    beginRenderPass: vi.fn((descriptor: GPURenderPassDescriptor) => {
      const pass = { descriptor, drawIndexed: vi.fn(), end: vi.fn(), setPipeline: vi.fn(), setBindGroup: vi.fn(),
        setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn() };
      passes.push(pass); return pass;
    }),
  };
  const target = {} as GPUTextureView;
  return { device: device as unknown as GPUDevice, raw: device, buffers, textures, writes, passes, pipeline, target,
    encoder: encoder as unknown as GPUCommandEncoder, rawEncoder: encoder,
    rejectNextView() { rejectView = true; },
    floats(label: string) {
      const value = buffers.find(buffer => buffer.label === label);
      if (!value) throw new Error(`Missing GPU buffer ${label}.`);
      return new Float32Array(value.bytes.buffer);
    },
  };
}

describe('authored root-box renderer ownership and packing', () => {
  it('uses the real f64 coordinate packer, full quaternion normals, stable materials and exact counters', async () => {
    const fake = gpu(); const renderer = await AuthoredBoxRenderer.create(fake.device, 'rgba8unorm', scene(3));
    try {
      expect(renderer.gpuBufferBytes).toBe(760 + 144 * 3);
      expect(renderer.initialUploadBytes).toBe(648 + 80 * 3);
      expect(fake.writes.reduce((sum, write) => sum + write.bytes.byteLength, 0)).toBe(renderer.initialUploadBytes);
      expect(fake.raw.createRenderPipelineAsync.mock.calls[0]![0]).toMatchObject({
        primitive: { cullMode: 'back', frontFace: 'ccw' },
        depthStencil: { format: 'depth32float', depthCompare: 'less', depthWriteEnabled: true },
      });
      const normals = fake.floats('Strata authored inverse-transpose normals');
      const expectedNormals = [0.25, 0, 0, 0, 0, 0, 0.5, 0, 0, -0.5, 0, 0];
      expectedNormals.forEach((value, index) => expect(normals[index]).toBeCloseTo(value, 7));
      const material = fake.floats('Strata authored box materials');
      [0.25, 0.5, 0.75, 0.6, 0.2, 0, 0, 0].forEach((value, index) => expect(material[index]).toBeCloseTo(value, 7));
      const initialWriteCount = fake.writes.length;
      const timestamps = { raster: { querySet: {} as GPUQuerySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } };
      const result = renderer.encode(fake.encoder, fake.target, 64, 32, 7, { debugView: 'base-color' }, timestamps);
      expect(renderer.passNames()).toEqual(['raster']);
      expect(result).toMatchObject({ drawCalls: 1, dispatchCalls: 0, triangles: 36, uploadBytes: 112 + 64 * 3,
        gpuTextureBytes: 64 * 32 * 4, authored: { aspect: 2, width: 64, height: 32, debugView: 'base-color', timeSeconds: 7,
          origin: [1_000_000, -1_000_000, 1_000_000] } });
      expect(fake.writes.slice(initialWriteCount).map(write => write.label)).toEqual(['Strata authored relative models', 'Strata authored camera and light']);
      const models = fake.floats('Strata authored relative models');
      [4, 0, 0, 0, 0, 0, 2, 0, 0, -2, 0, 0, 0.125, 0.25, -4, 1]
        .forEach((value, index) => expect(models[index]).toBeCloseTo(value, 7));
      expect(models[28]).toBe(5.125);
      const frame = fake.floats('Strata authored camera and light');
      expect(frame[0]).toBeCloseTo(Math.sqrt(3) / 2, 6); expect(frame[5]).toBeCloseTo(Math.sqrt(3), 6);
      expect([...frame.slice(16, 24)]).toEqual([0, 1, 0, 0, 4, 3, 2, 0]);
      expect(new Uint32Array(frame.buffer)[24]).toBe(1);
      expect(fake.passes[0]!.drawIndexed).toHaveBeenCalledExactlyOnceWith(36, 3);
      expect(fake.passes[0]!.descriptor.timestampWrites).toBe(timestamps.raster);
      expect(Object.isFrozen(result.authored.camera.rotation)).toBe(true);
    } finally { renderer.dispose(); }
    expect(renderer.gpuBufferBytes).toBe(0); expect(renderer.gpuTextureBytes).toBe(0);
    renderer.dispose();
    for (const resource of [...fake.buffers, ...fake.textures]) expect(resource.destroy).toHaveBeenCalledOnce();
  });

  it('snapshots the descriptor before asynchronous pipeline creation', async () => {
    const fake = gpu(); const source = scene();
    let resolve!: (value: typeof fake.pipeline) => void;
    fake.raw.createRenderPipelineAsync.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = AuthoredBoxRenderer.create(fake.device, 'rgba8unorm', source);
    expect(fake.buffers).toHaveLength(0);
    Reflect.set(source.camera.position, 0, 1_005_000);
    Reflect.set(source.boxes[0]!.transform.position, 0, -1_000_000);
    Reflect.set(source.boxes[0]!.material, 'roughness', 0.95);
    resolve(fake.pipeline);
    const renderer = await pending;
    try {
      const result = renderer.encode(fake.encoder, fake.target, 32, 32, 0);
      expect(result.authored.origin).toEqual([1_000_000, -1_000_000, 1_000_000]);
      expect(fake.floats('Strata authored relative models')[12]).toBe(0.125);
      expect(fake.floats('Strata authored box materials')[4]).toBeCloseTo(0.2, 7);
    } finally { renderer.dispose(); }
  });

  it.each(['pipeline', 'allocation', 'upload', 'bindings'] as const)('cleans every owned buffer on %s creation failure', async failure => {
    const fake = gpu(); const problem = new Error(`injected ${failure} failure`);
    if (failure === 'pipeline') fake.raw.createRenderPipelineAsync.mockRejectedValueOnce(problem);
    if (failure === 'allocation') {
      const create = fake.raw.createBuffer.getMockImplementation()!; let calls = 0;
      fake.raw.createBuffer.mockImplementation(descriptor => { if (++calls === 4) throw problem; return create(descriptor); });
    }
    if (failure === 'upload') {
      const write = fake.raw.queue.writeBuffer.getMockImplementation()!; let calls = 0;
      fake.raw.queue.writeBuffer.mockImplementation((...args) => { if (++calls === 3) throw problem; write(...args); });
    }
    if (failure === 'bindings') fake.raw.createBindGroup.mockImplementationOnce(() => { throw problem; });
    await expect(AuthoredBoxRenderer.create(fake.device, 'rgba8unorm', scene())).rejects.toBe(problem);
    expect(fake.buffers).toHaveLength({ pipeline: 0, allocation: 3, upload: 4, bindings: 6 }[failure]);
    for (const buffer of fake.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    expect(fake.textures).toHaveLength(0);
  });

  it('rejects invalid frame cameras and controls before depth changes or queue writes', async () => {
    const fake = gpu(); const source = scene(); const renderer = await AuthoredBoxRenderer.create(fake.device, 'rgba8unorm', source);
    try {
      renderer.encode(fake.encoder, fake.target, 32, 32, 0);
      const writes = fake.writes.length; const depth = fake.textures[0]!;
      const invalid = { ...source.camera, position: [1_005_000, -1_000_000, 1_000_000] as const };
      expect(() => renderer.encode(fake.encoder, fake.target, 64, 32, 0, { camera: invalid }))
        .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LIMIT' }));
      expect(() => renderer.encode(fake.encoder, fake.target, 64, 32, 0, { camera: null } as unknown as AuthoredBoxControls))
        .toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
      expect(() => renderer.encode(fake.encoder, fake.target, 64, 32, 0, { temporal: true } as unknown as AuthoredBoxControls))
        .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_FEATURE' }));
      expect(() => renderer.encode(fake.encoder, fake.target, 64, 32, 0, { debugView: 'normal' } as unknown as AuthoredBoxControls))
        .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_FEATURE' }));
      expect(() => renderer.encode(fake.encoder, fake.target, 65, 1, 0)).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LIMIT' }));
      expect(fake.writes).toHaveLength(writes); expect(fake.textures).toHaveLength(1);
      expect(depth.destroy).not.toHaveBeenCalled(); expect(renderer.gpuTextureBytes).toBe(32 * 32 * 4);
    } finally { renderer.dispose(); }
  });

  it('preserves old depth on resize view failure and retains failed retirement ownership for cleanup retry', async () => {
    const fake = gpu(); const renderer = await AuthoredBoxRenderer.create(fake.device, 'rgba8unorm', scene());
    renderer.encode(fake.encoder, fake.target, 32, 32, 0);
    const writes = fake.writes.length; const oldDepth = fake.textures[0]!;
    fake.rejectNextView();
    expect(() => renderer.encode(fake.encoder, fake.target, 64, 32, 0)).toThrow('depth view failed');
    expect(fake.writes).toHaveLength(writes); expect(oldDepth.destroy).not.toHaveBeenCalled();
    expect(fake.textures[1]!.destroy).toHaveBeenCalledOnce(); expect(renderer.gpuTextureBytes).toBe(32 * 32 * 4);
    oldDepth.destroy.mockImplementationOnce(() => { throw new Error('old depth retirement failed'); });
    expect(() => renderer.encode(fake.encoder, fake.target, 64, 32, 0)).toThrow('old depth retirement failed');
    expect(renderer.gpuTextureBytes).toBe((32 * 32 + 64 * 32) * 4);
    const vertices = fake.buffers[0]!;
    vertices.destroy.mockImplementationOnce(() => { throw new Error('vertex retirement failed'); });
    expect(() => renderer.dispose()).toThrow('Authored renderer cleanup failed');
    expect(renderer.gpuTextureBytes).toBe(0); expect(renderer.gpuBufferBytes).toBe(vertices.size);
    expect(() => renderer.encode(fake.encoder, fake.target, 32, 32, 0)).toThrowError(expect.objectContaining({ code: 'ENGINE_DISPOSED' }));
    renderer.dispose();
    expect(renderer.gpuBufferBytes).toBe(0); expect(vertices.destroy).toHaveBeenCalledTimes(2);
    for (const buffer of fake.buffers.slice(1)) expect(buffer.destroy).toHaveBeenCalledOnce();
  });

  it('clears an empty scene with the final background mapping and no box/depth allocations', async () => {
    const fake = gpu(); const renderer = await AuthoredBoxRenderer.create(fake.device, 'rgba8unorm', scene(0));
    try {
      const result = renderer.encode(fake.encoder, fake.target, 32, 64, 13, { debugView: 'base-color', cameraCut: true });
      expect(result).toMatchObject({ drawCalls: 0, triangles: 0, uploadBytes: 0, gpuBufferBytes: 0, gpuTextureBytes: 0,
        authored: { aspect: 0.5, debugView: 'base-color', timeSeconds: 13 } });
      expect(renderer.initialUploadBytes).toBe(0); expect(fake.raw.createRenderPipelineAsync).not.toHaveBeenCalled();
      expect(fake.buffers).toHaveLength(0); expect(fake.textures).toHaveLength(0); expect(fake.writes).toHaveLength(0);
      expect(fake.passes[0]!.drawIndexed).not.toHaveBeenCalled(); expect(fake.passes[0]!.end).toHaveBeenCalledOnce();
      const attachment = [...fake.passes[0]!.descriptor.colorAttachments][0]!;
      expect(attachment!.clearValue).toEqual(authoredClearColor([0, 0.5, 1], false));
      expect(fake.passes[0]!.descriptor.depthStencilAttachment).toBeUndefined();
    } finally { renderer.dispose(); }
  });

  it('applies exposure-one tone mapping once and avoids double transfer for sRGB attachments', () => {
    const encoded = authoredClearColor([0, 0.5, 1], false);
    const linear = authoredClearColor([0, 0.5, 1], true);
    expect(encoded.r).toBe(0); expect(linear.r).toBe(0);
    expect(linear.g).toBeCloseTo(0.6163069544364508, 12); expect(linear.b).toBeCloseTo(0.8037974683544302, 12);
    expect(encoded.g).toBeCloseTo(0.807318899732381, 12); expect(encoded.b).toBeCloseTo(0.9082304956696972, 12);
    expect(encoded.a).toBe(1); expect(linear.a).toBe(1);
  });
});
