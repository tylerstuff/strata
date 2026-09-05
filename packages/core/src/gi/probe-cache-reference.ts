/** CPU counterparts for the bounded probe integrator and visibility filter. */
export type ProbeVector = readonly [number, number, number];
const dot = (a: ProbeVector, b: ProbeVector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export function probeDirection(index: number, count: number, phase = 0): ProbeVector {
  const y = 1 - 2 * (index + 0.5) / count; const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const angle = index * 2.399963229728653 + phase;
  return [Math.cos(angle) * radius, y, Math.sin(angle) * radius];
}
export function octahedralDirection(u: number, v: number): ProbeVector {
  let x = 2 * u - 1; let y = 2 * v - 1; const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) { const oldX = x; x = (1 - Math.abs(y)) * (oldX >= 0 ? 1 : -1); y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1); }
  const length = Math.hypot(x, y, z); return [x / length, y / length, z / length];
}
export function encodeOctahedral(direction: ProbeVector): readonly [number, number] {
  const length = Math.abs(direction[0]) + Math.abs(direction[1]) + Math.abs(direction[2]);
  let x = direction[0] / length; let y = direction[1] / length;
  if (direction[2] < 0) { const oldX = x; x = (1 - Math.abs(y)) * (oldX >= 0 ? 1 : -1); y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1); }
  return [x * 0.5 + 0.5, y * 0.5 + 0.5];
}
/** Normalized cosine quadrature stores irradiance E. Receiver shading must multiply by albedo/pi. */
export function integrateProbeIrradiance(normal: ProbeVector, rays: readonly { direction: ProbeVector; radiance: ProbeVector }[]): ProbeVector {
  const sum = [0, 0, 0]; let weight = 0;
  for (const ray of rays) {
    const cosine = Math.max(0, dot(normal, ray.direction)); weight += cosine;
    for (let channel = 0; channel < 3; channel++) sum[channel]! += ray.radiance[channel]! * cosine;
  }
  return sum.map(value => Math.PI * value / Math.max(weight, 1e-6)) as unknown as ProbeVector;
}
export function probeVisibility(distance: number, mean: number, secondMoment: number): number {
  if (distance <= mean + 0.02) return 1;
  const variance = Math.max(secondMoment - mean * mean, 0.0001); const delta = distance - mean;
  const probability = variance / (variance + delta * delta);
  return probability * probability * probability;
}
export function probeHistoryWeight(oldEpoch: number, newEpoch: number, oldValid: boolean, hysteresis: number): number {
  return oldEpoch === newEpoch && oldValid ? hysteresis : 0;
}

/** Fold a one-texel octahedral border back into the same tile, reversing its opposite axis. */
export function wrapOctahedralTexel(x: number, y: number, size: number): readonly [number, number] {
  if (x < 0) { x = -x - 1; y = size - y - 1; }
  else if (x >= size) { x = 2 * size - x - 1; y = size - y - 1; }
  if (y < 0) { y = -y - 1; x = size - x - 1; }
  else if (y >= size) { y = 2 * size - y - 1; x = size - x - 1; }
  return [x, y];
}
