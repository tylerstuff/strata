import { spawnSync } from 'node:child_process';
import { chmod, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)),
  '-p', fileURLToPath(new URL('../tsconfig.build.json', import.meta.url)),
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await chmod(new URL('../dist/bin.js', import.meta.url), 0o755);
await chmod(new URL('../dist/connection-bin.js', import.meta.url), 0o755);
