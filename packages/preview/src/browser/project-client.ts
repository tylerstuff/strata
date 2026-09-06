// Standalone generated-app entry. The validation bridge below reports this one
// fixed submission; it is not an editing, capture, or general preview API.
import { createEngine, SceneCommitError, validateAuthoredBoxScene, validateAuthoredFrameCamera } from '@strata-engine/core';
import type { Engine, EngineInfo, EngineTelemetry, FrameMetrics, SceneCommitReceipt } from '@strata-engine/core';
import type { ProjectIdentity, ProjectInputRevisionPayload, ProjectRuntimeData } from '../project-types.js';

interface Failure { code: string; message: string; stage?: string; commitOccurred?: true }
interface ProjectState {
  status: 'loading' | 'ready' | 'failed' | 'disposed';
  projectId: string | null;
  identity: ProjectIdentity | null;
  width: number | null;
  height: number | null;
  view: ProjectRuntimeData['view'] | null;
  commit: SceneCommitReceipt | null;
  frame: FrameMetrics | null;
  telemetry: EngineTelemetry | null;
  environment: EngineInfo | null;
  error: Failure | null;
  cleanupError: Failure | null;
}

const canvas = document.querySelector<HTMLCanvasElement>('#project-canvas');
const statusElement = document.querySelector<HTMLElement>('#project-status');
const errorElement = document.querySelector<HTMLElement>('#project-error');
const controller = new AbortController();
const state: ProjectState = { status: 'loading', projectId: null, identity: null, width: null, height: null,
  view: null, commit: null, frame: null, telemetry: null, environment: null, error: null, cleanupError: null };
let engine: Engine | null = null;
let disposed = false;
function invalid(message: string): never { throw Object.assign(new Error(message), { code: 'PROJECT_RUNTIME_INVALID' }); }
const failure = (error: unknown): Failure => ({
  code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'PROJECT_BROWSER_FAILED',
  message: error instanceof Error ? error.message : String(error),
  ...(error instanceof SceneCommitError ? { stage: error.stage, commitOccurred: true as const } : {}),
});
// The saved-project hash contract uses sorted keys, two-space indentation and
// one final LF. Only this JSON encoding is reproduced here, not a scene schema.
function canonical(value: unknown): string {
  function render(value: unknown, depth: number): string {
    if (depth > 64) invalid('Runtime JSON exceeds its nesting limit.');
    const indent = '  '.repeat(depth), childIndent = `${indent}  `;
    if (Array.isArray(value)) return value.length === 0 ? '[]'
      : `[\n${value.map(item => `${childIndent}${render(item, depth + 1)}`).join(',\n')}\n${indent}]`;
    if (value && typeof value === 'object') {
      const keys = Object.keys(value).sort();
      return keys.length === 0 ? '{}' : `{\n${keys.map(key =>
        `${childIndent}${JSON.stringify(key)}: ${render((value as Record<string, unknown>)[key], depth + 1)}`).join(',\n')}\n${indent}}`;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) invalid('Runtime data must contain finite JSON numbers.');
    const result = JSON.stringify(value);
    if (result === undefined) invalid('Runtime data must contain JSON values.');
    return result;
  }
  return `${render(value, 0)}\n`;
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const sameCommit = (a: SceneCommitReceipt, b: SceneCommitReceipt): boolean =>
  a.sceneGeneration === b.sceneGeneration && a.renderer === b.renderer && a.sceneId === b.sceneId && a.sourceRevision === b.sourceRevision;
async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) invalid('Runtime data has missing or unsupported fields.');
  return value as Record<string, unknown>;
}
function active(): void {
  if (controller.signal.aborted) throw controller.signal.reason;
}
function release(candidate: Engine | null): void {
  try { candidate?.dispose(); }
  catch (error) { state.cleanupError = failure(error); }
}
function releaseOwned(): void { const current = engine; engine = null; release(current); }
function dispose(): void {
  if (disposed) return;
  disposed = true;
  state.status = 'disposed';
  controller.abort(Object.assign(new Error('Saved project was disposed.'), { code: 'PROJECT_DISPOSED' }));
  clearTimeout(timeout);
  releaseOwned();
  if (statusElement) statusElement.textContent = 'Saved project disposed.';
  globalThis.removeEventListener('pagehide', dispose);
}
function fail(error: unknown): void {
  if (disposed) return;
  state.status = 'failed'; state.error = failure(error);
  if (error instanceof SceneCommitError) state.commit = structuredClone(error.committedScene);
  if (engine) {
    try { state.telemetry = structuredClone(engine.getTelemetry()); } catch { /* Preserve the primary failure. */ }
  }
  releaseOwned();
  if (statusElement) statusElement.textContent = 'Saved project could not become ready.';
  if (errorElement) { errorElement.hidden = false; errorElement.textContent = `${state.error.code}: ${state.error.message}`; }
}

async function readRuntimeData(): Promise<ProjectRuntimeData> {
  const response = await fetch('./project-runtime.json', { signal: controller.signal, cache: 'no-store', redirect: 'error' });
  active();
  if (!response.ok || !response.body) invalid(`Cannot read project-runtime.json (HTTP ${response.status}).`);
  const maximum = 16 * 1024 * 1024, reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    for (;;) {
      const chunk = await reader.read(); active();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) invalid('Runtime data exceeds its 16 MiB limit.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const value = record(JSON.parse(text) as unknown, ['format', 'version', 'projectId', 'identity', 'width', 'height', 'scene', 'view']);
  if (value.format !== 'strata.project.runtime' || value.version !== 1
    || typeof value.projectId !== 'string' || !/^[a-z][a-z0-9._-]{0,63}(?![\s\S])/.test(value.projectId)) invalid('Unsupported saved runtime document.');
  for (const key of ['width', 'height']) if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key])
    || value[key] < 1 || value[key] > 16_384) invalid('Runtime dimensions must be integers from 1 to 16384 physical pixels.');
  const width = value.width as number, height = value.height as number;
  if (width * height > 64 * 1024 * 1024) invalid('Runtime viewport exceeds 64 Mi pixels.');
  const identity = record(value.identity, ['projectRevision', 'sourceRevision', 'inputRevision', 'projectSha256', 'sceneSha256',
    'viewSha256', 'runtimeSceneSha256', 'resolvedViewSha256']);
  for (const [key, hash] of Object.entries(identity)) if (typeof hash !== 'string'
    || !(key.endsWith('Revision') ? /^sha256:[a-f0-9]{64}$/ : /^[a-f0-9]{64}$/).test(hash)) invalid('Runtime identity hashes are invalid.');
  const scene = validateAuthoredBoxScene(value.scene);
  const view = record(value.view, ['camera', 'light', 'background', 'debugView', 'timeSeconds', 'temporal']);
  const camera = validateAuthoredFrameCamera(scene, view.camera, width, height);
  if (scene.sourceRevision !== identity.sourceRevision || !same(camera, scene.camera)
    || !same(view.light, scene.light) || !same(view.background, scene.background)
    || !['final', 'base-color'].includes(view.debugView as string) || view.temporal !== false
    || typeof view.timeSeconds !== 'number' || !Number.isFinite(view.timeSeconds)) invalid('Saved view and runtime scene do not describe the same supported fixed view.');
  const payload: ProjectInputRevisionPayload = { format: 'strata.project.inputs', version: 1,
    projectId: value.projectId, width, height,
    projectSha256: identity.projectSha256 as string, sceneSha256: identity.sceneSha256 as string, viewSha256: identity.viewSha256 as string,
    runtimeSceneSha256: await sha256(scene), resolvedViewSha256: await sha256(view) };
  if (payload.runtimeSceneSha256 !== identity.runtimeSceneSha256 || payload.resolvedViewSha256 !== identity.resolvedViewSha256
    || `sha256:${await sha256(payload)}` !== identity.inputRevision) invalid('Runtime data differs from its recorded input identity.');
  active();
  return { format: 'strata.project.runtime', version: 1, projectId: value.projectId,
    identity: structuredClone(identity) as unknown as ProjectIdentity, width, height, scene,
    view: { camera, light: scene.light, background: scene.background,
      debugView: view.debugView as 'final' | 'base-color', timeSeconds: view.timeSeconds, temporal: false } };
}

function verifyReady(current: Engine): void {
  active();
  const telemetry = current.getTelemetry();
  state.telemetry = structuredClone(telemetry);
  if (current.state !== 'ready' || telemetry.gpuErrorCount !== 0) throw Object.assign(new Error('Core is not healthy after the submitted frame.'), { code: 'PROJECT_RUNTIME_FAILED' });
  const frame = state.frame, commit = state.commit;
  if (!frame?.authored || !commit || !sameCommit(commit, frame.scene) || !sameCommit(commit, telemetry.scene.identity)
    || telemetry.submittedFrames !== 1 || telemetry.scene.firstSubmittedFrameId !== frame.frameId
    || telemetry.scene.lastSubmittedFrameId !== frame.frameId || frame.authored.width !== state.width || frame.authored.height !== state.height
    || canvas?.width !== state.width || canvas.height !== state.height || !same(frame.authored.camera, state.view?.camera)
    || frame.authored.debugView !== state.view?.debugView || frame.authored.timeSeconds !== state.view?.timeSeconds) {
    throw Object.assign(new Error('The fenced frame does not match the saved scene, view, or physical dimensions.'), { code: 'PROJECT_FRAME_MISMATCH' });
  }
}
function inspect(): ProjectState {
  if (state.status === 'ready' && engine) {
    try { verifyReady(engine); } catch (error) { fail(error); }
  }
  return structuredClone(state);
}
async function start(): Promise<ProjectState> {
  if (!canvas || !statusElement || !errorElement) invalid('Saved project HTML is missing its canvas or status elements.');
  const data = await readRuntimeData(); active();
  Object.assign(state, { projectId: data.projectId, identity: data.identity, width: data.width, height: data.height, view: data.view });
  canvas.width = data.width; canvas.height = data.height;
  const candidate = await createEngine({ canvas, signal: controller.signal, initializationTimeoutMs: 30_000, profiling: false });
  if (controller.signal.aborted) { release(candidate); active(); }
  engine = candidate; state.environment = structuredClone(candidate.info);
  if (candidate.state !== 'ready' || candidate.getTelemetry().gpuErrorCount !== 0) throw new Error('Core initialization did not yield a healthy engine.');
  state.commit = structuredClone(await candidate.setScene({ renderer: 'authored-boxes', scene: data.scene, signal: controller.signal }));
  active();
  if (state.commit.renderer !== 'authored-boxes' || state.commit.sceneId !== data.scene.sceneId
    || state.commit.sourceRevision !== data.identity.sourceRevision) throw Object.assign(new Error('Core committed a different scene.'), { code: 'PROJECT_FRAME_MISMATCH' });
  state.frame = structuredClone(candidate.render({ camera: data.view.camera, debugView: data.view.debugView,
    timeSeconds: data.view.timeSeconds, temporal: false }));
  await candidate.waitForIdle();
  verifyReady(candidate);
  state.status = 'ready';
  statusElement.textContent = `Saved project ${data.projectId} is ready.`;
  return structuredClone(state);
}

globalThis.addEventListener('pagehide', dispose);
const timeout = setTimeout(() => {
  const error = Object.assign(new Error('Saved project startup exceeded 30 seconds.'), { code: 'PROJECT_STARTUP_TIMEOUT' });
  controller.abort(error);
  fail(error);
}, 30_000);
const ready = start().catch(error => {
  const finalError: unknown = controller.signal.aborted ? controller.signal.reason : error;
  fail(finalError); throw finalError;
}).finally(() => clearTimeout(timeout));
// Keep a rejected ready promise observable without an unhandled rejection when
// the host only reads the accessible status text.
void ready.catch(() => {});
Object.assign(globalThis, { __strataProject: Object.freeze({ ready, inspect, dispose }) });
