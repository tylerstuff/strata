import { StrataError } from '../errors.js';

export type GltfObject = Record<string, unknown>;
export function gltfError(message: string): never { throw new StrataError('SCENE_LOAD_FAILED', `glTF: ${message}`); }
export function object(value: unknown, path: string): GltfObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) gltfError(`${path} must be an object.`);
  return value as GltfObject;
}
export function list(value: unknown, path: string, maximum = 65536): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) gltfError(`${path} must be a bounded array.`);
  return value;
}
export function integer(value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) gltfError(`${path} is out of range.`);
  return value;
}
export function scalar(value: unknown, path: string, minimum = -Infinity, maximum = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) gltfError(`${path} must be finite and in range.`);
  return value;
}
export function vector(value: unknown, count: number, path: string, minimum = -Infinity, maximum = Infinity): number[] {
  const result = list(value, path, count); if (result.length !== count) gltfError(`${path} needs ${count} components.`);
  return result.map((value, index) => scalar(value, `${path}[${index}]`, minimum, maximum));
}
export function indexed(values: unknown[], index: unknown, path: string): GltfObject {
  return object(values[integer(index, path, 0, values.length - 1)], path);
}
export function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StrataError('SCENE_LOAD_ABORTED', 'glTF loading was canceled.', { cause: signal.reason });
}
export async function checkpoint(index: number, signal?: AbortSignal): Promise<void> {
  abort(signal);
  if (index > 0 && index % 4096 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); abort(signal); }
}

export interface GltfAccessor { readonly values: Float64Array<ArrayBuffer>; readonly count: number; readonly components: number; readonly type: string; readonly componentType: number; readonly normalized: boolean }
const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const sizes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** Decodes offsets, interleaving, normalized integers, matrix padding and sparse overrides. */
export class GltfAccessors {
  private readonly accessors: unknown[];
  private readonly views: unknown[];
  private readonly cached = new Map<number, GltfAccessor>();
  constructor(readonly document: GltfObject, private readonly buffers: readonly Uint8Array<ArrayBuffer>[],
    private readonly reserve: (bytes: number) => void, private readonly signal?: AbortSignal) {
    this.accessors = list(document.accessors ?? [], 'accessors'); this.views = list(document.bufferViews ?? [], 'bufferViews');
  }
  view(index: unknown): { bytes: Uint8Array<ArrayBuffer>; stride?: number } {
    const view = indexed(this.views, index, 'bufferView'); const buffer = this.buffers[integer(view.buffer, 'bufferView.buffer', 0, this.buffers.length - 1)]!;
    const offset = integer(view.byteOffset ?? 0, 'bufferView.byteOffset'); const length = integer(view.byteLength, 'bufferView.byteLength', 1);
    if (offset + length > buffer.byteLength) gltfError('bufferView exceeds its declared buffer.');
    const stride = view.byteStride === undefined ? undefined : integer(view.byteStride, 'bufferView.byteStride', 4, 252);
    if (stride !== undefined && stride % 4 !== 0) gltfError('bufferView.byteStride must be a multiple of four.');
    return { bytes: buffer.subarray(offset, offset + length), ...(stride === undefined ? {} : { stride }) };
  }
  async read(index: unknown): Promise<GltfAccessor> {
    const id = integer(index, 'accessor', 0, this.accessors.length - 1); const cached = this.cached.get(id); if (cached) return cached;
    abort(this.signal); const accessor = indexed(this.accessors, id, 'accessor');
    const type = typeof accessor.type === 'string' ? accessor.type : ''; const width = components[type];
    const componentType = integer(accessor.componentType, 'accessor.componentType'); const bytes = sizes[componentType];
    if (!width || !bytes) gltfError('Unsupported accessor type/componentType.');
    const count = integer(accessor.count, 'accessor.count', 1, 16_777_216);
    if (accessor.normalized !== undefined && typeof accessor.normalized !== 'boolean') gltfError('accessor.normalized must be boolean.');
    const normalized = accessor.normalized === true;
    if (normalized && ![5120, 5121, 5122, 5123].includes(componentType)) gltfError('Only byte/short accessors may be normalized.');
    this.reserve(count * width * 8); const values = new Float64Array(count * width);
    const columns = type.startsWith('MAT') ? Number(type.at(-1)) : 1;
    const rows = width / columns; const columnStride = columns === 1 ? rows * bytes : Math.ceil(rows * bytes / 4) * 4;
    const elementBytes = columns * columnStride;
    const readComponent = (view: DataView, offset: number): number => {
      let value: number;
      switch (componentType) {
        case 5120: value = view.getInt8(offset); break;
        case 5121: value = view.getUint8(offset); break;
        case 5122: value = view.getInt16(offset, true); break;
        case 5123: value = view.getUint16(offset, true); break;
        case 5125: value = view.getUint32(offset, true); break;
        default: value = view.getFloat32(offset, true);
      }
      if (!Number.isFinite(value)) gltfError('An accessor contains a non-finite value.');
      if (!normalized) return value;
      if (componentType === 5120) return Math.max(value / 127, -1);
      if (componentType === 5122) return Math.max(value / 32767, -1);
      return value / (componentType === 5121 ? 255 : 65535);
    };
    const fill = async (source: Uint8Array<ArrayBuffer>, offset: number, stride: number, destinations: ArrayLike<number> | undefined, length: number): Promise<void> => {
      if (offset % bytes || source.byteOffset % bytes || stride < elementBytes || stride % bytes
        || offset + (length - 1) * stride + (columns - 1) * columnStride + rows * bytes > source.byteLength) gltfError('Accessor layout exceeds or misaligns its bufferView.');
      const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
      for (let index = 0; index < length; index++) {
        if (index % 4096 === 0) await checkpoint(index, this.signal);
        const destination = (destinations?.[index] ?? index) * width;
        for (let component = 0; component < width; component++) values[destination + component] = readComponent(view, offset + index * stride + Math.floor(component / rows) * columnStride + (component % rows) * bytes);
      }
    };
    if (accessor.bufferView !== undefined) {
      const source = this.view(accessor.bufferView); await fill(source.bytes, integer(accessor.byteOffset ?? 0, 'accessor.byteOffset'), source.stride ?? elementBytes, undefined, count);
    } else if (accessor.byteOffset !== undefined) gltfError('An accessor without a bufferView cannot specify byteOffset.');
    if (accessor.sparse !== undefined) {
      const sparse = object(accessor.sparse, 'accessor.sparse'); const length = integer(sparse.count, 'sparse.count', 1, count);
      const indices = object(sparse.indices, 'sparse.indices'); const code = integer(indices.componentType, 'sparse.indices.componentType');
      if (![5121, 5123, 5125].includes(code)) gltfError('Sparse indices must be unsigned integers.');
      const source = this.view(indices.bufferView); const size = sizes[code]!; const offset = integer(indices.byteOffset ?? 0, 'sparse.indices.byteOffset');
      if (source.stride !== undefined || offset % size || source.bytes.byteOffset % size || offset + length * size > source.bytes.byteLength) gltfError('Invalid sparse index layout.');
      this.reserve(length * 4); const destinations = new Uint32Array(length); const view = new DataView(source.bytes.buffer, source.bytes.byteOffset, source.bytes.byteLength);
      for (let index = 0; index < length; index++) {
        if (index % 4096 === 0) await checkpoint(index, this.signal);
        const at = offset + index * size; const value = size === 1 ? view.getUint8(at) : size === 2 ? view.getUint16(at, true) : view.getUint32(at, true);
        if (value >= count || (index > 0 && value <= destinations[index - 1]!)) gltfError('Sparse indices must be increasing and within accessor count.');
        destinations[index] = value;
      }
      const replacement = object(sparse.values, 'sparse.values'); const replacementView = this.view(replacement.bufferView);
      if (replacementView.stride !== undefined) gltfError('Sparse values must be tightly packed.');
      await fill(replacementView.bytes, integer(replacement.byteOffset ?? 0, 'sparse.values.byteOffset'), elementBytes, destinations, length);
    }
    const result = { values, count, components: width, type, componentType, normalized }; this.cached.set(id, result); return result;
  }
}
