/** Optional importer entry. Importing the default engine entry does not fetch or evaluate this module. */
export { loadGltf } from './imported/gltf-loader.js';
export type {
  LoadGltfOptions, ImportedAsset, ImportedBounds, ImportedMaterial, ImportedImage, ImportedPrimitive,
  ImportedAnimationClip, ImportedSceneOptions, ImportedControls, ImportedTelemetry, ImportedEnvironment,
} from './imported/imported-types.js';
export { estimateImportedTextureAllocation } from './imported/imported-texture-plan.js';
export type { ImportedTextureAllocationOptions, ImportedTextureAllocationRecord, ImportedTextureAllocationEstimate } from './imported/imported-texture-plan.js';
export { measureImportedPoseBounds, importedPoseBoundsLimits } from './imported/imported-pose-bounds.js';
export type { ImportedPoseBoundsOptions, ImportedPoseBoundsResult } from './imported/imported-pose-bounds.js';

export type { ImportedIndirectOptions, ImportedIndirectTraceOptions, ImportedIndirectDenoise, ImportedIndirectProgress, ImportedIndirectReadback, ImportedSpatialDiagnostics } from './imported/imported-indirect-types.js';

export { parseDdsMipChain } from './imported/imported-compression.js';
export type { ImportedBlockCompression } from './imported/imported-types.js';
