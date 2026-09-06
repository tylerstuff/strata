import { createMeshAsset } from '../../packages/core/src/meshes/mesh-asset.js';
import { ImportedRenderer } from '../../packages/core/src/imported/imported-renderer.js';
import { loadGltf } from '../../packages/core/src/imported/gltf-loader.js';
import { validateImportedEnvironment } from './imported-environment-validation.js';
import { validateImportedTransforms } from './imported-transform-validation.js';
import type { ImportedAsset, ImportedControls, ImportedImage, ImportedMaterial, ImportedPrimitive, ImportedVec3 } from '../../packages/core/src/imported/imported-types.js';
import type { RasterOutputs } from '../../packages/core/src/rendering/raster-types.js';

type Vec3 = ImportedVec3;
const size = 256;
const require = (value: unknown, message: string): void => { if (!value) throw new Error(message); };
const near = (actual: readonly number[], expected: readonly number[], tolerance: number, message: string): void => {
  require(actual.length === expected.length && actual.every((value, index) => Number.isFinite(value) && Math.abs(value - expected[index]!) <= tolerance),
    `${message}: actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}, tolerance ${tolerance}`);
};
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, scale: number): Vec3 => [a[0] * scale, a[1] * scale, a[2] * scale];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => mul(a, 1 / Math.hypot(...a));
const srgb = (byte: number) => byte / 255 <= 0.04045 ? byte / 255 / 12.92 : ((byte / 255 + 0.055) / 1.055) ** 2.4;
const sampler = { magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 } as const;
const camera = { eye: [0, 1, 4] as Vec3, target: [0, 1, 0] as Vec3, verticalFov: Math.PI / 3 };
const controls: ImportedControls = { camera, presentation: 'model-only', background: [0, 0, 0],
  lighting: { directionToLight: [0, 0, 1], color: [1, 1, 1], intensity: 0, ambient: [0, 0, 0] } };

function material(patch: Partial<ImportedMaterial> = {}): ImportedMaterial {
  return { name: 'Generated material', baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.5,
    emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1, occlusionStrength: 1,
    alphaMode: 'OPAQUE', alphaCutoff: 0.5, doubleSided: false, ...patch };
}
function quad(materialIndex = 0, z = 0, halfWidth = 1, low = 0, high = 2, color: readonly number[] = [1, 1, 1, 1], tangentSign = 1): ImportedPrimitive {
  const vertices = new Float32Array(64);
  [[-halfWidth, low, z, 0, 1], [halfWidth, low, z, 1, 1], [halfWidth, high, z, 1, 0], [-halfWidth, high, z, 0, 0]].forEach((p, index) => {
    vertices.set([p[0]!, p[1]!, p[2]!, 0, 0, 1, p[3]!, p[4]!, 1, 0, 0, tangentSign, ...color], index * 16);
  });
  return { name: 'Generated quad', vertices, indices: new Uint32Array([0, 1, 2, 0, 2, 3]), material: materialIndex };
}
function asset(primitives: readonly ImportedPrimitive[], materials: readonly ImportedMaterial[], images: readonly ImportedImage[] = [], maxTextureDimension = 64): ImportedAsset {
  const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
  for (const primitive of primitives) for (let offset = 0; offset < primitive.vertices.length; offset += 16) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis]!, primitive.vertices[offset + axis]!); max[axis] = Math.max(max[axis]!, primitive.vertices[offset + axis]!);
  }
  const bounds = { min: min as unknown as Vec3, max: max as unknown as Vec3 };
  return { version: 1, sourceUrl: `${location.origin}/__imported-fixtures__/generated`, primitives, materials, images,
    sourceBounds: bounds, bounds, normalization: { scale: 1, translation: [0, 0, 0] }, maxTextureDimension, warnings: [], clips: [],
    stats: { meshInstances: primitives.length, primitives: primitives.length, vertices: primitives.reduce((sum, p) => sum + p.vertices.length / 16, 0),
      triangles: primitives.reduce((sum, p) => sum + p.indices.length / 3, 0), materials: materials.length, images: images.length,
      encodedBytes: images.reduce((sum, image) => sum + image.bytes.byteLength, 0), geometryBytes: primitives.reduce((sum, p) => sum + p.vertices.byteLength + p.indices.byteLength, 0),
      skinnedMeshInstances: 0, animationClips: 0 } };
}
async function image(name: string, width: number, height: number): Promise<ImportedImage> {
  const response = await fetch(`/__imported-fixtures__/${name}.png`); require(response.ok, `Missing generated image ${name}`);
  return { name, mimeType: 'image/png', width, height, bytes: new Uint8Array(await response.arrayBuffer()) };
}
function pixel(world: Vec3, view = camera): readonly [number, number] {
  // Independent pinhole projection; no production matrix/projection helper.
  const forward = unit(sub(view.target, view.eye)); const right = unit(cross(forward, [0, 1, 0])); const up = cross(right, forward);
  const relative = sub(world, view.eye); const depth = dot(relative, forward); const scale = 1 / Math.tan(view.verticalFov / 2);
  return [Math.floor((dot(relative, right) * scale / depth + 1) * size / 2), Math.floor((1 - dot(relative, up) * scale / depth) * size / 2)];
}

const readShader = /* wgsl */ `
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var normals: texture_2d<f32>;
@group(0) @binding(2) var materials: texture_2d<f32>;
@group(0) @binding(3) var motions: texture_2d<f32>;
@group(0) @binding(4) var depths: texture_depth_2d;
@group(0) @binding(5) var<storage,read> points: array<vec4u>;
@group(0) @binding(6) var<storage,read_write> result: array<vec4f>;
@compute @workgroup_size(32) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=arrayLength(&points)){return;}
  let p=vec2i(points[id.x].xy);let start=id.x*5u;
  result[start]=textureLoad(hdr,p,0);result[start+1u]=textureLoad(normals,p,0);
  result[start+2u]=textureLoad(materials,p,0);result[start+3u]=textureLoad(motions,p,0);
  result[start+4u]=vec4f(textureLoad(depths,p,0),0.,0.,1.);
}`;
interface Sample { hdr: number[]; normal: number[]; material: number[]; motion: number[]; depth: number }
async function sample(device: GPUDevice, outputs: RasterOutputs, points: readonly (readonly [number, number])[]): Promise<Sample[]> {
  const buffers: GPUBuffer[] = [];
  try {
    const create = (bytes: number, usage: number) => { const value = device.createBuffer({ size: bytes, usage }); buffers.push(value); return value; };
    const positions = new Uint32Array(points.length * 4); points.forEach((p, index) => positions.set(p, index * 4));
    const input = create(positions.byteLength, 0x80 | 0x08); const output = create(points.length * 80, 0x80 | 0x04); const readback = create(points.length * 80, 0x01 | 0x08);
    device.queue.writeBuffer(input, 0, positions);
    const module = device.createShaderModule({ code: readShader }); const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const entries: GPUBindGroupEntry[] = [outputs.hdr, outputs.normal, outputs.material, outputs.motion, outputs.depth].map((resource, binding) => ({ binding, resource }));
    entries.push({ binding: 5, resource: { buffer: input } }, { binding: 6, resource: { buffer: output } });
    const encoder = device.createCommandEncoder(); const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
    pass.dispatchWorkgroups(Math.ceil(points.length / 32)); pass.end(); encoder.copyBufferToBuffer(output, 0, readback, 0, points.length * 80); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1); const values = new Float32Array(readback.getMappedRange().slice(0)); readback.unmap();
    return points.map((_, index) => { const start = index * 20; return { hdr: [...values.slice(start, start + 4)], normal: [...values.slice(start + 4, start + 8)],
      material: [...values.slice(start + 8, start + 12)], motion: [...values.slice(start + 12, start + 16)], depth: values[start + 16]! }; });
  } finally { for (const buffer of buffers) { if (buffer.mapState === 'mapped') buffer.unmap(); buffer.destroy(); } }
}

/** Tiny generated primitives exercise production imported shaders and real glTF loading. No gallery asset is used. */
export async function validateImportedRendering() {
  require(navigator.gpu, 'WebGPU is required for imported validation.'); const adapter = await navigator.gpu.requestAdapter(); require(adapter, 'No WebGPU adapter.');
  const device = await adapter!.requestDevice(); const errors: string[] = []; let destroying = false;
  const onError = (event: GPUUncapturedErrorEvent) => errors.push(event.error.message); device.addEventListener('uncapturederror', onError);
  void device.lost.then(info => { if (!destroying) errors.push(`Device lost: ${info.reason}: ${info.message}`); });
  const target = device.createTexture({ size: [size, size], format: 'rgba8unorm', usage: 0x10 }); const cases: unknown[] = [];
  async function render(input: ImportedAsset, settings: ImportedControls = controls, points: readonly (readonly [number, number])[] = [[128, 128]]) {
    const renderer = await ImportedRenderer.create(device, 'rgba8unorm', { renderer: 'imported', asset: input });
    try {
      const encoder = device.createCommandEncoder(); const stats = renderer.encode(encoder, target.createView(), size, size, 0, { temporal: false, imported: settings });
      device.queue.submit([encoder.finish()]); renderer.submitted(1); await device.queue.onSubmittedWorkDone();
      require(renderer.outputs, 'Imported renderer omitted shared outputs.'); const samples = await sample(device, renderer.outputs!, points);
      const telemetry = renderer.importedTelemetry; renderer.dispose(); require(renderer.gpuBufferBytes === 0 && renderer.gpuTextureBytes === 0, 'Imported renderer leaked owned allocation estimates.');
      return { samples, stats, telemetry };
    } finally { renderer.dispose(); }
  }
  try {
    cases.push({ name: 'normal-tangent-transform-numeric', ...await validateImportedTransforms(device) });
    const base = await image('base', 2, 2); const normal = await image('normal', 2, 2); const mask = await image('mask', 4, 4); const large = await image('large', 8, 4);
    const texture = (image: number) => ({ image, sampler });
    const color = [0.8, 0.5, 1, 0.95];
    const textured = material({ baseColorFactor: [0.5, 0.75, 0.25, 0.9], baseColorTexture: texture(0), metallicRoughnessTexture: texture(0),
      metallicFactor: 0.6, roughnessFactor: 0.8, emissiveTexture: texture(0), emissiveFactor: [0.3, 0.2, 0.1], emissiveStrength: 2,
      alphaMode: 'MASK', alphaCutoff: 0.4 });
    const colors = await render(asset([quad(0, 0, 1, 0, 2, color)], [textured], [base])); const c = colors.samples[0]!;
    near(c.material, [srgb(128) * 0.5 * 0.8, srgb(64) * 0.75 * 0.5, srgb(192) * 0.25, 192 / 255 * 0.6], 1.1 / 255, 'Base sRGB/factors/linear vertex color and linear metallic B');
    near([c.normal[3]!], [64 / 255 * 0.8], 0.001, 'Roughness uses linear G');
    near(c.hdr.slice(0, 3), [srgb(128) * 0.6, srgb(64) * 0.4, srgb(192) * 0.2], 0.001, 'Emission sRGB factor/strength; no alpha premultiplication');
    require(colors.telemetry.textures.length === 2 && ['srgb', 'linear'].every(role => colors.telemetry.textures.some(t => t.image === 0 && t.colorSpace === role && t.mipLevels === 2 && t.gpuBytes === 20)),
      'One source image used for color and data needs separate reported color-space resources with complete mip chains.');
    require(c.depth < 1, 'Alpha128 with independent factor and cutoff must survive.'); cases.push({ name: 'texture-color-spaces-and-factors', ...colors });

    const uvImage = await image('uv', 2, 2);
    const uv = await render(asset([quad()], [material({ unlit: true, baseColorTexture: texture(0) })], [uvImage]), controls,
      [pixel([-0.5, 1.5, 0]), pixel([0.5, 1.5, 0]), pixel([-0.5, 0.5, 0]), pixel([0.5, 0.5, 0])]);
    const uvExpected = [[192, 32, 16], [16, 160, 32], [32, 16, 192], [160, 128, 16]];
    uv.samples.forEach((value, index) => near(value.hdr.slice(0, 3), uvExpected[index]!.map(srgb), 0.001, 'glTF UV0 top-left image origin and channel order'));
    cases.push({ name: 'uv-image-orientation', ...uv });

    const unlitMaterial = material({ ...textured, unlit: true, metallicFactor: 1, roughnessFactor: 1, occlusionTexture: texture(0),
      normalTexture: texture(1), emissiveFactor: [1, 0.5, 0.25], emissiveStrength: 64 });
    const unlitAsset = asset([quad(0, 0, 1, 0, 2, color)], [unlitMaterial], [base, normal]);
    const unlitDark = await render(unlitAsset); const unlitBright = await render(unlitAsset, { ...controls,
      lighting: { directionToLight: [0, 0, 1], color: [1, 0.5, 0.25], intensity: 8, ambient: [1, 1, 1] } });
    const baseExpected = [srgb(128) * 0.5 * 0.8, srgb(64) * 0.75 * 0.5, srgb(192) * 0.25];
    near(unlitDark.samples[0]!.hdr.slice(0, 3), baseExpected, 0.001, 'Unlit output is texture times base factor times linear vertex color');
    near(unlitBright.samples[0]!.hdr.slice(0, 3), baseExpected, 0.001, 'Unlit output ignores lighting, AO, normal maps and emission');
    cases.push({ name: 'unlit-invariance', dark: unlitDark, bright: unlitBright });

    const environmentLight = { ...controls.lighting!, environment: { preset: 'studio' as const, intensity: 1 } };
    const authoredEnvironment = await render(unlitAsset, { ...controls, lighting: environmentLight });
    near(authoredEnvironment.samples[0]!.hdr.slice(0, 3), baseExpected, .001, 'Authored unlit ignores distant environment illumination');
    const relitDark = await render(unlitAsset, { ...controls, shading: 'relit' });
    near(relitDark.samples[0]!.hdr.slice(0, 3), [0, 0, 0], .0001, 'Relit unlit ignores emission and respects darkness');
    const relit = await render(unlitAsset, { ...controls, shading: 'relit', lighting: { ...controls.lighting!, intensity: 2 } });
    const relitExpected = baseExpected.map(value => ((1 - .04) * value / Math.PI + .04 / (4 * Math.PI * .65 ** 4)) * 2);
    near(relit.samples[0]!.hdr.slice(0, 3), relitExpected, .003, 'Relit matte dielectric follows independent direct GGX');
    near(relit.samples[0]!.normal, [0, 0, 1, .65], .001, 'Relit uses the geometric normal and explicit roughness');
    near([relit.samples[0]!.material[3]!], [0], .0001, 'Relit uses nonmetallic dielectric');
    require(unlitAsset.materials[0]!.unlit === true && unlitAsset.materials[0]!.metallicFactor === 1, 'Relighting must not mutate caller-owned material data.');
    const pbrInvariantAsset = asset([quad()], [material({ baseColorFactor: [.3, .5, .7, 1], roughnessFactor: .5, metallicFactor: .8 })]);
    const pbrAuthored = await render(pbrInvariantAsset, { ...controls, lighting: environmentLight });
    const pbrRelit = await render(pbrInvariantAsset, { ...controls, shading: 'relit', lighting: environmentLight });
    near(pbrAuthored.samples[0]!.hdr, pbrRelit.samples[0]!.hdr, 0, 'Relit mode leaves source PBR unchanged');
    require(pbrAuthored.samples[0]!.hdr.slice(0, 3).some(value => value > .01), 'Distant environment must illuminate a metal without direct light.');
    cases.push({ name: 'authored-relit-environment', authoredEnvironment, relitDark, relit, pbrAuthored, pbrRelit });
    cases.push({ name: 'environment-numeric', ...await validateImportedEnvironment(device) });

    const pbrBase = [0.25, 0.5, 0.75] as const; const metallic = 0.4; const roughness = 0.5;
    const pbr = await render(asset([quad()], [material({ baseColorFactor: [...pbrBase, 1], metallicFactor: metallic, roughnessFactor: roughness })]),
      { ...controls, lighting: { directionToLight: [0, 0, 1], color: [1, 0.8, 0.6], intensity: 2, ambient: [0, 0, 0] } });
    // Independent normal-incidence GGX/Schlick closed form; center-pixel view offset
    // is <.003 radians, accounted for by the declared .003 absolute tolerance.
    const pbrExpected = pbrBase.map((base, index) => {
      const fresnel = 0.04 * (1 - metallic) + base * metallic;
      return ((1 - fresnel) * (1 - metallic) * base / Math.PI + fresnel / (4 * Math.PI * roughness ** 4)) * [2, 1.6, 1.2][index]!;
    });
    near(pbr.samples[0]!.hdr.slice(0, 3), pbrExpected, 0.003, 'Textured PBR path preserves GGX direct-light normalization'); cases.push({ name: 'direct-pbr', ...pbr });

    const aoMaterial = material({ baseColorFactor: [0.25, 0.5, 0.75, 1], emissiveFactor: [0.1, 0.2, 0.3], occlusionTexture: texture(0), occlusionStrength: 0.75 });
    const aoLight = { directionToLight: [0, 0, 1] as Vec3, color: [1, 1, 1] as Vec3, intensity: 0, ambient: [0.2, 0.3, 0.4] as Vec3 };
    const ao = await render(asset([quad()], [aoMaterial], [base]), { ...controls, lighting: aoLight });
    const aoFactor = 1 + 0.75 * (128 / 255 - 1);
    near(ao.samples[0]!.hdr.slice(0, 3), pbrBase.map((base, index) => [0.1, 0.2, 0.3][index]! + base * aoLight.ambient[index]! * aoFactor), 0.001, 'AO attenuates ambient fill, not emission');
    const aoDirect = await render(asset([quad()], [aoMaterial], [base]), { ...controls, lighting: { ...aoLight, intensity: 1, ambient: [0, 0, 0] } });
    const noAoDirect = await render(asset([quad()], [material({ ...aoMaterial, occlusionStrength: 0 })], [base]), { ...controls, lighting: { ...aoLight, intensity: 1, ambient: [0, 0, 0] } });
    near(aoDirect.samples[0]!.hdr, noAoDirect.samples[0]!.hdr, 0.001, 'AO leaves direct lighting and emission unchanged');
    cases.push({ name: 'ambient-only-occlusion', ao, aoDirect, noAoDirect });

    for (const backside of [false, true]) for (const sign of [1, -1]) {
      const view = backside ? { ...camera, eye: [0, 1, -4] as Vec3 } : camera;
      const result = await render(asset([quad(0, 0, 1, 0, 2, [1, 1, 1, 1], sign)], [material({ normalTexture: texture(0), normalScale: 0.5, doubleSided: true })], [normal]), { ...controls, camera: view });
      const tangentNormal = unit([(191 / 255 * 2 - 1) * 0.5, (191 / 255 * 2 - 1) * 0.5 * sign, 218 / 255 * 2 - 1]);
      near(result.samples[0]!.normal.slice(0, 3), mul(tangentNormal, backside ? -1 : 1), 0.003, 'Linear normal map, scale, tangent handedness and double-sided normal reversal');
      cases.push({ name: `normal-map-${backside ? 'back' : 'front'}-${sign}`, ...result });
    }
    const culled = await render(asset([quad()], [material()]), { ...controls, camera: { ...camera, eye: [0, 1, -4] } });
    require(culled.samples[0]!.depth === 1, 'Single-sided back face must be culled.'); cases.push({ name: 'single-sided-culling', ...culled });

    const shadow = await render(asset([quad(0), quad(1, 0.5, 0.7, 0.3, 1.7)], [material(), material({ baseColorFactor: [0.1, 0.8, 0.2, 0.5], baseColorTexture: texture(0), alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true })], [mask]),
      { ...controls, lighting: { ...controls.lighting!, directionToLight: unit([1, 0, 1]), intensity: 1 } }, [pixel([-0.65, 1, 0]), pixel([-0.25, 1, 0]), pixel([0.35, 1, 0.5])]);
    near(shadow.samples.slice(0, 2).map(s => s.motion[2]!), [4, 4], 0.005, 'MASK holes leave receiver depth in the raster pass');
    require(shadow.samples[0]!.hdr[3]! > 0.9 && shadow.samples[1]!.hdr[3]! < 0.1, 'MASK shadow must transmit the transparent half and block the opaque half.');
    near([shadow.samples[2]!.motion[2]!], [3.5], 0.005, 'MASK alpha equal to cutoff survives as opaque.'); cases.push({ name: 'mask-matches-shadow', ...shadow });

    for (const mirrored of [false, true]) {
      const loaded = await loadGltf(`${location.origin}/__imported-fixtures__/${mirrored ? 'mirrored' : 'affine'}.gltf`);
      // Child rotationY(45deg), parent scale(±2,1,.5). The transformed triangle-edge
      // cross product yields the inverse-transpose normal independently of loader math.
      const transformedX: Vec3 = [(mirrored ? -2 : 2) / Math.SQRT2, 0, -0.5 / Math.SQRT2];
      const expected = mul(unit(cross(transformedX, [0, 1, 0])), mirrored ? -1 : 1);
      const center: Vec3 = [0, (loaded.bounds.min[1] + loaded.bounds.max[1]) / 2, 0];
      const result = await render(loaded, { ...controls, camera: { ...camera, eye: add(center, mul(expected, 4)), target: center } });
      require(result.samples[0]!.depth < 1, 'Affine/mirrored glTF front face disappeared.'); near(result.samples[0]!.normal.slice(0, 3), expected, 0.002, 'Inverse-transpose affine glTF normal');
      cases.push({ name: mirrored ? 'gltf-negative-determinant' : 'gltf-affine-normal', ...result });
    }

    // Exercise the real rigid and skin entry points, not only the compute probe.
    // Large local coordinates keep the projected quad visible while the palette
    // retains a 1e-5 scale, where the former cofactor cutoff lost its rotation.
    const smallScale = Math.fround(1e-5), smallRotation = Math.fround(smallScale / Math.SQRT2);
    const smallMatrix = new Float32Array([
      smallRotation, 0, -smallRotation, 0, 0, smallScale, 0, 0,
      smallRotation, 0, smallRotation, 0, 0, 1, 0, 1,
    ]);
    for (const mode of ['rigid', 'skin'] as const) {
      const localQuad = quad(0, 0, 100_000, -100_000, 100_000);
      const worldVertices = localQuad.vertices.slice();
      for (let offset = 0; offset < worldVertices.length; offset += 16) {
        const x = localQuad.vertices[offset]!, y = localQuad.vertices[offset + 1]!, z = localQuad.vertices[offset + 2]!;
        // Independent transformed positions; the normal oracle below uses
        // triangle edges, never the production cofactor or pose evaluator.
        worldVertices.set([smallRotation * (x + z), 1 + smallScale * y, smallRotation * (z - x)], offset);
      }
      const point = (vertex: number): Vec3 => [worldVertices[vertex * 16]!, worldVertices[vertex * 16 + 1]!, worldVertices[vertex * 16 + 2]!];
      const edge = sub(point(1), point(0));
      const expectedNormal = unit(cross(edge, sub(point(2), point(0))));
      const expectedTangent = unit(edge);
      for (let offset = 0; offset < worldVertices.length; offset += 16) {
        worldVertices.set(expectedNormal, offset + 3); worldVertices.set([...expectedTangent, 1], offset + 8);
      }
      const oneHotJoints = new Uint32Array(16), oneHotWeights = new Float32Array(16);
      for (let vertex = 0; vertex < 4; vertex++) oneHotWeights[vertex * 4] = 1;
      const primitive: ImportedPrimitive = { ...localQuad, name: `Generated small ${mode} transform`, vertices: worldVertices,
        deformation: { node: 0, vertices: localQuad.vertices,
          ...(mode === 'skin' ? { skin: 0, joints: oneHotJoints, weights: oneHotWeights } : {}) } };
      const base = asset([primitive], [material()]);
      const input: ImportedAsset = { ...base, rig: {
        nodes: [{ parent: null, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], matrix: smallMatrix }],
        skins: mode === 'skin' ? [{ joints: [0], inverseBindMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }] : [],
      }, stats: { ...base.stats, skinnedMeshInstances: Number(mode === 'skin') } };
      const interiorPixel = pixel([0, 1, 0]);
      const result = await render(input, controls, [interiorPixel]);
      require(result.samples[0]!.depth < 1, `Small ${mode} transform must cover the known interior pixel.`);
      near(result.samples[0]!.normal.slice(0, 3), expectedNormal, 0.002, `Small ${mode} vertex path must preserve the rotated geometric normal`);
      cases.push({ name: `small-${mode}-transform-gbuffer-normal`, matrix: [...smallMatrix], localHalfExtent: 100_000,
        interiorPixel, expectedNormal, ...result });
    }

    // Palette index162 is deliberately used: a64-joint uniform palette cannot
    // accidentally pass. Joints and mesh are on separate hierarchy branches.
    const local = quad(1, 0, 0.5, 0.5, 1.5);
    for (let index = 0; index < local.vertices.length; index += 16) {
      local.vertices[index + 2] = local.vertices[index]! * 0.5;
      local.vertices.set(unit([-0.5, 0, 1]), index + 3); local.vertices.set([...unit([1, 0, 0.5]), 1], index + 8);
    }
    const joints = new Uint32Array(16); const weights = new Float32Array(16);
    for (let index = 0; index < 4; index++) { joints[index * 4] = 162; weights[index * 4] = 1; }
    const inverseBind = new Float32Array(163 * 16);
    for (let joint = 0; joint < 163; joint++) for (const diagonal of [0, 5, 10, 15]) inverseBind[joint * 16 + diagonal] = 1;
    const identityNode = (parent: number | null) => ({ parent, translation: [0, 0, 0] as Vec3, rotation: [0, 0, 0, 1] as const, scale: [1, 1, 1] as Vec3 });
    const nodes = Array.from({ length: 165 }, (_, index) => identityNode(index === 0 || index === 163 ? null : index === 164 ? 163 : 0));
    nodes[163] = { ...nodes[163]!, translation: [4, 0, 0] }; nodes[164] = { ...nodes[164]!, translation: [2, 0, 0] };
    const skinBase = asset([quad(0, -0.5), { ...local, deformation: { node: 164, skin: 0, vertices: local.vertices.slice(), joints, weights } }], [material(), material({ baseColorFactor: [0.2, 0.8, 0.3, 1] })]);
    const skinAsset: ImportedAsset = { ...skinBase, rig: { nodes, skins: [{ joints: Array.from({ length: 163 }, (_, index) => index), inverseBindMatrices: inverseBind }] },
      clips: [{ id: 'generated-scale', name: 'Known one-hot scale and translation', duration: 0.125, channels: [
        { node: 162, path: 'scale', interpolation: 'LINEAR', times: new Float32Array([0, 0.125]), values: new Float32Array([1, 1, 1, 1.25, 0.75, 1.5]) },
        { node: 162, path: 'translation', interpolation: 'LINEAR', times: new Float32Array([0, 0.125]), values: new Float32Array([0, 0, 0, 0, 0, 0.25]) },
      ] }], stats: { ...skinBase.stats, skinnedMeshInstances: 1, animationClips: 1 } };
    const skinRenderer = await ImportedRenderer.create(device, 'rgba8unorm', { renderer: 'imported', asset: skinAsset });
    try {
      const skinFrames = [];
      // Remain below the public >.25-second seek cut so the motion oracle really
      // checks previous-pose reconstruction, rather than reset-to-current motion.
      const skinControls = (phase: number): ImportedControls => ({ ...controls, animation: { clipId: 'generated-scale', timeSeconds: phase * 0.125, loop: false },
        lighting: { ...controls.lighting!, directionToLight: unit([1, 0, 1]), intensity: 1 } });
      for (let phase = 0; phase < 2; phase++) {
        const encoder = device.createCommandEncoder(); const stats = skinRenderer.encode(encoder, target.createView(), size, size, phase / 60, { temporal: false, imported: skinControls(phase) });
        device.queue.submit([encoder.finish()]); skinRenderer.submitted(phase + 1); await device.queue.onSubmittedWorkDone();
        const samples = await sample(device, skinRenderer.outputs!, [[128, 128], pixel([-0.9, 1, -0.5])]);
        const n = unit(phase ? [-0.5 / 1.25, 0, 1 / 1.5] : [-0.5, 0, 1]);
        near(samples[0]!.normal.slice(0, 3), n, 0.002, '163-joint animated inverse-transpose normal');
        const slope = phase ? 0.6 : 0.5; const translation = phase ? 0.25 : 0;
        const rayX = (128.5 / size * 2 - 1) * Math.tan(camera.verticalFov / 2);
        const z = (4 * slope * rayX + translation) / (1 + slope * rayX);
        near([samples[0]!.motion[2]!], [4 - z], 0.005, '163-joint palette deforms rendered depth without double mesh-parent transform');
        if (phase === 1) {
          const worldX = (4 - z) * rayX; const worldY = 1 - (4 - z) * rayX;
          const old: Vec3 = [worldX / 1.25, worldY / 0.75, worldX / 1.25 * 0.5];
          const oldDepth = 4 - old[2]; const oldUv = [0.5 + old[0] / oldDepth / Math.tan(camera.verticalFov / 2) / 2,
            0.5 - (old[1] - 1) / oldDepth / Math.tan(camera.verticalFov / 2) / 2];
          near(samples[0]!.motion.slice(0, 2), oldUv.map(value => value - 128.5 / size), 0.002, 'Animated motion references the previously submitted skin pose');
          near([samples[0]!.motion[3]!], [oldDepth], 0.005, 'Animated expected-prior depth');
        }
        require(phase ? samples[1]!.hdr[3]! < 0.1 : samples[1]!.hdr[3]! > 0.9, 'Animated skinned caster must move its shadow onto the fixed receiver witness.');
        skinFrames.push({ phase, stats, samples, telemetry: skinRenderer.importedTelemetry });
      }
      // An application palette must produce the same independently checked
      // depth, normal, shadow and prior-pose motion as the known affine case.
      const application = await ImportedRenderer.create(device, 'rgba8unorm', { renderer: 'imported',
        asset: createMeshAsset({ meshes: [quad(0, -0.5), local], materials: skinBase.materials }) });
      try {
        const frames = [];
        for (let phase = 0; phase < 2; phase++) {
          const transforms = new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1,
            phase ? 1.25 : 1,0,0,0,0,phase ? .75 : 1,0,0,0,0,phase ? 1.5 : 1,0,0,0,phase ? .25 : 0,1]);
          const { animation: _animation, ...lighting } = skinControls(phase);
          const encoder = device.createCommandEncoder();
          const stats = application.encode(encoder, target.createView(), size, size, phase/60, { temporal: false, imported: { ...lighting, transforms } });
          device.queue.submit([encoder.finish()]); application.submitted(phase+1); await device.queue.onSubmittedWorkDone();
          const samples = await sample(device, application.outputs!, [[128,128], pixel([-.9,1,-.5])]);
          for (let i = 0; i < samples.length; i++) {
            for (const field of ['normal', 'motion', 'hdr'] as const) near(samples[i]![field], skinFrames[phase]!.samples[i]![field], .003, 'Application world palette '+field);
            near([samples[i]!.depth], [skinFrames[phase]!.samples[i]!.depth], .001, 'Application world depth');
          }
          frames.push({ phase, stats, samples });
        }
        cases.push({ name: 'application-mesh-palette-shared-normal-depth-shadow-motion', frames });
      } finally { application.dispose(); }
      const cancelled = device.createCommandEncoder(); skinRenderer.encode(cancelled, target.createView(), size, size, 2 / 60, { temporal: false, imported: skinControls(0.5) }); skinRenderer.cancelFrame();
      const retry = device.createCommandEncoder(); skinRenderer.encode(retry, target.createView(), size, size, 2 / 60, { temporal: false, imported: skinControls(1) });
      device.queue.submit([retry.finish()]); skinRenderer.submitted(3); await device.queue.onSubmittedWorkDone();
      const retried = await sample(device, skinRenderer.outputs!, [[128, 128]]);
      near(retried[0]!.motion.slice(0, 2), [0, 0], 0.002, 'Cancelled encode forces safe current-pose history invalidation on retry');
      cases.push({ name: '163-joint-animation-depth-shadow-motion-cancel', skinFrames, retried });
    } finally { skinRenderer.dispose(); }

    const capped = await render(asset([quad()], [material({ baseColorTexture: texture(0) })], [large], 2));
    require(capped.telemetry.textures.length > 0 && capped.telemetry.textures.every(t => t.sourceWidth === 8 && t.sourceHeight === 4 && t.uploadWidth === 2 && t.uploadHeight === 1 && t.mipLevels === 2 && t.gpuBytes === 12), 'Texture cap/report must preserve8:4 aspect while reporting2:1 upload and complete mip bytes.');
    cases.push({ name: 'texture-cap-report', ...capped });
    await device.queue.onSubmittedWorkDone(); require(errors.length === 0, `Imported GPU errors: ${errors.join('; ')}`);
    return { status: 'passed', size, cases, gpuErrors: errors, adapter: { vendor: adapter!.info.vendor, architecture: adapter!.info.architecture,
      device: adapter!.info.device, description: adapter!.info.description, isFallbackAdapter: adapter!.info.isFallbackAdapter ?? null },
      scope: 'Generated material/affine and one-hot163-joint fixtures, plus production WGSL normal/tangent numerical transforms; raw linear MRT/depth checks, not general animation or visual/performance acceptance.' };
  } finally { target.destroy(); destroying = true; device.removeEventListener('uncapturederror', onError); device.destroy(); }
}

/** This separate entry uses the built public package rather than the direct renderer test imports. */
export async function validateImportedPublicLifecycle() {
  const entry = '/packages/core/dist/index.js'; const { createEngine } = await import(/* @vite-ignore */ entry);
  const canvas = document.createElement('canvas'); document.body.append(canvas); const engine = await createEngine({ canvas });
  const input = asset([quad()], [material({ emissiveFactor: [0.5, 0.2, 0.1] })]); const stages = [];
  const loadingStage = async (name: string) => {
    const hook = (globalThis as typeof globalThis & { __strataImportedStage?: (name: string) => Promise<void> }).__strataImportedStage;
    if (hook) await hook(name);
  };
  try {
    engine.resize(256, 256); engine.render(); await engine.waitForIdle(); stages.push({ name: 'empty', telemetry: engine.getTelemetry() }); await loadingStage('empty');
    for (let cycle = 0; cycle < 2; cycle++) {
      await engine.setScene({ renderer: 'imported', asset: input }); engine.render({ timeSeconds: 0, temporal: false, imported: controls }); await engine.waitForIdle();
      stages.push({ name: `imported-${cycle}`, telemetry: engine.getTelemetry() });
      if (cycle === 0) await loadingStage('imported');
      engine.resize(cycle ? 192 : 128, cycle ? 128 : 192); engine.render({ timeSeconds: 1 / 60, temporal: true, imported: controls }); await engine.waitForIdle();
      await engine.setScene({ renderer: 'diffuse', instanceCount: 1 }); engine.render(); await engine.waitForIdle(); stages.push({ name: `retired-${cycle}`, telemetry: engine.getTelemetry() });
    }
    const aborted = new AbortController(); aborted.abort(); let rejection = '';
    try { await engine.setScene({ renderer: 'imported', asset: input, signal: aborted.signal }); } catch (error) { rejection = String((error as { code?: string }).code ?? error); }
    require(rejection === 'SCENE_LOAD_ABORTED', 'Pre-aborted imported creation must reject with SCENE_LOAD_ABORTED.'); engine.render(); await engine.waitForIdle();
    require(engine.getTelemetry().imported === undefined, 'Aborted creation replaced the active diffuse scene.');

    // Hold a real decoded bitmap across supersession. This exercises late GPU
    // creation cleanup in the public package without relying on request timing.
    const lateImage = await image('base', 2, 2);
    const lateAsset = asset([quad()], [material({ baseColorTexture: { image: 0, sampler } })], [lateImage]);
    const beforeLate = engine.getTelemetry(); const originalBitmap = globalThis.createImageBitmap;
    let releaseBitmap!: () => void; let enteredBitmap!: () => void; let closedBitmap!: () => void;
    const released = new Promise<void>(resolve => { releaseBitmap = resolve; });
    const entered = new Promise<void>(resolve => { enteredBitmap = resolve; });
    const closed = new Promise<void>(resolve => { closedBitmap = resolve; });
    globalThis.createImageBitmap = (async (source: ImageBitmapSource, options?: ImageBitmapOptions) => {
      const bitmap = await originalBitmap(source, options); const close = bitmap.close.bind(bitmap);
      bitmap.close = () => { close(); closedBitmap(); };
      enteredBitmap(); await released; return bitmap;
    }) as typeof createImageBitmap;
    let lateRejection = '';
    try {
      const pending = engine.setScene({ renderer: 'imported', asset: lateAsset }).then(() => { throw new Error('Superseded imported creation unexpectedly committed.'); },
        (error: { code?: string }) => { lateRejection = String(error.code ?? error); });
      await Promise.race([entered, pending.then(() => { throw new Error(`Imported creation ended before the held bitmap: ${lateRejection}`); })]);
      await engine.setScene({ renderer: 'diffuse', instanceCount: 1 });
      releaseBitmap(); await pending; await closed;
      // Match the already-rendered baseline: a new diffuse scene allocates its
      // depth target on first render. The prompt abort receipt precedes late cleanup.
      engine.render(); await engine.waitForIdle();
      require(lateRejection === 'SCENE_LOAD_SUPERSEDED', 'Late decoded-image creation must reject as superseded.');
      const afterLate = engine.getTelemetry();
      require(afterLate.imported === undefined && afterLate.allocatedGpuBufferBytes === beforeLate.allocatedGpuBufferBytes
        && afterLate.allocatedGpuTextureBytes === beforeLate.allocatedGpuTextureBytes, 'Superseded imported resources survived late cleanup.');
      stages.push({ name: 'late-decode-superseded', telemetry: afterLate });
    } finally { releaseBitmap(); globalThis.createImageBitmap = originalBitmap; }
    engine.dispose(); const disposed = engine.getTelemetry();
    require(disposed.allocatedGpuBufferBytes === 0 && disposed.allocatedGpuTextureBytes === 0 && disposed.wasmMemoryBytes === 0, 'Public imported lifecycle leaked allocation estimates.');
    require(stages.every(stage => stage.telemetry.gpuErrorCount === 0) && disposed.gpuErrorCount === 0, 'Public imported lifecycle recorded GPU errors.');
    return { status: 'passed', stages, rejection, lateRejection, disposed };
  } finally { engine.dispose(); canvas.remove(); }
}
