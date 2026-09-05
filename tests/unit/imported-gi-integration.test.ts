import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrataError } from '../../packages/core/src/errors.js';
import { ImportedRenderer } from '../../packages/core/src/imported/imported-renderer.js';
import type { ImportedGeometry } from '../../packages/core/src/imported/imported-geometry.js';
import type { ImportedIndirectEffect } from '../../packages/core/src/imported/imported-indirect-effect.js';
import type { ImportedIndirectMaterial, ImportedIndirectOptions, ImportedIndirectProgress, ImportedIndirectReadback } from '../../packages/core/src/imported/imported-indirect-types.js';
import type { ImportedAsset, ImportedControls, ImportedSceneOptions, ImportedTelemetry } from '../../packages/core/src/imported/imported-types.js';
import type { PreparedImportedStaticTrace } from '../../packages/core/src/imported/static-trace-data.js';
import type { CpuRuntime } from '../../packages/core/src/internal/cpu-runtime.js';
import type { StaticBvhResult } from '../../packages/core/src/internal/protocol.js';
import type { RasterRenderer } from '../../packages/core/src/rendering/raster-renderer.js';
import type { RasterControls, RasterPassName } from '../../packages/core/src/rendering/raster-types.js';

// These tests execute CPU orchestration only. Geometry, worker jobs and GPU effects
// are boundaries, so passing them is not shader, image-quality or GPU evidence.
const boundary = vi.hoisted(() => ({
  prepare: vi.fn<typeof import('../../packages/core/src/imported/static-trace-data.js')['prepareImportedStaticTrace']>(),
  validate: vi.fn<typeof import('../../packages/core/src/imported/static-trace-data.js')['validateImportedStaticBvh']>(),
  geometry: vi.fn<typeof import('../../packages/core/src/imported/imported-geometry.js')['ImportedGeometry']['create']>(),
  effect: vi.fn<typeof import('../../packages/core/src/imported/imported-indirect-effect.js')['ImportedIndirectEffect']['create']>(),
  raster: vi.fn<typeof import('../../packages/core/src/rendering/raster-renderer.js')['RasterRenderer']['create']>(),
}));
vi.mock('../../packages/core/src/imported/static-trace-data.js', () => ({ prepareImportedStaticTrace: boundary.prepare, validateImportedStaticBvh: boundary.validate }));
vi.mock('../../packages/core/src/imported/imported-geometry.js', () => ({ ImportedGeometry: { create: boundary.geometry } }));
vi.mock('../../packages/core/src/imported/imported-indirect-effect.js', () => ({ ImportedIndirectEffect: { create: boundary.effect } }));
vi.mock('../../packages/core/src/rendering/raster-renderer.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../packages/core/src/rendering/raster-renderer.js')>(), RasterRenderer: { create: boundary.raster },
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const vertices = new Float32Array(48), indices = new Uint32Array([0, 1, 2]);
  const asset: ImportedAsset = {
    version: 1, sourceUrl: 'generated:orchestration', primitives: [{ name: 'triangle', vertices, indices, material: 0 }],
    materials: [{ name: 'matte', baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1, emissiveFactor: [0, 0, 0],
      emissiveStrength: 1, normalScale: 1, occlusionStrength: 1, alphaMode: 'OPAQUE', alphaCutoff: .5, doubleSided: false }],
    images: [], clips: [], warnings: [], bounds: { min: [0, 0, 0], max: [1, 1, 0] }, sourceBounds: { min: [0, 0, 0], max: [1, 1, 0] },
    normalization: { scale: 1, translation: [0, 0, 0] }, maxTextureDimension: 4,
    stats: { meshInstances: 1, primitives: 1, vertices: 3, triangles: 1, materials: 1, images: 0, encodedBytes: 0, geometryBytes: 204, skinnedMeshInstances: 0, animationClips: 0 },
  };
  const prepared = { positions: new Float32Array(9), vertices, indices, sourceMaterialIndex: 0,
    maxWorkingBytes: 4096, estimatedPeakCpuBytes: 65536, traceGpuBytes: 300 } as PreparedImportedStaticTrace;
  const result: StaticBvhResult = { nodes: new ArrayBuffer(32), triangles: new ArrayBuffer(64), vertexCount: 3, triangleCount: 1,
    nodeCount: 1, maxDepth: 0, workUnits: 1, workingBytes: 4096, wasmMemoryBytes: 131072 };
  const events: string[] = [];
  let memoryBytes = 65536;
  const readInfo = vi.fn(() => { events.push('memory'); return { abiVersion: 2, memoryBytes }; });
  const cpu = { get info() { return readInfo(); }, waitForStaticBvhIdle: vi.fn(async () => { events.push('idle'); }),
    buildStaticBvh: vi.fn<CpuRuntime['buildStaticBvh']>(async () => { events.push('build'); return result; }), dispose: vi.fn() };
  const rawDevice = { limits: { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024,
    maxStorageBufferBindingSize: 128 * 1024 * 1024, maxComputeWorkgroupsPerDimension: 65535, maxStorageBuffersPerShaderStage: 8 },
    createBuffer: vi.fn(), createTexture: vi.fn(), createRenderPipelineAsync: vi.fn(), createComputePipelineAsync: vi.fn() };
  const device = rawDevice as unknown as GPUDevice;
  const material = {} as ImportedIndirectMaterial;
  const lighting: NonNullable<ImportedControls['lighting']> = { directionToLight: [0, 1, 0], color: [1, 1, 1], intensity: 2,
    ambient: [.3, .2, .1], environment: { preset: 'sky', intensity: 1, rotationRadians: .4 } };
  const geometry = { lighting, telemetry: { sourceUrl: asset.sourceUrl } as ImportedTelemetry,
    borrowIndirectMaterial: vi.fn((_index: number) => { events.push('borrow'); return material; }),
    useIndirectBaseline: vi.fn(() => { events.push('baseline'); }), update: vi.fn((_controls?: ImportedControls) => false),
    submitted: vi.fn(), cancelFrame: vi.fn(), dispose: vi.fn() };
  let progress: ImportedIndirectProgress = { revision: 1, submittedFrames: 1, batchCursor: 8, width: 8, height: 8,
    pendingReset: false, pendingFrame: false, enabled: true, spatialDenoise: false, denoise: 'off', presentationRevision: 0, submittedFrameId: 1, normalMode: 'geometric', textureLod: 0,
    limits: { maxPixels: 64, pixelBatch: 8, maxSamples: 16, maxVisits: 100, seed: 7 } };
  const counters = (overrides: Partial<ImportedIndirectReadback> = {}): ImportedIndirectReadback => ({ ...progress,
    attempted: 8, completed: 5, exhausted: 2, invalid: 1, ...overrides });
  const effect = { get progress() { return progress; }, validateSize: vi.fn((_width: number, _height: number) => undefined),
    readProgress: vi.fn(async () => counters()), updateLighting: vi.fn(),
    validateDenoise: vi.fn((mode: unknown) => {
      if (mode !== 'off' && mode !== 'spatial') throw new StrataError('INVALID_OPTIONS', 'Invalid denoise mode');
      if (mode === 'spatial' && !progress.spatialDenoise) throw new StrataError('UNSUPPORTED_FEATURE', 'Missing spatial capability');
    }),
    setDenoise: vi.fn((denoise: 'off' | 'spatial') => { if (denoise !== progress.denoise) progress = { ...progress, denoise, presentationRevision: progress.presentationRevision + 1 }; }),
    setEnabled: vi.fn((enabled: boolean) => { progress = { ...progress, enabled }; }), submitted: vi.fn(), cancelFrame: vi.fn(), dispose: vi.fn() };
  const stats = { drawCalls: 2, dispatchCalls: 1, triangles: 2, uploadBytes: 288, gpuBufferBytes: 4096, gpuTextureBytes: 1024 };
  const raster = { initialUploadBytes: 300, gpuBufferBytes: 4096, gpuTextureBytes: 1024,
    passNames: vi.fn((_controls: RasterControls): readonly RasterPassName[] => ['shadow', 'raster', 'presentation']),
    encode: vi.fn<RasterRenderer['encode']>(() => stats),
    // Once created, the raster owns the geometry and the borrowed-resource effect.
    dispose: vi.fn(() => { effect.dispose(); geometry.dispose(); }) };
  boundary.prepare.mockImplementation(async () => { events.push('prepare'); return prepared; });
  boundary.validate.mockImplementation(async () => { events.push('validated'); });
  boundary.geometry.mockImplementation(async () => { events.push('geometry'); return geometry as unknown as ImportedGeometry; });
  boundary.effect.mockImplementation(async () => { events.push('effect'); return effect as unknown as ImportedIndirectEffect; });
  boundary.raster.mockImplementation(async () => { events.push('raster'); return raster as unknown as RasterRenderer; });
  const context = { cpu, width: 8, height: 8, additionalResidentCpuBytes: 1234 };
  const create = (overrides: Partial<ImportedSceneOptions> = {}) => ImportedRenderer.create(device, 'rgba8unorm',
    { renderer: 'imported', asset, indirect: { maxPixels: 64 }, ...overrides }, context);
  return { asset, prepared, result, events, cpu, readInfo, rawDevice, device, material, geometry, effect, raster, context, create, counters,
    setMemory: (bytes: number) => { memoryBytes = bytes; }, setProgress: (patch: Partial<ImportedIndirectProgress>) => { progress = { ...progress, ...patch }; } };
}

beforeEach(() => { for (const mock of Object.values(boundary)) mock.mockReset(); });

describe('imported progressive GI CPU orchestration', () => {
  it.each([
    { name: 'invalid options', indirect: { maxSamples: 0 }, width: 8, height: 8, code: 'INVALID_OPTIONS' },
    { name: 'null options', indirect: null as unknown as ImportedIndirectOptions, width: 8, height: 8, code: 'INVALID_OPTIONS' },
    { name: 'pixel budget', indirect: { maxPixels: 63 }, width: 8, height: 8, code: 'UNSUPPORTED_LIMIT' },
    { name: 'invalid dimensions', indirect: { maxPixels: 64 }, width: 0, height: 8, code: 'INVALID_SIZE' },
  ])('rejects $name before CPU preparation or GPU resource creation', async ({ indirect, width, height, code }) => {
    const h = harness(); h.context.width = width; h.context.height = height;
    await expect(h.create({ indirect })).rejects.toMatchObject({ code });
    expect(h.cpu.waitForStaticBvhIdle).not.toHaveBeenCalled(); expect(h.readInfo).not.toHaveBeenCalled();
    for (const mock of Object.values(boundary)) expect(mock).not.toHaveBeenCalled();
    expect(h.cpu.buildStaticBvh).not.toHaveBeenCalled();
    for (const create of [h.rawDevice.createBuffer, h.rawDevice.createTexture, h.rawDevice.createRenderPipelineAsync, h.rawDevice.createComputePipelineAsync]) expect(create).not.toHaveBeenCalled();
  });

  it('waits for worker acknowledgement before measuring retained memory and preparing the next source', async () => {
    const h = harness(), idle = deferred<void>(), entered = deferred<void>();
    h.cpu.waitForStaticBvhIdle.mockImplementation(() => { entered.resolve(); return idle.promise; });
    const pending = h.create(); await entered.promise;
    expect(h.readInfo).not.toHaveBeenCalled(); expect(boundary.prepare).not.toHaveBeenCalled();
    h.setMemory(262144); idle.resolve(); const renderer = await pending;
    expect(boundary.prepare).toHaveBeenCalledWith(h.asset, h.device.limits, { retainedWasmBytes: 262144, additionalResidentCpuBytes: 1234 });
    expect(h.cpu.buildStaticBvh).toHaveBeenCalledWith({ positions: h.prepared.positions, indices: h.prepared.indices }, { maxWorkingBytes: 4096 });
    expect(boundary.validate).toHaveBeenCalledWith(h.prepared, h.result, undefined);
    expect(h.events).toEqual(['memory', 'prepare', 'build', 'validated', 'geometry', 'borrow', 'effect', 'baseline', 'raster']);
    renderer.dispose();
  });

  it('awaits full source validation before creating geometry or borrowing resources for the effect', async () => {
    const h = harness(), validation = deferred<void>(), entered = deferred<void>();
    boundary.validate.mockImplementation(() => { entered.resolve(); return validation.promise; });
    const pending = h.create(); await entered.promise;
    expect(boundary.geometry).not.toHaveBeenCalled(); expect(h.geometry.borrowIndirectMaterial).not.toHaveBeenCalled();
    expect(boundary.effect).not.toHaveBeenCalled(); expect(boundary.raster).not.toHaveBeenCalled();
    validation.resolve(); const renderer = await pending;
    expect(boundary.effect).toHaveBeenCalledWith(h.device, expect.objectContaining({
      source: { nodes: new Uint8Array(h.result.nodes), triangles: new Uint8Array(h.result.triangles), vertices: h.prepared.vertices, indices: h.prepared.indices },
      material: h.material, lighting: h.geometry.lighting, environment: { mode: 'sky', intensity: 1, rotationRadians: .4 },
    }));
    expect(h.geometry.borrowIndirectMaterial).toHaveBeenCalledWith(0); renderer.dispose();
  });

  it.each(['build', 'validate'] as const)('does not allocate geometry or effects when %s fails', async stage => {
    const h = harness(), failure = new Error(`${stage} failure`);
    if (stage === 'build') h.cpu.buildStaticBvh.mockRejectedValue(failure); else boundary.validate.mockRejectedValue(failure);
    await expect(h.create()).rejects.toBe(failure);
    expect(boundary.geometry).not.toHaveBeenCalled(); expect(boundary.effect).not.toHaveBeenCalled(); expect(boundary.raster).not.toHaveBeenCalled();
    expect(h.cpu.dispose).not.toHaveBeenCalled();
  });

  it('cancels an idle wait before memory observation, and propagates the signal to preparation and validation', async () => {
    const h = harness(), abort = new AbortController(), idle = deferred<void>(), entered = deferred<void>();
    h.cpu.waitForStaticBvhIdle.mockImplementation(() => { entered.resolve(); return idle.promise; });
    const pending = h.create({ signal: abort.signal }); await entered.promise; abort.abort(); idle.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'SCENE_LOAD_ABORTED' });
    expect(h.readInfo).not.toHaveBeenCalled(); expect(boundary.prepare).not.toHaveBeenCalled(); expect(boundary.geometry).not.toHaveBeenCalled();
    h.cpu.waitForStaticBvhIdle.mockResolvedValue(); const active = new AbortController();
    const renderer = await h.create({ signal: active.signal });
    expect(boundary.prepare).toHaveBeenCalledWith(h.asset, h.device.limits, expect.objectContaining({ signal: active.signal }));
    expect(h.cpu.buildStaticBvh).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ signal: active.signal }));
    expect(boundary.validate).toHaveBeenCalledWith(h.prepared, h.result, active.signal); renderer.dispose();
  });

  it.each(['effect', 'raster'] as const)('releases already-owned resources when %s creation fails', async stage => {
    const h = harness(), failure = new Error(`${stage} failure`);
    boundary[stage].mockRejectedValue(failure);
    await expect(h.create()).rejects.toBe(failure);
    expect(h.geometry.dispose).toHaveBeenCalledOnce(); expect(h.effect.dispose).toHaveBeenCalledTimes(stage === 'raster' ? 1 : 0);
    expect(h.raster.dispose).not.toHaveBeenCalled(); expect(h.cpu.dispose).not.toHaveBeenCalled();
  });

  it.each(['geometry', 'raster'] as const)('releases ownership after cancellation during %s creation', async stage => {
    const h = harness(), abort = new AbortController();
    if (stage === 'geometry') boundary.geometry.mockImplementation(async () => { abort.abort(); return h.geometry as unknown as ImportedGeometry; });
    else boundary.raster.mockImplementation(async () => { abort.abort(); return h.raster as unknown as RasterRenderer; });
    await expect(h.create({ signal: abort.signal })).rejects.toMatchObject({ code: 'SCENE_LOAD_ABORTED' });
    expect(h.geometry.dispose).toHaveBeenCalledOnce(); expect(h.effect.dispose).toHaveBeenCalledTimes(stage === 'raster' ? 1 : 0);
    expect(h.raster.dispose).toHaveBeenCalledTimes(stage === 'raster' ? 1 : 0); expect(h.cpu.dispose).not.toHaveBeenCalled();
  });

  it('keeps one direct baseline and disables temporal rendering in both GI comparison states', async () => {
    const h = harness(), renderer = await h.create();
    for (const enabled of [false, true]) {
      const controls = { temporal: true, imported: { indirect: { enabled } } };
      renderer.passNames(controls); renderer.encode({} as GPUCommandEncoder, {} as GPUTextureView, 8, 8, 0, controls);
      expect(h.raster.passNames).toHaveBeenLastCalledWith({ ...controls, temporal: false });
      expect(h.raster.encode).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 8, 8, 0,
        { ...controls, temporal: false, cameraCut: true }, {});
      expect(h.effect.setEnabled).toHaveBeenLastCalledWith(enabled);
      expect(renderer.importedTelemetry.indirect).toMatchObject({ temporal: false, rasterAmbient: 'disabled', rasterEnvironment: 'disabled' });
    }
    expect(h.geometry.useIndirectBaseline).toHaveBeenCalledOnce(); expect(boundary.geometry).toHaveBeenCalledOnce();
    expect(boundary.effect).toHaveBeenCalledOnce(); expect(boundary.raster).toHaveBeenCalledWith(h.device, 'rgba8unorm', {}, h.geometry, h.effect);
    renderer.dispose(); renderer.dispose(); expect(h.raster.dispose).toHaveBeenCalledOnce();
  });

  it('forwards submit/cancel and retries a cancelled frame with reset history', async () => {
    const h = harness(), renderer = await h.create();
    renderer.submitted(8); expect(h.effect.submitted).toHaveBeenCalledOnce(); expect(h.geometry.submitted).toHaveBeenCalledOnce();
    renderer.encode({} as GPUCommandEncoder, {} as GPUTextureView, 8, 8, 0);
    expect(h.raster.encode.mock.calls.at(-1)![5]).toMatchObject({ cameraCut: false, temporal: false });
    renderer.cancelFrame(); expect(h.effect.cancelFrame).toHaveBeenCalledOnce(); expect(h.geometry.cancelFrame).toHaveBeenCalledOnce();
    renderer.encode({} as GPUCommandEncoder, {} as GPUTextureView, 8, 8, 0);
    expect(h.raster.encode.mock.calls.at(-1)![5]).toMatchObject({ cameraCut: true, temporal: false });
    h.raster.encode.mockImplementationOnce(() => { throw Error('encode failure'); });
    expect(() => renderer.encode({} as GPUCommandEncoder, {} as GPUTextureView, 8, 8, 0)).toThrow('encode failure');
    expect(h.effect.cancelFrame).toHaveBeenCalledTimes(2); expect(h.geometry.cancelFrame).toHaveBeenCalledTimes(2); renderer.dispose();
  });

  it('shares one pending readback and suppresses stale accumulation revisions', async () => {
    const h = harness(), renderer = await h.create(), first = deferred<ImportedIndirectReadback>();
    h.effect.readProgress.mockReturnValueOnce(first.promise);
    const a = renderer.readIndirectProgress(), b = renderer.readIndirectProgress();
    expect(h.effect.readProgress).toHaveBeenCalledOnce();
    h.setProgress({ revision: 2 }); first.resolve(h.counters({ revision: 1 })); await Promise.all([a, b]);
    expect(renderer.importedTelemetry.indirect!.sampleCounters).toMatchObject({ revision: 2, attempted: 8, completed: 5 });
    expect(h.effect.readProgress).toHaveBeenCalledTimes(2);
    await renderer.readIndirectProgress(); expect(h.effect.readProgress).toHaveBeenCalledTimes(2);
    h.setProgress({ pendingReset: true }); expect(renderer.importedTelemetry.indirect!.sampleCounters).toBeNull();
    await renderer.readIndirectProgress(); expect(h.effect.readProgress).toHaveBeenCalledTimes(2); renderer.dispose();
  });

  it('clears a failed readback slot for retry and does not publish a readback after disposal', async () => {
    const h = harness(), renderer = await h.create(), failure = new Error('readback failure');
    h.effect.readProgress.mockRejectedValueOnce(failure);
    await expect(renderer.readIndirectProgress()).rejects.toBe(failure);
    const late = deferred<ImportedIndirectReadback>(); h.effect.readProgress.mockReturnValueOnce(late.promise);
    const pending = renderer.readIndirectProgress(); expect(h.effect.readProgress).toHaveBeenCalledTimes(2);
    renderer.dispose(); late.resolve(h.counters()); await pending;
    expect(renderer.importedTelemetry.indirect!.sampleCounters).toBeNull();
  });

  it('ignores a pending readback rejection only after the renderer has been retired', async () => {
    const h = harness(), renderer = await h.create(), readback = deferred<ImportedIndirectReadback>();
    h.effect.readProgress.mockReturnValueOnce(readback.promise);
    const first = renderer.readIndirectProgress(), second = renderer.readIndirectProgress();
    expect(h.effect.readProgress).toHaveBeenCalledOnce(); renderer.dispose();
    readback.reject(new Error('effect disposed during readback'));
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(renderer.importedTelemetry.indirect!.sampleCounters).toBeNull();
  });


  it.each([
    { name: 'malformed spatial flag', indirect: { spatialDenoise: null }, width: 8, height: 8, bindings: 8, code: 'INVALID_OPTIONS' },
    { name: 'insufficient bindings', indirect: { spatialDenoise: true }, width: 8, height: 8, bindings: 6, code: 'UNSUPPORTED_LIMIT' },
    { name: 'lifetime viewport cap', indirect: { spatialDenoise: true, maxPixels: 1048576 }, width: 257, height: 256, bindings: 8, code: 'UNSUPPORTED_LIMIT' },
  ])('rejects $name before waiting for or preparing the CPU source', async ({ indirect, width, height, bindings, code }) => {
    const h = harness(); h.context.width = width; h.context.height = height; h.rawDevice.limits.maxStorageBuffersPerShaderStage = bindings;
    await expect(h.create({ indirect: indirect as ImportedIndirectOptions })).rejects.toMatchObject({ code });
    expect(h.cpu.waitForStaticBvhIdle).not.toHaveBeenCalled(); expect(h.cpu.buildStaticBvh).not.toHaveBeenCalled();
    for (const mock of Object.values(boundary)) expect(mock).not.toHaveBeenCalled();
  });

  it('passes the explicit capability outside numeric limits and preserves requested mode across omissions', async () => {
    const h = harness(); h.setProgress({ spatialDenoise: true });
    const renderer = await h.create({ indirect: { maxPixels: 64, spatialDenoise: true } });
    expect(boundary.effect).toHaveBeenCalledWith(h.device, expect.objectContaining({ options: { maxPixels: 64, pixelBatch: 4096, maxSamples: 64, maxVisits: 4096, seed: 1337, spatialDenoise: true } }));
    const before = renderer.importedTelemetry.indirect!.progress;
    renderer.passNames({ imported: { indirect: { enabled: true, denoise: 'spatial' } } });
    renderer.passNames({ imported: { indirect: { enabled: true } } }); renderer.passNames({});
    expect(h.effect.setDenoise).toHaveBeenCalledOnce(); expect(h.effect.setDenoise).toHaveBeenCalledWith('spatial');
    expect(renderer.importedTelemetry.indirect!.progress).toMatchObject({ denoise: 'spatial', revision: before.revision, pendingReset: false,
      presentationRevision: before.presentationRevision + 1 });
    expect(renderer.importedTelemetry.indirect!.progress.limits).not.toHaveProperty('spatialDenoise'); renderer.dispose();
  });

  it('validates the full denoise request before publishing other imported control changes', async () => {
    const h = harness(), renderer = await h.create();
    const before = renderer.importedTelemetry;
    for (const denoise of ['spatial', 'invalid', null, 0]) {
      expect(() => renderer.passNames({ imported: { background: [1, 0, 0], lighting: { ...h.geometry.lighting, intensity: 4 },
        indirect: { enabled: true, denoise } } } as never)).toThrowError(expect.objectContaining({ code: denoise === 'spatial' ? 'UNSUPPORTED_FEATURE' : 'INVALID_OPTIONS' }));
      expect(h.geometry.update).not.toHaveBeenCalled(); expect(h.effect.updateLighting).not.toHaveBeenCalled();
      expect(h.effect.setEnabled).not.toHaveBeenCalled(); expect(h.effect.setDenoise).not.toHaveBeenCalled();
      expect(renderer.importedTelemetry).toEqual(before);
    }
    renderer.dispose();
  });

  it.each(['frame', 'presentation', 'mode', 'pending'] as const)('discards a stale %s reconstruction fault without rejecting the new presentation', async reason => {
    const h = harness(); h.setProgress({ spatialDenoise: true, denoise: 'spatial' }); const renderer = await h.create();
    const old = h.counters({ spatialDiagnostics: { filteredPixels: 4, fallbackChannels: 0, hdrFaultChannels: 1, guideBypassPixels: 0 } });
    const wait = deferred<ImportedIndirectReadback>(); h.effect.readProgress.mockReturnValueOnce(wait.promise);
    const pending = renderer.readIndirectProgress();
    if (reason === 'frame') h.setProgress({ submittedFrameId: 2 });
    if (reason === 'presentation') h.setProgress({ presentationRevision: old.presentationRevision + 1 });
    if (reason === 'mode') h.setProgress({ denoise: 'off' });
    if (reason === 'pending') h.setProgress({ pendingFrame: true });
    wait.resolve(old); await expect(pending).resolves.toBeUndefined();
    expect(renderer.importedTelemetry.indirect!.sampleCounters).toBeNull(); renderer.dispose();
  });

  it('reads a newly submitted frame when a second idle request overlaps an older diagnostic copy', async () => {
    const h = harness(); h.setProgress({ spatialDenoise: true }); const renderer = await h.create();
    const older = h.counters({ spatialDiagnostics: { filteredPixels: 0, fallbackChannels: 0, hdrFaultChannels: 0, guideBypassPixels: 0 } });
    const wait = deferred<ImportedIndirectReadback>(); h.effect.readProgress.mockReturnValueOnce(wait.promise);
    const firstIdle = renderer.readIndirectProgress();
    h.setProgress({ submittedFrameId: 2, submittedFrames: 2 });
    const current = h.counters({ spatialDiagnostics: { filteredPixels: 1, fallbackChannels: 0, hdrFaultChannels: 1, guideBypassPixels: 0 } });
    h.effect.readProgress.mockResolvedValueOnce(current);
    const secondIdle = expect(renderer.readIndirectProgress()).rejects.toMatchObject({ code: 'PRESENTATION_HDR_FAULT' });
    expect(h.effect.readProgress).toHaveBeenCalledOnce(); // No concurrent map operation.
    wait.resolve(older); await firstIdle; await secondIdle;
    expect(h.effect.readProgress).toHaveBeenCalledTimes(2);
    expect(renderer.importedTelemetry.indirect!.sampleCounters).toMatchObject({ submittedFrameId: 2, spatialDiagnostics: { hdrFaultChannels: 1 } });
    renderer.dispose();
  });

  it('coalesces a fresh header after a shared stale fault and never rejects the later display mode', async () => {
    const h = harness(); h.setProgress({ spatialDenoise: true, denoise: 'spatial' }); const renderer = await h.create();
    const staleFault = h.counters({ spatialDiagnostics: { filteredPixels: 4, fallbackChannels: 0, hdrFaultChannels: 3, guideBypassPixels: 0 } });
    const old = deferred<ImportedIndirectReadback>(), current = deferred<ImportedIndirectReadback>();
    h.effect.readProgress.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = renderer.readIndirectProgress();
    renderer.passNames({ imported: { indirect: { enabled: true, denoise: 'off' } } });
    h.setProgress({ submittedFrameId: 2, submittedFrames: 2 });
    const second = renderer.readIndirectProgress(), third = renderer.readIndirectProgress();
    old.resolve(staleFault); await first;
    // The second and third callers share one current GPU copy after joining A.
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(h.effect.readProgress).toHaveBeenCalledTimes(2);
    const healthy = h.counters({ spatialDiagnostics: { filteredPixels: 0, fallbackChannels: 0, hdrFaultChannels: 0, guideBypassPixels: 0 } });
    current.resolve(healthy); await expect(Promise.all([second, third])).resolves.toEqual([undefined, undefined]);
    expect(renderer.importedTelemetry.indirect!.sampleCounters).toMatchObject({ denoise: 'off', submittedFrameId: 2, spatialDiagnostics: { hdrFaultChannels: 0 } });
    renderer.dispose();
  });

  it('publishes a current HDR fault separately, clears the readback slot, and recovers under new controls', async () => {
    const h = harness(); h.setProgress({ spatialDenoise: true, denoise: 'spatial' }); const renderer = await h.create();
    const fault = h.counters({ spatialDiagnostics: { filteredPixels: 3, fallbackChannels: 1, hdrFaultChannels: 2, guideBypassPixels: 4 } });
    h.effect.readProgress.mockResolvedValueOnce(fault);
    await expect(renderer.readIndirectProgress()).rejects.toMatchObject({ code: 'PRESENTATION_HDR_FAULT' });
    await expect(renderer.readIndirectProgress()).rejects.toMatchObject({ code: 'PRESENTATION_HDR_FAULT' });
    expect(h.effect.readProgress).toHaveBeenCalledOnce(); // Repeated same-frame fault uses the matching cached diagnostic.
    expect(renderer.importedTelemetry.indirect!.sampleCounters).toMatchObject({ attempted: 8, completed: 5, exhausted: 2, invalid: 1,
      spatialDiagnostics: { hdrFaultChannels: 2 } });
    renderer.passNames({ imported: { indirect: { enabled: true, denoise: 'off' } } });
    expect(renderer.importedTelemetry.indirect!.sampleCounters).toBeNull();
    h.setProgress({ submittedFrameId: 2 }); h.effect.readProgress.mockResolvedValueOnce(h.counters({ spatialDiagnostics: { filteredPixels: 0, fallbackChannels: 0, hdrFaultChannels: 0, guideBypassPixels: 0 } }));
    await expect(renderer.readIndirectProgress()).resolves.toBeUndefined();
    expect(renderer.importedTelemetry.indirect!.sampleCounters).toMatchObject({ submittedFrameId: 2, denoise: 'off', spatialDiagnostics: { hdrFaultChannels: 0 } });
    expect(h.effect.readProgress).toHaveBeenCalledTimes(2); renderer.dispose();
  });
});
