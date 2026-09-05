import { describe, expect, it, vi } from 'vitest';
import { GiRenderer } from '../../packages/core/src/gi/gi-renderer.js';
import { GiComposer } from '../../packages/core/src/gi/gi-composer.js';
import { RoomGeometry, createGiCamera, invertGiMatrix } from '../../packages/core/src/gi/room-geometry.js';
import { createGiScene } from '../../packages/core/src/gi/scene-data.js';
import type { GiControls } from '../../packages/core/src/gi/gi-types.js';
import type { ProbeBindings } from '../../packages/core/src/gi/probe-cache.js';
import type { RasterControls, RasterOutputs } from '../../packages/core/src/rendering/raster-types.js';

function fixture() {
  const buffers: { descriptor: GPUBufferDescriptor; size: number; bytes: Uint8Array<ArrayBuffer>; destroy: ReturnType<typeof vi.fn> }[] = [];
  const textures: { descriptor: GPUTextureDescriptor; createView: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[] = [];
  let failNextView = false;
  const pipeline = () => ({ getBindGroupLayout: vi.fn(() => ({})) });
  const device = {
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { descriptor, size: descriptor.size, bytes: new Uint8Array(descriptor.size), destroy: vi.fn() }; buffers.push(buffer); return buffer;
    }),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const failView = failNextView; failNextView = false;
      const texture = { descriptor, createView: vi.fn(() => {
        if (failView) throw new Error('view creation failed');
        return {};
      }), destroy: vi.fn() };
      textures.push(texture); return texture;
    }),
    createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})), createPipelineLayout: vi.fn(() => ({})),
    createSampler: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    createComputePipelineAsync: vi.fn(async () => pipeline()), createRenderPipelineAsync: vi.fn(async () => pipeline()),
    queue: {
      writeBuffer: vi.fn((buffer: typeof buffers[number], offset: number, input: ArrayBuffer | ArrayBufferView<ArrayBuffer>, dataOffset = 0, size?: number) => {
        const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
        const unit = 'BYTES_PER_ELEMENT' in input ? Number(input.BYTES_PER_ELEMENT) : 1;
        const start = dataOffset * unit;
        buffer.bytes.set(bytes.subarray(start, size === undefined ? undefined : start + size * unit), offset);
      }),
      writeTexture: vi.fn(), submit: vi.fn((_commands: readonly unknown[]) => undefined),
    },
  };
  const renderPass = () => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(),
    drawIndexed: vi.fn(), draw: vi.fn(), end: vi.fn() });
  const computePass = () => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() });
  const encoder = { copyTextureToTexture: vi.fn(), beginRenderPass: vi.fn(renderPass), beginComputePass: vi.fn(computePass) };
  const create = () => GiRenderer.create(device as unknown as GPUDevice, 'bgra8unorm', { renderer: 'gi' });
  return { device: device as unknown as GPUDevice, raw: device, buffers, textures, pipeline,
    encoder: encoder as unknown as GPUCommandEncoder, rawEncoder: encoder, create, failNextView: () => { failNextView = true; } };
}

function transform(matrix: Float32Array, value: readonly number[]): number[] {
  return Array.from({ length: 4 }, (_, row) => value.reduce((sum, component, column) => sum + matrix[column * 4 + row]! * component, 0));
}
function project(matrix: Float32Array, value: readonly number[]): number[] {
  const clip = transform(matrix, [...value, 1]); return clip.slice(0, 3).map(component => component / clip[3]!);
}
function emptyOutputs(): RasterOutputs { return { hdr: {}, normal: {}, material: {}, motion: {}, depth: {} } as RasterOutputs; }
function emptyProbes(): ProbeBindings { return { irradiance: {}, visibility: {}, state: {}, uniform: {} } as ProbeBindings; }

describe('GI camera reconstruction', () => {
  it('roundtrips world coordinates through the jittered inverse and frames the receiver with offscreen source geometry', () => {
    for (const mode of ['receiver', 'overview', 'tour'] as const) {
      const camera = createGiCamera(1280, 720, 3, [0.25, -0.4], mode);
      const inverse = invertGiMatrix(camera.viewProjection);
      for (const point of [[-1.5, 0.01, 0.2], [-0.7, 0.01, 0], [2, 1, -2]]) {
        const clip = project(camera.viewProjection, point);
        const homogeneous = transform(inverse, [...clip, 1]);
        point.forEach((component, axis) => expect(homogeneous[axis]! / homogeneous[3]!).toBeCloseTo(component, 3));
      }
    }
    const camera = createGiCamera(1280, 720, 0, [0, 0], 'receiver');
    const receiver = project(camera.viewProjection, [-1.5, 0.01, 0.2]);
    expect(receiver[0]).toBeCloseTo(0, 5); expect(receiver[1]).toBeCloseTo(0, 5);
    expect(receiver[2]).toBeGreaterThan(0); expect(receiver[2]).toBeLessThan(1);
    const wall = project(camera.viewProjection, [3, 2, -4]);
    expect(Math.max(Math.abs(wall[0]!), Math.abs(wall[1]!))).toBeGreaterThan(1);
    const jittered = project(createGiCamera(1280, 720, 0, [0.25, -0.4], 'receiver').viewProjection, [-1.5, 0.01, 0.2]);
    expect((jittered[0]! - receiver[0]!) * 640).toBeCloseTo(0.25, 4);
    expect((jittered[1]! - receiver[1]!) * -360).toBeCloseTo(-0.4, 4);
    expect(() => invertGiMatrix(new Float32Array(16))).toThrow('singular');
  });
});

describe('GI scene and cache integration', () => {
  it('uploads only light/material records, keeps initial uploads separate, and attributes the submitted trace source', async () => {
    const gpu = fixture(); const renderer = await gpu.create();
    const traceWrites = () => gpu.raw.queue.writeBuffer.mock.calls.filter(([buffer]) => buffer.descriptor.label?.startsWith('Strata GI trace data '));
    expect(traceWrites()).toHaveLength(5);
    expect(renderer.giTelemetry).toMatchObject({ traceUpdateCount: 0, traceQueuedUpdateCount: 0,
      traceQueuedUploadBytes: 0, traceAttemptedWriteCalls: 0, traceLastSubmittedUpdateCount: 0, traceLastSubmittedFrameId: null });
    expect(renderer.giTelemetry.traceMetadataBytes).toBeGreaterThan(0);
    const encode = (gi: GiControls = {}) => renderer.encode(gpu.encoder, {} as GPUTextureView, 640, 360, 0, { gi, temporal: false });
    encode(); gpu.raw.queue.submit([{}]); renderer.submitted(1);
    const initial = traceWrites().length;
    encode({ lightIntensity: 2 });
    expect(traceWrites().slice(initial).map(([buffer]) => buffer.descriptor.label)).toEqual(['Strata GI trace data 4']);
    expect(renderer.giTelemetry).toMatchObject({ traceUpdateCount: 1, traceQueuedUpdateCount: 1,
      traceQueuedUploadBytes: 48, traceQueuedWriteCalls: 1, traceRegeneratedTriangleCount: 0,
      tracePackedTriangleCount: 0, traceRefitLeafCount: 0, traceRefitAncestorCount: 0,
      traceLastSubmittedUpdateCount: 0, traceLastSubmittedFrameId: 1 });
    renderer.cancelFrame();
    expect(renderer.giTelemetry.traceLastSubmittedUpdateCount).toBe(0);
    const written = traceWrites().length; encode();
    expect(traceWrites()).toHaveLength(written); // Queue writes survive encoder cancellation.
    gpu.raw.queue.submit([{}]); renderer.submitted(2);
    expect(renderer.giTelemetry).toMatchObject({ traceLastSubmittedUpdateCount: 1, traceLastSubmittedFrameId: 2 });
    encode({ wallColor: 'neutral' }); gpu.raw.queue.submit([{}]); renderer.submitted(3);
    expect(traceWrites().slice(written).map(([buffer]) => buffer.descriptor.label)).toEqual(['Strata GI trace data 3']);
    expect(renderer.giTelemetry).toMatchObject({ traceQueuedUploadBytes: 80, traceQueuedWriteCalls: 2,
      traceUpdateCount: 2, traceQueuedUpdateCount: 2, traceLastSubmittedUpdateCount: 2,
      traceRegeneratedTriangleCount: 0, tracePackedTriangleCount: 0, traceRefitLeafCount: 0, traceRefitAncestorCount: 0 });
    encode({ wallColor: 'neutral', lightIntensity: 2 }); gpu.raw.queue.submit([{}]); renderer.submitted(4);
    expect(renderer.giTelemetry).toMatchObject({ traceUpdateCount: 2, traceQueuedUploadBytes: 80, traceLastSubmittedFrameId: 4 });
    renderer.dispose(); expect(renderer.giTelemetry.traceMetadataBytes).toBe(0);
    expect(renderer.giTelemetry.tracePendingUploadBytes).toBe(0);
    expect(gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });

  it('keeps disabled CPU targets pending and retries a partially accepted trace upload against the latest target', async () => {
    const gpu = fixture(); const renderer = await gpu.create();
    const encode = (gi: GiControls = {}) => renderer.encode(gpu.encoder, {} as GPUTextureView, 640, 360, 0, { gi, temporal: false });
    encode(); renderer.submitted(1);
    encode({ enabled: false, doorOpen: false }); renderer.submitted(2);
    expect(renderer.giTelemetry).toMatchObject({ traceUpdateCount: 1, traceQueuedUpdateCount: 0,
      traceLastSubmittedUpdateCount: 0, traceLastSubmittedFrameId: 2, traceQueuedWriteCalls: 0 });
    expect(renderer.giTelemetry.tracePendingUploadBytes).toBeGreaterThan(0);
    const write = gpu.raw.queue.writeBuffer.getMockImplementation()!; let attempts = 0;
    gpu.raw.queue.writeBuffer.mockImplementation((...args) => {
      if (args[0].descriptor.label?.startsWith('Strata GI trace data ') && ++attempts === 2) throw Error('trace range failed');
      write(...args);
    });
    expect(() => encode({ enabled: true })).toThrow('trace range failed'); renderer.cancelFrame();
    expect(renderer.giTelemetry).toMatchObject({ traceUpdateCount: 1, traceQueuedUpdateCount: 0,
      traceAttemptedWriteCalls: 2, traceQueuedWriteCalls: 1, traceLastSubmittedUpdateCount: 0, traceLastSubmittedFrameId: 2 });
    expect(renderer.giTelemetry.traceQueuedUploadBytes).toBeGreaterThan(0);
    expect(renderer.giTelemetry.tracePendingUploadBytes).toBeGreaterThan(0);
    gpu.raw.queue.writeBuffer.mockImplementation(write);
    encode({ lightIntensity: 2 }); gpu.raw.queue.submit([{}]); renderer.submitted(3);
    expect(renderer.giTelemetry).toMatchObject({ traceUpdateCount: 2, traceQueuedUpdateCount: 2,
      traceLastSubmittedUpdateCount: 2, traceLastSubmittedFrameId: 3, tracePendingRangeCount: 0, tracePendingUploadBytes: 0 });
    const arrays = [renderer.traceData.nodeData, renderer.traceData.triangleData, renderer.traceData.boxData, renderer.traceData.materialData, renderer.traceData.uniformData];
    arrays.forEach((bytes, index) => expect(gpu.buffers.find(buffer => buffer.descriptor.label === `Strata GI trace data ${index}`)!.bytes).toEqual(new Uint8Array(bytes)));
    expect(renderer.currentScene.state).toMatchObject({ doorOpen: false, lightIntensity: 2 });
    renderer.dispose();
  });

  it('resets world epochs for material, light, door and explicit cache changes while camera and TAA changes preserve them', async () => {
    const gpu = fixture(); const renderer = await gpu.create(); let frameId = 0;
    const render = (controls: RasterControls & { gi?: GiControls } = {}) => {
      const result = renderer.encode(gpu.encoder, {} as GPUTextureView, 640, 360, frameId / 60, controls);
      gpu.raw.queue.submit([{}]); renderer.submitted(++frameId); return result;
    };
    render(); expect(renderer.giTelemetry).toMatchObject({ worldRevision: 1, cacheEpoch: 1, framesSinceReset: 1 });
    render({ cameraCut: true, temporal: false });
    render({ debugView: 'indirect' });
    expect(renderer.giTelemetry).toMatchObject({ worldRevision: 1, cacheEpoch: 1, framesSinceReset: 3 });
    render({ gi: { doorOpen: false } });
    expect(renderer.currentScene.state.doorOpen).toBe(false);
    expect(renderer.giTelemetry).toMatchObject({ worldRevision: 2, cacheEpoch: 2, framesSinceReset: 1 });
    render({ gi: { doorOpen: false } });
    expect(renderer.giTelemetry.worldRevision).toBe(2);
    render({ gi: { lightIntensity: 2 } });
    expect(renderer.giTelemetry).toMatchObject({ worldRevision: 3, cacheEpoch: 3, lightIntensity: 2 });
    render({ gi: { wallColor: 'neutral' } });
    expect(renderer.giTelemetry).toMatchObject({ worldRevision: 4, cacheEpoch: 4, wallColor: 'neutral' });
    render({ gi: { resetCache: true } });
    expect(renderer.giTelemetry).toMatchObject({ worldRevision: 5, cacheEpoch: 5, framesSinceReset: 1 });
    renderer.dispose(); renderer.dispose();
    expect([...gpu.buffers, ...gpu.textures].every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
  });

  it('predicts disabled passes without mutating state and performs no GI dispatch or ray budget while disabled', async () => {
    const gpu = fixture(); const renderer = await gpu.create();
    expect(renderer.passNames()).toEqual(['gi-trace', 'gi-update', 'shadow', 'raster', 'gi-shade', 'temporal', 'presentation']);
    expect(renderer.passNames({ gi: { enabled: false } })).toEqual(['shadow', 'raster', 'temporal', 'presentation']);
    expect(renderer.giTelemetry.enabled).toBe(true);
    const disabled = renderer.encode(gpu.encoder, {} as GPUTextureView, 640, 360, 0, { temporal: false, gi: { enabled: false } });
    renderer.submitted(1);
    expect(disabled.dispatchCalls).toBe(0); expect(disabled.drawCalls).toBe(3);
    expect(renderer.passNames({ temporal: false })).toEqual(['shadow', 'raster', 'presentation']);
    expect(renderer.giTelemetry).toMatchObject({ enabled: false, primaryRaysPerFrame: 0, maxShadowRaysPerFrame: 0, cacheEpoch: 0, submittedFrames: 0 });
    expect(gpu.rawEncoder.beginComputePass).not.toHaveBeenCalled();
    const enabled = renderer.encode(gpu.encoder, {} as GPUTextureView, 640, 360, 1 / 60, { temporal: false, gi: { enabled: true } });
    renderer.submitted(2);
    expect(enabled.dispatchCalls).toBe(3);
    expect(renderer.giTelemetry).toMatchObject({ enabled: true, primaryRaysPerFrame: 2048, cacheEpoch: 1, submittedFrames: 1 });
    renderer.dispose();
  });

  it('cancels failed submission without advancing cache frontier, epoch or frame sequence', async () => {
    const gpu = fixture(); const renderer = await gpu.create(); const initial = renderer.probeCache.bindings;
    const encode = () => renderer.encode(gpu.encoder, {} as GPUTextureView, 640, 360, 0, { temporal: false });
    const config = () => new Uint32Array((renderer.probeCache.diagnostics.configBuffer as unknown as typeof gpu.buffers[number]).bytes.buffer);
    encode(); expect([...config().subarray(8, 12)]).toEqual([0, 32, 64, 1]); expect(config()[16]).toBe(0);
    gpu.raw.queue.submit.mockImplementationOnce(() => { throw new Error('submit failed'); });
    try { gpu.raw.queue.submit([{}]); } catch { renderer.cancelFrame(); }
    expect(renderer.probeCache.bindings).toEqual(initial);
    expect(renderer.giTelemetry).toMatchObject({ cacheEpoch: 0, sourceFrameId: null, submittedFrames: 0 });
    encode(); expect([...config().subarray(8, 12)]).toEqual([0, 32, 64, 1]); expect(config()[16]).toBe(0);
    gpu.raw.queue.submit([{}]); renderer.submitted(7);
    expect(renderer.giTelemetry).toMatchObject({ cacheEpoch: 1, sourceFrameId: 7, submittedFrames: 1 });
    encode(); expect([...config().subarray(8, 12)]).toEqual([32, 32, 64, 1]); expect(config()[16]).toBe(1);
    renderer.cancelFrame(); renderer.dispose();
  });

  it('cleans trace, cache and room allocations when the shared raster pipeline fails to compile', async () => {
    const gpu = fixture(); gpu.raw.createRenderPipelineAsync.mockRejectedValueOnce(new Error('raster pipeline failed'));
    await expect(gpu.create()).rejects.toThrow('raster pipeline failed');
    expect(gpu.buffers.length).toBeGreaterThan(10); expect(gpu.textures.length).toBeGreaterThan(0);
    expect([...gpu.buffers, ...gpu.textures].every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
  });
});

describe('GI target and room update resource ownership', () => {
  it('reuses composition targets, preserves the old target on failed resize, and retires every allocation once', async () => {
    const gpu = fixture(); const entries = [0, 1, 2, 3, 4].map(binding => ({ binding, resource: { buffer: {} as GPUBuffer } }));
    const composer = await GiComposer.create(gpu.device, entries);
    const camera = createGiCamera(64, 32, 0, [0, 0], 'receiver'); const outputs = emptyOutputs(); const probes = emptyProbes();
    composer.encode(gpu.encoder, outputs, camera, 64, 32, {}, probes);
    const original = composer.outputTexture; const initialTexture = gpu.textures[0]!;
    expect(composer.gpuTextureBytes).toBe(64 * 32 * 8);
    composer.encode(gpu.encoder, outputs, camera, 64, 32, {}, probes);
    expect(gpu.textures).toHaveLength(1);
    gpu.failNextView();
    expect(() => composer.encode(gpu.encoder, outputs, camera, 128, 64, {}, probes)).toThrow('view creation failed');
    expect(composer.outputTexture).toBe(original); expect(initialTexture.destroy).not.toHaveBeenCalled();
    expect(composer.gpuTextureBytes).toBe(64 * 32 * 8);
    expect(gpu.textures[1]!.destroy).toHaveBeenCalledOnce();
    composer.encode(gpu.encoder, outputs, camera, 128, 64, {}, probes);
    expect(composer.outputTexture).not.toBe(original); expect(initialTexture.destroy).toHaveBeenCalledOnce();
    expect(composer.gpuTextureBytes).toBe(128 * 64 * 8);
    composer.dispose(); composer.dispose();
    expect(composer.gpuTextureBytes + composer.gpuBufferBytes).toBe(0);
    expect([...gpu.buffers, ...gpu.textures].every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
  });

  it('retries the complete room/light upload after a partially successful rigid-state update', () => {
    const gpu = fixture(); const scene = createGiScene(); const room = new RoomGeometry(gpu.device, scene, 'receiver');
    const camera = room.camera(640, 360, 0, [0, 0]); const next = createGiScene({ doorOpen: false, lightIntensity: 2 });
    room.setScene(next);
    const write = gpu.raw.queue.writeBuffer.getMockImplementation()!;
    let count = 0;
    gpu.raw.queue.writeBuffer.mockImplementation((...args) => { if (++count === 2) throw new Error('light upload failed'); write(...args); });
    expect(() => room.prepare(gpu.encoder, camera, 640, 360, true, {})).toThrow('light upload failed');
    gpu.raw.queue.writeBuffer.mockImplementation(write);
    const retried = room.prepare(gpu.encoder, camera, 640, 360, true, {});
    expect(retried.uploadBytes).toBe(room.initialUploadBytes);
    const light = gpu.buffers.find(buffer => buffer.descriptor.label === 'Strata shared GI room light')!;
    const values = new Float32Array(light.bytes.buffer);
    next.light.radiance.forEach((component, index) => expect(values[4 + index]).toBeCloseTo(component, 5));
    expect(room.prepare(gpu.encoder, camera, 640, 360, false, {}).uploadBytes).toBe(0);
    room.dispose(); room.dispose();
    expect(gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });
});
