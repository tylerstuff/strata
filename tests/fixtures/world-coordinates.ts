/**
 * Test data and an independent exact-transform/pinhole oracle for issue #18.
 * This is not a runtime descriptor, packer, renderer or browser-validation result.
 * No production/prototype math is imported. Public fixtures are JSON-serializable;
 * their ideal rational definitions stay private so Number input rounding is tested.
 */
export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];
export interface FixtureBox {
  readonly id: string;
  /** Full lengths of a unit box with template coordinates in [-0.5,0.5]. */
  readonly dimensions: Vec3;
  readonly transform: { readonly position: Vec3; readonly rotation: Quat; readonly scale: Vec3 };
  readonly material: { readonly baseColor: Vec3; readonly roughness: number; readonly metallic: number };
}
export interface FixtureFrame {
  readonly id: string;
  readonly sequence: string;
  readonly index: number;
  /** Scene replacement requires a fresh runtime receipt/generation in a future browser harness. */
  readonly event: 'continuous' | 'camera-cut' | 'teleport' | 'scene-replacement';
  readonly variant: 'dyadic' | 'decimal';
  /** Far clusters intentionally exceed the initial runtime's 4096 m local-extent cap. */
  readonly scope: 'resident-preview-reference' | 'numeric-only-far-clusters';
  /** Camera's global anchor; teleport frames retain all three preplaced clusters. */
  readonly offset: Vec3;
  readonly camera: { readonly position: Vec3; readonly rotation: Quat };
  readonly boxes: readonly FixtureBox[];
  readonly viewport: { readonly width: number; readonly height: number };
  readonly perspective: { readonly verticalFovRadians: number; readonly aspect: number; readonly near: number; readonly far: number };
}

interface Fraction { readonly n: bigint; readonly d: bigint }
type Exact3 = readonly [Fraction, Fraction, Fraction];
type Exact4 = readonly [Fraction, Fraction, Fraction, Fraction];
type ExactMatrix = readonly [Exact3, Exact3, Exact3]; // rows, unlike production column-major matrices
interface ExactBox { readonly id: string; readonly dimensions: Exact3; readonly position: Exact3; readonly rotation: Exact4; readonly scale: Exact3; readonly material: FixtureBox['material'] }
interface ExactFrame { readonly frame: FixtureFrame; readonly cameraPosition: Exact3; readonly cameraRotation: Exact4; readonly boxes: readonly ExactBox[] }

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  return a;
}
function q(n: number | bigint, d: number | bigint = 1): Fraction {
  let numerator = BigInt(n); let denominator = BigInt(d);
  if (denominator === 0n) throw new RangeError('Zero rational denominator');
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  const divisor = gcd(numerator, denominator);
  return { n: numerator / divisor, d: denominator / divisor };
}
const add = (a: Fraction, b: Fraction): Fraction => q(a.n * b.d + b.n * a.d, a.d * b.d);
const negate = (a: Fraction): Fraction => q(-a.n, a.d);
const sub = (a: Fraction, b: Fraction): Fraction => add(a, negate(b));
const mul = (a: Fraction, b: Fraction): Fraction => q(a.n * b.n, a.d * b.d);
const div = (a: Fraction, b: Fraction): Fraction => q(a.n * b.d, a.d * b.n);
const value = (a: Fraction): number => Number(a.n) / Number(a.d);
const numbers = (a: Exact3): Vec3 => [value(a[0]), value(a[1]), value(a[2])];
const quaternion = (a: Exact4): Quat => [value(a[0]), value(a[1]), value(a[2]), value(a[3])];
const zero = q(0); const one = q(1); const two = q(2);
const zero3: Exact3 = [zero, zero, zero];
const one3: Exact3 = [one, one, one];
const identity: Exact4 = [zero, zero, zero, one];
const yawCamera: Exact4 = [zero, q(40, 401), zero, q(399, 401)];
const plus = (a: Exact3, b: Exact3): Exact3 => [add(a[0], b[0]), add(a[1], b[1]), add(a[2], b[2])];
const minus = (a: Exact3, b: Exact3): Exact3 => [sub(a[0], b[0]), sub(a[1], b[1]), sub(a[2], b[2])];
const scale = (a: Exact3, b: Exact3): Exact3 => [mul(a[0], b[0]), mul(a[1], b[1]), mul(a[2], b[2])];
const dot = (a: Exact3, b: Exact3): Fraction => add(add(mul(a[0], b[0]), mul(a[1], b[1])), mul(a[2], b[2]));

/** Quaternion coefficients and all transforms are rational, with no float matrix products. */
function rotation([x, y, z, w]: Exact4): ExactMatrix {
  const norm = add(add(mul(x, x), mul(y, y)), add(mul(z, z), mul(w, w)));
  if (norm.n !== norm.d) throw new RangeError('Fixture quaternion must be exactly unit length');
  const twice = (a: Fraction): Fraction => mul(two, a);
  return [
    [sub(one, twice(add(mul(y, y), mul(z, z)))), twice(sub(mul(x, y), mul(z, w))), twice(add(mul(x, z), mul(y, w)))],
    [twice(add(mul(x, y), mul(z, w))), sub(one, twice(add(mul(x, x), mul(z, z)))), twice(sub(mul(y, z), mul(x, w)))],
    [twice(sub(mul(x, z), mul(y, w))), twice(add(mul(y, z), mul(x, w))), sub(one, twice(add(mul(x, x), mul(y, y))))],
  ];
}
const apply = (m: ExactMatrix, p: Exact3): Exact3 => [dot(m[0], p), dot(m[1], p), dot(m[2], p)];
const transpose = (m: ExactMatrix): ExactMatrix => [
  [m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]],
];

function freeze<T>(object: T): T {
  if (typeof object === 'object' && object !== null && !Object.isFrozen(object)) {
    for (const child of Object.values(object)) freeze(child);
    Object.freeze(object);
  }
  return object;
}

const offset3 = (offset: number): Exact3 => [q(offset), q(-offset), q(offset)];
const offsetId = (offset: number): string => offset === 0 ? 'origin' : `${offset < 0 ? 'neg' : 'pos'}-${Math.abs(offset)}m`;
const materials: readonly FixtureBox['material'][] = [
  { baseColor: [0.8, 0.1, 0.1], roughness: 0.8, metallic: 0 },
  { baseColor: [0.1, 0.2, 0.8], roughness: 0.8, metallic: 0 },
  { baseColor: [0.7, 0.6, 0.1], roughness: 0.25, metallic: 0.75 },
  { baseColor: [0.1, 0.8, 0.2], roughness: 0.8, metallic: 0 },
  { baseColor: [0.7, 0.1, 0.7], roughness: 0.5, metallic: 0.25 },
];

function boxesAt(anchor: Exact3, variant: FixtureFrame['variant'], prefix = ''): ExactBox[] {
  // Dyadic width=1/64 m and gap=1/1024 m; decimal width=2 cm and gap=1 mm.
  // Both gaps project to less than one pixel here. Numeric separation must not
  // be misreported as proof of an empty raster pixel between their silhouettes.
  const halfSpacing = variant === 'dyadic' ? q(17, 2048) : q(21, 2000);
  const side = variant === 'dyadic' ? q(1, 64) : q(1, 50);
  const definitions: readonly [string, Exact3, Exact3, Exact4, Exact3][] = [
    ['gap-left', [negate(halfSpacing), zero, q(-1)], [side, side, side], identity, one3],
    ['gap-right', [halfSpacing, zero, q(-1)], [side, side, side], identity, one3],
    ['rotated', [q(1, 4), q(1, 8), q(-3, 2)], [q(1, 8), q(1, 16), q(3, 32)],
      variant === 'dyadic' ? [q(1, 2), q(1, 2), q(1, 2), q(1, 2)] : [zero, zero, q(3, 5), q(4, 5)], [q(2), q(3), q(1, 2)]],
    ['occluder', [q(-1, 4), q(-1, 8), q(-2)], [q(1, 8), q(1, 8), q(1, 8)], identity, one3],
    ['occluded', [q(-3, 8), q(-3, 16), q(-3)], [q(3, 16), q(3, 16), q(3, 16)], identity, one3],
  ];
  return definitions.map(([id, position, dimensions, orientation, rootScale], index) => ({
    id: prefix + id, position: plus(anchor, position), dimensions, rotation: orientation, scale: rootScale, material: materials[index]!,
  }));
}

const exactFrames = new Map<string, ExactFrame>();
function addFrame(sequence: string, index: number, event: FixtureFrame['event'], offset: number,
  variant: FixtureFrame['variant'], localCamera: Exact3 = zero3, cameraRotation: Exact4 = identity,
  sceneBoxes: readonly ExactBox[] = boxesAt(offset3(offset), variant),
): void {
  const id = `${sequence}/${index}`;
  if (exactFrames.has(id)) throw new Error(`Duplicate fixture ID ${id}`);
  const cameraPosition = plus(offset3(offset), localCamera);
  const frame: FixtureFrame = freeze({
    id, sequence, index, event, variant, offset: numbers(offset3(offset)),
    scope: sequence === 'teleport-dyadic' ? 'numeric-only-far-clusters' : 'resident-preview-reference',
    camera: { position: numbers(cameraPosition), rotation: quaternion(cameraRotation) },
    boxes: sceneBoxes.map(box => ({ id: box.id, dimensions: numbers(box.dimensions), material: { ...box.material },
      transform: { position: numbers(box.position), rotation: quaternion(box.rotation), scale: numbers(box.scale) } })),
    viewport: { width: 512, height: 512 },
    perspective: { verticalFovRadians: 55 * Math.PI / 180, aspect: 1, near: 0.1, far: 32 },
  });
  exactFrames.set(id, { frame, cameraPosition, cameraRotation, boxes: sceneBoxes });
}

for (const variant of ['dyadic', 'decimal'] as const) {
  for (const offset of [0, 1_000, -1_000, 10_000, -10_000, 100_000, -100_000, 1_000_000, -1_000_000]) {
    addFrame(`static-${variant}-${offsetId(offset)}`, 0, 'continuous', offset, variant,
      zero3, variant === 'decimal' ? yawCamera : identity);
  }
  for (const offset of [0, 1_000_000, -1_000_000]) {
    const sequence = `slow-${variant}-${offsetId(offset)}`;
    for (let index = 0; index < 32; index++) {
      addFrame(sequence, index, 'continuous', offset, variant, [q(index - 16, variant === 'dyadic' ? 1024 : 1000), zero, zero]);
    }
  }
}
// Two slow passes across one derived 1024 m cell boundary, without moving roots.
for (let index = 0; index < 32; index++) {
  const step = index < 16 ? index - 8 : 23 - index;
  addFrame('boundary-dyadic', index, 'continuous', 999_936, 'dyadic', [q(step, 1024), zero, zero]);
}
addFrame('camera-cut-dyadic', 0, 'continuous', 1_000_000, 'dyadic');
addFrame('camera-cut-dyadic', 1, 'camera-cut', 1_000_000, 'dyadic', [q(1, 16), zero, zero], yawCamera);

// All 15 roots stay fixed through camera teleports. Off-cluster boxes are beyond
// the fixed far plane; only the local five-box cluster is inside the clip volume.
// This is numeric stress, not an admissible resident-preview descriptor: a later
// browser must reject its local range or explicitly replace resident snapshots.
const clusters = [0, 1_000_000, -1_000_000].flatMap(offset => boxesAt(offset3(offset), 'dyadic', `${offsetId(offset)}:`));
for (const [index, offset] of [0, 1_000_000, -1_000_000, 0].entries()) {
  addFrame('teleport-dyadic', index, index === 0 ? 'continuous' : 'teleport', offset, 'dyadic', zero3, identity, clusters);
  // Explicit document/fixture preparation selects a bounded catalog snapshot.
  // This is scene replacement, not runtime culling or world streaming.
  addFrame('replacement-dyadic', index, 'scene-replacement', offset, 'dyadic', zero3, identity,
    clusters.filter(box => box.id.startsWith(`${offsetId(offset)}:`)));
}
for (const [index, cameraPosition] of [zero3, [q(1, 8), zero, q(1, 8)] as Exact3, [q(-1, 8), q(1, 8), zero] as Exact3].entries()) {
  addFrame('local-teleport-dyadic', index, index === 0 ? 'continuous' : 'teleport', 1_000_000, 'dyadic', cameraPosition);
}
const frames = Object.freeze([...exactFrames.values()].map(entry => entry.frame));

export function getWorldCoordinateFixtures(): readonly FixtureFrame[] { return frames; }
export function getWorldCoordinateFixture(id: string): FixtureFrame { return exactFrame(id).frame; }
/** Immutable global source catalog used by both rejection and bounded replacement fixtures. */
export function getWorldCoordinateCatalog(): readonly FixtureBox[] { return getWorldCoordinateFixture('teleport-dyadic/0').boxes; }
function exactFrame(id: string): ExactFrame {
  const result = exactFrames.get(id);
  if (!result) throw new RangeError(`Unknown coordinate fixture ${id}`);
  return result;
}
function exactBox(frame: ExactFrame, id: string): ExactBox {
  const result = frame.boxes.find(box => box.id === id);
  if (!result) throw new RangeError(`Unknown box ${id} in ${frame.frame.id}`);
  return result;
}

export interface ReferencePoint {
  readonly relative: Vec3;
  readonly view: Vec3;
  readonly clipW: number;
  readonly pixel: readonly [number, number] | null;
  readonly ndcDepth: number | null;
  readonly insideClip: boolean;
}

/** Center/face/corner coordinates only; generic floating-point input is not an exact oracle. */
export function referenceBoxPoint(frameId: string, boxId: string, unitPoint: Vec3): ReferencePoint {
  if (unitPoint.length !== 3 || ![...unitPoint].every(v => v === -0.5 || v === 0 || v === 0.5)) {
    throw new RangeError('Reference points require three components from {-0.5,0,0.5}');
  }
  const frame = exactFrame(frameId); const box = exactBox(frame, boxId);
  const local: Exact3 = [q(unitPoint[0] * 2, 2), q(unitPoint[1] * 2, 2), q(unitPoint[2] * 2, 2)];
  const transformed = apply(rotation(box.rotation), scale(scale(local, box.dimensions), box.scale));
  const relative = plus(minus(box.position, frame.cameraPosition), transformed);
  const view = numbers(apply(transpose(rotation(frame.cameraRotation)), relative));
  const clipW = -view[2];
  if (clipW <= 0) return { relative: numbers(relative), view, clipW, pixel: null, ndcDepth: null, insideClip: false };
  const { near, far, aspect, verticalFovRadians } = frame.frame.perspective;
  // Independent pinhole equations: no production projection/matrix multiplication.
  const focal = 1 / Math.tan(verticalFovRadians / 2);
  const x = view[0] * focal / (aspect * clipW); const y = view[1] * focal / clipW;
  const ndcDepth = far / (far - near) * (1 - near / clipW);
  return { relative: numbers(relative), view, clipW,
    pixel: [(x + 1) * frame.frame.viewport.width / 2, (1 - y) * frame.frame.viewport.height / 2], ndcDepth,
    insideClip: Math.abs(x) <= 1 && Math.abs(y) <= 1 && clipW >= near && clipW <= far };
}

/** Template-space normal, including dimensions*scale. Integer oblique witnesses are allowed. */
export function referenceBoxNormal(frameId: string, boxId: string, localNormal: Vec3): Vec3 {
  if (localNormal.length !== 3 || ![...localNormal].every(v => v === -1 || v === 0 || v === 1) || localNormal.every(v => v === 0)) {
    throw new RangeError('Reference normals require nonzero components from {-1,0,1}');
  }
  const box = exactBox(exactFrame(frameId), boxId); const effective = scale(box.dimensions, box.scale);
  const normal = numbers(apply(rotation(box.rotation), [div(q(localNormal[0]), effective[0]), div(q(localNormal[1]), effective[1]), div(q(localNormal[2]), effective[2])]));
  const length = Math.hypot(...normal);
  return [normal[0] / length, normal[1] / length, normal[2] / length];
}
