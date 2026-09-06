/** Generated geometry only: local shadows, all cube directions, moving cache and light controls. */
export async function validatePointShadow() {
  const entry = '/packages/core/dist/index.js';
  const {createEngine,createMeshAsset,combineImportedAssets}=await import(/* @vite-ignore */ entry);
  const mat={name:'diffuse',baseColorFactor:[.6,.6,.6,1],metallicFactor:0,roughnessFactor:1,emissiveFactor:[0,0,0],emissiveStrength:1,normalScale:1,occlusionStrength:1,alphaMode:'OPAQUE',alphaCutoff:.5,doubleSided:true,localLighting:true};
  const triangle=(name:string,points:number[][],normal=[0,0,1])=>createMeshAsset({meshes:[{name,vertices:new Float32Array(points.flatMap(p=>[...p,...normal,0,0,1,0,0,1,1,1,1,1])),indices:new Uint32Array([0,1,2]),material:0}],materials:[mat]});
  const fixed=(a:any)=>({...a,rig:undefined,primitives:a.primitives.map(({deformation,...p}:any)=>p)});
  const receiver=fixed(triangle('receiver',[[-3,-3,-1],[3,-3,-1],[0,3,-1]]));
  const actor=triangle('caster',[[-.3,-.4,0],[.3,-.4,0],[0,.4,0]]);
  const mixed=combineImportedAssets(receiver,actor,{localLighting:true});
  const canvas=document.createElement('canvas');canvas.width=canvas.height=128;document.body.append(canvas);
  const reader=document.createElement('canvas');reader.width=reader.height=128;const ctx=reader.getContext('2d')!;
  const engine=await createEngine({canvas,profiling:true});let tick=0;
  const point={id:'lamp',position:[1,0,1],color:[1,.2,.05],intensity:8,range:10,shadowMapSize:512};
  const controls={background:[0,0,0],camera:{eye:[0,0,3],target:[0,0,-1],verticalFov:1},lighting:{directionToLight:[0,1,1],color:[1,1,1],intensity:0,ambient:[0,0,0],environment:null}};
  const render=(x=0,p=point)=>{
    const frame=engine.render({timeSeconds:tick++/60,temporal:false,imported:{...controls,placement:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,x,0,0,1]),pointLight:p}});
    ctx.drawImage(canvas,0,0);return {frame,pixels:[...ctx.getImageData(0,0,128,128).data]};
  };
  const observations:any[]=[];
  try {
    await engine.setScene({renderer:'imported',asset:mixed,pointLight:point,shadowMapSize:1024});
    const frames:number[][]=[];
    for(const x of [-.5,.5,-.5]) {
      const cached=render(x);await engine.waitForIdle();
      await engine.setScene({renderer:'imported',asset:mixed,pointLight:point,shadowMapSize:1024});
      const fresh=render(x);
      if(cached.pixels.some((v,i)=>v!==fresh.pixels[i]))throw Error('Point cache differs from fresh scene at '+x);
      frames.push(cached.pixels);observations.push({x,draws:cached.frame.drawCalls,freshDraws:fresh.frame.drawCalls});
    }
    if(frames[0]!.every((v,i)=>v===frames[1]![i]))throw Error('Actor movement made no visible difference');
    if(frames[0]!.some((v,i)=>v!==frames[2]![i]))throw Error('Stale moving point silhouette');
    // A fixed receiver's lighting differs with a caster: compare pixels away from actor projection.
    const blocked=render(0).pixels;
    await engine.setScene({renderer:'imported',asset:receiver,pointLight:point,shadowMapSize:1024});
    const lit=render(0).pixels;let shadowPixels=0;
    for(let y=40;y<88;y++)for(let x=28;x<50;x++){const i=(y*128+x)*4;if(lit[i]!>blocked[i]!+25)shadowPixels++;}
    if(shadowPixels<15)throw Error('No visible point shadow on fixed receiver: '+shadowPixels);
    const off=render(0,{...point,intensity:0}).pixels;
    if(off.some((v,i)=>i%4!==3&&v>1))throw Error('Disabled local light remained visible');
    // All six signed directions: lit receiver center must survive face projection and self-shadowing.
    const axes=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],[1,0,1],[1,1,0],[0,-1,-1],[1,1,1]].map(d=>{const l=Math.hypot(...d);return d.map(v=>v/l);});
    for(const [face,d] of axes.entries()) {
      const n=d.map(v=>-v),right=Math.abs(d[1]!)===1?[1,0,0]:[d[2]!,0,-d[0]!],u=right.map(v=>v/Math.hypot(...right));
      const v=[n[1]!*u[2]!-n[2]!*u[1]!,n[2]!*u[0]!-n[0]!*u[2]!,n[0]!*u[1]!-n[1]!*u[0]!];
      const points=[[-1,-1],[1,-1],[0,1]].map(q=>d.map((a,i)=>a*2+u[i]!*q[0]!+v[i]!*q[1]!));
      await engine.setScene({renderer:'imported',asset:fixed(triangle('face',points,n)),pointLight:{...point,position:[0,0,0]},shadowMapSize:1024});
      // Avoid camera look-at's fixed-up singularity on the vertical faces.
      engine.render({timeSeconds:tick++/60,temporal:false,imported:{...controls,camera:{eye:[.1,.1,.1],target:d.map(a=>a*2),verticalFov:1}}});
      ctx.drawImage(canvas,0,0);const pixel=[...ctx.getImageData(64,64,1,1).data];
      if(pixel[0]!<80||pixel[0]!<=pixel[2]!)throw Error('Point face orientation or acne '+JSON.stringify({face,pixel}));
      observations.push({face,pixel});
    }
    await engine.waitForIdle();const telemetry=engine.getTelemetry();if(telemetry.gpuErrorCount)throw Error('GPU error '+JSON.stringify(telemetry.lastGpuError));
    await engine.dispose();const disposed=engine.getTelemetry();if(disposed.allocatedGpuBufferBytes||disposed.allocatedGpuTextureBytes)throw Error('Point resources leaked');
    return {status:'passed',scope:'Generated six-face point lighting, shadow reception, moving/fresh cache equality, disabled light and lifecycle; not a performance result',shadowPixels,observations};
  } finally {await engine.dispose();canvas.remove();}
}
