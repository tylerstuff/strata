import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const transform = (translation = [0, 0, 0]) => ({ translation, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

function geometry() {
  // Four vertices per outward-facing cube face retain hard normals and UV seams.
  const faces = [
    { normal: [1, 0, 0], points: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
    { normal: [-1, 0, 0], points: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
    { normal: [0, 1, 0], points: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
    { normal: [0, -1, 0], points: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
    { normal: [0, 0, 1], points: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { normal: [0, 0, -1], points: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  ];
  const positions = [], normals = [], uvs = [], joints = [], weights = [], indices = [];
  for (const [faceIndex, face] of faces.entries()) {
    for (const point of face.points) {
      positions.push(...point.map(value => value * 0.5));
      normals.push(...face.normal);
      joints.push(point[1] > 0 ? 1 : 0, 0, 0, 0);
      weights.push(1, 0, 0, 0);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(...[0, 1, 2, 0, 2, 3].map(index => faceIndex * 4 + index));
  }
  const upperInverseBind = [...identity];
  upperInverseBind[13] = -0.5;
  const chunks = [], bufferViews = [], accessors = [];
  let byteLength = 0;
  const add = (values, type, componentType, target, bounds = {}) => {
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const bytes = componentType === 5123 ? 2 : 4;
    const padding = (4 - byteLength % 4) % 4;
    if (padding) { chunks.push(Buffer.alloc(padding)); byteLength += padding; }
    const chunk = Buffer.alloc(values.length * bytes);
    values.forEach((value, index) => {
      if (componentType === 5123) chunk.writeUInt16LE(value, index * bytes);
      else chunk.writeFloatLE(value, index * bytes);
    });
    const bufferView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: chunk.length, ...(target ? { target } : {}) });
    accessors.push({ bufferView, byteOffset: 0, componentType, count: values.length / components, type, ...bounds });
    chunks.push(chunk);
    byteLength += chunk.length;
    return accessors.length - 1;
  };
  const attributes = {
    POSITION: add(positions, 'VEC3', 5126, 34962, { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }),
    NORMAL: add(normals, 'VEC3', 5126, 34962),
    TEXCOORD_0: add(uvs, 'VEC2', 5126, 34962),
    JOINTS_0: add(joints, 'VEC4', 5123, 34962),
    WEIGHTS_0: add(weights, 'VEC4', 5126, 34962),
  };
  const indexAccessor = add(indices, 'SCALAR', 5123, 34963);
  const inverseBindMatrices = add([...identity, ...upperInverseBind], 'MAT4', 5126);
  const input = add([0, 0.5, 1], 'SCALAR', 5126, undefined, { min: [0], max: [1] });
  const output = add([0, 0.5, 0, 0.6, 0.8, 0, 0, 0.5, 0], 'VEC3', 5126);
  return { bytes: Buffer.concat(chunks), bufferViews, accessors, attributes, indexAccessor, inverseBindMatrices, input, output };
}

function model(data, color, name) {
  return {
    asset: { version: '2.0', generator: 'Strata procedural gallery fixture', extras: { source: { kind: 'procedural-box-skin-v1' } } },
    scene: 0,
    scenes: [{ name: 'Generated gallery fixture', nodes: [0, 1] }],
    nodes: [
      { name: 'FixtureRoot', ...transform(), children: [2] },
      { name: 'Box', ...transform(), mesh: 0, skin: 0 },
      { name: 'LowerJoint', ...transform(), children: [3] },
      { name: 'UpperJoint', ...transform([0, 0.5, 0]) },
    ],
    buffers: [{ uri: 'scene.bin', byteLength: data.bytes.length }],
    bufferViews: data.bufferViews,
    accessors: data.accessors,
    meshes: [{ name: 'Procedural cube', primitives: [{ attributes: data.attributes, indices: data.indexAccessor, material: 0, mode: 4 }] }],
    materials: [{ name, alphaMode: 'OPAQUE', pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: 0.65 } }],
    skins: [{ name: 'Two-joint box', skeleton: 2, joints: [2, 3], inverseBindMatrices: data.inverseBindMatrices }],
    animations: [{ name: 'Shift', samplers: [{ input: data.input, output: data.output, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 3, path: 'translation' } }] }],
  };
}

const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** Generate only procedural CI data in a dedicated temporary directory. The caller owns disposal. */
export async function createGalleryFixture() {
  const temporaryRoot = await fs.realpath(tmpdir());
  const withinRepository = relative(repository, temporaryRoot);
  if (!withinRepository || (withinRepository !== '..' && !withinRepository.startsWith(`..${sep}`) && !isAbsolute(withinRepository))) {
    throw new Error('Gallery fixtures require a temporary directory outside the repository.');
  }
  const directory = await fs.mkdtemp(join(temporaryRoot, 'strata-gallery-fixture-'));
  let disposal;
  const dispose = () => disposal ??= fs.rm(directory, { recursive: true, force: true });
  try {
    const data = geometry();
    const variants = [
      { id: 'fixture-red', path: 'red.gltf', title: 'Generated red box', color: [0.85, 0.06, 0.04, 1] },
      { id: 'fixture-green', path: 'green.gltf', title: 'Generated green box', color: [0.04, 0.8, 0.12, 1] },
    ];
    const catalog = {
      source: { kind: 'procedural-box-skin-v1', generated: true },
      assets: variants.map(variant => ({
        id: variant.id, title: variant.title, category: 'Procedural CI fixture',
        benchmark_use: 'Generated color selection and two-joint animation correctness checks; not performance evidence.',
        archive_author_credit: 'Generated by Strata', license: null, source_url: null, license_url: null,
        source: { kind: 'procedural-box-skin-v1', generated: true },
        recommended_gltf: variant.path, recommended_gltf_sha256: null,
        recommended_counts: { triangles_stored_mesh_primitives_once: 12, meshes: 1, skins: 1, animations: 1, morph_target_entries_across_primitives: 0 },
        recommended_texture_dimensions: [], recommended_extensions_used: [], recommended_extensions_required: [],
        alpha_modes: ['OPAQUE'], caveats: ['Generated locally from numeric cube data. No downloaded assets or textures.'],
      })),
    };
    const files = [...variants.map(variant => ({ path: variant.path, bytes: json(model(data, variant.color, variant.title)) })),
      { path: 'scene.bin', bytes: data.bytes }, { path: 'catalog.json', bytes: json(catalog) }];
    const manifest = json({ format: 'strata-gallery-fixture', version: 1, source: { kind: 'procedural-box-skin-v1' },
      files: files.map(file => ({ path: file.path, byteLength: file.bytes.length })) });
    if (manifest.length + files.reduce((sum, file) => sum + file.bytes.length, 0) > 64 * 1024) {
      throw new Error('Generated gallery fixture exceeds its 64 KiB limit.');
    }
    for (const file of files) await fs.writeFile(join(directory, file.path), file.bytes, { flag: 'wx' });
    await fs.writeFile(join(directory, 'fixture.json'), manifest, { flag: 'wx' });
    return { directory, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
