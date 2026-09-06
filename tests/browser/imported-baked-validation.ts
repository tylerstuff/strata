/** Public-package baked diffuse pixels against an independent scalar reference. */
export async function validateImportedBaked() {
  const entry='/packages/core/dist/index.js';
  const {createEngine,createMeshAsset}=await import(/* @vite-ignore */ entry);
  const gltfEntry='/packages/core/dist/gltf.js';
  const {estimateImportedTextureAllocation}=await import(/* @vite-ignore */ gltfEntry);
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
    // UV0 is constant and unrelated to the lightmap. UV1 selects four known HDR texels.
    const atlas=document.createElement('canvas');atlas.width=atlas.height=2;
    const ac=atlas.getContext('2d')!;const pixels=new Uint8ClampedArray([128,32,16,128, 16,128,32,64, 32,16,128,192, 64,96,32,255]);
    ac.putImageData(new ImageData(pixels,2,2),0,0);
    const blob=await new Promise<Blob>(resolve=>atlas.toBlob(b=>resolve(b!),'image/png'));
    const image={name:'generated RGBM',mimeType:'image/png' as const,bytes:new Uint8Array(await blob.arrayBuffer()),width:2,height:2};
    const lm={...asset,images:[image],maxTextureDimension:1,materials:[{...asset.materials[0],lightmapRange:4,lightmapTexture:{image:0,sampler:{wrapS:33071,wrapT:33071,magFilter:9729,minFilter:9729}}}],primitives:asset.primitives.map((p:any)=>({...p,vertices:p.vertices.map((v:number,i:number)=>i%16>=12?1:v),lightmapUvs:new Float32Array([.25,.25,.25,.25,.25,.25])}))};
    const estimate=estimateImportedTextureAllocation(lm,{maxTextureDimension:1,maxTextureDimension2D:8192});
    if(estimate.textures[0].uploadWidth!==2||estimate.textures[0].mipLevels!==1)throw Error('Lightmap was resized or mipmapped');
    for(const uv of [[.25,.25],[.75,.25],[.25,.75],[.75,.75],[.5,.5]]) {
      const current={...lm,primitives:lm.primitives.map((p:any)=>({...p,lightmapUvs:new Float32Array([...uv,...uv,...uv])}))};
      await engine.setScene({renderer:'imported',asset:current});
      engine.render({temporal:false,imported:{bakedVertexLighting:null,presentation:'model-only',camera:{eye:[0,0,3],target:[0,0,0],verticalFov:1},lighting:{directionToLight:[0,1,0],color:[1,1,1],intensity:0,ambient:[0,0,0],environment:null}}});
      ctx.drawImage(canvas,0,0);const pixel=[...ctx.getImageData(32,32,1,1).data];
      const idx=(uv[1]!>.5?2:0)+(uv[0]!>.5?1:0);
      const encoded=uv[0]===.5?[0,1,2,3].map(c=>[0,1,2,3].reduce((sum,t)=>sum+pixels[t*4+c]!,0)/4):[...pixels.slice(idx*4,idx*4+4)];
      const expected=[0,1,2].map(i=>display((uv[0]===.5?[0,1,2,3].reduce((sum,t)=>sum+pixels[t*4+i]!/255*pixels[t*4+3]!/255,0)/4:encoded[i]!/255*encoded[3]!/255)*4*[.5,.7,.9][i]!));
      if(expected.some((v,i)=>Math.abs(v-pixel[i]!)>3))throw Error(`Lightmap RGBM/UV mismatch ${JSON.stringify({uv,pixel,expected})}`);
      reports.push({intensity:4,pixel,expected});
    }
    await engine.waitForIdle();if(engine.getTelemetry().gpuErrorCount)throw Error('Baked GPU validation errors');
    return {status:'passed',reports};
  } finally {await engine.dispose();canvas.remove();}
}
