import { TemporalResolve } from '../../packages/core/src/rendering/temporal-resolve.js';
import { ggxDistributionShader } from '../../packages/core/src/rendering/raster-shaders.js';

/** Exercise the real temporal WGSL with controlled previous/current surface data. */
export async function validateTemporalShader() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter for temporal validation.');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const temporal = await TemporalResolve.create(device);
  const hdr = device.createTexture({ size: [4, 4], format: 'rgba16float', usage: 0x02 | 0x04 });
  const motion = device.createTexture({ size: [4, 4], format: 'rgba16float', usage: 0x02 | 0x04 });
  const output = device.createBuffer({ size: 256, usage: 0x80 | 0x04 });
  const readback = device.createBuffer({ size: 256, usage: 0x01 | 0x08 });
  const module = device.createShaderModule({ code: `
    @group(0) @binding(0) var source: texture_2d<f32>;
    @group(0) @binding(1) var<storage, read_write> result: array<vec4f>;
    @compute @workgroup_size(4,4) fn main(@builtin(global_invocation_id) id: vec3u) {
      result[id.y * 4u + id.x] = textureLoad(source, vec2i(id.xy), 0);
    }` });
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const float = new Float32Array(1);
  const bits = new Uint32Array(float.buffer);
  const half = (value: number) => {
    if (!Number.isFinite(value)) throw new Error('Finite half-float test data required.');
    float[0] = value;
    const word = bits[0]!;
    const sign = (word >>> 16) & 0x8000;
    const exponent = ((word >>> 23) & 0xff) - 127 + 15;
    const mantissa = word & 0x7fffff;
    if (exponent >= 31) throw new Error('Half-float test input overflow.');
    if (exponent < -10) return sign;
    if (exponent <= 0) return sign | Math.round((mantissa | 0x800000) / 2 ** (14 - exponent));
    return sign | ((exponent << 10) + Math.round(mantissa / 8192));
  };
  if (half(0.25) !== 0x3400 || half(-0.25) !== 0xb400 || half(0.0625) !== 0x2c00) throw new Error('Invalid half-float encoder.');
  const upload = (texture: GPUTexture, pixel: (index: number) => readonly number[]) => {
    const values = new Uint16Array(64);
    for (let index = 0; index < 16; index++) values.set(pixel(index).map(half), index * 4);
    device.queue.writeTexture({ texture }, values, { bytesPerRow: 32 }, [4, 4]);
  };
  type Pixels = (index: number) => readonly number[];
  const red: Pixels = () => [1, 0, 0, 1];
  const green: Pixels = () => [0, 1, 0, 1];
  const pattern: Pixels = index => index === 5 ? green(index) : red(index);
  const asymmetric: Pixels = index => index % 4 < 2 ? red(index) : [0, 0, 1, 1];
  const current: Pixels = index => index === 5 ? green(index) : asymmetric(index);
  const step = async (colors: Pixels, valid: boolean, expectedDepth = 1, motionX = 0, depth: (index: number) => number = () => 1) => {
    upload(hdr, colors);
    upload(motion, index => [motionX, 0, depth(index), expectedDepth]);
    const encoder = device.createCommandEncoder();
    const resolved = temporal.encode(encoder, { hdr: hdr.createView(), motion: motion.createView() }, 4, 4, valid);
    const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: resolved.view }, { binding: 1, resource: { buffer: output } },
    ] });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 256);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(0x01);
    const pixel = Array.from(new Float32Array(readback.getMappedRange()).slice(20, 24));
    readback.unmap();
    return pixel;
  };
  try {
    const ggxModule = device.createShaderModule({ code: `${ggxDistributionShader}
      @group(0) @binding(0) var<storage, read_write> result: array<vec4f>;
      @compute @workgroup_size(16) fn main(@builtin(global_invocation_id) id: vec3u) {
        if (id.x >= 15u) { return; }
        let roughness = array<f32,5>(0.06, 120.0/255.0*0.28, 0.2, 0.5, 1.0);
        let cosine = array<f32,3>(1.0, 0.0, 0.5);
        result[id.x] = vec4f(distributionGgx(roughness[id.x%5u], cosine[id.x/5u]),0.0,0.0,0.0);
      }` });
    const ggxPipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: ggxModule, entryPoint: 'main' } });
    const ggxEncoder = device.createCommandEncoder();
    const ggxPass = ggxEncoder.beginComputePass();
    ggxPass.setPipeline(ggxPipeline);
    ggxPass.setBindGroup(0, device.createBindGroup({ layout: ggxPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }] }));
    ggxPass.dispatchWorkgroups(1); ggxPass.end();
    ggxEncoder.copyBufferToBuffer(output, 0, readback, 0, 256);
    device.queue.submit([ggxEncoder.finish()]);
    await readback.mapAsync(0x01);
    const ggx = Array.from(new Float32Array(readback.getMappedRange())).filter((_, index) => index % 4 === 0).slice(0, 15);
    readback.unmap();
    for (let index = 0; index < 15; index++) {
      const roughness = [0.06, 120 / 255 * 0.28, 0.2, 0.5, 1][index % 5]!;
      const cosine = [1, 0, 0.5][Math.floor(index / 5)]!;
      const a2 = roughness ** 4;
      const expected = a2 / (Math.PI * ((1 - cosine ** 2) + a2 * cosine ** 2) ** 2);
      if (Math.abs(ggx[index]! - expected) > Math.max(expected * 0.003, 1e-6)) throw new Error(`GGX shader normalization failed at roughness ${roughness}, cosine ${cosine}: ${ggx[index]} vs ${expected}`);
    }
    await step(red, false);
    const reused = await step(pattern, true);
    if (!(reused[0]! > 0.3 && reused[1]! < 0.7)) throw new Error(`Valid history was not reused: ${reused}`);
    await step(red, false);
    const disoccluded = await step(pattern, true, 2);
    await step(red, false);
    const outside = await step(pattern, true, 1, 2);
    await step(red, false);
    const reset = await step(pattern, false);
    await step(red, false);
    const clamped = await step(green, true);
    for (const [name, pixel] of Object.entries({ disoccluded, outside, reset, clamped })) {
      if (!(pixel[0]! < 0.1 && pixel[1]! > 0.9 && pixel[3]! > 0.9)) throw new Error(`${name} retained stale history: ${pixel}`);
    }
    await step(asymmetric, false);
    const positiveMotion = await step(current, true, 1, 0.25);
    if (!(positiveMotion[2]! > 0.8 && positiveMotion[0]! < 0.1)) throw new Error(`Positive motion did not sample the right-hand history: ${positiveMotion}`);
    await step(asymmetric, false);
    const negativeMotion = await step(current, true, 1, -0.25);
    if (!(negativeMotion[0]! > 0.8 && negativeMotion[2]! < 0.1)) throw new Error(`Negative motion did not sample the left-hand history: ${negativeMotion}`);
    await step(asymmetric, false, 1, 0, index => index % 4 < 2 ? 1 : 2);
    const depthEdge = await step(current, true, 1, 0.0625);
    if (!(depthEdge[0]! > 0.8 && depthEdge[2]! < 0.05)) throw new Error(`Bilinear history leaked a mismatched-depth tap: ${depthEdge}`);
    if (errors.length) throw new Error(errors.join('; '));
    return { ggx, reused, disoccluded, outside, reset, clamped, positiveMotion, negativeMotion, depthEdge };
  } finally {
    temporal.dispose();
    hdr.destroy(); motion.destroy(); output.destroy(); readback.destroy(); device.destroy();
  }
}
