import { StrataError } from '../errors.js';
import type { ImportedBlockCompression } from './imported-types.js';

function fail(message: string): never { throw new StrataError('INVALID_OPTIONS', `Invalid compressed image: ${message}`); }
export function blockBytes(format: ImportedBlockCompression['format']): number {
  if (format === 'bc1-rgba-unorm') return 8;
  if (format === 'bc3-rgba-unorm' || format === 'bc5-rg-unorm') return 16;
  return fail('unsupported format.');
}
/** Validates a complete, single-layer, power-of-two mip chain without decoding pixels. */
export function validateBlockCompression(value: ImportedBlockCompression, width: number, height: number): void {
  if (!value || typeof value !== 'object') fail('expected a mip-chain object.');
  const block = blockBytes(value.format);
  if (![width, height].every(v => Number.isSafeInteger(v) && v >= 4 && v <= 16384 && (v & (v - 1)) === 0)) fail('dimensions must be powers of two from 4 through 16384.');
  if (value.normalY !== undefined && (value.format !== 'bc5-rg-unorm' || !['up', 'down'].includes(value.normalY))) fail('normalY applies only to BC5 normal maps.');
  const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
  if (!Array.isArray(value.mips) || value.mips.length !== levels) fail('a complete mip chain is required.');
  for (let i = 0; i < levels; i++) {
    const bytes = Math.ceil(Math.max(1, width >> i) / 4) * Math.ceil(Math.max(1, height >> i) / 4) * block;
    if (!(value.mips[i] instanceof Uint8Array) || !(value.mips[i]!.buffer instanceof ArrayBuffer) || value.mips[i]!.byteLength !== bytes) fail(`mip ${i} byte length mismatch.`);
  }
}
/** Legacy 2D DDS DXT1/DXT5/ATI2 only. Input storage remains caller-owned. */
export function parseDdsMipChain(bytes: Uint8Array<ArrayBuffer>, options: { normalY?: 'up' | 'down' } = {}): { width: number; height: number; compressed: ImportedBlockCompression } {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 128 || bytes.byteLength > 256 * 1024 * 1024) fail('bounded DDS bytes required.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x20534444 || view.getUint32(4, true) !== 124 || view.getUint32(76, true) !== 32) fail('invalid DDS header.');
  if ((view.getUint32(80, true) & 4) === 0 || view.getUint32(24, true) > 1 || view.getUint32(112, true) !== 0) fail('only single-layer 2D FourCC DDS is supported.');
  const code = String.fromCharCode(...bytes.subarray(84, 88));
  const formats = { DXT1: 'bc1-rgba-unorm', DXT5: 'bc3-rgba-unorm', ATI2: 'bc5-rg-unorm' } as const;
  if (!(code in formats)) fail('only DXT1, DXT5 and ATI2 are supported.');
  const format = formats[code as keyof typeof formats], width = view.getUint32(16, true), height = view.getUint32(12, true);
  const levels = Math.max(1, view.getUint32(28, true));
  if (levels > 15 || width < 4 || height < 4 || width > 16384 || height > 16384) fail('unsupported dimensions or mip count.');
  let offset = 128; const mips: Uint8Array<ArrayBuffer>[] = [];
  for (let i = 0; i < levels; i++) {
    const size = Math.ceil(Math.max(1, width >> i) / 4) * Math.ceil(Math.max(1, height >> i) / 4) * blockBytes(format);
    if (offset + size > bytes.byteLength) fail('truncated mip chain.');
    mips.push(bytes.subarray(offset, offset + size)); offset += size;
  }
  if (offset !== bytes.byteLength) fail('unexpected trailing DDS payload.');
  const compressed: ImportedBlockCompression = { format, mips, ...(options.normalY === undefined ? {} : { normalY: options.normalY }) };
  validateBlockCompression(compressed, width, height);
  return { width, height, compressed };
}
