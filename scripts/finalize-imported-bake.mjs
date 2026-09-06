import {readFile,writeFile,rename} from 'node:fs/promises';
import {resolve,dirname,relative,sep} from 'node:path';
/** Retain the input material/texture contract instead of Blender's repacked samplers. */
export async function finalizeBake(input,output) {
  const source=JSON.parse(await readFile(input,'utf8'));
  const path=resolve(output,'scene.gltf'),baked=JSON.parse(await readFile(path,'utf8'));
  const byName=new Map(source.materials.map((m,i)=>[m.name,i]));
  const manifest=JSON.parse(await readFile(resolve(output,'bake.pending.json'),'utf8'));
  const lightmap=manifest.format==='strata-baked-lightmap-diffuse';
  const remap=baked.materials.map(m=>{const index=byName.get(m.name);if(index===undefined)throw Error(`Unknown exported material ${m.name}`);return index;});
  for(const mesh of baked.meshes)for(const primitive of mesh.primitives){
    if(primitive.attributes[lightmap?'TEXCOORD_1':'COLOR_0']===undefined)throw Error('Export omitted baked vertex colors.');
    primitive.material=remap[primitive.material];
  }
  baked.materials=structuredClone(source.materials);
  for(const material of baked.materials)if(material.emissiveFactor?.some(v=>v>0)) {
    material.extensions??={};const strength=material.extensions.KHR_materials_emissive_strength?.emissiveStrength??1;
    material.extensions.KHR_materials_emissive_strength={emissiveStrength:strength*manifest.emissionScale};
  }
  baked.samplers=source.samplers;baked.textures=source.textures;
  baked.images=source.images?.map(image=>{
    if(!image.uri||image.uri.startsWith('data:'))throw Error('Initial bake profile requires external image files.');
    return {...image,uri:relative(output,resolve(dirname(input),decodeURIComponent(image.uri))).split(sep).map(encodeURIComponent).join('/')};
  });
  if(lightmap) {
    baked.images??=[];baked.textures??=[];baked.samplers??=[];
    for(const atlas of manifest.atlases){
      const index=baked.textures.length;
      baked.textures.push({source:baked.images.length,sampler:baked.samplers.length});
      baked.images.push({uri:atlas.image});
      baked.samplers.push({wrapS:33071,wrapT:33071,magFilter:9729,minFilter:9729});
      const m=baked.materials.find(m=>m.name===atlas.material);
      if(!m)throw Error('Unknown lightmap receiver material');
      m.extensions??={};m.extensions.EXT_strata_lightmap={version:1,encoding:'rgbm',range:atlas.range,texture:{index,texCoord:1}};
    }
    baked.extensionsRequired=[...new Set([...(baked.extensionsRequired??[]),'EXT_strata_lightmap'])];
  }
  baked.extensionsUsed=[...new Set([...(source.extensionsUsed??[]),...(baked.extensionsUsed??[]),'KHR_materials_emissive_strength',...(lightmap?['EXT_strata_lightmap']:[])])];
  await writeFile(path,JSON.stringify(baked));
  await rename(resolve(output,'bake.pending.json'),resolve(output,'bake.json'));
}
