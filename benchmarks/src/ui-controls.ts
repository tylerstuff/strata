import type { BenchmarkOptions } from './metrics.js';

type GiOptions = Pick<BenchmarkOptions, 'giEnabled' | 'cameraMode' | 'giScenario' | 'probesPerUpdate' | 'raysPerProbe'>;
const select = (id: string): HTMLSelectElement => document.querySelector<HTMLSelectElement>(id)!;

/** Read only when the selected renderer is GI; other renderers retain their own camera defaults. */
export function readGiBenchmarkControls(): GiOptions {
  return {
    giEnabled: document.querySelector<HTMLInputElement>('#gi-enabled')!.checked,
    cameraMode: select('#gi-camera').value as GiOptions['cameraMode'],
    giScenario: select('#gi-scenario').value as GiOptions['giScenario'],
    probesPerUpdate: Number(select('#gi-probes').value),
    raysPerProbe: Number(select('#gi-rays').value),
  };
}

/** Keep the visible controls and supported debug views aligned with the selected scene. */
export function initializeBenchmarkControls(): void {
  const renderer = select('#renderer'); const debug = select('#debug');
  const enabled = document.querySelector<HTMLInputElement>('#gi-enabled')!;
  const sync = (): void => {
    const integrated = renderer.value === 'integrated';
    const reflections = renderer.value === 'reflections' || integrated;
    const gi = renderer.value === 'gi' || reflections;
    document.querySelector<HTMLElement>('#reflection-controls')!.hidden = !reflections;
    document.querySelector<HTMLElement>('#gi-controls')!.hidden = !gi;
    document.querySelector<HTMLElement>('#geometry')!.hidden = renderer.value !== 'virtual' && !integrated;
    document.querySelector<HTMLElement>('#trace-proxy-control')!.hidden = !integrated;
    document.querySelector<HTMLElement>('#integrated-geometry-note')!.hidden = !integrated;
    for (const option of select('#gi-scenario').options) option.disabled = integrated ? option.value !== 'integrated-tour' : option.value === 'integrated-tour';
    select('#gi-scenario').disabled = integrated;
    select('#gi-camera').querySelector<HTMLOptionElement>('[value="terrain-witness"]')!.disabled = !integrated;
    document.querySelector<HTMLInputElement>('#temporal')!.disabled = renderer.value === 'diffuse';
    for (const group of debug.querySelectorAll<HTMLOptGroupElement>('optgroup[data-renderers]')) {
      group.disabled = !group.dataset.renderers!.split(' ').includes(renderer.value);
      group.hidden = group.disabled;
    }
    const selected = debug.selectedOptions[0];
    if (selected?.disabled || selected?.parentElement instanceof HTMLOptGroupElement && selected.parentElement.disabled) debug.value = 'final';
    const options = readGiBenchmarkControls();
    const rays = options.probesPerUpdate * options.raysPerProbe;
    document.querySelector<HTMLElement>('#gi-budget-note')!.textContent = enabled.checked
      ? `${rays.toLocaleString()} primary rays and up to ${rays.toLocaleString()} shadow rays per frame. A complete probe sweep takes ${Math.ceil(384 / options.probesPerUpdate)} frames.`
      : 'GI is off. The scene uses direct lighting and probe updates are paused.';
    document.querySelector<HTMLElement>('#gi-scenario-note')!.textContent = integrated
      ? 'A fixed 60-second courtyard cycle moves the object, closes and opens the door, turns the light off and on, and tours streamed terrain.'
      : options.giScenario === 'static'
      ? 'The door stays open and the light stays fixed.'
      : 'A 60-second cycle closes and reopens the door, dims and restores the light, then changes the wall color.';
  };
  renderer.addEventListener('change', () => {
    if (renderer.value === 'reflections') { select('#gi-camera').value = 'receiver'; select('#gi-scenario').value = 'static'; }
    else if (renderer.value === 'integrated') {
      select('#gi-camera').value = 'tour'; select('#gi-scenario').value = 'integrated-tour';
      const manifest = document.querySelector<HTMLInputElement>('#manifest')!;
      if (manifest.value === '/external-assets/terrain-v1-s1337-t8-c128/manifest.json') manifest.value = '/external-assets/integrated-courtyard-v1-s1337-t4-c64/manifest.json';
    } else {
      if (select('#gi-camera').value === 'terrain-witness') select('#gi-camera').value = 'overview';
      if (select('#gi-scenario').value === 'integrated-tour') select('#gi-scenario').value = 'door-light';
    }
  });
  for (const control of [renderer, enabled, select('#gi-scenario'), select('#gi-probes'), select('#gi-rays')]) control.addEventListener('change', sync);
  sync();
}

export function readReflectionBenchmarkControls(): Pick<BenchmarkOptions, 'reflectionMode' | 'reflectionResolutionScale' | 'reflectionMaxRays' | 'reflectionRoughness' | 'reflectionMaxDistance' | 'reflectionUpdateEvery'> {
  return { reflectionMode: select('#reflection-mode').value as BenchmarkOptions['reflectionMode'],
    reflectionResolutionScale: Number(select('#reflection-scale').value) as BenchmarkOptions['reflectionResolutionScale'],
    reflectionMaxRays: Number(select('#reflection-rays').value), reflectionRoughness: Number(select('#reflection-roughness').value),
    reflectionMaxDistance: Number(select('#reflection-distance').value), reflectionUpdateEvery: Number(select('#reflection-update').value) };
}
