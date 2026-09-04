// Shared by independently installed, packed-package consumer fixtures.
export function installHarness(createEngine) {
  const canvas = document.querySelector('canvas');
  let engine;

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
    renderPixel() {
      engine.render();
      const readback = document.createElement('canvas');
      readback.width = 1;
      readback.height = 1;
      const context = readback.getContext('2d');
      context.drawImage(canvas, 0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    },
    dispose() {
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
