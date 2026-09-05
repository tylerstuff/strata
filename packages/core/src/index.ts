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
} from './types.js';
