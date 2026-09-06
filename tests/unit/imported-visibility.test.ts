import { expect, it } from 'vitest';
import { importedBoundsVisible, importedFrustumPlanes, partitionImportedIndices } from '../../packages/core/src/imported/imported-visibility.js';
import { createRasterCamera } from '../../packages/core/src/rendering/raster-math.js';

it('preserves every triangle and winding, leaves vertices untouched, and bounds crossing triangles conservatively', () => {
  const vertices = new Float32Array(9000 * 3 * 16);
  const indices = new Uint32Array(9000 * 3);
  for (let i = 0; i < indices.length; i++) {
    indices[i] = i;
    vertices[i * 16] = Math.sin(i) * 10; vertices[i * 16 + 1] = Math.cos(i * 2) * 10; vertices[i * 16 + 2] = Math.sin(i * 3) * 10;
    vertices[i * 16 + 7] = i; // Attribute sentinel independent of position.
  }
  const snapshot = vertices.slice();
  const result = partitionImportedIndices(vertices, indices, { min: [-10, -10, -10], max: [10, 10, 10] });
  expect(vertices).toEqual(snapshot); expect(result.ranges.length).toBeLessThanOrEqual(64);
  expect(result.ranges.length).toBeGreaterThan(1);
  const found = new Set<number>(); let end = 0;
  for (const range of result.ranges) {
    expect(range.firstIndex).toBe(end); end += range.indexCount;
    for (let i = range.firstIndex; i < end; i += 3) {
      const first = result.indices[i]!; found.add(first);
      expect([...result.indices.subarray(i, i + 3)]).toEqual([first, first + 1, first + 2]);
      for (let c = 0; c < 3; c++) for (let axis = 0; axis < 3; axis++) {
        const v = vertices[result.indices[i + c]! * 16 + axis]!;
        expect(v).toBeGreaterThanOrEqual(range.bounds.min[axis]!); expect(v).toBeLessThanOrEqual(range.bounds.max[axis]!);
      }
    }
  }
  expect(found.size).toBe(9000); expect(end).toBe(indices.length);
});

it('uses WebGPU near/far planes and keeps edge intersections including camera-enclosing bounds', () => {
  const planes = importedFrustumPlanes(new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]));
  expect(importedBoundsVisible({ min: [-2,-2,-2], max: [2,2,2] }, planes)).toBe(true);
  expect(importedBoundsVisible({ min: [1,0,0], max: [2,1,1] }, planes)).toBe(true);
  for (const [min,max] of [ [[2,0,0],[3,1,1]], [[-3,0,0],[-2,1,1]], [[0,2,0],[1,3,1]], [[0,-3,0],[1,-2,1]], [[0,0,-2],[1,1,-1]], [[0,0,2],[1,1,3]] ] as const) {
    expect(importedBoundsVisible({min,max},planes)).toBe(false);
  }
});

it('never rejects a visible point across perspective camera motion and jitter phases', () => {
  for (let t = 0; t < 20; t += .5) {
    const camera = createRasterCamera(1024,640,t,4,[.4,-.3]);
    const planes = importedFrustumPlanes(camera.viewProjection), m = camera.viewProjection;
    for (let i = 0; i < 100; i++) {
      const p: [number,number,number] = [Math.sin(i)*12, Math.cos(i*2)*8, Math.cos(i)*12];
      const q = [0,1,2,3].map(row => m[row]! * p[0] + m[4+row]! * p[1] + m[8+row]! * p[2] + m[12+row]!);
      if (q[3]! > 0 && Math.abs(q[0]!) <= q[3]! && Math.abs(q[1]!) <= q[3]! && q[2]! >= 0 && q[2]! <= q[3]!) {
        expect(importedBoundsVisible({min:p,max:p},planes)).toBe(true);
      }
    }
  }
});
