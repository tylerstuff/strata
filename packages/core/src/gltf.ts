/** Optional importer entry. Importing the default engine entry does not fetch or evaluate this module. */
export { loadGltf } from './imported/gltf-loader.js';
export type {
  LoadGltfOptions, ImportedAsset, ImportedBounds, ImportedMaterial, ImportedImage, ImportedPrimitive,
  ImportedAnimationClip, ImportedSceneOptions, ImportedControls, ImportedTelemetry,
} from './imported/imported-types.js';
