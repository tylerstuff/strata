import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMeshPacking, MeshGeometry, selectMeshLods } from '../../packages/core/src/geometry/mesh-geometry.js';
import { createTerrainCamera } from '../../packages/core/src/geometry/geometry-data.js';
import { geometryDevice, geometryFixture } from './geometry-fixture.js';

function setup() {
  const fixture = geometryFixture(); const gpu = geometryDevice();
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const pageId = Number(new URL(String(input)).pathname.match(/(\d+)\.bin$/)![1]);
    return new Response(fixture.bodies[pageId]!.slice(0));
  });
  vi.stubGlobal('fetch', fetcher);
  const create = (signal?: AbortSignal) => MeshGeometry.create(gpu.device, fixture.manifest, new URL('https://geometry.test/manifest.json'),
    { renderer: 'virtual', manifestUrl: 'https://geometry.test/manifest.json', geometryMode: 'mesh-lod', cameraMode: 'coverage', ...(signal ? { signal } : {}) });
  return { ...fixture, gpu, fetcher, create };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('conventional CPU LOD mesh reference', () => {
  it('packs complete tile LOD ranges and rebases each cluster local index exactly once', async () => {
    const fixture = setup(); const packing = buildMeshPacking(fixture.manifest);
    expect(packing.tiles).toEqual([[{ firstIndex: 0, indexCount: 3, clusterCount: 1 }, { firstIndex: 3, indexCount: 3, clusterCount: 1 }]]);
    expect([...packing.clusterVertexBases]).toEqual([3, 0]);
    const mesh = await fixture.create();
    const vertices = fixture.gpu.buffers.find(buffer => buffer.label.endsWith('vertices'))!;
    const indices = fixture.gpu.buffers.find(buffer => buffer.label.endsWith('indices'))!;
    expect([...new Uint32Array(indices.bytes.buffer)]).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...new Float32Array(vertices.bytes.buffer).subarray(0, 8)]).toEqual([-4, 0, -4, 0, 1, 0, 0, 0]);
    expect(mesh.initialUploadBytes).toBe(6 * 32 + 6 * 4);
    expect(mesh.gpuBufferBytes).toBe(mesh.initialUploadBytes + 8);
    expect(mesh.geometryTelemetry).toMatchObject({ poolBytes: 0, residentPages: 0, capacityPages: 0, sourcePageCount: 2,
      sourceRootPageCount: 1, packedGeometryBytes: 216, startupCopiedBytes: 216, startupPageStagingBoundBytes: 131072 });
    expect(fixture.fetcher).toHaveBeenCalledTimes(2);
    mesh.dispose(); mesh.dispose();
    expect(fixture.gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });

  it('uses the coarsest acceptable LOD and keeps an offscreen coarse shadow caster', () => {
    const { manifest } = geometryFixture();
    const camera = createTerrainCamera(manifest, 800, 600, 0, [0, 0], 'coverage');
    expect(selectMeshLods(manifest, camera, 600, 2)[0]).toMatchObject({ lod: 0, visible: true });
    expect(selectMeshLods(manifest, camera, 600, 100)[0]).toMatchObject({ lod: 1, visible: true });
    const shifted = { ...camera, viewProjection: camera.viewProjection.slice() }; shifted.viewProjection[12] = 100;
    expect(selectMeshLods(manifest, shifted, 600, 2)[0]).toMatchObject({ lod: 1, visible: false });
  });

  it('counts actual indexed draws and invalidates history only after a submitted topology change', async () => {
    const { gpu, create } = setup(); const mesh = await create();
    const pipeline = { getBindGroupLayout: vi.fn() } as unknown as GPURenderPipeline;
    mesh.attachPipelines(pipeline, pipeline);
    const pass = { setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), setBindGroup: vi.fn(), drawIndexed: vi.fn() };
    const camera = mesh.camera(800, 600, 0, [0, 0]);
    const selections = gpu.buffers.find(buffer => buffer.label.endsWith('selections'))!;
    const prepare = (reset = false) => mesh.prepare(gpu.encoder, camera, 800, 600, reset, {});
    expect(prepare()).toEqual({ dispatchCalls: 0, drawCalls: 2, triangles: 2, uploadBytes: 8 });
    mesh.draw(pass as unknown as GPURenderPassEncoder, 'raster'); mesh.draw(pass as unknown as GPURenderPassEncoder, 'shadow');
    expect(pass.drawIndexed.mock.calls).toEqual([[3, 1, 0, 0, 0], [3, 1, 0, 0, 0]]);
    expect(new Uint32Array(selections.bytes.buffer)[1]).toBe(1);
    mesh.cancelFrame(); prepare();
    expect(new Uint32Array(selections.bytes.buffer)[1]).toBe(1);
    mesh.submitted(7); prepare();
    expect(new Uint32Array(selections.bytes.buffer)[1]).toBe(0);
    expect(mesh.geometryTelemetry.sourceFrameId).toBe(7);
    prepare(true); expect(new Uint32Array(selections.bytes.buffer)[1]).toBe(1);
    const shifted = { ...camera, viewProjection: camera.viewProjection.slice() }; shifted.viewProjection[12] = 100;
    expect(mesh.prepare(gpu.encoder, shifted, 800, 600, false, {})).toMatchObject({ drawCalls: 1, triangles: 1, dispatchCalls: 0 });
    expect([...new Uint32Array(selections.bytes.buffer)]).toEqual([1, 1]);
    mesh.submitted(8); expect(mesh.geometryTelemetry).toMatchObject({ sourceFrameId: 8, visibleTiles: 0, shadowTriangles: 1 });
    mesh.dispose();
  });

  it('fails before GPU allocation for corrupt pages and observes a cancelled preload', async () => {
    const fixture = setup();
    const damaged = fixture.bodies[0]!.slice(0); new Uint8Array(damaged)[0] = 123;
    fixture.fetcher.mockImplementation(async () => new Response(damaged.slice(0)));
    await expect(fixture.create()).rejects.toThrow('SHA-256');
    expect(fixture.gpu.raw.createBuffer).not.toHaveBeenCalled();
    const abort = new AbortController(); abort.abort(new Error('superseded'));
    await expect(fixture.create(abort.signal)).rejects.toThrow('superseded');
    expect(fixture.gpu.raw.createBuffer).not.toHaveBeenCalled();
  });

  it('bounds live requests and cancels them when scene creation is superseded', async () => {
    const fixture = setup(); const abort = new AbortController();
    fixture.fetcher.mockImplementation((_input, init?: RequestInit) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const pending = fixture.create(abort.signal);
    await vi.waitFor(() => expect(fixture.fetcher).toHaveBeenCalledTimes(2));
    abort.abort(new Error('superseded'));
    await expect(pending).rejects.toThrow('superseded');
    expect(fixture.gpu.raw.createBuffer).not.toHaveBeenCalled();
  });
});
