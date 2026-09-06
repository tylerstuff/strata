// CPU-only native-identity fixture. It has no descendants and expires even if
// its supervisor fails; only the explicit cleanup test ignores SIGTERM.
const lifetime = setTimeout(() => process.exit(90), 15_000);
process.on('SIGTERM', () => {});
process.on('message', message => {
  if (message?.kind === 'rename') {
    process.title = message.title;
    process.send?.({ kind: 'renamed', pid: process.pid });
  } else if (message?.kind === 'dispose') {
    clearTimeout(lifetime); process.exit(0);
  }
});
process.send?.({ kind: 'ready', pid: process.pid });
