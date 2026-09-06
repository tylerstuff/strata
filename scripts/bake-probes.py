"""Emission-only Cycles six-axis irradiance and scene-ray visibility grid."""
import bpy,sys,pathlib,json,math,hashlib,time
import numpy as np
from mathutils import Vector
source,config_path,output=map(pathlib.Path,sys.argv[sys.argv.index('--')+1:]);cfg=json.loads(config_path.read_text());start=time.time()
origin=np.array(cfg['origin'],dtype=float);spacing=np.array(cfg['spacing'],dtype=float);counts=cfg['counts'];samples=int(cfg.get('samples',64));power=float(cfg.get('emissionScale',1))
if origin.shape!=(3,) or spacing.shape!=(3,) or not np.isfinite(origin).all() or not np.isfinite(spacing).all() or min(spacing)<=0:raise ValueError('Invalid grid')
if len(counts)!=3 or any(not isinstance(v,int) or v<2 or v>64 for v in counts) or math.prod(counts)>4096 or not 1<=samples<=4096 or not 0<power<=1000:raise ValueError('Invalid bake bounds')
if np.max(np.abs(origin))>1024 or max(spacing)>1024 or np.max(np.abs(origin+spacing*(np.array(counts)-1)))>1024:raise ValueError('Grid outside scene bounds')
if not isinstance(cfg.get('revision'),str) or not 1<=len(cfg['revision'])<=128:raise ValueError('Explicit bake revision required')
doc=json.loads(source.read_text())
if doc.get('animations') or doc.get('skins'):raise ValueError('Static environment only')
bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.import_scene.gltf(filepath=str(source))
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=samples;scene.cycles.max_bounces=6;scene.cycles.diffuse_bounces=4;scene.cycles.device='CPU'
scene.render.threads_mode='FIXED';scene.render.threads=6
prefs=bpy.context.preferences.addons['cycles'].preferences
try:
    prefs.compute_device_type='METAL';prefs.get_devices()
    if any(d.type=='METAL' for d in prefs.devices):
        for d in prefs.devices:d.use=d.type=='METAL'
        scene.cycles.device='GPU'
except (TypeError,RuntimeError):pass
scene.world=bpy.data.worlds.new('No baked sky');scene.world.use_nodes=True;scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value=0
for obj in list(scene.objects):
    if obj.type=='LIGHT':bpy.data.objects.remove(obj,do_unlink=True)
for material in bpy.data.materials:
    if material.use_nodes:
        for node in material.node_tree.nodes:
            if node.type=='BSDF_PRINCIPLED':node.inputs['Emission Strength'].default_value*=power
for image in bpy.data.images:
    if image.source=='FILE' and max(image.size)>1024:
        w,h=image.size;s=1024/max(w,h);image.scale(max(1,int(w*s)),max(1,int(h*s)))
meshes=[o for o in scene.objects if o.type=='MESH'];minimum=np.full(3,np.inf);maximum=-minimum
for obj in meshes:
    for corner in obj.bound_box:
        p=obj.matrix_world@Vector(corner);q=np.array([p.x,p.z,-p.y]);minimum=np.minimum(minimum,q);maximum=np.maximum(maximum,q)
scale=2/max(maximum-minimum);translation=-np.array([(minimum[0]+maximum[0])/2,minimum[1],(minimum[2]+maximum[2])/2])*scale
if 'normalization' in cfg:
    scale=float(cfg['normalization']['scale']);translation=np.array(cfg['normalization']['translation'])
if not math.isfinite(scale) or scale<=0 or translation.shape!=(3,) or not np.isfinite(translation).all():raise ValueError('Invalid normalization')
def blender_point(p):
    q=(p-translation)/scale;return Vector((q[0],-q[2],q[1]))
def blender_direction(d):return Vector((d[0],-d[2],d[1]))
def octdir(x,y):
    d=np.array([2*(x+.5)/16-1,2*(y+.5)/16-1,0.]);d[2]=1-abs(d[0])-abs(d[1])
    if d[2]<0:d[:2]=(1-np.abs(d[1::-1]))*np.where(d[:2]>=0,1,-1)
    return d/np.linalg.norm(d)
positions=[origin+spacing*np.array([x,y,z]) for z in range(counts[2]) for y in range(counts[1]) for x in range(counts[0])]
axes=np.array([[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]],dtype=float)
visibility=[];valid=[];ground=[];deps=bpy.context.evaluated_depsgraph_get();limit=min(8192.,float(np.linalg.norm(maximum-minimum)*scale+1))
for i,p in enumerate(positions):
    point=blender_point(p);backfaces=0;near=False
    for d in axes:
        direction=blender_direction(d);hit,location,normal,*_=scene.ray_cast(deps,point,direction,distance=limit/scale)
        if hit:
            near|=(location-point).length*scale<min(spacing)*.003;backfaces+=int(normal.dot(direction)>0)
    valid.append(int(not near and backfaces<4))
    for y in range(16):
        for x in range(16):
            hit,location,*_=scene.ray_cast(deps,point,blender_direction(octdir(x,y)),distance=limit/scale)
            visibility.append((location-point).length*scale if hit else limit)
    if i%32==0:print('STRATA_PROBE_VISIBILITY',i,len(positions),flush=True)
# Tiny oriented white receivers are excluded from secondary rays and shadow occlusion.
verts=[];faces=[];radius=float(min(spacing)*.001/scale)
for p in positions:
    center=blender_point(p)
    for axis in axes:
        n=blender_direction(axis);u=n.cross(Vector((0,0,1)) if abs(n.z)<.9 else Vector((0,1,0))).normalized();v=n.cross(u)
        first=len(verts);verts.extend([center+radius*(-u-v),center+radius*(u-v),center+radius*(2*v)]);faces.append((first,first+1,first+2))
mesh=bpy.data.meshes.new('Baked probe receivers');mesh.from_pydata(verts,[],faces);mesh.update();obj=bpy.data.objects.new('Baked probe receivers',mesh);scene.collection.objects.link(obj)
mat=bpy.data.materials.new('Probe diffuse');mat.use_nodes=True;bsdf=mat.node_tree.nodes.get('Principled BSDF');bsdf.inputs['Base Color'].default_value=(1,1,1,1);bsdf.inputs['Roughness'].default_value=1;mesh.materials.append(mat)
for name in ['visible_shadow','visible_diffuse','visible_glossy','visible_transmission']:setattr(obj,name,False)
attr=mesh.color_attributes.new(name='ProbeDiffuse',type='FLOAT_COLOR',domain='POINT');mesh.color_attributes.active_color=attr
bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active=obj
scene.render.bake.target='VERTEX_COLORS';scene.render.bake.use_pass_direct=True;scene.render.bake.use_pass_indirect=True;scene.render.bake.use_pass_color=False
print('STRATA_PROBE_CYCLES',len(positions),scene.cycles.device,flush=True);bpy.ops.object.bake(type='DIFFUSE',pass_filter={'DIRECT','INDIRECT'})
colors=np.empty(len(attr.data)*4,np.float32);attr.data.foreach_get('color',colors);irradiance=colors.reshape(len(positions),6,3,4)[:,:,:,:3].mean(axis=2)
if not np.isfinite(irradiance).all() or irradiance.max()>65536:raise RuntimeError('Invalid or empty probe bake')
volume={'version':1,'revision':cfg['revision'],'origin':origin.tolist(),'spacing':spacing.tolist(),'counts':counts,'irradiance':np.maximum(irradiance,0).reshape(-1).tolist(),'visibility':visibility,'valid':valid}
(output/'probes.json').write_text(json.dumps(volume,separators=(',',':')))
manifest={'version':1,'backend':'Cycles','blender':bpy.app.version_string,'device':scene.cycles.device,'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'normalization':{'scale':scale,'translation':translation.tolist()},'samples':samples,'emissionScale':power,'elapsedSeconds':time.time()-start,'validProbes':sum(valid),'probes':len(valid),'maximumIrradiance':float(irradiance.max()),'scope':'Six-axis emission-only diffuse irradiance/pi. 16x16 first-hit visibility is approximate; no sun/sky, dynamic occlusion, or baked specular.'}
(output/'bake.json').write_text(json.dumps(manifest,indent=2));print('STRATA_PROBES_COMPLETE',json.dumps(manifest),flush=True)
