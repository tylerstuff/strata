# Packed consumer checks

Run `npm run build` followed by `npm run test:consumers`. Install the test browser
with `npx playwright install chromium` first, or use an installed Google Chrome
with `STRATA_TEST_BROWSER_CHANNEL=chrome npm run test:consumers`.

The runner creates an npm archive and installs it into temporary directories
outside this repository. One fixture uses a plain HTML import map; the other is
built by Vite and served from its production output. Neither imports workspace
source files. The plain consumer also verifies the package's TypeScript
declarations and that importing it in Node does not access browser globals.

Both browser fixtures run on localhost without COOP/COEP headers and verify the
real WebGPU clear frame, WASM ABI and memory, worker lifecycle, resizing,
initialization failures, cancellation, timeout, and recovery on the same canvas.
Rendering uses an animation loop. The test decodes a screenshot of the presented
canvas and checks its pixel color, allowing at most five seconds for the first
frame. It does not depend on immediate Canvas2D snapshots of a WebGPU canvas.
Screenshots and the reported adapter/browser are written to
`test-results/consumers/`. A separate case simulates an unavailable WebGPU API.

CI may set `STRATA_TEST_SOFTWARE_GPU=1` to use Chromium's SwiftShader backend.
Software-mode artifacts use the `-software` suffix so they preserve the default
adapter's results.
This validates behavior only. These small correctness checks do not establish
rendering performance or the project's 60 FPS target.
