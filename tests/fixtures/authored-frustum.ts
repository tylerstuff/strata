import type { AuthoredBox, BoxCamera, BoxSceneDescriptor, BoxVec3 } from '../../packages/core/src/rendering/authored-box-types.js';

export const authoredFrustumPerspective = Object.freeze({ verticalFovRadians: Math.PI / 2, aspect: 1, near: 1, far: 2 });
/** Exactly packed square projection: x, y, 2d−2, d with forward depth d=−z. */
export const authoredFrustumViewProjection = (): Float32Array => new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -2, -1, 0, 0, -2, 0,
]);

export function frustumBox(id: string, position: BoxVec3, dimensions: BoxVec3 = [1 / 4, 1 / 4, 1 / 4],
  rotation: AuthoredBox['transform']['rotation'] = [0, 0, 0, 1]): AuthoredBox {
  return { id, dimensions, transform: { position, rotation, scale: [1, 1, 1] },
    material: { baseColor: [0.4, 0.6, 0.8, 1], metallic: 0, roughness: 0.5 } };
}

export interface AuthoredFrustumCase {
  readonly box: AuthoredBox;
  readonly intersectsSurface: boolean;
  /** Strictly outside fixtures must exercise actual useful rejection. */
  readonly requireRejection: boolean;
  readonly boundary: 'left' | 'right' | 'bottom' | 'top' | 'near' | 'far' | null;
}

export function authoredFrustumCases(): readonly AuthoredFrustumCase[] {
  const result: AuthoredFrustumCase[] = [];
  const faces = ['left', 'right', 'bottom', 'top', 'near', 'far'] as const;
  // Side tangencies occur where d=13/8 and |x| or |y|=13/8;
  // near/far tangencies have d=1 or d=2. All values are exact dyadics.
  for (const face of faces) {
    for (const [kind, outward] of [['inside', -1 / 16], ['sliver', -1 / 1024], ['tangent', 0], ['outside', 1 / 1024]] as const) {
      const side = 7 / 4 + outward;
      const position: BoxVec3 = face === 'left' ? [-side, 0, -3 / 2]
        : face === 'right' ? [side, 0, -3 / 2]
          : face === 'bottom' ? [0, -side, -3 / 2]
            : face === 'top' ? [0, side, -3 / 2]
              : face === 'near' ? [0, 0, -(7 / 8 - outward)] : [0, 0, -(17 / 8 + outward)];
      result.push({ box: frustumBox(`${face}-${kind}`, position), intersectsSurface: kind !== 'outside',
        requireRejection: kind === 'outside', boundary: face });
    }
  }
  result.push(
    { box: frustumBox('central', [0, 0, -3 / 2]), intersectsSurface: true, requireRejection: false, boundary: null },
    { box: frustumBox('wide-face-no-inside-corner', [0, 0, -3 / 2], [8, 8, 1 / 8]), intersectsSurface: true, requireRejection: false, boundary: null },
    { box: frustumBox('corner-tangent', [7 / 4, 7 / 4, -3 / 2]), intersectsSurface: true, requireRejection: false, boundary: null },
    { box: frustumBox('corner-sliver', [7 / 4 - 1 / 1024, 7 / 4 - 1 / 1024, -3 / 2]), intersectsSurface: true, requireRejection: false, boundary: null },
    { box: frustumBox('camera-inside-w-crossing', [0, 0, 0], [1, 1, 4]), intersectsSurface: true, requireRejection: false, boundary: null },
    { box: frustumBox('oblique-thin', [0, 0, -3 / 2], [1 / 4096, 2, 1 / 4], [0, 3 / 5, 0, 4 / 5]), intersectsSurface: true, requireRejection: false, boundary: null },
    { box: frustumBox('cyclic-nonuniform', [3 / 2, 0, -3 / 2], [1 / 4, 1 / 4096, 1 / 2], [0.5, 0.5, 0.5, 0.5]), intersectsSurface: true, requireRejection: false, boundary: null },
    { box: frustumBox('minimum-dimensions', [0, 0, -3 / 2], [0.0001, 0.0001, 0.0001]), intersectsSurface: true, requireRejection: false, boundary: null },
    { box: frustumBox('behind-camera', [0, 0, 3 / 2]), intersectsSurface: false, requireRejection: true, boundary: null },
  );
  return result;
}

export function frustumScene(boxes: readonly AuthoredBox[], anchor: BoxVec3 = [0, 0, 0]): BoxSceneDescriptor {
  const camera: BoxCamera = { position: anchor, rotation: [0, 0, 0, 1],
    projection: { kind: 'perspective', verticalFovRadians: Math.PI / 2, near: 1, far: 2 } };
  return { format: 'strata.runtime-boxes', version: 1, coordinateSystem: 'strata-world-v1', sceneId: 'frustum-cpu',
    sourceRevision: 'exact-boundary-v1', camera,
    boxes: boxes.map(box => ({ ...box, transform: { ...box.transform,
      position: box.transform.position.map((value, axis) => value + anchor[axis]!) as unknown as BoxVec3 } })),
    light: { directionToLight: [0, 1, 0], radiance: [1, 1, 1] }, background: [0, 0, 0] };
}

export const authoredFrustumAnchors: readonly BoxVec3[] = [
  [0, 0, 0], ...[1_000, 10_000, 100_000, 1_000_000].flatMap(distance =>
    [[distance, -distance, distance], [-distance, distance, -distance]] as const),
  // Centered 1024m cells change at ±999936. Each adjacent pair straddles it.
  [999936 - 1 / 1024, -999936 + 1 / 1024, 999936 - 1 / 1024],
  [999936 + 1 / 1024, -999936 - 1 / 1024, 999936 + 1 / 1024],
  [-999936 - 1 / 1024, 999936 + 1 / 1024, -999936 - 1 / 1024],
  [-999936 + 1 / 1024, 999936 - 1 / 1024, -999936 + 1 / 1024],
];
