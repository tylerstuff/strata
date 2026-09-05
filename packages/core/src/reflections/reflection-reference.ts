import { StrataError } from '../errors.js';
import type { CameraFrame } from '../rendering/raster-math.js';
import type { ReflectionControls, ReflectionMode } from './reflection-types.js';

export type ReflectionVector = readonly [number, number, number];
export interface NormalizedReflectionControls {
  mode: ReflectionMode; roughness: number; maxDistance: number; updateEvery: number;
  objectOffset: number; resetHistory: boolean;
}
export function normalizeReflectionControls(input: ReflectionControls = {}): NormalizedReflectionControls {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new StrataError('INVALID_OPTIONS', 'Reflection controls must be an object.');
  for (const name of ['mode', 'roughness', 'maxDistance', 'updateEvery', 'objectOffset', 'resetHistory'] as const) {
    if (input[name] === null) throw new StrataError('INVALID_OPTIONS', 'Reflection control values cannot be null.');
  }
  const result = { mode: input.mode ?? 'world', roughness: input.roughness ?? 0.08, maxDistance: input.maxDistance ?? 16,
    updateEvery: input.updateEvery ?? 1, objectOffset: input.objectOffset ?? 0, resetHistory: input.resetHistory ?? false };
  if (!['off', 'probe-only', 'world'].includes(result.mode) || !Number.isFinite(result.roughness) || result.roughness < 0 || result.roughness > 0.35
    || !Number.isFinite(result.maxDistance) || result.maxDistance < 1 || result.maxDistance > 32
    || !Number.isInteger(result.updateEvery) || result.updateEvery < 1 || result.updateEvery > 4
    || !Number.isFinite(result.objectOffset) || result.objectOffset < -0.4 || result.objectOffset > 0.4 || typeof result.resetHistory !== 'boolean') {
    throw new StrataError('INVALID_OPTIONS', 'Use reflection mode off/probe-only/world, roughness 0..0.35, distance 1..32, update interval 1..4 and object offset -0.4..0.4.');
  }
  return result;
}

const dot = (a: ReflectionVector, b: ReflectionVector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: ReflectionVector, amount: number): ReflectionVector => [a[0] * amount, a[1] * amount, a[2] * amount];
const cross = (a: ReflectionVector, b: ReflectionVector): ReflectionVector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: ReflectionVector): ReflectionVector => scale(a, 1 / Math.hypot(...a));

export function reflectionFresnel(f0: ReflectionVector, cosine: number): ReflectionVector {
  const grazing = (1 - Math.max(0, Math.min(1, cosine))) ** 5;
  return f0.map(value => value + (1 - value) * grazing) as unknown as ReflectionVector;
}

/** Isotropic GGX visible-normal sampling; local normal is +Z and view points away from the surface.
 * Derivation: Heitz 2018, https://jcgt.org/published/0007/04/01/ .
 * For separable Smith G2=G1(V)G1(L), BRDF*cos/PDF reduces to Fresnel*G1(L).
 */
export function sampleReflectionDirection(view: ReflectionVector, normal: ReflectionVector, roughness: number,
  random: readonly [number, number], f0: ReflectionVector = [0.85, 0.85, 0.85]): { direction: ReflectionVector; weight: ReflectionVector } {
  if (![...view, ...normal, ...random, roughness, ...f0].every(Number.isFinite) || roughness < 0 || roughness > 0.35
    || random.some(value => value < 0 || value >= 1) || Math.abs(Math.hypot(...view) - 1) > 1e-5
    || Math.abs(Math.hypot(...normal) - 1) > 1e-5 || dot(view, normal) <= 0) throw new RangeError('Reflection sampling requires unit front-facing directions and finite samples.');
  const tangent = normalize(cross(Math.abs(normal[2]) < 0.999 ? [0, 0, 1] : [0, 1, 0], normal));
  const bitangent = cross(normal, tangent);
  const local: ReflectionVector = [dot(view, tangent), dot(view, bitangent), dot(view, normal)];
  let half: ReflectionVector = [0, 0, 1];
  const alpha = Math.max(roughness * roughness, 1e-6);
  if (roughness > 0) {
    const stretched = normalize([local[0] * alpha, local[1] * alpha, local[2]]);
    const lateral = stretched[0] * stretched[0] + stretched[1] * stretched[1];
    const axis: ReflectionVector = lateral > 1e-12 ? scale([-stretched[1], stretched[0], 0], 1 / Math.sqrt(lateral)) : [1, 0, 0];
    const other = cross(stretched, axis);
    const radius = Math.sqrt(random[0]); const angle = 2 * Math.PI * random[1];
    const diskX = radius * Math.cos(angle); const blend = (1 + stretched[2]) * 0.5;
    const diskY = (1 - blend) * Math.sqrt(Math.max(0, 1 - diskX * diskX)) + blend * radius * Math.sin(angle);
    const height = Math.sqrt(Math.max(0, 1 - diskX * diskX - diskY * diskY));
    const hemisphere = axis.map((value, i) => value * diskX + other[i]! * diskY + stretched[i]! * height) as unknown as ReflectionVector;
    half = normalize([hemisphere[0] * alpha, hemisphere[1] * alpha, Math.max(0, hemisphere[2])]);
  }
  const vh = dot(local, half);
  const light = local.map((value, axis) => 2 * vh * half[axis]! - value) as unknown as ReflectionVector;
  const direction = normalize(tangent.map((value, axis) => value * light[0] + bitangent[axis]! * light[1] + normal[axis]! * light[2]) as unknown as ReflectionVector);
  const nl = Math.max(0, light[2]);
  const masking = roughness === 0 ? 1 : 2 * nl / Math.max(nl + Math.sqrt(alpha * alpha + (1 - alpha * alpha) * nl * nl), 1e-8);
  return { direction, weight: scale(reflectionFresnel(f0, vh), light[2] > 0 ? masking : 0) };
}

export interface ReflectionRegion { x: number; y: number; width: number; height: number }
/** Conservative scheduling bounds only; the GPU's actual material mask selects reflectors. */
export function reflectionCandidateRegion(camera: CameraFrame, width: number, height: number,
  surface: { min: ReflectionVector; max: ReflectionVector; planeY: number }): ReflectionRegion {
  const clips = [surface.min[0], surface.max[0]].flatMap(x => [surface.min[2], surface.max[2]].map(z => {
    const point = [x, surface.planeY, z, 1];
    return Array.from({ length: 4 }, (_, row) => point.reduce((sum, value, column) => sum + value * camera.viewProjection[column * 4 + row]!, 0));
  }));
  if (clips.some(clip => clip.some(value => !Number.isFinite(value)) || clip[3]! <= 0 || clip[2]! < 0)) return { x: 0, y: 0, width, height };
  const xs = clips.map(clip => (clip[0]! / clip[3]! * 0.5 + 0.5) * width);
  const ys = clips.map(clip => (0.5 - clip[1]! / clip[3]! * 0.5) * height);
  const x = Math.max(0, Math.min(width, Math.floor(Math.min(...xs)) - 1));
  const y = Math.max(0, Math.min(height, Math.floor(Math.min(...ys)) - 1));
  const right = Math.max(x, Math.min(width, Math.ceil(Math.max(...xs)) + 1));
  const bottom = Math.max(y, Math.min(height, Math.ceil(Math.max(...ys)) + 1));
  return { x, y, width: right - x, height: bottom - y };
}

export interface ReflectionHistoryQuery { epoch: number; frameIndex: number; maxAge: number; depth: number; normal: ReflectionVector; roughness: number }
export interface ReflectionHistoryTap { epoch: number; freshFrame: number; source: number; depth: number; normal: ReflectionVector; roughness: number; reflector: boolean }
export function acceptsReflectionHistory(query: ReflectionHistoryQuery, tap: ReflectionHistoryTap): boolean {
  return tap.reflector && (tap.source === 0 || tap.source === 1 || tap.source === 3) && tap.epoch === query.epoch && tap.freshFrame <= query.frameIndex
    && query.frameIndex - tap.freshFrame <= query.maxAge && tap.depth > 0 && query.depth > 0
    && Math.abs(tap.depth - query.depth) <= Math.max(0.02, query.depth * 0.01)
    && dot(tap.normal, query.normal) >= 0.98 && Math.abs(tap.roughness - query.roughness) <= 0.005;
}
