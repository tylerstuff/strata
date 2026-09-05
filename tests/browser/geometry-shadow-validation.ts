import { parseGeometryManifest, validateGeometryPage } from '../../packages/core/src/geometry/format.js';
import type { GeometryManifest } from '../../packages/core/src/geometry/format.js';
import { buildGeometryMetadata, createTerrainCamera, geometryProjectionScale } from '../../packages/core/src/geometry/geometry-data.js';
import { geometrySelectionShader, geometryVertexShader } from '../../packages/core/src/geometry/gpu-geometry-shaders.js';
import { rasterShader } from '../../packages/core/src/rendering/raster-shaders.js';
import { lookAtMatrix, multiplyMatrices, orthographicMatrix } from '../../packages/core/src/rendering/raster-math.js';
import { invertGiMatrix } from '../../packages/core/src/gi/room-geometry.js';

const size = 256;
const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };

/** Independent ordinary vertex list: no GPU LOD selection, compaction or page pulling. */
function referenceVertices(manifest: GeometryManifest, pages: readonly ArrayBuffer[], finest: boolean): Float32Array<ArrayBuffer> {
  const clusters = manifest.tiles.flatMap(tile => tile.lods[finest ? 0 : tile.lods.length - 1]!.clusterIds);
  const count = clusters.reduce((sum, id) => sum + manifest.clusters[id]!.indexCount, 0);
  const result = new Float32Array(count * 3); let cursor = 0;
  for (const id of clusters) {
    const cluster = manifest.clusters[id]!; const data = new DataView(pages[cluster.pageId]!);
    for (let index = 0; index < cluster.indexCount; index++) {
      const vertex = data.getUint32(cluster.indexOffset + index * 4, true);
      for (let axis = 0; axis < 3; axis++) result[cursor++] = data.getFloat32(cluster.vertexOffset + vertex * 32 + axis * 4, true);
    }
  }
  return result;
}

function difference(left: Float32Array, right: Float32Array): number {
  let maximum = 0;
  for (let index = 0; index < left.length; index++) maximum = Math.max(maximum, Math.abs(left[index]! - right[index]!));
  return maximum;
}

function shadowImage(depths: Float32Array): string {
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
  const context = canvas.getContext('2d')!; const image = context.createImageData(size, size);
  for (let index = 0; index < depths.length; index++) {
    const value = depths[index]! >= 1 ? 0 : Math.round((1 - depths[index]!) * 255);
    image.data.set([value, value, value, 255], index * 4);
  }
  context.putImageData(image, 0, 0); return canvas.toDataURL('image/png');
}

/** Executes the production selection/compaction/pulling and production shadow PCF. */
export async function validateResidentFullShadows(manifestPath: string) {
  const manifestUrl = new URL(manifestPath, location.href);
  const manifest = parseGeometryManifest(await (await fetch(manifestUrl)).json());
  const pages: ArrayBuffer[] = [];
  for (const page of manifest.pages) {
    const body = await (await fetch(new URL(page.url, manifestUrl))).arrayBuffer();
    pages.push((await validateGeometryPage(page, body, manifest.clusters)).buffer);
  }
  const fullVertices = referenceVertices(manifest, pages, true);
  const coarseVertices = referenceVertices(manifest, pages, false);
  const fullTriangles = fullVertices.length / 9; const coarseTriangles = coarseVertices.length / 9;
  assert(fullTriangles === manifest.source.triangleCount && coarseTriangles < fullTriangles, 'The independent fixture must contain distinct finest/coarse surfaces.');
  const adapter = await navigator.gpu.requestAdapter(); assert(adapter, 'WebGPU adapter unavailable.');
  const device = await adapter!.requestDevice(); const buffers: GPUBuffer[] = []; const textures: GPUTexture[] = [];
  const errors: string[] = []; device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const buffer = (label: string, bytes: number, usage: GPUBufferUsageFlags): GPUBuffer => {
    const value = device.createBuffer({ label, size: bytes, usage }); buffers.push(value); return value;
  };
  const depthTexture = (label: string): GPUTexture => {
    const value = device.createTexture({ label, size: [size, size], format: 'depth32float', usage: 1 | 4 | 16 }); textures.push(value); return value;
  };
  try {
    const metadata = buildGeometryMetadata(manifest, pages.length);
    const pool = buffer('Validation resident pages', pages.length * manifest.pageBytes, 128 | 8);
    pages.forEach((page, id) => device.queue.writeBuffer(pool, id * manifest.pageBytes, page));
    const meta = buffer('Validation production metadata', metadata.words.byteLength, 128 | 8); device.queue.writeBuffer(meta, 0, metadata.words);
    const residency = buffer('Validation complete residency', pages.length * 4, 128 | 8);
    device.queue.writeBuffer(residency, 0, Uint32Array.from(pages, (_, id) => id));
    const selections = buffer('Validation production selections', manifest.tiles.length * 32, 128 | 8 | 4);
    device.queue.writeBuffer(selections, 0, new Uint32Array(manifest.tiles.length * 8).fill(0xffffffff));
    const references = buffer('Validation production work lists', metadata.triangleCapacity * 8, 128);
    const argumentsBuffer = buffer('Validation production arguments', 64, 128 | 256 | 8 | 4);
    const selectionUniform = buffer('Validation selection camera', 160, 64 | 8);
    const frameUniform = buffer('Validation raster frame', 352, 64 | 8);
    const shader = device.createShaderModule({ code: geometrySelectionShader });
    const selectPipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: shader, entryPoint: 'selectTiles' } });
    const compactPipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: shader, entryPoint: 'compactClusters' } });
    const entry = (binding: number, value: GPUBuffer): GPUBindGroupEntry => ({ binding, resource: { buffer: value } });
    const selectBindings = device.createBindGroup({ layout: selectPipeline.getBindGroupLayout(0), entries: [entry(0, meta), entry(1, residency), entry(2, selections), entry(4, argumentsBuffer), entry(5, selectionUniform)] });
    const compactBindings = device.createBindGroup({ layout: compactPipeline.getBindGroupLayout(0), entries: [entry(0, meta), entry(2, selections), entry(3, references), entry(4, argumentsBuffer), entry(5, selectionUniform)] });
    const extent = (manifest.bounds.max[0] - manifest.bounds.min[0]) / 2;
    // A grazing light makes the source's fine hills cast a substantive shadow witness.
    const lightMatrix = multiplyMatrices(orthographicMatrix(extent * 1.5, 0.1, extent * 5 + 40),
      lookAtMatrix([extent * 2.5, extent * 0.5, extent * 0.4], [0, 0, 0]));
    const frame = new Float32Array(88); frame.set(lightMatrix, 64); device.queue.writeBuffer(frameUniform, 0, frame);
    const shadowModule = device.createShaderModule({ code: rasterShader + geometryVertexShader + `
fn terrainWorldPosition(p: vec3f) -> vec3f { return p; }
fn terrainAlbedo() -> vec3f { return vec3f(0.3); }
fn terrainRoughness() -> f32 { return 1.0; }
` });
    const shadowPipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: shadowModule, entryPoint: 'virtualShadowMain' },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' } });
    const shadowFrame = device.createBindGroup({ layout: shadowPipeline.getBindGroupLayout(0), entries: [entry(0, frameUniform)] });
    const shadowGeometry = device.createBindGroup({ layout: shadowPipeline.getBindGroupLayout(1), entries: [entry(0, pool), entry(1, meta), entry(2, residency), entry(3, references)] });
    const referenceModule = device.createShaderModule({ code: `@group(0) @binding(0) var<uniform> light: mat4x4f;
@vertex fn main(@location(0) position: vec3f) -> @builtin(position) vec4f { return light * vec4f(position, 1.0); }` });
    const referencePipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: referenceModule, entryPoint: 'main',
      buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, format: 'float32x3', offset: 0 }] }] },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' } });
    const referenceLight = buffer('Validation independent light', 64, 64 | 8); device.queue.writeBuffer(referenceLight, 0, lightMatrix);
    const referenceBindings = device.createBindGroup({ layout: referencePipeline.getBindGroupLayout(0), entries: [entry(0, referenceLight)] });
    const source = buffer('Validation ordinary finest vertices', fullVertices.byteLength, 32 | 8); device.queue.writeBuffer(source, 0, fullVertices);
    const coarseSource = buffer('Validation ordinary coarse vertices', coarseVertices.byteLength, 32 | 8); device.queue.writeBuffer(coarseSource, 0, coarseVertices);
    const fullShadow = depthTexture('Validation ordinary finest shadow'); const coarseShadow = depthTexture('Validation ordinary coarse shadow');
    const actualShadow = depthTexture('Validation production shadow');
    const depthReadback = buffer('Validation depth readback', size * size * 4, 1 | 8);
    const selectionReadback = buffer('Validation selection readback', 64 + manifest.tiles.length * 32, 1 | 8);
    async function readDepth(texture: GPUTexture): Promise<Float32Array<ArrayBuffer>> {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture, aspect: 'depth-only' }, { buffer: depthReadback, bytesPerRow: size * 4 }, [size, size]);
      device.queue.submit([encoder.finish()]); await depthReadback.mapAsync(1);
      const result = new Float32Array(depthReadback.getMappedRange().slice(0)); depthReadback.unmap(); return result;
    }
    const passDescriptor = (texture: GPUTexture): GPURenderPassDescriptor => ({ colorAttachments: [],
      depthStencilAttachment: { view: texture.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 } });
    for (const [texture, vertices, count] of [[fullShadow, source, fullVertices.length / 3], [coarseShadow, coarseSource, coarseVertices.length / 3]] as const) {
      const encoder = device.createCommandEncoder(); const pass = encoder.beginRenderPass(passDescriptor(texture));
      pass.setPipeline(referencePipeline); pass.setBindGroup(0, referenceBindings); pass.setVertexBuffer(0, vertices); pass.draw(count); pass.end(); device.queue.submit([encoder.finish()]);
    }
    const fullDepth = await readDepth(fullShadow); const coarseDepth = await readDepth(coarseShadow);
    assert(difference(fullDepth, coarseDepth) > 0.001, 'Fixture finest/coarse light-space geometry must visibly differ.');

    // Select a light-space receiver between the two independently rasterized surfaces.
    let witness = -1; let witnessDepth = 0; let contrast = 0;
    for (let y = 2; y < size - 2; y++) for (let x = 2; x < size - 2; x++) {
      const index = y * size + x; const depth = (fullDepth[index]! + coarseDepth[index]!) / 2;
      if (fullDepth[index]! >= 1 || coarseDepth[index]! >= 1 || Math.abs(fullDepth[index]! - coarseDepth[index]!) < 0.0006) continue;
      let fine = 0; let coarse = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const sample = index + dy * size + dx;
        fine += Number(depth - 0.00025 <= fullDepth[sample]!); coarse += Number(depth - 0.00025 <= coarseDepth[sample]!);
      }
      const delta = Math.abs(fine - coarse) / 9;
      if (delta > contrast) { contrast = delta; witness = index; witnessDepth = depth; }
    }
    assert(witness >= 0 && contrast >= 1 / 3, 'Fixture needs a receiver whose cast-shadow visibility distinguishes finest from coarse.');
    const inverse = invertGiMatrix(lightMatrix); const ndc = [((witness % size) + 0.5) / size * 2 - 1, 1 - (Math.floor(witness / size) + 0.5) / size * 2, witnessDepth, 1];
    const world = [0, 1, 2, 3].map(row => ndc.reduce((sum, value, column) => sum + inverse[column * 4 + row]! * value, 0));
    const witnessBuffer = buffer('Validation receiver position', 16, 64 | 8); device.queue.writeBuffer(witnessBuffer, 0, new Float32Array([world[0]! / world[3]!, world[1]! / world[3]!, world[2]! / world[3]!, 1]));
    const witnessModule = device.createShaderModule({ code: rasterShader + `
@group(1) @binding(0) var<uniform> receiver: vec4f;
@vertex fn witnessVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[index],0,1); }
@fragment fn witnessFragment() -> @location(0) vec4f { return vec4f(shadowVisibility(receiver.xyz)); }` });
    const witnessPipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: witnessModule, entryPoint: 'witnessVertex' },
      fragment: { module: witnessModule, entryPoint: 'witnessFragment', targets: [{ format: 'rgba32float' }] } });
    const witnessPosition = device.createBindGroup({ layout: witnessPipeline.getBindGroupLayout(1), entries: [entry(0, witnessBuffer)] });
    const sampler = device.createSampler({ compare: 'less-equal', minFilter: 'linear', magFilter: 'linear' });
    const witnessOutput = device.createTexture({ size: [1, 1], format: 'rgba32float', usage: 1 | 16 }); textures.push(witnessOutput);
    const witnessReadback = buffer('Validation shadow visibility', 256, 1 | 8);
    async function visibility(texture: GPUTexture): Promise<number> {
      const bindings = device.createBindGroup({ layout: witnessPipeline.getBindGroupLayout(0), entries: [entry(0, frameUniform),
        { binding: 4, resource: texture.createView() }, { binding: 5, resource: sampler }] });
      const encoder = device.createCommandEncoder(); const pass = encoder.beginRenderPass({ colorAttachments: [{ view: witnessOutput.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      pass.setPipeline(witnessPipeline); pass.setBindGroup(0, bindings); pass.setBindGroup(1, witnessPosition); pass.draw(3); pass.end();
      encoder.copyTextureToBuffer({ texture: witnessOutput }, { buffer: witnessReadback, bytesPerRow: 256 }, [1, 1]);
      device.queue.submit([encoder.finish()]); await witnessReadback.mapAsync(1); const result = new Float32Array(witnessReadback.getMappedRange())[0]!; witnessReadback.unmap(); return result;
    }
    const fineVisibility = await visibility(fullShadow); const coarseVisibility = await visibility(coarseShadow);
    assert(Math.abs(fineVisibility - coarseVisibility) > 0.2, 'Production shadow PCF must distinguish the independent finest/coarse receiver.');
    const camera = createTerrainCamera(manifest, size, size, 0, [0, 0], 'coverage');
    const shifted = camera.viewProjection.slice(); shifted[12]! += 4;
    const images: Record<string, string> = { 'independent-finest': shadowImage(fullDepth), 'independent-coarse': shadowImage(coarseDepth) };
    const results = [];
    for (const [name, full, hidden] of [['visible', true, false], ['offscreen', true, true], ['visible-return', true, false], ['ordinary-offscreen', false, true]] as const) {
      const uniform = new ArrayBuffer(160); const floats = new Float32Array(uniform); const words = new Uint32Array(uniform);
      floats.set(hidden ? shifted : camera.viewProjection); floats.set(camera.view, 16); floats.set([geometryProjectionScale(camera, size), 0.25, size, size], 32);
      words.set([0, Number(full), metadata.triangleCapacity, 1], 36); device.queue.writeBuffer(selectionUniform, 0, uniform);
      const argumentsData = new Uint32Array(16); argumentsData[1] = 1; argumentsData[5] = 1; argumentsData[6] = metadata.triangleCapacity * 3;
      device.queue.writeBuffer(argumentsBuffer, 0, argumentsData);
      const encoder = device.createCommandEncoder(); const compute = encoder.beginComputePass();
      compute.setPipeline(selectPipeline); compute.setBindGroup(0, selectBindings); compute.dispatchWorkgroups(Math.ceil(manifest.tiles.length / 64));
      compute.setPipeline(compactPipeline); compute.setBindGroup(0, compactBindings); compute.dispatchWorkgroups(manifest.clusters.length); compute.end();
      const pass = encoder.beginRenderPass(passDescriptor(actualShadow)); pass.setPipeline(shadowPipeline); pass.setBindGroup(0, shadowFrame); pass.setBindGroup(1, shadowGeometry); pass.drawIndirect(argumentsBuffer, 16); pass.end();
      encoder.copyBufferToBuffer(argumentsBuffer, 0, selectionReadback, 0, 64); encoder.copyBufferToBuffer(selections, 0, selectionReadback, 64, manifest.tiles.length * 32);
      device.queue.submit([encoder.finish()]); await selectionReadback.mapAsync(1);
      const values = new Uint32Array(selectionReadback.getMappedRange().slice(0)); selectionReadback.unmap();
      assert(values[4]! / 3 === (full ? fullTriangles : coarseTriangles), `${name}: shadow count is not the independent expected source total.`);
      assert(values[10] === 0 && values[12] === 0, `${name}: production selection lost coverage or overflowed.`);
      assert(hidden ? values[0] === 0 : values[0] === fullTriangles * 3, `${name}: camera raster visibility did not change independently of shadows.`);
      for (const tile of manifest.tiles) {
        const base = 16 + tile.id * 8; const level = full ? 0 : tile.lods.length - 1;
        assert(values[base] === level && values[base + 1] === level && values[base + 2] === Number(!hidden), `${name}: incorrect actual GPU tile selection.`);
        if (name === 'offscreen' || name === 'visible-return') assert(values[base + 3] === 0, `${name}: camera visibility incorrectly invalidated unchanged finest topology.`);
      }
      const depths = await readDepth(actualShadow); const maximumDepthError = difference(depths, full ? fullDepth : coarseDepth);
      assert(maximumDepthError < 0.000002, `${name}: production light-space geometry differs from independent reference (${maximumDepthError}).`);
      const receiverVisibility = await visibility(actualShadow);
      assert(Math.abs(receiverVisibility - (full ? fineVisibility : coarseVisibility)) < 0.00001, `${name}: cast-shadow receiver changed when its camera visibility changed.`);
      images[name] = shadowImage(depths);
      results.push({ name, rasterTriangles: values[0]! / 3, shadowTriangles: values[4]! / 3, maximumDepthError, receiverVisibility });
    }
    assert(errors.length === 0, errors.join('\n'));
    return { fullTriangles, coarseTriangles, independentReceiver: { lightPixel: witness, depth: witnessDepth, world: world.slice(0, 3).map(value => value / world[3]!), fineVisibility, coarseVisibility }, results, images };
  } finally {
    for (const resource of [...buffers, ...textures]) resource.destroy(); device.destroy();
  }
}
