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
