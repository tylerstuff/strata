import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';
const blender=process.argv[2]??'blender';const base=join(homedir(),'Downloads/Strata-Benchmark-Results');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'shadow-layer-backend-'));
const run=(cmd,args)=>{const r=spawnSync(cmd,args,{stdio:'inherit'});if(r.error)throw r.error;assert.equal(r.status,0);};
run(blender,['--background','--factory-startup','--python-exit-code','1','--python','tests/bake/fixture.py','--',root]);
const combined=join(root,'combined'),output=join(root,'layer');
run(process.execPath,['scripts/bake-imported.mjs','--input',join(root,'source.gltf'),'--output',combined,'--blender',blender,'--profile','lightmap','--edge','512','--samples','32']);
const light={id:'fixture lamp',position:[0,.9,0],color:[1,.02,.1],intensity:1,range:3};
const config=join(root,'config.json');await writeFile(config,JSON.stringify({revision:'generated-layer-v1',light,emitterMaterial:'fixture-2',emitterBounds:[[-.6,.9,-.6],[.6,1.1,.6]],normalization:{scale:.5,translation:[0,0,0]},receivers:['fixture-0','fixture-1'],samples:64,maxEdge:512}));
run(process.execPath,['scripts/bake-shadow-layer.mjs','--input',join(combined,'scene.gltf'),'--config',config,'--output',output,'--blender',blender]);
const before=JSON.parse(await readFile(join(combined,'scene.gltf'))),after=JSON.parse(await readFile(join(output,'scene.gltf'))),manifest=JSON.parse(await readFile(join(output,'bake.json')));
assert.deepEqual(after.meshes,before.meshes);assert.deepEqual(after.accessors,before.accessors);assert.deepEqual(after.nodes,before.nodes);
for(let i=0;i<before.buffers.length;i++)assert.equal(resolve(output,decodeURIComponent(after.buffers[i].uri)),resolve(combined,decodeURIComponent(before.buffers[i].uri)));
for(let i=0;i<before.images.length;i++)assert.equal(resolve(output,decodeURIComponent(after.images[i].uri)),resolve(combined,decodeURIComponent(before.images[i].uri)));
assert.equal(manifest.emitterFaces,2);assert.ok(manifest.maximumDiffuse>0);assert.equal(manifest.atlases.length,2);
for(const m of after.materials.filter(m=>m.name!=='fixture-2')){const layer=m.extensions.EXT_strata_lightmap;assert.equal(layer.version,2);assert.deepEqual(layer.pointLight.light,light);assert.ok(layer.pointLight.range>0);}
console.log('Generated Cycles direct layer and unchanged source references passed',root);

const invalid=structuredClone(before);invalid.materials[1].name=invalid.materials[0].name;
const invalidPath=join(combined,'duplicate-names.gltf');await writeFile(invalidPath,JSON.stringify(invalid));
const rejected=spawnSync(process.execPath,['scripts/bake-shadow-layer.mjs','--input',invalidPath,'--config',config,'--output',join(root,'rejected'),'--blender',blender],{encoding:'utf8'});
assert.notEqual(rejected.status,0);assert.match(rejected.stdout+rejected.stderr,/Unique named source materials required/);
console.log('Ambiguous material selection rejected before baking');
