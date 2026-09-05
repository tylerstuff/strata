import { describe, expect, it } from 'vitest';
import { GltfAccessors } from '../../packages/core/src/imported/gltf-accessor.js';

describe('glTF accessor binary layouts', () => {
  it('decodes offsets, interleaved vertex stride and signed normalized integer endpoints', async () => {
    const buffer=new Uint8Array(32); const data=new DataView(buffer.buffer);
    data.setFloat32(4,1.25,true);data.setFloat32(8,2.5,true);data.setFloat32(20,-3,true);data.setFloat32(24,4,true);
    const decoded=new GltfAccessors({bufferViews:[{buffer:0,byteOffset:0,byteLength:32,byteStride:16}],accessors:[{bufferView:0,byteOffset:4,type:'VEC2',componentType:5126,count:2}]},[buffer],()=>{});
    expect([...(await decoded.read(0)).values]).toEqual([1.25,2.5,-3,4]);
    const signed=new GltfAccessors({bufferViews:[{buffer:0,byteLength:4}],accessors:[{bufferView:0,type:'VEC4',componentType:5120,count:1,normalized:true}]},[new Uint8Array([128,129,0,127])],()=>{});
    expect([...(await signed.read(0)).values]).toEqual([-1,-1,0,1]);
  });
  it('accounts for matrix column padding and sparse zero-initialized replacement', async () => {
    const bytes=new Uint8Array([1,2,3,99,4,5,6,99,7,8,9,99]);
    const matrix=new GltfAccessors({bufferViews:[{buffer:0,byteLength:12}],accessors:[{bufferView:0,type:'MAT3',componentType:5121,count:1}]},[bytes],()=>{});
    expect([...(await matrix.read(0)).values]).toEqual([1,2,3,4,5,6,7,8,9]);
    const sparse=new GltfAccessors({bufferViews:[{buffer:0,byteLength:1},{buffer:1,byteLength:12}],accessors:[{type:'VEC3',componentType:5126,count:3,sparse:{count:1,indices:{bufferView:0,componentType:5121},values:{bufferView:1}}}]},
      [new Uint8Array([1]),new Uint8Array(new Float32Array([2,3,4]).buffer)],()=>{});
    expect([...(await sparse.read(0)).values]).toEqual([0,0,0,2,3,4,0,0,0]);
  });
  it('rejects sparse duplicate indices, nonfinite floats and misaligned reads', async () => {
    const cases = [
      new GltfAccessors({bufferViews:[{buffer:0,byteLength:2},{buffer:1,byteLength:8}],accessors:[{type:'SCALAR',componentType:5126,count:3,sparse:{count:2,indices:{bufferView:0,componentType:5121},values:{bufferView:1}}}]},[new Uint8Array([1,1]),new Uint8Array(8)],()=>{}),
      new GltfAccessors({bufferViews:[{buffer:0,byteLength:4}],accessors:[{bufferView:0,type:'SCALAR',componentType:5126,count:1}]},[new Uint8Array(new Float32Array([Infinity]).buffer)],()=>{}),
      new GltfAccessors({bufferViews:[{buffer:0,byteOffset:1,byteLength:4}],accessors:[{bufferView:0,type:'SCALAR',componentType:5126,count:1}]},[new Uint8Array(8)],()=>{}),
    ];
    for (const accessors of cases) await expect(accessors.read(0)).rejects.toMatchObject({code:'SCENE_LOAD_FAILED'});
  });
});
