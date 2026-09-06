import {parseArgs} from 'node:util';
import {resolve,dirname,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {realpath,mkdir,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const {values}=parseArgs({options:{input:{type:'string'},config:{type:'string'},output:{type:'string'},blender:{type:'string',default:'blender'}}});
if(!values.input||!values.config||!values.output)throw Error('Required: --input static.gltf --config grid.json --output NEW_EXTERNAL_DIRECTORY [--blender executable]');
const repository=await realpath(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const input=await realpath(values.input),config=await realpath(values.config),output=resolve(values.output);
await mkdir(dirname(output),{recursive:true});const parent=await realpath(dirname(output)),r=relative(repository,parent);
if(r===''||(r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r)))throw Error('Probe output must be external to the repository.');
try{await access(output);throw Error('Output already exists.');}catch(e){if(e.code!=='ENOENT')throw e;}
await mkdir(output);
const child=spawn(values.blender,['--background','--factory-startup','--python-exit-code','1','--python',resolve(repository,'scripts/bake-probes.py'),'--',input,config,output],{stdio:'inherit'});
const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
if(code!==0)throw Error('Probe bake failed; partial output is not a completed bake.');
console.log('Completed probe volume: '+output+'/probes.json');
