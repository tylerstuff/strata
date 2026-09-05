import { StrataError } from '../errors.js';
import type { ImportedIndirectSource } from './imported-indirect-types.js';

/** Additional admission for the optional shared-primary-v1 numerical baseline. */
const primaryInputLimit = 2 ** 30;
const sourceChunk = 16_384;
const primaryAttributeComponents = [6, 7, 12, 13, 14] as const;
const yieldTask = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

function invalid(message: string): never {
  throw new StrataError('INVALID_OPTIONS', `Imported shared primary: ${message}`);
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StrataError('SCENE_LOAD_ABORTED', 'Imported shared-primary source validation was cancelled.', { cause: signal.reason });
}

/**
 * Inspect indexed attributes only, without copying the immutable source. Existing
 * static-BVH validation still owns topology, positions and material admission.
 * Yield between bounded chunks; scene supersession must be able to cancel a scan.
 */
export async function validateImportedPrimarySource(source: ImportedIndirectSource, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  if (!source.vertices.length || source.vertices.length % 16 || !source.indices.length || source.indices.length % 3) {
    invalid('source strides/counts are invalid.');
  }
  await yieldTask();
  checkAbort(signal);
  let deadline = performance.now() + 8, chunks = 0;
  const vertexCount = source.vertices.length / 16;
  for (let start = 0; start < source.indices.length; start += sourceChunk) {
    const end = Math.min(source.indices.length, start + sourceChunk);
    for (let index = start; index < end; index++) {
      const vertex = source.indices[index]!;
      if (vertex >= vertexCount) invalid('source index is outside its vertex buffer.');
      const offset = vertex * 16;
      for (const component of primaryAttributeComponents) {
        const value = source.vertices[offset + component]!;
        if (!Number.isFinite(value) || Math.abs(value) > primaryInputLimit) {
          invalid('indexed UV/COLOR components must be finite with magnitude at most 2^30.');
        }
      }
    }
    checkAbort(signal);
    if (++chunks >= 32 || performance.now() >= deadline) {
      await yieldTask();
      checkAbort(signal);
      chunks = 0;
      deadline = performance.now() + 8;
    }
  }
  checkAbort(signal);
}

/** Check the actual f32 matrices before any optional primary GPU multiplication. */
export function validateImportedPrimaryCamera(viewProjection: Float32Array, inverseViewProjection: Float32Array): void {
  for (const matrix of [viewProjection, inverseViewProjection]) {
    if (matrix.length !== 16 || !matrix.every(value => Number.isFinite(value) && Math.abs(value) <= primaryInputLimit)) {
      invalid('uploaded camera and inverse coefficients must be finite with magnitude at most 2^30.');
    }
  }
}
