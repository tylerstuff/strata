import bpy,pathlib,sys
root=pathlib.Path(sys.argv[sys.argv.index('--')+1]);root.mkdir(exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
for i in range(3):
    m=bpy.data.materials.new('fixture-'+str(i));m.use_nodes=True;n=m.node_tree.nodes.get('Principled BSDF');n.inputs['Base Color'].default_value=(1,1,1,1);n.inputs['Roughness'].default_value=1
    if i==2:n.inputs['Emission Color'].default_value=(1,.02,.1,1);n.inputs['Emission Strength'].default_value=5
    bpy.ops.mesh.primitive_plane_add(size=2,location=((i*2-1) if i<2 else 0,0,0 if i<2 else 2));o=bpy.context.object;o.name='receiver-'+str(i);o.data.materials.append(m)
    if i==2:o.rotation_euler.x=3.141592653589793
bpy.ops.export_scene.gltf(filepath=str(root/'source.gltf'),export_format='GLTF_SEPARATE')
