import { describe, expect, it, vi } from 'vitest';
import { ReflectionRenderer } from '../../packages/core/src/reflections/reflection-renderer.js';
import type { ReflectionSceneOptions, ReflectionControls, ReflectionMode } from '../../packages/core/src/reflections/reflection-types.js';
import type { GiControls } from '../../packages/core/src/gi/gi-types.js';
import type { RasterControls, RasterTimestamps } from '../../packages/core/src/rendering/raster-types.js';

type Controls = RasterControls & { gi?: GiControls; reflections?: ReflectionControls };
function fixture() {
  const buffers: { descriptor: GPUBufferDescriptor; bytes: Uint8Array<ArrayBuffer>; destroy: ReturnType<typeof vi.fn> }[] = [];
  const textures: { descriptor: GPUTextureDescriptor; createView: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[] = [];
  const groups: GPUBindGroupDescriptor[] = [];
  const passes: { type: 'render' | 'compute'; descriptor: GPURenderPassDescriptor | GPUComputePassDescriptor | undefined }[] = [];
  let failView = false;
  const pipeline = () => ({ getBindGroupLayout: vi.fn(() => ({})) });
  const device = {
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 ** 2, maxStorageBufferBindingSize: 128 * 1024 ** 2 },
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { descriptor, bytes: new Uint8Array(descriptor.size), destroy: vi.fn() }; buffers.push(buffer); return buffer;
    }),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const fail = failView; failView = false;
      const texture = { descriptor, createView: vi.fn(() => { if (fail) throw new Error('view failed'); return {}; }), destroy: vi.fn() };
      textures.push(texture); return texture;
    }),
    createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})), createPipelineLayout: vi.fn(() => ({})),
    createSampler: vi.fn(() => ({})), createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => { groups.push(descriptor); return {}; }),
    createComputePipelineAsync: vi.fn(async () => pipeline()), createRenderPipelineAsync: vi.fn(async () => pipeline()),
    queue: { writeTexture: vi.fn(), submit: vi.fn((_commands: readonly unknown[]) => undefined),
      writeBuffer: vi.fn((buffer: typeof buffers[number], offset: number, source: ArrayBuffer | ArrayBufferView<ArrayBuffer>) => {
        const bytes = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
        buffer.bytes.set(bytes, offset);
      }),
    },
  };
  const encoder = { copyTextureToTexture: vi.fn(),
    beginRenderPass: vi.fn((descriptor: GPURenderPassDescriptor) => {
      passes.push({ type: 'render', descriptor });
      return { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), draw: vi.fn(), drawIndexed: vi.fn(), end: vi.fn() };
    }),
    beginComputePass: vi.fn((descriptor?: GPUComputePassDescriptor) => {
      passes.push({ type: 'compute', descriptor }); return { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    }),
  };
  return { device: device as unknown as GPUDevice, raw: device, encoder: encoder as unknown as GPUCommandEncoder, rawEncoder: encoder,
    buffers, textures, groups, passes, failNextView: () => { failView = true; },
    create: (options: Partial<ReflectionSceneOptions> = {}) => ReflectionRenderer.create(device as unknown as GPUDevice, 'bgra8unorm', { renderer: 'reflections', ...options }),
  };
}

function frames(gpu: ReturnType<typeof fixture>, renderer: ReflectionRenderer) {
  let frameId = 0;
  return (controls: Controls = {}, width = 1280, height = 720) => {
    const names = renderer.passNames(controls);
    const timestamps = Object.fromEntries(names.map((name, index) => [name, { querySet: {} as GPUQuerySet, beginningOfPassWriteIndex: index * 2, endOfPassWriteIndex: index * 2 + 1 }])) as RasterTimestamps;
    const result = renderer.encode(gpu.encoder, {} as GPUTextureView, width, height, frameId / 60, controls, timestamps);
    gpu.raw.queue.submit([{}]); renderer.submitted(++frameId); return { result, names, timestamps };
  };
}

describe('reflection renderer integration', () => {
  it('matches actual pass submission and counters for every reflection, GI and TAA combination', async () => {
    for (const mode of ['off', 'probe-only', 'world'] as const) for (const gi of [false, true]) for (const temporal of [false, true]) {
      const gpu = fixture(); const renderer = await gpu.create(); const render = frames(gpu, renderer);
      const controls = { reflections: { mode }, gi: { enabled: gi }, temporal };
      const expected = [...(gi ? ['gi-trace', 'gi-update'] : []), 'shadow', 'raster',
        ...(mode === 'world' ? ['reflection-trace', 'reflection-resolve'] : []),
        ...(gi || mode !== 'off' ? ['gi-shade'] : []), ...(temporal ? ['temporal'] : []), 'presentation'];
      const { result, names, timestamps } = render(controls);
      expect(names).toEqual(expected); expect(names.length).toBeLessThanOrEqual(9);
      expect(gpu.passes.map(pass => pass.descriptor?.timestampWrites)).toEqual(expected.map(name => timestamps[name as keyof RasterTimestamps]));
      expect(result.drawCalls).toBe(temporal ? 4 : 3); expect(result.triangles).toBe(temporal ? 314 : 313);
      expect(result.dispatchCalls).toBe(Number(gi) * 2 + (mode === 'world' ? 2 : 0) + Number(gi || mode !== 'off'));
      expect(renderer.reflectionTelemetry).toMatchObject({ mode, giEnabled: gi, actualPrimaryRays: null, traceFailures: null });
      expect(renderer.giTelemetry.primaryRaysPerFrame).toBe(gi ? 2048 : 0);
      if (mode !== 'world') expect(renderer.reflectionTelemetry.maxPrimaryRays).toBe(0);
      renderer.dispose(); expect([...gpu.buffers, ...gpu.textures].every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
    }
  });

  it('preserves omitted/undefined patches and makes pass prediction read-only', async () => {
    const gpu = fixture(); const renderer = await gpu.create(); const render = frames(gpu, renderer);
    render({ reflections: { mode: 'probe-only', roughness: 0.2, maxDistance: 8, updateEvery: 3, objectOffset: 0.4 }, gi: { enabled: false } });
    render({ reflections: { maxDistance: 10 } });
    render({ reflections: { roughness: undefined, objectOffset: undefined } as unknown as ReflectionControls });
    expect(renderer.reflectionTelemetry).toMatchObject({ mode: 'probe-only', roughness: 0.2, maxDistance: 10, updateEvery: 3, objectOffset: 0.4, giEnabled: false });
    const before = renderer.reflectionTelemetry; const scene = renderer.currentScene; const writes = gpu.raw.queue.writeBuffer.mock.calls.length;
    expect(renderer.passNames({ reflections: { mode: 'world' }, gi: { enabled: true }, temporal: false }))
      .toEqual(['gi-trace', 'gi-update', 'shadow', 'raster', 'reflection-trace', 'reflection-resolve', 'gi-shade', 'presentation']);
    expect(renderer.reflectionTelemetry).toEqual(before); expect(renderer.currentScene).toBe(scene); expect(gpu.raw.queue.writeBuffer).toHaveBeenCalledTimes(writes);
    renderer.dispose();
  });

  it('rejects invalid reflection patches before any valid accompanying world change is applied', async () => {
    const gpu = fixture(); const renderer = await gpu.create(); const render = frames(gpu, renderer); render();
    const badPatches = [{ roughness: 0.36 }, { maxDistance: 0 }, { updateEvery: 1.5 }, { objectOffset: 0.5 }, { mode: 'unknown' },
      ...['mode', 'roughness', 'maxDistance', 'updateEvery', 'objectOffset', 'resetHistory'].map(name => ({ [name]: null }))];
    for (const patch of badPatches) {
      const input = { gi: { doorOpen: false }, reflections: patch as ReflectionControls };
      const before = renderer.reflectionTelemetry; const scene = renderer.currentScene; const writes = gpu.raw.queue.writeBuffer.mock.calls.length;
      expect(() => renderer.passNames(input)).toThrow();
      expect(() => renderer.encode(gpu.encoder, {} as GPUTextureView, 1280, 720, 1 / 60, input)).toThrow();
      expect(renderer.currentScene).toBe(scene); expect(renderer.reflectionTelemetry).toEqual(before); expect(gpu.raw.queue.writeBuffer).toHaveBeenCalledTimes(writes);
    }
    renderer.dispose();
  });

  it('rolls diffuse updates for object motion but hard-resets changed materials, preserving source materials', async () => {
    const gpu = fixture(); const renderer = await gpu.create(); const render = frames(gpu, renderer); render();
    const firstCube = renderer.currentScene.boxes[renderer.currentScene.objectBoxId]!;
    render({ reflections: { objectOffset: 0.4 } });
    expect(renderer.currentScene.boxes[renderer.currentScene.objectBoxId]!.center[2]).toBeCloseTo(firstCube.center[2] + 0.4);
    expect(renderer.giTelemetry).toMatchObject({ worldRevision: 2, diffuseInvalidationRevision: 1, cacheEpoch: 1, framesSinceReset: 2 });
    expect(renderer.reflectionTelemetry).toMatchObject({ worldRevision: 2, cacheEpoch: 2, framesSinceReset: 1 });
    render({ reflections: { roughness: 0.3 } });
    const mirror = renderer.currentScene.boxes[renderer.currentScene.reflectorBoxId]!;
    expect(renderer.currentScene.materials[mirror.materialId]).toMatchObject({ roughness: 0.3, metallic: 1 });
    expect(renderer.giTelemetry).toMatchObject({ worldRevision: 3, diffuseInvalidationRevision: 2, cacheEpoch: 2 });
    expect(renderer.reflectionTelemetry).toMatchObject({ worldRevision: 3, cacheEpoch: 3 });
    render(); expect(renderer.giTelemetry.cacheEpoch).toBe(2); expect(renderer.reflectionTelemetry.cacheEpoch).toBe(3); renderer.dispose();
  });

  it('resets reflection history once for explicit reset or camera cuts without resetting world GI', async () => {
    const gpu = fixture(); const renderer = await gpu.create(); const render = frames(gpu, renderer); render();
    render({ cameraCut: true });
    expect(renderer.reflectionTelemetry.cacheEpoch).toBe(2); expect(renderer.giTelemetry.cacheEpoch).toBe(1);
    render({ reflections: { resetHistory: true } });
    expect(renderer.reflectionTelemetry.cacheEpoch).toBe(3); expect(renderer.giTelemetry.cacheEpoch).toBe(1);
    render();
    expect(renderer.reflectionTelemetry).toMatchObject({ cacheEpoch: 3, framesSinceReset: 2 });
    expect(renderer.giTelemetry).toMatchObject({ cacheEpoch: 1, framesSinceReset: 4 }); renderer.dispose();
  });

  it('cancels both pending caches and restarts reflection history after a failed submission', async () => {
    const gpu = fixture(); const renderer = await gpu.create(); const render = frames(gpu, renderer); render();
    const reflection = renderer.reflectionCache.bindings; const probes = renderer.probeCache.bindings;
    renderer.encode(gpu.encoder, {} as GPUTextureView, 1280, 720, 1 / 60, { reflections: { objectOffset: -0.4 } });
    gpu.raw.queue.submit.mockImplementationOnce(() => { throw new Error('submission failed'); });
    try { gpu.raw.queue.submit([{}]); } catch { renderer.cancelFrame(); }
    expect(renderer.reflectionCache.bindings).toBe(reflection); expect(renderer.probeCache.bindings).toEqual(probes);
    expect(renderer.reflectionCache.telemetry).toMatchObject({ cacheEpoch: 1, sourceFrameId: 1, submittedFrames: 1 });
    expect(renderer.probeCache.telemetry).toMatchObject({ cacheEpoch: 1, sourceFrameId: 1, submittedFrames: 1 });
    render({ cameraCut: true });
    expect(renderer.reflectionTelemetry).toMatchObject({ cacheEpoch: 2, sourceFrameId: 2, submittedFrames: 2, framesSinceReset: 1 });
    expect(renderer.giTelemetry).toMatchObject({ cacheEpoch: 1, sourceFrameId: 2, submittedFrames: 2, refreshFrontier: 64 }); renderer.dispose();
  });

  it('keeps hard light, door, wall, explicit reset and re-enable exclusions across soft motion and cancellation', async () => {
    const gpu = fixture(); const renderer = await gpu.create(); const render = frames(gpu, renderer);
    for (let index = 0; index < 24; index++) render({ reflections: { objectOffset: Math.sin(index) * 0.4 } });
    expect(renderer.giTelemetry).toMatchObject({ cacheEpoch: 1, framesSinceReset: 24, refreshFrontier: 0 });
    let epoch = 1;
    for (const gi of [{ lightIntensity: 0 }, { doorOpen: false }, { wallColor: 'neutral' as const }, { resetCache: true }]) {
      renderer.encode(gpu.encoder, {} as GPUTextureView, 1280, 720, 1, { gi }); renderer.cancelFrame();
      expect(renderer.probeCache.telemetry.cacheEpoch).toBe(epoch);
      render();
      expect(renderer.giTelemetry).toMatchObject({ cacheEpoch: ++epoch, framesSinceReset: 1, refreshFrontier: 32 });
    }
    render({ gi: { enabled: false }, reflections: { objectOffset: 0.4 } });
    const submitted = renderer.probeCache.telemetry.submittedFrames;
    render({ reflections: { objectOffset: -0.4 } });
    expect(renderer.probeCache.telemetry.submittedFrames).toBe(submitted);
    render({ gi: { enabled: true } });
    expect(renderer.giTelemetry).toMatchObject({ cacheEpoch: ++epoch, framesSinceReset: 1, refreshFrontier: 32 });
    renderer.dispose();
  });

  it('refreshes composer bind groups by history identity across resize while reusing stable frame banks', async () => {
    const gpu = fixture(); const renderer = await gpu.create(); const render = frames(gpu, renderer);
    const reflectionGroups = () => gpu.groups.filter(group => group.label === 'Strata current reflection history');
    render(); render(); render(); expect(reflectionGroups()).toHaveLength(2);
    const original = reflectionGroups(); const oldBindings = renderer.reflectionCache.bindings;
    const oldTexture = renderer.composer.outputTexture;
    render({}, 1920, 1080); expect(reflectionGroups()).toHaveLength(3);
    expect(renderer.reflectionCache.bindings).not.toBe(oldBindings); expect(renderer.composer.outputTexture).not.toBe(oldTexture);
    const replacement = reflectionGroups()[2]!;
    const entries = (group: GPUBindGroupDescriptor) => [...group.entries];
    const uniform = entries(replacement)[3]!.resource as GPUBufferBinding;
    expect(original.some(group => (entries(group)[3]!.resource as GPUBufferBinding).buffer === uniform.buffer)).toBe(true);
    expect(original.every(group => entries(group)[0]!.resource !== entries(replacement)[0]!.resource)).toBe(true);
    render({}, 1920, 1080); render({}, 1920, 1080); expect(reflectionGroups()).toHaveLength(4);
    renderer.dispose(); renderer.dispose(); expect(renderer.gpuBufferBytes + renderer.gpuTextureBytes).toBe(0);
    expect([...gpu.buffers, ...gpu.textures].every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
  });

  it('retains owned resources after a failed target resize and cleans up after a retry', async () => {
    const gpu = fixture(); const renderer = await gpu.create(); const render = frames(gpu, renderer); render();
    const before = renderer.gpuTextureBytes; const target = renderer.composer.outputTexture; gpu.failNextView();
    expect(() => renderer.encode(gpu.encoder, {} as GPUTextureView, 1920, 1080, 1 / 60)).toThrow('view failed'); renderer.cancelFrame();
    expect(renderer.gpuTextureBytes).toBe(before); expect(renderer.composer.outputTexture).toBe(target);
    render({ cameraCut: true }, 1920, 1080); expect(renderer.gpuTextureBytes).toBeGreaterThan(before);
    renderer.dispose(); expect([...gpu.buffers, ...gpu.textures].every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
  });

  it('releases all partial resources when raster pipeline creation fails', async () => {
    const gpu = fixture(); gpu.raw.createRenderPipelineAsync.mockRejectedValueOnce(new Error('raster compile failed'));
    await expect(gpu.create()).rejects.toThrow('raster compile failed');
    expect(gpu.buffers.length).toBeGreaterThan(10);
    expect([...gpu.buffers, ...gpu.textures].every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
  });

  it('keeps no GI dispatches when world reflections use the uninitialized probe placeholders', async () => {
    const gpu = fixture(); const renderer = await gpu.create(); const render = frames(gpu, renderer);
    render({ gi: { enabled: false }, temporal: false });
    const config = renderer.reflectionCache.diagnostics.configBuffer as unknown as typeof gpu.buffers[number];
    expect(new Uint32Array(config.bytes.buffer)[43]).toBe(0);
    expect(renderer.giTelemetry).toMatchObject({ enabled: false, sourceFrameId: null, submittedFrames: 0, cacheEpoch: 0 });
    expect(gpu.rawEncoder.copyTextureToTexture).not.toHaveBeenCalled();
    expect(gpu.passes.filter(pass => pass.type === 'compute')).toHaveLength(3);
    for (const mode of ['off', 'probe-only', 'world'] as ReflectionMode[]) render({ reflections: { mode } });
    expect(renderer.giTelemetry.submittedFrames).toBe(0); renderer.dispose();
  });
});
