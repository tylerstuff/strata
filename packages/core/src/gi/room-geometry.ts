import { StrataError } from '../errors.js';
import type { RasterGeometryProvider } from '../rendering/geometry-provider.js';
import { createLightMatrix, lookAtMatrix, multiplyMatrices } from '../rendering/raster-math.js';
import type { CameraFrame, Vec3 } from '../rendering/raster-math.js';
import type { RasterControls } from '../rendering/raster-types.js';
import { triangulateGiScene } from './scene-data.js';
import type { GiSceneData } from './scene-data.js';

export type GiCameraMode = 'receiver' | 'overview' | 'tour';

export function createGiCamera(width: number, height: number, time: number, jitter: readonly [number, number], mode: GiCameraMode): CameraFrame {
  const eye: Vec3 = mode === 'overview' ? [-8, 8, 11]
    : mode === 'tour' ? [-3 + 0.3 * Math.sin(time * 0.2), 2.4, 0.2 + 0.15 * Math.cos(time * 0.2)] : [-3, 2.4, 0.2];
  const target: Vec3 = mode === 'overview' ? [0, 1, 0] : [-1.5, 0.01, 0.2];
  const view = lookAtMatrix(eye, target);
  const near = 0.05; const far = 50; const scale = 1 / Math.tan(mode === 'overview' ? Math.PI / 8 : Math.PI / 12);
  const projection = new Float32Array([
    scale / (width / height), 0, 0, 0,
    0, scale, 0, 0,
    -2 * jitter[0] / width, 2 * jitter[1] / height, far / (near - far), -1,
    0, 0, near * far / (near - far), 0,
  ]);
  return { eye, view, far, projectionScaleY: scale, orthographic: false, viewProjection: multiplyMatrices(projection, view) };
}

export function invertGiMatrix(matrix: Float32Array): Float32Array<ArrayBuffer> {
  const rows = Array.from({ length: 4 }, (_, row) => Array.from({ length: 8 }, (_, column) => column < 4 ? matrix[column * 4 + row]! : Number(column - 4 === row)));
  for (let column = 0; column < 4; column++) {
    let pivot = column;
    for (let row = column + 1; row < 4; row++) if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
    const divisor = rows[column]![column]!;
    if (Math.abs(divisor) < 1e-12) throw new StrataError('INVALID_OPTIONS', 'GI camera matrix is singular.');
    for (let entry = 0; entry < 8; entry++) rows[column]![entry]! /= divisor;
    for (let row = 0; row < 4; row++) {
      if (row === column) continue;
      const amount = rows[row]![column]!;
      for (let entry = 0; entry < 8; entry++) rows[row]![entry]! -= amount * rows[column]![entry]!;
    }
  }
  return Float32Array.from({ length: 16 }, (_, index) => rows[index % 4]![4 + Math.floor(index / 4)]!);
}

const roomShader = /* wgsl */ `
struct RoomLight { direction: vec4f, radiance: vec4f, };
@group(1) @binding(0) var<uniform> roomLight: RoomLight;
struct RoomInput { @location(0) position: vec3f, @location(1) normal: vec3f, @location(2) albedo: vec3f, };
@vertex fn roomShadowMain(input: RoomInput) -> @builtin(position) vec4f {
  return frame.lightViewProjection * vec4f(input.position, 1.0);
}
@vertex fn roomVertexMain(input: RoomInput) -> VertexOutput {
  let world = vec4f(input.position, 1.0);
  var output: VertexOutput;
  output.currentClip = frame.viewProjection * world; output.previousClip = frame.previousViewProjection * world;
  output.position = output.currentClip; output.world = input.position; output.normal = input.normal;
  output.color = input.albedo; output.uv = vec2f(0.0); output.metallic = 0.0; output.roughness = 1.0;
  output.viewDepths = vec2f(-(frame.view * world).z, -(frame.previousView * world).z);
  output.debugColor = vec3f(1.0);
  return output;
}
@fragment fn roomFragmentMain(input: VertexOutput) -> GBufferOutput {
  let normal = normalize(input.normal);
  let shadow = shadowVisibility(input.world);
  let direct = input.color / 3.14159265 * max(dot(normal, roomLight.direction.xyz), 0.0) * roomLight.radiance.xyz * shadow;
  let currentUV = input.currentClip.xy / input.currentClip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  let previousUV = input.previousClip.xy / input.previousClip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  var output: GBufferOutput;
  output.hdr = vec4f(direct, shadow);
  if (frame.parameters.z > 0.5) { output.hdr = vec4f(input.debugColor, 1.0); }
  output.normal = vec4f(normal, 1.0); output.material = vec4f(input.color, 0.0);
  output.motion = vec4f(previousUV - currentUV, input.viewDepths);
  return output;
}
`;

function packRoom(scene: GiSceneData): Float32Array<ArrayBuffer> {
  const triangles = triangulateGiScene(scene);
  const result = new Float32Array(triangles.length * 27);
  let offset = 0;
  for (const triangle of triangles) for (const point of [triangle.p0, triangle.p1, triangle.p2]) {
    result.set(point, offset); result.set(triangle.normal, offset + 3);
    result.set(scene.materials[triangle.materialId]!.albedo, offset + 6); offset += 9;
  }
  return result;
}

/** Exact same opaque triangles and flat albedos used by the world-space tracer. */
export class RoomGeometry implements RasterGeometryProvider {
  readonly selectionPass = false;
  readonly shaderSource = roomShader;
  readonly vertexEntryPoint = 'roomVertexMain';
  readonly shadowEntryPoint = 'roomShadowMain';
  readonly fragmentEntryPoint = 'roomFragmentMain';
  readonly usesMaterialTextures = false;
  readonly halfExtent = 6.1;
  readonly lightMatrix = createLightMatrix(this.halfExtent);
  readonly vertexBuffers: GPUVertexBufferLayout[] = [{ arrayStride: 36, attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x3' },
  ] }];
  private bindings: GPUBindGroup | undefined;
  private readonly vertices: GPUBuffer;
  private readonly light: GPUBuffer;
  private readonly bytes: number;
  private readonly vertexCount: number;
  private pendingScene: GiSceneData | undefined;
  private disposed = false;
  currentCamera: CameraFrame | undefined;

  constructor(private readonly device: GPUDevice, private scene: GiSceneData, private readonly cameraMode: GiCameraMode) {
    const data = packRoom(scene); this.vertexCount = data.length / 9; this.bytes = data.byteLength;
    const buffers: GPUBuffer[] = [];
    try {
      this.vertices = device.createBuffer({ label: 'Strata shared GI room triangles', size: this.bytes, usage: 0x20 | 0x8 }); buffers.push(this.vertices);
      this.light = device.createBuffer({ label: 'Strata shared GI room light', size: 32, usage: 0x40 | 0x8 }); buffers.push(this.light);
      device.queue.writeBuffer(this.vertices, 0, data); this.uploadLight(scene);
    } catch (cause) { for (const buffer of buffers) buffer.destroy(); throw cause; }
  }
  private uploadLight(scene: GiSceneData): void {
    const light = new Float32Array(8); light.set(scene.light.direction, 0); light.set(scene.light.radiance, 4);
    this.device.queue.writeBuffer(this.light, 0, light);
  }
  setScene(scene: GiSceneData): void { this.pendingScene = scene; }
  get initialUploadBytes(): number { return this.bytes + 32; }
  get gpuBufferBytes(): number { return this.disposed ? 0 : this.initialUploadBytes; }
  camera(width: number, height: number, time: number, jitter: readonly [number, number]): CameraFrame {
    const camera = createGiCamera(width, height, time, jitter, this.cameraMode); this.currentCamera = camera; return camera;
  }
  attachPipelines(raster: GPURenderPipeline, _shadow: GPURenderPipeline): void {
    this.bindings = this.device.createBindGroup({ label: 'Strata GI raster light', layout: raster.getBindGroupLayout(1), entries: [{ binding: 0, resource: { buffer: this.light } }] });
  }
  prepare(_encoder: GPUCommandEncoder, _camera: CameraFrame, _width: number, _height: number, _reset: boolean, _controls: RasterControls) {
    let uploadBytes = 0;
    if (this.pendingScene) {
      const data = packRoom(this.pendingScene);
      if (data.byteLength !== this.bytes) throw new StrataError('INVALID_OPTIONS', 'GI room topology changed.');
      this.device.queue.writeBuffer(this.vertices, 0, data); this.uploadLight(this.pendingScene);
      this.scene = this.pendingScene; this.pendingScene = undefined; uploadBytes = this.initialUploadBytes;
    }
    return { uploadBytes, dispatchCalls: 0, triangles: this.vertexCount / 3 * 2, drawCalls: 2 };
  }
  draw(pass: GPURenderPassEncoder, phase: 'raster' | 'shadow'): void {
    if (!this.bindings || this.disposed) throw new StrataError('RENDER_FAILED', 'GI room is unavailable.');
    if (phase === 'raster') pass.setBindGroup(1, this.bindings);
    pass.setVertexBuffer(0, this.vertices); pass.draw(this.vertexCount);
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.vertices.destroy(); this.light.destroy(); }
}
