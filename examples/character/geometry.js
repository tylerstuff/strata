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
];
const material = (name, color) => ({ name, baseColorFactor: [...color,1], metallicFactor: 0, roughnessFactor: .65,
  emissiveFactor: [0,0,0], emissiveStrength: 1, normalScale: 1, occlusionStrength: 1, alphaMode: 'OPAQUE', alphaCutoff: .5, doubleSided: false });

export {mesh, cube, material};
