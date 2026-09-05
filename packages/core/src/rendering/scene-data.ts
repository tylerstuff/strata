import { StrataError } from '../errors.js';

export interface ProceduralSceneOptions {
  /** Unsigned 32-bit layout seed. Defaults to 1337. */
  seed?: number;
  /** Number of boxes, excluding the ground. Integer from 0 to 100,000; defaults to 512. */
  instanceCount?: number;
}

/** The version identifies geometry, material, layout, and camera conventions together. */
export const proceduralSceneId = 'procedural-boxes-v1';
export const instanceStride = 48;
export const vertexStride = 32;

export interface ProceduralSceneData {
  readonly id: typeof proceduralSceneId;
  readonly seed: number;
  readonly boxCount: number;
  readonly instanceCount: number;
  readonly halfExtent: number;
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint16Array<ArrayBuffer>;
  /** Translation vec4, scale.xyz/yaw, and linear color vec4 per instance. */
  readonly instances: Float32Array<ArrayBuffer>;
}

function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pure, deterministic fixture data. No imported content or browser globals. */
export function buildProceduralScene(options: ProceduralSceneOptions = {}): ProceduralSceneData {
  if (!options || typeof options !== 'object') {
    throw new StrataError('INVALID_OPTIONS', 'Scene options must be an object.');
  }
  const seed = options.seed ?? 1337;
  const boxCount = options.instanceCount ?? 512;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new StrataError('INVALID_OPTIONS', 'Scene seed must be an unsigned 32-bit integer.');
  }
  if (!Number.isInteger(boxCount) || boxCount < 0 || boxCount > 100_000) {
    throw new StrataError('INVALID_OPTIONS', 'Scene instanceCount must be an integer from 0 to 100000.');
  }

  // Each face has independent normals/UVs and counterclockwise outward winding.
  const faces = [
    { n: [0, 0, 1], p: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { n: [0, 0, -1], p: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
    { n: [1, 0, 0], p: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
    { n: [-1, 0, 0], p: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
    { n: [0, 1, 0], p: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
    { n: [0, -1, 0], p: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  ];
  const vertices = new Float32Array(24 * 8);
  const indices = new Uint16Array(36);
  const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
  faces.forEach((face, faceIndex) => {
    face.p.forEach((position, vertexIndex) => {
      vertices.set([
        ...position.map((component) => component * 0.5), ...face.n, ...uvs[vertexIndex]!,
      ], (faceIndex * 4 + vertexIndex) * 8);
    });
    indices.set([0, 1, 2, 0, 2, 3].map((index) => faceIndex * 4 + index), faceIndex * 6);
  });

  const random = randomGenerator(seed);
  const gridSize = Math.max(1, Math.ceil(Math.sqrt(boxCount)));
  const halfExtent = Math.max(10, gridSize * 1.4);
  const instances = new Float32Array((boxCount + 1) * (instanceStride / 4));
  // Ground is the first instance, with its top exactly at world y = 0.
  instances.set([0, -0.1, 0, 0, halfExtent * 2, 0.2, halfExtent * 2, 0, 0.18, 0.22, 0.25, 1]);
  for (let index = 0; index < boxCount; index++) {
    const x = ((index % gridSize) - (gridSize - 1) / 2) * 2.6 + (random() - 0.5) * 0.4;
    const z = (Math.floor(index / gridSize) - (gridSize - 1) / 2) * 2.6 + (random() - 0.5) * 0.4;
    const height = 0.5 + random() * 5;
    const scaleX = 0.65 + random() * 0.9;
    const scaleZ = 0.65 + random() * 0.9;
    const yaw = random() * Math.PI * 2;
    const hue = random();
    // A repeatable warm/cool palette, supplied in linear space.
    instances.set([
      x, height / 2, z, 0, scaleX, height, scaleZ, yaw,
      0.12 + 0.55 * hue, 0.2 + 0.4 * (1 - hue), 0.3 + random() * 0.35, 1,
    ], (index + 1) * 12);
  }
  return { id: proceduralSceneId, seed, boxCount, instanceCount: boxCount + 1, halfExtent, vertices, indices, instances };
}

type Vec3 = readonly [number, number, number];

function normalize([x, y, z]: Vec3): Vec3 {
  const inverseLength = 1 / Math.hypot(x, y, z);
  return [x * inverseLength, y * inverseLength, z * inverseLength];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/** Column-major right-handed projection with WebGPU's zero-to-one depth range. */
export function perspectiveMatrix(aspect: number, near: number, far: number): Float32Array<ArrayBuffer> {
  if (!(Number.isFinite(aspect) && aspect > 0 && Number.isFinite(near) && near > 0
    && Number.isFinite(far) && far > near)) {
    throw new StrataError('INVALID_OPTIONS', 'Camera projection requires finite positive aspect and 0 < near < far.');
  }
  const focal = 1 / Math.tan(55 * Math.PI / 360);
  const depth = far / (near - far);
  return new Float32Array([focal / aspect, 0, 0, 0, 0, focal, 0, 0, 0, 0, depth, -1, 0, 0, near * depth, 0]);
}

/** The camera completes one orbit every 20 simulation seconds, independent of wall time. */
export function createCameraMatrix(
  aspect: number, timeSeconds: number, halfExtent: number,
): Float32Array<ArrayBuffer> {
  if (!Number.isFinite(timeSeconds) || !Number.isFinite(halfExtent) || halfExtent <= 0) {
    throw new StrataError('INVALID_OPTIONS', 'Camera time and scene extent must be finite, with positive extent.');
  }
  const angle = ((timeSeconds % 20) / 20) * Math.PI * 2 + Math.PI / 4;
  const eye: Vec3 = [Math.sin(angle) * halfExtent * 2.15, halfExtent * 1.35, Math.cos(angle) * halfExtent * 2.15];
  const target: Vec3 = [0, 1, 0];
  const forward = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const right = normalize(cross([0, 1, 0], forward));
  const up = cross(forward, right);
  const view = [
    right[0], up[0], forward[0], 0,
    right[1], up[1], forward[1], 0,
    right[2], up[2], forward[2], 0,
    -dot(right, eye), -dot(up, eye), -dot(forward, eye), 1,
  ];
  const projection = perspectiveMatrix(aspect, 0.1, halfExtent * 8 + 10);
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let value = 0;
      for (let component = 0; component < 4; component++) {
        value += projection[component * 4 + row]! * view[column * 4 + component]!;
      }
      result[column * 4 + row] = value;
    }
  }
  return result;
}
