import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { PREVIEW_CONNECTION_LIMITS as limits, connectionDiagnostic, connectionFailure, type PreviewConnectionHandler } from './connection-protocol.js';
import { runPreviewConnectionStdio } from './connection-stdio.js';

export interface PreviewConnectionStartupOptions {
  projectRoot: string;
  outputRoot: string;
  channel: 'chromium' | 'chrome';
  headless: boolean;
  softwareGpu: boolean;
  width: number;
  height: number;
  timeoutMs: number;
  cleanupTimeoutMs: number;
  signal?: AbortSignal;
}

export interface PreviewConnectionCliDependencies {
  createConnection(options: PreviewConnectionStartupOptions): Promise<PreviewConnectionHandler>;
  input: Readable;
  output: Writable;
  stderr(text: string): Promise<void>;
  signal?: AbortSignal;
}

const usage = {
  command: 'strata-preview-connection --project-root DIR --output-root DIR [--browser chromium|chrome] [--headed] [--software-gpu] [--width N] [--height N] [--timeout-ms N] [--cleanup-timeout-ms N]',
  help: 'strata-preview-connection --help',
  transport: 'UTF-8 LF-delimited JSON; Strata protocol version 1, not JSON-RPC or MCP.',
  startupOnly: ['project-root', 'output-root', 'browser', 'headed', 'software-gpu', 'width', 'height', 'timeout-ms', 'cleanup-timeout-ms'],
  defaults: { channel: 'chromium', headless: true, softwareGpu: false, width: 512, height: 512, timeoutMs: limits.defaultTimeoutMs, cleanupTimeoutMs: limits.defaultCleanupTimeoutMs },
  limits: { ...limits, maximumDimension: 16384, maximumPixels: 64 * 1024 * 1024 },
  browserInitialization: 'Lazy, after validated load input; help and discovery do not launch a browser.',
};

function invalid(message: string): never { throw connectionFailure('CONNECTION_CLI_USAGE', 'arguments', message, { usage: usage.command }); }

function argumentsFor(argv: readonly string[]): PreviewConnectionStartupOptions | null {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) invalid('Arguments must be strings.');
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help')) return null;
  const valued = new Set(['project-root', 'output-root', 'browser', 'width', 'height', 'timeout-ms', 'cleanup-timeout-ms']);
  const booleans = new Set(['headed', 'software-gpu']);
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (!argument.startsWith('--') || argument.includes('=')) invalid('Expected a supported startup flag.');
    const name = argument.slice(2);
    if (!valued.has(name) && !booleans.has(name)) invalid('Unknown startup flag.');
    if (flags.has(name)) invalid(`--${name} may only be supplied once.`);
    if (booleans.has(name)) flags.set(name, true);
    else {
      const value = argv[++i];
      if (!value || value.startsWith('--')) invalid(`--${name} requires a value.`);
      flags.set(name, value);
    }
  }
  const required = (name: string): string => {
    const value = flags.get(name);
    if (typeof value !== 'string') invalid(`--${name} is required.`);
    if (/[\x00-\x1f\x7f]/.test(value)) invalid(`--${name} cannot contain control characters.`);
    return resolve(value);
  };
  const integer = (name: string, fallback: number, maximum: number): number => {
    const value = flags.get(name);
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
      invalid(`--${name} must be an integer from 1 to ${maximum}.`);
    }
    return Number(value);
  };
  const channel = flags.get('browser') ?? 'chromium';
  if (channel !== 'chromium' && channel !== 'chrome') invalid('--browser must be chromium or chrome.');
  const width = integer('width', 512, 16384), height = integer('height', 512, 16384);
  if (width * height > 64 * 1024 * 1024) invalid('Viewport must contain at most 64 Mi physical pixels.');
  return {
    projectRoot: required('project-root'), outputRoot: required('output-root'), channel,
    headless: !flags.has('headed'), softwareGpu: flags.has('software-gpu'), width, height,
    timeoutMs: integer('timeout-ms', limits.defaultTimeoutMs, limits.maximumTimeoutMs),
    cleanupTimeoutMs: integer('cleanup-timeout-ms', limits.defaultCleanupTimeoutMs, limits.maximumTimeoutMs),
  };
}

async function boundedReport(work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(connectionFailure('CONNECTION_WRITE_TIMEOUT', 'cli', 'Writing process diagnostics exceeded its deadline.')), limits.defaultCleanupTimeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function writeHelp(output: Writable, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (failure?: unknown): void => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      // Node can emit error after invoking the failing write callback. Keep the
      // listener through this turn, then detach on both success and failure.
      setImmediate(() => { output.off('error', error); output.off('close', error); });
      if (failure === undefined) resolve(); else reject(failure);
    };
    const error = (): void => finish(connectionFailure('CONNECTION_OUTPUT_FAILED', 'cli', 'Writing connection help failed.'));
    const timer = setTimeout(() => {
      finish(connectionFailure('CONNECTION_WRITE_TIMEOUT', 'cli', 'Writing connection help exceeded its deadline.'));
      output.destroy();
    }, limits.defaultCleanupTimeoutMs);
    output.on('error', error); output.on('close', error);
    try {
      output.write(text, failure => { if (failure) error(); else finish(); });
    } catch { error(); }
  });
}

/** No process exit and no browser import: startup and transport are independently injectable. */
export async function runPreviewConnectionCli(argv: readonly string[], deps: PreviewConnectionCliDependencies): Promise<number> {
  try {
    const options = argumentsFor(argv);
    if (options === null) {
      await writeHelp(deps.output, `${JSON.stringify({ status: 'help', version: 1, usage })}\n`);
      return 0;
    }
    if (deps.signal?.aborted) throw connectionFailure('CONNECTION_ABORTED', 'startup', 'Connection startup was canceled.');
    const connection = await deps.createConnection({ ...options, ...(deps.signal === undefined ? {} : { signal: deps.signal }) });
    await runPreviewConnectionStdio({ connection, input: deps.input, output: deps.output, cleanupTimeoutMs: options.cleanupTimeoutMs, ...(deps.signal === undefined ? {} : { signal: deps.signal }) });
    return 0;
  } catch (error) {
    const diagnostic = connectionDiagnostic(error);
    try { await boundedReport(deps.stderr(`${JSON.stringify({ status: 'failed', error: diagnostic })}\n`)); }
    catch { return 1; }
    return diagnostic.code === 'CONNECTION_CLI_USAGE' ? 2 : 1;
  }
}
