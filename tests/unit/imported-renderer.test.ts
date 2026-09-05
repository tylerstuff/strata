import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportedRenderer } from '../../packages/core/src/imported/imported-renderer.js';
import { ImportedGeometry, importedTextureExtent } from '../../packages/core/src/imported/imported-geometry.js';
import { environmentTextureBytes, environmentUniformBytes } from '../../packages/core/src/imported/imported-environment.js';
import type { ImportedAsset, ImportedMaterial, ImportedTexture } from '../../packages/core/src/imported/imported-types.js';

const material: ImportedMaterial = { name: 'test', baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: .5, emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1, occlusionStrength: 1, alphaMode: 'OPAQUE', alphaCutoff: .5, doubleSided: false };
function asset(): ImportedAsset {
  const vertices = new Float32Array([[-1, 0, 0], [1, 0, 0], [0, 2, 0]].flatMap(p => [...p, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1]));
  return { version: 1, sourceUrl: 'generated:unit', primitives: [{ name: 'triangle', vertices, indices: new Uint32Array([0, 1, 2]), material: 0 }], materials: [material], images: [],
    bounds: { min: [-1, 0, 0], max: [1, 2, 0] }, sourceBounds: { min: [-1, 0, 0], max: [1, 2, 0] }, normalization: { scale: 1, translation: [0, 0, 0] }, maxTextureDimension: 4, warnings: [], clips: [],
    stats: { meshInstances: 1, primitives: 1, vertices: 3, triangles: 1, materials: 1, images: 0, encodedBytes: 0, geometryBytes: vertices.byteLength + 12, skinnedMeshInstances: 0, animationClips: 0 } };
}
function textured(edge = 4): ImportedAsset {
  const a = asset(); const ref: ImportedTexture = { image: 0, sampler: { magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 } };
  return { ...a, maxTextureDimension: edge, materials: [{ ...material, baseColorTexture: ref, metallicRoughnessTexture: ref, emissiveTexture: ref }], images: [{ name: 'shared', mimeType: 'image/png', width: 8, height: 4, bytes: new Uint8Array([1]) }] };
}
function gpu() {
  const buffers: { label: string; size: number; destroy: ReturnType<typeof vi.fn> }[] = [];
  const textures: { descriptor: GPUTextureDescriptor; destroy: ReturnType<typeof vi.fn>; createView: ReturnType<typeof vi.fn> }[] = [];
  const writes: { label: string; data: Float32Array }[] = [];
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), drawIndexed: vi.fn(), draw: vi.fn(), end: vi.fn() };
  const encoder = { beginRenderPass: vi.fn(() => pass), finish: vi.fn(() => ({})) };
  const device = { limits: { maxBufferSize: 512 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024, maxTextureDimension2D: 8192, maxBindGroups: 4, maxStorageBuffersPerShaderStage: 8, maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16 },
    createShaderModule: vi.fn(() => ({})), createRenderPipelineAsync: vi.fn(async (descriptor: GPURenderPipelineDescriptor) => ({ label: descriptor.label, getBindGroupLayout: vi.fn((group: number) => ({ group })) })),
    createBuffer: vi.fn((d: GPUBufferDescriptor) => { const b = { label: d.label ?? '', size: d.size, destroy: vi.fn() }; buffers.push(b); return b; }),
    createTexture: vi.fn((d: GPUTextureDescriptor) => { const t = { descriptor: d, destroy: vi.fn(), createView: vi.fn(() => ({})) }; textures.push(t); return t; }),
    createSampler: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})), createCommandEncoder: vi.fn(() => encoder),
    queue: { writeBuffer: vi.fn((buffer: { label: string }, _offset: number, data: ArrayBuffer | ArrayBufferView<ArrayBuffer>) => { const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength); writes.push({ label: buffer.label, data: new Float32Array(view.slice().buffer) }); }),
      writeTexture: vi.fn(), copyExternalImageToTexture: vi.fn(), submit: vi.fn() },
  };
  return { device: device as unknown as GPUDevice, raw: device, pass, encoder: encoder as unknown as GPUCommandEncoder, buffers, textures, writes };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('imported scene resource and temporal contracts', () => {
  it('accounts full rectangular mip chains after an aspect-preserving edge cap', () => {
    expect(importedTextureExtent(8, 4, 4)).toEqual({ width: 4, height: 2, mipLevels: 3, bytes: 44 });
    expect(importedTextureExtent(1, 9, 4)).toEqual({ width: 1, height: 4, mipLevels: 3, bytes: 28 });
    expect(() => importedTextureExtent(1, 1, 0)).toThrow();
  });
  it('uploads one image separately in sRGB and linear roles, closes decode/resize bitmaps and counts resources exactly', async () => {
    const g = gpu(); const bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[] = [];
    const decode = vi.fn(async (_source: unknown, options: ImageBitmapOptions) => { const b = { width: options.resizeWidth ?? 8, height: options.resizeHeight ?? 4, close: vi.fn() }; bitmaps.push(b); return b; });
    vi.stubGlobal('createImageBitmap', decode);
    const geometry = await ImportedGeometry.create(g.device, textured());
    expect(geometry.telemetry.textures).toHaveLength(2);
    expect(geometry.telemetry.textures.map(t => [t.uploadWidth, t.uploadHeight, t.colorSpace, t.mipLevels])).toEqual([[4, 2, 'srgb', 3], [4, 2, 'linear', 3]]);
    expect(geometry.gpuTextureBytes).toBe(96 + environmentTextureBytes); // Texture role copies, white fallbacks, fixed generated environment.
    expect(g.raw.queue.copyExternalImageToTexture).toHaveBeenCalledTimes(2);
    expect(g.raw.queue.submit).toHaveBeenCalledTimes(2);
    for (const b of bitmaps) expect(b.close).toHaveBeenCalledOnce();
    for (const [, options] of decode.mock.calls) expect(options).toMatchObject({ premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
    expect(geometry.gpuBufferBytes).toBe(g.buffers.reduce((n, b) => n + b.size, 0));
    geometry.dispose(); geometry.dispose();
    for (const r of [...g.buffers, ...g.textures]) expect(r.destroy).toHaveBeenCalledOnce();
    expect(geometry.gpuBufferBytes).toBe(0); expect(geometry.gpuTextureBytes).toBe(0);
  });
  it('preflights aggregate color-role texture memory before decoding or allocating', async () => {
    const g = gpu(), a = textured(8192); const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
    await expect(ImportedGeometry.create(g.device, { ...a, images: [{ ...a.images[0]!, width: 8192, height: 8192 }] })).rejects.toMatchObject({ code: 'UNSUPPORTED_LIMIT' });
    expect(decode).not.toHaveBeenCalled(); expect(g.raw.createTexture).not.toHaveBeenCalled(); expect(g.raw.createBuffer).not.toHaveBeenCalled();
  });
  it('snapshots environment and shading, replaces whole lighting, resets history and keeps bounded resources across toggles', async () => {
    const g = gpu(), geometry = await ImportedGeometry.create(g.device, asset());
    const bytes = geometry.gpuTextureBytes, resources = g.textures.length;
    expect(geometry.telemetry.shading).toBe('authored'); expect(geometry.telemetry.environment).toBeNull();
    const environment = { preset: 'studio' as const, intensity: 1, rotationRadians: Math.PI / 2 };
    const lighting = { directionToLight: [0, 1, 0] as const, color: [1, 1, 1] as const, intensity: 2, ambient: [0, 0, 0] as const, environment };
    expect(geometry.update({ shading: 'relit', lighting })).toBe(true);
    environment.intensity = 4;
    expect(geometry.telemetry.environment?.intensity).toBe(1);
    expect(geometry.prepare(true, false)).toBe(48 + environmentUniformBytes);
    expect(g.writes.filter(w => w.label === 'Strata imported environment and shading').at(-1)!.data[4]).toBe(1);
    const returned = geometry.telemetry.environment! as { intensity: number }; returned.intensity = 8;
    expect(geometry.telemetry.environment?.intensity).toBe(1);
    expect(geometry.update()).toBe(false);
    expect(geometry.update({ lighting: { ...lighting, environment: null } })).toBe(true);
    expect(geometry.telemetry.environment).toBeNull();
    geometry.update({ lighting });
    const { environment: _environment, ...replacement } = lighting;
    geometry.update({ lighting: replacement });
    expect(geometry.telemetry.environment).toBeNull();
    expect(geometry.telemetry.shading).toBe('relit');
    expect(geometry.update({ shading: 'authored' })).toBe(true);
    expect(geometry.gpuTextureBytes).toBe(bytes); expect(g.textures).toHaveLength(resources);
    geometry.dispose(); for (const resource of [...g.buffers, ...g.textures]) expect(resource.destroy).toHaveBeenCalledOnce();
  });
  it('rejects invalid environment/shading atomically before publishing a new light or camera', async () => {
    const g = gpu(), geometry = await ImportedGeometry.create(g.device, asset());
    const before = structuredClone(geometry.telemetry);
    const light = { directionToLight: [0, 1, 0] as const, color: [1, 1, 1] as const, intensity: 2, ambient: [0, 0, 0] as const };
    for (const environment of [[], { preset: 'invalid', intensity: 1 }, { preset: 'sky', intensity: NaN }, { preset: 'sky', intensity: -1 }, { preset: 'sky', intensity: 65 }, { preset: 'sky', intensity: 1, rotationRadians: Infinity }, { preset: 'sky', intensity: 1, rotationRadians: null }]) {
      expect(() => geometry.update({ lighting: { ...light, environment } } as never)).toThrow();
      expect(geometry.telemetry).toEqual(before);
    }
    expect(() => geometry.update({ shading: 'unknown' } as never)).toThrow();
    expect(geometry.telemetry).toEqual(before); geometry.dispose();
  });
  it('destroys all partial environment resources on an upload failure', async () => {
    const g = gpu();
    g.raw.queue.writeTexture.mockImplementation((destination: unknown) => {
      if ((destination as { texture: { descriptor: { label?: string } } }).texture.descriptor.label?.includes('GGX')) throw new Error('environment upload failure');
    });
    await expect(ImportedGeometry.create(g.device, asset())).rejects.toThrow('environment upload failure');
    for (const resource of [...g.buffers, ...g.textures]) expect(resource.destroy).toHaveBeenCalledOnce();
  });
  it.each([
    ['missing doubleSided', { doubleSided: undefined }], ['nonboolean doubleSided', { doubleSided: 1 }], ['nonboolean unlit', { unlit: 'true' }],
    ['missing base component', { baseColorFactor: [1, 1, 1] }],
    ['compensating vector lengths', { baseColorFactor: [1, 1, 1], emissiveFactor: [0, 0, 0, 0] }],
    ['sparse base factor', { baseColorFactor: [1, , 1, 1] }], ['base factor range', { baseColorFactor: [1, 2, 1, 1] }],
    ['emissive factor range', { emissiveFactor: [0, -1, 0] }], ['metallic factor range', { metallicFactor: 2 }],
    ['roughness factor range', { roughnessFactor: -.1 }], ['emissive strength range', { emissiveStrength: 1e7 }],
    ['normal scale finite', { normalScale: NaN }], ['normal scale float32 overflow', { normalScale: 1e100 }],
    ['occlusion strength range', { occlusionStrength: 1.1 }], ['alpha cutoff range', { alphaCutoff: -.1 }],
    ['unsupported alpha mode', { alphaMode: 'BLEND' }], ['material name', { name: null }],
    ['null texture reference', { normalTexture: null }], ['absent image', { normalTexture: { image: 100, sampler: {} } }],
    ['missing sampler', { normalTexture: { image: 0 } }],
    ['invalid texture wrapping', { normalTexture: { image: 0, sampler: { magFilter: 9729, minFilter: 9987, wrapS: 0, wrapT: 10497 } } }],
  ])('rejects %s before any material allocation or image decoding', async (_name, invalid) => {
    const g = gpu(), a = textured(); const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
    await expect(ImportedGeometry.create(g.device, { ...a, materials: [{ ...a.materials[0]!, ...invalid } as ImportedMaterial] })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(decode).not.toHaveBeenCalled(); expect(g.raw.createTexture).not.toHaveBeenCalled(); expect(g.raw.createBuffer).not.toHaveBeenCalled();
    expect(g.raw.createRenderPipelineAsync).not.toHaveBeenCalled();
  });
  it('closes an asynchronously decoded bitmap and destroys prior resources when creation is cancelled', async () => {
    const g = gpu(), controller = new AbortController(); const bitmap = { width: 8, height: 4, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { controller.abort(); return bitmap; }));
    await expect(ImportedGeometry.create(g.device, textured(), controller.signal)).rejects.toMatchObject({ code: 'SCENE_LOAD_ABORTED' });
    expect(bitmap.close).toHaveBeenCalledOnce(); expect(g.raw.queue.copyExternalImageToTexture).not.toHaveBeenCalled();
    for (const t of g.textures) expect(t.destroy).toHaveBeenCalledOnce();
  });
  it('uses shared MRT/TAA, keeps ordinary camera motion, resets controls, and owns hidden ground explicitly', async () => {
    const g = gpu(); const renderer = await ImportedRenderer.create(g.device, 'rgba8unorm', { renderer: 'imported', asset: asset() });
    const temporalValidity = () => g.writes.filter(w => w.label === 'Strata temporal options').map(w => new Uint32Array(w.data.buffer)[2]);
    const first = renderer.encode(g.encoder, {} as GPUTextureView, 128, 128, 0); renderer.submitted(1);
    expect(first.triangles).toBe(4); expect(first.drawCalls).toBe(4); // triangle in two passes + temporal + presentation.
    renderer.encode(g.encoder, {} as GPUTextureView, 128, 128, .016, { imported: { camera: { eye: [3.1, 2, 3], target: [0, 1, 0], verticalFov: Math.PI / 4 } } }); renderer.submitted(2);
    const frame = g.writes.filter(w => w.label === 'Strata current and previous transforms').at(-1)!.data;
    expect([...frame.subarray(0, 16)]).not.toEqual([...frame.subarray(16, 32)]);
    const ground = renderer.encode(g.encoder, {} as GPUTextureView, 128, 128, .032, { imported: { presentation: 'ground' } }); renderer.submitted(3);
    expect(ground.triangles).toBe(8); expect(ground.drawCalls).toBe(6);
    // Scalar temporal validity is Uint32 in an otherwise float-labelled mock write.
    expect(temporalValidity()).toEqual([0, 1, 0]);
    renderer.dispose(); renderer.dispose(); for (const r of [...g.buffers, ...g.textures]) expect(r.destroy).toHaveBeenCalledOnce();
    expect(renderer.gpuBufferBytes).toBe(0); expect(renderer.gpuTextureBytes).toBe(0);
  });
  it('updates the shadow transform coherently for a vertical light and contains all posed bounds', async () => {
    const g = gpu(); const geometry = await ImportedGeometry.create(g.device, asset()); const before = geometry.lightMatrix.slice();
    expect(geometry.update({ lighting: { directionToLight: [0, 1, 0], color: [1, 1, 1], intensity: 2, ambient: [0, 0, 0] } })).toBe(true);
    expect([...geometry.lightMatrix]).not.toEqual([...before]);
    for (const x of [-1, 1]) for (const y of [0, 2]) {
      const p = [x, y, 0, 1], m = geometry.lightMatrix;
      const clip = [0, 1, 2, 3].map(row => p.reduce((sum, v, column) => sum + v * m[column * 4 + row]!, 0));
      expect(Math.abs(clip[0]! / clip[3]!)).toBeLessThan(1); expect(Math.abs(clip[1]! / clip[3]!)).toBeLessThan(1);
      expect(clip[2]! / clip[3]!).toBeGreaterThan(0); expect(clip[2]! / clip[3]!).toBeLessThan(1);
    }
    geometry.dispose();
  });
  it('keeps normalized arbitrary light directions stable and rejects explicit null controls', async () => {
    const g = gpu(); const geometry = await ImportedGeometry.create(g.device, asset());
    geometry.update({ lighting: { directionToLight: [1, 1, 1], color: [1, 1, 1], intensity: 2, ambient: [0, 0, 0] } });
    const matrix = geometry.lightMatrix.slice();
    for (let i = 0; i < 100; i++) expect(geometry.update()).toBe(false);
    expect([...geometry.lightMatrix]).toEqual([...matrix]);
    for (const controls of [{ camera: null }, { lighting: null }, { background: null }, { presentation: null }, { animation: null }]) expect(() => geometry.update(controls as never)).toThrow();
    geometry.dispose();
  });
  it('commits only submitted palettes, fits current animated bounds, and resets cancelled-frame history', async () => {
    const g = gpu(); const a = asset(); const animated: ImportedAsset = { ...a, primitives: [{ ...a.primitives[0]!, deformation: { node: 0, vertices: a.primitives[0]!.vertices } }],
      rig: { nodes: [{ parent: null, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }], skins: [] },
      clips: [{ id: 'move', name: 'move', duration: 1, channels: [{ node: 0, path: 'translation', interpolation: 'LINEAR', times: new Float32Array([0, 1]), values: new Float32Array([0, 0, 0, 0, 0, 20]) }] }] };
    const r = await ImportedRenderer.create(g.device, 'rgba8unorm', { renderer: 'imported', asset: animated });
    const controls = (timeSeconds: number) => ({ temporal: false, imported: { animation: { clipId: 'move', timeSeconds, loop: false } } });
    r.encode(g.encoder, {} as GPUTextureView, 128, 128, 0, controls(0)); r.submitted(1);
    r.encode(g.encoder, {} as GPUTextureView, 128, 128, .016, controls(.5)); r.cancelFrame();
    r.encode(g.encoder, {} as GPUTextureView, 128, 128, .016, controls(1));
    const current = g.writes.filter(w => w.label === 'Strata imported current palette 0').at(-1)!.data;
    const previous = g.writes.filter(w => w.label === 'Strata imported previous palette 0').at(-1)!.data;
    expect(current[14]).toBe(20); expect([...previous]).toEqual([...current]);
    expect(r.importedTelemetry.bounds.min[2]).toBe(20); expect(r.importedTelemetry.bounds.max[2]).toBe(20);
    expect(r.currentCamera!.far).toBeGreaterThan(20);
    r.submitted(2); r.dispose();
  });
  it('rejects an out-of-range pose atomically and cancels history without publishing its controls or telemetry', async () => {
    const g = gpu(), a = asset(); const animated: ImportedAsset = { ...a, primitives: [{ ...a.primitives[0]!, deformation: { node: 0, vertices: a.primitives[0]!.vertices } }],
      rig: { nodes: [{ parent: null, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }], skins: [] },
      clips: [{ id: 'move', name: 'move', duration: 2, channels: [{ node: 0, path: 'translation', interpolation: 'LINEAR', times: new Float32Array([0, 1, 2]), values: new Float32Array([0, 0, 0, 0, 0, 20, 0, 0, 9000]) }] }] };
    const r = await ImportedRenderer.create(g.device, 'rgba8unorm', { renderer: 'imported', asset: animated });
    r.encode(g.encoder, {} as GPUTextureView, 128, 128, 0, { temporal: false, imported: { animation: { clipId: 'move', timeSeconds: .5, loop: false } } }); r.submitted(1);
    const before = structuredClone(r.importedTelemetry), camera = structuredClone(r.currentCamera);
    const writes = g.writes.length, cancel = vi.spyOn(ImportedGeometry.prototype, 'cancelFrame');
    expect(() => r.encode(g.encoder, {} as GPUTextureView, 128, 128, .016, { temporal: false, imported: {
      animation: { clipId: 'move', timeSeconds: 2, loop: false }, presentation: 'ground', background: [1, 0, 0],
      camera: { eye: [4, 2, 3], target: [0, 1, 0], verticalFov: Math.PI / 3 },
      lighting: { directionToLight: [0, 1, 0], color: [1, 1, 1], intensity: 1, ambient: [0, 0, 0] },
    } })).toThrow(/8192/);
    expect(cancel).toHaveBeenCalledOnce(); expect(g.writes).toHaveLength(writes);
    expect(r.importedTelemetry).toEqual(before); expect(r.currentCamera).toEqual(camera);
    // Omitting controls retries the last accepted pose/settings, not the rejected candidate.
    const retried = r.encode(g.encoder, {} as GPUTextureView, 128, 128, .016, { temporal: false });
    expect(retried.triangles).toBe(3); // Two mesh passes plus presentation; no rejected ground.
    expect(r.importedTelemetry).toEqual(before); expect(r.currentCamera).toEqual(camera);
    const current = g.writes.filter(w => w.label === 'Strata imported current palette 0').at(-1)!.data;
    const previous = g.writes.filter(w => w.label === 'Strata imported previous palette 0').at(-1)!.data;
    expect(current[14]).toBe(10); expect([...previous]).toEqual([...current]);
    expect(g.writes.slice(writes).some(w => w.label === 'Strata imported directional light and explicit fill')).toBe(false);
    r.submitted(2); r.dispose();
  });
});
