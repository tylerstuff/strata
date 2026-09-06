/** Generated fixtures through the built public package; no downloaded images. */
export async function validateCompressedTextures() {
  const coreEntry = '/packages/core/dist/index.js', gltfEntry = '/packages/core/dist/gltf.js';
  const { createEngine, createMeshAsset } = await import(/* @vite-ignore */ coreEntry);
  const { parseDdsMipChain, estimateImportedTextureAllocation } = await import(/* @vite-ignore */ gltfEntry);
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter.');
  const supported = adapter.features.has('texture-compression-bc');
  const imageCanvas = document.createElement('canvas'); imageCanvas.width = imageCanvas.height = 8;
  const ctx = imageCanvas.getContext('2d')!; ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 8, 8);
  const blob = await new Promise<Blob>(resolve => imageCanvas.toBlob(b => resolve(b!), 'image/png'));
  const png = new Uint8Array(await blob.arrayBuffer());
  const vertices = new Float32Array([[-1,-1], [1,-1], [1,1], [-1,1]].flatMap(([x,y]) => [x!,y!,0, 0,0,1, (x!+1)/2,(1-y!)/2, 1,0,0,1, 1,1,1,1]));
  const sampler = { minFilter: 9728, magFilter: 9728, wrapS: 10497, wrapT: 10497 }, ref = { image: 0, sampler };
  const baseMaterial = { name: 'generated', baseColorFactor: [1,1,1,1], metallicFactor: 0, roughnessFactor: .7, emissiveFactor: [0,0,0], emissiveStrength: 1, normalScale: 1, occlusionStrength: 1, alphaMode: 'OPAQUE', alphaCutoff: .5, doubleSided: false };
  function dds(code: string) {
    const block = code === 'DXT1' ? 8 : 16, bytes = new Uint8Array(128 + 7 * block), v = new DataView(bytes.buffer);
    for (const [offset, value] of [[0,0x20534444],[4,124],[12,8],[16,8],[28,4],[76,32],[80,4]]) v.setUint32(offset!,value!,true);
    bytes.set([...code].map(c=>c.charCodeAt(0)),84);
    let offset = 128;
    for (let level=0;level<4;level++) for(let b=0;b<(level===0?4:1);b++) {
      if(code==='ATI2'){bytes[offset]=bytes[offset+1]=191;bytes[offset+8]=bytes[offset+9]=64;}
      else {const colorOffset=offset+(code==='DXT5'?8:0);v.setUint16(colorOffset,level===0?0xf800:0x07e0,true);v.setUint16(colorOffset+2,0,true);}
      offset+=block;
    }
    return bytes;
  }
  const reports=[];
  for(const enabled of supported?[false,true]:[false]) {
    const canvas=document.createElement('canvas');canvas.width=canvas.height=64;document.body.append(canvas);
    const engine=await createEngine({canvas,requiredFeatures:enabled?['texture-compression-bc']:[]});
    try {
      for(const code of enabled?['DXT1','DXT5','ATI2']:['DXT1']) {
        const parsed=parseDdsMipChain(dds(code),code==='ATI2'?{normalY:'down'}:{});
        const material={...baseMaterial,...(code==='ATI2'?{normalTexture:ref}:{baseColorTexture:ref,unlit:true}),...(code==='DXT5'?{alphaMode:'MASK'}:{})};
        const asset=createMeshAsset({meshes:[{name:'quad',vertices,indices:new Uint32Array([0,1,2,0,2,3]),material:0}],materials:[material],images:[{name:'generated',mimeType:'image/png',bytes:png,width:8,height:8,compressed:parsed.compressed}],maxTextureDimension:4});
        const plan=estimateImportedTextureAllocation(asset,{maxTextureDimension:4,maxTextureDimension2D:8192,textureCompressionBC:enabled});
        await engine.setScene({renderer:'imported',asset});
        engine.render({temporal:false,debugView:code==='ATI2'?'normal':'final',imported:{camera:{eye:[0,0,3],target:[0,0,0],verticalFov:1},background:[0,0,0]}});
        const read=document.createElement('canvas');read.width=read.height=64;const r=read.getContext('2d')!;r.drawImage(canvas,0,0);const pixel=[...r.getImageData(32,32,1,1).data];
        await engine.waitForIdle();
        if(!enabled && !(pixel[2]!>200 && pixel[0]!<3 && pixel[1]!<3))throw new Error(`PNG fallback mismatch ${pixel}`);
        if(enabled && code==='DXT1' && !(pixel[1]!>200 && pixel[0]!<3 && pixel[2]!<3))throw new Error(`Selected compressed mip/sRGB mismatch ${pixel}`);
        if(enabled && code==='DXT5' && pixel.slice(0,3).some(v=>v>3))throw new Error(`BC3 alpha mask mismatch ${pixel}`);
        if(code==='ATI2' && !(Math.abs(pixel[0]!-191)<3 && Math.abs(pixel[1]!-191)<3 && Math.abs(pixel[2]!-218)<3))throw new Error(`BC5 normal convention mismatch ${pixel}`);
        const telemetry=engine.getTelemetry();if(telemetry.gpuErrorCount)throw new Error(telemetry.lastGpuError);
        const textures=telemetry.imported?.textures??[];
        reports.push({enabled,code,pixel,plan,textures});
      }
    }finally{engine.dispose();const t=engine.getTelemetry();if(t.allocatedGpuBufferBytes||t.allocatedGpuTextureBytes||t.wasmMemoryBytes)throw new Error('Retained resources after disposal.');canvas.remove();}
  }
  return {status:'passed',bcSupported:supported,compressedCases:supported?'passed':'unavailable',reports,scope:'Generated public-package fallback, selected compressed mip, BC3 alpha, BC5 orientation, allocation and disposal; no performance claim.'};
}
