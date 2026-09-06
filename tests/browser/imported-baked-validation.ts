/** Public-package baked diffuse pixels against an independent scalar reference. */
export async function validateImportedBaked() {
  const entry='/packages/core/dist/index.js';
  const {createEngine,createMeshAsset}=await import(/* @vite-ignore */ entry);
  const canvas=document.createElement('canvas');canvas.width=canvas.height=64;document.body.append(canvas);
  const reader=document.createElement('canvas');reader.width=reader.height=64;const ctx=reader.getContext('2d')!;
  const engine=await createEngine({canvas});const reports=[];
  const display=(v:number)=>{const t=Math.max(0,Math.min(1,v*(2.51*v+.03)/(v*(2.43*v+.59)+.14)));return 255*(t<=.0031308?t*12.92:1.055*t**(1/2.4)-.055);};
  try {
    const rgb=[.2,.03,.4];
    const vertices=new Float32Array([[-2,-2,0],[2,-2,0],[0,2,0]].flatMap(p=>[...p,0,0,1,0,0,1,0,0,1,...rgb,1]));
    const result=createMeshAsset({meshes:[{name:'receiver',vertices,indices:new Uint32Array([0,1,2]),material:0}],materials:[{name:'matte',baseColorFactor:[.5,.7,.9,1],metallicFactor:0,roughnessFactor:1,emissiveFactor:[0,0,0],emissiveStrength:1,normalScale:1,occlusionStrength:1,alphaMode:'OPAQUE',alphaCutoff:.5,doubleSided:false}]});
    const {rig,...plain}=result;const asset={...plain,primitives:result.primitives.map(({deformation,...p}:any)=>p)};
    await engine.setScene({renderer:'imported',asset});
    for(const intensity of [1,0,2,1]) {
      engine.render({temporal:false,imported:{bakedVertexLighting:{intensity},presentation:'model-only',camera:{eye:[0,0,3],target:[0,0,0],verticalFov:1},lighting:{directionToLight:[0,1,0],color:[1,1,1],intensity:0,ambient:[0,0,0],environment:null}}});
      ctx.drawImage(canvas,0,0);const pixel=[...ctx.getImageData(32,32,1,1).data];
      const expected=rgb.map((v,i)=>display(v*[.5,.7,.9][i]!*intensity));
      if(expected.some((v,i)=>Math.abs(v-pixel[i]!)>2))throw Error(`Baked diffuse color/intensity mismatch ${JSON.stringify({pixel,expected})}`);
      reports.push({intensity,pixel,expected});
    }
    await engine.waitForIdle();if(engine.getTelemetry().gpuErrorCount)throw Error('Baked GPU validation errors');
    return {status:'passed',reports};
  } finally {await engine.dispose();canvas.remove();}
}
