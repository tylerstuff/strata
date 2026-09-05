import type { AuthoredBox, BoxCamera, BoxSceneDescriptor, BoxVec3 } from '../../packages/core/src/rendering/authored-box-types.js';

export type MotionVariant = 'dyadic' | 'decimal';
export interface MotionFixtureFrame {
  readonly id: string;
  readonly frameId: number;
  readonly camera: BoxCamera;
  readonly width: number;
  readonly height: number;
  readonly cameraCut: boolean;
  readonly submit: boolean;
}
export interface MotionFixtureSequence {
  readonly id: string;
  readonly variant: MotionVariant;
  readonly offset: number;
  readonly scene: BoxSceneDescriptor;
  readonly frames: readonly MotionFixtureFrame[];
  /** Equivalent dyadic sequences must produce identical complete motion bytes. */
  readonly equivalentSequence?: string;
}
export const AUTHORED_MOTION_GATES = Object.freeze({
  xyPixels: 1 / 128, depthAbsolute: 1e-4, depthRelative: 2e-5,
  currentInteriorRadiusPixels: 2, priorEdgeMarginPixels: 1 / 64,
  priorDepthPlaneMargin: 1 / 1024, minimumMaskPixels: 64,
  allowedRejectedPixels: 0,
});

const offsets = [0, 1000, -1000, 10000, -10000, 100000, -100000, 1000000, -1000000];
const anchor = (value: number): BoxVec3 => [value, -value, value];
const plus = (a: BoxVec3, b: BoxVec3): BoxVec3 => [a[0] + b[0] || 0, a[1] + b[1] || 0, a[2] + b[2] || 0];
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

export function motionCamera(offset = 0, local: BoxVec3 = [0, 0, 0], yawParameter = 0, fov = 0.9): BoxCamera {
  const t = yawParameter, denominator = 1 + t * t;
  return { position: plus(anchor(offset), local), rotation: [0, 2 * t / denominator, 0, (1 - t * t) / denominator],
    projection: { kind: 'perspective', verticalFovRadians: fov, near: 0.125, far: 32 } };
}

export function authoredMotionScene(variant: MotionVariant, offset = 0): BoxSceneDescriptor {
  const decimal = variant === 'decimal';
  const definitions: readonly { id: string; p: BoxVec3; d: BoxVec3; q: AuthoredBox['transform']['rotation']; s: BoxVec3 }[] = [
    { id: 'front-landmark', p: [0, 0, -3], d: [0.625, 0.75, 0.5], q: [0, 0, 0, 1], s: [1, 1, 1] },
    { id: 'left-permutation', p: [-1, -0.375, -3.5], d: [0.5, 0.375, 0.625], q: [0.5, 0.5, 0.5, 0.5], s: [1, 2, 0.5] },
    { id: 'right-rotation', p: [1, 0.375, -3.5], d: [0.5, 0.625, 0.375], q: [0, 0.6, 0, 0.8], s: [1, 0.75, 1.5] },
    { id: 'upper', p: [-0.75, 0.875, -4], d: [0.5, 0.375, 0.5], q: [0.6, 0, 0, 0.8], s: [1, 1, 1] },
    { id: 'lower', p: [0.75, -0.875, -4], d: [0.625, 0.375, 0.5], q: [0, 0, 0, 1], s: [1, 1, 1] },
  ];
  const boxes = definitions.map((d, index): AuthoredBox => ({ id: d.id,
    dimensions: d.d.map((value, axis) => value + (decimal ? (axis + 1) / 1000 : 0)) as unknown as BoxVec3,
    transform: { position: plus(anchor(offset), d.p.map((v, a) => v + (decimal ? (index + 1) * (a + 1) / 1000 : 0)) as unknown as BoxVec3), rotation: d.q, scale: d.s },
    material: { baseColor: [0.2 + index / 8, 0.3, 0.6 - index / 16, 1], metallic: 0, roughness: 0.75 } }));
  return { format: 'strata.runtime-boxes', version: 1, coordinateSystem: 'strata-world-v1', sceneId: `motion-${variant}-${offset}`,
    sourceRevision: 'motion-fixture-v1', boxes, camera: motionCamera(offset), light: { directionToLight: [0, 0, 1], radiance: [2, 2, 2] }, background: [0, 0, 0] };
}

const sequences: MotionFixtureSequence[] = [];
function sequence(id: string, variant: MotionVariant, offset: number, requests: readonly Partial<MotionFixtureFrame>[], equivalentSequence?: string): void {
  const firstFrameId = 1000 + sequences.length * 100;
  sequences.push(freeze({ id, variant, offset, scene: authoredMotionScene(variant, offset),
    frames: requests.map((request, index): MotionFixtureFrame => ({ id: `${id}/${index}`, frameId: firstFrameId + index,
      camera: motionCamera(offset), width: 320, height: 240, cameraCut: false, submit: true, ...request })),
    ...(equivalentSequence ? { equivalentSequence } : {}) }));
}
for (const variant of ['dyadic', 'decimal'] as const) for (const offset of offsets) {
  const local: readonly BoxVec3[] = variant === 'dyadic'
    ? [[0, 0, 0], [1 / 32, -1 / 64, 1 / 16], [3 / 64, 1 / 128, 3 / 32]]
    : [[0, 0, 0], [0.01, -0.013, 0.019], [0.027, 0.006, 0.043]];
  sequence(`offset-${variant}-${offset}`, variant, offset, local.map(p => ({ camera: motionCamera(offset, p) })),
    variant === 'dyadic' && offset !== 0 ? 'offset-dyadic-0' : undefined);
}
for (const offset of [0, 1000000, -1000000]) {
  sequence(`slow-${offset}`, 'dyadic', offset, Array.from({ length: 8 }, (_, i) => ({ camera: {
    ...motionCamera(offset, [i / 1024, -i / 2048, i / 512], i / 1024, 0.9 + i / 512),
    projection: { kind: 'perspective', verticalFovRadians: 0.9 + i / 512, near: 0.125 + i / 1024, far: 32 + i },
  } })), offset ? 'slow-0' : undefined);
}
for (const offset of [999936, -999936]) {
  sequence(`cell-boundary-${offset}`, 'dyadic', offset,
    [-1 / 256, -1 / 1024, 1 / 1024, 1 / 256].map(x => ({ camera: motionCamera(offset, [x, 0, 0]) })));
}
sequence('lifecycle', 'dyadic', 1000000, [
  {}, { camera: motionCamera(1000000, [1 / 32, 0, 0]) },
  { camera: motionCamera(1000000, [1 / 4, 0, 0]), cameraCut: true, submit: false },
  { camera: motionCamera(1000000, [3 / 64, 0, 1 / 32]) },
  { camera: motionCamera(1000000, [1 / 16, 0, 1 / 16]), cameraCut: true },
  { camera: motionCamera(1000000, [1 / 8, 0, 1 / 8], 1 / 128, 0.95) },
  { width: 400, height: 240, camera: motionCamera(1000000, [1 / 8, 0, 1 / 8]) },
  { width: 400, height: 240, camera: motionCamera(1000000, [5 / 32, 0, 1 / 8]) },
  { width: 512, height: 256, camera: motionCamera(1000000, [1 / 2, 0, 0]), submit: false },
  { width: 400, height: 240, camera: motionCamera(1000000, [3 / 16, 0, 1 / 8]) },
]);
sequence('prior-frustum', 'dyadic', 0, [
  { camera: motionCamera(0, [0, 0, 0], 0, 0.45) },
  { camera: motionCamera(0, [1 / 64, 0, 1 / 32], 0, 1.05) },
]);
sequence('prior-near-plane', 'dyadic', 0, [
  { camera: { ...motionCamera(), projection: { kind: 'perspective', verticalFovRadians: 0.9, near: 3.125, far: 32 } } },
  { camera: motionCamera() },
]);
sequence('prior-far-plane', 'dyadic', 0, [
  { camera: { ...motionCamera(), projection: { kind: 'perspective', verticalFovRadians: 0.9, near: 0.125, far: 3.25 } } },
  { camera: motionCamera() },
]);
Object.freeze(sequences);

export function getAuthoredMotionFixtures(): readonly MotionFixtureSequence[] { return sequences; }

export interface MotionPair {
  readonly current: MotionFixtureFrame;
  readonly previous: MotionFixtureFrame | null;
  readonly valid: boolean;
  readonly resetReason: 'first-frame' | 'camera-cut' | 'viewport-change' | null;
}
/** Test-side submission ledger. Canceled requests are deliberately absent. */
export function motionFixturePairs(sequence: MotionFixtureSequence): readonly MotionPair[] {
  let previous: MotionFixtureFrame | null = null;
  return sequence.frames.map(current => {
    const resetReason: MotionPair['resetReason'] = previous === null ? 'first-frame' : current.cameraCut ? 'camera-cut'
      : current.width !== previous.width || current.height !== previous.height ? 'viewport-change' : null;
    const result = { current, previous, valid: resetReason === null, resetReason };
    if (current.submit) previous = current;
    return result;
  });
}
