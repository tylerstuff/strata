import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeometryPageCache } from '../../packages/core/src/geometry/page-cache.js';
import { GpuGeometry } from '../../packages/core/src/geometry/gpu-geometry.js';
import { buildGeometryMetadata, createTerrainCamera, geometryProjectionScale, projectedGeometryError } from '../../packages/core/src/geometry/geometry-data.js';
import { geometryDevice, geometryFixture } from './geometry-fixture.js';

function setup() {
  const { manifest } = geometryFixture(); const gpu = geometryDevice();
  const slots = [0, -1];
  const cache = {
    gpuBufferBytes: 131_072, initialUploadBytes: 65_536, telemetry: {}, buffer: {},
    getSlot: vi.fn((id: number) => slots[id]!), dispose: vi.fn(), setDemand: vi.fn(),
    update: vi.fn(() => ({ uploadBytes: 0, uploaded: [] as { pageId: number; slot: number }[], evicted: [] as { pageId: number; slot: number }[] })),
  };
  vi.spyOn(GeometryPageCache, 'create').mockResolvedValue(cache as unknown as GeometryPageCache);
  const create = () => GpuGeometry.create(gpu.device, manifest, new URL('https://geometry.test/manifest.json'),
    { renderer: 'virtual', manifestUrl: 'https://geometry.test/manifest.json', cameraMode: 'coverage', pageLoadDelayMs: 17 });
  return { manifest, gpu, cache, slots, create };
}

afterEach(() => vi.restoreAllMocks());
describe('GPU geometry metadata and frame ownership', () => {
  it('packs distinct LOD/page/cluster references and bounds both work lists by resident geometry', () => {
    const { manifest } = geometryFixture(); const packed = buildGeometryMetadata(manifest, 1);
    const words = packed.words;
    expect([...words.subarray(0, 4)]).toEqual([1, 2, 2, 2]);
    expect(packed.triangleCapacity).toBe(1);
    const clusterOffset = words[6]!;
    expect([...words.subarray(clusterOffset, clusterOffset + 6)]).toEqual([0, 0, 24, 1, 0, 1]);
    expect([...words.subarray(clusterOffset + 16, clusterOffset + 22)]).toEqual([1, 0, 24, 1, 0, 0]);
    expect([...words.subarray(words[8]!)]).toEqual([1, 0]);
    expect(new Float32Array(words.buffer)[words[5]! + 8 + 4]).toBe(1);
  });

  it('uses projection scale without depth division for orthographic coverage', () => {
    const { manifest } = geometryFixture();
    const camera = createTerrainCamera(manifest, 800, 600, 0, [0, 0], 'coverage');
    const error = projectedGeometryError(camera, manifest.bounds, 1, 600);
    expect(error).toBeCloseTo(600 / (2 * 4 * 1.05), 4);
    const shifted = { ...camera, view: camera.view.slice() }; shifted.view[14]! -= 100;
    expect(projectedGeometryError(shifted, manifest.bounds, 1, 600)).toBe(error);
    expect(projectedGeometryError(camera, manifest.bounds, 1, 1200)).toBe(error * 2);
    const perspective = createTerrainCamera(manifest, 800, 600, 0, [0, 0], 'tour');
    const further = { ...perspective, view: perspective.view.slice() }; further.view[14]! -= 100;
    expect(projectedGeometryError(further, manifest.bounds, 1, 600)).toBeLessThan(projectedGeometryError(perspective, manifest.bounds, 1, 600));
  });

  it('retries the residency table after a partially committed cache update and table upload failure', async () => {
    const fixture = setup(); const geometry = await fixture.create(); const { gpu, cache, slots } = fixture;
    const camera = geometry.camera(800, 600, 0, [0, 0]);
    cache.update.mockImplementationOnce(() => { slots[1] = 1; throw new Error('second page upload failed'); });
    expect(() => geometry.prepare(gpu.encoder, camera, 800, 600, true, {})).toThrow('second page');
    const table = gpu.buffers.find(buffer => buffer.label === 'Strata page residency table')!;
    const realWrite = gpu.raw.queue.writeBuffer.getMockImplementation()!;
    gpu.raw.queue.writeBuffer.mockImplementationOnce(() => { throw new Error('table upload failed'); });
    expect(() => geometry.prepare(gpu.encoder, camera, 800, 600, true, {})).toThrow('table upload');
    gpu.raw.queue.writeBuffer.mockImplementation(realWrite);
    const result = geometry.prepare(gpu.encoder, camera, 800, 600, true, {});
    expect([...new Uint32Array(table.bytes.buffer)]).toEqual([0, 1]);
    expect(result.uploadBytes).toBe(160 + 64 + 8);
    const uniform = gpu.buffers.find(buffer => buffer.label === 'Strata geometry selection camera')!;
    expect(new Uint32Array(uniform.bytes.buffer)[39]).toBe(1);
    expect(new Float32Array(uniform.bytes.buffer)[32]).toBeCloseTo(geometryProjectionScale(camera, 600), 4);
    expect(gpu.pass.dispatchWorkgroups.mock.calls).toEqual([[1], [2, 1]]);
    geometry.cancelFrame(); geometry.dispose(); geometry.dispose();
    expect(cache.dispose).toHaveBeenCalledOnce();
    expect(gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });

  it('bounds feedback staging, rejects out-of-order samples, and commits demands after submission', async () => {
    const { gpu, cache, create } = setup(); const geometry = await create();
    const feedback = gpu.buffers.filter(buffer => buffer.label.startsWith('Strata geometry feedback'));
    const finish: (() => void)[] = [];
    feedback.forEach(buffer => buffer.mapAsync.mockImplementation(() => new Promise<void>(resolve => finish.push(resolve))));
    for (let frame = 1; frame <= 3; frame++) {
      geometry.prepare(gpu.encoder, geometry.camera(800, 600, frame, [0, 0]), 800, 600, true, {});
      const words = new Uint32Array(feedback[frame - 1]!.bytes.buffer);
      words[0] = frame * 3; words[4] = 3; words.set([0, 1, 1, 1], 16);
      new Float32Array(words.buffer)[21] = frame;
      geometry.submitted(frame);
    }
    geometry.prepare(gpu.encoder, geometry.camera(800, 600, 4, [0, 0]), 800, 600, true, {});
    geometry.submitted(4);
    expect(geometry.geometryTelemetry.pendingFeedbackFrames).toBe(3);
    expect(geometry.geometryTelemetry.droppedFeedbackFrames).toBe(1);
    expect(cache.setDemand).not.toHaveBeenCalled();
    finish[2]!(); await Promise.resolve(); await Promise.resolve();
    finish[0]!(); finish[1]!(); await geometry.flushFeedback();
    expect(geometry.geometryTelemetry.sourceFrameId).toBe(3);
    expect(geometry.geometryTelemetry.selectedTriangles).toBe(3);
    expect(cache.setDemand).toHaveBeenCalledExactlyOnceWith([{ tileId: 0, lod: 0, priority: 3 }]);
    expect(geometry.geometryTelemetry).toMatchObject({ sourceSeed: 42, sourceTriangleCount: 1, pixelError: 2, pageLoadDelayMs: 17 });
    geometry.dispose();
  });
});
