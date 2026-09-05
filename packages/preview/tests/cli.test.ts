import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProceduralScene, sceneRevision, serializeScene, type SceneDocument } from '@strata-engine/authoring';
import type { CapturePublication } from '../src/artifacts.js';
import { MAX_PREVIEW_VIEW_BYTES, runPreviewCli, type PreviewCliDependencies, type PreviewCliSession, type PreviewCliSessionOptions } from '../src/cli.js';
import { PreviewError } from '../src/errors.js';
import type { OperationOptions } from '../src/operation.js';
import type { CaptureRequest, PreviewReadyReceipt } from '../src/session.js';

interface LoadedInput { scene: SceneDocument; revision: string; view: unknown }

class FakeSession implements PreviewCliSession {
  loads: { input: unknown; options: OperationOptions | undefined }[] = [];
  captures: { request: CaptureRequest; options: OperationOptions | undefined }[] = [];
  disposed = 0;
  events: string[] = [];
  onLoad?: () => Promise<void>;
  onCapture?: () => Promise<void>;
  onDispose?: () => Promise<void>;
  readyPatch: Partial<PreviewReadyReceipt<unknown>> = {};
  publication: CapturePublication | null = null;
  cleanupWarnings: { path: string; message: string }[] = [];

  async load(value: unknown, options?: OperationOptions): Promise<PreviewReadyReceipt<unknown>> {
    this.events.push('load');
    this.loads.push({ input: value, options });
    await this.onLoad?.();
    const loaded = value as LoadedInput;
    return {
      sessionId: 'fake-session', loadId: 'fake-load', sceneId: loaded.scene.id, sourceRevision: loaded.revision,
      commit: { testGeneration: 1 }, viewRevision: 'effective-view-digest', resolvedView: loaded.view,
      frameId: 1, width: 512, height: 512, ...this.readyPatch,
    };
  }

  async capture(request: CaptureRequest, options?: OperationOptions): Promise<CapturePublication> {
    this.events.push('capture');
    this.captures.push({ request, options });
    await this.onCapture?.();
    return this.publication = {
      imagePath: join(request.outputDirectory, 'capture-id', 'image.png'),
      receiptPath: join(request.outputDirectory, 'capture-id', 'receipt.json'),
      receipt: { sourceRevision: request.expectedRevision, loadId: request.expectedLoadId, frameId: 2 },
      cleanupWarnings: this.cleanupWarnings,
    };
  }

  async dispose() {
    this.events.push('dispose');
    this.disposed++;
    await this.onDispose?.();
  }
}

function harness(session = new FakeSession()) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const factoryOptions: PreviewCliSessionOptions[] = [];
  const dependencies: PreviewCliDependencies = {
    createSession(options) { factoryOptions.push(options); return session; },
    stdout(text) { stdout.push(text); },
    async stderr(text) { stderr.push(text); },
  };
  return { session, stdout, stderr, factoryOptions, dependencies };
}

function json(stream: string[]): Record<string, unknown> {
  expect(stream).toHaveLength(1);
  return JSON.parse(stream[0]!) as Record<string, unknown>;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const directory of temporaryRoots.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function files() {
  const root = await mkdtemp(join(tmpdir(), 'strata-preview-cli-test-'));
  temporaryRoots.push(root);
  const scenePath = join(root, 'scene.json');
  const viewPath = join(root, 'view.json');
  const output = join(root, 'new', 'nested-output');
  const scene = createProceduralScene('cli-demo');
  const view = { arbitraryAdapterOwnedView: { camera: [0, 0, 2] } };
  await writeFile(scenePath, serializeScene(scene));
  await writeFile(viewPath, JSON.stringify(view));
  return { root, scenePath, viewPath, output, scene, view, args: ['capture', '--scene', scenePath, '--view', viewPath, '--output', output] };
}

describe('runPreviewCli without a browser factory', () => {
  it.each([['--help'], ['help'], ['capture', '--help']].map(argv => ({ argv })))('returns one JSON help result for $argv without acquiring resources', async ({ argv }) => {
    const h = harness();
    expect(await runPreviewCli(argv, h.dependencies)).toBe(0);
    expect(json(h.stdout)).toMatchObject({ status: 'help', usage: { defaults: { width: 512, height: 512, frames: 1, timeoutMs: 30_000 } } });
    expect(h.stderr).toEqual([]);
    expect(h.factoryOptions).toEqual([]);
    expect(h.session.disposed).toBe(0);
  });

  it('loads validated file snapshots and forwards exact readiness tokens with defaults', async () => {
    const f = await files();
    const h = harness();
    h.dependencies.createSession = async options => {
      expect((await stat(f.output)).isDirectory()).toBe(true);
      h.factoryOptions.push(options);
      return h.session;
    };
    h.dependencies.stdout = async text => { expect(h.session.disposed).toBe(1); h.stdout.push(text); };
    expect(await runPreviewCli(f.args, h.dependencies)).toBe(0);
    expect(h.factoryOptions).toEqual([{ width: 512, height: 512, headless: true, softwareGpu: false, channel: 'chromium', timeoutMs: 30_000 }]);
    expect(h.session.loads).toEqual([{ input: { scene: f.scene, revision: sceneRevision(f.scene), view: f.view }, options: { timeoutMs: 30_000 } }]);
    expect(h.session.captures).toEqual([{ request: {
      expectedRevision: sceneRevision(f.scene), expectedLoadId: 'fake-load', expectedViewRevision: 'effective-view-digest',
      outputDirectory: f.output, frames: 1,
    }, options: { timeoutMs: 30_000 } }]);
    expect(json(h.stdout)).toMatchObject({ status: 'captured', publicationOccurred: true, imagePath: h.session.publication!.imagePath, receiptPath: h.session.publication!.receiptPath });
    expect(h.session.events).toEqual(['load', 'capture', 'dispose']);
    expect(h.stderr).toEqual([]);
    expect(await readFile(f.scenePath, 'utf8')).toBe(serializeScene(f.scene));
  });

  it('forwards explicit browser, viewport, frame, deadline and cancellation options', async () => {
    const f = await files();
    const h = harness();
    const controller = new AbortController();
    h.dependencies.signal = controller.signal;
    expect(await runPreviewCli([...f.args, '--width', '640', '--height', '480', '--frames', '8', '--timeout-ms', '1000', '--headed', '--software-gpu', '--browser', 'chrome'], h.dependencies)).toBe(0);
    expect(h.factoryOptions).toEqual([{ width: 640, height: 480, headless: false, softwareGpu: true, channel: 'chrome', timeoutMs: 1000, signal: controller.signal }]);
    expect(h.session.loads[0]!.options).toEqual({ timeoutMs: 1000, signal: controller.signal });
    expect(h.session.captures[0]!.options).toEqual({ timeoutMs: 1000, signal: controller.signal });
    expect(h.session.captures[0]!.request.frames).toBe(8);
    json(h.stdout);
  });

  it.each([
    [], ['unknown'], ['capture'], ['--help', 'extra'], ['capture', '--unknown'], ['capture', '--scene=x'],
    ['capture', '--scene', 'one', '--scene', 'two'], ['capture', '--headed', '--headed'],
    ['capture', '--scene', '--view', 'x'], ['capture', 'positional'],
  ].map(args => ({ args })))('rejects missing, unknown and duplicate arguments $args without side effects', async ({ args }) => {
    const h = harness();
    expect(await runPreviewCli(args, h.dependencies)).toBe(2);
    expect(json(h.stdout)).toMatchObject({ status: 'failed', publicationOccurred: false, error: { code: 'PREVIEW_CLI_USAGE', stage: 'arguments' } });
    expect(h.factoryOptions).toEqual([]);
  });

  it.each([
    ['--width', '0'], ['--height', '-1'], ['--width', '16385'], ['--width', '8193', '--height', '8193'],
    ['--frames', '0'], ['--frames', '9'], ['--frames', '1.5'], ['--frames', '1e0'],
    ['--timeout-ms', '0'], ['--timeout-ms', '300001'], ['--browser', 'firefox'],
  ].map(extra => ({ extra })))('rejects invalid limits $extra before reading or creating output', async ({ extra }) => {
    const f = await files();
    const h = harness();
    expect(await runPreviewCli([...f.args, ...extra], h.dependencies)).toBe(2);
    expect(json(h.stdout)).toMatchObject({ error: { code: 'PREVIEW_CLI_USAGE' } });
    expect(h.factoryOptions).toEqual([]);
    await expect(access(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    '{bad JSON', 'null', '[]', '{"overflow":1e309}',
    Buffer.from([123, 34, 120, 34, 58, 34, 0xc3, 0x28, 34, 125]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]),
    `${'{"x":'.repeat(130)}0${'}'.repeat(130)}`,
    Buffer.alloc(MAX_PREVIEW_VIEW_BYTES + 1, 0x20),
  ])('rejects malformed, non-object, unbounded or non-UTF8 view input', async view => {
    const f = await files();
    await writeFile(f.viewPath, view);
    const h = harness();
    expect(await runPreviewCli(f.args, h.dependencies)).toBe(2);
    expect(json(h.stdout)).toMatchObject({ error: { code: 'PREVIEW_INVALID_VIEW', details: { source: f.viewPath } } });
    expect(h.factoryOptions).toEqual([]);
    await expect(access(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts a view exactly at the byte bound and does not impose a Core schema', async () => {
    const f = await files();
    await writeFile(f.viewPath, '{}'.padEnd(MAX_PREVIEW_VIEW_BYTES, ' '));
    const h = harness();
    expect(await runPreviewCli(f.args, h.dependencies)).toBe(0);
    expect(h.session.loads[0]!.input).toMatchObject({ view: {} });
    json(h.stdout);
  });

  it('retains authoring diagnostics for an invalid scene without creating output', async () => {
    const f = await files();
    await writeFile(f.scenePath, JSON.stringify({ ...f.scene, camera: {} }));
    const h = harness();
    expect(await runPreviewCli(f.args, h.dependencies)).toBe(2);
    expect(json(h.stdout)).toMatchObject({ error: { code: 'PREVIEW_INVALID_SCENE', details: { diagnostics: [{ code: 'UNSUPPORTED_FIELD', path: '/camera' }] } } });
    expect(h.factoryOptions).toEqual([]);
    await expect(access(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports an output-directory failure as runtime I/O before creating a session', async () => {
    const f = await files();
    await mkdir(join(f.root, 'new'));
    await writeFile(f.output, 'A file blocks this directory.');
    const h = harness();
    expect(await runPreviewCli(f.args, h.dependencies)).toBe(1);
    expect(json(h.stdout)).toMatchObject({ error: { code: 'PREVIEW_OUTPUT_IO' } });
    expect(h.factoryOptions).toEqual([]);
    expect(await readFile(f.output, 'utf8')).toBe('A file blocks this directory.');
  });

  it('reports factory failure without pretending it owns a returned session', async () => {
    const f = await files();
    const h = harness();
    h.dependencies.createSession = async () => { throw new PreviewError('PREVIEW_BROWSER_START_FAILED', 'initialize', 'Cannot start browser.'); };
    expect(await runPreviewCli(f.args, h.dependencies)).toBe(1);
    expect(json(h.stdout)).toMatchObject({ status: 'failed', error: { code: 'PREVIEW_BROWSER_START_FAILED' } });
    expect(h.session.disposed).toBe(0);
  });

  it.each(['PREVIEW_SOURCE_REVISION_MISMATCH', 'PREVIEW_UNSUPPORTED_ASSET', 'PREVIEW_RUNTIME_VALIDATION_FAILED'])
  ('reports adapter rejection %s as input failure and disposes the session', async code => {
    const f = await files();
    const h = harness();
    h.session.onLoad = async () => { throw new PreviewError(code, 'prepare-load', 'Rejected authored input.', { coreCode: 'UNSUPPORTED_LIMIT' }); };
    expect(await runPreviewCli(f.args, h.dependencies)).toBe(2);
    expect(json(h.stdout)).toMatchObject({ status: 'failed', publicationOccurred: false, error: { code, details: { coreCode: 'UNSUPPORTED_LIMIT' } } });
    expect(h.session.captures).toEqual([]);
    expect(h.session.disposed).toBe(1);
  });

  it.each(['load', 'capture'] as const)('disposes after %s fails and preserves the primary failure', async stage => {
    const f = await files();
    const h = harness();
    const fail = async () => { throw new PreviewError('PREVIEW_TEST_FAILURE', stage, 'Operation failed.'); };
    if (stage === 'load') h.session.onLoad = fail;
    else h.session.onCapture = fail;
    h.session.onDispose = async () => { throw new Error('Cleanup also failed.'); };
    expect(await runPreviewCli(f.args, h.dependencies)).toBe(1);
    expect(json(h.stdout)).toMatchObject({ status: 'failed', publicationOccurred: false, error: { code: 'PREVIEW_TEST_FAILURE', stage }, cleanupWarnings: [{ code: 'PREVIEW_CLEANUP_FAILED' }] });
    expect(h.session.disposed).toBe(1);
  });

  it('rejects a ready receipt for another source snapshot before capture', async () => {
    const f = await files();
    const h = harness();
    h.session.readyPatch = { sourceRevision: 'another-revision' };
    expect(await runPreviewCli(f.args, h.dependencies)).toBe(1);
    expect(json(h.stdout)).toMatchObject({ error: { code: 'PREVIEW_STALE_STATE' } });
    expect(h.session.captures).toEqual([]);
    expect(h.session.disposed).toBe(1);
  });

  it('stops an already-aborted request before acquiring a session or creating output', async () => {
    const f = await files();
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    h.dependencies.signal = controller.signal;
    expect(await runPreviewCli(f.args, h.dependencies)).toBe(1);
    expect(json(h.stdout)).toMatchObject({ status: 'cancelled', publicationOccurred: false, error: { code: 'PREVIEW_ABORTED' } });
    expect(h.factoryOptions).toEqual([]);
    await expect(access(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('awaits an uncooperative factory after cancellation and disposes its late session', async () => {
    const f = await files();
    const h = harness();
    const entered = deferred();
    const ready = deferred<PreviewCliSession>();
    const controller = new AbortController();
    h.dependencies.signal = controller.signal;
    h.dependencies.createSession = async options => { h.factoryOptions.push(options); entered.resolve(); return ready.promise; };
    let settled = false;
    const running = runPreviewCli(f.args, h.dependencies);
    void running.then(() => { settled = true; });
    await entered.promise;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.factoryOptions[0]!.signal).toBe(controller.signal);
    ready.resolve(h.session);
    expect(await running).toBe(1);
    expect(json(h.stdout)).toMatchObject({ status: 'cancelled', publicationOccurred: false });
    expect(h.session.loads).toEqual([]);
    expect(h.session.disposed).toBe(1);
  });

  it('preserves captured truth if disposal fails after publication', async () => {
    const f = await files();
    const h = harness();
    h.session.onDispose = async () => { throw new Error('Cannot close browser.'); };
    expect(await runPreviewCli(f.args, h.dependencies)).toBe(1);
    expect(json(h.stdout)).toMatchObject({ status: 'captured', publicationOccurred: true, imagePath: h.session.publication!.imagePath, receiptPath: h.session.publication!.receiptPath, cleanupWarnings: [{ code: 'PREVIEW_CLEANUP_FAILED' }] });
    expect(h.session.disposed).toBe(1);
  });

  it('preserves explicit post-publication error metadata and capture paths', async () => {
    const f = await files();
    const h = harness();
    h.session.onCapture = async () => {
      throw new PreviewError('PREVIEW_ARTIFACT_IO', 'cleanup', 'Temporary receipt cleanup failed.', {
        publicationOccurred: true, imagePath: '/published/image.png', receiptPath: '/published/receipt.json', receipt: { captureId: 'done' },
      });
    };
    expect(await runPreviewCli(f.args, h.dependencies)).toBe(1);
    expect(json(h.stdout)).toMatchObject({ status: 'captured', publicationOccurred: true, imagePath: '/published/image.png', receiptPath: '/published/receipt.json', receipt: { captureId: 'done' }, error: { code: 'PREVIEW_ARTIFACT_IO' } });
    expect(h.session.disposed).toBe(1);
  });

  it('does not relabel publication as cancelled when abort arrives during final cleanup', async () => {
    const f = await files();
    const h = harness();
    const controller = new AbortController();
    h.dependencies.signal = controller.signal;
    h.session.onDispose = async () => { controller.abort(); };
    expect(await runPreviewCli(f.args, h.dependencies)).toBe(0);
    expect(json(h.stdout)).toMatchObject({ status: 'captured', publicationOccurred: true });
  });

  it('reports a failed stdout write on stderr with publication truth and never retries stdout', async () => {
    const f = await files();
    const h = harness();
    h.dependencies.stdout = async text => { h.stdout.push(text); throw new Error('EPIPE after possible partial write.'); };
    expect(await runPreviewCli(f.args, h.dependencies)).toBe(1);
    expect(json(h.stdout)).toMatchObject({ status: 'captured', publicationOccurred: true });
    expect(json(h.stderr)).toMatchObject({ status: 'reporting-failed', publicationOccurred: true, imagePath: h.session.publication!.imagePath, receiptPath: h.session.publication!.receiptPath, error: { code: 'PREVIEW_REPORT_FAILED', stage: 'stdout' } });
    expect(h.session.disposed).toBe(1);
  });

  it('returns failure even when both reporting channels reject after successful publication', async () => {
    const f = await files();
    const h = harness();
    h.dependencies.stdout = () => { throw new Error('stdout closed.'); };
    h.dependencies.stderr = () => { throw new Error('stderr closed.'); };
    expect(await runPreviewCli(f.args, h.dependencies)).toBe(1);
    expect(h.session.publication).not.toBeNull();
    expect(h.session.disposed).toBe(1);
  });

  it('classifies a structured stdout exception as reporting failure rather than capture cancellation', async () => {
    const f = await files();
    const h = harness();
    h.dependencies.stdout = () => { throw new PreviewError('PREVIEW_ABORTED', 'writer', 'Writer was canceled.'); };
    expect(await runPreviewCli(f.args, h.dependencies)).toBe(1);
    expect(json(h.stderr)).toMatchObject({
      status: 'reporting-failed', publicationOccurred: true,
      error: { code: 'PREVIEW_REPORT_FAILED', stage: 'stdout', details: { causeCode: 'PREVIEW_ABORTED' } },
    });
    expect(h.session.disposed).toBe(1);
  });
});
