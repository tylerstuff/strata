// Shared by independently installed, packed-package consumer fixtures.
export function installHarness(createEngine, createMeshAsset, prepareMeshTangents) {
  const canvas = document.querySelector('canvas');
  let engine;
  let animationFrame;

  const snapshot = () => ({
    state: engine.state,
    info: { ...engine.info, features: [...engine.info.features] },
    width: canvas.width,
    height: canvas.height,
    workers: globalThis.__strataWorkers.size,
    crossOriginIsolated: globalThis.crossOriginIsolated,
  });

  globalThis.strataTest = {
    async start(options = {}) {
      engine = await createEngine({ canvas, ...options });
      return snapshot();
    },
    async fail(options = {}) {
      try {
        const unexpected = await createEngine({ canvas, ...options });
        unexpected.dispose();
        return { code: null, message: 'Initialization unexpectedly succeeded' };
      } catch (error) {
        return { code: error.code, message: error.message };
      }
    },
    async abortDuringStart(wasmUrl) {
      const controller = new AbortController();
      const pending = this.fail({ wasmUrl, signal: controller.signal });
      // Wait for the worker to start so cancellation exercises active cleanup.
      const deadline = performance.now() + 5_000;
      while (globalThis.__strataWorkers.size === 0 && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort();
      return pending;
    },
    resize(width, height) {
      engine.resize(width, height);
      return snapshot();
    },
    startRendering() {
      return new Promise((resolve) => {
        const frame = () => {
          engine.render();
          animationFrame = requestAnimationFrame(frame);
          resolve();
        };
        animationFrame = requestAnimationFrame(frame);
      });
    },
    async exerciseScene(options, renderOptions = {}) {
      await engine.setScene(options);
      const metrics = engine.render({ timeSeconds: 0, temporal: false, ...renderOptions });
      await engine.flushGpuTimings();
      await engine.waitForIdle(120_000);
      // Give GPU validation/error delivery a browser turn without imposing a frame-rate assertion.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { metrics, telemetry: engine.getTelemetry() };
    },
    async exerciseMeshes() {
      let vertices = new Float32Array([[-1,0,0],[1,0,0],[0,2,0]].flatMap(p => [...p,0,0,1,0,0,1,0,0,1,1,1,1,1]));
      vertices=await prepareMeshTangents(vertices,new Uint32Array([0,1,2]));
      const material = { name: 'Generated matte', baseColorFactor: [.8,.15,.05,1], metallicFactor: 0, roughnessFactor: .7,
        emissiveFactor: [0,0,0], emissiveStrength: 1, normalScale: 1, occlusionStrength: 1, alphaMode: 'OPAQUE', alphaCutoff: .5, doubleSided: true };
      const asset = createMeshAsset({ meshes: [{ name: 'Generated triangle', vertices, indices: new Uint32Array([0,1,2]), material: 0 }], materials: [material] });
      const receipt = await engine.setScene({ renderer: 'imported', asset });
      const transforms = new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
      engine.resize(128,96);
      const first = engine.render({ temporal: false, imported: { transforms } });
      transforms[12] = 1;
      const moved = engine.render({ temporal: true, imported: { transforms, camera: { eye: [2,2,5], target: [1,1,0], verticalFov: Math.PI/3 } } });
      transforms[12] = Infinity;
      let rejected;
      try { engine.render({ imported: { transforms } }); } catch (error) { rejected = error.code; }
      const afterRejected = engine.getTelemetry();
      transforms[12] = 2;
      engine.resize(160,120);
      const resized = engine.render({ temporal: false, imported: { transforms } });
      await engine.waitForIdle();
      const telemetry = engine.getTelemetry();
      engine.resize(128,96);await engine.setScene({renderer:'imported',asset,shadowMapSize:4096});
      const highShadow=engine.render({temporal:false,imported:{transforms:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])}});await engine.waitForIdle();
      await engine.setScene(null);
      const cleared = engine.getTelemetry();
      return { receipt, first, moved, rejected, afterRejected, resized, telemetry, cleared, highShadow };
    },
    dispose() {
      cancelAnimationFrame(animationFrame);
      engine.dispose();
      engine.dispose();
      return snapshot();
    },
    renderAfterDispose() {
      try {
        engine.render();
        return null;
      } catch (error) {
        return error.code;
      }
    },
  };
}
