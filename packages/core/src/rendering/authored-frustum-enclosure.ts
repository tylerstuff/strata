/** Internal CPU prerequisite only; this does not enable renderer culling. */
export type AuthoredClipEnclosure =
  | { readonly supported: true; readonly bounds: Float64Array }
  | { readonly supported: false; readonly reason: string };

// See docs/authored-frustum-enclosure.md for the arithmetic-domain and error proof.
// These are selection eligibility bounds, never authored-scene admission limits.
const MIN_NONZERO_COEFFICIENT = 2 ** -30;
const MAX_COEFFICIENT = 2 ** 20;
const DIRECTED_F32_UNIT_ROUNDOFF = 2 ** -23;
const EXPANDED_OPERATION_COUNT = 47;
const binary64 = new DataView(new ArrayBuffer(8));

/** Adjacent binary64 value, also for negative values and either signed zero. */
function nextUp(value: number): number {
  if (value === 0) return Number.MIN_VALUE;
  binary64.setFloat64(0, value, false);
  const bits = binary64.getBigUint64(0, false);
  binary64.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n, false);
  return binary64.getFloat64(0, false);
}

function nextDown(value: number): number {
  return -nextUp(-value);
}

// Count*u and 1-Count*u are exact binary64 values; step above the rounded quotient.
const errorProduct = EXPANDED_OPERATION_COUNT * DIRECTED_F32_UNIT_ROUNDOFF;
const GAMMA = nextUp(errorProduct / (1 - errorProduct));

/**
 * Enclose all permitted rounded values of the authored vertex expression
 * viewProjection * (model * vec4f(position, 1)), for the eight unit-box corners.
 *
 * Matrices are the actual packed column-major f32 inputs, not f64 scene transforms.
 * Corner bits 0/1/2 choose +0.5 on x/y/z; unset bits choose -0.5.
 * Each eight-number record is [loX,loY,loZ,loW,hiX,hiY,hiZ,hiW].
 * Unsupported input must be retained by any caller; this is not scene validation.
 */
export function encloseAuthoredClipCorners(
  model: Float32Array,
  viewProjection: Float32Array,
): AuthoredClipEnclosure {
  if (!(model instanceof Float32Array) || !(viewProjection instanceof Float32Array)) {
    return { supported: false, reason: 'packed-matrix-type' };
  }
  if (typeof SharedArrayBuffer !== 'undefined'
    && (model.buffer instanceof SharedArrayBuffer || viewProjection.buffer instanceof SharedArrayBuffer)) {
    return { supported: false, reason: 'shared-matrix-buffer' };
  }
  if (model.length !== 16 || viewProjection.length !== 16) {
    return { supported: false, reason: 'matrix-length' };
  }
  for (const matrix of [model, viewProjection]) {
    for (const coefficient of matrix) {
      if (!Number.isFinite(coefficient)) return { supported: false, reason: 'nonfinite-coefficient' };
      const magnitude = Math.abs(coefficient);
      if (magnitude !== 0 && (magnitude < MIN_NONZERO_COEFFICIENT || magnitude > MAX_COEFFICIENT)) {
        return { supported: false, reason: 'coefficient-outside-proof-domain' };
      }
    }
  }

  const bounds = new Float64Array(64);
  for (let corner = 0; corner < 8; corner++) {
    const point = [corner & 1 ? 0.5 : -0.5, corner & 2 ? 0.5 : -0.5, corner & 4 ? 0.5 : -0.5, 1];
    for (let row = 0; row < 4; row++) {
      let exactLo = 0, exactHi = 0, absoluteSum = 0;
      for (let j = 0; j < 4; j++) {
        for (let k = 0; k < 4; k++) {
          // Two binary32 significands use at most 48 bits. Multiplication by
          // +/-0.5 or 1 only changes the exponent: each term is exact binary64.
          const term = viewProjection[j * 4 + row]! * model[k * 4 + j]! * point[k]!;
          if (term === 0) continue;
          exactLo = nextDown(exactLo + term);
          exactHi = nextUp(exactHi + term);
          absoluteSum = nextUp(absoluteSum + Math.abs(term));
        }
      }
      // Zero polynomial stays zero under every allowed operation ordering.
      if (absoluteSum === 0) continue;
      const radius = nextUp(GAMMA * absoluteSum);
      bounds[corner * 8 + row] = nextDown(exactLo - radius);
      bounds[corner * 8 + 4 + row] = nextUp(exactHi + radius);
    }
  }
  return { supported: true, bounds };
}
