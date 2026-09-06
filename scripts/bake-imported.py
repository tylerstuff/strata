"""Optional Cycles backend for Strata's static vertex-diffuse bake profile."""
import bpy, sys, pathlib, json, hashlib, time
import numpy as np
source, destination, samples, emission_scale = sys.argv[sys.argv.index('--')+1:]
source=pathlib.Path(source); destination=pathlib.Path(destination)
start=time.time()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(source))
scene=bpy.context.scene; scene.render.engine='CYCLES'
scene.cycles.device='CPU'; scene.cycles.samples=int(samples)
scene.cycles.max_bounces=6; scene.cycles.diffuse_bounces=4
scene.render.threads_mode='FIXED'; scene.render.threads=6
scene.world=bpy.data.worlds.new('No baked sky'); scene.world.use_nodes=True
scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value=0
# This slice bakes emission transport only; runtime sun and environment stay separate.
for obj in list(bpy.data.objects):
    if obj.type=='LIGHT': bpy.data.objects.remove(obj,do_unlink=True)
for material in bpy.data.materials:
    if material.use_nodes:
        for node in material.node_tree.nodes:
            if node.type=='BSDF_PRINCIPLED':
                node.inputs['Emission Strength'].default_value *= float(emission_scale)
# Bound tracing texture memory without changing the exported source images.
for image in bpy.data.images:
    if image.source=='FILE' and max(image.size)>512:
        w,h=image.size; scale=512/max(w,h); image.scale(max(1,int(w*scale)),max(1,int(h*scale)))
meshes=[o for o in scene.objects if o.type=='MESH']
source_objects=len(meshes)
bpy.ops.object.select_all(action='DESELECT')
for obj in meshes: obj.select_set(True)
bpy.context.view_layer.objects.active=meshes[0]
bpy.ops.object.join()
meshes=[bpy.context.view_layer.objects.active]
print('STRATA_BAKE_JOINED',source_objects,flush=True)
for obj in meshes:
    attr=obj.data.color_attributes.new(name='StrataBakedDiffuse',type='FLOAT_COLOR',domain='POINT')
    obj.data.color_attributes.active_color=attr
    obj.select_set(True)
bpy.context.view_layer.objects.active=meshes[0]
scene.render.bake.target='VERTEX_COLORS'
scene.render.bake.use_pass_direct=True; scene.render.bake.use_pass_indirect=True; scene.render.bake.use_pass_color=False
print('STRATA_BAKE_START',len(meshes),sum(len(o.data.vertices) for o in meshes),flush=True)
bpy.ops.object.bake(type='DIFFUSE',pass_filter={'DIRECT','INDIRECT'})
# glTF vertex colors are bounded. Store a shared linear scale in the manifest.
peak=0.0
for obj in meshes:
    attr=obj.data.color_attributes['StrataBakedDiffuse']; data=np.empty(len(attr.data)*4,np.float32);attr.data.foreach_get('color',data)
    if not np.isfinite(data).all() or np.min(data)<-1e-5: raise RuntimeError('Nonfinite or negative bake values')
    peak=max(peak,float(data.reshape(-1,4)[:,:3].max(initial=0)))
scale=max(1.0,peak)
for obj in meshes:
    attr=obj.data.color_attributes['StrataBakedDiffuse']; data=np.empty(len(attr.data)*4,np.float32);attr.data.foreach_get('color',data)
    data=data.reshape(-1,4);data[:,:3]=np.maximum(data[:,:3],0)/scale;data[:,3]=1;attr.data.foreach_set('color',data.ravel())
# Restore full-resolution source textures before exporting the local variant.
for image in bpy.data.images:
    if image.source=='FILE' and image.filepath: image.reload()
# The 5.2 exporter maps subsequent material slots to the attribute name rather
# than COLOR_0 and replaces their data with white. Enforce this tool's one-color
# contract in the in-process exporter only; the Blender installation is untouched.
from io_scene_gltf2.blender.exp import primitive_extract
original_material_info=primitive_extract.PrimitiveCreator._PrimitiveCreator__manage_color_attributes
def bake_material_info(self):
    if self.export_settings['gltf_vertex_color_name']=='StrataBakedDiffuse':
        for index in self.material_idxs_using_vc: self.material_idxs_using_vc[index]='COLOR_0'
    original_material_info(self)
primitive_extract.PrimitiveCreator._PrimitiveCreator__manage_color_attributes=bake_material_info
bpy.ops.wm.save_as_mainfile(filepath=str(destination/'bake-checkpoint.blend'))
bpy.ops.export_scene.gltf(filepath=str(destination/'scene.gltf'),export_format='GLTF_SEPARATE',export_animations=False,export_yup=True,export_vertex_color='NAME',export_vertex_color_name='StrataBakedDiffuse',export_active_vertex_color_when_no_material=True)
manifest={'format':'strata-baked-vertex-diffuse','version':1,'backend':'Cycles','blender':bpy.app.version_string,'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'samples':int(samples),'emissionScale':float(emission_scale),'intensity':scale,'maximumDiffuse':peak,'sourceObjects':source_objects,'objects':len(meshes),'elapsedSeconds':time.time()-start,'scope':'Static emission-only diffuse irradiance/pi at mesh vertices. No baked sun/sky, animated receivers, directional probes, or specular lighting. Texture sampling capped at 512.'}
(destination/'bake.pending.json').write_text(json.dumps(manifest,indent=2))
print('STRATA_BAKE_COMPLETE',json.dumps(manifest),flush=True)
