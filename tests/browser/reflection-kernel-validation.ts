import { reflectionDirectionShader, reflectionHistoryShader } from '../../packages/core/src/reflections/reflection-shaders.js';
import { sampleReflectionDirection } from '../../packages/core/src/reflections/reflection-reference.js';
import type { ReflectionVector } from '../../packages/core/src/reflections/reflection-reference.js';

/** Optional diagnostic called with the caller's WebGPU device; no renderer or browser lifecycle ownership. */
export async function runReflectionKernelValidation(device: GPUDevice): Promise<{ sampleCount: number; maxDirectionError: number; maxWeightError: number; maxLengthError: number;
  history: Awaited<ReturnType<typeof runReflectionHistoryKernelValidation>> }> {
  const cases: { view: ReflectionVector; normal: ReflectionVector; roughness: number; random: readonly [number, number] }[] = [];
  for (const roughness of [0, 0.001, 0.08, 0.35]) for (const normal of [[0, 1, 0], [0, 0, 1]] as ReflectionVector[]) {
    for (const cosine of [1, 0.8, 0.01]) for (let index = 0; index < 16; index++) {
      const lateral = Math.sqrt(1 - cosine * cosine);
      const view: ReflectionVector = normal[1] === 1 ? [lateral, cosine, 0] : [lateral, 0, cosine];
      cases.push({ view, normal, roughness, random: [(index + 0.5) / 16, (index * 0.61803398875) % 1] });
    }
  }
  const input = new Float32Array(cases.length * 16);
  cases.forEach((sample, index) => {
    input.set(sample.view, index * 16); input.set(sample.normal, index * 16 + 4);
    input.set([...sample.random, sample.roughness, 0], index * 16 + 8); input.set([0.85, 0.85, 0.85, 0], index * 16 + 12);
  });
  const resources: GPUBuffer[] = [];
  try {
    const make = (label: string, size: number, usage: number): GPUBuffer => { const value = device.createBuffer({ label, size, usage }); resources.push(value); return value; };
    const source = make('Reflection kernel validation inputs', input.byteLength, 0x80 | 0x8);
    const output = make('Reflection kernel validation output', cases.length * 32, 0x80 | 0x4);
    const readback = make('Reflection kernel validation readback', cases.length * 32, 0x1 | 0x8);
    const code = reflectionDirectionShader + /* wgsl */ `
struct ReflectionKernelInput { view: vec4f, normal: vec4f, randomRoughness: vec4f, f0: vec4f, };
@group(0) @binding(0) var<storage, read> inputs: array<ReflectionKernelInput>;
@group(0) @binding(1) var<storage, read_write> outputs: array<vec4f>;
@compute @workgroup_size(64) fn validateReflectionDirection(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&inputs)) { return; }
  let sample = inputs[id.x];
  let result = reflectionDirection(normalize(sample.view.xyz), normalize(sample.normal.xyz), sample.randomRoughness.z, sample.randomRoughness.xy, sample.f0.xyz);
  outputs[id.x * 2u] = vec4f(result.direction, length(result.direction)); outputs[id.x * 2u + 1u] = vec4f(result.weight, 0.0);
}
`;
    const pipeline = await device.createComputePipelineAsync({ label: 'Reflection estimator validation', layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'validateReflectionDirection' } });
    const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: source } }, { binding: 1, resource: { buffer: output } },
    ] });
    device.queue.writeBuffer(source, 0, input);
    const encoder = device.createCommandEncoder(); const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.dispatchWorkgroups(Math.ceil(cases.length / 64)); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, cases.length * 32); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1); const values = new Float32Array(readback.getMappedRange());
    let maxDirectionError = 0; let maxWeightError = 0; let maxLengthError = 0;
    let worstDirection: unknown; let worstWeight: unknown;
    for (const [index, sample] of cases.entries()) {
      // Compare exactly the float32 values transferred to WGSL, including its normalized input vectors.
      const unit = (offset: number): ReflectionVector => {
        const vector = input.slice(index * 16 + offset, index * 16 + offset + 3);
        const length = Math.hypot(...vector);
        return [vector[0]! / length, vector[1]! / length, vector[2]! / length];
      };
      const packed = { view: unit(0), normal: unit(4), roughness: input[index * 16 + 10]!,
        random: [input[index * 16 + 8]!, input[index * 16 + 9]!] as const,
        f0: [input[index * 16 + 12]!, input[index * 16 + 13]!, input[index * 16 + 14]!] as const };
      const expected = sampleReflectionDirection(packed.view, packed.normal, packed.roughness, packed.random, packed.f0);
      const detail = () => ({ index, source: sample, packed, expected,
        actual: { direction: [...values.slice(index * 8, index * 8 + 3)], weight: [...values.slice(index * 8 + 4, index * 8 + 7)] } });
      for (let axis = 0; axis < 3; axis++) {
        const direction = values[index * 8 + axis]!; const weight = values[index * 8 + 4 + axis]!;
        if (!Number.isFinite(direction) || !Number.isFinite(weight) || weight < -1e-5 || weight > 1.00001) throw new Error(`Reflection kernel produced non-finite/unbounded sample ${index}.`);
        const directionError = Math.abs(direction - expected.direction[axis]!); const weightError = Math.abs(weight - expected.weight[axis]!);
        if (directionError > maxDirectionError) { maxDirectionError = directionError; worstDirection = detail(); }
        if (weightError > maxWeightError) { maxWeightError = weightError; worstWeight = detail(); }
      }
      maxLengthError = Math.max(maxLengthError, Math.abs(values[index * 8 + 3]! - 1));
    }
    if (maxDirectionError > 0.003 || maxWeightError > 0.003 || maxLengthError > 0.00009) {
      throw new Error(`Reflection kernel disagrees with float32-input CPU reference: ${JSON.stringify({ maxDirectionError, maxWeightError, maxLengthError, worstDirection, worstWeight })}`);
    }
    readback.unmap(); return { sampleCount: cases.length, maxDirectionError, maxWeightError, maxLengthError,
      history: await runReflectionHistoryKernelValidation(device) };
  } finally { for (const resource of resources) resource.destroy(); }
}

/** Golden mathematical cases execute the same helpers called by production resolve.
 * This checks sample semantics and hard rejection, not denoised image quality.
 */
export async function runReflectionHistoryKernelValidation(device: GPUDevice) {
  const resources: GPUBuffer[] = [];
  const size = 16 * 16;
  try {
    const make = (label: string, usage: number) => { const buffer = device.createBuffer({ label, size, usage }); resources.push(buffer); return buffer; };
    const output = make('Reflection history golden output', 0x80 | 0x4);
    const readback = make('Reflection history golden readback', 0x1 | 0x8);
    const code = reflectionHistoryShader + /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> golden: array<vec4f>;
fn record(index: u32, sample: ReflectionSample) { golden[index] = vec4f(sample.radiance, f32(sample.source)); }
fn historyFlag(value: bool) -> f32 { return select(0.0, 1.0, value); }
@compute @workgroup_size(1) fn validateReflectionHistory() {
  var history = vec3f(0.0); var total = 0.0; var low = 1000.0; var high = -1000.0; var wrongSource = 0u;
  for (var frame = 0u; frame < 240u; frame++) {
    let hit = frame % 2u == 0u;
    let sample = reflectionAccumulateFresh(vec3f(select(0.0, 1.0, hit), 0.0, 0.0), select(5u, 1u, hit), history, frame > 0u, 0.08, 0.8);
    if (sample.source != select(3u, 1u, frame == 0u)) { wrongSource++; }
    history = sample.radiance;
    if (frame >= 180u) { total += history.x; low = min(low, history.x); high = max(high, history.x); }
  }
  golden[0] = vec4f(total / 60.0, low, high, high - low);
  golden[1] = vec4f(f32(wrongSource), 240.0, 60.0, 0.0);
  record(2u, reflectionAccumulateFresh(vec3f(1.0, 0.0, 0.0), 1u, vec3f(0.0), false, 0.08, 0.8));
  record(3u, reflectionAccumulateFresh(vec3f(0.0), 5u, vec3f(1.0), false, 0.08, 0.8));
  record(4u, reflectionAccumulateFresh(vec3f(0.0), 5u, vec3f(1.0, 0.0, 0.0), true, 0.08, 0.8));
  record(5u, reflectionAccumulateFresh(vec3f(1.0, 0.0, 0.0), 1u, vec3f(0.5, 0.0, 0.0), true, 0.08, 0.8));
  record(6u, reflectionAccumulateFresh(vec3f(0.0), 5u, vec3f(4.0), true, 0.0, 0.8));
  record(7u, reflectionAccumulateFresh(vec3f(0.0), 2u, vec3f(4.0), true, 0.08, 0.8));
  record(8u, reflectionAccumulateFresh(vec3f(0.0), 4u, vec3f(4.0), true, 0.08, 0.8));
  record(9u, reflectionAccumulateFresh(vec3f(0.0), 0u, vec3f(1.0, 0.0, 0.0), true, 0.08, 0.8));
  var config: ReflectionConfig;
  config.frame = vec4u(10u, 2u, 2u, 0u); config.settings = vec4f(0.08, 16.0, 0.8, 4.0);
  let previous = vec4f(1.0, 0.0, 0.0, 3.0); let surface = vec4f(0.0, 1.0, 0.0, 0.08); let normal = vec3f(0.0, 1.0, 0.0);
  golden[10] = vec4f(
    historyFlag(reflectionQualify(vec4u(5u, 8u, 2u, 1u), previous, surface, 3.0, normal, 0.08, config)),
    historyFlag(reflectionQualify(vec4u(2u, 8u, 2u, 1u), previous, surface, 3.0, normal, 0.08, config)),
    historyFlag(reflectionQualify(vec4u(4u, 8u, 2u, 1u), previous, surface, 3.0, normal, 0.08, config)),
    historyFlag(reflectionQualify(vec4u(5u, 8u, 2u, 0u), previous, surface, 3.0, normal, 0.08, config)));
  golden[11] = vec4f(
    historyFlag(reflectionQualify(vec4u(5u, 8u, 1u, 1u), previous, surface, 3.0, normal, 0.08, config)),
    historyFlag(reflectionQualify(vec4u(5u, 11u, 2u, 1u), previous, surface, 3.0, normal, 0.08, config)),
    historyFlag(reflectionQualify(vec4u(5u, 5u, 2u, 1u), previous, surface, 3.0, normal, 0.08, config)),
    historyFlag(reflectionQualify(vec4u(5u, 8u, 2u, 1u), previous, surface, 3.1, normal, 0.08, config)));
  golden[12] = vec4f(
    historyFlag(reflectionQualify(vec4u(5u, 8u, 2u, 1u), previous, surface, 0.0, normal, 0.08, config)),
    historyFlag(reflectionQualify(vec4u(5u, 8u, 2u, 1u), previous, surface, 3.0, vec3f(1.0, 0.0, 0.0), 0.08, config)),
    historyFlag(reflectionQualify(vec4u(5u, 8u, 2u, 1u), previous, surface, 3.0, normal, 0.2, config)),
    historyFlag(reflectionQualify(vec4u(5u, 8u, 2u, 1u), vec4f(1.0, 0.0, 0.0, 0.0), surface, 3.0, normal, 0.08, config)));
  golden[13] = vec4f(
    historyFlag(reflectionQualify(vec4u(3u, 6u, 2u, 1u), previous, surface, 3.0, normal, 0.08, config)),
    historyFlag(reflectionQualify(vec4u(1u, 8u, 2u, 1u), previous, surface, 3.0, normal, 0.08, config)),
    historyFlag(reflectionQualify(vec4u(0u, 8u, 2u, 1u), previous, surface, 3.0, normal, 0.08, config)),
    historyFlag(reflectionQualify(vec4u(6u, 8u, 2u, 1u), previous, surface, 3.0, normal, 0.08, config)));
  record(14u, reflectionAccumulateFresh(vec3f(1.0, 0.0, 0.0), 1u, vec3f(4.0), true, 0.0, 0.8));
}
`;
    const pipeline = await device.createComputePipelineAsync({ label: 'Reflection history golden cases', layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'validateReflectionHistory' } });
    const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }] });
    const encoder = device.createCommandEncoder(); const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, size); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1); const values = new Float32Array(readback.getMappedRange()).slice(); readback.unmap();
    // Closed-form expected output; no call to the CPU implementation under test.
    const expected = [[0.5, 0.8 / 1.8, 1 / 1.8, 1 / 9], [0, 240, 60, 0], [1, 0, 0, 1], [0, 0, 0, 5],
      [0.8, 0, 0, 3], [0.6, 0, 0, 3], [0, 0, 0, 5], [0, 0, 0, 2], [0, 0, 0, 4], [0.8, 0, 0, 3],
      [1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 1, 0], [1, 0, 0, 1]];
    let maxError = 0;
    for (const [record, vector] of expected.entries()) for (let axis = 0; axis < 4; axis++) {
      const actual = values[record * 4 + axis]!; const error = Math.abs(actual - vector[axis]!); maxError = Math.max(maxError, error);
      if (!Number.isFinite(actual) || error > 0.00001) throw new Error(`Reflection history golden case ${record}/${axis}: expected ${vector[axis]}, received ${actual}.`);
    }
    return { accumulationFrames: 240, singleSampleCases: 9, qualificationCases: 16, maxError,
      alternatingMean: values[0]!, alternatingRange: values[3]!, mixedSource: 3, completedMissSource: 5,
      limitation: 'Exact sample and qualification semantics only; no image-quality convergence claim.' };
  } finally { for (const resource of resources) resource.destroy(); }
}
