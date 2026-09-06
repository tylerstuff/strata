import {createEngine,createMeshAsset} from '/packages/core/dist/index.js';
import {createCharacterController,cookStaticCollision,createCapsuleController,decodeCollisionSnapshot} from '/packages/core/dist/gameplay.js';
import {mesh,cube,material} from './geometry.js';
const canvas=document.querySelector('canvas'),stats=document.querySelector('#stats'),keys=new Set();
const boxes=[
 {min:[-8,-.5,-8],max:[8,0,8]},
 {min:[-8,0,-8],max:[8,2,-7.7]},
 {min:[4,0,-6],max:[4.3,2.5,4]},
 {min:[-1,0,0],max:[1,.2,1]},
 {min:[-1,0,-1],max:[1,.4,0]},
 {min:[-1,0,-2],max:[1,.6,-1]},
 {min:[-1,0,-3],max:[1,.8,-2]},
 {min:[-4,0,0],max:[-2,.8,2]},
];
const spawn=[0,0,4],capsuleMode=new URLSearchParams(location.search).has('capsule');let controller;
const identity=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function boxMesh(name,min,max,mat){return mesh(name,cube.map(face=>face.map(p=>p.map((v,i)=>(min[i]+max[i])/2+v*(max[i]-min[i])/2))),mat);}
const parts=[
 {name:'torso',min:[-.24,.7,-.15],max:[.24,1.35,.15],color:3},
 {name:'head',min:[-.2,1.38,-.18],max:[.2,1.78,.18],color:4},
 {name:'left leg',min:[-.22,0,-.12],max:[-.035,.68,.12],color:5},
 {name:'right leg',min:[.035,0,-.12],max:[.22,.68,.12],color:5},
 {name:'left arm',min:[-.38,.72,-.1],max:[-.27,1.32,.1],color:4},
 {name:'right arm',min:[.27,.72,-.1],max:[.38,1.32,.1],color:4},
];
const courseMeshes=boxes.map((b,i)=>boxMesh('course '+i,b.min,b.max,i===0?0:i>2?2:1));if(capsuleMode)courseMeshes.push(mesh('shallow ramp',[[[-6,0,-2],[-3,0,-2],[-3,1.2,-5],[-6,1.2,-5]]],2));
const asset=createMeshAsset({meshes:[...courseMeshes,...parts.map(p=>boxMesh(p.name,p.min,p.max,p.color))],materials:[
 material('stone',[.24,.31,.35]),material('walls',[.15,.3,.4]),material('steps',[.65,.32,.1]),material('jacket',[.08,.48,.68]),material('skin',[.65,.4,.24]),material('trousers',[.09,.13,.2])
]});
if(capsuleMode){const positions=[],indices=[];for(const m of courseMeshes){const base=positions.length/3;for(let i=0;i<m.vertices.length;i+=16)positions.push(...m.vertices.slice(i,i+3));indices.push(...m.indices.map(i=>i+base));}let collision=await cookStaticCollision({positions:new Float32Array(positions),indices:new Uint32Array(indices)});if(new URLSearchParams(location.search).has('gzip')){const raw=collision.snapshot;const encoded=new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());const hash=async b=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(v=>v.toString(16).padStart(2,'0')).join('');collision={...collision,snapshot:await decodeCollisionSnapshot(encoded,{encoding:'gzip',bytes:encoded.length,sha256:await hash(encoded),decodedBytes:raw.length,decodedSha256:await hash(raw)})};}controller=await createCapsuleController({collision,position:spawn});}else controller=createCharacterController({boxes,position:spawn});
const transforms=new Float32Array(asset.rig.nodes.length*16);for(let i=0;i<asset.rig.nodes.length;i++)transforms.set(identity(),i*16);
let engine,frame,last,paused=false,override=null,yaw=0,cut=true,disposed=false,metrics;
const reset=()=>{controller.teleport(spawn);last=undefined;keys.clear();cut=true;};
const keyboard=e=>{
 if(!['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','KeyR'].includes(e.code))return;
 e.preventDefault();if(e.type==='keydown'){keys.add(e.code);if(e.code==='KeyR')reset();}else keys.delete(e.code);
};
canvas.addEventListener('keydown',keyboard);canvas.addEventListener('keyup',keyboard);canvas.addEventListener('blur',()=>{keys.clear();last=undefined;});
canvas.addEventListener('pointerdown',()=>canvas.focus());
document.querySelector('#reset').onclick=reset;
document.querySelector('#pause').onclick=e=>{paused=!paused;last=undefined;keys.clear();e.target.textContent=paused?'Resume':'Pause';};
const visible=()=>{keys.clear();last=undefined;};document.addEventListener('visibilitychange',visible);
function dispose(){if(disposed)return;disposed=true;cancelAnimationFrame(frame);engine?.dispose();controller?.dispose?.();document.removeEventListener('visibilitychange',visible);canvas.removeEventListener('keydown',keyboard);canvas.removeEventListener('keyup',keyboard);}
try{
 engine=await createEngine({canvas});await engine.setScene({renderer:'imported',asset});
 const tick=now=>{
  if(disposed)return;
  try{
   const elapsed=last===undefined||paused||document.hidden?0:Math.min(60,(now-last)/1000);last=now;
   const down=(...codes)=>codes.some(c=>keys.has(c));
   const state=controller.advance(elapsed,override??{x:Number(down('KeyD','ArrowRight'))-Number(down('KeyA','ArrowLeft')),z:Number(down('KeyS','ArrowDown'))-Number(down('KeyW','ArrowUp')),jump:down('Space')});
   const p=state.position.map((v,i)=>state.previousPosition[i]*(1-state.alpha)+v*state.alpha);
   if(Math.hypot(state.velocity[0],state.velocity[2])>.01)yaw=Math.atan2(state.velocity[0],state.velocity[2]);
   const c=Math.cos(yaw),s=Math.sin(yaw),stride=state.motion==='walk'?Math.sin(state.tick/60*11)*.12:0;
   parts.forEach((part,i)=>{const lift=i<2?0:(i%2?stride:-stride);transforms.set([c,0,-s,0,0,1,0,0,s,0,c,0,p[0],p[1]+Math.max(0,lift),p[2],1],(courseMeshes.length+i)*16);});
   metrics=engine.render({timeSeconds:state.tick/60,temporal:true,cameraCut:cut,imported:{transforms,camera:{eye:[p[0]+5,p[1]+5,p[2]+7],target:[p[0],p[1]+.8,p[2]],verticalFov:Math.PI/3},lighting:{directionToLight:[-.5,.85,.4],color:[1,.93,.82],intensity:3,ambient:[.08,.1,.12]},background:[.035,.055,.08]}});cut=false;
   stats.textContent=`${state.motion} · ${state.grounded?'grounded':'airborne'} · tick ${state.tick} · ${metrics.drawCalls} draws · ${state.droppedSeconds.toFixed(3)} s discarded`;
   frame=requestAnimationFrame(tick);
  }catch(error){document.querySelector('#error').textContent=String(error);dispose();}
 };
 window.characterCourse={ready:true,collisionDiagnostics:()=>controller.diagnostics?.(),snapshot:()=>controller.snapshot(),input:value=>{override=value;},reset,teleport:p=>{controller.teleport(p);cut=true;},telemetry:()=>engine.getTelemetry(),metrics:()=>metrics,dispose};
 frame=requestAnimationFrame(tick);
}catch(error){document.querySelector('#error').textContent=String(error);dispose();}
window.addEventListener('pagehide',dispose,{once:true});
