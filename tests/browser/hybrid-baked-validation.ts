/** Public installed-package mixed-scene color, visibility, movement and lifetime witnesses. */
export async function validateHybridBaked() {
  const entry = '/packages/core/dist/index.js';
  const {createEngine, createMeshAsset, combineImportedAssets} = await import(/* @vite-ignore */ entry);
  const material = {name:'matte',baseColorFactor:[.5,.5,.5,1],metallicFactor:0,roughnessFactor:1,emissiveFactor:[0,0,0],emissiveStrength:1,normalScale:1,occlusionStrength:1,alphaMode:'OPAQUE',alphaCutoff:.5,doubleSided:false};
  const vertices = (points:number[][]) => new Float32Array(points.flatMap(p=>[...p,0,0,1,0,0,1,0,0,1,1,1,1,1]));
  const make = (name:string,points:number[][]) => createMeshAsset({meshes:[{name,vertices:vertices(points),indices:new Uint32Array([0,1,2]),material:0}],materials:[material]});
  const source=make('static wall',[[-2,-2,-2],[2,-2,-2],[0,2,-2]]);
  const {rig,...plain}=source;
  const environment={...plain,primitives:source.primitives.map(({deformation,...p}:any)=>p)};
  const actor=make('actor',[[-.2,-.3,0],[.2,-.3,0],[0,.3,0]]);
  const mixed=combineImportedAssets(environment,actor,{bakedProbeLighting:true});
  const irradiance=Array.from({length:8*18},(_,i)=>{const probe=Math.floor(i/18),channel=i%3,face=Math.floor(i%18/3);return face===4?((channel===0&&probe%2===0)||(channel===2&&probe%2===1)?.8:0):.1;});
  const volume={version:1,revision:'generated-v1',origin:[-1,-1,-1],spacing:[2,2,2],counts:[2,2,2],irradiance,visibility:Array(8*256).fill(8),valid:Array(8).fill(1)};
  const canvas=document.createElement('canvas');canvas.width=canvas.height=128;document.body.append(canvas);
  const reader=document.createElement('canvas');reader.width=reader.height=128;const ctx=reader.getContext('2d')!;
  const engine=await createEngine({canvas,profiling:true});const observations=[];
  const display=(v:number)=>{const t=Math.max(0,Math.min(1,v*(2.51*v+.03)/(v*(2.43*v+.59)+.14)));return 255*(t<=.0031308?t*12.92:1.055*t**(1/2.4)-.055);};
  let tick=0;
  const render=async(x:number,enabled=true,revision='generated-v1')=>{
    const frame=engine.render({timeSeconds:tick++/60,temporal:false,imported:{placement:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,x,0,0,1]),bakedProbes:{revision,enabled},camera:{eye:[x,0,1],target:[x,0,0],verticalFov:1},lighting:{directionToLight:[0,1,1],color:[1,1,1],intensity:0,ambient:[0,0,0],environment:null}}});
    ctx.drawImage(canvas,0,0);return{frame,pixel:[...ctx.getImageData(64,64,1,1).data]};
  };
  try {
    await engine.setScene({renderer:'imported',asset:mixed,bakedProbes:volume,shadowMapSize:1024});
    const before=engine.getTelemetry();
    for(const x of [-.5,0,.5,-.5]) {
      const result=await render(x);
      const worldX=x+Math.tan(.5)/128;const fraction=(worldX+1)/2;
      const expected=[display(.4*(1-fraction)),0,display(.4*fraction)];
      if(expected.some((v,c)=>Math.abs(v-result.pixel[c]!)>3))throw Error('Probe interpolation/material mismatch '+JSON.stringify({x,...result,expected}));
      observations.push({x,...result,expected});
    }
    const after=engine.getTelemetry();
    if(before.scene.identity.sceneGeneration!==after.scene.identity.sceneGeneration||before.allocatedGpuBufferBytes!==after.allocatedGpuBufferBytes)throw Error('Movement recreated the scene/resources');
    // Static cache is reused but moving shadow geometry is still submitted.
    if(observations[1]!.frame.drawCalls!==observations[0]!.frame.drawCalls-1)throw Error('Static caster draw was not skipped');
    const off=await render(0,false);if(Math.max(...off.pixel.slice(0,3))>1)throw Error('Probe off comparison remained lit');
    let rejected=false;try{await render(0,true,'wrong-revision');}catch{rejected=true;}if(!rejected)throw Error('Stale bake accepted');
    const restored=await render(0,true);if(restored.pixel[0]!<50)throw Error('Rejected frame corrupted probe state');
    await engine.setScene({renderer:'imported',asset:mixed,bakedProbes:{...volume,visibility:Array(8*256).fill(0)},shadowMapSize:1024});
    const blocked=await render(0);if(Math.max(...blocked.pixel.slice(0,3))>1)throw Error('Occluded probes leaked into receiver');
    await engine.setScene({renderer:'imported',asset:mixed,bakedProbes:volume,shadowMapSize:1024});
    const outside=await render(1.4);if(Math.max(...outside.pixel.slice(0,3))>1)throw Error('Outside grid clamped to edge light');
    // Compare cached moving shadows with a forced full redraw at each pose.
    // The receiver extends beyond the actor and stays fixed in world space.
    const receiver=make('receiver',[[-2,-2,-1],[2,-2,-1],[0,2,-1]]);
    const fixed={...receiver,rig:undefined,primitives:receiver.primitives.map(({deformation,...p}:any)=>p)};
    const caster=make('caster',[[-.2,-.3,0],[.2,-.3,0],[0,.3,0]]);
    await engine.setScene({renderer:'imported',asset:combineImportedAssets(fixed,caster),shadowMapSize:1024});
    const shadowFrames:number[][]=[];
    for(const x of [-.5,.5,-.5]) {
      const captures:number[][]=[];
      for(const cameraCut of [false,true]) {
        engine.render({timeSeconds:tick++/60,temporal:false,cameraCut,debugView:'shadow',imported:{placement:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,x,0,0,1]),camera:{eye:[0,0,3],target:[0,0,0],verticalFov:1},lighting:{directionToLight:[.5,0,1],color:[1,1,1],intensity:2,ambient:[0,0,0],environment:null}}});
        ctx.drawImage(canvas,0,0);captures.push([...ctx.getImageData(0,0,128,128).data]);
      }
      if(captures[0]!.some((v,i)=>v!==captures[1]![i]))throw Error('Cached shadows differ from a fresh static/dynamic redraw');
      shadowFrames.push(captures[0]!);
    }
    if(shadowFrames[0]!.every((v,i)=>v===shadowFrames[1]![i]))throw Error('Moving caster produced no visible shadow change');
    if(shadowFrames[0]!.some((v,i)=>v!==shadowFrames[2]![i]))throw Error('Returning actor left stale silhouettes');
    await engine.waitForIdle();const telemetry=engine.getTelemetry();if(telemetry.gpuErrorCount)throw Error('Hybrid GPU errors '+JSON.stringify(telemetry.lastGpuError));
    await engine.dispose();const disposed=engine.getTelemetry();if(disposed.allocatedGpuBufferBytes||disposed.allocatedGpuTextureBytes)throw Error('Hybrid resources leaked');
    return {status:'passed',scope:'Generated six-axis probe colors, visibility negative controls, revision/placement, static shadow draw reuse and lifecycle; not a performance result',observations,off,blocked,outside};
  } finally {await engine.dispose();canvas.remove();}
}
