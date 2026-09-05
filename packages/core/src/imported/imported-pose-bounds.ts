import { StrataError } from '../errors.js';
import { createImportedPoseEvaluator } from './imported-animation.js';
import type { ImportedAsset, ImportedBounds, ImportedControls, ImportedPrimitive, ImportedVec3 } from './imported-types.js';

/** Fixed admission limits for one on-demand main-thread measurement. */
export const importedPoseBoundsLimits = Object.freeze({
  maxIndexEntries: 1_500_000,
  maxUniqueVertices: 250_000,
  maxJointContributions: 1_000_000,
  maxDedupBytes: 1_048_576,
  maxPrimitives: 4096,
  maxPoseNodes: 4096,
  maxPoseJoints: 32768,
  maxPoseSkins: 1024,
  maxPoseClips: 256,
  maxPoseChannels: 4096,
  maxPoseArrayBytes: 8_388_608,
  yieldWorkUnits: 4096,
});

export interface ImportedPoseBoundsOptions {
  readonly signal?: AbortSignal;
}
export interface ImportedPoseBoundsResult {
  /** Index-referenced model vertices at the resolved pose, expanded by padding. No generated ground. */
  readonly bounds: ImportedBounds;
  /** Double-precision calculation from the evaluator's float32 palettes and source buffers. */
  readonly unpaddedBounds: ImportedBounds;
  /** Maximum per-axis arithmetic error allowance, applied to both ends of unpaddedBounds. */
  readonly padding: ImportedVec3;
  readonly animation: NonNullable<ImportedControls['animation']>;
  readonly work: {
    readonly primitives: number;
    readonly indexEntries: number;
    /** Unique within each primitive instance, including instances sharing a source buffer. */
    readonly uniqueVertices: number;
    readonly staticVertices: number;
    readonly rigidVertices: number;
    readonly skinnedVertices: number;
    /** Four palette contributions per measured skinned vertex, including zero-weight slots. */
    readonly jointContributions: number;
    /** Cumulative allocated deduplication bitset bytes, not peak process memory. */
    readonly dedupBytes: number;
    readonly yields: number;
  };
  /** Main-thread elapsed time excluding explicit task-yield waits; not a CPU profiler measurement. */
  readonly cpuMs: number;
  /** Full wall-clock duration including task yields. */
  readonly elapsedMs: number;
}

const limits = importedPoseBoundsLimits;
const f32Maximum = 3.4028234663852886e38;
const f32MinimumNormal = 2 ** -126;
const unitRoundoff = 2 ** -24;
const gamma64 = 64 * unitRoundoff / (1 - 64 * unitRoundoff);
const safeMagnitude = f32Maximum / (1 + gamma64);
function invalid(message: string): never { throw new StrataError('INVALID_OPTIONS', `Imported pose bounds: ${message}`); }
function budget(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value > maximum) throw new StrataError('UNSUPPORTED_LIMIT', `Imported pose bounds ${label} exceeds the limit of ${maximum}.`);
}
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StrataError('SCENE_LOAD_ABORTED', 'Imported pose bounds measurement was canceled.', { cause: signal.reason });
}
function finiteGpuMagnitude(value: number, label: string): void {
  if (!Number.isFinite(value) || value > safeMagnitude) throw new StrataError('UNSUPPORTED_LIMIT', `Imported pose bounds cannot conservatively bound finite float32 ${label}.`);
}

/** Check lengths before the authoritative evaluator copies or visits pose arrays synchronously. */
function preflightPose(asset: ImportedAsset): void {
  if (!Array.isArray(asset.clips) || (asset.rig && (!Array.isArray(asset.rig.nodes) || !Array.isArray(asset.rig.skins)))) invalid('invalid pose collections.');
  if (!asset.normalization || !Array.isArray(asset.normalization.translation) || asset.normalization.translation.length !== 3) invalid('invalid normalization.');
  const nodes = asset.rig?.nodes ?? [], skins = asset.rig?.skins ?? [];
  budget(nodes.length, limits.maxPoseNodes, 'node count');
  budget(skins.length, limits.maxPoseSkins, 'skin count');
  budget(asset.clips.length, limits.maxPoseClips, 'clip count');
  let bytes = 0, joints = 0, channels = 0;
  for (const node of nodes) {
    if (!node || !Array.isArray(node.translation) || !Array.isArray(node.rotation) || !Array.isArray(node.scale)
      || node.translation.length !== 3 || node.rotation.length !== 4 || node.scale.length !== 3
      || (node.matrix !== undefined && (!(node.matrix instanceof Float32Array) || node.matrix.length !== 16))) invalid('invalid node data.');
    bytes += 10 * 8 + (node.matrix?.byteLength ?? 0);
  }
  for (const skin of skins) {
    if (!skin || !Array.isArray(skin.joints) || !(skin.inverseBindMatrices instanceof Float32Array)) invalid('invalid skin arrays.');
    joints += skin.joints.length; bytes += skin.inverseBindMatrices.byteLength;
    budget(joints, limits.maxPoseJoints, 'joint count'); budget(bytes, limits.maxPoseArrayBytes, 'pose array bytes');
  }
  for (const clip of asset.clips) {
    if (!clip || !Array.isArray(clip.channels)) invalid('invalid clip channels.');
    channels += clip.channels.length; budget(channels, limits.maxPoseChannels, 'channel count');
    for (const channel of clip.channels) {
      if (!channel || !(channel.times instanceof Float32Array) || !(channel.values instanceof Float32Array)) invalid('invalid animation arrays.');
      bytes += channel.times.byteLength + channel.values.byteLength;
      budget(bytes, limits.maxPoseArrayBytes, 'pose array bytes');
    }
  }
  budget(bytes, limits.maxPoseArrayBytes, 'pose array bytes');
}

function preflightPrimitives(asset: ImportedAsset): void {
  if (!Array.isArray(asset.primitives) || !asset.primitives.length) invalid('a nonempty model is required.');
  budget(asset.primitives.length, limits.maxPrimitives, 'primitive count');
  let indexEntries = 0, dedupBytes = 0;
  for (const primitive of asset.primitives) {
    if (!primitive || !(primitive.vertices instanceof Float32Array) || !primitive.vertices.length || primitive.vertices.length % 16
      || !(primitive.indices instanceof Uint32Array) || !primitive.indices.length || primitive.indices.length % 3) invalid('invalid triangle buffers.');
    indexEntries += primitive.indices.length;
    dedupBytes += Math.ceil(primitive.vertices.length / 16 / 8);
    budget(indexEntries, limits.maxIndexEntries, 'index entries'); budget(dedupBytes, limits.maxDedupBytes, 'deduplication bytes');
    const d = primitive.deformation;
    if (d !== undefined) {
      if (!d || !(d.vertices instanceof Float32Array) || d.vertices.length !== primitive.vertices.length
        || !Number.isSafeInteger(d.node) || d.node < 0 || d.node >= (asset.rig?.nodes.length ?? 0)) invalid('invalid local deformation attributes or node.');
      if (d.skin !== undefined && (!Number.isSafeInteger(d.skin) || d.skin < 0 || d.skin >= (asset.rig?.skins.length ?? 0)
        || !(d.joints instanceof Uint32Array) || !(d.weights instanceof Float32Array)
        || d.joints.length !== primitive.vertices.length / 4 || d.weights.length !== primitive.vertices.length / 4)) invalid('invalid skin influences.');
    }
  }
}

/**
 * Measures only indexed model positions, on demand. The caller must keep the
 * asset and its borrowed buffers immutable until this promise settles. Pose
 * data is copied by the same evaluator used by the renderer; geometry is not.
 * The result is a conservative arithmetic estimate, not a GPU/visibility query.
 */
export async function measureImportedPoseBounds(
  asset: ImportedAsset,
  animation: NonNullable<ImportedControls['animation']>,
  options: ImportedPoseBoundsOptions = {},
): Promise<ImportedPoseBoundsResult> {
  const started = performance.now();
  if (!options || typeof options !== 'object') invalid('invalid measurement options.');
  const signal = options.signal;
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')) invalid('invalid abort signal.');
  abort(signal);
  if (!asset || asset.version !== 1) invalid('an ImportedAsset version 1 is required.');
  if (!animation || (animation.clipId !== null && typeof animation.clipId !== 'string')
    || !Number.isFinite(animation.timeSeconds) || animation.timeSeconds < 0 || typeof animation.loop !== 'boolean') invalid('invalid animation controls.');
  const requestedAnimation = { clipId: animation.clipId, timeSeconds: animation.timeSeconds, loop: animation.loop };
  preflightPose(asset); preflightPrimitives(asset); abort(signal);
  const work = { primitives: 0, indexEntries: 0, uniqueVertices: 0, staticVertices: 0, rigidVertices: 0,
    skinnedVertices: 0, jointContributions: 0, dedupBytes: 0, yields: 0 };
  let yieldedMs = 0, units = 0;
  async function yieldTask(): Promise<void> {
    abort(signal);
    const waitStarted = performance.now();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    yieldedMs += performance.now() - waitStarted; work.yields++; units = 0;
    abort(signal);
  }
  // Give an already queued cancel a task boundary before the bounded synchronous
  // evaluator construction/evaluation. Never publish a canceled partial scan.
  await yieldTask(); abort(signal);
  const evaluator = createImportedPoseEvaluator(asset); abort(signal);
  const pose = evaluator.evaluate(requestedAnimation); abort(signal);
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity], padding = [0, 0, 0];
  const position = [0, 0, 0, 1], weights = [0, 0, 0, 0], offsets = [0, 0, 0, 0];

  function includeStatic(vertices: Float32Array, at: number): void {
    for (let axis = 0; axis < 3; axis++) {
      const value = vertices[at + axis]!;
      if (!Number.isFinite(value)) invalid('a referenced position is nonfinite.');
      minimum[axis] = Math.min(minimum[axis]!, value); maximum[axis] = Math.max(maximum[axis]!, value);
    }
  }
  function includeDeformed(primitive: ImportedPrimitive, vertex: number): void {
    const d = primitive.deformation!;
    for (let axis = 0; axis < 3; axis++) {
      const value = d.vertices[vertex * 16 + axis]!;
      if (!Number.isFinite(value)) invalid('a referenced local position is nonfinite.');
      position[axis] = value;
    }
    let palette: Float32Array, contributions: number;
    if (d.skin === undefined) {
      palette = pose.nodeMatrices; offsets[0] = d.node * 16; weights[0] = 1; contributions = 1; work.rigidVertices++;
    } else {
      palette = pose.skinMatrices[d.skin]!; contributions = 4;
      budget(work.jointContributions + 4, limits.maxJointContributions, 'joint contributions');
      let sum = 0;
      for (let slot = 0; slot < 4; slot++) {
        const joint = d.joints![vertex * 4 + slot]!, weight = d.weights![vertex * 4 + slot]!;
        if (joint >= palette.length / 16 || !Number.isFinite(weight) || weight < 0) invalid('a referenced skin influence is invalid.');
        offsets[slot] = joint * 16; weights[slot] = weight; sum += weight;
      }
      if (Math.abs(sum - 1) > .001) invalid('referenced skin weights must be normalized.');
      for (let slot = 0; slot < 4; slot++) weights[slot] = weights[slot]! / sum;
      work.skinnedVertices++; work.jointContributions += 4; units += 4;
    }
    const positionMagnitude = 1 + Math.abs(position[0]!) + Math.abs(position[1]!) + Math.abs(position[2]!);
    for (let axis = 0; axis < 3; axis++) {
      let value = 0, absoluteProducts = 0, unweightedPaletteMagnitude = 0;
      for (let column = 0; column < 4; column++) {
        let mixed = 0, absoluteMixed = 0;
        for (let slot = 0; slot < contributions; slot++) {
          const entry = palette[offsets[slot]! + column * 4 + axis]!;
          const weighted = entry * weights[slot]!;
          mixed += weighted; absoluteMixed += Math.abs(weighted); unweightedPaletteMagnitude += Math.abs(entry);
        }
        finiteGpuMagnitude(absoluteMixed, 'palette blending');
        value += mixed * position[column]!;
        absoluteProducts += absoluteMixed * Math.abs(position[column]!);
      }
      finiteGpuMagnitude(absoluteProducts, 'position arithmetic');
      // At most 64 relative-error steps cover four-weight normalization,
      // four-palette blending and affine evaluation (including reassociation).
      // The absolute term allows subnormal flushing of operands/intermediates;
      // its palette factor also covers a tiny weight times a large matrix.
      // Use absolute contributions, never |value|: cancellation is significant.
      const error = gamma64 * absoluteProducts + 64 * f32MinimumNormal * positionMagnitude * (1 + unweightedPaletteMagnitude);
      finiteGpuMagnitude(error, 'rounding padding');
      if (!Number.isFinite(value)) invalid('a measured position is nonfinite.');
      minimum[axis] = Math.min(minimum[axis]!, value); maximum[axis] = Math.max(maximum[axis]!, value);
      padding[axis] = Math.max(padding[axis]!, error);
    }
  }

  for (const primitive of asset.primitives) {
    abort(signal);
    const vertexCount = primitive.vertices.length / 16;
    const visited = new Uint8Array(Math.ceil(vertexCount / 8));
    work.primitives++; work.dedupBytes += visited.byteLength;
    for (const vertex of primitive.indices) {
      work.indexEntries++; units++;
      if (vertex >= vertexCount) invalid('a triangle references an absent vertex.');
      const byte = vertex >>> 3, mask = 1 << (vertex & 7);
      if (!(visited[byte]! & mask)) {
        budget(work.uniqueVertices + 1, limits.maxUniqueVertices, 'unique vertices');
        visited[byte] = visited[byte]! | mask; work.uniqueVertices++;
        if (primitive.deformation) includeDeformed(primitive, vertex);
        else { includeStatic(primitive.vertices, vertex * 16); work.staticVertices++; }
      }
      if (units >= limits.yieldWorkUnits) await yieldTask();
    }
  }
  abort(signal);
  const unpaddedBounds: ImportedBounds = { min: minimum as unknown as ImportedVec3, max: maximum as unknown as ImportedVec3 };
  const bounds: ImportedBounds = {
    min: minimum.map((value, axis) => value - padding[axis]!) as unknown as ImportedVec3,
    max: maximum.map((value, axis) => value + padding[axis]!) as unknown as ImportedVec3,
  };
  if (![...bounds.min, ...bounds.max].every(Number.isFinite)) invalid('the measured bounds are nonfinite.');
  const elapsedMs = performance.now() - started;
  return { bounds, unpaddedBounds, padding: padding as unknown as ImportedVec3,
    animation: { clipId: pose.clipId, timeSeconds: pose.timeSeconds, loop: pose.loop }, work,
    cpuMs: Math.max(0, elapsedMs - yieldedMs), elapsedMs };
}
