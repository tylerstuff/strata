import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import type { Result, SceneAsset, SceneDocument, SceneEntity, SceneMaterial } from './model.js';
import { AuthoringError, ID_PATTERN } from './model.js';
import {
  assetSchema, canonicalJson, entitySchema, materialSchema, serializeScene, validateScene,
} from './schema.js';

export type SceneOperation =
  | { op: 'set-entity'; value: SceneEntity }
  | { op: 'set-asset'; value: SceneAsset }
  | { op: 'set-material'; value: SceneMaterial }
  | { op: 'remove-entity' | 'remove-asset' | 'remove-material'; id: string };

export interface SceneBatch {
  format: 'strata.scene-edit';
  version: 1;
  expectedRevision: string;
  operations: SceneOperation[];
}

export interface SceneSnapshot { scene: SceneDocument; revision: string }
export interface SceneChange {
  collection: 'assets' | 'materials' | 'entities';
  id: string;
  before: SceneAsset | SceneMaterial | SceneEntity | null;
  after: SceneAsset | SceneMaterial | SceneEntity | null;
}
export interface EditPreview extends SceneSnapshot {
  baseRevision: string;
  changed: boolean;
  changes: SceneChange[];
}

const operationSchemas = [
  ...Object.entries({ entity: entitySchema, asset: assetSchema, material: materialSchema }).map(([kind, schema]) => ({
    type: 'object', additionalProperties: false, required: ['op', 'value'],
    properties: { op: { const: `set-${kind}` }, value: schema },
  })),
  {
    type: 'object', additionalProperties: false, required: ['op', 'id'],
    properties: {
      op: { enum: ['remove-entity', 'remove-asset', 'remove-material'] },
      id: { type: 'string', pattern: ID_PATTERN.source },
    },
  },
];

/** Schema fragments for set values are shared with the scene validator. */
export const batchSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'urn:strata:authoring:scene-edit:1',
  title: 'Strata scene edit batch v1',
  type: 'object', additionalProperties: false,
  required: ['format', 'version', 'expectedRevision', 'operations'],
  properties: {
    format: { const: 'strata.scene-edit' }, version: { const: 1 },
    expectedRevision: { type: 'string', pattern: '^sha256:[a-f0-9]{64}(?![\\s\\S])' },
    operations: { type: 'array', maxItems: 10000, items: { oneOf: operationSchemas } },
  },
};
const checkBatch = new Ajv({ allErrors: true, strict: true, strictRequired: false, ownProperties: true }).compile<SceneBatch>(batchSchema);

function invalid<T>(code: string, path: string, message: string, suggestion: string): Result<T> {
  return { ok: false, diagnostics: [{ code, path, message, suggestion }] };
}

export function validateBatch(input: unknown): Result<SceneBatch> {
  try { canonicalJson(input); } catch (error) {
    if (error instanceof AuthoringError) return { ok: false, diagnostics: error.diagnostics };
    throw error;
  }
  if (!checkBatch(input)) {
    const operations = input && typeof input === 'object' && 'operations' in input && Array.isArray(input.operations)
      ? input.operations as unknown[] : [];
    const branchForOp: Record<string, number> = {
      'set-entity': 0, 'set-asset': 1, 'set-material': 2,
      'remove-entity': 3, 'remove-asset': 3, 'remove-material': 3,
    };
    // oneOf reports failures from every alternative. For a known operation, show only
    // its own schema failures so agents are not told to add unrelated asset fields.
    const errors = (checkBatch.errors ?? []).filter(error => {
      const match = /^\/operations\/(\d+)/.exec(error.instancePath);
      if (!match) return true;
      const operation = operations[Number(match[1])];
      const op = operation && typeof operation === 'object' && 'op' in operation ? operation.op : undefined;
      const expected = typeof op === 'string' && Object.hasOwn(branchForOp, op) ? branchForOp[op] : undefined;
      if (expected === undefined) return error.keyword === 'oneOf';
      const branch = /\/oneOf\/(\d+)\//.exec(error.schemaPath);
      return error.keyword !== 'oneOf' && (!branch || Number(branch[1]) === expected);
    });
    return { ok: false, diagnostics: errors.map(error => {
      const property = error.keyword === 'required' ? error.params.missingProperty
        : error.keyword === 'additionalProperties' ? error.params.additionalProperty : undefined;
      const path = error.instancePath + (typeof property === 'string' ? `/${property.replace(/~/g, '~0').replace(/\//g, '~1')}` : '');
      return {
        code: 'INVALID_BATCH', path,
        message: error.keyword === 'oneOf' ? 'Expected a supported set/remove operation with a complete value or stable ID.'
          : `Edit batch ${error.message ?? 'is invalid'}.`,
        suggestion: `Use strata-scene schema batch; ${error.keyword}: ${JSON.stringify(error.params)}.`,
      };
    }) };
  }
  return { ok: true, value: structuredClone(input) };
}

export function parseBatch(text: string, source?: string): Result<SceneBatch> {
  let input: unknown;
  try { input = JSON.parse(text); } catch (error) {
    return { ok: false, diagnostics: [{
      code: 'INVALID_JSON', path: '', message: error instanceof Error ? error.message : 'Invalid batch JSON.',
      suggestion: 'Supply one JSON object with no comments or trailing commas.',
      ...(source === undefined ? {} : { source }),
    }] };
  }
  const result = validateBatch(input);
  return !result.ok && source !== undefined
    ? { ok: false, diagnostics: result.diagnostics.map(diagnostic => ({ ...diagnostic, source })) }
    : result;
}

/** Semantic content revision; whitespace and collection/key order do not change it. */
export function sceneRevision(scene: SceneDocument): string {
  return `sha256:${createHash('sha256').update(serializeScene(scene)).digest('hex')}`;
}

function setById<T extends { id: string }>(items: T[], value: T): void {
  const index = items.findIndex(item => item.id === value.id);
  if (index < 0) items.push(value);
  else items[index] = value;
}

/** Validate the final graph once, allowing reference creation/removal in any batch order. */
export function applySceneBatch(scene: SceneDocument, input: SceneBatch): Result<EditPreview> {
  const original = validateScene(scene);
  if (!original.ok) return original;
  const batch = validateBatch(input);
  if (!batch.ok) return batch;
  const baseRevision = sceneRevision(original.value);
  if (batch.value.expectedRevision !== baseRevision) {
    return invalid('SCENE_STALE', '/expectedRevision',
      `Expected ${batch.value.expectedRevision}, current scene revision is ${baseRevision}.`,
      'Inspect the current scene, review the diff, and submit a batch with its current revision.');
  }
  const next = structuredClone(original.value);
  for (const operation of batch.value.operations) {
    switch (operation.op) {
      case 'set-entity': setById(next.entities, operation.value); break;
      case 'set-asset': setById(next.assets, operation.value); break;
      case 'set-material': setById(next.materials, operation.value); break;
      case 'remove-entity': next.entities = next.entities.filter(item => item.id !== operation.id); break;
      case 'remove-asset': next.assets = next.assets.filter(item => item.id !== operation.id); break;
      case 'remove-material': next.materials = next.materials.filter(item => item.id !== operation.id); break;
    }
  }
  const validated = validateScene(next);
  if (!validated.ok) return validated;
  // Return the same order that save/reload returns, even when operations were unordered.
  const canonical = JSON.parse(serializeScene(validated.value)) as SceneDocument;
  const changes: SceneChange[] = [];
  for (const collection of ['assets', 'materials', 'entities'] as const) {
    const before = new Map<string, SceneChange['before']>(original.value[collection].map(item => [item.id, item]));
    const after = new Map<string, SceneChange['after']>(canonical[collection].map(item => [item.id, item]));
    for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const previous = before.get(id) ?? null;
      const current = after.get(id) ?? null;
      if (canonicalJson(previous) !== canonicalJson(current)) changes.push({
        collection, id, before: structuredClone(previous), after: structuredClone(current),
      });
    }
  }
  return { ok: true, value: {
    scene: canonical, baseRevision, revision: sceneRevision(canonical), changed: changes.length > 0, changes,
  } };
}

export interface InspectionQuery {
  entityId?: string;
  assetId?: string;
  materialId?: string;
  limit?: number;
  after?: string;
}
export interface SceneInspection {
  sceneId: string;
  name: string;
  counts: { entities: number; assets: number; materials: number };
  selection: { kind: 'entity' | 'asset' | 'material'; value: SceneEntity | SceneAsset | SceneMaterial } | null;
  entities: SceneEntity[];
  nextCursor: string | null;
}

/** Bounded output over an in-memory document, not a world-streaming/spatial index. */
export function inspectScene(scene: SceneDocument, query: InspectionQuery = {}): Result<SceneInspection> {
  const result = validateScene(scene);
  if (!result.ok) return result;
  try { canonicalJson(query); } catch {
    return invalid('INVALID_QUERY', '', 'Inspection queries must contain plain JSON data.',
      'Select an ID or request an entity page with a numeric limit and an after cursor.');
  }
  if (!query || typeof query !== 'object' || Array.isArray(query)
    || Object.keys(query).some(key => !['entityId', 'assetId', 'materialId', 'limit', 'after'].includes(key))) {
    return invalid('INVALID_QUERY', '', 'Unsupported inspection query.', 'Select an ID or request an entity page with limit and after.');
  }
  const selectors = ['entityId', 'assetId', 'materialId'] as const;
  const selected = selectors.filter(key => query[key] !== undefined);
  const limit = query.limit === undefined ? 100 : query.limit;
  if (selected.length > 1 || !Number.isInteger(limit) || limit < 1 || limit > 1000
    || selected.some(key => typeof query[key] !== 'string')
    || (query.after !== undefined && typeof query.after !== 'string')
    || (selected.length > 0 && (query.after !== undefined || query.limit !== undefined))) {
    return invalid('INVALID_QUERY', '', 'Conflicting or invalid inspection parameters.',
      'Select exactly one ID, or use a page limit from 1 to 1000 and an existing entity ID as the after cursor.');
  }
  const inspection: SceneInspection = {
    sceneId: scene.id, name: scene.name,
    counts: { entities: scene.entities.length, assets: scene.assets.length, materials: scene.materials.length },
    selection: null, entities: [], nextCursor: null,
  };
  const key = selected[0];
  if (key !== undefined) {
    const kind = key === 'entityId' ? 'entity' : key === 'assetId' ? 'asset' : 'material';
    const items = key === 'entityId' ? scene.entities : key === 'assetId' ? scene.assets : scene.materials;
    const value = items.find(item => item.id === query[key]);
    if (!value) return invalid('NOT_FOUND', '', `${kind} ${query[key]} does not exist.`, 'Inspect the scene or use a known stable ID.');
    inspection.selection = { kind, value: structuredClone(value) };
  } else {
    const sorted = [...scene.entities].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const cursor = query.after === undefined ? -1 : sorted.findIndex(item => item.id === query.after);
    if (query.after !== undefined && cursor < 0) return invalid('INVALID_QUERY', '/after',
      `Entity cursor ${query.after} does not exist.`, 'Restart pagination after a scene revision change.');
    inspection.entities = structuredClone(sorted.slice(cursor + 1, cursor + 1 + limit));
    if (cursor + 1 + limit < sorted.length) inspection.nextCursor = inspection.entities.at(-1)!.id;
  }
  return { ok: true, value: inspection };
}
