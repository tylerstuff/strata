import { importedIndirectShader } from '../../packages/core/src/imported/imported-indirect-shader.js';
import { importedIndirectSpatialShader } from '../../packages/core/src/imported/imported-indirect-spatial-shader.js';
import {
  makeSpatialTruthFixture, referenceSpatialPixel, roundSpatialPixelToF32, spatialTruthGates, spatialTruthSeeds,
  type ReferenceSpatialPixel, type SpatialVector,
} from '../helpers/imported-indirect-spatial-reference.js';

const require = (value: unknown, message: string): void => { if (!value) throw new Error(message); };
async function bounded<T>(promise: Promise<T>, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} exceeded 15 seconds.`)), 15_000);
  })]).finally(() => clearTimeout(timer));
}
const bits = (value: number): number => new Uint32Array(new Float32Array([value]).buffer)[0]!;
const float = (word: number): number => new Float32Array(new Uint32Array([word]).buffer)[0]!;
const vec = (value: readonly number[]): SpatialVector => [value[0]!, value[1]!, value[2]!];
/** Independent nearest-even binary16 conversion for test uploads. */
function half(value: number): number {
  const word = bits(value), sign = (word >>> 16) & 0x8000, exponent = (word >>> 23) & 255, fraction = word & 0x7fffff;
  if (exponent === 255) return sign | 0x7c00 | (fraction ? 0x200 : 0);
  if (exponent < 102) return sign;
  if (exponent > 142) return sign | 0x7c00;
  const shift = exponent < 113 ? 126 - exponent : 13;
  const mantissa = exponent < 113 ? fraction | 0x800000 : fraction;
  let rounded = Math.floor(mantissa / 2 ** shift);
  const remainder = mantissa - rounded * 2 ** shift;
  if (remainder > 2 ** (shift - 1) || (remainder === 2 ** (shift - 1) && rounded % 2)) rounded++;
  return sign | ((exponent < 113 ? 0 : exponent - 112) << 10) + rounded;
}
function unhalf(word: number): number {
  const sign = word & 0x8000 ? -1 : 1, exponent = (word >>> 10) & 31, fraction = word & 1023;
  return sign * (exponent === 0 ? fraction * 2 ** -24 : exponent === 31 ? (fraction ? NaN : Infinity) : (1 + fraction / 1024) * 2 ** (exponent - 15));
}
async function sha(value: string | ArrayBuffer): Promise<string> {
  const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(v => v.toString(16).padStart(2, '0')).join('');
}
function planar(width = 9, height = 9): ReferenceSpatialPixel[] {
  return Array.from({ length: width * height }, (_, index) => ({ sum: [32, 16, 48], samples: 64, status: 0,
    direct: [.125, .25, .5], guide: { valid: true, rho: [.5, .25, .75],
      point: [index % width, Math.floor(index / width), 0], normal: [0, 0, 1], footprint: 1, triangleExtent: 2, materialId: 0 } }));
}
const orthoInverse = [4, 0, 0, 0, 0, 4, 0, 0, 0, 0, -8, 0, 0, 0, 4, 1];
const orthoProjection = [.25, 0, 0, 0, 0, .25, 0, 0, 0, 0, -.125, 0, 0, 0, .5, 1];

// Appended diagnostic entry points call production helpers. They neither replace
// helper arithmetic nor write raw accumulation; their outputs remain f32 storage.
const probes = /* wgsl */ `
struct SpatialProbe { words: vec4u, point: vec4f, normal: vec4f, pixel: vec4f, };
struct SpatialProbeOutput { a: vec4f, b: vec4f, };
@group(3) @binding(0) var<storage, read> spatialProbeInputs: array<SpatialProbe>;
@group(3) @binding(1) var<storage, read_write> spatialProbeOutputs: array<SpatialProbeOutput>;
@compute @workgroup_size(32) fn querySpatialHelpers(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&spatialProbeInputs)) { return; }
  let query = spatialProbeInputs[id.x]; var output: SpatialProbeOutput;
  if (query.words.w == 0u) {
    let raw = spatialRawColor(query.words.x, query.words.y, query.words.z);
    let mean = spatialRawMean(query.words.x, query.words.y);
    output.a = vec4f(raw.mean, raw.color, select(0.0, 1.0, raw.valid), select(0.0, 1.0, mean.positive));
  } else if (query.words.w == 1u) {
    output.a = vec4f(select(0.0, 1.0, spatialIdentityValid(query.words.x)), f32(query.words.x & SPATIAL_ID_MASK),
      select(0.0, 1.0, (query.words.x & SPATIAL_FLIPPED) != 0u), 0.0);
  } else if (query.words.w == 2u) {
    let a = indirectSpatial.records[query.words.x]; let b = indirectSpatial.records[query.words.y];
    if (spatialGuideValid(a) && spatialGuideValid(b)) {
      output.a.x = spatialPairWeight(a, b, vec2i(query.pixel.xy));
    }
    output.a.y = select(0.0, 1.0, spatialGuideValid(a)); output.a.z = select(0.0, 1.0, spatialGuideValid(b));
  } else if (query.words.w == 3u) {
    output.a = spatialTangentPoint(query.pixel.xy, query.point.xyz, query.normal.xyz);
    output.b = spatialTangentPoint(query.pixel.xy + vec2f(1.0, 0.0), query.point.xyz, query.normal.xyz);
  } else {
    let incident = spatialIncident(query.words.x, query.words.y, query.words.z);
    output.a = vec4f(incident.value, select(0.0, 1.0, incident.valid), select(0.0, 1.0, incident.omitted), 0.0);
    if (incident.valid && !incident.omitted) {
      let remodulated = spatialRemodulate(incident.value, query.words.z, bitcast<u32>(query.point.x));
      output.b = vec4f(remodulated.indirect, remodulated.color, select(0.0, 1.0, remodulated.valid), 0.0);
    }
  }
  spatialProbeOutputs[id.x] = output;
}
`;

/** Bounded generated fixtures through actual production WGSL. No image assets,
 * texture-coordinate blur, exposure fitting, or performance claims participate.
 */
export async function validateImportedSpatial() {
  const adapter = await navigator.gpu.requestAdapter(); require(adapter, 'No WebGPU adapter.');
  const device = await adapter!.requestDevice();
  const liveBuffers = new Set<GPUBuffer>(), liveTextures = new Set<GPUTexture>();
  const errors: string[] = [], cases: unknown[] = [];
  const onError = (event: GPUUncapturedErrorEvent) => errors.push(event.error.message);
  device.addEventListener('uncapturederror', onError);
  let scopes = 3; device.pushErrorScope('validation'); device.pushErrorScope('out-of-memory'); device.pushErrorScope('internal');
  const buffer = (name: string, data: ArrayBuffer | number, usage = 0x80 | 0x08 | 0x04) => {
    const result = device.createBuffer({ label: name, size: typeof data === 'number' ? data : data.byteLength, usage });
    liveBuffers.add(result); if (typeof data !== 'number') device.queue.writeBuffer(result, 0, data); return result;
  };
  const texture = (name: string, width: number, height: number, format: GPUTextureFormat, usage: number) => {
    const result = device.createTexture({ label: name, size: [width, height], format, usage }); liveTextures.add(result); return result;
  };
  const removeBuffer = (value: GPUBuffer) => { value.destroy(); liveBuffers.delete(value); };
  const removeTexture = (value: GPUTexture) => { value.destroy(); liveTextures.delete(value); };
  try {
    require(half(1) === 0x3c00 && half(65472) === 0x7bfe && unhalf(0x0001) === 2 ** -24
      && half(2 ** -25) === 0 && half(2 ** -25 * 1.5) === 1 && half(2 ** -24) === 1, 'Independent FP16 conversion failure.');
    const group0Layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: 4, buffer: { type: 'uniform', minBindingSize: 288 } },
      { binding: 1, visibility: 4, texture: { sampleType: 'depth' } },
      { binding: 2, visibility: 4, texture: { sampleType: 'unfilterable-float' } },
      { binding: 3, visibility: 4, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ] });
    const group1Layout = device.createBindGroupLayout({ entries: Array.from({ length: 7 }, (_, binding) => ({ binding,
      visibility: 4, buffer: { type: binding < 4 ? 'read-only-storage' as const : 'storage' as const } })) });
    const group2Layout = device.createBindGroupLayout({ entries: Array.from({ length: 6 }, (_, binding) => binding % 2 === 0
      ? { binding, visibility: 4, texture: { sampleType: 'float' as const } }
      : { binding, visibility: 4, sampler: { type: 'filtering' as const } }) });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [group0Layout, group1Layout, group2Layout] });
    const module = device.createShaderModule({ label: 'Actual optional imported diffuse reconstruction', code: importedIndirectSpatialShader });
    const compose = await bounded(device.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'composeImportedIndirect' } }), 'Spatial compose pipeline');
    const trace = await bounded(device.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'traceImportedIndirect' } }), 'Spatial trace pipeline');
    const probeModule = device.createShaderModule({ label: 'Production helpers plus numerical queries', code: importedIndirectSpatialShader + probes });
    const probePipeline = await bounded(device.createComputePipelineAsync({ layout: 'auto', compute: { module: probeModule, entryPoint: 'querySpatialHelpers' } }), 'Spatial helper pipeline');
    const white = texture('Generated white material', 1, 1, 'rgba8unorm', 0x04 | 0x02);
    const black = texture('Generated zero metallic/emission', 1, 1, 'rgba8unorm', 0x04 | 0x02);
    device.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), {}, [1, 1]);
    device.queue.writeTexture({ texture: black }, new Uint8Array([0, 0, 0, 255]), {}, [1, 1]);
    const sampler = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest' });
    const group2 = device.createBindGroup({ layout: group2Layout, entries: [white.createView(), sampler, black.createView(), sampler, black.createView(), sampler]
      .map((resource, binding) => ({ binding, resource })) });
    const dummy = buffer('Unreferenced node/source placeholders', new ArrayBuffer(64));

    function pack(input: readonly ReferenceSpatialPixel[], metadata?: readonly number[]) {
      const pixels = input.map(p => { const q = roundSpatialPixelToF32(p); return { ...q, direct: vec(q.direct.map(v => unhalf(half(v)))) }; });
      const states = new ArrayBuffer(pixels.length * 32), guides = new ArrayBuffer(16 + pixels.length * 32), triangles = new ArrayBuffer(pixels.length * 64);
      const s = new DataView(states), g = new DataView(guides), t = new DataView(triangles);
      pixels.forEach((p, index) => {
        p.sum.forEach((v, c) => s.setUint32(index * 32 + c * 4, bits(v), true));
        s.setUint32(index * 32 + 12, p.samples, true); s.setUint32(index * 32 + 16, p.samples, true); s.setUint32(index * 32 + 20, p.status, true);
        p.guide.rho.forEach((v, c) => g.setUint32(16 + index * 32 + c * 4, bits(v), true));
        g.setUint32(16 + index * 32 + 12, metadata?.[index] ?? (index | (p.guide.valid ? 0x00100000 : 0)), true);
        p.guide.point.forEach((v, c) => g.setFloat32(16 + index * 32 + 16 + c * 4, v, true));
        g.setFloat32(16 + index * 32 + 28, p.guide.footprint, true);
        // Extent is independently known from the fixed X edge. Source IDs are
        // deliberately reordered; a packed-index/source-ID mix-up is observable.
        const [x, y, z] = p.guide.point, e = p.guide.triangleExtent;
        [x, y, z].forEach((v, c) => t.setFloat32(index * 64 + c * 4, v, true));
        [x + e, y, z].forEach((v, c) => t.setFloat32(index * 64 + 16 + c * 4, v, true));
        [x, y + e, z].forEach((v, c) => t.setFloat32(index * 64 + 32 + c * 4, v, true));
        p.guide.normal.forEach((v, c) => t.setFloat32(index * 64 + 48 + c * 4, v, true));
        t.setUint32(index * 64 + 12, p.guide.materialId, true); t.setUint32(index * 64 + 44, pixels.length - index - 1, true);
      });
      return { pixels, states, guides, triangles };
    }

    async function runCase(name: string, input: readonly ReferenceSpatialPixel[], width: number, height: number,
      enabled = true, metadata?: readonly number[]) {
      const packed = pack(input, metadata), owned: GPUBuffer[] = [], images: GPUTexture[] = [];
      const own = (name: string, data: ArrayBuffer | number, usage?: number) => { const b = buffer(name, data, usage); owned.push(b); return b; };
      try {
        const uniformBytes = new ArrayBuffer(288), uf = new Float32Array(uniformBytes), uw = new Uint32Array(uniformBytes);
        uf.set(orthoInverse); uf.set(orthoProjection, 16); uw.set([width, height, 0, width * height], 36);
        uw.set([64, 4096, 1337, 1], 40); uf[67] = enabled ? 1 : 0;
        const uniform = own(name + ' frame', uniformBytes, 0x40 | 0x08);
        const stateBuffer = own(name + ' exact raw words', packed.states), guideBuffer = own(name + ' guide and header', packed.guides);
        const rawCounters = new Uint32Array([101, 73, 17, 11]);
        const triangleBuffer = own(name + ' independently packed triangles', packed.triangles), counter = own(name + ' untouched trace counters', rawCounters.buffer);
        const direct = texture(name + ' direct HDR', width, height, 'rgba16float', 0x04 | 0x02); images.push(direct);
        const depth = texture(name + ' unused composition depth', width, height, 'depth32float', 0x04 | 0x10); images.push(depth);
        const output = texture(name + ' actual composed HDR', width, height, 'rgba16float', 0x08 | 0x01); images.push(output);
        const directBytes = new Uint16Array(width * height * 4);
        packed.pixels.forEach((p, i) => directBytes.set([...p.direct, (i % 4 + 1) / 4].map(half), i * 4));
        device.queue.writeTexture({ texture: direct }, directBytes, { bytesPerRow: width * 8 }, [width, height]);
        const group0 = device.createBindGroup({ layout: group0Layout, entries: [
          { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: depth.createView() },
          { binding: 2, resource: direct.createView() }, { binding: 3, resource: output.createView() },
        ] });
        const group1 = device.createBindGroup({ layout: group1Layout, entries: [dummy, triangleBuffer, dummy, dummy, stateBuffer, counter, guideBuffer]
          .map((value, binding) => ({ binding, resource: { buffer: value } })) });
        const row = Math.ceil(width * 8 / 256) * 256, textureBytes = row * height, stateOffset = textureBytes + 16;
        const counterOffset = stateOffset + packed.states.byteLength + packed.guides.byteLength;
        const readback = own(name + ' output/header/raw readback', counterOffset + 16, 0x01 | 0x08);
        const encoder = device.createCommandEncoder(); encoder.clearBuffer(guideBuffer, 0, 16);
        const pass = encoder.beginComputePass(); pass.setPipeline(compose); pass.setBindGroup(0, group0); pass.setBindGroup(1, group1); pass.setBindGroup(2, group2);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
        encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: row }, [width, height]);
        encoder.copyBufferToBuffer(guideBuffer, 0, readback, textureBytes, 16);
        encoder.copyBufferToBuffer(stateBuffer, 0, readback, stateOffset, packed.states.byteLength);
        encoder.copyBufferToBuffer(guideBuffer, 0, readback, stateOffset + packed.states.byteLength, packed.guides.byteLength);
        encoder.copyBufferToBuffer(counter, 0, readback, counterOffset, 16);
        device.queue.submit([encoder.finish()]); await bounded(readback.mapAsync(1), `${name} readback`);
        const result = readback.getMappedRange().slice(0); readback.unmap();
        const actualBytes = new Uint8Array(result, stateOffset, packed.states.byteLength), originalBytes = new Uint8Array(packed.states);
        require(actualBytes.every((v, i) => v === originalBytes[i]), `${name}: composition mutated raw state.`);
        const actualGuides = new Uint8Array(result, stateOffset + packed.states.byteLength + 16, packed.guides.byteLength - 16);
        require(actualGuides.every((v, i) => v === new Uint8Array(packed.guides, 16)[i]), `${name}: composition mutated guide records.`);
        require(new Uint32Array(result, counterOffset, 4).every((v, i) => v === rawCounters[i]), `${name}: composition mutated original tracing counters.`);
        const headers = [...new Uint32Array(result, textureBytes, 4)], expectedHeaders = [0, 0, 0, 0];
        const data = new DataView(result), rgb: SpatialVector[] = []; let maxError = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const expected = referenceSpatialPixel(packed.pixels, width, height, x, y, { enabled });
          expectedHeaders[0]! += Number(expected.filtered); expectedHeaders[1]! += expected.fallbackChannels;
          expectedHeaders[2]! += expected.hdrFaultChannels; expectedHeaders[3]! += Number(expected.guideBypass);
          const color = vec([0, 1, 2].map(c => unhalf(data.getUint16(y * row + x * 8 + c * 2, true))));
          require(color.every(Number.isFinite), `${name}: nonfinite FP16 output.`);
          require(unhalf(data.getUint16(y * row + x * 8 + 6, true)) === ((y * width + x) % 4 + 1) / 4, `${name}: direct/shadow alpha changed.`);
          const target = expected.hdrFaultChannels ? [1, 0, 1] : expected.composed;
          color.forEach((value, c) => {
            const error = Math.abs(value - target[c]!); maxError = Math.max(maxError, error);
            require(error <= spatialTruthGates.gpuAbsoluteTolerance + spatialTruthGates.gpuRelativeTolerance * Math.abs(target[c]!),
              `${name} pixel${x},${y} channel${c}: ${value} vs independent${target[c]}.`);
            if (target[c] === 0) require(value === 0, `${name}: exact zero acquired energy.`);
          });
          rgb.push(color);
        }
        require(headers.every((v, i) => v === expectedHeaders[i]), `${name}: header${headers} vs independent${expectedHeaders}.`);
        const summary = { name, width, height, enabled, headers, expectedHeaders, maxError,
          rawStateUnchanged: true, rawCountersUnchanged: true, guideRecordsUnchanged: true, center: rgb[Math.floor(height / 2) * width + Math.floor(width / 2)],
          rawInputSha256: await sha(packed.states), guideInputSha256: await sha(packed.guides) };
        cases.push(summary); return { ...summary, rgb, pixels: packed.pixels };
      } finally { owned.forEach(removeBuffer); images.forEach(removeTexture); }
    }

    const constant = planar().map((p, i) => {
      const rho = vec([[0, .25, .75], [.5, 0, .125], [2 ** -16, 2, 0], [0, 0, 0]][i % 4]!);
      return { ...p, sum: vec(rho.map((v, c) => v * [1, 2, .5][c]! * 64)), guide: { ...p.guide, rho } };
    });
    await runCase('constant-illumination-exact-rho-and-zero-channels', constant, 9, 9);
    const dark = planar().map(p => ({ ...p, direct: [0, 0, 0] as SpatialVector, sum: [2 ** -10, 2 ** -8, 2 ** -6] as SpatialVector,
      guide: { ...p.guide, rho: [2 ** -16, 2 ** -15, 2 ** -14] as SpatialVector } }));
    const darkResult = await runCase('dark-rho-pure-GI-exact-half-bits', dark, 9, 9);
    darkResult.rgb.forEach(p => p.forEach((v, c) => require(v === [2 ** -16, 2 ** -14, 2 ** -12][c], 'Dark rho energy lost behind an absolute tolerance.')));
    await runCase('off-is-unfiltered-raw', planar(), 9, 9, false);
    const zeros = planar().map(p => ({ ...p, sum: [0, 0, 0] as SpatialVector }));
    zeros[40] = { ...zeros[40]!, sum: [64, 64, 64] };
    const zeroResult = await runCase('completed-zero-donors-keep-weight', zeros, 9, 9);
    require(zeroResult.center?.every((v, c) => Math.abs(v - ([.125, .25, .5][c]! + 36 / 256)) <= .001), 'Known central binomial weight is wrong.');
    for (const status of [2, 3, 4]) {
      const unknown = planar().map(p => ({ ...p, status })); unknown[40] = planar()[40]!;
      await runCase(`status${status}-donors-excluded-centers-direct-only`, unknown, 9, 9);
    }
    await runCase('unknown-raw-poison-is-not-relabelled-HDR-fault', planar().map(p => ({ ...p, status: 2, sum: [NaN, -1, Infinity] as SpatialVector })), 9, 9);
    await runCase('partial-sweep-stale-guide-cannot-fill-unsampled', planar().map((p, i) => i % 3 ? p : { ...p, samples: 0 }), 9, 9);
    await runCase('invalid-center-and-donor-guides-bypass', planar().map((p, i) => ({ ...p, guide: { ...p.guide, valid: i % 3 !== 0 } })), 9, 9);
    for (const rho of [2 ** -17, 2 ** -149]) {
      const tiny = planar(); tiny[40] = { ...tiny[40]!, guide: { ...tiny[40]!.guide, rho: [rho, .25, .75] } };
      await runCase(`tiny-rho-${rho}-whole-channel-fallback`, tiny, 9, 9);
    }
    const heterogeneous = planar();
    heterogeneous[40] = { ...heterogeneous[40]!, sum: [16, 8, 48] };
    heterogeneous[41] = { ...heterogeneous[41]!, guide: { ...heterogeneous[41]!.guide, rho: [2 ** -17, .25, .75] } };
    const channelFallback = await runCase('heterogeneous-unsafe-donor-fallback-is-channel-local', heterogeneous, 9, 9);
    require(channelFallback.center?.[0] === .125 + .25,
      'Unsafe eligible red donor was omitted/renormalized instead of preserving the heterogeneous raw center.');
    // Green remains eligible: the center's lower raw value must gather its
    // neighbors. This distinguishes whole-pixel fallback from channel fallback.
    require(channelFallback.center![1] > .25 + .125 && channelFallback.center![1] < .25 + .25,
      'A red-channel fallback incorrectly prevented independent green reconstruction.');
    const underflow = planar(); underflow[40] = { ...underflow[40]!, sum: [2 ** -120, 16, 48] };
    await runCase('positive-donor-below-normal-irradiance-domain', underflow, 9, 9);
    for (const bad of [float(1), NaN, Infinity, -1, 65504 * 64 + 1024]) {
      const faulty = planar(1, 1); faulty[0] = { ...faulty[0]!, sum: [bad, 16, 48] };
      await runCase(`raw-hdr-fault-${String(bad)}`, faulty, 1, 1, false);
    }
    const overflow = planar(); overflow[40] = { ...overflow[40]!, direct: [65472, .25, .5], sum: [0, 16, 48] };
    await runCase('remodulated-plus-direct-overflow-preserves-proved-raw', overflow, 9, 9);
    for (const kind of ['depth', 'normal', 'material', 'world-distance'] as const) {
      const edge = planar().map((p, i) => {
        if (i % 9 < 4) return { ...p, sum: [0, 0, 0] as SpatialVector };
        const g = p.guide;
        return { ...p, sum: [128, 128, 128] as SpatialVector, guide: { ...g,
          point: kind === 'depth' ? [g.point[0], g.point[1], .25] as SpatialVector
            : kind === 'world-distance' ? [g.point[0] + 64, g.point[1], 0] as SpatialVector : g.point,
          normal: kind === 'normal' ? [0, 0, -1] as SpatialVector : g.normal,
          materialId: kind === 'material' ? 1 : 0 } };
      });
      const result = await runCase(`${kind}-boundary-independent-rejection`, edge, 9, 9);
      require(result.rgb[4 * 9 + 3]!.every((v, c) => v === [.125, .25, .5][c]), `${kind}: rejected boundary leaked positive GI.`);
    }
    const noiseReports: unknown[] = [];
    for (const seed of spatialTruthSeeds) {
      const fixture = makeSpatialTruthFixture(seed), result = await runCase(`linear-truth-retained-seed-${seed}`, fixture.pixels, fixture.width, fixture.height);
      let rawError = 0, filteredError = 0, rawSigned = 0, filteredSigned = 0, measuredSum = 0, truthSum = 0, count = 0;
      for (let y = 2; y < fixture.height - 2; y++) for (let x = 2; x < fixture.width - 2; x++) {
        const i = y * fixture.width + x, p = result.pixels[i]!;
        for (let c = 0; c < 3; c++) {
          const truth = fixture.truth[i]![c]!, measured = result.rgb[i]![c]! - p.direct[c]!;
          rawError += (p.sum[c]! / p.samples - truth) ** 2; filteredError += (measured - truth) ** 2;
          rawSigned += p.sum[c]! / p.samples - truth; filteredSigned += measured - truth;
          truthSum += truth; measuredSum += measured; count++;
        }
      }
      const mseRatio = filteredError / rawError, relativeMeanError = Math.abs(measuredSum - truthSum) / truthSum;
      const rawMeanError = rawSigned / count, filteredMeanError = filteredSigned / count;
      const rawVariance = rawError / count - rawMeanError ** 2, filteredVariance = filteredError / count - filteredMeanError ** 2;
      const varianceRatio = filteredVariance / rawVariance;
      require(mseRatio < spatialTruthGates.maxMseRatio && relativeMeanError < spatialTruthGates.maxRelativeMeanError && varianceRatio < spatialTruthGates.maxVarianceRatio,
        `Seed${seed}: predeclared linear-truth gate failed: MSEratio${mseRatio}, mean${relativeMeanError}.`);
      noiseReports.push({ seed, components: count, rawMse: rawError / count, filteredMse: filteredError / count, mseRatio, relativeMeanError,
        rawMeanError, filteredMeanError, rawVariance, filteredVariance, varianceRatio });
    }

    // Float-storage helper proof supplements actual rgba16f composition: tiny
    // normal values must survive classification/division rather than quantize to0.
    const rawQueries = [
      { name: 'positive-min-normal', sum: bits(2 ** -126), samples: 1, direct: 0, valid: true, mean: 2 ** -126 },
      { name: 'positive-min-normal-after1024', sum: bits(2 ** -116), samples: 1024, direct: 0, valid: true, mean: 2 ** -126 },
      { name: 'positive-subnormal-word', sum: 1, samples: 1, direct: 0, valid: false, mean: 0 },
      { name: 'negative-zero', sum: 0x80000000, samples: 64, direct: 0, valid: true, mean: 0 },
      { name: 'nan-word', sum: 0x7fc00000, samples: 1, direct: 0, valid: false, mean: 0 },
      { name: 'infinity-word', sum: 0x7f800000, samples: 1, direct: 0, valid: false, mean: 0 },
      { name: 'zero-count', sum: 0, samples: 0, direct: 0, valid: false, mean: 0 },
      { name: 'over-count', sum: 0, samples: 1025, direct: 0, valid: false, mean: 0 },
      { name: 'hdr-safe-endpoint', sum: bits(65472), samples: 1, direct: 0, valid: true, mean: 65472 },
      { name: 'hdr-excluded-half-maximum', sum: bits(65504), samples: 1, direct: 0, valid: false, mean: 0 },
      { name: 'direct-addition-outside-domain', sum: bits(1), samples: 1, direct: bits(65472), valid: false, mean: 0 },
    ];
    const identityQueries = [0x00100000, 0x001fffff, 0x003fffff, 0, 0x00400000 | 0x00100000, 0x80100000];
    const pairQueries = [
      { name: 'plane-inside', donor: 1, weight: 24, valid: true }, { name: 'plane-outside', donor: 2, weight: 0, valid: true },
      { name: 'normal-outside', donor: 3, weight: 0, valid: true },
      { name: 'normal-inside', donor: 4, weight: 24 * Math.fround(.9501) ** 32, valid: true },
      { name: 'distance-inside', donor: 5, weight: 24, valid: true }, { name: 'distance-outside', donor: 6, weight: 0, valid: true },
      { name: 'flipped-orientation-restored', donor: 7, weight: 24, valid: true },
      { name: 'opposite-orientation-rejected', donor: 8, weight: 0, valid: true },
      { name: 'reserved-guide-bits', donor: 9, weight: 0, valid: false },
      { name: 'packed-ID-outside-bound-buffer', donor: 10, weight: 0, valid: false },
    ];
    const incidentQueries = [
      { name: 'minimum-rho', rho: 2 ** -16, sum: 64 * 2 ** -16, count: 64, direct: 0, incident: 1, valid: true, omitted: false, remodulated: true, value: 2 ** -16 },
      { name: 'tiny-linear-energy-before-FP16', rho: 2 ** -16, sum: 2 ** -106, count: 1, direct: 0, incident: 2 ** -90, valid: true, omitted: false, remodulated: true, value: 2 ** -106 },
      { name: 'positive-energy-below-bound', rho: 2 ** -16, sum: 2 ** -107, count: 1, direct: 0, incident: 0, valid: false, omitted: false, remodulated: false, value: 0 },
      { name: 'subnormal-rho-not-completed-zero', rho: 2 ** -149, sum: 0, count: 64, direct: 0, incident: 0, valid: false, omitted: false, remodulated: false, value: 0 },
      { name: 'negative-zero-rho-omitted', rho: -0, sum: 0, count: 64, direct: 0, incident: 0, valid: true, omitted: true, remodulated: false, value: 0 },
      { name: 'nonzero-direct-remod-budget', rho: .5, sum: 64, count: 64, direct: 65472, incident: 2, valid: true, omitted: false, remodulated: false, value: 0 },
      { name: 'rho-above-one-exact', rho: 2, sum: 64, count: 64, direct: 0, incident: .5, valid: true, omitted: false, remodulated: true, value: 1 },
    ];
    const pairStart = rawQueries.length + identityQueries.length, incidentStart = pairStart + pairQueries.length, planeIndex = incidentStart + incidentQueries.length;
    const probeBytes = new ArrayBuffer((planeIndex + 1) * 64), pwords = new Uint32Array(probeBytes), pfloats = new Float32Array(probeBytes);
    rawQueries.forEach((q, i) => pwords.set([q.sum, q.samples, q.direct, 0], i * 16));
    identityQueries.forEach((identity, i) => pwords.set([identity, 0, 0, 1], (rawQueries.length + i) * 16));
    pairQueries.forEach((q, i) => { pwords.set([0, q.donor, 0, 2], (pairStart + i) * 16); pfloats.set([1, 0, 0, 0], (pairStart + i) * 16 + 12); });
    incidentQueries.forEach((q, i) => { pwords.set([bits(q.sum), q.count, bits(q.rho), 4], (incidentStart + i) * 16); pfloats[(incidentStart + i) * 16 + 4] = q.direct; });
    pwords[planeIndex * 16 + 3] = 3; pfloats.set([-.5, .5, 0, 0], planeIndex * 16 + 4);
    pfloats.set([0, 0, 1, 0], planeIndex * 16 + 8); pfloats.set([3, 3, 0, 0], planeIndex * 16 + 12);
    const queryBuffer = buffer('Raw integer-word numerical probes', probeBytes), probeOutput = buffer('Float32 helper results', (planeIndex + 1) * 32);
    const probeUniformBytes = new ArrayBuffer(288), probeUniformFloats = new Float32Array(probeUniformBytes);
    probeUniformFloats.set(orthoInverse); new Uint32Array(probeUniformBytes).set([8, 8, 0, 64], 36);
    const probeUniform = buffer('Independent orthographic camera', probeUniformBytes, 0x40 | 0x08);
    const pairPixels = planar(11, 1);
    const pairGuide = (index: number, point: SpatialVector, normal: SpatialVector = [0, 0, 1]) => {
      pairPixels[index] = { ...pairPixels[index]!, guide: { ...pairPixels[index]!.guide, point, normal } };
    };
    pairGuide(1, [1, 0, .049]); pairGuide(2, [1, 0, .051]);
    pairGuide(3, [0, 0, 0], [0, Math.sqrt(1 - .9499 ** 2), .9499]);
    pairGuide(4, [0, 0, 0], [0, Math.sqrt(1 - .9501 ** 2), .9501]);
    pairGuide(5, [2.499, 0, 0]); pairGuide(6, [2.501, 0, 0]);
    pairGuide(7, [1, 0, 0], [0, 0, -1]); pairGuide(8, [1, 0, 0], [0, 0, -1]);
    const pairMetadata = pairPixels.map((_, i) => i | 0x00100000); pairMetadata[7]! |= 0x00200000;
    pairMetadata[9]! |= 0x00400000; pairMetadata[10] = 0x001fffff;
    const packedProbe = pack(pairPixels, pairMetadata), probeTriangles = buffer('Probe triangle identities', packedProbe.triangles), probeGuides = buffer('Probe guides', packedProbe.guides);
    const pg0 = device.createBindGroup({ layout: probePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: probeUniform } }] });
    const pg1 = device.createBindGroup({ layout: probePipeline.getBindGroupLayout(1), entries: [{ binding: 1, resource: { buffer: probeTriangles } }, { binding: 6, resource: { buffer: probeGuides } }] });
    const pg2 = device.createBindGroup({ layout: probePipeline.getBindGroupLayout(2), entries: [] });
    const pg3 = device.createBindGroup({ layout: probePipeline.getBindGroupLayout(3), entries: [{ binding: 0, resource: { buffer: queryBuffer } }, { binding: 1, resource: { buffer: probeOutput } }] });
    async function probeRead() {
      const readback = buffer('Float32 probe readback', (planeIndex + 1) * 32, 0x01 | 0x08);
      try {
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(probePipeline);
        [pg0, pg1, pg2, pg3].forEach((g, i) => pass.setBindGroup(i, g)); pass.dispatchWorkgroups(Math.ceil((planeIndex + 1) / 32)); pass.end();
        encoder.copyBufferToBuffer(probeOutput, 0, readback, 0, (planeIndex + 1) * 32);
        device.queue.submit([encoder.finish()]); await bounded(readback.mapAsync(1), 'Spatial float helpers');
        const data = new Float32Array(readback.getMappedRange().slice(0)); readback.unmap(); return data;
      } finally { removeBuffer(readback); }
    }
    const orthographic = await probeRead();
    rawQueries.forEach((q, i) => {
      require(orthographic[i * 8 + 2] === Number(q.valid), `Integer-domain probe ${q.name} validity differs.`);
      if (q.valid) require(orthographic[i * 8] === q.mean, `Float32 probe ${q.name} changed exact mean.`);
    });
    identityQueries.forEach((identity, i) => {
      const at = (rawQueries.length + i) * 8, expected = i < 3;
      require(orthographic[at] === Number(expected) && orthographic[at + 1] === (identity & 0x000fffff), `Packed identity ${identity} failed.`);
    });
    pairQueries.forEach((q, i) => {
      const at = (pairStart + i) * 8;
      require(orthographic[at + 1] === 1 && orthographic[at + 2] === Number(q.valid), `${q.name}: guide validation mismatch.`);
      require(Math.abs(orthographic[at]! - q.weight) <= 1e-4, `${q.name}: geometric weight${orthographic[at]} vs${q.weight}.`);
      if (q.weight === 0) require(orthographic[at] === 0, `${q.name}: rejected guide acquired nonzero weight.`);
    });
    incidentQueries.forEach((q, i) => {
      const at = (incidentStart + i) * 8;
      require(orthographic[at + 1] === Number(q.valid) && orthographic[at + 2] === Number(q.omitted), `${q.name}: incident eligibility changed.`);
      if (q.valid && !q.omitted) require(Math.abs(orthographic[at]! - q.incident) <= Math.abs(q.incident) * 2e-6, `${q.name}: f32 demodulation changed energy.`);
      require(orthographic[at + 6] === Number(q.remodulated), `${q.name}: remodulation budget classification changed.`);
      if (q.remodulated) require(Math.abs(orthographic[at + 4]! - q.value) <= Math.abs(q.value) * 2e-6, `${q.name}: f32 remodulation changed or lost energy.`);
    });
    const near = (actual: number, expected: number, label: string) => require(Math.abs(actual - expected) <= 2e-6, `${label}: ${actual} vs${expected}.`);
    const pointOffset = planeIndex * 8;
    [-.5, .5, 0, 1, .5, .5, 0, 1].forEach((v, c) => near(orthographic[pointOffset + c]!, v, 'Orthographic tangent intersection'));
    // Perspective eye0, near1, far8, 90-degree FOV: plane z=-4 gives the same
    // one-world-unit pixel step. This oracle is independent of runtime matrices.
    probeUniformFloats.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -.875, 0, 0, -1, 1]);
    device.queue.writeBuffer(probeUniform, 0, probeUniformBytes); pfloats[planeIndex * 16 + 6] = -4;
    device.queue.writeBuffer(queryBuffer, 0, probeBytes); const perspective = await probeRead();
    [-.5, .5, -4, 1, .5, .5, -4, 1].forEach((v, c) => near(perspective[pointOffset + c]!, v, 'Perspective tangent intersection'));
    pfloats.set([1, 0, 0, 0], planeIndex * 16 + 8); // Parallel orthographic ray, then below .1 grazing threshold.
    probeUniformFloats.set(orthoInverse); device.queue.writeBuffer(probeUniform, 0, probeUniformBytes); device.queue.writeBuffer(queryBuffer, 0, probeBytes);
    const grazing = await probeRead(); require(grazing[pointOffset + 3] === 0 && grazing[pointOffset + 7] === 0, 'Parallel tangent footprint must bypass.');
    pfloats.set([Math.sqrt(1 - .05 ** 2), 0, .05, 0], planeIndex * 16 + 8); device.queue.writeBuffer(queryBuffer, 0, probeBytes);
    const nearGrazing = await probeRead(); require(nearGrazing[pointOffset + 3] === 0, 'Near-grazing footprint must bypass.');
    cases.push({ name: 'actual-f32-helper-domain-and-camera-probes', raw: rawQueries.map((q, i) => ({ ...q, actual: [...orthographic.slice(i * 8, i * 8 + 4)] })),
      identityWords: identityQueries, orthographic: [...orthographic.slice(pointOffset)], perspective: [...perspective.slice(pointOffset)],
      pairs: pairQueries.map((q, i) => ({ ...q, actual: [...orthographic.slice((pairStart + i) * 8, (pairStart + i) * 8 + 4)] })),
      incident: incidentQueries.map((q, i) => ({ ...q, actual: [...orthographic.slice((incidentStart + i) * 8, (incidentStart + i + 1) * 8)] })),
      parallelBypasses: true, nearGrazingBypasses: true });

    // Execute both actual trace entry points on identical generated source,
    // uniforms and depth. This establishes unchanged raw words while the optional
    // variant writes exact first-primary guides, including reordered packed IDs.
    const ordinaryModule = device.createShaderModule({ label: 'Unchanged six-binding estimator', code: importedIndirectShader });
    const ordinaryTrace = await bounded(device.createComputePipelineAsync({ layout, compute: { module: ordinaryModule, entryPoint: 'traceImportedIndirect' } }), 'Ordinary trace comparison');
    const positions = [[-8, -8, 0], [8, -8, 0], [8, 8, 0], [-8, 8, 0]], indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const sourceVertices = new Float32Array(4 * 16), sourceTriangles = new ArrayBuffer(128), st = new DataView(sourceTriangles);
    positions.forEach((p, i) => sourceVertices.set([...p, 0, 0, 1, .25, .25, 1, 0, 0, 1, .25, .5, .75, 1], i * 16));
    for (let packed = 0; packed < 2; packed++) {
      const source = 1 - packed;
      for (let corner = 0; corner < 3; corner++) positions[indices[source * 3 + corner]!]!.forEach((v, a) => st.setFloat32(packed * 64 + corner * 16 + a * 4, v, true));
      st.setUint32(packed * 64 + 28, indices[source * 3]!, true); st.setUint32(packed * 64 + 44, source, true); st.setFloat32(packed * 64 + 56, 1, true);
    }
    const nodeBytes = new ArrayBuffer(32), node = new DataView(nodeBytes);
    [-8, -8, 0].forEach((v, a) => node.setFloat32(a * 4, v, true)); [8, 8, 0].forEach((v, a) => node.setFloat32(16 + a * 4, v, true)); node.setUint32(28, 2, true);
    const nb = buffer('Trace comparison root node', nodeBytes), tb = buffer('Trace comparison reversed triangles', sourceTriangles);
    const vb = buffer('Trace comparison exact source colors', sourceVertices.buffer), ib = buffer('Trace comparison source indices', indices.buffer);
    const frameBytes = new ArrayBuffer(288), ff = new Float32Array(frameBytes), fw = new Uint32Array(frameBytes);
    ff.set(orthoInverse); ff.set(orthoProjection, 16); fw.set([8, 8, 0, 64], 36); fw.set([2, 4096, 1337, 1], 40);
    ff.set([3, 1, 1, 0], 52); ff.set([.5, 1, 2], 56); ff.set([1, 1, 1, 1], 60);
    const traceFrame = buffer('Trace comparison constant environment', frameBytes, 0x40 | 0x08);
    const traceDepth = texture('Exact orthographic plane depth', 8, 8, 'depth32float', 0x04 | 0x10);
    const traceDirect = texture('Trace unused direct input', 8, 8, 'rgba16float', 0x04 | 0x02), traceOutput = texture('Trace unused composition target', 8, 8, 'rgba16float', 0x08);
    const tg0 = device.createBindGroup({ layout: group0Layout, entries: [{ binding: 0, resource: { buffer: traceFrame } },
      { binding: 1, resource: traceDepth.createView() }, { binding: 2, resource: traceDirect.createView() }, { binding: 3, resource: traceOutput.createView() }] });
    const variants = [ordinaryTrace, trace].map((pipeline, i) => {
      const states = buffer(`Trace variant${i} raw state`, 64 * 32), counters = buffer(`Trace variant${i} raw counters`, 16), guides = buffer(`Trace variant${i} guide cache`, 16 + 64 * 32);
      const group = device.createBindGroup({ layout: group1Layout, entries: [nb, tb, vb, ib, states, counters, guides].map((b, binding) => ({ binding, resource: { buffer: b } })) });
      return { pipeline, states, counters, guides, group };
    });
    let traceSweepNumber = 0;
    async function traceSweep(clearDepth: boolean) {
      const each = 64 * 32 + 16 + 16 + 64 * 32, readback = buffer('Trace comparison exact word readback', each * 2, 0x01 | 0x08);
      try {
        const encoder = device.createCommandEncoder();
        if (clearDepth) {
          const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: traceDepth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: .5 } }); pass.end();
        }
        variants.forEach((variant, i) => {
          const pass = encoder.beginComputePass(); pass.setPipeline(variant.pipeline); pass.setBindGroup(0, tg0); pass.setBindGroup(1, variant.group); pass.setBindGroup(2, group2); pass.dispatchWorkgroups(1); pass.end();
          encoder.copyBufferToBuffer(variant.states, 0, readback, i * each, 64 * 32);
          encoder.copyBufferToBuffer(variant.counters, 0, readback, i * each + 64 * 32, 16);
          encoder.copyBufferToBuffer(variant.guides, 0, readback, i * each + 64 * 32 + 16, 16 + 64 * 32);
        });
        device.queue.submit([encoder.finish()]); await bounded(readback.mapAsync(1), 'Actual ordinary/optional trace comparison');
        const data = readback.getMappedRange().slice(0); readback.unmap();
        const ordinary = new Uint32Array(data, 0, (64 * 32 + 16) / 4), optional = new Uint32Array(data, each, (64 * 32 + 16) / 4);
        const guideBytes = data.slice(each + 64 * 32 + 16), guideView = new DataView(guideBytes);
        // Retain the actual words before parity or radiometric assertions. An
        // immutable failed report must contain the evidence needed to distinguish
        // material/fixture defects from harmless interpolation rounding.
        cases.push({ name: 'actual-trace-sweep-readback', sweep: ++traceSweepNumber,
          ordinaryStateAndCounterWords: [...ordinary], optionalStateAndCounterWords: [...optional],
          optionalGuideWords: [...new Uint32Array(guideBytes)],
          decoded: Array.from({ length: 64 }, (_, i) => ({ pixel: [i % 8, Math.floor(i / 8)],
            sum: [0, 1, 2].map(c => float(optional[i * 8 + c]!)), samples: optional[i * 8 + 3],
            attempts: optional[i * 8 + 4], status: optional[i * 8 + 5],
            rho: [0, 1, 2].map(c => guideView.getFloat32(16 + i * 32 + c * 4, true)),
            identity: guideView.getUint32(16 + i * 32 + 12, true),
            point: [0, 1, 2].map(c => guideView.getFloat32(16 + i * 32 + 16 + c * 4, true)),
            footprint: guideView.getFloat32(16 + i * 32 + 28, true) })),
          expectedAnalyticRho: [.25, .5, .75], expectedAnalyticFirstSum: [.125, .5, 1.5],
          sourceSha256: await sha(sourceTriangles), frameWords: [...fw] });
        require(ordinary.every((word, i) => word === optional[i]), 'Optional guide/integer storage changed raw estimator words/counters.');
        return { words: [...optional], guideBytes, sourceHash: await sha(sourceTriangles) };
      } finally { removeBuffer(readback); }
    }
    const firstTrace = await traceSweep(true), firstGuide = new DataView(firstTrace.guideBytes);
    // The rescaled triangle intersection need not produce exact dyadic weights.
    // Even constant source color is reconstructed through w0=(1-b1)-b2 and
    // three weighted additions. Allow gamma(8) for these at-most eight rounded
    // subtract/multiply/add operations (FMA contraction does not increase this
    // budget), with positive fixture weights and IEEE-f32 unit roundoff2^-24.
    // This bounds interpolation of the ideal constant; it does NOT relax actual
    // cached-rho transport or ordinary/optional raw-word parity below.
    const interpolationUnitRoundoff = 2 ** -24, interpolationRoundings = 8;
    const analyticRhoRelativeBound = interpolationRoundings * interpolationUnitRoundoff / (1 - interpolationRoundings * interpolationUnitRoundoff);
    let maxAnalyticRhoRelativeError = 0, nonDiagonalPackedIdentityChecks = 0;
    for (let i = 0; i < 64; i++) {
      require(firstTrace.words[i * 8 + 3] === 1 && firstTrace.words[i * 8 + 4] === 1 && firstTrace.words[i * 8 + 5] === 0, 'Trace comparison did not complete exactly one sample.');
      [.25, .5, .75].forEach((idealRho, c) => {
        const actualRho = firstGuide.getFloat32(16 + i * 32 + c * 4, true), radiance = [.5, 1, 2][c]!;
        const expectedSampleWord = bits(actualRho * radiance);
        require(firstTrace.words[i * 8 + c] === expectedSampleWord,
          `Cached-rho transport changed at pixel${i}, channel${c}: sampleWord=${firstTrace.words[i * 8 + c]}, cachedRho=${actualRho}, expectedWord=${expectedSampleWord}.`);
        const relativeError = Math.abs(actualRho - idealRho) / idealRho;
        require(Number.isFinite(actualRho) && relativeError <= analyticRhoRelativeBound,
          `Constant-color interpolation at pixel${i}, channel${c}: actual=${actualRho}, ideal=${idealRho}, relativeError=${relativeError}, gamma8=${analyticRhoRelativeBound}.`);
        maxAnalyticRhoRelativeError = Math.max(maxAnalyticRhoRelativeError, relativeError);
      });
      const identity = firstGuide.getUint32(16 + i * 32 + 12, true);
      require((identity & 0xfff00000) === 0x00100000 && (identity & 0xfffff) < 2, 'Guide did not store valid packed identity/original orientation.');
      const x = i % 8 - 3.5, y = 3.5 - Math.floor(i / 8);
      if (x !== y) {
        const expectedPacked = y < x ? 1 : 0;
        require((identity & 0xfffff) === expectedPacked, `Pixel${i}: source-order ID used instead of independently expected packed${expectedPacked}.`);
        nonDiagonalPackedIdentityChecks++;
      }
      [x, y, 0].forEach((v, c) => near(firstGuide.getFloat32(16 + i * 32 + 16 + c * 4, true), v, 'Traced guide world point'));
      near(firstGuide.getFloat32(16 + i * 32 + 28, true), 1, 'Actual first-primary tangent footprint');
    }
    require(nonDiagonalPackedIdentityChecks === 56, 'Independent packed-ID witness did not cover every off-diagonal pixel.');
    // A cache sentinel proves later attempts do not silently recompute the guide.
    device.queue.writeBuffer(variants[1]!.guides, 44, new Float32Array([2]));
    const secondTrace = await traceSweep(false), cappedTrace = await traceSweep(false);
    require(new DataView(secondTrace.guideBytes).getFloat32(44, true) === 2, 'Later trace attempt overwrote the first-primary guide.');
    require(secondTrace.words.every((word, i) => word === cappedTrace.words[i]), 'Capped trace changed raw estimator state/counters.');
    cases.push({ name: 'actual-trace-guide-and-legacy-word-identity', pixels: 64, sweeps: 3, cap: 2, sourceSha256: firstTrace.sourceHash,
      firstCounters: firstTrace.words.slice(64 * 8), cappedCounters: cappedTrace.words.slice(64 * 8),
      cachedRhoTransportBitsExact: true, idealColorInterpolation: { unitRoundoff: interpolationUnitRoundoff,
        roundingOperations: interpolationRoundings, relativeBound: analyticRhoRelativeBound, maxRelativeError: maxAnalyticRhoRelativeError },
      nonDiagonalPackedIdentityChecks, firstGuideOnly: true, rawStateAndCountersIdentical: true, tangentFootprint: 1 });
    await bounded(device.queue.onSubmittedWorkDone(), 'Spatial final fence');
    while (scopes > 0) { const error = await bounded(device.popErrorScope(), 'Spatial error scope'); scopes--; if (error) errors.push(error.message); }
    require(errors.length === 0, errors.join('; '));
    return { status: 'passed', performanceEvidence: false, adapter: { vendor: adapter!.info.vendor, architecture: adapter!.info.architecture,
      device: adapter!.info.device, description: adapter!.info.description, isFallbackAdapter: adapter!.info.isFallbackAdapter },
      shaderSha256: await sha(importedIndirectSpatialShader), legacyShaderSha256: await sha(importedIndirectShader),
      guideBytes: '16+32*N', rawBytesPerPixel: 32, header: ['filteredPixels', 'fallbackChannels', 'hdrFaultChannels', 'guideBypassPixels'],
      gates: spatialTruthGates, seeds: spatialTruthSeeds, noiseReports, cases, errors,
      limitations: ['Spatially biased; same-plane illumination discontinuities can blur.', 'No actual-house visual acceptance or performance evidence.',
        'Generated numerical fixtures do not replace public scene lifecycle validation.'] };
  } catch (error) {
    return { status: 'failed', performanceEvidence: false, failure: error instanceof Error ? error.stack : String(error), cases, errors,
      adapter: { vendor: adapter!.info.vendor, description: adapter!.info.description, isFallbackAdapter: adapter!.info.isFallbackAdapter } };
  } finally {
    while (scopes > 0) { await bounded(device.popErrorScope(), 'Spatial failed-scope cleanup').catch(() => undefined); scopes--; }
    for (const b of liveBuffers) { if (b.mapState === 'mapped') b.unmap(); b.destroy(); }
    for (const t of liveTextures) t.destroy(); device.removeEventListener('uncapturederror', onError); device.destroy();
  }
}
