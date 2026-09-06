import { legacyShadowShader, receiverPlaneShadowShader } from '../../packages/core/src/rendering/raster-shaders.js';

/** Production shadow functions, with an analytic planar depth fixture independent of the filter. */
export async function validateReceiverPlaneShadows() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Shadow validation requires WebGPU.');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const depth = device.createTexture({ size: [64, 64], format: 'depth32float', usage: 0x10 | 0x04 });
  const output = device.createTexture({ size: [64, 64], format: 'rgba32float', usage: 0x10 | 0x01 });
  const readback = device.createBuffer({ size: 64 * 64 * 16, usage: 0x01 | 0x08 });
  const results: Record<string, number> = {};
  try {
    for (const slope of [0, 0.15, -0.15]) for (const separation of [0, 0.0001]) {
      const vertex = `struct V { @builtin(position) position: vec4f, @location(0) world: vec3f };
      @vertex fn vertex(@builtin(vertex_index) i: u32) -> V {
        let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
        var v: V; v.world = vec3f(xy, 0.5 + ${slope} * (xy.x + xy.y));
        v.position = vec4f(xy, 0.0, 1.0); return v;
      }`;
      const caster = device.createShaderModule({ code: vertex + `
      @fragment fn fragment(v: V) -> @builtin(frag_depth) f32 { return v.world.z - ${separation}; }` });
      const casterPipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: caster, entryPoint: 'vertex' },
        fragment: { module: caster, entryPoint: 'fragment', targets: [] }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' } });
      for (const [name, code] of [['legacy', legacyShadowShader], ['corrected', receiverPlaneShadowShader]] as const) {
        const shader = device.createShaderModule({ code: `
          struct Frame { lightViewProjection: mat4x4f }; const frame = Frame(mat4x4f(vec4f(1,0,0,0),vec4f(0,1,0,0),vec4f(0,0,1,0),vec4f(0,0,0,1)));
          @group(0) @binding(0) var shadowTexture: texture_depth_2d;
          @group(0) @binding(1) var shadowSampler: sampler_comparison;
          ${vertex} ${code}
          @fragment fn fragment(v: V) -> @location(0) vec4f {
            let gradient = shadowReceiverGradient(v.world);
            if (v.world.x > 0.5) { discard; }
            return vec4f(shadowVisibilityPrepared(v.world, gradient));
          }` });
        const layout = device.createBindGroupLayout({ entries: [
          { binding: 0, visibility: 2, texture: { sampleType: 'depth' } },
          { binding: 1, visibility: 2, sampler: { type: 'comparison' } },
        ] });
        const pipeline = await device.createRenderPipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          vertex: { module: shader, entryPoint: 'vertex' }, fragment: { module: shader, entryPoint: 'fragment', targets: [{ format: 'rgba32float' }] } });
        const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: depth.createView() },
          { binding: 1, resource: device.createSampler({ compare: 'less-equal', minFilter: 'linear', magFilter: 'linear' }) }] });
        const encoder = device.createCommandEncoder();
        const shadow = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'store' } });
        shadow.setPipeline(casterPipeline); shadow.draw(3); shadow.end();
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: output.createView(), loadOp: 'clear', storeOp: 'store' }] });
        pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
        encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: 64 * 16 }, [64, 64]);
        device.queue.submit([encoder.finish()]); await readback.mapAsync(1);
        const values = new Float32Array(readback.getMappedRange()); let sum = 0, count = 0;
        for (let y = 4; y < 60; y++) for (let x = 4; x < 44; x++) {
          const value = values[(y * 64 + x) * 4]!;
          if (!Number.isFinite(value)) throw new Error('Non-finite shadow visibility.');
          sum += value; count++;
        }
        if (values[(32 * 64 + 60) * 4] !== 0) throw new Error('Masked receiver must preserve the cleared output.');
        readback.unmap(); const mean = sum / count;
        results[`${name}/${slope}/${separation}`] = mean;
        if (name === 'corrected' && Math.abs(mean - (separation === 0 ? 1 : 0)) > 0.001) throw new Error(`Receiver plane regression: ${JSON.stringify(results)}`);
        if (name === 'legacy' && slope === 0 && separation > 0 && mean < 0.999) throw new Error('Fixture must reproduce legacy detached contact shadow.');
      }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    return { status: 'passed', results };
  } finally { readback.destroy(); output.destroy(); depth.destroy(); device.destroy(); }
}
