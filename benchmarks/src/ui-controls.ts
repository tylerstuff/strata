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
    const gi = renderer.value === 'gi';
    document.querySelector<HTMLElement>('#gi-controls')!.hidden = !gi;
    document.querySelector<HTMLElement>('#geometry')!.hidden = renderer.value !== 'virtual';
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
    document.querySelector<HTMLElement>('#gi-scenario-note')!.textContent = options.giScenario === 'static'
      ? 'The door stays open and the light stays fixed.'
      : 'A 60-second cycle closes and reopens the door, dims and restores the light, then changes the wall color.';
  };
  for (const control of [renderer, enabled, select('#gi-scenario'), select('#gi-probes'), select('#gi-rays')]) control.addEventListener('change', sync);
  sync();
}
