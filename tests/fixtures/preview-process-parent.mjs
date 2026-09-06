import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The child starts immediately, before any hypothetical capture or later census.
const [, , token, mode = 'normal'] = process.argv;
if (!token?.startsWith('strata-process-test-')) throw new Error('Missing fixture ownership token');
const child = spawn(process.execPath, [fileURLToPath(new URL('./preview-process-child.mjs', import.meta.url)), token, mode], {
  detached: true,
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
process.send?.({ kind: 'child-started', childPid: child.pid });
const lifetime = setTimeout(() => process.exit(90), 15_000);
child.on('message', message => {
  if (message?.kind === 'ready') process.send?.({ kind: 'ready', pid: process.pid, childPid: child.pid });
});
child.on('error', () => process.exit(91));
process.on('message', message => {
  if (message === 'dispose') {
    child.once('exit', () => { clearTimeout(lifetime); process.exit(0); });
    child.send('dispose');
  } else if (message === 'exit-parent' || message === 'exit-parent-success') {
    child.disconnect();
    child.unref();
    process.exit(message === 'exit-parent-success' ? 0 : 23);
  } else if (message === 'overflow') {
    process.stdout.write(`stdout-prefix:${'o'.repeat(64)}`);
    process.stderr.write(`stderr-prefix:${'e'.repeat(64)}`);
  }
});
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
