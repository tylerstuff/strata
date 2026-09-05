import type { CameraFrame } from '../rendering/raster-math.js';
import type { RasterControls, RasterOutputs } from '../rendering/raster-types.js';
import { probeSamplingShader } from './probe-cache.js';
import type { ProbeBindings } from './probe-cache.js';
import { giTraceShader } from './trace-shaders.js';
import { invertGiMatrix } from './room-geometry.js';

const shader = /* wgsl */ `
${giTraceShader({ group: 1 })}
${probeSamplingShader({ group: 2 })}
struct ComposeFrame { inverseViewProjection: mat4x4f, eye: vec4f, settings: vec4u, };
@group(0) @binding(0) var<uniform> composeFrame: ComposeFrame;
@group(0) @binding(1) var composeDepth: texture_depth_2d;
@group(0) @binding(2) var composeNormal: texture_2d<f32>;
@group(0) @binding(3) var composeMaterial: texture_2d<f32>;
@group(0) @binding(4) var composeDirect: texture_2d<f32>;
@group(0) @binding(5) var composeOutput: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn giCompose(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(composeOutput);
  if (any(id.xy >= size)) { return; }
  let pixel = vec2i(id.xy); let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let mode = composeFrame.settings.x;
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
    textureStore(composeOutput, pixel, select(direct, vec4f(0.0, 0.0, 0.0, 1.0), mode == 11u || mode == 13u)); return;
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
  let irradiance = sampleProbeIrradiance(world, normal, view);
  let indirect = material.rgb * (1.0 - material.a) * irradiance / 3.14159265;
  textureStore(composeOutput, pixel, vec4f(select(direct.rgb + indirect, indirect, mode == 11u), direct.a));
}
`;

/** Separate linear HDR target; the original direct-light MRT remains available for comparison. */
export class GiComposer {
  private texture: GPUTexture | undefined;
  private output: GPUTextureView | undefined;
  private width = 0;
  private height = 0;
  private source: GPUTextureView | undefined;
  private sourceGroup: GPUBindGroup | undefined;
  private readonly probeGroups = new Map<GPUBuffer, GPUBindGroup>();
  private disposed = false;

  private constructor(private readonly device: GPUDevice, private readonly uniform: GPUBuffer,
    private readonly pipeline: GPUComputePipeline, private readonly sceneGroup: GPUBindGroup,
    private readonly sourceLayout: GPUBindGroupLayout, private readonly probeLayout: GPUBindGroupLayout) {}

  static async create(device: GPUDevice, traceEntries: readonly GPUBindGroupEntry[]): Promise<GiComposer> {
    const buffer = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: 4, buffer: { type } });
    const texture = (binding: number, sampleType: GPUTextureSampleType): GPUBindGroupLayoutEntry => ({ binding, visibility: 4, texture: { sampleType } });
    const sourceLayout = device.createBindGroupLayout({ label: 'Strata GI composition screen inputs', entries: [
      buffer(0, 'uniform'), texture(1, 'depth'), texture(2, 'float'), texture(3, 'float'), texture(4, 'float'),
      { binding: 5, visibility: 4, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ] });
    const sceneLayout = device.createBindGroupLayout({ label: 'Strata GI composition trace scene', entries: [0, 1, 2, 3, 4].map(index => buffer(index, index === 4 ? 'uniform' : 'read-only-storage')) });
    const probeLayout = device.createBindGroupLayout({ label: 'Strata GI composition probe sampling', entries: [
      texture(0, 'float'), texture(1, 'unfilterable-float'), buffer(2, 'read-only-storage'), buffer(3, 'uniform'),
    ] });
    const pipeline = await device.createComputePipelineAsync({ label: 'Strata world-space diffuse GI composition',
      layout: device.createPipelineLayout({ bindGroupLayouts: [sourceLayout, sceneLayout, probeLayout] }),
      compute: { module: device.createShaderModule({ label: 'Strata GI composition shader', code: shader }), entryPoint: 'giCompose' },
    });
    const uniform = device.createBuffer({ label: 'Strata GI inverse camera and controls', size: 96, usage: 0x40 | 0x8 });
    try {
      const sceneGroup = device.createBindGroup({ label: 'Strata GI debug trace inputs', layout: sceneLayout, entries: [...traceEntries] });
      return new GiComposer(device, uniform, pipeline, sceneGroup, sourceLayout, probeLayout);
    } catch (cause) { uniform.destroy(); throw cause; }
  }
  get outputTexture(): GPUTexture | undefined { return this.texture; }
  get gpuBufferBytes(): number { return this.disposed ? 0 : 96; }
  get gpuTextureBytes(): number { return this.disposed ? 0 : this.width * this.height * 8; }
  encode(encoder: GPUCommandEncoder, outputs: RasterOutputs, camera: CameraFrame, width: number, height: number,
    controls: RasterControls, probes: ProbeBindings, timestampWrites?: GPUComputePassTimestampWrites) {
    if (!this.texture || width !== this.width || height !== this.height) {
      const texture = this.device.createTexture({ label: 'Strata composed GI HDR', size: [width, height], format: 'rgba16float', usage: 0x1 | 0x4 | 0x8 });
      let view: GPUTextureView;
      try { view = texture.createView(); } catch (cause) { texture.destroy(); throw cause; }
      this.texture?.destroy(); this.texture = texture; this.output = view; this.width = width; this.height = height;
      this.source = undefined; this.sourceGroup = undefined;
    }
    const data = new ArrayBuffer(96); const floats = new Float32Array(data); const words = new Uint32Array(data);
    floats.set(invertGiMatrix(camera.viewProjection)); floats.set(camera.eye, 16);
    const view = controls.debugView ?? 'final';
    words[20] = ({ indirect: 11, trace: 12, 'probe-age': 13, 'probe-irradiance': 14, 'probe-visibility': 15 } as Record<string, number>)[view] ?? 0;
    this.device.queue.writeBuffer(this.uniform, 0, data);
    if (this.source !== outputs.hdr) {
      this.sourceGroup = this.device.createBindGroup({ label: 'Strata GI screen reconstruction', layout: this.sourceLayout, entries: [
        { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: outputs.depth }, { binding: 2, resource: outputs.normal },
        { binding: 3, resource: outputs.material }, { binding: 4, resource: outputs.hdr }, { binding: 5, resource: this.output! },
      ] }); this.source = outputs.hdr;
    }
    let probeGroup = this.probeGroups.get(probes.uniform);
    if (!probeGroup) {
      probeGroup = this.device.createBindGroup({ label: 'Strata GI current-epoch probe views', layout: this.probeLayout, entries: [
        { binding: 0, resource: probes.irradiance }, { binding: 1, resource: probes.visibility },
        { binding: 2, resource: { buffer: probes.state } }, { binding: 3, resource: { buffer: probes.uniform } },
      ] }); this.probeGroups.set(probes.uniform, probeGroup);
    }
    const pass = encoder.beginComputePass({ label: 'Strata GI shade', ...(timestampWrites ? { timestampWrites } : {}) });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.sourceGroup!); pass.setBindGroup(1, this.sceneGroup); pass.setBindGroup(2, probeGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
    return { view: this.output!, dispatchCalls: 1, uploadBytes: 96 };
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.uniform.destroy(); this.texture?.destroy(); this.probeGroups.clear(); this.sourceGroup = undefined;
  }
}
