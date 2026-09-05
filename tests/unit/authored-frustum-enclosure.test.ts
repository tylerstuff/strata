import { describe, expect, it } from 'vitest';
import { encloseAuthoredClipCorners } from '../../packages/core/src/rendering/authored-frustum-enclosure.js';

type Dyadic = { n: bigint; e: number };
const bits = new DataView(new ArrayBuffer(4));
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// Independent exact arithmetic for test evaluation only. Host floating sums do
// not decide which adjacent f32 result is permitted, even under cancellation.
function dyadic(value: number): Dyadic {
  bits.setFloat32(0, value, false);
  const word = bits.getUint32(0, false), exponent = (word >>> 23) & 255;
  const mantissa = (word & 0x7fffff) | (exponent ? 0x800000 : 0);
  return { n: BigInt(word >>> 31 ? -mantissa : mantissa), e: exponent ? exponent - 150 : -149 };
}
function add(a: Dyadic, b: Dyadic): Dyadic {
  const e = Math.min(a.e, b.e);
  return { n: (a.n << BigInt(a.e - e)) + (b.n << BigInt(b.e - e)), e };
}
function multiply(a: Dyadic, b: Dyadic): Dyadic { return { n: a.n * b.n, e: a.e + b.e }; }
function compare(a: Dyadic, b: Dyadic): bigint { return add(a, { n: -b.n, e: b.e }).n; }
function adjacent(value: number, up: boolean): number {
  if (value === 0) return up ? 2 ** -149 : -(2 ** -149);
  bits.setFloat32(0, value, false);
  const word = bits.getUint32(0, false);
  bits.setUint32(0, word + (value > 0 === up ? 1 : -1), false);
  return bits.getFloat32(0, false);
}
function directed(value: Dyadic, up: boolean): number {
  const candidate = Math.fround(Number(value.n) * 2 ** value.e);
  const order = compare(dyadic(candidate), value);
  if (order === 0n) return candidate;
  return up ? (order < 0n ? adjacent(candidate, true) : candidate)
    : (order > 0n ? adjacent(candidate, false) : candidate);
}

type Schedule = 'up' | 'down' | 'alternating';
type Tree = 'forward' | 'reverse' | 'balanced' | 'fused';
function arithmetic(schedule: Schedule) {
  let operations = 0;
  const round = (v: Dyadic) => directed(v, schedule === 'up' || schedule === 'alternating' && operations++ % 2 === 0);
  const plus = (a: number, b: number) => round(add(dyadic(a), dyadic(b)));
  const times = (a: number, b: number) => round(multiply(dyadic(a), dyadic(b)));
  const fma = (a: number, b: number, c: number) => round(add(multiply(dyadic(a), dyadic(b)), dyadic(c)));
  function sum(values: number[], tree: Tree): number {
    if (values.length === 1) return values[0]!;
    if (tree === 'balanced') {
      const half = values.length >> 1;
      return plus(sum(values.slice(0, half), tree), sum(values.slice(half), tree));
    }
    const ordered = tree === 'reverse' ? values.slice().reverse() : values;
    return ordered.slice(1).reduce(plus, ordered[0]!);
  }
  function dot(a: number[], b: number[], tree: Tree): number {
    if (tree === 'fused') {
      let value = times(a[0]!, b[0]!);
      for (let i = 1; i < a.length; i++) value = fma(a[i]!, b[i]!, value);
      return value;
    }
    return sum(a.map((v, i) => times(v, b[i]!)), tree);
  }
  function matvec(matrix: Float32Array, point: number[], tree: Tree): number[] {
    return [0, 1, 2, 3].map(row => dot([0, 1, 2, 3].map(col => matrix[col * 4 + row]!), point, tree));
  }
  return { sum, times, dot, matvec };
}

function assertEncloses(bounds: Float64Array, corner: number, output: number[]): void {
  for (let row = 0; row < 4; row++) {
    expect(output[row]).toBeGreaterThanOrEqual(bounds[corner * 8 + row]!);
    expect(output[row]).toBeLessThanOrEqual(bounds[corner * 8 + 4 + row]!);
  }
}

describe('authored packed clip-coordinate enclosure', () => {
  it('returns documented corner order and outward finite bounds without mutating packed inputs', () => {
    const model = identity(), vp = identity(), beforeModel = model.slice(), beforeVp = vp.slice();
    const result = encloseAuthoredClipCorners(model, vp);
    expect(result.supported).toBe(true);
    if (!result.supported) throw new Error('Expected supported identity');
    expect(result.bounds).toHaveLength(64);
    expect(Array.from(result.bounds).every(Number.isFinite)).toBe(true);
    for (let corner = 0; corner < 8; corner++) {
      const point = [corner & 1 ? 0.5 : -0.5, corner & 2 ? 0.5 : -0.5, corner & 4 ? 0.5 : -0.5, 1];
      assertEncloses(result.bounds, corner, point);
      for (let row = 0; row < 4; row++) {
        expect(result.bounds[corner * 8 + 4 + row]! - result.bounds[corner * 8 + row]!).toBeLessThan(0.000012);
      }
    }
    expect(model).toEqual(beforeModel); expect(vp).toEqual(beforeVp);
  });

  it('keeps exact zero polynomials finite and signed-zero independent', () => {
    const result = encloseAuthoredClipCorners(new Float32Array(16).fill(-0), identity());
    expect(result).toEqual({ supported: true, bounds: new Float64Array(64) });
  });

  it('retains non-packed and concurrently mutable input instead of relying only on TypeScript types', () => {
    expect(encloseAuthoredClipCorners(new Float64Array(16) as unknown as Float32Array, identity()))
      .toEqual({ supported: false, reason: 'packed-matrix-type' });
    expect(encloseAuthoredClipCorners(identity(), Array.from(identity()) as unknown as Float32Array))
      .toEqual({ supported: false, reason: 'packed-matrix-type' });
    expect(encloseAuthoredClipCorners(new Float32Array(new SharedArrayBuffer(64)), identity()))
      .toEqual({ supported: false, reason: 'shared-matrix-buffer' });
    expect(encloseAuthoredClipCorners(identity(), new Float32Array(new SharedArrayBuffer(64))))
      .toEqual({ supported: false, reason: 'shared-matrix-buffer' });
  });

  it.each([NaN, Infinity, -Infinity])('fails open for nonfinite coefficient %s in either matrix', value => {
    for (const inModel of [true, false]) {
      const model = identity(), vp = identity();
      (inModel ? model : vp)[7] = value;
      expect(encloseAuthoredClipCorners(model, vp)).toEqual({ supported: false, reason: 'nonfinite-coefficient' });
    }
  });

  it('accepts both exact domain endpoints and retains adjacent out-of-domain values including subnormals', () => {
    for (const magnitude of [2 ** -30, 2 ** 20]) {
      for (const sign of [-1, 1]) {
        const model = identity(); model[4] = sign * magnitude;
        expect(encloseAuthoredClipCorners(model, identity()).supported).toBe(true);
      }
    }
    for (const magnitude of [adjacent(2 ** -30, false), adjacent(2 ** 20, true), 2 ** -149, (2 - 2 ** -23) * 2 ** 127]) {
      for (const sign of [-1, 1]) {
        const vp = identity(); vp[1] = sign * magnitude;
        expect(encloseAuthoredClipCorners(identity(), vp)).toEqual({ supported: false, reason: 'coefficient-outside-proof-domain' });
      }
    }
    expect(encloseAuthoredClipCorners(new Float32Array(15), identity())).toEqual({ supported: false, reason: 'matrix-length' });
    expect(encloseAuthoredClipCorners(identity(), new Float32Array(17))).toEqual({ supported: false, reason: 'matrix-length' });
  });

  it('checks the exact directed-rounding witness independently of host addition and multiplication', () => {
    const tiny = dyadic(2 ** -30), one = dyadic(1);
    expect(directed(add(one, tiny), false)).toBe(1);
    expect(directed(add(one, tiny), true)).toBe(adjacent(1, true));
    const below = add(one, { ...tiny, n: -tiny.n });
    expect(directed(below, false)).toBe(adjacent(1, false));
    expect(directed(below, true)).toBe(1);
    const a = dyadic(1 + 2 ** -23), product = multiply(a, a);
    expect(directed(product, false)).toBe(1 + 2 ** -22);
    expect(directed(product, true)).toBe(1 + 2 ** -22 + 2 ** -23);
  });

  it('retains cancellation down to the proved 2^-107 lattice without subnormal assumptions', () => {
    const a = 2 ** -30, b = a + 2 ** -53;
    const model = new Float32Array(16), vp = new Float32Array(16);
    model[0] = b; model[1] = a; model[4] = -a; model[5] = -b;
    vp[0] = b; vp[4] = a;
    const result = encloseAuthoredClipCorners(model, vp);
    if (!result.supported) throw new Error(result.reason);
    for (const schedule of ['up', 'down', 'alternating'] as const) {
      const ops = arithmetic(schedule);
      const clip = ops.matvec(vp, ops.matvec(model, [0.5, 0.5, 0.5, 1], 'forward'), 'forward');
      expect(clip[0]).toBe(2 ** -107);
      expect(clip[0]).toBeGreaterThan(2 ** -126);
      assertEncloses(result.bounds, 7, clip);
    }
  });

  it('encloses directed f32 evaluation across matrix regrouping, sum trees, fusion, and cancellation', () => {
    let seed = 0x7183901;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const coefficient = () => {
      const exponent = [-30, -20, -1, 0, 8, 19][next() % 6]!;
      return Math.fround((next() & 1 ? -1 : 1) * (1 + (next() % 0x800000) * 2 ** -23) * 2 ** exponent);
    };
    const pairs: [Float32Array, Float32Array][] = [
      [new Float32Array(16).fill(2 ** 20), new Float32Array(16).fill(-(2 ** 20))],
      [new Float32Array(16).fill(2 ** -30), new Float32Array(16).fill(2 ** -30)],
      [new Float32Array([2 ** 20, 1, -1, 0, -(2 ** 20), -1, 1, 0,
        1 + 2 ** -23, 2 ** -30, 2 ** 20, 0, -1, -(2 ** -30), -(2 ** 20), 1]), identity()],
    ];
    for (let i = 0; i < 9; i++) pairs.push([Float32Array.from({ length: 16 }, coefficient), Float32Array.from({ length: 16 }, coefficient)]);
    let checkedComponents = 0;
    for (const [model, vp] of pairs) {
      const result = encloseAuthoredClipCorners(model, vp);
      if (!result.supported) throw new Error(result.reason);
      for (let corner = 0; corner < 8; corner++) {
        const point = [corner & 1 ? 0.5 : -0.5, corner & 2 ? 0.5 : -0.5, corner & 4 ? 0.5 : -0.5, 1];
        for (const schedule of ['up', 'down', 'alternating'] as const) {
          for (const tree of ['forward', 'reverse', 'balanced', 'fused'] as const) {
            const arithmeticOps = arithmetic(schedule);
            const nested = arithmeticOps.matvec(vp, arithmeticOps.matvec(model, point, tree), tree);
            assertEncloses(result.bounds, corner, nested);
            const product = new Float32Array(16);
            for (let col = 0; col < 4; col++) {
              for (let row = 0; row < 4; row++) {
                product[col * 4 + row] = arithmeticOps.dot(
                  [0, 1, 2, 3].map(j => vp[j * 4 + row]!),
                  [0, 1, 2, 3].map(j => model[col * 4 + j]!), tree);
              }
            }
            assertEncloses(result.bounds, corner, arithmeticOps.matvec(product, point, tree));
            const expanded = [0, 1, 2, 3].map(row => {
              const terms: number[] = [];
              for (let j = 0; j < 4; j++) {
                for (let k = 0; k < 4; k++) {
                  terms.push(arithmeticOps.times(arithmeticOps.times(vp[j * 4 + row]!, model[k * 4 + j]!), point[k]!));
                }
              }
              return arithmeticOps.sum(terms, tree);
            });
            assertEncloses(result.bounds, corner, expanded);
            checkedComponents += 12;
          }
        }
      }
    }
    expect(checkedComponents).toBe(13824);
  });
});
