import { ReflectionRenderer } from '../../packages/core/src/reflections/reflection-renderer.js';

// The runner bundles this identical harness against the original git snapshot and
// current source. No reference radiance or BRDF code executes in this module.
function require(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const witnessPixels = Array.from({ length: 32 * 18 }, (_, i) => [112 + i % 32 * 3, 63 + Math.floor(i / 32) * 3] as const);
const width = 320; const height = 180;
let active: { device: GPUDevice; renderer: ReflectionRenderer; canvas: HTMLCanvasElement; context: GPUCanvasContext;
  frame: number; roughness: number; errors: string[]; lost: boolean } | undefined;
function half(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1; const exponent = bits >>> 10 & 31; const mantissa = bits & 1023;
  return sign * (exponent === 0 ? mantissa * 2 ** -24 : exponent === 31 ? Infinity : (1 + mantissa / 1024) * 2 ** (exponent - 15));
}
async function readTextures(textures: readonly GPUTexture[]): Promise<{ width: number; height: number; values: number[] }[]> {
  require(active, 'Image session missing.'); const device = active.device;
  const allocations = textures.map(texture => {
    const stride = texture.format === 'rgba32uint' ? 16 : 8; const bytesPerRow = Math.ceil(texture.width * stride / 256) * 256;
    return { texture, stride, bytesPerRow, buffer: device.createBuffer({ size: bytesPerRow * texture.height, usage: 0x1 | 0x8 }) };
  });
  try {
    const encoder = device.createCommandEncoder();
    for (const value of allocations) encoder.copyTextureToBuffer({ texture: value.texture }, { buffer: value.buffer, bytesPerRow: value.bytesPerRow }, [value.texture.width, value.texture.height]);
    device.queue.submit([encoder.finish()]); await Promise.all(allocations.map(value => value.buffer.mapAsync(1)));
    return allocations.map(({ texture, buffer, bytesPerRow, stride }) => {
      const data = new DataView(buffer.getMappedRange()); const values: number[] = [];
      for (let y = 0; y < texture.height; y++) for (let x = 0; x < texture.width; x++) for (let channel = 0; channel < 4; channel++) {
        const offset = y * bytesPerRow + x * stride + channel * stride / 4;
        const value = stride === 16 ? data.getUint32(offset, true) : half(data.getUint16(offset, true));
        require(Number.isFinite(value), 'Nonfinite image readback.'); values.push(value);
      }
      buffer.unmap(); return { width: texture.width, height: texture.height, values };
    });
  } finally { for (const value of allocations) value.buffer.destroy(); }
}
export async function startReflectionImage(roughness: number, scale: .25 | 1) {
  finishReflectionImage();
  const adapter = await navigator.gpu.requestAdapter(); require(adapter, 'WebGPU adapter unavailable.');
  const device = await adapter.requestDevice(); const errors: string[] = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const canvas = document.querySelector('canvas'); require(canvas, 'Image canvas missing.'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('webgpu') as GPUCanvasContext | null; require(context, 'WebGPU context missing.');
  const format = navigator.gpu.getPreferredCanvasFormat(); context.configure({ device, format, alphaMode: 'opaque' });
  try {
    const renderer = await ReflectionRenderer.create(device, format, { renderer: 'reflections', roughness,
      cameraMode: 'receiver', lightIntensity: 0, resolutionScale: scale, maxRaysPerFrame: 32768 });
    active = { device, renderer, canvas, context, frame: 0, roughness, errors, lost: false };
    void device.lost.then(info => { if (info.reason !== 'destroyed') { errors.push(`Device lost: ${info.message}`); if (active?.device === device) active.lost = true; } });
    const first = await captureReflectionImage(1);
    const readback = device.createBuffer({ size: 16, usage: 0x1 | 0x8 }); let configSettings: number[];
    try {
      const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(renderer.reflectionCache.diagnostics.configBuffer, 192, readback, 0, 16);
      device.queue.submit([encoder.finish()]); await readback.mapAsync(1); configSettings = Array.from(new Float32Array(readback.getMappedRange())); readback.unmap();
    } finally { readback.destroy(); }
    const camera = renderer.currentCamera!;
    return { adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device,
      description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter },
      scene: renderer.currentScene, camera: { eye: camera.eye, viewProjection: Array.from(camera.viewProjection) },
      width, height, roughness, resolutionScale: scale, maxRaysPerFrame: 32768, configSettings, first };
  } catch (error) { context.unconfigure(); device.destroy(); throw error; }
}
export async function captureReflectionImage(targetFrame: number) {
  require(active, 'Image session missing.'); const s = active;
  while (s.frame < targetFrame) {
    const encoder = s.device.createCommandEncoder();
    s.renderer.encode(encoder, s.context.getCurrentTexture().createView(), width, height, 0, {
      temporal: false, debugView: 'reflections', gi: { enabled: false, lightIntensity: 0 },
      reflections: { mode: 'world', roughness: s.roughness, maxDistance: 16, updateEvery: 1 },
    });
    s.device.queue.submit([encoder.finish()]); s.renderer.submitted(++s.frame);
    // This is frame-count quality evidence. Bound queue depth on every submission.
    await s.device.queue.onSubmittedWorkDone(); require(!s.lost && !s.errors.length, s.errors.join('\n'));
  }
  const diagnostic = s.renderer.reflectionCache.diagnostics;
  const [image, rawMetadata, raw, metadata] = await readTextures([s.renderer.composer.outputTexture!, diagnostic.rawMetadataTexture, diagnostic.rawTexture, diagnostic.metadataTexture]);
  require(image && rawMetadata && raw && metadata, 'Missing reflection images.');
  const rgb: number[] = []; const rawSources = [0, 0, 0, 0, 0, 0]; const resolvedSources = [0, 0, 0, 0, 0, 0]; let rawEmissiveHits = 0;
  const rawSelectedSources: number[] = []; const rawSelectedEmissive: number[] = [];
  for (const [x, y] of witnessPixels) {
    const index = (y * width + x) * 4; rgb.push(...image.values.slice(index, index + 3));
    const rx = Math.min(raw.width - 1, Math.floor((x + .5) / width * raw.width));
    const ry = Math.min(raw.height - 1, Math.floor((y + .5) / height * raw.height)); const r = (ry * raw.width + rx) * 4;
    if (rawMetadata.values[r + 3]) { rawSources[rawMetadata.values[r]!]!++; rawEmissiveHits += Number(raw.values[r]! > .1); rawSelectedSources.push(rawMetadata.values[r]!); }
    else rawSelectedSources.push(-1);
    rawSelectedEmissive.push(Number(rawMetadata.values[r + 3] && raw.values[r]! > .1));
    if (metadata.values[r + 3]) resolvedSources[metadata.values[r]!]!++;
  }
  require(rawSources[4] === 0 && resolvedSources[4] === 0, 'Traversal exhaustion in image witness.');
  require(s.errors.length === 0 && !s.lost, s.errors.join('\n'));
  return { frame: s.frame, rgb, rawSources, resolvedSources, rawSelectedSources, rawSelectedEmissive, rawEmissiveHits,
    telemetry: s.renderer.reflectionTelemetry, gpuErrors: [...s.errors] };
}
export function finishReflectionImage() {
  if (!active) return null; const s = active; active = undefined;
  s.renderer.dispose(); const allocations = { buffers: s.renderer.gpuBufferBytes, textures: s.renderer.gpuTextureBytes };
  s.context.unconfigure(); s.device.destroy(); require(allocations.buffers === 0 && allocations.textures === 0, 'Image renderer leaked tracked allocations.'); return allocations;
}
