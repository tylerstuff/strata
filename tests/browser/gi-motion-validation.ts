import { ReflectionRenderer } from '../../packages/core/src/reflections/reflection-renderer.js';
import { createReflectionScene } from '../../packages/core/src/reflections/reflection-scene.js';
import type { ReflectionSceneData } from '../../packages/core/src/reflections/reflection-scene.js';
import { probeSamplingShader } from '../../packages/core/src/gi/probe-cache.js';
import type { GiControls } from '../../packages/core/src/gi/gi-types.js';

type V3 = readonly [number, number, number];
const regions: { name: string; world: V3 }[] = [
  { name: 'emitter-near-negative-z', world: [-0.45, 0, -0.3] },
  { name: 'emitter-near-positive-z', world: [-0.45, 0, 0.75] },
  { name: 'left-room-corner', world: [-5.2, 0, 3.1] },
  { name: 'doorway-right', world: [1.6, 0, 0] },
  { name: 'right-room-wall', world: [5.1, 0, -3.1] },
];
const patch = [-0.06, 0, 0.06].flatMap(x => [-0.06, 0, 0.06].map(z => [x, z] as const));
const require = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const energy = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0);

/** Independent oriented-box slab oracle. No production BVH, probe estimator or triangle traversal. */
function closest(scene: ReflectionSceneData, origin: V3, direction: V3) {
  let nearest: { distance: number; normal: V3; materialId: number } | undefined;
  for (const box of scene.boxes) {
    const c = Math.cos(box.yaw); const s = Math.sin(box.yaw);
    const delta: V3 = [origin[0] - box.center[0], origin[1] - box.center[1], origin[2] - box.center[2]];
    const o = [c * delta[0] - s * delta[2], delta[1], s * delta[0] + c * delta[2]];
    const d = [c * direction[0] - s * direction[2], direction[1], s * direction[0] + c * direction[2]];
    let enter = -Infinity; let exit = Infinity; let axis = 0; let sign = 0;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]!) < 1e-12) { if (Math.abs(o[k]!) > box.halfSize[k]!) exit = -Infinity; continue; }
      const a = (-box.halfSize[k]! - o[k]!) / d[k]!; const b = (box.halfSize[k]! - o[k]!) / d[k]!;
      const near = Math.min(a, b); if (near > enter) { enter = near; axis = k; sign = a < b ? -1 : 1; }
      exit = Math.min(exit, Math.max(a, b));
    }
    if (enter < 0.0001 || enter > exit || enter > 32 || (nearest && enter >= nearest.distance)) continue;
    const n = [0, 0, 0]; n[axis] = sign;
    nearest = { distance: enter, normal: [c * n[0]! + s * n[2]!, n[1]!, -s * n[0]! + c * n[2]!], materialId: box.materialId };
  }
  return nearest;
}

function reference(scene: ReflectionSceneData, samples = 8192, onlyRegion?: string) {
  return regions.filter(region => onlyRegion === undefined || region.name === onlyRegion).map(region => {
    const regionIndex = regions.indexOf(region);
    const blocks: number[][] = Array.from({ length: 4 }, () => [0, 0, 0]);
    let seed = (1337 + regionIndex * 101) >>> 0;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
    for (let i = 0; i < samples; i++) {
      const p = patch[i % patch.length]!;
      const origin: V3 = [region.world[0] + p[0], 0.002, region.world[2] + p[1]];
      const u = random(); const phi = random() * Math.PI * 2;
      const direction: V3 = [Math.sqrt(u) * Math.cos(phi), Math.sqrt(1 - u), Math.sqrt(u) * Math.sin(phi)];
      const hit = closest(scene, origin, direction); if (!hit) continue;
      const material = scene.materials[hit.materialId]!; const radiance = [...material.emission];
      const cosine = Math.max(0, dot(hit.normal, scene.light.direction));
      const point: V3 = [origin[0] + direction[0] * hit.distance + hit.normal[0] * 0.002,
        origin[1] + direction[1] * hit.distance + hit.normal[1] * 0.002, origin[2] + direction[2] * hit.distance + hit.normal[2] * 0.002];
      if (cosine > 0 && !closest(scene, point, scene.light.direction)) {
        for (let k = 0; k < 3; k++) radiance[k]! += material.albedo[k]! * (1 - (material.metallic ?? 0)) * scene.light.radiance[k]! * cosine / Math.PI;
      }
      // Cosine hemisphere integration cancels pi against the receiver's Lambertian BRDF.
      for (let k = 0; k < 3; k++) blocks[i % 4]![k]! += 0.72 * radiance[k]! * 4 / samples;
    }
    const mean = [0, 1, 2].map(k => blocks.reduce((total, block) => total + block[k]!, 0) / 4);
    const values = blocks.map(energy); const average = energy(mean);
    return { name: region.name, mean, energy: average, blockEnergyMeans: values,
      blockStandardError: Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / 3 / 4), samples };
  });
}

/** CPU-only derived references can extend uncertainty estimates without changing captured GPU evidence. */
export function computeGiMotionReferences(samples = 8192, onlyRegion?: string) {
  require(Number.isInteger(samples) && samples >= 1024 && samples <= 1048576 && samples % 4 === 0, 'Reference sample count must be1024..1048576 and divisible by4.');
  require(onlyRegion === undefined || regions.some(region => region.name === onlyRegion), 'Unknown diffuse reference region.');
  return Object.fromEntries([
    ['open-negative', { objectOffset: -.4 }], ['open-zero', { objectOffset: 0 }], ['open-positive', { objectOffset: .4 }],
    ['light-off', { lightIntensity: 0 }], ['door-closed', { doorOpen: false }],
  ].map(([name, options]) => [name, reference(createReflectionScene(options as Parameters<typeof createReflectionScene>[0]), samples, onlyRegion)]));
}

function validateReferenceOracle(): void {
  const scene = createReflectionScene();
  const box = { id: 0, name: 'oracle unit cube', center: [0, 0, 0] as V3, halfSize: [1, 1, 1] as V3, yaw: 0, materialId: 0 };
  const fixture = { ...scene, boxes: [box] };
  const hit = closest(fixture, [-2, 0, 0], [1, 0, 0]);
  require(hit?.distance === 1 && hit.normal[0] === -1, 'Independent slab reference failed known distance/normal.');
  require(!closest(fixture, [-2, 2, 0], [1, 0, 0]) && !closest(fixture, [-2, 0, 0], [-1, 0, 0]), 'Independent slab reference accepted a miss.');
  const rotated = closest({ ...scene, boxes: [{ ...box, yaw: Math.PI / 4 }] }, [-2, 0, 0], [1, 0, 0]);
  require(rotated !== undefined && Math.abs(rotated.distance - (2 - Math.SQRT2)) < 1e-12, 'Independent slab reference failed rotated box.');
}

interface Observation {
  phase: string; phaseFrame: number; frameIndex: number; objectOffset: number; gi: Record<string, number | string | boolean | null>;
  epochProbeCount: number; validProbeCount: number; maxObservationAge: number; updatedProbeIds: number[];
  states: number[]; diffuse: number[][]; traceCounters: number[];
}

export async function validateGiMotion({ smoke = false }: { smoke?: boolean } = {}) {
  validateReferenceOracle();
  const adapter = await navigator.gpu.requestAdapter(); if (!adapter) throw new Error('WebGPU adapter unavailable.');
  const device = await adapter.requestDevice(); const errors: string[] = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  let lost: GPUDeviceLostInfo | undefined; void device.lost.then(info => { lost = info; });
  const canvas = document.querySelector('canvas')!; canvas.width = 320; canvas.height = 180;
  const context = canvas.getContext('webgpu') as GPUCanvasContext; context.configure({ device, format: 'bgra8unorm', alphaMode: 'opaque' });
  const renderer = await ReflectionRenderer.create(device, 'bgra8unorm', { renderer: 'reflections', cameraMode: 'overview', probesPerUpdate: 32, raysPerProbe: 64 });
  const resources: GPUBuffer[] = [];
  const buffer = (size: number, usage: number) => { const b = device.createBuffer({ size, usage }); resources.push(b); return b; };
  const positions = buffer(regions.length * patch.length * 16, 0x80 | 0x8);
  const output = buffer(regions.length * patch.length * 16, 0x80 | 0x4);
  const readback = buffer(6144 + output.size + 32, 0x1 | 0x8);
  device.queue.writeBuffer(positions, 0, new Float32Array(regions.flatMap(r => patch.flatMap(p => [r.world[0] + p[0], r.world[1], r.world[2] + p[1], 0]))));
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
@compute @workgroup_size(64) fn sampleRegions(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=arrayLength(&positions)){return;}
  diffuse[id.x]=vec4f(sampleProbeIrradiance(positions[id.x].xyz,vec3f(0,1,0),vec3f(0,1,0))*(0.72/3.141592653589793),1);
}` }), entryPoint: 'sampleRegions' } });
  const sampleGroup = device.createBindGroup({ layout: sampleLayout, entries: [{ binding: 0, resource: { buffer: positions } }, { binding: 1, resource: { buffer: output } }] });
  const samples: Observation[] = []; let frameIndex = 0; let offset = 0;
  async function frame(phase: string, phaseFrame: number, objectOffset: number, gi: GiControls = {}) {
    offset = objectOffset; const encoder = device.createCommandEncoder();
    renderer.encode(encoder, context.getCurrentTexture().createView(), 320, 180, frameIndex / 60,
      { temporal: false, gi, reflections: { mode: 'off', objectOffset } });
    device.queue.submit([encoder.finish()]); renderer.submitted(frameIndex + 1);
    const bindings = renderer.probeCache.bindings; const diagnostics = renderer.probeCache.diagnostics;
    const group = device.createBindGroup({ layout: probeLayout, entries: [{ binding: 0, resource: bindings.irradiance },
      { binding: 1, resource: bindings.visibility }, { binding: 2, resource: { buffer: bindings.state } }, { binding: 3, resource: { buffer: bindings.uniform } }] });
    const read = device.createCommandEncoder(); const pass = read.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.setBindGroup(1, sampleGroup); pass.dispatchWorkgroups(1); pass.end();
    read.copyBufferToBuffer(diagnostics.stateBuffer, 0, readback, 0, 6144);
    read.copyBufferToBuffer(output, 0, readback, 6144, output.size);
    read.copyBufferToBuffer(diagnostics.statisticsBuffer, 0, readback, 6144 + output.size, 32);
    device.queue.submit([read.finish()]); await readback.mapAsync(0x1);
    const copied = readback.getMappedRange().slice(0); readback.unmap();
    const words = new Uint32Array(copied); const floats = new Float32Array(copied); const epoch = Number(renderer.giTelemetry.cacheEpoch);
    const ids = Array.from({ length: 384 }, (_, i) => i); const current = ids.filter(i => words[i * 4] === epoch);
    const updated = ids.filter(i => words[i * 4] === epoch && words[i * 4 + 3] === frameIndex);
    const diffuse = regions.map((_, r) => [0, 1, 2].map(channel => patch.reduce((sum, _p, j) => sum + floats[1536 + (r * patch.length + j) * 4 + channel]!, 0) / patch.length));
    require(diffuse.flat().every(v => Number.isFinite(v) && v >= 0), 'Nonfinite/negative regional diffuse radiance.');
    const traceCounters = [...words.subarray((6144 + output.size) / 4)];
    require(updated.length === 32 && traceCounters[0] === 2048 && traceCounters[4]! <= 2048 && traceCounters[3] === 0, 'Probe scheduling/ray cap/traversal failure.');
    require(renderer.probeCache.gpuBufferBytes === 71904 && renderer.probeCache.gpuTextureBytes === 1966080, 'Probe memory budget changed.');
    const observation = { phase, phaseFrame, frameIndex, objectOffset, gi: { ...renderer.giTelemetry }, epochProbeCount: current.length,
      validProbeCount: current.filter(i => words[i * 4 + 1] !== 0).length,
      maxObservationAge: Math.max(...current.map(i => frameIndex - words[i * 4 + 3]!)), updatedProbeIds: updated,
      states: [...words.subarray(0, 1536)], diffuse, traceCounters };
    samples.push(observation); frameIndex++; require(errors.length === 0 && !lost, `GPU failure: ${errors.join('; ')} ${lost?.message ?? ''}`); return observation;
  }
  const phases = [
    { name: 'cold-motion', count: 36, motion: true }, { name: 'static-open', count: 240, gi: { resetCache: true } },
    { name: 'warm-motion', count: 96, motion: true }, { name: 'motion-stopped', count: 240 },
    { name: 'light-off', count: 48, gi: { lightIntensity: 0 } }, { name: 'light-on', count: 48, gi: { lightIntensity: 1 } },
    { name: 'door-closed', count: 240, gi: { doorOpen: false } }, { name: 'door-open', count: 240, gi: { doorOpen: true } },
  ].map(phase => ({ ...phase, count: smoke && phase.name !== 'cold-motion' ? 12 : phase.count }));
  try {
    const references = computeGiMotionReferences(smoke ? 1024 : 8192);
    for (const phase of phases) {
      const previousEpoch = Number(renderer.giTelemetry.cacheEpoch);
      if (phase.name === 'door-closed') {
        const discarded = device.createCommandEncoder();
        renderer.encode(discarded, context.getCurrentTexture().createView(), 320, 180, frameIndex / 60,
          { temporal: false, gi: phase.gi!, reflections: { mode: 'off', objectOffset: 0 } });
        renderer.cancelFrame();
        require(Number(renderer.giTelemetry.cacheEpoch) === previousEpoch, 'Canceled hard frame committed a diffuse epoch.');
      }
      for (let i = 0; i < phase.count; i++) {
        const observation = await frame(phase.name, i, phase.motion ? .4 * Math.sin(i * Math.PI / 24) : 0,
          i === 0 && phase.name !== 'door-closed' ? phase.gi ?? {} : {});
        const rolling = observation.gi.objectMotionRollingRefresh === true;
        if (phase.gi && i === 0) require(Number(observation.gi.cacheEpoch) === previousEpoch + 1 && observation.epochProbeCount === 32, 'Hard reset retained prior-epoch probes.');
        if (rolling && i >= 11) require(observation.epochProbeCount === 384 && observation.maxObservationAge <= 11, 'Continuous motion starved or aged out a probe update.');
      }
      console.log(`GI motion diagnostic: ${phase.name}, ${phase.count} submissions complete.`);
    }
    const cold = samples.filter(s => s.phase === 'cold-motion');
    const rolling = cold[0]!.gi.objectMotionRollingRefresh === true;
    require(rolling ? cold[11]!.epochProbeCount === 384 : cold.slice(1).every(s => s.epochProbeCount === 32), 'Motion policy diagnosis differs from actual GPU states.');
    const summaries = phases.map(phase => {
      const values = samples.filter(s => s.phase === phase.name); const tail = values.slice(-24);
      const target = phase.name === 'light-off' ? 'light-off' : phase.name === 'door-closed' ? 'door-closed' : 'open-zero';
      return { name: phase.name, frames: phase.count, lastEpochProbeCount: values.at(-1)!.epochProbeCount,
        minValidProbeCount: Math.min(...values.map(s => s.validProbeCount)), maxObservationAge: Math.max(...values.map(s => s.maxObservationAge)),
        regions: regions.map((r, index) => {
          const energies = tail.map(s => energy(s.diffuse[index]!)); const mean = energy(tail.reduce((sum, s) => sum.map((v, k) => v + s.diffuse[index]![k]! / tail.length), [0, 0, 0]));
          const ref = references[target]![index]!; const variance = energies.reduce((sum, v) => sum + (v - mean) ** 2, 0) / energies.length;
          const threshold = Math.max(0.00001, ref.energy * .2);
          const stable = values.findIndex((_, i) => values.slice(i).every(s => Math.abs(energy(s.diffuse[index]!) - ref.energy) <= threshold));
          return { name: r.name, meanEnergy: mean, standardDeviation: Math.sqrt(variance), relativeBias: phase.motion ? null : (mean - ref.energy) / Math.max(ref.energy, 1e-8),
            reference: phase.motion ? null : ref, firstSubmissionAllRemainingWithin20PercentOfReference: phase.motion ? null : stable < 0 ? null : stable + 1,
            censored: !phase.motion && stable < 0, firstEnergy: energy(values[0]!.diffuse[index]!), twelfthEnergy: energy(values[11]!.diffuse[index]!) };
        }) };
    });
    const motionReferenceSamples = samples.filter(s => s.phase === 'warm-motion' && s.phaseFrame % 12 === 0).map(s => {
      const target = Math.abs(s.objectOffset) < 1e-6 ? 'open-zero' : s.objectOffset < 0 ? 'open-negative' : 'open-positive';
      return { frameIndex: s.frameIndex, phaseFrame: s.phaseFrame, objectOffset: s.objectOffset, reference: target,
        regions: s.diffuse.map((v, i) => ({ name: regions[i]!.name, energy: energy(v), expectedEnergy: references[target]![i]!.energy,
          error: energy(v) - references[target]![i]!.energy })) };
    });
    // Deliberately advance only the diagnostic sampling clock after normal rendering.
    // This proves the GPU sampler excludes missed refreshes, rather than merely reporting old ages.
    const bindings = renderer.probeCache.bindings;
    device.queue.writeBuffer(bindings.uniform, 64, new Uint32Array([frameIndex + 12]));
    const staleGroup = device.createBindGroup({ layout: probeLayout, entries: [{ binding: 0, resource: bindings.irradiance },
      { binding: 1, resource: bindings.visibility }, { binding: 2, resource: { buffer: bindings.state } }, { binding: 3, resource: { buffer: bindings.uniform } }] });
    const staleEncoder = device.createCommandEncoder(); const stalePass = staleEncoder.beginComputePass();
    stalePass.setPipeline(pipeline); stalePass.setBindGroup(0, staleGroup); stalePass.setBindGroup(1, sampleGroup); stalePass.dispatchWorkgroups(1); stalePass.end();
    staleEncoder.copyBufferToBuffer(output, 0, readback, 0, output.size); device.queue.submit([staleEncoder.finish()]);
    await readback.mapAsync(0x1); const stale = new Float32Array(readback.getMappedRange().slice(0, output.size)); readback.unmap();
    const staleMaximum = Math.max(...stale.filter((_value, index) => index % 4 !== 3));
    if (rolling) require(staleMaximum === 0, 'Aged-out probe observations still contributed light.');
    require(errors.length === 0 && !lost, 'GPU error during age-exclusion probe.');
    return { scope: smoke ? 'bounded-motion-regression' : 'motion-and-independent-reference-diagnostic', policy: rolling ? 'bounded-object-motion-v1' : 'legacy-world-epoch-v1', adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description },
      units: 'submitted frame ticks and linear Lambertian diffuse radiance; not elapsed performance evidence',
      settings: { probesPerUpdate: 32, raysPerProbe: 64, probeCount: 384, hysteresis: .85, temporal: false, reflections: 'off', seed: 1337 },
      sampleDefinition: { regions, patch, normal: [0, 1, 0], viewDirection: [0, 1, 0], receiverAlbedo: .72, diagnosticGain: 1 },
      referenceDefinition: `Independent oriented-box closest/slab shadow oracle; ${smoke ? 1024 : 8192} cosine-weighted hemisphere samples across each 3x3 surface patch, four deterministic blocks. Direct light on traced diffuse hits plus emission; no probe interpolation/history.`,
      limitations: ['A12-frame observation cycle is not a12-frame irradiance-contribution bound: the retained .85 hysteresis carries older weighted light.',
        'Finite Monte Carlo reference and finite observed windows do not establish convergence. Moving-light bias compares matching frozen configurations; it includes spatial probe approximation and temporal lag.',
        'Broad raster TAA/reflection resets and unfiltered visibility moments remain unchanged; this isolates starvation and does not close issue15.'],
      references, summaries, motionReferenceSamples, samples, hardDoorCancellationRetried: true,
      ageExclusion: { testOnlySamplingFrameIndex: frameIndex + 12, lastNormalFrameIndex: frameIndex - 1, maximumDiffuseAfterClockAdvance: staleMaximum },
      gpuErrors: errors, deviceLost: lost ?? null };
  } finally {
    renderer.dispose(); for (const resource of resources) resource.destroy(); context.unconfigure();
    require(renderer.gpuBufferBytes === 0 && renderer.gpuTextureBytes === 0, 'Renderer disposal retained tracked allocations.'); device.destroy();
  }
}
