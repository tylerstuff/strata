"""Cycles emission-only diffuse lightmap backend. Invoked by bake-imported.mjs."""
import bpy, sys, pathlib, json, hashlib, time, struct, zlib
import numpy as np
source, destination, samples, emission_scale, edge, denoiser_option = sys.argv[sys.argv.index('--')+1:]
source=pathlib.Path(source); destination=pathlib.Path(destination); edge=int(edge); start=time.time()
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from lightmap_denoise import find_denoiser
denoiser=find_denoiser(denoiser_option)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(source))
scene=bpy.context.scene; scene.render.engine='CYCLES'
scene.cycles.device='CPU'; scene.cycles.samples=int(samples)
preferences=bpy.context.preferences.addons['cycles'].preferences
try:
    preferences.compute_device_type='METAL'; preferences.get_devices()
    if any(d.type=='METAL' for d in preferences.devices):
        for d in preferences.devices: d.use=d.type=='METAL'
        scene.cycles.device='GPU'
except (TypeError,RuntimeError): pass
scene.cycles.max_bounces=6; scene.cycles.diffuse_bounces=4
scene.render.threads_mode='FIXED'; scene.render.threads=6
scene.world=bpy.data.worlds.new('No baked sky'); scene.world.use_nodes=True
scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value=0
for obj in list(bpy.data.objects):
    if obj.type=='LIGHT': bpy.data.objects.remove(obj,do_unlink=True)
for material in bpy.data.materials:
    if material.use_nodes:
        for node in material.node_tree.nodes:
            if node.type=='BSDF_PRINCIPLED': node.inputs['Emission Strength'].default_value *= float(emission_scale)
for image in bpy.data.images:
    if image.source=='FILE' and max(image.size)>1024:
        w,h=image.size; scale=1024/max(w,h); image.scale(max(1,int(w*scale)),max(1,int(h*scale)))
meshes=[o for o in scene.objects if o.type=='MESH']; source_objects=len(meshes)
bpy.ops.object.select_all(action='DESELECT')
for obj in meshes: obj.select_set(True)
bpy.context.view_layer.objects.active=meshes[0]; bpy.ops.object.join(); obj=bpy.context.object
for attr in list(obj.data.color_attributes): obj.data.color_attributes.remove(attr)
while len(obj.data.uv_layers)>1: obj.data.uv_layers.remove(obj.data.uv_layers[-1])
obj.data.uv_layers.new(name='StrataLightmap'); obj.data.uv_layers.active_index=1
print('STRATA_LIGHTMAP_UNWRAP',len(obj.data.polygons),flush=True)
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.mesh.remove_doubles(threshold=0.000001); bpy.ops.object.mode_set(mode='OBJECT')
# Separate material atlases keep tiny foliage charts from consuming architecture density.
bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.mesh.separate(type='MATERIAL');bpy.ops.object.mode_set(mode='OBJECT')
receivers=[o for o in scene.objects if o.type=='MESH']
areas=[]
for receiver in receivers:
    area_values=np.empty(len(receiver.data.polygons),np.float32);receiver.data.polygons.foreach_get('area',area_values);areas.append(float(area_values.sum()))
images={};atlas_records=[]
bpy.ops.object.select_all(action='DESELECT')
for index,(receiver,area) in enumerate(zip(receivers,areas)):
    if area<=0: raise RuntimeError('Zero-area bake receiver')
    material=receiver.data.materials[0]
    allocation=max(128,min(edge,2**int(np.floor(np.log2(max(128,np.sqrt(area/sum(areas))*edge))))))
    receiver.select_set(True);bpy.context.view_layer.objects.active=receiver
    receiver.data.uv_layers.active_index=1
    source_uv=np.empty(len(receiver.data.uv_layers[0].data)*2,np.float32);receiver.data.uv_layers[0].data.foreach_get('uv',source_uv)
    bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=1.151917,island_margin=0.00001,margin_method='SCALED',area_weight=0.0,correct_aspect=False,scale_to_bounds=True)
    bpy.ops.object.mode_set(mode='OBJECT');receiver.select_set(False)
    preserved_uv=np.empty_like(source_uv);receiver.data.uv_layers[0].data.foreach_get('uv',preserved_uv)
    if not np.array_equal(source_uv,preserved_uv): raise RuntimeError('Unwrap changed source material UVs')
    uv_values=np.empty(len(receiver.data.uv_layers[1].data)*2,np.float32);receiver.data.uv_layers[1].data.foreach_get('uv',uv_values)
    if not np.isfinite(uv_values).all() or uv_values.min() < -1e-6 or uv_values.max() > 1.000001: raise RuntimeError('Atlas packing produced out-of-range UVs')
    uv_triangles=uv_values.reshape(-1,3,2);a=uv_triangles[:,1]-uv_triangles[:,0];b=uv_triangles[:,2]-uv_triangles[:,0]
    coverage=float(np.abs(a[:,0]*b[:,1]-a[:,1]*b[:,0]).sum()/2)
    if coverage<0.01: raise RuntimeError('Atlas chart coverage is too low: '+material.name+' '+str(coverage))
    receiver.data.uv_layers[0].active_render=True
    image=bpy.data.images.new('StrataDiffuseLightmap-'+str(index),width=allocation,height=allocation,alpha=True,float_buffer=True)
    image.colorspace_settings.name='Non-Color';images[index]=image
    nodes=material.node_tree.nodes
    for node in nodes: node.select=False
    target=nodes.new('ShaderNodeTexImage');target.image=image;target.select=True;nodes.active=target
    atlas_records.append({'material':material.name,'image':'lightmap-'+str(index)+'.png','edge':allocation,'area':area,'uvCoverage':coverage})
    print('STRATA_ATLAS',material.name,allocation,coverage,flush=True)
for receiver in receivers: receiver.select_set(True)
bpy.context.view_layer.objects.active=receivers[0];bpy.ops.object.join();obj=bpy.context.object
print('STRATA_LIGHTMAP_UV_OK',len(obj.data.vertices),flush=True)
scene.render.bake.target='IMAGE_TEXTURES';scene.render.bake.margin=8
scene.render.bake.use_pass_direct=True;scene.render.bake.use_pass_indirect=True;scene.render.bake.use_pass_color=False
bpy.ops.wm.save_as_mainfile(filepath=str(destination/'lightmap-checkpoint.blend'))
print('STRATA_LIGHTMAP_BAKE',edge,scene.cycles.device,flush=True)
bpy.ops.object.bake(type='DIFFUSE',pass_filter={'DIRECT','INDIRECT'},uv_layer='StrataLightmap')
def chunk(kind,payload): return struct.pack('>I',len(payload))+kind+payload+struct.pack('>I',zlib.crc32(kind+payload)&0xffffffff)
peak=0.0
for record,(index,image) in zip(atlas_records,images.items()):
    size=record['edge'];data=np.empty(size*size*4,np.float32);image.pixels.foreach_get(data);data=data.reshape(size,size,4)
    if not np.isfinite(data).all(): raise RuntimeError('Nonfinite lightmap')
    maximum=float(data[:,:,:3].max());peak=max(peak,maximum)
    if denoiser:
        data[:,:,:3]=denoiser.apply(np.maximum(data[:,:,:3],0));maximum=float(data[:,:,:3].max())
        print('STRATA_LIGHTMAP_DENOISED',record['material'],flush=True)
    decode_range=max(1.0,2**np.ceil(np.log2(max(1.0,maximum))))
    if decode_range>65536: raise RuntimeError('Bake exceeds RGBM range')
    record['range']=float(decode_range);record['maximumDiffuse']=maximum
    rgb=np.maximum(data[:,:,:3],0)/decode_range
    multiplier=np.maximum(1/255,np.ceil(np.max(rgb,axis=2)*255)/255)
    encoded=np.empty_like(data);encoded[:,:,:3]=rgb/multiplier[:,:,None];encoded[:,:,3]=multiplier
    encoded=np.uint8(np.clip(np.rint(encoded*255),0,255))[::-1]
    raw=b''.join(b'\0'+row.tobytes() for row in encoded)
    (destination/record['image']).write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(raw,6))+chunk(b'IEND',b''))
if peak<=0: raise RuntimeError('Empty lightmap bake; output is not publishable')
for material in obj.data.materials:
    if material:
        for node in list(material.node_tree.nodes):
            if node.type=='TEX_IMAGE' and node.image in images.values(): material.node_tree.nodes.remove(node)
for original in bpy.data.images:
    if original.source=='FILE' and original.filepath: original.reload()
obj.data.uv_layers.active_index=0
bpy.ops.export_scene.gltf(filepath=str(destination/'scene.gltf'),export_format='GLTF_SEPARATE',export_animations=False,export_yup=True,export_texcoords=True,export_normals=True,export_tangents=False,export_vertex_color='NONE')
manifest={'format':'strata-baked-lightmap-diffuse','version':1,'backend':'Cycles','denoiser':'Open Image Denoise RTLightmap' if denoiser else 'none','device':scene.cycles.device,'blender':bpy.app.version_string,'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'samples':int(samples),'emissionScale':float(emission_scale),'atlases':atlas_records,'atlasBytes':sum(a['edge']**2*4 for a in atlas_records),'edge':edge,'padding':8,'maximumDiffuse':peak,'sourceObjects':source_objects,'elapsedSeconds':time.time()-start,'scope':'Static emission-only diffuse irradiance/pi. RGBM texture, independent UV1, no mipmaps. Runtime sun/sky separate; no dynamic receivers or baked specular.'}
if denoiser:denoiser.close()
(destination/'bake.pending.json').write_text(json.dumps(manifest,indent=2));print('STRATA_LIGHTMAP_COMPLETE',json.dumps(manifest),flush=True)
