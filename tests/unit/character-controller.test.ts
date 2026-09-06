import { describe,it,expect } from 'vitest';
import { createCharacterController } from '../../packages/core/src/gameplay.js';
import type { CollisionBox, CharacterInput } from '../../packages/core/src/gameplay.js';
const floor:CollisionBox={min:[-100,-1,-100],max:[100,0,100]};
const make=(boxes:CollisionBox[]=[])=>createCharacterController({boxes:[floor,...boxes],position:[0,0,0]});
const idle={x:0,z:0};
function run(c:ReturnType<typeof make>,n:number,input:CharacterInput=idle){for(let i=0;i<n;i++)c.advance(1/60,input);return c.snapshot();}
describe('optional kinematic character',()=>{
  it('is render-rate independent and interpolates only completed simulation states',()=>{
    const a=make(),b=make(),c=make();for(let i=0;i<120;i++)a.advance(1/120,{x:1,z:0});for(let i=0;i<30;i++)b.advance(1/30,{x:1,z:0});run(c,60,{x:1,z:0});
    expect(a.snapshot()).toEqual(b.snapshot());expect(a.snapshot()).toEqual(c.snapshot());expect(a.snapshot().position[0]).toBeCloseTo(4,10);
    const v=a.advance(1/120,idle);expect(v.alpha).toBeCloseTo(.5);expect(v.tick).toBe(60);
  });
  it('does not accelerate diagonal input',()=>{const c=make();const s=run(c,60,{x:1,z:1});expect(Math.hypot(s.position[0],s.position[2])).toBeCloseTo(4);});
  it('sweeps thin walls without tunneling and slides along them',()=>{
    const c=createCharacterController({boxes:[floor,{min:[1,0,-20],max:[1.001,5,20]}],position:[0,0,0],speed:128});
    const s=run(c,3,{x:1,z:1});expect(s.position[0]).toBeCloseTo(.7);expect(s.position[2]).toBeGreaterThan(4);expect(s.grounded).toBe(true);
  });
  it('handles simultaneous corner contacts independent of box order',()=>{
    const x:CollisionBox={min:[1,0,-10],max:[2,5,10]},z:CollisionBox={min:[-10,0,1],max:[10,5,2]};
    const a=run(make([x,z]),60,{x:1,z:1}),b=run(make([z,x]),60,{x:1,z:1});expect(a).toEqual(b);expect(a.position).toEqual([.7,0,.7]);expect(a.motion).toBe('idle');
  });
  it('jumps once per press, lands and permits a subsequent jump',()=>{
    const c=make();const first=c.advance(1/60,{...idle,jump:true});expect(first.motion).toBe('jump');expect(first.grounded).toBe(false);
    const landed=run(c,120,{...idle,jump:true});expect(landed.grounded).toBe(true);expect(landed.position[1]).toBeCloseTo(0);c.advance(1/60,idle);expect(c.advance(1/60,{...idle,jump:true}).motion).toBe('jump');
  });
  it('retains a jump press across a render frame with no physics tick',()=>{const c=make();c.advance(1/120,{...idle,jump:true});expect(c.advance(1/120,idle).motion).toBe('jump');});
  it('stops upward motion at a ceiling',()=>{const c=make([{min:[-2,2,-2],max:[2,3,2]}]);let high=0;for(let i=0;i<90;i++){const s=c.advance(1/60,{...idle,jump:true});high=Math.max(high,s.position[1]);}expect(high).toBeLessThanOrEqual(.2+1e-9);expect(c.snapshot().grounded).toBe(true);});
  it('climbs small steps, snaps down them and refuses tall obstacles',()=>{
    const step:CollisionBox={min:[1,0,-2],max:[2,.2,2]},c=make([step]);let high=0;for(let i=0;i<50;i++){const s=c.advance(1/60,{x:1,z:0});high=Math.max(high,s.position[1]);}expect(high).toBeCloseTo(.2);expect(c.snapshot().position[0]).toBeGreaterThan(3);expect(c.snapshot().position[1]).toBeCloseTo(0);
    const wall=make([{min:[1,0,-2],max:[2,.5,2]}]);expect(run(wall,60,{x:1,z:0}).position[0]).toBeCloseTo(.7);
  });
  it('cannot step into insufficient headroom or traverse a gap narrower than its body',()=>{
    const c=make([{min:[1,0,-2],max:[2,.2,2]},{min:[.4,1.9,-2],max:[2,3,2]}]);expect(run(c,60,{x:1,z:0}).position[0]).toBeCloseTo(.7);
    const gap=make([{min:[1,0,.25],max:[3,3,4]},{min:[1,0,-4],max:[3,3,-.25]}]);expect(run(gap,60,{x:1,z:0}).position[0]).toBeCloseTo(.7);
  });
  it('bounds catch-up and reports discarded time',()=>{const c=make();const s=c.advance(1,idle);expect(s.tick).toBe(8);expect(s.droppedSeconds).toBeCloseTo(52/60);expect(s.alpha).toBeLessThan(1);});
  it('snapshots inputs and rejects invalid updates and overlapping teleports atomically',()=>{
    const box={min:[1,0,-2] as [number,number,number],max:[2,4,2] as [number,number,number]},c=make([box]);box.min[0]=50;
    expect(run(c,60,{x:1,z:0}).position[0]).toBeCloseTo(.7);const before=c.snapshot();expect(()=>c.advance(NaN,idle)).toThrow();expect(()=>c.advance(1/60,{x:2,z:0})).toThrow();expect(()=>c.teleport([1,0,0])).toThrow();expect(c.snapshot()).toEqual(before);
    const copy=c.snapshot();(copy.position as unknown as number[])[0]=50;expect(c.snapshot()).toEqual(before);expect(c.teleport([-2,2,0]).velocity).toEqual([0,0,0]);
  });
  it('rejects inverted boxes, overlapping spawn and invalid body dimensions',()=>{
    expect(()=>make([{min:[1,0,0],max:[0,1,1]}])).toThrow();expect(()=>make([{min:[-.1,0,-.1],max:[.1,1,.1]}])).toThrow();expect(()=>createCharacterController({boxes:[],position:[0,0,0],halfWidth:0})).toThrow();
  });
});
