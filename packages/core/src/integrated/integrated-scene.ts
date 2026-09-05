import { StrataError } from '../errors.js';
import type { GiMaterial, GiVec3 } from '../gi/scene-data.js';
import { createReflectionScene } from '../reflections/reflection-scene.js';
import type { ReflectionSceneData, ReflectionSceneOptions } from '../reflections/reflection-scene.js';
import type { ReflectionRenderControls } from '../reflections/reflection-renderer.js';
import { createGiCamera } from '../gi/room-geometry.js';
import { lookAtMatrix, multiplyMatrices } from '../rendering/raster-math.js';
import type { CameraFrame, Vec3 } from '../rendering/raster-math.js';
import type { IntegratedCameraMode } from './integrated-types.js';

export const integratedTerrainTransform = Object.freeze({ scale: 0.125, translation: Object.freeze([0, -1.625, 0]) as GiVec3 });
export const integratedTerrainAlbedos = Object.freeze({ green: Object.freeze([0.08, 0.65, 0.12]) as GiVec3,
  neutral: Object.freeze([0.45, 0.45, 0.45]) as GiVec3 });

/** Same source boxes/materials as the reflection proof, with the east wall lowered to a courtyard curb. */
export function createIntegratedScene(options: ReflectionSceneOptions = {}, terrainColor: 'green' | 'neutral' = 'green'): ReflectionSceneData {
  if (!['green', 'neutral'].includes(terrainColor)) throw new StrataError('INVALID_OPTIONS', 'Unknown integrated terrain color.');
  const base = createReflectionScene(options);
  const boxes = base.boxes.map(box => box.id === 2 ? Object.freeze({ ...box, name: 'courtyard curb',
    center: Object.freeze([6.05, 0.15, 0]) as GiVec3, halfSize: Object.freeze([0.05, 0.15, 4.1]) as GiVec3 }) : box);
  const terrainMaterial: GiMaterial = Object.freeze({ id: 5, albedo: integratedTerrainAlbedos[terrainColor],
    emission: Object.freeze([0, 0, 0]) as GiVec3, roughness: 1, metallic: 0 });
  return Object.freeze({ ...base, boxes: Object.freeze(boxes), materials: Object.freeze([...base.materials, terrainMaterial]),
    bounds: Object.freeze({ min: Object.freeze([-16, -3, -16]) as GiVec3, max: Object.freeze([16, 4.1, 16]) as GiVec3 }) });
}

interface Waypoint { time: number; eye: Vec3; target: Vec3 }
// A deterministic 60-second inspection path. Movement is unconstrained; collision is not implemented.
export const integratedWaypoints: readonly Waypoint[] = Object.freeze([
  { time: 0, eye: [-3, 2.4, 0.2], target: [-1.5, 0.01, 0.2] },
  { time: 8, eye: [-3, 2.4, 0.2], target: [-1.5, 0.01, 0.2] },
  { time: 12, eye: [-2, 1.8, -0.5], target: [3, 1.2, -0.5] },
  { time: 16, eye: [1.8, 1.8, -0.5], target: [5.5, 1.5, -4] },
  { time: 18, eye: [4.5, 2.4, -2.5], target: [5.5, 1.5, -4] },
  { time: 22, eye: [4.5, 2.4, -2.5], target: [5.5, 1.5, -4] },
  { time: 26, eye: [7, 1.5, -2], target: [11, -2, -6] },
  { time: 33, eye: [13, 0.8, -12], target: [6, -2, -12] },
  { time: 40, eye: [-12, 0.8, -12], target: [-12, -2, 0] },
  { time: 47, eye: [-12, 0.8, 12], target: [5, -2, 12] },
  { time: 53, eye: [12, 1, 10], target: [6, 1, 0] },
  { time: 57, eye: [4, 2, 0], target: [-3, 1, 0] },
  { time: 60, eye: [-3, 2.4, 0.2], target: [-1.5, 0.01, 0.2] },
]);
export function integratedPhase(time: number): number { return ((time % 60) + 60) % 60; }

/** Scene events are benchmark-owned: the runtime accepts ordinary persistent state patches. */
export function integratedScenario(time: number): ReflectionRenderControls {
  const phase = integratedPhase(time);
  return { gi: { doorOpen: !(phase >= 4 && phase < 8), lightIntensity: phase >= 14 && phase < 18 ? 0 : 1 },
    reflections: { objectOffset: phase >= 2 && phase < 6 ? 0.4 * Math.sin((phase - 2) * Math.PI / 2) : 0 } };
}
export function createIntegratedCamera(width: number, height: number, time: number, jitter: readonly [number, number],
  mode: IntegratedCameraMode = 'tour'): CameraFrame {
  if (![width, height, time, ...jitter].every(Number.isFinite) || width <= 0 || height <= 0
    || !['tour', 'receiver', 'overview', 'terrain-witness'].includes(mode)) {
    throw new StrataError('INVALID_OPTIONS', 'Invalid integrated camera inputs.');
  }
  if (mode === 'receiver') return createGiCamera(width, height, time, jitter, 'receiver');
  let eye: Vec3; let target: Vec3;
  if (mode === 'terrain-witness') { eye = [4.5, 2.4, -2.5]; target = [5.5, 1.5, -4]; }
  else if (mode === 'overview') { eye = [20, 18, 24]; target = [0, 0, 0]; }
  else {
    const phase = integratedPhase(time);
    const end = integratedWaypoints.findIndex(point => point.time > phase);
    const b = integratedWaypoints[end]!; const a = integratedWaypoints[end - 1]!;
    const fraction = (phase - a.time) / (b.time - a.time); const u = fraction * fraction * (3 - 2 * fraction);
    const lerp = (from: Vec3, to: Vec3): Vec3 => [from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u, from[2] + (to[2] - from[2]) * u];
    eye = lerp(a.eye, b.eye); target = lerp(a.target, b.target);
  }
  const view = lookAtMatrix(eye, target); const near = 0.05; const far = 100;
  const phase = integratedPhase(time);
  // Hold the offscreen mirror witness at 30 degrees, then widen smoothly for the courtyard.
  const smooth = (fraction: number) => fraction * fraction * (3 - 2 * fraction);
  const tourFov = phase < 8 ? 30 : phase < 12 ? 30 + 30 * smooth((phase - 8) / 4)
    : phase > 57 ? 60 - 30 * smooth((phase - 57) / 3) : 60;
  const degrees = mode === 'terrain-witness' ? 10 : mode === 'tour' ? tourFov : 60;
  const scale = 1 / Math.tan(degrees * Math.PI / 360);
  const projection = new Float32Array([scale / (width / height), 0, 0, 0, 0, scale, 0, 0,
    -2 * jitter[0] / width, 2 * jitter[1] / height, far / (near - far), -1, 0, 0, near * far / (near - far), 0]);
  return { eye, view, far, projectionScaleY: scale, orthographic: false, viewProjection: multiplyMatrices(projection, view) };
}
