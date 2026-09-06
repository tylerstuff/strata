import { describe, expect, it, vi } from 'vitest';
import { createCameraMatrix } from '../../packages/core/src/rendering/scene-data.js';
import { animatedOffset, cameraJitter, createLightMatrix, createMaterialTextures, createRasterCamera, orthographicMatrix, referenceGgxDistribution } from '../../packages/core/src/rendering/raster-math.js';
import { mustResetHistory, normalizeRasterControls, RasterRenderer } from '../../packages/core/src/rendering/raster-renderer.js';
import type { RasterFrameState } from '../../packages/core/src/rendering/raster-renderer.js';
import type { RasterGeometryProvider, RasterGeometryGroup } from '../../packages/core/src/rendering/geometry-provider.js';

function project(matrix: Float32Array, point: readonly number[]): number[] {
  const clip = Array.from({ length: 4 }, (_, row) => point.reduce((sum, value, column) => sum + matrix[column * 4 + row]! * value, 0));
  return [clip[0]! / clip[3]!, clip[1]! / clip[3]!, clip[2]! / clip[3]!];
}

describe('raster camera, shadow and material contracts', () => {
  it('retains the physical GGX peak for smooth metals and the expected grazing tail', () => {
    const roughnesses = [0.06, 120 / 255 * 0.28, 0.2, 0.5, 1];
    const normal = roughnesses.map(roughness => referenceGgxDistribution(roughness, 1));
    const grazing = roughnesses.map(roughness => referenceGgxDistribution(roughness, 0));
    roughnesses.forEach((roughness, index) => {
      expect(normal[index]! / (1 / (Math.PI * roughness ** 4))).toBeCloseTo(1, 8);
      expect(grazing[index]! / (roughness ** 4 / Math.PI)).toBeCloseTo(1, 8);
      expect(referenceGgxDistribution(roughness, 0.5)).toBeGreaterThan(grazing[index]! * 0.99);
      if (index > 0) {
        expect(normal[index]!).toBeLessThan(normal[index - 1]!);
        expect(grazing[index]!).toBeGreaterThan(grazing[index - 1]!);
      }
    });
    expect(normal[0]).toBeGreaterThan(24_000);
    expect(normal[1]).toBeGreaterThan(1_000);
    expect(referenceGgxDistribution(0.06, 1.000001)).toBe(referenceGgxDistribution(0.06, 1));
    expect(referenceGgxDistribution(0.5, -0.000001)).toBe(referenceGgxDistribution(0.5, 0));
  });

  it('preserves the baseline orbit and offsets projection by the specified texture pixels', () => {
    for (const time of [0, 1, 7, 15, 20]) {
      const camera = createRasterCamera(1280, 720, time, 32.2);
      const baseline = createCameraMatrix(1280 / 720, time, 32.2);
      const cameraPoint = project(camera.viewProjection, [0, 1, 0, 1]);
      const baselinePoint = project(baseline, [0, 1, 0, 1]);
      cameraPoint.forEach((value, index) => expect(value).toBeCloseTo(baselinePoint[index]!, 5));
      const jittered = project(createRasterCamera(1280, 720, time, 32.2, [0.25, -0.4]).viewProjection, [0, 1, 0, 1]);
      expect((jittered[0]! - cameraPoint[0]!) * 1280 / 2).toBeCloseTo(0.25, 3);
      expect((jittered[1]! - cameraPoint[1]!) * -720 / 2).toBeCloseTo(-0.4, 3);
    }
    expect(cameraJitter(0)).toEqual(cameraJitter(8));
    expect(new Set(Array.from({ length: 8 }, (_, index) => cameraJitter(index).join(','))).size).toBe(8);
    for (let index = 0; index < 8; index++) {
      expect(cameraJitter(index).every(value => value >= -0.5 && value <= 0.5)).toBe(true);
    }
  });

  it('maps light depth correctly and contains scene bounds including raised objects', () => {
    const projection = orthographicMatrix(20, 0.1, 200);
    expect(project(projection, [0, 0, -0.1, 1])[2]).toBeCloseTo(0, 6);
    expect(project(projection, [0, 0, -200, 1])[2]).toBeCloseTo(1, 6);
    const light = createLightMatrix(32.2);
    for (const x of [-32.2, 32.2]) for (const y of [0, 6.2]) for (const z of [-32.2, 32.2]) {
      const point = project(light, [x, y, z, 1]);
      expect(Math.abs(point[0]!)).toBeLessThan(1);
      expect(Math.abs(point[1]!)).toBeLessThan(1);
      expect(point[2]!).toBeGreaterThan(0);
      expect(point[2]!).toBeLessThan(1);
    }
  });

  it('separates moving-object motion from camera motion and keeps static transforms unchanged', () => {
    const fixed = createRasterCamera(1280, 720, 0, 32.2).viewProjection;
    const previous = animatedOffset(1, 0);
    const current = animatedOffset(1, 0.1);
    const previousNdc = project(fixed, [...previous, 1]);
    const currentNdc = project(fixed, [...current, 1]);
    expect(previousNdc).not.toEqual(currentNdc);
    expect(animatedOffset(0, 0)).toEqual(animatedOffset(0, 100));
    expect(animatedOffset(2, 0)).toEqual(animatedOffset(2, 100));
    expect(project(createRasterCamera(1280, 720, 0.1, 32.2).viewProjection, [3, 1, 0, 1]))
      .not.toEqual(project(fixed, [3, 1, 0, 1]));
  });

  it('generates deterministic opaque textures with varying base color and independent linear roughness', () => {
    const material = createMaterialTextures();
    expect(material).toEqual(createMaterialTextures());
    expect(material.baseColor.byteLength).toBe(64 * 64 * 4);
    expect(material.metallicRoughness.byteLength).toBe(64 * 64 * 4);
    const colors = new Set<number>();
    const roughness = new Set<number>();
    for (let index = 0; index < material.baseColor.length; index += 4) {
      colors.add(material.baseColor[index]!);
      roughness.add(material.metallicRoughness[index + 1]!);
      expect(material.baseColor[index + 3]).toBe(255);
      expect(material.metallicRoughness[index + 2]).toBe(255);
    }
    expect(colors.size).toBe(2);
    expect(roughness.size).toBe(2);
  });

  it('invalidates history at discontinuities while preserving ordinary motion and paused accumulation', () => {
    const previous: RasterFrameState = { width: 1280, height: 720, time: 1, temporal: true, jitter: true };
    expect(mustResetHistory(undefined, previous, false)).toBe(true);
    expect(mustResetHistory(previous, previous, false)).toBe(false);
    expect(mustResetHistory(previous, { ...previous, time: 1.016 }, false)).toBe(false);
    for (const change of [{ width: 1920 }, { height: 1080 }, { time: 0.9 }, { time: 1.251 }, { temporal: false }, { jitter: false }]) {
      expect(mustResetHistory(previous, { ...previous, ...change }, false)).toBe(true);
    }
    expect(mustResetHistory(previous, previous, true)).toBe(true);
    expect(normalizeRasterControls()).toEqual({ temporal: true, cameraCut: false, debugView: 'final', exposureEV: 0 });
    expect(() => normalizeRasterControls({ temporal: 'yes' } as never)).toThrow();
    expect(() => normalizeRasterControls({ debugView: 'unknown' } as never)).toThrow();
  });
});

function fixture() {
  const buffers: { destroy: ReturnType<typeof vi.fn>; label: string; size: number }[] = [];
  const textures: { destroy: ReturnType<typeof vi.fn>; createView: ReturnType<typeof vi.fn>; descriptor: GPUTextureDescriptor }[] = [];
  const writes: { label: string; bytes: Uint8Array }[] = [];
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxTextureDimension2D: 8192 },
    queue: {
      writeBuffer: vi.fn((buffer: { label: string }, _offset: number, data: ArrayBuffer | ArrayBufferView<ArrayBuffer>) => {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        writes.push({ label: buffer.label, bytes: new Uint8Array(bytes) });
      }),
      writeTexture: vi.fn(),
    },
    createShaderModule: vi.fn(() => ({})),
    createRenderPipelineAsync: vi.fn(async () => ({ getBindGroupLayout: vi.fn(() => ({})) })),
    createSampler: vi.fn(() => ({})),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { label: descriptor.label ?? '', size: descriptor.size, destroy: vi.fn() };
      buffers.push(buffer); return buffer;
    }),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const view = {};
      const texture = { descriptor, destroy: vi.fn(), createView: vi.fn(() => view) };
      textures.push(texture); return texture;
    }),
    createBindGroup: vi.fn(() => ({})),
  };
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), drawIndexed: vi.fn(), draw: vi.fn(), end: vi.fn() };
  const encoder = { beginRenderPass: vi.fn((_descriptor: GPURenderPassDescriptor) => pass) };
  return { device, buffers, textures, writes, pass, encoder };
}

describe('raster frame orchestration and ownership', () => {
  function provider(name: string, selectionPass: boolean, counts: { triangles: number; drawCalls: number; dispatchCalls: number; uploadBytes: number }) {
    return {
      shaderSource: `// ${name}`, vertexEntryPoint: `${name}Vertex`, shadowEntryPoint: `${name}Shadow`, usesMaterialTextures: false,
      halfExtent: 4, selectionPass, lightMatrix: createLightMatrix(4), gpuBufferBytes: 80, initialUploadBytes: 48,
      camera: vi.fn(() => createRasterCamera(640, 360, 0, 4)), attachPipelines: vi.fn(), prepare: vi.fn(() => counts), draw: vi.fn(), dispose: vi.fn(),
    } satisfies RasterGeometryProvider;
  }

  it('passes the signed camera jitter to final presentation and zeroes diagnostic/bypass offsets', async () => {
    const gpu = fixture();
    const renderer = await RasterRenderer.create(gpu.device as unknown as GPUDevice, 'bgra8unorm');
    for (let frame = 0; frame < 8; frame++) renderer.encode(gpu.encoder as unknown as GPUCommandEncoder,
      {} as GPUTextureView, 640, 360, frame / 60, { temporal: true });
    const offsets = gpu.writes.filter(write => write.label === 'Strata presentation settings')
      .map(write => Array.from(new Float32Array(write.bytes.buffer).subarray(4, 6)));
    expect(offsets).toEqual(Array.from({ length: 8 }, (_, i) => cameraJitter(i).map(Math.fround)));
    for (const controls of [{ temporal: false }, { temporal: true, debugView: 'normal' as const }]) {
      renderer.encode(gpu.encoder as unknown as GPUCommandEncoder, {} as GPUTextureView, 640, 360, 1, controls);
      expect(Array.from(new Float32Array(gpu.writes.filter(write => write.label === 'Strata presentation settings').at(-1)!.bytes.buffer).subarray(4, 6))).toEqual([0, 0]);
    }
    renderer.dispose();
  });

  it('changes only presentation exposure while preserving temporal history and resource ownership', async () => {
    const gpu = fixture();
    const renderer = await RasterRenderer.create(gpu.device as unknown as GPUDevice, 'bgra8unorm');
    const render = (exposureEV?: number) => renderer.encode(gpu.encoder as unknown as GPUCommandEncoder,
      {} as GPUTextureView, 640, 360, 0, exposureEV === undefined ? {} : { exposureEV });
    render();
    const textures = gpu.textures.length, buffers = gpu.buffers.length;
    for (const exposureEV of [-16, -0.5, 0, 4, 8, 12, 16]) render(exposureEV);
    render(); // An omitted value resets the display compensation to zero for this frame.
    const values = gpu.writes.filter(write => write.label === 'Strata presentation settings')
      .map(write => new Float32Array(write.bytes.buffer)[3]);
    expect(values).toEqual([1, 2 ** -16, Math.fround(2 ** -0.5), 1, 16, 256, 4096, 65536, 1]);
    expect(values.every(value => Number.isFinite(value) && value! > 0)).toBe(true);
    const historyFlags = gpu.writes.filter(write => write.label === 'Strata temporal options')
      .map(write => new Uint32Array(write.bytes.buffer)[2]);
    expect(historyFlags).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(gpu.textures).toHaveLength(textures); expect(gpu.buffers).toHaveLength(buffers);
    const writeCount = gpu.writes.length, passCount = gpu.encoder.beginRenderPass.mock.calls.length;
    for (const value of [NaN, Infinity, -Infinity, -16.01, 16.01, null, '4', true]) {
      expect(() => render(value as number)).toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    }
    expect(gpu.writes).toHaveLength(writeCount);
    expect(gpu.encoder.beginRenderPass).toHaveBeenCalledTimes(passCount);
    expect(gpu.textures).toHaveLength(textures); expect(gpu.buffers).toHaveLength(buffers);
    render(0);
    expect(new Uint32Array(gpu.writes.filter(write => write.label === 'Strata temporal options').at(-1)!.bytes.buffer)[2]).toBe(1);
    renderer.dispose();
  });

  it('batches separate provider pipelines into one camera, shadow map and MRT while summing actual work', async () => {
    const gpu = fixture();
    const a = provider('terrain', true, { triangles: 20, drawCalls: 2, dispatchCalls: 2, uploadBytes: 7 });
    const b = provider('rooms', false, { triangles: 12, drawCalls: 6, dispatchCalls: 0, uploadBytes: 11 });
    const camera = createRasterCamera(640, 360, 0, 16); const lightMatrix = createLightMatrix(16);
    const group = { providers: [a, b], halfExtent: 16, lightMatrix, camera: vi.fn(() => camera) } satisfies RasterGeometryGroup;
    const renderer = await RasterRenderer.create(gpu.device as unknown as GPUDevice, 'bgra8unorm', {}, group);
    expect(a.attachPipelines).toHaveBeenCalledOnce(); expect(b.attachPipelines).toHaveBeenCalledOnce();
    const selection = {} as GPUComputePassTimestampWrites;
    const result = renderer.encode(gpu.encoder as unknown as GPUCommandEncoder, {} as GPUTextureView, 640, 360, 0,
      { temporal: false }, { selection });
    expect(result).toMatchObject({ drawCalls: 9, triangles: 33, dispatchCalls: 2, uploadBytes: 402 });
    expect(group.camera).toHaveBeenCalledOnce(); expect(a.camera).not.toHaveBeenCalled(); expect(b.camera).not.toHaveBeenCalled();
    expect(a.prepare).toHaveBeenCalledWith(gpu.encoder, camera, 640, 360, true, { temporal: false, debugView: 'final', cameraCut: false, exposureEV: 0 }, selection);
    expect(b.prepare).toHaveBeenCalledWith(gpu.encoder, camera, 640, 360, true, { temporal: false, debugView: 'final', cameraCut: false, exposureEV: 0 }, undefined);
    expect(gpu.encoder.beginRenderPass.mock.calls.map(([descriptor]) => descriptor.label)).toEqual([
      'Strata directional shadow', 'Strata PBR and shared geometry outputs', 'Strata tone mapping and debug presentation',
    ]);
    const [aRaster, aShadow] = a.attachPipelines.mock.calls[0]!; const [bRaster, bShadow] = b.attachPipelines.mock.calls[0]!;
    expect(gpu.pass.setPipeline.mock.calls.slice(0, 4).map(([pipeline]) => pipeline)).toEqual([aShadow, bShadow, aRaster, bRaster]);
    expect(gpu.pass.setBindGroup.mock.calls.filter(([index]) => index === 0)).toHaveLength(5);
    expect(a.draw.mock.calls.map(([, phase]) => phase)).toEqual(['shadow', 'raster']);
    expect(b.draw.mock.calls.map(([, phase]) => phase)).toEqual(['shadow', 'raster']);
    const uniformWrites = gpu.writes.filter(write => write.label === 'Strata current and previous transforms');
    expect(uniformWrites).toHaveLength(1); expect(new Float32Array(uniformWrites[0]!.bytes.buffer).slice(64, 80)).toEqual(lightMatrix);
    expect(renderer.gpuBufferBytes).toBe(gpu.buffers.reduce((sum, buffer) => sum + buffer.size, 0) + 160);
    expect(gpu.textures.filter(texture => texture.descriptor.label === 'Strata directional shadow depth')).toHaveLength(1);
    expect(renderer.passNames({ temporal: false })).toEqual(['selection', 'shadow', 'raster', 'presentation']);
    renderer.dispose(); renderer.dispose(); expect(a.dispose).toHaveBeenCalledOnce(); expect(b.dispose).toHaveBeenCalledOnce();
    expect([...gpu.buffers, ...gpu.textures].every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
  });

  it('rejects duplicate/ambiguous provider ownership and leaves providers caller-owned when creation fails', async () => {
    const gpu = fixture(); const counts = { triangles: 2, drawCalls: 2, dispatchCalls: 0, uploadBytes: 0 };
    const a = provider('a', true, counts); const b = provider('b', true, counts);
    for (const providers of [[], [a, a], [a, b]]) {
      await expect(RasterRenderer.create(gpu.device as unknown as GPUDevice, 'bgra8unorm', {},
        { providers, halfExtent: 4, lightMatrix: a.lightMatrix, camera: a.camera })).rejects.toThrow('unique providers');
    }
    expect(gpu.buffers).toHaveLength(0); expect(gpu.device.createRenderPipelineAsync).not.toHaveBeenCalled();
    const fail = new Error('provider binding failed'); a.attachPipelines.mockImplementation(() => { throw fail; });
    await expect(RasterRenderer.create(gpu.device as unknown as GPUDevice, 'bgra8unorm', {}, a)).rejects.toBe(fail);
    expect(a.dispose).not.toHaveBeenCalled(); expect(b.dispose).not.toHaveBeenCalled();
    expect([...gpu.buffers, ...gpu.textures].every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
  });

  it('orders all passes, counts allocations and uploads, and retains valid history until a reset', async () => {
    const gpu = fixture();
    const renderer = await RasterRenderer.create(gpu.device as unknown as GPUDevice, 'bgra8unorm', { instanceCount: 2 });
    const staticTextures = 2048 * 2048 * 4 + 64 * 64 * 8;
    expect(renderer.gpuTextureBytes).toBe(staticTextures);
    expect(renderer.gpuBufferBytes).toBe(gpu.buffers.reduce((sum, buffer) => sum + buffer.size, 0));
    expect(renderer.initialUploadBytes).toBe(24 * 32 + 36 * 2 + 3 * 48 + 64 * 64 * 8);
    expect(renderer.passNames()).toEqual(['shadow', 'raster', 'temporal', 'presentation']);
    expect(renderer.passNames({ temporal: false })).toEqual(['shadow', 'raster', 'presentation']);
    const render = (time: number, controls = {}) => renderer.encode(gpu.encoder as unknown as GPUCommandEncoder, {} as GPUTextureView, 640, 360, time, controls);
    const first = render(0);
    expect(first).toMatchObject({ drawCalls: 4, triangles: 74, dispatchCalls: 0, uploadBytes: 400 });
    expect(renderer.gpuTextureBytes).toBe(staticTextures + 640 * 360 * 48);
    expect(gpu.encoder.beginRenderPass.mock.calls.map(([descriptor]) => descriptor.label)).toEqual([
      'Strata directional shadow', 'Strata PBR and shared geometry outputs', 'Strata HDR temporal resolve', 'Strata tone mapping and debug presentation',
    ]);
    render(0.016); render(0.032, { cameraCut: true }); render(0.048);
    render(0.064, { debugView: 'normal' }); render(0.080, { debugView: 'normal' });
    const bypass = render(0.096, { temporal: false });
    expect(bypass).toMatchObject({ drawCalls: 3, triangles: 73, uploadBytes: 384 });
    render(0.112);
    const historyFlags = gpu.writes.filter(write => write.label === 'Strata temporal options').map(write => new Uint32Array(write.bytes.buffer)[2]);
    expect(historyFlags).toEqual([0, 1, 0, 1, 0, 1, 0]);
    expect(gpu.device.createTexture).toHaveBeenCalledTimes(10);
    const firstFrame = gpu.writes.find(write => write.label === 'Strata current and previous transforms')!;
    const floats = new Float32Array(firstFrame.bytes.buffer);
    expect(floats.slice(0, 16)).toEqual(floats.slice(16, 32));
    expect(floats[83]).toBe(floats[84]);
    expect(gpu.textures.filter(texture => texture.descriptor.format === 'rgba8unorm-srgb')).toHaveLength(1);
    renderer.dispose(); renderer.dispose();
    for (const resource of [...gpu.buffers, ...gpu.textures]) expect(resource.destroy).toHaveBeenCalledOnce();
    expect(renderer.allocatedBytes).toBe(0);
  });

  it('replaces size-dependent targets without retaining old views and rejects invalid requests before mutation', async () => {
    const gpu = fixture();
    const renderer = await RasterRenderer.create(gpu.device as unknown as GPUDevice, 'bgra8unorm');
    const encoder = gpu.encoder as unknown as GPUCommandEncoder;
    renderer.encode(encoder, {} as GPUTextureView, 640, 360, 0);
    const firstViews = renderer.outputs;
    const oldTargets = gpu.textures.slice(3);
    renderer.encode(encoder, {} as GPUTextureView, 1280, 720, 0.016);
    expect(renderer.outputs).not.toBe(firstViews);
    for (const texture of oldTargets) expect(texture.destroy).toHaveBeenCalledOnce();
    const count = gpu.textures.length;
    expect(() => renderer.encode(encoder, {} as GPUTextureView, 0, 720, 0)).toThrow();
    expect(() => renderer.encode(encoder, {} as GPUTextureView, 1280, 720, Infinity)).toThrow();
    expect(gpu.textures).toHaveLength(count);
    renderer.dispose();
    for (const texture of gpu.textures) expect(texture.destroy).toHaveBeenCalledOnce();
  });

  it('destroys partial static resources when material upload fails', async () => {
    const gpu = fixture();
    const error = new Error('Texture upload failure');
    gpu.device.queue.writeTexture.mockImplementationOnce(() => { throw error; });
    await expect(RasterRenderer.create(gpu.device as unknown as GPUDevice, 'bgra8unorm')).rejects.toBe(error);
    expect(gpu.buffers.length).toBeGreaterThan(0);
    expect(gpu.textures.length).toBeGreaterThan(0);
    for (const resource of [...gpu.buffers, ...gpu.textures]) expect(resource.destroy).toHaveBeenCalledOnce();
  });
});
