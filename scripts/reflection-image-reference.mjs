// Independent image oracle: deterministic area quadrature and oriented-box slabs.
// This module imports no engine code, random sampler, traversal, or WGSL helper.
export const imageOracleSettings = Object.freeze({ width: 320, height: 180, columns: 32, rows: 18,
  firstX: 112, firstY: 63, pixelStep: 3, frames: 240, tailFrames: 60, maxDistance: 16,
  normalBias: .002, tMin: .002, quadratureCoarse: 64, quadratureFine: 128 });
export const witnesses = () => Array.from({ length: imageOracleSettings.columns * imageOracleSettings.rows }, (_, i) =>
  [imageOracleSettings.firstX + i % imageOracleSettings.columns * imageOracleSettings.pixelStep,
    imageOracleSettings.firstY + Math.floor(i / imageOracleSettings.columns) * imageOracleSettings.pixelStep]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a, b) => a.map((value, i) => value - b[i]);
const normalize = a => { const length = Math.hypot(...a); return a.map(value => value / length); };
export function inverseMatrix(matrix) {
  const rows = Array.from({ length: 4 }, (_, row) => [...Array.from({ length: 4 }, (_, column) => matrix[column * 4 + row]),
    ...Array.from({ length: 4 }, (_, column) => Number(row === column))]);
  for (let column = 0; column < 4; column++) {
    let pivot = column; for (let row = column + 1; row < 4; row++) if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]]; const divisor = rows[column][column];
    if (Math.abs(divisor) < 1e-12) throw new Error('Singular reference camera.');
    rows[column] = rows[column].map(value => value / divisor);
    for (let row = 0; row < 4; row++) if (row !== column) { const amount = rows[row][column]; rows[row] = rows[row].map((value, i) => value - amount * rows[column][i]); }
  }
  return Array.from({ length: 16 }, (_, i) => rows[i % 4][4 + Math.floor(i / 4)]);
}
function multiply(matrix, value) { return Array.from({ length: 4 }, (_, row) => value.reduce((sum, component, column) => sum + matrix[column * 4 + row] * component, 0)); }
export function intersectBox(origin, direction, box, tMin = .002, tMax = 16) {
  const c = Math.cos(box.yaw); const s = Math.sin(box.yaw); const delta = subtract(origin, box.center);
  const o = [c * delta[0] - s * delta[2], delta[1], s * delta[0] + c * delta[2]];
  const d = [c * direction[0] - s * direction[2], direction[1], s * direction[0] + c * direction[2]];
  let lo = tMin; let hi = tMax;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis]) < 1e-12) { if (Math.abs(o[axis]) > box.halfSize[axis]) return null; continue; }
    const a = (-box.halfSize[axis] - o[axis]) / d[axis]; const b = (box.halfSize[axis] - o[axis]) / d[axis];
    lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b)); if (lo > hi) return null;
  }
  return lo;
}
function aabb(box) {
  const c = Math.abs(Math.cos(box.yaw)); const s = Math.abs(Math.sin(box.yaw));
  const half = [c * box.halfSize[0] + s * box.halfSize[2], box.halfSize[1], s * box.halfSize[0] + c * box.halfSize[2]];
  return { min: box.center.map((v, i) => v - half[i]), max: box.center.map((v, i) => v + half[i]) };
}
export function ggxBrdf(view, light, roughness, f0) {
  const nv = view[1]; const nl = light[1]; if (nv <= 0 || nl <= 0) return 0;
  const half = normalize(view.map((v, i) => v + light[i])); const nh = half[1]; const vh = Math.max(0, Math.min(1, dot(view, half)));
  const alpha2 = Math.max(roughness * roughness, 1e-6) ** 2;
  const denominator = nh * nh * (alpha2 - 1) + 1;
  const distribution = alpha2 / (Math.PI * denominator * denominator);
  const g1 = cosine => 2 * cosine / (cosine + Math.sqrt(alpha2 + (1 - alpha2) * cosine * cosine));
  const fresnel = f0 + (1 - f0) * (1 - vh) ** 5;
  return fresnel * distribution * g1(nv) * g1(nl) / (4 * nv * nl);
}
export function referencePrimaryPoint(camera, inverse, x, y, width = 320, height = 180) {
  const far = multiply(inverse, [(x + .5) / width * 2 - 1, 1 - (y + .5) / height * 2, 1, 1]);
  const ray = normalize(far.slice(0, 3).map((value, axis) => value / far[3] - camera.eye[axis]));
  const distance = (.01 - camera.eye[1]) / ray[1];
  return { distance, ray, point: camera.eye.map((value, axis) => value + distance * ray[axis]) };
}
export function buildImageReference(scene, camera, roughness, subdivisions, samples = {}) {
  const { width = 320, height = 180, pixels = witnesses() } = samples;
  if (!Number.isSafeInteger(width) || width < 1 || width > 4096 || !Number.isSafeInteger(height) || height < 1 || height > 4096
    || !Number.isSafeInteger(subdivisions) || subdivisions < 1 || subdivisions > 1024
    || !Array.isArray(pixels) || pixels.length < 1 || pixels.length > 16384
    || Array.from(pixels).some(pixel => !Array.isArray(pixel) || pixel.length !== 2 || !Number.isInteger(pixel[0]) || !Number.isInteger(pixel[1])
      || pixel[0] < 0 || pixel[0] >= width || pixel[1] < 0 || pixel[1] >= height)) {
    throw new Error('Invalid bounded reference pixel corpus, viewport or quadrature subdivisions.');
  }
  const emitter = scene.boxes.find(box => box.id === scene.objectBoxId);
  const reflector = scene.boxes.find(box => box.id === scene.reflectorBoxId);
  if (!emitter || !reflector || emitter.yaw !== 0 || roughness <= 0) throw new Error('Oracle requires the fixed axis-aligned emissive-box fixture and glossy roughness.');
  if (reflector.yaw !== 0 || JSON.stringify(reflector.center) !== '[-1.5,0.005,0]'
    || JSON.stringify(reflector.halfSize) !== '[0.5,0.005,1]' || reflector.center[1] + reflector.halfSize[1] !== .01
    || scene.light.radiance.some(value => value !== 0)
    || scene.materials[reflector.materialId].roughness !== roughness
    || scene.materials[reflector.materialId].metallic !== 1
    || scene.materials[reflector.materialId].albedo.some(value => value !== .85)
    || scene.materials.some(material => material.id !== emitter.materialId && material.emission.some(value => value !== 0))) {
    throw new Error('Image oracle fixed reflector plane/bounds/material or emissive-only lighting assumption changed.');
  }
  const emission = scene.materials[emitter.materialId].emission;
  const f0 = Math.round(scene.materials[reflector.materialId].albedo[0] * 255) / 255;
  const inverse = inverseMatrix(camera.viewProjection); const sourceBounds = aabb(emitter);
  const values = []; const mask = []; let quadratureRays = 0; let occludedRays = 0; let candidateBoxes = 0;
  for (const [x, y] of pixels) {
    const { point, ray, distance } = referencePrimaryPoint(camera, inverse, x, y, width, height);
    const visible = distance > 0 && point[0] > -2 && point[0] < -1 && point[2] > -1 && point[2] < 1
      && !scene.boxes.some(box => box.id !== reflector.id && intersectBox(camera.eye, ray, box, .05, distance - 1e-5) !== null);
    mask.push(Number(visible)); if (!visible) { values.push(0, 0, 0); continue; }
    const origin = [point[0], point[1] + imageOracleSettings.normalBias, point[2]]; const view = normalize(subtract(camera.eye, point));
    // Conservative segment-union AABB culls only boxes that cannot occlude ANY emitter sample.
    const bounds = { min: origin.map((value, axis) => Math.min(value, sourceBounds.min[axis])), max: origin.map((value, axis) => Math.max(value, sourceBounds.max[axis])) };
    const occluders = scene.boxes.filter(box => {
      if (box.id === emitter.id) return false; const b = aabb(box);
      return b.min.every((value, axis) => value <= bounds.max[axis]) && b.max.every((value, axis) => value >= bounds.min[axis]);
    }); candidateBoxes += occluders.length;
    let integral = 0;
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const axes = [0, 1, 2].filter(value => value !== axis); const uAxis = axes[0]; const vAxis = axes[1];
      const center = [...emitter.center]; center[axis] += sign * emitter.halfSize[axis];
      if ((origin[axis] - center[axis]) * sign <= 0) continue;
      const area = 4 * emitter.halfSize[uAxis] * emitter.halfSize[vAxis] / subdivisions ** 2;
      for (let ySample = 0; ySample < subdivisions; ySample++) for (let xSample = 0; xSample < subdivisions; xSample++) {
        const location = [...center];
        location[uAxis] += ((xSample + .5) / subdivisions * 2 - 1) * emitter.halfSize[uAxis];
        location[vAxis] += ((ySample + .5) / subdivisions * 2 - 1) * emitter.halfSize[vAxis];
        const delta = subtract(location, origin); const r2 = dot(delta, delta); const distance = Math.sqrt(r2);
        const light = delta.map(value => value / distance); const cosineSource = -light[axis] * sign;
        if (light[1] <= 0 || cosineSource <= 0 || distance > 16) continue;
        quadratureRays++;
        if (occluders.some(box => intersectBox(origin, light, box, .002, distance - 1e-6) !== null)) { occludedRays++; continue; }
        integral += ggxBrdf(view, light, roughness, f0) * light[1] * cosineSource / r2 * area;
      }
    }
    values.push(...emission.map(value => value * integral));
  }
  return { values, mask, subdivisions, quadratureRays, occludedRays, candidateBoxes, f0, emission,
    method: 'Uniform midpoint area quadrature over visible emitter-box faces; independent GGX BRDF and oriented-box occlusion; no production sampling/tracing helpers.',
    pixelFilter: 'Fixed primary pixel-center point samples; no pixel-area antialiasing or production low-resolution reconstruction.' };
}
export function imageError(actual, reference, mask) {
  let count = 0; let abs = 0; let squared = 0; let signed = 0; let maximum = 0;
  for (let i = 0; i < actual.length; i++) if (mask[Math.floor(i / 3)]) {
    const difference = actual[i] - reference[i]; abs += Math.abs(difference); squared += difference * difference; signed += difference;
    maximum = Math.max(maximum, Math.abs(difference)); count++;
  }
  return { samples: count, mae: abs / count, rmse: Math.sqrt(squared / count), signedBias: signed / count, maxAbsoluteError: maximum };
}
export function summarizeImageFrames(frames, reference) {
  const tail = frames.filter(frame => frame.frame > 180); const mean = reference.values.map((_, i) => tail.reduce((sum, frame) => sum + frame.rgb[i], 0) / tail.length);
  let variance = 0; let count = 0;
  for (let i = 0; i < mean.length; i++) if (reference.mask[Math.floor(i / 3)]) {
    variance += tail.reduce((sum, frame) => sum + (frame.rgb[i] - mean[i]) ** 2, 0) / tail.length; count++;
  }
  return { tailFrameCount: tail.length, mean, meanImageError: imageError(mean, reference.values, reference.mask),
    temporalVariance: variance / count, meanInstantaneousMse: tail.reduce((sum, frame) => sum + imageError(frame.rgb, reference.values, reference.mask).rmse ** 2, 0) / tail.length,
    finalImageError: imageError(frames.at(-1).rgb, reference.values, reference.mask),
    perCapturedFrame: frames.map(frame => ({ frame: frame.frame, ...imageError(frame.rgb, reference.values, reference.mask), rawSources: frame.rawSources, rawEmissiveHits: frame.rawEmissiveHits })) };
}
