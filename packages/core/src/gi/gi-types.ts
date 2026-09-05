export interface GiSceneOptions {
  renderer: 'gi';
  doorOpen?: boolean;
  wallColor?: 'red' | 'neutral';
  lightIntensity?: number;
  probesPerUpdate?: number;
  raysPerProbe?: number;
  cameraMode?: 'receiver' | 'overview' | 'tour';
}

/** Partial world-state patches persist. Camera cuts do not invalidate world lighting. */
export interface GiControls {
  enabled?: boolean;
  doorOpen?: boolean;
  wallColor?: 'red' | 'neutral';
  lightIntensity?: number;
  resetCache?: boolean;
}

export interface GiTelemetry {
  readonly [name: string]: number | string | boolean | null;
}
