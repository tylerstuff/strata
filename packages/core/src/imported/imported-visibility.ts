import type { ImportedBounds } from './imported-types.js';

export interface ImportedDrawRange { firstIndex: number; indexCount: number; bounds: ImportedBounds }

/** One-time static index partition. Vertex data (including baked UVs) is never changed. */
export function partitionImportedIndices(vertices: Float32Array, indices: Uint32Array, bounds: ImportedBounds): {
  indices: Uint32Array; ranges: readonly ImportedDrawRange[];
} {
  if (indices.length < 24576) return { indices, ranges: [{ firstIndex: 0, indexCount: indices.length, bounds }] };
  // A bounded grid avoids thousands of tiny draws on material-joined environments.
  const scale = bounds.min.map((v, axis) => 4 / Math.max(bounds.max[axis]! - v, 1e-9));
  const cells = new Uint8Array(indices.length / 3), counts = new Uint32Array(64);
  for (let t = 0; t < cells.length; t++) {
    let cell = 0;
    for (let axis = 0; axis < 3; axis++) {
      const center = (vertices[indices[t * 3]! * 16 + axis]! + vertices[indices[t * 3 + 1]! * 16 + axis]! + vertices[indices[t * 3 + 2]! * 16 + axis]!) / 3;
      cell |= Math.max(0, Math.min(3, Math.floor((center - bounds.min[axis]!) * scale[axis]!))) << (axis * 2);
    }
    cells[t] = cell; counts[cell]! += 3;
  }
  const offsets = new Uint32Array(64), cursor = new Uint32Array(64);
  const ranges = Array.from({ length: 64 }, (_, cell) => {
    if (cell) offsets[cell] = offsets[cell - 1]! + counts[cell - 1]!;
    cursor[cell] = offsets[cell]!;
    return { firstIndex: offsets[cell]!, indexCount: counts[cell]!, bounds: { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] } };
  });
  const reordered = new Uint32Array(indices.length);
  for (let t = 0; t < cells.length; t++) {
    const cell = cells[t]!, b = ranges[cell]!.bounds;
    for (let corner = 0; corner < 3; corner++) {
      const index = indices[t * 3 + corner]!; reordered[cursor[cell]!] = index; cursor[cell]!++;
      for (let axis = 0; axis < 3; axis++) {
        const value = vertices[index * 16 + axis]!;
        b.min[axis] = Math.min(b.min[axis]!, value); b.max[axis] = Math.max(b.max[axis]!, value);
      }
    }
  }
  return { indices: reordered, ranges: ranges.filter(r => r.indexCount) };
}

/** WebGPU clip volume: -w <= x,y <= w and 0 <= z <= w. Conservative at boundaries. */
export function importedFrustumPlanes(matrix: Float32Array): Float64Array {
  const planes = new Float64Array(24);
  for (let p = 0; p < 6; p++) for (let c = 0; c < 4; c++) {
    const axis = p >> 1, sign = p % 2 === 0 ? 1 : -1;
    planes[p * 4 + c] = p === 4 ? matrix[c * 4 + 2]! : matrix[c * 4 + 3]! + sign * matrix[c * 4 + axis]!;
  }
  return planes;
}
export function importedBoundsVisible(bounds: ImportedBounds, planes: Float64Array): boolean {
  for (let p = 0; p < 24; p += 4) {
    let maximum = planes[p + 3]!;
    let tolerance = (Math.abs(maximum) + 1) * 1e-6;
    for (let axis = 0; axis < 3; axis++) {
      const coefficient = planes[p + axis]!;
      maximum += coefficient * (coefficient >= 0 ? bounds.max[axis]! : bounds.min[axis]!);
      tolerance += Math.abs(coefficient) * (1e-5 + Math.max(Math.abs(bounds.min[axis]!), Math.abs(bounds.max[axis]!)) * 1e-6);
    }
    if (maximum < -tolerance) return false;
  }
  return true;
}
