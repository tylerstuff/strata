// CPU-only process-ownership fixture. Every instance also expires on its own.
const [, , token, mode = 'normal'] = process.argv;
if (!token?.startsWith('strata-process-test-')) throw new Error('Missing fixture ownership token');
const lifetime = setTimeout(() => process.exit(90), 15_000);
process.on('message', message => {
  if (message === 'dispose') {
    clearTimeout(lifetime);
    process.exit(0);
  }
});
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
process.send?.({ kind: 'ready', pid: process.pid });
