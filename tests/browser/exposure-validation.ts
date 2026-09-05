import { presentationShader } from '../../packages/core/src/rendering/raster-shaders.js';

const require = (value: unknown, message: string): void => { if (!value) throw new Error(message); };
const exposureStops = [-16, -0.5, 0, 4, 8, 12, 16] as const;
// All source components are exactly representable normal binary16 numbers or zero.
// Mixed extremes exercise channels independently; black is deliberately first.
const hdrSamples: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], [2 ** -14, 2 ** -12, 2 ** -10], [2 ** -8, 2 ** -6, 2 ** -4],
  [0.125, 0.25, 0.5], [1, 2, 4], [16, 64, 256], [1024, 4096, 16384], [32752, 65504, 65504],
  [65504, 0, 2 ** -14], [2 ** -14, 65504, 0], [0, 2 ** -14, 65504], [0.5, 0.125, 0.25],
  [4, 1, 2], [256, 16, 64], [16384, 1024, 4096], [65504, 32752, 65504],
];

/** Binary16 encoding for this fixed exactly representable, nonnegative fixture. */
function exactHalf(value: number): number {
  if (value === 0) return 0;
  const exponent = Math.floor(Math.log2(value));
  const mantissa = (value / 2 ** exponent - 1) * 1024;
  require(exponent >= -14 && exponent <= 15 && Number.isInteger(mantissa) && mantissa >= 0 && mantissa <= 1023,
    `Fixture is not an exact finite normal binary16 value: ${value}.`);
  return (exponent + 15) * 1024 + mantissa;
}

/** Independent binary64 evaluation of the specified fitted ACES curve and IEC sRGB transfer. */
function reference(value: number, ev: number): number {
  const exposed = value * (2 ** ev);
  const mapped = Math.max(0, Math.min(1, (2.51 * exposed ** 2 + 0.03 * exposed) / (2.43 * exposed ** 2 + 0.59 * exposed + 0.14)));
  return mapped <= 0.0031308 ? 12.92 * mapped : 1.055 * mapped ** (1 / 2.4) - 0.055;
}

async function bounded<T>(promise: Promise<T>, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} exceeded15seconds.`)), 15_000); })])
    .finally(() => clearTimeout(timer));
}

/** Actual unmodified production fragment output in rgba32float, before any UNORM/PNG quantization. */
export async function validateExposureShader() {
  const adapter = await navigator.gpu.requestAdapter();
  require(adapter, 'No WebGPU adapter for exposure validation.');
  const device = await adapter!.requestDevice();
  const textures: GPUTexture[] = [], buffers: GPUBuffer[] = [], errors: string[] = [];
  const onError = (event: GPUUncapturedErrorEvent) => errors.push(event.error.message);
  device.addEventListener('uncapturederror', onError);
  const width = hdrSamples.length, rawViews = [['shadow', 2], ['depth', 3], ['normal', 4], ['motion', 5], ['material', 6]] as const;
  const cases = [['final', 0], ['direct', 1], ...rawViews].flatMap(([view, mode]) => exposureStops.map(exposureEV => ({ view, mode: Number(mode), exposureEV })));
  const stride = Math.max(16, device.limits.minUniformBufferOffsetAlignment), bytesPerRow = width * 16;
  require(bytesPerRow === 256, 'Readback rows must meet WebGPU alignment.');
  let scope = true; device.pushErrorScope('validation');
  try {
    require(exactHalf(65504) === 0x7bff && exactHalf(2 ** -14) === 0x0400 && exactHalf(1) === 0x3c00, 'Independent fixture binary16 encoding is invalid.');
    const source = (name: string, pixel: (index: number) => readonly number[]) => {
      const texture = device.createTexture({ label: `Exposure fixture ${name}`, size: [width, 1], format: 'rgba16float', usage: 0x04 | 0x02 });
      textures.push(texture); const values = new Uint16Array(width * 4);
      for (let index = 0; index < width; index++) values.set(pixel(index).map(value => value < 0 ? exactHalf(-value) | 0x8000 : exactHalf(value)), index * 4);
      device.queue.writeTexture({ texture }, values, { bytesPerRow: width * 8 }, [width, 1]);
      return texture.createView();
    };
    const resolved = source('resolved HDR', index => [...hdrSamples[index]!, 1]);
    // Deliberately permute the direct channels so testing the wrong source texture cannot pass.
    const direct = source('direct HDR', index => { const [r, g, b] = hdrSamples[index]!; return [b, r, g, (index % 4 + 1) / 4]; });
    const normal = source('raw normal/roughness', index => [...([[0, 1, 0], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][index % 4]!), (index % 4 + 1) / 4]);
    const material = source('raw material', index => [0.25, 0.5, 0.75, index % 4 / 4]);
    const motion = source('raw motion/depth', index => [(index % 3 - 1) / 128, (index % 4 - 2) / 128, index % 4, 1]);
    const output = device.createTexture({ label: 'Production presentation float outputs', size: [width, 1, cases.length], format: 'rgba32float',
      usage: 0x10 | 0x01 }); textures.push(output);
    const uniform = device.createBuffer({ label: 'Exposure per-case uniforms', size: stride * cases.length, usage: 0x40 | 0x08 }); buffers.push(uniform);
    const readback = device.createBuffer({ label: 'Exposure float readback', size: bytesPerRow * cases.length, usage: 0x01 | 0x08 }); buffers.push(readback);
    const uniforms = new ArrayBuffer(stride * cases.length), floats = new Float32Array(uniforms), words = new Uint32Array(uniforms);
    cases.forEach((test, index) => { const offset = index * stride / 4; words.set([test.mode, 1], offset); floats.set([8, 2 ** test.exposureEV], offset + 2); });
    device.queue.writeBuffer(uniform, 0, uniforms);
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: 0x02, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 } },
      ...Array.from({ length: 5 }, (_, index) => ({ binding: index + 1, visibility: 0x02, texture: { sampleType: 'float' as const } })),
    ] });
    const module = device.createShaderModule({ label: 'Unmodified production exposure presentation', code: presentationShader });
    const pipeline = await bounded(device.createRenderPipelineAsync({ label: 'Presentation numeric float witness', layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vertexMain' }, fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: 'rgba32float' }] }, primitive: { topology: 'triangle-list' } }), 'Exposure pipeline');
    const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform, size: 16 } },
      ...[resolved, direct, normal, material, motion].map((resource, index) => ({ binding: index + 1, resource })),
    ] });
    const encoder = device.createCommandEncoder({ label: '49 bounded production exposure cases' });
    cases.forEach((_, index) => {
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: output.createView({ dimension: '2d', baseArrayLayer: index, arrayLayerCount: 1 }),
        clearValue: { r: -7, g: -7, b: -7, a: -7 }, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(pipeline); pass.setBindGroup(0, group, [index * stride]); pass.draw(3); pass.end();
      encoder.copyTextureToBuffer({ texture: output, origin: [0, 0, index] }, { buffer: readback, offset: index * bytesPerRow, bytesPerRow }, [width, 1]);
    });
    device.queue.submit([encoder.finish()]);
    await bounded(readback.mapAsync(0x01), 'Exposure float readback');
    const bytes = readback.getMappedRange().slice(0); readback.unmap();
    const gpuError = await device.popErrorScope(); scope = false;
    require(!gpuError && errors.length === 0, `Exposure GPU error: ${gpuError?.message ?? errors.join('; ')}`);
    const actual = new Float32Array(bytes), actualBits = new Uint32Array(bytes);
    const reports = cases.map((test, caseIndex) => {
      const offset = caseIndex * width * 4; const pixels = [...actual.subarray(offset, offset + width * 4)];
      require(pixels.every(Number.isFinite), `Presentation ${test.view} EV${test.exposureEV} produced nonfinite float output.`);
      require(pixels.filter((_, index) => index % 4 === 3).every(value => value === 1), 'Actual fragment alpha must be one for every covered output.');
      let maxAbsoluteError = 0;
      if (test.mode <= 1) {
        hdrSamples.forEach((color, pixel) => {
          const input = test.mode === 0 ? color : [color[2], color[0], color[1]];
          input.forEach((value, channel) => {
            const expected = reference(value, test.exposureEV), measured = pixels[pixel * 4 + channel]!;
            const tolerance = Math.max(2e-7, 2e-5 * Math.abs(expected));
            maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(measured - expected));
            require(Math.abs(measured - expected) <= tolerance,
              `${test.view} EV${test.exposureEV} sample${pixel} channel${channel}: ${measured} vs independent ${expected}, tolerance ${tolerance}.`);
            if (value === 0) require(measured === 0, 'Black must remain exactly zero at every exposure.');
          });
        });
      }
      return { ...test, pixels, maxAbsoluteError };
    });
    for (const view of ['final', 'direct']) {
      const series = reports.filter(test => test.view === view);
      for (let index = 1; index < series.length; index++) for (let channel = 0; channel < width * 4; channel++) {
        if (channel % 4 !== 3) require(series[index]!.pixels[channel]! >= series[index - 1]!.pixels[channel]!, `${view} output must be monotonic as exposure increases.`);
      }
    }
    for (const [view] of rawViews) {
      const first = cases.findIndex(test => test.view === view && test.exposureEV === 0), baseline = actualBits.subarray(first * width * 4, (first + 1) * width * 4);
      require(reports[first]!.pixels.some((value, index) => index % 4 !== 3 && value > 0 && value < 1), `${view} must contain nonsaturated nonblack raw quantities.`);
      cases.forEach((test, index) => {
        if (test.view !== view) return;
        const bits = actualBits.subarray(index * width * 4, (index + 1) * width * 4);
        require(bits.every((value, channel) => value === baseline[channel]), `${view} raw f32 bits changed with exposure EV${test.exposureEV}.`);
      });
    }
    const shaderDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(presentationShader)));
    return { status: 'passed', adapter: { vendor: adapter!.info.vendor, description: adapter!.info.description, isFallbackAdapter: adapter!.info.isFallbackAdapter ?? null },
      sourceFormat: 'rgba16float', outputFormat: 'rgba32float', beforeUnormQuantization: true, shaderSha256: [...shaderDigest].map(v => v.toString(16).padStart(2, '0')).join(''),
      exposureStops, hdrSamples, cases: reports, gpuErrors: errors, tolerance: { absolute: 2e-7, relative: 2e-5, combination: 'max', declaredBeforeGpuObservation: true },
      scope: 'Unmodified production fragment entry on exact finite binary16 HDR including65504, seven EV values, final/direct numeric reference and raw-view bit invariance. No exposure-history or real-scene visual claim.' };
  } finally {
    if (scope) { try { await device.popErrorScope(); } catch { /* Preserve the first failure. */ } }
    for (const resource of [...textures, ...buffers]) resource.destroy();
    device.removeEventListener('uncapturederror', onError); device.destroy();
  }
}
