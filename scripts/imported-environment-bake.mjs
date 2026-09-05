/** Contributor-only deterministic quadrature. Never imported by the browser runtime. */
export const cubeSize = 64;
export const lutSize = 64;
export const mipLevels = 7;
export const minimumRoughness = 0.06;
export const minimumNoV = 0.0001;
export const prefilterSamples = 256;
export const dfgSamples = 4096;
export const presets = ['studio', 'sky'];
const pi = Math.PI;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit = a => { const length = Math.hypot(...a); return a.map(v => v / length); };

/** WebGPU cube layer order +X,-X,+Y,-Y,+Z,-Z; row zero is the top. */
export function cubeDirection(face, u, v) {
  return unit([[1, -v, -u], [-1, -v, u], [u, 1, v], [u, -1, -v], [u, -v, 1], [-u, -v, -1]][face]);
}
const studioLights = [
  { direction: unit([-.45, .72, .52]), sharpness: 12, color: [4.2, 3.9, 3.6] },
  { direction: unit([.75, .3, -.65]), sharpness: 20, color: [2.8, 3.1, 3.5] },
  { direction: unit([-.5, .1, -.7]), sharpness: 4, color: [.35, .4, .5] },
];
/** Defined scene-linear incident radiance; no source image, exposure gain or geometry. */
export function radiance(preset, direction) {
  if (preset === 'studio') {
    const result = [.025, .03, .04];
    for (const light of studioLights) {
      const weight = Math.exp(light.sharpness * (dot(direction, light.direction) - 1));
      for (let c = 0; c < 3; c++) result[c] += light.color[c] * weight;
    }
    return result;
  }
  if (preset !== 'sky') throw new Error('Unknown generated environment.');
  const y = direction[1];
  const horizon = [.55, .65, .8];
  const pole = y >= 0 ? [.24, .48, .95] : [.045, .04, .035];
  const blend = y >= 0 ? Math.pow(y, .6) : 1 - Math.exp(y * 6);
  return horizon.map((value, c) => value * (1 - blend) + pole[c] * blend);
}

export function shBasis([x, y, z]) {
  return [.28209479177387814, .4886025119029199 * y, .4886025119029199 * z, .4886025119029199 * x,
    1.0925484305920792 * x * y, 1.0925484305920792 * y * z, .31539156525252005 * (3 * z * z - 1),
    1.0925484305920792 * x * z, .5462742152960396 * (x * x - y * y)];
}
const areaElement = (x, y) => Math.atan2(x * y, Math.sqrt(x * x + y * y + 1));
export function solidAngle(x, y, size) {
  const a = 2 * x / size - 1, b = 2 * y / size - 1, d = 2 / size;
  return areaElement(a + d, b + d) - areaElement(a, b + d) - areaElement(a + d, b) + areaElement(a, b);
}
/** Coefficients store irradiance, including the cosine convolution; runtime divides by pi once. */
export function bakeDiffuse(source, size = cubeSize) {
  const sh = Array.from({ length: 9 }, () => [0, 0, 0]);
  for (let face = 0; face < 6; face++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = cubeDirection(face, (x + .5) * 2 / size - 1, (y + .5) * 2 / size - 1);
    const color = source(n), basis = shBasis(n), omega = solidAngle(x, y, size);
    for (let i = 0; i < 9; i++) for (let c = 0; c < 3; c++) sh[i][c] += color[c] * basis[i] * omega;
  }
  return sh.map((coefficient, i) => coefficient.map(value => value * (i === 0 ? pi : i < 4 ? 2 * pi / 3 : pi / 4)));
}
export function evaluateDiffuse(sh, normal) {
  const basis = shBasis(normal);
  return [0, 1, 2].map(c => Math.max(0, sh.reduce((sum, value, i) => sum + value[c] * basis[i], 0)));
}
function radicalInverse(bits) {
  bits = ((bits << 16) | (bits >>> 16)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  return bits * 2.3283064365386963e-10;
}
function halfVectors(roughness, count) {
  const a2 = roughness ** 4;
  return Array.from({ length: count }, (_, i) => {
    const phi = 2 * pi * i / count, u = radicalInverse(i);
    const z = Math.sqrt((1 - u) / (1 + (a2 - 1) * u)), s = Math.sqrt(Math.max(0, 1 - z * z));
    return [s * Math.cos(phi), s * Math.sin(phi), z];
  });
}
/** Split-sum radiance term: N=V=reflection direction, normalized NoL-weighted GGX samples. */
export function prefilter(source, normal, roughness, count = prefilterSamples, samples = halfVectors(roughness, count)) {
  const tangent = unit(cross(Math.abs(normal[2]) < .999 ? [0, 0, 1] : [1, 0, 0], normal));
  const bitangent = cross(normal, tangent), result = [0, 0, 0]; let weight = 0;
  for (const h of samples) {
    const nl = 2 * h[2] * h[2] - 1;
    if (nl <= 0) continue;
    const local = [2 * h[2] * h[0], 2 * h[2] * h[1], nl];
    const direction = [0, 1, 2].map(c => tangent[c] * local[0] + bitangent[c] * local[1] + normal[c] * local[2]);
    const color = source(direction); weight += nl;
    for (let c = 0; c < 3; c++) result[c] += color[c] * nl;
  }
  return result.map(value => value / weight);
}
/** Visible GGX hemisphere sampling; current single-scatter correlated Smith and production guards.
 * The VNDF PDF is D*G1(V)*VoH/NoV; reflection contributes the 1/(4*VoH) Jacobian.
 * See https://pbr-book.org/4ed/Reflection_Models/Roughness_Using_Microfacet_Theory .
 */
export function dfg(noV, roughness, count = dfgSamples) {
  const nv = Math.max(noV, minimumNoV), vx = Math.sqrt(1 - nv * nv), alpha = roughness * roughness, a2 = alpha * alpha;
  const stretched = unit([alpha * vx, 0, nv]), t1 = stretched[0] === 0 ? [1, 0, 0] : [0, 1, 0], t2 = cross(stretched, t1);
  const g1 = 2 * nv / (nv + Math.sqrt(nv * nv + a2 * (1 - nv * nv))), blend = (1 + stretched[2]) / 2;
  let a = 0, b = 0;
  for (let i = 0; i < count; i++) {
    const radius = Math.sqrt((i + .5) / count), phi = 2 * pi * radicalInverse(i), x = radius * Math.cos(phi);
    const y = (1 - blend) * Math.sqrt(Math.max(0, 1 - x * x)) + blend * radius * Math.sin(phi), z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    const hemisphere = [0, 1, 2].map(c => x * t1[c] + y * t2[c] + z * stretched[c]);
    const h = unit([alpha * hemisphere[0], alpha * hemisphere[1], Math.max(0, hemisphere[2])]);
    const vh = vx * h[0] + nv * h[2], nl = 2 * vh * h[2] - nv;
    if (vh <= 0 || nl <= 0) continue;
    const visibility = .5 / Math.max(nl * Math.sqrt(nv * nv * (1 - a2) + a2) + nv * Math.sqrt(nl * nl * (1 - a2) + a2), .00001);
    const weight = 4 * nv * visibility * nl / g1, fresnel = (1 - vh) ** 5;
    a += weight * (1 - fresnel); b += weight * fresnel;
  }
  return [a / count, b / count];
}

/** Finite nonnegative values only; IEEE binary16 round-to-nearest, ties-to-even. */
export function half(value) {
  if (!Number.isFinite(value) || value < 0 || value > 65504) throw new Error('Environment sample is outside finite binary16.');
  if (value === 0) return 0;
  let exponent = Math.floor(Math.log2(value));
  const quantum = 2 ** Math.max(-24, exponent - 10), scaled = value / quantum;
  const floor = Math.floor(scaled), fraction = scaled - floor;
  const rounded = floor + Number(fraction > .5 || (fraction === .5 && (floor & 1) === 1));
  if (exponent < -14) return rounded;
  if (rounded === 2048) { exponent++; return (exponent + 15) << 10; }
  return ((exponent + 15) << 10) | (rounded - 1024);
}
export function bakeCube(source, size = cubeSize, levels = mipLevels, count = prefilterSamples) {
  const values = [];
  for (let level = 0; level < levels; level++) {
    const edge = Math.max(1, size >> level), roughness = minimumRoughness + (1 - minimumRoughness) * level / (levels - 1);
    const samples = halfVectors(roughness, count);
    for (let face = 0; face < 6; face++) for (let y = 0; y < edge; y++) for (let x = 0; x < edge; x++) {
      const n = cubeDirection(face, (x + .5) * 2 / edge - 1, (y + .5) * 2 / edge - 1);
      values.push(...prefilter(source, n, roughness, count, samples).map(half), half(1));
    }
  }
  const bytes = Buffer.alloc(values.length * 2); values.forEach((value, i) => bytes.writeUInt16LE(value, i * 2)); return bytes;
}
export function bakeDfg(size = lutSize, count = dfgSamples) {
  const bytes = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const roughness = minimumRoughness + (1 - minimumRoughness) * y / (size - 1);
    for (let x = 0; x < size; x++) {
      const nv = minimumNoV + (1 - minimumNoV) * (x / (size - 1)) ** 2;
      dfg(nv, roughness, count).forEach((value, c) => bytes.writeUInt16LE(half(value), (y * size + x) * 4 + c * 2));
    }
  }
  return bytes;
}
