import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGltf, gltfImageDimensions } from '../../packages/core/src/imported/gltf-loader.js';
import type { GltfObject } from '../../packages/core/src/imported/gltf-accessor.js';

// All bytes here are generated test data. No model or texture from the external collection is copied.
class Fixture {
  readonly views: GltfObject[] = [];
  readonly accessors: GltfObject[] = [];
  readonly parts: Uint8Array[] = [];
  length = 0;
  document: GltfObject = { asset: { version: '2.0' }, nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 };
  add(values: Float32Array | Uint8Array | Uint16Array | Uint32Array, type: string, normalized = false): number {
    const padding = (4 - this.length % 4) % 4; this.parts.push(new Uint8Array(padding)); this.length += padding;
    this.views.push({ buffer: 0, byteOffset: this.length, byteLength: values.byteLength });
    this.parts.push(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)); this.length += values.byteLength;
    const width: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
    this.accessors.push({ bufferView: this.views.length - 1, componentType: values instanceof Float32Array ? 5126 : values instanceof Uint8Array ? 5121 : values instanceof Uint16Array ? 5123 : 5125,
      count: values.length / width[type]!, type, ...(normalized ? { normalized: true } : {}) });
    return this.accessors.length - 1;
  }
  triangle(normal = true): GltfObject {
    const attributes: GltfObject = { POSITION: this.add(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 'VEC3') };
    if (normal) attributes.NORMAL = this.add(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 'VEC3');
    attributes.TEXCOORD_0 = this.add(new Uint16Array([0, 0, 65535, 0, 0, 65535]), 'VEC2', true);
    const primitive = { attributes, indices: this.add(new Uint8Array([0, 1, 2]), 'SCALAR') };
    this.document.meshes = [{ primitives: [primitive] }]; return primitive;
  }
  bytes(): Uint8Array<ArrayBuffer> { const result = new Uint8Array(this.length); let offset = 0; for (const part of this.parts) { result.set(part, offset); offset += part.length; } return result; }
  json(dataUri = false): GltfObject {
    return { ...this.document, bufferViews: this.views, accessors: this.accessors, buffers: [{ byteLength: this.length,
      ...(dataUri ? { uri: `data:application/octet-stream;base64,${Buffer.from(this.bytes()).toString('base64')}` } : { uri: 'mesh.bin' }) }] };
  }
  serve(): void {
    const bytes = this.bytes();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://fixture.test/path/scene.gltf') return new Response(JSON.stringify(this.json()));
      if (url === 'https://fixture.test/path/mesh.bin') return new Response(bytes);
      if (url === 'https://fixture.test/texture.png') return new Response(png(2, 4));
      return new Response('missing', { status: 404 });
    }));
  }
  load() { this.serve(); return loadGltf('https://fixture.test/path/scene.gltf'); }
}
function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33); const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x89504e47); view.setUint32(4, 0x0d0a1a0a); view.setUint32(8, 13); view.setUint32(12, 0x49484452);
  view.setUint32(16, width); view.setUint32(20, height); return bytes;
}
function expectVector(actual: ArrayLike<number>, expected: readonly number[], digits = 6): void {
  expect(actual.length).toBe(expected.length); expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, digits));
}
function translationClip(f: Fixture, node = 0): void {
  const input = f.add(new Float32Array([0, 2]), 'SCALAR'); const output = f.add(new Float32Array([0, 0, 0, 1, 0, 0]), 'VEC3');
  f.document.animations = [{ name: 'Move', samplers: [{ input, output }], channels: [{ sampler: 0, target: { node, path: 'translation' } }] }];
}
afterEach(() => vi.unstubAllGlobals());

describe('generated glTF rest geometry and materials', () => {
  it('normalizes the selected scene and decodes normalized color/UV, MASK and unlit material texture semantics', async () => {
    const f = new Fixture(); const p = f.triangle(); const a = p.attributes as GltfObject;
    a.COLOR_0 = f.add(new Uint8Array([255, 128, 0, 64, 0, 255, 0, 255, 0, 0, 255, 255]), 'VEC4', true);
    p.material = 0;
    f.document.nodes = [{ mesh: 0, translation: [4, -2, 7] }];
    f.document.images = [{ uri: '../texture.png' }]; f.document.textures = [{ source: 0, sampler: 0 }];
    f.document.samplers = [{ wrapS: 33071, wrapT: 33648, minFilter: 9728, magFilter: 9728 }];
    f.document.extensionsRequired = ['KHR_materials_unlit', 'KHR_materials_emissive_strength'];
    f.document.materials = [{ alphaMode: 'MASK', alphaCutoff: 0.75, doubleSided: true, extensions: { KHR_materials_unlit: {}, KHR_materials_emissive_strength: { emissiveStrength: 3 } },
      pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 0.8], metallicFactor: 0.1, roughnessFactor: 0.9, baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 0 } },
      normalTexture: { index: 0, scale: 0.5 }, occlusionTexture: { index: 0, strength: 0.25 }, emissiveFactor: [0.1, 0.2, 0.3], emissiveTexture: { index: 0 } }];
    const asset = await f.load(); const vertices = asset.primitives[0]!.vertices;
    expect(asset.sourceBounds).toEqual({ min: [4, -2, 7], max: [5, -1, 7] });
    expect(asset.normalization).toEqual({ scale: 2, translation: [-9, 4, -14] });
    expectVector(vertices.subarray(0, 3), [-1, 0, 0]); expectVector(vertices.subarray(16, 19), [1, 0, 0]);
    expectVector(vertices.subarray(12, 16), [1, 128 / 255, 0, 64 / 255]); expectVector(vertices.subarray(22, 24), [1, 0]);
    expectVector(vertices.subarray(8, 12), [1, 0, 0, 1]);
    expect(asset.materials[0]).toMatchObject({ unlit: true, alphaMode: 'MASK', alphaCutoff: 0.75, doubleSided: true, normalScale: 0.5, occlusionStrength: 0.25, emissiveStrength: 3,
      baseColorTexture: { image: 0, sampler: { wrapS: 33071, wrapT: 33648, minFilter: 9728, magFilter: 9728 } } });
    expect(asset.images[0]).toMatchObject({ width: 2, height: 4, mimeType: 'image/png' });
    expect(asset.stats).toMatchObject({ meshInstances: 1, vertices: 3, triangles: 1, geometryBytes: 204, animationClips: 0 });
    expect(asset.rig).toBeUndefined();
  });
  it('repairs mirrored winding and preserves inverse-transpose normals and tangent handedness under affine scale', async () => {
    const f = new Fixture(); const p = f.triangle(); const a = p.attributes as GltfObject; const n = 1 / Math.sqrt(3), t = Math.SQRT1_2;
    a.NORMAL = f.add(new Float32Array([n,n,n,n,n,n,n,n,n]), 'VEC3');
    a.TANGENT = f.add(new Float32Array([t,-t,0,1,t,-t,0,1,t,-t,0,1]), 'VEC4');
    f.document.nodes = [{ children: [1], scale: [-2,3,4], translation: [2,1,0] }, { mesh: 0 }];
    translationClip(f, 1); const asset = await f.load(); const primitive = asset.primitives[0]!;
    expect([...primitive.indices]).toEqual([0,2,1]);
    const expected = [-0.5, 1 / 3, 0.25]; const length = Math.hypot(...expected);
    expectVector(primitive.vertices.subarray(3,6), expected.map(value => value / length));
    expectVector(primitive.vertices.subarray(8,12), [-2 / Math.sqrt(13), -3 / Math.sqrt(13), 0, -1]);
    expectVector(primitive.deformation!.vertices.subarray(8,12), [t,-t,0,1]);
  });
  it('generates local missing normals before mirrored winding repair for retained animation', async () => {
    const f = new Fixture(); f.triangle(false); f.document.nodes = [{ children: [1], scale: [-2,3,1] }, { mesh: 0 }]; translationClip(f,1);
    const primitive = (await f.load()).primitives[0]!;
    expect([...primitive.indices]).toEqual([0,2,1]);
    for (let vertex = 0; vertex < 3; vertex++) {
      expectVector(primitive.deformation!.vertices.subarray(vertex * 16 + 3,vertex * 16 + 6), [0,0,1]);
      // Independent inverse-transpose diag(-1/2,1/3,1) maps the retained normal to +Z.
      expectVector(primitive.vertices.subarray(vertex * 16 + 3,vertex * 16 + 6), [0,0,1]);
    }
  });
  it('bakes weighted jointWorld*inverseBind without the mesh parent, and transforms normals after matrix blending', async () => {
    const f = new Fixture(); const p = f.triangle(); const a = p.attributes as GltfObject;
    a.POSITION = f.add(new Float32Array([0,0,0,1,0,0,0,1,1]), 'VEC3'); const n = Math.SQRT1_2;
    a.NORMAL = f.add(new Float32Array([0,-n,n,0,-n,n,0,-n,n]), 'VEC3');
    a.JOINTS_0 = f.add(new Uint16Array([0,1,0,0,0,1,0,0,0,1,0,0]), 'VEC4');
    a.WEIGHTS_0 = f.add(new Float32Array([.25,.75,0,0,.25,.75,0,0,.25,.75,0,0]), 'VEC4');
    const inverse = f.add(new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,-1,0,0,1, 1,0,0,0,0,1,0,0,0,0,1,0,0,-1,0,1]), 'MAT4');
    f.document.nodes = [{ children: [1], translation: [100,100,100] }, { mesh: 0, skin: 0, translation: [50,0,0] },
      { translation: [10,0,0], scale: [2,1,1] }, { translation: [0,4,0], scale: [1,3,2] }];
    f.document.scenes = [{ nodes: [0,2,3] }]; f.document.skins = [{ joints: [2,3], inverseBindMatrices: inverse }];
    const asset = await f.load(); const primitive = asset.primitives[0]!;
    expect(asset.sourceBounds).toEqual({ min: [2,.75,0], max: [3.25,3.25,1.75] });
    expectVector(primitive.vertices.subarray(0,3), [-.5,0,-.7]);
    const length = Math.hypot(1 / 2.5, 1 / 1.75);
    expectVector(primitive.vertices.subarray(3,6), [0,-1 / 2.5 / length,1 / 1.75 / length]);
    expectVector(primitive.deformation!.vertices.subarray(0,3), [0,0,0]);
    expect([...primitive.deformation!.weights!].slice(0,4)).toEqual([.25,.75,0,0]);
    expect(asset.rig!.nodes[1]!.parent).toBe(0); expect(asset.rig!.skins[0]!.joints).toEqual([2,3]);
    expect(asset.stats.skinnedMeshInstances).toBe(1);
  });
});

describe('generated glTF containers, animation and rejection boundaries', () => {
  it('retains exact LINEAR, STEP and CUBICSPLINE clip channels and output layout', async () => {
    const f = new Fixture(); f.triangle(); const input = f.add(new Float32Array([0,2]), 'SCALAR');
    const translation = f.add(new Float32Array([0,0,0,2,0,0]), 'VEC3');
    const rotation = f.add(new Float32Array([0,0,0,1,0,0,0,-1]), 'VEC4');
    const cubicValues = [0,0,0,1,1,1,0,0,0, 0,0,0,2,2,2,0,0,0]; const scale = f.add(new Float32Array(cubicValues), 'VEC3');
    f.document.animations = [{ name: 'All interpolation modes', samplers: [{input,output:translation}, {input,output:rotation,interpolation:'STEP'}, {input,output:scale,interpolation:'CUBICSPLINE'}],
      channels: ['translation','rotation','scale'].map((path,sampler) => ({sampler,target:{node:0,path}})) }];
    const asset = await f.load(); expect(asset.clips[0]).toMatchObject({id:'animation-0',duration:2,name:'All interpolation modes'});
    expect(asset.clips[0]!.channels.map(channel => channel.interpolation)).toEqual(['LINEAR','STEP','CUBICSPLINE']);
    expect([...asset.clips[0]!.channels[2]!.values]).toEqual(cubicValues); expect(asset.primitives[0]!.deformation).toBeDefined();
  });
  it('loads base64 buffers and GLB binary chunks with legal padding', async () => {
    const f = new Fixture(); f.triangle();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(f.json(true)))));
    expect((await loadGltf('https://fixture.test/data.gltf')).stats.triangles).toBe(1);
    const doc = f.json(); (doc.buffers as GltfObject[])[0] = { byteLength: f.length };
    const json = new TextEncoder().encode(JSON.stringify(doc)); const jsonLength = Math.ceil(json.length / 4) * 4, binaryLength = Math.ceil(f.length / 4) * 4;
    const glb = new Uint8Array(28 + jsonLength + binaryLength); const view = new DataView(glb.buffer);
    [0x46546c67,2,glb.length,jsonLength,0x4e4f534a].forEach((value,index) => view.setUint32(index*4,value,true));
    glb.fill(32,20,20+jsonLength); glb.set(json,20); view.setUint32(20+jsonLength,binaryLength,true); view.setUint32(24+jsonLength,0x4e4942,true); glb.set(f.bytes(),28+jsonLength);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(glb)));
    expect((await loadGltf('https://fixture.test/scene.glb')).stats.geometryBytes).toBe(204);
    view.setUint32(8,glb.length-1,true); await expect(loadGltf('https://fixture.test/scene.glb')).rejects.toThrow('GLB');
  });
  it('rejects unsupported shading, UV sets, malformed hierarchy and accessor bounds instead of silently dropping features', async () => {
    for (const change of [
      (f:Fixture) => { f.document.extensionsRequired = ['KHR_draco_mesh_compression']; },
      (f:Fixture) => { f.document.materials = [{alphaMode:'BLEND'}]; },
      (f:Fixture) => { f.document.nodes = [{children:[1]},{children:[0],mesh:0}]; },
      (f:Fixture) => { f.accessors[0]!.count = 4; },
      (f:Fixture) => { f.views[0]!.byteStride = 10; },
      (f:Fixture) => { const p = ((f.document.meshes as GltfObject[])[0]!.primitives as GltfObject[])[0]!; p.material=0; f.document.materials=[{pbrMetallicRoughness:{baseColorTexture:{index:0,texCoord:1}}}]; },
    ]) { const f = new Fixture(); f.triangle(); change(f); await expect(f.load()).rejects.toMatchObject({name:'StrataError'}); }
  });
  it('rejects malformed animation keyframes and morph channels', async () => {
    for (const change of [
      (f:Fixture) => { ((f.document.animations as GltfObject[])[0]!.channels as GltfObject[])[0]!.target={node:0,path:'weights'}; },
      (f:Fixture) => { const a=(f.document.animations as GltfObject[])[0]!; const sampler=(a.samplers as GltfObject[])[0]!; sampler.interpolation='CUBICSPLINE'; },
      (f:Fixture) => { const a=(f.document.animations as GltfObject[])[0]!; (a.channels as GltfObject[])[0]!.target={node:0,path:'rotation'}; (a.samplers as GltfObject[])[0]!.output=f.add(new Float32Array([0,0,0,2,0,0,0,2]),'VEC4'); },
    ]) { const f=new Fixture(); f.triangle(); translationClip(f); change(f); await expect(f.load()).rejects.toMatchObject({name:'StrataError'}); }
  });
  it('enforces aggregate source, retained geometry and encoded image dimension budgets', async () => {
    const f = new Fixture(); f.triangle(); translationClip(f); f.serve();
    await expect(loadGltf('https://fixture.test/path/scene.gltf',{maxSourceBytes:64})).rejects.toMatchObject({code:'UNSUPPORTED_LIMIT'});
    await expect(loadGltf('https://fixture.test/path/scene.gltf',{maxGeometryBytes:300})).rejects.toMatchObject({code:'UNSUPPORTED_LIMIT'});
    expect(() => gltfImageDimensions(png(8192,8192),4096)).toThrow('dimensions');
    expect(gltfImageDimensions(png(8192,8192),16384)).toMatchObject({width:8192,height:8192});
  });
  it('cancels and unlocks an oversized streaming response without waiting for its unbounded remainder', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(128)); }, cancel });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream)));
    await expect(loadGltf('https://fixture.test/oversized.gltf',{maxSourceBytes:64})).rejects.toMatchObject({code:'UNSUPPORTED_LIMIT'});
    expect(cancel).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false);
  });
  it('closes unsuccessful responses and a response arriving concurrently with cancellation', async () => {
    for (const canceled of [false,true]) {
      const controller = new AbortController(); const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({ cancel });
      vi.stubGlobal('fetch', vi.fn(async () => { if (canceled) controller.abort(); return new Response(stream,{status:canceled ? 200 : 404}); }));
      await expect(loadGltf('https://fixture.test/unavailable.gltf',{signal:controller.signal})).rejects.toMatchObject({code:canceled ? 'SCENE_LOAD_ABORTED' : 'SCENE_LOAD_FAILED'});
      expect(cancel).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false);
    }
  });
  it('honors cancellation before fetch and during chunked CPU data decoding', async () => {
    const f = new Fixture(); f.triangle(); f.serve(); const pre = new AbortController(); pre.abort();
    await expect(loadGltf('https://fixture.test/path/scene.gltf',{signal:pre.signal})).rejects.toMatchObject({code:'SCENE_LOAD_ABORTED'}); expect(fetch).not.toHaveBeenCalled();
    const large = new Uint8Array(100000); const controller = new AbortController();
    const url = `data:application/octet-stream;base64,${Buffer.from(large).toString('base64')}`;
    setTimeout(() => controller.abort(),0); await expect(loadGltf(url,{signal:controller.signal})).rejects.toMatchObject({code:'SCENE_LOAD_ABORTED'});
  });
});
