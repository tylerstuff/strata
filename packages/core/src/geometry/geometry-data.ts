import { transformGeometryBounds } from './terrain-rendering.js';
import type { TerrainTransform } from './terrain-rendering.js';
import { StrataError } from '../errors.js';
import type { GeometryBounds, GeometryManifest } from './format.js';
import { lookAtMatrix, multiplyMatrices, orthographicMatrix } from '../rendering/raster-math.js';
import type { CameraFrame, Vec3 } from '../rendering/raster-math.js';
import { perspectiveMatrix } from '../rendering/scene-data.js';

/** GPU ABI v1: 16-word header, 12-word tiles, 8-word LODs, 16-word clusters. */
export function buildGeometryMetadata(manifest: GeometryManifest, capacityPages: number, transform?: TerrainTransform): { words: Uint32Array<ArrayBuffer>; triangleCapacity: number } {
  const lodCount = manifest.tiles.reduce((sum, tile) => sum + tile.lods.length, 0);
  const pageRefs = manifest.tiles.flatMap(tile => tile.lods.flatMap(lod => [...lod.pageIds]));
  const clusterRefs = manifest.tiles.flatMap(tile => tile.lods.flatMap(lod => [...lod.clusterIds]));
  const tileOffset = 16;
  const lodOffset = tileOffset + manifest.tiles.length * 12;
  const clusterOffset = lodOffset + lodCount * 8;
  const pageOffset = clusterOffset + manifest.clusters.length * 16;
  const referenceOffset = pageOffset + pageRefs.length;
  const words = new Uint32Array(referenceOffset + clusterRefs.length);
  const floats = new Float32Array(words.buffer);
  const pageTriangles = new Uint32Array(manifest.pages.length);
  for (const cluster of manifest.clusters) pageTriangles[cluster.pageId]! += cluster.triangleCount;
  const maxPageTriangles = pageTriangles.reduce((maximum, count) => Math.max(maximum, count), 0);
  const fullTriangles = manifest.tiles.reduce((sum, tile) => sum + Math.max(...tile.lods.map(lod => lod.clusterIds.reduce(
    (count, id) => count + manifest.clusters[id]!.triangleCount, 0,
  ))), 0);
  // At most capacityPages distinct pages can be resident. Every selected cluster belongs
  // to exactly one tile/LOD, so this bound covers both the camera and shadow work lists.
  const triangleCapacity = Math.min(fullTriangles, capacityPages * maxPageTriangles);
  if (!Number.isSafeInteger(triangleCapacity) || triangleCapacity < 1 || triangleCapacity * 3 >= 0x1_0000_0000) {
    throw new StrataError('UNSUPPORTED_LIMIT', 'Geometry draw capacity exceeds 32-bit indirect arguments.');
  }
  words.set([manifest.tiles.length, lodCount, manifest.clusters.length, manifest.pages.length,
    tileOffset, lodOffset, clusterOffset, pageOffset, referenceOffset, manifest.pageBytes / 4, triangleCapacity]);
  words.set(pageRefs, pageOffset); words.set(clusterRefs, referenceOffset);
  let lodIndex = 0; let pageIndex = 0; let clusterIndex = 0;
  for (const tile of manifest.tiles) {
    const base = tileOffset + tile.id * 12;
    const bounds = transform ? transformGeometryBounds(tile.bounds, transform) : tile.bounds;
    floats.set(bounds.min, base); floats.set(bounds.max, base + 4);
    words.set([lodIndex, tile.lods.length, 0, 0], base + 8);
    for (const lod of tile.lods) {
      const record = lodOffset + lodIndex * 8;
      words.set([clusterIndex, lod.clusterIds.length, pageIndex, lod.pageIds.length], record);
      floats[record + 4] = lod.error * (transform?.scale ?? 1); words[record + 5] = lod.level; words[record + 6] = tile.id;
      for (const id of lod.clusterIds) {
        const cluster = manifest.clusters[id]!;
        const clusterBase = clusterOffset + id * 16;
        words.set([cluster.pageId, cluster.vertexOffset / 4, cluster.indexOffset / 4, cluster.triangleCount, tile.id, lod.level, 0, 0], clusterBase);
        const bounds = transform ? transformGeometryBounds(cluster.bounds, transform) : cluster.bounds;
        floats.set(bounds.min, clusterBase + 8); floats.set(bounds.max, clusterBase + 12);
      }
      pageIndex += lod.pageIds.length; clusterIndex += lod.clusterIds.length; lodIndex++;
    }
  }
  return { words, triangleCapacity };
}

function transformed(matrix: Float32Array, point: Vec3): readonly [number, number, number, number] {
  return [0, 1, 2, 3].map(row => matrix[row]! * point[0] + matrix[4 + row]! * point[1]
    + matrix[8 + row]! * point[2] + matrix[12 + row]!) as unknown as readonly [number, number, number, number];
}
function corners(bounds: GeometryBounds): Vec3[] {
  return Array.from({ length: 8 }, (_, i) => [bounds[i & 1 ? 'max' : 'min'][0], bounds[i & 2 ? 'max' : 'min'][1], bounds[i & 4 ? 'max' : 'min'][2]] as Vec3);
}
export function geometryBoundsVisible(matrix: Float32Array, bounds: GeometryBounds): boolean {
  const clip = corners(bounds).map(point => transformed(matrix, point));
  return ![
    (p: readonly number[]) => p[0]! < -p[3]!, (p: readonly number[]) => p[0]! > p[3]!,
    (p: readonly number[]) => p[1]! < -p[3]!, (p: readonly number[]) => p[1]! > p[3]!,
    (p: readonly number[]) => p[2]! < 0, (p: readonly number[]) => p[2]! > p[3]!,
  ].some(outside => clip.every(outside));
}
export function projectedGeometryError(camera: CameraFrame, bounds: GeometryBounds, error: number, height: number): number {
  const depth = camera.orthographic ? 1 : Math.max(0.1, Math.min(...corners(bounds).map(point => -transformed(camera.view, point)[2])));
  return error * geometryProjectionScale(camera, height) / depth;
}

export function geometryProjectionScale(camera: CameraFrame, height: number): number {
  return height * (camera.projectionScaleY ?? 1 / Math.tan(55 * Math.PI / 360)) / 2;
}

/** Versioned close tour; visits each tile in serpentine order every 1.2 seconds. */
export function createTerrainCamera(manifest: GeometryManifest, width: number, height: number, time: number,
  jitter: readonly [number, number], mode: 'tour' | 'coverage'): CameraFrame {
  const extent = Math.max(manifest.bounds.max[0] - manifest.bounds.min[0], manifest.bounds.max[2] - manifest.bounds.min[2]) / 2;
  const far = extent * 8 + 100;
  let eye: Vec3; let view: Float32Array<ArrayBuffer>; let projection: Float32Array<ArrayBuffer>;
  if (mode === 'coverage') {
    eye = [0, manifest.bounds.max[1] + extent * 2 + 20, 0];
    view = new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, -eye[1], 1]);
    projection = orthographicMatrix(extent * 1.05, 0.1, far);
    projection[0]! /= width / height;
  } else {
    const side = manifest.source.tilesPerSide;
    const cell = manifest.source.cellsPerTile;
    const count = side * side;
    const phase = ((time / 1.2) % count + count) % count;
    const current = Math.floor(phase); const fraction = phase - current;
    const center = (index: number): readonly [number, number] => {
      const row = Math.floor(index / side); const column = row % 2 ? side - 1 - index % side : index % side;
      return [manifest.bounds.min[0] + (column + 0.5) * cell, manifest.bounds.min[2] + (row + 0.5) * cell];
    };
    const start = center(current); const end = center((current + 1) % count);
    const x = start[0] + (end[0] - start[0]) * fraction;
    const z = start[1] + (end[1] - start[1]) * fraction;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const dx = length ? (end[0] - start[0]) / length : 1;
    const dz = length ? (end[1] - start[1]) / length : 0;
    eye = [x, manifest.bounds.max[1] + 16, z];
    const target: Vec3 = [x + dx * cell * 0.25, manifest.bounds.min[1] - 4, z + dz * cell * 0.25];
    view = lookAtMatrix(eye, target);
    projection = perspectiveMatrix(width / height, 0.1, far);
  }
  if (mode === 'coverage') { projection[12] = 2 * jitter[0] / width; projection[13] = -2 * jitter[1] / height; }
  else { projection[8] = -2 * jitter[0] / width; projection[9] = 2 * jitter[1] / height; }
  return { eye, view, far, projectionScaleY: Math.abs(projection[5]!), orthographic: mode === 'coverage', viewProjection: multiplyMatrices(projection, view) };
}
