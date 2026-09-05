import { ReflectionRenderer } from '../../packages/core/src/reflections/reflection-renderer.js';
import { probeSamplingShader } from '../../packages/core/src/gi/probe-cache.js';
import { combineQuality, contributors, decodeQualityConfig, halfFloat, octTaps, probePosition, qualityHit, qualityIncoming, qualityPoints, visibilityWeight } from './probe-quality-reference.js';
import type { QualityCapture, QualityFrame, QualityPoint, QualityProbe, V3 } from './probe-quality-reference.js';

const require = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };

/** Test-only readback. No production settings, shaders, resource budgets or sampling path are changed. */
export async function validateProbeQuality(): Promise<QualityCapture & { adapter: object; warmupSubmissions: number; captureSubmissions: number; gpuErrors: string[]; failure?: string }> {
  const adapter = await navigator.gpu.requestAdapter(); if (!adapter) throw new Error('WebGPU adapter unavailable.');
  const device = await adapter.requestDevice(); const errors: string[] = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  let lost: GPUDeviceLostInfo | undefined; void device.lost.then(info => { lost = info; });
  const canvas = document.querySelector('canvas')!; canvas.width = 320; canvas.height = 180;
  const context = canvas.getContext('webgpu') as GPUCanvasContext; context.configure({ device, format: 'bgra8unorm', alphaMode: 'opaque' });
  const renderer = await ReflectionRenderer.create(device, 'bgra8unorm', { renderer: 'reflections', cameraMode: 'overview', probesPerUpdate: 32, raysPerProbe: 64 });
  const resources: GPUBuffer[] = [];
  const buffer = (size: number, usage: number) => { const value = device.createBuffer({ size, usage }); resources.push(value); return value; };
  const positions = buffer(qualityPoints.length * 16, 0x80 | 0x8); const output = buffer(qualityPoints.length * 16, 0x80 | 0x4);
  device.queue.writeBuffer(positions, 0, new Float32Array(qualityPoints.flatMap(point => [...point.world, 0])));
  const probeLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: 4, texture: { sampleType: 'float' } }, { binding: 1, visibility: 4, texture: { sampleType: 'unfilterable-float' } },
    { binding: 2, visibility: 4, buffer: { type: 'read-only-storage' } }, { binding: 3, visibility: 4, buffer: { type: 'uniform' } },
  ] });
  const sampleLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } }, { binding: 1, visibility: 4, buffer: { type: 'storage' } },
  ] });
  const pipeline = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [probeLayout, sampleLayout] }),
    compute: { module: device.createShaderModule({ code: probeSamplingShader({ group: 0 }) + `
@group(1) @binding(0) var<storage,read> positions:array<vec4f>;
@group(1) @binding(1) var<storage,read_write> diffuse:array<vec4f>;
@compute @workgroup_size(64) fn sampleQuality(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=arrayLength(&positions)){return;}
  diffuse[id.x]=vec4f(sampleProbeIrradiance(positions[id.x].xyz,vec3f(0,1,0),vec3f(0,1,0))*(.72/3.141592653589793),1);
}` }), entryPoint: 'sampleQuality' } });
  const sampleGroup = device.createBindGroup({ layout: sampleLayout, entries: [{ binding: 0, resource: { buffer: positions } }, { binding: 1, resource: { buffer: output } }] });
  const diagnostics = renderer.probeCache.diagnostics;
  let size = 0; const section = (bytes: number) => { const offset = size; size += Math.ceil(bytes / 256) * 256; return { offset, bytes }; };
  const irradiance = section(diagnostics.irradianceTexture.width * diagnostics.irradianceTexture.height * 8);
  const moments = section(diagnostics.visibilityTexture.width * diagnostics.visibilityTexture.height * 8);
  const states = section(diagnostics.stateBuffer.size); const rays = section(diagnostics.rayBuffer.size); const config = section(diagnostics.configBuffer.size);
  const statistics = section(diagnostics.statisticsBuffer.size); const sampled = section(output.size); const readback = buffer(size, 0x1 | 0x8);
  const frames: QualityFrame[] = []; let maxSamplerReconstructionError = 0; let maxTransferredRayRadianceError = 0; let maxTransferredRayDistanceError = 0; let rayComparisons = 0;
  const warmupSubmissions = 240; const captureSubmissions = 96; let failure: string | undefined;
  const sceneState = renderer.currentScene.state;
  try {
    require(renderer.probeCache.gpuBufferBytes === 71904 && renderer.probeCache.gpuTextureBytes === 1966080, 'Production probe memory budget differs from the attribution baseline.');
    for (let frameIndex = 0; frameIndex < warmupSubmissions + captureSubmissions; frameIndex++) {
      const encoder = device.createCommandEncoder();
      renderer.encode(encoder, context.getCurrentTexture().createView(), 320, 180, frameIndex / 60,
        { temporal: false, gi: { enabled: true }, reflections: { mode: 'off', objectOffset: 0 } });
      device.queue.submit([encoder.finish()]); renderer.submitted(frameIndex + 1);
      if (frameIndex < warmupSubmissions) {
        await device.queue.onSubmittedWorkDone();
        if ((frameIndex + 1) % 60 === 0) console.log(`Probe quality diagnostic: warmup ${frameIndex + 1}/${warmupSubmissions}`);
        require(errors.length === 0 && !lost, `GPU failed during warmup: ${errors.join('; ')} ${lost?.message ?? ''}`); continue;
      }
      const bindings = renderer.probeCache.bindings; const d = renderer.probeCache.diagnostics;
      const group = device.createBindGroup({ layout: probeLayout, entries: [
        { binding: 0, resource: bindings.irradiance }, { binding: 1, resource: bindings.visibility },
        { binding: 2, resource: { buffer: bindings.state } }, { binding: 3, resource: { buffer: bindings.uniform } },
      ] });
      const read = device.createCommandEncoder(); const pass = read.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.setBindGroup(1, sampleGroup); pass.dispatchWorkgroups(1); pass.end();
      read.copyTextureToBuffer({ texture: d.irradianceTexture }, { buffer: readback, offset: irradiance.offset, bytesPerRow: d.irradianceTexture.width * 8 }, [d.irradianceTexture.width, d.irradianceTexture.height]);
      read.copyTextureToBuffer({ texture: d.visibilityTexture }, { buffer: readback, offset: moments.offset, bytesPerRow: d.visibilityTexture.width * 8 }, [d.visibilityTexture.width, d.visibilityTexture.height]);
      for (const [source, target] of [[d.stateBuffer, states], [d.rayBuffer, rays], [d.configBuffer, config], [d.statisticsBuffer, statistics], [output, sampled]] as const) {
        read.copyBufferToBuffer(source, 0, readback, target.offset, target.bytes);
      }
      device.queue.submit([read.finish()]); await readback.mapAsync(0x1);
      const copied = readback.getMappedRange().slice(0); readback.unmap();
      const actualConfig = decodeQualityConfig(copied.slice(config.offset, config.offset + config.bytes));
      require(actualConfig.frame === frameIndex && actualConfig.count === 32 && actualConfig.rays === 64 && actualConfig.maxAge === 12, 'Captured production config differs from fixed diagnostic contract.');
      const stateWords = new Uint32Array(copied, states.offset, states.bytes / 4); const rawRays = new Float32Array(copied, rays.offset, rays.bytes / 4);
      const irradianceWords = new Uint16Array(copied, irradiance.offset, irradiance.bytes / 2); const momentFloats = new Float32Array(copied, moments.offset, moments.bytes / 4);
      const gpuOutput = new Float32Array(copied, sampled.offset, sampled.bytes / 4);
      // Use the exact f32 positions transferred to the GPU when reconstructing its weights.
      const worlds = qualityPoints.map(point => point.world.map(Math.fround) as unknown as V3);
      const neighborhoods = worlds.map(world => contributors(world, actualConfig)); const ids = [...new Set(neighborhoods.flatMap(items => items.map(item => item.id)))].sort((a, b) => a - b);
      const probes: QualityProbe[] = ids.map(id => {
        const taps = octTaps([0, 1, 0], actualConfig.irradianceSize).map(tap => {
          const x = id % actualConfig.columns * actualConfig.irradianceSize + tap.x; const y = Math.floor(id / actualConfig.columns) * actualConfig.irradianceSize + tap.y;
          const offset = (y * d.irradianceTexture.width + x) * 4;
          return { ...tap, value: [0, 1, 2].map(channel => halfFloat(irradianceWords[offset + channel]!)) };
        });
        const state = [...stateWords.subarray(id * 4, id * 4 + 4)];
        const local = (id - actualConfig.start + actualConfig.probeCount) % actualConfig.probeCount;
        const capturedRays = local < actualConfig.count ? Array.from({ length: actualConfig.rays }, (_, ray) => [...rawRays.subarray((local * actualConfig.rays + ray) * 8, (local * actualConfig.rays + ray + 1) * 8)]) : undefined;
        const position = probePosition(id, actualConfig);
        if (capturedRays) for (const ray of capturedRays) {
          const direction: V3 = [ray[4]!, ray[5]!, ray[6]!]; const reference = qualityIncoming(renderer.currentScene, position, direction);
          maxTransferredRayRadianceError = Math.max(maxTransferredRayRadianceError, ...reference.radiance.map((value, channel) => Math.abs(value - ray[channel]!)));
          maxTransferredRayDistanceError = Math.max(maxTransferredRayDistanceError, Math.abs(reference.distance - ray[3]!)); rayComparisons++;
          require(reference.status === ray[7], `Independent ray status differs at probe ${id}, frame ${frameIndex}.`);
        }
        return { id, position, state, taps, irradiance: [0, 1, 2].map(channel => taps.reduce((sum, tap) => sum + tap.value[channel]! * tap.weight, 0)),
          ...(capturedRays ? { rawRays: capturedRays } : {}) };
      });
      const points: QualityPoint[] = neighborhoods.map((items, pointIndex) => {
        const neighbors = items.map(item => {
          const probe = probes.find(value => value.id === item.id)!;
          const eligible = probe.state[0] === actualConfig.epoch && probe.state[1] !== 0 && probe.state[3]! <= frameIndex && frameIndex - probe.state[3]! < actualConfig.maxAge;
          const taps = octTaps(item.direction, actualConfig.momentSize).map(tap => {
            const x = item.id % actualConfig.columns * actualConfig.momentSize + tap.x; const y = Math.floor(item.id / actualConfig.columns) * actualConfig.momentSize + tap.y;
            const offset = (y * d.visibilityTexture.width + x) * 2;
            return { ...tap, value: [momentFloats[offset]!, momentFloats[offset + 1]!] };
          });
          const value = [0, 1].map(channel => taps.reduce((sum, tap) => sum + tap.value[channel]! * tap.weight, 0));
          const visibility = visibilityWeight(item.distance, value);
          return { id: item.id, distance: item.distance, direction: item.direction, trilinear: item.trilinear, orientation: item.orientation, eligible,
            momentTaps: taps, moments: value, visibility, weight: eligible ? item.trilinear * item.orientation * visibility : 0,
            segmentOccluded: !!qualityHit(renderer.currentScene, item.position, item.direction, .002, item.distance - .002) };
        });
        const cpuRadiance = combineQuality(probes, neighbors); const gpuRadiance = [...gpuOutput.subarray(pointIndex * 4, pointIndex * 4 + 3)];
        maxSamplerReconstructionError = Math.max(maxSamplerReconstructionError, ...cpuRadiance.map((value, channel) => Math.abs(value - gpuRadiance[channel]!)));
        return { world: worlds[pointIndex]!, region: qualityPoints[pointIndex]!.region, biasedPoint: items[0]!.point,
          gpuRadiance, cpuRadiance, totalWeight: neighbors.reduce((sum, item) => sum + item.weight, 0), neighbors };
      });
      const traceCounters = [...new Uint32Array(copied, statistics.offset, 8)];
      require(traceCounters[0] === 2048 && traceCounters[3] === 0 && traceCounters[4]! <= 2048, 'Production ray budget/error regression.');
      require(probes.every(probe => probe.state[0] === actualConfig.epoch && probe.state[1] === 1 && frameIndex - probe.state[3]! <= 11), 'Selected probe became invalid/stale in static diagnostic.');
      require(points.flatMap(point => point.gpuRadiance).every(value => Number.isFinite(value) && value >= 0), 'Nonfinite or negative diffuse sample.');
      frames.push({ frameIndex, config: actualConfig, probes, points, traceCounters });
      if (frames.length % 24 === 0) console.log(`Probe quality diagnostic: capture ${frames.length}/${captureSubmissions}`);
      require(errors.length === 0 && !lost, `GPU failed: ${errors.join('; ')} ${lost?.message ?? ''}`);
    }
    require(maxSamplerReconstructionError < 5e-4, `CPU reconstruction does not match actual production GPU sampler: ${maxSamplerReconstructionError}.`);
    require(maxTransferredRayRadianceError < 5e-3 && maxTransferredRayDistanceError < 2e-3, `Independent transferred-ray mismatch: radiance ${maxTransferredRayRadianceError}, distance ${maxTransferredRayDistanceError}.`);
    require(rayComparisons > 0, 'No selected probe raw rays captured.');
  } catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); }
  finally { renderer.dispose(); for (const resource of resources) resource.destroy(); context.unconfigure(); device.destroy(); }
  return { adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter },
    frames, sceneState, maxSamplerReconstructionError, maxTransferredRayRadianceError, maxTransferredRayDistanceError, rayComparisons,
    warmupSubmissions, captureSubmissions, gpuErrors: errors, ...(failure ? { failure } : {}) };
}
