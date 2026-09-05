import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGeometryMetadata, createTerrainCamera, projectedGeometryError } from '../../packages/core/src/geometry/geometry-data.js';
import { GpuGeometry } from '../../packages/core/src/geometry/gpu-geometry.js';
import { MeshGeometry, selectMeshLods } from '../../packages/core/src/geometry/mesh-geometry.js';
import { normalizeTerrainTransform, TerrainRendering, transformGeometryBounds, transformTerrainCamera } from '../../packages/core/src/geometry/terrain-rendering.js';
import type { TerrainRenderOptions } from '../../packages/core/src/geometry/terrain-rendering.js';
import { geometryDevice, geometryFixture } from './geometry-fixture.js';

const transform = { scale: 0.125, translation: [0, -1.625, 0] as const };
const light = { direction: [0, 1, 0] as const, radiance: [4, 3.8, 3.5] as const };
const options: TerrainRenderOptions = { transform, shading: 'lambert', albedo: [0.08, 0.65, 0.12], light };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function project(matrix: Float32Array, point: readonly number[]): number[] {
  const clip = Array.from({ length: 4 }, (_, row) => matrix[row]! * point[0]! + matrix[4 + row]! * point[1]!
    + matrix[8 + row]! * point[2]! + matrix[12 + row]!);
  return clip.slice(0, 3).map(value => value / clip[3]!);
}

describe('fixed terrain world transform and flat material', () => {
  it('transforms all metadata bounds and LOD errors without changing page offsets or source data', () => {
    const { manifest } = geometryFixture(); const before = structuredClone(manifest);
    const identity = buildGeometryMetadata(manifest, 2); const moved = buildGeometryMetadata(manifest, 2, transform);
    const floats = new Float32Array(moved.words.buffer); const expectedBounds = { min: [-0.5, -1.75, -0.5], max: [0.5, -1.5, 0.5] };
    const tile = moved.words[4]!; const lod = moved.words[5]!; const clusters = moved.words[6]!;
    expect([...floats.slice(tile, tile + 3)]).toEqual(expectedBounds.min); expect([...floats.slice(tile + 4, tile + 7)]).toEqual(expectedBounds.max);
    expect(floats[lod + 4]).toBe(0); expect(floats[lod + 8 + 4]).toBe(0.125);
    for (let index = 0; index < manifest.clusters.length; index++) {
      const base = clusters + index * 16;
      expect([...floats.slice(base + 8, base + 11)]).toEqual(expectedBounds.min);
      expect([...floats.slice(base + 12, base + 15)]).toEqual(expectedBounds.max);
      expect(moved.words.slice(base, base + 8)).toEqual(identity.words.slice(base, base + 8));
    }
    expect(moved.triangleCapacity).toBe(identity.triangleCapacity); expect(manifest).toEqual(before);
  });

  it('preserves camera projection, visibility and projected error when camera and geometry share uniform scale', () => {
    const { manifest } = geometryFixture(); const bounds = transformGeometryBounds(manifest.bounds, transform);
    for (const mode of ['tour', 'coverage'] as const) {
      const camera = createTerrainCamera(manifest, 800, 600, 0.3, [0.25, -0.25], mode);
      const moved = transformTerrainCamera(camera, transform);
      for (const source of [manifest.bounds.min, manifest.bounds.max, [0, 0, 0] as const]) {
        const world = source.map((value, axis) => value * transform.scale + transform.translation[axis]!);
        const original = project(camera.viewProjection, source); const actual = project(moved.viewProjection, world);
        original.forEach((value, axis) => expect(actual[axis]).toBeCloseTo(value, 5));
      }
      expect(projectedGeometryError(moved, bounds, transform.scale, 600)).toBeCloseTo(projectedGeometryError(camera, manifest.bounds, 1, 600), 4);
      expect(selectMeshLods(manifest, moved, 600, 20, transform)[0]!.lod).toBe(selectMeshLods(manifest, camera, 600, 20)[0]!.lod);
      expect(Math.hypot(moved.view[0]!, moved.view[4]!, moved.view[8]!)).toBeCloseTo(1, 6);
      expect(Math.hypot(moved.view[1]!, moved.view[5]!, moved.view[9]!)).toBeCloseTo(1, 6);
      expect(moved.far).toBe(camera.far * transform.scale);
    }
  });

  it('keeps the standalone identity path allocation-free and validates unsupported transforms/materials', () => {
    const gpu = geometryDevice(); const rendering = new TerrainRendering(gpu.device);
    expect(rendering.gpuBufferBytes).toBe(0); expect(rendering.flush()).toBe(0); expect(gpu.buffers).toHaveLength(0);
    for (const scale of [-1, 0, NaN, Infinity, 1e-46, 1e39]) expect(() => normalizeTerrainTransform({ scale, translation: [0, 0, 0] })).toThrow();
    for (const value of [{ transform: { scale: 1, translation: [0, Infinity, 0] } }, { light: { direction: [0, 0, 0], radiance: [1, 1, 1] } },
      { albedo: [1, -0.1, 0] }, { shading: 'transparent' }, { transform: null }, { albedo: null }]) {
      expect(() => new TerrainRendering(gpu.device, value as TerrainRenderOptions)).toThrow();
    }
    expect(gpu.buffers).toHaveLength(0); rendering.dispose();
  });

  it('packs one transform/light/material uniform and uploads defined light changes once', () => {
    const gpu = geometryDevice(); const rendering = new TerrainRendering(gpu.device, options);
    expect(rendering.gpuBufferBytes).toBe(64); expect(rendering.initialUploadBytes).toBe(64);
    const floats = new Float32Array(gpu.buffers[0]!.bytes.buffer);
    expect([...floats.slice(0, 4)]).toEqual([0, -1.625, 0, 0.125]); expect([...floats.slice(4, 7)]).toEqual([0, 1, 0]);
    [0.08, 0.65, 0.12, 1].forEach((value, index) => expect(floats[12 + index]).toBeCloseTo(value, 6));
    expect(rendering.flush()).toBe(0); rendering.setLight(light); expect(rendering.flush()).toBe(0);
    rendering.setLight({ ...light, radiance: [0, 0, 0] }); expect(rendering.flush()).toBe(64); expect(rendering.flush()).toBe(0);
    expect([...floats.slice(8, 11)]).toEqual([0, 0, 0]);
    expect(() => rendering.setLight({ ...light, direction: [0, 0, 0] })).toThrow(); expect(rendering.flush()).toBe(0);
    rendering.dispose(); rendering.dispose(); expect(gpu.buffers[0]!.destroy).toHaveBeenCalledOnce(); expect(rendering.gpuBufferBytes).toBe(0);
  });

  it('cleans up its optional buffer if the initial upload fails', () => {
    const gpu = geometryDevice(); gpu.raw.queue.writeBuffer.mockImplementationOnce(() => { throw new Error('upload failed'); });
    expect(() => new TerrainRendering(gpu.device, options)).toThrow('upload failed');
    expect(gpu.buffers).toHaveLength(1); expect(gpu.buffers[0]!.destroy).toHaveBeenCalledOnce();
  });

  for (const mode of ['streamed', 'mesh-lod'] as const) it(`shares transformed geometry and flat light bindings in ${mode} raster and shadow paths`, async () => {
    const fixture = geometryFixture(); const gpu = geometryDevice();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const page = Number(new URL(String(input)).pathname.match(/(\d+)\.bin$/)![1]); return new Response(fixture.bodies[page]!.slice(0));
    }));
    const source = { renderer: 'virtual' as const, manifestUrl: 'https://geometry.test/manifest.json', geometryMode: mode,
      cameraMode: 'coverage' as const, poolBytes: 2 * 65536 };
    const provider = mode === 'mesh-lod'
      ? await MeshGeometry.create(gpu.device, fixture.manifest, new URL(source.manifestUrl), source, options)
      : await GpuGeometry.create(gpu.device, fixture.manifest, new URL(source.manifestUrl), source, options);
    expect(provider.fragmentEntryPoint).toBe('terrainLambertFragment'); expect(provider.usesMaterialTextures).toBe(false);
    const uniform = gpu.buffers.find(buffer => buffer.label === 'Strata terrain transform and flat material')!;
    const pipeline = { getBindGroupLayout: vi.fn(() => ({})) } as unknown as GPURenderPipeline;
    provider.attachPipelines(pipeline, pipeline);
    const groups = gpu.raw.createBindGroup.mock.calls.map(([descriptor]) => descriptor as GPUBindGroupDescriptor);
    const shadow = groups.find(group => group.label === (mode === 'mesh-lod' ? 'Strata conventional terrain shadow transform' : 'Strata shadow page pulling'))!;
    const raster = groups.find(group => group.label === (mode === 'mesh-lod' ? 'Strata conventional tile history' : 'Strata raster page pulling'))!;
    const binding = mode === 'mesh-lod' ? 1 : 5;
    for (const group of [shadow, raster]) expect([...group.entries].find(entry => entry.binding === binding)!.resource).toEqual({ buffer: uniform });
    if (mode === 'streamed') {
      const metadata = gpu.buffers.find(buffer => buffer.label === 'Strata cooked geometry metadata')!;
      const words = new Uint32Array(metadata.bytes.buffer); const floats = new Float32Array(metadata.bytes.buffer);
      expect([...floats.slice(words[4]!, words[4]! + 3)]).toEqual([-0.5, -1.75, -0.5]);
    } else {
      const vertices = gpu.buffers.find(buffer => buffer.label === 'Strata conventional terrain vertices')!;
      // Source positions and normals remain intact; the shared uniform transforms both draw phases.
      expect([...new Float32Array(vertices.bytes.buffer).slice(0, 6)]).toEqual([-4, 0, -4, 0, 1, 0]);
    }
    const camera = provider.camera(800, 600, 0, [0, 0]);
    const before = provider.prepare(gpu.encoder, camera, 800, 600, true, {}); provider.cancelFrame();
    provider.setLight({ ...light, radiance: [0, 0, 0] });
    const after = provider.prepare(gpu.encoder, camera, 800, 600, true, {});
    expect(after.uploadBytes).toBe(before.uploadBytes + 64);
    provider.dispose(); provider.dispose(); expect(gpu.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });
});
