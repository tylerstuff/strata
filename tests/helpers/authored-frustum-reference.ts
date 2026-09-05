/**
 * Independent exact-real geometric oracle, never a GPU rounding simulation.
 * Decode finite binary inputs as BigInt rationals, transform the twelve surface
 * triangles, then Sutherland–Hodgman clip each triangle against all six planes.
 * No selector, support bound, production matrix helper, epsilon or division by w
 * is used. A nonempty zero-area polygon counts as a tangent and must be retained.
 * A box containing the whole frustum can have no intersecting surface triangles;
 * that result is not permission to reject it (the selector is conservative).
 */
type Rational = readonly [numerator: bigint, denominator: bigint];
type ExactPoint = readonly [Rational, Rational, Rational, Rational];
export type FrustumClipPoint = readonly [number, number, number, number];
const ZERO: Rational = [0n, 1n];
const ONE: Rational = [1n, 1n];

function fraction(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new RangeError('An exact rational denominator cannot be zero.');
  if (numerator === 0n) return ZERO;
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  let left = numerator < 0n ? -numerator : numerator;
  let right = denominator;
  while (right !== 0n) { const next = left % right; left = right; right = next; }
  return [numerator / left, denominator / left];
}
function add(a: Rational, b: Rational): Rational { return fraction(a[0] * b[1] + b[0] * a[1], a[1] * b[1]); }
function subtract(a: Rational, b: Rational): Rational { return fraction(a[0] * b[1] - b[0] * a[1], a[1] * b[1]); }
function multiply(a: Rational, b: Rational): Rational { return fraction(a[0] * b[0], a[1] * b[1]); }
function divide(a: Rational, b: Rational): Rational { return fraction(a[0] * b[1], a[1] * b[0]); }

/** Exact binary64 decoding also exactly represents every finite f32 input. */
function exact(value: number): Rational {
  if (!Number.isFinite(value)) throw new RangeError('The exact oracle requires finite inputs.');
  if (value === 0) return ZERO;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const mantissa = (bits & ((1n << 52n) - 1n)) + (exponent === 0 ? 0n : 1n << 52n);
  const signed = bits >> 63n ? -mantissa : mantissa;
  const power = (exponent === 0 ? -1022 : exponent - 1023) - 52;
  return power >= 0 ? fraction(signed << BigInt(power), 1n) : fraction(signed, 1n << BigInt(-power));
}

function distance(point: ExactPoint, plane: number): Rational {
  switch (plane) {
    case 0: return add(point[3], point[0]);
    case 1: return subtract(point[3], point[0]);
    case 2: return add(point[3], point[1]);
    case 3: return subtract(point[3], point[1]);
    case 4: return point[2];
    case 5: return subtract(point[3], point[2]);
    default: throw new RangeError('Unknown homogeneous clip plane.');
  }
}

function clipPolygon(input: readonly ExactPoint[]): readonly ExactPoint[] {
  let polygon = input;
  for (let plane = 0; plane < 6 && polygon.length !== 0; plane++) {
    const output: ExactPoint[] = [];
    let previous = polygon[polygon.length - 1]!;
    let previousDistance = distance(previous, plane);
    for (const current of polygon) {
      const currentDistance = distance(current, plane);
      const previousInside = previousDistance[0] >= 0n;
      const currentInside = currentDistance[0] >= 0n;
      if (currentInside !== previousInside) {
        const t = divide(previousDistance, subtract(previousDistance, currentDistance));
        output.push(previous.map((component, axis) =>
          add(component, multiply(t, subtract(current[axis]!, component)))) as unknown as ExactPoint);
      }
      if (currentInside) output.push(current);
      previous = current;
      previousDistance = currentDistance;
    }
    polygon = output;
  }
  return polygon;
}

export function exactTriangleClipVertexCount(points: readonly FrustumClipPoint[]): number {
  if (points.length !== 3 || points.some(point => point.length !== 4)) throw new RangeError('Expected three homogeneous vertices.');
  return clipPolygon(points.map(point => point.map(exact) as unknown as ExactPoint)).length;
}

function matrixPoint(matrix: readonly Rational[], point: ExactPoint): ExactPoint {
  return [0, 1, 2, 3].map(row => point.reduce((sum, value, column) =>
    add(sum, multiply(matrix[column * 4 + row]!, value)), ZERO)) as unknown as ExactPoint;
}

// The eight bit-indexed corners and faces are defined here independently of the
// renderer's 24 normal-split vertices. Winding is immaterial to closed clipping.
const localCorners: readonly ExactPoint[] = Array.from({ length: 8 }, (_, index) => [
  [index & 1 ? 1n : -1n, 2n], [index & 2 ? 1n : -1n, 2n], [index & 4 ? 1n : -1n, 2n], ONE,
]);
const triangles = [
  [0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5],
  [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6],
  [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3],
] as const;

export interface ExactBoxClipResult {
  readonly intersectsSurface: boolean;
  readonly intersectingTriangles: number;
  readonly insideCorners: number;
  readonly clippedTriangleVertexCounts: readonly number[];
}

export function exactPackedBoxClip(model: ArrayLike<number>, viewProjection: ArrayLike<number>): ExactBoxClipResult {
  if (model.length !== 16 || viewProjection.length !== 16) throw new RangeError('Expected two complete 4×4 matrices.');
  const m = Array.from(model, exact);
  const vp = Array.from(viewProjection, exact);
  const points = localCorners.map(point => matrixPoint(vp, matrixPoint(m, point)));
  const clippedTriangleVertexCounts = triangles.map(indices => clipPolygon(indices.map(index => points[index]!)).length);
  const intersectingTriangles = clippedTriangleVertexCounts.filter(count => count !== 0).length;
  return {
    intersectsSurface: intersectingTriangles !== 0,
    intersectingTriangles,
    insideCorners: points.filter(point => Array.from({ length: 6 }, (_, plane) => distance(point, plane)[0] >= 0n).every(Boolean)).length,
    clippedTriangleVertexCounts,
  };
}
