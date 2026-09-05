import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { environmentCubeData, environmentDfgData, environmentMetadata } from '../../packages/core/src/imported/imported-environment-data.js';
import { environmentTextureBytes, environmentUniform, snapshotEnvironment } from '../../packages/core/src/imported/imported-environment.js';
import { bakeCube, bakeDiffuse, cubeDirection, dfg, evaluateDiffuse, half, prefilter, solidAngle, unit } from '../../scripts/imported-environment-bake.mjs';

const pi = Math.PI;
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, i) => sum + value * b[i]!, 0);
function decodeHalf(value: number): number {
  const exponent = (value >> 10) & 31, fraction = value & 1023;
  return exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15);
}
const bytes = Buffer.from(environmentDfgData, 'base64');
function lookup(noV: number, roughness: number): number[] {
  // Inverse of the documented endpoint grid, with independent bilinear texel interpolation.
  const x = Math.sqrt((Math.max(.0001, Math.min(1, noV)) - .0001) / .9999) * 63;
  const y = Math.max(0, Math.min(1, (roughness - .06) / .94)) * 63;
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  return [0, 1].map(c => {
    const sample = (dx: number, dy: number) => decodeHalf(bytes.readUInt16LE((Math.min(63, iy + dy) * 64 + Math.min(63, ix + dx)) * 4 + c * 2));
    return (sample(0, 0) * (1 - fx) + sample(1, 0) * fx) * (1 - fy) + (sample(0, 1) * (1 - fx) + sample(1, 1) * fx) * fy;
  });
}
function close(actual: readonly number[], expected: readonly number[], tolerance: number) {
  actual.forEach((value, i) => expect(Math.abs(value - expected[i]!)).toBeLessThan(tolerance));
}

describe('generated distant environment numeric contract', () => {
  it('pins deterministic procedural provenance, dimensions, byte budgets and finite half-float payloads', () => {
    const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
    expect(environmentMetadata.bakerSha256).toBe(sha(readFileSync(new URL('../../scripts/imported-environment-bake.mjs', import.meta.url))));
    expect(bytes.length).toBe(64 * 64 * 4); expect(sha(bytes)).toBe(environmentMetadata.dfg.sha256);
    let total = bytes.length;
    for (const preset of ['studio', 'sky'] as const) {
      const cube = Buffer.from(environmentCubeData[preset], 'base64');
      expect(cube.length).toBe(6 * [64, 32, 16, 8, 4, 2, 1].reduce((sum, edge) => sum + edge * edge, 0) * 8);
      expect(sha(cube)).toBe(environmentMetadata.environments[preset].sha256); total += cube.length;
      for (let index = 0; index < cube.length; index += 2) expect(cube.readUInt16LE(index)).toBeLessThan(0x7c00);
    }
    expect(total).toBe(environmentTextureBytes); expect(total).toBeLessThan(529 * 1024);
    for (let index = 0; index < bytes.length; index += 4) {
      const a = decodeHalf(bytes.readUInt16LE(index)), b = decodeHalf(bytes.readUInt16LE(index + 2));
      expect(a).toBeGreaterThanOrEqual(0); expect(b).toBeGreaterThanOrEqual(0); expect(a + b).toBeLessThan(1.02);
      for (const f0 of [0, .04, .5, 1]) {
        const energy = Math.min(1, Math.max(0, f0 * a + b));
        for (const base of [0, .4, 1]) for (const metallic of [0, .5, 1]) {
          expect(energy + base * (1 - metallic) * (1 - energy)).toBeLessThanOrEqual(1 + 1e-15);
        }
      }
    }
  });
  it('rounds binary16 ties to even and preserves constant HDR radiance across every cube face and roughness level', () => {
    expect(half(1 + 2 ** -11)).toBe(0x3c00); expect(half(1 + 3 * 2 ** -11)).toBe(0x3c02);
    expect(half(2 ** -24)).toBe(1); expect(half(2 ** -25)).toBe(0); expect(half(65504)).toBe(0x7bff);
    const color = [.125, 2, 4], cube = bakeCube(() => color, 8, 4, 32);
    for (let offset = 0; offset < cube.length; offset += 8) {
      close([0, 1, 2].map(c => decodeHalf(cube.readUInt16LE(offset + c * 2))), color, 1e-12);
      expect(cube.readUInt16LE(offset + 6)).toBe(half(1));
    }
  });
  it('matches exact sphere moments for diffuse cosine convolution and roughness-one prefiltering', () => {
    const normals = [[1, 0, 0], [0, 1, 0], [0, 0, 1], unit([1, 2, -3]), unit([-2, -1, .5])];
    const q = unit([1, 2, 3]), b = .7;
    const affine = (n: readonly number[]) => [1 + .5 * n[0]!, 2 + .3 * n[1]!, .8 - .2 * n[2]!];
    const quadratic = (n: readonly number[]) => [1 + b * dot(n, q) ** 2, .8 + .4 * n[0]! * n[1]!, .5];
    const a = bakeDiffuse(affine), c = bakeDiffuse(quadratic);
    for (const n of normals) {
      const expectedA = [1 + n[0]! / 3, 2 + .2 * n[1]!, .8 - .4 / 3 * n[2]!];
      const expectedC = [1 + b / 4 * (1 + dot(n, q) ** 2), .8 + .1 * n[0]! * n[1]!, .5];
      close(evaluateDiffuse(a, n).map((v: number) => v / pi), expectedA, .00003);
      close(evaluateDiffuse(c, n).map((v: number) => v / pi), expectedC, .00003);
      close(prefilter(affine, n, 1), expectedA, .005);
      close(prefilter(quadratic, n, 1), expectedC, .005);
    }
    let area = 0; for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) area += solidAngle(x, y, 64) * 6;
    expect(Math.abs(area - 4 * pi)).toBeLessThan(1e-12);
  });
  it('uses WebGPU face signs and inverse yaw consistently for diffuse and reflected directions', () => {
    const faceVectors = [[1, -.6, .2], [-1, -.6, -.2], [-.2, 1, .6], [-.2, -1, -.6], [-.2, -.6, 1], [.2, -.6, -1]];
    faceVectors.forEach((expected, face) => close(cubeDirection(face, -.2, .6), unit(expected), 1e-12));
    const settings = snapshotEnvironment({ preset: 'studio', intensity: 2, rotationRadians: pi / 2 });
    const packed = environmentUniform(settings, 'relit');
    close([...packed.subarray(0, 5)], [2, 0, 1, 0, 1], 1e-7);
    // A +90-degree yaw carries source +X to world -Z; the lookup must map it back.
    const world = [0, 0, -1]; close([packed[1]! * world[0]! - packed[2]! * world[2]!, world[1]!, packed[2]! * world[0]! + packed[1]! * world[2]!], [1, 0, 0], 1e-7);
    expect(environmentUniform(null, 'authored')[0]).toBe(0);
  });
  it('matches independent incoming-direction quadrature and the exact roughness-one single-scatter furnace', () => {
    // Independent partitioned Gauss-Legendre integration of incoming directions using slope-domain D and Smith Lambda.
    // 16/32-point convergence for these anchors is <9e-8. The r=1 sum additionally has the exact form below.
    const anchors = [
      [1, 1, .306819205145, .000033614295], [.5, 1, .447705120411, .002988735255], [.1, 1, .736343577907, .023866894813],
      [.5, .35, .923143131646, .031206680972], [1, .06, .999986963852, .000000011568],
      [.5, .06, .968689017215, .031278242895], [.1, .06, .410669769739, .588635556161], [.02, .06, .104267680116, .876341603627],
    ];
    for (const [nv, roughness, a, b] of anchors) {
      close(dfg(nv!, roughness!), [a!, b!], .001);
      close(lookup(nv!, roughness!), [a!, b!], .009);
    }
    for (const nv of [1, .5, .1, .01]) {
      const expected = 1 - nv * Math.log1p(1 / nv), result = lookup(nv, 1);
      expect(Math.abs(result[0]! + result[1]! - expected)).toBeLessThan(.006);
    }
    // Fault controls: reversing DFG channels or using alpha in the roughness coordinate must fail these witnesses.
    const witness = lookup(.5, .35);
    expect(Math.abs(witness[1]! - .923143131646)).toBeGreaterThan(.8);
    expect(Math.abs(lookup(.5, .35 ** 2)[0]! - .923143131646)).toBeGreaterThan(.02);
    expect(Math.abs(lookup(1, 1)[0]! + lookup(1, 1)[1]! - 1)).toBeGreaterThan(.6);
  });
});
