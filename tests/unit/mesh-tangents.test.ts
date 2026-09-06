import { expect, it } from 'vitest';
import { prepareMeshTangents } from '../../packages/core/src/meshes/mesh-tangents.js';
const mesh=(mirror=false)=>new Float32Array([[0,0,0,0],[1,0,1,0],[0,1,0,1]].flatMap(([x,y,u,v])=>[x!,y!,0,0,0,1,mirror?-u!:u!,v!,1,0,0,1,.3,.4,.5,1]));
const indices=new Uint32Array([0,1,2]);
it('derives the UV basis and mirrored handedness without changing other attributes',async()=>{
 for(const mirror of [false,true]){const source=mesh(mirror),result=await prepareMeshTangents(source,indices);
 for(let i=0;i<3;i++){expect(Array.from(result.slice(i*16+8,i*16+12))).toEqual([mirror?-1:1,0,0,mirror?-1:1]);
 for(let j=0;j<16;j++)if(j<8||j>11)expect(result[i*16+j]).toBe(source[i*16+j]);}
 expect(result).not.toBe(source);}
});
it('uses a finite perpendicular fallback for collapsed UVs',async()=>{
 const source=mesh();for(let i=0;i<3;i++)source.fill(0,i*16+6,i*16+8);
 const result=await prepareMeshTangents(source,indices);expect(result.every(Number.isFinite)).toBe(true);
 expect(Math.hypot(...result.slice(8,11))).toBeCloseTo(1);expect(result[10]).toBeCloseTo(0);
});
it('rejects malformed inputs and supports cancellation',async()=>{
 await expect(prepareMeshTangents(mesh(),new Uint32Array([0,1,99]))).rejects.toThrow();
 const invalid=mesh();invalid[5]=0;await expect(prepareMeshTangents(invalid,indices)).rejects.toThrow('normals');
 await expect(prepareMeshTangents(mesh(),indices,{signal:AbortSignal.abort()})).rejects.toMatchObject({code:'SCENE_LOAD_ABORTED'});
 const controller=new AbortController(),pending=prepareMeshTangents(mesh(),indices,{signal:controller.signal});controller.abort();await expect(pending).rejects.toMatchObject({code:'SCENE_LOAD_ABORTED'});
});
it('owns its source across asynchronous preparation',async()=>{
 const source=mesh(),ids=indices.slice(),pending=prepareMeshTangents(source,ids);source.fill(99);ids.fill(99);
 const result=await pending;expect(result[0]).toBe(0);expect(result[8]).toBe(1);
});
it('follows a rotated UV chart rather than an arbitrary normal perpendicular',async()=>{
 const source=mesh();for(let i=0;i<3;i++){const u=source[i*16+6]!;source[i*16+6]=source[i*16+7]!;source[i*16+7]=-u;}
 const result=await prepareMeshTangents(source,indices);for(let i=0;i<3;i++){expect(result[i*16+8]).toBeCloseTo(0);expect(result[i*16+9]).toBeCloseTo(1);expect(result[i*16+11]).toBe(1);}
});
