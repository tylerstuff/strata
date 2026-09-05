import { loadGalleryCatalog, orderedGalleryAssets, type GalleryAsset, type GalleryCatalog } from './catalog.js';
import { GalleryRuntime, debugViews, lightingPresets, scenePresets, type DebugView, type GalleryAnimation, type GalleryEnvironment, type GallerySceneMode, type GalleryShading, type GalleryTextureCap, type LightingPreset, type ScenePreset } from './runtime.js';
import type { GalleryOrbit } from './orbit.js';
import { fitViewportSize, watchDisplayDensity } from './viewport.js';
import { describeProgressiveCounters } from './progressive-status.js';

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
const shadingSelect = element<HTMLSelectElement>('material-shading');
const environmentSelect = element<HTMLSelectElement>('environment-preset');
const environmentIntensity = element<HTMLInputElement>('environment-intensity');
const environmentRotation = element<HTMLInputElement>('environment-rotation');
const textureSelect = element<HTMLSelectElement>('texture-cap');
const exposureInput = element<HTMLInputElement>('exposure-ev');
const exposureReset = element<HTMLButtonElement>('reset-exposure');
const progressiveButton = element<HTMLButtonElement>('progressive-mode');
const indirectToggle = element<HTMLInputElement>('indirect-enabled');
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
let shownDetailsSignature = '';
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
  const progressive = state.settings.sceneMode === 'progressive';
  const known = state.asset !== null && state.modelId === selected?.id ? state.asset : null;
  element('model-title').textContent = selected?.title ?? 'Model gallery';
  element('model-subtitle').textContent = selected ? `${selected.category} · Local glTF` : 'Select a local model to begin.';
  element('connection-status').textContent = ({ initializing: 'Starting Strata', empty: 'Strata ready', loading: 'Loading model', ready: progressive ? state.live ? state.settings.indirectEnabled ? 'Accumulating preview' : 'Direct reference · live' : 'Preview · paused' : state.live ? 'Live view' : 'Ready · paused', unsupported: 'Unsupported', error: 'Needs attention', disposed: 'Disposed' } satisfies Record<typeof state.phase, string>)[state.phase];
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
  sceneSelect.disabled = !ready || progressive;
  temporalToggle.disabled = !ready || progressive;
  temporalToggle.checked = state.settings.temporal;
  for (const option of resolutionSelect.options) {
    const [width, height] = option.value.split('x').map(Number);
    option.disabled = progressive && (option.value === 'fit' || !width || !height || width * height > state.progressive.maxPixels);
  }
  for (const control of [shadingSelect, environmentSelect, textureSelect]) control.disabled = !ready;
  shadingSelect.value = state.settings.shading;
  environmentSelect.value = state.settings.environment.preset;
  textureSelect.value = String(state.settings.textureCap);
  const environment = state.settings.environment;
  element('environment-label').textContent = progressive ? 'Incident environment' : 'Distant environment';
  element('environment-controls').hidden = environment.preset === 'off';
  environmentIntensity.disabled = !ready || environment.preset === 'off';
  environmentRotation.disabled = !ready || environment.preset === 'off';
  // Preserve an in-progress numeric edit during live telemetry updates.
  if (document.activeElement !== environmentIntensity) environmentIntensity.value = String(environment.intensity);
  if (document.activeElement !== environmentRotation) environmentRotation.value = String(Number((environment.rotationRadians * 180 / Math.PI).toFixed(2)));
  exposureInput.disabled = !ready;
  exposureReset.disabled = !ready || state.settings.exposureEV === 0;
  if (document.activeElement !== exposureInput) exposureInput.value = String(state.settings.exposureEV);
  element('quality-status').textContent = [
    state.settings.shading === 'relit' ? 'Unlit materials use a matte interpretation; source PBR materials retain their settings.' : 'Source-authored materials. Unlit materials ignore lighting.',
    environment.preset === 'off' ? 'Environment off.' : environment.intensity === 0 ? 'Environment intensity is zero.' : progressive ? state.settings.indirectEnabled ? 'The incident environment supplies visibility-tested diffuse transport.' : 'The incident environment is retained but inactive in this direct reference.' : 'The distant environment adds illumination without scene occlusion.',
  ].join(' ');
  progressiveButton.disabled = !ready || (!progressive && (!fixedViewport || !state.progressive.eligibility.eligible));
  progressiveButton.textContent = progressive ? 'Return to ordinary rendering' : 'Start progressive preview';
  progressiveButton.setAttribute('aria-pressed', String(progressive));
  indirectToggle.disabled = !ready || !progressive;
  indirectToggle.checked = state.settings.indirectEnabled;
  element('progressive-mode-label').textContent = progressive ? state.settings.indirectEnabled ? '· indirect included' : '· direct reference' : '· off';
  element('progressive-guidance').textContent = progressive
    ? `${state.viewport.width} × ${state.viewport.height} physical px. Both comparisons disable temporal AA, raster ambient and unoccluded environment lighting. ${state.settings.indirectEnabled ? 'Use Accumulate preview while stationary. Camera or light changes restart accumulation.' : 'The direct reference does not accumulate indirect samples. Re-enable indirect lighting to restart accumulation.'} Return to ordinary rendering to select another model or restore AA.`
    : [
      `Choose an explicit small render size, such as 640 × 360 or 320 × 180; maximum ${state.progressive.maxPixels.toLocaleString()} physical pixels. Fit and full HD are never reduced automatically.`,
      ...state.progressive.eligibility.reasons,
      ...(!fixedViewport ? ['Choose a fixed render size before starting the preview.'] : []),
    ].join(' ');
  element('progressive-diagnostics').hidden = !progressive;
  const counterView = describeProgressiveCounters(state.progressive.telemetry, {
    engineEpoch: state.engineEpoch, sceneGeneration: state.sceneCommit?.sceneGeneration ?? null, countersPending: state.progressive.countersPending,
  });
  for (const name of ['attempted', 'completed', 'exhausted', 'invalid'] as const) element(`progressive-${name}`).textContent = counterView.counts[name]?.toLocaleString() ?? '—';
  element('progressive-counter-identity').textContent = counterView.identity;
  element('progressive-counter-status').textContent = counterView.message;
  liveButton.textContent = progressive ? state.settings.indirectEnabled ? state.live ? 'Pause accumulation' : 'Accumulate preview' : state.live ? 'Pause direct reference' : 'Resume direct reference' : state.live ? 'Pause live view' : 'Resume live view';
  liveButton.setAttribute('aria-pressed', String(state.live));
  for (const button of modelList.querySelectorAll<HTMLButtonElement>('button[data-model-id]')) {
    button.setAttribute('aria-pressed', String(button.dataset.modelId === state.requestedModelId));
    button.disabled = state.phase === 'initializing' || state.phase === 'disposed' || state.busy !== null || (ready && progressive);
    button.title = ready && progressive ? 'Return to ordinary rendering before selecting another model.' : '';
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
  const decision = state.settings.textureDecision;
  const detailsSignature = JSON.stringify([selected?.id, selected?.category, selected?.triangles, selected?.textureMaxEdge, known?.stats, known?.maxTextureDimension, decision]);
  if (shownDetailsSignature !== detailsSignature) {
    shownDetailsSignature = detailsSignature;
    const wasOpen = details.querySelector<HTMLDetailsElement>('.allocation-details')?.open ?? false;
    details.replaceChildren();
    if (selected) {
      details.append(detail('Category', selected.category), detail('Source triangles', formatCount(selected.triangles)), detail('Source texture edge', selected.textureMaxEdge === null ? 'Unavailable' : `${selected.textureMaxEdge.toLocaleString()} px`));
      if (known) {
        details.append(detail('Loaded triangles', formatCount(known.stats.triangles)), detail('Runtime primitives', formatCount(known.stats.primitives)));
        if (decision?.status === 'ready') {
          const accepted = decision.attempts.at(-1)!;
          details.append(detail('Texture cap', `${decision.requestedCap.toLocaleString()} px requested · ${decision.effectiveCap.toLocaleString()} px effective`));
          details.append(detail('Texture payload', `${(accepted.gpuTextureBytes / 1048576).toFixed(2)} / ${(decision.budgetBytes / 1048576).toFixed(0)} MiB modeled`));
          if (decision.budgetFallback) details.append(paragraph(`The texture budget reduced the selected cap to ${decision.selectedCap.toLocaleString()} px.`));
          if (decision.deviceLimited) details.append(paragraph('The device texture limit constrains the effective cap.'));
          const allocation = document.createElement('details');
          allocation.className = 'allocation-details'; allocation.open = wasOpen;
          const summary = document.createElement('summary'); summary.textContent = 'Allocation details';
          const evidence = document.createElement('pre'); evidence.textContent = JSON.stringify(decision, null, 2);
          allocation.append(summary, paragraph('Imported texture payload only; excludes frame targets, buffers, driver memory and overlapping scene allocations.'), evidence);
          details.append(allocation);
        } else details.append(detail('Texture upload cap', `${known.maxTextureDimension.toLocaleString()} px`));
      } else details.append(paragraph('Runtime support and loaded counts are established after a successful import.'));
    } else details.append(paragraph('Select a model to view its details.'));
  }
  const limitations = element('limitations');
  limitations.replaceChildren();
  const notes = new Set([
    'Texture caps are preflighted against the shared Core budget. Model details report the requested and effective caps; source images remain unchanged.',
    progressive
      ? 'Static progressive preview uses geometric normals and source textures at LOD zero for bounded diffuse transport. Both indirect-on and direct-reference views disable temporal AA, raster ambient and unoccluded environment lighting. No specular bounces or extra diffuse surface bounces.'
      : 'Ordinary lighting combines a directional light, ambient fill and optional distant environment illumination. Ambient and environment have no scene visibility, GI, local reflections or interior occlusion.',
    ...(state.settings.scenePreset === 'ground' && (known?.clips.length ?? 0) > 0 ? ['Ground stays at the rest-pose level; animated poses can cross it. Use Model only to inspect the full pose.'] : []),
    ...(selected?.features.usedExtensions.includes('KHR_materials_unlit') ? [state.settings.shading === 'authored' ? 'Includes authored unlit materials, whose color ignores scene lighting. Relight unlit explicitly interprets them as matte materials.' : 'Source unlit materials are explicitly relit as matte dielectrics with geometric normals; this is an interpretation, not recovered source material.'] : []),
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
  clipSelect.disabled = !ready || progressive || clips.length === 0;
  clipSelect.value = animation.clipId ?? '';
  playButton.disabled = !ready || progressive || !activeClip;
  playButton.textContent = animation.playing ? 'Pause animation' : 'Play animation';
  playButton.setAttribute('aria-pressed', String(animation.playing));
  timeline.disabled = !ready || progressive || !activeClip;
  timeline.max = String(activeClip?.duration ?? 0);
  if (!scrubbing) timeline.value = String(animation.timeSeconds);
  element<HTMLOutputElement>('animation-time-label').value = `${(scrubbing ? Number(timeline.value) : animation.timeSeconds).toFixed(2)} / ${(activeClip?.duration ?? 0).toFixed(2)} s`;
  loopToggle.disabled = !ready || progressive || !activeClip;
  loopToggle.checked = animation.loop;
  element('animation-status').textContent = progressive ? 'Progressive diffuse preview supports static geometry only. Animation and ground are unavailable in this mode.' : known ? clips.length ? `${clips.length} runtime-supported clips. Authored motion; camera fit uses rest pose. Looping returns to the clip start.` : 'The runtime exposes no playable clips for this model.' : 'Animation support is reported by the runtime.';

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
shadingSelect.addEventListener('change', () => run(() => runtime.setShading(shadingSelect.value as GalleryShading)), { signal: events.signal });
environmentSelect.addEventListener('change', () => run(() => runtime.setEnvironment({ preset: environmentSelect.value as GalleryEnvironment['preset'] })), { signal: events.signal });
environmentIntensity.addEventListener('change', () => run(() => runtime.setEnvironment({ intensity: environmentIntensity.valueAsNumber })), { signal: events.signal });
environmentRotation.addEventListener('change', () => run(() => runtime.setEnvironment({ rotationRadians: environmentRotation.valueAsNumber * Math.PI / 180 })), { signal: events.signal });
for (const input of [environmentIntensity, environmentRotation]) input.addEventListener('blur', update, { signal: events.signal });
exposureInput.addEventListener('change', async () => {
  await run(() => runtime.setExposureEV(exposureInput.valueAsNumber));
  // Reconcile a rejected edit with the retained setting even while focused.
  exposureInput.value = String(runtime.getState().settings.exposureEV);
}, { signal: events.signal });
exposureInput.addEventListener('blur', update, { signal: events.signal });
exposureReset.addEventListener('click', () => run(() => runtime.setExposureEV(0)), { signal: events.signal });
textureSelect.addEventListener('change', () => run(() => runtime.setTextureCap(Number(textureSelect.value) as GalleryTextureCap)), { signal: events.signal });
progressiveButton.addEventListener('click', () => run(() => setSceneMode(runtime.getState().settings.sceneMode === 'progressive' ? 'ordinary' : 'progressive')), { signal: events.signal });
indirectToggle.addEventListener('change', () => run(() => runtime.setIndirectEnabled(indirectToggle.checked)), { signal: events.signal });
resolutionSelect.addEventListener('change', () => run(async () => {
  if (resolutionSelect.value === 'fit') {
    if (runtime.getState().settings.sceneMode === 'progressive') throw new Error('Return to ordinary rendering before choosing Fit viewport. The progressive preview requires an explicit bounded render size.');
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

async function setSceneMode(mode: GallerySceneMode) {
  if (mode === 'progressive' && !fixedViewport) throw new Error('Choose an explicit fixed render size, such as 640 × 360 or 320 × 180, before starting the progressive preview.');
  await runtime.setSceneMode(mode);
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
  setShading: (value: GalleryShading) => runtime.setShading(value),
  setEnvironment: (value: Partial<GalleryEnvironment>) => runtime.setEnvironment(value),
  setExposureEV: (value: number) => runtime.setExposureEV(value),
  setTextureCap: (value: GalleryTextureCap) => runtime.setTextureCap(value),
  setSceneMode,
  setIndirectEnabled: (enabled: boolean) => runtime.setIndirectEnabled(enabled),
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
