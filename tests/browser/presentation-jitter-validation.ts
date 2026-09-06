import { presentationShader } from '../../packages/core/src/rendering/raster-shaders.js';

/** Production presentation, driven by analytically translated planar HDR ramps. */
export async function validatePresentationJitter() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable.');
  const device = await adapter.requestDevice();
  const resources: (GPUBuffer | GPUTexture)[] = [];
  const errors: string[] = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const offsets = [[0, 0], [.375, .25], [-.375, .25], [.375, -.25], [-.375, -.25], [0, .375], [-.25, 0]];
  const width = 16, height = 16, bytesPerRow = 256;
  const half = (v: number) => {
    const e = Math.floor(Math.log2(v));
    const m = (v / 2 ** e - 1) * 1024;
    if (!Number.isInteger(m)) throw new Error('Fixture must be exact binary16.');
    return (e + 15) * 1024 + m;
  };
  const signal = (x: number, y: number) => [.125 + x / 64 + y / 128, .25 + y / 64, .5 - x / 128];
  const display = (x: number) => {
    const t = (x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14);
    return t <= .0031308 ? t * 12.92 : 1.055 * t ** (1 / 2.4) - .055;
  };
  device.pushErrorScope('validation');
  try {
    const source = device.createTexture({ size: [width, height], format: 'rgba16float', usage: 2 | 4 }); resources.push(source);
    const target = device.createTexture({ size: [width, height], format: 'rgba32float', usage: 1 | 16 }); resources.push(target);
    const uniform = device.createBuffer({ size: 32, usage: 8 | 64 }); resources.push(uniform);
    const readback = device.createBuffer({ size: bytesPerRow * height, usage: 1 | 8 }); resources.push(readback);
    const module = device.createShaderModule({ code: presentationShader });
    const pipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: 'rgba32float' }] } });
    const view = source.createView();
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: uniform } }, ...[1, 2, 3, 4, 5].map(binding => ({ binding, resource: view })),
    ] });
    const reports = [];
    for (const [jx, jy] of offsets as [number, number][]) {
      const pixels = new Uint16Array(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        pixels.set([...signal(x - jx, y - jy).map(half), half(1)], (y * width + x) * 4);
      }
      device.queue.writeTexture({ texture: source }, pixels, { bytesPerRow: width * 8 }, [width, height]);
      const data = new Float32Array([0, 0, 32, 1, jx, jy, 0, 0]);
      device.queue.writeBuffer(uniform, 0, data);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
      encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1); const actual = new Float32Array(readback.getMappedRange().slice(0)); readback.unmap();
      if (!actual.every(Number.isFinite)) throw new Error('Nonfinite presentation output at image boundary.');
      let maxError = 0;
      for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
        for (let c = 0; c < 3; c++) maxError = Math.max(maxError, Math.abs(actual[(y * width + x) * 4 + c]! - display(signal(x, y)[c]!)));
      }
      reports.push({ jitter: [jx, jy], maxError });
    }
    const validation = await device.popErrorScope();
    if (validation || errors.length) throw new Error(validation?.message ?? errors.join('; '));
    const worst = Math.max(...reports.map(r => r.maxError));
    if (worst > 2e-5) throw new Error(`Stationary presentation moves with projection jitter: max error ${worst}; ${JSON.stringify(reports)}`);
    return { status: 'passed', maxError: worst, tolerance: 2e-5, reports, scope: 'Signed XY stationary ramp phase through production presentation; finite clamped image boundaries. No frame-performance claim.' };
  } finally { for (const r of resources) r.destroy(); device.destroy(); }
}
