# @strata-engine/core

The experimental Strata browser runtime. It initializes WebGPU and a private Rust/WebAssembly worker, loads authored opaque box scenes, and provides separate procedural PBR, terrain streaming, software GI and selected-reflection experiments. These remain restricted rendering proofs; general imported scenes and game-quality 60 FPS are not established.

This package is currently built and packed from the repository; it has not been published to npm. Its API is experimental.

## Use the package

After installing a built archive in a Vite application (TypeScript 7+ includes the WebGPU DOM types used by the declarations):

```ts
import { createEngine, StrataError } from '@strata-engine/core';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;

try {
  const engine = await createEngine({ canvas });
  engine.resize(1280, 720);
  engine.render(); // One clear frame. The engine does not start an animation loop.

  // Call when the application no longer needs this instance.
  engine.dispose();
} catch (error) {
  if (error instanceof StrataError) console.error(error.code, error.message);
  else throw error;
}
```

The package includes compiled WASM and a JavaScript module worker. Consumers need neither Rust nor a WASM compilation plugin. Importing the package during SSR does not access the DOM or initialize the GPU. Call `createEngine` in the browser, after the canvas exists.

For plain HTML, serve the entire `dist` directory unchanged on the same origin and import `./dist/index.js` from a module script. Use HTTPS or localhost for WebGPU. Ordinary hosting is supported without COOP/COEP headers or shared memory.

See [the runtime guide](https://github.com/tylerstuff/strata/blob/main/docs/runtime.md) for ownership, errors, asset hosting, and device loss.

For explicit geometry, use `setScene({ renderer: 'authored-boxes', scene })` with a validated plain JSON box descriptor. Its returned scene receipt identifies commitment; `render()` returns the identity and effective camera of the submitted frame. See [authored boxes](https://github.com/tylerstuff/strata/blob/main/docs/authored-boxes.md) for the complete example, supported profile and capture semantics. The renderer is loaded on demand and requires no authoring/editor package.
