import { StrataError } from '../errors.js';
import type { RasterGiProvider } from '../rendering/gi-provider.js';
import type { CameraFrame } from '../rendering/raster-math.js';
import type { RasterControls, RasterOutputs, RasterTimestamps } from '../rendering/raster-types.js';
import { importedIndirectShader } from './imported-indirect-shader.js';
import type { ImportedIndirectCreateOptions, ImportedIndirectEnvironment, ImportedIndirectLighting, ImportedIndirectMaterial,
  ImportedIndirectOptions, ImportedIndirectProgress, ImportedIndirectReadback, ImportedIndirectSource } from './imported-indirect-types.js';

const uniformBytes = 288, diagnosticBytes = 16, pixelBytes = 32;
const defaults: Required<ImportedIndirectOptions> = { maxPixels: 262144, pixelBatch: 4096, maxSamples: 64, maxVisits: 4096, seed: 1337 };
function fail(message: string): never { throw new StrataError('INVALID_OPTIONS', `Imported indirect: ${message}`); }
function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new StrataError('SCENE_LOAD_ABORTED', 'Imported indirect creation was cancelled.'); }
function scalar(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${name} is outside [${min}, ${max}].`); return value;
}
function vector(value: unknown, length: number, min: number, max: number, name: string): number[] {
  if (!Array.isArray(value) || value.length !== length) fail(`${name} needs ${length} components.`);
  return Array.from(value, component => scalar(component, min, max, name));
}
function settings(input: ImportedIndirectOptions = {}, current = defaults): Required<ImportedIndirectOptions> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('options must be an object.');
  const next = { ...current, ...input };
  for (const [key, min, max] of [['maxPixels', 1, 1048576], ['pixelBatch', 1, 65536], ['maxSamples', 1, 1024], ['maxVisits', 1, 524287], ['seed', 0, 0xffffffff]] as const) {
    scalar(next[key], min, max, key); if (!Number.isInteger(next[key])) fail(`${key} must be an integer.`);
  }
  return next;
}
function lighting(input: ImportedIndirectLighting): ImportedIndirectLighting {
  if (!input || typeof input !== 'object') fail('lighting must be an object.');
  const direction = vector(input.directionToLight, 3, -1e6, 1e6, 'light direction'); const length = Math.hypot(...direction);
  if (length < 1e-8) fail('light direction is zero.');
  return { directionToLight: direction.map(v => v / length) as [number, number, number], color: vector(input.color, 3, 0, 64, 'light color') as [number, number, number], intensity: scalar(input.intensity, 0, 64, 'light intensity') };
}
function environment(input: ImportedIndirectEnvironment): ImportedIndirectEnvironment {
  if (!input || !['off', 'studio', 'sky', 'constant'].includes(input.mode)) fail('unknown environment.');
  const constantRadiance = vector(input.constantRadiance ?? [0, 0, 0], 3, 0, 64, 'constant environment') as [number, number, number];
  return { mode: input.mode, intensity: scalar(input.intensity, 0, 64, 'environment intensity'), rotationRadians: scalar(input.rotationRadians, -1e6, 1e6, 'environment rotation'), constantRadiance };
}
function validateSource(device: GPUDevice, source: ImportedIndirectSource): number {
  if (!source || !(source.nodes instanceof Uint8Array) || !(source.triangles instanceof Uint8Array)
    || !(source.vertices instanceof Float32Array) || !(source.indices instanceof Uint32Array)) fail('source requires the four typed geometry arrays.');
  if (!source.nodes.byteLength || source.nodes.byteLength % 32 || !source.triangles.byteLength || source.triangles.byteLength % 64
    || !source.vertices.length || source.vertices.length % 16 || !source.indices.length || source.indices.length % 3) fail('source array strides/counts are invalid.');
  if (source.triangles.byteLength / 64 !== source.indices.length / 3) fail('BVH triangle count differs from the source index triplets.');
  // The immutable lane-A snapshot has already passed validateImportedStaticBvh.
  // Avoid another synchronous scan of millions of source attributes on the UI thread.
  if (source.vertices.length / 16 > 2097152 || source.triangles.byteLength / 64 > 1048576 || source.nodes.byteLength / 32 > 524287) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported indirect source exceeds the static geometry count limits.');
  let bytes = 0;
  for (const data of [source.nodes, source.triangles, source.vertices, source.indices]) {
    if (data.byteLength > device.limits.maxBufferSize || data.byteLength > device.limits.maxStorageBufferBindingSize) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported indirect source exceeds GPU storage binding limits.');
    bytes += data.byteLength;
  }
  if (bytes > 256 * 1024 * 1024) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported indirect source exceeds its 256 MiB GPU budget.');
  return bytes;
}
function inverse(matrix: Float32Array): Float32Array<ArrayBuffer> {
  const rows = Array.from({ length: 4 }, (_, row) => Array.from({ length: 8 }, (_, column) => column < 4 ? matrix[column * 4 + row]! : Number(column - 4 === row)));
  for (let column = 0; column < 4; column++) {
    let pivot = column; for (let row = column + 1; row < 4; row++) if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!]; const divisor = rows[column]![column]!;
    if (Math.abs(divisor) < 1e-12) fail('camera projection is singular.');
    for (let entry = 0; entry < 8; entry++) rows[column]![entry]! /= divisor;
    for (let row = 0; row < 4; row++) if (row !== column) { const scale = rows[row]![column]!; for (let entry = 0; entry < 8; entry++) rows[row]![entry]! -= scale * rows[column]![entry]!; }
  }
  const result = Float32Array.from({ length: 16 }, (_, index) => rows[index % 4]![4 + Math.floor(index / 4)]!);
  if (!result.every(Number.isFinite)) fail('inverse camera exceeds float32.'); return result;
}
function cameraData(camera: CameraFrame): { key: string; inverse: Float32Array<ArrayBuffer> } {
  if (!camera || camera.viewProjection.length !== 16 || camera.view.length !== 16 || !camera.viewProjection.every(Number.isFinite) || !camera.view.every(Number.isFinite)) fail('camera matrices must be finite 4x4 matrices.');
  vector(camera.eye, 3, -8192, 8192, 'camera eye');
  return { key: JSON.stringify([[...camera.viewProjection], [...camera.view], camera.eye]), inverse: inverse(camera.viewProjection) };
}
interface Targets { width: number; height: number; accumulation: GPUBuffer; texture: GPUTexture; view: GPUTextureView; scene: GPUBindGroup; }
interface Pending { encoder: GPUCommandEncoder; width: number; height: number; cameraKey: string; key: string; inverse: Float32Array<ArrayBuffer>; reset: boolean; start: number; count: number; encoded: boolean; }

/** Full-resolution, bounded progressive diffuse accumulation. Borrowed material resources are never destroyed. */
export class ImportedIndirectEffect implements RasterGiProvider {
  readonly preparePassNames = [] as const;
  readonly composePassNames = ['gi-trace', 'gi-shade'] as const;
  private enabled = true;
  private disposed = false;
  private dirty = true;
  private revision = 0;
  private submittedFrames = 0;
  private cursor = 0;
  private committedKey: string | undefined;
  private committedSize = [0, 0];
  private pending: Pending | undefined;
  private targets: Targets | undefined;
  private readback: GPUBuffer | undefined;
  private constructor(private readonly device: GPUDevice, private readonly sourceBuffers: readonly GPUBuffer[], private readonly sourceBytes: number,
    private readonly uniform: GPUBuffer, private readonly diagnostics: GPUBuffer, private readonly tracePipeline: GPUComputePipeline,
    private readonly composePipeline: GPUComputePipeline, private readonly screenLayout: GPUBindGroupLayout, private readonly sceneLayout: GPUBindGroupLayout,
    private readonly materialGroup: GPUBindGroup, private readonly material: ImportedIndirectMaterial,
    private light: ImportedIndirectLighting, private env: ImportedIndirectEnvironment, private limits: Required<ImportedIndirectOptions>) {}
  static async create(device: GPUDevice, input: ImportedIndirectCreateOptions): Promise<ImportedIndirectEffect> {
    if (!input) fail('creation options are required.'); aborted(input.signal);
    const limits = settings(input.options), light = lighting(input.lighting), env = environment(input.environment), m = input.material;
    if (!m || !m.baseColorTexture || !m.baseSampler || !m.metallicRoughnessTexture || !m.metallicRoughnessSampler || !m.emissiveTexture || !m.emissiveSampler || typeof m.doubleSided !== 'boolean') fail('borrowed material bindings and boolean doubleSided are required.');
    const material: ImportedIndirectMaterial = { ...m, baseColorFactor: vector(m.baseColorFactor, 4, 0, 1, 'base color') as [number, number, number, number], metallicFactor: scalar(m.metallicFactor, 0, 1, 'metallic factor'),
      emissiveFactor: vector(m.emissiveFactor, 3, 0, 1, 'emissive factor') as [number, number, number], emissiveStrength: scalar(m.emissiveStrength, 0, 1e6, 'emissive strength') };
    if (material.emissiveFactor.some(value => value * material.emissiveStrength > 65504)) fail('emissive factor times strength exceeds the finite rgba16float range (65504).');
    const sourceBytes = validateSource(device, input.source);
    const l = device.limits;
    if (l.maxStorageBuffersPerShaderStage < 6 || l.maxBindGroups < 3 || l.maxSampledTexturesPerShaderStage < 5 || l.maxSamplersPerShaderStage < 3
      || l.maxStorageTexturesPerShaderStage < 1 || l.maxUniformBufferBindingSize < uniformBytes || l.maxComputeInvocationsPerWorkgroup < 64 || l.maxComputeWorkgroupSizeX < 64 || l.maxComputeWorkgroupSizeY < 8) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported indirect requires six storage buffers, three groups, five textures, three samplers and 64-thread compute groups.');
    const bufferEntry = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: 4, buffer: { type } });
    const screenLayout = device.createBindGroupLayout({ entries: [bufferEntry(0, 'uniform'), { binding: 1, visibility: 4, texture: { sampleType: 'depth' } }, { binding: 2, visibility: 4, texture: { sampleType: 'float' } }, { binding: 3, visibility: 4, storageTexture: { access: 'write-only', format: 'rgba16float' } }] });
    const sceneLayout = device.createBindGroupLayout({ entries: Array.from({ length: 6 }, (_, binding) => bufferEntry(binding, binding < 4 ? 'read-only-storage' : 'storage')) });
    const materialLayout = device.createBindGroupLayout({ entries: [0, 2, 4].flatMap(binding => [{ binding, visibility: 4, texture: { sampleType: 'float' as const } }, { binding: binding + 1, visibility: 4, sampler: { type: 'filtering' as const } }]) });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [screenLayout, sceneLayout, materialLayout] });
    const module = device.createShaderModule({ label: 'Strata imported progressive indirect', code: importedIndirectShader });
    const [trace, compose] = await Promise.all(['traceImportedIndirect', 'composeImportedIndirect'].map(entryPoint => device.createComputePipelineAsync({ label: entryPoint, layout, compute: { module, entryPoint } })));
    aborted(input.signal); const owned: GPUBuffer[] = [];
    try {
      const sourceBuffers = [input.source.nodes, input.source.triangles, input.source.vertices, input.source.indices].map((data, index) => {
        const b = device.createBuffer({ label: `Strata imported indirect source ${index}`, size: data.byteLength, usage: 0x80 | 0x8 }); owned.push(b); device.queue.writeBuffer(b, 0, data); return b;
      });
      const uniform = device.createBuffer({ label: 'Strata imported indirect frame', size: uniformBytes, usage: 0x40 | 0x8 }); owned.push(uniform);
      const diagnostics = device.createBuffer({ label: 'Strata imported indirect counters', size: diagnosticBytes, usage: 0x80 | 0x8 | 0x4 }); owned.push(diagnostics);
      const materialGroup = device.createBindGroup({ layout: materialLayout, entries: [{ binding: 0, resource: m.baseColorTexture }, { binding: 1, resource: m.baseSampler }, { binding: 2, resource: m.metallicRoughnessTexture }, { binding: 3, resource: m.metallicRoughnessSampler }, { binding: 4, resource: m.emissiveTexture }, { binding: 5, resource: m.emissiveSampler }] });
      aborted(input.signal);
      return new ImportedIndirectEffect(device, sourceBuffers, sourceBytes, uniform, diagnostics, trace!, compose!, screenLayout, sceneLayout, materialGroup, material, light, env, limits);
    } catch (cause) { for (const resource of owned) resource.destroy(); throw cause; }
  }
  private live(): void { if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'Imported indirect effect is disposed.'); }
  private idle(): void { this.live(); if (this.pending) throw new StrataError('RENDER_FAILED', 'Imported indirect frame requires submitted() or cancelFrame() before another operation.'); }
  get active(): boolean { return this.enabled && !this.disposed; }
  get initialUploadBytes(): number { return this.sourceBytes; }
  get gpuBufferBytes(): number { return this.disposed ? 0 : this.sourceBytes + uniformBytes + diagnosticBytes + (this.targets ? this.targets.width * this.targets.height * pixelBytes : 0) + (this.readback ? diagnosticBytes : 0); }
  get gpuTextureBytes(): number { return this.disposed || !this.targets ? 0 : this.targets.width * this.targets.height * 8; }
  get outputTexture(): GPUTexture | undefined { return this.targets?.texture; }
  /** Internal diagnostic readback; this buffer expires on resize/disposal. */
  get accumulationBuffer(): GPUBuffer | undefined { return this.targets?.accumulation; }
  get maxPixels(): number { return this.limits.maxPixels; }
  get progress(): ImportedIndirectProgress { return { revision: this.revision, submittedFrames: this.submittedFrames, batchCursor: this.cursor, width: this.committedSize[0]!, height: this.committedSize[1]!, pendingReset: this.dirty || Boolean(this.pending?.reset), pendingFrame: Boolean(this.pending), enabled: this.active, normalMode: 'geometric', textureLod: 0, limits: { ...this.limits } }; }
  updateLighting(value: ImportedIndirectLighting, env?: ImportedIndirectEnvironment): void {
    this.idle(); const nextLight = lighting(value), nextEnvironment = env === undefined ? this.env : environment(env);
    if (JSON.stringify([nextLight, nextEnvironment]) !== JSON.stringify([this.light, this.env])) { this.light = nextLight; this.env = nextEnvironment; this.dirty = true; }
  }
  updateSettings(value: ImportedIndirectOptions): void { this.idle(); const next = settings(value, this.limits); if (JSON.stringify(next) !== JSON.stringify(this.limits)) { this.limits = next; this.dirty = true; } }
  setEnabled(value: boolean): void { this.idle(); if (typeof value !== 'boolean') fail('enabled must be boolean.'); if (value !== this.enabled) { this.enabled = value; this.dirty = true; } }
  reset(): void { this.idle(); this.dirty = true; }
  /** Pure size preflight: safe before host resize/activation, with no allocation or state change. */
  validateSize(width: number, height: number): void {
    this.live();
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > this.device.limits.maxTextureDimension2D || height > this.device.limits.maxTextureDimension2D) throw new StrataError('INVALID_SIZE', 'Imported indirect dimensions must fit GPU texture limits.');
    const pixels = width * height;
    if (pixels > this.limits.maxPixels) throw new StrataError('UNSUPPORTED_LIMIT', `Imported indirect preview exceeds maxPixels=${this.limits.maxPixels}; choose a smaller explicit preview resolution.`);
    if (pixels * pixelBytes > Math.min(this.device.limits.maxBufferSize, this.device.limits.maxStorageBufferBindingSize)) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported indirect pixel state exceeds GPU storage limits.');
    if (Math.ceil(width / 8) > this.device.limits.maxComputeWorkgroupsPerDimension || Math.ceil(height / 8) > this.device.limits.maxComputeWorkgroupsPerDimension || Math.ceil(Math.min(pixels, this.limits.pixelBatch) / 64) > this.device.limits.maxComputeWorkgroupsPerDimension) throw new StrataError('UNSUPPORTED_LIMIT', 'Imported indirect dispatch exceeds GPU workgroup limits.');
  }
  prepare(encoder: GPUCommandEncoder, camera: CameraFrame, width: number, height: number, _time: number, _timestamps: RasterTimestamps) {
    this.idle(); if (!this.active) fail('cannot prepare a disabled effect.'); this.validateSize(width, height);
    const pixels = width * height;
    const data = cameraData(camera), key = JSON.stringify([data.key, width, height, this.light, this.env, this.limits]);
    const reset = this.dirty || key !== this.committedKey, start = reset ? 0 : this.cursor;
    this.pending = { encoder, width, height, cameraKey: data.key, key, inverse: data.inverse, reset, start, count: Math.min(this.limits.pixelBatch, pixels - start), encoded: false };
    return { dispatchCalls: 0, uploadBytes: 0 };
  }
  private resize(width: number, height: number): Targets {
    if (this.targets?.width === width && this.targets.height === height) return this.targets;
    let accumulation: GPUBuffer | undefined, texture: GPUTexture | undefined;
    try {
      accumulation = this.device.createBuffer({ label: 'Strata imported indirect pixel state', size: width * height * pixelBytes, usage: 0x80 | 0x8 | 0x4 });
      texture = this.device.createTexture({ label: 'Strata imported indirect composed HDR', size: [width, height], format: 'rgba16float', usage: 0x1 | 0x4 | 0x8 });
      const view = texture.createView();
      const scene = this.device.createBindGroup({ layout: this.sceneLayout, entries: [...this.sourceBuffers.map((buffer, binding) => ({ binding, resource: { buffer } })), { binding: 4, resource: { buffer: accumulation } }, { binding: 5, resource: { buffer: this.diagnostics } }] });
      this.targets?.accumulation.destroy(); this.targets?.texture.destroy(); this.targets = { width, height, accumulation, texture, view, scene }; return this.targets;
    } catch (cause) { accumulation?.destroy(); texture?.destroy(); throw cause; }
  }
  compose(encoder: GPUCommandEncoder, outputs: RasterOutputs, camera: CameraFrame, width: number, height: number, _time: number, controls: RasterControls, timestamps: RasterTimestamps) {
    this.live();
    try {
      const p = this.pending;
      if (!p || p.encoded || p.encoder !== encoder || p.width !== width || p.height !== height || cameraData(camera).key !== p.cameraKey) throw new StrataError('RENDER_FAILED', 'Imported indirect compose must match its one pending prepare.');
      if (controls.temporal !== false) fail('progressive imported indirect requires temporal:false and an unjittered camera.');
      const target = this.resize(width, height), data = new ArrayBuffer(uniformBytes), f = new Float32Array(data), u = new Uint32Array(data);
      f.set(p.inverse); f.set(camera.viewProjection, 16); f.set(camera.eye, 32);
      u.set([width, height, p.start, p.count], 36); u.set([this.limits.maxSamples, this.limits.maxVisits, this.limits.seed, Number(this.material.doubleSided)], 40);
      f.set(this.light.directionToLight, 44); f.set(this.light.color.map(v => v * this.light.intensity), 48);
      f.set([['off', 'studio', 'sky', 'constant'].indexOf(this.env.mode), this.env.intensity, Math.cos(this.env.rotationRadians), Math.sin(this.env.rotationRadians)], 52);
      f.set(this.env.constantRadiance!, 56); f.set(this.material.baseColorFactor, 60);
      f.set([this.material.metallicFactor, 0, controls.debugView === 'indirect' ? 1 : controls.debugView === 'trace' ? 2 : 0, 0], 64);
      f.set(this.material.emissiveFactor.map(value => value * this.material.emissiveStrength), 68);
      this.device.queue.writeBuffer(this.uniform, 0, data);
      const screen = this.device.createBindGroup({ layout: this.screenLayout, entries: [{ binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: outputs.depth }, { binding: 2, resource: outputs.hdr }, { binding: 3, resource: target.view }] });
      if (p.reset) { encoder.clearBuffer(target.accumulation); encoder.clearBuffer(this.diagnostics); }
      const trace = encoder.beginComputePass({ label: 'Strata imported indirect trace', ...(timestamps['gi-trace'] ? { timestampWrites: timestamps['gi-trace'] } : {}) });
      trace.setPipeline(this.tracePipeline); trace.setBindGroup(0, screen); trace.setBindGroup(1, target.scene); trace.setBindGroup(2, this.materialGroup); trace.dispatchWorkgroups(Math.ceil(p.count / 64)); trace.end();
      const compose = encoder.beginComputePass({ label: 'Strata imported indirect composition', ...(timestamps['gi-shade'] ? { timestampWrites: timestamps['gi-shade'] } : {}) });
      compose.setPipeline(this.composePipeline); compose.setBindGroup(0, screen); compose.setBindGroup(1, target.scene); compose.setBindGroup(2, this.materialGroup); compose.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); compose.end();
      p.encoded = true; return { view: target.view, dispatchCalls: 2, uploadBytes: uniformBytes };
    } catch (cause) { this.cancelFrame(); throw cause; }
  }
  submitted(): void {
    this.live(); if (!this.active && !this.pending) return;
    const p = this.pending; if (!p?.encoded) throw new StrataError('RENDER_FAILED', 'Imported indirect submitted() requires an encoded frame.');
    if (p.reset) { this.revision++; this.submittedFrames = 0; }
    this.cursor = (p.start + p.count) % (p.width * p.height); this.committedKey = p.key; this.committedSize = [p.width, p.height]; this.submittedFrames++; this.dirty = false; this.pending = undefined;
  }
  cancelFrame(): void { if (this.disposed) return; this.pending = undefined; this.dirty = true; }
  async readProgress(): Promise<ImportedIndirectReadback> {
    this.idle(); if (this.dirty || !this.submittedFrames) fail('readProgress requires a submitted accumulation revision.');
    if (this.readback) throw new StrataError('RENDER_FAILED', 'Imported indirect diagnostic readback is already pending.');
    const progress = this.progress, buffer = this.device.createBuffer({ label: 'Strata imported indirect diagnostic readback', size: diagnosticBytes, usage: 0x1 | 0x8 }); this.readback = buffer;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const encoder = this.device.createCommandEncoder(); encoder.copyBufferToBuffer(this.diagnostics, 0, buffer, 0, diagnosticBytes); this.device.queue.submit([encoder.finish()]);
      await Promise.race([buffer.mapAsync(1), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StrataError('GPU_WORK_TIMEOUT', 'Imported indirect diagnostic readback timed out.')), 5000); })]);
      this.live(); const counters = new Uint32Array(buffer.getMappedRange()).slice(); buffer.unmap();
      return { ...progress, attempted: counters[0]!, completed: counters[1]!, exhausted: counters[2]!, invalid: counters[3]! };
    } finally { if (timer) clearTimeout(timer); if (this.readback === buffer) { this.readback = undefined; buffer.destroy(); } }
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.pending = undefined; this.readback?.destroy(); this.readback = undefined; for (const buffer of this.sourceBuffers) buffer.destroy(); this.uniform.destroy(); this.diagnostics.destroy(); this.targets?.accumulation.destroy(); this.targets?.texture.destroy(); this.targets = undefined; }
}
