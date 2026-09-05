/** Shared thresholds for the shader and its CPU reference acceptance checks. */
export const temporalAbsoluteDepthTolerance = 0.02;
export const temporalRelativeDepthTolerance = 0.02;
export const temporalHistoryWeight = 0.9;

function depthMatches(expectedDepth: number, historyDepth: number): boolean {
  return Number.isFinite(expectedDepth) && Number.isFinite(historyDepth) && expectedDepth > 0 && historyDepth > 0
    && Math.abs(historyDepth - expectedDepth) <= Math.max(
      temporalAbsoluteDepthTolerance, temporalRelativeDepthTolerance * expectedDepth,
    );
}

/** Reference for the raster motion channel contract; coordinates are top-down UV. */
export function acceptsTemporalHistory(
  currentUv: readonly [number, number],
  motion: readonly [number, number, number, number],
  historyDepth: number,
): boolean {
  if (![...currentUv, ...motion, historyDepth].every(Number.isFinite)) return false;
  const previousU = currentUv[0] + motion[0];
  const previousV = currentUv[1] + motion[1];
  if (previousU < 0 || previousU >= 1 || previousV < 0 || previousV >= 1
    || motion[2] <= 0 || motion[3] <= 0 || historyDepth <= 0) return false;
  return depthMatches(motion[3], historyDepth);
}

type HistoryTap = readonly [number, number, number, number];

/** CPU reference for depth-qualified taps ordered top-left, top-right, bottom-left, bottom-right. */
export function blendDepthQualifiedHistory(
  taps: readonly [HistoryTap, HistoryTap, HistoryTap, HistoryTap],
  fraction: readonly [number, number],
  expectedDepth: number,
): readonly [number, number, number] | null {
  if (!fraction.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return null;
  const [x, y] = fraction;
  const weights = [(1 - x) * (1 - y), x * (1 - y), (1 - x) * y, x * y];
  const sum = [0, 0, 0];
  let totalWeight = 0;
  taps.forEach((tap, index) => {
    const weight = weights[index]!;
    if (weight > 0 && depthMatches(expectedDepth, tap[3])) {
      for (let channel = 0; channel < 3; channel++) sum[channel]! += tap[channel]! * weight;
      totalWeight += weight;
    }
  });
  return totalWeight > 0 ? [sum[0]! / totalWeight, sum[1]! / totalWeight, sum[2]! / totalWeight] : null;
}

export interface ReconstructedTemporalHistory {
  readonly color: readonly [number, number, number];
  readonly filter: 'catmull-rom' | 'bilinear';
  readonly acceptedBilinearWeight: number;
  readonly historyWeight: number;
}

/**
 * CPU reference for a clamped 4x4 history footprint, row-major at base + [-1..2].
 * Signed Catmull–Rom requires every nonzero tap to match depth. Otherwise the
 * central positive bilinear support determines both reconstruction and feedback.
 * Current-neighborhood color clipping is applied separately by the GPU resolve.
 */
export function reconstructTemporalHistory(
  taps: readonly HistoryTap[], fraction: readonly [number, number], expectedDepth: number,
): ReconstructedTemporalHistory | null {
  if (taps.length !== 16 || !fraction.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return null;
  const [x, y] = fraction;
  const central = [taps[5]!, taps[6]!, taps[9]!, taps[10]!] as const;
  const bilinear = blendDepthQualifiedHistory(central, fraction, expectedDepth);
  if (!bilinear) return null;
  const weights = [(1 - x) * (1 - y), x * (1 - y), (1 - x) * y, x * y];
  const support = central.reduce((sum, tap, index) => sum + (depthMatches(expectedDepth, tap[3]) ? weights[index]! : 0), 0);
  const cubic = (f: number) => [
    -0.5 * f + f * f - 0.5 * f ** 3, 1 - 2.5 * f * f + 1.5 * f ** 3,
    0.5 * f + 2 * f * f - 1.5 * f ** 3, -0.5 * f * f + 0.5 * f ** 3,
  ];
  const horizontal = cubic(x); const vertical = cubic(y);
  const color: [number, number, number] = [0, 0, 0];
  let cubicValid = true;
  taps.forEach((tap, index) => {
    const weight = horizontal[index % 4]! * vertical[Math.floor(index / 4)]!;
    if (weight === 0) return;
    if (!depthMatches(expectedDepth, tap[3])) { cubicValid = false; return; }
    for (let channel = 0; channel < 3; channel++) color[channel]! += tap[channel]! * weight;
  });
  return {
    color: cubicValid ? color : bilinear, filter: cubicValid ? 'catmull-rom' : 'bilinear',
    acceptedBilinearWeight: support, historyWeight: temporalHistoryWeight * Math.max(0, Math.min(1, support)),
  };
}
