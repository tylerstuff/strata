import { StrataError } from '../errors.js';
import type { RasterGeometryProvider } from '../rendering/geometry-provider.js';
import { createLightMatrix } from '../rendering/raster-math.js';
import type { CameraFrame } from '../rendering/raster-math.js';
import type { RasterControls } from '../rendering/raster-types.js';
import { createGiCamera } from '../gi/room-geometry.js';
import type { GiCameraMode } from '../gi/room-geometry.js';
import { triangulateGiScene } from '../gi/scene-data.js';
import type { ReflectionSceneData } from './reflection-scene.js';

const vertexStride = 60;
const reflectionGeometryShader = /* wgsl */ `
struct ReflectionLight { direction: vec4f, radiance: vec4f, };
@group(1) @binding(0) var<uniform> reflectionLight: ReflectionLight;
struct ReflectionInput {
  @location(0) position: vec3f, @location(1) normal: vec3f, @location(2) albedo: vec3f,
  @location(3) emission: vec3f, @location(4) material: vec2f, @location(5) changed: f32,
};
@vertex fn reflectionShadowMain(input: ReflectionInput) -> @builtin(position) vec4f {
  return frame.lightViewProjection * vec4f(input.position, 1.0);
}
@vertex fn reflectionVertexMain(input: ReflectionInput) -> VertexOutput {
  let world = vec4f(input.position, 1.0);
  var output: VertexOutput;
  output.currentClip = frame.viewProjection * world; output.previousClip = frame.previousViewProjection * world;
  output.position = output.currentClip; output.world = input.position; output.normal = input.normal;
  output.color = input.albedo; output.uv = vec2f(0.0); output.roughness = input.material.x; output.metallic = input.material.y;
  output.viewDepths = vec2f(-(frame.view * world).z, select(-(frame.previousView * world).z, -1.0, input.changed > 0.5));
  // This geometry's flat payload carries the exact source material emission.
  output.debugColor = input.emission;
  return output;
}
@fragment fn reflectionFragmentMain(input: VertexOutput) -> GBufferOutput {
  let normal = normalize(input.normal); let shadow = shadowVisibility(input.world);
  let direct = input.debugColor + input.color * (1.0 - input.metallic) / 3.14159265
    * max(dot(normal, reflectionLight.direction.xyz), 0.0) * reflectionLight.radiance.xyz * shadow;
  let currentUV = input.currentClip.xy / input.currentClip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  let previousUV = input.previousClip.xy / input.previousClip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  var output: GBufferOutput;
  output.hdr = vec4f(direct, shadow); output.normal = vec4f(normal, input.roughness);
  output.material = vec4f(input.color, input.metallic); output.motion = vec4f(previousUV - currentUV, input.viewDepths);
  return output;
}
`;

/** Float32 vertex data comes from the exact closed boxes shared by raster and tracing. */
export function packReflectionGeometry(scene: ReflectionSceneData, changedBoxes: ReadonlySet<number> = new Set()): Float32Array<ArrayBuffer> {
  const triangles = triangulateGiScene(scene); const result = new Float32Array(triangles.length * 3 * vertexStride / 4);
  let offset = 0;
  for (const triangle of triangles) {
    const material = scene.materials[triangle.materialId]!;
    for (const point of [triangle.p0, triangle.p1, triangle.p2]) {
      result.set(point, offset); result.set(triangle.normal, offset + 3); result.set(material.albedo, offset + 6);
      result.set(material.emission, offset + 9);
      result.set([material.roughness, material.metallic ?? 0, changedBoxes.has(triangle.boxId) ? 1 : 0], offset + 12); offset += 15;
    }
  }
  return result;
}

/** Selected reflector and movable emitter, preserving the independent GI room implementation. */
export class ReflectionGeometry implements RasterGeometryProvider {
  readonly selectionPass = false;
  readonly shaderSource = reflectionGeometryShader;
  readonly vertexEntryPoint = 'reflectionVertexMain';
  readonly shadowEntryPoint = 'reflectionShadowMain';
  readonly fragmentEntryPoint = 'reflectionFragmentMain';
  readonly usesMaterialTextures = false;
  readonly halfExtent = 6.1;
  readonly lightMatrix = createLightMatrix(this.halfExtent);
  readonly vertexBuffers: GPUVertexBufferLayout[] = [{ arrayStride: vertexStride, attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x3' }, { shaderLocation: 3, offset: 36, format: 'float32x3' },
    { shaderLocation: 4, offset: 48, format: 'float32x2' }, { shaderLocation: 5, offset: 56, format: 'float32' },
  ] }];
  private readonly vertices: GPUBuffer;
  private readonly light: GPUBuffer;
  private readonly bytes: number;
  private readonly vertexCount: number;
  private bindings: GPUBindGroup | undefined;
  private pendingScene: ReflectionSceneData | undefined;
  private clearMotion = false;
  private disposed = false;
  currentCamera: CameraFrame | undefined;

  constructor(private readonly device: GPUDevice, private scene: ReflectionSceneData, private readonly cameraMode: GiCameraMode = 'receiver') {
    const data = packReflectionGeometry(scene); this.bytes = data.byteLength; this.vertexCount = data.length / 15;
    if (this.bytes > device.limits.maxBufferSize) throw new StrataError('UNSUPPORTED_LIMIT', 'Reflection geometry exceeds device buffer limits.');
    const buffers: GPUBuffer[] = [];
    try {
      this.vertices = device.createBuffer({ label: 'Strata reflection fixture vertices', size: this.bytes, usage: 0x20 | 0x8 }); buffers.push(this.vertices);
      this.light = device.createBuffer({ label: 'Strata reflection fixture light', size: 32, usage: 0x40 | 0x8 }); buffers.push(this.light);
      device.queue.writeBuffer(this.vertices, 0, data); this.uploadLight(scene);
    } catch (cause) { for (const buffer of buffers) buffer.destroy(); throw cause; }
  }
  private uploadLight(scene: ReflectionSceneData): void {
    const data = new Float32Array(8); data.set(scene.light.direction, 0); data.set(scene.light.radiance, 4);
    this.device.queue.writeBuffer(this.light, 0, data);
  }
  setScene(scene: ReflectionSceneData): void { this.pendingScene = scene; }
  get initialUploadBytes(): number { return this.bytes + 32; }
  get gpuBufferBytes(): number { return this.disposed ? 0 : this.initialUploadBytes; }
  camera(width: number, height: number, time: number, jitter: readonly [number, number]): CameraFrame {
    const camera = createGiCamera(width, height, time, jitter, this.cameraMode); this.currentCamera = camera; return camera;
  }
  attachPipelines(raster: GPURenderPipeline, _shadow: GPURenderPipeline): void {
    this.bindings = this.device.createBindGroup({ label: 'Strata reflection fixture raster light', layout: raster.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer: this.light } }] });
  }
  prepare(_encoder: GPUCommandEncoder, _camera: CameraFrame, _width: number, _height: number, _reset: boolean, _controls: RasterControls) {
    if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'Reflection geometry was disposed.');
    let uploadBytes = 0;
    if (this.pendingScene || this.clearMotion) {
      const next = this.pendingScene ?? this.scene; const changed = new Set<number>();
      for (const box of next.boxes) {
        const previous = this.scene.boxes[box.id];
        if (!previous || previous.yaw !== box.yaw || previous.center.some((value, axis) => value !== box.center[axis])) changed.add(box.id);
      }
      const data = packReflectionGeometry(next, changed);
      if (data.byteLength !== this.bytes) throw new StrataError('INVALID_OPTIONS', 'Reflection fixture topology changed.');
      this.device.queue.writeBuffer(this.vertices, 0, data); uploadBytes += data.byteLength;
      if (this.pendingScene) { this.uploadLight(next); uploadBytes += 32; }
      this.scene = next; this.pendingScene = undefined; this.clearMotion = changed.size > 0;
    }
    return { uploadBytes, dispatchCalls: 0, triangles: this.vertexCount / 3 * 2, drawCalls: 2 };
  }
  draw(pass: GPURenderPassEncoder, phase: 'raster' | 'shadow'): void {
    if (!this.bindings || this.disposed) throw new StrataError('RENDER_FAILED', 'Reflection geometry is unavailable.');
    if (phase === 'raster') pass.setBindGroup(1, this.bindings);
    pass.setVertexBuffer(0, this.vertices); pass.draw(this.vertexCount);
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.vertices.destroy(); this.light.destroy(); }
}
