#!/usr/bin/env node
import { createPreviewSession } from './browser-driver.js';
import { runPreviewCli } from './cli.js';

const controller = new AbortController();
const abort = (): void => { controller.abort(); };
process.on('SIGINT', abort);
process.on('SIGTERM', abort);
// Stream errors are returned through write callbacks and reported by the CLI.
const streamError = (): void => {};
process.stdout.on('error', streamError);
process.stderr.on('error', streamError);
const write = (stream: NodeJS.WriteStream, value: string): Promise<void> => new Promise((resolve, reject) => {
  stream.write(value, error => { if (error) reject(error); else resolve(); });
});
try {
  process.exitCode = await runPreviewCli(process.argv.slice(2), {
    createSession: createPreviewSession,
    signal: controller.signal,
    stdout: value => write(process.stdout, value), stderr: value => write(process.stderr, value),
  });
} finally {
  process.off('SIGINT', abort);
  process.off('SIGTERM', abort);
}
