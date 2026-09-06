import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCapsuleController} from '../packages/core/dist/gameplay.js';
const root=await mkdtemp(join(tmpdir(),'strata-collision-cook-'));
try{
 const pos=new Float32Array([-5,0,-5,5,0,-5,5,0,5,-5,0,5]),idx=new Uint32Array([0,2,1,0,3,2]);const bytes=Buffer.concat([Buffer.from(pos.buffer),Buffer.from(idx.buffer)]);await writeFile(join(root,'mesh.bin'),bytes);
 const doc={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0,translation:[0,2,0]}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],materials:[{name:'floor'}],buffers:[{uri:'mesh.bin',byteLength:bytes.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:pos.byteLength},{buffer:0,byteOffset:pos.byteLength,byteLength:idx.byteLength}],accessors:[{bufferView:0,componentType:5126,count:4,type:'VEC3'},{bufferView:1,componentType:5125,count:6,type:'SCALAR'}]};
 await writeFile(join(root,'scene.gltf'),JSON.stringify(doc));
 execFileSync(process.execPath,['scripts/cook-collision.mjs','--input',join(root,'scene.gltf'),'--output',join(root,'cooked')],{stdio:'pipe'});
 const manifest=JSON.parse(await readFile(join(root,'cooked/collision.json'),'utf8'));assert.equal(manifest.triangles,2);
 const c=await createCapsuleController({collision:{...manifest,snapshot:new Uint8Array(await readFile(join(root,'cooked/world.bin')))},position:[0,2.02,0]});try{assert(Math.abs(c.groundHeight([0,5,0])-2)<1e-5);}finally{c.dispose();}
 assert.throws(()=>execFileSync(process.execPath,['scripts/cook-collision.mjs','--input',join(root,'scene.gltf'),'--output',join(root,'cooked')],{stdio:'pipe'}));
 assert.throws(()=>execFileSync(process.execPath,['scripts/cook-collision.mjs','--input',join(root,'scene.gltf'),'--output','test-results/rejected-collision'],{stdio:'pipe'}));
 console.log('Collision cooker: transformed glTF, snapshot restore, output isolation and no-overwrite passed.');
}finally{await rm(root,{recursive:true,force:true});}
