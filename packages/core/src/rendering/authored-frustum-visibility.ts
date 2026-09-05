import { encloseAuthoredClipCorners } from './authored-frustum-enclosure.js';

/** Internal prerequisite only: no renderer calls this selector yet. */
export type AuthoredVisibilityMode = 'frustum' | 'none';
export type AuthoredClipPlane = 'left' | 'right' | 'bottom' | 'top' | 'near' | 'far';
export type AuthoredBoxClassification = 'inside' | 'boundary-or-intersecting' | 'outside' | 'unsupported' | 'not-tested';
export interface AuthoredDrawRun { readonly firstInstance: number; readonly instanceCount: number }
export interface AuthoredVisibilitySelection {
  readonly retainedIndices: readonly number[];
  readonly drawnIndices: readonly number[];
  readonly classifications: readonly AuthoredBoxClassification[];
  readonly rejectionPlanes: readonly (AuthoredClipPlane | null)[];
  readonly runs: readonly AuthoredDrawRun[];
  readonly diagnostics: Readonly<{
    candidateBoxes: number; testedBoxes: number; planeTests: number;
    rejectedBoxes: number; uncertainRetainedBoxes: number; unsupportedRetainedBoxes: number;
    retainedBoxes: number; drawnBoxes: number; skippedBoxes: number; drawCalls: number; drawnTriangles: number;
    packedInstances: number; currentModelUploadBytes: number; previousModelUploadBytes: number;
    frameUniformUploadBytes: number; totalUploadBytes: number; fallbackReason: 'run-limit' | null;
  }>;
}

const MAX_RESIDENT_BOXES = 1024;
const MAX_DRAW_RUNS = 16;
const PLANES: readonly AuthoredClipPlane[] = ['left', 'right', 'bottom', 'top', 'near', 'far'];
const bits = new DataView(new ArrayBuffer(8));

// Outward binary64 rounding for the host's clip-plane sum/difference. The GPU
// enclosure already includes GPU arithmetic; these operations happen only here.
function nextUp(value: number): number {
  if (value === Infinity || Number.isNaN(value)) return value;
  if (value === 0) return Number.MIN_VALUE;
  bits.setFloat64(0, value);
  bits.setBigUint64(0, bits.getBigUint64(0) + (value > 0 ? 1n : -1n));
  return bits.getFloat64(0);
}
function nextDown(value: number): number { return -nextUp(-value); }

function planeInterval(bounds: Float64Array, corner: number, plane: number): readonly [number, number] {
  const offset = corner * 8;
  const x0 = bounds[offset]!, y0 = bounds[offset + 1]!, z0 = bounds[offset + 2]!, w0 = bounds[offset + 3]!;
  const x1 = bounds[offset + 4]!, y1 = bounds[offset + 5]!, z1 = bounds[offset + 6]!, w1 = bounds[offset + 7]!;
  switch (plane) {
    case 0: return [nextDown(x0 + w0), nextUp(x1 + w1)];
    case 1: return [nextDown(w0 - x1), nextUp(w1 - x0)];
    case 2: return [nextDown(y0 + w0), nextUp(y1 + w1)];
    case 3: return [nextDown(w0 - y1), nextUp(w1 - y0)];
    case 4: return [z0, z1];
    default: return [nextDown(w0 - z1), nextUp(w1 - z0)];
  }
}

/**
 * Select ordered draw ranges from a complete, already admitted resident pack.
 * This is NOT scene/camera validation: callers must keep the existing authored
 * validator, including every offscreen root's +/-4096 camera-relative envelope.
 * No source IDs, buffers or current/previous history are changed or compacted.
 * Numeric inputs outside the enclosure's proof domain are retained. Malformed
 * buffer shapes/counts are programmer errors, not a new scene admission policy.
 */
export function selectAuthoredBoxVisibility(
  modelMatrices: Float32Array, viewProjection: Float32Array, mode: AuthoredVisibilityMode = 'frustum',
): AuthoredVisibilitySelection {
  if (!(modelMatrices instanceof Float32Array) || modelMatrices.length % 16 !== 0
    || modelMatrices.length > MAX_RESIDENT_BOXES * 16 || !(viewProjection instanceof Float32Array) || viewProjection.length !== 16) {
    throw new RangeError('Authored visibility requires 0–1024 packed 4x4 models and one packed 4x4 view projection.');
  }
  if (mode !== 'frustum' && mode !== 'none') throw new RangeError('Unknown internal authored visibility mode.');
  const count = modelMatrices.length / 16;
  const retained: number[] = [];
  const classifications: AuthoredBoxClassification[] = [];
  const rejectionPlanes: (AuthoredClipPlane | null)[] = [];
  let planeTests = 0, rejectedBoxes = 0, uncertainRetainedBoxes = 0, unsupportedRetainedBoxes = 0;
  for (let index = 0; index < count; index++) {
    let classification: AuthoredBoxClassification = 'not-tested';
    let rejectionPlane: AuthoredClipPlane | null = null;
    if (mode === 'frustum') {
      const enclosure = encloseAuthoredClipCorners(modelMatrices.subarray(index * 16, (index + 1) * 16), viewProjection);
      if (!enclosure.supported) {
        classification = 'unsupported';
        unsupportedRetainedBoxes++;
        uncertainRetainedBoxes++;
      } else {
        let inside = true;
        for (let plane = 0; plane < PLANES.length; plane++) {
          planeTests++;
          let commonOutside = true;
          for (let corner = 0; corner < 8; corner++) {
            const [lower, upper] = planeInterval(enclosure.bounds, corner, plane);
            // Negated comparisons keep any unexpected NaN conservatively.
            if (!(upper < 0)) commonOutside = false;
            if (!(lower > 0)) inside = false;
          }
          if (commonOutside) { rejectionPlane = PLANES[plane]!; break; }
        }
        classification = rejectionPlane !== null ? 'outside' : inside ? 'inside' : 'boundary-or-intersecting';
        if (classification === 'boundary-or-intersecting') uncertainRetainedBoxes++;
      }
    }
    classifications.push(classification);
    rejectionPlanes.push(rejectionPlane);
    if (rejectionPlane === null) retained.push(index);
    else rejectedBoxes++;
  }

  let runs: AuthoredDrawRun[] = [];
  for (const index of retained) {
    const last = runs[runs.length - 1];
    if (last && last.firstInstance + last.instanceCount === index) {
      runs[runs.length - 1] = { firstInstance: last.firstInstance, instanceCount: last.instanceCount + 1 };
    } else runs.push({ firstInstance: index, instanceCount: 1 });
  }
  const fallbackReason = runs.length > MAX_DRAW_RUNS ? 'run-limit' : null;
  const drawn = fallbackReason === null ? [...retained] : Array.from({ length: count }, (_, index) => index);
  if (fallbackReason !== null) runs = [{ firstInstance: 0, instanceCount: count }];
  const frameUniformUploadBytes = count > 0 ? 176 : 0;
  return Object.freeze({
    retainedIndices: Object.freeze(retained), drawnIndices: Object.freeze(drawn),
    classifications: Object.freeze(classifications), rejectionPlanes: Object.freeze(rejectionPlanes),
    runs: Object.freeze(runs.map(run => Object.freeze(run))),
    diagnostics: Object.freeze({
      candidateBoxes: count, testedBoxes: mode === 'frustum' ? count : 0, planeTests,
      rejectedBoxes, uncertainRetainedBoxes, unsupportedRetainedBoxes,
      retainedBoxes: retained.length, drawnBoxes: drawn.length, skippedBoxes: count - drawn.length,
      drawCalls: runs.length, drawnTriangles: drawn.length * 12,
      // Planned accounting, not executed queue traffic. Integration must continue
      // uploading/staging the complete resident current/prior packs on each try.
      packedInstances: count, currentModelUploadBytes: count * 64, previousModelUploadBytes: count * 64,
      frameUniformUploadBytes, totalUploadBytes: count * 128 + frameUniformUploadBytes, fallbackReason,
    }),
  });
}
