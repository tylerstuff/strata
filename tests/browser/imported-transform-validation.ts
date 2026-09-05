import { importedTransformShader } from '../../packages/core/src/imported/imported-transform.js';
import { importedTransformCases, degenerateTransformCases } from './imported-transform-cases.js';

const tolerance = 2e-5;
const inputFloats = 20;
const outputFloats = 8;

function require(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const probe = /* wgsl */ `
struct TransformProbeInput {
  column0: vec4f,
  column1: vec4f,
  column2: vec4f,
  normal: vec4f,
  tangent: vec4f,
};
@group(0) @binding(0) var<storage, read> transformInputs: array<TransformProbeInput>;
@group(0) @binding(1) var<storage, read_write> transformResults: array<vec4f>;
@compute @workgroup_size(32)
fn validateTransformFrame(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&transformInputs)) { return; }
  let q = transformInputs[id.x];
  let frame = importedTransformFrame(mat3x3f(q.column0.xyz, q.column1.xyz, q.column2.xyz), q.normal.xyz, q.tangent);
  transformResults[id.x * 2u] = vec4f(frame.normal, 1.0);
  transformResults[id.x * 2u + 1u] = frame.tangent;
}
`;

/** Execute the production WGSL helper; fixtures own the independent CPU oracle. */
export async function validateImportedTransforms(device: GPUDevice) {
  const cases = [...importedTransformCases, ...degenerateTransformCases];
  require(importedTransformCases.length > 0 && degenerateTransformCases.length > 0 && cases.length <= 256,
    'Transform probes require both oracle and collapsed cases, with at most 256 total inputs.');
  require(new Set(cases.map(value => value.name)).size === cases.length, 'Transform probe names must be unique.');
  const input = new Float32Array(cases.length * inputFloats);
  for (const [index, value] of cases.entries()) {
    require(value.matrix.length === 9 && value.normal.length === 3 && value.tangent.length === 4,
      `${value.name}: malformed transform fixture.`);
    // WGSL mat3 columns have vec4 alignment. Preserve the fixture's column-major
    // order; do not reuse production CPU transform/normalization helpers here.
    const offset = index * inputFloats;
    for (let column = 0; column < 3; column++) input.set(value.matrix.slice(column * 3, column * 3 + 3), offset + column * 4);
    input.set(value.normal, offset + 12);
    input.set(value.tangent, offset + 16);
    if (index < importedTransformCases.length) {
      require(!value.expectFiniteOnly && value.expectedNormal?.length === 3 && value.expectedTangent?.length === 4,
        `${value.name}: nonsingular transform needs an independent normal/tangent/sign oracle.`);
    } else require(value.expectFiniteOnly, `${value.name}: collapsed fixture must declare its finite-frame contract.`);
  }
  require(input.every(Number.isFinite), 'Transform input must remain finite after float32 packing.');

  const buffers: GPUBuffer[] = [];
  const createBuffer = (size: number, usage: number, label: string) => {
    const buffer = device.createBuffer({ size, usage, label });
    buffers.push(buffer);
    return buffer;
  };
  try {
    const source = createBuffer(input.byteLength, 0x80 | 0x8, 'Imported transform probe inputs');
    const outputBytes = cases.length * outputFloats * Float32Array.BYTES_PER_ELEMENT;
    const output = createBuffer(outputBytes, 0x80 | 0x4, 'Imported transform probe output');
    const readback = createBuffer(outputBytes, 0x1 | 0x8, 'Imported transform probe readback');
    const module = device.createShaderModule({ code: importedTransformShader + probe, label: 'Production imported transform numeric probe' });
    const pipeline = await device.createComputePipelineAsync({ label: 'Imported normal/tangent transform validation',
      layout: 'auto', compute: { module, entryPoint: 'validateTransformFrame' } });
    const binding = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: source } }, { binding: 1, resource: { buffer: output } },
    ] });
    device.queue.writeBuffer(source, 0, input);
    const encoder = device.createCommandEncoder({ label: 'Imported transform numeric readback' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, binding);
    pass.dispatchWorkgroups(Math.ceil(cases.length / 32)); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, outputBytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(0x1);
    const values = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    require(values.length === cases.length * outputFloats, 'Transform output has the wrong size.');

    let maxNormalError = 0, maxTangentError = 0, maxUnitError = 0, maxOrthogonalityError = 0;
    const results = cases.map((value, index) => {
      const offset = index * outputFloats;
      const normal = [...values.slice(offset, offset + 3)];
      const tangent = [...values.slice(offset + 4, offset + 8)];
      require([...normal, ...tangent].every(Number.isFinite), `${value.name}: non-finite GPU normal/tangent ${normal}; ${tangent}.`);
      require(values[offset + 3] === 1, `${value.name}: transform invocation did not write its completion marker.`);
      require(tangent[3] === 1 || tangent[3] === -1, `${value.name}: tangent handedness must be exactly +1 or -1.`);
      const normalUnitError = Math.abs(Math.hypot(...normal) - 1);
      const tangentUnitError = Math.abs(Math.hypot(...tangent.slice(0, 3)) - 1);
      const orthogonalityError = Math.abs(normal.reduce((sum, component, axis) => sum + component * tangent[axis]!, 0));
      const unitError = Math.max(normalUnitError, tangentUnitError);
      require(unitError <= tolerance && orthogonalityError <= tolerance,
        `${value.name}: GPU frame is not orthonormal: ${JSON.stringify({ normal, tangent, normalUnitError, tangentUnitError, orthogonalityError, tolerance })}`);
      maxUnitError = Math.max(maxUnitError, unitError);
      maxOrthogonalityError = Math.max(maxOrthogonalityError, orthogonalityError);
      if (index >= importedTransformCases.length) {
        return { name: value.name, contract: 'finite-orthonormal-fallback', normal, tangent, unitError, orthogonalityError };
      }
      require(!value.expectFiniteOnly, `${value.name}: missing independent oracle.`);
      const normalError = Math.max(...normal.map((component, axis) => Math.abs(component - value.expectedNormal[axis]!)));
      const tangentError = Math.max(...tangent.map((component, axis) => Math.abs(component - value.expectedTangent[axis]!)));
      require(normalError <= tolerance && tangentError <= tolerance,
        `${value.name}: production WGSL differs from the independent float32-input oracle: ${JSON.stringify({ normal, tangent,
          expectedNormal: value.expectedNormal, expectedTangent: value.expectedTangent, normalError, tangentError, tolerance })}`);
      maxNormalError = Math.max(maxNormalError, normalError);
      maxTangentError = Math.max(maxTangentError, tangentError);
      return { name: value.name, contract: 'independent-affine-oracle', normal, tangent, normalError, tangentError, unitError, orthogonalityError };
    });
    return { status: 'passed', caseCount: cases.length, oracleCases: importedTransformCases.length, collapsedCases: degenerateTransformCases.length,
      tolerance, maxNormalError, maxTangentError, maxUnitError, maxOrthogonalityError, results,
      scope: 'Production WGSL normal, tangent and handedness numeric checks with independent affine expectations; collapsed inputs require finite orthonormal output. Not a general animation, image or performance acceptance result.' };
  } finally {
    for (const buffer of buffers) {
      if (buffer.mapState === 'mapped') buffer.unmap();
      buffer.destroy();
    }
  }
}
