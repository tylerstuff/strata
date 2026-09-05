/** Generated finite-input witness, independent of runtime/shader code.
 * A closed white Lambertian enclosure emits the same radiance on every surface.
 * With sun/environment off, every cosine sample returns exactly that emission.
 * Two samples may exceed binary16 in the raw float32 sum without exceeding the
 * per-sample bound. Only the final direct + mean storage clips the red channel.
 */
export const importedHdrCompositionWitness = {
  emission: [40000, 20000, 2],
  directHalfWords: [0x78e2, 0x74e2, 0x4000, 0x3a00],
  rawSum: [80000, 40000, 4],
  unboundedComposition: [80000, 40000, 4],
  storedComposition: [65504, 40000, 4],
  alpha: 0.75,
  samples: 2,
  exposureEV: -16,
  // 50-decimal-digit evaluation of the specified fitted ACES curve followed by
  // IEC sRGB. Inputs are the exact stored half values above, divided by 65536.
  presentedRgb: [0.9081788321160902, 0.8424948288274155, 0.00016979941861755563],
  unclippedPresentedRed: 0.9274426473910688,
} as const;

/** Storage admission predicate, not an implementation of composition. */
export function isFiniteHalfRgb(rgb: readonly number[]): boolean {
  return rgb.length === 3 && rgb.every(value => Number.isFinite(value) && value >= 0 && value <= 65504);
}
