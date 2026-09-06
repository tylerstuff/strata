import { StrataError } from '../errors.js';
import type { ImportedAsset, ImportedMaterial } from '../imported/imported-types.js';

/** Compose one immutable environment and one independently posed actor asset.
 * Payloads remain caller-owned until setScene completes; no large source copies.
 * Animation/placement controls address the actor; camera coordinates address the environment.
 */
export function combineImportedAssets(environment: ImportedAsset, actor: ImportedAsset,
  options: { readonly bakedProbeLighting?: boolean; readonly localLighting?: boolean } = {}): ImportedAsset {
  if (!environment || !actor || environment.version !== 1 || actor.version !== 1
    || environment.primitives.some(p => p.deformation) || environment.clips.length
    || !actor.rig || actor.primitives.some(p => !p.deformation)) {
    throw new StrataError('INVALID_OPTIONS', 'Mixed assets require an immutable environment and a rigged or createMeshAsset actor.');
  }
  const offset = environment.images.length;
  const roles = ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'occlusionTexture', 'emissiveTexture', 'lightmapTexture'] as const;
  const materials = actor.materials.map(m => {
    if (m.lightmapTexture) throw new StrataError('INVALID_OPTIONS', 'Moving actors cannot use static lightmaps.');
    const result: ImportedMaterial = { ...m, ...(options.localLighting && !m.unlit ? { localLighting: true } : {}), ...(options.bakedProbeLighting && !m.unlit ? { bakedProbeLighting: true } : {}) };
    return { ...result, ...Object.fromEntries(roles.flatMap(role => m[role] ? [[role, { ...m[role], image: m[role].image + offset }]] : [])) };
  });
  const primitives = [...environment.primitives, ...actor.primitives.map(p => ({ ...p, material: p.material + environment.materials.length }))];
  return { ...environment, sourceUrl: 'strata:mixed-imported-assets', primitives,
    // Only actor deformation palettes use this normalization; static vertices are already in scene units.
    normalization: actor.normalization, rig: actor.rig, clips: actor.clips,
    materials: [...environment.materials, ...materials], images: [...environment.images, ...actor.images],
    warnings: [...environment.warnings, ...actor.warnings],
    stats: { ...environment.stats, meshInstances: environment.stats.meshInstances + actor.stats.meshInstances,
      primitives: primitives.length, vertices: environment.stats.vertices + actor.stats.vertices,
      triangles: environment.stats.triangles + actor.stats.triangles, materials: environment.materials.length + materials.length,
      images: environment.images.length + actor.images.length, encodedBytes: environment.stats.encodedBytes + actor.stats.encodedBytes,
      geometryBytes: environment.stats.geometryBytes + actor.stats.geometryBytes,
      skinnedMeshInstances: actor.stats.skinnedMeshInstances, animationClips: actor.clips.length } };
}
