import { createEngine, StrataError } from '@strata-engine/core';

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
    engine.dispose();
    return { abiVersion, memoryBytes, format, state };
  } catch (error) {
    if (error instanceof StrataError) return error.code;
    throw error;
  }
}

void lifecycle;
