import { StrataError } from '../errors.js';
import { perspectiveMatrix } from './scene-data.js';

export type Vec3 = readonly [number, number, number];

export function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array<ArrayBuffer> {
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let component = 0; component < 4; component++) {
        result[column * 4 + row]! += a[component * 4 + row]! * b[column * 4 + component]!;
      }
    }
  }
  return result;
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

export function lookAtMatrix(eye: Vec3, target: Vec3): Float32Array<ArrayBuffer> {
  const back = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const right = normalize(cross([0, 1, 0], back));
  const up = cross(back, right);
  return new Float32Array([
    right[0], up[0], back[0], 0,
    right[1], up[1], back[1], 0,
    right[2], up[2], back[2], 0,
    -dot(right, eye), -dot(up, eye), -dot(back, eye), 1,
  ]);
}

export function orthographicMatrix(extent: number, near: number, far: number): Float32Array<ArrayBuffer> {
  if (!Number.isFinite(extent) || extent <= 0 || !Number.isFinite(near) || near < 0 || !Number.isFinite(far) || far <= near) {
    throw new StrataError('INVALID_OPTIONS', 'Orthographic projection requires finite positive extent and 0 <= near < far.');
  }
  return new Float32Array([
    1 / extent, 0, 0, 0, 0, 1 / extent, 0, 0,
    0, 0, 1 / (near - far), 0, 0, 0, near / (near - far), 1,
  ]);
}

export interface CameraFrame {
  readonly projectionScaleY?: number;
  readonly orthographic?: boolean;
  readonly view: Float32Array<ArrayBuffer>;
  readonly viewProjection: Float32Array<ArrayBuffer>;
  readonly eye: Vec3;
  readonly far: number;
}

/** Same orbit and projection as procedural-boxes-v1, with optional pixel jitter. */
export function createRasterCamera(width: number, height: number, time: number, halfExtent: number,
  jitter: readonly [number, number] = [0, 0]): CameraFrame {
  if (![width, height, time, halfExtent, ...jitter].every(Number.isFinite) || width <= 0 || height <= 0 || halfExtent <= 0) {
    throw new StrataError('INVALID_OPTIONS', 'Raster camera inputs must be finite, with positive dimensions and extent.');
  }
  const angle = ((time % 20) / 20) * Math.PI * 2 + Math.PI / 4;
  const eye: Vec3 = [Math.sin(angle) * halfExtent * 2.15, halfExtent * 1.35, Math.cos(angle) * halfExtent * 2.15];
  const view = lookAtMatrix(eye, [0, 1, 0]);
  const far = halfExtent * 8 + 10;
  const projection = perspectiveMatrix(width / height, 0.1, far);
  // Clip w = -view z. Positive pixel y points down in texture coordinates.
  projection[8] = -2 * jitter[0] / width;
  projection[9] = 2 * jitter[1] / height;
  return { eye, view, far, viewProjection: multiplyMatrices(projection, view) };
}

export const lightDirection = normalize([0.35, 0.8, 0.4]);
export function createLightMatrix(halfExtent: number): Float32Array<ArrayBuffer> {
  const target: Vec3 = [0, 0, 0];
  const eye: Vec3 = [lightDirection[0] * halfExtent * 3, lightDirection[1] * halfExtent * 3, lightDirection[2] * halfExtent * 3];
  return multiplyMatrices(orthographicMatrix(halfExtent * 1.8 + 6, 0.1, halfExtent * 8 + 30), lookAtMatrix(eye, target));
}

function halton(index: number, base: number): number {
  let fraction = 1;
  let value = 0;
  while (index > 0) { fraction /= base; value += fraction * (index % base); index = Math.floor(index / base); }
  return value;
}
export function cameraJitter(frameIndex: number): readonly [number, number] {
  const index = (frameIndex % 8) + 1;
  return [halton(index, 2) - 0.5, halton(index, 3) - 0.5];
}

/** Mirrors the shader's one animated object; useful for reprojection validation. */
export function animatedOffset(instanceIndex: number, time: number): Vec3 {
  return instanceIndex === 1 ? [Math.sin(time * 1.7) * 1.2, 0.35 + Math.sin(time * 2.3) * 0.35, Math.cos(time * 1.3) * 0.7] : [0, 0, 0];
}

export function createMaterialTextures(size = 64): { baseColor: Uint8Array<ArrayBuffer>; metallicRoughness: Uint8Array<ArrayBuffer> } {
  if (!Number.isInteger(size) || size < 8 || size > 1024) throw new StrataError('INVALID_OPTIONS', 'Material texture size must be an integer from 8 to 1024.');
  const baseColor = new Uint8Array(size * size * 4);
  const metallicRoughness = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const checker = (Math.floor(x / 8) + Math.floor(y / 8)) % 2;
      const color = checker ? 245 : 155;
      const offset = (y * size + x) * 4;
      baseColor.set([color, color, color, 255], offset);
      // glTF-style channels: G is roughness, B is metallic. Both are linear data.
      metallicRoughness.set([255, checker ? 220 : 120, 255, 255], offset);
    }
  }
  return { baseColor, metallicRoughness };
}

/** Double-precision reference for the production WGSL GGX distribution. */
export function referenceGgxDistribution(roughness: number, nDotH: number): number {
  const alpha2 = Math.min(1, Math.max(0.06, roughness)) ** 4;
  const nh2 = Math.min(1, Math.max(0, nDotH)) ** 2;
  const denominator = 1 + (alpha2 - 1) * nh2;
  return alpha2 / (Math.PI * denominator * denominator);
}
