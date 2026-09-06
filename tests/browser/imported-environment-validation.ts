import { createEnvironmentResources, environmentUniform, importedEnvironmentShader, uploadEnvironmentLevel } from '../../packages/core/src/imported/imported-environment.js';
import { createImportedEnvironmentCubeCases } from './imported-environment-cube-cases.js';

type V3 = readonly [number, number, number];
const unit = (v: V3): V3 => { const length = Math.hypot(...v); return [v[0] / length, v[1] / length, v[2] / length]; };
function require(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function near(actual: readonly number[], expected: readonly number[], tolerance: number, label: string): number {
  const error = Math.max(...actual.map((value, index) => Math.abs(value - expected[index]!)));
  require(Number.isFinite(error) && error <= tolerance, `${label}: max error ${error} > ${tolerance}; ${actual} versus ${expected}`); return error;
}
interface Query { normal: V3; view: V3; base: V3; roughness: number; metallic: number; ao?: number }
const probe = /* wgsl */ `
struct Query { normal: vec4f, view: vec4f, base: vec4f, parameters: vec4f, };
@group(0) @binding(0) var<storage, read> queries: array<Query>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4f>;
@compute @workgroup_size(1) fn environmentProbe(@builtin(global_invocation_id) id: vec3u) {
  let q = queries[id.x];
  results[id.x] = vec4f(importedEnvironmentLight(q.base.xyz, q.parameters.x, q.parameters.y,
    q.normal.xyz, q.view.xyz, q.parameters.z), 1.0);
}
`;

/** Runs the actual environment WGSL with generated HDR sources and independent numeric witnesses. */
export async function validateImportedEnvironment(device: GPUDevice) {
  const resources = createEnvironmentResources(device);
  const buffers: GPUBuffer[] = [];
  let evaluations = 0;
  const errors: number[] = [];
  try {
    const module = device.createShaderModule({ code: importedEnvironmentShader + probe, label: 'Strata environment numeric production probe' });
    // Explicit layouts can be shared with the deliberately mutated shader. Auto-generated
    // layouts are exclusive to their original pipeline and cannot form a new pipeline layout.
    const queryLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: 0x4, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: 0x4, buffer: { type: 'storage' } },
    ] });
    const environmentLayout = device.createBindGroupLayout({ entries: [
      { binding: 12, visibility: 0x4, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      { binding: 13, visibility: 0x4, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 14, visibility: 0x4, sampler: { type: 'filtering' } },
      { binding: 15, visibility: 0x4, buffer: { type: 'uniform' } },
    ] });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [queryLayout, environmentLayout] });
    const pipeline = await device.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'environmentProbe' } });
    const binding = device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [
      { binding: 12, resource: resources.cube.createView({ dimension: '2d-array', arrayLayerCount: 12 }) },
      { binding: 13, resource: resources.dfg.createView() }, { binding: 14, resource: resources.sampler },
      { binding: 15, resource: { buffer: resources.uniform } },
    ] });
    async function run(queries: Query[], uniform: Float32Array<ArrayBuffer>, candidate = pipeline): Promise<number[][]> {
      require(queries.length > 0 && queries.length <= 128, 'Environment probe query budget exceeded.');
      device.queue.writeBuffer(resources.uniform, 0, uniform);
      const values = new Float32Array(queries.flatMap(q => [...q.normal, 0, ...q.view, 0, ...q.base, 0, q.roughness, q.metallic, q.ao ?? 1, 0]));
      const input = device.createBuffer({ size: values.byteLength, usage: 0x80 | 0x8 }); buffers.push(input);
      const output = device.createBuffer({ size: queries.length * 16, usage: 0x80 | 0x4 }); buffers.push(output);
      const readback = device.createBuffer({ size: queries.length * 16, usage: 0x1 | 0x8 }); buffers.push(readback);
      device.queue.writeBuffer(input, 0, values);
      const queriesBinding = device.createBindGroup({ layout: candidate.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } }] });
      const encoder = device.createCommandEncoder(); const pass = encoder.beginComputePass();
      pass.setPipeline(candidate); pass.setBindGroup(0, queriesBinding); pass.setBindGroup(1, binding); pass.dispatchWorkgroups(queries.length); pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, queries.length * 16); device.queue.submit([encoder.finish()]);
      await readback.mapAsync(0x1);
      const data = new Float32Array(readback.getMappedRange()).slice(); readback.unmap();
      input.destroy(); output.destroy(); readback.destroy(); buffers.splice(buffers.length - 3, 3);
      evaluations += queries.length;
      return queries.map((_, index) => [...data.subarray(index * 4, index * 4 + 3)]);
    }
    // Save actual generated-preset outputs before replacing our private textures with analytical fixtures.
    const axis: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], unit([2, 1, -3])];
    // Signed seams vary the third coordinate, so the spatial RGB field below
    // detects reversed adjacent border rows as well as wrong neighbor faces.
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const third of [-.37, .37]) {
        const direction: [number, number, number] = [0, 0, 0]; direction[a] = x; direction[b] = y; direction[3 - a - b] = third;
        axis.push(unit(direction));
      }
    }
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) axis.push(unit([x, y, z]));
    const metallicQueries = axis.map(normal => ({ normal, view: normal, base: [1, 1, 1] as V3, roughness: .06, metallic: 1 }));
    const studioUniform = environmentUniform({ preset: 'studio', intensity: 1, rotationRadians: 0 }, 'authored');
    const studio = await run(metallicQueries, studioUniform);
    const sky = await run(metallicQueries, environmentUniform({ preset: 'sky', intensity: 1, rotationRadians: 0 }, 'authored'));
    require(studio.some((rgb, index) => Math.abs(rgb[0]! - sky[index]![0]!) > .1), 'Environment selection must change actual distant radiance.');
    const off = await run(metallicQueries, environmentUniform(null, 'authored'));
    off.forEach(value => errors.push(near(value, [0, 0, 0], 0, 'Environment off is exactly zero')));
    const doubled = await run(metallicQueries, environmentUniform({ preset: 'studio', intensity: 2, rotationRadians: 0 }, 'authored'));
    doubled.forEach((value, index) => errors.push(near(value, studio[index]!.map(v => v * 2), .00001, 'Environment intensity is linear')));

    // Constant white incident radiance in all faces/levels. Isolate BRDF energy from texture prefilter approximations.
    for (let level = 0; level < 7; level++) {
      const edge = 64 >> level, data = new Uint16Array(edge * edge * 12 * 4).fill(0x3c00);
      uploadEnvironmentLevel(device, resources.cube, level, data);
    }
    const constant = environmentUniform({ preset: 'studio', intensity: 1, rotationRadians: 0 }, 'authored');
    constant.fill(0, 8); constant.set([Math.PI / .28209479177387814, Math.PI / .28209479177387814, Math.PI / .28209479177387814], 8);
    const furnaceQueries: Query[] = [];
    const expected: number[][] = [];
    for (const nv of [1, .5, .1, .01]) {
      const view: V3 = [Math.sqrt(1 - nv * nv), 0, nv];
      furnaceQueries.push({ normal: [0, 0, 1], view, base: [1, 1, 1], roughness: 1, metallic: 1 });
      expected.push(Array(3).fill(1 - nv * Math.log1p(1 / nv)));
      furnaceQueries.push({ normal: [0, 0, 1], view, base: [1, 1, 1], roughness: 1, metallic: 0 }); expected.push([1, 1, 1]);
    }
    const furnace = await run(furnaceQueries, constant);
    furnace.forEach((value, index) => errors.push(near(value, expected[index]!, index % 2 ? .0001 : .003, 'Independent roughness-one furnace')));
    const anchors = [[1, .06, .999986963852, .000000011568], [.5, .35, .923143131646, .031206680972], [.1, .06, .410669769739, .588635556161], [.02, .06, .104267680116, .876341603627]];
    const brdfQueries: Query[] = anchors.map(([nv, roughness]) => ({ normal: [0, 0, 1], view: [Math.sqrt(1 - nv! * nv!), 0, nv!], base: [0, .04, 1], roughness: roughness!, metallic: 1 }));
    const brdf = await run(brdfQueries, constant);
    brdf.forEach((value, index) => { const [, , a, b] = anchors[index]!; errors.push(near(value, [b!, .04 * a! + b!, a! + b!], .004, 'Independent A/B/white specular controls')); });
    // Execute a real removed-specular shader mutation against the same furnace acceptance.
    const wrongModule = device.createShaderModule({ code: importedEnvironmentShader.replace('diffuse + radiance * specularEnergy', 'diffuse') + probe });
    const wrong = await device.createComputePipelineAsync({ layout, compute: { module: wrongModule, entryPoint: 'environmentProbe' } });
    const rejected = await run([furnaceQueries[0]!], constant, wrong);
    let rejects = false; try { near(rejected[0]!, expected[0]!, .003, 'Removed environment specular control'); } catch { rejects = true; }
    require(rejects, 'Removed-specular negative control was accepted.');

    // A signed RGB direction field validates cube orientation and both inverse-yaw paths without a baked-data oracle.
    const toHalf = (value: number) => { const exponent = Math.floor(Math.log2(value)); return ((exponent + 15) << 10) + Math.round((value / 2 ** exponent - 1) * 1024); };
    const data = new Uint16Array(64 * 64 * 12 * 4);
    for (let face = 0; face < 12; face++) for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const u = (x + .5) / 32 - 1, v = (y + .5) / 32 - 1;
      const directions: V3[] = [[1, -v, -u], [-1, -v, u], [u, 1, v], [u, -1, -v], [u, -v, 1], [-u, -v, -1]];
      const n = unit(directions[face % 6]!); const offset = ((face * 64 + y) * 64 + x) * 4;
      data.set([...n.map(component => toHalf(1 + .2 * component)), 0x3c00], offset);
    }
    uploadEnvironmentLevel(device, resources.cube, 0, data);
    for (const rotation of [0, Math.PI / 2]) {
      const uniform = environmentUniform({ preset: 'studio', intensity: 1, rotationRadians: rotation }, 'authored');
      const result = await run(metallicQueries, uniform);
      result.forEach((value, index) => {
        const n = axis[index]!, c = Math.cos(rotation), s = Math.sin(rotation), rotated = [c * n[0] - s * n[2], n[1], s * n[0] + c * n[2]];
        errors.push(near(value, rotated.map(v => 1 + .2 * v), .002, 'Signed cube axes and inverse environment yaw'));
      });
      // E/pi=(1+.2*(2/3)*n) is exact for this affine radiance. Subtract the same
      // dielectric with zero material AO to isolate only its diffuse partition.
      uniform.fill(0, 8);
      uniform.set([Math.PI / .28209479177387814, Math.PI / .28209479177387814, Math.PI / .28209479177387814], 8);
      const coefficient = .2 * (4 * Math.PI / 3) * .4886025119029199 * (2 * Math.PI / 3);
      uniform[8 + 3 * 4] = coefficient; uniform[8 + 1 * 4 + 1] = coefficient; uniform[8 + 2 * 4 + 2] = coefficient;
      const diffuse = await run(axis.flatMap(normal => [{ normal, view: normal, base: [1, 1, 1] as V3, roughness: .06, metallic: 0, ao: 1 },
        { normal, view: normal, base: [1, 1, 1] as V3, roughness: .06, metallic: 0, ao: 0 }]), uniform);
      diffuse.filter((_, index) => index % 2 === 0).forEach((value, index) => {
        const n = axis[index]!, c = Math.cos(rotation), s = Math.sin(rotation), rotated = [c * n[0] - s * n[2], n[1], s * n[0] + c * n[2]];
        errors.push(near(value.map((v, channel) => v - diffuse[index * 2 + 1]![channel]!), rotated.map(v => (1 + .2 * 2 / 3 * v) * .96), .001, 'Affine irradiance and diffuse-only material AO'));
      });
    }
    const reversedRowShader = importedEnvironmentShader.replace('p = vec2f(-d.z, -d.y)', 'p = vec2f(-d.z, d.y)');
    require(reversedRowShader !== importedEnvironmentShader, 'Reversed-border-row mutation must apply.');
    const reversedRow = await device.createComputePipelineAsync({ layout, compute: { module: device.createShaderModule({ code: reversedRowShader + probe }), entryPoint: 'environmentProbe' } });
    const seamDirection = unit([1, .37, 1]);
    const rowResult = await run([{ normal: seamDirection, view: seamDirection, base: [1, 1, 1], roughness: .06, metallic: 1 }], studioUniform, reversedRow);
    let rowRejected = false; try { near(rowResult[0]!, seamDirection.map(v => 1 + .2 * v), .002, 'Signed gradient adjacent row'); } catch { rowRejected = true; }
    require(rowRejected, 'Reversed adjacent border row was accepted.');

    // Independent face/mip colors exercise (0.001 permits binary16 corner rounding and hardware filtering) all signed seams, all corners,
    // unequal edge weights and fractional LOD without reproducing the sampler.
    const cubeFixture = createImportedEnvironmentCubeCases();
    for (const { level, edge, data } of cubeFixture.mipLevels) {
      uploadEnvironmentLevel(device, resources.cube, level, data);
    }
    const cubeProbe = probe.replace('importedEnvironmentLight(q.base.xyz, q.parameters.x, q.parameters.y,\n    q.normal.xyz, q.view.xyz, q.parameters.z)',
      'importedCubeRadiance(q.normal.xyz, q.parameters.x, i32(q.parameters.y))');
    require(cubeProbe !== probe, 'Cube probe must call the production cube filter.');
    async function cubePipeline(shader: string) {
      return device.createComputePipelineAsync({ layout, compute: { module: device.createShaderModule({ code: shader + cubeProbe }), entryPoint: 'environmentProbe' } });
    }
    const cube = await cubePipeline(importedEnvironmentShader);
    const query = (q: (typeof cubeFixture.queries)[number]): Query => ({ normal: q.direction, view: [0, 0, 1], base: [1, 1, 1], roughness: q.lod, metallic: q.preset });
    for (let offset = 0; offset < cubeFixture.queries.length; offset += 128) {
      const batch = cubeFixture.queries.slice(offset, offset + 128);
      const output = await run(batch.map(query), constant, cube);
      output.forEach((rgb, index) => errors.push(near(rgb, batch[index]!.expected, .001, batch[index]!.label)));
    }
    // A same-face clamp can preserve a constant source while losing its neighbor's
    // color. This mutation must fail the very same nonuniform seam assertion.
    const clampedEdgeShader = importedEnvironmentShader.replace('address.uv * f32(edge) + vec2f(1.0)', 'clamp(address.uv, vec2f(0.5 / f32(edge)), vec2f(1.0 - 0.5 / f32(edge))) * f32(edge) + vec2f(1.0)');
    require(clampedEdgeShader !== importedEnvironmentShader, 'Clamped-edge mutation must apply.');
    const seam = cubeFixture.queries.find(q => q.label.includes('seam'))!;
    const clampedEdge = await run([query(seam)], constant, await cubePipeline(clampedEdgeShader));
    let edgeRejected = false; try { near(clampedEdge[0]!, seam.expected, .00001, seam.label); } catch { edgeRejected = true; }
    require(edgeRejected, 'Discarded adjacent-face color was accepted.');
    const nearestLodShader = importedEnvironmentShader.replace('return mix(a, importedCubeLevel(address, lower + 1, preset), weight);', 'return a;');
    require(nearestLodShader !== importedEnvironmentShader, 'Nearest-LOD mutation must apply.');
    const fractional = cubeFixture.queries.find(q => !Number.isInteger(q.lod))!;
    const nearestLod = await run([query(fractional)], constant, await cubePipeline(nearestLodShader));
    let lodRejected = false; try { near(nearestLod[0]!, fractional.expected, .00001, fractional.label); } catch { lodRejected = true; }
    require(lodRejected, 'Discarded fractional LOD was accepted.');
    return { evaluations, cubeQueries: cubeFixture.queries.length, maximumAbsoluteError: Math.max(...errors), controls: ['presets', 'off', 'linear-intensity', 'single-scatter-furnace', 'independent-DFG', 'removed-specular-negative', 'cube-orientation', 'inverse-yaw', 'affine-irradiance', 'diffuse-AO', 'gradient-seams', 'reversed-row-negative', 'nonuniform-seams-corners-lod', 'clamped-edge-negative', 'nearest-lod-negative'] };
  } finally { for (const buffer of buffers) buffer.destroy(); resources.uniform.destroy(); resources.cube.destroy(); resources.dfg.destroy(); }
}
