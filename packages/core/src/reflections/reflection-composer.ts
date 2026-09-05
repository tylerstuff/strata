import type { CameraFrame } from '../rendering/raster-math.js';
import type { RasterControls, RasterOutputs } from '../rendering/raster-types.js';
import { probeSamplingShader } from '../gi/probe-cache.js';
import type { ProbeBindings } from '../gi/probe-cache.js';
import { giTraceShader } from '../gi/trace-shaders.js';
import { invertGiMatrix } from '../gi/room-geometry.js';

import { reflectionSamplingShader } from './reflection-shaders.js';
import type { ReflectionBindings } from './reflection-cache.js';

const shader = /* wgsl */ `
${giTraceShader({ group: 1 })}
${probeSamplingShader({ group: 2 })}
${reflectionSamplingShader({ group: 3 })}
struct ComposeFrame { inverseViewProjection: mat4x4f, eye: vec4f, settings: vec4u, };
@group(0) @binding(0) var<uniform> composeFrame: ComposeFrame;
@group(0) @binding(1) var composeDepth: texture_depth_2d;
@group(0) @binding(2) var composeNormal: texture_2d<f32>;
@group(0) @binding(3) var composeMaterial: texture_2d<f32>;
@group(0) @binding(4) var composeDirect: texture_2d<f32>;
@group(0) @binding(5) var composeOutput: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn reflectionCompose(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(composeOutput);
  if (any(id.xy >= size)) { return; }
  let pixel = vec2i(id.xy); let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let mode = composeFrame.settings.x;
  if (composeFrame.settings.y == 0u && (mode == 11u || mode == 13u || mode == 14u || mode == 15u)) {
    textureStore(composeOutput, pixel, vec4f(0.0, 0.0, 0.0, 1.0)); return;
  }
  if (mode == 14u || mode == 15u) {
    let tile = min(vec2u(uv * vec2f(24.0, 16.0)), vec2u(23u, 15u));
    let state = giProbeStates[tile.x + tile.y * 24u];
    if (state.epoch != giProbeConfig.budget.w || state.valid == 0u) {
      textureStore(composeOutput, pixel, vec4f(0.0, 0.0, 0.0, 1.0)); return;
    }
    var color: vec3f;
    if (mode == 14u) {
      let atlasPixel = min(vec2u(uv * vec2f(textureDimensions(giProbeIrradiance))), textureDimensions(giProbeIrradiance) - 1u);
      let energy = textureLoad(giProbeIrradiance, vec2i(atlasPixel), 0).rgb;
      color = energy / (vec3f(1.0) + energy);
    } else {
      let atlasPixel = min(vec2u(uv * vec2f(textureDimensions(giProbeVisibility))), textureDimensions(giProbeVisibility) - 1u);
      let moments = textureLoad(giProbeVisibility, vec2i(atlasPixel), 0).xy;
      color = vec3f(moments.x / 32.0, sqrt(max(0.0, moments.y - moments.x * moments.x)) / 32.0, 0.0);
    }
    textureStore(composeOutput, pixel, vec4f(color, 1.0)); return;
  }
  let clipXY = uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  if (mode == 12u) {
    let farH = composeFrame.inverseViewProjection * vec4f(clipXY, 1.0, 1.0);
    let direction = normalize(farH.xyz / farH.w - composeFrame.eye.xyz);
    let hit = giTraceBvh(GiRay(composeFrame.eye.xyz, 0.05, direction, 32.0));
    var color = vec3f(0.0);
    if (hit.status == 1u) { color = hit.normal * 0.5 + 0.5; }
    if (hit.status == 2u) { color = vec3f(1.0, 0.0, 1.0); }
    textureStore(composeOutput, pixel, vec4f(color, 1.0)); return;
  }
  let direct = textureLoad(composeDirect, pixel, 0);
  let depth = textureLoad(composeDepth, pixel, 0);
  if (depth >= 1.0) {
    textureStore(composeOutput, pixel, select(direct, vec4f(0.0, 0.0, 0.0, 1.0), mode == 11u || mode == 13u || mode == 16u || mode == 17u)); return;
  }
  let homogeneous = composeFrame.inverseViewProjection * vec4f(clipXY, depth, 1.0);
  let world = homogeneous.xyz / homogeneous.w;
  let normal = normalize(textureLoad(composeNormal, pixel, 0).xyz);
  let view = normalize(composeFrame.eye.xyz - world);
  if (mode == 13u) {
    let diagnostics = sampleProbeDiagnostics(world);
    let age = clamp(diagnostics.y / 24.0, 0.0, 1.0);
    textureStore(composeOutput, pixel, vec4f(1.0 - diagnostics.x, diagnostics.x * (1.0 - age), age * diagnostics.x, 1.0)); return;
  }
  let material = textureLoad(composeMaterial, pixel, 0);
  var irradiance = vec3f(0.0);
  if (composeFrame.settings.y != 0u) { irradiance = sampleProbeIrradiance(world, normal, view); }
  let indirect = material.rgb * (1.0 - material.a) * irradiance / 3.14159265;
  var reflected = ReflectionSample(vec3f(0.0), 0u);
  let roughness = textureLoad(composeNormal, pixel, 0).a;
  // rgba16float can round the validated 0.35 upper bound up to this exact binary16 value.
  if (material.a > 0.5 && roughness <= 0.35009765625 && dot(normal, view) > 0.0) {
    // Low-frequency fallback only: diffuse probe irradiance cannot reconstruct a sharp reflected image.
    let fallback = irradiance / 3.14159265 * reflectionFresnel(material.rgb, dot(normal, view));
    reflected = sampleReflection(uv, world, normal, roughness, fallback);
  }
  var color = direct.rgb + indirect + reflected.radiance;
  if (mode == 11u) { color = indirect; }
  if (mode == 16u) { color = reflected.radiance; }
  if (mode == 17u) {
    color = vec3f(0.0);
    switch reflected.source {
      case 1u: { color = vec3f(0.1, 0.9, 0.2); }
      case 2u: { color = vec3f(0.1, 0.3, 1.0); }
      case 3u: { color = vec3f(1.0, 0.6, 0.1); }
      case 4u: { color = vec3f(1.0, 0.0, 1.0); }
      default: {}
    }
  }
  textureStore(composeOutput, pixel, vec4f(color, direct.a));
}
`;

/** Separate linear HDR target; the original direct-light MRT remains available for comparison. */
export class ReflectionComposer {
  private texture: GPUTexture | undefined;
  private output: GPUTextureView | undefined;
  private width = 0;
  private height = 0;
  private source: GPUTextureView | undefined;
  private sourceGroup: GPUBindGroup | undefined;
  private readonly probeGroups = new Map<GPUBuffer, GPUBindGroup>();
  private reflectionGroups = new WeakMap<ReflectionBindings, GPUBindGroup>();
  private disposed = false;

  private constructor(private readonly device: GPUDevice, private readonly uniform: GPUBuffer,
    private readonly pipeline: GPUComputePipeline, private readonly sceneGroup: GPUBindGroup,
    private readonly sourceLayout: GPUBindGroupLayout, private readonly probeLayout: GPUBindGroupLayout, private readonly reflectionLayout: GPUBindGroupLayout) {}

  static async create(device: GPUDevice, traceEntries: readonly GPUBindGroupEntry[], reflectionLayout: GPUBindGroupLayout): Promise<ReflectionComposer> {
    const buffer = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: 4, buffer: { type } });
    const texture = (binding: number, sampleType: GPUTextureSampleType): GPUBindGroupLayoutEntry => ({ binding, visibility: 4, texture: { sampleType } });
    const sourceLayout = device.createBindGroupLayout({ label: 'Strata reflection composition screen inputs', entries: [
      buffer(0, 'uniform'), texture(1, 'depth'), texture(2, 'float'), texture(3, 'float'), texture(4, 'float'),
      { binding: 5, visibility: 4, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ] });
    const sceneLayout = device.createBindGroupLayout({ label: 'Strata reflection composition trace scene', entries: [0, 1, 2, 3, 4].map(index => buffer(index, index === 4 ? 'uniform' : 'read-only-storage')) });
    const probeLayout = device.createBindGroupLayout({ label: 'Strata reflection composition probe sampling', entries: [
      texture(0, 'float'), texture(1, 'unfilterable-float'), buffer(2, 'read-only-storage'), buffer(3, 'uniform'),
    ] });
    const pipeline = await device.createComputePipelineAsync({ label: 'Strata diffuse and reflection composition',
      layout: device.createPipelineLayout({ bindGroupLayouts: [sourceLayout, sceneLayout, probeLayout, reflectionLayout] }),
      compute: { module: device.createShaderModule({ label: 'Strata reflection composition shader', code: shader }), entryPoint: 'reflectionCompose' },
    });
    const uniform = device.createBuffer({ label: 'Strata reflection inverse camera and controls', size: 96, usage: 0x40 | 0x8 });
    try {
      const sceneGroup = device.createBindGroup({ label: 'Strata reflection debug trace inputs', layout: sceneLayout, entries: [...traceEntries] });
      return new ReflectionComposer(device, uniform, pipeline, sceneGroup, sourceLayout, probeLayout, reflectionLayout);
    } catch (cause) { uniform.destroy(); throw cause; }
  }
  get outputTexture(): GPUTexture | undefined { return this.texture; }
  get gpuBufferBytes(): number { return this.disposed ? 0 : 96; }
  get gpuTextureBytes(): number { return this.disposed ? 0 : this.width * this.height * 8; }
  encode(encoder: GPUCommandEncoder, outputs: RasterOutputs, camera: CameraFrame, width: number, height: number,
    controls: RasterControls, probes: ProbeBindings, reflections: ReflectionBindings, giEnabled: boolean, timestampWrites?: GPUComputePassTimestampWrites) {
    if (!this.texture || width !== this.width || height !== this.height) {
      const texture = this.device.createTexture({ label: 'Strata composed reflection HDR', size: [width, height], format: 'rgba16float', usage: 0x1 | 0x4 | 0x8 });
      let view: GPUTextureView;
      try { view = texture.createView(); } catch (cause) { texture.destroy(); throw cause; }
      this.texture?.destroy(); this.texture = texture; this.output = view; this.width = width; this.height = height;
      this.source = undefined; this.sourceGroup = undefined;
    }
    const data = new ArrayBuffer(96); const floats = new Float32Array(data); const words = new Uint32Array(data);
    floats.set(invertGiMatrix(camera.viewProjection)); floats.set(camera.eye, 16);
    const view = controls.debugView ?? 'final';
    words[20] = ({ indirect: 11, trace: 12, 'probe-age': 13, 'probe-irradiance': 14, 'probe-visibility': 15, reflections: 16, 'reflection-source': 17 } as Record<string, number>)[view] ?? 0;
    words[21] = Number(giEnabled);
    this.device.queue.writeBuffer(this.uniform, 0, data);
    if (this.source !== outputs.hdr) {
      this.sourceGroup = this.device.createBindGroup({ label: 'Strata reflection screen reconstruction', layout: this.sourceLayout, entries: [
        { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: outputs.depth }, { binding: 2, resource: outputs.normal },
        { binding: 3, resource: outputs.material }, { binding: 4, resource: outputs.hdr }, { binding: 5, resource: this.output! },
      ] }); this.source = outputs.hdr;
    }
    let probeGroup = this.probeGroups.get(probes.uniform);
    if (!probeGroup) {
      probeGroup = this.device.createBindGroup({ label: 'Strata reflection current-epoch probe views', layout: this.probeLayout, entries: [
        { binding: 0, resource: probes.irradiance }, { binding: 1, resource: probes.visibility },
        { binding: 2, resource: { buffer: probes.state } }, { binding: 3, resource: { buffer: probes.uniform } },
      ] }); this.probeGroups.set(probes.uniform, probeGroup);
    }
    let reflectionGroup = this.reflectionGroups.get(reflections);
    if (!reflectionGroup) {
      reflectionGroup = this.device.createBindGroup({ label: 'Strata current reflection history', layout: this.reflectionLayout, entries: [...reflections.entries] });
      this.reflectionGroups.set(reflections, reflectionGroup);
    }
    const pass = encoder.beginComputePass({ label: 'Strata reflection shade', ...(timestampWrites ? { timestampWrites } : {}) });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.sourceGroup!); pass.setBindGroup(1, this.sceneGroup); pass.setBindGroup(2, probeGroup); pass.setBindGroup(3, reflectionGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
    return { view: this.output!, dispatchCalls: 1, uploadBytes: 96 };
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.uniform.destroy(); this.texture?.destroy(); this.probeGroups.clear(); this.reflectionGroups = new WeakMap(); this.sourceGroup = undefined;
  }
}
