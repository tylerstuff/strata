import {createEngine,createMeshAsset} from '/packages/core/dist/index.js';
const canvas=document.querySelector('#canvas'),status=document.querySelector('#status'),select=document.querySelector('#scene'),toggle=document.querySelector('#toggle');
let engine,ready=false,enabled=true,submitted=0,busy=false;
async function asset(mode){
 const vertices=[],indices=[];
 function quad(points,uv=.125){const a=points[0],b=points[1],c=points[2],u=b.map((v,i)=>v-a[i]),v=c.map((v,i)=>v-a[i]);let n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];const length=Math.hypot(...n);n=n.map(x=>x/length);const t=u.map(x=>x/Math.hypot(...u));const start=vertices.length/16;for(const p of points)vertices.push(...p,...n,uv,.5,...t,1,1,1,1,1);indices.push(start,start+1,start+2,start,start+2,start+3);}
 quad([[-2,0,2],[2,0,2],[2,0,-2],[-2,0,-2]]);
 quad([[-2,3,-2],[2,3,-2],[2,3,2],[-2,3,2]]);
 quad([[-2,0,-2],[2,0,-2],[2,3,-2],[-2,3,-2]]);
 quad([[-2,0,2],[-2,0,-2],[-2,3,-2],[-2,3,2]]);
 quad([[2,0,-2],[2,0,2],[2,3,2],[2,3,-2]]);
 quad([[-1.98,.8,-.1],[-1.98,.8,-1.5],[-1.98,2.4,-1.5],[-1.98,2.4,-.1]],.375);
 quad([[1.98,.8,-1.5],[1.98,.8,-.1],[1.98,2.4,-.1],[1.98,2.4,-1.5]],.625);
 // Neutral center pedestal provides differently oriented receivers and an occluder.
 quad([[-.4,0,.1],[.4,0,.1],[.4,1.1,.1],[-.4,1.1,.1]]);
 quad([[.4,0,-.7],[-.4,0,-.7],[-.4,1.1,-.7],[.4,1.1,-.7]]);
 quad([[-.4,0,-.7],[-.4,0,.1],[-.4,1.1,.1],[-.4,1.1,-.7]]);
 quad([[.4,0,.1],[.4,0,-.7],[.4,1.1,-.7],[.4,1.1,.1]]);
 quad([[-.4,1.1,.1],[.4,1.1,.1],[.4,1.1,-.7],[-.4,1.1,-.7]]);
 if(mode==='blocked'){
 quad([[-1.9,0,2],[-1.9,0,-2],[-1.9,3,-2],[-1.9,3,2]]);
 quad([[1.9,0,-2],[1.9,0,2],[1.9,3,2],[1.9,3,-2]]);
 }
 const palette=document.createElement('canvas');palette.width=4;palette.height=1;const ctx=palette.getContext('2d');ctx.fillStyle='black';ctx.fillRect(0,0,4,1);
 ctx.fillStyle=mode==='blue'?'black':mode==='green-magenta'?'#20ff30':'#ff2020';ctx.fillRect(1,0,1,1);
 ctx.fillStyle=mode==='red'?'black':mode==='green-magenta'?'#ff20ff':'#2040ff';ctx.fillRect(2,0,1,1);
 const blob=await new Promise(r=>palette.toBlob(r));const bytes=new Uint8Array(await blob.arrayBuffer());
 const material={name:'neutral room and emissive atlas',baseColorFactor:[.65,.65,.65,1],metallicFactor:0,roughnessFactor:1,emissiveFactor:[1,1,1],emissiveStrength:5,normalScale:1,occlusionStrength:1,alphaMode:'OPAQUE',alphaCutoff:.5,doubleSided:true,emissiveTexture:{image:0,sampler:{minFilter:9728,magFilter:9728,wrapS:33071,wrapT:33071}}};
 const result=createMeshAsset({meshes:[{name:'room',vertices:new Float32Array(vertices),indices:new Uint32Array(indices),material:0}],materials:[material],images:[{name:'generated emission palette',mimeType:'image/png',width:4,height:1,bytes}],maxTextureDimension:4});
 // This exact static tracing profile retains no animation/deformation state.
 const {rig,...plain}=result;return {...plain,primitives:result.primitives.map(({deformation,...p})=>p)};
}
async function load(){ready=false;select.disabled=true;status.textContent='Preparing exact static tracing…';try{await engine.setScene({renderer:'imported',asset:await asset(select.value),indirect:{maxPixels:57600,pixelBatch:57600,maxSamples:512,maxVisits:512,spatialDenoise:true}});submitted=0;ready=true;}catch(e){status.textContent=e.message;console.error(e);}finally{select.disabled=false;}}
function render(){engine.render({temporal:false,imported:{camera:{eye:[0,1.3,4.6],target:[0,1.15,-.6],verticalFov:.95},lighting:{directionToLight:[0,1,0],color:[1,1,1],intensity:0,ambient:[0,0,0],environment:null},background:[.005,.005,.005],indirect:{enabled,denoise:'spatial'}}});submitted++;}
async function frame(){requestAnimationFrame(frame);if(!ready||busy||document.hidden||submitted>=544)return;busy=true;try{render();await engine.waitForIdle();status.textContent=`${enabled?'Traced colored bounce':'Direct emission only'} · ${submitted} submissions · GPU errors: ${engine.getTelemetry().gpuErrorCount}`;}catch(e){ready=false;status.textContent=e.message;}finally{busy=false;}}
toggle.onclick=()=>{enabled=!enabled;toggle.textContent=enabled?'Show direct only':'Show GI';submitted=0;};select.onchange=load;
window.lightingLab={get report(){return{ready,submitted,enabled,telemetry:engine?.getTelemetry()};},async capture(mode,on=true){ready=false;while(busy)await new Promise(r=>setTimeout(r,10));select.value=mode;enabled=on;await load();ready=false;for(let i=0;i<528;i++){render();await engine.waitForIdle();}return this.report;}};
try{engine=await createEngine({canvas});await load();requestAnimationFrame(frame);}catch(e){status.textContent=e.message;console.error(e);}
