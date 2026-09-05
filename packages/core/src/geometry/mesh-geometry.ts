import { TerrainRendering, transformGeometryBounds, transformTerrainCamera } from './terrain-rendering.js';
import type { TerrainTransform, TerrainLight, TerrainRenderOptions } from './terrain-rendering.js';
import { StrataError } from '../errors.js';
import { validateGeometryPage } from './format.js';
import type { GeometryManifest } from './format.js';
import { createTerrainCamera, geometryBoundsVisible, projectedGeometryError } from './geometry-data.js';
import type { GeometryTelemetry, VirtualSceneOptions } from './virtual-types.js';
import { createLightMatrix } from '../rendering/raster-math.js';
import type { CameraFrame } from '../rendering/raster-math.js';
import type { RasterGeometryProvider } from '../rendering/geometry-provider.js';
import type { RasterControls } from '../rendering/raster-types.js';

interface MeshRange { readonly firstIndex: number; readonly indexCount: number; readonly clusterCount: number }
export interface MeshPacking {
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly clusterVertexBases: Uint32Array<ArrayBuffer>;
  readonly clusterIndexBases: Uint32Array<ArrayBuffer>;
  readonly tiles: readonly (readonly MeshRange[])[];
}

/** Tile/LOD ranges are contiguous; no draw is required per cooked cluster. */
export function buildMeshPacking(manifest: GeometryManifest): MeshPacking {
  const clusterVertexBases = new Uint32Array(manifest.clusters.length);
  const clusterIndexBases = new Uint32Array(manifest.clusters.length);
  let vertexCount = 0; let indexCount = 0;
  const tiles = manifest.tiles.map(tile => tile.lods.map(lod => {
    const firstIndex = indexCount;
    for (const id of lod.clusterIds) {
      const cluster = manifest.clusters[id]!;
      clusterVertexBases[id] = vertexCount; clusterIndexBases[id] = indexCount;
      vertexCount += cluster.vertexCount; indexCount += cluster.indexCount;
    }
    return { firstIndex, indexCount: indexCount - firstIndex, clusterCount: lod.clusterIds.length };
  }));
  if (vertexCount > 0xffffffff || indexCount > 0xffffffff) throw new StrataError('UNSUPPORTED_LIMIT', 'Conventional mesh exceeds 32-bit indices.');
  return { vertexCount, indexCount, clusterVertexBases, clusterIndexBases, tiles };
}

export function selectMeshLods(manifest: GeometryManifest, camera: CameraFrame, height: number, pixelError: number, transform?: TerrainTransform): { lod: number; visible: boolean; error: number }[] {
  return manifest.tiles.map(tile => {
    const bounds = transform ? transformGeometryBounds(tile.bounds, transform) : tile.bounds;
    const errorScale = transform?.scale ?? 1;
    const visible = geometryBoundsVisible(camera.viewProjection, bounds);
    let lod = tile.lods.length - 1;
    if (visible) {
      lod = 0;
      for (let level = tile.lods.length - 1; level >= 0; level--) {
        if (projectedGeometryError(camera, bounds, tile.lods[level]!.error * errorScale, height) <= pixelError) { lod = level; break; }
      }
    }
    return { lod, visible, error: projectedGeometryError(camera, bounds, tile.lods[lod]!.error * errorScale, height) };
  });
}

const meshVertexShader = /* wgsl */ `
@group(1) @binding(0) var<storage, read> meshSelections: array<u32>;
struct MeshInput { @location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @builtin(instance_index) tile: u32, };
@vertex fn meshShadowMain(input: MeshInput) -> @builtin(position) vec4f {
  return frame.lightViewProjection * vec4f(terrainWorldPosition(input.position), 1.0);
}
fn meshColor(id: u32) -> vec3f {
  let hash = (id + 1u) * 2654435761u;
  return vec3f(f32(hash & 255u), f32((hash >> 8u) & 255u), f32((hash >> 16u) & 255u)) / 340.0 + 0.2;
}
@vertex fn meshVertexMain(input: MeshInput) -> VertexOutput {
  let selected = meshSelections[input.tile * 2u];
  let changed = meshSelections[input.tile * 2u + 1u] != 0u;
  let position = vec4f(terrainWorldPosition(input.position), 1.0);
  var output: VertexOutput;
  output.currentClip = frame.viewProjection * position; output.previousClip = frame.previousViewProjection * position;
  output.position = output.currentClip; output.world = position.xyz; output.normal = input.normal; output.uv = input.uv;
  output.color = terrainAlbedo(); output.metallic = 0.0; output.roughness = terrainRoughness();
  output.viewDepths = vec2f(-(frame.view * position).z, select(-(frame.previousView * position).z, -1.0, changed));
  let debug = u32(frame.parameters.z + 0.5);
  // The conventional reference submits tiles, so its cluster debug view colors draw batches.
  output.debugColor = meshColor(input.tile);
  if (debug == 2u) { output.debugColor = meshColor(selected * 7u); }
  if (debug == 3u) { output.debugColor = vec3f(0.1, 0.85, 0.3); }
  if (debug == 4u) { output.debugColor = vec3f(1.0); }
  return output;
}
`;

/** Ordinary preloaded indexed mesh reference, with CPU selection and one draw per tile. */
export class MeshGeometry implements RasterGeometryProvider {
  readonly selectionPass = false;
  readonly shaderSource: string;
  readonly fragmentEntryPoint?: string;
  readonly usesMaterialTextures: boolean;
  readonly vertexEntryPoint = 'meshVertexMain';
  readonly shadowEntryPoint = 'meshShadowMain';
  readonly vertexBuffers: GPUVertexBufferLayout[] = [{ arrayStride: 32, attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x2' },
  ] }];
  readonly halfExtent: number;
  readonly lightMatrix: Float32Array<ArrayBuffer>;
  private bindings: GPUBindGroup | undefined;
  private shadowBindings: GPUBindGroup | undefined;
  private readonly selectionWords: Uint32Array<ArrayBuffer>;
  private previousLods: number[];
  private current: ReturnType<typeof selectMeshLods> = [];
  private pending: GeometryTelemetry | undefined;
  private latest: GeometryTelemetry = { sourceFrameId: null, visibleTiles: 0, selectedClusters: 0, shadowClusters: 0,
    selectedTriangles: 0, shadowTriangles: 0, maxProjectedError: 0 };
  private disposed = false;

  private constructor(private readonly device: GPUDevice, readonly manifest: GeometryManifest,
    private readonly packing: MeshPacking, private readonly vertices: GPUBuffer, private readonly indices: GPUBuffer,
    private readonly selections: GPUBuffer, private readonly pixelError: number, private readonly cameraMode: 'tour' | 'coverage',
    private readonly pageLoadDelayMs: number, private readonly stagingBound: number, private readonly rendering: TerrainRendering) {
    this.selectionWords = new Uint32Array(manifest.tiles.length * 2);
    this.previousLods = Array<number>(manifest.tiles.length).fill(-1);
    this.shaderSource = meshVertexShader + rendering.shader(1);
    this.usesMaterialTextures = rendering.shading !== 'lambert';
    if (!this.usesMaterialTextures) this.fragmentEntryPoint = 'terrainLambertFragment';
    const bounds = transformGeometryBounds(manifest.bounds, rendering.transform);
    this.halfExtent = Math.max(Math.abs(bounds.min[0]), Math.abs(bounds.max[0]), Math.abs(bounds.min[2]), Math.abs(bounds.max[2]));
    this.lightMatrix = createLightMatrix(this.halfExtent);
  }

  static async create(device: GPUDevice, manifest: GeometryManifest, manifestUrl: URL, options: VirtualSceneOptions, renderOptions?: TerrainRenderOptions): Promise<MeshGeometry> {
    const pixelError = options.pixelError ?? 2; const concurrency = options.maxConcurrentRequests ?? 4;
    const delay = options.pageLoadDelayMs ?? 0; const cameraMode = options.cameraMode ?? 'tour';
    if (!Number.isFinite(pixelError) || pixelError <= 0 || pixelError > 1000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32
      || !Number.isFinite(delay) || delay < 0 || delay > 60_000 || !['tour', 'coverage'].includes(cameraMode)) {
      throw new StrataError('INVALID_OPTIONS', 'Invalid conventional mesh loading or selection options.');
    }
    const packing = buildMeshPacking(manifest);
    const vertexBytes = packing.vertexCount * 32; const indexBytes = packing.indexCount * 4;
    const selectionBytes = manifest.tiles.length * 8;
    if ([vertexBytes, indexBytes, selectionBytes].some(bytes => bytes > device.limits.maxBufferSize)
      || selectionBytes > device.limits.maxStorageBufferBindingSize) throw new StrataError('UNSUPPORTED_LIMIT', 'Conventional mesh buffers exceed device limits.');
    const abort = new AbortController();
    const onAbort = (): void => abort.abort(options.signal?.reason ?? new DOMException('Scene creation aborted.', 'AbortError'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const buffers: GPUBuffer[] = [];
    let rendering: TerrainRendering | undefined;
    try {
      abort.signal.throwIfAborted();
      rendering = new TerrainRendering(device, renderOptions);
      const vertices = new Float32Array(packing.vertexCount * 8); const indices = new Uint32Array(packing.indexCount);
      const clustersByPage = manifest.pages.map(() => [] as number[]);
      for (const cluster of manifest.clusters) clustersByPage[cluster.pageId]!.push(cluster.id);
      let nextPage = 0;
      const worker = async (): Promise<void> => {
        while (nextPage < manifest.pages.length) {
          abort.signal.throwIfAborted();
          const page = manifest.pages[nextPage++]!;
          const timeout = setTimeout(() => abort.abort(new StrataError('SCENE_LOAD_FAILED', 'Conventional geometry page request timed out.')), 30_000 + delay);
          try {
            if (delay) await new Promise<void>((resolve, reject) => {
              const cancel = (): void => { clearTimeout(timer); reject(abort.signal.reason); };
              const timer = setTimeout(() => { abort.signal.removeEventListener('abort', cancel); resolve(); }, delay);
              abort.signal.addEventListener('abort', cancel, { once: true });
              if (abort.signal.aborted) cancel();
            });
            const response = await fetch(new URL(page.url, manifestUrl), { signal: abort.signal });
            if (!response.ok || !response.body) throw new StrataError('SCENE_LOAD_FAILED', `Geometry page ${page.id} returned HTTP ${response.status}.`);
            const body = new Uint8Array(page.byteLength); let offset = 0;
            const reader = response.body.getReader();
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                if (offset + chunk.value.byteLength > body.byteLength) throw new StrataError('SCENE_LOAD_FAILED', 'Geometry page exceeds its declared byte length.');
                body.set(chunk.value, offset); offset += chunk.value.byteLength;
              }
            } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
            if (offset !== body.byteLength) throw new StrataError('SCENE_LOAD_FAILED', 'Geometry page is shorter than its declared byte length.');
            const clusters = clustersByPage[page.id]!.map(id => manifest.clusters[id]!);
            const validated = await validateGeometryPage(page, body.buffer, clusters);
            abort.signal.throwIfAborted();
            const data = new DataView(validated.buffer);
            for (const cluster of clusters) {
              const vertexBase = packing.clusterVertexBases[cluster.id]!; const indexBase = packing.clusterIndexBases[cluster.id]!;
              for (let float = 0; float < cluster.vertexCount * 8; float++) vertices[vertexBase * 8 + float] = data.getFloat32(cluster.vertexOffset + float * 4, true);
              for (let index = 0; index < cluster.indexCount; index++) indices[indexBase + index] = vertexBase + data.getUint32(cluster.indexOffset + index * 4, true);
            }
          } finally { clearTimeout(timeout); }
        }
      };
      const workers = Array.from({ length: Math.min(concurrency, manifest.pages.length) }, () => worker().catch(cause => { abort.abort(cause); throw cause; }));
      const results = await Promise.allSettled(workers);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      abort.signal.throwIfAborted();
      const make = (label: string, size: number, usage: number): GPUBuffer => {
        const buffer = device.createBuffer({ label, size, usage: usage | 0x8 }); buffers.push(buffer); return buffer;
      };
      const vertexBuffer = make('Strata conventional terrain vertices', vertexBytes, 0x20);
      const indexBuffer = make('Strata conventional terrain indices', indexBytes, 0x10);
      const selections = make('Strata conventional tile selections', selectionBytes, 0x80);
      device.queue.writeBuffer(vertexBuffer, 0, vertices); device.queue.writeBuffer(indexBuffer, 0, indices);
      return new MeshGeometry(device, manifest, packing, vertexBuffer, indexBuffer, selections, pixelError, cameraMode, delay,
        Math.min(concurrency, manifest.pages.length) * manifest.pageBytes, rendering);
    } catch (cause) { abort.abort(cause); rendering?.dispose(); for (const buffer of buffers) buffer.destroy(); throw cause; }
    finally { options.signal?.removeEventListener('abort', onAbort); }
  }

  get initialUploadBytes(): number { return this.packing.vertexCount * 32 + this.packing.indexCount * 4 + this.rendering.initialUploadBytes; }
  get gpuBufferBytes(): number { return this.disposed ? 0 : this.initialUploadBytes + this.selectionWords.byteLength; }
  get geometryTelemetry(): GeometryTelemetry {
    const packedBytes = this.packing.vertexCount * 32 + this.packing.indexCount * 4;
    return { ...this.latest, geometryMode: 'mesh-lod', cameraPath: this.cameraMode === 'coverage' ? 'terrain-coverage-v1' : 'terrain-tour-v1',
      sourceSeed: this.manifest.source.seed, sourceTriangleCount: this.manifest.source.triangleCount,
      sourceTilesPerSide: this.manifest.source.tilesPerSide, sourceCellsPerTile: this.manifest.source.cellsPerTile,
      pixelError: this.pixelError, pageLoadDelayMs: this.pageLoadDelayMs,
      uniqueCompiledBytes: this.manifest.pages.length * this.manifest.pageBytes,
      packedGeometryBytes: packedBytes, startupCopiedBytes: packedBytes,
      startupCpuBufferBytes: packedBytes, startupPageStagingBoundBytes: this.stagingBound,
      fetchedBytes: this.manifest.pages.length * this.manifest.pageBytes,
      residentPages: 0, capacityPages: 0, rootPages: 0,
      sourcePageCount: this.manifest.pages.length, sourceRootPageCount: this.manifest.rootPageIds.length,
      poolBytes: 0, pageBytes: this.manifest.pageBytes, pendingRequests: 0, completedPages: 0, completedBytes: 0,
      uploadedBytes: this.initialUploadBytes, uploadedPages: 0, evictions: 0, failedPages: 0, requestsStarted: this.manifest.pages.length,
      requestsCompleted: this.manifest.pages.length, requestsFailed: 0, requestsCancelled: 0,
      stagingReservedBytes: 0, stagingBudgetBytes: this.stagingBound, missingDetailTiles: 0, coverageMissingTiles: 0,
      overflowCount: 0, pendingFeedbackFrames: 0, droppedFeedbackFrames: 0, lastFailure: null };
  }
  camera(width: number, height: number, time: number, jitter: readonly [number, number]): CameraFrame {
    return transformTerrainCamera(createTerrainCamera(this.manifest, width, height, time, jitter, this.cameraMode), this.rendering.transform);
  }
  setLight(light: TerrainLight): void { this.rendering.setLight(light); }
  attachPipelines(raster: GPURenderPipeline, shadow: GPURenderPipeline): void {
    this.bindings = this.device.createBindGroup({ label: 'Strata conventional tile history', layout: raster.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer: this.selections } },
        ...(this.rendering.buffer ? [{ binding: 1, resource: { buffer: this.rendering.buffer } }] : [])] });
    if (this.rendering.buffer) this.shadowBindings = this.device.createBindGroup({ label: 'Strata conventional terrain shadow transform',
      layout: shadow.getBindGroupLayout(1), entries: [{ binding: 1, resource: { buffer: this.rendering.buffer } }] });
  }
  prepare(_encoder: GPUCommandEncoder, camera: CameraFrame, _width: number, height: number, reset: boolean, _controls: RasterControls): {
    dispatchCalls: number; uploadBytes: number; triangles: number; drawCalls: number;
  } {
    if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'Conventional geometry was disposed.');
    this.current = selectMeshLods(this.manifest, camera, height, this.pixelError, this.rendering.transform);
    let selectedTriangles = 0; let shadowTriangles = 0; let selectedClusters = 0; let shadowClusters = 0; let visibleTiles = 0; let maxProjectedError = 0;
    for (const tile of this.manifest.tiles) {
      const selection = this.current[tile.id]!; const range = this.packing.tiles[tile.id]![selection.lod]!;
      this.selectionWords[tile.id * 2] = selection.lod;
      this.selectionWords[tile.id * 2 + 1] = reset || this.previousLods[tile.id] !== selection.lod ? 1 : 0;
      shadowTriangles += range.indexCount / 3; shadowClusters += range.clusterCount;
      if (selection.visible) {
        visibleTiles++; selectedTriangles += range.indexCount / 3; selectedClusters += range.clusterCount;
        maxProjectedError = Math.max(maxProjectedError, selection.error);
      }
    }
    this.device.queue.writeBuffer(this.selections, 0, this.selectionWords);
    this.pending = { sourceFrameId: null, visibleTiles, selectedTriangles, shadowTriangles, selectedClusters, shadowClusters, maxProjectedError };
    return { dispatchCalls: 0, uploadBytes: this.selectionWords.byteLength + this.rendering.flush(), triangles: selectedTriangles + shadowTriangles,
      drawCalls: visibleTiles + this.manifest.tiles.length };
  }
  draw(pass: GPURenderPassEncoder, phase: 'raster' | 'shadow'): void {
    if (!this.bindings || !this.pending) throw new StrataError('RENDER_FAILED', 'Conventional geometry is not prepared.');
    pass.setVertexBuffer(0, this.vertices); pass.setIndexBuffer(this.indices, 'uint32');
    if (phase === 'raster') pass.setBindGroup(1, this.bindings);
    else if (this.shadowBindings) pass.setBindGroup(1, this.shadowBindings);
    for (const tile of this.manifest.tiles) {
      const selection = this.current[tile.id]!;
      if (phase === 'raster' && !selection.visible) continue;
      const range = this.packing.tiles[tile.id]![selection.lod]!;
      pass.drawIndexed(range.indexCount, 1, range.firstIndex, 0, tile.id);
    }
  }
  submitted(frameId: number): void {
    if (!this.pending || this.disposed) return;
    this.previousLods = this.current.map(selection => selection.lod);
    this.latest = { ...this.pending, sourceFrameId: frameId }; this.pending = undefined;
  }
  cancelFrame(): void { this.pending = undefined; }
  async flushFeedback(_timeoutMs = 5000): Promise<void> { /* CPU counters are committed synchronously on submission. */ }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.pending = undefined;
    this.vertices.destroy(); this.indices.destroy(); this.selections.destroy(); this.rendering.dispose();
  }
}
