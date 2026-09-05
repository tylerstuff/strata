/** Binary64, test-only specification of the frozen spatial reconstruction contract.
 * No runtime/shader imports. Analytic plane intersections and known linear fields
 * provide independent truth; this is not a model of f32 instruction rounding.
 * Recovered I is irradiance/pi: remodulation is rho*I, with no extra pi.
 */
export type SpatialVector = readonly [number, number, number];
export interface ReferenceSpatialGuide {
  readonly valid: boolean;
  readonly rho: SpatialVector;
  readonly point: SpatialVector;
  readonly normal: SpatialVector;
  readonly footprint: number;
  readonly triangleExtent: number;
  readonly materialId: number;
}
export interface ReferenceSpatialPixel {
  readonly sum: SpatialVector;
  readonly samples: number;
  readonly status: number;
  readonly direct: SpatialVector;
  readonly guide: ReferenceSpatialGuide;
}
export interface ReferenceSpatialResult {
  readonly indirect: SpatialVector;
  readonly composed: SpatialVector;
  readonly fallbackChannels: number;
  readonly hdrFaultChannels: number;
  readonly filtered: boolean;
  readonly guideBypass: boolean;
}
export interface ReferenceClipRay { readonly near: SpatialVector; readonly far: SpatialVector }
export const spatialReferenceLimits = Object.freeze({
  hdr: 65472, raw: 65504, minimumRawMean: 2 ** -126, minimumRho: 2 ** -16,
  minimumIncident: 2 ** -90, maximumIncident: 2 ** 32, maximumWeightedSum: 2 ** 40,
  maximumWeight: 256, minimumNormalAgreement: .95, minimumRayCosine: .1,
});
const spatialKernel = [1, 4, 6, 4, 1] as const;
const finite3 = (v: SpatialVector): boolean => v.every(Number.isFinite);
const dot = (a: SpatialVector, b: SpatialVector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: SpatialVector, b: SpatialVector): SpatialVector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const magnitude = (v: SpatialVector): number => Math.hypot(...v);
const maxAbs = (v: SpatialVector): number => Math.max(...v.map(Math.abs));
const eligible = (p: ReferenceSpatialPixel): boolean => p.status === 0 && Number.isInteger(p.samples) && p.samples > 0;
const validGuide = (g: ReferenceSpatialGuide): boolean => g.valid && finite3(g.rho) && g.rho.every(v => v >= 0 && v <= 65504)
  && finite3(g.point) && finite3(g.normal) && Math.abs(magnitude(g.normal) - 1) < 1e-5
  && Number.isFinite(g.footprint) && g.footprint > 0 && Number.isFinite(g.triangleExtent) && g.triangleExtent >= 0;

/** Intersection of each actual adjacent near/far clip segment with the hit's
 * tangent plane. The largest displacement is the conservative pixel footprint.
 * No eye distance, clip.w or perspective-only shortcut participates.
 */
export function tangentPlaneFootprint(point: SpatialVector, normal: SpatialVector,
  adjacentRays: readonly [ReferenceClipRay, ReferenceClipRay]): number | null {
  if (!finite3(point) || !finite3(normal) || Math.abs(magnitude(normal) - 1) > 1e-6) return null;
  const distances: number[] = [];
  for (const ray of adjacentRays) {
    if (!finite3(ray.near) || !finite3(ray.far)) return null;
    const d = sub(ray.far, ray.near), length = magnitude(d);
    if (!(length > 0)) return null;
    const denominator = dot(normal, d);
    if (Math.abs(denominator) / length < .1) return null;
    const t = dot(normal, sub(point, ray.near)) / denominator;
    if (!Number.isFinite(t) || t < 0 || t > 1) return null;
    const hit: SpatialVector = [ray.near[0] + t * d[0], ray.near[1] + t * d[1], ray.near[2] + t * d[2]];
    distances.push(magnitude(sub(hit, point)));
  }
  const answer = Math.max(...distances);
  return Number.isFinite(answer) && answer > 0 ? answer : null;
}

/** Dimensionless geometric factor; spatial binomial weights are applied later.
 * No triangle identity test: differently triangulated coplanar samples can mix.
 */
export function spatialGuideWeight(center: ReferenceSpatialGuide, donor: ReferenceSpatialGuide, screenDistance: number): number {
  if (!validGuide(center) || !validGuide(donor) || center.materialId !== donor.materialId) return 0;
  const agreement = Math.max(0, Math.min(1, dot(center.normal, donor.normal)));
  if (agreement < .95) return 0;
  const delta = sub(donor.point, center.point);
  const tolerance = .05 * Math.min(center.footprint, donor.footprint)
    + 8 * 2 ** -23 * (maxAbs(center.point) + maxAbs(donor.point) + center.triangleExtent + donor.triangleExtent);
  if (Math.abs(dot(delta, center.normal)) > tolerance || Math.abs(dot(delta, donor.normal)) > tolerance) return 0;
  if (magnitude(delta) > (screenDistance + 1.5) * Math.max(center.footprint, donor.footprint)) return 0;
  return Math.max(.125, Math.min(1, agreement ** 32));
}
function rawChannel(p: ReferenceSpatialPixel, channel: number): number | null {
  const sum = p.sum[channel]!;
  if (!Number.isInteger(p.samples) || p.samples < 1 || p.samples > 1024 || !Number.isFinite(sum) || sum < 0) return null;
  if (sum === 0) return 0; // Both signs of zero carry an exact completed-zero estimate.
  if (sum < p.samples * 2 ** -126 || sum > p.samples * 65504) return null;
  return sum / p.samples;
}
export function referenceSpatialPixel(pixels: readonly ReferenceSpatialPixel[], width: number, height: number,
  x: number, y: number, options: { readonly enabled?: boolean } = {}): ReferenceSpatialResult {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || pixels.length !== width * height
    || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) throw new Error('Invalid reference grid.');
  const center = pixels[y * width + x]!, direct = center.direct;
  if (!eligible(center)) return { indirect: [0, 0, 0], composed: [...direct], fallbackChannels: 0, hdrFaultChannels: 0, filtered: false, guideBypass: false };
  const rawValues = [0, 1, 2].map(c => rawChannel(center, c));
  const hdrFaultChannels = rawValues.filter((raw, c) => raw === null || !Number.isFinite(direct[c]!) || direct[c]! < 0
    || direct[c]! > 65472 || raw > 65472 - direct[c]!).length;
  // A presentation fault is a whole-pixel marker, never a partially filtered
  // color. Its specific marker hue is deliberately outside this numeric oracle.
  if (hdrFaultChannels) return { indirect: [NaN, NaN, NaN], composed: [NaN, NaN, NaN], hdrFaultChannels,
    fallbackChannels: 0, filtered: false, guideBypass: false };
  const indirect: [number, number, number] = [0, 0, 0], composed: [number, number, number] = [0, 0, 0];
  let fallbackChannels = 0, filtered = false;
  const guideBypass = options.enabled !== false && !validGuide(center.guide);
  for (let c = 0; c < 3; c++) {
    const raw = rawValues[c]!, d = direct[c]!;
    indirect[c] = raw; composed[c] = d + raw;
    if (options.enabled === false || guideBypass) continue;
    const rho = center.guide.rho[c]!;
    if (rho === 0) { indirect[c] = 0; composed[c] = d; continue; }
    if (rho < 2 ** -16) { fallbackChannels++; continue; }
    filtered = true; // Header counts entering the gather, including eventual fallback.
    let weightSum = 0, weightedIncident = 0, unsafe = false;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const qx = x + dx, qy = y + dy;
      if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
      const donor = pixels[qy * width + qx]!;
      if (!eligible(donor)) continue;
      const geometryWeight = spatialGuideWeight(center.guide, donor.guide, Math.hypot(dx, dy));
      if (geometryWeight === 0) continue;
      const donorRho = donor.guide.rho[c]!;
      if (donorRho === 0) continue;
      const donorRaw = rawChannel(donor, c);
      if (donorRho < 2 ** -16 || donorRaw === null
        || (donor.sum[c]! > 0 && donor.sum[c]! < donor.samples * donorRho * 2 ** -90)) { unsafe = true; continue; }
      const incident = donorRaw / donorRho;
      if (!Number.isFinite(incident) || incident >= 2 ** 32 || (donorRaw > 0 && incident === 0)) { unsafe = true; continue; }
      const weight = spatialKernel[dx + 2]! * spatialKernel[dy + 2]! * geometryWeight;
      weightSum += weight; weightedIncident += weight * incident;
    }
    if (unsafe || weightSum === 0 || weightSum > 256 || weightedIncident >= 2 ** 40) { fallbackChannels++; continue; }
    const incident = weightedIncident / weightSum;
    if (!Number.isFinite(incident) || incident > (65472 - d) / rho) { fallbackChannels++; continue; }
    indirect[c] = incident * rho; composed[c] = d + incident * rho;
  }
  return { indirect, composed, fallbackChannels, hdrFaultChannels, filtered, guideBypass };
}

export const spatialTruthSeeds = Object.freeze([1, 17, 1337, 0xdecafbad]);
/** Frozen before GPU observation. Noise reduction is compared to known scene-
 * linear truth, not to another blurred image. Boundary gates are separate.
 */
export const spatialTruthGates = Object.freeze({ maxMseRatio: .25, maxVarianceRatio: .25, maxRelativeMeanError: .10,
  exactDoubleTolerance: 1e-12, gpuAbsoluteTolerance: .001, gpuRelativeTolerance: .003 });
export interface SpatialTruthFixture {
  readonly width: number; readonly height: number; readonly seed: number;
  readonly pixels: readonly ReferenceSpatialPixel[]; readonly truth: readonly SpatialVector[];
}
export function makeSpatialTruthFixture(seed: number, width = 17, height = 17): SpatialTruthFixture {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || width < 5 || height < 5) throw new Error('Invalid fixture inputs.');
  let sequence = seed >>> 0;
  const random = (): number => { sequence = (Math.imul(sequence, 1664525) + 1013904223) >>> 0; return sequence / 2 ** 32; };
  const pixels: ReferenceSpatialPixel[] = [], truth: SpatialVector[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const incident = .8 + .02 * x + .01 * y;
    // Texture contrast is independent of illumination noise and must survive remodulation.
    const rho: SpatialVector = [(x + y) % 2 ? .8 : .02, x % 3 ? .1 : .7, y % 4 ? .05 : .9];
    const exact: SpatialVector = [rho[0] * incident, rho[1] * incident, rho[2] * incident];
    const noisy = incident * (1 + .9 * (2 * random() - 1));
    truth.push(exact);
    pixels.push({ sum: [rho[0] * noisy * 64, rho[1] * noisy * 64, rho[2] * noisy * 64], samples: 64, status: 0,
      direct: [.1, .2, .3], guide: { valid: true, rho, point: [x, y, 0], normal: [0, 0, 1], footprint: 1, triangleExtent: 2, materialId: 0 } });
  }
  return { width, height, seed, pixels, truth };
}
export function spatialTruthMetrics(fixture: SpatialTruthFixture): {
  rawMse: number; filteredMse: number; mseRatio: number; relativeMeanError: number;
  rawMeanError: number; filteredMeanError: number; rawResidualVariance: number; filteredResidualVariance: number; varianceRatio: number;
} {
  const { pixels, width, height, truth } = fixture;
  let rawSse = 0, filteredSse = 0, rawErrorSum = 0, filteredErrorSum = 0, expectedSum = 0, reconstructedSum = 0, count = 0;
  // Interior prevents truncated-kernel bias being confused with reconstruction accuracy.
  for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
    const index = y * width + x, p = pixels[index]!, answer = referenceSpatialPixel(pixels, width, height, x, y);
    for (let c = 0; c < 3; c++) {
      const exact = truth[index]![c]!;
      rawSse += (p.sum[c]! / p.samples - exact) ** 2;
      filteredSse += (answer.indirect[c]! - exact) ** 2;
      rawErrorSum += p.sum[c]! / p.samples - exact;
      filteredErrorSum += answer.indirect[c]! - exact;
      expectedSum += exact; reconstructedSum += answer.indirect[c]!; count++;
    }
  }
  const rawMeanError = rawErrorSum / count, filteredMeanError = filteredErrorSum / count;
  const rawResidualVariance = Math.max(0, rawSse / count - rawMeanError ** 2);
  const filteredResidualVariance = Math.max(0, filteredSse / count - filteredMeanError ** 2);
  return { rawMse: rawSse / count, filteredMse: filteredSse / count, mseRatio: filteredSse / rawSse,
    rawMeanError, filteredMeanError, rawResidualVariance, filteredResidualVariance, varianceRatio: filteredResidualVariance / rawResidualVariance,
    relativeMeanError: Math.abs(reconstructedSum - expectedSum) / expectedSum };
}

/** Frozen wire flags, checked independently of the production shader. */
export function decodeSpatialGuideMetadata(word: number): { triangle: number; flipped: boolean } | null {
  if (!Number.isInteger(word) || word < 0 || word > 0xffffffff || (word & 0xffc00000) !== 0 || (word & 0x00100000) === 0) return null;
  return { triangle: word & 0x000fffff, flipped: (word & 0x00200000) !== 0 };
}
/** CPU oracles should evaluate the exact values sent to GPU, not an unrounded
 * precursor that straddles a geometry/numeric threshold. */
export function roundSpatialPixelToF32(p: ReferenceSpatialPixel): ReferenceSpatialPixel {
  const vector = (v: SpatialVector): SpatialVector => [Math.fround(v[0]), Math.fround(v[1]), Math.fround(v[2])];
  return { ...p, sum: vector(p.sum), direct: vector(p.direct), guide: { ...p.guide,
    rho: vector(p.guide.rho), point: vector(p.guide.point), normal: vector(p.guide.normal),
    footprint: Math.fround(p.guide.footprint), triangleExtent: Math.fround(p.guide.triangleExtent) } };
}
