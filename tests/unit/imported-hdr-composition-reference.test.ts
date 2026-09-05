import { describe, expect, it } from 'vitest';
import { importedHdrCompositionWitness as witness, isFiniteHalfRgb } from '../helpers/imported-hdr-composition-reference.js';

describe('independent bright-emissive composition witness', () => {
  it('requires a valid two-sample estimator whose sum exceeds half storage', () => {
    expect(isFiniteHalfRgb(witness.emission)).toBe(true);
    expect(witness.emission.map(value => value * witness.samples)).toEqual(witness.rawSum);
    expect(isFiniteHalfRgb(witness.rawSum)).toBe(false);
    expect(witness.emission.map((value, channel) => value + witness.rawSum[channel]! / witness.samples)).toEqual(witness.unboundedComposition);
    expect(isFiniteHalfRgb(witness.unboundedComposition)).toBe(false);
    expect(isFiniteHalfRgb(witness.storedComposition)).toBe(true);
    expect(witness.unboundedComposition.slice(1)).toEqual(witness.storedComposition.slice(1));
  });
  it('pins exact source half values and independent high-precision presentation expectations', () => {
    const decoded = witness.directHalfWords.map(word => 2 ** ((word >> 10) - 15) * (1 + (word & 1023) / 1024));
    expect(decoded).toEqual([...witness.emission, witness.alpha]);
    const present = (value: number) => {
      const x = value * 2 ** witness.exposureEV;
      const y = Math.min(1, (2.51 * x ** 2 + 0.03 * x) / (2.43 * x ** 2 + 0.59 * x + 0.14));
      return y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (5 / 12) - 0.055;
    };
    witness.storedComposition.forEach((value, channel) => expect(present(value)).toBeCloseTo(witness.presentedRgb[channel]!, 14));
    expect(present(80000)).toBeCloseTo(witness.unclippedPresentedRed, 14);
    expect(witness.unclippedPresentedRed - witness.presentedRgb[0]).toBeGreaterThan(0.019);
    for (const invalid of [[NaN, 1, 2], [Infinity, 0, 0], [-1, 0, 0], [1, 2]]) expect(isFiniteHalfRgb(invalid)).toBe(false);
  });
});
