import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = new URL('../packages/core/dist/', import.meta.url);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
run('cargo', ['build', '--package', 'strata-runtime', '--target', 'wasm32-unknown-unknown', '--release', '--locked']);
await copyFile(
  new URL('../target/wasm32-unknown-unknown/release/strata_runtime.wasm', import.meta.url),
  new URL('strata_runtime.wasm', dist),
);
await build({
  absWorkingDir: root,
  entryPoints: ['packages/core/src/index.ts', 'packages/core/src/worker.ts', 'packages/core/src/gltf.ts', 'packages/core/src/gameplay.ts'],
  outdir: fileURLToPath(dist),
  bundle: true,
  splitting: true,
  // Keep every chunk beside worker.js/WASM so module-relative asset URLs stay valid.
  chunkNames: '[name]-[hash]',
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
});
run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'packages/core/tsconfig.build.json']);
await build({
  absWorkingDir: root,
  entryPoints: ['benchmarks/src/main.ts'],
  outfile: 'benchmarks/browser/app.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['@strata-engine/core'],
  sourcemap: true,
});
await import('./build-gallery.mjs');
console.log('Built the ESM package, declarations, module worker, and precompiled WASM.');
