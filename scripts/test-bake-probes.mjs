import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const blender=process.argv[2]??'blender';
const base=join(homedir(),'Downloads/Strata-Benchmark-Results');await mkdir(base,{recursive:true});
const root=await mkdtemp(join(base,'probe-backend-'));
const run=(command,args)=>{const result=spawnSync(command,args,{stdio:'inherit'});if(result.error)throw result.error;assert.equal(result.status,0);};
run(blender,['--background','--factory-startup','--python-exit-code','1','--python','tests/bake/fixture.py','--',root]);
const results={};
for(const transport of ['combined','indirect']) {
  const config=join(root,`${transport}.json`),output=join(root,transport);
  await writeFile(config,JSON.stringify({revision:transport,transport,origin:[-.3,.2,-.2],spacing:[.6,.2,.4],counts:[2,2,2],samples:128,emissionScale:1}));
  run(process.execPath,['scripts/bake-probes.mjs','--input',join(root,'source.gltf'),'--config',config,'--output',output,'--blender',blender]);
  const volume=JSON.parse(await readFile(join(output,'probes.json'))),manifest=JSON.parse(await readFile(join(output,'bake.json')));
  assert.equal(volume.transport,transport);assert.equal(manifest.transport,transport);assert.equal(volume.irradiance.length,144);
  assert.ok(volume.irradiance.every(v=>Number.isFinite(v)&&v>=0));assert.equal(volume.valid.reduce((a,b)=>a+b),8);
  results[transport]=volume.irradiance.reduce((a,b)=>a+b,0);
}
assert.ok(results.indirect>0,'Indirect-only bake lost floor bounce');
assert.ok(results.combined>results.indirect*2,'Indirect-only bake retained direct emitter illumination');
console.log('Cycles probe transport separation passed',results,root);
