/** Internal static-mesh tracing job contract. This does not enable imported GI. */
export const staticBvhFormatVersion = 1;
export const staticBvhLimits = Object.freeze({
  maxVertices: 2_097_152,
  maxTriangles: 1_048_576,
  leafSize: 4,
  maxDepth: 32,
  nodeBytes: 32,
  triangleBytes: 64,
  vertexBytes: 64,
  defaultWorkingBytes: 256 * 1024 * 1024,
  maxWorkingBytes: 512 * 1024 * 1024,
  defaultPeakCpuBytes: 768 * 1024 * 1024,
  workingHeadroomBytes: 1024 * 1024,
});

/** Balanced median splits reserve a complete tree above leaves of at most four. */
export function staticBvhNodeCapacity(triangleCount: number): number {
  if (!Number.isSafeInteger(triangleCount) || triangleCount < 1 || triangleCount > staticBvhLimits.maxTriangles) {
    throw new RangeError('Static BVH triangle count is outside the supported range.');
  }
  let leaves = 1;
  while (leaves < Math.ceil(triangleCount / staticBvhLimits.leafSize)) leaves *= 2;
  return 2 * leaves - 1;
}

/** Mirrors the Rust job reservation: inputs, 40-byte records, output and headroom. */
export function estimateStaticBvhWorkingBytes(vertexCount: number, triangleCount: number): number {
  if (!Number.isSafeInteger(vertexCount) || vertexCount < 3 || vertexCount > staticBvhLimits.maxVertices) {
    throw new RangeError('Static BVH vertex count is outside the supported range.');
  }
  return 12 * vertexCount + 116 * triangleCount + 32 * staticBvhNodeCapacity(triangleCount)
    + staticBvhLimits.workingHeadroomBytes;
}

/** Byte offsets in little-endian output, also consumed by the future WGSL tracer. */
export const staticBvhLayout = Object.freeze({
  node: { minimum: 0, first: 12, maximum: 16, count: 28 },
  // Original positions are preserved; precomputed f32 edges can collapse small endpoints.
  triangle: { p0: 0, materialId: 12, p1: 16, sourceVertex0: 28, p2: 32, sourceTriangleId: 44, normal: 48, padding: 60 },
  // sourceTriangleId indexes this ORIGINAL triplet, independent of BVH leaf order.
  indexBytes: 12,
  // Reuse the existing indexed imported vertex record, never expand it per triangle.
  vertex: { position: 0, normal: 12, uv: 24, tangent: 32, color: 48 },
});
