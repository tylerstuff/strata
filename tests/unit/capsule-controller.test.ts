import {describe,it,expect} from 'vitest';
import {cookStaticCollision,createCapsuleController} from '../../packages/core/src/gameplay.js';
const mesh=(ramp=false)=>({positions:new Float32Array([-20,0,-20,20,0,-20,20,ramp?10:0,20,-20,ramp?10:0,20]),indices:new Uint32Array([0,2,1,0,3,2])});
function boxesMesh(boxes:number[][]){
 const positions:number[]=[],indices:number[]=[];
 for(const [x,y,z,X,Y,Z] of boxes){const base=positions.length/3;positions.push(x!,y!,z!,X!,y!,z!,X!,Y!,z!,x!,Y!,z!,x!,y!,Z!,X!,y!,Z!,X!,Y!,Z!,x!,Y!,Z!);indices.push(...[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5].map(i=>base+i));}
 return {positions:new Float32Array(positions),indices:new Uint32Array(indices)};
}
describe('WASM capsule collision',()=>{
 it('blocks thin walls and ceilings, and climbs a low triangle step',async()=>{
  const collision=await cookStaticCollision(boxesMesh([[-20,-1,-20,20,0,20],[2,0,-5,2.001,5,5],[-2,2,-2,1,3,2],[-5,0,2,1,.2,3]]));
  const c=await createCapsuleController({collision,position:[0,.02,0],speed:128});
  try{for(let i=0;i<5;i++)c.advance(1/60,{x:1,z:0});expect(c.snapshot().position[0]).toBeLessThan(1.72);c.teleport([0,.02,0]);let high=0;for(let i=0;i<90;i++)high=Math.max(high,c.advance(1/60,{x:0,z:0,jump:true}).position[1]);expect(high).toBeLessThan(.22);}finally{c.dispose();}
  const stairs=await createCapsuleController({collision,position:[-3,.02,0]});try{let high=0;for(let i=0;i<40;i++)high=Math.max(high,stairs.advance(1/60,{x:0,z:1}).position[1]);expect(high).toBeGreaterThan(.19);expect(stairs.snapshot().position[2]).toBeGreaterThan(2.4);}finally{stairs.dispose();}
 });
 it('does not climb a slope beyond its configured limit',async()=>{
  const collision=await cookStaticCollision({positions:new Float32Array([-10,-10,-5,10,-10,-5,10,10,5,-10,10,5]),indices:new Uint32Array([0,2,1,0,3,2])});
  const c=await createCapsuleController({collision,position:[0,.5,0],slopeLimitRadians:Math.PI/4});try{for(let i=0;i<60;i++)c.advance(1/60,{x:0,z:1});expect(c.snapshot().position[2]).toBeLessThan(.5);}finally{c.dispose();}
 });
 it('cooks/restores a triangle world, jumps, lands and frees owned worlds',async()=>{
  const collision=await cookStaticCollision(mesh());const c=await createCapsuleController({collision,position:[0,.02,0]});
  for(let i=0;i<5;i++)c.advance(1/60,{x:0,z:0});expect(c.snapshot().grounded).toBe(true);
  expect(c.advance(1/60,{x:0,z:0,jump:true}).position[1]).toBeGreaterThan(.1);
  for(let i=0;i<120;i++)c.advance(1/60,{x:0,z:0});expect(c.snapshot().grounded).toBe(true);expect(c.groundHeight([0,10,0])).toBeCloseTo(0);
  const before=c.snapshot();expect(()=>c.teleport([0,-.5,0])).toThrow();expect(c.snapshot()).toEqual(before);c.dispose();c.dispose();expect(c.diagnostics().ownedWorlds).toBe(0);expect(()=>c.snapshot()).toThrow();
 });
 it('climbs a shallow triangle slope and is render-rate independent',async()=>{
  const collision=await cookStaticCollision(mesh(true));const a=await createCapsuleController({collision,position:[0,5.1,0]}),b=await createCapsuleController({collision,position:[0,5.1,0]});
  try{for(let i=0;i<120;i++)a.advance(1/60,{x:0,z:1});for(let i=0;i<240;i++)b.advance(1/120,{x:0,z:1});expect(a.snapshot()).toEqual(b.snapshot());expect(a.snapshot().position[1]).toBeGreaterThan(6);expect(a.snapshot().grounded).toBe(true);}finally{a.dispose();b.dispose();}
 });
 it('rejects incompatible data and cancellation before initialization',async()=>{
  const collision=await cookStaticCollision(mesh());await expect(createCapsuleController({collision:{...collision,version:2} as never,position:[0,0,0]})).rejects.toThrow();
  const a=new AbortController();a.abort();await expect(cookStaticCollision(mesh(),a.signal)).rejects.toThrow();
  await expect(cookStaticCollision({positions:new Float32Array([0,NaN,0]),indices:new Uint32Array([0,1,2])})).rejects.toThrow();
 });
});
