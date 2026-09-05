import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { GeometryManifest } from '../../packages/core/src/geometry/format.js';

export function geometryFixture() {
  const bounds = { min: [-4, -1, -4], max: [4, 1, 4] } as const;
  const bodies = Array.from({ length: 2 }, () => {
    const body = new ArrayBuffer(65_536);
    new Float32Array(body, 0, 24).set([-4, 0, -4, 0, 1, 0, 0, 0, -4, 0, 4, 0, 1, 0, 0, 1, 4, 0, -4, 0, 1, 0, 1, 0]);
    new Uint32Array(body, 96, 3).set([0, 1, 2]);
    return body;
  });
  const manifest: GeometryManifest = {
    format: 'strata-geometry', version: 1, pageBytes: 65_536, vertexStride: 32, indexFormat: 'uint32',
    source: { kind: 'analytic-heightfield-v1', seed: 42, tilesPerSide: 1, cellsPerTile: 8, cellSize: 1, triangleCount: 1 },
    bounds, rootPageIds: [0],
    pages: bodies.map((body, id) => ({ id, url: `pages/${String(id).padStart(6, '0')}.bin`, byteLength: 65_536,
      sha256: createHash('sha256').update(new Uint8Array(body)).digest('hex'), pinned: id === 0 })),
    clusters: bodies.map((_, id) => ({ id, pageId: id, vertexOffset: 0, vertexCount: 3, indexOffset: 96, indexCount: 3, triangleCount: 1, bounds })),
    tiles: [{ id: 0, bounds, lods: [
      { level: 0, error: 0, clusterIds: [1], pageIds: [1] }, { level: 1, error: 1, clusterIds: [0], pageIds: [0] },
    ] }],
  };
  return { manifest, bodies };
}

export function geometryDevice() {
  const buffers: { label: string; bytes: Uint8Array<ArrayBuffer>; destroy: ReturnType<typeof vi.fn>; mapAsync: ReturnType<typeof vi.fn>; unmap: ReturnType<typeof vi.fn>; getMappedRange(): ArrayBuffer }[] = [];
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    createShaderModule: vi.fn(),
    createComputePipelineAsync: vi.fn(async () => ({ getBindGroupLayout: vi.fn() })),
    createBindGroup: vi.fn((_descriptor: GPUBindGroupDescriptor) => ({})),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const bytes = new Uint8Array(descriptor.size);
      const buffer = { label: descriptor.label ?? '', bytes, destroy: vi.fn(), mapAsync: vi.fn(async () => undefined), unmap: vi.fn(), getMappedRange: () => bytes.buffer };
      buffers.push(buffer); return buffer;
    }),
    queue: { writeBuffer: vi.fn((buffer: typeof buffers[number], offset: number, input: ArrayBuffer | ArrayBufferView<ArrayBuffer>) => {
      const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
      buffer.bytes.set(bytes, offset);
    }) },
  };
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
  const encoder = {
    beginComputePass: vi.fn(() => pass),
    copyBufferToBuffer: vi.fn((source: typeof buffers[number], offset: number, target: typeof buffers[number], destination: number, bytes: number) => target.bytes.set(source.bytes.subarray(offset, offset + bytes), destination)),
  };
  return { device: device as unknown as GPUDevice, raw: device, buffers, encoder: encoder as unknown as GPUCommandEncoder, pass };
}
