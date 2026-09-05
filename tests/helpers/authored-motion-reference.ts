import type { AuthoredBox, BoxCamera, BoxQuaternion, BoxSceneDescriptor, BoxVec3 } from '../../packages/core/src/rendering/authored-box-types.js';
import { AUTHORED_MOTION_GATES } from '../fixtures/authored-motion.js';
import type { MotionPair } from '../fixtures/authored-motion.js';

type Clip = readonly [number, number, number, number];
const ensure = (condition: unknown, message: string): void => { if (!condition) throw new Error(`Motion reference: ${message}`); };
const dot = (a: BoxVec3, b: BoxVec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: BoxVec3, b: BoxVec3): BoxVec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: BoxVec3, b: BoxVec3): BoxVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: BoxVec3, k: number): BoxVec3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: BoxVec3, b: BoxVec3): BoxVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalized(q: BoxQuaternion): BoxQuaternion {
  const length = Math.hypot(...q); ensure(Number.isFinite(length) && length > 0, 'invalid quaternion');
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}
const conjugate = (q: BoxQuaternion): BoxQuaternion => [-q[0], -q[1], -q[2], q[3]];
function hamilton(a: BoxQuaternion, b: BoxQuaternion): BoxQuaternion {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
function rotateHamilton(q: BoxQuaternion, p: BoxVec3): BoxVec3 {
  const r = hamilton(hamilton(q, [p[0], p[1], p[2], 0]), conjugate(q)); return [r[0], r[1], r[2]];
}
/** Separately expressed quaternion-vector identity for the CPU ray diagnostics. */
function rotateCross(q0: BoxQuaternion, p: BoxVec3): BoxVec3 {
  const q = normalized(q0), v: BoxVec3 = [q[0], q[1], q[2]], a = cross(v, p);
  return add(p, add(scale(a, 2 * q[3]), scale(cross(v, a), 2)));
}
function clipFromView(view: BoxVec3, camera: BoxCamera, width: number, height: number): Clip {
  const { near, far, verticalFovRadians } = camera.projection, d = -view[2], f = 1 / Math.tan(verticalFovRadians / 2);
  return [view[0] * f / (width / height), view[1] * f, far / (far - near) * d - far * near / (far - near), d];
}
export function priorClipValid(clip: Clip): boolean {
  return clip.every(Number.isFinite) && clip[3] > 0 && Math.abs(clip[0]) <= clip[3] && Math.abs(clip[1]) <= clip[3]
    && clip[2] >= 0 && clip[2] <= clip[3];
}
export interface MotionReferencePoint { readonly current: Clip; readonly previous: Clip; readonly rgba: Clip; readonly priorValid: boolean }
export interface MotionReferenceFault { readonly previousOrigin?: BoxVec3; readonly sign?: 1 | -1 }

/** Root-minus-intended-camera in binary64, Hamilton rotation, scalar pinhole lens. No production math. */
export function referenceAuthoredMotionPoint(box: AuthoredBox, pair: MotionPair, unitPoint: BoxVec3,
  fault: MotionReferenceFault = {}): MotionReferencePoint {
  const p = unitPoint.map((v, a) => v * box.dimensions[a]! * box.transform.scale[a]!) as unknown as BoxVec3;
  const local = rotateHamilton(normalized(box.transform.rotation), p);
  const project = (camera: BoxCamera, width: number, height: number, origin = camera.position): Clip => {
    const relative = add(sub(box.transform.position, origin), local);
    return clipFromView(rotateHamilton(conjugate(normalized(camera.rotation)), relative), camera, width, height);
  };
  const current = project(pair.current.camera, pair.current.width, pair.current.height);
  const previous = pair.valid && pair.previous ? project(pair.previous.camera, pair.previous.width, pair.previous.height, fault.previousOrigin) : [0, 0, 0, 0] as const;
  const priorValid = priorClipValid(previous), sign = fault.sign ?? 1;
  const rgba: Clip = priorValid ? [sign * 0.5 * (previous[0] / previous[3] - current[0] / current[3]),
    sign * -0.5 * (previous[1] / previous[3] - current[1] / current[3]), current[3], previous[3]] : [0, 0, current[3], 0];
  ensure([...current, ...previous, ...rgba].every(Number.isFinite), 'nonfinite point');
  return { current, previous, rgba, priorValid };
}

interface RayHit { readonly object: number; readonly primitiveId: number; readonly depth: number; readonly relative: BoxVec3; readonly unitPoint: BoxVec3 }
export type PriorRegion = 'valid' | 'frame-invalid' | 'xy' | 'near' | 'far' | 'behind';
export interface MotionMaskEntry { readonly index: number; readonly primitiveId: number; readonly priorValid: boolean; readonly priorRegion: PriorRegion; readonly ideal: Clip }
export interface MotionMask {
  readonly width: number; readonly height: number; readonly entries: readonly MotionMaskEntry[];
  /** Four predetermined corners, accepted only after the independent ray oracle proves them empty. */
  readonly backgroundIndices: readonly number[];
  readonly currentSurfacePixels: number; readonly erodedSurfacePixels: number; readonly excludedPriorMargin: number;
  readonly countsByObject: Readonly<Record<string, number>>;
}
function prepareTrace(scene: BoxSceneDescriptor, pair: MotionPair): (x: number, y: number) => RayHit | null {
  const frame = pair.current, axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(v => rotateCross(frame.camera.rotation, v as unknown as BoxVec3));
  const tangent = Math.tan(frame.camera.projection.verticalFovRadians / 2);
  const boxes = scene.boxes.map(box => {
    const basis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(v => rotateCross(box.transform.rotation, v as unknown as BoxVec3));
    const center = sub(box.transform.position, frame.camera.position);
    return { basis, origin: basis.map(v => -dot(center, v)), lengths: box.dimensions.map((v, a) => v * box.transform.scale[a]!) };
  });
  return (x, y) => {
    const direction = add(add(scale(axes[0]!, (2 * (x + 0.5) / frame.width - 1) * tangent * frame.width / frame.height),
      scale(axes[1]!, (1 - 2 * (y + 0.5) / frame.height) * tangent)), scale(axes[2]!, -1));
    let closest = frame.camera.projection.far, result: RayHit | null = null;
    boxes.forEach((box, object) => {
      let entry = -Infinity, exit = Infinity, faceAxis = 0, sign = 1;
      const d = box.basis.map(axis => dot(direction, axis));
      for (let a = 0; a < 3; a++) {
        const half = box.lengths[a]! / 2, o = box.origin[a]!;
        if (Math.abs(d[a]!) < 1e-15) { if (Math.abs(o) > half) return; continue; }
        const first = (-half - o) / d[a]!, second = (half - o) / d[a]!;
        const near = Math.min(first, second), far = Math.max(first, second);
        if (near > entry) { entry = near; faceAxis = a; sign = first > second ? 1 : -1; }
        exit = Math.min(exit, far);
      }
      if (entry > exit || entry < frame.camera.projection.near || entry >= closest) return;
      const local = box.origin.map((v, a) => (v + d[a]! * entry) / box.lengths[a]!) as unknown as BoxVec3;
      const face = faceAxis === 2 ? (sign > 0 ? 0 : 1) : faceAxis === 0 ? (sign > 0 ? 2 : 3) : sign > 0 ? 4 : 5;
      const u = face === 0 || face === 4 || face === 5 ? local[0] + 0.5 : face === 1 ? 0.5 - local[0] : face === 2 ? 0.5 - local[2] : local[2] + 0.5;
      const v = face < 4 ? local[1] + 0.5 : face === 4 ? 0.5 - local[2] : local[2] + 0.5;
      closest = entry; result = { object, primitiveId: (object + 1) * 16 + face * 2 + Number(v > u), depth: entry,
        relative: scale(direction, entry), unitPoint: local };
    });
    return result;
  };
}
function rayMotion(hit: RayHit, pair: MotionPair, x: number, y: number): { ideal: Clip; priorValid: boolean; margin: boolean; priorRegion: PriorRegion } {
  if (!pair.valid || !pair.previous) return { ideal: [0, 0, hit.depth, 0], priorValid: false, margin: true, priorRegion: 'frame-invalid' };
  const p = pair.previous, relative = add(hit.relative, sub(pair.current.camera.position, p.camera.position));
  const view = rotateCross(conjugate(p.camera.rotation), relative), clip = clipFromView(view, p.camera, p.width, p.height);
  const valid = priorClipValid(clip), depth = clip[3];
  const px = (0.5 + 0.5 * clip[0] / depth) * p.width, py = (0.5 - 0.5 * clip[1] / depth) * p.height;
  const margin = Math.abs(depth) >= AUTHORED_MOTION_GATES.priorDepthPlaneMargin
    && Math.min(Math.abs(px), Math.abs(px - p.width), Math.abs(py), Math.abs(py - p.height)) >= AUTHORED_MOTION_GATES.priorEdgeMarginPixels
    && Math.min(Math.abs(depth - p.camera.projection.near), Math.abs(depth - p.camera.projection.far)) >= AUTHORED_MOTION_GATES.priorDepthPlaneMargin;
  const priorRegion: PriorRegion = valid ? 'valid' : depth <= 0 ? 'behind' : depth < p.camera.projection.near ? 'near'
    : depth > p.camera.projection.far ? 'far' : 'xy';
  return { priorValid: valid, margin, priorRegion, ideal: valid ? [px / p.width - (x + 0.5) / pair.current.width,
    py / p.height - (y + 0.5) / pair.current.height, hit.depth, depth] : [0, 0, hit.depth, 0] };
}

/** Fixed CPU selection before readback: two-pixel primitive erosion and declared prior-frustum margins. */
export function prepareAuthoredMotionMask(scene: BoxSceneDescriptor, pair: MotionPair): MotionMask {
  const { width, height } = pair.current, trace = prepareTrace(scene, pair), hits = new Array<RayHit | null>(width * height), ids = new Uint32Array(hits.length);
  let currentSurfacePixels = 0, erodedSurfacePixels = 0, excludedPriorMargin = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const hit = trace(x, y); hits[y * width + x] = hit; ids[y * width + x] = hit?.primitiveId ?? 0; if (hit) currentSurfacePixels++;
  }
  const entries: MotionMaskEntry[] = [], countsByObject: Record<string, number> = {}, radius = AUTHORED_MOTION_GATES.currentInteriorRadiusPixels;
  for (let y = radius; y < height - radius; y++) for (let x = radius; x < width - radius; x++) {
    const index = y * width + x, hit = hits[index]; if (!hit) continue;
    let stable = true;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) if (ids[index + dy * width + dx] !== hit.primitiveId) stable = false;
    if (!stable) continue; erodedSurfacePixels++;
    const expected = rayMotion(hit, pair, x, y); if (!expected.margin) { excludedPriorMargin++; continue; }
    entries.push({ index, primitiveId: hit.primitiveId, priorValid: expected.priorValid, priorRegion: expected.priorRegion, ideal: expected.ideal });
    const id = scene.boxes[hit.object]!.id; countsByObject[id] = (countsByObject[id] ?? 0) + 1;
  }
  ensure(entries.length >= AUTHORED_MOTION_GATES.minimumMaskPixels, `insufficient fixed mask for ${pair.current.id}`);
  const backgroundIndices = [0, width - 1, (height - 1) * width, width * height - 1];
  ensure(backgroundIndices.every(i => ids[i] === 0), `fixed background corner is not empty for ${pair.current.id}`);
  return { width, height, entries, backgroundIndices, currentSurfacePixels, erodedSurfacePixels, excludedPriorMargin, countsByObject };
}

const faces: readonly { o: BoxVec3; u: BoxVec3; v: BoxVec3 }[] = [
  { o: [-0.5, -0.5, 0.5], u: [1, 0, 0], v: [0, 1, 0] }, { o: [0.5, -0.5, -0.5], u: [-1, 0, 0], v: [0, 1, 0] },
  { o: [0.5, -0.5, 0.5], u: [0, 0, -1], v: [0, 1, 0] }, { o: [-0.5, -0.5, -0.5], u: [0, 0, 1], v: [0, 1, 0] },
  { o: [-0.5, 0.5, 0.5], u: [1, 0, 0], v: [0, 0, -1] }, { o: [-0.5, -0.5, -0.5], u: [1, 0, 0], v: [0, 0, 1] },
];
export function packAuthoredMotionReference(scene: BoxSceneDescriptor, pair: MotionPair, fault: MotionReferenceFault = {}): ArrayBuffer {
  const data = new ArrayBuffer(scene.boxes.length * 36 * 36), floats = new Float32Array(data), integers = new Uint32Array(data); let vertex = 0;
  scene.boxes.forEach((box, object) => faces.forEach((face, f) => {
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => referenceAuthoredMotionPoint(box, pair,
      add(face.o, add(scale(face.u, u!), scale(face.v, v!))), fault));
    [[0, 1, 2], [0, 2, 3]].forEach((triangle, t) => triangle.forEach(c => {
      floats.set([...corners[c]!.current, ...corners[c]!.previous], vertex * 9); integers[vertex * 9 + 8] = (object + 1) * 16 + f * 2 + t;
      for (let k = 0; k < 8; k++) ensure(Number.isFinite(floats[vertex * 9 + k]), 'upload exceeds float32'); vertex++;
    }));
  }));
  return data;
}
export interface MotionReferenceCapture { readonly ids: Uint32Array<ArrayBuffer>; readonly motion: Float32Array<ArrayBuffer> }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Motion readback timed out')), 15000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
/** Shared fixed-function rasterizer/interpolation, independent ordinary clip vertices and fragment math. */
export async function captureAuthoredMotionReference(device: GPUDevice, scene: BoxSceneDescriptor, pair: MotionPair,
  fault: MotionReferenceFault = {}): Promise<MotionReferenceCapture> {
  const { width, height } = pair.current, upload = packAuthoredMotionReference(scene, pair, fault), owned: (GPUBuffer | GPUTexture)[] = [];
  const code = `
struct Input { @location(0) current: vec4f, @location(1) previous: vec4f, @location(2) id: u32, };
struct Varying { @builtin(position) position: vec4f, @location(0) previous: vec4f, @location(1) depth: f32, @location(2) @interpolate(flat) id: u32, };
struct Output { @location(0) id: u32, @location(1) motion: vec4f, };
@vertex fn vertex(input: Input) -> Varying {
  var o: Varying; o.position=input.current; o.previous=input.previous; o.depth=input.current.w; o.id=input.id; return o;
}
@fragment fn fragment(input: Varying) -> Output {
  var o: Output; o.id=input.id; o.motion=vec4f(0.0,0.0,input.depth,0.0);
  let p=input.previous;
  if(p.w>0.0 && all(abs(p.xy)<=vec2f(p.w)) && p.z>=0.0 && p.z<=p.w) {
    let prior=vec2f(0.5+0.5*p.x/p.w,0.5-0.5*p.y/p.w);
    let current=input.position.xy/vec2f(${width}.0,${height}.0);
    o.motion=vec4f((prior-current)*${fault.sign === -1 ? '-1.0' : '1.0'},input.depth,p.w);
  }
  return o;
}`;
  try {
    const module = device.createShaderModule({ label: 'Independent authored motion reference', code });
    const pipeline = await bounded(device.createRenderPipelineAsync({ layout: 'auto',
      vertex: { module, entryPoint: 'vertex', buffers: [{ arrayStride: 36, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x4' }, { shaderLocation: 2, offset: 32, format: 'uint32' },
      ] }] }, fragment: { module, entryPoint: 'fragment', targets: [{ format: 'r32uint' }, { format: 'rgba32float' }] },
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'back' }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' } }));
    const buffer = device.createBuffer({ size: upload.byteLength, usage: 0x20 | 0x08 }); owned.push(buffer); device.queue.writeBuffer(buffer, 0, upload);
    const texture = (format: GPUTextureFormat, usage: number): GPUTexture => { const t = device.createTexture({ size: [width, height], format, usage }); owned.push(t); return t; };
    const ids = texture('r32uint', 0x10 | 0x01), motion = texture('rgba32float', 0x10 | 0x01), depth = texture('depth32float', 0x10);
    const idRow = Math.ceil(width * 4 / 256) * 256, motionRow = Math.ceil(width * 16 / 256) * 256, idBytes = idRow * height;
    const staging = device.createBuffer({ size: idBytes + motionRow * height, usage: 0x01 | 0x08 }); owned.push(staging);
    const encoder = device.createCommandEncoder(), pass = encoder.beginRenderPass({ colorAttachments: [ids, motion].map(t => ({ view: t.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' })),
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
    pass.setPipeline(pipeline); pass.setVertexBuffer(0, buffer); pass.draw(upload.byteLength / 36); pass.end();
    encoder.copyTextureToBuffer({ texture: ids }, { buffer: staging, bytesPerRow: idRow }, [width, height]);
    encoder.copyTextureToBuffer({ texture: motion }, { buffer: staging, offset: idBytes, bytesPerRow: motionRow }, [width, height]);
    device.queue.submit([encoder.finish()]); await bounded(staging.mapAsync(0x01));
    try {
      const mapped = staging.getMappedRange(), result: MotionReferenceCapture = { ids: new Uint32Array(width * height), motion: new Float32Array(width * height * 4) };
      for (let y = 0; y < height; y++) { result.ids.set(new Uint32Array(mapped, y * idRow, width), y * width);
        result.motion.set(new Float32Array(mapped, idBytes + y * motionRow, width * 4), y * width * 4); }
      return result;
    } finally { staging.unmap(); }
  } finally { for (const resource of owned.reverse()) resource.destroy(); }
}

export function compareAuthoredMotion(actual: Float32Array, reference: MotionReferenceCapture, mask: MotionMask) {
  ensure(actual.length === mask.width * mask.height * 4 && reference.motion.length === actual.length && reference.ids.length * 4 === actual.length, 'readback dimensions changed');
  let rejected = 0, missing = 0, nonfinite = 0, referenceMismatch = 0, maxXYPixels = 0, maxDepthError = 0;
  const failures: { index: number; actual: number[]; expected: number[]; referenceId: number; expectedId: number }[] = [];
  for (const entry of mask.entries) {
    const at = entry.index * 4, a = Array.from(actual.subarray(at, at + 4)), e = Array.from(reference.motion.subarray(at, at + 4));
    const finite = [...a, ...e].every(Number.isFinite); if (!finite) nonfinite++;
    const absent = !(a[2]! > 0); if (absent) missing++;
    const badReference = reference.ids[entry.index] !== entry.primitiveId || !(e[2]! > 0) || (e[3]! > 0) !== entry.priorValid;
    if (badReference) referenceMismatch++;
    const xy = Math.max(Math.abs(a[0]! - e[0]!) * mask.width, Math.abs(a[1]! - e[1]!) * mask.height);
    const depth = Math.max(Math.abs(a[2]! - e[2]!), Math.abs(a[3]! - e[3]!));
    if (finite) { maxXYPixels = Math.max(maxXYPixels, xy); maxDepthError = Math.max(maxDepthError, depth); }
    const depthBad = [2, 3].some(c => Math.abs(a[c]! - e[c]!) > AUTHORED_MOTION_GATES.depthAbsolute + AUTHORED_MOTION_GATES.depthRelative * Math.abs(e[c]!));
    const invalidBad = !entry.priorValid && (a[0] !== 0 || a[1] !== 0 || a[3] !== 0 || e[0] !== 0 || e[1] !== 0 || e[3] !== 0);
    if (!finite || absent || badReference || invalidBad || depthBad || xy > AUTHORED_MOTION_GATES.xyPixels) {
      rejected++; if (failures.length < 16) failures.push({ index: entry.index, actual: a, expected: e, referenceId: reference.ids[entry.index]!, expectedId: entry.primitiveId });
    }
  }
  return { pixels: mask.entries.length, rejected, missing, nonfinite, referenceMismatch, maxXYPixels, maxDepthError, failures };
}

/** Hand-derived fractions at a 90-degree lens; shared by CPU preparation and unit checks. */
export function validateAuthoredMotionLandmarks() {
  const camera: BoxCamera = { position: [0, 0, 0], rotation: [0, 0, 0, 1],
    projection: { kind: 'perspective', verticalFovRadians: Math.PI / 2, near: 1 / 8, far: 32 } };
  const current: MotionPair['current'] = { id: 'rational', frameId: 2, camera, width: 320, height: 240, cameraCut: false, submit: true };
  const box: AuthoredBox = { id: 'rational', dimensions: [1, 1, 1],
    transform: { position: [0, 0, -4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    material: { baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1 } };
  const cases = [
    { name: 'previous-left', position: [-1 / 8, 0, 0] as BoxVec3, expected: [3 / 224, 0, 7 / 2, 7 / 2] },
    { name: 'previous-up', position: [0, 1 / 8, 0] as BoxVec3, expected: [0, 1 / 56, 7 / 2, 7 / 2] },
    { name: 'previous-back', position: [0, 0, 1 / 4] as BoxVec3, expected: [0, 0, 7 / 2, 15 / 4] },
  ].map(c => {
    const pair: MotionPair = { current, previous: { ...current, frameId: 1, camera: { ...camera, position: c.position } }, valid: true, resetReason: null };
    const actual = referenceAuthoredMotionPoint(box, pair, [0, 0, 0.5]).rgba;
    const maxError = Math.max(...actual.map((v, i) => Math.abs(v - c.expected[i]!)));
    ensure(maxError < 1e-14, `closed-form ${c.name} failed`); return { name: c.name, actual, expected: c.expected, maxError };
  });
  const pair: MotionPair = { current: { ...current, camera: { ...camera, rotation: [0, 0.6, 0, 0.8] } }, previous: null, valid: false, resetReason: 'first-frame' };
  const rotated = referenceAuthoredMotionPoint(box, pair, [0, 0, 0]).current;
  const expected = [72 / 25, 0, 32 / (32 - 1 / 8) * (28 / 25 - 1 / 8), 28 / 25];
  ensure(rotated.every((v, i) => Math.abs(v - expected[i]!) < 1e-14), 'rational camera quaternion failed');
  const cyclicBox: AuthoredBox = { ...box, dimensions: [1 / 2, 1 / 4, 1 / 8],
    transform: { ...box.transform, rotation: [0.5, 0.5, 0.5, 0.5], scale: [1, 2, 4] } };
  const cyclic = referenceAuthoredMotionPoint(cyclicBox, { ...pair, current }, [0.5, 0.25, -0.5]).current;
  const cyclicExpected = [-3 / 16, 1 / 4, 32 / (32 - 1 / 8) * (31 / 8 - 1 / 8), 31 / 8];
  ensure(cyclic.every((v, i) => Math.abs(v - cyclicExpected[i]!) < 1e-14), 'rational root rotation/scale failed');
  for (const clip of [rotated, cyclic]) for (const v of clip) {
    ensure(Math.abs(Math.fround(v) - v) <= Math.abs(v) * 2 ** -24, 'landmark float32 upload rounding bound failed');
  }
  return { cases, rotatedCamera: { actual: rotated, expected }, cyclicRoot: { actual: cyclic, expected: cyclicExpected }, tolerance: 1e-14 };
}
