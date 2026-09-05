/**
 * Internal orchestration seam. Scene, view, commit and metrics types belong to the
 * runtime adapter; this protocol deliberately does not define a runtime schema.
 * All returned data must be detached strict JSON. No background frames may run.
 */
export interface PreparedPreviewLoad<Scene, View> {
  scene: Scene;
  view: View;
  sceneId: string;
  /** The adapter verifies this against canonical authoring document bytes. */
  sourceRevision: string;
}

export interface PreviewDriverObservation<Commit> {
  /** ready asserts an initialized driver with no observed GPU or browser errors. */
  status: 'ready' | 'lost' | 'disposed' | 'failed';
  commit: Commit | null;
  width: number;
  height: number;
  lastSubmittedFrameId: number | null;
  telemetry: unknown;
  environment: unknown;
  /** Adapter-normalized samples, tagged with their actual submitted frame ID. */
  gpuSamples?: readonly { frameId: number; sample: unknown }[];
  /** Why timing is disabled, unavailable, delayed, or incomplete, when known. */
  gpuTimingUnavailableReason?: string;
}

export interface PreviewDriverFrame<Commit, Frame> {
  commit: Commit;
  frameId: number;
  width: number;
  height: number;
  /** Complete effective camera, light, settings, time and physical viewport. */
  resolvedView: unknown;
  metrics: Frame;
}

export interface PreviewDriver<Scene, View, Commit, Frame> {
  /** Validate and detach synchronously, before a valid pending load is superseded. */
  prepareLoad(input: unknown): PreparedPreviewLoad<Scene, View>;
  observe(): Promise<PreviewDriverObservation<Commit>>;
  setScene(scene: Scene, signal: AbortSignal): Promise<Commit>;
  render(view: View, signal: AbortSignal): Promise<PreviewDriverFrame<Commit, Frame>>;
  resize(width: number, height: number, signal: AbortSignal): Promise<void>;
  waitForIdle(signal: AbortSignal): Promise<void>;
  screenshot(signal: AbortSignal): Promise<Uint8Array>;
  /** Must interrupt browser/runtime work and release all resources it owns. */
  dispose(): Promise<void>;
  /** Extract only an explicit historical receipt attached by Core after a commit. */
  committedReceipt?(error: unknown): Commit | undefined;
}
