import { StrataError } from '../errors.js';
import { RasterRenderer, normalizeRasterControls } from '../rendering/raster-renderer.js';
import type { CameraFrame } from '../rendering/raster-math.js';
import type { RasterControls, RasterOutputs, RasterPassName, RasterTimestamps } from '../rendering/raster-types.js';
import type { SceneFrameStats } from '../rendering/scene-renderer.js';
import { ImportedGeometry } from './imported-geometry.js';
import type { ImportedControls, ImportedSceneOptions, ImportedTelemetry } from './imported-types.js';

type Controls = RasterControls & { imported?: ImportedControls };

/** Optional conventional imported meshes in Strata's PBR/shadow/MRT/temporal pipeline. */
export class ImportedRenderer {
  private forceReset = true;
  private disposed = false;
  private constructor(private readonly raster: RasterRenderer, private readonly geometry: ImportedGeometry) {}
  static async create(device: GPUDevice, format: GPUTextureFormat, options: ImportedSceneOptions): Promise<ImportedRenderer> {
    if (!options || options.renderer !== 'imported') throw new StrataError('INVALID_OPTIONS', 'Imported rendering requires a decoded glTF asset.');
    const geometry = await ImportedGeometry.create(device, options.asset, options.signal);
    let raster: RasterRenderer | undefined;
    try {
      if (options.signal?.aborted) throw new StrataError('SCENE_LOAD_ABORTED', 'Imported scene creation was cancelled.');
      raster = await RasterRenderer.create(device, format, {}, geometry);
      if (options.signal?.aborted) throw new StrataError('SCENE_LOAD_ABORTED', 'Imported scene creation was cancelled.');
      return new ImportedRenderer(raster, geometry);
    } catch (cause) { raster?.dispose(); geometry.dispose(); throw cause; }
  }
  get initialUploadBytes(): number { return this.raster.initialUploadBytes; }
  get gpuBufferBytes(): number { return this.raster.gpuBufferBytes; }
  get gpuTextureBytes(): number { return this.raster.gpuTextureBytes; }
  get importedTelemetry(): ImportedTelemetry { return this.geometry.telemetry; }
  get outputs(): RasterOutputs | undefined { return this.raster.outputs; }
  get directTexture(): GPUTexture | undefined { return this.raster.directTexture; }
  get currentCamera(): CameraFrame | undefined { return this.geometry.currentCamera; }
  passNames(controls: Controls = {}): readonly RasterPassName[] { return this.raster.passNames(controls); }
  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number, timeSeconds: number,
    controls: Controls = {}, timestamps: RasterTimestamps = {}): SceneFrameStats {
    if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'Imported renderer is disposed.');
    try {
      normalizeRasterControls(controls);
      const reset = this.geometry.update(controls.imported);
      return this.raster.encode(encoder, target, width, height, timeSeconds, { ...controls, cameraCut: Boolean(controls.cameraCut || reset || this.forceReset) }, timestamps);
    }
    catch (cause) { this.cancelFrame(); throw cause; }
  }
  submitted(_frameId: number): void { this.geometry.submitted(); this.forceReset = false; }
  cancelFrame(): void { this.geometry.cancelFrame(); this.forceReset = true; }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.raster.dispose(); }
}
