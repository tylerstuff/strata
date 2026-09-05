import { loadGalleryCatalog, orderedGalleryAssets, type GalleryAsset, type GalleryCatalog } from './catalog.js';
import { GalleryRuntime, debugViews, lightingPresets, scenePresets, type DebugView, type GalleryAnimation, type LightingPreset, type ScenePreset } from './runtime.js';
import type { GalleryOrbit } from './orbit.js';
import { fitViewportSize, watchDisplayDensity } from './viewport.js';

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Gallery is missing #${id}.`);
  return value as T;
}
const canvas = element<HTMLCanvasElement>('viewport');
const modelList = element('model-list');
const sceneSelect = element<HTMLSelectElement>('scene-preset');
const lightSelect = element<HTMLSelectElement>('lighting-preset');
const debugSelect = element<HTMLSelectElement>('debug-view');
const resolutionSelect = element<HTMLSelectElement>('resolution');
const temporalToggle = element<HTMLInputElement>('temporal-aa');
const clipSelect = element<HTMLSelectElement>('animation-clip');
const timeline = element<HTMLInputElement>('animation-time');
const loopToggle = element<HTMLInputElement>('animation-loop');
const playButton = element<HTMLButtonElement>('animation-play');
const liveButton = element<HTMLButtonElement>('toggle-motion');
const events = new AbortController();
let catalog: GalleryCatalog | null = null;
let assets: GalleryAsset[] = [];
let actionError: string | null = null;
let viewportError: string | null = null;
let shownModel: string | null = null;
let shownClipSignature = '';
let fixedViewport = false;
let fitMaximumDimension = 8192;
let scrubbing = false;
const runtime = new GalleryRuntime(canvas, update);

function options(select: HTMLSelectElement, entries: readonly (readonly [string, string])[]) {
  select.replaceChildren(...entries.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
}
options(sceneSelect, Object.entries(scenePresets));
options(lightSelect, Object.entries(lightingPresets).map(([id, preset]) => [id, preset.label]));
options(debugSelect, Object.entries(debugViews));
options(clipSelect, [['', 'Rest pose']]);

function paragraph(text: string) {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}
function detail(label: string, value: string) {
  const p = document.createElement('p');
  const name = document.createElement('strong');
  name.textContent = `${label} `;
  p.append(name, document.createTextNode(value));
  return p;
}
function anchor(label: string, href: string | null) {
  if (href === null) return document.createTextNode(label);
  // The catalog transport permits only HTTPS links. Check again at the DOM sink.
  const url = new URL(href);
  if (url.protocol !== 'https:' || url.username || url.password) return document.createTextNode(label);
  const a = document.createElement('a');
  a.textContent = label;
  a.href = url.href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}
function formatCount(value: number | null) { return value === null ? 'Unavailable' : value.toLocaleString(); }
function milliseconds(value: number | null) { return value === null ? '—' : `${value.toFixed(2)} ms`; }

function showCatalog() {
  modelList.replaceChildren();
  for (const asset of assets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'model-card';
    button.dataset.modelId = asset.id;
    button.setAttribute('aria-pressed', 'false');
    const name = document.createElement('span');
    name.className = 'model-name'; name.textContent = asset.title;
    const metadata = document.createElement('span');
    metadata.className = 'model-meta'; metadata.textContent = asset.category;
    const status = document.createElement('span');
    status.className = 'model-status'; status.textContent = asset.unavailableReason ? 'Unavailable' : `${formatCount(asset.triangles)} source triangles`;
    button.append(name, metadata, status);
    button.addEventListener('click', () => run(() => selectModel(asset.id)), { signal: events.signal });
    modelList.append(button);
  }
  if (assets.length === 0) modelList.append(paragraph(catalog?.diagnostics.join(' ') || 'No local models are available.'));
}

function update() {
  const state = runtime.getState();
  fitMaximumDimension = state.engineInfo?.maxTextureDimension2D ?? fitMaximumDimension;
  const selected = assets.find(asset => asset.id === state.requestedModelId) ?? null;
  const ready = state.phase === 'ready' && state.busy === null;
  const known = state.asset !== null && state.modelId === selected?.id ? state.asset : null;
  element('model-title').textContent = selected?.title ?? 'Model gallery';
  element('model-subtitle').textContent = selected ? `${selected.category} · Local glTF` : 'Select a local model to begin.';
  element('connection-status').textContent = ({ initializing: 'Starting Strata', empty: 'Strata ready', loading: 'Loading model', ready: state.live ? 'Live view' : 'Ready · paused', unsupported: 'Unsupported', error: 'Needs attention', disposed: 'Disposed' } satisfies Record<typeof state.phase, string>)[state.phase];
  const overlay = element('stage-status');
  overlay.hidden = state.phase === 'ready';
  overlay.textContent = state.phase === 'loading' ? 'Loading model and textures into Strata…' : state.phase === 'initializing' ? 'Starting the WebGPU runtime…' : state.phase === 'empty' ? 'Choose a model from your collection.' : state.phase === 'disposed' ? 'Gallery disposed.' : 'The requested model is not ready.';
  const error = element('stage-error');
  error.hidden = state.error === null;
  error.textContent = state.error ? `${state.error.code}: ${state.error.message}` : '';
  canvas.setAttribute('aria-busy', String(state.phase === 'loading' || state.busy !== null));
  for (const control of [sceneSelect, lightSelect, debugSelect, resolutionSelect, element<HTMLButtonElement>('reset-camera'), liveButton, element<HTMLButtonElement>('render-frame')]) control.disabled = !ready;
  sceneSelect.value = state.settings.scenePreset;
  lightSelect.value = state.settings.lightingPreset;
  debugSelect.value = state.settings.debugView;
  temporalToggle.disabled = !ready;
  temporalToggle.checked = state.settings.temporal;
  liveButton.textContent = state.live ? 'Pause live view' : 'Resume live view';
  liveButton.setAttribute('aria-pressed', String(state.live));
  for (const button of modelList.querySelectorAll<HTMLButtonElement>('button[data-model-id]')) {
    button.setAttribute('aria-pressed', String(button.dataset.modelId === state.requestedModelId));
    button.disabled = state.phase === 'initializing' || state.phase === 'disposed' || state.busy !== null;
  }
  if (shownModel !== selected?.id) {
    shownModel = selected?.id ?? null;
    const attribution = element('attribution');
    attribution.replaceChildren();
    if (selected) {
      attribution.append(paragraph(selected.author));
      const links = document.createElement('p');
      links.append(anchor('Source model', selected.sourceUrl), document.createTextNode(' · '), anchor(selected.license, selected.licenseUrl));
      attribution.append(links);
    }
  }
  const details = element('model-details');
  details.replaceChildren();
  if (selected) {
    details.append(detail('Category', selected.category), detail('Source triangles', formatCount(selected.triangles)), detail('Source texture edge', selected.textureMaxEdge === null ? 'Unavailable' : `${selected.textureMaxEdge.toLocaleString()} px`));
    if (known) details.append(detail('Loaded triangles', formatCount(known.stats.triangles)), detail('Runtime primitives', formatCount(known.stats.primitives)), detail('Texture upload cap', `${known.maxTextureDimension} px`));
    else details.append(paragraph('Runtime support and loaded counts are established after a successful import.'));
  } else details.append(paragraph('Select a model to view its details.'));
  const limitations = element('limitations');
  limitations.replaceChildren();
  const notes = new Set([
    'Textures are capped at 2048 px for this gallery. Importer warnings report resizing and unsupported content.',
    'Lighting uses one directional light and ambient fill with material AO only. Imported GI and reflections are unavailable.',
    ...(state.settings.scenePreset === 'ground' && (known?.clips.length ?? 0) > 0 ? ['Ground stays at the rest-pose level; animated poses can cross it. Use Model only to inspect the full pose.'] : []),
    ...(selected?.features.usedExtensions.includes('KHR_materials_unlit') ? ['Includes authored unlit materials. Their color may remain unchanged when scene lighting changes; ground and shadows can still respond.'] : []),
    ...(selected?.notes ?? []), ...(known?.warnings ?? []), ...(known ? state.frame?.imported?.warnings ?? [] : []), ...(catalog?.diagnostics ?? []),
  ]);
  for (const note of notes) limitations.append(paragraph(note));

  const clips = known?.clips ?? [];
  const signature = JSON.stringify(clips);
  if (shownClipSignature !== signature) {
    shownClipSignature = signature;
    options(clipSelect, [['', 'Rest pose'], ...clips.map(clip => [clip.id, clip.name || clip.id] as const)]);
  }
  const animation = state.settings.animation;
  const activeClip = clips.find(clip => clip.id === animation.clipId);
  clipSelect.disabled = !ready || clips.length === 0;
  clipSelect.value = animation.clipId ?? '';
  playButton.disabled = !ready || !activeClip;
  playButton.textContent = animation.playing ? 'Pause animation' : 'Play animation';
  playButton.setAttribute('aria-pressed', String(animation.playing));
  timeline.disabled = !ready || !activeClip;
  timeline.max = String(activeClip?.duration ?? 0);
  if (!scrubbing) timeline.value = String(animation.timeSeconds);
  element<HTMLOutputElement>('animation-time-label').value = `${(scrubbing ? Number(timeline.value) : animation.timeSeconds).toFixed(2)} / ${(activeClip?.duration ?? 0).toFixed(2)} s`;
  loopToggle.disabled = !ready || !activeClip;
  loopToggle.checked = animation.loop;
  element('animation-status').textContent = known ? clips.length ? `${clips.length} runtime-supported clips. Authored motion; camera fit uses rest pose. Looping returns to the clip start.` : 'The runtime exposes no playable clips for this model.' : 'Animation support is reported by the runtime.';

  const metrics = state.measurements;
  element('metric-cpu').textContent = milliseconds(metrics.cpuSubmissionMs);
  element('metric-cadence').textContent = milliseconds(metrics.callbackIntervalMs);
  element('metric-frame').textContent = metrics.submittedFrameId === null ? '—' : String(metrics.submittedFrameId);
  element('metric-gpu').textContent = metrics.gpu.spanMs === null ? '—' : metrics.gpu.spanMs.toFixed(2);
  element('metric-gpu').title = metrics.gpu.frameId === null ? state.engineInfo?.profiling.reason ?? 'No matching GPU samples yet.' : `Measured pass span for frame ${metrics.gpu.frameId}; ${metrics.gpu.passCount} pass samples. Not total frame or presentation time.`;
  const adapter = state.engineInfo?.adapter;
  element('metric-device').textContent = adapter ? [adapter.description || adapter.device || adapter.architecture || adapter.vendor || 'WebGPU adapter', ...(adapter.isFallbackAdapter ? ['software adapter'] : [])].join(' · ') : 'Waiting for runtime';
  element('operation-status').textContent = viewportError ?? actionError ?? (state.busy ? `Preparing ${state.busy}…` : state.phase === 'ready' ? `${state.viewport.width} × ${state.viewport.height} · ${state.frame?.triangles.toLocaleString() ?? '—'} submitted triangles · ${state.telemetry?.gpuErrorCount ?? 0} GPU errors` : state.error?.message ?? catalog?.diagnostics.join(' ') ?? 'Loading catalog…');
  updateDisplayStatus();
}

function getDisplay() {
  // The canvas has no border or padding. Use its CSS content dimensions in every
  // sizing path, rather than mixing the wrapper's border and content boxes.
  const rect = canvas.getBoundingClientRect();
  const devicePixelRatio = window.devicePixelRatio;
  return {
    mode: fixedViewport ? 'fixed' as const : 'fit' as const,
    css: { width: rect.width, height: rect.height },
    render: { width: canvas.width, height: canvas.height },
    devicePixelRatio,
    nativeScale: {
      x: rect.width > 0 ? canvas.width / (rect.width * devicePixelRatio) : null,
      y: rect.height > 0 ? canvas.height / (rect.height * devicePixelRatio) : null,
    },
  };
}
function fittedViewport() {
  const display = getDisplay();
  return fitViewportSize(display.css.width, display.css.height, display.devicePixelRatio, fitMaximumDimension);
}
function updateDisplayStatus() {
  const display = getDisplay();
  const { x, y } = display.nativeScale;
  const scale = x === null || y === null ? 'Hidden viewport' : `${Math.round(x * 100)}% × ${Math.round(y * 100)}% native density`;
  const status = `${display.render.width} × ${display.render.height} render px · ${display.css.width.toFixed(1)} × ${display.css.height.toFixed(1)} CSS px · DPR ${display.devicePixelRatio} · ${scale}`;
  const output = element('resolution-status');
  if (output.textContent !== status) output.textContent = status;
}
function syncFitViewport() {
  const previousError = viewportError;
  try {
    if (!fixedViewport) {
      const size = fittedViewport();
      // Re-submit the desired size even if it matches the current canvas: it may
      // cancel a different resize queued behind an in-flight settings/capture fence.
      if (size) runtime.resize(size.width, size.height);
    }
    viewportError = null;
  } catch (error) {
    // An impossible fit rejects before changing the healthy camera. Observer
    // callbacks must report it in the UI, not escape as an uncaught page error.
    viewportError = error instanceof Error ? error.message : String(error);
  }
  if (viewportError !== previousError) update();
  else updateDisplayStatus();
}

async function run(action: () => unknown | Promise<unknown>) {
  actionError = null;
  try { await action(); }
  catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) actionError = error instanceof Error ? error.message : String(error); }
  update();
}
async function selectModel(id: string) {
  const model = assets.find(asset => asset.id === id);
  if (!model) throw new Error('Unknown gallery model ID.');
  await runtime.selectModel(model);
  return runtime.getState();
}

sceneSelect.addEventListener('change', () => run(() => runtime.setScenePreset(sceneSelect.value as ScenePreset)), { signal: events.signal });
lightSelect.addEventListener('change', () => run(() => runtime.setLightingPreset(lightSelect.value as LightingPreset)), { signal: events.signal });
debugSelect.addEventListener('change', () => run(() => runtime.setDebugView(debugSelect.value as DebugView)), { signal: events.signal });
temporalToggle.addEventListener('change', () => run(() => runtime.setTemporal(temporalToggle.checked)), { signal: events.signal });
resolutionSelect.addEventListener('change', () => run(async () => {
  if (resolutionSelect.value === 'fit') {
    fixedViewport = false;
    element('viewport-wrap').removeAttribute('style');
    const size = fittedViewport();
    if (size) await runtime.setViewport(size.width, size.height);
    viewportError = null;
  } else {
    const [width, height] = resolutionSelect.value.split('x').map(Number);
    await setViewport(width!, height!);
  }
}), { signal: events.signal });
element('reset-camera').addEventListener('click', () => run(() => runtime.resetCamera()), { signal: events.signal });
liveButton.addEventListener('click', () => run(() => runtime.setLive(!runtime.getState().live)), { signal: events.signal });
element('render-frame').addEventListener('click', () => run(() => runtime.renderFrames()), { signal: events.signal });
clipSelect.addEventListener('change', () => run(() => runtime.setAnimation({ clipId: clipSelect.value || null, timeSeconds: 0, playing: false })), { signal: events.signal });
playButton.addEventListener('click', () => run(() => runtime.setAnimation({ playing: !runtime.getState().settings.animation.playing })), { signal: events.signal });
loopToggle.addEventListener('change', () => run(() => runtime.setAnimation({ loop: loopToggle.checked })), { signal: events.signal });
timeline.addEventListener('pointerdown', () => { scrubbing = true; }, { signal: events.signal });
timeline.addEventListener('input', () => { scrubbing = true; element<HTMLOutputElement>('animation-time-label').value = `${Number(timeline.value).toFixed(2)} / ${Number(timeline.max).toFixed(2)} s`; }, { signal: events.signal });
timeline.addEventListener('change', () => { const timeSeconds = Number(timeline.value); scrubbing = false; void run(() => runtime.setAnimation({ timeSeconds, playing: false })); }, { signal: events.signal });
for (const event of ['pointercancel', 'blur']) timeline.addEventListener(event, () => { scrubbing = false; update(); }, { signal: events.signal });

let pointer: { id: number; x: number; y: number } | null = null;
let queuedOrbit: Partial<GalleryOrbit> | null = null;
let orbitInFlight = false;
async function applyQueuedOrbit() {
  if (orbitInFlight || !queuedOrbit) return;
  orbitInFlight = true;
  const orbit = queuedOrbit;
  queuedOrbit = null;
  await run(() => runtime.setOrbit(orbit));
  orbitInFlight = false;
  if (queuedOrbit) void applyQueuedOrbit();
}
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || runtime.getState().phase !== 'ready') return;
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
}, { signal: events.signal });
canvas.addEventListener('pointermove', event => {
  if (!pointer || pointer.id !== event.pointerId) return;
  const orbit = { ...runtime.getState().settings.orbit, ...queuedOrbit };
  queuedOrbit = { ...orbit, azimuth: orbit.azimuth - (event.clientX - pointer.x) * 0.008, elevation: orbit.elevation + (event.clientY - pointer.y) * 0.008 };
  pointer.x = event.clientX; pointer.y = event.clientY;
  void applyQueuedOrbit();
}, { signal: events.signal });
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, () => { pointer = null; }, { signal: events.signal });
canvas.addEventListener('wheel', event => {
  if (runtime.getState().phase !== 'ready') return;
  event.preventDefault();
  const orbit = { ...runtime.getState().settings.orbit, ...queuedOrbit };
  queuedOrbit = { ...orbit, distance: orbit.distance * Math.exp(Math.max(-500, Math.min(500, event.deltaY)) * 0.001) };
  void applyQueuedOrbit();
}, { passive: false, signal: events.signal });
canvas.addEventListener('keydown', event => {
  const orbit = runtime.getState().settings.orbit;
  const changes: Record<string, Partial<GalleryOrbit>> = { ArrowLeft: { azimuth: orbit.azimuth - 0.1 }, ArrowRight: { azimuth: orbit.azimuth + 0.1 }, ArrowUp: { elevation: orbit.elevation + 0.1 }, ArrowDown: { elevation: orbit.elevation - 0.1 }, '+': { distance: orbit.distance * 0.9 }, '-': { distance: orbit.distance * 1.1 } };
  const change = changes[event.key];
  if (change) { event.preventDefault(); void run(() => runtime.setOrbit(change)); }
}, { signal: events.signal });

const resize = new ResizeObserver(syncFitViewport);
resize.observe(canvas);
watchDisplayDensity(window, syncFitViewport, events.signal);
document.addEventListener('visibilitychange', () => runtime.visibilityChanged(), { signal: events.signal });
const healthRefresh = setInterval(update, 500);
function dispose() { events.abort(); resize.disconnect(); clearInterval(healthRefresh); queuedOrbit = null; runtime.dispose(); }
window.addEventListener('pagehide', dispose, { once: true });
async function setViewport(width: number, height: number) {
  const previous = fixedViewport;
  fixedViewport = true;
  try {
    const state = await runtime.setViewport(width, height);
    viewportError = null;
    const style = element('viewport-wrap').style;
    style.boxSizing = 'content-box';
    style.width = `${width}px`; style.maxWidth = '100%'; style.height = 'auto';
    style.minHeight = '0'; style.maxHeight = 'none'; style.aspectRatio = `${width} / ${height}`;
    const value = `${width}x${height}`;
    if (!Array.from(resolutionSelect.options).some(option => option.value === value)) {
      const option = document.createElement('option'); option.value = value; option.textContent = `${width} × ${height}`; resolutionSelect.append(option);
    }
    resolutionSelect.value = value;
    updateDisplayStatus();
    return state;
  } catch (error) { fixedViewport = previous; throw error; }
}

const api = {
  getState: () => runtime.getState(),
  getDisplay,
  getCatalog: () => structuredClone(catalog),
  selectModel,
  setScenePreset: (id: ScenePreset) => runtime.setScenePreset(id),
  setLightingPreset: (id: LightingPreset) => runtime.setLightingPreset(id),
  setDebugView: (id: DebugView) => runtime.setDebugView(id),
  setTemporal: (enabled: boolean) => runtime.setTemporal(enabled),
  setOrbit: (orbit: Partial<GalleryOrbit>) => runtime.setOrbit(orbit),
  resetCamera: () => runtime.resetCamera(),
  setAnimation: (animation: Partial<GalleryAnimation>) => runtime.setAnimation(animation),
  setLive: (live: boolean) => runtime.setLive(live),
  setViewport,
  renderFrames: (count?: number) => runtime.renderFrames(count),
  captureState: (frames?: number) => runtime.captureState(frames),
  dispose,
};
Object.defineProperty(window, 'strataGallery', { value: Object.freeze(api), configurable: false, writable: false });
declare global { interface Window { readonly strataGallery: typeof api; } }

void run(async () => {
  try { catalog = await loadGalleryCatalog(events.signal); }
  catch (error) { modelList.replaceChildren(paragraph(error instanceof Error ? error.message : String(error))); runtime.reportFailure(error); throw error; }
  assets = orderedGalleryAssets(catalog);
  showCatalog();
  await runtime.initialize();
  syncFitViewport();
  const initial = assets.find(asset => asset.entryUrl !== null && asset.unavailableReason === null);
  if (initial) await selectModel(initial.id);
});
