import { StrataError } from '../errors.js';
import { RasterRenderer, normalizeRasterControls } from '../rendering/raster-renderer.js';
import type { CameraFrame } from '../rendering/raster-math.js';
import type { RasterControls, RasterOutputs, RasterPassName, RasterTimestamps } from '../rendering/raster-types.js';
import type { SceneFrameStats } from '../rendering/scene-renderer.js';
import { ImportedGeometry } from './imported-geometry.js';
import type { ImportedAsset, ImportedControls, ImportedSceneOptions, ImportedTelemetry } from './imported-types.js';
import type { CpuRuntime } from '../internal/cpu-runtime.js';
import type { ImportedIndirectEffect } from './imported-indirect-effect.js';
import type { ImportedIndirectProgress, ImportedIndirectReadback } from './imported-indirect-types.js';

type Controls = RasterControls & { imported?: ImportedControls };
interface CreationContext { readonly cpu: CpuRuntime; readonly width: number; readonly height: number; readonly additionalResidentCpuBytes: number; }
type TraceSummary = Pick<NonNullable<ImportedTelemetry['indirect']>, 'estimatedPeakCpuBytes' | 'preparedTraceGpuBytes'>;
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new StrataError('SCENE_LOAD_ABORTED', 'Imported scene creation was cancelled.'); }
function retainedAssetBytes(asset: ImportedAsset): number {
  const buffers = new Set<ArrayBufferLike>();
  const add = (value?: ArrayBufferView): void => { if (value) buffers.add(value.buffer); };
  for (const p of asset.primitives) { add(p.vertices); add(p.indices); add(p.deformation?.vertices); add(p.deformation?.joints); add(p.deformation?.weights); }
  for (const image of asset.images) add(image.bytes);
  for (const clip of asset.clips) for (const channel of clip.channels) { add(channel.times); add(channel.values); }
  for (const node of asset.rig?.nodes ?? []) add(node.matrix);
  for (const skin of asset.rig?.skins ?? []) add(skin.inverseBindMatrices);
  return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
}
function incident(lighting: NonNullable<ImportedControls['lighting']>) {
  const env = lighting.environment;
  return env ? { mode: env.preset, intensity: env.intensity, rotationRadians: env.rotationRadians ?? 0 }
    : { mode: 'off' as const, intensity: 0, rotationRadians: 0 };
}

/** Optional conventional imported meshes in Strata's PBR/shadow/MRT/temporal pipeline. */
export class ImportedRenderer {
  private forceReset = true;
  private disposed = false;
  private counters: ImportedIndirectReadback | null = null;
  private counterReadback: Promise<void> | undefined;
  private indirectGpuFault: StrataError | undefined;
  private constructor(private readonly raster: RasterRenderer, private readonly geometry: ImportedGeometry,
    readonly retainedCpuBytes: number, private readonly indirect?: ImportedIndirectEffect, private readonly traceSummary?: TraceSummary) {}
  static async create(device: GPUDevice, format: GPUTextureFormat, options: ImportedSceneOptions, context?: CreationContext): Promise<ImportedRenderer> {
    if (!options || options.renderer !== 'imported') throw new StrataError('INVALID_OPTIONS', 'Imported rendering requires a decoded glTF asset.');
    checkAbort(options.signal);
    // Preparation and shaders remain in optional chunks and are loaded only for explicit progressive scenes.
    let prepared: Awaited<ReturnType<typeof import('./static-trace-data.js')['prepareImportedStaticTrace']>> | undefined;
    let result: Awaited<ReturnType<CpuRuntime['buildStaticBvh']>> | undefined;
    let effectModule: typeof import('./imported-indirect-effect.js') | undefined;
    let spatialDenoise = false;
    let indirectOptions: ReturnType<typeof import('./imported-indirect-options.js')['normalizeImportedIndirectOptions']> | undefined;
    if (options.indirect !== undefined) {
      if (!context) throw new StrataError('INVALID_OPTIONS', 'Progressive imported lighting requires the engine CPU runtime and viewport.');
      const preflight = await import('./imported-indirect-options.js'); checkAbort(options.signal);
      indirectOptions = preflight.normalizeImportedIndirectOptions(options.indirect);
      preflight.validateImportedIndirectSize(device.limits, context.width, context.height, indirectOptions);
      spatialDenoise = preflight.normalizeImportedSpatialDenoise(options.indirect);
      preflight.validateImportedIndirectCapability(device.limits, context.width, context.height, spatialDenoise);
      const source = await import('./static-trace-data.js'); checkAbort(options.signal);
      await context.cpu.waitForStaticBvhIdle(); checkAbort(options.signal);
      prepared = await source.prepareImportedStaticTrace(options.asset, device.limits, {
        retainedWasmBytes: context.cpu.info.memoryBytes, additionalResidentCpuBytes: context.additionalResidentCpuBytes,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      result = await context.cpu.buildStaticBvh({ positions: prepared.positions, indices: prepared.indices }, {
        maxWorkingBytes: prepared.maxWorkingBytes, ...(options.signal ? { signal: options.signal } : {}),
      });
      await source.validateImportedStaticBvh(prepared, result, options.signal); checkAbort(options.signal);
      effectModule = await import('./imported-indirect-effect.js'); checkAbort(options.signal);
    }
    const geometry = await ImportedGeometry.create(device, options.asset, options.signal);
    let raster: RasterRenderer | undefined;
    let indirect: ImportedIndirectEffect | undefined;
    try {
      checkAbort(options.signal);
      if (prepared && result && effectModule && indirectOptions) {
        const lighting = geometry.lighting;
        // Shared-primary attribute admission runs inside effect creation before
        // any indirect allocation/upload. A rejection retires this already-owned
        // common geometry below, including its borrowed texture resources.
        indirect = await effectModule.ImportedIndirectEffect.create(device, {
          source: { nodes: new Uint8Array(result.nodes), triangles: new Uint8Array(result.triangles), vertices: prepared.vertices, indices: prepared.indices },
          material: geometry.borrowIndirectMaterial(prepared.sourceMaterialIndex), lighting, environment: incident(lighting), options: { ...indirectOptions, spatialDenoise },
          ...(options.signal ? { signal: options.signal } : {}),
        });
        geometry.useIndirectBaseline();
      }
      raster = await RasterRenderer.create(device, format, {}, geometry, indirect);
      checkAbort(options.signal);
      return new ImportedRenderer(raster, geometry, retainedAssetBytes(options.asset), indirect, prepared ? {
        estimatedPeakCpuBytes: prepared.estimatedPeakCpuBytes, preparedTraceGpuBytes: prepared.traceGpuBytes,
      } : undefined);
    } catch (cause) { if (raster) raster.dispose(); else { indirect?.dispose(); geometry.dispose(); } throw cause; }
  }
  get initialUploadBytes(): number { return this.raster.initialUploadBytes; }
  get gpuBufferBytes(): number { return this.raster.gpuBufferBytes; }
  get gpuTextureBytes(): number { return this.raster.gpuTextureBytes; }
  get importedTelemetry(): ImportedTelemetry {
    const base = this.geometry.telemetry;
    if (!this.indirect || !this.traceSummary) return base;
    const progress = this.indirect.progress;
    return { ...base, indirect: { mode: 'progressive-diffuse', temporal: false, rasterAmbient: 'disabled', rasterEnvironment: 'disabled',
      progress, sampleCounters: this.counters && this.matchesReadback(this.counters, progress) ? this.counters : null, ...this.traceSummary } };
  }
  get outputs(): RasterOutputs | undefined { return this.raster.outputs; }
  get directTexture(): GPUTexture | undefined { return this.raster.directTexture; }
  get currentCamera(): CameraFrame | undefined { return this.geometry.currentCamera; }
  get hasIndirect(): boolean { return this.indirect !== undefined; }
  get hasSharedPrimary(): boolean { return this.indirect?.hasSharedPrimary === true; }
  /** Fault all queued descendants; in-flight work cannot be rolled back. */
  faultIndirectEpoch(cause: unknown): void {
    if (this.disposed || !this.hasSharedPrimary || this.indirectGpuFault) return;
    this.indirectGpuFault = cause instanceof StrataError ? cause : new StrataError('GPU_VALIDATION_FAILED', 'Shared primary epoch is faulted; recreate the engine.', { cause });
    this.counters = null; this.indirect!.faultGpuEpoch(this.indirectGpuFault);
  }
  validateSize(width: number, height: number): void { this.indirect?.validateSize(width, height); }
  async readIndirectProgress(): Promise<void> {
    if (this.indirectGpuFault) throw this.indirectGpuFault;
    // An earlier idle request may have copied frame A before this caller fenced
    // frame B. Join A, then obtain B's header rather than accepting stale data.
    if (this.counterReadback) await this.counterReadback;
    if (this.disposed || !this.indirect) return;
    if (this.indirectGpuFault) throw this.indirectGpuFault;
    const effect = this.indirect, progress = effect.progress;
    if (progress.pendingReset || progress.pendingFrame || !progress.submittedFrames) return;
    if (!this.counters || !this.matchesReadback(this.counters, progress)) {
      if (!this.counterReadback) {
        const operation = effect.readProgress().then(counters => {
          if (!this.disposed && this.matchesReadback(counters, effect.progress)) this.counters = counters;
        }, cause => {
          // Retirement must not report the replacement engine as disposed.
          if (!this.disposed && (!this.hasSharedPrimary || this.indirectGpuFault || this.matchesReadback(progress, effect.progress))) throw cause;
        });
        const pending = operation.finally(() => { if (this.counterReadback === pending) this.counterReadback = undefined; });
        this.counterReadback = pending;
      }
      await this.counterReadback;
    }
    if (!this.disposed && this.indirectGpuFault) throw this.indirectGpuFault;
    // Only a currently matching result may reject. A completed older promise
    // never carries a presentation fault into a later frame or display mode.
    if (!this.disposed && this.counters && this.matchesReadback(this.counters, effect.progress)
      && this.counters.spatialDiagnostics?.hdrFaultChannels) {
      throw new StrataError('PRESENTATION_HDR_FAULT', 'Imported indirect composition exceeds the explicit spatial capability HDR domain [0, 65472]; inspect spatialDiagnostics.hdrFaultChannels. Raw transport is unchanged.');
    }
  }
  private matchesReadback(readback: ImportedIndirectProgress, progress: ImportedIndirectProgress): boolean {
    return !progress.pendingReset && !progress.pendingFrame && readback.revision === progress.revision
      && readback.submittedFrameId === progress.submittedFrameId && readback.presentationRevision === progress.presentationRevision
      && readback.denoise === progress.denoise && !this.indirectGpuFault
      && readback.primary?.generation === progress.primary?.generation && progress.primary?.state !== 'faulted' && progress.primary?.state !== 'disposed';
  }
  private configure(controls: Controls): Controls {
    normalizeRasterControls(controls);
    const input = controls.imported;
    if (input?.indirect !== undefined && (!input.indirect || typeof input.indirect !== 'object' || Array.isArray(input.indirect) || typeof input.indirect.enabled !== 'boolean')) {
      throw new StrataError('INVALID_OPTIONS', 'Imported indirect controls require a boolean enabled.');
    }
    if (!this.indirect && input?.indirect !== undefined) throw new StrataError('UNSUPPORTED_FEATURE', 'Create the imported scene with indirect options before enabling progressive lighting.');
    if (input?.indirect?.denoise !== undefined) this.indirect!.validateDenoise(input.indirect.denoise);
    if (this.indirect && input?.presentation === 'ground') throw new StrataError('UNSUPPORTED_FEATURE', 'Progressive imported lighting traces the model only; ground participation is unsupported.');
    if (this.indirect && input?.transforms !== undefined) throw new StrataError('UNSUPPORTED_FEATURE', 'Static progressive tracing does not support dynamic mesh transforms.');
    const reset = this.geometry.update(input); this.forceReset = this.forceReset || reset;
    if (this.indirect) {
      const lighting = this.geometry.lighting;
      this.indirect.updateLighting(lighting, incident(lighting));
      if (input?.indirect) {
        if (input.indirect.denoise !== undefined) this.indirect.setDenoise(input.indirect.denoise);
        this.indirect.setEnabled(input.indirect.enabled);
      }
      return { ...controls, temporal: false };
    }
    return controls;
  }
  passNames(controls: Controls = {}): readonly RasterPassName[] { return this.raster.passNames(this.configure(controls)); }
  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number, timeSeconds: number,
    controls: Controls = {}, timestamps: RasterTimestamps = {}): SceneFrameStats {
    if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'Imported renderer is disposed.');
    try {
      this.validateSize(width, height);
      const effective = this.configure(controls);
      return this.raster.encode(encoder, target, width, height, timeSeconds, { ...effective, cameraCut: Boolean(controls.cameraCut || this.forceReset) }, timestamps);
    }
    catch (cause) { this.cancelFrame(); throw cause; }
  }
  submitted(frameId: number): void { this.indirect?.submitted(frameId); this.geometry.submitted(); this.forceReset = false; }
  cancelFrame(): void { this.indirect?.cancelFrame(); this.geometry.cancelFrame(); this.forceReset = true; }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.raster.dispose(); }
}
