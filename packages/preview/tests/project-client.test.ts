import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { canonicalJson, createProceduralScene, sceneRevision } from '@strata-engine/authoring';
import { createEngine, SceneCommitError } from '@strata-engine/core';
import type { Engine, EngineTelemetry, FrameMetrics, SceneCommitReceipt } from '@strata-engine/core';
import { prepareAuthoredPreviewLoad } from '../src/adapter.js';
import { defaultProjectView } from '../src/project-input.js';
import type { ProjectInputRevisionPayload, ProjectRuntimeData } from '../src/project-types.js';

vi.mock('@strata-engine/core', async importOriginal => ({
  ...await importOriginal<typeof import('@strata-engine/core')>(), createEngine: vi.fn(),
}));

type State = { status: string; identity: ProjectRuntimeData['identity']; commit: SceneCommitReceipt | null;
  frame: FrameMetrics | null; telemetry: EngineTelemetry | null; error: { code: string; message: string; commitOccurred?: boolean } | null };
interface Bridge { ready: Promise<State>; inspect(): State; dispose(): void }
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function runtimeData(): ProjectRuntimeData {
  const source = createProceduralScene('saved_scene.v1');
  const prepared = prepareAuthoredPreviewLoad({ scene: source, revision: sceneRevision(source), view: defaultProjectView() });
  const hashes = { projectSha256: 'a'.repeat(64), sceneSha256: 'b'.repeat(64), viewSha256: 'c'.repeat(64),
    runtimeSceneSha256: hash(prepared.scene), resolvedViewSha256: hash(prepared.view) };
  const projectId = 'saved_project.v1', width = 320, height = 180;
  const payload: ProjectInputRevisionPayload = { format: 'strata.project.inputs', version: 1, projectId, width, height, ...hashes };
  return { format: 'strata.project.runtime', version: 1, projectId, width, height,
    scene: prepared.scene, view: prepared.view,
    identity: { ...hashes, projectRevision: `sha256:${'d'.repeat(64)}`, sourceRevision: prepared.sourceRevision,
      inputRevision: `sha256:${hash(payload)}` } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

let events: EventTarget;
let elements: { canvas: { width: number; height: number }; status: { textContent: string }; error: { hidden: boolean; textContent: string } };
let bridge: Bridge | undefined;
let data: ProjectRuntimeData;
beforeEach(() => {
  vi.resetModules(); vi.mocked(createEngine).mockReset();
  events = new EventTarget(); data = runtimeData();
  elements = { canvas: { width: 300, height: 150 }, status: { textContent: '' }, error: { hidden: true, textContent: '' } };
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('document', { querySelector: (selector: string) => ({ '#project-canvas': elements.canvas,
    '#project-status': elements.status, '#project-error': elements.error })[selector] });
  vi.stubGlobal('addEventListener', events.addEventListener.bind(events));
  vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(canonicalJson(data))));
});
afterEach(() => { bridge?.dispose(); bridge = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

async function launch(): Promise<Bridge> {
  await import('../src/browser/project-client.js');
  bridge = (globalThis as unknown as { __strataProject: Bridge }).__strataProject;
  return bridge;
}
function fakeCore() {
  let state: Engine['state'] = 'ready';
  const commit: SceneCommitReceipt = { sceneGeneration: 7, renderer: 'authored-boxes', sceneId: data.scene.sceneId,
    sourceRevision: data.identity.sourceRevision };
  let telemetry = { scene: { identity: commit, firstSubmittedFrameId: null, lastSubmittedFrameId: null },
    submittedFrames: 0, gpuErrorCount: 0, lastGpuError: null } as EngineTelemetry;
  const frame: FrameMetrics = { frameId: 1, scene: commit,
    authored: { camera: data.view.camera, width: data.width, height: data.height, aspect: data.width / data.height,
      origin: data.view.camera.position, debugView: data.view.debugView, timeSeconds: data.view.timeSeconds,
      motion: { previousSubmittedFrameId: null, valid: false, resetReason: 'first-frame' } },
    cpuSubmissionMs: 0.2, drawCalls: 1, dispatchCalls: 0, triangles: 12, uploadBytes: 0,
    allocatedGpuBufferBytes: 100, allocatedGpuTextureBytes: 100, wasmMemoryBytes: 100 };
  const engine = {
    get state() { return state; }, info: { profiling: { enabled: false }, adapter: { description: 'CPU test fake; no GPU' } },
    getTelemetry: vi.fn(() => structuredClone(telemetry)),
    setScene: vi.fn(async () => commit),
    render: vi.fn(() => {
      telemetry = { ...telemetry, submittedFrames: 1, scene: { identity: commit, firstSubmittedFrameId: 1, lastSubmittedFrameId: 1 } };
      return structuredClone(frame);
    }),
    waitForIdle: vi.fn(async () => {}), dispose: vi.fn(() => { state = 'disposed'; }),
  };
  vi.mocked(createEngine).mockResolvedValue(engine as unknown as Engine);
  return { engine, commit, frame, replaceTelemetry: (next: Partial<EngineTelemetry>) => { telemetry = { ...telemetry, ...next }; },
    setState: (next: Engine['state']) => { state = next; } };
}

test('one submitted and fenced frame exposes detached data using the real Core validators', async () => {
  const h = fakeCore(), app = await launch();
  const ready = await app.ready;
  expect(ready).toMatchObject({ status: 'ready', identity: data.identity, commit: h.commit, frame: { frameId: 1 } });
  expect(h.engine.render).toHaveBeenCalledTimes(1);
  expect(h.engine.waitForIdle).toHaveBeenCalledTimes(1);
  expect(createEngine).toHaveBeenCalledWith(expect.objectContaining({ canvas: elements.canvas, profiling: false }));
  expect(elements.canvas).toEqual({ width: 320, height: 180 });
  expect(elements.status.textContent).toBe(`Saved project ${data.projectId} is ready.`);
  ready.identity.inputRevision = 'caller mutation';
  expect(app.inspect().identity.inputRevision).toBe(data.identity.inputRevision);
  events.dispatchEvent(new Event('pagehide')); app.dispose();
  expect(app.inspect().status).toBe('disposed'); expect(h.engine.dispose).toHaveBeenCalledTimes(1);
});

test.each(['scene', 'view', 'identity', 'profile'] as const)('rejects altered %s data before creating an engine', async kind => {
  const h = fakeCore();
  if (kind === 'scene') data = { ...data, scene: { ...data.scene, background: [0.1, 0.2, 0.3] }, view: { ...data.view, background: [0.1, 0.2, 0.3] } };
  if (kind === 'view') data = { ...data, view: { ...data.view, timeSeconds: 2 } };
  if (kind === 'identity') data.identity.inputRevision = `sha256:${'f'.repeat(64)}`;
  if (kind === 'profile') data = { ...data, scene: { ...data.scene, boxes: data.scene.boxes.map(box =>
    ({ ...box, material: { ...box.material, baseColor: [1, 1, 1, 0.5] as unknown as readonly [number, number, number, 1] } })) } };
  const app = await launch(); await expect(app.ready).rejects.toBeDefined();
  expect(createEngine).not.toHaveBeenCalled(); expect(h.engine.render).not.toHaveBeenCalled();
  expect(app.inspect().status).toBe('failed'); expect(elements.error.hidden).toBe(false);
});

test.each(['projectId', 'width', 'height'] as const)('rejects a valid but unhashed %s change before creating an engine', async field => {
  const h = fakeCore();
  if (field === 'projectId') data.projectId = 'different_project';
  else data[field] += 1;
  const app = await launch();
  await expect(app.ready).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_INVALID', message: 'Runtime data differs from its recorded input identity.' });
  expect(createEngine).not.toHaveBeenCalled(); expect(h.engine.setScene).not.toHaveBeenCalled();
  expect(h.engine.render).not.toHaveBeenCalled(); expect(app.inspect().status).toBe('failed');
});

test('pagehide during initialization disposes a late candidate without loading or resurrecting ready', async () => {
  const h = fakeCore(), initialization = deferred<Engine>(), entered = deferred<void>();
  vi.mocked(createEngine).mockImplementation(() => { entered.resolve(); return initialization.promise; });
  const app = await launch(); await entered.promise;
  events.dispatchEvent(new Event('pagehide'));
  expect(app.inspect().status).toBe('disposed');
  initialization.resolve(h.engine as unknown as Engine);
  await expect(app.ready).rejects.toMatchObject({ code: 'PROJECT_DISPOSED' });
  expect(h.engine.dispose).toHaveBeenCalledTimes(1); expect(h.engine.setScene).not.toHaveBeenCalled();
  expect(app.inspect().status).toBe('disposed');
});

test('pagehide during the frame fence preserves disposal after the fence settles', async () => {
  const h = fakeCore(), fence = deferred<void>(), entered = deferred<void>();
  h.engine.waitForIdle.mockImplementation(() => { entered.resolve(); return fence.promise; });
  const app = await launch(); await entered.promise;
  expect(app.inspect().status).toBe('loading'); events.dispatchEvent(new Event('pagehide')); fence.resolve();
  await expect(app.ready).rejects.toMatchObject({ code: 'PROJECT_DISPOSED' });
  expect(h.engine.dispose).toHaveBeenCalledTimes(1);
  expect(app.inspect()).toMatchObject({ status: 'disposed', frame: { frameId: 1 } });
});

test.each(['commit', 'frame', 'viewport', 'camera', 'device', 'gpu-error'] as const)('does not claim readiness after a %s mismatch during the fence', async kind => {
  const h = fakeCore();
  h.engine.waitForIdle.mockImplementation(async () => {
    if (kind === 'commit') h.replaceTelemetry({ scene: { identity: { ...h.commit, sceneGeneration: 8 }, firstSubmittedFrameId: 1, lastSubmittedFrameId: 1 } });
    if (kind === 'frame') h.replaceTelemetry({ scene: { identity: h.commit, firstSubmittedFrameId: 1, lastSubmittedFrameId: 2 }, submittedFrames: 2 });
    if (kind === 'viewport') elements.canvas.width = 640;
    if (kind === 'device') h.setState('lost');
    if (kind === 'gpu-error') h.replaceTelemetry({ gpuErrorCount: 1 });
  });
  if (kind === 'camera') Object.assign(h.frame, { authored: { ...h.frame.authored!, camera: { ...data.view.camera, position: [1, 2, 3] } } });
  const app = await launch(); await expect(app.ready).rejects.toBeDefined();
  expect(app.inspect().status).toBe('failed'); expect(h.engine.dispose).toHaveBeenCalledTimes(1);
  expect(h.engine.render).toHaveBeenCalledTimes(1);
});

test('a fence rejection retains the actual submitted frame without reporting ready', async () => {
  const h = fakeCore(); h.engine.waitForIdle.mockRejectedValue(new Error('Fence failed <not markup>'));
  const app = await launch(); await expect(app.ready).rejects.toThrow('Fence failed');
  expect(app.inspect()).toMatchObject({ status: 'failed', commit: h.commit, frame: { frameId: 1 } });
  expect(elements.error.textContent).toContain('<not markup>');
  expect(h.engine.dispose).toHaveBeenCalledTimes(1);
});

test('a render failure never fabricates a returned frame receipt', async () => {
  const h = fakeCore(); h.engine.render.mockImplementation(() => { throw new Error('Submission failed'); });
  const app = await launch(); await expect(app.ready).rejects.toThrow('Submission failed');
  expect(app.inspect()).toMatchObject({ status: 'failed', commit: h.commit, frame: null });
  expect(h.engine.waitForIdle).not.toHaveBeenCalled(); expect(h.engine.dispose).toHaveBeenCalledTimes(1);
});

test('post-commit cleanup failure keeps the exact historical commit and submits no frame', async () => {
  const h = fakeCore(); h.engine.setScene.mockRejectedValue(new SceneCommitError(h.commit, new Error('Retirement failed')));
  const app = await launch(); await expect(app.ready).rejects.toBeInstanceOf(SceneCommitError);
  expect(app.inspect()).toMatchObject({ status: 'failed', commit: h.commit, frame: null, error: { commitOccurred: true } });
  expect(h.engine.render).not.toHaveBeenCalled(); expect(h.engine.dispose).toHaveBeenCalledTimes(1);
});

test('inspection detects later device failure while the ready promise remains a historical snapshot', async () => {
  const h = fakeCore(), app = await launch(); const ready = await app.ready;
  h.setState('lost');
  expect(app.inspect().status).toBe('failed'); expect(ready.status).toBe('ready');
  expect(h.engine.dispose).toHaveBeenCalledTimes(1);
  h.setState('ready'); expect(app.inspect().status).toBe('failed');
});

test('startup timeout reports failure immediately and disposes a late initializer result', async () => {
  vi.useFakeTimers();
  const h = fakeCore(), initialization = deferred<Engine>(), entered = deferred<void>();
  vi.mocked(createEngine).mockImplementation(() => { entered.resolve(); return initialization.promise; });
  const app = await launch(); await entered.promise;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(app.inspect()).toMatchObject({ status: 'failed', error: { code: 'PROJECT_STARTUP_TIMEOUT' } });
  initialization.resolve(h.engine as unknown as Engine);
  await expect(app.ready).rejects.toMatchObject({ code: 'PROJECT_STARTUP_TIMEOUT' });
  expect(h.engine.dispose).toHaveBeenCalledTimes(1); expect(h.engine.setScene).not.toHaveBeenCalled();
});

test('pagehide during a late fetch cannot begin initialization', async () => {
  fakeCore(); const response = deferred<Response>();
  vi.mocked(fetch).mockReturnValue(response.promise);
  const app = await launch(); events.dispatchEvent(new Event('pagehide'));
  expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  response.resolve(new Response(canonicalJson(data)));
  await expect(app.ready).rejects.toMatchObject({ code: 'PROJECT_DISPOSED' });
  expect(createEngine).not.toHaveBeenCalled(); expect(app.inspect().status).toBe('disposed');
});
