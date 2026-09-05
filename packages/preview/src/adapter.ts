import { AuthoringError, canonicalJson, sceneRevision, validateScene, type SceneDocument } from '@strata-engine/authoring';
import { AuthoredBoxValidationError, validateAuthoredBoxScene, type BoxSceneDescriptor } from '@strata-engine/core';
import type { PreparedPreviewLoad } from './driver.js';
import { PreviewError } from './errors.js';

export interface AuthoredPreviewViewInput {
  camera: BoxSceneDescriptor['camera'];
  light: BoxSceneDescriptor['light'];
  background: BoxSceneDescriptor['background'];
  debugView?: 'final' | 'base-color';
  timeSeconds?: number;
  temporal?: false;
}

export interface AuthoredPreviewView {
  readonly camera: BoxSceneDescriptor['camera'];
  readonly light: BoxSceneDescriptor['light'];
  readonly background: BoxSceneDescriptor['background'];
  readonly debugView: 'final' | 'base-color';
  readonly timeSeconds: number;
  readonly temporal: false;
}

export interface AuthoredPreviewLoadInput {
  scene: SceneDocument;
  revision: string;
  view: AuthoredPreviewViewInput;
}

function reject(code: string, path: string, reason: string): never {
  throw new PreviewError(code, 'prepare-load', reason, { diagnostics: [{ path, reason }] });
}

function record(input: unknown, allowed: readonly string[], required: readonly string[], path: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    reject('PREVIEW_INVALID_OPTIONS', path, 'Expected a plain JSON object.');
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) reject('PREVIEW_UNSUPPORTED_FEATURE', `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, 'This field is unsupported by the authored preview profile.');
  }
  for (const key of required) {
    if (!Object.hasOwn(input, key)) reject('PREVIEW_INVALID_OPTIONS', `${path}/${key}`, 'Required preview field is missing.');
  }
  return input as Record<string, unknown>;
}

/**
 * Lower a verified authoring document into Core's resident root-box descriptor.
 * All validation and snapshots complete synchronously. Core owns runtime profile
 * limits and the descriptor/camera/light schema; no browser or asset fetching occurs.
 */
export function prepareAuthoredPreviewLoad(input: unknown): PreparedPreviewLoad<BoxSceneDescriptor, AuthoredPreviewView> {
  try {
    // Preflight only: do not use serialization as the snapshot, which would rewrite -0.
    canonicalJson(input);
  } catch (error) {
    throw new PreviewError('PREVIEW_INVALID_OPTIONS', 'prepare-load', 'Preview input must contain strict JSON data.',
      error instanceof AuthoringError ? { diagnostics: error.diagnostics } : {});
  }
  const value = record(input, ['scene', 'revision', 'view'], ['scene', 'revision', 'view'], '');
  const validated = validateScene(value.scene);
  if (!validated.ok) {
    throw new PreviewError('PREVIEW_INVALID_OPTIONS', 'prepare-load', 'The authoring scene is invalid.', {
      diagnostics: validated.diagnostics.map(diagnostic => ({ ...diagnostic, path: `/scene${diagnostic.path}` })),
    });
  }
  const document = validated.value;
  if (typeof value.revision !== 'string' || value.revision.length === 0) {
    reject('PREVIEW_INVALID_OPTIONS', '/revision', 'Supply the canonical source revision from the authoring API.');
  }
  const revision = sceneRevision(document);
  if (value.revision !== revision) {
    throw new PreviewError('PREVIEW_SOURCE_REVISION_MISMATCH', 'prepare-load', 'Source revision does not match the authoring document.', {
      expectedRevision: value.revision, actualRevision: revision,
      diagnostics: [{ path: '/revision', reason: 'Recompute sceneRevision after reviewing the changed source document.' }],
    });
  }
  for (const [index, asset] of document.assets.entries()) {
    if (asset.kind === 'external') {
      throw new PreviewError('PREVIEW_UNSUPPORTED_ASSET', 'prepare-load', 'This preview profile accepts procedural boxes only; external assets are unsupported even when unused.', {
        assetId: asset.id, diagnostics: [{ path: `/scene/assets/${index}/kind`, assetId: asset.id, reason: 'Remove the external descriptor from this procedural preview document; no asset is fetched or substituted.' }],
      });
    }
  }
  const view = record(value.view,
    ['camera', 'light', 'background', 'debugView', 'timeSeconds', 'temporal'],
    ['camera', 'light', 'background'], '/view');
  const debugView = view.debugView === undefined ? 'final' : view.debugView;
  if (debugView !== 'final' && debugView !== 'base-color') {
    reject('PREVIEW_UNSUPPORTED_FEATURE', '/view/debugView', 'Only final and base-color diagnostic views are supported.');
  }
  if (view.temporal !== undefined && view.temporal !== false) {
    reject('PREVIEW_UNSUPPORTED_FEATURE', '/view/temporal', 'Temporal rendering is unsupported by the authored root-box profile; use false.');
  }
  const timeSeconds = view.timeSeconds === undefined ? 0 : view.timeSeconds;
  if (typeof timeSeconds !== 'number' || !Number.isFinite(timeSeconds)) {
    reject('PREVIEW_INVALID_OPTIONS', '/view/timeSeconds', 'Fixed scene time must be a finite number.');
  }

  const assets = new Map(document.assets.map(asset => [asset.id, asset]));
  const materials = new Map(document.materials.map(material => [material.id, material]));
  // Preserve source entity order; canonical source revisions intentionally ignore collection order.
  const boxes = document.entities.map(entity => {
    const asset = assets.get(entity.assetId)!;
    const material = materials.get(entity.materialId)!;
    if (asset.kind !== 'procedural-box') reject('PREVIEW_UNSUPPORTED_ASSET', '', 'Only procedural boxes can be lowered.');
    return {
      id: entity.id, dimensions: asset.size, transform: entity.transform,
      material: { baseColor: material.baseColor, metallic: material.metallic, roughness: material.roughness },
    };
  });
  let scene: BoxSceneDescriptor;
  try {
    scene = validateAuthoredBoxScene({
      format: 'strata.runtime-boxes', version: 1, coordinateSystem: document.coordinateSystem,
      sceneId: document.id, sourceRevision: revision, boxes,
      camera: view.camera, light: view.light, background: view.background,
    });
  } catch (error) {
    if (!(error instanceof AuthoredBoxValidationError)) throw error;
    throw new PreviewError('PREVIEW_RUNTIME_VALIDATION_FAILED', 'prepare-load', error.message, {
      coreCode: error.code, diagnostics: error.diagnostics,
    });
  }
  return Object.freeze({
    scene, sceneId: document.id, sourceRevision: revision,
    view: Object.freeze({
      camera: scene.camera, light: scene.light, background: scene.background,
      debugView, timeSeconds, temporal: false,
    }),
  });
}
