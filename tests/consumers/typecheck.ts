import { loadGltf, type LoadGltfOptions } from '@strata-engine/core/gltf';
import { createEngine, StrataError, SceneCommitError, validateAuthoredBoxScene, validateBoxCamera, validateAuthoredFrameCamera } from '@strata-engine/core';
import type { BoxSceneDescriptor, BoxCamera, SceneCommitReceipt, SceneOptions, AuthoredFrameMetadata, AuthoredBoxSceneOptions, ReflectionMode, ReflectionSceneOptions, ReflectionControls, ReflectionTelemetry, IntegratedSceneOptions, IntegratedTelemetry, IntegratedCameraMode } from '@strata-engine/core';

const canvas = document.createElement('canvas');
const options: Parameters<typeof createEngine>[0] = {
  canvas,
  requiredFeatures: ['timestamp-query'],
  requiredLimits: { maxTextureDimension2D: 8192 },
  initializationTimeoutMs: 30_000,
};

async function lifecycle() {
  try {
    const engine = await createEngine(options);
    const abiVersion: number = engine.info.cpu.abiVersion;
    const memoryBytes: number = engine.info.cpu.memoryBytes;
    const format: GPUTextureFormat = engine.info.format;
    const state: 'ready' | 'lost' | 'disposed' = engine.state;
    engine.resize(640, 360);
    engine.render();
    await engine.setScene({ renderer: 'gi', cameraMode: 'overview', probesPerUpdate: 16, raysPerProbe: 32 });
    const giFrame = engine.render({ temporal: false, debugView: 'indirect', gi: { enabled: true, doorOpen: false, lightIntensity: 2 } });
    const giEnabled: number | string | boolean | null | undefined = giFrame.gi?.enabled;
    void giEnabled;
    const reflectionMode: ReflectionMode = 'world';
    const reflectionScene: ReflectionSceneOptions = { renderer: 'reflections', cameraMode: 'receiver',
      resolutionScale: 0.25, maxRaysPerFrame: 32768, roughness: 0.08, objectOffset: 0,
      probesPerUpdate: 16, raysPerProbe: 32, doorOpen: true, wallColor: 'red', lightIntensity: 1 };
    const reflectionControls: ReflectionControls = { mode: reflectionMode, roughness: 0.08,
      maxDistance: 16, updateEvery: 1, objectOffset: 0, resetHistory: true };
    await engine.setScene(reflectionScene);
    const reflectionFrame = engine.render({ temporal: false, debugView: 'reflections',
      gi: { enabled: true }, reflections: reflectionControls });
    const reflectionTelemetry: ReflectionTelemetry | undefined = reflectionFrame.reflections;
    const currentReflectionTelemetry: ReflectionTelemetry | undefined = engine.getTelemetry().reflections;
    engine.render({ debugView: 'reflection-source', reflections: { mode: 'probe-only' } });
    const disabledMode: ReflectionMode = 'off';
    engine.render({ reflections: { mode: disabledMode } });
    // @ts-expect-error Screen tracing is not a supported reflection mode.
    const invalidMode: ReflectionMode = 'screen-space';
    // @ts-expect-error Resolution scale is a bounded choice rather than an arbitrary number.
    const invalidScale: ReflectionSceneOptions = { renderer: 'reflections', resolutionScale: 0.75 };
    void reflectionTelemetry; void currentReflectionTelemetry; void invalidMode; void invalidScale;
    const integratedCamera: IntegratedCameraMode = 'tour';
    const integratedScene: IntegratedSceneOptions = { renderer: 'integrated', manifestUrl: '/manifest.json',
      traceProxyUrl: '/trace-proxy.json', cameraMode: integratedCamera, geometryMode: 'streamed',
      poolBytes: 1024 * 1024, terrainColor: 'green', resolutionScale: 0.25 };
    await engine.setScene(integratedScene);
    const integratedTelemetry: IntegratedTelemetry | undefined = engine.render().integrated;
    // @ts-expect-error A persistent trace proxy is mandatory for integrated coverage.
    const missingProxy: IntegratedSceneOptions = { renderer: 'integrated', manifestUrl: '/manifest.json' };
    void integratedTelemetry; void missingProxy;
    const importedOptions: LoadGltfOptions = { maxTextureDimension: 2048, signal: new AbortController().signal };
    const imported = await loadGltf('/model/scene.gltf', importedOptions);
    await engine.setScene({ renderer: 'imported', asset: imported });
    const importedFrame = engine.render({ imported: { camera: { eye: [3, 2, 3], target: [0, 1, 0], verticalFov: 1 },
      animation: { clipId: imported.clips[0]?.id ?? null, timeSeconds: 0.5, loop: false }, presentation: 'ground' } });
    const importedTime: number | undefined = importedFrame.imported?.animation.timeSeconds;
    void importedTime;
    const camera: BoxCamera = { position: [0, 0, 3], rotation: [0, 0, 0, 1],
      projection: { kind: 'perspective', verticalFovRadians: 1, near: 0.1, far: 32 } };
    const boxes: BoxSceneDescriptor = validateAuthoredBoxScene({
      format: 'strata.runtime-boxes', version: 1, coordinateSystem: 'strata-world-v1',
      sceneId: 'packed-example', sourceRevision: null, boxes: [], camera,
      light: { directionToLight: [0, 1, 0], radiance: [1, 1, 1] }, background: [0, 0, 0],
    });
    const authoredOptions: AuthoredBoxSceneOptions = { renderer: 'authored-boxes', scene: boxes };
    const genericScene: SceneOptions = authoredOptions;
    const load: Promise<SceneCommitReceipt> = engine.setScene(genericScene);
    const receipt: SceneCommitReceipt = await load;
    const authoredFrame = engine.render({ camera: validateBoxCamera(camera), temporal: false, debugView: 'base-color' });
    const metadata: AuthoredFrameMetadata | undefined = authoredFrame.authored;
    const previousAuthoredFrame: number | null | undefined = metadata?.motion.previousSubmittedFrameId;
    const correspondence: boolean | undefined = metadata?.motion.valid;
    const submittedScene: SceneCommitReceipt = authoredFrame.scene;
    const last: number | null = engine.getTelemetry().scene.lastSubmittedFrameId;
    const checkedCamera: BoxCamera = validateAuthoredFrameCamera(boxes, camera, 640, 360);
    // @ts-expect-error setScene returns a receipt even through generic SceneOptions.
    const oldVoidWrapper: Promise<void> = engine.setScene(genericScene);
    void receipt; void metadata; void previousAuthoredFrame; void correspondence; void submittedScene; void last; void checkedCamera; void oldVoidWrapper;
    await engine.waitForIdle();
    engine.dispose();
    return { abiVersion, memoryBytes, format, state };
  } catch (error) {
    if (error instanceof SceneCommitError) { const committed: SceneCommitReceipt = error.committedScene; void committed; }
    if (error instanceof StrataError) return error.code;
    throw error;
  }
}

void lifecycle;
