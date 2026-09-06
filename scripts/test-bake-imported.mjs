import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const blender=process.argv[2]??'blender';const profile=process.argv[3]??'vertex';
const base=join(homedir(),'Downloads/Strata-Benchmark-Results');await mkdir(base,{recursive:true});
const root=await mkdtemp(join(base,'bake-backend-')),out=join(root,'result');
function run(command,args){const r=spawnSync(command,args,{stdio:'inherit'});if(r.error)throw r.error;assert.equal(r.status,0);}
run(blender,['--background','--factory-startup','--python-exit-code','1','--python','tests/bake/fixture.py','--',root]);
run(process.execPath,['scripts/bake-imported.mjs','--input',join(root,'source.gltf'),'--output',out,'--blender',blender,'--samples','16','--profile',profile,'--edge','512','--denoiser',process.argv[4]??'none']);
const gltf=JSON.parse(await readFile(join(out,'scene.gltf'),'utf8'));
const data=await readFile(join(out,gltf.buffers[0].uri));
assert.equal(gltf.meshes[0].primitives.length,3);
if(profile==='lightmap'){
 const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
 const {PNG}=require(new URL('../node_modules/playwright-core/lib/utilsBundle.js',import.meta.url).pathname);
 const manifest=JSON.parse(await readFile(join(out,'bake.json'),'utf8'));
 assert.ok(manifest.maximumDiffuse>0);
 for(const primitive of gltf.meshes[0].primitives){
  const extension=gltf.materials[primitive.material].extensions.EXT_strata_lightmap;
  assert.equal(extension.texture.texCoord,1);
  const atlas=gltf.images[gltf.textures[extension.texture.index].source];
  const png=PNG.sync.read(await readFile(join(out,atlas.uri)));
  assert.equal(extension.range,manifest.atlases.find(a=>a.image===atlas.uri).range);
  const a=gltf.accessors[primitive.attributes.TEXCOORD_1],v=gltf.bufferViews[a.bufferView];
  let u=0,w=0;for(let i=0;i<a.count;i++){const offset=(v.byteOffset??0)+(a.byteOffset??0)+i*(v.byteStride??8);u+=data.readFloatLE(offset)/a.count;w+=data.readFloatLE(offset+4)/a.count;}
  assert.ok(u>=0&&u<=1&&w>=0&&w<=1);
  const at=(Math.min(png.height-1,Math.floor(w*png.height))*png.width+Math.min(png.width-1,Math.floor(u*png.width)))*4;
  assert.ok(png.data[at]>0&&png.data[at]>png.data[at+1]*5,`Receiver lacks red light: ${gltf.materials[primitive.material].name}`);
 }
}else for(const primitive of gltf.meshes[0].primitives){
 const a=gltf.accessors[primitive.attributes.COLOR_0],view=gltf.bufferViews[a.bufferView];
 assert.equal(a.componentType,5123);assert.equal(a.type,'VEC4');assert.equal(a.normalized,true);
 const sum=[0,0,0];for(let i=0;i<a.count;i++)for(let c=0;c<3;c++)sum[c]+=data.readUInt16LE((view.byteOffset??0)+(a.byteOffset??0)+i*(view.byteStride??8)+c*2);
 // The shared bake attribute must reach every material, including later slots.
 assert.ok(sum[0]>0&&sum[0]>sum[1]*10&&sum[0]>sum[2]*5,`Wrong red-light bake for ${gltf.materials[primitive.material].name}: ${sum}`);
}
assert.equal(JSON.parse(await readFile(join(out,'bake.json'),'utf8')).backend,'Cycles');
if(profile==='lightmap'&&process.argv[4]&&process.argv[4]!=='none')run(blender,['--background','--factory-startup','--python-exit-code','1','--python','tests/bake/denoise.py','--',process.argv[4]]);
console.log('Cycles bake and three-material finalization passed:',profile,root);
