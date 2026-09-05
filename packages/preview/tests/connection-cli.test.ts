import { Readable, Writable } from 'node:stream';
import { setImmediate as turn } from 'node:timers/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runPreviewConnectionCli } from '../src/connection-cli.js';
import { connectionFailure, type ConnectionResponse } from '../src/connection-protocol.js';

function dependencies() {
  const stdout: string[] = [], stderr: string[] = [];
  const connection = { closing: false, request: vi.fn(async (value: unknown): Promise<ConnectionResponse> => ({ version: 1, id: (value as { id: number }).id, ok: true, result: { discovered: true } })), close: vi.fn(async () => {}) };
  const deps = {
    createConnection: vi.fn(async () => connection), input: Readable.from([]),
    output: new Writable({ write(chunk, _encoding, callback) { stdout.push(chunk.toString()); callback(); } }),
    stderr: vi.fn(async (text: string) => { stderr.push(text); }),
  };
  return { deps, connection, stdout, stderr };
}
const roots = ['--project-root', './project', '--output-root', './captures'];

describe('connection startup CLI', () => {
  it('prints machine-readable help without constructing a connection', async () => {
    const { deps, stdout } = dependencies();
    expect(await runPreviewConnectionCli(['--help'], deps)).toBe(0);
    expect(deps.createConnection).not.toHaveBeenCalled(); expect(deps.stderr).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.join(''))).toMatchObject({ status: 'help', version: 1, usage: { defaults: { width: 512, height: 512, headless: true } } });
    expect(stdout.join('').split('\n')).toHaveLength(2);
  });

  it('starts with resolved fixed roots and defaults, emits no startup banner, and closes on EOF', async () => {
    const { deps, connection, stdout } = dependencies();
    expect(await runPreviewConnectionCli(roots, deps)).toBe(0);
    expect(deps.createConnection).toHaveBeenCalledExactlyOnceWith({ projectRoot: resolve('./project'), outputRoot: resolve('./captures'), channel: 'chromium', headless: true, softwareGpu: false, width: 512, height: 512, timeoutMs: 30000, cleanupTimeoutMs: 5000 });
    expect(connection.close).toHaveBeenCalledTimes(1); expect(stdout).toEqual([]); expect(deps.stderr).not.toHaveBeenCalled();
  });

  it('forwards every supported startup override and signal', async () => {
    const { deps } = dependencies(), controller = new AbortController();
    expect(await runPreviewConnectionCli([...roots, '--browser', 'chrome', '--headed', '--software-gpu', '--width', '640', '--height', '360', '--timeout-ms', '2000', '--cleanup-timeout-ms', '300000'], { ...deps, signal: controller.signal })).toBe(0);
    expect(deps.createConnection).toHaveBeenCalledWith(expect.objectContaining({ channel: 'chrome', headless: false, softwareGpu: true, width: 640, height: 360, timeoutMs: 2000, cleanupTimeoutMs: 300000, signal: controller.signal }));
  });

  it.each([
    [], ['--help', '--headed'], [...roots, '--width', '0'], [...roots, '--width', '1.2'], [...roots, '--width', '16385'],
    [...roots, '--width', '16384', '--height', '16384'], [...roots, '--timeout-ms', '300001'], [...roots, '--cleanup-timeout-ms', '-1'],
    [...roots, '--width', '512', '--width', '512'], [...roots, '--headed', '--headed'], [...roots, '--browser', 'firefox'],
    [...roots, '--other'], [...roots, '--width=10'], [...roots, '--width'], ['--project-root', 'a\0b', '--output-root', 'out'],
  ].map(argv => ({ argv })))('rejects strict invalid startup arguments $argv', async ({ argv }) => {
    const { deps, stdout, stderr } = dependencies();
    expect(await runPreviewConnectionCli(argv, deps)).toBe(2);
    expect(deps.createConnection).not.toHaveBeenCalled(); expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(''))).toMatchObject({ status: 'failed', error: { code: 'CONNECTION_CLI_USAGE', stage: 'arguments' } });
    expect(stderr.join('')).not.toContain('stack');
  });

  it('reports a structured startup failure exclusively on stderr', async () => {
    const { deps, stdout, stderr } = dependencies();
    deps.createConnection.mockRejectedValue(connectionFailure('CONNECTION_INVALID_ROOT', 'startup', 'The project root does not exist.'));
    expect(await runPreviewConnectionCli(roots, deps)).toBe(1); expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join('')).error).toMatchObject({ code: 'CONNECTION_INVALID_ROOT', stage: 'startup' });
  });

  it('does not construct a connection when already canceled', async () => {
    const { deps, stderr } = dependencies(), controller = new AbortController(); controller.abort();
    expect(await runPreviewConnectionCli(roots, { ...deps, signal: controller.signal })).toBe(1);
    expect(deps.createConnection).not.toHaveBeenCalled(); expect(JSON.parse(stderr.join('')).error.code).toBe('CONNECTION_ABORTED');
  });

  it('closes a connection returned after startup cancellation', async () => {
    const { deps, connection } = dependencies(), controller = new AbortController();
    deps.createConnection.mockImplementation(async () => { controller.abort(); return connection; });
    expect(await runPreviewConnectionCli(roots, { ...deps, signal: controller.signal })).toBe(0);
    expect(connection.close).toHaveBeenCalledTimes(1); expect(connection.request).not.toHaveBeenCalled();
  });

  it('passes only protocol responses to stdout once started', async () => {
    const { deps, stdout } = dependencies(); deps.input = Readable.from([Buffer.from('{"version":1,"id":1,"method":"discover","params":{}}\n')]);
    expect(await runPreviewConnectionCli(roots, deps)).toBe(0);
    expect(stdout).toHaveLength(1); expect(JSON.parse(stdout[0]!)).toEqual({ version: 1, id: 1, ok: true, result: { discovered: true } });
  });

  it('turns output failure into a diagnostic and closes the owned handler', async () => {
    const { deps, connection, stderr } = dependencies();
    deps.input = Readable.from([Buffer.from('{"id":1}\n')]);
    deps.output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('EPIPE')); } });
    expect(await runPreviewConnectionCli(roots, deps)).toBe(1); expect(connection.close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stderr.join('')).error.code).toBe('CONNECTION_OUTPUT_FAILED');
  });

  it('returns failure if even the diagnostic writer rejects', async () => {
    const { deps } = dependencies(); deps.stderr.mockRejectedValue(new Error('EPIPE'));
    expect(await runPreviewConnectionCli([], deps)).toBe(1);
  });

  it('handles a broken help pipe and releases the temporary error listener', async () => {
    const { deps, stderr } = dependencies();
    deps.output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('EPIPE')); } });
    expect(await runPreviewConnectionCli(['--help'], deps)).toBe(1); await turn();
    expect(JSON.parse(stderr.join('')).error.code).toBe('CONNECTION_OUTPUT_FAILED');
    expect(deps.output.listenerCount('error')).toBe(0);
  });

  it('bounds stalled help output and removes its listeners', async () => {
    vi.useFakeTimers();
    try {
      const { deps, stderr } = dependencies(); deps.output = new Writable({ write() {} });
      const running = runPreviewConnectionCli(['--help'], deps);
      await vi.advanceTimersByTimeAsync(5001);
      expect(await running).toBe(1);
      expect(JSON.parse(stderr.join('')).error.code).toBe('CONNECTION_WRITE_TIMEOUT');
      expect(deps.output.destroyed).toBe(true); expect(deps.output.listenerCount('error')).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
