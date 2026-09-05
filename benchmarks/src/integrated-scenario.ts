export { integratedScenario } from '../../packages/core/src/integrated/integrated-scene.js';
export const integratedEvents = [
  { atSeconds: 2, objectMotion: 'sinusoid', untilSeconds: 6, amplitude: 0.4, periodSeconds: 4 },
  { atSeconds: 4, doorOpen: false }, { atSeconds: 8, doorOpen: true },
  { atSeconds: 14, lightIntensity: 0 }, { atSeconds: 18, lightIntensity: 1 },
];
