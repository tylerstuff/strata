import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportedIndirectEffect } from '../../packages/core/src/imported/imported-indirect-effect.js';
import type { ImportedIndirectCreateOptions } from '../../packages/core/src/imported/imported-indirect-types.js';
import { normalizeImportedIndirectOptions, normalizeImportedSpatialDenoise, validateImportedIndirectCapability } from '../../packages/core/src/imported/imported-indirect-options.js';
import type { CameraFrame } from '../../packages/core/src/rendering/raster-math.js';
import type { RasterOutputs } from '../../packages/core/src/rendering/raster-types.js';

function camera(): CameraFrame { return { view: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), eye: [0, 0, 3], far: 32 }; }
function options(): ImportedIndirectCreateOptions {
  const borrowed = () => ({ destroy: vi.fn() }) as unknown as GPUTextureView;
  return { source: { nodes: new Uint8Array(32), triangles: new Uint8Array(64), vertices: new Float32Array(48), indices: new Uint32Array([0, 1, 2]) },
    material: { baseColorTexture: borrowed(), baseSampler: borrowed() as GPUSampler, metallicRoughnessTexture: borrowed(), metallicRoughnessSampler: borrowed() as GPUSampler,
      emissiveTexture: borrowed(), emissiveSampler: borrowed() as GPUSampler, baseColorFactor: [.2, .3, .4, 1], metallicFactor: .25, doubleSided: true, emissiveFactor: [.1, .2, .3], emissiveStrength: 4 },
    lighting: { directionToLight: [0, 2, 0], color: [1, .5, .25], intensity: 3 }, environment: { mode: 'constant', intensity: 2, rotationRadians: Math.PI / 2, constantRadiance: [.1, .2, .3] },
    options: { maxPixels: 256, pixelBatch: 8, maxSamples: 16, maxVisits: 123, seed: 7 } };
}
function gpu() {
  const buffers: ReturnType<typeof makeBuffer>[] = [], textures: { destroy: ReturnType<typeof vi.fn>; createView: ReturnType<typeof vi.fn> }[] = [];
  function makeBuffer(descriptor: GPUBufferDescriptor) {
    const data = new Uint8Array(descriptor.size); return { label: descriptor.label, size: descriptor.size, data, destroy: vi.fn(), mapAsync: vi.fn(async (): Promise<void> => {}), getMappedRange: vi.fn(() => data.buffer), unmap: vi.fn() };
  }
  function encoder() {
    const commands: (() => void)[] = [], passes: { descriptor: GPUComputePassDescriptor | undefined; dispatchWorkgroups: ReturnType<typeof vi.fn> }[] = [];
    const value = { clearBuffer: vi.fn((buffer: ReturnType<typeof makeBuffer>, offset = 0, size = buffer.size - offset) => commands.push(() => buffer.data.fill(0, offset, offset + size))),
      copyBufferToBuffer: vi.fn((source: ReturnType<typeof makeBuffer>, sourceOffset: number, target: ReturnType<typeof makeBuffer>, targetOffset: number, bytes: number) => commands.push(() => target.data.set(source.data.subarray(sourceOffset, sourceOffset + bytes), targetOffset))),
      beginComputePass: vi.fn((descriptor?: GPUComputePassDescriptor) => { const pass = { descriptor, setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() }; passes.push(pass); return pass; }),
      finish: vi.fn(() => commands), passes };
    return value;
  }
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024, maxTextureDimension2D: 8192, maxBindGroups: 4, maxStorageBuffersPerShaderStage: 8,
    maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16, maxStorageTexturesPerShaderStage: 4, maxUniformBufferBindingSize: 65536,
    maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupSizeY: 256, maxComputeWorkgroupsPerDimension: 65535 },
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor), createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor),
    createShaderModule: vi.fn(() => ({})), createComputePipelineAsync: vi.fn(async (descriptor: GPUComputePipelineDescriptor) => descriptor),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor), createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => { const b = makeBuffer(descriptor); buffers.push(b); return b; }),
    createTexture: vi.fn((_descriptor: GPUTextureDescriptor) => { const t = { destroy: vi.fn(), createView: vi.fn(() => ({})) }; textures.push(t); return t; }), createCommandEncoder: vi.fn(encoder),
    queue: { writeBuffer: vi.fn((b: ReturnType<typeof makeBuffer>, offset: number, data: ArrayBuffer | ArrayBufferView<ArrayBuffer>) => b.data.set(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset)),
      submit: vi.fn((sets: (() => void)[][]) => { for (const commands of sets) for (const command of commands) command(); }) } };
  return { device: device as unknown as GPUDevice, raw: device, buffers, textures, encoder };
}
const outputs = { hdr: { label: 'raw sharp HDR' }, normal: {}, material: {}, motion: {}, depth: { label: 'depth' } } as unknown as RasterOutputs;
function encode(effect: ImportedIndirectEffect, g: ReturnType<typeof gpu>, cam = camera(), width = 7, height = 3, debugView: 'final' | 'indirect' | 'trace' = 'final') {
  const e = g.encoder(); effect.prepare(e as unknown as GPUCommandEncoder, cam, width, height, 0, {});
  const result = effect.compose(e as unknown as GPUCommandEncoder, outputs, cam, width, height, 0, { temporal: false, debugView }, {});
  return { encoder: e, result };
}

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const capabilityOptions = (): ImportedIndirectCreateOptions => { const input = options(); return { ...input, options: { ...input.options, spatialDenoise: true } }; };
function guide(g: ReturnType<typeof gpu>) {
  const groups = g.raw.createBindGroup.mock.calls.map(([value]) => value);
  const entry = groups.flatMap(value => [...value.entries]).reverse().find(value => value.binding === 6);
  expect(entry).toBeDefined(); return (entry!.resource as GPUBufferBinding).buffer as unknown as (typeof g.buffers)[number];
}
function submit(effect: ImportedIndirectEffect, g: ReturnType<typeof gpu>, frame = encode(effect, g), frameId = 1) {
  g.raw.queue.submit([frame.encoder.finish()]); effect.submitted(frameId); return frame;
}
const effects: ImportedIndirectEffect[] = [];
afterEach(() => { for (const effect of effects.splice(0)) effect.dispose(); vi.useRealTimers(); });
async function make(g: ReturnType<typeof gpu>, input = capabilityOptions()) { const effect = await ImportedIndirectEffect.create(g.device, input); effects.push(effect); return effect; }

describe('optional imported spatial reconstruction data and lifecycle', () => {
  it('normalizes the lifetime capability separately from numeric trace limits and rejects malformed flags', () => {
    const input = Object.freeze({ maxSamples: 8, spatialDenoise: true });
    expect(normalizeImportedSpatialDenoise(input)).toBe(true);
    expect(normalizeImportedSpatialDenoise({})).toBe(false);
    expect(normalizeImportedSpatialDenoise({ spatialDenoise: false })).toBe(false);
    expect(normalizeImportedIndirectOptions(input)).toEqual({ maxPixels: 262144, pixelBatch: 4096, maxSamples: 8, maxVisits: 4096, seed: 1337 });
    expect(input).toEqual({ maxSamples: 8, spatialDenoise: true });
    for (const spatialDenoise of [null, 0, 1, 'true', [], {}]) {
      expect(() => normalizeImportedSpatialDenoise({ spatialDenoise } as never)).toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
    }
  });

  it('admits exactly the fixed capability pixel and binding budgets while keeping the six-binding path', async () => {
    const g = gpu(); g.raw.limits.maxStorageBuffersPerShaderStage = 6;
    const ordinary = await make(g, options());
    expect(g.raw.createBindGroupLayout.mock.calls.some(([d]) => [...d.entries].length === 6)).toBe(true);
    expect(g.raw.createBindGroupLayout.mock.calls.some(([d]) => [...d.entries].length === 7)).toBe(false);
    expect(() => ordinary.validateDenoise('spatial')).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_FEATURE' }));
    expect(ordinary.progress).toMatchObject({ spatialDenoise: false, denoise: 'off' });
    const h = gpu(); h.raw.limits.maxStorageBuffersPerShaderStage = 6;
    await expect(ImportedIndirectEffect.create(h.device, capabilityOptions())).rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT' });
    expect(h.raw.createComputePipelineAsync).not.toHaveBeenCalled(); expect(h.buffers).toHaveLength(0);
    const l = gpu().raw.limits;
    expect(() => validateImportedIndirectCapability(l, 256, 256, true)).not.toThrow();
    expect(() => validateImportedIndirectCapability(l, 257, 256, true)).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LIMIT' }));
    expect(() => validateImportedIndirectCapability(l, 257, 256, false)).not.toThrow();
    expect(() => validateImportedIndirectCapability({ ...l, maxStorageBuffersPerShaderStage: 6 }, 1, 1, true)).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LIMIT' }));
    expect(() => validateImportedIndirectCapability({ ...l, maxStorageBufferBindingSize: 16 + 32 * 64 - 1 }, 8, 8, true)).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LIMIT' }));
  });

  it('allocates precisely one header plus f32 guides, keeps raw layouts intact, and toggles without reset or upload', async () => {
    const g = gpu(), effect = await make(g), initialBytes = effect.gpuBufferBytes;
    submit(effect, g, encode(effect, g), 17);
    const records = guide(g), state = effect.accumulationBuffer as unknown as (typeof g.buffers)[number];
    expect(records.size).toBe(16 + 32 * 21); expect(state.size).toBe(32 * 21);
    expect(effect.gpuBufferBytes).toBe(initialBytes + 32 * 21 + 16 + 32 * 21);
    expect(effect.gpuTextureBytes).toBe(8 * 21);
    expect(g.raw.createBindGroupLayout.mock.calls.some(([d]) => [...d.entries].length === 7)).toBe(true);
    state.data.fill(17); records.data.fill(23);
    const before = effect.progress, buffers = g.buffers.length, textures = g.textures.length;
    const sourceWrites = () => g.raw.queue.writeBuffer.mock.calls.filter(([buffer]) => buffer.label?.startsWith('Strata imported indirect source')).length;
    const uploadCount = sourceWrites();
    effect.setDenoise('spatial');
    expect(effect.progress).toMatchObject({ spatialDenoise: true, denoise: 'spatial', revision: before.revision, pendingReset: false, batchCursor: before.batchCursor, submittedFrameId: 17,
      presentationRevision: before.presentationRevision + 1 });
    const frame = encode(effect, g); submit(effect, g, frame, 23);
    expect([...records.data.subarray(0, 16)]).toEqual(Array(16).fill(0));
    expect([...records.data.subarray(16)]).toEqual(Array(32 * 21).fill(23));
    expect([...state.data]).toEqual(Array(32 * 21).fill(17));
    expect(effect.progress).toMatchObject({ revision: before.revision, denoise: 'spatial', submittedFrameId: 23, pendingReset: false });
    expect(sourceWrites()).toBe(uploadCount); expect(g.buffers).toHaveLength(buffers); expect(g.textures).toHaveLength(textures);
    const sameMode = effect.progress; effect.setDenoise('spatial'); expect(effect.progress).toEqual(sameMode);
    effect.setDenoise('off'); expect(effect.progress.pendingReset).toBe(false);
    expect(guide(g)).toBe(records); expect(effect.initialUploadBytes).toBe(300);
  });

  it('rejects invalid modes and capability changes atomically, including after guides exist', async () => {
    const g = gpu(), effect = await make(g); submit(effect, g); const before = effect.progress, bytes = effect.gpuBufferBytes, calls = g.raw.queue.writeBuffer.mock.calls.length;
    for (const mode of [null, true, '', 'temporal', 'SPATIAL']) {
      expect(() => effect.validateDenoise(mode as never)).toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
      expect(() => effect.setDenoise(mode as never)).toThrowError(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
      expect(effect.progress).toEqual(before);
    }
    expect(() => effect.updateSettings({ spatialDenoise: false })).toThrow();
    expect(effect.progress).toEqual(before); expect(effect.gpuBufferBytes).toBe(bytes); expect(g.raw.queue.writeBuffer).toHaveBeenCalledTimes(calls);
    const baseInput = capabilityOptions(), largeInput = { ...baseInput, options: { ...baseInput.options, maxPixels: 1048576 } };
    const h = gpu(), limited = await make(h, largeInput);
    expect(() => limited.validateSize(257, 256)).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LIMIT' }));
    expect(h.textures).toHaveLength(0);
  });

  it('clears the guide records together with raw state only on a committed hard reset and retries cancellation', async () => {
    const g = gpu(), effect = await make(g); submit(effect, g);
    const records = guide(g), state = effect.accumulationBuffer as unknown as (typeof g.buffers)[number]; records.data.fill(19); state.data.fill(31);
    effect.updateLighting({ directionToLight: [1, 0, 0], color: [1, 1, 1], intensity: 1 });
    encode(effect, g); effect.cancelFrame();
    expect(records.data.every(value => value === 19)).toBe(true); expect(state.data.every(value => value === 31)).toBe(true);
    expect(effect.progress).toMatchObject({ pendingFrame: false, pendingReset: true, revision: 1 });
    submit(effect, g, encode(effect, g), 9);
    expect(records.data.every(value => value === 0)).toBe(true); expect(state.data.every(value => value === 0)).toBe(true);
    expect(effect.progress).toMatchObject({ pendingReset: false, revision: 2, submittedFrames: 1, submittedFrameId: 9 });
  });

  it.each(['guide', 'texture', 'bindings'] as const)('rolls back a failed resize at %s without retiring the live target', async stage => {
    const g = gpu(), effect = await make(g); submit(effect, g);
    const oldState = effect.accumulationBuffer, oldGuide = guide(g), oldOutput = effect.outputTexture;
    const oldBuffers = g.buffers.length, oldTextures = g.textures.length, oldBytes = effect.gpuBufferBytes;
    if (stage === 'guide') { const create = g.raw.createBuffer.getMockImplementation()!; g.raw.createBuffer.mockImplementation(d => { if (d.size === 16 + 32 * 24) throw Error('guide allocation failed'); return create(d); }); }
    if (stage === 'texture') g.raw.createTexture.mockImplementationOnce(() => { throw Error('texture allocation failed'); });
    if (stage === 'bindings') g.raw.createBindGroup.mockImplementationOnce(() => { throw Error('binding creation failed'); });
    expect(() => encode(effect, g, camera(), 8, 3)).toThrow(/failed/);
    expect(effect.accumulationBuffer).toBe(oldState); expect(effect.outputTexture).toBe(oldOutput); expect(effect.gpuBufferBytes).toBe(oldBytes);
    expect(oldGuide.destroy).not.toHaveBeenCalled();
    for (const resource of [...g.buffers.slice(oldBuffers), ...g.textures.slice(oldTextures)]) expect(resource.destroy).toHaveBeenCalledOnce();
    expect(effect.progress).toMatchObject({ pendingFrame: false, pendingReset: true, revision: 1 });
    submit(effect, g, encode(effect, g), 8); expect(effect.progress.submittedFrameId).toBe(8);
  });

  it('returns separate frame-tagged reconstruction diagnostics without relabeling raw sample failures', async () => {
    const g = gpu(), effect = await make(g); effect.setDenoise('spatial'); submit(effect, g, encode(effect, g), 57);
    const raw = g.buffers.find(b => b.label === 'Strata imported indirect counters')!;
    new Uint32Array(raw.data.buffer).set([8, 5, 2, 1]); new Uint32Array(guide(g).data.buffer, 0, 4).set([12, 13, 14, 15]);
    const readback = await effect.readProgress();
    expect(readback).toMatchObject({ attempted: 8, completed: 5, exhausted: 2, invalid: 1, revision: 1, submittedFrameId: 57, denoise: 'spatial',
      spatialDiagnostics: { filteredPixels: 12, fallbackChannels: 13, hdrFaultChannels: 14, guideBypassPixels: 15 } });
    expect(g.buffers.at(-1)!.size).toBe(32); expect(g.buffers.at(-1)!.destroy).toHaveBeenCalledOnce();
    const before = effect.progress; effect.setDenoise('off');
    submit(effect, g, encode(effect, g), 58); const recovered = await effect.readProgress();
    expect(recovered).toMatchObject({ attempted: 8, completed: 5, exhausted: 2, invalid: 1, revision: before.revision, submittedFrameId: 58, denoise: 'off',
      spatialDiagnostics: { filteredPixels: 0, fallbackChannels: 0, hdrFaultChannels: 0, guideBypassPixels: 0 } });
  });

  it('tags an in-flight readback with its submitted mode and frame even if a later display control changes', async () => {
    const g = gpu(), effect = await make(g); effect.setDenoise('spatial'); submit(effect, g, encode(effect, g), 20);
    const wait = deferred<void>(), create = g.raw.createBuffer.getMockImplementation()!;
    g.raw.createBuffer.mockImplementation(d => { const b = create(d); if ((d.usage & 1) !== 0) b.mapAsync.mockReturnValueOnce(wait.promise); return b; });
    const before = effect.progress, pending = effect.readProgress(); effect.setDenoise('off'); wait.resolve();
    const result = await pending;
    expect(result).toMatchObject({ submittedFrameId: 20, denoise: 'spatial', presentationRevision: before.presentationRevision });
    expect(effect.progress).toMatchObject({ denoise: 'off', presentationRevision: before.presentationRevision + 1 });
  });

  it('never relabels a previous submitted header with a newly requested display mode', async () => {
    const g = gpu(), effect = await make(g); effect.setDenoise('spatial'); submit(effect, g, encode(effect, g), 31);
    const before = effect.progress; new Uint32Array(guide(g).data.buffer, 0, 4).set([7, 0, 2, 0]);
    effect.setDenoise('off'); const old = await effect.readProgress();
    expect(old).toMatchObject({ submittedFrameId: 31, denoise: 'spatial', presentationRevision: before.presentationRevision,
      spatialDiagnostics: { hdrFaultChannels: 2 } });
    expect(effect.progress).toMatchObject({ denoise: 'off', presentationRevision: before.presentationRevision + 1 });
    submit(effect, g, encode(effect, g), 32); const current = await effect.readProgress();
    expect(current).toMatchObject({ submittedFrameId: 32, denoise: 'off', presentationRevision: before.presentationRevision + 1,
      spatialDiagnostics: { hdrFaultChannels: 0 } });
  });

  it('destroys a pending diagnostic readback exactly once on disposal and never touches borrowed textures', async () => {
    const g = gpu(), input = capabilityOptions(), effect = await make(g, input); submit(effect, g);
    const wait = deferred<void>(), create = g.raw.createBuffer.getMockImplementation()!;
    g.raw.createBuffer.mockImplementation(d => { const b = create(d); if ((d.usage & 1) !== 0) b.mapAsync.mockReturnValueOnce(wait.promise); return b; });
    const pending = effect.readProgress(); const readback = g.buffers.at(-1)!; effect.dispose(); wait.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'ENGINE_DISPOSED' });
    expect(readback.getMappedRange).not.toHaveBeenCalled();
    for (const resource of [...g.buffers, ...g.textures]) expect(resource.destroy).toHaveBeenCalledOnce();
    for (const resource of [input.material.baseColorTexture, input.material.metallicRoughnessTexture, input.material.emissiveTexture]) expect((resource as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).not.toHaveBeenCalled();
    expect(effect.gpuBufferBytes).toBe(0); expect(effect.gpuTextureBytes).toBe(0);
  });
});
