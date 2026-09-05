import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { BoxSceneDescriptor, FrameMetrics, SceneCommitReceipt } from '@strata-engine/core';
import { prepareAuthoredPreviewLoad } from './adapter.js';
import type { AuthoredPreviewView } from './adapter.js';
import type { PreviewDriver, PreviewDriverFrame, PreviewDriverObservation } from './driver.js';
import { PreviewError } from './errors.js';
import { OperationGate } from './operation.js';
import { PreviewSession } from './session.js';
import { startPreviewServer } from './server.js';

export interface CreatePreviewSessionOptions {
  width?: number;
  height?: number;
  headless?: boolean;
  /** Explicit functional-test mode; its timings are not hardware performance evidence. */
  softwareGpu?: boolean;
  channel?: 'chromium' | 'chrome';
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  signal?: AbortSignal;
}

type Observation = PreviewDriverObservation<SceneCommitReceipt>;
type SubmittedFrame = PreviewDriverFrame<SceneCommitReceipt, FrameMetrics>;
type AuthoredSession = PreviewSession<BoxSceneDescriptor, AuthoredPreviewView, SceneCommitReceipt, FrameMetrics>;
interface RpcResult {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string; stage?: string; commitOccurred?: true; committedScene?: SceneCommitReceipt };
}
interface BrowserBridge {
  request(request: { id: string; method: string; data: unknown }): Promise<RpcResult>;
  cancel(id: string): void;
  dispose(): void;
}

async function settleCleanup(entries: readonly { resource: string; promise: Promise<void> }[], timeoutMs: number): Promise<void> {
  const unresolved = new Set(entries.map(entry => entry.resource));
  const errors: { resource: string; message: string }[] = [];
  const completed = Promise.all(entries.map(async entry => {
    try { await entry.promise; }
    catch (error) { errors.push({ resource: entry.resource, message: String(error) }); }
    finally { unresolved.delete(entry.resource); }
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([completed, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(1, timeoutMs)); })]); }
  finally { clearTimeout(timer); }
  if (errors.length || unresolved.size) {
    throw new PreviewError('PREVIEW_DISPOSE_FAILED', 'dispose', 'Preview cleanup failed or exceeded its deadline.',
      { errors, unresolvedResources: [...unresolved] });
  }
}

function settings(options: CreatePreviewSessionOptions): Required<Omit<CreatePreviewSessionOptions, 'signal'>> {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['width', 'height', 'headless', 'softwareGpu', 'channel', 'timeoutMs', 'cleanupTimeoutMs', 'signal'].includes(key))) {
    throw new PreviewError('PREVIEW_INVALID_OPTIONS', 'initialize', 'Unknown preview session option.');
  }
  const value = {
    width: options.width === undefined ? 512 : options.width, height: options.height === undefined ? 512 : options.height,
    headless: options.headless === undefined ? true : options.headless, softwareGpu: options.softwareGpu === undefined ? false : options.softwareGpu,
    channel: options.channel === undefined ? 'chromium' : options.channel, timeoutMs: options.timeoutMs === undefined ? 30_000 : options.timeoutMs,
    cleanupTimeoutMs: options.cleanupTimeoutMs === undefined ? 5000 : options.cleanupTimeoutMs,
  };
  if (!Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1
    || value.width > 16_384 || value.height > 16_384 || value.width * value.height > 64 * 1024 * 1024
    || typeof value.headless !== 'boolean' || typeof value.softwareGpu !== 'boolean'
    || !['chromium', 'chrome'].includes(value.channel)
    || [value.timeoutMs, value.cleanupTimeoutMs].some(item => !Number.isInteger(item) || item < 1 || item > 300_000)
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    throw new PreviewError('PREVIEW_INVALID_OPTIONS', 'initialize', 'Invalid viewport, browser or deadline option.');
  }
  return value;
}

/** Owns one loopback server, browser, context, canvas, engine and worker. */
class AuthoredBrowserDriver implements PreviewDriver<BoxSceneDescriptor, AuthoredPreviewView, SceneCommitReceipt, FrameMetrics> {
  readonly #browser: Browser;
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #server: Awaited<ReturnType<typeof startPreviewServer>>;
  readonly #environment: Record<string, unknown>;
  readonly #cleanupTimeoutMs: number;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;
  #browserFailure: string | null = null;
  #last: Observation;

  constructor(browser: Browser, context: BrowserContext, page: Page, server: Awaited<ReturnType<typeof startPreviewServer>>,
    environment: Record<string, unknown>, width: number, height: number, cleanupTimeoutMs: number) {
    this.#browser = browser;
    this.#context = context;
    this.#page = page;
    this.#server = server;
    this.#environment = environment;
    this.#cleanupTimeoutMs = cleanupTimeoutMs;
    this.#last = { status: 'ready', commit: null, width, height, lastSubmittedFrameId: null, telemetry: {}, environment };
    page.on('pageerror', error => { this.#browserFailure ??= error.message.slice(0, 2048); });
    page.on('crash', () => { this.#browserFailure ??= 'Preview browser page crashed.'; });
    browser.on('disconnected', () => { if (!this.#disposed) this.#browserFailure ??= 'Preview browser disconnected.'; });
  }

  prepareLoad = prepareAuthoredPreviewLoad;

  async initialize(width: number, height: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
    await this.#request('initialize', { width, height, timeoutMs }, signal);
    const state = await this.observe();
    if (state.status !== 'ready') throw new PreviewError('PREVIEW_INITIALIZE_FAILED', 'initialize', 'The initialized browser/runtime is unhealthy.', { state });
  }

  async observe(): Promise<Observation> {
    const terminal = this.#terminalObservation();
    if (terminal) return terminal;
    try {
      const result = await this.#request('observe', null) as Observation;
      const after = this.#terminalObservation();
      if (after) return after;
      this.#last = { ...result, environment: { ...this.#environment, ...(result.environment as Record<string, unknown>) } };
      return this.#last;
    } catch (error) {
      const after = this.#terminalObservation();
      if (after) return after;
      this.#browserFailure ??= error instanceof Error ? error.message.slice(0, 2048) : 'Browser observation failed.';
      return this.#terminalObservation()!;
    }
  }

  #terminalObservation(): Observation | null {
    if (this.#disposed) return { ...this.#last, status: 'disposed' };
    if (this.#browserFailure) return { ...this.#last, status: 'failed', environment: { ...this.#environment, browserFailure: this.#browserFailure } };
    return null;
  }

  async setScene(scene: BoxSceneDescriptor, signal: AbortSignal): Promise<SceneCommitReceipt> {
    return await this.#request('load', scene, signal) as SceneCommitReceipt;
  }

  async render(view: AuthoredPreviewView, signal: AbortSignal): Promise<SubmittedFrame> {
    return await this.#request('render', view, signal) as SubmittedFrame;
  }

  async resize(width: number, height: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new PreviewError('PREVIEW_ABORTED', 'resize', 'Resize was canceled.');
    await this.#page.setViewportSize({ width, height });
    await this.#request('resize', { width, height }, signal);
  }

  async waitForIdle(signal: AbortSignal): Promise<void> { await this.#request('fence', null, signal); }

  async screenshot(signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) throw new PreviewError('PREVIEW_ABORTED', 'screenshot', 'Screenshot was canceled.');
    return this.#page.locator('#preview').screenshot({ type: 'png', animations: 'disabled', scale: 'css' });
  }

  committedReceipt(error: unknown): SceneCommitReceipt | undefined {
    if (error instanceof PreviewError && error.details.commitOccurred === true) {
      return error.details.committedScene as SceneCommitReceipt | undefined;
    }
    return undefined;
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    this.#disposed = true;
    const deadline = Date.now() + this.#cleanupTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const releaseEngine = this.#page.evaluate(() => {
        (globalThis as unknown as { __strataPreview?: BrowserBridge }).__strataPreview?.dispose();
      }).catch(() => undefined);
      await Promise.race([releaseEngine, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(1000, this.#cleanupTimeoutMs)); })]);
    } finally { clearTimeout(timer); }
    // Explicit engine shutdown is bounded; closing the context/browser also
    // interrupts outstanding RPCs and releases the dedicated worker/device.
    await settleCleanup([
      { resource: 'context', promise: this.#context.close() },
      { resource: 'browser', promise: this.#browser.close() },
      { resource: 'server', promise: this.#server.dispose() },
    ], deadline - Date.now());
  }

  async #request(method: string, data: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#disposed) throw new PreviewError('PREVIEW_DISPOSED', method, 'Preview browser was disposed.');
    if (signal?.aborted) throw new PreviewError('PREVIEW_ABORTED', method, 'Browser request was canceled before it started.');
    const id = randomUUID();
    let cancellation: Promise<unknown> | null = null;
    const onAbort = (): void => {
      cancellation = this.#page.evaluate(requestId => {
        const host = (globalThis as unknown as { __strataPreview: BrowserBridge }).__strataPreview;
        host.cancel(requestId);
      }, id).catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await this.#page.evaluate(request => {
        const host = (globalThis as unknown as { __strataPreview: BrowserBridge }).__strataPreview;
        return host.request(request);
      }, { id, method, data });
      if (!result.ok) {
        const error = result.error!;
        throw new PreviewError(error.code, error.stage ?? method, error.message, {
          ...(error.commitOccurred === true ? { commitOccurred: true, committedScene: error.committedScene } : {}),
        });
      }
      return result.value;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (cancellation) await cancellation;
    }
  }
}

/** Start a real ordinary WebGPU browser session. No animation loop is installed. */
export async function createPreviewSession(options: CreatePreviewSessionOptions = {}): Promise<AuthoredSession> {
  const resolved = settings(options);
  const args = ['--enable-unsafe-webgpu'];
  if (resolved.softwareGpu && process.platform === 'linux') {
    args.push('--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface');
  } else if (resolved.softwareGpu) args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  let server: Awaited<ReturnType<typeof startPreviewServer>> | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let driver: AuthoredBrowserDriver | null = null;
  let teardownStarted = false;
  let cleanupDeadline: number | null = null;
  const releases = new WeakMap<object, Promise<void>>();
  const release = (resource: object | null, action: () => Promise<void> | undefined): Promise<void> => {
    if (!resource) return Promise.resolve();
    let pending = releases.get(resource);
    if (!pending) {
      pending = Promise.resolve().then(action);
      releases.set(resource, pending);
    }
    return pending;
  };
  const cleanup = async (): Promise<void> => {
    teardownStarted = true;
    cleanupDeadline ??= Date.now() + resolved.cleanupTimeoutMs;
    if (driver) { await driver.dispose(); return; }
    const currentContext = context, currentBrowser = browser, currentServer = server;
    await settleCleanup([
      { resource: 'context', promise: release(currentContext, () => currentContext?.close()) },
      { resource: 'browser', promise: release(currentBrowser, () => currentBrowser?.close()) },
      { resource: 'server', promise: release(currentServer, () => currentServer?.dispose()) },
    ], cleanupDeadline - Date.now());
  };
  const gate = new OperationGate({ defaultTimeoutMs: resolved.timeoutMs, cleanupTimeoutMs: resolved.cleanupTimeoutMs,
    onFault: () => { void cleanup().catch(() => {}); } });
  return gate.run('load', options.signal ? { signal: options.signal } : {}, async operation => {
    try {
      const runtimeDirectory = dirname(fileURLToPath(import.meta.resolve('@strata-engine/core')));
      const clientSource = await readFile(new URL('./browser/client.js', import.meta.url), 'utf8');
      operation.throwIfAborted();
      server = await startPreviewServer({ runtimeDirectory, clientSource, signal: operation.signal });
      operation.throwIfAborted();
      browser = await chromium.launch({ headless: resolved.headless, channel: resolved.channel, args, timeout: resolved.timeoutMs });
      operation.throwIfAborted();
      context = await browser.newContext({ viewport: { width: resolved.width, height: resolved.height }, deviceScaleFactor: 1 });
      operation.throwIfAborted();
      const page = await context.newPage();
      page.setDefaultTimeout(resolved.timeoutMs);
      operation.throwIfAborted();
      driver = new AuthoredBrowserDriver(browser, context, page, server, {
        browser: { version: browser.version(), channel: resolved.channel, headless: resolved.headless, softwareGpu: resolved.softwareGpu, launchArguments: args },
        host: { platform: process.platform, architecture: process.arch },
      }, resolved.width, resolved.height, resolved.cleanupTimeoutMs);
      await page.goto(server.url, { waitUntil: 'load', timeout: resolved.timeoutMs });
      operation.throwIfAborted();
      await page.waitForFunction(() => '__strataPreview' in globalThis);
      await driver.initialize(resolved.width, resolved.height, resolved.timeoutMs, operation.signal);
      operation.throwIfAborted();
      if (teardownStarted) throw new PreviewError('PREVIEW_DISPOSED', 'initialize', 'Initialization teardown already began.');
      return new PreviewSession(driver, { defaultTimeoutMs: resolved.timeoutMs, cleanupTimeoutMs: resolved.cleanupTimeoutMs });
    } catch (error) {
      try { await cleanup(); }
      catch (cleanupError) {
        throw new PreviewError('PREVIEW_INITIALIZE_FAILED', 'initialize', error instanceof Error ? error.message : String(error),
          { cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
      }
      throw error;
    }
  }).catch(async error => {
    // Cancellation may beat the gate's result delivery after initialization
    // returned a session. No rejected factory call may leave that session alive.
    try { await cleanup(); }
    catch (cleanupError) {
      throw new PreviewError('PREVIEW_INITIALIZE_FAILED', 'initialize', error instanceof Error ? error.message : String(error),
        { cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
    }
    throw error;
  });
}
