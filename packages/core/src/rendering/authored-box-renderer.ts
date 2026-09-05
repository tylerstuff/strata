import { StrataError } from '../errors.js';
import { authoredBoxShader, authoredClearColor } from './authored-box-shaders.js';
import { AuthoredBoxValidationError, validateAuthoredBoxScene, validateAuthoredFrameCamera } from './authored-box-validation.js';
import { WorldCoordinateError, packWorldCoordinateFrame } from './world-coordinate-frame.js';
import type { AuthoredFrameMetadata, BoxCamera, BoxSceneDescriptor } from './authored-box-types.js';
import type { RasterPassName, RasterTimestamps } from './raster-types.js';
import type { SceneFrameStats } from './scene-renderer.js';

export interface AuthoredBoxControls {
  readonly camera?: BoxCamera;
  readonly debugView?: 'final' | 'base-color';
  readonly temporal?: false;
  readonly cameraCut?: boolean;
}

export interface AuthoredBoxFrameStats extends SceneFrameStats {
  readonly authored: AuthoredFrameMetadata;
}

const usage = { copyDestination: 0x8, index: 0x10, vertex: 0x20, uniform: 0x40 };
const frameBytes = 176;
const passes: readonly RasterPassName[] = Object.freeze(['raster']);

interface Resources {
  readonly pipeline: GPURenderPipeline;
  readonly bindGroup: GPUBindGroup;
  readonly vertices: GPUBuffer;
  readonly indices: GPUBuffer;
  readonly models: GPUBuffer;
  readonly previousModels: GPUBuffer;
  readonly normals: GPUBuffer;
  readonly materials: GPUBuffer;
  readonly frame: GPUBuffer;
}

interface SubmittedView {
  frameId: number;
  readonly packed: Pick<ReturnType<typeof pack>, 'camera' | 'origin' | 'viewProjection' | 'modelMatrices'>;
  readonly width: number;
  readonly height: number;
}

function unitCube(): { vertices: Float32Array<ArrayBuffer>; indices: Uint16Array<ArrayBuffer> } {
  // Outward CCW faces with independent flat normals. Dimensions belong to the
  // shared coordinate packer; these vertices always stay within [-0.5, 0.5].
  const faces = [
    { normal: [0, 0, 1], points: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { normal: [0, 0, -1], points: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
    { normal: [1, 0, 0], points: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
    { normal: [-1, 0, 0], points: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
    { normal: [0, 1, 0], points: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
    { normal: [0, -1, 0], points: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  ];
  const vertices = new Float32Array(24 * 6);
  const indices = new Uint16Array(36);
  for (const [faceIndex, face] of faces.entries()) {
    for (const [vertexIndex, point] of face.points.entries()) {
      vertices.set([...point.map(value => value * 0.5), ...face.normal], (faceIndex * 4 + vertexIndex) * 6);
    }
    indices.set([0, 1, 2, 0, 2, 3].map(index => faceIndex * 4 + index), faceIndex * 6);
  }
  return { vertices, indices };
}

function validateControls(controls: AuthoredBoxControls): 'final' | 'base-color' {
  if (controls === null || typeof controls !== 'object') throw new StrataError('INVALID_OPTIONS', 'Authored render controls must be an object.');
  if (controls.temporal !== undefined && controls.temporal !== false) {
    throw new StrataError('UNSUPPORTED_FEATURE', 'Authored boxes do not support temporal rendering.');
  }
  if (controls.debugView !== undefined && controls.debugView !== 'final' && controls.debugView !== 'base-color') {
    throw new StrataError('UNSUPPORTED_FEATURE', 'Authored boxes support only final and base-color views.');
  }
  if (controls.cameraCut !== undefined && typeof controls.cameraCut !== 'boolean') {
    throw new StrataError('INVALID_OPTIONS', 'cameraCut must be boolean.');
  }
  return controls.debugView ?? 'final';
}

function pack(scene: BoxSceneDescriptor, camera: BoxCamera, aspect: number) {
  try {
    return packWorldCoordinateFrame(scene.boxes, camera, {
      verticalFovRadians: camera.projection.verticalFovRadians,
      near: camera.projection.near, far: camera.projection.far, aspect,
    });
  } catch (cause) {
    if (!(cause instanceof WorldCoordinateError)) throw cause;
    const error = new AuthoredBoxValidationError('UNSUPPORTED_LIMIT', cause.path, cause.reason);
    error.cause = cause;
    throw error;
  }
}

/** Optional root-box renderer with submitted camera motion; no temporal resolve. */
export class AuthoredBoxRenderer {
  private depth: GPUTexture | undefined;
  private depthView: GPUTextureView | undefined;
  private motion: GPUTexture | undefined;
  private motionView: GPUTextureView | undefined;
  private readonly ownedTextures = new Map<GPUTexture, number>();
  private width = 0;
  private height = 0;
  private disposed = false;
  private previous: SubmittedView | undefined;
  private pending: SubmittedView | undefined;
  private readonly frameValues = new Float32Array(frameBytes / 4);
  private readonly frameSettings = new Uint32Array(this.frameValues.buffer);
  private readonly clearColor: GPUColorDict;

  private constructor(
    private readonly device: GPUDevice,
    format: GPUTextureFormat,
    private readonly scene: BoxSceneDescriptor,
    private readonly resources: Resources | undefined,
    private readonly ownedBuffers: Map<GPUBuffer, number>,
    readonly initialUploadBytes: number,
  ) {
    this.clearColor = authoredClearColor(scene.background, format.endsWith('-srgb'));
    const direction = scene.light.directionToLight;
    const length = Math.hypot(...direction);
    this.frameValues.set(direction.map(value => value / length), 32);
    this.frameValues.set(scene.light.radiance, 36);
  }

  static async create(
    device: GPUDevice, format: GPUTextureFormat, input: BoxSceneDescriptor,
  ): Promise<AuthoredBoxRenderer> {
    // Snapshot before the first async boundary, even for direct internal callers.
    const scene = validateAuthoredBoxScene(input);
    const camera = validateAuthoredFrameCamera(scene, scene.camera, 1, 1);
    const initialFrame = pack(scene, camera, 1);
    const owned = new Map<GPUBuffer, number>();
    if (scene.boxes.length === 0) return new AuthoredBoxRenderer(device, format, scene, undefined, owned, 0);
    // Canvas unorm formats cost eight attachment bytes per sample; rgba32float
    // costs sixteen. It is unblended/single-sample and requires no float feature.
    if (device.limits.maxVertexAttributes < 15 || device.limits.maxVertexBuffers < 5
      || device.limits.maxInterStageShaderVariables < 6 || device.limits.maxColorAttachments < 2
      || device.limits.maxColorAttachmentBytesPerSample < 24) {
      throw new StrataError('UNSUPPORTED_LIMIT', 'Authored motion exceeds the device vertex or color attachment limits.');
    }
    const cube = unitCube();
    const materialValues = new Float32Array(scene.boxes.length * 8);
    for (const [index, box] of scene.boxes.entries()) {
      materialValues.set([...box.material.baseColor.slice(0, 3), box.material.metallic, box.material.roughness], index * 8);
    }
    const sizes = [cube.vertices.byteLength, cube.indices.byteLength, initialFrame.modelMatrices.byteLength,
      initialFrame.normalMatrices.byteLength, materialValues.byteLength, frameBytes];
    if (sizes.some(size => size > device.limits.maxBufferSize)) {
      throw new StrataError('UNSUPPORTED_LIMIT', 'Authored box buffers exceed maxBufferSize.');
    }
    function allocate(label: string, size: number, flags: GPUBufferUsageFlags): GPUBuffer {
      const buffer = device.createBuffer({ label, size, usage: flags | usage.copyDestination });
      owned.set(buffer, size);
      return buffer;
    }
    function upload(label: string, data: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>, flags: GPUBufferUsageFlags): GPUBuffer {
      const buffer = allocate(label, data.byteLength, flags);
      device.queue.writeBuffer(buffer, 0, data);
      return buffer;
    }
    try {
      const module = device.createShaderModule({ label: 'Strata authored root boxes direct PBR', code: authoredBoxShader(format.endsWith('-srgb')) });
      const pipeline = await device.createRenderPipelineAsync({
        label: 'Strata authored root boxes pipeline', layout: 'auto',
        vertex: {
          module, entryPoint: 'vertexMain', buffers: [
            { arrayStride: 24, attributes: [
              { shaderLocation: 0, format: 'float32x3', offset: 0 }, { shaderLocation: 1, format: 'float32x3', offset: 12 },
            ] },
            { arrayStride: 64, stepMode: 'instance', attributes: [
              { shaderLocation: 2, format: 'float32x4', offset: 0 }, { shaderLocation: 3, format: 'float32x4', offset: 16 },
              { shaderLocation: 4, format: 'float32x4', offset: 32 }, { shaderLocation: 5, format: 'float32x4', offset: 48 },
            ] },
            { arrayStride: 48, stepMode: 'instance', attributes: [
              { shaderLocation: 6, format: 'float32x3', offset: 0 }, { shaderLocation: 7, format: 'float32x3', offset: 16 },
              { shaderLocation: 8, format: 'float32x3', offset: 32 },
            ] },
            { arrayStride: 32, stepMode: 'instance', attributes: [
              { shaderLocation: 9, format: 'float32x4', offset: 0 }, { shaderLocation: 10, format: 'float32', offset: 16 },
            ] },
            { arrayStride: 64, stepMode: 'instance', attributes: [
              { shaderLocation: 11, format: 'float32x4', offset: 0 }, { shaderLocation: 12, format: 'float32x4', offset: 16 },
              { shaderLocation: 13, format: 'float32x4', offset: 32 }, { shaderLocation: 14, format: 'float32x4', offset: 48 },
            ] },
          ],
        },
        fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }, { format: 'rgba32float' }] },
        primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
        depthStencil: { format: 'depth32float', depthCompare: 'less', depthWriteEnabled: true },
      });
      const vertices = upload('Strata authored unit cube vertices', cube.vertices, usage.vertex);
      const indices = upload('Strata authored unit cube indices', cube.indices, usage.index);
      const models = allocate('Strata authored relative models', initialFrame.modelMatrices.byteLength, usage.vertex);
      const previousModels = allocate('Strata authored previous relative models', initialFrame.modelMatrices.byteLength, usage.vertex);
      const normals = upload('Strata authored inverse-transpose normals', initialFrame.normalMatrices, usage.vertex);
      const materials = upload('Strata authored box materials', materialValues, usage.vertex);
      const frame = allocate('Strata authored camera and light', frameBytes, usage.uniform);
      const bindGroup = device.createBindGroup({
        label: 'Strata authored frame bindings', layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: frame } }],
      });
      const initialBytes = cube.vertices.byteLength + cube.indices.byteLength + initialFrame.normalMatrices.byteLength + materialValues.byteLength;
      return new AuthoredBoxRenderer(device, format, scene,
        { pipeline, bindGroup, vertices, indices, models, previousModels, normals, materials, frame }, owned, initialBytes);
    } catch (cause) {
      const failures: unknown[] = [];
      for (const buffer of owned.keys()) {
        try { buffer.destroy(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError([cause, ...failures], 'Authored renderer creation and cleanup failed.', { cause });
      throw cause;
    }
  }

  get gpuBufferBytes(): number { return [...this.ownedBuffers.values()].reduce((sum, bytes) => sum + bytes, 0); }
  /** Requested depth/motion texel bytes; excludes driver padding and swapchain. */
  get gpuTextureBytes(): number { return [...this.ownedTextures.values()].reduce((sum, bytes) => sum + bytes, 0); }
  /** Internal browser validation readback; ownership stays with this renderer. */
  get depthTexture(): GPUTexture | undefined { return this.depth; }
  /** Internal rgba32float readback; XY motion, Z current depth, W prior depth. */
  get motionTexture(): GPUTexture | undefined { return this.motion; }

  passNames(controls: AuthoredBoxControls = {}): readonly RasterPassName[] {
    if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'This authored scene has been disposed.');
    validateControls(controls);
    return passes;
  }

  private resizeTargets(width: number, height: number): void {
    if (!this.resources || (this.width === width && this.height === height)) return;
    const created: GPUTexture[] = [];
    const create = (label: string, format: GPUTextureFormat, texelBytes: number) => {
      const texture = this.device.createTexture({ label, size: [width, height], format, usage: 0x10 | 0x1 });
      this.ownedTextures.set(texture, width * height * texelBytes);
      created.push(texture);
      return { texture, view: texture.createView() };
    };
    let depth: ReturnType<typeof create>, motion: ReturnType<typeof create>;
    try {
      depth = create('Strata authored box depth', 'depth32float', 4);
      motion = create('Strata authored box motion', 'rgba32float', 16);
    } catch (cause) {
      const failures: unknown[] = [];
      for (const texture of created) {
        try { texture.destroy(); this.ownedTextures.delete(texture); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError([cause, ...failures], 'Authored target creation and cleanup failed.', { cause });
      throw cause;
    }
    const oldTargets = [this.depth, this.motion];
    this.depth = depth.texture; this.depthView = depth.view;
    this.motion = motion.texture; this.motionView = motion.view;
    this.width = width; this.height = height;
    const failures: unknown[] = [];
    for (const previous of oldTargets) {
      if (previous) {
        try { previous.destroy(); this.ownedTextures.delete(previous); } catch (error) { failures.push(error); }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Authored target retirement failed.');
  }

  encode(
    encoder: GPUCommandEncoder, target: GPUTextureView, width: number, height: number, timeSeconds: number,
    controls: AuthoredBoxControls = {}, timestamps?: RasterTimestamps,
  ): AuthoredBoxFrameStats {
    if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'This authored scene has been disposed.');
    if (this.pending) throw new StrataError('RENDER_FAILED', 'Submit or cancel the previous authored encode before encoding another frame.');
    const debugView = validateControls(controls);
    if (!Number.isFinite(timeSeconds)) throw new StrataError('INVALID_OPTIONS', 'timeSeconds must be finite.');
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width > this.device.limits.maxTextureDimension2D || height > this.device.limits.maxTextureDimension2D) {
      throw new StrataError('INVALID_SIZE', 'Authored viewport dimensions must fit the device.');
    }
    // Both the override and all box-relative bounds are checked before resource
    // changes or writes. All world subtraction/matrices belong to the packer.
    const camera = validateAuthoredFrameCamera(this.scene, controls.camera === undefined ? this.scene.camera : controls.camera, width, height);
    const aspect = width / height;
    const packed = pack(this.scene, camera, aspect);
    const previous = this.previous;
    // Compare against the submitted viewport, not potentially resized resources
    // left by an unsubmitted attempt. An origin/lens change is not a camera cut.
    const resetReason = !previous ? 'first-frame' : controls.cameraCut ? 'camera-cut'
      : previous.width !== width || previous.height !== height ? 'viewport-change' : null;
    const motionValid = resetReason === null;
    const motion = Object.freeze({ previousSubmittedFrameId: previous?.frameId ?? null, valid: motionValid, resetReason });
    const authored: AuthoredFrameMetadata = Object.freeze({
      camera: Object.freeze({
        position: camera.position, rotation: Object.freeze([...packed.camera.rotation]) as BoxCamera['rotation'],
        projection: camera.projection,
      }),
      origin: Object.freeze([...packed.origin]) as AuthoredFrameMetadata['origin'],
      aspect, width, height, debugView, timeSeconds, motion,
    });
    this.resizeTargets(width, height);
    let uploadBytes = 0;
    if (this.resources) {
      this.frameValues.set(packed.viewProjection);
      this.frameValues.set(previous?.packed.viewProjection ?? packed.viewProjection, 16);
      this.frameSettings.set([debugView === 'base-color' ? 1 : 0, motionValid ? 1 : 0, width, height], 40);
      // writeBuffer is queue work even if a later encode/submit fails. Restore
      // every frame input from CPU snapshots on every attempt, including prior.
      this.device.queue.writeBuffer(this.resources.models, 0, packed.modelMatrices);
      this.device.queue.writeBuffer(this.resources.previousModels, 0, previous?.packed.modelMatrices ?? packed.modelMatrices);
      this.device.queue.writeBuffer(this.resources.frame, 0, this.frameValues);
      uploadBytes = packed.modelMatrices.byteLength * 2 + this.frameValues.byteLength;
    }
    const pass = encoder.beginRenderPass({
      label: 'Strata authored boxes raster',
      colorAttachments: [
        { view: target, clearValue: this.clearColor, loadOp: 'clear', storeOp: 'store' },
        ...(this.resources ? [{ view: this.motionView!, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear' as const, storeOp: 'store' as const }] : []),
      ],
      ...(this.resources ? { depthStencilAttachment: {
        view: this.depthView!, depthClearValue: 1, depthLoadOp: 'clear' as const, depthStoreOp: 'store' as const,
      } } : {}),
      ...(timestamps?.raster === undefined ? {} : { timestampWrites: timestamps.raster }),
    });
    if (this.resources) {
      pass.setPipeline(this.resources.pipeline);
      pass.setBindGroup(0, this.resources.bindGroup);
      pass.setVertexBuffer(0, this.resources.vertices);
      pass.setVertexBuffer(1, this.resources.models);
      pass.setVertexBuffer(2, this.resources.normals);
      pass.setVertexBuffer(3, this.resources.materials);
      pass.setVertexBuffer(4, this.resources.previousModels);
      pass.setIndexBuffer(this.resources.indices, 'uint16');
      pass.drawIndexed(36, this.scene.boxes.length);
    }
    pass.end();
    this.pending = { frameId: 0, width, height, packed: {
      camera: packed.camera, origin: packed.origin, viewProjection: packed.viewProjection, modelMatrices: packed.modelMatrices,
    } };
    return {
      authored, drawCalls: this.resources ? 1 : 0, dispatchCalls: 0, triangles: this.scene.boxes.length * 12,
      uploadBytes, gpuBufferBytes: this.gpuBufferBytes, gpuTextureBytes: this.gpuTextureBytes,
    };
  }

  /** Infallible acknowledgement immediately after the queue.submit call returns. */
  submitted(frameId: number): void {
    if (!this.pending) return;
    this.pending.frameId = frameId;
    this.previous = this.pending;
    this.pending = undefined;
  }

  /** Discard only unsubmitted work; a completed acknowledgement cannot roll back. */
  cancelFrame(): void { this.pending = undefined; }

  dispose(): void {
    this.disposed = true;
    this.pending = undefined;
    this.previous = undefined;
    const failures: unknown[] = [];
    for (const depth of this.ownedTextures.keys()) {
      try {
        depth.destroy(); this.ownedTextures.delete(depth);
        if (depth === this.depth) { this.depth = undefined; this.depthView = undefined; }
        if (depth === this.motion) { this.motion = undefined; this.motionView = undefined; }
      } catch (error) { failures.push(error); }
    }
    for (const buffer of this.ownedBuffers.keys()) {
      try { buffer.destroy(); this.ownedBuffers.delete(buffer); } catch (error) { failures.push(error); }
    }
    // Successful resources are retired once; a failed destroy remains owned for
    // a caller's cleanup retry and remains visible in allocation telemetry.
    if (failures.length) throw new AggregateError(failures, 'Authored renderer cleanup failed.');
  }
}
