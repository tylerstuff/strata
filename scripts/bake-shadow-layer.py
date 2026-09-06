"""Bake one emissive source's direct diffuse on existing lightmap UVs; never re-unwrap."""
import bpy,sys,pathlib,json,numpy as np,time,struct,zlib,hashlib,urllib.parse,os
source,config,output=map(pathlib.Path,sys.argv[sys.argv.index('--')+1:]);cfg=json.loads(config.read_text());doc=json.loads(source.read_text());start=time.time()
light=cfg['light'];bounds=np.array(cfg['emitterBounds'],dtype=float);scale=float(cfg['normalization']['scale']);translation=np.array(cfg['normalization']['translation'],dtype=float)
if bounds.shape!=(2,3) or not np.isfinite(bounds).all() or np.any(bounds[0]>=bounds[1]):raise ValueError('Invalid emitter bounds')
if not 1<=int(cfg.get('samples',128))<=4096 or scale<=0 or not np.isfinite(scale) or translation.shape!=(3,):raise ValueError('Invalid bake settings')
if not isinstance(cfg.get('revision'),str) or not 1<=len(cfg['revision'])<=128:raise ValueError('Explicit revision required')
if not isinstance(light.get('id'),str) or not 1<=len(light['id'])<=128:raise ValueError('Invalid light ID')
for key,minimum,maximum in [('position',-1024,1024),('color',0,1)]:
 values=np.array(light.get(key),dtype=float)
 if values.shape!=(3,) or not np.isfinite(values).all() or np.any(values<minimum) or np.any(values>maximum):raise ValueError('Invalid light vector')
if not np.isfinite(light['intensity']) or not 0<=light['intensity']<=64 or not np.isfinite(light['range']) or not .001<=light['range']<=1024:raise ValueError('Invalid light range/intensity')
if not np.isfinite(translation).all() or int(cfg.get('maxEdge',1024)) not in [128,256,512,1024,2048,4096]:raise ValueError('Invalid normalization/edge')
for item in doc.get('buffers',[])+doc.get('images',[]):
 if not isinstance(item.get('uri'),str) or ':' in item['uri']:raise ValueError('External relative file assets required')
if doc.get('animations') or doc.get('skins'):raise ValueError('Static lightmapped source required')
if not cfg.get('receivers') or not all(isinstance(n,str) for n in cfg['receivers']):raise ValueError('Named receiver materials required')
import_doc=json.loads(json.dumps(doc));import_doc['extensionsRequired']=[e for e in import_doc.get('extensionsRequired',[]) if e!='EXT_strata_lightmap']
for item in import_doc.get('buffers',[])+import_doc.get('images',[]):
 if 'uri' in item:item['uri']=urllib.parse.quote(os.path.relpath(source.parent/urllib.parse.unquote(item['uri']),output),safe='/')
import_path=output/'import-source.gltf';import_path.write_text(json.dumps(import_doc))
bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.import_scene.gltf(filepath=str(import_path));scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=int(cfg.get('samples',128));scene.cycles.device='CPU';scene.render.threads_mode='FIXED';scene.render.threads=6
prefs=bpy.context.preferences.addons['cycles'].preferences
try:
 prefs.compute_device_type='METAL';prefs.get_devices()
 if any(d.type=='METAL' for d in prefs.devices):
  for d in prefs.devices:d.use=d.type=='METAL'
  scene.cycles.device='GPU'
except (TypeError,RuntimeError):pass
scene.world=bpy.data.worlds.new('No baked sky');scene.world.use_nodes=True;scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value=0
for o in list(scene.objects):
 if o.type=='LIGHT':bpy.data.objects.remove(o,do_unlink=True)
original=bpy.data.materials.get(cfg['emitterMaterial'])
if not original:raise ValueError('Emitter material absent')
emitter=original.copy();emitter.name='Selected shadow lamp'
for m in bpy.data.materials:
 if m!=emitter and m.use_nodes:
  for n in m.node_tree.nodes:
   if n.type=='BSDF_PRINCIPLED':n.inputs['Emission Strength'].default_value=0
   elif n.type=='EMISSION':n.inputs['Strength'].default_value=0
meshes=[o for o in scene.objects if o.type=='MESH'];selected=0
for o in meshes:
 indices=np.empty(len(o.data.polygons),np.int32);o.data.polygons.foreach_get('material_index',indices)
 slots=[i for i,m in enumerate(o.data.materials) if m==original]
 if not slots:continue
 centers=np.empty(len(indices)*3,np.float32);o.data.polygons.foreach_get('center',centers);centers=centers.reshape(-1,3)
 matrix=np.array(o.matrix_world);world=centers@matrix[:3,:3].T+matrix[:3,3];normalized=world[:,[0,2,1]]*np.array([1,1,-1])*scale+translation
 mask=np.isin(indices,slots)&np.all(normalized>=bounds[0],axis=1)&np.all(normalized<=bounds[1],axis=1)
 if mask.any():
  indices[mask]=len(o.data.materials);o.data.materials.append(emitter);o.data.polygons.foreach_set('material_index',indices);selected+=int(mask.sum())
if selected==0:raise RuntimeError('No emitter faces selected')
print('STRATA_SHADOW_EMITTER_FACES',selected,flush=True)
# One bake target for every material; discarded targets do not enter the output asset.
targets={};records=[];source_by_name={m.get('name'):m for m in doc['materials']}
for m in bpy.data.materials:
 if not m.use_nodes:continue
 selected_receiver=m.name in cfg['receivers'];edge=1
 if selected_receiver:
  lm=source_by_name[m.name].get('extensions',{}).get('EXT_strata_lightmap')
  if not lm or lm['version']!=1:raise ValueError('Receiver needs an existing version-1 combined lightmap')
  uri=doc['images'][doc['textures'][lm['texture']['index']]['source']]['uri'];png=(source.parent/urllib.parse.unquote(uri)).read_bytes();w,h=struct.unpack('>II',png[16:24]);edge=min(max(w,h),int(cfg.get('maxEdge',1024)))
 image=bpy.data.images.new('Shadow contribution '+m.name,width=edge,height=edge,alpha=True,float_buffer=True);image.colorspace_settings.name='Non-Color'
 for n in m.node_tree.nodes:n.select=False
 node=m.node_tree.nodes.new('ShaderNodeTexImage');node.image=image;node.select=True;m.node_tree.nodes.active=node
 if selected_receiver:targets[m.name]=image;records.append({'material':m.name,'image':'shadow-layer-'+str(len(records))+'.png','edge':edge})
if set(targets)!=set(cfg['receivers']):raise ValueError('Receiver material absent')
for image in bpy.data.images:
 if image.source=='FILE' and max(image.size)>1024:
  w,h=image.size;s=1024/max(w,h);image.scale(max(1,int(w*s)),max(1,int(h*s)))
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
 if len(o.data.uv_layers)<2:raise ValueError('Existing lightmap UVs required')
 o.data.uv_layers[1].name='StrataShadowUV';o.select_set(True)
bpy.context.view_layer.objects.active=meshes[0];scene.render.bake.target='IMAGE_TEXTURES';scene.render.bake.margin=8;scene.render.bake.use_pass_color=False
print('STRATA_SHADOW_LAYER_BAKE',len(records),scene.cycles.device,flush=True)
bpy.ops.object.bake(type='DIFFUSE',pass_filter={'DIRECT'},uv_layer='StrataShadowUV')
def chunk(kind,payload):return struct.pack('>I',len(payload))+kind+payload+struct.pack('>I',zlib.crc32(kind+payload)&0xffffffff)
peak=0
for r in records:
 image=targets[r['material']];e=r['edge'];data=np.empty(e*e*4,np.float32);image.pixels.foreach_get(data);rgb=np.maximum(data.reshape(e,e,4)[:,:,:3],0)
 if not np.isfinite(rgb).all():raise RuntimeError('Nonfinite direct layer')
 maximum=float(rgb.max());peak=max(peak,maximum);decode=float(max(1,2**np.ceil(np.log2(max(1,maximum)))))
 if decode>65536:raise RuntimeError('Direct layer exceeds HDR domain')
 r.update(range=decode,maximumDiffuse=maximum);rgb/=decode;mult=np.maximum(1/255,np.ceil(rgb.max(axis=2)*255)/255);encoded=np.concatenate([rgb/mult[:,:,None],mult[:,:,None]],axis=2);encoded=np.uint8(np.clip(np.rint(encoded*255),0,255))[::-1];raw=b''.join(b'\0'+row.tobytes() for row in encoded)
 (output/r['image']).write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',e,e,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(raw,6))+chunk(b'IEND',b''))
if peak<=0:raise RuntimeError('Empty direct contribution')
# Preserve source geometry/materials byte-for-byte via external references; only add the layer extension.
for item in doc.get('buffers',[])+doc.get('images',[]):
 if 'uri' in item:
  if ':' in item['uri']:raise ValueError('External relative file assets required')
  item['uri']=urllib.parse.quote(os.path.relpath(source.parent/urllib.parse.unquote(item['uri']),output),safe='/')
for r in records:
 index=len(doc['textures']);doc['textures'].append({'source':len(doc['images']),'sampler':len(doc['samplers'])});doc['images'].append({'uri':r['image']});doc['samplers'].append({'wrapS':33071,'wrapT':33071,'magFilter':9729,'minFilter':9729})
 lm=source_by_name[r['material']]['extensions']['EXT_strata_lightmap'];lm['version']=2;lm['pointLight']={'texture':{'index':index,'texCoord':1},'range':r['range'],'light':light}
(output/'scene.gltf').write_text(json.dumps(doc,separators=(',',':')))
manifest={'format':'strata-baked-lightmap-diffuse','version':1,'backend':'Cycles','blender':bpy.app.version_string,'revision':cfg['revision'],'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'samples':scene.cycles.samples,'light':light,'emitterBounds':bounds.tolist(),'emitterFaces':selected,'atlases':records,'maximumDiffuse':peak,'elapsedSeconds':time.time()-start,'scope':'Selected emitter direct diffuse only on existing UVs; point approximation for dynamic occlusion. Other light and bounce remain in the source combined bake.'}
(output/'bake.json').write_text(json.dumps(manifest,indent=2));print('STRATA_SHADOW_LAYER_COMPLETE',json.dumps(manifest),flush=True)
