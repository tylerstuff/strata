import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AuthoringError, canonicalJson, readSceneFile } from '@strata-engine/authoring';
import { MAX_CAPTURE_PNG_DIMENSION, MAX_CAPTURE_PNG_PIXELS, type CapturePublication } from './artifacts.js';
import { PreviewError } from './errors.js';
import { MAX_OPERATION_TIMEOUT_MS, type OperationOptions } from './operation.js';
import type { CaptureRequest, PreviewReadyReceipt } from './session.js';

export const MAX_PREVIEW_VIEW_BYTES = 64 * 1024;

export interface PreviewCliSession {
  load(input: unknown, options?: OperationOptions): Promise<PreviewReadyReceipt<unknown>>;
  capture(request: CaptureRequest, options?: OperationOptions): Promise<CapturePublication>;
  dispose(): Promise<void>;
}

export interface PreviewCliSessionOptions {
  width: number;
  height: number;
  headless: boolean;
  softwareGpu: boolean;
  channel: 'chromium' | 'chrome';
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface PreviewCliDependencies {
  /** Factory rejection must release partially acquired resources; returned sessions are always disposed here. */
  createSession(options: PreviewCliSessionOptions): PreviewCliSession | Promise<PreviewCliSession>;
  stdout(text: string): void | Promise<void>;
  stderr(text: string): void | Promise<void>;
  signal?: AbortSignal;
}

interface CaptureArguments extends PreviewCliSessionOptions {
  scenePath: string;
  viewPath: string;
  outputDirectory: string;
  frames: number;
}

interface CliDiagnostic {
  code: string;
  stage: string;
  message: string;
  details: Record<string, unknown>;
}

const usage = {
  command: 'strata-preview capture --scene PATH --view PATH --output DIR [--width N] [--height N] [--frames N] [--timeout-ms N] [--headed] [--software-gpu] [--browser chromium|chrome]',
  help: 'strata-preview --help',
  defaults: { width: 512, height: 512, frames: 1, timeoutMs: 30_000, headless: true, softwareGpu: false, channel: 'chromium' },
  limits: { frames: [1, 8], timeoutMs: [1, MAX_OPERATION_TIMEOUT_MS], viewBytes: MAX_PREVIEW_VIEW_BYTES },
  output: 'One terminal JSON result on stdout; reporting failures go to stderr. Published captures remain published if cleanup or reporting fails.',
};

function invalid(message: string): never {
  throw new PreviewError('PREVIEW_CLI_USAGE', 'arguments', message, { usage: usage.command });
}

function parseArguments(argv: readonly string[]): CaptureArguments | null {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) invalid('Arguments must be strings.');
  if ((argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help'))
    || (argv.length === 2 && argv[0] === 'capture' && argv[1] === '--help')) return null;
  if (argv[0] !== 'capture') invalid('Expected capture or --help.');
  const valueFlags = new Set(['scene', 'view', 'output', 'width', 'height', 'frames', 'timeout-ms', 'browser']);
  const booleanFlags = new Set(['headed', 'software-gpu']);
  const flags = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (!argument.startsWith('--') || argument.includes('=')) invalid(`Unsupported argument ${JSON.stringify(argument)}.`);
    const name = argument.slice(2);
    if (!valueFlags.has(name) && !booleanFlags.has(name)) invalid(`Unknown argument ${JSON.stringify(argument)}.`);
    if (flags.has(name)) invalid(`Argument --${name} may only be supplied once.`);
    if (booleanFlags.has(name)) flags.set(name, true);
    else {
      const value = argv[++index];
      if (value === undefined || value.length === 0 || value.startsWith('--')) invalid(`Argument --${name} requires a value.`);
      flags.set(name, value);
    }
  }
  const required = (name: string): string => {
    const value = flags.get(name);
    if (typeof value !== 'string') invalid(`Missing required argument --${name}.`);
    return value;
  };
  const integer = (name: string, fallback: number, maximum: number): number => {
    const value = flags.get(name);
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
      invalid(`Argument --${name} must be an integer from 1 to ${maximum}.`);
    }
    return Number(value);
  };
  const width = integer('width', 512, MAX_CAPTURE_PNG_DIMENSION);
  const height = integer('height', 512, MAX_CAPTURE_PNG_DIMENSION);
  if (width * height > MAX_CAPTURE_PNG_PIXELS) invalid(`Viewport must contain at most ${MAX_CAPTURE_PNG_PIXELS} physical pixels.`);
  const channel = flags.get('browser') ?? 'chromium';
  if (channel !== 'chromium' && channel !== 'chrome') invalid('Argument --browser must be chromium or chrome.');
  return {
    scenePath: resolve(required('scene')), viewPath: resolve(required('view')), outputDirectory: resolve(required('output')),
    width, height, channel, headless: !flags.has('headed'), softwareGpu: flags.has('software-gpu'),
    frames: integer('frames', 1, 8), timeoutMs: integer('timeout-ms', 30_000, MAX_OPERATION_TIMEOUT_MS),
  };
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PreviewError('PREVIEW_ABORTED', 'cli', 'Preview capture was canceled.');
}

async function readView(path: string): Promise<unknown> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_PREVIEW_VIEW_BYTES) throw new Error(`View must be a regular file no larger than ${MAX_PREVIEW_VIEW_BYTES} bytes.`);
      const chunks: Buffer[] = [];
      let length = 0;
      while (true) {
        const buffer = Buffer.allocUnsafe(Math.min(16 * 1024, MAX_PREVIEW_VIEW_BYTES - length + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > MAX_PREVIEW_VIEW_BYTES) throw new Error(`View exceeds ${MAX_PREVIEW_VIEW_BYTES} bytes.`);
        chunks.push(buffer.subarray(0, bytesRead));
      }
      bytes = Buffer.concat(chunks, length);
    } finally { await handle.close(); }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('View must be a JSON object.');
    // Generic strict JSON copying only. Runtime view fields are validated by the adapter/Core.
    return JSON.parse(canonicalJson(parsed)) as unknown;
  } catch (error) {
    throw new PreviewError('PREVIEW_INVALID_VIEW', 'view-input', error instanceof Error ? error.message : 'Cannot read view JSON.', { source: path });
  }
}

function diagnostic(error: unknown, fallbackCode: string, stage: string): CliDiagnostic {
  if (error instanceof PreviewError) {
    let details: Record<string, unknown>;
    try { details = JSON.parse(canonicalJson(error.details)) as Record<string, unknown>; }
    catch { details = { detailSerializationFailed: true }; }
    return { code: error.code.startsWith('PREVIEW_') ? error.code : `PREVIEW_${error.code}`, stage: error.stage, message: error.message, details };
  }
  return { code: fallbackCode, stage, message: error instanceof Error ? error.message : 'Unexpected preview failure.', details: {} };
}

const inputCodes = new Set([
  'PREVIEW_CLI_USAGE', 'PREVIEW_INVALID_SCENE', 'PREVIEW_INVALID_VIEW', 'PREVIEW_INVALID_OPTIONS',
  'PREVIEW_INVALID_INPUT', 'PREVIEW_UNSUPPORTED_FEATURE', 'PREVIEW_UNSUPPORTED_LIMIT',
  'PREVIEW_SOURCE_REVISION_MISMATCH', 'PREVIEW_UNSUPPORTED_ASSET', 'PREVIEW_RUNTIME_VALIDATION_FAILED',
]);

function publishedFromError(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof PreviewError) || error.details.publicationOccurred !== true) return null;
  return {
    status: 'captured', publicationOccurred: true,
    imagePath: typeof error.details.imagePath === 'string' ? error.details.imagePath : null,
    receiptPath: typeof error.details.receiptPath === 'string' ? error.details.receiptPath : null,
    receipt: error.details.receipt ?? null,
  };
}

/** Parse and orchestrate one request; never launches a browser itself or calls process.exit. */
export async function runPreviewCli(argv: readonly string[], dependencies: PreviewCliDependencies): Promise<number> {
  let session: PreviewCliSession | undefined;
  let result: Record<string, unknown>;
  let exitCode = 0;
  const cleanupWarnings: unknown[] = [];
  try {
    const args = parseArguments(argv);
    if (args === null) result = { status: 'help', usage };
    else {
      checkAbort(dependencies.signal);
      const [snapshot, view] = await Promise.all([
        readSceneFile(args.scenePath).catch(error => {
          throw new PreviewError('PREVIEW_INVALID_SCENE', 'scene-input', error instanceof Error ? error.message : 'Cannot read authoring scene.', {
            source: args.scenePath, ...(error instanceof AuthoringError ? { diagnostics: error.diagnostics } : {}),
          });
        }),
        readView(args.viewPath),
      ]);
      checkAbort(dependencies.signal);
      try { await mkdir(args.outputDirectory, { recursive: true }); }
      catch (error) { throw new PreviewError('PREVIEW_OUTPUT_IO', 'prepare-output', error instanceof Error ? error.message : 'Cannot create output directory.', { outputDirectory: args.outputDirectory }); }
      checkAbort(dependencies.signal);
      session = await dependencies.createSession({
        width: args.width, height: args.height, channel: args.channel, timeoutMs: args.timeoutMs,
        headless: args.headless, softwareGpu: args.softwareGpu,
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      });
      checkAbort(dependencies.signal);
      const options: OperationOptions = { timeoutMs: args.timeoutMs, ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }) };
      const ready = await session.load({ scene: snapshot.scene, revision: snapshot.revision, view }, options);
      checkAbort(dependencies.signal);
      if (ready.sceneId !== snapshot.scene.id || ready.sourceRevision !== snapshot.revision) {
        throw new PreviewError('PREVIEW_STALE_STATE', 'load', 'Ready receipt does not identify the requested scene snapshot.');
      }
      const publication = await session.capture({
        expectedRevision: ready.sourceRevision, expectedLoadId: ready.loadId, expectedViewRevision: ready.viewRevision,
        outputDirectory: args.outputDirectory, frames: args.frames,
      }, options);
      // Publication is irreversible. A late abort cannot relabel it as canceled.
      cleanupWarnings.push(...publication.cleanupWarnings);
      result = {
        status: 'captured', publicationOccurred: true,
        imagePath: publication.imagePath, receiptPath: publication.receiptPath, receipt: publication.receipt,
      };
    }
  } catch (error) {
    const failure = diagnostic(error, 'PREVIEW_RUNTIME_FAILED', 'capture');
    const published = publishedFromError(error);
    exitCode = published ? 1 : inputCodes.has(failure.code) ? 2 : 1;
    result = published ?? { status: failure.code === 'PREVIEW_ABORTED' ? 'cancelled' : 'failed', publicationOccurred: false };
    result.error = failure;
  } finally {
    if (session) {
      try { await session.dispose(); }
      catch (error) {
        cleanupWarnings.push(diagnostic(error, 'PREVIEW_CLEANUP_FAILED', 'dispose'));
        if (exitCode === 0) exitCode = 1;
      }
    }
  }
  if (cleanupWarnings.length > 0) {
    result.cleanupWarnings = cleanupWarnings;
    if (exitCode === 0) exitCode = 1;
  }
  try {
    // One write attempt only: a rejected stream write may already have written a prefix.
    await dependencies.stdout(canonicalJson(result));
  } catch (error) {
    const cause = diagnostic(error, 'PREVIEW_REPORT_FAILED', 'stdout');
    const report = {
      status: 'reporting-failed', publicationOccurred: result.publicationOccurred === true,
      ...(result.publicationOccurred === true ? { imagePath: result.imagePath ?? null, receiptPath: result.receiptPath ?? null } : {}),
      error: {
        ...cause, code: 'PREVIEW_REPORT_FAILED', stage: 'stdout',
        details: { ...cause.details, ...(cause.code === 'PREVIEW_REPORT_FAILED' ? {} : { causeCode: cause.code }) },
      },
    };
    try { await dependencies.stderr(canonicalJson(report)); } catch { /* Exit code still reports the failed output channel. */ }
    return 1;
  }
  return exitCode;
}
