import { StrataError } from '../errors.js';
import type { GeometryBounds } from './format.js';
import { multiplyMatrices } from '../rendering/raster-math.js';
import type { CameraFrame, Vec3 } from '../rendering/raster-math.js';

export interface TerrainTransform { readonly scale: number; readonly translation: Vec3 }
export interface TerrainLight { readonly direction: Vec3; readonly radiance: Vec3 }
export interface TerrainRenderOptions {
  readonly transform?: TerrainTransform;
  readonly shading?: 'pbr' | 'lambert';
  readonly albedo?: Vec3;
  readonly light?: TerrainLight;
}
const identity: TerrainTransform = Object.freeze({ scale: 1, translation: Object.freeze([0, 0, 0]) as Vec3 });
const defaultLight: TerrainLight = { direction: [0.35, 0.8, 0.4], radiance: [4, 3.8, 3.5] };
const vector = (value: Vec3): Vec3 => Object.freeze([...value]) as unknown as Vec3;
const validVector = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3
  && value.every(component => typeof component === 'number' && Number.isFinite(component) && Number.isFinite(Math.fround(component)));

export function normalizeTerrainTransform(value: TerrainTransform = identity): TerrainTransform {
  if (!value || typeof value !== 'object' || !Number.isFinite(value.scale) || Math.fround(value.scale) <= 0
    || !Number.isFinite(Math.fround(value.scale)) || !Number.isFinite(Math.fround(1 / value.scale)) || !validVector(value.translation)) {
    throw new StrataError('INVALID_OPTIONS', 'Terrain transforms require a positive finite uniform scale and finite translation.');
  }
  return Object.freeze({ scale: Math.fround(value.scale), translation: vector(value.translation.map(Math.fround) as unknown as Vec3) });
}
export function transformGeometryBounds(bounds: GeometryBounds, transform: TerrainTransform): GeometryBounds {
  const point = (source: Vec3): Vec3 => source.map((value, axis) => value * transform.scale + transform.translation[axis]!) as unknown as Vec3;
  const min = point(bounds.min); const max = point(bounds.max);
  if (![...min, ...max].every(value => Number.isFinite(Math.fround(value)))) throw new StrataError('UNSUPPORTED_LIMIT', 'Transformed terrain bounds exceed float32.');
  return { min, max };
}
export function transformTerrainCamera(camera: CameraFrame, transform: TerrainTransform): CameraFrame {
  if (transform.scale === 1 && transform.translation.every(value => value === 0)) return camera;
  const scale = transform.scale; const translation = transform.translation;
  const inverse = new Float32Array([1 / scale, 0, 0, 0, 0, 1 / scale, 0, 0, 0, 0, 1 / scale, 0,
    -translation[0] / scale, -translation[1] / scale, -translation[2] / scale, 1]);
  const view = camera.view.slice();
  for (let row = 0; row < 3; row++) view[12 + row] = camera.view[12 + row]! * scale
    - camera.view[row]! * translation[0] - camera.view[4 + row]! * translation[1] - camera.view[8 + row]! * translation[2];
  return { ...camera, eye: camera.eye.map((value, axis) => value * scale + translation[axis]!) as unknown as Vec3,
    view, viewProjection: multiplyMatrices(camera.viewProjection, inverse), far: camera.far * scale,
    ...(camera.projectionScaleY === undefined ? {} : { projectionScaleY: camera.projectionScaleY / (camera.orthographic ? scale : 1) }) };
}

function normalizeLight(light: TerrainLight): TerrainLight {
  if (!light || !validVector(light.direction) || !validVector(light.radiance) || light.radiance.some(value => value < 0)
    || Math.hypot(...light.direction) < 1e-12) throw new StrataError('INVALID_OPTIONS', 'Terrain light needs a finite nonzero direction and nonnegative radiance.');
  const length = Math.hypot(...light.direction);
  return { direction: vector(light.direction.map(value => value / length) as unknown as Vec3), radiance: vector(light.radiance) };
}

/** Optional fixed terrain transform/material. Default providers retain their original zero-buffer path. */
export class TerrainRendering {
  readonly transform: TerrainTransform;
  readonly shading: 'pbr' | 'lambert';
  readonly albedo: Vec3;
  readonly buffer: GPUBuffer | undefined;
  private light: TerrainLight;
  private dirty = false;
  private disposed = false;

  constructor(private readonly device: GPUDevice, options?: TerrainRenderOptions) {
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw new StrataError('INVALID_OPTIONS', 'Terrain rendering options must be an object.');
    if (options?.transform === null || options?.light === null || (options?.shading !== undefined && !['pbr', 'lambert'].includes(options.shading))
      || (options?.albedo !== undefined && (!validVector(options.albedo) || options.albedo.some(value => value < 0 || value > 1)))) {
      throw new StrataError('INVALID_OPTIONS', 'Invalid terrain shading or albedo.');
    }
    this.transform = normalizeTerrainTransform(options?.transform);
    this.shading = options?.shading ?? 'pbr'; this.albedo = vector(options?.albedo ?? [0.31, 0.48, 0.19]);
    this.light = normalizeLight(options?.light ?? defaultLight);
    if (options !== undefined) {
      if (device.limits.maxBufferSize < 64) throw new StrataError('UNSUPPORTED_LIMIT', 'Terrain transform/light uniform exceeds the buffer limit.');
      this.buffer = device.createBuffer({ label: 'Strata terrain transform and flat material', size: 64, usage: 0x40 | 0x8 });
      try { this.upload(); } catch (cause) { this.buffer.destroy(); throw cause; }
    }
  }
  get initialUploadBytes(): number { return this.buffer ? 64 : 0; }
  get gpuBufferBytes(): number { return this.disposed ? 0 : this.initialUploadBytes; }
  setLight(light: TerrainLight): void {
    if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'Terrain rendering resources were disposed.');
    const next = normalizeLight(light);
    if (next.direction.some((value, index) => value !== this.light.direction[index]) || next.radiance.some((value, index) => value !== this.light.radiance[index])) {
      this.light = next; this.dirty = true;
    }
  }
  flush(): number {
    if (this.disposed) throw new StrataError('ENGINE_DISPOSED', 'Terrain rendering resources were disposed.');
    if (!this.buffer || !this.dirty) return 0;
    this.upload(); this.dirty = false; return 64;
  }
  private upload(): void {
    const values = new Float32Array(16); values.set([...this.transform.translation, this.transform.scale]);
    values.set(this.light.direction, 4); values.set(this.light.radiance, 8); values.set([...this.albedo, 1], 12);
    this.device.queue.writeBuffer(this.buffer!, 0, values);
  }
  shader(binding: number): string {
    return (this.buffer ? /* wgsl */ `
struct TerrainFrame { transform: vec4f, lightDirection: vec4f, lightRadiance: vec4f, albedo: vec4f, };
@group(1) @binding(${binding}) var<uniform> terrainFrame: TerrainFrame;
fn terrainWorldPosition(position: vec3f) -> vec3f { return position * terrainFrame.transform.w + terrainFrame.transform.xyz; }
` : 'fn terrainWorldPosition(position: vec3f) -> vec3f { return position; }\n')
      + (this.shading === 'lambert' ? /* wgsl */ `
fn terrainAlbedo() -> vec3f { return terrainFrame.albedo.rgb; }
fn terrainRoughness() -> f32 { return 1.0; }
@fragment fn terrainLambertFragment(input: VertexOutput) -> GBufferOutput {
  let normal = normalize(input.normal); let shadow = shadowVisibility(input.world);
  let direct = input.color / 3.14159265 * max(dot(normal, terrainFrame.lightDirection.xyz), 0.0) * terrainFrame.lightRadiance.xyz * shadow;
  let currentUV = input.currentClip.xy / input.currentClip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  let previousUV = input.previousClip.xy / input.previousClip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  var output: GBufferOutput; output.hdr = vec4f(direct, shadow);
  if (frame.parameters.z > 0.5) { output.hdr = vec4f(input.debugColor, 1.0); }
  output.normal = vec4f(normal, 1.0); output.material = vec4f(input.color, 0.0);
  output.motion = vec4f(previousUV - currentUV, input.viewDepths); return output;
}
` : 'fn terrainAlbedo() -> vec3f { return vec3f(0.31, 0.48, 0.19); }\nfn terrainRoughness() -> f32 { return 0.85; }\n');
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.buffer?.destroy(); }
}
