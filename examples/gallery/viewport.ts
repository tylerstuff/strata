export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

/** Fit CSS content dimensions to physical display pixels, with one shared scale. */
export function fitViewportSize(cssWidth: number, cssHeight: number, devicePixelRatio: number, maximumDimension: number): ViewportSize | null {
  if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || cssWidth <= 0 || cssHeight <= 0) return null;
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0 || !Number.isInteger(maximumDimension) || maximumDimension < 1) {
    throw new Error('Viewport density and device dimensions must be positive and finite.');
  }
  // Clamp the scale before multiplying, so large layouts retain their aspect
  // rather than independently clipping their physical width and height.
  const scale = Math.min(devicePixelRatio, maximumDimension / cssWidth, maximumDimension / cssHeight);
  return {
    width: Math.max(1, Math.min(maximumDimension, Math.round(cssWidth * scale))),
    height: Math.max(1, Math.min(maximumDimension, Math.round(cssHeight * scale))),
  };
}

type DensitySource = Pick<Window, 'devicePixelRatio' | 'matchMedia' | 'addEventListener'>;

/** CSS size need not change when zoom or a display move changes pixel density. */
export function watchDisplayDensity(source: DensitySource, changed: () => void, signal: AbortSignal): void {
  if (signal.aborted) return;
  let query: MediaQueryList;
  function listen() {
    query?.removeEventListener('change', refresh);
    query = source.matchMedia(`(resolution: ${source.devicePixelRatio}dppx)`);
    query.addEventListener('change', refresh);
  }
  function refresh() {
    if (signal.aborted) return;
    listen();
    changed();
  }
  listen();
  source.addEventListener('resize', refresh, { signal });
  signal.addEventListener('abort', () => query.removeEventListener('change', refresh), { once: true });
}
