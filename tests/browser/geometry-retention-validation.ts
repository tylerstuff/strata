import { parseGeometryManifest, validateGeometryPage } from '../../packages/core/src/geometry/format.js';
import { GeometryPageCache } from '../../packages/core/src/geometry/page-cache.js';
import type { GeometryPageUpdate } from '../../packages/core/src/geometry/page-cache.js';
import { buildGeometryMetadata, createTerrainCamera, geometryProjectionScale } from '../../packages/core/src/geometry/geometry-data.js';
import { geometrySelectionShader, geometryVertexShader } from '../../packages/core/src/geometry/gpu-geometry-shaders.js';
import { rasterShader } from '../../packages/core/src/rendering/raster-shaders.js';

const size = 256;
const require = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const emptyUpdate = (): GeometryPageUpdate => ({ uploaded: [], evicted: [], uploadBytes: 0 });
interface RetentionSnapshot {
  name: string; desired: number; selected: number; changed: boolean;
  rasterTriangles: number; shadowTriangles: number; missingDetailTiles: number;
  coveredPixels: number; rejectedHistoryPixels: number; maximumDepthError: number;
  mappings: { pageId: number; slot: number }[];
  update: GeometryPageUpdate; telemetry: GeometryPageCache['telemetry'];
}
async function until(ready: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${message}`);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** Controls response delivery only. Production cache validates bytes, chooses slots,
 * commits GPU writes and owns cancellation. No residency is directly manufactured. */
class PageDelivery {
  private readonly pending = new Map<number, () => void>();
  readonly requests: number[] = [];
  constructor(private readonly pages: readonly ArrayBuffer[], private readonly roots: ReadonlySet<number>) {}
  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const match = /\/(\d+)\.bin$/.exec(url); require(match, `Unexpected page request: ${url}`);
    const id = Number(match![1]); this.requests.push(id);
    const respond = () => new Response(this.pages[id]!.slice(0), { status: 200 });
    if (this.roots.has(id)) return respond();
    return await new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const abort = () => { this.pending.delete(id); reject(new DOMException('Controlled response aborted.', 'AbortError')); };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      require(!this.pending.has(id), `Duplicate live page request ${id}.`);
      this.pending.set(id, () => {
        this.pending.delete(id); signal?.removeEventListener('abort', abort); resolve(respond());
      });
    });
  };
  async release(id: number): Promise<void> {
    await until(() => this.pending.has(id), `request for page ${id}`);
    this.pending.get(id)!();
  }
}

/** Fixed-demand, real-cache eviction witness. It does not measure camera motion,
 * asynchronous presentation, visual convergence, throughput or scheduling latency. */
export async function validateGeometryRetention(manifestPath: string) {
  const url = new URL(manifestPath, location.href);
  const manifest = parseGeometryManifest(await (await fetch(url)).json());
  const levels = manifest.tiles[0]!.lods.length; const root = levels - 1; const target = 1;
  require(manifest.tiles.length === 1 && levels === 7 && manifest.source.cellsPerTile === 64,
    'Retention witness requires certified one-tile 64-cell terrain with seven LODs.');
  const roots = [...manifest.rootPageIds]; const finePages = [...manifest.tiles[0]!.lods[0]!.pageIds];
  const targetPages = [...manifest.tiles[0]!.lods[target]!.pageIds];
  require(finePages.length > 1 && targetPages.length > 1, 'Retention witness requires multi-page fine and target LODs.');
  const union = new Set([...roots, ...finePages, ...targetPages]);
  require(union.size === roots.length + finePages.length + targetPages.length,
    'Retention witness requires disjoint root, finest and target page dependencies.');
  const blockedCapacity = roots.length + finePages.length; const feasibleCapacity = union.size;
  require(roots.length + targetPages.length <= blockedCapacity, 'Blocked witness must fit the final desired LOD alone.');
  const pages: ArrayBuffer[] = [];
  for (const page of manifest.pages) {
    const bytes = await (await fetch(new URL(page.url, url))).arrayBuffer();
    pages.push((await validateGeometryPage(page, bytes, manifest.clusters)).buffer);
  }
  // Ordinary vertices are decoded directly from each declared complete LOD, independently
  // of the production selector, work lists and shader page pulling.
  const vertices = Array.from({ length: levels }, (_, level) => {
    const ids = manifest.tiles.flatMap(tile => tile.lods[level]!.clusterIds);
    const result = new Float32Array(ids.reduce((sum, id) => sum + manifest.clusters[id]!.indexCount * 3, 0)); let cursor = 0;
    for (const id of ids) {
      const cluster = manifest.clusters[id]!; const data = new DataView(pages[cluster.pageId]!);
      for (let index = 0; index < cluster.indexCount; index++) {
        const vertex = data.getUint32(cluster.indexOffset + index * 4, true);
        for (let axis = 0; axis < 3; axis++) result[cursor++] = data.getFloat32(cluster.vertexOffset + vertex * 32 + axis * 4, true);
      }
    }
    return result;
  });
  const adapter = await navigator.gpu.requestAdapter(); require(adapter, 'WebGPU adapter unavailable.');
  const device = await adapter!.requestDevice(); const buffers: GPUBuffer[] = []; const textures: GPUTexture[] = []; const errors: string[] = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  void device.lost.then(info => { if (info.reason !== 'destroyed') errors.push(`Device lost: ${info.reason}: ${info.message}`); });
  const caches: GeometryPageCache[] = [];
  const buffer = (label: string, bytes: number, usage: number) => { const value = device.createBuffer({ label, size: bytes, usage }); buffers.push(value); return value; };
  const texture = (label: string, format: GPUTextureFormat) => { const value = device.createTexture({ label, size: [size, size], format, usage: 1 | 16 }); textures.push(value); return value; };
  const entry = (binding: number, value: GPUBuffer): GPUBindGroupEntry => ({ binding, resource: { buffer: value } });
  try {
    const packed = buildGeometryMetadata(manifest, feasibleCapacity);
    require(buildGeometryMetadata(manifest, blockedCapacity).triangleCapacity === packed.triangleCapacity,
      'Both matched capacities must admit the same bounded work-list capacity.');
    const metadata = buffer('Retention metadata', packed.words.byteLength, 128 | 8); device.queue.writeBuffer(metadata, 0, packed.words);
    const residency = buffer('Retention controlled residency', pages.length * 4, 128 | 8);
    const selections = buffer('Retention production selections', manifest.tiles.length * 32, 128 | 8 | 4);
    device.queue.writeBuffer(selections, 0, new Uint32Array(manifest.tiles.length * 8).fill(0xffffffff));
    const work = buffer('Retention work lists', packed.triangleCapacity * 8, 128);
    const argumentsBuffer = buffer('Retention indirect arguments', 64, 128 | 256 | 8 | 4);
    const selectionUniform = buffer('Retention selection camera', 160, 64 | 8); const frameUniform = buffer('Retention raster frame', 352, 64 | 8);
    const shader = device.createShaderModule({ code: geometrySelectionShader });
    const select = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: shader, entryPoint: 'selectTiles' } });
    const compact = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: shader, entryPoint: 'compactClusters' } });
    const selectionGroup = device.createBindGroup({ layout: select.getBindGroupLayout(0), entries: [entry(0, metadata), entry(1, residency), entry(2, selections), entry(4, argumentsBuffer), entry(5, selectionUniform)] });
    const compactGroup = device.createBindGroup({ layout: compact.getBindGroupLayout(0), entries: [entry(0, metadata), entry(2, selections), entry(3, work), entry(4, argumentsBuffer), entry(5, selectionUniform)] });
    const camera = createTerrainCamera(manifest, size, size, 0, [0, 0], 'coverage'); const projectionScale = geometryProjectionScale(camera, size);
    const frame = new Float32Array(88); frame.set(camera.viewProjection); frame.set(camera.viewProjection, 16); frame.set(camera.view, 32); frame.set(camera.view, 48);
    frame[86] = 3; device.queue.writeBuffer(frameUniform, 0, frame);
    const production = device.createShaderModule({ code: rasterShader + geometryVertexShader + `
fn terrainWorldPosition(p:vec3f)->vec3f{return p;}
fn terrainAlbedo()->vec3f{return vec3f(.3);}
fn terrainRoughness()->f32{return 1.;}
@fragment fn fallbackWitness(input:VertexOutput)->@location(0) vec4f {
  return vec4f(input.viewDepths, input.debugColor.g, 1.);
}` });
    const depthState: GPUDepthStencilState = { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' };
    const primitive: GPUPrimitiveState = { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' };
    const pipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: production, entryPoint: 'virtualVertexMain' },
      fragment: { module: production, entryPoint: 'fallbackWitness', targets: [{ format: 'rgba32float' }] }, primitive, depthStencil: depthState });
    const frameGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [entry(0, frameUniform)] });
    const geometryGroup = (cache: GeometryPageCache) => device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [entry(0, cache.buffer), entry(1, metadata), entry(2, residency), entry(3, work), entry(4, selections)] });
    const independent = device.createShaderModule({ code: `@group(0) @binding(0) var<uniform> matrix:mat4x4f;
@vertex fn main(@location(0) p:vec3f)->@builtin(position) vec4f{return matrix*vec4f(p,1.);}` });
    const referencePipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: independent, entryPoint: 'main',
      buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, format: 'float32x3', offset: 0 }] }] }, primitive, depthStencil: depthState });
    const referenceGroup = device.createBindGroup({ layout: referencePipeline.getBindGroupLayout(0), entries: [entry(0, frameUniform)] });
    const depth = texture('Retention actual depth', 'depth32float'); const referenceDepth = texture('Retention ordinary depth', 'depth32float');
    const diagnostic = texture('Retention actual history eligibility', 'rgba32float');
    const imageBytes = size * size * 4; const feedbackBytes = 64 + manifest.tiles.length * 32;
    const readback = buffer('Retention readback', feedbackBytes + imageBytes * 5, 1 | 8);
    const referenceReadback = buffer('Retention independent readback', imageBytes, 1 | 8);
    const depthAttachment = (value: GPUTexture): GPURenderPassDepthStencilAttachment => ({ view: value.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 });
    const depthReferences: Float32Array[] = [];
    for (const data of vertices) {
      const source = buffer('Retention ordinary vertices', data.byteLength, 32 | 8); device.queue.writeBuffer(source, 0, data);
      const encoder = device.createCommandEncoder(); const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: depthAttachment(referenceDepth) });
      pass.setPipeline(referencePipeline); pass.setBindGroup(0, referenceGroup); pass.setVertexBuffer(0, source); pass.draw(data.length / 3); pass.end();
      encoder.copyTextureToBuffer({ texture: referenceDepth, aspect: 'depth-only' }, { buffer: referenceReadback, bytesPerRow: size * 4 }, [size, size]);
      device.queue.submit([encoder.finish()]); await referenceReadback.mapAsync(1);
      depthReferences.push(new Float32Array(referenceReadback.getMappedRange().slice(0))); referenceReadback.unmap();
    }
    let distinct = 0; for (let i = 0; i < size * size; i++) distinct = Math.max(distinct, Math.abs(depthReferences[0]![i]! - depthReferences[root]![i]!));
    require(distinct > .00005, 'Fixture must distinguish finest and root surfaces in depth.');
    let fineTargetDifference = 0;
    for (let i = 0; i < size * size; i++) fineTargetDifference = Math.max(fineTargetDifference, Math.abs(depthReferences[0]![i]! - depthReferences[target]![i]!));
    require(fineTargetDifference > .000005, 'Fixture must distinguish fine and desired surfaces in depth.');
    const results = []; const images: Record<string, string> = {};
    for (const scenario of ['blocked', 'feasible'] as const) for (const policy of ['greedy', 'retain-fallback'] as const) {
      const capacity = scenario === 'blocked' ? blockedCapacity : feasibleCapacity;
      const delivery = new PageDelivery(pages, new Set(roots));
      const cache = await GeometryPageCache.create(device, manifest, url, { residencyPolicy: policy, poolBytes: capacity * manifest.pageBytes,
        maxConcurrentRequests: 1, uploadBudgetBytes: manifest.pageBytes, maxCompletedBytes: manifest.pageBytes,
        maxRetries: 0, requestTimeoutMs: 20_000, fetch: delivery.fetch });
      caches.push(cache);
      require(cache.buffer.size === capacity * manifest.pageBytes && cache.gpuBufferBytes === cache.buffer.size, 'Cache pool allocation differs from fixed cap.');
      const group = geometryGroup(cache); const frames: RetentionSnapshot[] = []; let previous = -1;
      device.queue.writeBuffer(selections, 0, new Uint32Array(manifest.tiles.length * 8).fill(0xffffffff));
      const snapshot = async (name: string, desired: number, selected: number, update = emptyUpdate()) => {
        const mappings = pages.map((_, pageId) => ({ pageId, slot: cache.getSlot(pageId) })).filter(item => item.slot >= 0);
        require(mappings.length <= capacity && new Set(mappings.map(item => item.slot)).size === mappings.length, `${name}: invalid physical slots.`);
        require(mappings.every(item => item.slot < capacity), `${name}: slot exceeds pool cap.`);
        require(roots.every(pageId => cache.getSlot(pageId) >= 0), `${name}: pinned root was evicted.`);
        device.queue.writeBuffer(residency, 0, Uint32Array.from(pages, (_, id) => cache.getSlot(id) < 0 ? 0xffffffff : cache.getSlot(id)));
        const uniform = new ArrayBuffer(160); const floats = new Float32Array(uniform); const words = new Uint32Array(uniform);
        floats.set(camera.viewProjection); floats.set(camera.view, 16);
        const lower = manifest.tiles[0]!.lods[desired]!.error * projectionScale;
        const upper = desired === root ? lower * 2 + 1 : manifest.tiles[0]!.lods[desired + 1]!.error * projectionScale;
        require(lower < upper, 'Diagnostic requires separated error thresholds.');
        floats.set([projectionScale, (lower + upper) / 2, size, size], 32); words.set([0, 0, packed.triangleCapacity, 1], 36);
        device.queue.writeBuffer(selectionUniform, 0, uniform);
        const argumentsData = new Uint32Array(16); argumentsData[1] = 1; argumentsData[5] = 1; argumentsData[6] = packed.triangleCapacity * 3;
        device.queue.writeBuffer(argumentsBuffer, 0, argumentsData);
        const encoder = device.createCommandEncoder(); const compute = encoder.beginComputePass();
        compute.setPipeline(select); compute.setBindGroup(0, selectionGroup); compute.dispatchWorkgroups(1);
        compute.setPipeline(compact); compute.setBindGroup(0, compactGroup); compute.dispatchWorkgroups(manifest.clusters.length); compute.end();
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: diagnostic.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }], depthStencilAttachment: depthAttachment(depth) });
        pass.setPipeline(pipeline); pass.setBindGroup(0, frameGroup); pass.setBindGroup(1, group); pass.drawIndirect(argumentsBuffer, 0); pass.end();
        encoder.copyBufferToBuffer(argumentsBuffer, 0, readback, 0, 64); encoder.copyBufferToBuffer(selections, 0, readback, 64, 32);
        encoder.copyTextureToBuffer({ texture: depth, aspect: 'depth-only' }, { buffer: readback, offset: feedbackBytes, bytesPerRow: size * 4 }, [size, size]);
        encoder.copyTextureToBuffer({ texture: diagnostic }, { buffer: readback, offset: feedbackBytes + imageBytes, bytesPerRow: size * 16 }, [size, size]);
        device.queue.submit([encoder.finish()]); await readback.mapAsync(1);
        const result = readback.getMappedRange().slice(0); readback.unmap();
        const counts = new Uint32Array(result, 0, feedbackBytes / 4); const depths = new Float32Array(result, feedbackBytes, imageBytes / 4);
        const history = new Float32Array(result, feedbackBytes + imageBytes); const changed = previous !== selected;
        const triangleCount = vertices[selected]!.length / 9;
        require(counts[0] === triangleCount * 3 && counts[4] === triangleCount * 3, `${name}: actual raster/shadow count mismatch.`);
        require(counts[10] === 0 && counts[12] === 0, `${name}: missing complete tile or work-list overflow.`);
        require(counts[11] === Number(selected > desired), `${name}: detail-shortfall counter mismatch.`);
        require(counts[16] === desired && counts[17] === selected && counts[18] === 1 && counts[19] === Number(changed), `${name}: desired/selected/history feedback mismatch.`);
        let maximumDepthError = 0; let covered = 0; let rejectedHistory = 0;
        for (let y = 16; y < size - 16; y++) for (let x = 16; x < size - 16; x++) {
          const i = y * size + x;
          require(depths[i]! < 1 && history[i * 4 + 3] === 1, `${name}: missing interior surface.`); covered++;
          maximumDepthError = Math.max(maximumDepthError, Math.abs(depths[i]! - depthReferences[selected]![i]!));
          if (history[i * 4 + 1]! < 0) rejectedHistory++;
        }
        require(maximumDepthError < .000002, `${name}: real cache pool pulling differs from independent selected-LOD depth.`);
        require(rejectedHistory === (changed ? covered : 0), `${name}: topology/history mismatch.`);
        require(cache.telemetry.poolBytes === capacity * manifest.pageBytes && cache.telemetry.stagingReservedBytes <= manifest.pageBytes, `${name}: cache budget exceeded.`);
        require(cache.telemetry.failedPages === 0 && cache.telemetry.requestsFailed === 0, `${name}: page request/validation failure.`);
        const key = `${scenario}-${policy}-${name}`;
        const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size; const context = canvas.getContext('2d')!;
        const image = context.createImageData(size, size);
        for (let i = 0; i < size * size; i++) { const value = depths[i]! >= 1 ? 0 : Math.round((1 - depths[i]!) * 255); image.data.set([value, value, value, 255], i * 4); }
        context.putImageData(image, 0, 0); images[key] = canvas.toDataURL('image/png');
        frames.push({ name, desired: counts[16]!, selected: counts[17]!, changed: Boolean(counts[19]), rasterTriangles: counts[0]! / 3,
          shadowTriangles: counts[4]! / 3, missingDetailTiles: counts[11]!, coveredPixels: covered, rejectedHistoryPixels: rejectedHistory,
          maximumDepthError, mappings, update, telemetry: cache.telemetry });
        previous = selected;
      };
      const upload = async (id: number) => {
        await delivery.release(id); await until(() => cache.telemetry.completedPages === 1, `validation of page ${id}`);
        const update = cache.update(); require(update.uploaded.length === 1 && update.uploaded[0]!.pageId === id, `Expected exactly page ${id} to upload.`);
        return update;
      };
      await snapshot('roots-ready', root, root);
      cache.setDemand([{ tileId: 0, lod: 0, priority: 1 }]);
      for (const [index, id] of finePages.entries()) {
        const update = await upload(id); await snapshot(`fine-upload-${index + 1}`, 0, index === finePages.length - 1 ? 0 : root, update);
      }
      await snapshot('fine-steady', 0, 0);
      const requestsBefore = delivery.requests.length; cache.setDemand([{ tileId: 0, lod: target, priority: 1 }]);
      await snapshot('desired-coarser-missing', target, 0);
      if (scenario === 'blocked' && policy === 'retain-fallback') {
        for (let index = 0; index < 3; index++) {
          const update = cache.update(); require(update.uploaded.length === 0 && update.evicted.length === 0, 'Blocked retention must not fabricate transition progress.');
          await snapshot(`blocked-held-${index + 1}`, target, 0, update);
        }
        require(cache.telemetry.retainedBlockedDemands === 1 && cache.telemetry.retainedTargetLod === null, 'Impossible overlap was not reported as blocked.');
        require(delivery.requests.length === requestsBefore, 'Blocked target unexpectedly started page requests.');
      } else {
        for (const [index, id] of targetPages.entries()) {
          const update = await upload(id); const complete = index === targetPages.length - 1;
          const expected = complete ? target : scenario === 'blocked' ? root : 0;
          await snapshot(`target-upload-${index + 1}`, target, expected, update);
          if (scenario === 'blocked') require(update.evicted.length === 1, 'Greedy blocked-overlap witness must actually evict a fine page.');
          else require(update.evicted.length === 0, 'Feasible overlap should retain the old complete LOD without eviction.');
        }
        await snapshot('target-steady', target, target);
        if (policy === 'retain-fallback') require(cache.telemetry.retainedUnsatisfiedDemands === 0 && cache.telemetry.retainedBlockedDemands === 0, 'Completed retained transition still marked unsatisfied.');
      }
      const finalTelemetry = cache.telemetry; cache.dispose(); await device.queue.onSubmittedWorkDone();
      require(cache.gpuBufferBytes === 0 && cache.telemetry.pendingRequests === 0 && cache.telemetry.completedPages === 0, 'Cache disposal left active resources.');
      results.push({ scenario, policy, capacityPages: capacity, poolBytes: capacity * manifest.pageBytes,
        requests: [...delivery.requests], frames, finalTelemetry, disposedPoolBytes: cache.gpuBufferBytes });
    }
    require(errors.length === 0, errors.join('\n'));
    return { adapter: { vendor: adapter!.info.vendor, architecture: adapter!.info.architecture, device: adapter!.info.device,
      description: adapter!.info.description, isFallbackAdapter: adapter!.info.isFallbackAdapter },
      levels, sourceTriangles: manifest.source.triangleCount, roots, finePages, targetPages,
      blockedCapacityPages: blockedCapacity, feasibleCapacityPages: feasibleCapacity,
      independentFineRootDepthDifference: distinct, independentFineTargetDepthDifference: fineTargetDifference, results, images,
      scope: 'Fixed-demand real-cache allocation/eviction, production selection/compaction/pulling, ordinary-vertex depth and topology-history validation. No moving-camera or performance claim. Incidental shared-page protection is CPU-tested separately.' };
  } finally { for (const cache of caches) cache.dispose(); for (const resource of [...buffers, ...textures]) resource.destroy(); device.destroy(); }
}
