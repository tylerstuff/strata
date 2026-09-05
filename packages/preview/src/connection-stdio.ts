import type { Readable, Writable } from 'node:stream';
import {
  PREVIEW_CONNECTION_LIMITS as limits, connectionErrorResponse, connectionFailure,
  type ConnectionResponse, type PreviewConnectionHandler,
} from './connection-protocol.js';

export interface PreviewConnectionStdioOptions {
  connection: PreviewConnectionHandler;
  input: Readable;
  output: Writable;
  signal?: AbortSignal;
  writeTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

function deadline<T>(work: Promise<T>, milliseconds: number, code: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(connectionFailure(code, 'stdio', 'Connection shutdown exceeded its deadline.', { outcomeUnknown: true, deliveryUncertain: true })), milliseconds);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Keep publication evidence when a result cannot fit the transport envelope. */
function unavailable(response: ConnectionResponse, code: string, message: string): ConnectionResponse {
  const value = response.ok ? response.result : response.error.details;
  const evidence: Record<string, unknown> = { outcomeUnknown: true, responseUnavailable: true };
  if (value !== null && typeof value === 'object') {
    const fields = value as Record<string, unknown>;
    for (const key of ['publicationOccurred', 'commitOccurred'] as const) {
      if (fields[key] === true) evidence[key] = true;
    }
    for (const key of ['imagePath', 'receiptPath'] as const) {
      if (typeof fields[key] === 'string' && Buffer.byteLength(fields[key]) <= 4096) evidence[key] = fields[key];
    }
  }
  return connectionErrorResponse(response.id, connectionFailure(code, 'stdio', message, evidence));
}

/**
 * Own the handler until EOF, disposal, cancellation or transport failure. Streams
 * are borrowed: normal completion pauses input and drains output without ending it.
 * Input must yield raw bytes so invalid UTF-8 cannot be silently replaced upstream.
 */
export async function runPreviewConnectionStdio(options: PreviewConnectionStdioOptions): Promise<void> {
  const { connection, input, output, signal } = options;
  const writeTimeoutMs = options.writeTimeoutMs ?? limits.defaultCleanupTimeoutMs;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? limits.defaultCleanupTimeoutMs;
  if (!Number.isSafeInteger(writeTimeoutMs) || writeTimeoutMs < 1 || writeTimeoutMs > limits.maximumTimeoutMs) {
    throw connectionFailure('CONNECTION_INVALID_OPTIONS', 'stdio', 'writeTimeoutMs must be an integer from 1 to 300000.');
  }
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > limits.maximumTimeoutMs) {
    throw connectionFailure('CONNECTION_INVALID_OPTIONS', 'stdio', 'cleanupTimeoutMs must be an integer from 1 to 300000.');
  }
  let stopping = false, finished = false, failure: unknown, outputFailed = false;
  let queuedBytes = 0, responseBuffers = 0, ordinaryRequests = 0, writing = false;
  let rejectWrite: ((error: unknown) => void) | undefined;
  const queue: { bytes: Buffer; resolve(): void; reject(error: unknown): void }[] = [];
  const pending = new Set<Promise<void>>();
  const drainWaiters = new Set<{ resolve(): void; reject(error: unknown): void }>();
  let pendingDrained: (() => void) | undefined;
  const line = Buffer.allocUnsafe(limits.inputLineBytes);
  let lineLength = 0, discardLine = false;
  let resolveRun!: () => void, rejectRun!: (error: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });

  function stopInput(): void {
    input.pause();
    input.off('data', data); input.off('end', ended); input.off('close', inputClosed);
  }
  function fail(error: unknown): void {
    failure ??= error;
    shutdown();
  }
  function failOutput(error: unknown): void {
    if (outputFailed || finished) return;
    outputFailed = true;
    failure ??= error;
    for (const entry of queue) entry.reject(error);
    queue.length = 0; queuedBytes = 0; responseBuffers = 0;
    rejectWrite?.(error);
    for (const waiter of drainWaiters) waiter.reject(error);
    drainWaiters.clear();
    // Broken/stalled output cannot carry terminal responses. Destroying it also
    // releases Node's queued writes; retain its error listener through close.
    if (!output.destroyed) output.destroy();
    shutdown();
  }
  function notifyDrain(): void {
    if (writing || queue.length) return;
    for (const waiter of drainWaiters) waiter.resolve();
    drainWaiters.clear();
  }
  function writeOne(bytes: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      let callbackDone = false, drainDone = false, returned = false, settled = false;
      const finish = (error?: unknown): void => {
        if (settled || (error === undefined && (!callbackDone || !drainDone || !returned))) return;
        settled = true; clearTimeout(timer); output.off('drain', drained); rejectWrite = undefined;
        if (error === undefined) resolve(); else reject(error);
      };
      const drained = (): void => { drainDone = true; finish(); };
      const timer = setTimeout(() => finish(connectionFailure('CONNECTION_WRITE_TIMEOUT', 'stdio', 'Writing a response exceeded its deadline.', { outcomeUnknown: true })), writeTimeoutMs);
      rejectWrite = error => finish(error);
      output.on('drain', drained);
      try {
        const accepted = output.write(bytes, error => { if (error) finish(error); else { callbackDone = true; finish(); } });
        returned = true; if (accepted) drainDone = true; finish();
      } catch (error) { finish(error); }
    });
  }
  async function pump(): Promise<void> {
    if (writing || outputFailed) return;
    writing = true;
    try {
      while (queue.length && !outputFailed) {
        const entry = queue.shift()!;
        try { await writeOne(entry.bytes); }
        catch (error) { entry.reject(error); throw error; }
        if (!outputFailed) { queuedBytes -= entry.bytes.length; responseBuffers--; }
        entry.resolve();
      }
    } catch (error) { failOutput(error); }
    finally { writing = false; notifyDrain(); }
  }
  function send(response: ConnectionResponse): Promise<void> {
    if (finished) return Promise.resolve();
    if (outputFailed) return Promise.reject(failure);
    let text: string;
    try { text = JSON.stringify(response); }
    catch { text = JSON.stringify(unavailable(response, 'CONNECTION_RESPONSE_INVALID', 'The result cannot be encoded as JSON.')); }
    if (Buffer.byteLength(text) + 1 > limits.responseBytes) {
      text = JSON.stringify(unavailable(response, 'CONNECTION_RESPONSE_TOO_LARGE', 'The result exceeds the four MiB response limit.'));
    }
    const bytes = Buffer.from(`${text}\n`);
    if (responseBuffers >= limits.responseBuffers || queuedBytes + bytes.length > limits.outputQueueBytes) {
      const error = connectionFailure('CONNECTION_OUTPUT_OVERFLOW', 'stdio', 'The bounded response queue is full.', { outcomeUnknown: true, deliveryUncertain: true });
      failOutput(error); return Promise.reject(error);
    }
    const delivered = new Promise<void>((resolve, reject) => { queue.push({ bytes, resolve, reject }); });
    queuedBytes += bytes.length; responseBuffers++; void pump();
    return delivered;
  }
  function framingError(code: string, message: string): void {
    void send(connectionErrorResponse(null, connectionFailure(code, 'input', message))).catch(fail);
  }
  function dispatch(value: unknown): void {
    const method = (value as { method?: unknown }).method;
    const ordinary = method !== 'cancel' && method !== 'dispose';
    if (pending.size >= limits.outstandingRequests || (ordinary && ordinaryRequests >= limits.ordinaryRequests)) {
      const error = connectionFailure('CONNECTION_ADMISSION_OVERFLOW', 'input', 'Outstanding response capacity is exhausted; connection admission is closed.', { outcomeUnknown: true, deliveryUncertain: true });
      // An unaccepted overflow frame consumes no handler ID. Emit at most one
      // error, and only when accepted requests leave room for that extra record.
      if (pending.size < limits.responseBuffers && responseBuffers < limits.responseBuffers) {
        void send(connectionErrorResponse(null, error)).catch(fail);
      }
      fail(error); return;
    }
    let request: Promise<ConnectionResponse>;
    try { request = connection.request(value); }
    catch (error) { void send(connectionErrorResponse(null, error)).catch(fail); return; }
    if (ordinary) ordinaryRequests++;
    const job = request.then(send, error => send(connectionErrorResponse(null, error))).catch(fail).finally(() => {
      pending.delete(job);
      if (ordinary) ordinaryRequests--;
      if (pending.size === 0) pendingDrained?.();
      if (connection.closing) shutdown();
    });
    pending.add(job);
    if (connection.closing) shutdown();
  }
  function parseLine(): void {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line.subarray(0, lineLength)); }
    catch { framingError('CONNECTION_INVALID_UTF8', 'Request lines must contain valid UTF-8.'); return; }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { framingError('CONNECTION_INVALID_JSON', 'Each request must be one LF-terminated JSON object.'); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      framingError('CONNECTION_INVALID_FRAME', 'Batches and non-object requests are unsupported.'); return;
    }
    dispatch(value);
  }
  function data(chunk: unknown): void {
    if (!(chunk instanceof Uint8Array)) {
      fail(connectionFailure('CONNECTION_INPUT_FAILED', 'input', 'The input stream must provide raw UTF-8 bytes.')); return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < bytes.length && !stopping) {
      const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline;
      if (!discardLine) {
        const length = end - offset;
        if (length > limits.inputLineBytes - lineLength) {
          discardLine = true; lineLength = 0;
          framingError('CONNECTION_LINE_TOO_LARGE', 'Request line exceeds 64 KiB.');
        } else { bytes.copy(line, lineLength, offset, end); lineLength += length; }
      }
      if (newline >= 0) {
        if (!discardLine && !stopping) parseLine();
        lineLength = 0; discardLine = false;
      }
      offset = newline < 0 ? bytes.length : newline + 1;
    }
  }
  function ended(): void {
    if (lineLength && !discardLine) framingError('CONNECTION_UNTERMINATED_FRAME', 'The final request is missing its LF terminator.');
    shutdown();
  }
  function inputClosed(): void { if (!input.readableEnded) fail(connectionFailure('CONNECTION_INPUT_FAILED', 'input', 'Input closed before EOF.')); }
  function inputError(): void { fail(connectionFailure('CONNECTION_INPUT_FAILED', 'input', 'Reading connection input failed.')); }
  function outputError(): void { failOutput(connectionFailure('CONNECTION_OUTPUT_FAILED', 'stdio', 'Writing connection output failed.', { outcomeUnknown: true })); }
  function outputClosed(): void { if (!finished) outputError(); output.off('error', outputError); output.off('close', outputClosed); }
  function aborted(): void { shutdown(); }
  function shutdown(): void {
    if (stopping) return;
    stopping = true; stopInput();
    void (async () => {
      const closeAndDrain = async (): Promise<void> => {
        try { await connection.close(); }
        catch (error) { failure ??= error; }
        if (finished) return;
        if (pending.size) await new Promise<void>(resolve => { pendingDrained = resolve; });
        if (!outputFailed && (writing || queue.length)) {
          await new Promise<void>((resolve, reject) => { drainWaiters.add({ resolve, reject }); });
        }
      };
      try {
        await deadline(Promise.resolve().then(closeAndDrain), cleanupTimeoutMs, 'CONNECTION_DRAIN_TIMEOUT');
      } catch (error) { failure ??= error; failOutput(error); }
      finally {
        finished = true; pendingDrained = undefined;
        input.off('error', inputError); signal?.removeEventListener('abort', aborted);
        if (!outputFailed || output.closed) { output.off('error', outputError); output.off('close', outputClosed); }
        if (failure === undefined) resolveRun(); else rejectRun(failure);
      }
    })();
  }
  input.on('error', inputError); output.on('error', outputError); output.on('close', outputClosed);
  input.on('data', data); input.on('end', ended); input.on('close', inputClosed);
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted || connection.closing || input.readableEnded) shutdown();
  else if (input.destroyed || output.destroyed || !output.writable) output.destroyed || !output.writable ? outputError() : inputClosed();
  await completed;
}
