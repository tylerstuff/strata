type Vec3 = readonly [number, number, number];
type Mutable3 = [number, number, number];
export interface CollisionBox { readonly min: Vec3; readonly max: Vec3 }
export interface CharacterOptions {
  readonly boxes: readonly CollisionBox[];
  /** Foot position, Y up, in application units (normally metres). */
  readonly position: Vec3;
  readonly halfWidth?: number;
  readonly height?: number;
  readonly speed?: number;
  readonly gravity?: number;
  readonly jumpSpeed?: number;
  readonly stepHeight?: number;
}
export interface CharacterInput { readonly x: number; readonly z: number; readonly jump?: boolean }
export interface CharacterSnapshot {
  readonly position: Vec3;
  readonly previousPosition: Vec3;
  readonly velocity: Vec3;
  readonly grounded: boolean;
  readonly motion: 'idle' | 'walk' | 'jump' | 'fall';
  readonly tick: number;
  readonly alpha: number;
  /** Time discarded by the eight-tick catch-up budget, accumulated since teleport. */
  readonly droppedSeconds: number;
}
const dt = 1 / 60, epsilon = 1e-9;
const length = (v: Vec3) => Math.hypot(...v);
const add = (a: Vec3, b: Vec3): Mutable3 => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
function vector(v: Vec3): Mutable3 {
  if (!Array.isArray(v) || v.length !== 3 || v.some(x => !Number.isFinite(x) || Math.abs(x)>1e6)) throw new RangeError('Expected a finite three-component position within ±1,000,000 units.');
  return [v[0],v[1],v[2]];
}
function scalar(v: number, min: number, max: number): number {
  if (!Number.isFinite(v) || v<min || v>max) throw new RangeError(`Character setting must be in [${min}, ${max}].`);
  return v;
}
/** Kinematic upright box against immutable AABBs. Not a rigid-body or triangle physics backend. */
export function createCharacterController(options: CharacterOptions) {
  const width=scalar(options.halfWidth??.3,.01,10), height=scalar(options.height??1.8,.02,20);
  const speed=scalar(options.speed??4,0,128), gravity=scalar(options.gravity??20,.01,128);
  const jumpSpeed=scalar(options.jumpSpeed??7,0,64), stepHeight=scalar(options.stepHeight??.3,0,height/2);
  if (!Array.isArray(options.boxes) || options.boxes.length>2048) throw new RangeError('At most 2048 collision boxes are supported.');
  // Minkowski expansion converts an upright character to a swept foot point.
  const boxes=options.boxes.map(box=>{
    const min=vector(box.min),max=vector(box.max);
    if (min.some((v,i)=>v>=max[i]!)) throw new RangeError('Collision box bounds must have positive extent.');
    return {min:[min[0]-width,min[1]-height,min[2]-width] as Vec3,max:[max[0]+width,max[1],max[2]+width] as Vec3};
  });
  function clear(p: Vec3) {
    return !boxes.some(b=>p.every((v,i)=>v>b.min[i]!+epsilon&&v<b.max[i]!-epsilon));
  }
  function sweep(p: Vec3, delta: Vec3) {
    let time=1; let normals: Mutable3[]=[];
    for (const box of boxes) {
      let enter=-Infinity,exit=Infinity;let axes: number[]=[];
      for (let axis=0;axis<3;axis++) {
        const d=delta[axis]!,v=p[axis]!,lo=box.min[axis]!,hi=box.max[axis]!;
        if (Math.abs(d)<epsilon) { if(v<=lo+epsilon||v>=hi-epsilon){exit=-Infinity;break;} continue; }
        const a=(lo-v)/d,b=(hi-v)/d,near=Math.min(a,b),far=Math.max(a,b);
        if (near>enter+epsilon) {enter=near;axes=[axis];} else if(Math.abs(near-enter)<=epsilon)axes.push(axis);
        exit=Math.min(exit,far);
      }
      if (enter < -epsilon || enter>1 || enter>exit+epsilon || exit<0 || enter>time+epsilon) continue;
      if (enter<time-epsilon) normals=[];
      time=Math.min(time,Math.max(0,enter));
      for(const axis of axes){const n:Mutable3=[0,0,0];n[axis]=delta[axis]!>0?-1:1;normals.push(n);}
    }
    return {time,normals};
  }
  function slide(start: Vec3, delta: Vec3) {
    let p:Mutable3=[...start],remaining:Mutable3=[...delta];const contacts:Mutable3[]=[];
    for(let iteration=0;iteration<4&&length(remaining)>epsilon;iteration++){
      const hit=sweep(p,remaining);p=add(p,remaining.map(v=>v*hit.time) as Mutable3);contacts.push(...hit.normals);
      if(!hit.normals.length)break;
      remaining=remaining.map(v=>v*(1-hit.time)) as Mutable3;
      for(const n of hit.normals){const dot=remaining[0]*n[0]+remaining[1]*n[1]+remaining[2]*n[2];if(dot<0)remaining=remaining.map((v,i)=>v-dot*n[i]!) as Mutable3;}
    }
    return {position:p,contacts};
  }
  let position=vector(options.position);
  if(!clear(position))throw new RangeError('Character spawn overlaps collision geometry.');
  let previous:Mutable3=[...position],velocity:Mutable3=[0,0,0],grounded=sweep(position,[0,-.001,0]).normals.some(n=>n[1]>0);
  let tick=0,accumulator=0,droppedSeconds=0,jumpHeld=false,jumpPending=false;
  const snapshot=():CharacterSnapshot=>({position:[...position],previousPosition:[...previous],velocity:[...velocity],grounded,
    motion:!grounded?(velocity[1]>0?'jump':'fall'):Math.hypot(velocity[0],velocity[2])>.001?'walk':'idle',tick,alpha:accumulator/dt,droppedSeconds});
  function step(x: number,z: number) {
    previous=[...position];const wasGrounded=grounded,jumping=jumpPending&&grounded;jumpPending=false;
    velocity=[x*speed,jumping?jumpSpeed:velocity[1],z*speed];velocity[1]-=gravity*dt;
    const delta=velocity.map(v=>v*dt) as Mutable3;
    let result=slide(position,delta);
    if(wasGrounded&&!jumping&&stepHeight>0&&result.contacts.some(n=>n[0]!==0||n[2]!==0)){
      const up=sweep(position,[0,stepHeight,0]);
      if(!up.normals.length){
        const raised=add(position,[0,stepHeight,0]),across=slide(raised,[delta[0],0,delta[2]]);
        const down=sweep(across.position,[0,-stepHeight-.001,0]);
        const candidate=add(across.position,[0,(-stepHeight-.001)*down.time,0]);
        const progress=(p:Vec3)=>Math.hypot(p[0]-position[0],p[2]-position[2]);
        if(down.normals.some(n=>n[1]>0)&&progress(candidate)>progress(result.position)+epsilon&&clear(candidate))result={position:candidate,contacts:[...across.contacts,...down.normals]};
      }
    }
    position=result.position;grounded=result.contacts.some(n=>n[1]>0);
    if(wasGrounded&&!jumping&&!grounded){
      const down=sweep(position,[0,-stepHeight-.001,0]);
      if(down.normals.some(n=>n[1]>0)){position=add(position,[0,(-stepHeight-.001)*down.time,0]);grounded=true;}
    }
    // Report realized horizontal velocity so walking into a wall settles to idle.
    velocity[0]=(position[0]-previous[0])/dt;velocity[2]=(position[2]-previous[2])/dt;
    if(grounded||result.contacts.some(n=>n[1]<0))velocity[1]=0;
    tick++;
  }
  return {
    snapshot,
    /** Elapsed seconds; at most eight 60 Hz ticks. No DOM input or wall clock is owned here. */
    advance(elapsedSeconds: number,input: CharacterInput):CharacterSnapshot {
      scalar(elapsedSeconds,0,60);scalar(input.x,-1,1);scalar(input.z,-1,1);
      if(input.jump!==undefined&&typeof input.jump!=='boolean')throw new TypeError('jump must be boolean.');
      if(input.jump&&!jumpHeld&&grounded)jumpPending=true;jumpHeld=Boolean(input.jump);
      const magnitude=Math.max(1,Math.hypot(input.x,input.z));accumulator+=elapsedSeconds;
      const available=Math.floor((accumulator+epsilon)/dt),count=Math.min(8,available);
      if(available>count){const dropped=(available-count)*dt;accumulator-=dropped;droppedSeconds+=dropped;}
      for(let i=0;i<count;i++){step(input.x/magnitude,input.z/magnitude);accumulator-=dt;}
      accumulator=Math.max(0,accumulator);return snapshot();
    },
    /** Rejection is atomic; valid teleports reset velocity, interpolation, input and timing. */
    teleport(target: Vec3):CharacterSnapshot {
      const candidate=vector(target);if(!clear(candidate))throw new RangeError('Character teleport overlaps collision geometry.');
      position=candidate;previous=[...candidate];velocity=[0,0,0];grounded=sweep(position,[0,-.001,0]).normals.some(n=>n[1]>0);
      tick=0;accumulator=0;droppedSeconds=0;jumpHeld=false;jumpPending=false;return snapshot();
    },
  };
}
