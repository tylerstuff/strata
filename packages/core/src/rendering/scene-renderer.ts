import { StrataError } from '../errors.js';
import { buildProceduralScene, createCameraMatrix, instanceStride, vertexStride } from './scene-data.js';
import type { ProceduralSceneOptions } from './scene-data.js';

export type { ProceduralSceneOptions } from './scene-data.js';

// WebGPU flag values are fixed by the API; the TS DOM declarations omit their globals.
const bufferUsage = { copyDestination: 0x8, index: 0x10, vertex: 0x20, uniform: 0x40 };
const renderAttachmentUsage = 0x10;

export interface SceneFrameStats {
  readonly drawCalls: number;
  readonly dispatchCalls: number;
  readonly triangles: number;
  readonly uploadBytes: number;
  readonly gpuBufferBytes: number;
  readonly gpuTextureBytes: number;
}

const shader = /* wgsl */ `
struct Camera { viewProjection: mat4x4f, };
@group(0) @binding(0) var<uniform> camera: Camera;

struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) translation: vec3f,
  @location(3) scale: vec3f,
  @location(4) yaw: f32,
  @location(5) color: vec4f,
};
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) color: vec3f,
};
fn rotateY(value: vec3f, cosine: f32, sine: f32) -> vec3f {
  return vec3f(cosine * value.x + sine * value.z, value.y, -sine * value.x + cosine * value.z);
}
@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
  let cosine = cos(input.yaw);
  let sine = sin(input.yaw);
  let world = rotateY(input.position * input.scale, cosine, sine) + input.translation;
  var output: VertexOutput;
  output.position = camera.viewProjection * vec4f(world, 1.0);
  output.normal = normalize(rotateY(input.normal / input.scale, cosine, sine));
  output.color = input.color.rgb;
  return output;
}
@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let light = normalize(vec3f(0.35, 0.8, 0.4));
  let diffuse = max(dot(normalize(input.normal), light), 0.0);
  let linearColor = input.color * (0.14 + 0.86 * diffuse);
  return vec4f(pow(linearColor, vec3f(1.0 / 2.2)), 1.0);
}
`;

/** One owned raster pass for the versioned procedural benchmark scene. */
export class SceneRenderer {
  private depth: GPUTexture | undefined;
  private depthView: GPUTextureView | undefined;
  private width = 0;
  private height = 0;
  private disposed = false;

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPURenderPipeline,
    private readonly bindGroup: GPUBindGroup,
    private readonly vertices: GPUBuffer,
    private readonly indices: GPUBuffer,
    private readonly instances: GPUBuffer,
    private readonly camera: GPUBuffer,
    private readonly instanceCount: number,
    private readonly halfExtent: number,
    private readonly bufferBytes: number,
    readonly initialUploadBytes: number,
  ) {}

  static async create(device: GPUDevice, format: GPUTextureFormat, options: ProceduralSceneOptions = {}): Promise<SceneRenderer> {
    const data = buildProceduralScene(options);
    const owned: GPUBuffer[] = [];
    function upload(label: string, array: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>, usage: GPUBufferUsageFlags): GPUBuffer {
      if (array.byteLength > device.limits.maxBufferSize) {
        throw new StrataError('UNSUPPORTED_LIMIT', `${label} exceeds maxBufferSize.`);
      }
      const buffer = device.createBuffer({ label, size: array.byteLength, usage: usage | bufferUsage.copyDestination });
      owned.push(buffer);
      device.queue.writeBuffer(buffer, 0, array);
      return buffer;
    }
    try {
      const module = device.createShaderModule({ label: 'Strata procedural baseline shader', code: shader });
      const pipeline = await device.createRenderPipelineAsync({
        label: 'Strata procedural baseline pipeline',
        layout: 'auto',
        vertex: {
          module, entryPoint: 'vertexMain',
          buffers: [
            { arrayStride: vertexStride, attributes: [
              { shaderLocation: 0, format: 'float32x3', offset: 0 },
              { shaderLocation: 1, format: 'float32x3', offset: 12 },
            ] },
            { arrayStride: instanceStride, stepMode: 'instance', attributes: [
              { shaderLocation: 2, format: 'float32x3', offset: 0 },
              { shaderLocation: 3, format: 'float32x3', offset: 16 },
              { shaderLocation: 4, format: 'float32', offset: 28 },
              { shaderLocation: 5, format: 'float32x4', offset: 32 },
            ] },
          ],
        },
        fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
        primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
      });
      const vertices = upload('Strata cube vertices', data.vertices, bufferUsage.vertex);
      const indices = upload('Strata cube indices', data.indices, bufferUsage.index);
      const instances = upload('Strata box instances', data.instances, bufferUsage.vertex);
      const camera = device.createBuffer({ label: 'Strata camera', size: 64, usage: bufferUsage.uniform | bufferUsage.copyDestination });
      owned.push(camera);
      const bindGroup = device.createBindGroup({
        label: 'Strata camera bindings', layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: camera } }],
      });
      const initialUploadBytes = data.vertices.byteLength + data.indices.byteLength + data.instances.byteLength;
      return new SceneRenderer(device, pipeline, bindGroup, vertices, indices, instances, camera,
        data.instanceCount, data.halfExtent, initialUploadBytes + 64, initialUploadBytes);
    } catch (cause) {
      for (const buffer of owned) buffer.destroy();
      throw cause;
    }
  }

  get gpuBufferBytes(): number { return this.disposed ? 0 : this.bufferBytes; }
  /** Requested depth texel bytes; excludes driver padding and the browser-owned swapchain. */
  get gpuTextureBytes(): number { return this.disposed ? 0 : this.width * this.height * 4; }
  get allocatedBytes(): number { return this.gpuBufferBytes + this.gpuTextureBytes; }

  encode(
    encoder: GPUCommandEncoder, targetView: GPUTextureView, width: number, height: number,
    timeSeconds: number, timestampWrites?: GPURenderPassTimestampWrites,
  ): SceneFrameStats {
    if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'This scene has been disposed.');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > this.device.limits.maxTextureDimension2D || height > this.device.limits.maxTextureDimension2D) {
      throw new StrataError('INVALID_SIZE', 'Scene dimensions must be positive integers within device limits.');
    }
    const camera = createCameraMatrix(width / height, timeSeconds, this.halfExtent);
    if (this.width !== width || this.height !== height) {
      const depth = this.device.createTexture({
        label: 'Strata scene depth', size: [width, height], format: 'depth32float', usage: renderAttachmentUsage,
      });
      let view: GPUTextureView;
      try { view = depth.createView(); } catch (cause) { depth.destroy(); throw cause; }
      this.depth?.destroy();
      this.depth = depth;
      this.depthView = view;
      this.width = width;
      this.height = height;
    }
    this.device.queue.writeBuffer(this.camera, 0, camera);
    const pass = encoder.beginRenderPass({
      label: 'Strata procedural raster',
      colorAttachments: [{ view: targetView, clearValue: { r: 0.035, g: 0.055, b: 0.085, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: this.depthView!, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      ...(timestampWrites === undefined ? {} : { timestampWrites }),
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertices);
    pass.setVertexBuffer(1, this.instances);
    pass.setIndexBuffer(this.indices, 'uint16');
    pass.drawIndexed(36, this.instanceCount);
    pass.end();
    return {
      drawCalls: 1, dispatchCalls: 0, triangles: this.instanceCount * 12, uploadBytes: camera.byteLength,
      gpuBufferBytes: this.gpuBufferBytes, gpuTextureBytes: this.gpuTextureBytes,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.depth?.destroy();
    this.depth = undefined;
    this.depthView = undefined;
    this.vertices.destroy();
    this.indices.destroy();
    this.instances.destroy();
    this.camera.destroy();
  }
}
