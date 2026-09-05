import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '@strata-engine/authoring';
import { PreviewError } from './errors.js';

/** Output safety limits, not renderer limits or a performance claim. */
export const MAX_CAPTURE_PNG_BYTES = 64 * 1024 * 1024;
export const MAX_CAPTURE_PNG_DIMENSION = 16_384;
export const MAX_CAPTURE_PNG_PIXELS = 64 * 1024 * 1024;
export const MAX_CAPTURE_RECEIPT_BYTES = 4 * 1024 * 1024;

export interface CaptureImage {
  /** Relative to the directory containing receipt.json. */
  readonly relativePath: 'image.png';
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly bytes: number;
}

export interface PublishCaptureOptions {
  /** Existing local output root; no parent directories are created. */
  readonly outputDirectory: string;
  /** Unique filename token; an existing capture directory is never reused. */
  readonly captureId: string;
  readonly png: Uint8Array;
  /** Synchronous receipt construction; its schema belongs to the caller. */
  readonly createReceipt: (image: CaptureImage) => unknown;
  readonly signal?: AbortSignal;
  /** Operation gate defers cancellation while the exclusive publication syscall is in flight. */
  readonly commit?: <T>(publish: () => Promise<T>) => Promise<T>;
}

export interface CapturePublication {
  readonly imagePath: string;
  readonly receiptPath: string;
  readonly receipt: unknown;
  /** A published capture remains successful if removing its temporary receipt link fails. */
  readonly cleanupWarnings: readonly { path: string; message: string }[];
}

/** Narrow write/publication seam for CPU failure and race tests; native defaults use wx/link. */
export interface CaptureArtifactIo {
  openFile(path: string): Promise<{
    writeFile(data: Uint8Array | string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  publishReceipt(temporary: string, target: string): Promise<void>;
}

const nativeIo: CaptureArtifactIo = {
  openFile: (path) => open(path, 'wx', 0o600),
  publishReceipt: link,
};

const CAPTURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\s\S])/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function errno(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkAbort(signal: AbortSignal | undefined, stage: string): void {
  if (signal?.aborted) throw new PreviewError('PREVIEW_ABORTED', stage, 'Capture publication was cancelled before the success receipt was published.');
}

function invalid(stage: string, description: string): never {
  throw new PreviewError('PREVIEW_ARTIFACT_INVALID', stage, description);
}

/** Header/dimension validation only; this is not an image decoder or a pixel-correctness proof. */
function pngMetadata(png: Buffer): CaptureImage {
  if (png.length < 33 || png.length > MAX_CAPTURE_PNG_BYTES
    || !png.subarray(0, 8).equals(PNG_SIGNATURE)
    || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR') {
    invalid('verify-image', 'Expected bounded PNG bytes with a complete signature and 13-byte IHDR.');
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_CAPTURE_PNG_DIMENSION || height > MAX_CAPTURE_PNG_DIMENSION
    || width * height > MAX_CAPTURE_PNG_PIXELS) {
    invalid('verify-image', `PNG dimensions must be positive, at most ${MAX_CAPTURE_PNG_DIMENSION} per axis, and at most ${MAX_CAPTURE_PNG_PIXELS} pixels.`);
  }
  const bitDepth = png[24]!;
  const colorType = png[25]!;
  const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[colorType]?.includes(bitDepth) || png[26] !== 0 || png[27] !== 0 || (png[28] !== 0 && png[28] !== 1)) {
    invalid('verify-image', 'PNG IHDR contains unsupported or invalid encoding fields.');
  }
  return Object.freeze({ relativePath: 'image.png', width, height, sha256: createHash('sha256').update(png).digest('hex'), bytes: png.length });
}

async function readBoundedFile(path: string, maxBytes: number, stage: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) invalid(stage, 'Written artifact must remain a bounded regular file.');
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - bytes + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maxBytes) invalid(stage, 'Written artifact exceeded the output byte limit.');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, bytes);
  } finally { await handle.close(); }
}

/**
 * Reserve one output directory, verify the closed image, then exclusively publish the receipt last.
 * Cancellation is checked before publication begins. Once link() is in flight its actual result
 * decides success, even if the signal aborts meanwhile. Callers must await this settlement rather
 * than race it against a separate abort promise. No recursive cleanup is used.
 */
export async function publishCapture(options: PublishCaptureOptions, overrides: Partial<CaptureArtifactIo> = {}): Promise<CapturePublication> {
  if (!options || typeof options !== 'object' || typeof options.outputDirectory !== 'string' || options.outputDirectory.length === 0
    || typeof options.captureId !== 'string' || !CAPTURE_ID.test(options.captureId)
    || !(options.png instanceof Uint8Array) || options.png.byteLength < 33 || options.png.byteLength > MAX_CAPTURE_PNG_BYTES
    || typeof options.createReceipt !== 'function' || (options.commit !== undefined && typeof options.commit !== 'function')) {
    invalid('prepare-output', 'Supply an existing output directory, a safe unique captureId, bounded PNG bytes, and a synchronous receipt callback.');
  }
  const { outputDirectory, captureId, createReceipt, signal, commit } = options;
  // Copy synchronously before the first await, retaining neither the caller's byte view nor options.
  const expected = Buffer.from(options.png);
  const io = { ...nativeIo, ...overrides };
  const ownedFiles = new Set<string>();
  let ownedDirectory: string | undefined;
  let imagePath: string | undefined;
  let receiptPath: string | undefined;
  let temporaryReceipt: string | undefined;
  let stage = 'reserve-output';
  let published = false;
  let receipt: unknown;
  const closeFailures: { path: string; message: string }[] = [];

  async function writeOwned(path: string, data: Uint8Array | string): Promise<void> {
    const handle = await io.openFile(path);
    ownedFiles.add(path);
    let failed = false;
    let failure: unknown;
    try {
      checkAbort(signal, stage);
      await handle.writeFile(data);
      await handle.sync();
    } catch (error) { failed = true; failure = error; }
    try { await handle.close(); } catch (error) {
      if (!failed) { failed = true; failure = error; }
      // A rejected close does not prove the handle closed. Make one bounded cleanup attempt.
      try { await handle.close(); } catch (cleanupError) { closeFailures.push({ path, message: message(cleanupError) }); }
    }
    if (failed) throw failure;
    checkAbort(signal, stage);
  }

  async function removeOwnedFiles(): Promise<{ path: string; message: string }[]> {
    const failures: { path: string; message: string }[] = [];
    for (const path of ownedFiles) {
      try { await unlink(path); ownedFiles.delete(path); } catch (error) {
        if (errno(error) === 'ENOENT') ownedFiles.delete(path);
        else failures.push({ path, message: message(error) });
      }
    }
    if (ownedDirectory !== undefined) {
      const directory = ownedDirectory;
      try { await rmdir(directory); ownedDirectory = undefined; } catch (error) {
        if (errno(error) === 'ENOENT') ownedDirectory = undefined;
        else failures.push({ path: directory, message: message(error) });
      }
    }
    return failures;
  }

  async function removeTemporaryReceipt(): Promise<{ path: string; message: string }[]> {
    if (temporaryReceipt === undefined || !ownedFiles.has(temporaryReceipt)) return [];
    try { await unlink(temporaryReceipt); ownedFiles.delete(temporaryReceipt); } catch (error) {
      if (errno(error) === 'ENOENT') ownedFiles.delete(temporaryReceipt);
      else return [{ path: temporaryReceipt, message: message(error) }];
    }
    return [];
  }

  try {
    checkAbort(signal, stage);
    const root = await realpath(outputDirectory);
    checkAbort(signal, stage);
    if (!(await stat(root)).isDirectory()) invalid(stage, 'outputDirectory must identify an existing directory.');
    checkAbort(signal, stage);
    const directory = join(root, captureId);
    await mkdir(directory, { mode: 0o700 });
    ownedDirectory = directory;
    checkAbort(signal, stage);
    imagePath = join(directory, 'image.png');
    receiptPath = join(directory, 'receipt.json');
    temporaryReceipt = join(directory, `.receipt.${randomUUID()}.tmp`);

    stage = 'write-image';
    await writeOwned(imagePath, expected);
    stage = 'verify-image';
    const written = await readBoundedFile(imagePath, MAX_CAPTURE_PNG_BYTES, stage);
    checkAbort(signal, stage);
    if (!written.equals(expected)) invalid(stage, 'Written PNG bytes do not match the captured input (short write or corruption).');
    const image = pngMetadata(written);

    stage = 'create-receipt';
    const receiptText = canonicalJson(createReceipt(image));
    if (Buffer.byteLength(receiptText, 'utf8') > MAX_CAPTURE_RECEIPT_BYTES) invalid(stage, 'Capture receipt exceeds the output byte limit.');
    receipt = JSON.parse(receiptText) as unknown;
    checkAbort(signal, stage);
    stage = 'write-receipt';
    await writeOwned(temporaryReceipt, receiptText);
    stage = 'verify-receipt';
    const stagedReceipt = await readBoundedFile(temporaryReceipt, MAX_CAPTURE_RECEIPT_BYTES, stage);
    checkAbort(signal, stage);
    if (!stagedReceipt.equals(Buffer.from(receiptText, 'utf8'))) invalid(stage, 'Written receipt bytes do not match the canonical success receipt.');

    stage = 'publish-receipt';
    checkAbort(signal, stage);
    // Point of no return for cancellation: await the actual exclusive publication outcome.
    const publish = async (): Promise<void> => {
      checkAbort(signal, stage);
      await io.publishReceipt(temporaryReceipt!, receiptPath!);
      // Track the syscall's outcome here, even if the surrounding gate/reporting wrapper throws.
      published = true;
    };
    if (commit === undefined) await publish();
    else await commit(publish);
    const cleanupWarnings = await removeTemporaryReceipt();
    return { imagePath, receiptPath, receipt, cleanupWarnings };
  } catch (error) {
    const cleanupErrors = published ? await removeTemporaryReceipt() : await removeOwnedFiles();
    const details = {
      captureId, publicationOccurred: published,
      ...(imagePath !== undefined ? { imagePath } : {}),
      ...(receiptPath !== undefined ? { receiptPath } : {}),
      ...(published ? { receipt } : {}),
      incompleteArtifacts: published ? cleanupErrors.map(({ path }) => path) : [...ownedFiles, ...(ownedDirectory === undefined ? [] : [ownedDirectory])],
      cleanupErrors,
      unclosedHandles: closeFailures,
    };
    if (error instanceof PreviewError) throw new PreviewError(error.code, error.stage, error.message, { ...error.details, ...details });
    throw new PreviewError(errno(error) === 'EEXIST' ? 'PREVIEW_OUTPUT_EXISTS' : stage === 'create-receipt' ? 'PREVIEW_ARTIFACT_INVALID' : 'PREVIEW_ARTIFACT_IO', stage,
      `Capture artifact operation failed: ${message(error)}`, details);
  }
}
