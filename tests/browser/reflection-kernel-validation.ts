import { reflectionDirectionShader } from '../../packages/core/src/reflections/reflection-shaders.js';
import { sampleReflectionDirection } from '../../packages/core/src/reflections/reflection-reference.js';
import type { ReflectionVector } from '../../packages/core/src/reflections/reflection-reference.js';

/** Optional diagnostic called with the caller's WebGPU device; no renderer or browser lifecycle ownership. */
export async function runReflectionKernelValidation(device: GPUDevice): Promise<{ sampleCount: number; maxDirectionError: number; maxWeightError: number; maxLengthError: number }> {
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
    readback.unmap(); return { sampleCount: cases.length, maxDirectionError, maxWeightError, maxLengthError };
  } finally { for (const resource of resources) resource.destroy(); }
}
