import { createGiScene, triangulateGiScene } from '../../packages/core/src/gi/scene-data.js';
import { buildGiTraceData, refitGiTraceData } from '../../packages/core/src/gi/trace-data.js';
import { giTraceShader } from '../../packages/core/src/gi/trace-shaders.js';
import { ProbeCache, probeCacheLayout, probeSamplingShader } from '../../packages/core/src/gi/probe-cache.js';
import { GiRenderer } from '../../packages/core/src/gi/gi-renderer.js';

type Vec3 = readonly [number, number, number];
interface Ray { origin: Vec3; direction: Vec3; tMin: number; tMax: number }
interface TraceHit {
  distance: number; triangleId: number; materialId: number; boxId: number; normal: Vec3;
  status: number; nodeVisits: number; primitiveTests: number; steps: number;
}
type Triangle = ReturnType<typeof triangulateGiScene>[number];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a));
const f32 = (a: Vec3): Vec3 => [Math.fround(a[0]), Math.fround(a[1]), Math.fround(a[2])];

function require(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

/** Independent double-precision triangle oracle: no production BVH or SDF code. */
function bruteForce(triangles: readonly Triangle[], ray: Ray, edgeTolerance = 0) {
  let distance = ray.tMax; let nearest: Triangle | undefined; let ambiguous = false;
  for (const triangle of triangles) {
    const edge1 = sub(triangle.p1, triangle.p0); const edge2 = sub(triangle.p2, triangle.p0);
    const p = cross(ray.direction, edge2); const determinant = dot(edge1, p);
    if (Math.abs(determinant) < 1e-12) continue;
    const t = sub(ray.origin, triangle.p0); const u = dot(t, p) / determinant;
    if (u < -edgeTolerance || u > 1 + edgeTolerance) continue;
    const q = cross(t, edge1); const v = dot(ray.direction, q) / determinant;
    if (v < -edgeTolerance || u + v > 1 + edgeTolerance) continue;
    const candidate = dot(edge2, q) / determinant;
    if (candidate < ray.tMin || candidate > ray.tMax) continue;
    if (nearest && Math.abs(candidate - distance) < 1e-5) ambiguous = true;
    if (!nearest || candidate < distance) {
      if (distance - candidate > 1e-5) ambiguous = false;
      distance = candidate; nearest = triangle;
    }
  }
  return { distance, triangle: nearest, ambiguous };
}

function validateOracle() {
  const triangle: Triangle = { id: 0, boxId: 0, materialId: 0, p0: [0, 0, 0], p1: [1, 0, 0], p2: [0, 1, 0], normal: [0, 0, 1] };
  const ray: Ray = { origin: [0.2, 0.2, 1], direction: [0, 0, -1], tMin: 0, tMax: 1 };
  require(bruteForce([triangle], ray).triangle?.id === 0, 'CPU reference lost an inclusive maximum-distance hit.');
  require(bruteForce([triangle], { ...ray, tMax: 0.9 }).triangle === undefined, 'CPU reference ignored ray clipping.');
  require(bruteForce([triangle], { ...ray, origin: [0.2, 0.2, -1], direction: [0, 0, 1] }).triangle?.id === 0, 'CPU reference incorrectly culled backfaces.');
  require(bruteForce([triangle], { ...ray, direction: [1, 0, 0] }).triangle === undefined, 'CPU reference accepted a parallel ray.');
}

function rayDistributions(triangles: readonly Triangle[], count: number, seed: number): Record<string, Ray[]> {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
  const ray = (origin: Vec3, direction: Vec3, tMin = 0.001, tMax = 40): Ray => ({
    origin: f32(origin), direction: f32(normalize(direction)), tMin: Math.fround(tMin), tMax: Math.fround(tMax),
  });
  const directions: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const result: Record<string, Ray[]> = { coherent: [], incoherent: [], grazing: [], axesAndClips: [] };
  for (let index = 0; index < count; index++) {
    const side = Math.ceil(Math.sqrt(count)); const x = (index % side + 0.5) / side; const y = (Math.floor(index / side) + 0.5) / side;
    result.coherent!.push(ray([-4.5, 1.65, 2.5], [1, (y - 0.5) * 0.8, (x - 0.5) * 1.4 - 0.45]));
    const origin: Vec3 = [(random() - 0.5) * 15, -0.5 + random() * 6, (random() - 0.5) * 11];
    const z = random() * 2 - 1; const angle = random() * Math.PI * 2; const radius = Math.sqrt(1 - z * z);
    result.incoherent!.push(ray(origin, [radius * Math.cos(angle), z, radius * Math.sin(angle)]));
    const triangle = triangles[index % triangles.length]!;
    const centroid = scale(add(add(triangle.p0, triangle.p1), triangle.p2), 1 / 3);
    const tangent = normalize(sub(triangle.p1, triangle.p0));
    result.grazing!.push(ray(add(centroid, scale(triangle.normal, index % 2 ? 0.002 : 0.02)),
      sub(tangent, scale(triangle.normal, index % 3 ? 0.0001 : 0.01)), 0.0001));
    result.axesAndClips!.push(ray(origin, directions[index % directions.length]!, index % 3 ? 0.001 : 0,
      index % 4 === 0 ? 0.03 : index % 4 === 1 ? 0.5 : 40));
  }
  return result;
}

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { samples: sorted.length, min: sorted[0] ?? 0, mean: sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length),
    p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1) ?? 0 };
}

function unpackHits(buffer: ArrayBuffer, count: number): TraceHit[] {
  const floats = new Float32Array(buffer); const words = new Uint32Array(buffer);
  return Array.from({ length: count }, (_, index) => {
    const offset = index * 12;
    return { distance: floats[offset]!, triangleId: words[offset + 1]!, materialId: words[offset + 2]!, boxId: words[offset + 3]!,
      normal: [floats[offset + 4]!, floats[offset + 5]!, floats[offset + 6]!] as Vec3, status: words[offset + 7]!,
      nodeVisits: words[offset + 8]!, primitiveTests: words[offset + 9]!, steps: words[offset + 10]! };
  });
}

function clipPoint(matrix: ArrayLike<number>, point: Vec3): readonly [number, number, number, number] {
  return [0, 1, 2, 3].map(row => matrix[row]! * point[0] + matrix[row + 4]! * point[1]
    + matrix[row + 8]! * point[2] + matrix[row + 12]!) as unknown as readonly [number, number, number, number];
}

/** A common separating clip plane proves the entire colored box is offscreen. */
export function isColoredWallOffscreen(scene: ReturnType<typeof createGiScene>, viewProjection: ArrayLike<number>): boolean {
  const box = scene.boxes[scene.coloredWallBoxId]!; const c = Math.cos(box.yaw); const s = Math.sin(box.yaw);
  const corners = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => {
    const local: Vec3 = [x * box.halfSize[0], y * box.halfSize[1], z * box.halfSize[2]];
    return clipPoint(viewProjection, [c * local[0] + s * local[2] + box.center[0], local[1] + box.center[1], -s * local[0] + c * local[2] + box.center[2]]);
  })));
  const planes = [(p: readonly number[]) => p[0]! + p[3]!, (p: readonly number[]) => p[3]! - p[0]!,
    (p: readonly number[]) => p[1]! + p[3]!, (p: readonly number[]) => p[3]! - p[1]!,
    (p: readonly number[]) => p[2]!, (p: readonly number[]) => p[3]! - p[2]!];
  return planes.some(plane => corners.every(point => plane(point) < 0));
}

export function projectGiValidationPoint(viewProjection: ArrayLike<number>, point: Vec3, width: number, height: number): readonly [number, number] {
  const clip = clipPoint(viewProjection, point);
  require(clip[3] > 0 && clip[2] >= 0 && clip[2] <= clip[3], 'GI validation receiver is outside the camera depth interval.');
  const x = (clip[0] / clip[3] * 0.5 + 0.5) * width; const y = (0.5 - clip[1] / clip[3] * 0.5) * height;
  require(x >= 0 && x < width && y >= 0 && y < height, 'GI validation receiver is outside the image.');
  return [Math.floor(x), Math.floor(y)];
}

/** Linear HDR readback avoids tone mapping/screenshot thresholds in energy tests. */
export async function readGiLinearRoi(device: GPUDevice, texture: GPUTexture, center: readonly [number, number], radius = 2) {
  require(texture.format === 'rgba16float', 'GI validation requires the linear rgba16float output.');
  const x = Math.max(0, center[0] - radius); const y = Math.max(0, center[1] - radius);
  const width = Math.min(texture.width - x, radius * 2 + 1); const height = Math.min(texture.height - y, radius * 2 + 1);
  const bytesPerRow = Math.ceil(width * 8 / 256) * 256;
  const readback = device.createBuffer({ label: 'GI linear receiver readback', size: bytesPerRow * height, usage: 0x01 | 0x08 });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture, origin: [x, y] }, { buffer: readback, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]); await readback.mapAsync(0x01);
    const halves = new Uint16Array(readback.getMappedRange()); const sum = [0, 0, 0]; let maximum = 0; let minimum = Infinity;
    for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
      for (let channel = 0; channel < 3; channel++) {
        const bits = halves[row * bytesPerRow / 2 + column * 4 + channel]!;
        const sign = bits & 0x8000 ? -1 : 1; const exponent = (bits >>> 10) & 31; const mantissa = bits & 1023;
        const value = sign * (exponent === 0 ? mantissa * 2 ** -24 : exponent === 31 ? Infinity : (1 + mantissa / 1024) * 2 ** (exponent - 15));
        require(Number.isFinite(value) && value >= -0.00001, 'GI output contains nonfinite or negative radiance.');
        sum[channel]! += value; minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
      }
    }
    readback.unmap();
    return { center, radius, pixels: width * height, mean: sum.map(value => value / (width * height)), minimum, maximum };
  } finally { readback.destroy(); }
}

/** Same production WGSL and rays, with honest SDF disagreements and bounded-work counters. */
export async function validateGiTracing({ measure = false, doorOpen = true, raysPerDistribution = 1024, iterations = 31 } = {}) {
  validateOracle();
  require(Number.isInteger(raysPerDistribution) && raysPerDistribution >= 16 && raysPerDistribution <= 16384, 'Invalid ray corpus size.');
  require(Number.isInteger(iterations) && iterations >= 3 && iterations <= 101, 'Invalid measurement repeat count.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  require(adapter, 'No WebGPU adapter for GI trace validation.');
  if (measure) require(adapter.info.isFallbackAdapter !== true, 'Representation measurements require a hardware adapter.');
  const timestamps = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: timestamps ? ['timestamp-query'] : [] });
  const errors: string[] = []; const buffers: GPUBuffer[] = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  let query: GPUQuerySet | undefined;
  try {
    const scene = createGiScene({ doorOpen }); const triangles = triangulateGiScene(scene); const data = buildGiTraceData(scene);
    const corpus = rayDistributions(triangles, raysPerDistribution, 1337); const rays = Object.values(corpus).flat();
    const reference = rays.map(ray => bruteForce(triangles, ray));
    const makeBuffer = (label: string, size: number, usage: number, bytes?: ArrayBuffer) => {
      const buffer = device.createBuffer({ label, size, usage }); buffers.push(buffer);
      if (bytes) device.queue.writeBuffer(buffer, 0, bytes);
      return buffer;
    };
    const input = new Float32Array(rays.length * 8);
    rays.forEach((ray, index) => input.set([...ray.origin, ray.tMin, ...ray.direction, ray.tMax], index * 8));
    const resources = [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData]
      .map((bytes, index) => makeBuffer(`GI trace source ${index}`, bytes.byteLength, (index === 4 ? 0x40 : 0x80) | 0x08, bytes));
    resources.push(makeBuffer('GI validation identical rays', input.byteLength, 0x80 | 0x08, input.buffer));
    resources.push(makeBuffer('GI validation hit output', rays.length * 48, 0x80 | 0x04));
    const readback = makeBuffer('GI hit readback', rays.length * 48, 0x01 | 0x08);
    const layout = device.createBindGroupLayout({ entries: resources.map((_, binding) => ({ binding, visibility: 0x04,
      buffer: { type: binding === 4 ? 'uniform' : binding === 6 ? 'storage' : 'read-only-storage' } })) });
    const group = device.createBindGroup({ layout, entries: resources.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const shader = device.createShaderModule({ code: `${giTraceShader({ group: 0, firstBinding: 0 })}
      @group(0) @binding(5) var<storage, read> validationRays: array<GiRay>;
      @group(0) @binding(6) var<storage, read_write> validationHits: array<GiTraceHit>;
      @compute @workgroup_size(64) fn bvh(@builtin(global_invocation_id) id: vec3u) {
        if (id.x < arrayLength(&validationRays)) { validationHits[id.x] = giTraceBvh(validationRays[id.x]); }
      }
      @compute @workgroup_size(64) fn anyHit(@builtin(global_invocation_id) id: vec3u) {
        if (id.x < arrayLength(&validationRays)) { validationHits[id.x] = giTraceAnyBvh(validationRays[id.x]); }
      }
      @compute @workgroup_size(64) fn sdf(@builtin(global_invocation_id) id: vec3u) {
        if (id.x < arrayLength(&validationRays)) { validationHits[id.x] = giTraceSdf(validationRays[id.x]); }
      }` });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipelines = await Promise.all(['bvh', 'anyHit', 'sdf'].map(entryPoint => device.createComputePipelineAsync({
      layout: pipelineLayout, compute: { module: shader, entryPoint },
    })));
    if (timestamps) query = device.createQuerySet({ type: 'timestamp', count: 2 });
    const queryResolve = query ? makeBuffer('GI timestamp resolve', 16, 0x200 | 0x04) : undefined;
    const queryReadback = query ? makeBuffer('GI timestamp readback', 16, 0x01 | 0x08) : undefined;
    async function dispatch(pipeline: GPUComputePipeline, hits: boolean, timed: boolean) {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass({ ...(timed && query ? { timestampWrites: { querySet: query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}) });
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(rays.length / 64)); pass.end();
      if (hits) encoder.copyBufferToBuffer(resources[6]!, 0, readback, 0, rays.length * 48);
      if (timed && query) { encoder.resolveQuerySet(query, 0, 2, queryResolve!, 0); encoder.copyBufferToBuffer(queryResolve!, 0, queryReadback!, 0, 16); }
      device.queue.submit([encoder.finish()]);
      let result: TraceHit[] = []; let gpuMs: number | null = null;
      if (hits) { await readback.mapAsync(0x01); result = unpackHits(readback.getMappedRange().slice(0), rays.length); readback.unmap(); }
      if (timed && query) {
        await queryReadback!.mapAsync(0x01); const values = new BigUint64Array(queryReadback!.getMappedRange());
        gpuMs = Number(values[1]! - values[0]!) / 1e6; queryReadback!.unmap();
      } else if (!hits) await device.queue.onSubmittedWorkDone();
      return { result, gpuMs };
    }
    const resultByRepresentation: Record<string, TraceHit[]> = {};
    for (const [index, name] of ['bvh', 'anyHit', 'sdf'].entries()) resultByRepresentation[name] = (await dispatch(pipelines[index]!, true, false)).result;
    const reports: Record<string, unknown> = {};
    for (const [name, hits] of Object.entries(resultByRepresentation)) {
      const groups: Record<string, unknown> = {};
      let offset = 0;
      for (const [distributionName, distributionRays] of Object.entries(corpus)) {
        let falseHits = 0; let falseMisses = 0; let exhausted = 0; let distanceDisagreements = 0; let normalDisagreements = 0;
        const distanceErrors: number[] = []; const subset = hits.slice(offset, offset + distributionRays.length);
        for (const [index, hit] of subset.entries()) {
          const expected = reference[offset + index]!; const ray = distributionRays[index]!;
          require(hit.status >= 0 && hit.status <= 2, `${name} returned invalid hit status ${hit.status}.`);
          require(Number.isFinite(hit.distance), `${name} returned nonfinite distance.`);
          require(hit.nodeVisits <= 8191, `${name} exceeded the declared node-visit ceiling.`);
          require(hit.steps <= 128, `${name} exceeded the declared sphere-tracing step ceiling.`);
          if (hit.status === 2) { exhausted++; continue; }
          if (hit.status === 0) require(hit.distance === ray.tMax && hit.triangleId === 0xffffffff
            && hit.materialId === 0xffffffff && hit.boxId === 0xffffffff, `${name} returned an invalid miss ABI.`);
          if (hit.status === 1 && name !== 'sdf') {
            const actual = triangles[hit.triangleId];
            require(actual && hit.materialId === actual.materialId && hit.boxId === actual.boxId,
              `${name} returned a triangle/material/box identity mismatch.`);
            const primitiveHit = bruteForce([actual], ray, 1e-5);
            require(primitiveHit.triangle && Math.abs(primitiveHit.distance - hit.distance) < 0.002,
              `${name} reported a hit outside its named source triangle.`);
          }
          if (hit.status === 1 && !expected.triangle) falseHits++;
          if (hit.status === 0 && expected.triangle) falseMisses++;
          if (hit.status === 1 && expected.triangle && name !== 'anyHit') {
            const error = Math.abs(hit.distance - expected.distance); distanceErrors.push(error);
            if (error > Math.max(0.002, expected.distance * 0.0002)) distanceDisagreements++;
            if (!expected.ambiguous && error < 0.002 && dot(hit.normal, expected.triangle.normal) < 0.98) normalDisagreements++;
          }
          if (name !== 'sdf') require(hit.distance >= ray.tMin - 0.002 && hit.distance <= ray.tMax + 0.002, `${name} violated the finite ray interval.`);
        }
        if (name !== 'sdf') require(falseHits + falseMisses + exhausted + distanceDisagreements + normalDisagreements === 0,
          `${name}/${distributionName} disagrees with independent triangles: ${JSON.stringify({ falseHits, falseMisses, exhausted, distanceDisagreements, normalDisagreements })}`);
        groups[distributionName] = { rays: subset.length, hits: subset.filter(hit => hit.status === 1).length,
          falseHits, falseMisses, exhausted, distanceDisagreements, normalDisagreements, distanceErrorMetres: distribution(distanceErrors),
          nodeVisits: distribution(subset.map(hit => hit.nodeVisits)), primitiveTests: distribution(subset.map(hit => hit.primitiveTests)), steps: distribution(subset.map(hit => hit.steps)) };
        offset += distributionRays.length;
      }
      reports[name] = groups;
    }
    const measurements: Record<string, unknown> = {};
    if (measure) {
      for (const [index, name] of ['bvh', 'anyHit', 'sdf'].entries()) {
        for (let warmup = 0; warmup < 3; warmup++) await dispatch(pipelines[index]!, false, false);
        const samples: number[] = [];
        for (let iteration = 0; iteration < iterations; iteration++) {
          require(document.visibilityState === 'visible', 'Representation measurement lost browser visibility.');
          const { gpuMs } = await dispatch(pipelines[index]!, false, true); if (gpuMs !== null) samples.push(gpuMs);
        }
        measurements[name] = { scope: 'one compute dispatch over the identical mixed ray corpus', gpuMs: samples.length ? distribution(samples) : null };
      }
    }
    require(errors.length === 0, errors.join('; '));
    return { kind: 'same-ray-software-tracing', seed: 1337, rayCount: rays.length, sceneState: scene.state,
      triangleCount: triangles.length, representationBytes: {
        combinedValidationAllocation: data.gpuBufferBytes,
        sharedMaterialsAndLight: data.materialData.byteLength + data.uniformData.byteLength,
        bvh: data.nodeData.byteLength + data.triangleData.byteLength + data.materialData.byteLength + data.uniformData.byteLength,
        sdf: data.boxData.byteLength + data.materialData.byteLength + data.uniformData.byteLength,
      },
      adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description,
        isFallbackAdapter: adapter.info.isFallbackAdapter }, timestampAvailable: timestamps,
      timestampPrecision: 'browser-dependent', representations: reports, measurements, gpuErrors: errors };
  } finally { query?.destroy(); for (const buffer of buffers) buffer.destroy(); device.destroy(); }
}

/** Actual cache compute, submission semantics, budget counters and zero-light epoch rejection. */
export async function validateGiProbeCache() {
  const adapter = await navigator.gpu.requestAdapter(); require(adapter, 'No WebGPU adapter for probe validation.');
  const device = await adapter.requestDevice(); const errors: string[] = []; const buffers: GPUBuffer[] = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  let cache: ProbeCache | undefined;
  try {
    const scene = createGiScene(); const data = buildGiTraceData(scene);
    const packed = [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData];
    const source = packed.map((bytes, binding) => {
      const buffer = device.createBuffer({ size: bytes.byteLength, usage: (binding === 4 ? 0x40 : 0x80) | 0x08 });
      buffers.push(buffer); device.queue.writeBuffer(buffer, 0, bytes); return buffer;
    });
    cache = await ProbeCache.create(device, source.map((buffer, binding) => ({ binding, resource: { buffer } })),
      { probesPerUpdate: 32, raysPerProbe: 64, seed: 1337 });
    const output = device.createBuffer({ label: 'GI sampled validation receivers', size: 48, usage: 0x80 | 0x04 }); buffers.push(output);
    const stateBytes = probeCacheLayout.probeCount * probeCacheLayout.stateStride;
    const readback = device.createBuffer({ label: 'GI probe diagnostics readback', size: stateBytes + 32 + 48, usage: 0x01 | 0x08 }); buffers.push(readback);
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: 4, texture: { sampleType: 'float' } },
      { binding: 1, visibility: 4, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 4, visibility: 4, buffer: { type: 'storage' } },
    ] });
    const module = device.createShaderModule({ code: `${probeSamplingShader({ group: 0 })}
      @group(0) @binding(4) var<storage, read_write> receivers: array<vec4f>;
      @compute @workgroup_size(1) fn sampleReceivers() {
        receivers[0] = vec4f(sampleProbeIrradiance(vec3f(-1.5,0.01,0.2),vec3f(0.0,1.0,0.0),vec3f(0.0,1.0,0.0)),1.0);
        receivers[1] = vec4f(sampleProbeIrradiance(vec3f(3.0,0.01,-1.0),vec3f(0.0,1.0,0.0),vec3f(0.0,1.0,0.0)),1.0);
        receivers[2] = vec4f(sampleProbeIrradiance(vec3f(-4.0,0.01,0.0),vec3f(0.0,1.0,0.0),vec3f(0.0,1.0,0.0)),1.0);
      }` });
    const pipeline = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: 'sampleReceivers' } });
    let frameId = 0;
    const step = async (revision: number) => {
      const encoder = device.createCommandEncoder();
      const encoded = cache!.encode(encoder, { revision, frameIndex: frameId });
      require(encoded.primaryRays === 2048 && encoded.probeUpdates === 32 && encoded.dispatchCalls === 2, 'Probe update exceeded its declared finite budget.');
      const bindings = encoded.bindings;
      const group = device.createBindGroup({ layout, entries: [
        { binding: 0, resource: bindings.irradiance }, { binding: 1, resource: bindings.visibility },
        { binding: 2, resource: { buffer: bindings.state } }, { binding: 3, resource: { buffer: bindings.uniform } },
        { binding: 4, resource: { buffer: output } },
      ] });
      const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
      const diagnostics = cache!.diagnostics;
      encoder.copyBufferToBuffer(diagnostics.stateBuffer, 0, readback, 0, stateBytes);
      encoder.copyBufferToBuffer(diagnostics.statisticsBuffer, 0, readback, stateBytes, 32);
      encoder.copyBufferToBuffer(output, 0, readback, stateBytes + 32, 48);
      device.queue.submit([encoder.finish()]); cache!.submitted(++frameId);
      await readback.mapAsync(0x01);
      const memory = readback.getMappedRange(); const words = new Uint32Array(memory);
      const states = Array.from({ length: 384 }, (_, index) => [...words.slice(index * 4, index * 4 + 4)]);
      const statistics = [...words.slice(stateBytes / 4, stateBytes / 4 + 8)];
      const irradiance = Array.from({ length: 3 }, (_, index) => [...new Float32Array(memory, stateBytes + 32 + index * 16, 3)]);
      readback.unmap();
      require(statistics[0] === 2048 && statistics[7] === 32 && statistics[3] === 0, `Invalid trace/update counters: ${statistics}`);
      require(statistics[4]! <= 2048 && statistics[5]! <= statistics[4]!, 'Secondary visibility rays exceeded the primary-ray bound.');
      require(statistics[1]! + statistics[2]! === statistics[0], 'Successful primary hits and misses must account for every traced ray.');
      require(irradiance.flat().every(value => Number.isFinite(value) && value >= 0), 'Probe sampling returned invalid irradiance.');
      return { frameId, states, statistics, irradiance, telemetry: cache!.telemetry };
    };
    const first = await step(0); const epoch = Number(first.telemetry.cacheEpoch);
    require(first.states.filter(state => state[0] === epoch).length === 32, 'Initial frame updated more than its 32-probe window.');
    const beforeCancel = cache.telemetry;
    cache.encode(device.createCommandEncoder(), { revision: 99, frameIndex: 999 }); cache.cancelFrame();
    require(JSON.stringify(cache.telemetry) === JSON.stringify(beforeCancel), 'An unsubmitted command buffer advanced probe cache state.');
    const series = [{ frameId: first.frameId, irradiance: first.irradiance }];
    let warm = first;
    for (let index = 1; index < 36; index++) {
      warm = await step(0); series.push({ frameId: warm.frameId, irradiance: warm.irradiance });
      if (index === 11) require(warm.states.every(state => state[0] === epoch && state[2]! >= 1), 'One declared update period failed to visit every probe.');
    }
    require(warm.irradiance[1]!.some(value => value > 0.001), 'Sunlit source room has no indirect energy after three update periods.');
    const updateScene = (options: Parameters<typeof createGiScene>[0]) => {
      refitGiTraceData(data, createGiScene(options));
      [data.nodeData, data.triangleData, data.boxData, data.materialData, data.uniformData]
        .forEach((bytes, binding) => device.queue.writeBuffer(source[binding]!, 0, bytes));
    };
    updateScene({ lightIntensity: 0 });
    const lightOff = await step(1); const darkEpoch = Number(lightOff.telemetry.cacheEpoch);
    require(darkEpoch === epoch + 1 && lightOff.states.filter(state => state[0] === darkEpoch).length === 32,
      'Lighting change did not invalidate the previous epoch while preserving the update budget.');
    require(lightOff.irradiance.flat().every(value => value < 1e-6), 'Old irradiance survived a zero-light epoch reset.');
    const dark = await step(1);
    require(dark.irradiance.flat().every(value => value < 1e-6), 'Stale unupdated probes leaked light after the reset.');
    updateScene({ lightIntensity: 1, doorOpen: false });
    const doorReset = await step(2);
    require(Number(doorReset.telemetry.cacheEpoch) === darkEpoch + 1, 'Rigid door change did not advance the cache epoch.');
    require(doorReset.states.filter(state => state[0] === darkEpoch + 1).length === 32, 'Door reset exceeded its bounded update window.');
    require(errors.length === 0, errors.join('; '));
    const allocations = { bufferBytes: cache.gpuBufferBytes, textureBytes: cache.gpuTextureBytes };
    cache.dispose(); cache.dispose();
    require(cache.gpuBufferBytes === 0 && cache.gpuTextureBytes === 0, 'Probe cache disposal retained GPU allocation counters.');
    return { kind: 'probe-cache-compute-validation', layout: probeCacheLayout, allocations,
      cold: { statistics: first.statistics, irradiance: first.irradiance, telemetry: first.telemetry },
      warm: { statistics: warm.statistics, irradiance: warm.irradiance, telemetry: warm.telemetry },
      lightOff: { statistics: lightOff.statistics, irradiance: lightOff.irradiance, telemetry: lightOff.telemetry },
      doorReset: { statistics: doorReset.statistics, irradiance: doorReset.irradiance, telemetry: doorReset.telemetry },
      convergence: { unit: 'submitted frames, not a claimed display rate', qualification: 'Finite observation only; not radiometric convergence against an independent lighting reference.', samples: series }, gpuErrors: errors };
  } finally { cache?.dispose(); for (const buffer of buffers) buffer.destroy(); device.destroy(); }
}

/** Cold-cache rendered proof with no screen tracing or temporal accumulation. */
export async function validateGiRenderedScene() {
  const adapter = await navigator.gpu.requestAdapter(); require(adapter, 'No WebGPU adapter for rendered GI validation.');
  const device = await adapter.requestDevice(); const errors: string[] = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const receiver: Vec3 = [-1.5, 0.01, 0.2]; let width = 320; let height = 180; let frameId = 0;
  let target = device.createTexture({ label: 'GI validation presentation', size: [width, height], format: 'rgba8unorm', usage: 0x10 });
  let renderer: GiRenderer | undefined;
  const progress: Record<string, unknown> = { stage: 'initialization' };
  const observationSubmissions = 240; const tailSubmissions = 24;
  type Controls = NonNullable<Parameters<GiRenderer['encode']>[5]>;
  type Roi = Awaited<ReturnType<typeof readGiLinearRoi>>;
  try {
    const step = async (controls: Controls = {}) => {
      const effective = { temporal: false, debugView: 'indirect' as const, ...controls };
      const encoder = device.createCommandEncoder();
      const stats = renderer!.encode(encoder, target.createView(), width, height, frameId / 60, effective);
      device.queue.submit([encoder.finish()]); renderer!.submitted(++frameId);
      require(stats.dispatchCalls === (renderer!.giTelemetry.enabled ? 3 : 0), 'GI disabled/enabled compute pass count is incorrect.');
      const camera = renderer!.currentCamera; require(camera, 'GI renderer did not publish its camera.');
      const pixel = projectGiValidationPoint(camera.viewProjection, receiver, width, height);
      const directTexture = renderer!.directTexture; require(directTexture, 'GI renderer did not publish its direct HDR texture.');
      const direct = await readGiLinearRoi(device, directTexture, pixel);
      let indirect: Roi | null = null;
      if (renderer!.giTelemetry.enabled) {
        const texture = renderer!.composer.outputTexture; require(texture, 'GI compositor did not produce linear output.');
        indirect = await readGiLinearRoi(device, texture, pixel);
      }
      return { frameId, direct, indirect, telemetry: renderer!.giTelemetry, stats };
    };
    const create = async (wallColor: 'red' | 'neutral') => {
      renderer?.dispose();
      renderer = await GiRenderer.create(device, 'rgba8unorm', { renderer: 'gi', wallColor, doorOpen: true,
        cameraMode: 'receiver', probesPerUpdate: 32, raysPerProbe: 64 });
    };
    const warm = async (count = 36) => {
      const samples = [];
      for (let index = 0; index < count; index++) {
        const result = await step(); samples.push({ submission: result.frameId, framesSinceReset: Number(result.telemetry.framesSinceReset),
          indirectRgb: result.indirect!.mean, telemetry: result.telemetry });
      }
      return samples;
    };
    const tailMean = (samples: Awaited<ReturnType<typeof warm>>) => [0, 1, 2].map(channel => {
      const tail = samples.slice(-tailSubmissions);
      return tail.reduce((sum, sample) => sum + sample.indirectRgb[channel]!, 0) / tail.length;
    });
    const summarizeResponse = (samples: Awaited<ReturnType<typeof warm>>) => {
      const energies = samples.map(sample => sample.indirectRgb.reduce((sum, value) => sum + value, 0));
      const tail = energies.slice(-tailSubmissions); const mean = tail.reduce((sum, value) => sum + value, 0) / tail.length;
      const standardDeviation = Math.sqrt(tail.reduce((sum, value) => sum + (value - mean) ** 2, 0) / tail.length);
      const stable = samples.find((_, index) => energies.slice(index).every(value => Math.abs(value - mean) <= Math.max(mean * 0.2, 1e-6)));
      return { firstResponseFrame: samples.find(sample => sample.indirectRgb.some(value => value > 1e-5))?.framesSinceReset ?? null,
        tailEnergy: distribution(tail), tailStandardDeviation: standardDeviation,
        tailCoefficientOfVariation: mean > 0 ? standardDeviation / mean : null,
        firstRemainingWithin20PercentTailMean: stable?.framesSinceReset ?? null };
    };
    await create('red');
    const coldRed = await step({ cameraCut: true });
    progress.stage = 'cold-red'; progress.coldRed = coldRed;
    require(isColoredWallOffscreen(renderer!.currentScene, renderer!.currentCamera!.viewProjection),
      'The colored source wall must be completely offscreen before the first GI update.');
    require(coldRed.indirect!.mean.every(value => value < 1e-6), 'Fresh GI caches unexpectedly contained receiver lighting.');
    const redSeries = await warm(observationSubmissions - 1); const red = tailMean(redSeries);
    progress.stage = 'warm-red'; progress.redSeries = redSeries;
    require(red.some(value => value > 0.0001), 'An offscreen source did not affect the visible receiver from a cold cache.');
    require(coldRed.direct.mean.every(value => value < 0.00001), 'The receiver must be shadowed in the direct-only baseline.');
    const redEpoch = Number(renderer!.giTelemetry.cacheEpoch);
    const cameraCut = await step({ cameraCut: true });
    require(Number(cameraCut.telemetry.cacheEpoch) === redEpoch, 'A screen history cut invalidated world-space GI.');
    const close = await step({ gi: { doorOpen: false } });
    progress.stage = 'closed-door-reset'; progress.close = close;
    require(Number(close.telemetry.cacheEpoch) === redEpoch + 1, 'Closing the rigid door did not invalidate old lighting.');
    require(close.indirect!.mean.every(value => value < 1e-6), 'Closed door reset retained old receiver irradiance.');
    const closedSeries = await warm(35); const closed = tailMean(closedSeries);
    progress.stage = 'closed-door-stabilization'; progress.closedSeries = closedSeries;
    const openEnergy = red.reduce((sum, value) => sum + value, 0); const closedEnergy = closed.reduce((sum, value) => sum + value, 0);
    require(closedEnergy < openEnergy * 0.25, `Closed-door leakage is too large: closed/open=${closedEnergy / openEnergy}.`);
    const lightOff = await step({ gi: { lightIntensity: 0 } });
    progress.stage = 'light-off'; progress.lightOff = lightOff;
    require([...lightOff.direct.mean, ...lightOff.indirect!.mean].every(value => value < 1e-6), 'Disabling the light retained direct or indirect radiance.');
    const paused = await step({ gi: { enabled: false } });
    require(paused.indirect === null && paused.stats.dispatchCalls === 0, 'GI disabled still dispatched tracing/update/shading.');
    const resumed = await step({ gi: { enabled: true, lightIntensity: 1, doorOpen: true } });
    require(resumed.indirect!.mean.every(value => value < 1e-6), 'Reenabled GI reused stale cache data.');
    const reopenSeries = await warm(observationSubmissions - 1); const reopened = tailMean(reopenSeries);
    progress.stage = 'reopened-door'; progress.reopenSeries = reopenSeries;
    require(reopened.reduce((sum, value) => sum + value, 0) > openEnergy * 0.25, 'Reopening the door did not restore receiver lighting.');
    const beforeResize = Number(renderer!.giTelemetry.cacheEpoch);
    target.destroy(); width = 160; height = 90;
    target = device.createTexture({ label: 'Resized GI validation presentation', size: [width, height], format: 'rgba8unorm', usage: 0x10 });
    const resized = await step({ temporal: true, cameraCut: true });
    require(Number(resized.telemetry.cacheEpoch) === beforeResize, 'Resize or temporal toggling invalidated the world cache.');
    renderer!.dispose();
    require(renderer!.gpuBufferBytes === 0 && renderer!.gpuTextureBytes === 0, 'GI renderer disposal retained allocation counters.');
    target.destroy(); width = 320; height = 180;
    target = device.createTexture({ label: 'Neutral GI validation presentation', size: [width, height], format: 'rgba8unorm', usage: 0x10 });
    await create('neutral');
    const coldNeutral = await step({ cameraCut: true });
    progress.stage = 'cold-neutral'; progress.coldNeutral = coldNeutral;
    require(isColoredWallOffscreen(renderer!.currentScene, renderer!.currentCamera!.viewProjection), 'Neutral comparison source entered the camera view.');
    require(coldNeutral.indirect!.mean.every(value => value < 1e-6), 'Neutral comparison did not start from a cold cache.');
    const neutralSeries = await warm(observationSubmissions - 1); const neutral = tailMean(neutralSeries);
    progress.stage = 'warm-neutral'; progress.neutralSeries = neutralSeries;
    const redRatio = red[0]! / Math.max(red[1]!, 1e-8); const neutralRatio = neutral[0]! / Math.max(neutral[1]!, 1e-8);
    require(redRatio > neutralRatio + 0.2, `Offscreen material color did not affect receiver chroma: red R/G=${redRatio}, neutral=${neutralRatio}.`);
    require(errors.length === 0, errors.join('; '));
    return { kind: 'cold-offscreen-rendered-gi', receiverWorld: receiver, receiverPixels: coldRed.indirect!.center,
      sourceCompletelyOffscreen: true, screenTracing: false, temporalDuringEnergyComparisons: false,
      directOnly: coldRed.direct, coldRed: coldRed.indirect, coldNeutral: coldNeutral.indirect,
      redTailMean: red, neutralTailMean: neutral, redGreenRatio: { red: redRatio, neutral: neutralRatio },
      closedDoorTailMean: closed, closedOpenEnergyRatio: closedEnergy / openEnergy, reopenedDoorTailMean: reopened,
      lightOff: { direct: lightOff.direct, indirect: lightOff.indirect },
      convergence: { unit: 'submitted frames, not a claimed display rate', qualification: 'Tail-relative stabilization only; not radiometric convergence against an independent lighting reference.', observationSubmissions, tailSubmissions,
        summaryDefinition: 'Retrospective response within the finite observation window; final tail mean is not a ground-truth error bound.',
        summaries: { red: summarizeResponse(redSeries), neutral: summarizeResponse(neutralSeries), closed: summarizeResponse(closedSeries), reopened: summarizeResponse(reopenSeries) },
        red: redSeries, neutral: neutralSeries, closed: closedSeries, reopened: reopenSeries },
      lifecycle: { cameraCutEpoch: cameraCut.telemetry.cacheEpoch, beforeResizeEpoch: beforeResize, resizedEpoch: resized.telemetry.cacheEpoch,
        pausedDispatchCalls: paused.stats.dispatchCalls }, gpuErrors: errors };
  } catch (cause) {
    return { kind: 'cold-offscreen-rendered-gi', failure: cause instanceof Error ? cause.message : String(cause), progress, gpuErrors: errors };
  } finally { renderer?.dispose(); target.destroy(); device.destroy(); }
}

type GiVisualView = 'final' | 'direct' | 'indirect' | 'trace' | 'probe-age' | 'probe-irradiance' | 'probe-visibility';
let visualSession: { device: GPUDevice; context: GPUCanvasContext; renderer: GiRenderer; frame: number;
  cameraMode: 'receiver' | 'overview'; errors: string[] } | undefined;

/** Keep a real canvas alive between Playwright screenshots. */
export async function startGiVisualScene(cameraMode: 'receiver' | 'overview') {
  disposeGiVisualScene();
  const adapter = await navigator.gpu.requestAdapter(); require(adapter, 'No adapter for GI image capture.');
  const device = await adapter.requestDevice();
  const canvas = document.querySelector('canvas'); require(canvas, 'GI capture canvas is missing.');
  canvas.width = 640; canvas.height = 360; canvas.style.width = '640px'; canvas.style.height = '360px';
  const context = canvas.getContext('webgpu') as GPUCanvasContext | null; require(context, 'No WebGPU canvas for GI image capture.');
  const errors: string[] = []; device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const format = navigator.gpu.getPreferredCanvasFormat(); context.configure({ device, format, alphaMode: 'opaque' });
  try {
    const renderer = await GiRenderer.create(device, format, { renderer: 'gi', cameraMode, probesPerUpdate: 32, raysPerProbe: 64 });
    visualSession = { device, context, renderer, frame: 0, cameraMode, errors };
    for (let index = 0; index < 240; index++) {
      submitGiVisual('final');
      if (index % 12 === 11) await device.queue.onSubmittedWorkDone();
    }
    require(errors.length === 0, errors.join('; '));
    return { cameraMode, warmupSubmissions: 240, telemetry: renderer.giTelemetry };
  } catch (cause) { disposeGiVisualScene(); context.unconfigure(); device.destroy(); throw cause; }
}

function submitGiVisual(debugView: GiVisualView) {
  require(visualSession, 'GI visual session has not started.');
  const { device, context, renderer } = visualSession;
  const encoder = device.createCommandEncoder();
  renderer.encode(encoder, context.getCurrentTexture().createView(), 640, 360, visualSession.frame / 60, { temporal: false, debugView });
  device.queue.submit([encoder.finish()]); renderer.submitted(++visualSession.frame);
}

export async function renderGiVisualView(debugView: GiVisualView) {
  submitGiVisual(debugView);
  const session = visualSession!;
  await session.device.queue.onSubmittedWorkDone();
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  require(session.errors.length === 0, session.errors.join('; '));
  return { cameraMode: session.cameraMode, debugView, displayGain: debugView === 'indirect' ? 20 : 1,
    width: 640, height: 360, telemetry: session.renderer.giTelemetry };
}

export function disposeGiVisualScene() {
  if (!visualSession) return;
  visualSession.renderer.dispose(); visualSession.context.unconfigure(); visualSession.device.destroy(); visualSession = undefined;
}
