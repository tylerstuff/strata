import { StrataError } from '../errors.js';
import type { ImportedAnimationChannel, ImportedAsset, ImportedControls, ImportedNode } from './imported-types.js';

function invalid(message: string): never { throw new StrataError('INVALID_OPTIONS', message); }
function finite(values: ArrayLike<number>, count: number): boolean {
  if (values.length !== count) return false;
  for (let i = 0; i < count; i++) if (!Number.isFinite(values[i])) return false;
  return true;
}

/** glTF Appendix C: endpoint clamping, shortest-path SLERP and duration-scaled Hermite tangents. */
export function sampleImportedChannel(channel: ImportedAnimationChannel, time: number, output: Float64Array): void {
  const size = channel.path === 'rotation' ? 4 : 3;
  const cubic = channel.interpolation === 'CUBICSPLINE';
  const stride = size * (cubic ? 3 : 1);
  const offset = cubic ? size : 0;
  const times = channel.times, values = channel.values;
  let left = 0, right = times.length - 1;
  while (left < right) {
    const middle = Math.ceil((left + right) / 2);
    if (times[middle]! <= time) left = middle; else right = middle - 1;
  }
  const next = Math.min(left + 1, times.length - 1);
  const duration = times[next]! - times[left]!;
  const u = duration > 0 ? Math.min(1, Math.max(0, (time - times[left]!) / duration)) : 0;
  const a = left * stride + offset, b = next * stride + offset;
  if (u === 0 || channel.interpolation === 'STEP') {
    for (let i = 0; i < size; i++) output[i] = values[a + i]!;
  } else if (cubic) {
    const u2 = u * u, u3 = u2 * u;
    for (let i = 0; i < size; i++) output[i] = (2 * u3 - 3 * u2 + 1) * values[a + i]!
      + duration * (u3 - 2 * u2 + u) * values[a + size + i]!
      + (-2 * u3 + 3 * u2) * values[b + i]!
      + duration * (u3 - u2) * values[b - size + i]!;
  } else if (channel.path === 'rotation') {
    const lengthA = Math.hypot(values[a]!, values[a + 1]!, values[a + 2]!, values[a + 3]!);
    const lengthB = Math.hypot(values[b]!, values[b + 1]!, values[b + 2]!, values[b + 3]!);
    if (lengthA < 1e-12 || lengthB < 1e-12) invalid('Animation contains a degenerate quaternion.');
    let dot = 0;
    for (let i = 0; i < 4; i++) dot += (values[a + i]! / lengthA) * (values[b + i]! / lengthB);
    const sign = dot < 0 ? -1 : 1, cosine = Math.min(1, Math.abs(dot));
    const angle = Math.acos(cosine), sine = Math.sin(angle);
    const first = cosine > 0.9995 ? 1 - u : Math.sin((1 - u) * angle) / sine;
    const second = cosine > 0.9995 ? u : Math.sin(u * angle) / sine;
    for (let i = 0; i < 4; i++) output[i] = first * (values[a + i]! / lengthA) + sign * second * (values[b + i]! / lengthB);
  } else {
    for (let i = 0; i < size; i++) output[i] = (1 - u) * values[a + i]! + u * values[b + i]!;
  }
  if (channel.path === 'rotation') {
    const length = Math.hypot(output[0]!, output[1]!, output[2]!, output[3]!);
    if (!Number.isFinite(length) || length < 1e-12) invalid('Animation produced a degenerate quaternion.');
    for (let i = 0; i < 4; i++) output[i]! /= length;
  }
}

function compose(output: Float64Array, offset: number, translation: ArrayLike<number>, rotation: ArrayLike<number>, scale: ArrayLike<number>): void {
  const length = Math.hypot(rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!);
  const x = rotation[0]! / length, y = rotation[1]! / length, z = rotation[2]! / length, w = rotation[3]! / length;
  const sx = scale[0]!, sy = scale[1]!, sz = scale[2]!;
  output.set([
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    translation[0]!, translation[1]!, translation[2]!, 1,
  ], offset);
}
function multiply(output: Float64Array, out: number, a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): void {
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let value = 0;
    for (let k = 0; k < 4; k++) value += a[ai + k * 4 + row]! * b[bi + column * 4 + k]!;
    output[out + column * 4 + row] = value;
  }
}

export interface ImportedPose {
  /** Reused storage; copy before a later evaluate() when retaining a previous pose. */
  readonly nodeMatrices: Float32Array<ArrayBuffer>;
  /** Normalization * jointWorld * inverseBind. Mesh-node transforms must not be applied again. */
  readonly skinMatrices: readonly Float32Array<ArrayBuffer>[];
  readonly clipId: string | null;
  readonly timeSeconds: number;
  readonly loop: boolean;
}

/** Copies the small pose/curve data once; vertex skinning remains GPU work. */
export function createImportedPoseEvaluator(asset: ImportedAsset): { evaluate(animation?: ImportedControls['animation']): ImportedPose } {
  const normalization = asset.normalization;
  if (!normalization || !Number.isFinite(normalization.scale) || normalization.scale <= 0
    || !finite(normalization.translation, 3)) invalid('Imported normalization must be finite and positive.');
  const nodes: ImportedNode[] = (asset.rig?.nodes ?? []).map(node => ({
    parent: node.parent, translation: [...node.translation], rotation: [...node.rotation], scale: [...node.scale],
    ...(node.matrix ? { matrix: node.matrix.slice() } : {}),
  }));
  if (nodes.length > 65536) invalid('Imported rig exceeds the node limit.');
  const children = nodes.map(() => [] as number[]), order: number[] = [];
  nodes.forEach((node, index) => {
    if (!finite(node.translation, 3) || !finite(node.rotation, 4) || !finite(node.scale, 3)
      || Math.hypot(...node.rotation) < 1e-12 || node.scale.some(value => value === 0)
      || (node.matrix && (!finite(node.matrix, 16) || node.matrix[3] !== 0 || node.matrix[7] !== 0 || node.matrix[11] !== 0 || node.matrix[15] !== 1))) invalid('Invalid imported node transform.');
    if (node.parent === null) order.push(index);
    else if (Number.isInteger(node.parent) && node.parent >= 0 && node.parent < nodes.length && node.parent !== index) children[node.parent]!.push(index);
    else invalid('Invalid imported node parent.');
  });
  for (let i = 0; i < order.length; i++) order.push(...children[order[i]!]!);
  if (order.length !== nodes.length) invalid('Imported rig contains a parent cycle.');
  const skins = (asset.rig?.skins ?? []).map(skin => {
    if (!skin.joints.length || skin.joints.length > 65536 || !finite(skin.inverseBindMatrices, skin.joints.length * 16)
      || skin.joints.some(joint => !Number.isInteger(joint) || joint < 0 || joint >= nodes.length)) invalid('Invalid imported skin.');
    return { joints: [...skin.joints], inverseBindMatrices: skin.inverseBindMatrices.slice() };
  });
  const clips = new Map<string, { duration: number; channels: ImportedAnimationChannel[] }>();
  for (const clip of asset.clips) {
    if (!clip.id || clips.has(clip.id) || !Number.isFinite(clip.duration) || clip.duration < 0) invalid('Invalid imported animation clip.');
    const destinations = new Set<string>();
    const channels = clip.channels.map(channel => {
      if (!Number.isInteger(channel.node) || !nodes[channel.node] || nodes[channel.node]!.matrix
        || !['translation', 'rotation', 'scale'].includes(channel.path)
        || !['LINEAR', 'STEP', 'CUBICSPLINE'].includes(channel.interpolation)) invalid('Invalid imported animation target.');
      const key = `${channel.node}:${channel.path}`;
      if (destinations.has(key)) invalid('Animation channels cannot repeat a node property.');
      destinations.add(key);
      const size = channel.path === 'rotation' ? 4 : 3;
      const multiplier = channel.interpolation === 'CUBICSPLINE' ? 3 : 1;
      if (!channel.times.length || (multiplier === 3 && channel.times.length < 2)
        || !finite(channel.values, channel.times.length * size * multiplier)
        || !finite(channel.times, channel.times.length)) invalid('Invalid imported animation samples.');
      for (let i = 0; i < channel.times.length; i++) {
        if (channel.times[i]! < 0 || channel.times[i]! > clip.duration
          || (i > 0 && channel.times[i]! <= channel.times[i - 1]!)) invalid('Animation sample times must increase within the clip.');
        if (channel.path === 'rotation') {
          const first = (i * multiplier + (multiplier === 3 ? 1 : 0)) * 4;
          const length = Math.hypot(...channel.values.subarray(first, first + 4));
          if (Math.abs(length - 1) > 0.001) invalid('Animation keyframe rotations must be unit quaternions.');
        }
      }
      return { ...channel, times: channel.times.slice(), values: channel.values.slice() };
    });
    clips.set(clip.id, { duration: clip.duration, channels });
  }
  const local = new Float64Array(nodes.length * 16), world = new Float64Array(local.length);
  const nodeMatrices = new Float32Array(local.length);
  const skinMatrices = skins.map(skin => new Float32Array(skin.joints.length * 16));
  const translations = nodes.map(node => new Float64Array(node.translation));
  const rotations = nodes.map(node => new Float64Array(node.rotation));
  const scales = nodes.map(node => new Float64Array(node.scale));
  const temporary = new Float64Array(16);
  const { scale } = normalization, translation = [...normalization.translation];
  function normalizeMatrix(destination: Float32Array, offset: number, source: Float64Array, at: number): void {
    for (let i = 0; i < 16; i++) {
      const row = i % 4;
      const value = row === 3 ? source[at + i]! : source[at + i]! * scale + (i >= 12 ? translation[row]! : 0);
      if (!Number.isFinite(value) || Math.abs(value) > 3.4028234e38) invalid('Animation transform exceeds finite GPU range.');
      destination[offset + i] = value;
    }
  }
  return { evaluate(animation) {
    const controls = animation ?? { clipId: null, timeSeconds: 0, loop: false };
    if (!controls || (controls.clipId !== null && typeof controls.clipId !== 'string')
      || !Number.isFinite(controls.timeSeconds) || controls.timeSeconds < 0 || typeof controls.loop !== 'boolean') invalid('Invalid imported animation controls.');
    const clip = controls.clipId === null ? undefined : clips.get(controls.clipId);
    if (controls.clipId !== null && !clip) invalid('The requested animation clip does not exist.');
    const time = clip ? (controls.loop && clip.duration > 0 ? controls.timeSeconds % clip.duration : Math.min(clip.duration, controls.timeSeconds)) : 0;
    nodes.forEach((node, i) => { translations[i]!.set(node.translation); rotations[i]!.set(node.rotation); scales[i]!.set(node.scale); });
    for (const channel of clip?.channels ?? []) {
      sampleImportedChannel(channel, time, (channel.path === 'translation' ? translations : channel.path === 'rotation' ? rotations : scales)[channel.node]!);
    }
    for (const i of order) {
      const node = nodes[i]!;
      if (node.matrix) local.set(node.matrix, i * 16);
      else {
        const current = scales[i]!;
        if (current.some(value => !Number.isFinite(value) || value === 0)
          || Math.sign(current[0]! * current[1]! * current[2]!) !== Math.sign(node.scale[0] * node.scale[1] * node.scale[2])) {
          throw new StrataError('UNSUPPORTED_FEATURE', 'Animation cannot collapse a scale axis or change transform handedness.');
        }
        compose(local, i * 16, translations[i]!, rotations[i]!, current);
      }
      if (node.parent === null) world.set(local.subarray(i * 16, i * 16 + 16), i * 16);
      else multiply(world, i * 16, world, node.parent * 16, local, i * 16);
      normalizeMatrix(nodeMatrices, i * 16, world, i * 16);
    }
    skins.forEach((skin, i) => skin.joints.forEach((joint, index) => {
      multiply(temporary, 0, world, joint * 16, skin.inverseBindMatrices, index * 16);
      normalizeMatrix(skinMatrices[i]!, index * 16, temporary, 0);
    }));
    return { nodeMatrices, skinMatrices, clipId: controls.clipId, timeSeconds: time, loop: controls.loop };
  } };
}
