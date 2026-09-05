import { StrataError } from '../errors.js';
import { parseGeometryManifest } from '../geometry/format.js';
import { GpuGeometry } from '../geometry/gpu-geometry.js';
import { MeshGeometry } from '../geometry/mesh-geometry.js';
import { fetchTraceSourceBytes, loadTraceProxy } from '../geometry/trace-proxy.js';
import type { TerrainTraceProxy } from '../geometry/trace-proxy.js';
import type { GeometryTelemetry, VirtualSceneOptions } from '../geometry/virtual-types.js';
import { validateGiControls } from '../gi/gi-renderer.js';
import { ReflectionEffect } from '../reflections/reflection-renderer.js';
import type { ReflectionRenderControls } from '../reflections/reflection-renderer.js';
import { ReflectionGeometry } from '../reflections/reflection-geometry.js';
import { RasterRenderer, normalizeRasterControls } from '../rendering/raster-renderer.js';
import { createLightMatrix } from '../rendering/raster-math.js';
import type { CameraFrame } from '../rendering/raster-math.js';
import type { RasterPassName, RasterTimestamps } from '../rendering/raster-types.js';
import { createIntegratedCamera, createIntegratedScene, integratedTerrainTransform } from './integrated-scene.js';
import type { IntegratedSceneOptions, IntegratedTelemetry } from './integrated-types.js';

/** One camera, one shadow map, one MRT, and shared persistent lighting for room and streamed terrain. */
export class IntegratedRenderer {
  private camera: CameraFrame | undefined;
  private constructor(private readonly raster: RasterRenderer, private readonly terrain: GpuGeometry | MeshGeometry,
    private readonly room: ReflectionGeometry, private readonly effect: ReflectionEffect, readonly proxy: TerrainTraceProxy,
    private readonly options: IntegratedSceneOptions) {}

  static async create(device: GPUDevice, format: GPUTextureFormat, options: IntegratedSceneOptions): Promise<IntegratedRenderer> {
    if (!options || options.renderer !== 'integrated'
      || !(typeof options.manifestUrl === 'string' || options.manifestUrl instanceof URL)
      || !(typeof options.traceProxyUrl === 'string' || options.traceProxyUrl instanceof URL)
      || (options.cameraMode !== undefined && !['tour', 'receiver', 'overview', 'terrain-witness'].includes(options.cameraMode))) {
      throw new StrataError('INVALID_OPTIONS', 'Integrated scenes require cooked terrain/proxy URLs and a supported camera mode.');
    }
    const base = typeof document === 'undefined' ? undefined : document.baseURI;
    const manifestUrl = new URL(options.manifestUrl, base); const proxyUrl = new URL(options.traceProxyUrl, base);
    if (![manifestUrl, proxyUrl].every(url => ['https:', 'http:'].includes(url.protocol))) {
      throw new StrataError('INVALID_OPTIONS', 'Integrated asset URLs require HTTP or HTTPS.');
    }
    const sceneFactory = (state: Parameters<typeof createIntegratedScene>[0]) => createIntegratedScene(state, options.terrainColor);
    const scene = sceneFactory(options);
    const sourceBytes = await fetchTraceSourceBytes(manifestUrl, 8 * 1024 * 1024, options.signal);
    const manifest = parseGeometryManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes)));
    const proxy = await loadTraceProxy(proxyUrl, manifest, sourceBytes, options.signal);
    let terrain: GpuGeometry | MeshGeometry | undefined; let room: ReflectionGeometry | undefined;
    let effect: ReflectionEffect | undefined; let raster: RasterRenderer | undefined;
    try {
      const geometryOptions: VirtualSceneOptions = { ...options, renderer: 'virtual', cameraMode: 'tour', poolBytes: options.poolBytes ?? 1024 * 1024 };
      const rendering = { transform: integratedTerrainTransform, shading: 'lambert' as const, albedo: scene.materials[5]!.albedo, light: scene.light };
      terrain = options.geometryMode === 'mesh-lod'
        ? await MeshGeometry.create(device, manifest, manifestUrl, geometryOptions, rendering)
        : await GpuGeometry.create(device, manifest, manifestUrl, geometryOptions, rendering);
      effect = await ReflectionEffect.create(device, scene, options, { sceneFactory, staticTriangles: proxy.triangles });
      room = new ReflectionGeometry(device, scene);
      let owner: IntegratedRenderer | undefined;
      raster = await RasterRenderer.create(device, format, {}, { providers: [terrain, room], halfExtent: 16,
        lightMatrix: createLightMatrix(16), camera(width, height, time, jitter) {
          const camera = createIntegratedCamera(width, height, time, jitter, options.cameraMode);
          if (owner) owner.camera = camera; return camera;
        } }, effect);
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Scene creation aborted.', 'AbortError');
      owner = new IntegratedRenderer(raster, terrain, room, effect, proxy, { ...options });
      return owner;
    } catch (cause) {
      if (raster) raster.dispose(); else { room?.dispose(); terrain?.dispose(); effect?.dispose(); }
      throw cause;
    }
  }
  get gpuBufferBytes(): number { return this.raster.gpuBufferBytes; }
  get gpuTextureBytes(): number { return this.raster.gpuTextureBytes; }
  get initialUploadBytes(): number { return this.raster.initialUploadBytes; }
  get geometryTelemetry(): GeometryTelemetry { return { ...this.terrain.geometryTelemetry, cameraPath: `integrated-${this.options.cameraMode ?? 'tour'}-v1` }; }
  get giTelemetry() { return this.effect.giTelemetry; }
  get reflectionTelemetry() { return this.effect.reflectionTelemetry; }
  get integratedTelemetry(): IntegratedTelemetry {
    return { fixture: 'streamed-courtyard-v1', cameraPath: `integrated-${this.options.cameraMode ?? 'tour'}-v1`,
      renderRepresentation: 'streamed-terrain-and-exact-room-v1', tracingRepresentation: 'persistent-terrain-proxy-and-exact-room-v1',
      collisionRepresentation: 'none', terrainColor: this.options.terrainColor ?? 'green',
      staticRasterTriangles: 312, persistentProxyTriangles: this.proxy.triangles.length,
      totalTraceTriangles: this.effect.traceData.triangleCount, traceProxyPayloadBytes: this.proxy.payloadBytes,
      traceGeometryBytes: this.effect.traceData.gpuBufferBytes,
      proxySourceManifestSha256: this.proxy.manifest.sourceManifestSha256, proxyPayloadSha256: this.proxy.manifest.mesh.sha256,
      proxyMaxVerticalError: this.proxy.manifest.error.maxVertical, proxyMeasuredMaxVerticalError: this.proxy.manifest.error.measuredMaxVertical,
      terrainScale: integratedTerrainTransform.scale, terrainYOffset: integratedTerrainTransform.translation[1],
      probeVolume: 'fixed-room-grid-v1', outdoorGiSupported: false };
  }
  get currentScene() { return this.effect.currentScene; }
  get currentCamera() { return this.camera; }
  get composer() { return this.effect.composer; }
  get directTexture() { return this.raster.directTexture; }
  get outputs() { return this.raster.outputs; }
  get probeCache() { return this.effect.probeCache; }
  get reflectionCache() { return this.effect.reflectionCache; }
  get traceData() { return this.effect.traceData; }
  get traceBindings() { return this.effect.traceBindings; }
  passNames(controls: ReflectionRenderControls = {}): readonly RasterPassName[] {
    const temporal = normalizeRasterControls(controls).temporal; validateGiControls(controls.gi);
    const reflections = this.effect.mergedControls(controls.reflections); const gi = controls.gi?.enabled ?? this.effect.giEnabled;
    const active = gi || reflections.mode !== 'off';
    return [...(gi ? ['gi-trace', 'gi-update'] as const : []), ...(this.terrain.selectionPass ? ['selection'] as const : []), 'shadow', 'raster',
      ...(active ? [...(reflections.mode === 'world' ? ['reflection-trace', 'reflection-resolve'] as const : []), 'gi-shade'] as const : []),
      ...(temporal ? ['temporal'] as const : []), 'presentation'];
  }
  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number, timeSeconds: number,
    controls: ReflectionRenderControls = {}, timestamps: RasterTimestamps = {}) {
    normalizeRasterControls(controls); const oldScene = this.effect.currentScene; const reset = this.effect.update(controls);
    if (oldScene !== this.effect.currentScene) {
      this.room.setScene(this.effect.currentScene); this.terrain.setLight(this.effect.currentScene.light);
    }
    return this.raster.encode(encoder, target, width, height, timeSeconds, { ...controls, cameraCut: controls.cameraCut || reset }, timestamps);
  }
  submitted(frameId: number): void { this.terrain.submitted(frameId); this.effect.submitted(frameId); }
  cancelFrame(): void { this.terrain.cancelFrame(); this.effect.cancelFrame(); }
  async flushFeedback(timeoutMs = 5000): Promise<void> { await this.terrain.flushFeedback(timeoutMs); }
  dispose(): void { this.raster.dispose(); }
}
