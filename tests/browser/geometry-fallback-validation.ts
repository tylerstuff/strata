import { parseGeometryManifest, validateGeometryPage } from '../../packages/core/src/geometry/format.js';
import { buildGeometryMetadata, createTerrainCamera, geometryProjectionScale } from '../../packages/core/src/geometry/geometry-data.js';
import { geometrySelectionShader, geometryVertexShader } from '../../packages/core/src/geometry/gpu-geometry-shaders.js';
import { rasterShader } from '../../packages/core/src/rendering/raster-shaders.js';

const size = 256;
const require = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };

/** Controlled residency tests the production selector, compaction and pulled vertex/history
 * path. It does not claim that the streaming cache retains an active replacement. */
export async function validateGeometryResidentFallback(manifestPath: string) {
  const url = new URL(manifestPath, location.href);
  const manifest = parseGeometryManifest(await (await fetch(url)).json());
  const levels = manifest.tiles[0]!.lods.length; const root = levels - 1; const target = root - 1;
  require(levels >= 3 && manifest.tiles.every(tile => tile.lods.length === levels), 'Fallback witness requires at least three LODs.');
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
  const buffer = (label: string, bytes: number, usage: number) => { const value = device.createBuffer({ label, size: bytes, usage }); buffers.push(value); return value; };
  const texture = (label: string, format: GPUTextureFormat) => { const value = device.createTexture({ label, size: [size, size], format, usage: 1 | 16 }); textures.push(value); return value; };
  const entry = (binding: number, value: GPUBuffer): GPUBindGroupEntry => ({ binding, resource: { buffer: value } });
  try {
    const packed = buildGeometryMetadata(manifest, pages.length);
    const pool = buffer('Fallback fixed geometry pool', pages.length * manifest.pageBytes, 128 | 8);
    pages.forEach((page, id) => device.queue.writeBuffer(pool, id * manifest.pageBytes, page));
    const metadata = buffer('Fallback metadata', packed.words.byteLength, 128 | 8); device.queue.writeBuffer(metadata, 0, packed.words);
    const residency = buffer('Fallback controlled residency', pages.length * 4, 128 | 8);
    const selections = buffer('Fallback production selections', manifest.tiles.length * 32, 128 | 8 | 4);
    device.queue.writeBuffer(selections, 0, new Uint32Array(manifest.tiles.length * 8).fill(0xffffffff));
    const work = buffer('Fallback work lists', packed.triangleCapacity * 8, 128);
    const argumentsBuffer = buffer('Fallback indirect arguments', 64, 128 | 256 | 8 | 4);
    const selectionUniform = buffer('Fallback selection camera', 160, 64 | 8); const frameUniform = buffer('Fallback raster frame', 352, 64 | 8);
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
    const geometryGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [entry(0, pool), entry(1, metadata), entry(2, residency), entry(3, work), entry(4, selections)] });
    const independent = device.createShaderModule({ code: `@group(0) @binding(0) var<uniform> matrix:mat4x4f;
@vertex fn main(@location(0) p:vec3f)->@builtin(position) vec4f{return matrix*vec4f(p,1.);}` });
    const referencePipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: independent, entryPoint: 'main',
      buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, format: 'float32x3', offset: 0 }] }] }, primitive, depthStencil: depthState });
    const referenceGroup = device.createBindGroup({ layout: referencePipeline.getBindGroupLayout(0), entries: [entry(0, frameUniform)] });
    const depth = texture('Fallback actual depth', 'depth32float'); const referenceDepth = texture('Fallback ordinary depth', 'depth32float');
    const diagnostic = texture('Fallback actual history eligibility', 'rgba32float');
    const imageBytes = size * size * 4; const feedbackBytes = 64 + manifest.tiles.length * 32;
    const readback = buffer('Fallback readback', feedbackBytes + imageBytes * 5, 1 | 8);
    const referenceReadback = buffer('Fallback independent readback', imageBytes, 1 | 8);
    const depthAttachment = (value: GPUTexture): GPURenderPassDepthStencilAttachment => ({ view: value.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 });
    const depthReferences: Float32Array[] = [];
    for (const data of vertices) {
      const source = buffer('Fallback ordinary vertices', data.byteLength, 32 | 8); device.queue.writeBuffer(source, 0, data);
      const encoder = device.createCommandEncoder(); const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: depthAttachment(referenceDepth) });
      pass.setPipeline(referencePipeline); pass.setBindGroup(0, referenceGroup); pass.setVertexBuffer(0, source); pass.draw(data.length / 3); pass.end();
      encoder.copyTextureToBuffer({ texture: referenceDepth, aspect: 'depth-only' }, { buffer: referenceReadback, bytesPerRow: size * 4 }, [size, size]);
      device.queue.submit([encoder.finish()]); await referenceReadback.mapAsync(1);
      depthReferences.push(new Float32Array(referenceReadback.getMappedRange().slice(0))); referenceReadback.unmap();
    }
    let distinct = 0; for (let i = 0; i < size * size; i++) distinct = Math.max(distinct, Math.abs(depthReferences[0]![i]! - depthReferences[root]![i]!));
    require(distinct > .00005, 'Fixture must distinguish finest and root surfaces in depth.');
    const pageSet = (...residentLevels: number[]) => new Set(residentLevels.flatMap(level => manifest.tiles.flatMap(tile => [...tile.lods[level]!.pageIds])));
    const fineAndRoots = pageSet(0, root); const complete = pageSet(...Array.from({ length: levels }, (_, i) => i));
    const partialFine = pageSet(root);
    for (const tile of manifest.tiles) {
      const ids = tile.lods[0]!.pageIds; require(ids.length > 1, 'Incomplete finer witness requires a multi-page finest LOD.');
      ids.slice(1).forEach(id => partialFine.add(id));
    }
    // Pages can be shared by neighboring tiles: remove each missing dependency after
    // constructing the union, so every finest LOD really is incomplete.
    manifest.tiles.forEach(tile => partialFine.delete(tile.lods[0]!.pageIds[0]!));
    const stages = [
      { name: 'fine-ready', resident: fineAndRoots, desired: 0, selected: 0 },
      { name: 'fine-steady', resident: fineAndRoots, desired: 0, selected: 0 },
      { name: 'coarser-target-missing', resident: fineAndRoots, desired: target, selected: 0 },
      { name: 'coarser-target-still-missing', resident: fineAndRoots, desired: target, selected: 0 },
      { name: 'partial-finer-rejected', resident: partialFine, desired: target, selected: root },
      { name: 'closest-finer', resident: pageSet(0, target - 1, root), desired: target, selected: target - 1 },
      { name: 'target-ready', resident: complete, desired: target, selected: target },
      { name: 'target-steady', resident: complete, desired: target, selected: target },
      { name: 'offscreen-coarse', resident: fineAndRoots, desired: root, selected: root, hidden: true },
      { name: 'visible-return', resident: fineAndRoots, desired: target, selected: 0 },
      { name: 'full-reference', resident: complete, desired: 0, selected: 0, full: true },
      { name: 'full-reference-offscreen', resident: complete, desired: 0, selected: 0, full: true, hidden: true },
      { name: 'explicit-cut', resident: fineAndRoots, desired: target, selected: 0, reset: true },
    ];
    let previous = -1; const results = []; const images: Record<string, string> = {};
    for (const stage of stages) {
      device.queue.writeBuffer(residency, 0, Uint32Array.from(pages, (_, id) => stage.resident.has(id) ? id : 0xffffffff));
      const uniform = new ArrayBuffer(160); const floats = new Float32Array(uniform); const words = new Uint32Array(uniform);
      floats.set(camera.viewProjection); if (stage.hidden) floats[12]! += 4; floats.set(camera.view, 16);
      const lower = Math.max(...manifest.tiles.map(tile => tile.lods[stage.desired]!.error)) * projectionScale;
      const upper = stage.desired === root ? lower * 2 + 1 : Math.min(...manifest.tiles.map(tile => tile.lods[stage.desired + 1]!.error)) * projectionScale;
      require(lower < upper, 'Diagnostic requires separated common error targets.');
      floats.set([projectionScale, (lower + upper) / 2, size, size], 32); words.set([Number(stage.reset ?? false), Number(stage.full ?? false), packed.triangleCapacity, 1], 36);
      device.queue.writeBuffer(selectionUniform, 0, uniform);
      const argumentsData = new Uint32Array(16); argumentsData[1] = 1; argumentsData[5] = 1; argumentsData[6] = packed.triangleCapacity * 3;
      device.queue.writeBuffer(argumentsBuffer, 0, argumentsData);
      const encoder = device.createCommandEncoder(); const compute = encoder.beginComputePass();
      compute.setPipeline(select); compute.setBindGroup(0, selectionGroup); compute.dispatchWorkgroups(Math.ceil(manifest.tiles.length / 64));
      compute.setPipeline(compact); compute.setBindGroup(0, compactGroup); compute.dispatchWorkgroups(manifest.clusters.length); compute.end();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: diagnostic.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }], depthStencilAttachment: depthAttachment(depth) });
      pass.setPipeline(pipeline); pass.setBindGroup(0, frameGroup); pass.setBindGroup(1, geometryGroup); pass.drawIndirect(argumentsBuffer, 0); pass.end();
      encoder.copyBufferToBuffer(argumentsBuffer, 0, readback, 0, 64); encoder.copyBufferToBuffer(selections, 0, readback, 64, manifest.tiles.length * 32);
      encoder.copyTextureToBuffer({ texture: depth, aspect: 'depth-only' }, { buffer: readback, offset: feedbackBytes, bytesPerRow: size * 4 }, [size, size]);
      encoder.copyTextureToBuffer({ texture: diagnostic }, { buffer: readback, offset: feedbackBytes + imageBytes, bytesPerRow: size * 16 }, [size, size]);
      device.queue.submit([encoder.finish()]); await readback.mapAsync(1);
      const result = readback.getMappedRange().slice(0); readback.unmap(); const counts = new Uint32Array(result, 0, feedbackBytes / 4);
      const depths = new Float32Array(result, feedbackBytes, imageBytes / 4); const history = new Float32Array(result, feedbackBytes + imageBytes);
      const changed = previous !== stage.selected || !!stage.reset; const triangleCount = vertices[stage.selected]!.length / 9;
      require(counts[0] === (stage.hidden ? 0 : triangleCount * 3) && counts[4] === triangleCount * 3, `${stage.name}: incorrect actual raster/shadow triangle counts.`);
      require(counts[10] === 0 && counts[12] === 0, `${stage.name}: coverage hole or work-list overflow.`);
      require(counts[11] === (!stage.hidden && stage.selected > stage.desired ? manifest.tiles.length : 0), `${stage.name}: finer resident geometry incorrectly counted as missing detail.`);
      for (const tile of manifest.tiles) {
        const base = 16 + tile.id * 8;
        require(counts[base] === stage.desired && counts[base + 1] === stage.selected, `${stage.name}: desired/selected GPU levels differ from expected ${stage.desired}/${stage.selected}.`);
        require(counts[base + 2] === Number(!stage.hidden) && counts[base + 3] === Number(changed), `${stage.name}: actual topology/history flags differ.`);
      }
      let maximumDepthError = 0; let covered = 0; let rejectedHistory = 0;
      for (let y = 16; y < size - 16; y++) for (let x = 16; x < size - 16; x++) {
        const index = y * size + x;
        if (stage.hidden) { require(depths[index] === 1, `${stage.name}: offscreen camera draws survived.`); continue; }
        require(depths[index]! < 1 && history[index * 4 + 3] === 1, `${stage.name}: missing interior surface.`); covered++;
        maximumDepthError = Math.max(maximumDepthError, Math.abs(depths[index]! - depthReferences[stage.selected]![index]!));
        if (history[index * 4 + 1]! < 0) rejectedHistory++;
        require(Math.abs(history[index * 4 + 2]! - (stage.selected <= stage.desired ? .85 : .35)) < .00001, `${stage.name}: residency diagnostic disagrees with detail quality.`);
      }
      require(maximumDepthError < .000002, `${stage.name}: pulled geometry differs from independent selected-LOD depth.`);
      require(rejectedHistory === (changed ? covered : 0), `${stage.name}: production vertex history eligibility differs from topology change.`);
      const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size; const context = canvas.getContext('2d')!; const image = context.createImageData(size, size);
      for (let i = 0; i < size * size; i++) { const value = depths[i]! >= 1 ? 0 : Math.round((1 - depths[i]!) * 255); image.data.set([value, value, value, 255], i * 4); }
      context.putImageData(image, 0, 0); images[stage.name] = canvas.toDataURL('image/png');
      results.push({ name: stage.name, desired: stage.desired, selected: stage.selected, residentPages: stage.resident.size, rasterTriangles: counts[0]! / 3,
        shadowTriangles: counts[4]! / 3, missingDetailTiles: counts[11], maximumDepthError, coveredPixels: covered, rejectedHistoryPixels: rejectedHistory, changed });
      previous = stage.selected;
    }
    require(errors.length === 0, errors.join('\n'));
    return { adapter: { vendor: adapter!.info.vendor, architecture: adapter!.info.architecture, device: adapter!.info.device,
      description: adapter!.info.description, isFallbackAdapter: adapter!.info.isFallbackAdapter },
      levels, multipleFinerChoiceTested: levels >= 4, sourceTriangles: manifest.source.triangleCount, fixedPoolBytes: pool.size, independentFineRootDepthDifference: distinct, results, images,
      scope: 'Controlled residency selector/compaction/vertex test; active-page retention under cache eviction is not tested or changed.' };
  } finally { for (const resource of [...buffers, ...textures]) resource.destroy(); device.destroy(); }
}
