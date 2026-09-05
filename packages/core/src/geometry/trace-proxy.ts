import { StrataError } from '../errors.js';
import type { GiMaterial, GiTriangle, GiVec3 } from '../gi/scene-data.js';
import type { GeometryBounds, GeometryManifest } from './format.js';

const vector = (x: number, y: number, z: number): GiVec3 => Object.freeze([x, y, z]) as GiVec3;
export const integratedTerrainTransform = Object.freeze({ scale: 0.125, translation: vector(0, -1.625, 0) });
/** Default source material. A diagnostic override must update raster and tracing together. */
export const integratedTerrainMaterial: GiMaterial = Object.freeze({ id: 5, albedo: vector(0.08, 0.65, 0.12),
  emission: vector(0, 0, 0), roughness: 1, metallic: 0 });
export const terrainTraceObjectId = 0xffff_fffe;
export const traceProxyVerticalError = (0.07 * (64 / 3 + 1 / 3) + 0.0001) * 0.125;
const proxyBounds = Object.freeze({ min: vector(-16, -3, -16), max: vector(16, -0.25, 16) });
const proxyPayloadBytes = 37644;
const proxyVertices = 1089;
const proxyIndices = 6144;

export interface TraceProxyManifest {
  readonly format: 'strata-trace-proxy'; readonly version: 1;
  readonly sourceManifestSha256: string;
  readonly source: GeometryManifest['source'];
  readonly grid: { readonly cellsPerSide: 32; readonly sourceStep: 8 };
  readonly transform: typeof integratedTerrainTransform;
  readonly material: GiMaterial;
  readonly bounds: GeometryBounds;
  /** Both errors are in transformed world metres; neither bounds radiometric/normal error. */
  readonly error: { readonly maxVertical: number; readonly measuredMaxVertical: number };
  readonly mesh: {
    readonly url: 'trace-proxy.bin'; readonly byteLength: 37644; readonly sha256: string;
    readonly vertexCount: 1089; readonly vertexStride: 12; readonly indexCount: 6144; readonly indexFormat: 'uint32';
  };
}
export interface TerrainTraceProxy {
  readonly manifest: TraceProxyManifest;
  /** World positions, immutable local IDs0..2047; object identity is not an analytic-box index. */
  readonly triangles: readonly GiTriangle[];
  /** External payload size, distinct from packed BVH/GPU allocation and retained JS objects. */
  readonly payloadBytes: number;
}

function invalid(message: string): never { throw new StrataError('INVALID_OPTIONS', `Invalid trace proxy: ${message}`); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function sameVector(value: unknown, expected: GiVec3): boolean {
  return Array.isArray(value) && value.length === 3 && value.every((entry, axis) => entry === expected[axis]);
}
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function sameSource(source: Record<string, unknown>): boolean {
  return source.kind === 'analytic-heightfield-v1' && source.seed === 1337 && source.tilesPerSide === 4
    && source.cellsPerTile === 64 && source.cellSize === 1 && source.triangleCount === 131072;
}

/** Deliberately restricted to the recorded integrated fixture, with no arbitrary proxy claims. */
export function parseTraceProxyManifest(input: unknown, geometryManifest: GeometryManifest): TraceProxyManifest {
  const value = record(input, 'manifest'); const source = record(value.source, 'source');
  const transform = record(value.transform, 'transform'); const material = record(value.material, 'material');
  const bounds = record(value.bounds, 'bounds'); const grid = record(value.grid, 'grid');
  const error = record(value.error, 'error'); const mesh = record(value.mesh, 'mesh');
  if (value.format !== 'strata-trace-proxy' || value.version !== 1 || !hash(value.sourceManifestSha256)) invalid('unsupported format or source hash.');
  if (!sameSource(source) || !sameSource(record(geometryManifest.source, 'geometry source'))) invalid('source must match seed1337/tiles4/cells64.');
  if (grid.cellsPerSide !== 32 || grid.sourceStep !== 8) invalid('unsupported tracing grid.');
  if (transform.scale !== integratedTerrainTransform.scale || !sameVector(transform.translation, integratedTerrainTransform.translation)) invalid('source transform differs from the recorded fixture.');
  if (material.id !== 5 || material.roughness !== 1 || material.metallic !== 0 || !sameVector(material.albedo, integratedTerrainMaterial.albedo)
    || !sameVector(material.emission, integratedTerrainMaterial.emission)) invalid('source material differs from the recorded fixture.');
  if (!sameVector(bounds.min, proxyBounds.min) || !sameVector(bounds.max, proxyBounds.max)) invalid('source bounds differ from the recorded fixture.');
  if (typeof error.maxVertical !== 'number' || !Number.isFinite(error.maxVertical) || Math.abs(error.maxVertical - traceProxyVerticalError) > 1e-12
    || typeof error.measuredMaxVertical !== 'number' || !Number.isFinite(error.measuredMaxVertical)
    || error.measuredMaxVertical < 0 || error.measuredMaxVertical > error.maxVertical) invalid('invalid geometric error bound.');
  if (mesh.url !== 'trace-proxy.bin' || mesh.byteLength !== proxyPayloadBytes || !hash(mesh.sha256)
    || mesh.vertexCount !== proxyVertices || mesh.vertexStride !== 12 || mesh.indexCount !== proxyIndices || mesh.indexFormat !== 'uint32') invalid('unsupported payload layout.');
  return Object.freeze({ format: 'strata-trace-proxy', version: 1, sourceManifestSha256: value.sourceManifestSha256,
    source: Object.freeze({ kind: 'analytic-heightfield-v1', seed: 1337, tilesPerSide: 4, cellsPerTile: 64, cellSize: 1, triangleCount: 131072 }),
    grid: Object.freeze({ cellsPerSide: 32, sourceStep: 8 }), transform: integratedTerrainTransform, material: integratedTerrainMaterial,
    bounds: proxyBounds, error: Object.freeze({ maxVertical: error.maxVertical, measuredMaxVertical: error.measuredMaxVertical }),
    mesh: Object.freeze({ url: 'trace-proxy.bin', byteLength: 37644, sha256: mesh.sha256,
      vertexCount: 1089, vertexStride: 12, indexCount: 6144, indexFormat: 'uint32' }),
  });
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Hashes bind the coarse grid to exact cooked source bytes; no dense runtime recooking. */
export async function validateTraceProxy(manifest: TraceProxyManifest, payload: ArrayBuffer, sourceManifestBytes: ArrayBuffer): Promise<TerrainTraceProxy> {
  if (payload.byteLength !== proxyPayloadBytes) invalid('payload has the wrong byte length.');
  if (sourceManifestBytes.byteLength === 0 || sourceManifestBytes.byteLength > 8 * 1024 * 1024) invalid('render manifest has an invalid byte length.');
  const [payloadHash, sourceHash] = await Promise.all([sha256(payload), sha256(sourceManifestBytes)]);
  if (payloadHash !== manifest.mesh.sha256) invalid('payload failed SHA-256 validation.');
  if (sourceHash !== manifest.sourceManifestSha256) invalid('render manifest failed SHA-256 linkage.');
  const data = new DataView(payload); const vertices: GiVec3[] = [];
  for (let id = 0; id < proxyVertices; id++) {
    const point = vector(data.getFloat32(id * 12, true), data.getFloat32(id * 12 + 4, true), data.getFloat32(id * 12 + 8, true));
    if (point.some((value, axis) => !Number.isFinite(value) || value < proxyBounds.min[axis]! || value > proxyBounds.max[axis]!)) invalid('non-finite or out-of-bounds vertex.');
    if (point[0] !== id % 33 - 16 || point[2] !== Math.floor(id / 33) - 16) invalid('grid positions do not match the complete source domain.');
    vertices.push(point);
  }
  const triangles: GiTriangle[] = []; const indexOffset = proxyVertices * 12;
  for (let cell = 0; cell < 1024; cell++) {
    const a = Math.floor(cell / 32) * 33 + cell % 32; const b = a + 33;
    const expected = [a, b, b + 1, a, b + 1, a + 1];
    for (let i = 0; i < 6; i++) if (data.getUint32(indexOffset + (cell * 6 + i) * 4, true) !== expected[i]) invalid('index topology is incomplete, out of range, or has reversed winding.');
    for (const start of [0, 3]) {
      const p0 = vertices[expected[start]!]!; const p1 = vertices[expected[start + 1]!]!; const p2 = vertices[expected[start + 2]!]!;
      const e1 = p1.map((value, axis) => value - p0[axis]!); const e2 = p2.map((value, axis) => value - p0[axis]!);
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const length = Math.hypot(...n); if (!Number.isFinite(length) || length === 0 || n[1]! <= 0) invalid('invalid triangle normal.');
      const normal = vector(...n.map(value => Math.fround(value / length)) as [number, number, number]);
      triangles.push(Object.freeze({ id: triangles.length, boxId: terrainTraceObjectId, materialId: 5, p0, p1, p2, normal }));
    }
  }
  return Object.freeze({ manifest, triangles: Object.freeze(triangles), payloadBytes: payload.byteLength });
}

/** Bound linked-source and sidecar network data before decoding or allocating geometry. */
export async function fetchTraceSourceBytes(url: URL, maximum: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) { await response.body?.cancel(); invalid(`request failed with HTTP${response.status}.`); }
  const announced = response.headers.get('content-length');
  if (announced !== null && (!/^\d+$/.test(announced) || Number(announced) > maximum)) {
    await response.body?.cancel(); invalid('response exceeds its bounded byte budget.');
  }
  if (!response.body) invalid('response has no body.');
  const reader = response.body.getReader(); const result = new Uint8Array(maximum); let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); signal?.throwIfAborted();
      if (chunk.done) break;
      if (total + chunk.value.byteLength > maximum) invalid('response exceeds its bounded byte budget.');
      result.set(chunk.value, total); total += chunk.value.byteLength;
    }
  } catch (cause) { await reader.cancel().catch(() => undefined); throw cause; }
  finally { reader.releaseLock(); }
  return result.buffer.slice(0, total);
}

export async function loadTraceProxy(proxyUrl: URL, geometryManifest: GeometryManifest, sourceManifestBytes: ArrayBuffer, signal?: AbortSignal): Promise<TerrainTraceProxy> {
  const bytes = await fetchTraceSourceBytes(proxyUrl, 16384, signal);
  let json: unknown;
  try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { invalid('manifest is not valid UTF-8 JSON.'); }
  const manifest = parseTraceProxyManifest(json, geometryManifest);
  const payload = await fetchTraceSourceBytes(new URL(manifest.mesh.url, proxyUrl), proxyPayloadBytes, signal);
  const result = await validateTraceProxy(manifest, payload, sourceManifestBytes);
  signal?.throwIfAborted();
  return result;
}
