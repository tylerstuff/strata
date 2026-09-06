import type { CameraFrame } from '../rendering/raster-math.js';
import type { EnvironmentSettings } from './imported-environment.js';

/** The same analytic incident radiance used by the environment baker and diffuse tracer. */
export const importedSkyShader = /* wgsl */ `
struct Sky { right: vec4f, up: vec4f, forward: vec4f, viewport: vec4f, source: vec4f, };
@group(0) @binding(0) var<uniform> sky: Sky;
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 1.0, 1.0);
}
struct Output { @location(0) hdr: vec4f, @location(1) normal: vec4f, @location(2) material: vec4f, @location(3) motion: vec4f, };
@fragment fn fragmentMain(@builtin(position) pixel: vec4f) -> Output {
  let uv = (pixel.xy - sky.viewport.zw) / sky.viewport.xy;
  let ray = normalize(sky.forward.xyz + (uv.x * 2.0 - 1.0) * sky.right.xyz + (1.0 - uv.y * 2.0) * sky.up.xyz);
  let direction = vec3f(sky.source.y * ray.x - sky.source.z * ray.z, ray.y, sky.source.z * ray.x + sky.source.y * ray.z);
  var color = vec3f(.025, .03, .04);
  if (sky.source.w > .5) {
    let pole = select(vec3f(.045, .04, .035), vec3f(.24, .48, .95), direction.y >= 0.0);
    let blend = select(1.0 - exp(direction.y * 6.0), pow(max(direction.y, 0.0), .6), direction.y >= 0.0);
    color = mix(vec3f(.55, .65, .8), pole, blend);
  } else {
    color += vec3f(4.2, 3.9, 3.6) * exp(12.0 * (dot(direction, normalize(vec3f(-.45, .72, .52))) - 1.0));
    color += vec3f(2.8, 3.1, 3.5) * exp(20.0 * (dot(direction, normalize(vec3f(.75, .3, -.65))) - 1.0));
    color += vec3f(.35, .4, .5) * exp(4.0 * (dot(direction, normalize(vec3f(-.5, .1, -.7))) - 1.0));
  }
  var output: Output;
  output.hdr = vec4f(color * sky.source.x, 1.0);
  output.normal = vec4f(0.0); output.material = vec4f(0.0); output.motion = vec4f(0.0);
  return output;
}
`;
export const importedSkyUniformBytes = 80;
export async function createImportedSky(device: GPUDevice) {
  const module = device.createShaderModule({ label: 'Strata incident environment skybox', code: importedSkyShader });
  const pipeline = await device.createRenderPipelineAsync({ label: 'Strata imported skybox', layout: 'auto',
    vertex: { module, entryPoint: 'vertexMain' }, fragment: { module, entryPoint: 'fragmentMain', targets: [
      { format: 'rgba16float' }, { format: 'rgba16float' }, { format: 'rgba8unorm' }, { format: 'rgba16float' },
    ] }, depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'always' } });
  const uniform = device.createBuffer({ label: 'Strata skybox camera and environment', size: importedSkyUniformBytes, usage: 0x40 | 0x8 });
  try {
    const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
    return { uniform, draw(pass: GPURenderPassEncoder, camera: CameraFrame, width: number, height: number,
      jitter: readonly [number, number], environment: NonNullable<EnvironmentSettings>) {
      const v = camera.view, t = 1 / camera.projectionScaleY!, a = width / height;
      const data = new Float32Array(importedSkyUniformBytes / 4);
      data.set([v[0]! * t * a, v[4]! * t * a, v[8]! * t * a, 0]);
      data.set([v[1]! * t, v[5]! * t, v[9]! * t, 0], 4);
      data.set([-v[2]!, -v[6]!, -v[10]!, 0], 8);
      data.set([width, height, ...jitter], 12);
      data.set([environment.intensity, Math.cos(environment.rotationRadians), Math.sin(environment.rotationRadians), Number(environment.preset === 'sky')], 16);
      device.queue.writeBuffer(uniform, 0, data); pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.draw(3);
    } };
  } catch (error) { uniform.destroy(); throw error; }
}
