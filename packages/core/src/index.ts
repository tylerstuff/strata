export { createEngine } from './engine.js';
export { StrataError, SceneCommitError } from './errors.js';
export { validateAuthoredBoxScene, validateBoxCamera, validateAuthoredFrameCamera, AuthoredBoxValidationError } from './rendering/authored-box-validation.js';
export type { StrataErrorCode } from './errors.js';
export type {
  CreateEngineOptions, Engine, EngineInfo, EngineState, EngineTelemetry,
  FrameMetrics, GpuTiming, ProceduralSceneOptions, RasterControls, RenderOptions,
  SceneOptions, VirtualSceneOptions, GeometryTelemetry, GeometryMode,
  GiSceneOptions, GiControls, GiTelemetry,
  ReflectionSceneOptions, ReflectionControls, ReflectionTelemetry, ReflectionMode,
  IntegratedSceneOptions, IntegratedTelemetry, IntegratedCameraMode,
  SceneCommitReceipt, AuthoredBoxSceneOptions, AuthoredFrameMetadata, BoxCamera,
  BoxSceneDescriptor, AuthoredBox, BoxVec3, BoxQuaternion,
  ImportedAsset, ImportedSceneOptions, ImportedControls, ImportedTelemetry, ImportedBounds, ImportedAnimationClip, ImportedEnvironment,
} from './types.js';

export type { ImportedIndirectOptions, ImportedIndirectTraceOptions, ImportedIndirectDenoise, ImportedIndirectProgress, ImportedIndirectReadback, ImportedSpatialDiagnostics } from './imported/imported-indirect-types.js';

export { createMeshAsset } from './meshes/mesh-asset.js';
export type { MeshAssetOptions, MeshGeometry } from './meshes/mesh-asset.js';
export type { ImportedMaterial, ImportedImage, ImportedTexture, ImportedSampler } from './imported/imported-types.js';
export { prepareMeshTangents } from './meshes/mesh-tangents.js';

export { combineImportedAssets } from './meshes/mixed-asset.js';
export type { BakedProbeVolume } from './imported/baked-probes.js';

export type { ImportedPointLight, ImportedPointLightControl } from './imported/imported-point-light.js';
