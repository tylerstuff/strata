/** Independent binary64 geometry/admission oracle for the shared-primary ABI.
 * No production imports, BVH traversal, or WGSL arithmetic is reused. It does
 * not model f32 reassociation or certify the inherited triangle predicate.
 */
export type PrimaryVec3 = readonly [number, number, number];
export type PrimaryState = 0 | 1 | 2 | 3 | 4;
export const primaryWire = Object.freeze({ id: 0x000fffff, guide: 0x00100000, flip: 0x00200000,
  stateShift: 22, query: 0x02000000, reserved: 0xfc000000, ready: 0x02400000 });
export const primaryReferenceGates = Object.freeze({ pointAbsolute: 3e-5, pointRelative: 3e-6,
  rhoAbsolute: 3e-4, rhoRelative: 3e-5, directionLength: 3e-5, hemisphere: 3e-6,
  depth: 2e-5, barycentricEnvelope: 2 ** -20 });
const dot = (a: PrimaryVec3, b: PrimaryVec3) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const sub = (a: PrimaryVec3, b: PrimaryVec3): PrimaryVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: PrimaryVec3, b: PrimaryVec3): PrimaryVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: PrimaryVec3): PrimaryVec3 => { const n = Math.hypot(...a); if (!(n > 0)) throw Error('Degenerate reference vector.'); return [a[0] / n, a[1] / n, a[2] / n]; };
const vector = (a: readonly number[]): PrimaryVec3 => [a[0]!, a[1]!, a[2]!];
export const primaryFloatBits = (x: number): number => new Uint32Array(new Float32Array([x]).buffer)[0]!;
export const primaryBitsFloat = (x: number): number => new Float32Array(new Uint32Array([x]).buffer)[0]!;
const bounded = (x: number, limit: number) => Number.isFinite(x) && Math.abs(x) <= limit;

export interface ReferencePrimaryRecord {
  readonly state: PrimaryState; readonly issued: boolean; readonly triangle: number;
  readonly flipped: boolean; readonly guide: boolean; readonly rho: PrimaryVec3;
  readonly point: PrimaryVec3; readonly footprint: number;
}
export function decodePrimaryRecord(words: readonly number[], triangleCount: number): ReferencePrimaryRecord | null {
  if (words.length !== 8 || words.some(w => !Number.isInteger(w) || w < 0 || w > 0xffffffff)
    || !Number.isInteger(triangleCount) || triangleCount < 1 || triangleCount > 1048576) return null;
  const identity = words[3]!, state = (identity >>> 22) & 7, issued = Boolean(identity & primaryWire.query);
  if ((identity & primaryWire.reserved) !== 0 || state > 4) return null;
  const triangle = identity & primaryWire.id, guide = Boolean(identity & primaryWire.guide), flipped = Boolean(identity & primaryWire.flip);
  const rho = vector(words.slice(0, 3).map(primaryBitsFloat)), point = vector(words.slice(4, 7).map(primaryBitsFloat));
  const footprint = primaryBitsFloat(words[7]!);
  if (state === 1) {
    if (!issued || triangle >= triangleCount || rho.some(v => !Number.isFinite(v) || v < 0 || v > 65504)
      || point.some(v => !bounded(v, 2 ** 30))) return null;
    if (guide ? !(Number.isFinite(footprint) && footprint >= 2 ** -40 && footprint <= 2 ** 20
      && point.every(v => bounded(v, 2 ** 20))) : words[7] !== 0) return null;
  } else {
    if ([0, 2].includes(state) && issued || state === 3 && !issued) return null;
    if (triangle || guide || flipped || [0, 1, 2, 4, 5, 6, 7].some(i => words[i] !== 0)) return null;
  }
  return { state: state as PrimaryState, issued, triangle, flipped, guide, rho, point, footprint };
}
export function packPrimaryRecord(record: Partial<ReferencePrimaryRecord> & { readonly state: PrimaryState }): number[] {
  const ready = record.state === 1;
  const meta = ((record.triangle ?? 0) | (record.guide ? primaryWire.guide : 0) | (record.flipped ? primaryWire.flip : 0)
    | (record.state << 22) | (record.issued ? primaryWire.query : 0)) >>> 0;
  return [...(ready ? record.rho ?? [0, 0, 0] : [0, 0, 0]).map(primaryFloatBits), meta,
    ...(ready ? record.point ?? [0, 0, 0] : [0, 0, 0]).map(primaryFloatBits), primaryFloatBits(ready && record.guide ? record.footprint ?? 1 : 0)];
}
/** First consumption only. A READY result still depends on secondary transport. */
export function primaryFirstConsumption(words: readonly number[], triangleCount: number): {
  rawStatus: number; attempted: number; exhausted: number; invalid: number; transport: boolean;
} {
  const decoded = decodePrimaryRecord(words, triangleCount);
  if (!decoded || decoded.state === 0 || decoded.state === 4) return { rawStatus: 3, attempted: 1, exhausted: 0, invalid: 1, transport: false };
  if (decoded.state === 2) return { rawStatus: 4, attempted: 0, exhausted: 0, invalid: 0, transport: false };
  if (decoded.state === 3) return { rawStatus: 2, attempted: 1, exhausted: 1, invalid: 0, transport: false };
  return { rawStatus: 0, attempted: 1, exhausted: 0, invalid: 0, transport: true };
}
export function primaryCompositionConsistent(words: readonly number[], triangleCount: number, rawStatus: number, samples: number): boolean {
  const p = decodePrimaryRecord(words, triangleCount);
  return p !== null && p.state === 1 && rawStatus === 0 && Number.isInteger(samples) && samples > 0;
}

/** The bounds are checked before division/products; this intentionally rejects
 * finite inputs whose proposed operation has not been admitted by v2. */
export function referenceUnproject(h: readonly number[]): PrimaryVec3 | null {
  if (h.length !== 4 || h.some(x => !bounded(x, 2 ** 33))) return null;
  const w = h[3]!;
  if (Math.abs(w) < 2 ** -30 || h.slice(0, 3).some(x => Math.abs(x) > Math.abs(w) * 2 ** 30)) return null;
  const result = vector(h.slice(0, 3).map(x => x / w));
  return result.every(x => bounded(x, 2 ** 30)) ? result : null;
}
export function referenceClipSegment(near: PrimaryVec3, far: PrimaryVec3): { direction: PrimaryVec3; distance: number } | null {
  if (![...near, ...far].every(x => bounded(x, 2 ** 30))) return null;
  const delta = sub(far, near), square = dot(delta, delta);
  if (!(square >= 2 ** -60 && square < 2 ** 64)) return null;
  const distance = Math.sqrt(square), direction = vector(delta.map(x => x / distance));
  if (!(distance >= 2 ** -30 && distance <= 2 ** 32) || !direction.every(x => bounded(x, 2))) return null;
  return { direction, distance };
}
export function referenceWeights(u: number, v: number): PrimaryVec3 | null {
  if (!bounded(u, 2) || !bounded(v, 2)) return null;
  const result: PrimaryVec3 = [1 - u - v, u, v], e = 2 ** -20;
  return result.every(x => x >= -e && x <= 1 + e) ? result : null;
}
export function referenceRho(base: PrimaryVec3, factor: PrimaryVec3, colors: readonly PrimaryVec3[], weights: PrimaryVec3,
  metallicSample: number, metallicFactor: number): PrimaryVec3 | null {
  if (colors.length !== 3 || colors.some(c => c.some(x => !bounded(x, 2 ** 30)))
    || ![...base, ...factor, metallicSample, metallicFactor].every(x => Number.isFinite(x) && x >= 0 && x <= 1)
    || weights.some(x => !Number.isFinite(x) || x < -(2 ** -20) || x > 1 + 2 ** -20)) return null;
  const color = vector([0, 1, 2].map(c => colors.reduce((sum, v, i) => sum + weights[i]! * v[c]!, 0)));
  if (!color.every(x => Number.isFinite(x) && x >= 0 && x <= 2 ** 33)) return null;
  const rho = vector(base.map((b, c) => b * factor[c]! * color[c]! * (1 - metallicSample * metallicFactor)));
  return rho.every(x => Number.isFinite(x) && x >= 0 && x <= 65504) ? rho : null;
}
export const referenceSrgb = (byte: number): number => { const x = byte / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; };

export interface ReferencePrimaryCamera {
  readonly inverse: readonly number[]; readonly projection: readonly number[];
  readonly ray: (x: number, y: number, width: number, height: number) => { near: PrimaryVec3; far: PrimaryVec3 };
}
export function referencePrimaryCamera(options: { eye: PrimaryVec3; target: PrimaryVec3; up: PrimaryVec3; near: number; far: number;
  aspect?: number; halfHeight?: number; verticalFov?: number }): ReferencePrimaryCamera {
  const { eye, near, far } = options, forward = unit(sub(options.target, eye));
  const right = unit(cross(forward, options.up)), up = cross(right, forward), aspect = options.aspect ?? 1;
  const perspective = options.verticalFov !== undefined, h = perspective ? Math.tan(options.verticalFov! / 2) : options.halfHeight!;
  if (!(near > 0 && far > near && h > 0 && aspect > 0)) throw Error('Invalid analytic camera.');
  const projection = new Array<number>(16).fill(0), inverse = new Array<number>(16).fill(0);
  for (let i = 0; i < 3; i++) {
    projection[i * 4] = right[i]! / (h * aspect); projection[i * 4 + 1] = up[i]! / h;
    projection[i * 4 + 2] = forward[i]! * (perspective ? far : 1) / (far - near);
    projection[i * 4 + 3] = perspective ? forward[i]! : 0;
    inverse[i] = right[i]! * h * aspect; inverse[4 + i] = up[i]! * h;
    inverse[8 + i] = perspective ? eye[i]! * (1 / far - 1 / near) : forward[i]! * (far - near);
    inverse[12 + i] = perspective ? eye[i]! / near + forward[i]! : eye[i]! + forward[i]! * near;
  }
  projection[12] = -dot(right, eye) / (h * aspect); projection[13] = -dot(up, eye) / h;
  projection[14] = -(dot(forward, eye) * (perspective ? far : 1) + (perspective ? near * far : near)) / (far - near);
  projection[15] = perspective ? -dot(forward, eye) : 1;
  inverse[11] = perspective ? 1 / far - 1 / near : 0; inverse[15] = perspective ? 1 / near : 1;
  return { projection, inverse, ray(x, y, width, height) {
    const xx = (2 * (x + .5) / width - 1) * h * aspect, yy = (1 - 2 * (y + .5) / height) * h;
    const endpoint = (depth: number): PrimaryVec3 => vector(eye.map((e, i) => e + forward[i]! * depth
      + (right[i]! * xx + up[i]! * yy) * (perspective ? depth : 1)));
    return { near: endpoint(near), far: endpoint(far) };
  } };
}
/** Plane intersection plus a binary64 Gram solve, independent of the runtime's
 * dominant-axis shear triangle predicate. Used only away from shared edges. */
export function referencePrimaryHit(ray: { near: PrimaryVec3; far: PrimaryVec3 }, triangle: readonly [PrimaryVec3, PrimaryVec3, PrimaryVec3],
  doubleSided: boolean): { point: PrimaryVec3; normal: PrimaryVec3; weights: PrimaryVec3; flipped: boolean; fraction: number } | null {
  const [a, b, c] = triangle, e1 = sub(b, a), e2 = sub(c, a), normal = unit(cross(e1, e2));
  const direction = sub(ray.far, ray.near), denominator = dot(normal, direction);
  if (denominator === 0 || (!doubleSided && denominator >= 0)) return null;
  const fraction = dot(normal, sub(a, ray.near)) / denominator;
  if (fraction < 0 || fraction > 1) return null;
  const point = vector(ray.near.map((v, i) => v + fraction * direction[i]!)), delta = sub(point, a);
  const aa = dot(e1, e1), ab = dot(e1, e2), bb = dot(e2, e2), determinant = aa * bb - ab * ab;
  const u = (dot(delta, e1) * bb - dot(delta, e2) * ab) / determinant;
  const v = (dot(delta, e2) * aa - dot(delta, e1) * ab) / determinant;
  if (u < -1e-12 || v < -1e-12 || u + v > 1 + 1e-12) return null;
  const flipped = denominator > 0;
  return { point, normal: flipped ? vector(normal.map(v => -v)) : normal, weights: [1 - u - v, u, v], flipped, fraction };
}
