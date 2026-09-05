import type { AuthoredBox, BoxCamera, BoxQuaternion, BoxSceneDescriptor, BoxVec3 } from '../../packages/core/src/rendering/authored-box-types.js';

type ClipPoint = readonly [number, number, number, number];
export type AuthoredDepthReferencePoint = { readonly relative: BoxVec3; readonly view: BoxVec3; readonly clip: ClipPoint };
export type AuthoredDepthReferenceVertex = { readonly clip: ClipPoint; readonly id: number };
export type AuthoredDepthReferenceCapture = { readonly ids: Uint32Array<ArrayBuffer>; readonly depth: Float32Array<ArrayBuffer> };

function requireReference(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Authored depth reference: ${message}`);
}

function normalized(q: BoxQuaternion): BoxQuaternion {
  const length = Math.hypot(...q);
  requireReference(Number.isFinite(length) && length > 0, 'quaternion must have a finite nonzero norm.');
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/** Hamilton products, independently expressed from the ray oracle's cross-product identity. */
function multiply(a: BoxQuaternion, b: BoxQuaternion): BoxQuaternion {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function conjugate(q: BoxQuaternion): BoxQuaternion { return [-q[0], -q[1], -q[2], q[3]]; }

function rotate(q: BoxQuaternion, point: BoxVec3): BoxVec3 {
  const result = multiply(multiply(q, [point[0], point[1], point[2], 0]), conjugate(q));
  return [result[0], result[1], result[2]];
}

function validateViewport(width: number, height: number): void {
  requireReference(Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0,
    'viewport dimensions must be positive safe integers.');
}

/** Binary64 reference geometry and scalar pinhole projection; no production matrix or shader math. */
export function projectAuthoredBoxDepthPoint(box: AuthoredBox, camera: BoxCamera, unitPoint: BoxVec3,
  width: number, height: number): AuthoredDepthReferencePoint {
  validateViewport(width, height);
  const { near, far, verticalFovRadians } = camera.projection;
  requireReference(Number.isFinite(near) && Number.isFinite(far) && near > 0 && far > near
    && Number.isFinite(verticalFovRadians) && verticalFovRadians > 0 && verticalFovRadians < Math.PI,
  'perspective parameters must be finite with 0 < near < far and 0 < vertical FOV < pi.');
  const local: BoxVec3 = [unitPoint[0] * box.dimensions[0] * box.transform.scale[0],
    unitPoint[1] * box.dimensions[1] * box.transform.scale[1], unitPoint[2] * box.dimensions[2] * box.transform.scale[2]];
  const rotated = rotate(normalized(box.transform.rotation), local);
  // Subtract the intended camera before adding local detail, and before any float32 conversion.
  const relative: BoxVec3 = [box.transform.position[0] - camera.position[0] + rotated[0],
    box.transform.position[1] - camera.position[1] + rotated[1], box.transform.position[2] - camera.position[2] + rotated[2]];
  const view = rotate(conjugate(normalized(camera.rotation)), relative);
  const focal = 1 / Math.tan(verticalFovRadians / 2), distance = -view[2];
  const clip: ClipPoint = [focal / (width / height) * view[0], focal * view[1],
    far / (far - near) * distance - far * near / (far - near), distance];
  requireReference(clip.every(Number.isFinite), 'projected corner is not finite.');
  return { relative, view, clip };
}

/**
 * Independent face frames generate outward CCW quads. Their origins specify the
 * declared +Z,-Z,+X,-X,+Y,-Y face order and the same 0-2 diagonal as the box mesh.
 * Matching this topology matters: snapping can change depth across a face diagonal.
 */
const faceFrames: readonly { readonly origin: BoxVec3; readonly u: BoxVec3; readonly v: BoxVec3 }[] = [
  { origin: [-0.5, -0.5, 0.5], u: [1, 0, 0], v: [0, 1, 0] },
  { origin: [0.5, -0.5, -0.5], u: [-1, 0, 0], v: [0, 1, 0] },
  { origin: [0.5, -0.5, 0.5], u: [0, 0, -1], v: [0, 1, 0] },
  { origin: [-0.5, -0.5, -0.5], u: [0, 0, 1], v: [0, 1, 0] },
  { origin: [-0.5, 0.5, 0.5], u: [1, 0, 0], v: [0, 0, -1] },
  { origin: [-0.5, -0.5, -0.5], u: [1, 0, 0], v: [0, 0, 1] },
];

/**
 * Returns 36 binary64 clip vertices per box; float32 rounding happens only at upload.
 * IDs encode ((objectIndex + 1) << 4) | (faceIndex << 1) | triangleIndex.
 * Clear is zero; decode object with id >>> 4, face with (id >>> 1) & 7, triangle with id & 1.
 */
export function buildAuthoredBoxDepthReferenceVertices(scene: BoxSceneDescriptor, camera: BoxCamera,
  width: number, height: number): readonly AuthoredDepthReferenceVertex[] {
  validateViewport(width, height);
  requireReference(scene.boxes.length > 0 && scene.boxes.length <= 0x0fffffff, 'box count cannot be encoded in the reference IDs.');
  const vertices: AuthoredDepthReferenceVertex[] = [];
  for (const [objectIndex, box] of scene.boxes.entries()) {
    for (const [faceIndex, face] of faceFrames.entries()) {
      const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => {
        const point = face.origin.map((value, axis) => value + u! * face.u[axis]! + v! * face.v[axis]!) as unknown as BoxVec3;
        return projectAuthoredBoxDepthPoint(box, camera, point, width, height).clip;
      });
      for (const [triangleIndex, triangle] of [[0, 1, 2], [0, 2, 3]].entries()) {
        const id = ((objectIndex + 1) * 16 + faceIndex * 2 + triangleIndex) >>> 0;
        for (const corner of triangle) vertices.push({ clip: corners[corner]!, id });
      }
    }
  }
  return vertices;
}

/**
 * The only float32 conversion. The optional negative control shifts NDC depth by
 * clipDepthOffset while preserving X/Y/W and IDs. It must keep all corners inside
 * the depth clip range so rejection cannot be attributed to clipping or coverage.
 */
export function packAuthoredBoxDepthReferenceVertices(vertices: readonly AuthoredDepthReferenceVertex[], clipDepthOffset = 0): ArrayBuffer {
  requireReference(Number.isFinite(clipDepthOffset), 'depth offset must be finite.');
  const upload = new ArrayBuffer(vertices.length * 20), floatWords = new Float32Array(upload), uintWords = new Uint32Array(upload);
  for (const [index, vertex] of vertices.entries()) {
    const [x, y, z, w] = vertex.clip, shiftedZ = clipDepthOffset === 0 ? z : z + clipDepthOffset * w;
    if (clipDepthOffset !== 0) requireReference(w > 0 && shiftedZ >= 0 && shiftedZ <= w, 'depth offset would clip a reference corner.');
    floatWords.set([x, y, shiftedZ, w], index * 5);
    requireReference(vertex.clip.every((_, axis) => Number.isFinite(floatWords[index * 5 + axis])), 'clip coordinate is not representable as float32.');
    if (clipDepthOffset !== 0) requireReference(floatWords[index * 5 + 3]! > 0 && floatWords[index * 5 + 2]! >= 0
      && floatWords[index * 5 + 2]! <= floatWords[index * 5 + 3]!, 'float32 depth offset would clip a reference corner.');
    uintWords[index * 5 + 4] = vertex.id;
  }
  return upload;
}

const shader = /* wgsl */ `
struct VertexInput {
  @location(0) clip: vec4f,
  @location(1) id: u32,
};
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) id: u32,
};
@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = input.clip;
  output.id = input.id;
  return output;
}
@fragment fn fragmentMain(input: VertexOutput) -> @location(0) u32 {
  return input.id;
}
`;

async function bounded<T>(work: Promise<T>, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Authored depth reference: ${operation} timed out.`)), 15_000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/**
 * Ordinary fixed-function rasterization of independently projected triangles on
 * the caller's device. Shares backend rasterization, but no production buffers,
 * matrices, geometry helpers, shader code, material output, or fragment depth.
 * The caller owns the device and its error/loss reporting; all resources here are temporary.
 * clipDepthOffset is the explicit depth-only negative control described by the packer above.
 */
export async function captureAuthoredBoxDepthReference(device: GPUDevice, scene: BoxSceneDescriptor, camera: BoxCamera,
  width: number, height: number, clipDepthOffset = 0): Promise<AuthoredDepthReferenceCapture> {
  const vertices = buildAuthoredBoxDepthReferenceVertices(scene, camera, width, height);
  const upload = packAuthoredBoxDepthReferenceVertices(vertices, clipDepthOffset);
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256, planeBytes = bytesPerRow * height;
  const owned: (GPUBuffer | GPUTexture)[] = [];
  try {
    const module = device.createShaderModule({ label: 'Independent authored depth reference', code: shader });
    const pipeline = await bounded(device.createRenderPipelineAsync({
      label: 'Independent authored depth reference', layout: 'auto',
      vertex: { module, entryPoint: 'vertexMain', buffers: [{ arrayStride: 20, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'uint32' },
      ] }] },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: 'r32uint' }] },
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'back' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: 1 },
    }), 'pipeline creation');
    const vertexBuffer = device.createBuffer({ label: 'Independent authored clip vertices', size: upload.byteLength, usage: 0x20 | 0x08 });
    owned.push(vertexBuffer);
    device.queue.writeBuffer(vertexBuffer, 0, upload);
    const idsTexture = device.createTexture({ label: 'Independent authored primitive IDs', size: [width, height], format: 'r32uint', usage: 0x10 | 0x01 });
    owned.push(idsTexture);
    const depthTexture = device.createTexture({ label: 'Independent authored reference depth', size: [width, height], format: 'depth32float', usage: 0x10 | 0x01 });
    owned.push(depthTexture);
    const staging = device.createBuffer({ label: 'Independent authored reference readback', size: planeBytes * 2, usage: 0x01 | 0x08 });
    owned.push(staging);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: idsTexture.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depthTexture.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.draw(vertices.length);
    pass.end();
    encoder.copyTextureToBuffer({ texture: idsTexture }, { buffer: staging, bytesPerRow }, [width, height]);
    encoder.copyTextureToBuffer({ texture: depthTexture, aspect: 'depth-only' }, { buffer: staging, offset: planeBytes, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await bounded(staging.mapAsync(0x01), 'readback');
    try {
      const mapped = staging.getMappedRange(), ids = new Uint32Array(width * height), depth = new Float32Array(width * height);
      for (let y = 0; y < height; y++) {
        ids.set(new Uint32Array(mapped, y * bytesPerRow, width), y * width);
        depth.set(new Float32Array(mapped, planeBytes + y * bytesPerRow, width), y * width);
      }
      return { ids, depth };
    } finally { staging.unmap(); }
  } finally {
    for (const resource of owned.reverse()) resource.destroy();
  }
}
