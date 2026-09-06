import { createEngine, createMeshAsset } from '/packages/core/dist/index.js';
const canvas = document.querySelector('canvas');
let engine, frame, paused = false, time = 0, last = 0;
const identity = () => [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function mesh(name, faces, material) {
  const vertices = [], indices = [];
  for (const face of faces) {
    const a = face[1].map((v,i) => v-face[0][i]), b = face[2].map((v,i) => v-face[0][i]);
    const cross = [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const normal = cross.map(v => v/Math.hypot(...cross)), tangent = a.map(v => v/Math.hypot(...a));
    const base = vertices.length/16;
    face.forEach((p,i) => vertices.push(...p,...normal,...[[0,0],[1,0],[1,1],[0,1]][i],...tangent,1,1,1,1,1));
    indices.push(base,base+1,base+2,base,base+2,base+3);
  }
  return { name, vertices: new Float32Array(vertices), indices: new Uint32Array(indices), material };
}
const cube = [
  [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]], [[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]],
  [[1,-1,1],[1,-1,-1],[1,1,-1],[1,1,1]], [[-1,-1,-1],[-1,-1,1],[-1,1,1],[-1,1,-1]],
  [[-1,1,1],[1,1,1],[1,1,-1],[-1,1,-1]], [[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1]],
].map(face => face.map(p => p.map(v => v*.65)));
const material = (name, color) => ({ name, baseColorFactor: [...color,1], metallicFactor: 0, roughnessFactor: .65,
  emissiveFactor: [0,0,0], emissiveStrength: 1, normalScale: 1, occlusionStrength: 1, alphaMode: 'OPAQUE', alphaCutoff: .5, doubleSided: false });
const asset = createMeshAsset({ meshes: [
  mesh('floor', [[[-4,0,3],[4,0,3],[4,0,-3],[-4,0,-3]]], 0),
  mesh('moving actor proxy', cube, 1),
  mesh('back wall', [[[-4,0,-3],[4,0,-3],[4,3,-3],[-4,3,-3]]], 2),
], materials: [material('warm stone',[.35,.31,.25]),material('orange actor',[.85,.23,.035]),material('blue wall',[.16,.28,.4])] });
const transforms = new Float32Array([...identity(), ...identity(), ...identity()]);
document.querySelector('#pause').onclick = e => { paused = !paused; e.target.textContent = paused ? 'Resume animation' : 'Pause animation'; };
try {
  engine = await createEngine({ canvas });
  await engine.setScene({ renderer: 'imported', asset });
  const tick = now => {
    if (!paused && last && !document.hidden) time += Math.min(.05,(now-last)/1000); last = now;
    const c = Math.cos(time), s = Math.sin(time);
    transforms.set([c,0,-s,0,0,1,0,0,s,0,c,0,Math.sin(time*.6)*1.7,.9+Math.sin(time*1.8)*.15,0,1],16);
    try {
      const metrics = engine.render({ timeSeconds: time, temporal: true, debugView: document.querySelector('#view').value,
        imported: { transforms, camera: { eye: [6,4.5,8], target: [0,1,0], verticalFov: Math.PI/4 },
          lighting: { directionToLight: [-.5,.85,.4], color: [1,.93,.82], intensity: 3, ambient: [.055,.065,.08] }, background: [.035,.05,.07] } });
      document.querySelector('#stats').textContent = `${metrics.drawCalls} submitted draws · ${metrics.triangles} pass triangles · ${metrics.uploadBytes} upload bytes · scene generation ${metrics.scene.sceneGeneration}`;
      frame = requestAnimationFrame(tick);
    } catch (error) { document.querySelector('#error').textContent = String(error); }
  };
  frame = requestAnimationFrame(tick);
} catch (error) { document.querySelector('#error').textContent = String(error); engine?.dispose(); }
window.addEventListener('pagehide', () => { cancelAnimationFrame(frame); engine?.dispose(); }, { once: true });
