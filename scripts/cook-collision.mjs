import {parseArgs} from 'node:util';
import {readFile,writeFile,mkdir,realpath,stat} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {cookStaticCollision} from '../packages/core/dist/gameplay.js';
const {values}=parseArgs({options:{input:{type:'string'},output:{type:'string'},'include-material':{type:'string'}}});
if(!values.input||!values.output)throw Error('Use --input static.gltf --output NEW_EXTERNAL_DIRECTORY [--include-material REGEXP]');
const root=await realpath(resolve(import.meta.dirname,'..')),input=await realpath(values.input),output=resolve(values.output);
await mkdir(dirname(output),{recursive:true});const parent=await realpath(dirname(output)),rel=relative(root,parent);
if(rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)))throw Error('Collision output must be external.');
const docBytes=await readFile(input);if(docBytes.length>32*1024*1024)throw Error('glTF JSON exceeds 32 MiB.');
const doc=JSON.parse(docBytes);if(doc.animations?.length||doc.skins?.length)throw Error('Static unskinned glTF required.');
const buffers=[],bufferHashes=[];let sourceBytes=docBytes.length;
for(const b of doc.buffers){if(typeof b.uri!=='string'||b.uri.includes(':'))throw Error('Local external glTF buffers required.');const path=resolve(dirname(input),decodeURIComponent(b.uri));sourceBytes+=(await stat(path)).size;if(sourceBytes>512*1024*1024)throw Error('Source buffers exceed 512 MiB.');const bytes=await readFile(path);buffers.push(bytes);bufferHashes.push({uri:b.uri,sha256:createHash('sha256').update(bytes).digest('hex')});}
function accessor(id,position){const a=doc.accessors[id];if(!a||a.sparse||a.type!==(position?'VEC3':'SCALAR')||(position?a.componentType!==5126:![5121,5123,5125].includes(a.componentType)))throw Error('Unsupported collision accessor.');
 if(!Number.isSafeInteger(a.count)||a.count<1||a.count>9_000_000)throw Error('Invalid accessor count.');
 const v=doc.bufferViews[a.bufferView],b=buffers[v.buffer],size=position?4:({5121:1,5123:2,5125:4}[a.componentType]),width=position?3:1,stride=v.byteStride??size*width,base=(v.byteOffset??0)+(a.byteOffset??0);
 if(stride<size*width||base<0||base+(a.count-1)*stride+width*size>b.length)throw Error('Collision accessor outside buffer.');
 const view=new DataView(b.buffer,b.byteOffset,b.byteLength);return Array.from({length:a.count},(_,i)=>Array.from({length:width},(_,j)=>{const o=base+i*stride+j*size;return position?view.getFloat32(o,true):size===4?view.getUint32(o,true):size===2?view.getUint16(o,true):view.getUint8(o);}));}
const identity=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const multiply=(a,b)=>Array.from({length:16},(_,i)=>[0,1,2,3].reduce((s,k)=>s+a[k*4+i%4]*b[Math.floor(i/4)*4+k],0));
function local(n){if(n.matrix){if(n.matrix.length!==16||n.matrix[3]!==0||n.matrix[7]!==0||n.matrix[11]!==0||n.matrix[15]!==1)throw Error('Affine node matrix required.');return n.matrix;}const [x,y,z,w]=n.rotation??[0,0,0,1],s=n.scale??[1,1,1],t=n.translation??[0,0,0];return [(1-2*y*y-2*z*z)*s[0],(2*x*y+2*w*z)*s[0],(2*x*z-2*w*y)*s[0],0,(2*x*y-2*w*z)*s[1],(1-2*x*x-2*z*z)*s[1],(2*y*z+2*w*x)*s[1],0,(2*x*z+2*w*y)*s[2],(2*y*z-2*w*x)*s[2],(1-2*x*x-2*y*y)*s[2],0,...t,1];}
const positions=[],indices=[],materials=new Set(),visited=new Set(),selection=values['include-material']?new RegExp(values['include-material']):null;let degenerate=0,excluded=0;
function visit(id,parent){if(visited.has(id))throw Error('Repeated/cyclic scene node.');visited.add(id);const n=doc.nodes[id],matrix=multiply(parent,local(n));if(!matrix.every(Number.isFinite))throw Error('Invalid node matrix.');
 if(n.mesh!==undefined)for(const p of doc.meshes[n.mesh].primitives){const name=doc.materials?.[p.material]?.name??'';if(selection&&!selection.test(name)){excluded++;continue;}if((p.mode??4)!==4||p.targets)throw Error('Only fixed triangle primitives supported.');const v=accessor(p.attributes.POSITION,true),base=positions.length/3;
 for(const q of v)positions.push(...[0,1,2].map(i=>matrix[i]*q[0]+matrix[4+i]*q[1]+matrix[8+i]*q[2]+matrix[12+i]));
 const ids=p.indices===undefined?v.map((_,i)=>i):accessor(p.indices,false).flat();if(ids.length%3||ids.some(i=>i>=v.length))throw Error('Invalid triangle indices.');
 for(let i=0;i<ids.length;i+=3){const a=ids.slice(i,i+3).map(j=>positions.slice((base+j)*3,(base+j)*3+3)),u=a[1].map((x,k)=>x-a[0][k]),w=a[2].map((x,k)=>x-a[0][k]);const area=Math.hypot(u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]);if(area<1e-10){degenerate++;continue;}indices.push(...ids.slice(i,i+3).map(j=>base+j));}
 materials.add(name);if(positions.length*4+indices.length*4>128*1024*1024||indices.length>9_000_000)throw Error('Collision mesh budget exceeded.');}
 for(const child of n.children??[])visit(child,matrix);}
for(const id of doc.scenes[doc.scene??0].nodes)visit(id,identity());
await mkdir(output);const started=performance.now();const cooked=await cookStaticCollision({positions:new Float32Array(positions),indices:new Uint32Array(indices)});
await writeFile(resolve(output,'world.bin'),cooked.snapshot);
const manifest={version:cooked.version,backend:cooked.backend,triangles:cooked.triangles,snapshotBytes:cooked.snapshot.byteLength,sha256:createHash('sha256').update(cooked.snapshot).digest('hex'),sourceSha256:createHash('sha256').update(docBytes).digest('hex'),bufferHashes,units:'source glTF units; Y up; node world transforms applied',materials:[...materials],excludedPrimitives:excluded,degenerateTriangles:degenerate,sourceBytes,cookMilliseconds:performance.now()-started};
await writeFile(resolve(output,'collision.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest));
