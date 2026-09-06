import { checkpoint } from '../imported/gltf-accessor.js';
import { unit } from '../imported/gltf-math.js';

export async function generateTangents(vertices: Float32Array<ArrayBuffer>, indices: Uint32Array<ArrayBuffer>, signal?: AbortSignal, positions?: Float64Array<ArrayBuffer>): Promise<void> {
  const sum = new Float64Array(vertices.length / 16 * 6);
  for (let index = 0; index < indices.length; index += 3) {
    if (index % 12288 === 0) await checkpoint(index / 3, signal);
    const ids = [indices[index]!, indices[index + 1]!, indices[index + 2]!]; const [a, b, c] = ids.map(value => value * 16) as [number, number, number];
    const du1 = vertices[b + 6]! - vertices[a + 6]!, dv1 = vertices[b + 7]! - vertices[a + 7]!, du2 = vertices[c + 6]! - vertices[a + 6]!, dv2 = vertices[c + 7]! - vertices[a + 7]!;
    const determinant = du1 * dv2 - du2 * dv1; if (Math.abs(determinant) < 1e-12) continue;
    const source = positions ?? vertices, stride = positions ? 3 : 16;
    const pa = ids[0]! * stride, pb = ids[1]! * stride, pc = ids[2]! * stride;
    for (let axis = 0; axis < 3; axis++) {
      const p = source[pb + axis]! - source[pa + axis]!, q = source[pc + axis]! - source[pa + axis]!;
      for (const id of ids) { sum[id * 6 + axis]! += (p * dv2 - q * dv1) / determinant; sum[id * 6 + axis + 3]! += (q * du1 - p * du2) / determinant; }
    }
  }
  for (let vertex = 0; vertex < vertices.length / 16; vertex++) {
    if (vertex % 4096 === 0) await checkpoint(vertex, signal);
    const at = vertex * 16; const n = [vertices[at + 3]!, vertices[at + 4]!, vertices[at + 5]!]; let t = [sum[vertex * 6]!, sum[vertex * 6 + 1]!, sum[vertex * 6 + 2]!];
    const dot = t.reduce((total, value, axis) => total + value * n[axis]!, 0); t = t.map((value, axis) => value - dot * n[axis]!);
    if (Math.hypot(...t) < 1e-12) t = Math.abs(n[1]!) < 0.9 ? [n[2]!, 0, -n[0]!] : [0, -n[2]!, n[1]!];
    const tangent = unit(t[0]!, t[1]!, t[2]!); const cross = [n[1]! * tangent[2] - n[2]! * tangent[1], n[2]! * tangent[0] - n[0]! * tangent[2], n[0]! * tangent[1] - n[1]! * tangent[0]];
    const sign = cross.reduce((total, value, axis) => total + value * sum[vertex * 6 + 3 + axis]!, 0) < 0 ? -1 : 1;
    vertices.set([...tangent, sign], at + 8);
  }
}
