#!/usr/bin/env node
import { runProjectCli, writeProjectCliResult } from './project-cli.js';

const controller = new AbortController();
const abort = (): void => controller.abort();
const streamError = (): void => {};
process.on('SIGINT', abort); process.on('SIGTERM', abort);
process.stdout.on('error', streamError); process.stderr.on('error', streamError);
const write = (stream: NodeJS.WriteStream, text: string): Promise<void> => new Promise((resolve, reject) => {
  stream.write(text, error => { if (error) reject(error); else resolve(); });
});
try {
  // Keep signal handlers installed until actual API publication/cleanup and the
  // terminal report settle. An interrupt is not evidence of rollback.
  const outcome = await runProjectCli(process.argv.slice(2), { signal: controller.signal });
  process.exitCode = await writeProjectCliResult(outcome, {
    stdout: text => write(process.stdout, text), stderr: text => write(process.stderr, text),
  });
} finally {
  process.off('SIGINT', abort); process.off('SIGTERM', abort);
}
