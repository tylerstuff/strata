import { StrataError } from '../errors.js';
import type { RasterGeometryGroup, RasterGeometryProvider } from '../rendering/geometry-provider.js';
import { multiplyMatrices, orthographicMatrix } from '../rendering/raster-math.js';
import type { CameraFrame } from '../rendering/raster-math.js';
import type { ImportedAsset, ImportedBounds, ImportedControls, ImportedMaterial, ImportedSampler, ImportedTelemetry, ImportedTexture, ImportedVec3 } from './imported-types.js';
import { createImportedPoseEvaluator } from './imported-animation.js';
import { importedMipmapShader, importedShader } from './imported-shaders.js';
import { createEnvironmentResources, environmentTextureBytes, environmentUniform, environmentUniformBytes, snapshotEnvironment } from './imported-environment.js';
import { estimateImportedTextureAllocation } from './imported-texture-plan.js';
export { importedTextureExtent } from './imported-texture-plan.js';

const geometryBudget = 256 * 1024 * 1024;
const materialBytes = 64;
const lightBytes = 48;
const vertexLayout: GPUVertexBufferLayout[] = [{ arrayStride: 64, attributes: [
  { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
  { shaderLocation: 2, offset: 24, format: 'float32x2' }, { shaderLocation: 3, offset: 32, format: 'float32x4' },
  { shaderLocation: 4, offset: 48, format: 'float32x4' },
] }];
const defaultSampler: ImportedSampler = { wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9987 };
export const importedDefaults = {
  camera: { eye: [3, 2, 3] as ImportedVec3, target: [0, 1, 0] as ImportedVec3, verticalFov: Math.PI / 4 },
  lighting: { directionToLight: [0.35, 0.8, 0.4] as ImportedVec3, color: [1, .95, .875] as ImportedVec3, intensity: 4, ambient: [.06, .06, .06] as ImportedVec3 },
  presentation: 'model-only' as const, background: [.02, .035, .055] as ImportedVec3,
};
type Settings = { camera: NonNullable<ImportedControls['camera']>; lighting: NonNullable<ImportedControls['lighting']>; presentation: 'model-only' | 'ground'; background: ImportedVec3; shading?: 'authored' | 'relit' };
function fail(message: string): never { throw new StrataError('INVALID_OPTIONS', `Invalid imported scene: ${message}`); }
function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) throw new StrataError('SCENE_LOAD_ABORTED', 'Imported scene creation was cancelled.'); }
function vector(value: unknown, label: string, maximum: number, minimum = -maximum): asserts value is ImportedVec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(v => typeof v === 'number' && Number.isFinite(v) && v >= minimum && v <= maximum)) fail(`${label} must be three finite values in [${minimum}, ${maximum}].`);
}
const cross = (a: ImportedVec3, b: ImportedVec3): ImportedVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: ImportedVec3, b: ImportedVec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function normalize(v: ImportedVec3): ImportedVec3 { const n = Math.hypot(...v); if (n < 1e-8) fail('a direction has zero length.'); return [v[0] / n, v[1] / n, v[2] / n]; }
function lookAt(eye: ImportedVec3, target: ImportedVec3): Float32Array<ArrayBuffer> {
  const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  // A vertical light or camera is valid; avoid the fixed-up lookAt singularity.
  const x = normalize(cross(Math.abs(z[1]) > .999 ? [0, 0, 1] : [0, 1, 0], z)); const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}
function snapshot(controls: ImportedControls, current: Settings): Settings {
  if (!controls || typeof controls !== 'object' || Array.isArray(controls)) fail('controls must be an object.');
  const camera = controls.camera === undefined ? current.camera : controls.camera; const lighting = controls.lighting === undefined ? current.lighting : controls.lighting;
  if (!camera || !lighting) fail('camera and lighting must be objects.');
  vector(camera.eye, 'camera eye', 1024); vector(camera.target, 'camera target', 1024);
  if (Math.hypot(...camera.eye.map((v, i) => v - camera.target[i]!)) < .01) fail('camera eye and target must be separated by at least .01.');
  if (!Number.isFinite(camera.verticalFov) || camera.verticalFov < Math.PI / 180 || camera.verticalFov > Math.PI * 5 / 6) fail('verticalFov must be 1–150 degrees in radians.');
  vector(lighting.directionToLight, 'directionToLight', 1e6); vector(lighting.color, 'light color', 64, 0); vector(lighting.ambient, 'ambient fill', 64, 0);
  if (!Number.isFinite(lighting.intensity) || lighting.intensity < 0 || lighting.intensity > 64) fail('light intensity must be in [0, 64].');
  const background = controls.background === undefined ? current.background : controls.background; vector(background, 'background', 64, 0);
  const presentation = controls.presentation === undefined ? current.presentation : controls.presentation; if (presentation !== 'model-only' && presentation !== 'ground') fail('unknown presentation.');
  const shading = controls.shading === undefined ? current.shading ?? 'authored' : controls.shading;
  if (shading !== 'authored' && shading !== 'relit') fail('shading must be authored or relit.');
  const environment = snapshotEnvironment(lighting.environment);
  return { camera: { eye: [...camera.eye], target: [...camera.target], verticalFov: camera.verticalFov },
    lighting: { directionToLight: controls.lighting === undefined ? [...lighting.directionToLight] : normalize(lighting.directionToLight), color: [...lighting.color], intensity: lighting.intensity, ambient: [...lighting.ambient], environment }, presentation, background: [...background], shading };
}

function samplerDescriptor(s: ImportedSampler): GPUSamplerDescriptor {
  if (!s || typeof s !== 'object' || Array.isArray(s)) fail('texture sampler must be an object.');
  const wrap = (v: number): GPUAddressMode => { if (v === 33071) return 'clamp-to-edge'; if (v === 33648) return 'mirror-repeat'; if (v === 10497) return 'repeat'; return fail('unsupported texture wrapping.'); };
  if (![9728, 9729].includes(s.magFilter) || ![9728, 9729, 9984, 9985, 9986, 9987].includes(s.minFilter)) fail('unsupported texture filter.');
  return { addressModeU: wrap(s.wrapS), addressModeV: wrap(s.wrapT), magFilter: s.magFilter === 9728 ? 'nearest' : 'linear',
    minFilter: [9728, 9984, 9986].includes(s.minFilter) ? 'nearest' : 'linear', mipmapFilter: [9986, 9987].includes(s.minFilter) ? 'linear' : 'nearest', lodMaxClamp: [9728, 9729].includes(s.minFilter) ? 0 : 32 };
}
function validateMaterial(material: ImportedMaterial): void {
  if (!material || typeof material !== 'object' || Array.isArray(material)) fail('material must be an object.');
  if (typeof material.name !== 'string') fail('material name must be a string.');
  const factor = (value: unknown, name: string, minimum: number, maximum = Infinity): void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || value < minimum || value > maximum) fail(`${name} is outside its finite material range.`);
  };
  const color = (value: unknown, length: number, name: string): void => {
    if (!Array.isArray(value) || value.length !== length) fail(`${name} must contain exactly ${length} components.`);
    for (const component of value) factor(component, name, 0, 1);
  };
  color(material.baseColorFactor, 4, 'baseColorFactor'); color(material.emissiveFactor, 3, 'emissiveFactor');
  factor(material.metallicFactor, 'metallicFactor', 0, 1); factor(material.roughnessFactor, 'roughnessFactor', 0, 1);
  factor(material.emissiveStrength, 'emissiveStrength', 0, 1e6); factor(material.normalScale, 'normalScale', -Infinity);
  factor(material.occlusionStrength, 'occlusionStrength', 0, 1); factor(material.alphaCutoff, 'alphaCutoff', 0);
  if (!['OPAQUE', 'MASK'].includes(material.alphaMode)) fail('only OPAQUE and MASK materials are supported.');
  if (typeof material.doubleSided !== 'boolean' || (material.unlit !== undefined && typeof material.unlit !== 'boolean')) fail('doubleSided and optional unlit must be booleans.');
}
type DeformationMode = 'static' | 'rigid' | 'skin';
interface Mesh { vertices: GPUBuffer; indices: GPUBuffer; indexCount: number; material: number; ground: boolean;
  mode: DeformationMode; influences: GPUBuffer | undefined; deformationUniform: GPUBuffer | undefined; palette: number;
  bounds: readonly { matrix: number; bounds: ImportedBounds }[]; }
interface Palette { current: GPUBuffer; previous: GPUBuffer; data: Float32Array<ArrayBuffer>; committed: Float32Array<ArrayBuffer>; }
function pointBounds(): { min: [number, number, number]; max: [number, number, number] } { return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; }
function addPoint(bounds: { min: number[]; max: number[] }, point: ArrayLike<number>): void { for (let i = 0; i < 3; i++) { bounds.min[i] = Math.min(bounds.min[i]!, point[i]!); bounds.max[i] = Math.max(bounds.max[i]!, point[i]!); } }
function transformedBounds(bounds: ImportedBounds, matrices: Float32Array, offset: number, out: { min: number[]; max: number[] }): void {
  for (let corner = 0; corner < 8; corner++) {
    const p = [0, 1, 2].map(axis => ((corner >> axis) & 1) ? bounds.max[axis]! : bounds.min[axis]!);
    const q = [0, 1, 2].map(row => matrices[offset + row]! * p[0]! + matrices[offset + 4 + row]! * p[1]! + matrices[offset + 8 + row]! * p[2]! + matrices[offset + 12 + row]!);
    if (!q.every(Number.isFinite) || q.some(v => Math.abs(v) > 8192)) fail('animated bounds exceed the finite normalized preview range (8192 units).');
    addPoint(out, q);
  }
}
interface Material { buffer: GPUBuffer; textures: readonly GPUTexture[]; samplers: readonly GPUSampler[]; doubleSided: boolean; }
interface Owned { buffers: GPUBuffer[]; textures: GPUTexture[]; bufferBytes: number; textureBytes: number; initialUploadBytes: number; }
const groundMaterial: ImportedMaterial = { name: 'Strata explicit ground', baseColorFactor: [.22, .22, .22, 1], metallicFactor: 0, roughnessFactor: .9, emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1, occlusionStrength: 1, alphaMode: 'OPAQUE', alphaCutoff: .5, doubleSided: false };
function groundVertices(): Float32Array<ArrayBuffer> {
  return new Float32Array([[-3, -.005, -3, 0, 0], [3, -.005, -3, 1, 0], [3, -.005, 3, 1, 1], [-3, -.005, 3, 0, 1]].flatMap(([x, y, z, u, v]) => [x!, y!, z!, 0, 1, 0, u!, v!, 1, 0, 0, -1, 1, 1, 1, 1]));
}

/** Material batches share the production raster passes; all asset GPU resources have one owner. */
export class ImportedGeometry implements RasterGeometryGroup {
  readonly halfExtent = 4;
  readonly providers: readonly RasterGeometryProvider[];
  private settings: Settings = snapshot({ lighting: importedDefaults.lighting }, importedDefaults);
  private lightDirty = false;
  private environmentDirty = false;
  private disposed = false;
  private current: CameraFrame | undefined;
  private light: Float32Array<ArrayBuffer> = new Float32Array(16);
  private visibleBounds: ImportedBounds = { min: [0, 0, 0], max: [0, 0, 0] };
  private animation: NonNullable<ImportedControls['animation']> = { clipId: null, timeSeconds: 0, loop: false };
  private committedAnimation: ImportedTelemetry['animation'] | undefined;
  private pendingAnimation: ImportedTelemetry['animation'] = { clipId: null, timeSeconds: 0, loop: false };
  private posePrepared = false;
  private readonly summary: Pick<ImportedTelemetry, 'sourceUrl' | 'triangles' | 'primitives' | 'warnings'>;
  private constructor(private readonly device: GPUDevice, asset: ImportedAsset, private readonly owned: Owned,
    private readonly materials: readonly Material[], private readonly meshes: readonly Mesh[], private readonly lightBuffer: GPUBuffer,
    readonly textureRecords: ImportedTelemetry['textures'], private readonly evaluator: ReturnType<typeof createImportedPoseEvaluator>, private readonly palettes: readonly Palette[],
    private readonly environment: ReturnType<typeof createEnvironmentResources>) {
    this.summary = { sourceUrl: asset.sourceUrl, triangles: asset.stats.triangles, primitives: asset.primitives.length, warnings: [...asset.warnings] };
    const batches: ImportedBatch[] = [];
    for (const mode of ['static', 'rigid', 'skin'] as const) for (const doubleSided of [false, true]) {
      if (meshes.some(mesh => mesh.mode === mode && materials[mesh.material]!.doubleSided === doubleSided)) batches.push(new ImportedBatch(this, mode, doubleSided, batches.length === 0));
    }
    this.providers = batches;
    const fit = this.fitLightMatrix(this.settings, this.palettes.map(palette => palette.data));
    this.visibleBounds = fit.bounds; this.light = fit.matrix;
  }
  static async create(device: GPUDevice, asset: ImportedAsset, signal?: AbortSignal): Promise<ImportedGeometry> {
    checkSignal(signal);
    if (!asset || asset.version !== 1 || !Array.isArray(asset.primitives) || !Array.isArray(asset.materials) || !Array.isArray(asset.images)
      || asset.primitives.length === 0 || asset.primitives.length > 4096 || asset.materials.length > 4096 || asset.images.length > 1024) fail('asset needs a bounded decoded glTF scene.');
    if (!Number.isSafeInteger(asset.maxTextureDimension) || asset.maxTextureDimension < 1 || asset.maxTextureDimension > 16384) fail('invalid texture edge cap.');
    vector(asset.bounds.min, 'bounds min', 1024); vector(asset.bounds.max, 'bounds max', 1024);
    if (asset.bounds.min.some((v, i) => v > asset.bounds.max[i]!)) fail('bounds are inverted.');
    if (device.limits.maxSampledTexturesPerShaderStage < 8 || device.limits.maxSamplersPerShaderStage < 7 || device.limits.maxBindGroups < 2) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported PBR/environment needs eight sampled textures, seven samplers and two bind groups.');
    const evaluator = createImportedPoseEvaluator(asset);
    const initialPose = evaluator.evaluate();
    const initialPalettes = [initialPose.nodeMatrices, ...initialPose.skinMatrices];
    if (asset.primitives.some(p => p.deformation) && (device.limits.maxBindGroups < 3 || device.limits.maxStorageBuffersPerShaderStage < 2)) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported animation needs three bind groups and two vertex storage buffers.');
    for (const data of initialPalettes) if (data.byteLength > device.limits.maxStorageBufferBindingSize || data.byteLength > device.limits.maxBufferSize) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported animation palette exceeds device storage limits.');
    const owned: Owned = { buffers: [], textures: [], bufferBytes: 0, textureBytes: 0, initialUploadBytes: 0 };
    const textureRecords: { image: number; sourceWidth: number; sourceHeight: number; uploadWidth: number; uploadHeight: number; colorSpace: 'srgb' | 'linear'; mipLevels: number; gpuBytes: number }[] = [];
    const texturePlan = estimateImportedTextureAllocation(asset, { maxTextureDimension: asset.maxTextureDimension,
      maxTextureDimension2D: Math.min(16384, device.limits.maxTextureDimension2D) });
    const textureRequests = new Map(texturePlan.textures.map(record => [ `${record.image}/${record.colorSpace === 'srgb'}`, {
      image: record.image, srgb: record.colorSpace === 'srgb', extent: { width: record.uploadWidth, height: record.uploadHeight, mipLevels: record.mipLevels, bytes: record.gpuBytes },
    } ]));
    const definitions = [...asset.materials, groundMaterial];
    const roles = (m: ImportedMaterial) => [m.baseColorTexture, m.metallicRoughnessTexture, m.normalTexture, m.occlusionTexture, m.emissiveTexture];
    for (const material of definitions) {
      validateMaterial(material);
      for (const ref of roles(material)) {
        if (ref === undefined) continue;
        if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail('material texture reference must be an object.');
        if (!Number.isSafeInteger(ref.image) || ref.image < 0 || ref.image >= asset.images.length) fail('material references an absent image.');
        samplerDescriptor(ref.sampler);
        const image = asset.images[ref.image]!;
        if (!image || !['image/png', 'image/jpeg'].includes(image.mimeType) || !(image.bytes instanceof Uint8Array) || !image.bytes.byteLength) fail('referenced image must contain encoded PNG or JPEG bytes.');
      }
    }
    if (!texturePlan.fitsBudget) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported texture role copies, mip chains and fixed environment textures exceed the 512 MiB budget; lower maxTextureDimension.');
    let geometryBytes = 0;
    for (const primitive of asset.primitives) {
      if (!(primitive.vertices instanceof Float32Array) || primitive.vertices.length === 0 || primitive.vertices.length % 16
        || !(primitive.indices instanceof Uint32Array) || primitive.indices.length === 0 || primitive.indices.length % 3
        || !Number.isSafeInteger(primitive.material) || !definitions[primitive.material] || primitive.material >= asset.materials.length) fail('invalid primitive buffers/material.');
      const vertices = primitive.vertices.length / 16;
      if (!primitive.vertices.every(Number.isFinite) || primitive.indices.some((v: number) => v >= vertices)) fail('nonfinite geometry or out-of-range triangle index.');
      geometryBytes += primitive.vertices.byteLength + primitive.indices.byteLength;
      const deformation = primitive.deformation;
      if (deformation) {
        if (!Number.isSafeInteger(deformation.node) || deformation.node < 0 || deformation.node >= initialPose.nodeMatrices.length / 16
          || !(deformation.vertices instanceof Float32Array) || deformation.vertices.length !== primitive.vertices.length || !deformation.vertices.every(Number.isFinite)) fail('invalid local deformation attributes/node.');
        if (deformation.skin !== undefined) {
          const matrices = initialPose.skinMatrices[deformation.skin];
          if (!Number.isSafeInteger(deformation.skin) || !matrices || !(deformation.joints instanceof Uint32Array) || !(deformation.weights instanceof Float32Array)
            || deformation.joints.length !== vertices * 4 || deformation.weights.length !== vertices * 4
            || deformation.joints.some((j: number) => j >= matrices.length / 16) || deformation.weights.some((w: number) => !Number.isFinite(w) || w < 0)) fail('invalid skin palette/influences.');
          for (let vertex = 0; vertex < vertices; vertex++) { let sum = 0; for (let i = 0; i < 4; i++) sum += deformation.weights[vertex * 4 + i]!; if (Math.abs(sum - 1) > .001) fail('skin weights must be normalized.'); }
          geometryBytes += vertices * 32;
        }
      }
      if (primitive.vertices.byteLength > device.limits.maxBufferSize || primitive.indices.byteLength > device.limits.maxBufferSize) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported mesh exceeds maxBufferSize.');
    }
    geometryBytes += initialPalettes.reduce((sum, data) => sum + data.byteLength * 2, 0);
    if (geometryBytes > geometryBudget) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported static GPU geometry exceeds 256 MiB.');
    const buffer = (label: string, data: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>, usage: GPUBufferUsageFlags): GPUBuffer => {
      const value = device.createBuffer({ label, size: data.byteLength, usage: usage | 0x8 }); owned.buffers.push(value); owned.bufferBytes += data.byteLength;
      device.queue.writeBuffer(value, 0, data); owned.initialUploadBytes += data.byteLength; return value;
    };
    const texture = (label: string, width: number, height: number, mipLevelCount: number, srgb: boolean): GPUTexture => {
      const value = device.createTexture({ label, size: [width, height], mipLevelCount, format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm', usage: 0x2 | 0x4 | 0x10 }); owned.textures.push(value); return value;
    };
    try {
      const module = device.createShaderModule({ label: 'Strata imported texture mipmaps', code: importedMipmapShader });
      const pipelinePromises = [false, true].map(async srgb => device.createRenderPipelineAsync({ label: `Strata imported ${srgb ? 'sRGB' : 'linear'} mipmaps`, layout: 'auto',
        vertex: { module, entryPoint: 'mipVertex' }, fragment: { module, entryPoint: 'mipFragment', targets: [{ format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' } }));
      const pipelines = await Promise.all(pipelinePromises); checkSignal(signal);
      const mipSampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
      const fallbacks = [false, true].map(srgb => { const t = texture('Strata imported white fallback', 1, 1, 1, srgb); device.queue.writeTexture({ texture: t }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]); owned.textureBytes += 4; owned.initialUploadBytes += 4; return t; });
      const gpuImages = new Map<string, GPUTexture>();
      for (const [key, request] of textureRequests) {
        checkSignal(signal); const image = asset.images[request.image]!; const e = request.extent;
        let source: ImageBitmap | undefined, upload: ImageBitmap | undefined;
        try {
          source = await createImageBitmap(new Blob([image.bytes], { type: image.mimeType }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none', imageOrientation: 'none' });
          checkSignal(signal);
          if (source.width !== image.width || source.height !== image.height) fail('decoded image dimensions differ from validated source metadata.');
          upload = source;
          if (source.width !== e.width || source.height !== e.height) {
            upload = await createImageBitmap(source, { resizeWidth: e.width, resizeHeight: e.height, resizeQuality: 'high', colorSpaceConversion: 'none', premultiplyAlpha: 'none', imageOrientation: 'none' });
            checkSignal(signal);
          }
          const t = texture(`Strata imported image ${request.image} ${request.srgb ? 'sRGB' : 'linear'}`, e.width, e.height, e.mipLevels, request.srgb);
          device.queue.copyExternalImageToTexture({ source: upload, flipY: false }, { texture: t, colorSpace: 'srgb', premultipliedAlpha: false }, [e.width, e.height]);
          owned.textureBytes += e.bytes; owned.initialUploadBytes += e.width * e.height * 4;
          const encoder = device.createCommandEncoder({ label: 'Strata imported mipmap upload' }); const pipeline = pipelines[Number(request.srgb)]!;
          for (let level = 1; level < e.mipLevels; level++) {
            const binding = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) }, { binding: 1, resource: mipSampler }] });
            const pass = encoder.beginRenderPass({ colorAttachments: [{ view: t.createView({ baseMipLevel: level, mipLevelCount: 1 }), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
            pass.setPipeline(pipeline); pass.setBindGroup(0, binding); pass.draw(3); pass.end();
          }
          if (e.mipLevels > 1) device.queue.submit([encoder.finish()]);
          gpuImages.set(key, t);
          textureRecords.push({ image: request.image, sourceWidth: image.width, sourceHeight: image.height, uploadWidth: e.width, uploadHeight: e.height, colorSpace: request.srgb ? 'srgb' : 'linear', mipLevels: e.mipLevels, gpuBytes: e.bytes });
        } finally { if (upload && upload !== source) upload.close(); source?.close(); }
      }
      checkSignal(signal);
      const samplers = new Map<string, GPUSampler>();
      const sampler = (ref: ImportedTexture | undefined): GPUSampler => { const descriptor = samplerDescriptor(ref?.sampler ?? defaultSampler); const key = JSON.stringify(descriptor); let value = samplers.get(key); if (!value) { value = device.createSampler(descriptor); samplers.set(key, value); } return value; };
      const materials = definitions.map(m => {
        const data = new Float32Array([...m.baseColorFactor, ...m.emissiveFactor, m.emissiveStrength, m.metallicFactor, m.roughnessFactor, m.normalScale, m.occlusionStrength, m.alphaCutoff, Number(m.alphaMode === 'MASK'), Number(Boolean(m.normalTexture)), Number(Boolean(m.unlit))]);
        if (data.byteLength !== materialBytes || !data.every(Number.isFinite)) fail('material factors must be finite.');
        return { buffer: buffer('Strata imported material', data, 0x40), textures: roles(m).map((ref, role) => ref ? gpuImages.get(`${ref.image}/${role === 0 || role === 4}`)! : fallbacks[Number(role === 0 || role === 4)]!), samplers: roles(m).map(sampler), doubleSided: m.doubleSided };
      });
      const palettes = initialPalettes.map((data, index) => ({ current: buffer(`Strata imported current palette ${index}`, data.length ? data : new Float32Array(16), 0x80),
        previous: buffer(`Strata imported previous palette ${index}`, data.length ? data : new Float32Array(16), 0x80), data: data.slice(), committed: data.slice() }));
      const meshes: Mesh[] = asset.primitives.map(primitive => {
        const d = primitive.deformation; const vertices = d?.vertices ?? primitive.vertices;
        const mode: DeformationMode = !d ? 'static' : d.skin === undefined ? 'rigid' : 'skin';
        const bounds = new Map<number, ReturnType<typeof pointBounds>>();
        let influences: GPUBuffer | undefined;
        if (mode === 'skin') {
          const bytes = new ArrayBuffer(vertices.length / 16 * 32); const joints = new Uint32Array(bytes), weights = new Float32Array(bytes);
          for (let vertex = 0; vertex < vertices.length / 16; vertex++) for (let i = 0; i < 4; i++) {
            const joint = d!.joints![vertex * 4 + i]!, weight = d!.weights![vertex * 4 + i]!;
            joints[vertex * 8 + i] = joint; weights[vertex * 8 + 4 + i] = weight;
            if (weight > 0) { let b = bounds.get(joint); if (!b) { b = pointBounds(); bounds.set(joint, b); } addPoint(b, vertices.subarray(vertex * 16, vertex * 16 + 3)); }
          }
          influences = buffer('Strata imported joint indices and weights', new Uint32Array(bytes), 0x20);
        } else {
          const b = pointBounds(); for (let vertex = 0; vertex < vertices.length; vertex += 16) addPoint(b, vertices.subarray(vertex, vertex + 3)); bounds.set(d?.node ?? 0, b);
        }
        return { vertices: buffer('Strata imported vertices', vertices, 0x20), indices: buffer('Strata imported indices', primitive.indices, 0x10), indexCount: primitive.indices.length,
          material: primitive.material, ground: false, mode, influences, palette: mode === 'skin' ? d!.skin! + 1 : 0,
          deformationUniform: d ? buffer('Strata imported deformation mode', new Uint32Array([Number(mode === 'skin'), d.node, 0, 0]), 0x40) : undefined,
          bounds: [...bounds].map(([matrix, bounds]) => ({ matrix, bounds })) };
      });
      meshes.push({ vertices: buffer('Strata explicit ground vertices', groundVertices(), 0x20), indices: buffer('Strata explicit ground indices', new Uint32Array([0, 2, 1, 0, 3, 2]), 0x10), indexCount: 6,
        material: materials.length - 1, ground: true, mode: 'static', influences: undefined, deformationUniform: undefined, palette: 0, bounds: [{ matrix: 0, bounds: { min: [-3, -.005, -3], max: [3, -.005, 3] } }] });
      const lightData = new Float32Array(lightBytes / 4); const defaults = snapshot({ lighting: importedDefaults.lighting }, importedDefaults);
      lightData.set(defaults.lighting.directionToLight); lightData.set(defaults.lighting.color.map(v => v * defaults.lighting.intensity), 4); lightData.set(defaults.lighting.ambient, 8);
      const lightBuffer = buffer('Strata imported directional light and explicit fill', lightData, 0x40);
      checkSignal(signal);
      const environment = createEnvironmentResources(device);
      owned.textures.push(environment.cube, environment.dfg); owned.buffers.push(environment.uniform);
      owned.textureBytes += environmentTextureBytes; owned.bufferBytes += environmentUniformBytes;
      owned.initialUploadBytes += environmentTextureBytes + environmentUniformBytes;
      checkSignal(signal);
      return new ImportedGeometry(device, asset, owned, materials, meshes, lightBuffer, textureRecords, evaluator, palettes, environment);
    } catch (cause) { for (const resource of [...owned.buffers, ...owned.textures]) resource.destroy(); throw cause; }
  }
  get background(): ImportedVec3 { return this.settings.background; }
  get lightMatrix(): Float32Array<ArrayBuffer> { return this.light; }
  get currentCamera(): CameraFrame | undefined { return this.current; }
  get gpuBufferBytes(): number { return this.disposed ? 0 : this.owned.bufferBytes; }
  get gpuTextureBytes(): number { return this.disposed ? 0 : this.owned.textureBytes; }
  get initialUploadBytes(): number { return this.owned.initialUploadBytes; }
  get telemetry(): ImportedTelemetry { return { ...this.summary,
    animation: this.pendingAnimation, bounds: this.visibleBounds, textures: this.textureRecords,
    shading: this.settings.shading ?? 'authored', environment: snapshotEnvironment(this.settings.lighting.environment) }; }
  update(controls: ImportedControls = {}): boolean {
    if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'Imported geometry is disposed.');
    const next = snapshot(controls, this.settings);
    if (controls.animation !== undefined && (!controls.animation || typeof controls.animation !== 'object' || Array.isArray(controls.animation))) fail('animation controls must be an object.');
    const animation = controls.animation === undefined ? this.animation : controls.animation;
    const pose = this.evaluator.evaluate(animation);
    const sources = [pose.nodeMatrices, ...pose.skinMatrices];
    // The evaluator reuses its arrays. Validate the entire candidate before copying any
    // palette or publishing controls/telemetry, so an out-of-range pose is atomic.
    const fit = this.fitLightMatrix(next, sources);
    this.palettes.forEach((palette, i) => palette.data.set(sources[i]!));
    const animationCut = this.committedAnimation !== undefined && pose.clipId !== this.committedAnimation.clipId;
    this.pendingAnimation = { clipId: pose.clipId, timeSeconds: pose.timeSeconds, loop: pose.loop }; this.animation = { ...animation };
    const changedLighting = JSON.stringify(next.lighting) !== JSON.stringify(this.settings.lighting);
    const changedShading = next.shading !== this.settings.shading;
    const cut = changedLighting || changedShading || next.presentation !== this.settings.presentation || JSON.stringify(next.background) !== JSON.stringify(this.settings.background) || next.camera.verticalFov !== this.settings.camera.verticalFov;
    this.environmentDirty ||= changedShading || JSON.stringify(next.lighting.environment) !== JSON.stringify(this.settings.lighting.environment);
    this.settings = next; this.lightDirty ||= changedLighting;
    this.visibleBounds = fit.bounds; this.light = fit.matrix; return cut || animationCut;
  }
  private fitLightMatrix(settings: Settings, palettes: readonly Float32Array[]): { bounds: ImportedBounds; matrix: Float32Array<ArrayBuffer> } {
    const out = pointBounds();
    for (const mesh of this.meshes) {
      if (mesh.ground && settings.presentation !== 'ground') continue;
      for (const entry of mesh.bounds) {
        if (mesh.mode === 'static') { addPoint(out, entry.bounds.min); addPoint(out, entry.bounds.max); }
        else transformedBounds(entry.bounds, palettes[mesh.palette]!, entry.matrix * 16, out);
      }
    }
    const { min, max } = out;
    if (![...min, ...max].every(v => Number.isFinite(v) && Math.abs(v) <= 8192)) fail('bounds exceed the finite normalized preview range (8192 units).');
    const center: ImportedVec3 = [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2];
    const radius = Math.max(.5, Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) / 2);
    const l = settings.lighting.directionToLight; const distance = radius * 2 + .1;
    const eye: ImportedVec3 = [center[0] + l[0] * distance, center[1] + l[1] * distance, center[2] + l[2] * distance];
    return { bounds: { min: [...min], max: [...max] }, matrix: multiplyMatrices(orthographicMatrix(radius * 1.05, .01, radius * 4 + .2), lookAt(eye, center)) };
  }
  camera(width: number, height: number, _time: number, jitter: readonly [number, number]): CameraFrame {
    const camera = this.settings.camera; const view = lookAt(camera.eye, camera.target); const y = 1 / Math.tan(camera.verticalFov / 2);
    const near = .01, far = Math.max(32, ...[0,1,2,3,4,5,6,7].map(corner => Math.hypot(...[0,1,2].map(axis => (((corner >> axis) & 1) ? this.visibleBounds.max[axis]! : this.visibleBounds.min[axis]!) - camera.eye[axis]!)))) + 1;
    const projection = new Float32Array([y / (width / height), 0, 0, 0, 0, y, 0, 0, -2 * jitter[0] / width, 2 * jitter[1] / height, far / (near - far), -1, 0, 0, near * far / (near - far), 0]);
    this.current = { eye: [...camera.eye], view, viewProjection: multiplyMatrices(projection, view), far, projectionScaleY: y }; return this.current;
  }
  prepare(owner: boolean, reset: boolean): number {
    if (!owner) return 0;
    let uploadBytes = 0;
    if (this.lightDirty) {
      const data = new Float32Array(lightBytes / 4); data.set(this.settings.lighting.directionToLight); data.set(this.settings.lighting.color.map(v => v * this.settings.lighting.intensity), 4); data.set(this.settings.lighting.ambient, 8);
      this.device.queue.writeBuffer(this.lightBuffer, 0, data); this.lightDirty = false; uploadBytes += lightBytes;
    }
    if (this.environmentDirty) {
      this.device.queue.writeBuffer(this.environment.uniform, 0, environmentUniform(snapshotEnvironment(this.settings.lighting.environment), this.settings.shading ?? 'authored'));
      this.environmentDirty = false; uploadBytes += environmentUniformBytes;
    }
    if (this.meshes.some(mesh => mesh.mode !== 'static')) for (const palette of this.palettes) {
      if (!palette.data.length) continue;
      this.device.queue.writeBuffer(palette.current, 0, palette.data);
      this.device.queue.writeBuffer(palette.previous, 0, reset ? palette.data : palette.committed);
      uploadBytes += palette.data.byteLength * 2;
    }
    this.posePrepared = true; return uploadBytes;
  }
  submitted(): void {
    if (!this.posePrepared) return;
    for (const palette of this.palettes) palette.committed.set(palette.data);
    this.committedAnimation = this.pendingAnimation; this.posePrepared = false;
  }
  cancelFrame(): void { this.posePrepared = false; }
  deformationBindings(pipeline: GPURenderPipeline, mode: DeformationMode, shadow: boolean): ReadonlyMap<Mesh, GPUBindGroup> {
    const result = new Map<Mesh, GPUBindGroup>(); if (mode === 'static') return result;
    for (const mesh of this.meshes.filter(mesh => mesh.mode === mode)) {
      const palette = this.palettes[mesh.palette]!;
      result.set(mesh, this.device.createBindGroup({ label: 'Strata imported current/previous pose', layout: pipeline.getBindGroupLayout(2), entries: [
        { binding: 0, resource: { buffer: palette.current } },
        // Shadow entry points do not read previous transforms; auto layout omits this binding.
        ...(shadow ? [] : [{ binding: 1, resource: { buffer: palette.previous } }]),
        ...(mode === 'rigid' ? [{ binding: 2, resource: { buffer: mesh.deformationUniform! } }] : []),
      ] }));
    }
    return result;
  }
  materialBindings(pipeline: GPURenderPipeline, shadow: boolean): readonly GPUBindGroup[] {
    return this.materials.map(m => this.device.createBindGroup({ label: 'Strata imported material bindings', layout: pipeline.getBindGroupLayout(1), entries: shadow ? [
      { binding: 0, resource: { buffer: m.buffer } }, { binding: 1, resource: m.textures[0]!.createView() }, { binding: 2, resource: m.samplers[0]! },
    ] : [{ binding: 0, resource: { buffer: m.buffer } }, ...m.textures.flatMap((texture, i) => [{ binding: i * 2 + 1, resource: texture.createView() }, { binding: i * 2 + 2, resource: m.samplers[i]! }]), { binding: 11, resource: { buffer: this.lightBuffer } },
      { binding: 12, resource: this.environment.cube.createView({ dimension: 'cube-array', arrayLayerCount: 12 }) },
      { binding: 13, resource: this.environment.dfg.createView() }, { binding: 14, resource: this.environment.sampler },
      { binding: 15, resource: { buffer: this.environment.uniform } }] }));
  }
  selectedMeshes(doubleSided: boolean, mode: DeformationMode): readonly Mesh[] { return this.meshes.filter(mesh => mesh.mode === mode && this.materials[mesh.material]!.doubleSided === doubleSided && (!mesh.ground || this.settings.presentation === 'ground')); }
  dispose(): void { if (this.disposed) return; this.disposed = true; for (const resource of [...this.owned.buffers, ...this.owned.textures]) resource.destroy(); this.current = undefined; }
}
class ImportedBatch implements RasterGeometryProvider {
  readonly shaderSource = importedShader;
  get vertexEntryPoint(): string { return this.mode === 'skin' ? 'importedSkinVertexMain' : this.mode === 'rigid' ? 'importedRigidVertexMain' : 'importedVertexMain'; }
  get shadowEntryPoint(): string { return this.mode === 'skin' ? 'importedSkinShadowMain' : this.mode === 'rigid' ? 'importedRigidShadowMain' : 'importedShadowMain'; }
  readonly fragmentEntryPoint = 'importedFragment'; readonly shadowFragmentEntryPoint = 'importedShadowFragment';
  readonly usesMaterialTextures = false; readonly selectionPass = false; get vertexBuffers(): GPUVertexBufferLayout[] { return this.mode === 'skin' ? [...vertexLayout, { arrayStride: 32, attributes: [{ shaderLocation: 5, offset: 0, format: 'uint32x4' }, { shaderLocation: 6, offset: 16, format: 'float32x4' }] }] : vertexLayout; } readonly halfExtent = 4;
  private bindings: { raster: readonly GPUBindGroup[]; shadow: readonly GPUBindGroup[] } | undefined;
  private deformation: { raster: ReadonlyMap<Mesh, GPUBindGroup>; shadow: ReadonlyMap<Mesh, GPUBindGroup> } | undefined;
  constructor(private readonly owner: ImportedGeometry, private readonly mode: DeformationMode, private readonly doubleSided: boolean, private readonly accountsResources: boolean) {}
  get cullMode(): GPUCullMode { return this.doubleSided ? 'none' : 'back'; }
  get lightMatrix(): Float32Array<ArrayBuffer> { return this.owner.lightMatrix; }
  get gpuBufferBytes(): number { return this.accountsResources ? this.owner.gpuBufferBytes : 0; }
  get gpuTextureBytes(): number { return this.accountsResources ? this.owner.gpuTextureBytes : 0; }
  get initialUploadBytes(): number { return this.accountsResources ? this.owner.initialUploadBytes : 0; }
  camera(width: number, height: number, time: number, jitter: readonly [number, number]): CameraFrame { return this.owner.camera(width, height, time, jitter); }
  attachPipelines(raster: GPURenderPipeline, shadow: GPURenderPipeline): void { this.bindings = { raster: this.owner.materialBindings(raster, false), shadow: this.owner.materialBindings(shadow, true) }; this.deformation = { raster: this.owner.deformationBindings(raster, this.mode, false), shadow: this.owner.deformationBindings(shadow, this.mode, true) }; }
  prepare(_encoder: GPUCommandEncoder, _camera: CameraFrame, _width: number, _height: number, reset: boolean) { const meshes = this.owner.selectedMeshes(this.doubleSided, this.mode); return { dispatchCalls: 0, drawCalls: meshes.length * 2, triangles: meshes.reduce((n, mesh) => n + mesh.indexCount / 3 * 2, 0), uploadBytes: this.owner.prepare(this.accountsResources, reset) }; }
  draw(pass: GPURenderPassEncoder, phase: 'raster' | 'shadow'): void {
    if (!this.bindings) throw new StrataError('RENDER_FAILED', 'Imported material pipelines are not attached.');
    for (const mesh of this.owner.selectedMeshes(this.doubleSided, this.mode)) { if (this.mode !== 'static') pass.setBindGroup(2, this.deformation![phase].get(mesh)!); if (mesh.influences) pass.setVertexBuffer(1, mesh.influences); pass.setBindGroup(1, this.bindings[phase][mesh.material]!); pass.setVertexBuffer(0, mesh.vertices); pass.setIndexBuffer(mesh.indices, 'uint32'); pass.drawIndexed(mesh.indexCount); }
  }
  dispose(): void { this.owner.dispose(); this.bindings = undefined; }
}
