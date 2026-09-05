import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateImportedPrimaryCamera, validateImportedPrimarySource } from '../../packages/core/src/imported/imported-indirect-primary-domain.js';
import type { ImportedIndirectSource } from '../../packages/core/src/imported/imported-indirect-types.js';

function source(vertexCount = 4, indexCount = 3): ImportedIndirectSource {
  const vertices = new Float32Array(vertexCount * 16);
  for (let vertex = 0; vertex < vertexCount; vertex++) vertices.set([1, 1, 1, 1], vertex * 16 + 12);
  return { vertices, indices: Uint32Array.from({ length: indexCount }, (_, index) => index % 3), nodes: new Uint8Array(0), triangles: new Uint8Array(0) };
}
function matrix(): Float32Array<ArrayBuffer> { return Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
const invalid = expect.objectContaining({ code: 'INVALID_OPTIONS' });

afterEach(() => vi.restoreAllMocks());

describe('optional shared-primary host admission', () => {
  it('accepts signed UV/COLOR bounds and tiny values without modifying source bytes', async () => {
    const input = source();
    input.vertices.set([2 ** 30, -(2 ** 30)], 6);
    input.vertices.set([-(2 ** 30), 2 ** 30, 2 ** -149], 12);
    const before = input.vertices.slice(), indices = input.indices.slice();
    await expect(validateImportedPrimarySource(input)).resolves.toBeUndefined();
    expect(input.vertices).toEqual(before);
    expect(input.indices).toEqual(indices);
  });

  it('rejects each consumed UV/COLOR component above the actual f32 bound or nonfinite', async () => {
    const words = new Uint32Array(new Float32Array([2 ** 30]).buffer);
    words[0]!++;
    const next = new Float32Array(words.buffer)[0]!;
    for (const component of [6, 7, 12, 13, 14]) {
      for (const value of [next, -next, NaN, Infinity, -Infinity]) {
        const input = source(); input.vertices[16 + component] = value;
        await expect(validateImportedPrimarySource(input)).rejects.toEqual(invalid);
      }
    }
  });

  it('does not add restrictions on unreferenced attributes or unrelated vertex fields', async () => {
    const input = source();
    input.vertices[3 * 16 + 6] = Infinity; // Unreferenced vertex: existing source validation owns it.
    input.vertices[8] = 2 ** 31; // Tangent: not consumed by primary rho interpolation.
    await expect(validateImportedPrimarySource(input)).resolves.toBeUndefined();
    input.indices[2] = 3;
    await expect(validateImportedPrimarySource(input)).rejects.toEqual(invalid);
  });

  it('rejects malformed index/stride input before reading arbitrary attributes', async () => {
    const input = source(); input.indices[1] = 4;
    await expect(validateImportedPrimarySource(input)).rejects.toEqual(invalid);
    await expect(validateImportedPrimarySource({ ...source(), vertices: new Float32Array(17) })).rejects.toEqual(invalid);
    await expect(validateImportedPrimarySource({ ...source(), indices: new Uint32Array(2) })).rejects.toEqual(invalid);
  });

  it('scans the last indexed corner of a source spanning multiple chunks', async () => {
    const input = source(4, 65_538);
    input.indices[input.indices.length - 1] = 3;
    input.vertices[3 * 16 + 14] = 2 ** 31;
    await expect(validateImportedPrimarySource(input)).rejects.toEqual(invalid);
  });

  it('honors cancellation before scanning and while a later scan chunk is yielded', async () => {
    const already = new AbortController(); already.abort('before');
    await expect(validateImportedPrimarySource(source(), already.signal)).rejects.toMatchObject({ code: 'SCENE_LOAD_ABORTED', cause: 'before' });
    vi.useFakeTimers();
    try {
      // A deterministic CPU deadline forces a yield after the first bounded chunk.
      let time = 0; vi.spyOn(performance, 'now').mockImplementation(() => time += 9);
      const controller = new AbortController();
      const pending = validateImportedPrimarySource(source(4, 65_538), controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({ code: 'SCENE_LOAD_ABORTED', cause: 'during' });
      await vi.advanceTimersToNextTimerAsync();
      controller.abort('during');
      await vi.runAllTimersAsync();
      await rejected;
    } finally { vi.useRealTimers(); }
  });

  it('checks both uploaded matrices independently, preserving guide-independent and tiny values', () => {
    const vp = matrix(), inverse = matrix();
    vp[4] = 2 ** 30; inverse[7] = -(2 ** 30); inverse[1] = 2 ** -149;
    expect(() => validateImportedPrimaryCamera(vp, inverse)).not.toThrow();
    for (const target of [vp, inverse]) {
      for (const value of [2 ** 30 + 128, -(2 ** 30) - 128, NaN, Infinity, -Infinity]) {
        const before = target[0]!; target[0] = value;
        expect(() => validateImportedPrimaryCamera(vp, inverse)).toThrow(invalid);
        target[0] = before;
      }
    }
    expect(() => validateImportedPrimaryCamera(new Float32Array(15), inverse)).toThrow(invalid);
    expect(() => validateImportedPrimaryCamera(vp, new Float32Array(17))).toThrow(invalid);
  });
});
