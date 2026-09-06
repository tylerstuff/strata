import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const blender=process.argv[2]??'blender';
const base=join(homedir(),'Downloads/Strata-Benchmark-Results');await mkdir(base,{recursive:true});
const root=await mkdtemp(join(base,'bake-backend-')),out=join(root,'result');
function run(command,args){const r=spawnSync(command,args,{stdio:'inherit'});if(r.error)throw r.error;assert.equal(r.status,0);}
run(blender,['--background','--factory-startup','--python-exit-code','1','--python','tests/bake/fixture.py','--',root]);
run(process.execPath,['scripts/bake-imported.mjs','--input',join(root,'source.gltf'),'--output',out,'--blender',blender,'--samples','16']);
const gltf=JSON.parse(await readFile(join(out,'scene.gltf'),'utf8'));
const data=await readFile(join(out,gltf.buffers[0].uri));
assert.equal(gltf.meshes[0].primitives.length,3);
for(const primitive of gltf.meshes[0].primitives){
 const a=gltf.accessors[primitive.attributes.COLOR_0],view=gltf.bufferViews[a.bufferView];
 assert.equal(a.componentType,5123);assert.equal(a.type,'VEC4');assert.equal(a.normalized,true);
 const sum=[0,0,0];for(let i=0;i<a.count;i++)for(let c=0;c<3;c++)sum[c]+=data.readUInt16LE((view.byteOffset??0)+(a.byteOffset??0)+i*(view.byteStride??8)+c*2);
 // The shared bake attribute must reach every material, including later slots.
 assert.ok(sum[0]>0&&sum[0]>sum[1]*10&&sum[0]>sum[2]*5,`Wrong red-light bake for ${gltf.materials[primitive.material].name}: ${sum}`);
}
assert.equal(JSON.parse(await readFile(join(out,'bake.json'),'utf8')).backend,'Cycles');
console.log('Cycles bake, shared vertex colors across three materials, and finalization passed:',root);
