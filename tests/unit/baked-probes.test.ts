import { expect, it } from 'vitest';
import { prepareBakedProbes, type BakedProbeVolume } from '../../packages/core/src/imported/baked-probes.js';
const volume = (): BakedProbeVolume => ({ version: 1, revision: 'test-v1', origin: [-1,-1,-1], spacing: [2,2,2], counts: [2,2,2], irradiance: Array(144).fill(.25), visibility: Array(2048).fill(10), valid: Array(8).fill(1) });
it('snapshots six directional lobes and visibility without modifying caller arrays', () => {
  const input = volume(), packed = prepareBakedProbes(input);
  (input.irradiance as number[])[0] = 99;
  expect(packed.data[0]).toBe(.25); expect(packed.data[3]).toBe(1); expect(packed.data[24]).toBe(10);
  expect(packed.data.length).toBe(8*280); expect(packed.uniform[12]).toBe(1);
});
it('rejects malformed, stale-format, nonfinite, overflowing and incomplete probe payloads', () => {
  for (const patch of [{version:2},{revision:''},{counts:[1,2,2]},{counts:[64,64,64]},{spacing:[0,2,2]}, {origin:[Infinity,0,0]}, {visibility:[1]}, {valid:Array(8).fill(.5)}, {irradiance:Array(144).fill(NaN)}]) {
    expect(() => prepareBakedProbes({...volume(),...patch} as BakedProbeVolume)).toThrow();
  }
});
