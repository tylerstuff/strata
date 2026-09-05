import { AuthoredBoxRenderer } from '../../packages/core/src/rendering/authored-box-renderer.js';
import { packWorldCoordinateFrame } from '../../packages/core/src/rendering/world-coordinate-frame.js';
import type { AuthoredBox, AuthoredFrameMetadata, BoxCamera, BoxQuaternion, BoxSceneDescriptor, BoxVec3 } from '../../packages/core/src/rendering/authored-box-types.js';
import { getWorldCoordinateFixtures, referenceBoxPoint } from '../fixtures/world-coordinates.js';
import type { FixtureFrame } from '../fixtures/world-coordinates.js';
import { buildAuthoredBoxDepthReferenceVertices, captureAuthoredBoxDepthReference, packAuthoredBoxDepthReferenceVertices,
  projectAuthoredBoxDepthPoint } from './authored-box-depth-reference.js';

const size = 512;
const offsets = [0, 1000, -1000, 10000, -10000, 100000, -100000, 1000000, -1000000];
const variants = ['dyadic', 'decimal'] as const;
type Variant = typeof variants[number];
type Capture = { color: Uint8Array<ArrayBuffer>; depth: Float32Array<ArrayBuffer>; authored: AuthoredFrameMetadata };
type Hit = { id: number; distance: number; normal: BoxVec3; position: BoxVec3; face: readonly [axis: number, sign: number] };
type OracleBox = { center: BoxVec3; half: BoxVec3; axes: readonly BoxVec3[]; origin: BoxVec3 };
type Oracle = { ids: Uint8Array; depths: Float64Array; counts: number[]; interior: Uint8Array; trace: (x: number, y: number) => Hit | null };

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const dot = (a: BoxVec3, b: BoxVec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: BoxVec3, b: BoxVec3): BoxVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: BoxVec3, amount: number): BoxVec3 => [a[0] * amount, a[1] * amount, a[2] * amount];
const add = (a: BoxVec3, b: BoxVec3): BoxVec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: BoxVec3, b: BoxVec3): BoxVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a: BoxVec3): BoxVec3 => scale(a, 1 / Math.hypot(...a));
const clamp = (value: number, low = 0, high = 1): number => Math.max(low, Math.min(high, value));
const srgb = (value: number): number => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
const tone = (x: number): number => clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
const color = (index: number): readonly [number, number, number, 1] => [(index % 4 + 1) / 5, (Math.floor(index / 4) + 1) / 5, 0.2 + index % 3 / 5, 1];

/** Independent quaternion-vector identity; no production matrices/packing are used by the ray oracle. */
function rotate(q: BoxQuaternion, point: BoxVec3): BoxVec3 {
  const length = Math.hypot(...q); const vector: BoxVec3 = [q[0] / length, q[1] / length, q[2] / length];
  const uv = cross(vector, point);
  return add(point, add(scale(uv, 2 * q[3] / length), scale(cross(vector, uv), 2)));
}

function fixture(variant: Variant, offset: number): FixtureFrame {
  const result = getWorldCoordinateFixtures().find(frame => frame.sequence.startsWith(`static-${variant}-`) && frame.offset[0] === offset);
  check(result, `Missing independent ${variant} fixture at ${offset}.`); return result;
}

/** Five shared coordinate witnesses plus eleven independently placed roots, all within eight metres. */
export function authoredValidationScene(variant: Variant, offset = 0): BoxSceneDescriptor {
  const source = fixture(variant, offset);
  const boxes: AuthoredBox[] = source.boxes.map((box, index) => ({ ...box, material: { ...box.material, baseColor: color(index) } }));
  for (let index = 5; index < 16; index++) {
    const extra = index - 5;
    const local: BoxVec3 = extra < 10 ? [(extra % 5 - 2) / 2, extra < 5 ? -0.875 : 0.875, -4] : [-0.75, 0.375, -2.5];
    const rotations: BoxQuaternion[] = [[0, 0, 0, 1], [0, 0.6, 0, 0.8], [0.6, 0, 0, 0.8], [0.5, 0.5, 0.5, 0.5]];
    boxes.push({ id: `extra-${extra}`, dimensions: [0.125, 0.1875, 0.15625],
      transform: { position: add(source.offset, local), rotation: rotations[extra % 4]!, scale: [1, 0.75, 1.5] },
      material: { baseColor: color(index), roughness: 0.2 + (index % 4) * 0.2, metallic: index % 3 / 2 } });
  }
  return { format: 'strata.runtime-boxes', version: 1, coordinateSystem: 'strata-world-v1', sceneId: `coordinate-${variant}`,
    sourceRevision: `test-${variant}-${offset}`, boxes, camera: { ...source.camera,
      projection: { kind: 'perspective', verticalFovRadians: source.perspective.verticalFovRadians, near: 0.1, far: 32 } },
    light: { directionToLight: unit([0.3, 0.5, 1]), radiance: [4, 3.8, 3.5] }, background: [0, 0, 0] };
}

function prepareOracle(scene: BoxSceneDescriptor, camera = scene.camera): (x: number, y: number) => Hit | null {
  const cameraAxes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(axis => rotate(camera.rotation, axis as unknown as BoxVec3));
  const boxes: OracleBox[] = scene.boxes.map(box => {
    const center = sub(box.transform.position, camera.position);
    const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(axis => rotate(box.transform.rotation, axis as unknown as BoxVec3));
    return { center, axes, half: box.dimensions.map((value, axis) => value * box.transform.scale[axis]! / 2) as unknown as BoxVec3,
      origin: axes.map(axis => -dot(center, axis)) as unknown as BoxVec3 };
  });
  const tangent = Math.tan(camera.projection.verticalFovRadians / 2);
  return (x, y) => {
    // Deliberately unnormalized: the ray parameter equals positive camera-space depth.
    const direction = add(add(scale(cameraAxes[0]!, (2 * (x + 0.5) / size - 1) * tangent),
      scale(cameraAxes[1]!, (1 - 2 * (y + 0.5) / size) * tangent)), scale(cameraAxes[2]!, -1));
    let closest = camera.projection.far; let result: Hit | null = null;
    for (let index = 0; index < boxes.length; index++) {
      const box = boxes[index]!; let entry = -Infinity, exit = Infinity, face = 0, sign = 0;
      for (let axis = 0; axis < 3; axis++) {
        const d = dot(direction, box.axes[axis]!); const o = box.origin[axis]!; const h = box.half[axis]!;
        if (Math.abs(d) < 1e-14) { if (Math.abs(o) > h) { exit = -Infinity; break; } continue; }
        const a = (-h - o) / d, b = (h - o) / d; const first = Math.min(a, b);
        if (first > entry) { entry = first; face = axis; sign = a < b ? -1 : 1; }
        exit = Math.min(exit, Math.max(a, b));
      }
      if (entry <= exit && entry >= camera.projection.near && entry < closest) {
        closest = entry; result = { id: index + 1, distance: entry, normal: scale(box.axes[face]!, sign), position: scale(direction, entry), face: [face, sign] };
      }
    }
    return result;
  };
}

function oracle(scene: BoxSceneDescriptor): Oracle {
  const trace = prepareOracle(scene); const ids = new Uint8Array(size * size), depths = new Float64Array(size * size).fill(1);
  const counts = Array<number>(17).fill(0); const interior = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const hit = trace(x, y); const index = y * size + x; const id = hit?.id ?? 0;
    ids[index] = id; counts[id]!++;
    if (hit) depths[index] = scene.camera.projection.far / (scene.camera.projection.far - scene.camera.projection.near)
      * (1 - scene.camera.projection.near / hit.distance);
  }
  for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
    const index = y * size + x; const id = ids[index]; let stable = true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (ids[index + dy * size + dx] !== id) stable = false;
    interior[index] = Number(stable);
  }
  return { ids, depths, counts, interior, trace };
}

function validateReferencePoints(variant: Variant) {
  const source = fixture(variant, 0); const scene = authoredValidationScene(variant); let maximumPixelError = 0, maximumDepthError = 0;
  let maximumClipPixelError = 0, maximumClipDepthError = 0;
  const inverse: BoxQuaternion = [-scene.camera.rotation[0], -scene.camera.rotation[1], -scene.camera.rotation[2], scene.camera.rotation[3]];
  for (const box of scene.boxes.slice(0, 5)) for (const point of [[0, 0, 0], [-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]] as const) {
    const exact = referenceBoxPoint(source.id, box.id, point); check(exact.pixel && exact.ndcDepth !== null, 'Reference point was clipped.');
    const local = point.map((value, axis) => value * box.dimensions[axis]! * box.transform.scale[axis]!) as unknown as BoxVec3;
    const relative = add(sub(box.transform.position, scene.camera.position), rotate(box.transform.rotation, local));
    const view = rotate(inverse, relative); const focal = 1 / Math.tan(scene.camera.projection.verticalFovRadians / 2);
    const pixel = [(1 + view[0] * focal / -view[2]) * size / 2, (1 - view[1] * focal / -view[2]) * size / 2];
    const depth = 32 / 31.9 * (1 - 0.1 / -view[2]);
    maximumPixelError = Math.max(maximumPixelError, ...pixel.map((value, axis) => Math.abs(value - exact.pixel![axis]!)));
    maximumDepthError = Math.max(maximumDepthError, Math.abs(depth - exact.ndcDepth));
    // Exercise the NEW clip generator against the rational oracle, independently
    // of the cross-product ray implementation immediately above.
    const clip = projectAuthoredBoxDepthPoint(box, scene.camera, point, size, size).clip;
    const clipPixel = [(1 + clip[0] / clip[3]) * size / 2, (1 - clip[1] / clip[3]) * size / 2];
    maximumClipPixelError = Math.max(maximumClipPixelError, ...clipPixel.map((value, axis) => Math.abs(value - exact.pixel![axis]!)));
    maximumClipDepthError = Math.max(maximumClipDepthError, Math.abs(clip[2] / clip[3] - exact.ndcDepth));
  }
  check(maximumPixelError < 1e-9 && maximumDepthError < 1e-12, 'Independent ray orientation disagrees with rational fixture point oracle.');
  check(maximumClipPixelError < 1e-9 && maximumClipDepthError < 1e-12, 'Independent clip generator disagrees with rational fixture point oracle.');
  const vertices = buildAuthoredBoxDepthReferenceVertices(scene, scene.camera, size, size);
  check(vertices.length === 576, 'Reference does not contain the complete sixteen-box triangle list.');
  const packed = new Uint32Array(packAuthoredBoxDepthReferenceVertices(vertices));
  const fault = new Uint32Array(packAuthoredBoxDepthReferenceVertices(vertices, 0.001));
  let changedDepthVertices = 0;
  for (let index = 0; index < packed.length; index++) {
    if (index % 5 === 2) changedDepthVertices += Number(packed[index] !== fault[index]);
    else check(packed[index] === fault[index], 'Clip-Z fault changed X/Y/W or primitive IDs.');
  }
  check(changedDepthVertices === vertices.length, 'Clip-Z fault did not affect every vertex depth.');
  return { maximumPixelError, maximumDepthError, rationalPointCount: 15,
    clipReference: { maximumPixelError: maximumClipPixelError, maximumDepthError: maximumClipDepthError,
      rationalPointCount: 15, vertices: vertices.length, clipDepthFaultVertices: changedDepthVertices } };
}

/** CPU-only checks are also run by the runner's --prepare-only path; no browser/device is touched. */
export function validateAuthoredBoxReference() {
  const results = variants.map(variant => {
    const scene = authoredValidationScene(variant); const reference = oracle(scene);
    check(reference.counts[5] === 0, 'The deliberate homothetic back box should be fully occluded.');
    for (let id = 1; id <= 16; id++) if (id !== 5) check(reference.counts[id]! >= 9, `Reference ${variant} box ${id} lacks independently predicted coverage.`);
    const origin = authoredValidationScene(variant); const packed = packWorldCoordinateFrame(origin.boxes, origin.camera, { ...origin.camera.projection, aspect: 1 });
    const far = authoredValidationScene(variant, 1_000_000);
    const bad = earlyFloat32(far); const wrong = packWorldCoordinateFrame(bad.boxes, bad.camera, { ...bad.camera.projection, aspect: 1 });
    check(packed.modelMatrices.some((value, index) => value !== wrong.modelMatrices[index]), 'The early-f32 control did not change packed model positions.');
    const cleanComparison = compareReadback(reference.ids, reference.depths, scene, reference.ids, reference.depths, reference.interior);
    assertComparison(cleanComparison, 'oracle');
    const missingReference = compareReadback(reference.ids, reference.depths, scene, reference.ids, reference.depths,
      reference.interior, undefined, undefined, new Uint8Array(reference.ids.length));
    check(missingReference.interiorSamples === cleanComparison.interiorSamples
      && missingReference.badInterior === cleanComparison.interiorSamples, 'Missing reference IDs silently removed analytic foreground samples.');
    requireRejectedComparison(missingReference, 'Missing reference ID control');
    return { variant, expectedPixelCounts: reference.counts, ...validateReferencePoints(variant),
      comparisonControls: { interiorSamples: cleanComparison.interiorSamples, missingReferenceRejected: true,
        constants: constantDepthControls(reference.ids, reference.depths, reference, variant, 'CPU reference') } };
  });
  return { sceneBoxes: 16, expectedVisibleBoxes: 15, deliberatelyOccludedBoxes: 1, viewport: [size, size], results };
}

function earlyFloat32(scene: BoxSceneDescriptor): BoxSceneDescriptor {
  return { ...scene, sourceRevision: `${scene.sourceRevision}-negative-control`, camera: { ...scene.camera, position: scene.camera.position.map(Math.fround) as unknown as BoxVec3 },
    boxes: scene.boxes.map(box => ({ ...box, transform: { ...box.transform, position: box.transform.position.map(Math.fround) as unknown as BoxVec3 } })) };
}

function classify(capture: Capture, scene: BoxSceneDescriptor): Uint8Array {
  const palette = [[0, 0, 0], ...scene.boxes.map(box => box.material.baseColor.slice(0, 3).map(value => Math.round(srgb(value) * 255)))];
  const lookup = new Map<number, number>();
  const ids = new Uint8Array(size * size);
  for (let index = 0; index < ids.length; index++) {
    const red = capture.color[index * 4]!, green = capture.color[index * 4 + 1]!, blue = capture.color[index * 4 + 2]!;
    const key = (red << 16) | (green << 8) | blue;
    let id = lookup.get(key);
    if (id === undefined) {
      let nearest = Infinity; id = 0;
      for (let candidate = 0; candidate < palette.length; candidate++) {
        const p = palette[candidate]!; const distance = Math.max(Math.abs(p[0]! - red), Math.abs(p[1]! - green), Math.abs(p[2]! - blue));
        if (distance < nearest) { nearest = distance; id = candidate; }
      }
      check(nearest <= 2, `Unexpected diagnostic pixel at ${index}, distance=${nearest}.`); lookup.set(key, id);
    }
    check(capture.color[index * 4 + 3] === 255, `Unexpected alpha at ${index}.`); ids[index] = id;
  }
  return ids;
}

type DepthErrors = { samples: number; outsideTolerance: number; minimumSigned: number | null; maximumSigned: number | null; maximumAbsolute: number };
const depthErrors = (): DepthErrors => ({ samples: 0, outsideTolerance: 0, minimumSigned: null, maximumSigned: null, maximumAbsolute: 0 });
function recordDepth(errors: DepthErrors, signed: number): void {
  errors.samples++;
  if (Math.abs(signed) > 2e-6) errors.outsideTolerance++;
  errors.minimumSigned = errors.minimumSigned === null ? signed : Math.min(errors.minimumSigned, signed);
  errors.maximumSigned = errors.maximumSigned === null ? signed : Math.max(errors.maximumSigned, signed);
  errors.maximumAbsolute = Math.max(errors.maximumAbsolute, Math.abs(signed));
}

/** Discrepancy analysis of existing readback. It neither changes acceptance nor renders another frame. */
function depthDiagnostics(capture: Capture, scene: BoxSceneDescriptor, actual: Uint8Array, referenceIds: Uint8Array,
  referenceDepth: ArrayLike<number>, interior: Uint8Array, referenceColor?: ArrayLike<number>, depthReferenceIds?: Uint8Array,
  depthReferencePrimitiveIds?: Uint32Array) {
  const trace = prepareOracle(scene, capture.authored.camera);
  const perObject = scene.boxes.map(box => ({ id: box.id, interiorSamples: 0, idMismatches: 0, matchingIdDepth: depthErrors() }));
  const perFace = new Map<string, { id: string; face: Hit['face']; normal: BoxVec3; matchingIdDepth: DepthErrors }>();
  // Bit flags: ID=1, depth=2, color=4. These seven buckets are mutually exclusive.
  const failureNames = ['pass', 'idOnly', 'depthOnly', 'idAndDepth', 'colorOnly', 'idAndColor', 'depthAndColor', 'idDepthAndColor'] as const;
  const exclusiveFailures = { idOnly: 0, depthOnly: 0, idAndDepth: 0, colorOnly: 0, idAndColor: 0, depthAndColor: 0, idDepthAndColor: 0 };
  const samplesPerObject = Array<number>(scene.boxes.length + 1).fill(0);
  const samples: ReturnType<typeof pixel>[] = [];
  let failingPixels = 0, faceUnclassifiedSamples = 0;
  function pixel(index: number, hit = trace(index % size, Math.floor(index / size))) {
    const { near, far } = capture.authored.camera.projection;
    return { x: index % size, y: Math.floor(index / size), expectedId: referenceIds[index], actualId: actual[index],
      depthReferenceId: depthReferenceIds?.[index] ?? null,
      depthReferencePrimitiveId: depthReferencePrimitiveIds?.[index] ?? null,
      referenceDepth: referenceDepth[index], roundedReferenceDepth: Math.fround(referenceDepth[index]!), gpuDepth: capture.depth[index],
      signedDepthError: capture.depth[index]! - referenceDepth[index]!, oracleId: hit?.id ?? 0,
      cameraDepth: hit?.distance ?? null,
      analyticDepth: hit ? far / (far - near) * (1 - near / hit.distance) : 1,
      oracleFace: hit?.face ?? null, oracleNormal: hit?.normal ?? null };
  }
  for (let index = 0; index < actual.length; index++) {
    const expected = referenceIds[index]!;
    if (!interior[index] || expected === 0) continue;
    const object = perObject[expected - 1]!; object.interiorSamples++;
    const idMismatch = actual[index] !== expected || (depthReferenceIds !== undefined && depthReferenceIds[index] !== expected);
    const signed = capture.depth[index]! - referenceDepth[index]!;
    let colorMismatch = false;
    if (referenceColor) for (let channel = 0; channel < 3; channel++) {
      if (Math.abs(capture.color[index * 4 + channel]! - referenceColor[index * 4 + channel]!) > 1) colorMismatch = true;
    }
    const flags = Number(idMismatch) | (Number(Math.abs(signed) > 2e-6) << 1) | (Number(colorMismatch) << 2);
    const hit = trace(index % size, Math.floor(index / size));
    if (idMismatch) object.idMismatches++;
    else {
      recordDepth(object.matchingIdDepth, signed);
      // Face attribution is independently ray-derived, not an observed GPU face ID.
      if (hit?.id === expected) {
        const key = `${expected}/${hit.face[0]}/${hit.face[1]}`;
        let face = perFace.get(key);
        if (!face) { face = { id: object.id, face: hit.face, normal: hit.normal, matchingIdDepth: depthErrors() }; perFace.set(key, face); }
        recordDepth(face.matchingIdDepth, signed);
      } else faceUnclassifiedSamples++;
    }
    if (flags !== 0) {
      exclusiveFailures[failureNames[flags] as keyof typeof exclusiveFailures]++;
      failingPixels++;
      if (samples.length < 16 && samplesPerObject[expected]! < 3) { samples.push(pixel(index, hit)); samplesPerObject[expected]!++; }
    }
  }
  const front = pixel(256 * size + 252), background = pixel(0);
  const camera = capture.authored.camera;
  const rationalFrontApplies = scene.sceneId === 'coordinate-dyadic' && camera.position.every(value => value === 0)
    && camera.rotation.every((value, index) => value === (index === 3 ? 1 : 0))
    && camera.projection.near === 0.1 && camera.projection.far === 32 && front.oracleId === 1 && front.cameraDepth === 127 / 128
    && front.oracleNormal?.every((value, index) => value === (index === 2 ? 1 : 0));
  return { exclusiveFailures, failingPixels, perObject, perFace: [...perFace.values()], faceUnclassifiedSamples,
    samples, sampleLimit: 16, perObjectSampleLimit: 3, droppedSamples: failingPixels - samples.length,
    sentinels: { front: { ...front, rationalReferenceDepth: rationalFrontApplies ? 36544 / 40513 : null },
      background: { ...background, expectedClearDepth: background.oracleId === 0 ? 1 : null } },
    camera, width: capture.authored.width, height: capture.authored.height,
    scope: 'Signed error is GPU minus comparison reference; face labels and analyticDepth come from the independent current-camera ray oracle. Per-face depth statistics include matching object IDs only.' };
}

function compareReadback(actual: Uint8Array, actualDepth: ArrayLike<number>, scene: BoxSceneDescriptor,
  referenceIds: Uint8Array, referenceDepth: ArrayLike<number>, interior: Uint8Array,
  actualColor?: ArrayLike<number>, referenceColor?: ArrayLike<number>, depthReferenceIds?: Uint8Array) {
  const counts = Array<number>(17).fill(0), intersection = Array<number>(17).fill(0), unions = Array<number>(17).fill(0);
  const expectedCount = Array<number>(17).fill(0), actualXY = Array.from({ length: 17 }, () => [0, 0]), expectedXY = Array.from({ length: 17 }, () => [0, 0]);
  let interiorSamples = 0, badInterior = 0, interiorIdMismatches = 0, maximumDepthError = 0, maximumInteriorColorDelta = 0;
  for (let index = 0; index < actual.length; index++) {
    const a = actual[index]!, b = referenceIds[index]!; counts[a]!++; expectedCount[b]!++;
    actualXY[a]![0]! += index % size; actualXY[a]![1]! += Math.floor(index / size);
    expectedXY[b]![0]! += index % size; expectedXY[b]![1]! += Math.floor(index / size);
    unions[a]!++; if (a !== b) unions[b]!++; else intersection[a]!++;
    check(Number.isFinite(actualDepth[index]) && actualDepth[index]! >= 0 && actualDepth[index]! <= 1, 'Invalid GPU depth.');
    check(Number.isFinite(referenceDepth[index]) && referenceDepth[index]! >= 0 && referenceDepth[index]! <= 1, 'Invalid comparison reference depth.');
    if (interior[index] && b !== 0) {
      interiorSamples++; const error = Math.abs(actualDepth[index]! - referenceDepth[index]!);
      const idMismatch = a !== b || (depthReferenceIds !== undefined && depthReferenceIds[index] !== b);
      if (idMismatch) interiorIdMismatches++;
      maximumDepthError = Math.max(maximumDepthError, error);
      let colorDelta = 0;
      if (referenceColor && actualColor) for (let channel = 0; channel < 3; channel++) colorDelta = Math.max(colorDelta, Math.abs(actualColor[index * 4 + channel]! - referenceColor[index * 4 + channel]!));
      maximumInteriorColorDelta = Math.max(maximumInteriorColorDelta, colorDelta);
      if (idMismatch || error > 2e-6 || colorDelta > 1) badInterior++;
    }
  }
  const objects = scene.boxes.map((box, index) => {
    const id = index + 1, expected = expectedCount[id]!, measured = counts[id]!;
    const centroid = expected && measured ? Math.hypot(actualXY[id]![0]! / measured - expectedXY[id]![0]! / expected,
      actualXY[id]![1]! / measured - expectedXY[id]![1]! / expected) : expected === measured ? 0 : Infinity;
    return { id: box.id, expected, measured, iou: unions[id] ? intersection[id]! / unions[id]! : 1, centroidDriftPixels: centroid };
  });
  return { objects, interiorSamples, interiorIdMismatches, badInterior, badInteriorFraction: badInterior / Math.max(1, interiorSamples), maximumDepthError, maximumInteriorColorDelta };
}

function compare(capture: Capture, scene: BoxSceneDescriptor, referenceIds: Uint8Array, referenceDepth: ArrayLike<number>, interior: Uint8Array,
  referenceColor?: ArrayLike<number>, depthReferenceIds?: Uint8Array, depthReferencePrimitiveIds?: Uint32Array) {
  const actual = classify(capture, scene);
  const result = compareReadback(actual, capture.depth, scene, referenceIds, referenceDepth, interior, capture.color, referenceColor, depthReferenceIds);
  return { ...result, diagnostics: result.badInterior > 0
    ? depthDiagnostics(capture, scene, actual, referenceIds, referenceDepth, interior, referenceColor, depthReferenceIds, depthReferencePrimitiveIds) : null };
}

function assertCoverage(result: ReturnType<typeof compareReadback>, tolerance: 'oracle' | 'offset'): void {
  try {
    for (const box of result.objects) {
      check(box.iou >= (tolerance === 'oracle' ? 0.98 : 0.995), `${box.id} coverage IoU=${box.iou} failed ${tolerance} comparison.`);
      check(box.centroidDriftPixels <= (tolerance === 'oracle' ? 0.5 : 0.25), `${box.id} centroid drift=${box.centroidDriftPixels}.`);
      if (box.expected === 0) check(box.measured === 0, 'A fully occluded box became visible.');
    }
    check(result.interiorSamples > 50 && result.interiorIdMismatches / result.interiorSamples <= 0.001,
      `Interior coverage failures=${result.interiorIdMismatches}/${result.interiorSamples}.`);
  } catch (cause) {
    throw new Error(`${cause instanceof Error ? cause.message : String(cause)}; comparison=${JSON.stringify({ tolerance, ...result })}`, { cause });
  }
}

function assertComparison(result: ReturnType<typeof compareReadback>, tolerance: 'oracle' | 'offset'): void {
  assertCoverage(result, tolerance);
  check(result.badInteriorFraction <= 0.001,
    `Interior coverage/depth failures=${result.badInterior}/${result.interiorSamples}; comparison=${JSON.stringify({ tolerance, ...result })}`);
}

function requireRejectedComparison(result: ReturnType<typeof compareReadback>, label: string): void {
  let rejected = false;
  try { assertComparison(result, 'oracle'); } catch { rejected = true; }
  check(rejected, `${label} unexpectedly passed the real coverage/depth assertion.`);
}

function referenceObjectIds(primitiveIds: Uint32Array, scene: BoxSceneDescriptor): Uint8Array {
  check(primitiveIds.length === size * size, 'Reference ID readback has the wrong extent.');
  return Uint8Array.from(primitiveIds, code => {
    const id = code >>> 4;
    check(code === 0 || (id >= 1 && id <= scene.boxes.length && (code & 15) < 12), 'Invalid reference object/face/triangle ID.');
    return id;
  });
}

/** Existing analytic constants are executable controls on both GPU paths. */
function constantDepthControls(ids: Uint8Array, depths: ArrayLike<number>, reference: Oracle, variant: Variant, label: string) {
  check(reference.ids[0] === 0 && ids[0] === 0 && depths[0] === 1, `${label} background ID/depth must be exactly 0/1.`);
  let front = null;
  if (variant === 'dyadic') {
    const index = 256 * size + 252, hit = reference.trace(252, 256);
    check(hit?.id === 1 && hit.distance === 127 / 128 && hit.normal[0] === 0 && hit.normal[1] === 0 && hit.normal[2] === 1,
      'Dyadic front rational sentinel no longer applies.');
    const expected = 36544 / 40513, absoluteError = Math.abs(depths[index]! - expected);
    check(ids[index] === 1 && absoluteError <= 2e-6, `${label} constant front depth failed: ID=${ids[index]}, error=${absoluteError}.`);
    front = { x: 252, y: 256, expected, measured: depths[index], absoluteError, tolerance: 2e-6 };
  }
  return { background: { x: 0, y: 0, expected: 1, measured: depths[0] }, front,
    scope: 'The rational front control applies to the dyadic identity camera only; the decimal static camera is rotated.' };
}

function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 30000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms.`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

function image(capture: Capture): string {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const context = canvas.getContext('2d'); check(context, 'No 2D canvas for packaging GPU readback PNG.');
  context.putImageData(new ImageData(new Uint8ClampedArray(capture.color), size, size), 0, 0);
  return canvas.toDataURL('image/png').split(',')[1]!;
}

/** Independent direct-light formula: GGX NDF and height-correlated Smith evaluated in JS binary64. */
function directPixel(scene: BoxSceneDescriptor, hit: Hit): number[] {
  const material = scene.boxes[hit.id - 1]!.material, n = hit.normal, l = unit(scene.light.directionToLight), v = unit(scale(hit.position, -1));
  const nl = clamp(dot(n, l)), nv = clamp(dot(n, v));
  if (!nl || !nv || Math.hypot(...add(l, v)) < 1e-6) return [0, 0, 0];
  const h = unit(add(l, v)), nh = clamp(dot(n, h)), vh = clamp(dot(v, h)), roughness = Math.max(0.06, material.roughness), a2 = roughness ** 4;
  const d = a2 / (Math.PI * (1 + (a2 - 1) * nh * nh) ** 2);
  const smith = 0.5 / Math.max(nl * Math.sqrt(nv * nv * (1 - a2) + a2) + nv * Math.sqrt(nl * nl * (1 - a2) + a2), 1e-5);
  return material.baseColor.slice(0, 3).map((base, channel) => {
    const f0 = 0.04 * (1 - material.metallic) + base * material.metallic;
    const fresnel = f0 + (1 - f0) * (1 - vh) ** 5;
    const brdf = (1 - fresnel) * (1 - material.metallic) * base / Math.PI + d * smith * fresnel;
    return Math.round(srgb(tone(brdf * nl * scene.light.radiance[channel]!)) * 255);
  });
}

function comparePbr(capture: Capture, scene: BoxSceneDescriptor, reference: Oracle) {
  let samples = 0, maximumChannelError = 0, failed = 0;
  const perObject = Array<number>(17).fill(0);
  for (let index = 0; index < reference.ids.length; index++) {
    const id = reference.ids[index]!; if (!id || !reference.interior[index] || perObject[id]! >= 24) continue;
    const hit = reference.trace(index % size, Math.floor(index / size)); check(hit && hit.id === id, 'Ray sample identity changed.');
    const expected = directPixel(scene, hit);
    const error = Math.max(...expected.map((value, channel) => Math.abs(value - capture.color[index * 4 + channel]!)));
    maximumChannelError = Math.max(maximumChannelError, error); if (error > 3) failed++;
    samples++; perObject[id]!++;
  }
  check(samples >= 100 && failed === 0, `Independent direct PBR mismatch: ${failed}/${samples}, max=${maximumChannelError} code values.`);
  return { samples, maximumChannelError, failed, perObject };
}

export async function runAuthoredBoxValidation({ software = false } = {}) {
  const references = validateAuthoredBoxReference();
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); check(adapter, 'No WebGPU adapter.');
  if (!software) check(adapter.info.isFallbackAdapter !== true, 'Hardware correctness request received a fallback adapter.');
  const environment = { softwareRequested: software, browser: { userAgent: navigator.userAgent, platform: navigator.platform },
    adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device,
      description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter ?? null } };
  let stage = 'device-initialization';
  const device = await adapter.requestDevice(); const errors: string[] = []; let expectedDestroy = false, lost: { reason: string; message: string } | null = null;
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  void device.lost.then(value => { if (!expectedDestroy) lost = { reason: value.reason, message: value.message }; });
  const target = device.createTexture({ size: [size, size], format: 'rgba8unorm', usage: 0x10 | 0x01 });
  const payloadBytes = size * size * 4;
  const staging = device.createBuffer({ size: payloadBytes * 2, usage: 0x01 | 0x08 });
  const results: Record<string, unknown> = {}; const images: { name: string; base64: string; authored: AuthoredFrameMetadata }[] = [];
  let frameCount = 0, referenceFrameCount = 0;
  const capture = async (renderer: AuthoredBoxRenderer, scene: BoxSceneDescriptor, debugView: 'final' | 'base-color' = 'base-color', camera = scene.camera, time = 0): Promise<Capture> => {
    const encoder = device.createCommandEncoder(); const stats = renderer.encode(encoder, target.createView(), size, size, time, { debugView, camera, temporal: false });
    check(stats.drawCalls === 1 && stats.dispatchCalls === 0 && stats.triangles === 192, 'Authored draw count is not the declared sixteen-box workload.');
    check(stats.authored.origin.every((value, axis) => value === camera.position[axis]) && stats.authored.aspect === 1
      && stats.authored.width === size && stats.authored.height === size && stats.authored.timeSeconds === time, 'Effective frame camera metadata is wrong.');
    const depth = renderer.depthTexture; check(depth, 'Production renderer did not expose its diagnostic depth texture.');
    encoder.copyTextureToBuffer({ texture: target }, { buffer: staging, bytesPerRow: size * 4 }, [size, size]);
    encoder.copyTextureToBuffer({ texture: depth, aspect: 'depth-only' }, { buffer: staging, offset: payloadBytes, bytesPerRow: size * 4 }, [size, size]);
    device.queue.submit([encoder.finish()]);
    await bounded(staging.mapAsync(0x01), 'Authored readback');
    let result: Capture;
    try { const copy = staging.getMappedRange().slice(0); result = { color: new Uint8Array(copy, 0, payloadBytes), depth: new Float32Array(copy, payloadBytes), authored: stats.authored }; }
    finally { staging.unmap(); }
    frameCount++; check(errors.length === 0 && !lost, `GPU error/loss: ${JSON.stringify({ errors, lost })}`); return result;
  };
  const renderOnce = async (scene: BoxSceneDescriptor, view: 'final' | 'base-color' = 'base-color') => {
    const renderer = await AuthoredBoxRenderer.create(device, 'rgba8unorm', scene);
    try { return await capture(renderer, scene, view); }
    finally { renderer.dispose(); check(renderer.gpuBufferBytes === 0 && renderer.gpuTextureBytes === 0, 'Renderer disposal leaked tracked allocations.'); }
  };
  const captureReference = async (scene: BoxSceneDescriptor, clipDepthOffset = 0) => {
    const result = await captureAuthoredBoxDepthReference(device, scene, scene.camera, size, size, clipDepthOffset);
    referenceFrameCount++;
    check(errors.length === 0 && !lost, `Reference GPU error/loss: ${JSON.stringify({ errors, lost })}`);
    return result;
  };
  try {
    for (const variant of variants) {
      console.info(`Authored correctness: ${variant} static offset witnesses.`);
      stage = `${variant}/static/origin/oracle`;
      const originScene = authoredValidationScene(variant), reference = oracle(originScene), baseline = await renderOnce(originScene);
      // Ideal sloped depth remains reported, but coverage and rational constants
      // are the analytic gates. Ordinary GPU vertices supply rasterized depth.
      const independent = compare(baseline, originScene, reference.ids, reference.depths, reference.interior); assertCoverage(independent, 'oracle');
      const baselineIds = classify(baseline, originScene); const captures: unknown[] = [];
      const productionConstants = constantDepthControls(baselineIds, baseline.depth, reference, variant, 'Production');
      stage = `${variant}/static/origin/gpu-reference`;
      const gpuReference = await captureReference(originScene), gpuReferenceIds = referenceObjectIds(gpuReference.ids, originScene);
      const referenceAnalytic = compareReadback(gpuReferenceIds, gpuReference.depth, originScene, reference.ids, reference.depths, reference.interior);
      assertCoverage(referenceAnalytic, 'oracle');
      const referenceConstants = constantDepthControls(gpuReferenceIds, gpuReference.depth, reference, variant, 'GPU reference');
      // Membership and expected identity ALWAYS come from the original analytic
      // oracle. A missing/wrong reference GPU ID is a failure, never a mask edit.
      const rasterDepth = compare(baseline, originScene, reference.ids, gpuReference.depth, reference.interior, undefined, gpuReferenceIds, gpuReference.ids);
      check(rasterDepth.interiorSamples === independent.interiorSamples, 'GPU reference changed the analytic sample denominator.');
      assertComparison(rasterDepth, 'oracle');
      let depthOnlyNegativeControl = null;
      if (variant === 'dyadic') {
        stage = `${variant}/static/origin/clip-z-negative`;
        const faultyReference = await captureReference(originScene, 0.001), faultyIds = referenceObjectIds(faultyReference.ids, originScene);
        check(sameBytes(gpuReference.ids, faultyReference.ids), 'Clip-Z fault changed reference object/face/triangle coverage.');
        const faultyComparison = compare(baseline, originScene, reference.ids, faultyReference.depth, reference.interior, undefined, faultyIds, faultyReference.ids);
        // Coverage still passes, so rejection must exercise the depth predicate.
        assertCoverage(faultyComparison, 'oracle');
        check(faultyComparison.interiorSamples === independent.interiorSamples
          && faultyComparison.badInterior === independent.interiorSamples, 'Clip-Z fault did not fail every unchanged analytic interior sample.');
        requireRejectedComparison(faultyComparison, 'GPU clip-Z +0.001*w control');
        depthOnlyNegativeControl = { clipDepthOffset: 0.001, exactPrimitiveIds: true, rejected: true, comparison: faultyComparison };
      }
      const originPacked = packWorldCoordinateFrame(originScene.boxes, originScene.camera, { ...originScene.camera.projection, aspect: 1 });
      for (const offset of offsets.slice(1)) {
        stage = `${variant}/static/${offset}/offset`;
        const scene = authoredValidationScene(variant, offset); const current = await renderOnce(scene);
        const comparison = compare(current, scene, baselineIds, baseline.depth, reference.interior, baseline.color); assertComparison(comparison, 'offset');
        const exactColor = sameBytes(current.color, baseline.color), exactDepth = sameBytes(current.depth, baseline.depth);
        const packed = packWorldCoordinateFrame(scene.boxes, scene.camera, { ...scene.camera.projection, aspect: 1 });
        const exactModelBytes = sameBytes(packed.modelMatrices, originPacked.modelMatrices);
        if (variant === 'dyadic') check(exactColor && exactDepth && exactModelBytes && sameBytes(packed.viewProjection, originPacked.viewProjection), `Exact dyadic offset ${offset} changed GPU color/depth or packed coordinates.`);
        captures.push({ offset: [offset, -offset, offset], comparison, exactColor, exactDepth, exactModelBytes });
      }
      const controls = [];
      for (const offset of [100000, 1000000]) {
        stage = `${variant}/early-f32/${offset}`;
        const invalidScene = earlyFloat32(authoredValidationScene(variant, offset));
        const invalid = await renderOnce(invalidScene);
        const comparison = compare(invalid, invalidScene, baselineIds, baseline.depth, reference.interior, baseline.color);
        const failedWitnesses = comparison.objects.filter(box => box.iou < 0.995 || box.centroidDriftPixels > 0.25);
        const gapWitnessFailed = failedWitnesses.some(box => box.id === 'gap-left' || box.id === 'gap-right');
        // At 100km the dyadic gap can close numerically yet retain the same covered pixel columns.
        // The 1000km control merges the centers at a much larger ULP and must lose visible identity.
        if (offset === 1000000) check(gapWitnessFailed, 'Early-f32 1000km GPU negative control did not fail either millimetre witness.');
        controls.push({ offset, requiredFailure: offset === 1000000, gapWitnessFailed, failedWitnesses, comparison });
      }
      results[variant] = { independent, analyticAcceptance: 'Coverage, occlusion and applicable constant depth; sloped ray depth is diagnostic.',
        gpuDepthReference: { kind: 'independent-clip-vertices-v1', vertices: 576, intendedCamera: originScene.camera,
          primitiveIdEncoding: '(objectId << 4) | (faceIndex << 1) | triangleIndex; face order +Z,-Z,+X,-X,+Y,-Y; clear 0',
          referenceAnalytic, productionVsReference: rasterDepth, constants: { production: productionConstants, reference: referenceConstants },
          depthOnlyNegativeControl, depthTolerance: 2e-6, maximumRejectedInteriorFraction: 0.001,
          scope: 'Independent CPU Hamilton quaternion/clip vertices with fixed-function GPU depth; original analytic foreground mask. Shared backend rasterization is not independently certified.' },
        offsets: captures, earlyFloat32NegativeControls: controls };
      images.push({ name: `${variant}-base-color`, base64: image(baseline), authored: baseline.authored });

      // Reuse renderers while only the camera moves; every paired step is compared, with no temporal settling.
      stage = `${variant}/paired-motion/setup`;
      const farScene = authoredValidationScene(variant, 1000000);
      const nearRenderer = await AuthoredBoxRenderer.create(device, 'rgba8unorm', originScene), farRenderer = await AuthoredBoxRenderer.create(device, 'rgba8unorm', farScene);
      let changedFrames = 0, maximumColorDelta = 0, maximumDepthDelta = 0; let previous: Capture | undefined;
      try {
        for (let step = 0; step < 32; step++) {
          stage = `${variant}/paired-motion/${step}`;
          const shift = (step - 16) / (variant === 'dyadic' ? 1024 : 1000);
          const nearCamera: BoxCamera = { ...originScene.camera, position: add(originScene.camera.position, [shift, 0, 0]) };
          const farCamera: BoxCamera = { ...farScene.camera, position: add(farScene.camera.position, [shift, 0, 0]) };
          const near = await capture(nearRenderer, originScene, 'base-color', nearCamera, step / 60);
          const far = await capture(farRenderer, farScene, 'base-color', farCamera, step / 60);
          if (previous && !sameBytes(previous.color, near.color)) changedFrames++;
          if (variant === 'dyadic') check(sameBytes(near.color, far.color) && sameBytes(near.depth, far.depth), `Dyadic slow camera step ${step} lost offset invariance.`);
          for (let index = 0; index < near.color.length; index++) maximumColorDelta = Math.max(maximumColorDelta, Math.abs(near.color[index]! - far.color[index]!));
          for (let index = 0; index < near.depth.length; index++) maximumDepthDelta = Math.max(maximumDepthDelta, Math.abs(near.depth[index]! - far.depth[index]!));
          // Decimal edges can differ; compare each actual pair using a one-pixel stability mask.
          if (variant === 'decimal') {
            const nearIds = classify(near, originScene), interior = new Uint8Array(nearIds.length);
            for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
              const index = y * size + x; let stable = true;
              for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (nearIds[index] !== nearIds[index + dy * size + dx]) stable = false;
              interior[index] = Number(stable);
            }
            assertComparison(compare(far, farScene, nearIds, near.depth, interior, near.color), 'offset');
          }
          previous = near;
        }
      } finally { nearRenderer.dispose(); farRenderer.dispose(); }
      check(changedFrames > 0, 'Camera overrides did not move any visible content.');
      results[`${variant}Motion`] = { pairedFrames: 32, nearOffset: [0, 0, 0], farOffset: [1000000, -1000000, 1000000], changedFrames, maximumColorDelta, maximumDepthDelta };
    }

    console.info('Authored correctness: direct PBR light/material witnesses.');
    stage = 'dyadic/origin/direct-pbr';
    const scene = authoredValidationScene('dyadic'), reference = oracle(scene), direct = await renderOnce(scene, 'final');
    const darkScene = { ...scene, light: { ...scene.light, radiance: [0, 0, 0] as const } }, dark = await renderOnce(darkScene, 'final');
    check(dark.color.every((value, index) => index % 4 === 3 ? value === 255 : value === 0), 'Zero radiance produced ambient/emissive light.');
    const changedScene: BoxSceneDescriptor = { ...scene, sourceRevision: 'material-change', boxes: scene.boxes.map(box => ({ ...box,
      material: { ...box.material, baseColor: [0.1, 0.6, 0.9, 1], metallic: 1 - box.material.metallic, roughness: 0.85 } })) };
    const changed = await renderOnce(changedScene, 'final');
    const reversedScene = { ...scene, light: { ...scene.light, directionToLight: scale(scene.light.directionToLight, -1) } };
    const reversed = await renderOnce(reversedScene, 'final');
    check(!sameBytes(direct.color, changed.color) && !sameBytes(direct.color, reversed.color), 'Material/light edits did not affect production PBR output.');
    results.pbr = { original: comparePbr(direct, scene, reference), materialEdit: comparePbr(changed, changedScene, reference), reversedLight: comparePbr(reversed, reversedScene, reference), zeroRadianceIsBlack: true };
    images.push({ name: 'direct-pbr', base64: image(direct), authored: direct.authored }, { name: 'material-edit-pbr', base64: image(changed), authored: changed.authored });
    await bounded(device.queue.onSubmittedWorkDone(), 'Final authored queue completion');
    check(errors.length === 0 && !lost, `GPU failure: ${JSON.stringify({ errors, lost })}`);
    return { kind: 'strata-authored-box-functional', performanceEvidence: false, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      device: adapter.info.device, description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter ?? null },
      references, frameCount, referenceFrameCount, results, images, gpuErrors: errors, deviceLost: lost,
      scope: 'Production renderer + packer, GPU color/depth readback; 16 roots, 15 expected visible and one intentionally occluded. Subpixel gap is not an empty-pixel guarantee. Box face normals check rotation/sign/stride; inverse-transpose necessity requires the separate oblique CPU oracle. No shadows, temporal rendering, GI or reflections.' };
  } catch (cause) { throw new Error(`${cause instanceof Error ? cause.message : String(cause)}; GPU diagnostics=${JSON.stringify({ stage, ...environment, errors, lost })}`, { cause }); }
  finally { staging.destroy(); target.destroy(); expectedDestroy = true; device.destroy(); }
}

/** Public built-package lifecycle/camera receipts; visual packed-consumer coverage is separately owned. */
export async function validateAuthoredEngine() {
  const entry = '/packages/core/dist/index.js';
  const { createEngine } = await import(entry) as typeof import('../../packages/core/src/index.js');
  const canvas = document.querySelector<HTMLCanvasElement>('#engine'); check(canvas, 'Engine validation canvas is missing.');
  const engine = await createEngine({ canvas, wasmUrl: new URL('/packages/core/dist/strata_runtime.wasm', location.href),
    workerUrl: new URL('/packages/core/dist/worker.js', location.href) });
  try {
    engine.resize(size, size); const descriptor = authoredValidationScene('dyadic');
    const first = await engine.setScene({ renderer: 'authored-boxes', scene: descriptor });
    check(engine.getTelemetry().scene.firstSubmittedFrameId === null, 'Committed scene falsely reports a submitted frame.');
    const camera: BoxCamera = { ...descriptor.camera, position: [0.125, 0, 0] };
    const frame = engine.render({ camera, debugView: 'base-color', temporal: false, timeSeconds: 0.25 });
    check(frame.scene.sceneGeneration === first.sceneGeneration && frame.scene.sourceRevision === descriptor.sourceRevision, 'Submitted identity differs from commit receipt.');
    check(frame.authored?.camera.position[0] === 0.125 && frame.authored.timeSeconds === 0.25, 'Effective camera/time metadata lost the override.');
    await engine.waitForIdle(30000);
    check(engine.getTelemetry().scene.lastSubmittedFrameId === frame.frameId, 'Frame submission bookkeeping is stale.');
    const second = await engine.setScene({ renderer: 'authored-boxes', scene: descriptor });
    check(second.sceneGeneration > first.sceneGeneration && second.sourceRevision === first.sourceRevision, 'Repeated source revision reused its runtime generation.');
    engine.resize(640, 320); const resized = engine.render({ temporal: false, cameraCut: true }); await engine.waitForIdle(30000);
    check(resized.authored?.aspect === 2 && resized.authored.width === 640 && resized.authored.camera.position[0] === 0, 'Resize/aspect or per-frame camera override leaked into later frames.');
    const clear = await engine.setScene(null); const cleared = engine.render(); await engine.waitForIdle(30000);
    check(clear.renderer === 'clear' && cleared.scene.sceneGeneration === clear.sceneGeneration, 'Clear receipt differs from submitted clear.');
    const active = engine.getTelemetry(); check(active.gpuErrorCount === 0, 'Public engine recorded a GPU error.');
    engine.dispose(); const disposed = engine.getTelemetry();
    check(disposed.allocatedGpuBufferBytes === 0 && disposed.allocatedGpuTextureBytes === 0 && disposed.wasmMemoryBytes === 0, 'Public engine disposal retained allocations.');
    return { info: engine.info, first, frame, second, resized, clear, cleared, active, disposed };
  } finally { engine.dispose(); }
}
