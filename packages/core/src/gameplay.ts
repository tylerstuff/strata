/** Optional CPU-only gameplay helpers; no renderer, DOM or physics worker initialization. */
export { createCharacterController } from './gameplay/character-controller.js';
export type { CharacterOptions, CharacterInput, CharacterSnapshot, CollisionBox } from './gameplay/character-controller.js';
export { cookStaticCollision, createCapsuleController } from './gameplay/capsule-controller.js';
export type { CollisionMesh, StaticCollisionData, CapsuleOptions } from './gameplay/capsule-controller.js';
export { decodeCollisionSnapshot } from './gameplay/collision-transport.js';
export type { CollisionTransport } from './gameplay/collision-transport.js';
