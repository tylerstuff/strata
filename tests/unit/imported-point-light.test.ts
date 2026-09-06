import { expect, it } from 'vitest';
import { pointLightMatrices, snapshotPointLight } from '../../packages/core/src/imported/imported-point-light.js';
it('projects all signed axes with correct vertical orientation, near and far depth',()=>{
  const position=[2,3,4] as const, range=10, matrices=pointLightMatrices(position,range);
  const directions=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  const project=(face:number,p:number[])=>{const m=matrices[face]!;const q=[0,1,2,3].map(row=>m[row]! * p[0]!+m[row+4]! * p[1]!+m[row+8]! * p[2]!+m[row+12]!);return q.slice(0,3).map(v=>v/q[3]!);};
  directions.forEach((d,face)=>{for(const distance of [.01,1,10]){const p=position.map((v,i)=>v+d[i]!*distance),q=project(face,p);expect(q[0]).toBeCloseTo(0);expect(q[1]).toBeCloseTo(0);expect(q[2]).toBeCloseTo(10/9.99-.1/(9.99*distance),4);}});
  // +Y sees +Z down; -Y sees +Z up, preventing singular look-at matrices.
  expect(project(2,[2,4,4.2])[1]).toBeLessThan(0);
  expect(project(3,[2,2,4.2])[1]).toBeGreaterThan(0);
});
it('copies mutable inputs and bounds the light domain',()=>{
  const source={id:'a',position:[0,1,2] as [number,number,number],color:[1,.5,0] as const,intensity:1,range:5};
  const result=snapshotPointLight(source);source.position[0]=4;expect(result.position[0]).toBe(0);
  for(const value of [{...source,range:NaN},{...source,intensity:-1},{...source,color:[2,0,0]},{...source,shadowMapSize:4096},{...source,id:''}])expect(()=>snapshotPointLight(value as typeof source)).toThrow();
});
