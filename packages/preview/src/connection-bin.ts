#!/usr/bin/env node
import { createPreviewConnection } from './connection.js';
import { runPreviewConnectionCli } from './connection-cli.js';

const controller = new AbortController();
const abort = (): void => controller.abort();
const streamError = (): void => {};
process.on('SIGINT', abort); process.on('SIGTERM', abort);
process.stdout.on('error', streamError); process.stderr.on('error', streamError);
try {
  process.exitCode = await runPreviewConnectionCli(process.argv.slice(2), {
    createConnection: createPreviewConnection,
    input: process.stdin, output: process.stdout, signal: controller.signal,
    stderr: text => new Promise<void>((resolve, reject) => {
      process.stderr.write(text, error => { if (error) reject(error); else resolve(); });
    }),
  });
} finally {
  process.off('SIGINT', abort); process.off('SIGTERM', abort);
}
