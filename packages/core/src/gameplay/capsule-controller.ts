import type { CharacterInput, CharacterSnapshot } from './character-controller.js';
import type * as Rapier from '@dimforge/rapier3d-compat';
type Vec3 = readonly [number,number,number];
const backend='rapier3d-0.20.0' as const, maxBytes=256*1024*1024;
let initialization:Promise<typeof Rapier>|undefined;
async function runtime(){return initialization??=import('@dimforge/rapier3d-compat').then(async r=>{await r.init();return r;}).catch(e=>{initialization=undefined;throw e;});}
const abort=(signal?:AbortSignal)=>signal?.throwIfAborted();
function number(v:number,min:number,max:number){if(!Number.isFinite(v)||v<min||v>max)throw new RangeError('Invalid capsule setting.');return v;}
function vector(v:Vec3):[number,number,number]{if(!Array.isArray(v)||v.length!==3)throw new RangeError('Expected three coordinates.');v.forEach(x=>number(x,-8192,8192));return [v[0],v[1],v[2]];}
const xyz=(v:Vec3)=>({x:v[0],y:v[1],z:v[2]});
export interface StaticCollisionData {readonly version:1;readonly backend:typeof backend;readonly triangles:number;readonly snapshot:Uint8Array<ArrayBuffer>}
export interface CollisionMesh {readonly positions:Float32Array<ArrayBuffer>;readonly indices:Uint32Array<ArrayBuffer>}
/** Offline preparation: bake the triangle spatial index into a version-pinned snapshot. */
export async function cookStaticCollision(mesh:CollisionMesh,signal?:AbortSignal):Promise<StaticCollisionData>{
  abort(signal);
  if(!(mesh.positions instanceof Float32Array)||!(mesh.indices instanceof Uint32Array)||!(mesh.positions.buffer instanceof ArrayBuffer)||!(mesh.indices.buffer instanceof ArrayBuffer)||mesh.positions.length%3||mesh.indices.length%3||!mesh.positions.length||!mesh.indices.length||mesh.indices.length>9_000_000||mesh.positions.byteLength+mesh.indices.byteLength>128*1024*1024)throw new RangeError('Invalid or oversized collision mesh.');
  const positions=mesh.positions.slice(),indices=mesh.indices.slice();
  if(!positions.every(v=>Number.isFinite(v)&&Math.abs(v)<=8192)||!indices.every(i=>i<positions.length/3))throw new RangeError('Invalid collision vertex/index.');
  const r=await runtime();abort(signal);const world=new r.World({x:0,y:0,z:0});
  try{
    world.createCollider(r.ColliderDesc.trimesh(positions,indices,r.TriMeshFlags.FIX_INTERNAL_EDGES));world.step();abort(signal);
    const snapshot=new Uint8Array(world.takeSnapshot());if(snapshot.byteLength>maxBytes)throw new RangeError('Cooked collision exceeds 256 MiB.');
    return {version:1,backend,triangles:indices.length/3,snapshot};
  }finally{world.free();}
}
export interface CapsuleOptions {
  readonly collision:StaticCollisionData;readonly position:Vec3;readonly radius?:number;readonly height?:number;
  readonly speed?:number;readonly gravity?:number;readonly jumpSpeed?:number;readonly stepHeight?:number;
  readonly slopeLimitRadians?:number;readonly signal?:AbortSignal;
}
/** Internally initialized precompiled WASM; owns one static world and one kinematic capsule. */
export async function createCapsuleController(options:CapsuleOptions){
  abort(options.signal);const data=options.collision;
  if(data.version!==1||data.backend!==backend||!(data.snapshot instanceof Uint8Array)||!(data.snapshot.buffer instanceof ArrayBuffer)||!data.snapshot.byteLength||data.snapshot.byteLength>maxBytes||!Number.isSafeInteger(data.triangles)||data.triangles<1||data.triangles>3_000_000)throw new RangeError('Invalid/version-incompatible cooked collision.');
  const sourceBytes=data.snapshot.byteLength,triangles=data.triangles;
  const bytes=data.snapshot.slice(),radius=number(options.radius??.3,.02,5),height=number(options.height??1.8,2*radius,20);
  const speed=number(options.speed??4,0,128),gravity=number(options.gravity??20,.01,128),jumpSpeed=number(options.jumpSpeed??7,0,64);
  const stepHeight=number(options.stepHeight??.3,0,height/2),slope=number(options.slopeLimitRadians??Math.PI/4,0,Math.PI/2-.01);
  let position=vector(options.position),previous=[...position] as [number,number,number],velocity:[number,number,number]=[0,0,0];
  const r=await runtime();abort(options.signal);const world=r.World.restoreSnapshot(bytes);
  if(!world)throw new RangeError('Invalid collision snapshot.');
  world.timestep=1/60;
  let disposed=false;
  try{
    if(world.bodies.len()!==0||world.colliders.len()!==1)throw new RangeError('Collision snapshot must contain one static triangle collider.');
    world.colliders.forEach(c=>{if(c.shapeType()!==r.ShapeType.TriMesh||c.isSensor())throw new RangeError('Expected solid static triangle collision.');});
    const shape=new r.Capsule(height/2-radius,radius),rotation={x:0,y:0,z:0,w:1},center=(p:Vec3)=>({x:p[0],y:p[1]+height/2,z:p[2]});
    const body=world.createRigidBody(r.RigidBodyDesc.kinematicPositionBased().setTranslation(...Object.values(center(position)) as [number,number,number]));
    const collider=world.createCollider(r.ColliderDesc.capsule(height/2-radius,radius),body);
    const controller=world.createCharacterController(.01);controller.setMaxSlopeClimbAngle(slope);controller.setMinSlopeSlideAngle(slope);
    if(stepHeight>0){controller.enableAutostep(stepHeight,.1,false);controller.enableSnapToGround(stepHeight);}
    function clear(p:Vec3){let overlap=false;world.intersectionsWithShape(center(p),rotation,shape,other=>{const contact=other.contactShape(shape,center(p),rotation,0);if(contact&&contact.distance<-.001)overlap=true;return !overlap;},undefined,undefined,collider);return !overlap;}
    world.step();if(!clear(position))throw new RangeError('Capsule spawn overlaps collision geometry.');
    controller.computeColliderMovement(collider,{x:0,y:-.02,z:0});let grounded=controller.computedGrounded();
    let accumulator=0,tick=0,droppedSeconds=0,jumpHeld=false,jumpPending=false;
    const alive=()=>{if(disposed)throw new Error('Capsule controller is disposed.');};
    const snapshot=():CharacterSnapshot=>{alive();return {position:[...position],previousPosition:[...previous],velocity:[...velocity],grounded,tick,alpha:accumulator*60,droppedSeconds,motion:!grounded?(velocity[1]>0?'jump':'fall'):Math.hypot(velocity[0],velocity[2])>.01?'walk':'idle'};};
    return {
      snapshot,
      advance(elapsedSeconds:number,input:CharacterInput){
        alive();number(elapsedSeconds,0,60);number(input.x,-1,1);number(input.z,-1,1);if(input.jump!==undefined&&typeof input.jump!=='boolean')throw new TypeError('jump must be boolean.');
        if(input.jump&&!jumpHeld&&grounded)jumpPending=true;jumpHeld=Boolean(input.jump);accumulator+=elapsedSeconds;
        const available=Math.floor((accumulator+1e-9)*60),count=Math.min(available,8);droppedSeconds+=(available-count)/60;accumulator-=(available-count)/60;
        for(let i=0;i<count;i++){
          previous=[...position];const jump=jumpPending&&grounded;jumpPending=false;const norm=Math.max(1,Math.hypot(input.x,input.z));
          velocity=[input.x/norm*speed,jump?jumpSpeed:grounded?0:velocity[1],input.z/norm*speed];velocity[1]-=gravity/60;
          controller.computeColliderMovement(collider,xyz(velocity.map(v=>v/60) as [number,number,number]));
          const movement=controller.computedMovement();position=[position[0]+movement.x,position[1]+movement.y,position[2]+movement.z];grounded=controller.computedGrounded();
          if(grounded||(velocity[1]>0&&movement.y<velocity[1]/60-.001))velocity[1]=0;
          velocity[0]=movement.x*60;velocity[2]=movement.z*60;
          body.setNextKinematicTranslation(center(position));world.step();tick++;accumulator-=1/60;
        }
        accumulator=Math.max(0,accumulator);return snapshot();
      },
      teleport(target:Vec3){alive();const candidate=vector(target);if(!clear(candidate))throw new RangeError('Capsule teleport overlaps collision geometry.');position=candidate;previous=[...candidate];velocity=[0,0,0];body.setTranslation(center(position),true);body.setNextKinematicTranslation(center(position));world.step();controller.computeColliderMovement(collider,{x:0,y:-.02,z:0});grounded=controller.computedGrounded();accumulator=0;tick=0;droppedSeconds=0;jumpHeld=false;jumpPending=false;return snapshot();},
      /** Downward world query for spawn inspection. Returns the first triangle surface height. */
      groundHeight(origin:Vec3,distance=20){alive();const p=vector(origin);number(distance,0,16384);const hit=world.castRay(new r.Ray(xyz(p),{x:0,y:-1,z:0}),distance,true,undefined,undefined,collider);return hit?p[1]-hit.timeOfImpact:null;},
      diagnostics(){return {disposed,backend,triangles,snapshotBytes:sourceBytes,ownedWorlds:disposed?0:1};},
      dispose(){if(!disposed){disposed=true;world.free();}},
    };
  }catch(error){world.free();throw error;}
}
