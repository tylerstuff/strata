import { describe, expect, it, vi } from 'vitest';
import { ImportedIndirectEffect } from '../../packages/core/src/imported/imported-indirect-effect.js';
import type { ImportedIndirectCreateOptions } from '../../packages/core/src/imported/imported-indirect-types.js';
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
    const data = new Uint8Array(descriptor.size); return { label: descriptor.label, size: descriptor.size, data, destroy: vi.fn(), mapAsync: vi.fn(async () => undefined), getMappedRange: vi.fn(() => data.buffer), unmap: vi.fn() };
  }
  function encoder() {
    const commands: (() => void)[] = [], passes: { descriptor: GPUComputePassDescriptor | undefined; dispatchWorkgroups: ReturnType<typeof vi.fn> }[] = [];
    const value = { clearBuffer: vi.fn((buffer: ReturnType<typeof makeBuffer>) => commands.push(() => buffer.data.fill(0))),
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

describe('imported progressive indirect effect ownership and submission', () => {
  it('uploads owned source copies, borrows material resources and encodes the exact 288-byte ABI', async () => {
    const g = gpu(), input = options(), effect = await ImportedIndirectEffect.create(g.device, input);
    expect(effect.initialUploadBytes).toBe(300); expect(effect.gpuBufferBytes).toBe(604); expect(effect.gpuTextureBytes).toBe(0);
    input.source.vertices.fill(9); expect(g.buffers[2]!.data.every(v => v === 0)).toBe(true);
    (input.material.baseColorFactor as unknown as number[])[0] = 1;
    const frame = encode(effect, g, camera(), 7, 3, 'indirect');
    const bytes = g.buffers.find(b => b.label === 'Strata imported indirect frame')!.data;
    const u = new Uint32Array(bytes.buffer), f = new Float32Array(bytes.buffer);
    expect([...u.subarray(36, 44)]).toEqual([7, 3, 0, 8, 16, 123, 7, 1]);
    expect([...f.subarray(44, 47)]).toEqual([0, 1, 0]); expect([...f.subarray(48, 51)]).toEqual([3, 1.5, .75]);
    expect([...f.subarray(52, 54)]).toEqual([3, 2]); expect(f[54]).toBeCloseTo(0); expect(f[55]).toBe(1);
    expect(f[60]).toBeCloseTo(.2); expect([...f.subarray(64, 68)]).toEqual([.25, 0, 1, 0]);
    expect(f[68]).toBeCloseTo(.4); expect(f[69]).toBeCloseTo(.8); expect(f[70]).toBeCloseTo(1.2);
    expect(frame.result).toMatchObject({ dispatchCalls: 2, uploadBytes: 288 }); expect(frame.result.view).not.toBe(outputs.hdr);
    expect(g.raw.createBindGroup.mock.calls.some(([d]) => [...d.entries].some(e => e.binding === 2 && e.resource === outputs.hdr))).toBe(true);
    expect(effect.gpuBufferBytes).toBe(604 + 21 * 32); expect(effect.gpuTextureBytes).toBe(21 * 8);
    expect(effect.progress).toMatchObject({ revision: 0, submittedFrames: 0, batchCursor: 0, normalMode: 'geometric', textureLod: 0 });
    effect.submitted(); effect.dispose(); effect.dispose();
    for (const resource of [...g.buffers, ...g.textures]) expect(resource.destroy).toHaveBeenCalledOnce();
    for (const resource of [input.material.baseColorTexture, input.material.baseSampler, input.material.metallicRoughnessTexture, input.material.metallicRoughnessSampler, input.material.emissiveTexture, input.material.emissiveSampler]) expect((resource as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).not.toHaveBeenCalled();
    expect(effect.gpuBufferBytes).toBe(0); expect(effect.gpuTextureBytes).toBe(0);
  });
  it('covers the pixel tail without overlap and advances its cursor only after submit acknowledgement', async () => {
    const g = gpu(), effect = await ImportedIndirectEffect.create(g.device, options()); const batches: number[][] = [];
    for (let i = 0; i < 4; i++) {
      const before = effect.progress, frame = encode(effect, g);
      const u = new Uint32Array(g.buffers.find(b => b.label === 'Strata imported indirect frame')!.data.buffer); batches.push([...u.subarray(38, 40)]);
      expect(effect.progress.batchCursor).toBe(before.batchCursor); expect(effect.progress.submittedFrames).toBe(before.submittedFrames);
      expect(() => effect.prepare(g.encoder() as unknown as GPUCommandEncoder, camera(), 7, 3, 0, {})).toThrow(/submitted/);
      g.raw.queue.submit([frame.encoder.finish()]); effect.submitted();
    }
    expect(batches).toEqual([[0, 8], [8, 8], [16, 5], [0, 8]]); expect(effect.progress).toMatchObject({ revision: 1, submittedFrames: 4, batchCursor: 8 }); effect.dispose();
  });
  it('records reset clears in the encoder, preserves hard resets across cancellation, and restarts deterministically', async () => {
    const g = gpu(), effect = await ImportedIndirectEffect.create(g.device, options()); let frame = encode(effect, g); g.raw.queue.submit([frame.encoder.finish()]); effect.submitted();
    const state = g.buffers.find(b => b.label === 'Strata imported indirect pixel state')!; state.data[0] = 123;
    effect.updateLighting({ directionToLight: [1, 0, 0], color: [1, 1, 1], intensity: 2 }); frame = encode(effect, g);
    expect(frame.encoder.clearBuffer).toHaveBeenCalledTimes(2); expect(state.data[0]).toBe(123); expect(effect.progress.revision).toBe(1);
    effect.cancelFrame(); expect(effect.progress).toMatchObject({ pendingReset: true, pendingFrame: false, revision: 1 });
    frame = encode(effect, g); expect(frame.encoder.clearBuffer).toHaveBeenCalledTimes(2); g.raw.queue.submit([frame.encoder.finish()]); expect(state.data[0]).toBe(0); effect.submitted();
    expect(effect.progress).toMatchObject({ revision: 2, submittedFrames: 1, batchCursor: 8, pendingReset: false }); effect.dispose();
  });
  it('invalidates on camera, dimensions, environment, options and reenable but not identical settings', async () => {
    const g = gpu(), input = options(), effect = await ImportedIndirectEffect.create(g.device, input); encode(effect, g); effect.submitted();
    effect.updateLighting(input.lighting, input.environment); expect(effect.progress.pendingReset).toBe(false);
    const moved = camera(); moved.viewProjection[12] = .1; let frame = encode(effect, g, moved); expect(frame.encoder.clearBuffer).toHaveBeenCalledTimes(2); effect.submitted();
    const oldBuffer = effect.accumulationBuffer; frame = encode(effect, g, moved, 8, 3); expect(frame.encoder.clearBuffer).toHaveBeenCalledTimes(2); expect(effect.accumulationBuffer).not.toBe(oldBuffer); effect.submitted();
    effect.updateLighting(input.lighting, { ...input.environment, intensity: 0 }); expect(effect.progress.pendingReset).toBe(true); encode(effect, g); effect.submitted();
    effect.updateSettings({ maxSamples: 32 }); expect(effect.progress.pendingReset).toBe(true); encode(effect, g); effect.submitted();
    effect.setEnabled(false); expect(effect.active).toBe(false); expect(() => effect.prepare(g.encoder() as unknown as GPUCommandEncoder, camera(), 7, 3, 0, {})).toThrow(/disabled/);
    effect.setEnabled(true); expect(effect.progress.pendingReset).toBe(true); encode(effect, g); effect.submitted();
    expect(effect.progress.revision).toBe(6); effect.dispose();
  });
  it('rejects resolution and temporal misuse before allocation/writes, retaining prior resources', async () => {
    const g = gpu(), effect = await ImportedIndirectEffect.create(g.device, options()); const before = effect.progress, bufferCount = g.buffers.length, writes = g.raw.queue.writeBuffer.mock.calls.length;
    expect(effect.maxPixels).toBe(256); expect(() => effect.validateSize(17, 16)).toThrow(/smaller explicit preview/);
    expect(() => effect.prepare(g.encoder() as unknown as GPUCommandEncoder, camera(), 17, 16, 0, {})).toThrow(/maxPixels/);
    expect(effect.progress).toEqual(before); expect(g.buffers).toHaveLength(bufferCount); expect(g.textures).toHaveLength(0);
    const encoder = g.encoder() as unknown as GPUCommandEncoder; effect.prepare(encoder, camera(), 7, 3, 0, {});
    expect(() => effect.compose(encoder, outputs, camera(), 7, 3, 0, { temporal: true }, {})).toThrow(/temporal:false/);
    expect(g.buffers).toHaveLength(bufferCount); expect(g.raw.queue.writeBuffer).toHaveBeenCalledTimes(writes); expect(effect.progress.pendingFrame).toBe(false);
    const singular = camera(); singular.viewProjection.fill(0); expect(() => effect.prepare(encoder, singular, 7, 3, 0, {})).toThrow(/singular/); effect.dispose();
  });
  it('rejects invalid source/device/material budgets before pipeline or buffer allocation', async () => {
    const variants = [
      (x: ImportedIndirectCreateOptions) => ({ ...x, source: { ...x.source, nodes: new Uint8Array(31) } }),
      (x: ImportedIndirectCreateOptions) => ({ ...x, source: { ...x.source, indices: new Uint32Array([0, 1, 2, 0, 2, 1]) } }),
      (x: ImportedIndirectCreateOptions) => ({ ...x, material: { ...x.material, emissiveStrength: Infinity } }),
      (x: ImportedIndirectCreateOptions) => ({ ...x, material: { ...x.material, emissiveFactor: [1, 0, 0] as const, emissiveStrength: 65505 } }),
      (x: ImportedIndirectCreateOptions) => ({ ...x, options: { maxPixels: 1048577 } }),
    ];
    for (const variant of variants) { const g = gpu(); await expect(ImportedIndirectEffect.create(g.device, variant(options()))).rejects.toMatchObject({ code: 'INVALID_OPTIONS' }); expect(g.buffers).toHaveLength(0); expect(g.raw.createComputePipelineAsync).not.toHaveBeenCalled(); }
    const g = gpu(); g.raw.limits.maxStorageBufferBindingSize = 128;
    await expect(ImportedIndirectEffect.create(g.device, options())).rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT' }); expect(g.buffers).toHaveLength(0);
    const h = gpu(), input = options();
    await expect(ImportedIndirectEffect.create(h.device, { ...input, source: { ...input.source, nodes: new Uint8Array(524288 * 32) } })).rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT' }); expect(h.buffers).toHaveLength(0);
  });
  it('cleans a partial initialization and an aborted pipeline wait without touching borrowed materials', async () => {
    const g = gpu(), create = g.raw.createBuffer.getMockImplementation()!; let count = 0;
    g.raw.createBuffer.mockImplementation(d => { if (++count === 3) throw Error('allocation failure'); return create(d); });
    await expect(ImportedIndirectEffect.create(g.device, options())).rejects.toThrow('allocation failure'); for (const b of g.buffers) expect(b.destroy).toHaveBeenCalledOnce();
    const h = gpu(), abort = new AbortController(); h.raw.createComputePipelineAsync.mockImplementation(async descriptor => { abort.abort(); return descriptor; });
    await expect(ImportedIndirectEffect.create(h.device, { ...options(), signal: abort.signal })).rejects.toMatchObject({ code: 'SCENE_LOAD_ABORTED' }); expect(h.buffers).toHaveLength(0);
  });
  it('reads independent GPU counters without deriving accepted samples from frame count', async () => {
    const g = gpu(), effect = await ImportedIndirectEffect.create(g.device, options()); const frame = encode(effect, g); g.raw.queue.submit([frame.encoder.finish()]); effect.submitted();
    const counters = g.buffers.find(b => b.label === 'Strata imported indirect counters')!; new Uint32Array(counters.data.buffer).set([8, 5, 2, 1]);
    const progress = await effect.readProgress(); expect(progress).toMatchObject({ attempted: 8, completed: 5, exhausted: 2, invalid: 1, submittedFrames: 1, revision: 1 }); expect(progress).not.toHaveProperty('samplesPerPixel');
    expect(g.buffers.at(-1)!.destroy).toHaveBeenCalledOnce(); effect.dispose();
  });
});
