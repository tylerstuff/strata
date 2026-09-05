import { StrataError } from '../errors.js';
import { buildProceduralScene, instanceStride, vertexStride } from './scene-data.js';
import type { ProceduralSceneOptions } from './scene-data.js';
import type { SceneFrameStats } from './scene-renderer.js';
import { cameraJitter, createLightMatrix, createMaterialTextures, createRasterCamera } from './raster-math.js';
import type { CameraFrame } from './raster-math.js';
import { presentationShader, rasterShader } from './raster-shaders.js';
import { TemporalResolve } from './temporal-resolve.js';
import type { RasterControls, RasterOutputs, RasterPassName, RasterTimestamps } from './raster-types.js';
import type { RasterGeometryProvider } from './geometry-provider.js';

const bufferUsage = { copyDestination: 0x8, index: 0x10, vertex: 0x20, uniform: 0x40 };
const textureUsage = { copyDestination: 0x2, binding: 0x4, attachment: 0x10 };
const shadowSize = 2048;
const materialSize = 64;
const frameUniformBytes = 352;
const presentationUniformBytes = 16;
const debugViews = ['final', 'direct', 'shadow', 'depth', 'normal', 'motion', 'material', 'clusters', 'lod', 'residency', 'coverage'] as const;

export function normalizeRasterControls(controls: RasterControls = {}): Required<RasterControls> {
  if (!controls || typeof controls !== 'object'
    || (controls.temporal !== undefined && typeof controls.temporal !== 'boolean')
    || (controls.cameraCut !== undefined && typeof controls.cameraCut !== 'boolean')
    || (controls.debugView !== undefined && !debugViews.includes(controls.debugView))) {
    throw new StrataError('INVALID_OPTIONS', 'Invalid raster controls.');
  }
  return { temporal: controls.temporal ?? true, debugView: controls.debugView ?? 'final', cameraCut: controls.cameraCut ?? false };
}

export interface RasterFrameState {
  readonly width: number;
  readonly height: number;
  readonly time: number;
  readonly temporal: boolean;
  readonly jitter: boolean;
}

export function mustResetHistory(previous: RasterFrameState | undefined, current: RasterFrameState, cameraCut: boolean): boolean {
  return cameraCut || !previous || previous.width !== current.width || previous.height !== current.height
    || previous.temporal !== current.temporal || previous.jitter !== current.jitter
    || current.time < previous.time || current.time - previous.time > 0.25;
}

interface Targets {
  readonly width: number;
  readonly height: number;
  readonly textures: readonly GPUTexture[];
  readonly views: RasterOutputs;
}

interface StaticResources {
  readonly buffers: readonly GPUBuffer[];
  readonly textures: readonly GPUTexture[];
  readonly vertices: GPUBuffer | undefined;
  readonly indices: GPUBuffer | undefined;
  readonly instances: GPUBuffer | undefined;
  readonly frameUniform: GPUBuffer;
  readonly presentationUniform: GPUBuffer;
  readonly shadowView: GPUTextureView;
  readonly rasterBindings: GPUBindGroup;
  readonly shadowBindings: GPUBindGroup;
  readonly rasterPipeline: GPURenderPipeline;
  readonly shadowPipeline: GPURenderPipeline;
  readonly presentationPipeline: GPURenderPipeline;
  readonly bufferBytes: number;
  readonly initialUploadBytes: number;
}

/** Textured direct-light foundation. Owns all intermediate views and integrates temporal resolve. */
export class RasterRenderer {
  private targets: Targets | undefined;
  private readonly presentationBindings = new Map<GPUTextureView, GPUBindGroup>();
  private previousState: RasterFrameState | undefined;
  private previousCamera: CameraFrame | undefined;
  private jitterIndex = 0;
  private historyReady = false;
  private disposed = false;
  private readonly lightMatrix: Float32Array<ArrayBuffer>;

  private constructor(
    private readonly device: GPUDevice,
    private readonly resources: StaticResources,
    private readonly temporal: TemporalResolve,
    private readonly instanceCount: number,
    private readonly halfExtent: number,
    private readonly geometry?: RasterGeometryProvider,
  ) { this.lightMatrix = geometry?.lightMatrix ?? createLightMatrix(halfExtent); }

  static async create(device: GPUDevice, format: GPUTextureFormat, options: ProceduralSceneOptions = {}, geometry?: RasterGeometryProvider): Promise<RasterRenderer> {
    const data = geometry ? undefined : buildProceduralScene(options);
    if (device.limits.maxTextureDimension2D < shadowSize) {
      throw new StrataError('UNSUPPORTED_LIMIT', `Raster shadows require ${shadowSize}-pixel textures.`);
    }
    const buffers: GPUBuffer[] = [];
    const textures: GPUTexture[] = [];
    let temporal: TemporalResolve | undefined;
    function buffer(label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer {
      if (size > device.limits.maxBufferSize) throw new StrataError('UNSUPPORTED_LIMIT', `${label} exceeds maxBufferSize.`);
      const value = device.createBuffer({ label, size, usage: usage | bufferUsage.copyDestination });
      buffers.push(value);
      return value;
    }
    function texture(label: string, size: number, textureFormat: GPUTextureFormat, usage: GPUTextureUsageFlags): GPUTexture {
      const value = device.createTexture({ label, size: [size, size], format: textureFormat, usage });
      textures.push(value);
      return value;
    }
    try {
      const vertexBuffers: GPUVertexBufferLayout[] = [
        { arrayStride: vertexStride, attributes: [
          { shaderLocation: 0, format: 'float32x3', offset: 0 },
          { shaderLocation: 1, format: 'float32x3', offset: 12 },
          { shaderLocation: 6, format: 'float32x2', offset: 24 },
        ] },
        { arrayStride: instanceStride, stepMode: 'instance', attributes: [
          { shaderLocation: 2, format: 'float32x3', offset: 0 },
          { shaderLocation: 3, format: 'float32x3', offset: 16 },
          { shaderLocation: 4, format: 'float32', offset: 28 },
          { shaderLocation: 5, format: 'float32x4', offset: 32 },
        ] },
      ];
      const module = device.createShaderModule({ label: 'Strata PBR and shadow shader', code: rasterShader + (geometry?.shaderSource ?? '') });
      const presentModule = device.createShaderModule({ label: 'Strata tone mapping and debug shader', code: presentationShader });
      const [rasterPipeline, shadowPipeline, presentationPipeline] = await Promise.all([
        device.createRenderPipelineAsync({
          label: 'Strata PBR MRT pipeline', layout: 'auto',
          vertex: { module, entryPoint: geometry?.vertexEntryPoint ?? 'vertexMain', buffers: geometry ? geometry.vertexBuffers ?? [] : vertexBuffers },
          fragment: { module, entryPoint: 'fragmentMain', targets: [
            { format: 'rgba16float' }, { format: 'rgba16float' }, { format: 'rgba8unorm' }, { format: 'rgba16float' },
          ] },
          primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
        }),
        device.createRenderPipelineAsync({
          label: 'Strata directional shadow pipeline', layout: 'auto',
          vertex: { module, entryPoint: geometry?.shadowEntryPoint ?? 'shadowMain', buffers: geometry ? geometry.vertexBuffers ?? [] : vertexBuffers },
          primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 },
        }),
        device.createRenderPipelineAsync({
          label: 'Strata presentation pipeline', layout: 'auto',
          vertex: { module: presentModule, entryPoint: 'vertexMain' },
          fragment: { module: presentModule, entryPoint: 'fragmentMain', targets: [{ format }] },
          primitive: { topology: 'triangle-list' },
        }),
      ]);
      const vertices = data ? buffer('Strata PBR vertices', data.vertices.byteLength, bufferUsage.vertex) : undefined;
      const indices = data ? buffer('Strata PBR indices', data.indices.byteLength, bufferUsage.index) : undefined;
      const instances = data ? buffer('Strata PBR instances', data.instances.byteLength, bufferUsage.vertex) : undefined;
      const frameUniform = buffer('Strata current and previous transforms', frameUniformBytes, bufferUsage.uniform);
      const presentationUniform = buffer('Strata presentation settings', presentationUniformBytes, bufferUsage.uniform);
      if (data) {
        device.queue.writeBuffer(vertices!, 0, data.vertices);
        device.queue.writeBuffer(indices!, 0, data.indices);
        device.queue.writeBuffer(instances!, 0, data.instances);
      }
      const material = createMaterialTextures(materialSize);
      const baseTexture = texture('Strata sRGB base-color fixture', materialSize, 'rgba8unorm-srgb', textureUsage.copyDestination | textureUsage.binding);
      const mrTexture = texture('Strata linear metallic-roughness fixture', materialSize, 'rgba8unorm', textureUsage.copyDestination | textureUsage.binding);
      device.queue.writeTexture({ texture: baseTexture }, material.baseColor, { bytesPerRow: materialSize * 4 }, [materialSize, materialSize]);
      device.queue.writeTexture({ texture: mrTexture }, material.metallicRoughness, { bytesPerRow: materialSize * 4 }, [materialSize, materialSize]);
      const shadowTexture = texture('Strata directional shadow depth', shadowSize, 'depth32float', textureUsage.binding | textureUsage.attachment);
      const shadowView = shadowTexture.createView();
      const materialSampler = device.createSampler({ label: 'Strata repeating material sampler', addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear' });
      const shadowSampler = device.createSampler({ label: 'Strata shadow comparison sampler', compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
      const shadowBindings = device.createBindGroup({ label: 'Strata shadow frame', layout: shadowPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: frameUniform } }] });
      const rasterBindings = device.createBindGroup({ label: 'Strata PBR materials and light', layout: rasterPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: frameUniform } },
        { binding: 1, resource: baseTexture.createView() }, { binding: 2, resource: mrTexture.createView() },
        { binding: 3, resource: materialSampler }, { binding: 4, resource: shadowView }, { binding: 5, resource: shadowSampler },
      ] });
      temporal = await TemporalResolve.create(device);
      geometry?.attachPipelines(rasterPipeline, shadowPipeline);
      const geometryBytes = data ? data.vertices.byteLength + data.indices.byteLength + data.instances.byteLength : 0;
      return new RasterRenderer(device, {
        buffers, textures, vertices, indices, instances, frameUniform, presentationUniform,
        shadowView, shadowBindings, rasterBindings, rasterPipeline, shadowPipeline, presentationPipeline,
        bufferBytes: geometryBytes + frameUniformBytes + presentationUniformBytes,
        initialUploadBytes: geometryBytes + material.baseColor.byteLength + material.metallicRoughness.byteLength,
      }, temporal, data?.instanceCount ?? 0, geometry?.halfExtent ?? data!.halfExtent, geometry);
    } catch (cause) {
      temporal?.dispose();
      for (const resource of [...buffers, ...textures]) resource.destroy();
      throw cause;
    }
  }

  get initialUploadBytes(): number { return this.resources.initialUploadBytes + this.temporal.initialUploadBytes + (this.geometry?.initialUploadBytes ?? 0); }
  get gpuBufferBytes(): number { return this.disposed ? 0 : this.resources.bufferBytes + this.temporal.gpuBufferBytes + (this.geometry?.gpuBufferBytes ?? 0); }
  get gpuTextureBytes(): number {
    if (this.disposed) return 0;
    return shadowSize * shadowSize * 4 + materialSize * materialSize * 8
      + (this.targets ? this.targets.width * this.targets.height * 32 : 0) + this.temporal.gpuTextureBytes;
  }
  get allocatedBytes(): number { return this.gpuBufferBytes + this.gpuTextureBytes; }
  /** Internal views remain owned by this renderer and expire on resize/disposal. */
  get outputs(): RasterOutputs | undefined { return this.targets?.views; }

  passNames(controls: RasterControls = {}): readonly RasterPassName[] {
    const geometryPass: RasterPassName[] = this.geometry?.selectionPass ? ['selection'] : [];
    return normalizeRasterControls(controls).temporal
      ? [...geometryPass, 'shadow', 'raster', 'temporal', 'presentation'] : [...geometryPass, 'shadow', 'raster', 'presentation'];
  }

  private resize(width: number, height: number): Targets {
    if (this.targets?.width === width && this.targets.height === height) return this.targets;
    const textures: GPUTexture[] = [];
    const make = (label: string, format: GPUTextureFormat): GPUTextureView => {
      const texture = this.device.createTexture({ label, size: [width, height], format, usage: textureUsage.binding | textureUsage.attachment });
      textures.push(texture);
      return texture.createView();
    };
    let views: RasterOutputs;
    try {
      views = {
        hdr: make('Strata linear HDR and shadow visibility', 'rgba16float'),
        normal: make('Strata world normals and roughness', 'rgba16float'),
        material: make('Strata linear base color and metallic', 'rgba8unorm'),
        motion: make('Strata motion and current/previous view depths', 'rgba16float'),
        depth: make('Strata raster depth', 'depth32float'),
      };
    } catch (cause) {
      for (const texture of textures) texture.destroy();
      throw cause;
    }
    for (const texture of this.targets?.textures ?? []) texture.destroy();
    this.presentationBindings.clear();
    this.targets = { width, height, textures, views };
    return this.targets;
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number, timeSeconds: number,
    controls: RasterControls = {}, timestamps: RasterTimestamps = {}): SceneFrameStats {
    if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'This raster scene has been disposed.');
    const settings = normalizeRasterControls(controls);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
      || width > this.device.limits.maxTextureDimension2D || height > this.device.limits.maxTextureDimension2D) {
      throw new StrataError('INVALID_SIZE', 'Raster dimensions must be positive integers within device limits.');
    }
    if (!Number.isFinite(timeSeconds)) throw new StrataError('INVALID_OPTIONS', 'Raster time must be finite.');
    const state: RasterFrameState = { width, height, time: timeSeconds, temporal: settings.temporal, jitter: settings.temporal && settings.debugView === 'final' };
    const reset = mustResetHistory(this.previousState, state, settings.cameraCut);
    if (reset) { this.jitterIndex = 0; this.historyReady = false; }
    const jitter = state.jitter ? cameraJitter(this.jitterIndex) : [0, 0] as const;
    const camera = this.geometry?.camera(width, height, timeSeconds, jitter) ?? createRasterCamera(width, height, timeSeconds, this.halfExtent, jitter);
    const previous = reset ? camera : this.previousCamera ?? camera;
    const previousTime = reset ? timeSeconds : this.previousState?.time ?? timeSeconds;
    const targets = this.resize(width, height);
    const prepared = this.geometry?.prepare(encoder, camera, width, height, reset, settings, timestamps.selection);
    const frameData = new Float32Array(frameUniformBytes / 4);
    frameData.set(camera.viewProjection, 0); frameData.set(previous.viewProjection, 16);
    frameData.set(camera.view, 32); frameData.set(previous.view, 48);
    frameData.set(this.lightMatrix, 64); frameData.set([...camera.eye, timeSeconds], 80);
    frameData.set([previousTime, camera.far, Math.max(0, debugViews.indexOf(settings.debugView) - 6), 0], 84);
    this.device.queue.writeBuffer(this.resources.frameUniform, 0, frameData);
    const presentationData = new ArrayBuffer(presentationUniformBytes);
    new Uint32Array(presentationData)[0] = debugViews.indexOf(settings.debugView);
    new Float32Array(presentationData).set([camera.far, 1], 2);
    this.device.queue.writeBuffer(this.resources.presentationUniform, 0, presentationData);
    const drawGeometry = (pass: GPURenderPassEncoder, pipeline: GPURenderPipeline, bindings: GPUBindGroup): void => {
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindings);
      if (this.geometry) this.geometry.draw(pass, pipeline === this.resources.shadowPipeline ? 'shadow' : 'raster');
      else {
        pass.setVertexBuffer(0, this.resources.vertices!); pass.setVertexBuffer(1, this.resources.instances!);
        pass.setIndexBuffer(this.resources.indices!, 'uint16'); pass.drawIndexed(36, this.instanceCount);
      }
      pass.end();
    };
    const shadow = encoder.beginRenderPass({ label: 'Strata directional shadow', colorAttachments: [],
      depthStencilAttachment: { view: this.resources.shadowView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      ...(timestamps.shadow ? { timestampWrites: timestamps.shadow } : {}) });
    drawGeometry(shadow, this.resources.shadowPipeline, this.resources.shadowBindings);
    const raster = encoder.beginRenderPass({ label: 'Strata PBR and shared geometry outputs', colorAttachments: [
      { view: targets.views.hdr, clearValue: { r: 0.02, g: 0.035, b: 0.055, a: 1 }, loadOp: 'clear', storeOp: 'store' },
      { view: targets.views.normal, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
      { view: targets.views.material, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
      { view: targets.views.motion, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
    ], depthStencilAttachment: { view: targets.views.depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    ...(timestamps.raster ? { timestampWrites: timestamps.raster } : {}) });
    drawGeometry(raster, this.resources.rasterPipeline, this.resources.rasterBindings);
    let resolved = targets.views.hdr;
    let drawCalls = (prepared?.drawCalls ?? 2) + 1;
    let dispatchCalls = prepared?.dispatchCalls ?? 0;
    let uploadBytes = frameUniformBytes + presentationUniformBytes + (prepared?.uploadBytes ?? 0);
    let triangles = (prepared?.triangles ?? this.instanceCount * 24) + 1;
    if (settings.temporal) {
      const temporal = this.temporal.encode(encoder, { hdr: targets.views.hdr, motion: targets.views.motion }, width, height,
        this.historyReady && !reset, timestamps.temporal);
      resolved = temporal.view;
      drawCalls += temporal.drawCalls; dispatchCalls += temporal.dispatchCalls; uploadBytes += temporal.uploadBytes;
      triangles += temporal.drawCalls;
    }
    let bindings = this.presentationBindings.get(resolved);
    if (!bindings) {
      bindings = this.device.createBindGroup({ label: 'Strata presentation views', layout: this.resources.presentationPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.resources.presentationUniform } }, { binding: 1, resource: resolved },
        { binding: 2, resource: targets.views.hdr }, { binding: 3, resource: targets.views.normal },
        { binding: 4, resource: targets.views.material }, { binding: 5, resource: targets.views.motion },
      ] });
      this.presentationBindings.set(resolved, bindings);
    }
    const presentation = encoder.beginRenderPass({ label: 'Strata tone mapping and debug presentation',
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      ...(timestamps.presentation ? { timestampWrites: timestamps.presentation } : {}) });
    presentation.setPipeline(this.resources.presentationPipeline); presentation.setBindGroup(0, bindings); presentation.draw(3); presentation.end();
    this.previousCamera = camera; this.previousState = state;
    this.historyReady = settings.temporal; this.jitterIndex = (this.jitterIndex + 1) % 8;
    return { drawCalls, dispatchCalls, triangles, uploadBytes, gpuBufferBytes: this.gpuBufferBytes, gpuTextureBytes: this.gpuTextureBytes };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.temporal.dispose();
    this.geometry?.dispose();
    for (const resource of [...this.resources.buffers, ...this.resources.textures, ...(this.targets?.textures ?? [])]) resource.destroy();
    this.targets = undefined;
    this.previousCamera = undefined;
    this.previousState = undefined;
    this.presentationBindings.clear();
  }
}
