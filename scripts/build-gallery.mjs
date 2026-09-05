import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['examples/gallery/main.ts'],
  outfile: 'examples/gallery/app.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['@strata-engine/core', '@strata-engine/core/*'],
  sourcemap: true,
  logLevel: 'info',
});
