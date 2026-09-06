import { radiance } from '../../scripts/imported-environment-bake.mjs';
/** Public package pixels against the independent CPU environment source. */
export async function validateImportedSky() {
  const entry = '/packages/core/dist/index.js';
  const { createEngine, createMeshAsset } = await import(/* @vite-ignore */ entry);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64; document.body.append(canvas);
  const engine = await createEngine({ canvas });
  const reader = document.createElement('canvas'); reader.width = reader.height = 64; const ctx = reader.getContext('2d')!;
  const display = (v: number) => { const t = Math.max(0, Math.min(1, v * (2.51 * v + .03) / (v * (2.43 * v + .59) + .14))); return t <= .0031308 ? t * 12.92 : 1.055 * t ** (1 / 2.4) - .055; };
  const normalize = (v: number[]) => { const length = Math.hypot(...v); return v.map(x => x / length); };
  const reports = [];
  try {
    const vertices = new Float32Array([[-.2,-.2,0],[.2,-.2,0],[0,.2,0]].flatMap(p => [...p,0,0,1,0,0,1,0,0,1,1,1,1,1]));
    const material = { name:'blue',baseColorFactor:[0,0,1,1],metallicFactor:0,roughnessFactor:1,emissiveFactor:[0,0,0],emissiveStrength:1,normalScale:1,occlusionStrength:1,alphaMode:'OPAQUE',alphaCutoff:.5,doubleSided:false,unlit:true };
    await engine.setScene({ renderer:'imported',asset:createMeshAsset({ meshes:[{ name:'triangle',vertices,indices:new Uint32Array([0,1,2]),material:0 }],materials:[material] }) });
    for (const preset of ['sky','studio'] as const) for (const angle of [0,.8]) for (const translation of [0,3]) {
      const camera={eye:[translation,0,3],target:[translation,0,0],verticalFov:1};
      engine.render({temporal:false,imported:{camera,skybox:true,lighting:{directionToLight:[0,1,0],color:[1,1,1],intensity:0,ambient:[0,0,0],environment:{preset,intensity:.65,rotationRadians:angle}}}});
      ctx.drawImage(canvas,0,0);const pixel=[...ctx.getImageData(8,8,1,1).data];
      const d=normalize([(8.5/64*2-1)*Math.tan(.5),(1-8.5/64*2)*Math.tan(.5),-1]);
      const rotated=[Math.cos(angle)*d[0]!-Math.sin(angle)*d[2]!,d[1]!,Math.sin(angle)*d[0]!+Math.cos(angle)*d[2]!];
      const expected=radiance(preset,rotated).map(v=>display(v*.65)*255);
      const error=Math.max(...expected.map((v,i)=>Math.abs(v-pixel[i]!)));
      if(error>2)throw Error(`Sky source/camera/rotation mismatch: ${JSON.stringify({preset,angle,translation,pixel,expected,error})}`);
      reports.push({preset,angle,translation,error});
      if(translation===0){const center=ctx.getImageData(32,32,1,1).data;if(center[2]!<200||center[0]!>2)throw Error('Sky overwrote foreground geometry.');}
    }
    for(let frame=0;frame<8;frame++) {
      engine.render({temporal:true});ctx.drawImage(canvas,0,0);
      const pixel=[...ctx.getImageData(8,8,1,1).data];
      const d=normalize([(8.5/64*2-1)*Math.tan(.5),(1-8.5/64*2)*Math.tan(.5),-1]);
      const rotated=[Math.cos(.8)*d[0]!-Math.sin(.8)*d[2]!,d[1]!,Math.sin(.8)*d[0]!+Math.cos(.8)*d[2]!];
      if(radiance('studio',rotated).some((v,i)=>Math.abs(display(v*.65)*255-pixel[i]!)>2))throw Error('Sky moved with temporal jitter.');
    }
    engine.render({temporal:false,debugView:'normal'});ctx.drawImage(canvas,0,0);
    if([...ctx.getImageData(8,8,1,1).data].slice(0,3).some(v=>v!==0))throw Error('Sky contaminated normal diagnostics.');
    engine.render({temporal:false,imported:{skybox:false,background:[0,0,0]}});ctx.drawImage(canvas,0,0);
    if([...ctx.getImageData(8,8,1,1).data].slice(0,3).some(v=>v!==0))throw Error('Sky disable failed.');
    await engine.waitForIdle();if(engine.getTelemetry().gpuErrorCount)throw Error(engine.getTelemetry().lastGpuError);
    return {status:'passed',reports,scope:'Public sky/studio source, yaw, translation invariance, foreground depth, raw diagnostic exclusion and disposal. No performance claim.'};
  } finally {engine.dispose();const t=engine.getTelemetry();if(t.allocatedGpuBufferBytes||t.allocatedGpuTextureBytes||t.wasmMemoryBytes)throw Error('Sky resources retained after disposal.');canvas.remove();}
}
