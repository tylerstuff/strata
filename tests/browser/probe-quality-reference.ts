import { createReflectionScene } from '../../packages/core/src/reflections/reflection-scene.js';
import type { ReflectionSceneData } from '../../packages/core/src/reflections/reflection-scene.js';

export type V3 = readonly [number, number, number];
export const qualityRegions = [
  { name: 'emitter-near-negative-z', world: [-.45, 0, -.3] as V3 },
  { name: 'emitter-near-positive-z', world: [-.45, 0, .75] as V3 },
  { name: 'left-room-corner', world: [-5.2, 0, 3.1] as V3 },
];
export const qualityPoints = qualityRegions.flatMap((region, regionIndex) => [-.06, 0, .06].flatMap(x => [-.06, 0, .06].map(z => ({
  region: regionIndex, world: [region.world[0] + x, region.world[1], region.world[2] + z] as V3,
}))));
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a: V3): V3 => { const length = Math.hypot(...a); return [a[0] / length, a[1] / length, a[2] / length]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const energy = (v: readonly number[]): number => v.reduce((sum, channel) => sum + channel, 0);

/** Independent slab oracle, including exit hits for rays starting inside a box. */
export function qualityHit(scene: ReflectionSceneData, origin: V3, direction: V3, minDistance = .002, maxDistance = 32) {
  let result: { distance: number; normal: V3; materialId: number; boxId: number } | undefined;
  for (const box of scene.boxes) {
    const c = Math.cos(box.yaw); const s = Math.sin(box.yaw);
    const delta = [origin[0] - box.center[0], origin[1] - box.center[1], origin[2] - box.center[2]];
    const o = [c * delta[0]! - s * delta[2]!, delta[1]!, s * delta[0]! + c * delta[2]!];
    const d = [c * direction[0] - s * direction[2], direction[1], s * direction[0] + c * direction[2]];
    let near = -Infinity; let far = Infinity; let nearAxis = 0; let farAxis = 0; let nearSign = 0; let farSign = 0;
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(d[axis]!) < 1e-12) { if (Math.abs(o[axis]!) > box.halfSize[axis]!) far = -Infinity; continue; }
      const a = (-box.halfSize[axis]! - o[axis]!) / d[axis]!; const b = (box.halfSize[axis]! - o[axis]!) / d[axis]!;
      if (Math.min(a, b) > near) { near = Math.min(a, b); nearAxis = axis; nearSign = a < b ? -1 : 1; }
      if (Math.max(a, b) < far) { far = Math.max(a, b); farAxis = axis; farSign = a < b ? 1 : -1; }
    }
    const inside = near < minDistance; const distance = inside ? far : near;
    if (near > far || distance < minDistance || distance > maxDistance || (result && distance >= result.distance)) continue;
    const n = [0, 0, 0]; n[inside ? farAxis : nearAxis] = inside ? farSign : nearSign;
    result = { distance, normal: [c * n[0]! + s * n[2]!, n[1]!, -s * n[0]! + c * n[2]!], materialId: box.materialId, boxId: box.id };
  }
  return result;
}

export function qualityIncoming(scene: ReflectionSceneData, origin: V3, direction: V3) {
  const hit = qualityHit(scene, origin, direction);
  const emission = [0, 0, 0]; const direct = [0, 0, 0];
  if (hit && dot(hit.normal, direction) < 0) {
    const material = scene.materials[hit.materialId]!; emission.splice(0, 3, ...material.emission);
    const cosine = Math.max(0, dot(hit.normal, scene.light.direction));
    const point: V3 = [origin[0] + direction[0] * hit.distance + hit.normal[0] * .002,
      origin[1] + direction[1] * hit.distance + hit.normal[1] * .002, origin[2] + direction[2] * hit.distance + hit.normal[2] * .002];
    if (cosine > 0 && !qualityHit(scene, point, scene.light.direction)) {
      for (let channel = 0; channel < 3; channel++) direct[channel] = material.albedo[channel]! * (1 - (material.metallic ?? 0)) * scene.light.radiance[channel]! * cosine / Math.PI;
    }
  }
  return { radiance: emission.map((v, i) => v + direct[i]!) as unknown as V3, emission, direct,
    distance: hit?.distance ?? 32, status: hit && dot(hit.normal, direction) >= 0 ? -1 : 1, boxId: hit?.boxId ?? null };
}

export interface DirectionReference { irradiance: number[]; emissionIrradiance: number[]; directIrradiance: number[]; blockEnergyMeans: number[]; blockStandardError: number; samples: number }
/** Cosine-hemisphere integration at arbitrary positions/normals. Result is E, not receiver radiance. */
export function integrateQualityReference(scene: ReflectionSceneData, points: readonly V3[], normal: V3, samples: number, seed = 1337): DirectionReference {
  if (!Number.isInteger(samples) || samples < 64 || samples % 8 !== 0 || points.length === 0) throw new Error('Reference requires nonempty points and a positive multiple of eight samples.');
  const n = norm(normal); const tangent = norm(cross(Math.abs(n[1]) < .9 ? [0, 1, 0] : [0, 0, 1], n)); const bitangent = cross(n, tangent);
  const blocks = Array.from({ length: 8 }, () => [0, 0, 0]); const emission = [0, 0, 0]; const direct = [0, 0, 0];
  let state = seed >>> 0; const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
  for (let sample = 0; sample < samples; sample++) {
    const u = random(); const angle = 2 * Math.PI * random(); const a = Math.sqrt(u) * Math.cos(angle); const b = Math.sqrt(u) * Math.sin(angle); const c = Math.sqrt(1 - u);
    const direction: V3 = [tangent[0] * a + bitangent[0] * b + n[0] * c, tangent[1] * a + bitangent[1] * b + n[1] * c, tangent[2] * a + bitangent[2] * b + n[2] * c];
    const incoming = qualityIncoming(scene, points[sample % points.length]!, direction);
    for (let channel = 0; channel < 3; channel++) {
      blocks[sample % 8]![channel]! += incoming.radiance[channel]! * Math.PI * 8 / samples;
      emission[channel]! += incoming.emission[channel]! * Math.PI / samples;
      direct[channel]! += incoming.direct[channel]! * Math.PI / samples;
    }
  }
  const irradiance = [0, 1, 2].map(channel => blocks.reduce((sum, block) => sum + block[channel]!, 0) / 8);
  const blockEnergyMeans = blocks.map(energy); const meanEnergy = energy(irradiance);
  return { irradiance, emissionIrradiance: emission, directIrradiance: direct, blockEnergyMeans,
    blockStandardError: Math.sqrt(blockEnergyMeans.reduce((sum, value) => sum + (value - meanEnergy) ** 2, 0) / 7 / 8), samples };
}

export function halfFloat(word: number): number {
  const sign = word & 0x8000 ? -1 : 1; const exponent = (word >>> 10) & 31; const fraction = word & 1023;
  return exponent === 0 ? sign * 2 ** -14 * fraction / 1024 : exponent === 31 ? (fraction ? NaN : sign * Infinity) : sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}
export interface OctTap { x: number; y: number; weight: number; direction: V3 }
export function octTaps(direction: V3, size: number): OctTap[] {
  const denominator = Math.abs(direction[0]) + Math.abs(direction[1]) + Math.abs(direction[2]);
  let x = direction[0] / denominator; let y = direction[1] / denominator;
  if (direction[2] < 0) { const oldX = x; x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1); y = (1 - Math.abs(oldX)) * (y >= 0 ? 1 : -1); }
  const pixel = [(x * .5 + .5) * size - .5, (y * .5 + .5) * size - .5]; const low = pixel.map(Math.floor); const f = pixel.map((v, i) => v - low[i]!);
  const taps: OctTap[] = [];
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    let tx = low[0]! + i; let ty = low[1]! + j;
    if (tx < 0) { tx = -tx - 1; ty = size - ty - 1; } else if (tx >= size) { tx = 2 * size - tx - 1; ty = size - ty - 1; }
    if (ty < 0) { ty = -ty - 1; tx = size - tx - 1; } else if (ty >= size) { ty = 2 * size - ty - 1; tx = size - tx - 1; }
    const weight = (i ? f[0]! : 1 - f[0]!) * (j ? f[1]! : 1 - f[1]!);
    let dx = 2 * (tx + .5) / size - 1; let dy = 2 * (ty + .5) / size - 1; const dz = 1 - Math.abs(dx) - Math.abs(dy);
    if (dz < 0) { const oldX = dx; dx = (1 - Math.abs(dy)) * (dx >= 0 ? 1 : -1); dy = (1 - Math.abs(oldX)) * (dy >= 0 ? 1 : -1); }
    const existing = taps.find(tap => tap.x === tx && tap.y === ty);
    if (existing) existing.weight += weight; else taps.push({ x: tx, y: ty, weight, direction: norm([dx, dy, dz]) });
  }
  return taps.filter(tap => tap.weight > 1e-12);
}

export interface ProbeQualityConfig { origin: V3; spacing: number; grid: V3; probeCount: number; start: number; count: number; rays: number; epoch: number; hysteresis: number; normalBias: number; frame: number; maxAge: number; columns: number; irradianceSize: number; momentSize: number }
export function decodeQualityConfig(buffer: ArrayBuffer): ProbeQualityConfig {
  const f = new Float32Array(buffer); const u = new Uint32Array(buffer);
  return { origin: [f[0]!, f[1]!, f[2]!], spacing: f[3]!, grid: [u[4]!, u[5]!, u[6]!], probeCount: u[7]!, start: u[8]!, count: u[9]!, rays: u[10]!, epoch: u[11]!,
    hysteresis: f[12]!, normalBias: f[14]!, frame: u[16]!, maxAge: u[19]!, columns: u[20]!, irradianceSize: u[21]!, momentSize: u[22]! };
}
export function probePosition(id: number, config: ProbeQualityConfig): V3 {
  return [config.origin[0] + id % config.grid[0] * config.spacing,
    config.origin[1] + Math.floor(id / config.grid[0]) % config.grid[1] * config.spacing,
    config.origin[2] + Math.floor(id / (config.grid[0] * config.grid[1])) * config.spacing];
}
export function contributors(world: V3, config: ProbeQualityConfig) {
  const point: V3 = [world[0], world[1] + config.normalBias + .02, world[2]];
  const grid = point.map((v, i) => (v - config.origin[i]!) / config.spacing); const base = grid.map(Math.floor); const f = grid.map((v, i) => v - base[i]!);
  const result = [];
  for (let corner = 0; corner < 8; corner++) {
    const offset = [corner & 1, (corner >>> 1) & 1, (corner >>> 2) & 1]; const cell = base.map((v, i) => v + offset[i]!);
    if (cell.some((v, i) => v < 0 || v >= config.grid[i]!)) continue;
    const id = cell[0]! + cell[1]! * config.grid[0] + cell[2]! * config.grid[0] * config.grid[1]; const position = probePosition(id, config);
    const delta: V3 = [point[0] - position[0], point[1] - position[1], point[2] - position[2]]; const distance = Math.hypot(...delta);
    const direction = distance > 1e-5 ? norm(delta) : [0, 1, 0] as V3;
    result.push({ id, point, position, distance, direction, trilinear: offset.reduce((v, bit, i) => v * (bit ? f[i]! : 1 - f[i]!), 1), orientation: Math.max(.05, -direction[1] * .5 + .5) ** 2 });
  }
  return result;
}
export function visibilityWeight(distance: number, moments: readonly number[]): number {
  if (distance <= moments[0]! + .02) return 1;
  const variance = Math.max(moments[1]! - moments[0]! ** 2, .0001); const delta = distance - moments[0]!;
  return (variance / (variance + delta * delta)) ** 3;
}

export interface QualityProbe { id: number; position: V3; state: number[]; taps: (OctTap & { value: number[] })[]; irradiance: number[]; rawRays?: number[][] }
export interface QualityNeighbor { id: number; distance: number; direction: V3; trilinear: number; orientation: number; eligible: boolean; momentTaps: (OctTap & { value: number[] })[]; moments: number[]; visibility: number; weight: number; segmentOccluded: boolean }
export interface QualityPoint { world: V3; region: number; biasedPoint: V3; gpuRadiance: number[]; cpuRadiance: number[]; totalWeight: number; neighbors: QualityNeighbor[] }
export interface QualityFrame { frameIndex: number; config: ProbeQualityConfig; probes: QualityProbe[]; points: QualityPoint[]; traceCounters: number[] }
export interface QualityCapture { frames: QualityFrame[]; sceneState: ReflectionSceneData['state']; maxSamplerReconstructionError: number; maxTransferredRayRadianceError: number; maxTransferredRayDistanceError: number; rayComparisons: number }

export function combineQuality(probes: QualityProbe[], neighbors: QualityNeighbor[], reference?: Map<number, number[]>): number[] {
  const total = neighbors.reduce((sum, item) => sum + item.weight, 0); const denominator = Math.max(total, 1e-5);
  return [0, 1, 2].map(channel => neighbors.reduce((sum, item) => sum + (reference?.get(item.id) ?? probes.find(probe => probe.id === item.id)!.irradiance)[channel]! * item.weight, 0) / denominator * (.72 / Math.PI));
}

export function finiteRayIrradiance(rays: readonly number[][], normal: V3): number[] {
  const weights = rays.map(ray => Math.max(0, dot(normal, [ray[4]!, ray[5]!, ray[6]!])));
  const denominator = Math.max(weights.reduce((sum, value) => sum + value, 0), 1e-6);
  return [0, 1, 2].map(channel => rays.reduce((sum, ray, index) => sum + ray[channel]! * weights[index]!, 0) * Math.PI / denominator);
}

/** Offline analysis; independent integration runs only after the browser is closed. */
export function analyzeProbeQuality(capture: QualityCapture, samples = 262144, cornerSamples = 1048576) {
  const scene = createReflectionScene(capture.sceneState); const first = capture.frames[0]!; const references = new Map<number, number[]>(); const upwardReferences = new Map<number, number[]>();
  const cornerIds = new Set(first.points.filter(point => point.region === 2).flatMap(point => point.neighbors.map(neighbor => neighbor.id)));
  const probeReferences = first.probes.map(probe => {
    const count = cornerIds.has(probe.id) ? cornerSamples : samples;
    const directions = probe.taps.map((tap, index) => ({ ...tap, reference: integrateQualityReference(scene, [probe.position], tap.direction, count, 1337 + probe.id * 101 + index) }));
    const irradiance = [0, 1, 2].map(channel => directions.reduce((sum, direction) => sum + direction.weight * direction.reference.irradiance[channel]!, 0));
    references.set(probe.id, irradiance);
    const exactUp = integrateQualityReference(scene, [probe.position], [0, 1, 0], count, 7717 + probe.id * 101); upwardReferences.set(probe.id, exactUp.irradiance);
    return { id: probe.id, position: probe.position, directions, sampledIrradiance: irradiance, exactUp };
  });
  const surfaceReferences = qualityRegions.map((region, index) => ({ name: region.name,
    reference: integrateQualityReference(scene, qualityPoints.filter(point => point.region === index).map(point => [point.world[0], point.world[1] + .002, point.world[2]]), [0, 1, 0], index === 2 ? cornerSamples : samples, 1337 + index * 101) }));
  const combinations = capture.frames.map(frame => ({ frameIndex: frame.frameIndex, points: frame.points.map((point, index) => ({
    region: point.region, P: combineQuality(frame.probes, point.neighbors), E: combineQuality(frame.probes, point.neighbors, references),
    V: combineQuality(frame.probes, first.points[index]!.neighbors), EV: combineQuality(frame.probes, first.points[index]!.neighbors, references),
    EU: combineQuality(frame.probes, point.neighbors, upwardReferences),
  })) }));
  const summarize = (values: number[]) => { const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return { mean, standardDeviation: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length), min: Math.min(...values), max: Math.max(...values) }; };
  const probeEstimates = probeReferences.map(reference => {
    const observations = capture.frames.map(frame => ({ frame, probe: frame.probes.find(probe => probe.id === reference.id)! }));
    const refreshes = observations.flatMap(({ frame, probe }, index) => {
      if (!probe.rawRays) return [];
      const previous = index > 0 ? observations[index - 1]!.probe : undefined;
      const taps = probe.taps.map((tap, tapIndex) => {
        const finiteIrradiance = finiteRayIrradiance(probe.rawRays!, tap.direction);
        const predictedHistory = previous ? finiteIrradiance.map((value, channel) => value * (1 - frame.config.hysteresis) + previous.taps[tapIndex]!.value[channel]! * frame.config.hysteresis) : null;
        return { x: tap.x, y: tap.y, finiteIrradiance, actualStoredIrradiance: tap.value, predictedHistory,
          maxHistoryReconstructionError: predictedHistory ? Math.max(...predictedHistory.map((value, channel) => Math.abs(value - tap.value[channel]!))) : null };
      });
      const emitterHits = probe.rawRays.filter(ray => qualityIncoming(scene, probe.position, [ray[4]!, ray[5]!, ray[6]!]).boxId === scene.objectBoxId).length;
      return [{ frameIndex: frame.frameIndex, emitterHits, taps }];
    });
    const actual = summarize(observations.map(({ probe }) => energy(probe.irradiance)));
    const expected = energy(reference.sampledIrradiance);
    return { id: reference.id, actualIrradianceEnergy: actual, referenceIrradianceEnergy: expected,
      relativeBias: (actual.mean - expected) / Math.max(expected, 1e-12), angularReferenceDifference: expected - energy(reference.exactUp.irradiance), refreshes };
  });
  const regions = qualityRegions.map((region, index) => {
    const referenceEnergy = energy(surfaceReferences[index]!.reference.irradiance) * .72 / Math.PI;
    return { name: region.name, referenceEnergy, referenceBlockStandardError: surfaceReferences[index]!.reference.blockStandardError * .72 / Math.PI,
      combinations: Object.fromEntries((['P', 'E', 'V', 'EV', 'EU'] as const).map(key => {
        const values = combinations.map(frame => { const points = frame.points.filter(point => point.region === index); return points.reduce((sum, point) => sum + energy(point[key]), 0) / points.length; });
        const distribution = summarize(values); return [key, { ...distribution, relativeBias: (distribution.mean - referenceEnergy) / Math.max(referenceEnergy, 1e-12) }];
      })) };
  });
  return { referenceSamplesPerDirection: samples, cornerReferenceSamplesPerDirection: cornerSamples, referenceUnits: 'linear irradiance E; receiver radiance=.72*E/pi',
    frozenWeights: { frameIndex: first.frameIndex, truthClaim: false, scope: 'Single production snapshot held fixed; variance attribution only, not a visibility oracle.' },
    probeReferences, probeEstimates, surfaceReferences, combinations, regions };
}
