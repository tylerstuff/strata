import { probeSamplingShader } from '../../packages/core/src/gi/probe-cache-shaders.js';

type Vec3 = readonly [number, number, number];
interface Fixture { name: string; origin: Vec3; grid: Vec3; spacing: number; min: Vec3; max: Vec3; columns: number }
interface Query { name: string; world: Vec3; normal: Vec3; view: Vec3; inside: boolean; legacyInside: boolean }

// Independent world-space answers, deliberately not imported from the production predicate.
const fixtures: readonly Fixture[] = [
  { name: 'production-room', origin: [-5.5, 0.5, -3.5], grid: [12, 4, 8], spacing: 1, min: [-6, 0, -4], max: [6, 4, 4], columns: 24 },
  { name: 'translated-two-metre-grid', origin: [10, 20, 30], grid: [2, 2, 2], spacing: 2, min: [9, 19, 29], max: [13, 23, 33], columns: 2 },
];
const hdr: Vec3 = [2, 4, 8];
const tolerance = { insideAbsolute: 0.002, outsideAbsolute: 1e-7, patternedPairwiseAbsolute: 1e-5 };
const guard = '  if (any(grid < vec3f(-0.5)) || any(grid > vec3f(giProbeConfig.grid.xyz) - vec3f(0.5))) { return vec3f(0.0); }';

function queriesFor(fixture: Fixture): Query[] {
  const { min, max } = fixture;
  const center = min.map((value, axis) => (value + max[axis]!) / 2) as unknown as Vec3;
  const result: Query[] = [];
  const atPoint = (name: string, point: Vec3, inside: boolean, legacyInside = true): void => {
    // Axis-aligned unit vectors keep exact face/edge/corner coordinates unchanged
    // in Y/Z; X endpoints are represented exactly after the production bias.
    const sign = point[0] > center[0] ? -1 : 1;
    result.push({ name, world: [point[0] - sign * 0.14, point[1], point[2]], normal: [sign, 0, 0], view: [sign, 0, 0], inside, legacyInside });
  };
  atPoint('interior-center', center, true);
  atPoint('first-probe-center', fixture.origin, true);
  for (let axis = 0; axis < 3; axis++) for (const side of [-1, 1]) {
    for (const [label, offset, inside] of [['boundary', 0, true], ['just-inside', -0.01, true], ['just-outside', 0.01, false]] as const) {
      const point = [...center]; point[axis] = (side < 0 ? min : max)[axis]! + side * offset;
      atPoint(`axis-${axis}-${side < 0 ? 'min' : 'max'}-${label}`, point as unknown as Vec3, inside);
    }
    const far = [...center]; far[axis] = (side < 0 ? min : max)[axis]! + side * fixture.spacing * 2;
    atPoint(`axis-${axis}-${side < 0 ? 'min' : 'max'}-far-outside`, far as unknown as Vec3, false, false);
  }
  for (let freeAxis = 0; freeAxis < 3; freeAxis++) for (let bits = 0; bits < 4; bits++) {
    const point = [...center]; let bit = 0;
    for (let axis = 0; axis < 3; axis++) if (axis !== freeAxis) point[axis] = ((bits >> bit++) & 1 ? max : min)[axis]!;
    atPoint(`closed-edge-${freeAxis}-${bits}`, point as unknown as Vec3, true);
  }
  for (let bits = 0; bits < 8; bits++) {
    const point = min.map((value, axis) => (bits >> axis) & 1 ? max[axis]! : value) as unknown as Vec3;
    atPoint(`closed-corner-${bits}`, point, true);
    atPoint(`outside-corner-${bits}`, point.map((value, axis) => value + ((bits >> axis) & 1 ? 0.01 : -0.01)) as unknown as Vec3, false);
  }
  if (fixture.name === 'production-room') {
    // Tangent view leaves the wall/floor plane coordinate affected only by the
    // production 0.12m normal bias; the 0.02m view bias still operates in X.
    const surface = (name: string, world: Vec3, normal: Vec3, inside: boolean) => result.push({ name, world, normal, view: [1, 0, 0], inside, legacyInside: true });
    surface('actual-red-wall-exterior-biased-z-minus-4.22', [3, 2, -4.1], [0, 0, -1], false);
    surface('actual-red-wall-interior-biased-z-minus-3.88', [3, 2, -4], [0, 0, 1], true);
    result.push({ name: 'exterior-facing-view-biased-z-minus-4.24', world: [3, 2, -4.1], normal: [0, 0, -1], view: [0, 0, -1], inside: false, legacyInside: true });
    result.push({ name: 'interior-facing-view-biased-z-minus-3.86', world: [3, 2, -4], normal: [0, 0, 1], view: [0, 0, 1], inside: true, legacyInside: true });
    surface('floor-interior-biased-y-plus-0.12', [0, 0, 0], [0, 1, 0], true);
    surface('floor-outward-biased-y-minus-0.12', [0, 0, 0], [0, -1, 0], false);
    surface('ceiling-interior-biased-y-3.88', [0, 4, 0], [0, -1, 0], true);
    surface('ceiling-outward-biased-y-4.12', [0, 4, 0], [0, 1, 0], false);
    surface('actual-room-floor-receiver', [-1.5, 0.01, 0.2], [0, 1, 0], true);
    surface('actual-inner-back-wall-receiver', [5.5, 1.5, -4], [0, 0, 1], true);
    surface('actual-receiver-ceiling-underside', [-3, 4, 0], [0, -1, 0], true);
    // These start inside the volume; the *biased* position must decide support.
    surface('inside-world-normal-bias-crosses-west-plane', [-5.95, 2, 0], [-1, 0, 0], false);
    result.push({ name: 'inside-world-view-bias-crosses-east-plane', world: [5.99, 2, 0], normal: [0, 1, 0], view: [1, 0, 0], inside: false, legacyInside: true });
  }
  return result;
}

const kernel = /* wgsl */ `
struct VolumeQuery { world: vec4f, normal: vec4f, view: vec4f, };
@group(0) @binding(4) var<storage, read> queries: array<VolumeQuery>;
@group(0) @binding(5) var<storage, read_write> results: array<vec4f>;
@compute @workgroup_size(64) fn validateVolume(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&queries)) { return; }
  let query = queries[id.x];
  results[id.x] = vec4f(sampleProbeIrradiance(query.world.xyz, query.normal.xyz, query.view.xyz), 1.0);
}
`;

async function runFixture(device: GPUDevice, fixture: Fixture, variants: readonly { name: string; source: string }[], atlasMode: 'constant' | 'patterned') {
  const queries = queriesFor(fixture); const buffers: GPUBuffer[] = []; const textures: GPUTexture[] = [];
  try {
    const buffer = (label: string, size: number, usage: number) => {
      const value = device.createBuffer({ label, size, usage }); buffers.push(value); return value;
    };
    const texture = (label: string, size: readonly [number, number], format: GPUTextureFormat) => {
      const value = device.createTexture({ label, size: [...size], format, usage: 0x02 | 0x04 }); textures.push(value); return value;
    };
    const count = fixture.grid[0] * fixture.grid[1] * fixture.grid[2]; const rows = count / fixture.columns;
    const irradiance = texture('Constant probe irradiance', [fixture.columns * 8, rows * 8], 'rgba16float');
    const visibility = texture('Unoccluded probe distance moments', [fixture.columns * 16, rows * 16], 'rg32float');
    const irradianceData = new Uint16Array(fixture.columns * rows * 8 * 8 * 4);
    // All inputs below are positive, normal, exactly half-representable dyadics.
    const word = new Uint32Array(1); const value = new Float32Array(word.buffer);
    const half = (component: number): number => { value[0] = component; return (((word[0]! >>> 23) - 112) << 10) | ((word[0]! & 0x7fffff) >>> 13); };
    for (let probe = 0; probe < count; probe++) {
      const color = atlasMode === 'constant' ? hdr : [0.5 + (probe % 7) * 0.25, 1 + ((probe * 3) % 11) * 0.125, 2 + ((probe * 5) % 13) * 0.25];
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const pixel = (Math.floor(probe / fixture.columns) * 8 + y) * fixture.columns * 8 + (probe % fixture.columns) * 8 + x;
        irradianceData.set([...color.map(half), 0x3c00], pixel * 4);
      }
    }
    const moments = new Float32Array(fixture.columns * rows * 16 * 16 * 2);
    for (let offset = 0; offset < moments.length; offset += 2) moments.set([24, 576], offset);
    device.queue.writeTexture({ texture: irradiance }, irradianceData, { bytesPerRow: fixture.columns * 8 * 8 }, [fixture.columns * 8, rows * 8]);
    device.queue.writeTexture({ texture: visibility }, moments, { bytesPerRow: fixture.columns * 16 * 8 }, [fixture.columns * 16, rows * 16]);
    const stateData = new Uint32Array(count * 4);
    for (let index = 0; index < count; index++) stateData.set([7, 1, 3, 10], index * 4);
    const configData = new ArrayBuffer(96); const floats = new Float32Array(configData); const words = new Uint32Array(configData);
    floats.set([...fixture.origin, fixture.spacing], 0); words.set([...fixture.grid, count], 4);
    words.set([0, Math.min(32, count), 64, 7], 8); floats.set([0.85, 32, 0.12, 32], 12);
    words.set([11, 0, 1337, 120], 16); words.set([fixture.columns, 8, 16, 0], 20);
    const queryData = new Float32Array(queries.length * 12);
    queries.forEach((query, index) => { queryData.set(query.world, index * 12); queryData.set(query.normal, index * 12 + 4); queryData.set(query.view, index * 12 + 8); });
    const state = buffer('Recent valid probe states', stateData.byteLength, 0x80 | 0x08);
    const config = buffer('Probe volume config', 96, 0x40 | 0x08);
    const input = buffer('Probe volume queries', queryData.byteLength, 0x80 | 0x08);
    const output = buffer('Probe volume results', queries.length * 16, 0x80 | 0x04);
    const readback = buffer('Probe volume readback', queries.length * 16, 0x01 | 0x08);
    device.queue.writeBuffer(state, 0, stateData); device.queue.writeBuffer(config, 0, configData); device.queue.writeBuffer(input, 0, queryData);
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: 4, texture: { sampleType: 'float' } },
      { binding: 1, visibility: 4, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 4, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: 4, buffer: { type: 'storage' } },
    ] });
    const bindings = device.createBindGroup({ layout, entries: [
      { binding: 0, resource: irradiance.createView() }, { binding: 1, resource: visibility.createView() },
      ...[state, config, input, output].map((value, index) => ({ binding: index + 2, resource: { buffer: value } })),
    ] });
    const runs = [];
    for (const variant of variants) {
      const module = device.createShaderModule({ label: `Probe volume ${variant.name}`, code: variant.source + kernel });
      const compilation = await module.getCompilationInfo();
      const errors = compilation.messages.filter(message => message.type === 'error').map(message => `${message.lineNum}:${message.linePos} ${message.message}`);
      if (errors.length) throw new Error(`Probe sampling shader did not compile: ${errors.join('; ')}`);
      const pipeline = await device.createComputePipelineAsync({ label: `Probe volume ${variant.name}`, layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: 'validateVolume' } });
      const encoder = device.createCommandEncoder(); const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.dispatchWorkgroups(Math.ceil(queries.length / 64)); pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, queries.length * 16); device.queue.submit([encoder.finish()]);
      await readback.mapAsync(0x01); const values = new Float32Array(readback.getMappedRange().slice(0)); readback.unmap();
      const samples = queries.map((query, index) => {
        const expectedInside = variant.name === 'production' ? query.inside : query.legacyInside;
        const expected = !expectedInside ? [0, 0, 0] : atlasMode === 'constant' ? hdr : null;
        const actual = [...values.slice(index * 4, index * 4 + 3)];
        const error = expected ? Math.max(...actual.map((value, axis) => Math.abs(value - expected[axis]!))) : null;
        const inRange = actual.every((component, axis) => component >= [0.5, 1, 2][axis]! - tolerance.insideAbsolute
          && component <= [2, 2.25, 5][axis]! + tolerance.insideAbsolute);
        if (!actual.every(Number.isFinite) || values[index * 4 + 3] !== 1
          || (error === null ? !inRange : error > (expectedInside ? tolerance.insideAbsolute : tolerance.outsideAbsolute))) {
          throw new Error(`Probe volume mismatch: ${JSON.stringify({ fixture: fixture.name, atlasMode, variant: variant.name, query, expected, actual, error, tolerance })}`);
        }
        return { ...query, expected, actual, maximumAbsoluteError: error };
      });
      runs.push({ variant: variant.name, dispatches: 1, queries: queries.length, samples });
    }
    const exposedLeaks = queries.filter(query => !query.inside && query.legacyInside).map(query => query.name);
    if (!exposedLeaks.length) throw new Error('Negative control must expose outside donor normalization.');
    let acceptedPairwiseMaximumError = 0;
    if (atlasMode === 'patterned') {
      for (let index = 0; index < queries.length; index++) if (queries[index]!.inside) {
        const production = runs[0]!.samples[index]!.actual; const control = runs[1]!.samples[index]!.actual;
        acceptedPairwiseMaximumError = Math.max(acceptedPairwiseMaximumError, ...production.map((component, axis) => Math.abs(component - control[axis]!)));
      }
      if (acceptedPairwiseMaximumError > tolerance.patternedPairwiseAbsolute) throw new Error(`Accepted nonuniform probe interpolation changed by ${acceptedPairwiseMaximumError}.`);
    }
    return { fixture, atlasMode, constantIrradiance: atlasMode === 'constant' ? hdr : null,
      patternedIrradiance: atlasMode === 'patterned' ? 'Per-probe dyadic RGB: [.5+(id%7)/4,1+((id*3)%11)/8,2+((id*5)%13)/4], direction-independent' : null,
      acceptedPairwiseMaximumError, visibilityMoments: [24, 576], normalBias: 0.12, viewBias: 0.02, exposedLeaks, runs };
  } finally {
    for (const resource of buffers) { if (resource.mapState === 'mapped') resource.unmap(); resource.destroy(); }
    for (const resource of textures) resource.destroy();
  }
}

/** Synthetic sampling proof only: no traced scene, image-quality or performance claim. */
export async function validateProbeVolume() {
  if (!navigator.gpu) throw new Error('WebGPU is required for the production probe volume shader proof.');
  const source = probeSamplingShader({ group: 0 });
  if (source.split(guard).length !== 2) throw new Error('Expected exactly one frozen production domain guard for the mechanical negative control.');
  const variants = [{ name: 'production', source }, { name: 'guard-removed-negative-control', source: source.replace(guard, '') }];
  const adapter = await navigator.gpu.requestAdapter(); if (!adapter) throw new Error('No WebGPU adapter.');
  const device = await adapter.requestDevice(); const errors: string[] = []; let scopes = 0; let destroying = false;
  const onError = (event: GPUUncapturedErrorEvent) => errors.push(event.error.message);
  device.addEventListener('uncapturederror', onError);
  void device.lost.then(info => { if (!destroying) errors.push(`Device lost: ${info.reason}: ${info.message}`); });
  try {
    for (const filter of ['validation', 'out-of-memory', 'internal'] as const) { device.pushErrorScope(filter); scopes++; }
    const results = [];
    for (const fixture of fixtures) for (const atlasMode of ['constant', 'patterned'] as const) results.push(await runFixture(device, fixture, variants, atlasMode));
    await device.queue.onSubmittedWorkDone();
    while (scopes > 0) { scopes--; const error = await device.popErrorScope(); if (error) errors.push(error.message); }
    if (errors.length) throw new Error(`GPU validation errors: ${errors.join('; ')}`);
    return { status: 'passed', tolerance, negativeControl: 'mechanically removed exactly one domain guard; all other shader bytes identical',
      adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description,
        isFallbackAdapter: adapter.info.isFallbackAdapter ?? null },
      totalDispatches: results.reduce((sum, result) => sum + result.runs.length, 0), results, gpuErrors: errors };
  } finally {
    while (scopes > 0) { scopes--; await device.popErrorScope().catch(() => undefined); }
    destroying = true; device.removeEventListener('uncapturederror', onError); device.destroy();
  }
}
