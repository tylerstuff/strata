import { PassThrough, Readable, Writable } from 'node:stream';
import { setImmediate as turn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { runPreviewConnectionStdio } from '../src/connection-stdio.js';
import { PREVIEW_CONNECTION_LIMITS as limits, connectionFailure, type ConnectionResponse, type PreviewConnectionHandler } from '../src/connection-protocol.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const success = (id: number, result: unknown = {}): ConnectionResponse => ({ version: 1, id, ok: true, result });
const frame = (id: number, method = 'discover'): string => `${JSON.stringify({ version: 1, id, method, params: {} })}\n`;
function captureOutput(highWaterMark = 16384) {
  const chunks: Buffer[] = [];
  const output = new Writable({ highWaterMark, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  return { output, text: () => Buffer.concat(chunks).toString(), records: () => Buffer.concat(chunks).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
function handler(request: PreviewConnectionHandler['request'] = async value => success((value as { id: number }).id)) {
  return { closing: false as boolean, request: vi.fn(request), close: vi.fn(async () => {}) } satisfies PreviewConnectionHandler;
}
type ErrorKind = 'invalid JSON' | 'invalid UTF-8' | 'synchronous handler throw';
const errorKinds: ErrorKind[] = ['invalid JSON', 'invalid UTF-8', 'synchronous handler throw'];
function errorFrames(kind: ErrorKind, count: number): Buffer {
  return Buffer.concat(Array.from({ length: count }, (_, i) => kind === 'invalid JSON' ? Buffer.from('no\n')
    : kind === 'invalid UTF-8' ? Buffer.from([0xff, 10]) : Buffer.from(frame(i + 1))));
}
function errorHandler(kind: ErrorKind) {
  const connection = handler(value => {
    const request = value as { id: number; method: string };
    if (kind === 'synchronous handler throw' && request.method === 'discover') throw new Error('Handler failed synchronously.');
    if (request.method === 'dispose') connection.closing = true;
    return Promise.resolve(success(request.id));
  });
  return connection;
}

describe('connection stdio framing', () => {
  it('decodes a multibyte character split across chunks and emits one compact line', async () => {
    const input = new PassThrough(), result = captureOutput(), connection = handler(async value => success(1, value));
    const running = runPreviewConnectionStdio({ connection, input, output: result.output });
    const bytes = Buffer.from('{"id":1,"name":"雪"}\n');
    const start = bytes.indexOf(Buffer.from('雪'));
    input.write(bytes.subarray(0, start + 1)); input.write(bytes.subarray(start + 1, start + 2)); input.end(bytes.subarray(start + 2));
    await running;
    expect(result.records()).toEqual([success(1, { id: 1, name: '雪' })]);
    expect(result.text().split('\n')).toHaveLength(2);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(result.output.writableEnded).toBe(false);
  });

  it('rejects malformed bytes, JSON, batches, BOM and unterminated EOF without dispatch', async () => {
    const malformed = Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
    const input = Readable.from([malformed, Buffer.from('no\n[]\n\ufeff{}\n{"id":1}')]);
    const result = captureOutput(), connection = handler();
    await runPreviewConnectionStdio({ connection, input, output: result.output });
    expect(connection.request).not.toHaveBeenCalled();
    expect(result.records().map(r => [r.id, r.error.code])).toEqual([
      [null, 'CONNECTION_INVALID_UTF8'], [null, 'CONNECTION_INVALID_JSON'],
      [null, 'CONNECTION_INVALID_FRAME'], [null, 'CONNECTION_INVALID_JSON'], [null, 'CONNECTION_UNTERMINATED_FRAME'],
    ]);
  });

  it('accepts exactly 64KiB and discards one oversized line through LF', async () => {
    const prefix = '{"id":1,"pad":"', suffix = '"}';
    const exact = Buffer.from(prefix + 'x'.repeat(limits.inputLineBytes - prefix.length - suffix.length) + suffix);
    const input = Readable.from([exact, Buffer.from('\n'), Buffer.alloc(limits.inputLineBytes, 32), Buffer.from('x'), Buffer.alloc(20000, 32), Buffer.from('\n'), Buffer.from(frame(2))]);
    const result = captureOutput(), connection = handler();
    await runPreviewConnectionStdio({ connection, input, output: result.output });
    expect(connection.request).toHaveBeenCalledTimes(2);
    expect(result.records().filter(r => r.id === null).map(r => r.error.code)).toEqual(['CONNECTION_LINE_TOO_LARGE']);
    expect(result.records().filter(r => r.ok).map(r => r.id)).toEqual([1, 2]);
  });

  it('rejects decoded-string streams because original UTF-8 validity is unavailable', async () => {
    const result = captureOutput(), connection = handler();
    await expect(runPreviewConnectionStdio({ connection, input: Readable.from([frame(1)]), output: result.output })).rejects.toMatchObject({ code: 'CONNECTION_INPUT_FAILED' });
    expect(connection.close).toHaveBeenCalledTimes(1);
  });
});

describe('connection stdio ownership and output', () => {
  it('dispatches cancellation while a request is pending and responds by completion', async () => {
    const input = new PassThrough(), result = captureOutput(), load = deferred<ConnectionResponse>();
    const connection = handler(value => (value as { id: number }).id === 1 ? load.promise : Promise.resolve(success(2, { cancellationRequested: true })));
    const running = runPreviewConnectionStdio({ connection, input, output: result.output });
    input.write(frame(1, 'load') + frame(2, 'cancel'));
    await turn();
    expect(result.records()).toEqual([success(2, { cancellationRequested: true })]);
    load.resolve(success(1, { publicationOccurred: true })); await turn(); input.end(); await running;
    expect(result.records().map(r => r.id)).toEqual([2, 1]);
  });

  it('rejects ordinary admission after six slots, emits one error and shuts down', async () => {
    const input = new PassThrough(), result = captureOutput(), requests = Array.from({ length: 6 }, () => deferred<ConnectionResponse>());
    const connection = handler(value => requests[(value as { id: number }).id - 1]!.promise);
    connection.close.mockImplementation(async () => { requests.forEach((r, i) => r.resolve(success(i + 1))); });
    const running = runPreviewConnectionStdio({ connection, input, output: result.output });
    const rejection = expect(running).rejects.toMatchObject({ code: 'CONNECTION_ADMISSION_OVERFLOW' });
    input.write(Array.from({ length: 100 }, (_, i) => frame(i + 1)).join('')); await rejection;
    expect(connection.request).toHaveBeenCalledTimes(6);
    expect(result.records().filter(r => r.id === null)).toMatchObject([{ error: { code: 'CONNECTION_ADMISSION_OVERFLOW' } }]);
    expect(result.records()).toHaveLength(7); expect(input.isPaused()).toBe(true);
  });

  it('reserves control admission while six completed ordinary responses await a blocked writer', async () => {
    const input = new PassThrough(), chunks: Buffer[] = [], releases: (() => void)[] = [];
    const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); releases.push(callback); } });
    const connection = handler(async value => {
      const request = value as { id: number; method: string };
      if (request.method === 'dispose') connection.closing = true;
      return success(request.id);
    });
    const running = runPreviewConnectionStdio({ connection, input, output });
    input.write(Array.from({ length: 6 }, (_, i) => frame(i + 1)).join('')); await turn();
    expect(connection.request).toHaveBeenCalledTimes(6); expect(chunks).toHaveLength(1);
    input.write(frame(7, 'cancel') + frame(8, 'dispose')); await turn();
    expect(connection.request).toHaveBeenCalledTimes(8);
    for (let i = 0; i < 8; i++) { expect(releases).toHaveLength(1); releases.shift()!(); await turn(); }
    await running;
    expect(chunks.map(b => JSON.parse(b.toString()).id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('does not free ordinary capacity until a terminal response finishes writing', async () => {
    const input = new PassThrough(), output = new Writable({ write() {} }), connection = handler();
    const running = runPreviewConnectionStdio({ connection, input, output, cleanupTimeoutMs: 15 });
    const rejection = expect(running).rejects.toMatchObject({ code: 'CONNECTION_ADMISSION_OVERFLOW' });
    input.write(Array.from({ length: 6 }, (_, i) => frame(i + 1)).join('')); await turn();
    input.write(frame(7)); await rejection; expect(connection.request).toHaveBeenCalledTimes(6);
  });

  it('pauses admission on dispose but drains its terminal response before returning', async () => {
    const input = new PassThrough(), chunks: Buffer[] = [], release = deferred<void>();
    const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); void release.promise.then(() => callback()); } });
    const connection = handler(async value => { connection.closing = true; return success((value as { id: number }).id, { disposed: true }); });
    let finished = false;
    const running = runPreviewConnectionStdio({ connection, input, output }).then(() => { finished = true; });
    input.write(frame(1, 'dispose') + frame(2)); await turn();
    expect(connection.request).toHaveBeenCalledTimes(1); expect(connection.close).toHaveBeenCalledTimes(1); expect(finished).toBe(false);
    release.resolve(); await running;
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(success(1, { disposed: true }));
    expect(input.isPaused()).toBe(true);
  });

  it.each(['eof', 'signal'] as const)('closes once on %s and drains resulting aborted terminal responses', async cause => {
    const input = new PassThrough(), result = captureOutput(), controller = new AbortController(), request = deferred<ConnectionResponse>();
    const connection = handler(() => request.promise);
    connection.close.mockImplementation(async () => { request.resolve({ version: 1, id: 1, ok: false, error: { code: 'PREVIEW_ABORTED', stage: 'load', message: 'Canceled.', details: {} } }); });
    const running = runPreviewConnectionStdio({ connection, input, output: result.output, signal: controller.signal });
    input.write(frame(1, 'load')); if (cause === 'eof') input.end(); else controller.abort(); await running;
    expect(connection.close).toHaveBeenCalledTimes(1); expect(result.records()).toMatchObject([{ id: 1, error: { code: 'PREVIEW_ABORTED' } }]);
  });

  it('honors Writable backpressure without overlapping writes', async () => {
    const input = new PassThrough(), chunks: Buffer[] = [], callbacks: (() => void)[] = [];
    const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callbacks.push(callback); } });
    const connection = handler(), running = runPreviewConnectionStdio({ connection, input, output });
    input.write(frame(1) + frame(2)); await turn(); expect(chunks).toHaveLength(1);
    callbacks.shift()!(); await turn(); expect(chunks).toHaveLength(2);
    callbacks.shift()!(); input.end(); await running;
    expect(Buffer.concat(chunks).toString().trim().split('\n').map(s => JSON.parse(s).id)).toEqual([1, 2]);
  });

  it('returns bounded fallback evidence when a successful publication exceeds the response cap', async () => {
    const result = captureOutput();
    const connection = handler(async () => success(1, { publicationOccurred: true, commitOccurred: true, imagePath: '/out/image.png', receiptPath: '/out/receipt.json', oversized: 'x'.repeat(limits.responseBytes) }));
    await runPreviewConnectionStdio({ connection, input: Readable.from([Buffer.from(frame(1))]), output: result.output });
    expect(result.records()).toMatchObject([{ id: 1, ok: false, error: { code: 'CONNECTION_RESPONSE_TOO_LARGE', details: { publicationOccurred: true, commitOccurred: true, imagePath: '/out/image.png', receiptPath: '/out/receipt.json', outcomeUnknown: true } } }]);
    expect(Buffer.byteLength(result.text())).toBeLessThan(1000);
  });

  it.each(errorKinds)('reserves two controls while six %s responses await a blocked writer', async kind => {
    const input = new PassThrough(), chunks: Buffer[] = [], releases: (() => void)[] = [];
    const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); releases.push(callback); } });
    const connection = errorHandler(kind), running = runPreviewConnectionStdio({ connection, input, output });
    input.write(errorFrames(kind, 6)); await turn();
    expect(chunks).toHaveLength(1); expect(connection.closing).toBe(false);
    input.write(frame(7, 'cancel') + frame(8, 'dispose')); await turn();
    expect(connection.request.mock.calls.map(([value]) => (value as { method: string }).method).slice(-2)).toEqual(['cancel', 'dispose']);
    expect(connection.close).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 8; i++) { expect(releases).toHaveLength(1); releases.shift()!(); await turn(); }
    await running;
    const records = chunks.map(chunk => JSON.parse(chunk.toString()));
    expect(records.slice(0, 6).map(record => [record.id, record.ok])).toEqual(Array.from({ length: 6 }, () => [null, false]));
    expect(records.slice(6)).toEqual([success(7), success(8)]);
    expect(output.destroyed).toBe(false);
  });

  it.each(errorKinds)('closes on the seventh ordinary %s response, with at most one overflow error', async kind => {
    const input = new PassThrough(), chunks: Buffer[] = [], releases: (() => void)[] = [];
    const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); releases.push(callback); } });
    const connection = errorHandler(kind), running = runPreviewConnectionStdio({ connection, input, output });
    const rejection = expect(running).rejects.toMatchObject({ code: 'CONNECTION_ADMISSION_OVERFLOW' });
    input.write(errorFrames(kind, 6)); await turn(); input.write(errorFrames(kind, 100)); await turn();
    expect(connection.close).toHaveBeenCalledTimes(1); expect(input.isPaused()).toBe(true);
    expect(connection.request).toHaveBeenCalledTimes(kind === 'synchronous handler throw' ? 6 : 0);
    for (let i = 0; i < 7; i++) { expect(releases).toHaveLength(1); releases.shift()!(); await turn(); }
    await rejection;
    const records = chunks.map(chunk => JSON.parse(chunk.toString()));
    expect(records).toHaveLength(7);
    expect(records.filter(record => record.error.code === 'CONNECTION_ADMISSION_OVERFLOW')).toHaveLength(1);
  });

  it('releases a framing-error admission slot only after its write completes', async () => {
    const input = new PassThrough(), chunks: Buffer[] = [], releases: (() => void)[] = [];
    const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); releases.push(callback); } });
    const connection = handler(), running = runPreviewConnectionStdio({ connection, input, output });
    input.write(errorFrames('invalid JSON', 6)); await turn();
    releases.shift()!(); await turn();
    input.write(errorFrames('invalid UTF-8', 1)); await turn();
    expect(connection.close).not.toHaveBeenCalled();
    for (let i = 0; i < 6; i++) { releases.shift()!(); await turn(); }
    input.end(); await running;
    expect(chunks).toHaveLength(7); expect(connection.request).not.toHaveBeenCalled();
  });

  it('counts the LF against the four MiB response cap', async () => {
    const prefixSize = Buffer.byteLength(JSON.stringify(success(1, '')));
    const exact = 'x'.repeat(limits.responseBytes - prefixSize - 1);
    for (const [payload, expectedCode] of [[exact, undefined], [exact + 'x', 'CONNECTION_RESPONSE_TOO_LARGE']] as const) {
      const result = captureOutput(), connection = handler(async () => success(1, payload));
      await runPreviewConnectionStdio({ connection, input: Readable.from([Buffer.from(frame(1))]), output: result.output });
      if (expectedCode) expect(result.records()[0].error.code).toBe(expectedCode);
      else { expect(Buffer.byteLength(result.text())).toBe(limits.responseBytes); expect(result.records()[0].result).toBe(exact); }
    }
  });

  it('closes on a broken pipe and rejects without an unhandled stream error', async () => {
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error('Broken pipe'), { code: 'EPIPE' })); } });
    const input = new PassThrough(), connection = handler();
    const running = runPreviewConnectionStdio({ connection, input, output });
    const rejection = expect(running).rejects.toMatchObject({ code: 'CONNECTION_OUTPUT_FAILED' });
    input.write(frame(1)); await rejection; await turn(); expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled write', async () => {
    const input = new PassThrough(), output = new Writable({ write() {} }), connection = handler();
    const running = runPreviewConnectionStdio({ connection, input, output, writeTimeoutMs: 10 });
    const rejection = expect(running).rejects.toMatchObject({ code: 'CONNECTION_WRITE_TIMEOUT' });
    input.write(frame(1)); await rejection; expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('reports unknown outcome if requests remain unsettled after bounded close', async () => {
    const input = new PassThrough(), result = captureOutput(), late = deferred<ConnectionResponse>();
    const connection = handler(() => late.promise);
    const running = runPreviewConnectionStdio({ connection, input, output: result.output, cleanupTimeoutMs: 10 });
    const rejection = expect(running).rejects.toMatchObject({ code: 'CONNECTION_DRAIN_TIMEOUT', details: { outcomeUnknown: true } });
    input.end(frame(1)); await rejection;
    const serialized = vi.fn(() => ({ publicationOccurred: true }));
    late.resolve(success(1, { toJSON: serialized })); await turn(); expect(result.text()).toBe('');
    expect(serialized).not.toHaveBeenCalled();
    expect(input.listenerCount('data')).toBe(0); expect(result.output.listenerCount('error')).toBe(0);
  });

  it('observes late handler rejection without serializing diagnostics after shutdown', async () => {
    const input = new PassThrough(), result = captureOutput(), late = deferred<ConnectionResponse>(), connection = handler(() => late.promise);
    const running = runPreviewConnectionStdio({ connection, input, output: result.output, cleanupTimeoutMs: 10 });
    const rejection = expect(running).rejects.toMatchObject({ code: 'CONNECTION_DRAIN_TIMEOUT' });
    input.end(frame(1)); await rejection;
    const error = connectionFailure('LATE_FAILURE', 'capture', 'Late failure.'), readDetails = vi.fn(() => ({}));
    Object.defineProperty(error, 'details', { get: readDetails });
    late.reject(error); await turn(); await turn();
    expect(readDetails).not.toHaveBeenCalled(); expect(result.text()).toBe('');
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(input.listenerCount('error')).toBe(0); expect(result.output.listenerCount('close')).toBe(0);
  });

  it('handles a write callback failing after the stream was destroyed on timeout', async () => {
    const input = new PassThrough(), connection = handler();
    let callback!: (error?: Error | null) => void;
    const write = vi.fn((_chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) => { callback = done; });
    const output = new Writable({ write });
    const running = runPreviewConnectionStdio({ connection, input, output, writeTimeoutMs: 10 });
    const rejection = expect(running).rejects.toMatchObject({ code: 'CONNECTION_WRITE_TIMEOUT' });
    input.write(frame(1)); await rejection; await turn();
    expect(output.destroyed).toBe(true);
    callback(new Error('Late write failure')); await turn(); await turn();
    expect(write).toHaveBeenCalledTimes(1); expect(connection.close).toHaveBeenCalledTimes(1);
    expect(output.listenerCount('drain')).toBe(0); expect(output.listenerCount('error')).toBe(0);
  });

  it('delivers a successful publication that wins cancellation before the shutdown deadline', async () => {
    const input = new PassThrough(), result = captureOutput(), controller = new AbortController(), publication = deferred<ConnectionResponse>();
    const connection = handler(() => publication.promise);
    connection.close.mockImplementation(async () => { await publication.promise; });
    const running = runPreviewConnectionStdio({ connection, input, output: result.output, signal: controller.signal, cleanupTimeoutMs: 100 });
    input.write(frame(1, 'capture')); controller.abort(); await turn();
    expect(result.text()).toBe(''); expect(connection.close).toHaveBeenCalledTimes(1);
    publication.resolve(success(1, { publicationOccurred: true, imagePath: '/out/image.png', receiptPath: '/out/receipt.json' }));
    await running;
    expect(result.records()).toEqual([success(1, { publicationOccurred: true, imagePath: '/out/image.png', receiptPath: '/out/receipt.json' })]);
  });

  it('includes handler cleanup in the same absolute shutdown deadline', async () => {
    const input = new PassThrough(), result = captureOutput(), lateClose = deferred<void>(), connection = handler();
    connection.close.mockImplementation(() => lateClose.promise);
    const running = runPreviewConnectionStdio({ connection, input, output: result.output, cleanupTimeoutMs: 10 });
    const rejection = expect(running).rejects.toMatchObject({ code: 'CONNECTION_DRAIN_TIMEOUT', details: { deliveryUncertain: true } });
    input.end(); await rejection; expect(connection.close).toHaveBeenCalledTimes(1);
    lateClose.resolve(); await turn(); expect(result.text()).toBe('');
  });

  it('observes a late cleanup rejection without reopening output or admission', async () => {
    const input = new PassThrough(), result = captureOutput(), lateClose = deferred<void>(), connection = handler();
    connection.close.mockImplementation(() => lateClose.promise);
    const running = runPreviewConnectionStdio({ connection, input, output: result.output, cleanupTimeoutMs: 10 });
    const rejection = expect(running).rejects.toMatchObject({ code: 'CONNECTION_DRAIN_TIMEOUT' });
    input.end(); await rejection;
    lateClose.reject(new Error('Late cleanup failure')); await turn(); await turn();
    expect(connection.close).toHaveBeenCalledTimes(1); expect(connection.request).not.toHaveBeenCalled();
    expect(result.text()).toBe(''); expect(input.isPaused()).toBe(true);
  });

  it('preserves incomplete-cleanup errors after draining responses', async () => {
    const result = captureOutput(), connection = handler();
    connection.close.mockRejectedValue(connectionFailure('CONNECTION_CLEANUP_TIMEOUT', 'dispose', 'Cleanup incomplete.', { outcomeUnknown: true }));
    await expect(runPreviewConnectionStdio({ connection, input: Readable.from([Buffer.from(frame(1))]), output: result.output })).rejects.toMatchObject({ code: 'CONNECTION_CLEANUP_TIMEOUT' });
    expect(result.records()).toEqual([success(1)]);
  });
});
