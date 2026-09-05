export type ImportedEnvironmentCubeVector = readonly [number, number, number];

export interface ImportedEnvironmentCubeQuery {
  readonly direction: ImportedEnvironmentCubeVector;
  readonly lod: number;
  readonly preset: 0 | 1;
  readonly expected: ImportedEnvironmentCubeVector;
  readonly label: string;
}

export interface ImportedEnvironmentCubeMip {
  readonly level: number;
  readonly edge: number;
  /** Tightly packed RGBA16F, row-major within each of the 12 array layers. */
  readonly data: Uint16Array<ArrayBuffer>;
}

export interface ImportedEnvironmentCubeFixture {
  readonly mipLevels: readonly ImportedEnvironmentCubeMip[];
  readonly queries: readonly ImportedEnvironmentCubeQuery[];
}

type V3 = ImportedEnvironmentCubeVector;
interface Face { readonly index: number; readonly name: string; readonly axis: number; readonly direction: V3 }
const faces: readonly Face[] = [
  { index: 0, name: '+X', axis: 0, direction: [1, 0, 0] },
  { index: 1, name: '-X', axis: 0, direction: [-1, 0, 0] },
  { index: 2, name: '+Y', axis: 1, direction: [0, 1, 0] },
  { index: 3, name: '-Y', axis: 1, direction: [0, -1, 0] },
  { index: 4, name: '+Z', axis: 2, direction: [0, 0, 1] },
  { index: 5, name: '-Z', axis: 2, direction: [0, 0, -1] },
];
// Adjacency is geometric: two distinct coordinate axes share an edge. Opposite
// faces do not. These fixtures never implement a direction-to-face lookup.
const edges = faces.flatMap((a, index) => faces.slice(index + 1).filter(b => a.axis !== b.axis).map(b => ({ a, b })));

function fractions(preset: 0 | 1, level: number, face: number): V3 {
  return [32 + face * 48 + level * 8 + preset * 512,
    11 + face * face * 11 + level * 13 + preset * 384,
    3 + ((face * 7) % 11) * 31 + level * 17 + preset * 512];
}
function color(preset: 0 | 1, level: number, face: number): V3 {
  const f = fractions(preset, level, face);
  return [1 + f[0] / 1024, 1 + f[1] / 1024, 1 + f[2] / 1024];
}
function blend(a: V3, b: V3, weightB: number): V3 {
  return [a[0] * (1 - weightB) + b[0] * weightB, a[1] * (1 - weightB) + b[1] * weightB,
    a[2] * (1 - weightB) + b[2] * weightB];
}
function towards(a: V3, b: V3, ratio: number): V3 {
  return [a[0] + ratio * b[0], a[1] + ratio * b[1], a[2] + ratio * b[2]];
}

/**
 * Pure generated witnesses for a 64x64, seven-mip, two-preset cubemap. Every
 * face/mip/preset has a distinct RGB triple, constant within that face. All RGB
 * components are 1+k/1024, 0<=k<1024: their half bits are exactly 0x3c00+k.
 * This avoids a shared half converter or a CPU copy of the renderer's sampler.
 * The 196 queries may be dispatched in slices of at most 128.
 */
export function createImportedEnvironmentCubeCases(): ImportedEnvironmentCubeFixture {
  const mipLevels: ImportedEnvironmentCubeMip[] = [];
  for (let level = 0; level < 7; level++) {
    const edge = 64 >> level, data = new Uint16Array(edge * edge * 12 * 4);
    for (const preset of [0, 1] as const) for (const face of faces) {
      const f = fractions(preset, level, face.index), start = (preset * 6 + face.index) * edge * edge * 4;
      for (let texel = 0; texel < edge * edge; texel++) {
        data.set([0x3c00 + f[0], 0x3c00 + f[1], 0x3c00 + f[2], 0x3c00], start + texel * 4);
      }
    }
    mipLevels.push({ level, edge, data });
  }

  const queries: ImportedEnvironmentCubeQuery[] = [];
  for (const preset of [0, 1] as const) {
    const prefix = `cube preset ${preset}`;
    for (let level = 0; level < 7; level++) for (const face of faces) {
      queries.push({ direction: face.direction, lod: level, preset, expected: color(preset, level, face.index),
        label: `${prefix} mip ${level} axis ${face.name}` });
    }
    for (const [index, { a, b }] of edges.entries()) {
      // Equal major components put the footprint halfway across the shared edge.
      // Its other coordinate is centered, so the only colors have weights 1/2.
      for (const level of [0, 6]) {
        queries.push({ direction: towards(a.direction, b.direction, 1), lod: level, preset,
          expected: blend(color(preset, level, a.index), color(preset, level, b.index), .5),
          label: `${prefix} mip ${level} seam ${a.name}/${b.name}` });
      }

      // A direction A+(1-2t/N)B lies t texels inside A's edge on an N-wide face.
      // The texel-center convention yields weights (1/2+t)A + (1/2-t)B.
      // Reverse the major face for the second preset to inspect both seam sides.
      const major = preset === 0 ? a : b, neighbor = preset === 0 ? b : a;
      const level = [0, 3, 6][index % 3]!, t = [.125, .25, .375][index % 3]!, edge = 64 >> level;
      queries.push({ direction: towards(major.direction, neighbor.direction, 1 - 2 * t / edge), lod: level, preset,
        expected: blend(color(preset, level, major.index), color(preset, level, neighbor.index), .5 - t),
        label: `${prefix} mip ${level} near ${major.name}/${neighbor.name} neighbor weight ${.5 - t}` });

      // Keep one direction across two mips. At the finer level t=1/4; halving N
      // gives t=1/8, hence neighbor weights 1/4 and 3/8 before the LOD blend.
      const lower = index % 6, fraction = [.25, .5, .75][index % 3]!, finerEdge = 64 >> lower;
      const low = blend(color(preset, lower, major.index), color(preset, lower, neighbor.index), .25);
      const high = blend(color(preset, lower + 1, major.index), color(preset, lower + 1, neighbor.index), .375);
      queries.push({ direction: towards(major.direction, neighbor.direction, 1 - .5 / finerEdge), lod: lower + fraction,
        preset, expected: blend(low, high, fraction),
        label: `${prefix} lod ${lower + fraction} near ${major.name}/${neighbor.name}` });
    }
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      const a = color(preset, 6, x > 0 ? 0 : 1), b = color(preset, 6, y > 0 ? 2 : 3), c = color(preset, 6, z > 0 ? 4 : 5);
      // At the corner three ordinary bilinear taps contribute 1/4 each; the
      // fourth tap is the three-face mean. Each incident face therefore gets 1/3.
      queries.push({ direction: [x, y, z], lod: 6, preset,
        expected: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3],
        label: `${prefix} mip 6 corner ${x},${y},${z}` });
    }
  }
  return { mipLevels, queries };
}
