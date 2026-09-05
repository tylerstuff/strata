import { StrataError } from '../errors.js';
import { parseGeometryManifest } from './format.js';
import { GpuGeometry } from './gpu-geometry.js';
import { MeshGeometry } from './mesh-geometry.js';
import type { GeometryTelemetry, VirtualSceneOptions } from './virtual-types.js';
import { RasterRenderer } from '../rendering/raster-renderer.js';
import type { RasterControls, RasterPassName, RasterTimestamps } from '../rendering/raster-types.js';
import type { SceneFrameStats } from '../rendering/scene-renderer.js';

/** Restricted static cooked-terrain adapter sharing the existing PBR/HDR renderer. */
export class VirtualRenderer {
  private constructor(private readonly raster: RasterRenderer, private readonly geometry: GpuGeometry | MeshGeometry) {}

  static async create(device: GPUDevice, format: GPUTextureFormat, options: VirtualSceneOptions): Promise<VirtualRenderer> {
    if (!options || options.renderer !== 'virtual' || !(typeof options.manifestUrl === 'string' || options.manifestUrl instanceof URL)) {
      throw new StrataError('INVALID_OPTIONS', 'Virtual terrain requires a cooked manifest URL.');
    }
    const url = new URL(options.manifestUrl, typeof document === 'undefined' ? undefined : document.baseURI);
    if (!['http:', 'https:'].includes(url.protocol)) throw new StrataError('INVALID_OPTIONS', 'Geometry manifests require HTTP or HTTPS.');
    const response = await fetch(url, options.signal ? { signal: options.signal } : {});
    if (!response.ok) throw new StrataError('SCENE_LOAD_FAILED', `Geometry manifest returned HTTP ${response.status}.`);
    const manifest = parseGeometryManifest(await response.json());
    const geometry = options.geometryMode === 'mesh-lod'
      ? await MeshGeometry.create(device, manifest, url, options) : await GpuGeometry.create(device, manifest, url, options);
    try {
      const raster = await RasterRenderer.create(device, format, {}, geometry);
      if (options.signal?.aborted) { raster.dispose(); throw options.signal.reason ?? new DOMException('Scene creation aborted.', 'AbortError'); }
      return new VirtualRenderer(raster, geometry);
    } catch (cause) { geometry.dispose(); throw cause; }
  }

  get gpuBufferBytes(): number { return this.raster.gpuBufferBytes; }
  get gpuTextureBytes(): number { return this.raster.gpuTextureBytes; }
  get initialUploadBytes(): number { return this.raster.initialUploadBytes; }
  get geometryTelemetry(): GeometryTelemetry { return this.geometry.geometryTelemetry; }
  passNames(controls: RasterControls = {}): readonly RasterPassName[] { return this.raster.passNames(controls); }
  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number, timeSeconds: number,
    controls: RasterControls = {}, timestamps: RasterTimestamps = {}): SceneFrameStats {
    return this.raster.encode(encoder, target, width, height, timeSeconds, controls, timestamps);
  }
  submitted(frameId: number): void { this.geometry.submitted(frameId); }
  cancelFrame(): void { this.geometry.cancelFrame(); }
  async flushFeedback(timeoutMs = 5000): Promise<void> { await this.geometry.flushFeedback(timeoutMs); }
  dispose(): void { this.raster.dispose(); }
}
