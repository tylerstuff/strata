import { StrataError } from '../errors.js';
import { abort, checkpoint, GltfAccessors, gltfError, indexed, integer, list, object, scalar, vector } from './gltf-accessor.js';
import type { GltfAccessor, GltfObject } from './gltf-accessor.js';
import { affine, gltfPositionError, identityMatrix, multiplyGltfMatrices, multiplyGltfMatrixError, nodeMatrix, normalMatrix, transformDirection, unit } from './gltf-math.js';
import type { ImportedAnimationClip, ImportedAsset, ImportedImage, ImportedMaterial, ImportedNode, ImportedPrimitive, ImportedSampler, ImportedSkin,
  ImportedTexture, ImportedVec3, ImportedVec4, LoadGltfOptions } from './imported-types.js';

const maximumItems = 16384;
const text = (value: unknown, fallback: string): string => typeof value === 'string' ? value.slice(0, 1024) : fallback;
const requiredExtensions = new Set(['KHR_materials_emissive_strength', 'KHR_materials_unlit']);
const boolean = (value: unknown, fallback: boolean): boolean => { if (value === undefined) return fallback; if (typeof value !== 'boolean') gltfError('Expected a boolean.'); return value; };

class SourceBudget {
  total = 0;
  encoded = 0;
  constructor(readonly maximum: number, readonly signal?: AbortSignal) {}
  reserve = (bytes: number): void => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.total + bytes > this.maximum) throw new StrataError('UNSUPPORTED_LIMIT', 'glTF source/decoded data exceeds maxSourceBytes.');
    this.total += bytes;
  };
  async fetch(url: URL): Promise<Uint8Array<ArrayBuffer>> {
    abort(this.signal);
    if (url.protocol === 'data:') {
      const comma = url.href.indexOf(','); if (comma < 0) gltfError('Malformed data URI.');
      const header = url.href.slice(0, comma); const body = url.href.slice(comma + 1);
      if (!/;base64$/i.test(header)) gltfError('Only base64 data URIs are supported.');
      if (body.length > (this.maximum - this.total) * 4 / 3 + 8) throw new StrataError('UNSUPPORTED_LIMIT', 'glTF data URI exceeds the source budget.');
      let binary: string; try { binary = atob(body); } catch { gltfError('Malformed base64 resource.'); }
      this.reserve(binary.length); this.encoded += binary.length;
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < bytes.length; index++) { if (index % 4096 === 0) await checkpoint(index, this.signal); bytes[index] = binary.charCodeAt(index); }
      return bytes;
    }
    if (!['http:', 'https:'].includes(url.protocol)) gltfError('Resources require HTTP(S) or base64 data URIs.');
    const response = await fetch(url, this.signal ? { signal: this.signal } : {});
    if (this.signal?.aborted) { await response.body?.cancel().catch(() => undefined); abort(this.signal); }
    if (!response.ok) { await response.body?.cancel(); gltfError(`Resource request failed (${response.status}).`); }
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > this.maximum - this.total) { await response.body?.cancel(); throw new StrataError('UNSUPPORTED_LIMIT', 'glTF resource exceeds the source budget.'); }
    if (!response.body) gltfError('Resource response has no readable body.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        abort(this.signal); const chunk = await reader.read(); abort(this.signal); if (chunk.done) break;
        this.reserve(chunk.value.byteLength); this.encoded += chunk.value.byteLength; length += chunk.value.byteLength; chunks.push(chunk.value);
      }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }
}

function parseContainer(bytes: Uint8Array<ArrayBuffer>): { document: GltfObject; binary?: Uint8Array<ArrayBuffer> } {
  let json = bytes; let binary: Uint8Array<ArrayBuffer> | undefined;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 4 && data.getUint32(0, true) === 0x46546c67) {
    if (bytes.byteLength < 20 || data.getUint32(4, true) !== 2 || data.getUint32(8, true) !== bytes.byteLength) gltfError('Invalid GLB version/length.');
    let offset = 12; let first = true;
    while (offset < bytes.byteLength) {
      if (offset + 8 > bytes.byteLength) gltfError('Truncated GLB chunk.');
      const length = data.getUint32(offset, true); const type = data.getUint32(offset + 4, true); offset += 8;
      if (length % 4 || offset + length > bytes.byteLength) gltfError('Invalid GLB chunk range.');
      if (first) { if (type !== 0x4e4f534a) gltfError('GLB JSON must be first.'); json = bytes.subarray(offset, offset + length); }
      else if (type === 0x4e4942) { if (binary) gltfError('Duplicate GLB binary chunk.'); binary = bytes.subarray(offset, offset + length); }
      else if (type === 0x4e4f534a) gltfError('Duplicate GLB JSON chunk.');
      first = false; offset += length;
    }
  }
  let document: GltfObject;
  try { document = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)), 'document'); }
  catch (cause) { throw new StrataError('SCENE_LOAD_FAILED', 'glTF JSON is invalid.', { cause }); }
  const asset = object(document.asset, 'asset'); if (asset.version !== '2.0' || (asset.minVersion !== undefined && asset.minVersion !== '2.0')) gltfError('Only glTF 2.0 is supported.');
  for (const extension of list(document.extensionsRequired ?? [], 'extensionsRequired', 128)) {
    if (typeof extension !== 'string' || !requiredExtensions.has(extension)) throw new StrataError('UNSUPPORTED_FEATURE', `Unsupported required glTF extension: ${String(extension)}.`);
  }
  return { document, ...(binary ? { binary } : {}) };
}

/** Metadata parse only; the GPU renderer owns bounded bitmap decoding and resizing. */
export function gltfImageDimensions(bytes: Uint8Array<ArrayBuffer>, maximum: number): { mimeType: 'image/png' | 'image/jpeg'; width: number; height: number } {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let width = 0; let height = 0; let mimeType: 'image/png' | 'image/jpeg';
  if (bytes.length >= 33 && data.getUint32(0) === 0x89504e47 && data.getUint32(4) === 0x0d0a1a0a && data.getUint32(8) === 13 && data.getUint32(12) === 0x49484452) {
    mimeType = 'image/png'; width = data.getUint32(16); height = data.getUint32(20);
  } else if (bytes.length >= 4 && data.getUint16(0) === 0xffd8) {
    mimeType = 'image/jpeg'; let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) gltfError('Malformed JPEG marker.');
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]; if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) gltfError('Truncated JPEG segment.'); const length = data.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) gltfError('Invalid JPEG segment length.');
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) gltfError('Truncated JPEG dimensions.'); height = data.getUint16(offset + 3); width = data.getUint16(offset + 5); break;
      }
      offset += length;
    }
  } else gltfError('Only PNG and JPEG images are supported.');
  if (!width || !height || width > maximum || height > maximum) throw new StrataError('UNSUPPORTED_LIMIT', 'glTF image dimensions exceed the source image limit or are invalid.');
  return { mimeType, width, height };
}

function materialData(document: GltfObject): ImportedMaterial[] {
  const textures = list(document.textures ?? [], 'textures', maximumItems); const images = list(document.images ?? [], 'images', 256);
  const samplers = list(document.samplers ?? [], 'samplers', maximumItems);
  const choose = <T extends number>(value: unknown, fallback: T, values: readonly T[]): T => {
    const result = value ?? fallback; if (!values.includes(result as T)) gltfError('Unsupported texture sampler enum.'); return result as T;
  };
  const texture = (info: unknown): ImportedTexture | undefined => {
    if (info === undefined) return undefined; const value = object(info, 'textureInfo');
    if (integer(value.texCoord ?? 0, 'textureInfo.texCoord') !== 0) throw new StrataError('UNSUPPORTED_FEATURE', 'This glTF path supports referenced TEXCOORD_0 only.');
    if (value.extensions !== undefined && object(value.extensions, 'textureInfo.extensions').KHR_texture_transform !== undefined) throw new StrataError('UNSUPPORTED_FEATURE', 'Texture transforms are not supported.');
    const source = indexed(textures, value.index, 'texture.index'); const image = integer(source.source, 'texture.source', 0, images.length - 1);
    const sampler = source.sampler === undefined ? {} : indexed(samplers, source.sampler, 'texture.sampler');
    const result: ImportedSampler = { magFilter: choose(sampler.magFilter, 9729, [9728, 9729]), minFilter: choose(sampler.minFilter, 9987, [9728, 9729, 9984, 9985, 9986, 9987]),
      wrapS: choose(sampler.wrapS, 10497, [33071, 33648, 10497]), wrapT: choose(sampler.wrapT, 10497, [33071, 33648, 10497]) };
    return { image, sampler: result };
  };
  const materials = list(document.materials ?? [], 'materials', maximumItems);
  return [...materials, {}].map((entry, index) => {
    const material = object(entry, 'material'); const pbr = object(material.pbrMetallicRoughness ?? {}, 'material.pbrMetallicRoughness');
    const alphaMode = material.alphaMode ?? 'OPAQUE'; if (alphaMode !== 'OPAQUE' && alphaMode !== 'MASK') throw new StrataError('UNSUPPORTED_FEATURE', 'Only OPAQUE and MASK glTF materials are supported.');
    const extensions = object(material.extensions ?? {}, 'material.extensions'); const strength = object(extensions.KHR_materials_emissive_strength ?? {}, 'emissive strength');
    if (extensions.KHR_materials_unlit !== undefined) object(extensions.KHR_materials_unlit, 'KHR_materials_unlit');
    const normal = object(material.normalTexture ?? {}, 'normalTexture'); const occlusion = object(material.occlusionTexture ?? {}, 'occlusionTexture');
    const result: ImportedMaterial = { name: text(material.name, `material-${index}`),
      baseColorFactor: vector(pbr.baseColorFactor ?? [1, 1, 1, 1], 4, 'baseColorFactor', 0, 1) as unknown as ImportedVec4,
      metallicFactor: scalar(pbr.metallicFactor ?? 1, 'metallicFactor', 0, 1), roughnessFactor: scalar(pbr.roughnessFactor ?? 1, 'roughnessFactor', 0, 1),
      emissiveFactor: vector(material.emissiveFactor ?? [0, 0, 0], 3, 'emissiveFactor', 0, 1) as unknown as ImportedVec3,
      emissiveStrength: scalar(strength.emissiveStrength ?? 1, 'emissiveStrength', 0, 1e6), normalScale: scalar(normal.scale ?? 1, 'normalTexture.scale'),
      occlusionStrength: scalar(occlusion.strength ?? 1, 'occlusionTexture.strength', 0, 1), alphaMode,
      alphaCutoff: scalar(material.alphaCutoff ?? 0.5, 'alphaCutoff', 0), doubleSided: boolean(material.doubleSided, false),
      ...(extensions.KHR_materials_unlit === undefined ? {} : { unlit: true }),
    };
    const bindings = { baseColorTexture: texture(pbr.baseColorTexture), metallicRoughnessTexture: texture(pbr.metallicRoughnessTexture), normalTexture: texture(material.normalTexture),
      occlusionTexture: texture(material.occlusionTexture), emissiveTexture: texture(material.emissiveTexture) };
    return { ...result, ...Object.fromEntries(Object.entries(bindings).filter(([, value]) => value !== undefined)) };
  });
}

async function hierarchy(document: GltfObject, reserve: (bytes: number) => void, signal?: AbortSignal) {
  const source = list(document.nodes ?? [], 'nodes', maximumItems).map((value, index) => object(value, `nodes[${index}]`));
  const parents = new Int32Array(source.length).fill(-1); const children = source.map(node => list(node.children ?? [], 'node.children', maximumItems).map(value => integer(value, 'node.child', 0, source.length - 1)));
  children.forEach((values, parent) => values.forEach(child => { if (parents[child] !== -1 || child === parent) gltfError('Node hierarchy contains repeated parents or self-reference.'); parents[child] = parent; }));
  const local = source.map(node => { if (node.matrix !== undefined) reserve(128); return nodeMatrix(node); });
  const worlds: Float64Array<ArrayBuffer>[] = [];
  const errors: (Float64Array<ArrayBuffer> | undefined)[] = [];
  const queue = Array.from(parents).flatMap((parent, index) => parent < 0 ? [index] : []);
  for (let index = 0; index < queue.length; index++) {
    if (index % 4096 === 0) await checkpoint(index, signal);
    const node = queue[index]!, parent = parents[node]!;
    worlds[node] = parent < 0 ? local[node]! : multiplyGltfMatrices(worlds[parent]!, local[node]!);
    if (parent >= 0) { reserve(128); errors[node] = multiplyGltfMatrixError(worlds[parent]!, local[node]!, errors[parent]); }
    queue.push(...children[node]!);
  }
  if (queue.length !== source.length) gltfError('Node hierarchy has a cycle.');
  const scenes = list(document.scenes ?? [], 'scenes', maximumItems);
  const roots = scenes.length ? list(indexed(scenes, document.scene ?? 0, 'scene').nodes ?? [], 'scene.nodes', maximumItems).map(value => integer(value, 'scene.node', 0, source.length - 1))
    : Array.from(parents).flatMap((parent, index) => parent < 0 ? [index] : []);
  const active = new Set<number>(); const pending = [...roots];
  for (const root of roots) if (parents[root] !== -1) gltfError('A scene root has a parent.');
  for (let index = 0; index < pending.length; index++) {
    const node = pending[index]!; if (active.has(node)) gltfError('Scene nodes are repeated.'); active.add(node); pending.push(...children[node]!);
  }
  const nodes: ImportedNode[] = source.map((node, index) => ({ parent: parents[index]! < 0 ? null : parents[index]!,
    translation: vector(node.translation ?? [0, 0, 0], 3, 'node.translation') as unknown as ImportedVec3,
    rotation: vector(node.rotation ?? [0, 0, 0, 1], 4, 'node.rotation') as unknown as ImportedVec4,
    scale: vector(node.scale ?? [1, 1, 1], 3, 'node.scale') as unknown as ImportedVec3,
    // Keep JSON matrix precision through retained-pose normalization as well as
    // the baked path. This reuses the already allocated local matrix.
    ...(node.matrix === undefined ? {} : { matrix: local[index]! }),
  }));
  return { source, nodes, worlds, errors, active };
}

async function animationData(document: GltfObject, accessors: GltfAccessors, nodes: readonly ImportedNode[], reserve: (bytes: number) => void, signal?: AbortSignal): Promise<ImportedAnimationClip[]> {
  const animations = list(document.animations ?? [], 'animations', 1024); const clips: ImportedAnimationClip[] = [];
  for (const [index, source] of animations.entries()) {
    const animation = object(source, 'animation'); const samplers = list(animation.samplers, 'animation.samplers', maximumItems);
    const channels: ImportedAnimationClip['channels'][number][] = []; const seen = new Set<string>(); let duration = 0;
    for (const entry of list(animation.channels, 'animation.channels', maximumItems)) {
      const channel = object(entry, 'animation.channel'); const target = object(channel.target, 'animation.target');
      const node = integer(target.node, 'animation.target.node', 0, nodes.length - 1); const path = target.path;
      if (path !== 'translation' && path !== 'rotation' && path !== 'scale') throw new StrataError('UNSUPPORTED_FEATURE', 'Only TRS animation channels are supported; morph animation is unsupported.');
      if (nodes[node]!.matrix) gltfError('Animation cannot target a matrix-authored node.');
      const key = `${node}:${path}`; if (seen.has(key)) gltfError('Animation repeats a node/property channel.'); seen.add(key);
      const sampler = indexed(samplers, channel.sampler, 'animation.sampler'); const interpolation = sampler.interpolation ?? 'LINEAR';
      if (interpolation !== 'LINEAR' && interpolation !== 'STEP' && interpolation !== 'CUBICSPLINE') gltfError('Unsupported animation interpolation.');
      const times = await accessors.read(sampler.input); const values = await accessors.read(sampler.output); const width = path === 'rotation' ? 4 : 3;
      if (times.type !== 'SCALAR' || times.componentType !== 5126 || values.componentType !== 5126 || values.components !== width
        || values.type !== `VEC${width}` || (interpolation === 'CUBICSPLINE' && times.count < 2)
        || values.count !== times.count * (interpolation === 'CUBICSPLINE' ? 3 : 1)) gltfError('Animation accessor layout/count is invalid.');
      for (let key = 0; key < times.count; key++) {
        if (key % 4096 === 0) await checkpoint(key, signal);
        if (times.values[key]! < 0 || (key > 0 && times.values[key]! <= times.values[key - 1]!)) gltfError('Animation times must be nonnegative and strictly increasing.');
        if (path === 'rotation') {
          const offset = (key * (interpolation === 'CUBICSPLINE' ? 3 : 1) + (interpolation === 'CUBICSPLINE' ? 1 : 0)) * 4;
          if (Math.abs(Math.hypot(...values.values.subarray(offset, offset + 4)) - 1) > 0.001) gltfError('Animation keyframe rotations must be unit quaternions.');
        }
      }
      reserve((times.values.length + values.values.length) * 4); duration = Math.max(duration, times.values[times.count - 1]!);
      channels.push({ node, path, interpolation, times: new Float32Array(times.values), values: new Float32Array(values.values) });
    }
    clips.push({ id: `animation-${index}`, name: text(animation.name, `Animation ${index + 1}`), duration, channels });
  }
  return clips;
}

/** Optional bounded glTF/GLB loader: rest-pose flattening plus retained TRS/skin animation source. */
export async function loadGltf(input: string | URL, options: LoadGltfOptions = {}): Promise<ImportedAsset> {
  if (!options || typeof options !== 'object') throw new StrataError('INVALID_OPTIONS', 'glTF load options must be an object.');
  const maximumSource = integer(options.maxSourceBytes ?? 256 * 1024 * 1024, 'maxSourceBytes', 1, 1024 * 1024 * 1024);
  const maximumGeometry = integer(options.maxGeometryBytes ?? 256 * 1024 * 1024, 'maxGeometryBytes', 1, 1024 * 1024 * 1024);
  const maxTextureDimension = integer(options.maxTextureDimension ?? 2048, 'maxTextureDimension', 1, 16384);
  const maxSourceDimension = integer(options.maxSourceImageDimension ?? 16384, 'maxSourceImageDimension', 1, 32768);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new StrataError('INVALID_OPTIONS', 'glTF signal must be an AbortSignal.');
  let url: URL; try { url = new URL(input, typeof document === 'undefined' ? undefined : document.baseURI); } catch { gltfError('Invalid source URL.'); }
  const budget = new SourceBudget(maximumSource, options.signal); let outputBytes = 0;
  const reserve = (bytes: number): void => { if (!Number.isSafeInteger(bytes) || bytes < 0 || outputBytes + bytes > maximumGeometry) throw new StrataError('UNSUPPORTED_LIMIT', 'glTF output exceeds maxGeometryBytes.'); outputBytes += bytes; };
  try {
    const container = parseContainer(await budget.fetch(url)); const doc = container.document;
    const buffers: Uint8Array<ArrayBuffer>[] = [];
    for (const [index, value] of list(doc.buffers ?? [], 'buffers', 256).entries()) {
      const buffer = object(value, 'buffer'); const length = integer(buffer.byteLength, 'buffer.byteLength', 1, maximumSource);
      let data: Uint8Array<ArrayBuffer>;
      if (buffer.uri === undefined) { if (index !== 0 || !container.binary || container.binary.length - length > 3) gltfError('Missing or invalid GLB binary buffer.'); data = container.binary; }
      else { if (typeof buffer.uri !== 'string') gltfError('buffer.uri must be a string.'); data = await budget.fetch(new URL(buffer.uri, url)); }
      if (data.byteLength < length) gltfError('Resource is shorter than its declared buffer.'); buffers.push(data.subarray(0, length));
    }
    const accessors = new GltfAccessors(doc, buffers, budget.reserve, options.signal); const graph = await hierarchy(doc, budget.reserve, options.signal);
    const materials = materialData(doc); const images: ImportedImage[] = [];
    for (const [index, value] of list(doc.images ?? [], 'images', 256).entries()) {
      const image = object(value, 'image'); let bytes: Uint8Array<ArrayBuffer>;
      if (image.uri !== undefined) { if (image.bufferView !== undefined || typeof image.uri !== 'string') gltfError('Image must choose URI or bufferView.'); bytes = await budget.fetch(new URL(image.uri, url)); }
      else { if (image.mimeType !== 'image/png' && image.mimeType !== 'image/jpeg') gltfError('Embedded images require PNG/JPEG mimeType.'); const source = accessors.view(image.bufferView); if (source.stride !== undefined) gltfError('Images cannot use strided bufferViews.'); budget.reserve(source.bytes.byteLength); bytes = source.bytes.slice(); }
      const dimensions = gltfImageDimensions(bytes, maxSourceDimension);
      if (image.mimeType !== undefined && image.mimeType !== dimensions.mimeType) gltfError('Image MIME disagrees with encoded content.');
      images.push({ name: text(image.name, `image-${index}`), bytes, ...dimensions });
    }
    const skins: ImportedSkin[] = []; const skinMatrices: Float64Array<ArrayBuffer>[][] = [], skinErrors: Float64Array<ArrayBuffer>[][] = [];
    for (const value of list(doc.skins ?? [], 'skins', maximumItems)) {
      const skin = object(value, 'skin'); const joints = list(skin.joints, 'skin.joints', 1024).map(value => integer(value, 'skin.joint', 0, graph.nodes.length - 1));
      if (!joints.length || new Set(joints).size !== joints.length) gltfError('Skin joints must be nonempty and unique.');
      const source = skin.inverseBindMatrices === undefined ? undefined : await accessors.read(skin.inverseBindMatrices);
      if (source && (source.type !== 'MAT4' || source.componentType !== 5126 || source.count < joints.length)) gltfError('Invalid inverse bind matrices.');
      reserve(joints.length * 64); budget.reserve(joints.length * 128);
      const inverseBindMatrices = new Float32Array(joints.length * 16); const matrices = [], errors = [];
      for (let joint = 0; joint < joints.length; joint++) {
        const inverse = source ? source.values.subarray(joint * 16, joint * 16 + 16) : identityMatrix(); affine(inverse);
        inverseBindMatrices.set(inverse, joint * 16); matrices.push(multiplyGltfMatrices(graph.worlds[joints[joint]!]!, inverse));
        errors.push(multiplyGltfMatrixError(graph.worlds[joints[joint]!]!, inverse, graph.errors[joints[joint]!]));
      }
      skins.push({ joints, inverseBindMatrices }); skinMatrices.push(matrices); skinErrors.push(errors);
    }
    const clips = await animationData(doc, accessors, graph.nodes, reserve, options.signal); const retain = clips.length > 0 || skins.length > 0;
    const meshes = list(doc.meshes ?? [], 'meshes', maximumItems); const primitives: ImportedPrimitive[] = []; const warnings = new Set<string>();
    const worldPositions: Float64Array<ArrayBuffer>[] = [];
    const missingAttributes: { normal: boolean; tangent: boolean }[] = [];
    let positionError = 0;
    let meshInstances = 0; let skinnedMeshInstances = 0; let vertices = 0; let triangles = 0;
    for (const node of graph.active) {
      abort(options.signal); const source = graph.source[node]!; if (source.mesh === undefined) continue;
      const mesh = indexed(meshes, source.mesh, 'node.mesh'); meshInstances++;
      const skin = source.skin === undefined ? undefined : integer(source.skin, 'node.skin', 0, skins.length - 1);
      if (skin !== undefined) { skinnedMeshInstances++; if (skins[skin]!.joints.some(joint => !graph.active.has(joint))) gltfError('Skin joint is outside the selected scene.'); }
      for (const [index, entry] of list(mesh.primitives, 'mesh.primitives', maximumItems).entries()) {
        const primitive = object(entry, 'primitive'); if ((primitive.mode ?? 4) !== 4) throw new StrataError('UNSUPPORTED_FEATURE', 'Only glTF triangle-list primitives are supported.');
        if (primitive.targets !== undefined) {
          const weights = vector(source.weights ?? mesh.weights ?? Array(list(primitive.targets, 'morph targets', 256).length).fill(0), list(primitive.targets, 'morph targets', 256).length, 'morph weights');
          if (weights.some(value => value !== 0)) throw new StrataError('UNSUPPORTED_FEATURE', 'Nonzero morph rest weights are unsupported.'); warnings.add('Zero-weight morph targets are not rendered.');
        }
        const material = primitive.material === undefined ? materials.length - 1 : integer(primitive.material, 'primitive.material', 0, materials.length - 2);
        const attributes = object(primitive.attributes, 'primitive.attributes');
        const position = await accessors.read(attributes.POSITION);
        if (position.type !== 'VEC3' || position.componentType !== 5126) gltfError('POSITION must be a float VEC3.');
        const read = async (name: string, widths: readonly number[], allowed: readonly number[], normalizedInteger = true): Promise<GltfAccessor | undefined> => {
          if (attributes[name] === undefined) return undefined; const data = await accessors.read(attributes[name]);
          if (data.count !== position.count || data.type !== `VEC${data.components}` || !widths.includes(data.components) || !allowed.includes(data.componentType)
            || (normalizedInteger && data.componentType !== 5126 && !data.normalized)) gltfError(`Invalid ${name} accessor.`); return data;
        };
        const normal = await read('NORMAL', [3], [5126]); const tangent = await read('TANGENT', [4], [5126]);
        if (tangent && !normal) gltfError('TANGENT requires a NORMAL attribute.');
        const uv = await read('TEXCOORD_0', [2], [5121, 5123, 5126]); const color = await read('COLOR_0', [3, 4], [5121, 5123, 5126]);
        const joints = await read('JOINTS_0', [4], [5121, 5123], false); const weights = await read('WEIGHTS_0', [4], [5121, 5123, 5126]);
        if (joints?.normalized) gltfError('Joint indices cannot be normalized.');
        if (attributes.JOINTS_1 !== undefined || attributes.WEIGHTS_1 !== undefined) throw new StrataError('UNSUPPORTED_FEATURE', 'More than four skin influences are unsupported.');
        if (skin !== undefined && (!joints || !weights)) gltfError('Skinned primitive requires JOINTS_0 and WEIGHTS_0.');
        if (!uv && Object.keys(materials[material]!).some(key => key.endsWith('Texture'))) gltfError('Textured material requires TEXCOORD_0.');
        const indexData = primitive.indices === undefined ? undefined : await accessors.read(primitive.indices);
        if (indexData && (indexData.type !== 'SCALAR' || ![5121, 5123, 5125].includes(indexData.componentType) || indexData.normalized)) gltfError('Indices must be unsigned scalars.');
        const indexCount = indexData?.count ?? position.count; if (indexCount % 3) gltfError('Triangle index count is not divisible by three.');
        const count = normal ? position.count : indexCount;
        reserve(count * 64 + indexCount * 4 + (retain ? count * 64 + (skin === undefined ? 0 : count * 32) : 0));
        // Transformed positions must not enter a float32 buffer until the whole
        // asset has been centered/scaled. Charge the temporary 24 bytes/vertex
        // before allocating it, including expanded flat-shaded vertices.
        budget.reserve(count * 3 * 8);
        const precisePositions = new Float64Array(count * 3);
        const local = new Float32Array(count * 16); const baked = new Float32Array(count * 16); const indices = new Uint32Array(indexCount);
        const retainedJoints = skin === undefined ? undefined : new Uint32Array(count * 4); const retainedWeights = skin === undefined ? undefined : new Float32Array(count * 4);
        // Reuse the skin blend's two bounded matrices rather than allocating per vertex.
        if (skin !== undefined) budget.reserve(256);
        const blended = skin === undefined ? undefined : new Float64Array(16), blendError = skin === undefined ? undefined : new Float64Array(16);
        const sourceIndex = (index: number): number => {
          const value = indexData?.values[index] ?? index; if (!Number.isInteger(value) || value < 0 || value >= position.count) gltfError('Vertex index exceeds POSITION count.'); return value;
        };
        for (let index = 0; index < indexCount; index++) {
          if (index % 4096 === 0) await checkpoint(index, options.signal);
          indices[index] = normal ? sourceIndex(index) : index;
        }
        const signs = new Int8Array(count); const rigidNormal = skin === undefined ? normalMatrix(graph.worlds[node]!) : undefined;
        for (let vertex = 0; vertex < count; vertex++) {
          if (vertex % 4096 === 0) await checkpoint(vertex, options.signal);
          const sourceVertex = normal ? vertex : sourceIndex(vertex); const at = vertex * 16;
          local.set(position.values.subarray(sourceVertex * 3, sourceVertex * 3 + 3), at);
          local.set(normal?.values.subarray(sourceVertex * 3, sourceVertex * 3 + 3) ?? [0, 1, 0], at + 3);
          local.set(uv?.values.subarray(sourceVertex * 2, sourceVertex * 2 + 2) ?? [0, 0], at + 6);
          local.set(tangent?.values.subarray(sourceVertex * 4, sourceVertex * 4 + 4) ?? [1, 0, 0, 1], at + 8);
          local.set([1, 1, 1, 1], at + 12); if (color) local.set(color.values.subarray(sourceVertex * color.components, sourceVertex * color.components + color.components), at + 12);
          let matrix = graph.worlds[node]!;
          let matrixError = graph.errors[node];
          if (skin !== undefined) {
            matrix = blended!; matrix.fill(0); matrixError = blendError!; matrixError.fill(0); let sum = 0;
            for (let influence = 0; influence < 4; influence++) {
              const weight = weights!.values[sourceVertex * 4 + influence]!; const joint = joints!.values[sourceVertex * 4 + influence]!;
              if (weight < 0 || weight > 1 || !Number.isInteger(joint) || joint < 0 || joint >= skins[skin]!.joints.length) gltfError('Skin weight/joint index is invalid.'); sum += weight;
            }
            if (sum <= 1e-12) gltfError('Skin weights sum to zero.');
            for (let influence = 0; influence < 4; influence++) {
              const weight = weights!.values[sourceVertex * 4 + influence]! / sum; const joint = joints!.values[sourceVertex * 4 + influence]!;
              retainedJoints![vertex * 4 + influence] = joint; retainedWeights![vertex * 4 + influence] = weight;
              const transform = skinMatrices[skin]![joint]!, error = skinErrors[skin]![joint]!;
              for (let component = 0; component < 16; component++) {
                matrix[component]! += weight * transform[component]!;
                // Eight roundings allow weight normalization, multiplication and
                // four-term blending; inflate the bound's own accumulation.
                matrixError[component]! += (Math.abs(weight) * error[component]! + 8 * Number.EPSILON * Math.abs(weight * transform[component]!) + 8 * Number.MIN_VALUE) * (1 + 16 * Number.EPSILON);
              }
            }
          }
          const nMatrix = rigidNormal ?? normalMatrix(matrix); signs[vertex] = nMatrix.sign;
          const p = transformDirection(matrix, local[at]!, local[at + 1]!, local[at + 2]!);
          baked.set(local.subarray(at, at + 16), at);
          precisePositions.set([p[0] + matrix[12]!, p[1] + matrix[13]!, p[2] + matrix[14]!], vertex * 3);
          positionError = Math.max(positionError, ...gltfPositionError(matrix, matrixError, local[at]!, local[at + 1]!, local[at + 2]!));
          if (normal) {
            const n = unit(...transformDirection(nMatrix.matrix, local[at + 3]!, local[at + 4]!, local[at + 5]!)); baked.set(n, at + 3);
            if (tangent) {
              if (local[at + 11] !== 1 && local[at + 11] !== -1) gltfError('Tangent handedness must be +/-1.');
              const t = transformDirection(matrix, local[at + 8]!, local[at + 9]!, local[at + 10]!); const dot = t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
              baked.set(unit(t[0] - dot * n[0], t[1] - dot * n[1], t[2] - dot * n[2]), at + 8); baked[at + 11] = local[at + 11]! * nMatrix.sign;
            }
          }
        }
        // Local faces retain source winding; only baked world-space indices need parity repair.
        if (!normal) await generateNormals(local, indices, options.signal);
        for (let index = 0; index < indexCount; index += 3) {
          if (index % 12288 === 0) await checkpoint(index / 3, options.signal);
          const a = indices[index]!, b = indices[index + 1]!, c = indices[index + 2]!;
          if (signs[a] !== signs[b] || signs[a] !== signs[c]) throw new StrataError('UNSUPPORTED_FEATURE', 'Mixed skin handedness within a triangle is unsupported.');
          if (signs[a]! < 0) { indices[index + 1] = c; indices[index + 2] = b; }
        }
        if (!normal) warnings.add('Missing normals use deindexed flat faces.');
        if (!tangent) { budget.reserve(count * 6 * 8 * 2); await generateTangents(local, indices, options.signal); if (materials[material]!.normalTexture) warnings.add('Missing tangents use UV-derived tangents; exact MikkTSpace parity is not guaranteed.'); }
        if (!baked.every(Number.isFinite) || !local.every(Number.isFinite)) gltfError('Flattened geometry exceeds finite float32.');
        vertices += count; triangles += indexCount / 3;
        primitives.push({ name: text(mesh.name, `node-${node}`) + `/primitive-${index}`, vertices: baked, indices, material,
          ...(retain ? { deformation: { node, vertices: local, ...(skin === undefined ? {} : { skin, joints: retainedJoints!, weights: retainedWeights! }) } } : {}) });
        worldPositions.push(precisePositions);
        missingAttributes.push({ normal: !normal, tangent: !tangent });
        if (primitives.length > maximumItems) gltfError('Too many mesh primitive instances.');
      }
    }
    if (!primitives.length) gltfError('Selected scene contains no renderable triangles.');
    const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
    for (const positions of worldPositions) for (let vertex = 0; vertex < positions.length / 3; vertex++) {
      if (vertex % 4096 === 0) await checkpoint(vertex, options.signal);
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis]!, positions[vertex * 3 + axis]!); max[axis] = Math.max(max[axis]!, positions[vertex * 3 + axis]!);
      }
    }
    const extent = Math.max(...max.map((value, axis) => value - min[axis]!)); if (!Number.isFinite(extent) || extent <= 1e-12) gltfError('Scene has degenerate or non-finite bounds.');
    const scale = 2 / extent;
    const center: ImportedVec3 = [min[0]! / 2 + max[0]! / 2, min[1]!, min[2]! / 2 + max[2]! / 2];
    const translation = center.map(value => -value * scale) as unknown as ImportedVec3;
    // Bound rest-pose affine cancellation relative to this asset's normalized
    // size, including hierarchy errors even if large ancestor offsets cancel.
    // Two 64-operation f32 error budgets are an admission allowance, not a claim
    // of exact GPU parity or arbitrary large-world/animation precision.
    const u32 = 2 ** -24, precisionAllowance = 2 * 64 * u32 / (1 - 64 * u32);
    const normalizationError = 8 * Number.EPSILON * Math.max(...min.map(Math.abs), ...max.map(Math.abs)) * scale;
    if (!Number.isFinite(scale) || !translation.every(Number.isFinite) || !Number.isFinite(positionError)
      || extent <= 2 * positionError || 8 * positionError / (extent - 2 * positionError) + normalizationError > precisionAllowance) {
      throw new StrataError('UNSUPPORTED_LIMIT', 'glTF rest transforms cannot preserve the normalized position precision allowance. Recenter or rescale the source hierarchy.');
    }
    const normalizedMin = [Infinity,Infinity,Infinity], normalizedMax = [-Infinity,-Infinity,-Infinity];
    for (const [index, primitive] of primitives.entries()) for (let vertex = 0; vertex < primitive.vertices.length / 16; vertex++) {
      if (vertex % 4096 === 0) await checkpoint(vertex, options.signal);
      for (let axis = 0; axis < 3; axis++) {
        const value = Math.fround((worldPositions[index]![vertex * 3 + axis]! - center[axis]!) * scale);
        if (!Number.isFinite(value)) throw new StrataError('UNSUPPORTED_LIMIT', 'glTF normalized positions exceed finite float32.');
        primitive.vertices[vertex * 16 + axis] = value;
        normalizedMin[axis] = Math.min(normalizedMin[axis]!, value); normalizedMax[axis] = Math.max(normalizedMax[axis]!, value);
      }
    }
    for (const [index, primitive] of primitives.entries()) {
      if (missingAttributes[index]!.normal) await generateNormals(primitive.vertices, primitive.indices, options.signal, worldPositions[index]);
      if (missingAttributes[index]!.tangent) await generateTangents(primitive.vertices, primitive.indices, options.signal, worldPositions[index]);
      if (!primitive.vertices.every(Number.isFinite)) gltfError('Normalized geometry exceeds finite float32.');
    }
    abort(options.signal);
    return { version: 1, sourceUrl: url.href, primitives, materials, images,
      sourceBounds: { min: min as unknown as ImportedVec3, max: max as unknown as ImportedVec3 },
      bounds: { min: normalizedMin as unknown as ImportedVec3, max: normalizedMax as unknown as ImportedVec3 },
      normalization: { scale, translation }, maxTextureDimension, warnings: [...warnings], clips,
      ...(retain ? { rig: { nodes: graph.nodes, skins } } : {}),
      stats: { meshInstances, primitives: primitives.length, vertices, triangles, materials: materials.length, images: images.length, encodedBytes: budget.encoded,
        geometryBytes: primitives.reduce((sum, primitive) => sum + primitive.vertices.byteLength + primitive.indices.byteLength, 0), skinnedMeshInstances, animationClips: clips.length } };
  } catch (cause) {
    abort(options.signal); if (cause instanceof StrataError) throw cause;
    throw new StrataError('SCENE_LOAD_FAILED', 'glTF loading failed.', { cause });
  }
}

async function generateNormals(vertices: Float32Array<ArrayBuffer>, indices: Uint32Array<ArrayBuffer>, signal?: AbortSignal, positions?: Float64Array<ArrayBuffer>): Promise<void> {
  for (let index = 0; index < indices.length; index += 3) {
    if (index % 12288 === 0) await checkpoint(index / 3, signal);
    const a = indices[index]! * 16, b = indices[index + 1]! * 16, c = indices[index + 2]! * 16;
    const source = positions ?? vertices, stride = positions ? 3 : 16;
    const pa = a / 16 * stride, pb = b / 16 * stride, pc = c / 16 * stride;
    const u = [source[pb]! - source[pa]!, source[pb + 1]! - source[pa + 1]!, source[pb + 2]! - source[pa + 2]!];
    const v = [source[pc]! - source[pa]!, source[pc + 1]! - source[pa + 1]!, source[pc + 2]! - source[pa + 2]!];
    const n = unit(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
    for (const at of [a, b, c]) vertices.set(n, at + 3);
  }
}
async function generateTangents(vertices: Float32Array<ArrayBuffer>, indices: Uint32Array<ArrayBuffer>, signal?: AbortSignal, positions?: Float64Array<ArrayBuffer>): Promise<void> {
  const sum = new Float64Array(vertices.length / 16 * 6);
  for (let index = 0; index < indices.length; index += 3) {
    if (index % 12288 === 0) await checkpoint(index / 3, signal);
    const ids = [indices[index]!, indices[index + 1]!, indices[index + 2]!]; const [a, b, c] = ids.map(value => value * 16) as [number, number, number];
    const du1 = vertices[b + 6]! - vertices[a + 6]!, dv1 = vertices[b + 7]! - vertices[a + 7]!, du2 = vertices[c + 6]! - vertices[a + 6]!, dv2 = vertices[c + 7]! - vertices[a + 7]!;
    const determinant = du1 * dv2 - du2 * dv1; if (Math.abs(determinant) < 1e-12) continue;
    const source = positions ?? vertices, stride = positions ? 3 : 16;
    const pa = ids[0]! * stride, pb = ids[1]! * stride, pc = ids[2]! * stride;
    for (let axis = 0; axis < 3; axis++) {
      const p = source[pb + axis]! - source[pa + axis]!, q = source[pc + axis]! - source[pa + axis]!;
      for (const id of ids) { sum[id * 6 + axis]! += (p * dv2 - q * dv1) / determinant; sum[id * 6 + axis + 3]! += (q * du1 - p * du2) / determinant; }
    }
  }
  for (let vertex = 0; vertex < vertices.length / 16; vertex++) {
    if (vertex % 4096 === 0) await checkpoint(vertex, signal);
    const at = vertex * 16; const n = [vertices[at + 3]!, vertices[at + 4]!, vertices[at + 5]!]; let t = [sum[vertex * 6]!, sum[vertex * 6 + 1]!, sum[vertex * 6 + 2]!];
    const dot = t.reduce((total, value, axis) => total + value * n[axis]!, 0); t = t.map((value, axis) => value - dot * n[axis]!);
    if (Math.hypot(...t) < 1e-12) t = Math.abs(n[1]!) < 0.9 ? [n[2]!, 0, -n[0]!] : [0, -n[2]!, n[1]!];
    const tangent = unit(t[0]!, t[1]!, t[2]!); const cross = [n[1]! * tangent[2] - n[2]! * tangent[1], n[2]! * tangent[0] - n[0]! * tangent[2], n[0]! * tangent[1] - n[1]! * tangent[0]];
    const sign = cross.reduce((total, value, axis) => total + value * sum[vertex * 6 + 3 + axis]!, 0) < 0 ? -1 : 1;
    vertices.set([...tangent, sign], at + 8);
  }
}
