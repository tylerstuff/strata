import { describe, expect, it, vi } from 'vitest';
import { AuthoredBoxRenderer } from '../../packages/core/src/rendering/authored-box-renderer.js';
import type { AuthoredBoxControls } from '../../packages/core/src/rendering/authored-box-renderer.js';
import type { BoxCamera, BoxSceneDescriptor } from '../../packages/core/src/rendering/authored-box-types.js';
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
  let rejectView: boolean | GPUTextureFormat = false;
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxTextureDimension2D: 8192,
      maxVertexAttributes: 16, maxVertexBuffers: 8, maxInterStageShaderVariables: 16,
      maxColorAttachments: 4, maxColorAttachmentBytesPerSample: 32 },
    createShaderModule: vi.fn(() => ({})),
    createRenderPipelineAsync: vi.fn(async (_descriptor: GPURenderPipelineDescriptor) => pipeline),
    createBindGroup: vi.fn(() => ({})),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const value = { label: descriptor.label ?? '', size: descriptor.size, bytes: new Uint8Array(descriptor.size), destroy: vi.fn() };
      buffers.push(value); return value;
    }),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const value = { descriptor, destroy: vi.fn(), createView: vi.fn(() => {
        if (rejectView === true || rejectView === descriptor.format) { rejectView = false; throw new Error('texture view failed'); }
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
    rejectNextView(format?: GPUTextureFormat) { rejectView = format ?? true; },
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
      expect(renderer.gpuBufferBytes).toBe(824 + 208 * 3);
      expect(renderer.initialUploadBytes).toBe(648 + 80 * 3);
      expect(fake.writes.reduce((sum, write) => sum + write.bytes.byteLength, 0)).toBe(renderer.initialUploadBytes);
      expect(fake.raw.createRenderPipelineAsync.mock.calls[0]![0]).toMatchObject({
        primitive: { cullMode: 'back', frontFace: 'ccw' },
        depthStencil: { format: 'depth32float', depthCompare: 'less', depthWriteEnabled: true },
      });
      const pipeline = fake.raw.createRenderPipelineAsync.mock.calls[0]![0];
      expect([...pipeline.fragment!.targets]).toEqual([{ format: 'rgba8unorm' }, { format: 'rgba32float' }]);
      const attributes = [...pipeline.vertex.buffers!].flatMap(buffer => buffer ? [...buffer.attributes] : []);
      expect(attributes.map(attribute => attribute.shaderLocation)).toEqual(Array.from({ length: 15 }, (_, index) => index));
      expect(attributes.slice(11)).toEqual([0, 16, 32, 48].map((offset, index) => ({
        shaderLocation: 11 + index, format: 'float32x4', offset,
      })));
      const normals = fake.floats('Strata authored inverse-transpose normals');
      const expectedNormals = [0.25, 0, 0, 0, 0, 0, 0.5, 0, 0, -0.5, 0, 0];
      expectedNormals.forEach((value, index) => expect(normals[index]).toBeCloseTo(value, 7));
      const material = fake.floats('Strata authored box materials');
      [0.25, 0.5, 0.75, 0.6, 0.2, 0, 0, 0].forEach((value, index) => expect(material[index]).toBeCloseTo(value, 7));
      const initialWriteCount = fake.writes.length;
      const timestamps = { raster: { querySet: {} as GPUQuerySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } };
      const result = renderer.encode(fake.encoder, fake.target, 64, 32, 7, { debugView: 'base-color' }, timestamps);
      expect(renderer.passNames()).toEqual(['raster']);
      expect(result).toMatchObject({ drawCalls: 1, dispatchCalls: 0, triangles: 36, uploadBytes: 176 + 128 * 3,
        gpuTextureBytes: 64 * 32 * 20, authored: { aspect: 2, width: 64, height: 32, debugView: 'base-color', timeSeconds: 7,
          origin: [1_000_000, -1_000_000, 1_000_000],
          motion: { previousSubmittedFrameId: null, valid: false, resetReason: 'first-frame' } } });
      expect(fake.writes.slice(initialWriteCount).map(write => write.label)).toEqual([
        'Strata authored relative models', 'Strata authored previous relative models', 'Strata authored camera and light',
      ]);
      const models = fake.floats('Strata authored relative models');
      [4, 0, 0, 0, 0, 0, 2, 0, 0, -2, 0, 0, 0.125, 0.25, -4, 1]
        .forEach((value, index) => expect(models[index]).toBeCloseTo(value, 7));
      expect(models[28]).toBe(5.125);
      const frame = fake.floats('Strata authored camera and light');
      expect(frame[0]).toBeCloseTo(Math.sqrt(3) / 2, 6); expect(frame[5]).toBeCloseTo(Math.sqrt(3), 6);
      expect([...frame.slice(16, 32)]).toEqual([...frame.slice(0, 16)]);
      expect([...frame.slice(32, 40)]).toEqual([0, 1, 0, 0, 4, 3, 2, 0]);
      expect([...new Uint32Array(frame.buffer).slice(40)]).toEqual([1, 0, 64, 32]);
      expect(fake.passes[0]!.drawIndexed).toHaveBeenCalledExactlyOnceWith(36, 3);
      expect(fake.passes[0]!.descriptor.timestampWrites).toBe(timestamps.raster);
      expect(Object.isFrozen(result.authored.camera.rotation)).toBe(true);
      expect(Object.isFrozen(result.authored.motion)).toBe(true);
      const motion = fake.textures.find(texture => texture.descriptor.format === 'rgba32float')!;
      expect(renderer.motionTexture).toBe(motion);
      expect(motion.descriptor).toMatchObject({ label: 'Strata authored box motion', size: [64, 32], usage: 0x10 | 0x1 });
      expect([...fake.passes[0]!.descriptor.colorAttachments]).toHaveLength(2);
    } finally { renderer.dispose(); }
    expect(renderer.gpuBufferBytes).toBe(0); expect(renderer.gpuTextureBytes).toBe(0);
    expect(renderer.motionTexture).toBeUndefined();
    expect(() => renderer.submitted(100)).not.toThrow();
    expect(() => renderer.cancelFrame()).not.toThrow();
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

  it('pairs distinct origins, camera rotations and lenses with the last submitted frame only', async () => {
    const fake = gpu(); const source = scene(); const renderer = await AuthoredBoxRenderer.create(fake.device, 'rgba8unorm', source);
    try {
      renderer.encode(fake.encoder, fake.target, 64, 32, 0);
      const firstModels = [...fake.floats('Strata authored relative models')];
      const firstView = [...fake.floats('Strata authored camera and light').slice(0, 16)];
      const expectedFirstView = [Math.sqrt(3) / 2, 0, 0, 0, 0, Math.sqrt(3), 0, 0, 0, 0, -320 / 319, -1, 0, 0, -32 / 319, 0];
      expect(firstView).toEqual(expectedFirstView.map(Math.fround));
      const writes = fake.writes.length;
      expect(() => renderer.encode(fake.encoder, fake.target, 64, 32, 1)).toThrow();
      expect(fake.writes).toHaveLength(writes);
      renderer.submitted(7);
      renderer.submitted(99); // No staged candidate: a duplicate acknowledgement cannot invent a predecessor.

      const camera: BoxCamera = { position: [1_000_000.375, -1_000_000.25, 1_000_000.125],
        rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
        projection: { kind: 'perspective', verticalFovRadians: Math.PI / 2, near: .25, far: 16 } };
      const moved = renderer.encode(fake.encoder, fake.target, 64, 32, 1, { camera });
      expect(moved.authored.motion).toEqual({ previousSubmittedFrameId: 7, valid: true, resetReason: null });
      expect([...fake.floats('Strata authored previous relative models')]).toEqual(firstModels);
      const frame = fake.floats('Strata authored camera and light');
      expect([...frame.slice(16, 32)]).toEqual(firstView);
      // Independent inverse 90-degree camera roll and scalar near=.25/far=16 perspective.
      const expectedView = [0, -1, 0, 0, .5, 0, 0, 0, 0, 0, -64 / 63, -1, 0, 0, -16 / 63, 0];
      expectedView.forEach((value, index) => {
        if (value === 0) expect(Math.abs(frame[index]!)).toBeLessThan(1e-14);
        else expect(frame[index]).toBe(Math.fround(value));
      });
      expect([...fake.floats('Strata authored relative models').slice(12, 15)]).toEqual([-.25, .5, -4.125]);
      expect([...new Uint32Array(frame.buffer).slice(40)]).toEqual([0, 1, 64, 32]);
      const movedModels = [...fake.floats('Strata authored relative models')];
      const movedView = [...frame.slice(0, 16)];
      renderer.submitted(11);
      Reflect.set(camera.position, 0, 1_000_100);
      Reflect.set(camera.projection, 'near', 1);

      const reverted = renderer.encode(fake.encoder, fake.target, 64, 32, -10);
      expect(reverted.authored.motion).toEqual({ previousSubmittedFrameId: 11, valid: true, resetReason: null });
      expect([...fake.floats('Strata authored previous relative models')]).toEqual(movedModels);
      expect([...fake.floats('Strata authored camera and light').slice(16, 32)]).toEqual(movedView);
      expect([...fake.floats('Strata authored relative models')]).toEqual(firstModels);
      expect([...fake.floats('Strata authored camera and light').slice(0, 16)]).toEqual(firstView);
    } finally { renderer.dispose(); }
  });

  it('discards failed cuts and resized candidates without replacing the submitted baseline', async () => {
    const fake = gpu(); const renderer = await AuthoredBoxRenderer.create(fake.device, 'rgba8unorm', scene());
    try {
      const first = renderer.encode(fake.encoder, fake.target, 32, 32, 0, { cameraCut: true });
      expect(first.authored.motion).toEqual({ previousSubmittedFrameId: null, valid: false, resetReason: 'first-frame' });
      renderer.submitted(1);
      const cut = renderer.encode(fake.encoder, fake.target, 32, 32, 1, { cameraCut: true });
      expect(cut.authored.motion).toEqual({ previousSubmittedFrameId: 1, valid: false, resetReason: 'camera-cut' });
      expect(new Uint32Array(fake.floats('Strata authored camera and light').buffer)[41]).toBe(0);
      renderer.cancelFrame(); renderer.cancelFrame(); renderer.submitted(77);
      const retry = renderer.encode(fake.encoder, fake.target, 32, 32, 2);
      expect(retry.authored.motion).toEqual({ previousSubmittedFrameId: 1, valid: true, resetReason: null });
      renderer.submitted(2);

      const resized = renderer.encode(fake.encoder, fake.target, 64, 32, 3);
      expect(resized.authored.motion).toEqual({ previousSubmittedFrameId: 2, valid: false, resetReason: 'viewport-change' });
      renderer.cancelFrame(); // Resources have resized, but this frame did not reach queue.submit.
      const originalSize = renderer.encode(fake.encoder, fake.target, 32, 32, 4);
      expect(originalSize.authored.motion).toEqual({ previousSubmittedFrameId: 2, valid: true, resetReason: null });
      renderer.submitted(3);
      const acceptedResize = renderer.encode(fake.encoder, fake.target, 64, 32, 5);
      expect(acceptedResize.authored.motion.resetReason).toBe('viewport-change');
      renderer.submitted(4);
      expect(renderer.encode(fake.encoder, fake.target, 64, 32, 6).authored.motion)
        .toEqual({ previousSubmittedFrameId: 4, valid: true, resetReason: null });
    } finally { renderer.dispose(); }
  });

  it('restores complete current and previous uploads after partial writes and repeated encoding failures', async () => {
    const fake = gpu(); const source = scene(); const renderer = await AuthoredBoxRenderer.create(fake.device, 'rgba8unorm', source);
    try {
      renderer.encode(fake.encoder, fake.target, 32, 32, 0); renderer.submitted(12);
      const models = [...fake.floats('Strata authored relative models')];
      const previousView = [...fake.floats('Strata authored camera and light').slice(0, 16)];
      const originalWrite = fake.raw.queue.writeBuffer.getMockImplementation()!;
      const camera: BoxCamera = { ...source.camera, position: [1_000_001, -1_000_000, 1_000_000] };
      for (let attempt = 0; attempt < 2; attempt++) {
        fake.raw.queue.writeBuffer.mockImplementation((...args) => {
          if (args[0].label === 'Strata authored camera and light') throw new Error('partial frame upload');
          originalWrite(...args);
        });
        expect(() => renderer.encode(fake.encoder, fake.target, 32, 32, 1, { camera, cameraCut: true })).toThrow('partial frame upload');
        renderer.cancelFrame(); renderer.submitted(80 + attempt);
        expect(fake.floats('Strata authored relative models')[12]).toBe(-.875);
      }
      fake.raw.queue.writeBuffer.mockImplementation(originalWrite);
      const writes = fake.writes.length;
      const recovered = renderer.encode(fake.encoder, fake.target, 32, 32, 2);
      expect(recovered.authored.motion).toEqual({ previousSubmittedFrameId: 12, valid: true, resetReason: null });
      expect(fake.writes.slice(writes).map(write => write.bytes.byteLength)).toEqual([64, 64, 176]);
      expect([...fake.floats('Strata authored relative models')]).toEqual(models);
      expect([...fake.floats('Strata authored previous relative models')]).toEqual(models);
      expect([...fake.floats('Strata authored camera and light').slice(16, 32)]).toEqual(previousView);
    } finally { renderer.dispose(); }
  });

  it('keeps cell crossings, separate renderers and rejected validation independent of origin state', async () => {
    const fake = gpu(); const source = scene();
    const camera: BoxCamera = { ...source.camera, position: [999_936 - 1 / 1024, -1_000_000, 1_000_000] };
    const renderer = await AuthoredBoxRenderer.create(fake.device, 'rgba8unorm', source);
    const other = await AuthoredBoxRenderer.create(fake.device, 'rgba8unorm', source);
    try {
      renderer.encode(fake.encoder, fake.target, 32, 32, 0, { camera }); renderer.submitted(20);
      const invalid: BoxCamera = { ...camera, position: [1_005_000, -1_000_000, 1_000_000] };
      expect(() => renderer.encode(fake.encoder, fake.target, 32, 32, 0, { camera: invalid })).toThrow();
      renderer.cancelFrame();
      const crossing = renderer.encode(fake.encoder, fake.target, 32, 32, 1,
        { camera: { ...camera, position: [999_936 + 1 / 1024, -1_000_000, 1_000_000] } });
      expect(crossing.authored.motion).toEqual({ previousSubmittedFrameId: 20, valid: true, resetReason: null });
      const otherFirst = other.encode(fake.encoder, fake.target, 32, 32, 0);
      expect(otherFirst.authored.motion).toEqual({ previousSubmittedFrameId: null, valid: false, resetReason: 'first-frame' });
    } finally { renderer.dispose(); other.dispose(); }
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
    expect(fake.buffers).toHaveLength({ pipeline: 0, allocation: 3, upload: 5, bindings: 7 }[failure]);
    for (const buffer of fake.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    expect(fake.textures).toHaveLength(0);
  });

  it('rejects fewer than six interstage variables before allocating or creating a pipeline', async () => {
    const fake = gpu(); fake.raw.limits.maxInterStageShaderVariables = 5;
    await expect(AuthoredBoxRenderer.create(fake.device, 'rgba8unorm', scene()))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT' });
    expect(fake.raw.createShaderModule).not.toHaveBeenCalled();
    expect(fake.raw.createRenderPipelineAsync).not.toHaveBeenCalled();
    expect(fake.buffers).toHaveLength(0); expect(fake.textures).toHaveLength(0);
  });

  it('rejects invalid frame cameras and controls before depth changes or queue writes', async () => {
    const fake = gpu(); const source = scene(); const renderer = await AuthoredBoxRenderer.create(fake.device, 'rgba8unorm', source);
    try {
      renderer.encode(fake.encoder, fake.target, 32, 32, 0);
      renderer.submitted(1);
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
      expect(fake.writes).toHaveLength(writes); expect(fake.textures).toHaveLength(2);
      expect(depth.destroy).not.toHaveBeenCalled(); expect(renderer.gpuTextureBytes).toBe(32 * 32 * 20);
    } finally { renderer.dispose(); }
  });

  it('preserves both old targets on motion-view failure and retains failed retirement ownership for cleanup retry', async () => {
    const fake = gpu(); const renderer = await AuthoredBoxRenderer.create(fake.device, 'rgba8unorm', scene());
    renderer.encode(fake.encoder, fake.target, 32, 32, 0);
    renderer.submitted(1);
    const writes = fake.writes.length; const oldDepth = fake.textures[0]!;
    const oldMotion = renderer.motionTexture;
    fake.rejectNextView('rgba32float');
    expect(() => renderer.encode(fake.encoder, fake.target, 64, 32, 0)).toThrow('texture view failed');
    expect(fake.writes).toHaveLength(writes); expect(oldDepth.destroy).not.toHaveBeenCalled();
    expect(renderer.motionTexture).toBe(oldMotion);
    for (const target of fake.textures.slice(2)) expect(target.destroy).toHaveBeenCalledOnce();
    expect(renderer.gpuTextureBytes).toBe(32 * 32 * 20);
    oldDepth.destroy.mockImplementationOnce(() => { throw new Error('old depth retirement failed'); });
    expect(() => renderer.encode(fake.encoder, fake.target, 64, 32, 0)).toThrow('Authored target retirement failed.');
    expect(renderer.gpuTextureBytes).toBe(32 * 32 * 4 + 64 * 32 * 20);
    const vertices = fake.buffers[0]!;
    vertices.destroy.mockImplementationOnce(() => { throw new Error('vertex retirement failed'); });
    expect(() => renderer.dispose()).toThrow('Authored renderer cleanup failed');
    expect(renderer.gpuTextureBytes).toBe(0); expect(renderer.gpuBufferBytes).toBe(vertices.size);
    expect(() => renderer.encode(fake.encoder, fake.target, 32, 32, 0)).toThrowError(expect.objectContaining({ code: 'ENGINE_DISPOSED' }));
    renderer.dispose();
    expect(renderer.gpuBufferBytes).toBe(0); expect(vertices.destroy).toHaveBeenCalledTimes(2);
    for (const buffer of fake.buffers.slice(1)) expect(buffer.destroy).toHaveBeenCalledOnce();
  });

  it.each(['depth32float', 'rgba32float'] as const)('retries a failed %s allocation without replacing targets or the submitted viewport', async format => {
    const fake = gpu(); const renderer = await AuthoredBoxRenderer.create(fake.device, 'rgba8unorm', scene());
    try {
      renderer.encode(fake.encoder, fake.target, 32, 32, 0); renderer.submitted(5);
      const depth = renderer.depthTexture; const motion = renderer.motionTexture;
      const create = fake.raw.createTexture.getMockImplementation()!; let reject = true;
      fake.raw.createTexture.mockImplementation(descriptor => {
        if (reject && descriptor.format === format) { reject = false; throw new Error('target allocation failed'); }
        return create(descriptor);
      });
      expect(() => renderer.encode(fake.encoder, fake.target, 64, 32, 1)).toThrow('target allocation failed');
      renderer.cancelFrame();
      expect(renderer.depthTexture).toBe(depth); expect(renderer.motionTexture).toBe(motion);
      expect(renderer.gpuTextureBytes).toBe(32 * 32 * 20);
      const resized = renderer.encode(fake.encoder, fake.target, 64, 32, 2);
      expect(resized.authored.motion).toEqual({ previousSubmittedFrameId: 5, valid: false, resetReason: 'viewport-change' });
      renderer.cancelFrame();
      const recovered = renderer.encode(fake.encoder, fake.target, 32, 32, 3);
      expect(recovered.authored.motion).toEqual({ previousSubmittedFrameId: 5, valid: true, resetReason: null });
    } finally { renderer.dispose(); }
    for (const texture of fake.textures) expect(texture.destroy).toHaveBeenCalledOnce();
  });

  it('clears an empty scene with the final background mapping and no box/depth allocations', async () => {
    const fake = gpu(); const renderer = await AuthoredBoxRenderer.create(fake.device, 'rgba8unorm', scene(0));
    try {
      const result = renderer.encode(fake.encoder, fake.target, 32, 64, 13, { debugView: 'base-color', cameraCut: true });
      expect(result).toMatchObject({ drawCalls: 0, triangles: 0, uploadBytes: 0, gpuBufferBytes: 0, gpuTextureBytes: 0,
        authored: { aspect: 0.5, debugView: 'base-color', timeSeconds: 13 } });
      expect(renderer.initialUploadBytes).toBe(0); expect(fake.raw.createRenderPipelineAsync).not.toHaveBeenCalled();
      expect(renderer.motionTexture).toBeUndefined();
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
