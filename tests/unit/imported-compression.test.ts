import { describe, it, expect } from 'vitest';
import { parseDdsMipChain, validateBlockCompression } from '../../packages/core/src/imported/imported-compression.js';
import { estimateImportedTextureAllocation } from '../../packages/core/src/imported/imported-texture-plan.js';
import type { ImportedMaterial, ImportedImage } from '../../packages/core/src/imported/imported-types.js';

function dds(code = 'DXT1') {
  const block = code === 'DXT1' ? 8 : 16;
  const bytes = new Uint8Array(128 + 7 * block), v = new DataView(bytes.buffer);
  v.setUint32(0, 0x20534444, true); v.setUint32(4, 124, true); v.setUint32(12, 8, true); v.setUint32(16, 8, true);
  v.setUint32(28, 4, true); v.setUint32(76, 32, true); v.setUint32(80, 4, true);
  bytes.set([...code].map(c => c.charCodeAt(0)), 84); return bytes;
}
const material: ImportedMaterial = { name: 'fixture', baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: .5, emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1, occlusionStrength: 1, alphaMode: 'OPAQUE', alphaCutoff: .5, doubleSided: false };
const ref = { image: 0, sampler: { magFilter: 9729 as const, minFilter: 9987 as const, wrapS: 10497 as const, wrapT: 10497 as const } };
const opts = { maxTextureDimension: 4, maxTextureDimension2D: 8192, textureCompressionBC: true };
describe('bounded compressed mip chains', () => {
  it.each(['DXT1', 'DXT5', 'ATI2'])('parses %s with exact final partial-block payloads', code => {
    const bytes = dds(code), parsed = parseDdsMipChain(bytes);
    expect(parsed.width).toBe(8); expect(parsed.height).toBe(8);
    const block = code === 'DXT1' ? 8 : 16;
    expect(parsed.compressed.mips.map(m => m.byteLength)).toEqual([4 * block, block, block, block]);
    expect(parsed.compressed.mips[0]!.buffer).toBe(bytes.buffer);
  });
  it('rejects truncation, extra payload, cube, volume, unsupported format and incomplete mip chains', () => {
    for (const modify of [(b: Uint8Array<ArrayBuffer>) => b.subarray(0, b.length - 1), (b: Uint8Array<ArrayBuffer>) => new Uint8Array(b.length + 1),
      (b: Uint8Array<ArrayBuffer>) => { new DataView(b.buffer).setUint32(112, 512, true); return b; },
      (b: Uint8Array<ArrayBuffer>) => { new DataView(b.buffer).setUint32(24, 2, true); return b; },
      (b: Uint8Array<ArrayBuffer>) => { b[84] = 0; return b; },
      (b: Uint8Array<ArrayBuffer>) => { new DataView(b.buffer).setUint32(28, 3, true); return b; }]) {
      expect(() => parseDdsMipChain(modify(dds()))).toThrow();
    }
  });
  it('admits only complete valid normal conventions', () => {
    expect(parseDdsMipChain(dds('ATI2'), { normalY: 'down' }).compressed.normalY).toBe('down');
    expect(() => parseDdsMipChain(dds(), { normalY: 'down' })).toThrow();
    const c = parseDdsMipChain(dds()).compressed;
    expect(() => validateBlockCompression(c, 7, 8)).toThrow();
    expect(() => validateBlockCompression({ ...c, mips: c.mips.slice(1) }, 8, 8)).toThrow();
  });
  it('counts selected mip blocks, separates sRGB/linear copies and falls back without the enabled device feature', () => {
    const image: ImportedImage = { ...parseDdsMipChain(dds()), name: 'generated', mimeType: 'image/png', bytes: new Uint8Array() };
    const input = { images: [image], materials: [{ ...material, baseColorTexture: ref, metallicRoughnessTexture: ref }] };
    const plan = estimateImportedTextureAllocation(input, opts);
    expect(plan.textures.map(t => [t.format, t.sourceMip, t.uploadWidth, t.mipLevels, t.gpuBytes])).toEqual([
      ['bc1-rgba-unorm-srgb', 1, 4, 3, 24], ['bc1-rgba-unorm', 1, 4, 3, 24],
    ]);
    const fallback = estimateImportedTextureAllocation(input, { ...opts, textureCompressionBC: false });
    expect(fallback.textures.map(t => [t.format, t.gpuBytes])).toEqual([[undefined, 84], [undefined, 84]]);
    expect(plan.gpuTextureBytes).toBe(fallback.gpuTextureBytes - 120);
  });
  it('rejects BC5 outside the normal role even when the linear pair was already visited', () => {
    const image: ImportedImage = { ...parseDdsMipChain(dds('ATI2')), name: 'normal', mimeType: 'image/png', bytes: new Uint8Array() };
    expect(() => estimateImportedTextureAllocation({ images: [image], materials: [{ ...material, normalTexture: ref, occlusionTexture: ref }] }, opts)).toThrow();
  });
});
