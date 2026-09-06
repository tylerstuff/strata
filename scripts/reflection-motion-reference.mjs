import { createHash } from 'node:crypto';
import { buildImageReference, imageError, intersectBox, inverseMatrix, referencePrimaryPoint } from './reflection-image-reference.mjs';

// CPU preparation only. No engine, traversal, random sampler or shader imports.
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const finite = (values, length) => Array.isArray(values) && values.length === length && Array.from(values).every(Number.isFinite);
const normalize = vector => { const length = Math.hypot(...vector); return vector.map(value => value / length); };
const kinds = ['still', 'camera-hold', 'object-hold', 'thin'];

export const motionReferenceContract = freeze({
  version: 1, width: 320, height: 180, frames: 240, moveFirst: 61, moveLast: 120, tailFirst: 181,
  scales: [.25, .5, 1], roughnesses: [.08, .35], thinPixelPhases: [0, 1, 2, 3], maxRaysPerFrame: 256,
  cameraTranslationZ: .2, objectOffsetStart: -.4, objectOffsetEnd: .4, thinCenterWidthPixels: 1.5,
  roiPaddingPixels: 4, maxRoiPixels: 16384, quadratureCoarse: 64, quadratureFine: 128,
  referenceSanity: { rmse: .01, maxAbsoluteError: .05 },
  qualification: 'Preparation only; reference sanity is not an engine error gate. Equal candidate caps are not equal executed ray counts.',
});

/** Numeric source identity excludes labels/state bookkeeping, never geometry/material/light data. */
function sourceIdentity(scene) {
  if (!scene || !Array.isArray(scene.boxes) || !scene.boxes.length || scene.boxes.length > 4096
    || !Array.isArray(scene.materials) || !scene.materials.length || scene.materials.length > 4096
    || !finite(scene.light?.direction, 3) || !finite(scene.light?.radiance, 3)) throw new Error('Invalid reference source.');
  const materials = scene.materials.map((material, id) => {
    if (material.id !== id || !finite(material.albedo, 3) || !finite(material.emission, 3)
      || !Number.isFinite(material.roughness) || !Number.isFinite(material.metallic ?? 0)) throw new Error('Invalid reference material.');
    return { id, albedo: [...material.albedo], emission: [...material.emission], roughness: material.roughness, metallic: material.metallic ?? 0 };
  });
  const boxes = scene.boxes.map((box, id) => {
    if (box.id !== id || !finite(box.center, 3) || !finite(box.halfSize, 3) || box.halfSize.some(value => value <= 0)
      || !Number.isFinite(box.yaw) || !Number.isInteger(box.materialId) || !materials[box.materialId]) throw new Error('Invalid reference box.');
    return { id, center: [...box.center], halfSize: [...box.halfSize], yaw: box.yaw, materialId: box.materialId };
  });
  if (!boxes[scene.objectBoxId] || !boxes[scene.reflectorBoxId] || scene.objectBoxId === scene.reflectorBoxId) throw new Error('Invalid reference source IDs.');
  return { boxes, materials, light: { direction: [...scene.light.direction], radiance: [...scene.light.radiance] },
    objectBoxId: scene.objectBoxId, reflectorBoxId: scene.reflectorBoxId };
}
function cameraIdentity(camera) {
  if (!camera || !finite(camera.eye, 3) || !finite(camera.viewProjection, 16)
    || camera.viewProjection.some(value => value !== Math.fround(value))) throw new Error('Reference camera needs finite eye and stored f32 viewProjection.');
  inverseMatrix(camera.viewProjection);
  return { eye: [...camera.eye], viewProjection: [...camera.viewProjection] };
}
function controlsIdentity(controls) {
  return { temporal: controls?.temporal, debugView: controls?.debugView, cameraCut: controls?.cameraCut ?? false,
    gi: { enabled: controls?.gi?.enabled, lightIntensity: controls?.gi?.lightIntensity, resetCache: controls?.gi?.resetCache ?? false },
    reflections: Object.fromEntries(['mode', 'roughness', 'objectOffset', 'maxDistance', 'updateEvery', 'resetHistory']
      .map(key => [key, controls?.reflections?.[key]])) };
}
function project(camera, point) {
  const clip = [0, 1, 2, 3].map(row => camera.viewProjection[12 + row]
    + point.reduce((sum, value, axis) => sum + camera.viewProjection[axis * 4 + row] * value, 0));
  if (!clip.every(Number.isFinite) || clip[3] <= 0) throw new Error('Reference ROI crosses the camera plane.');
  return { x: (clip[0] / clip[3] + 1) * 160, y: (1 - clip[1] / clip[3]) * 90, clip };
}
function translatedCamera(camera, z) {
  const matrix = [...camera.viewProjection];
  for (let row = 0; row < 4; row++) matrix[12 + row] = Math.fround(matrix[12 + row] - matrix[8 + row] * z);
  return { eye: [camera.eye[0], camera.eye[1], camera.eye[2] + z], viewProjection: matrix };
}
function pixelTranslationZ(camera, point, pixels) {
  const { x, clip } = project(camera, point); const ndc = (x + pixels) / 160 - 1;
  const denominator = camera.viewProjection[8] - ndc * camera.viewProjection[11];
  if (Math.abs(denominator) < 1e-8) throw new Error('Thin feature cannot translate along image X.');
  const delta = (ndc * clip[3] - clip[0]) / denominator;
  if (!Number.isFinite(delta)) throw new Error('Nonfinite thin-feature translation.');
  return delta;
}
const virtualPoint = point => [point[0], .02 - point[1], point[2]];

export function reflectionMotionProfiles() {
  return freeze(motionReferenceContract.roughnesses.flatMap(roughness => kinds.flatMap(kind =>
    (kind === 'thin' ? motionReferenceContract.thinPixelPhases : [0]).map(pixelPhase => ({
      id: `${kind}-r${roughness}${kind === 'thin' ? `-phase${pixelPhase}` : ''}`, kind, roughness, pixelPhase,
    })))));
}

/** Pass the independently prepared pristine fixture, before observing any candidate capture. */
export function createMotionReferencePlan(baseScene, baseCamera, profileId) {
  const profile = reflectionMotionProfiles().find(value => value.id === profileId);
  if (!profile) throw new Error('Unknown frozen reflection motion profile.');
  const source = sourceIdentity(baseScene); const camera = cameraIdentity(baseCamera);
  const emitter = source.boxes[source.objectBoxId]; const mirror = source.boxes[source.reflectorBoxId];
  if (JSON.stringify(emitter.center) !== '[-0.8,1.12,0.2]' || JSON.stringify(emitter.halfSize) !== '[0.18,0.18,0.18]'
    || emitter.yaw !== 0 || JSON.stringify(mirror.center) !== '[-1.5,0.005,0]' || JSON.stringify(mirror.halfSize) !== '[0.5,0.005,1]'
    || mirror.yaw !== 0 || source.light.radiance.some(value => value !== 0)
    || source.materials[mirror.materialId].metallic !== 1 || source.materials[mirror.materialId].albedo.some(value => value !== .85)
    || JSON.stringify(source.materials[emitter.materialId].emission) !== '[4,0.25,0.08]'
    || source.boxes.some(box => box.id !== emitter.id && box.materialId === emitter.materialId)
    || source.materials.some(value => value.id !== emitter.materialId && value.emission.some(channel => channel !== 0))) {
    throw new Error('Plan requires the pristine fixed reflector/emitter and emissive-only source.');
  }
  const sourceAt = frame => {
    const progress = Math.max(0, Math.min(1, (frame - 60) / 60));
    const scene = copy(source); const object = scene.boxes[scene.objectBoxId];
    scene.materials[mirror.materialId].roughness = profile.roughness;
    const offset = profile.kind === 'object-hold' ? -.4 + .8 * progress : 0;
    object.center[2] += offset;
    if (profile.kind === 'thin') {
      // Four physical-pixel center shifts exercise all four quarter-grid phases.
      // Require the receiver orientation: depth and image Y are invariant along Z.
      if (Math.abs(camera.viewProjection[9]) > 1e-8 || Math.abs(camera.viewProjection[11]) > 1e-8) throw new Error('Thin profile requires receiver camera orientation.');
      const virtual = virtualPoint(object.center);
      object.halfSize[2] = Math.abs(pixelTranslationZ(camera, virtual, .75));
      object.center[2] += pixelTranslationZ(camera, virtual, profile.pixelPhase);
    }
    const expectedCamera = profile.kind === 'camera-hold' ? translatedCamera(camera, .2 * progress) : copy(camera);
    const controls = { temporal: false, debugView: 'reflections', gi: { enabled: false, lightIntensity: 0 },
      reflections: { mode: 'world', roughness: profile.roughness, objectOffset: offset, maxDistance: 16, updateEvery: 1, resetHistory: frame === 1 } };
    return { frame, phase: ['still', 'thin'].includes(profile.kind) ? 'still' : frame < 61 ? 'initial' : frame <= 120 ? 'motion' : 'hold', scene, camera: expectedCamera, controls };
  };
  // One dense rectangle covers every expected trajectory/phase, with a fixed background border.
  // Derive it only from geometry. It never depends on candidate radiance or error.
  const projected = [];
  for (let frame = 1; frame <= 240; frame++) {
    const expected = sourceAt(frame); const object = expected.scene.boxes[source.objectBoxId];
    for (let corner = 0; corner < 8; corner++) projected.push(project(expected.camera, virtualPoint(object.center.map((value, axis) =>
      value + (corner & (1 << axis) ? 1 : -1) * object.halfSize[axis]))));
  }
  const roi = { minX: Math.floor(Math.min(...projected.map(value => value.x))) - 4,
    maxX: Math.ceil(Math.max(...projected.map(value => value.x))) + 4,
    minY: Math.floor(Math.min(...projected.map(value => value.y))) - 4,
    maxY: Math.ceil(Math.max(...projected.map(value => value.y))) + 4 };
  const count = (roi.maxX - roi.minX + 1) * (roi.maxY - roi.minY + 1);
  if (roi.minX < 0 || roi.minY < 0 || roi.maxX >= 320 || roi.maxY >= 180 || count > 16384) throw new Error('Expected feature ROI exceeds the frozen viewport/count domain.');
  const pixels = Array.from({ length: count }, (_, i) => [roi.minX + i % (roi.maxX - roi.minX + 1), roi.minY + Math.floor(i / (roi.maxX - roi.minX + 1))]);
  const evaluationFrames = [...new Set([1, 60, 61, 75, 90, 105, 120, 121, 122, 124, 128, 136, 152, 180,
    ...Array.from({ length: 60 }, (_, i) => 181 + i)])];
  const frames = Array.from({ length: 240 }, (_, i) => {
    const expected = sourceAt(i + 1);
    return { ...expected, evaluate: evaluationFrames.includes(i + 1), poseKey: digest({ scene: expected.scene, camera: expected.camera, roughness: profile.roughness }) };
  });
  const identity = digest({ contract: motionReferenceContract, profile, source, camera, pixels, frames });
  return freeze({ identity, profile, roi, pixels, evaluationFrames, frames });
}

/** Geometric sharp-ray masks, not zero-support claims for the glossy GGX lobe. */
export function geometricMotionMasks(plan, frameNumber) {
  const classify = expected => {
    const inverse = inverseMatrix(expected.camera.viewProjection); const emitterId = expected.scene.objectBoxId;
    return plan.pixels.map(([x, y]) => {
      const { distance, ray, point } = referencePrimaryPoint(expected.camera, inverse, x, y);
      const visible = distance > 0 && point[0] > -2 && point[0] < -1 && point[2] > -1 && point[2] < 1
        && !expected.scene.boxes.some(box => box.id !== expected.scene.reflectorBoxId
          && intersectBox(expected.camera.eye, ray, box, .05, distance - 1e-5) !== null);
      if (!visible) return -1;
      const direction = normalize([ray[0], -ray[1], ray[2]]); const origin = [point[0], point[1] + .002, point[2]];
      let first = null; let closest = 16;
      for (const box of expected.scene.boxes) {
        const hit = intersectBox(origin, direction, box, .002, closest);
        if (hit !== null && hit < closest) { first = box.id; closest = hit; }
      }
      return Number(first === emitterId);
    });
  };
  const frame = plan.frames[frameNumber - 1]; if (!frame || frame.frame !== frameNumber) throw new Error('Unknown reference frame.');
  const current = classify(frame); const initial = classify(plan.frames[0]);
  return freeze({ visible: current.map(value => Number(value !== -1)), feature: current.map(value => Number(value === 1)),
    background: current.map(value => Number(value === 0)), vacated: current.map((value, i) => Number(value === 0 && initial[i] === 1)) });
}

/** Compute outside the render loop. A poseKey may cache identical hold-frame quadrature. */
export function buildMotionFrameReference(plan, frameNumber, subdivisions) {
  const frame = plan.frames[frameNumber - 1]; if (!frame || !frame.evaluate) throw new Error('Frame is outside the frozen evaluation schedule.');
  const reference = buildImageReference(frame.scene, frame.camera, plan.profile.roughness, subdivisions,
    { width: 320, height: 180, pixels: plan.pixels });
  return freeze({ planIdentity: plan.identity, frame: frameNumber, poseKey: frame.poseKey, reference, masks: geometricMotionMasks(plan, frameNumber) });
}

function validImage(values, count, maximum = 65504) {
  if (!finite(values, count * 3) || values.some(value => Math.abs(value) > maximum)) throw new Error('Image shape or finite rgba16float-value contract failed.');
}
function metric(actual, reference, mask) { return mask.some(Boolean) ? imageError(actual, reference, mask) : null; }

/** Capture must report observed state, not merely echo the requested frame label. */
export function compareMotionFrame(plan, capture, record) {
  const expected = plan.frames[capture.frame - 1];
  if (!expected || !expected.evaluate || record.frame !== capture.frame || record.planIdentity !== plan.identity || record.poseKey !== expected.poseKey
    || capture.planIdentity !== plan.identity || !motionReferenceContract.scales.includes(capture.resolutionScale)
    || capture.maxRaysPerFrame !== 256 || digest(sourceIdentity(capture.scene)) !== digest(expected.scene)
    || digest(cameraIdentity(capture.camera)) !== digest(expected.camera) || digest(controlsIdentity(capture.controls)) !== digest(controlsIdentity(expected.controls))) {
    throw new Error('Capture/reference does not match the frozen frame, pose, controls or budget.');
  }
  validImage(capture.rgb, plan.pixels.length); validImage(record.reference.values, plan.pixels.length);
  const masks = geometricMotionMasks(plan, capture.frame);
  if (digest(masks) !== digest(record.masks) || digest(record.reference.mask) !== digest(masks.visible)) throw new Error('Reference mask identity mismatch.');
  if (!masks.feature.some(Boolean) || !masks.background.some(Boolean)
    || (['object-hold', 'camera-hold'].includes(plan.profile.kind) && capture.frame >= 120 && !masks.vacated.some(Boolean))) throw new Error('Required geometric region is empty.');
  return { frame: capture.frame, phase: expected.phase, poseKey: expected.poseKey,
    all: metric(capture.rgb, record.reference.values, masks.visible), feature: metric(capture.rgb, record.reference.values, masks.feature),
    background: metric(capture.rgb, record.reference.values, masks.background), vacated: metric(capture.rgb, record.reference.values, masks.vacated),
    residual: capture.rgb.map((value, i) => value - record.reference.values[i]) };
}

/** Subtract per-frame truth before measuring variation; moving reference energy is not noise. */
export function residualVariation(comparisons, fixedMask) {
  if (!Array.isArray(comparisons) || comparisons.length < 2 || !Array.isArray(fixedMask) || !fixedMask.some(Boolean)
    || Array.from(fixedMask).some(value => value !== 0 && value !== 1)) throw new Error('Residual variation needs two frames and a nonempty fixed mask.');
  for (const comparison of comparisons) validImage(comparison.residual, fixedMask.length, 2 * 65504);
  let sum = 0; let channels = 0;
  for (let i = 0; i < fixedMask.length * 3; i++) if (fixedMask[Math.floor(i / 3)]) {
    const mean = comparisons.reduce((total, entry) => total + entry.residual[i], 0) / comparisons.length;
    sum += comparisons.reduce((total, entry) => total + (entry.residual[i] - mean) ** 2, 0) / comparisons.length; channels++;
  }
  return sum / channels;
}

/** Freeze from repeated baseline runs BEFORE candidate outcomes; no superiority gate is applied here. */
export function proposedImprovementMargin(referenceRmse, baselineRunRmse) {
  for (const values of [referenceRmse, baselineRunRmse]) {
    if (!Array.isArray(values) || values.length < 2 || Array.from(values).some(value => !Number.isFinite(value) || value < 0)) throw new Error('Margin requires finite nonnegative repeated qualification measurements.');
  }
  const absoluteRmseMargin = 2 * Math.max(...referenceRmse) + Math.max(...baselineRunRmse) - Math.min(...baselineRunRmse);
  if (!Number.isFinite(absoluteRmseMargin)) throw new Error('Improvement margin overflowed.');
  return freeze({ status: 'proposal-not-engine-acceptance', referenceRmse: [...referenceRmse], baselineRunRmse: [...baselineRunRmse], absoluteRmseMargin,
    definition: 'Twice the largest paired coarse/fine residual plus the repeated-baseline RMSE range, for the same profile/region/schedule.' });
}
