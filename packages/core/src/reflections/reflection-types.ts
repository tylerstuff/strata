import type { GiSceneOptions } from '../gi/gi-types.js';

export type ReflectionMode = 'off' | 'probe-only' | 'world';
export interface ReflectionControls {
  mode?: ReflectionMode;
  roughness?: number;
  maxDistance?: number;
  updateEvery?: number;
  objectOffset?: number;
  resetHistory?: boolean;
}
export interface ReflectionSceneOptions extends Omit<GiSceneOptions, 'renderer'> {
  renderer: 'reflections';
  resolutionScale?: 0.25 | 0.5 | 1;
  maxRaysPerFrame?: number;
  objectOffset?: number;
  roughness?: number;
}
export interface ReflectionTelemetry {
  readonly [name: string]: number | string | boolean | null;
}
