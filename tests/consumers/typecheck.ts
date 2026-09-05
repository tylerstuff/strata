import { createEngine, StrataError } from '@strata-engine/core';
import type { ReflectionMode, ReflectionSceneOptions, ReflectionControls, ReflectionTelemetry, IntegratedSceneOptions, IntegratedTelemetry, IntegratedCameraMode } from '@strata-engine/core';

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
    engine.dispose();
    return { abiVersion, memoryBytes, format, state };
  } catch (error) {
    if (error instanceof StrataError) return error.code;
    throw error;
  }
}

void lifecycle;
