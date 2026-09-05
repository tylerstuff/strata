import { Ajv, type ErrorObject } from 'ajv';
import {
  AuthoringError,
  ID_PATTERN,
  MAX_SCALE,
  MIN_SCALE,
  QUATERNION_NORM_TOLERANCE,
  SCENE_SCHEMA_VERSION,
  WORLD_POSITION_LIMIT,
  type Diagnostic,
  type Result,
  type SceneDocument,
} from './model.js';

const idSchema = { type: 'string', pattern: ID_PATTERN.source };
const nameSchema = { type: 'string', minLength: 1, maxLength: 256 };
const unitNumberSchema = { type: 'number', minimum: 0, maximum: 1 };
const vectorSchema = (component: object, count = 3): object => ({
  type: 'array', minItems: count, maxItems: count, items: component,
});

/** Shared fragments also power batch-operation validation. They contain no external $refs. */
export const transformSchema = {
  type: 'object', additionalProperties: false, required: ['position', 'rotation', 'scale'],
  properties: {
    position: vectorSchema({ type: 'number', minimum: -WORLD_POSITION_LIMIT, maximum: WORLD_POSITION_LIMIT }),
    rotation: vectorSchema({ type: 'number' }, 4),
    scale: vectorSchema({ type: 'number', minimum: MIN_SCALE, maximum: MAX_SCALE }),
  },
};

export const assetSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'kind'],
  properties: {
    id: idSchema,
    kind: { enum: ['procedural-box', 'external'] },
    size: vectorSchema({ type: 'number', exclusiveMinimum: 0 }),
    uri: { type: 'string', minLength: 1, maxLength: 4096, pattern: '\\S' },
    mediaType: { type: 'string', minLength: 1, maxLength: 256, pattern: '^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+(?![\\s\\S])' },
  },
  allOf: [{
    if: { properties: { kind: { const: 'procedural-box' } }, required: ['kind'] },
    then: { required: ['size'], properties: { size: {}, uri: false, mediaType: false } },
  }, {
    if: { properties: { kind: { const: 'external' } }, required: ['kind'] },
    then: { required: ['uri', 'mediaType'], properties: { uri: {}, mediaType: {}, size: false } },
  }],
};

export const materialSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'kind', 'baseColor', 'metallic', 'roughness'],
  properties: {
    id: idSchema,
    kind: { const: 'pbr' },
    baseColor: {
      type: 'array', minItems: 4, maxItems: 4,
      items: [unitNumberSchema, unitNumberSchema, unitNumberSchema, { const: 1 }],
      additionalItems: false,
    },
    metallic: unitNumberSchema,
    roughness: unitNumberSchema,
  },
};

export const entitySchema = {
  type: 'object', additionalProperties: false, required: ['id', 'assetId', 'materialId', 'transform'],
  properties: {
    id: idSchema, name: nameSchema, assetId: idSchema, materialId: idSchema, transform: transformSchema,
  },
};

/** Draft 7 shape schema. validateScene additionally checks ID references and quaternion norm. */
export const sceneSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'urn:strata:authoring:scene:1',
  title: 'Strata authoring scene version 1',
  description: 'Editable root entities and asset descriptors; no browser runtime loading is implemented by this format.',
  type: 'object', additionalProperties: false,
  required: ['format', 'version', 'id', 'name', 'coordinateSystem', 'assets', 'materials', 'entities'],
  properties: {
    format: { const: 'strata.scene' },
    version: { const: SCENE_SCHEMA_VERSION },
    id: idSchema,
    name: nameSchema,
    coordinateSystem: { const: 'strata-world-v1' },
    assets: { type: 'array', items: assetSchema },
    materials: { type: 'array', items: materialSchema },
    entities: { type: 'array', items: entitySchema },
  },
};

const validateShape = new Ajv({ allErrors: true, strict: true, ownProperties: true }).compile<SceneDocument>(sceneSchema);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const pointerToken = (value: string): string => value.replace(/~/g, '~0').replace(/\//g, '~1');

function jsonDiagnostic(path: string, message: string): Diagnostic {
  return {
    code: 'INVALID_JSON_VALUE',
    path,
    message,
    suggestion: 'Use only plain JSON objects, arrays, strings, booleans, null, and finite numbers.',
  };
}

/** Validates JSON values without invoking getters or silently dropping data. */
function sortedJson(value: unknown, path = '', ancestors = new Set<object>(), depth = 0): JsonValue {
  if (depth > 128) {
    throw new AuthoringError([jsonDiagnostic(path, 'JSON nesting exceeds the supported depth of 128.')]);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value !== 'object' || value === null) {
    throw new AuthoringError([jsonDiagnostic(path, 'This value cannot be represented losslessly in JSON.')]);
  }
  if (ancestors.has(value)) {
    throw new AuthoringError([jsonDiagnostic(path, 'JSON cannot represent a circular reference.')]);
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new AuthoringError([jsonDiagnostic(path, 'Expected a plain JSON object.')]);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new AuthoringError([jsonDiagnostic(path, 'JSON cannot preserve symbol properties.')]);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.getOwnPropertyNames(value).filter((key) => key !== 'length');
      if (keys.length !== value.length || keys.some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
        throw new AuthoringError([jsonDiagnostic(path, 'Expected a dense JSON array without extra properties.')]);
      }
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) {
          throw new AuthoringError([jsonDiagnostic(`${path}/${index}`, 'JSON values cannot use getters or setters.')]);
        }
        return sortedJson(descriptor.value, `${path}/${index}`, ancestors, depth + 1);
      });
    }
    const result: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw new AuthoringError([jsonDiagnostic(`${path}/${pointerToken(key)}`, 'JSON values cannot use getters, setters, or hidden properties.')]);
      }
      result[key] = sortedJson(descriptor.value, `${path}/${pointerToken(key)}`, ancestors, depth + 1);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** Canonical JSON text: lexical object keys, preserved array order, two spaces and one trailing LF. */
export function canonicalJson(value: unknown): string {
  const render = (input: JsonValue, depth: number): string => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    const indent = '  '.repeat(depth);
    const childIndent = `${indent}  `;
    if (Array.isArray(input)) {
      return input.length === 0 ? '[]' : `[\n${input.map((item) => `${childIndent}${render(item, depth + 1)}`).join(',\n')}\n${indent}]`;
    }
    const keys = Object.keys(input).sort();
    return keys.length === 0 ? '{}' : `{\n${keys.map((key) => `${childIndent}${JSON.stringify(key)}: ${render(input[key]!, depth + 1)}`).join(',\n')}\n${indent}}`;
  };
  return `${render(sortedJson(value), 0)}\n`;
}

function diagnosticContext(input: unknown, path: string): Partial<Diagnostic> {
  const match = /^\/(entities|assets|materials)\/(\d+)(?:\/|$)/.exec(path);
  if (!match || !input || typeof input !== 'object') return {};
  const collection: unknown = Object.getOwnPropertyDescriptor(input, match[1]!)?.value;
  if (!Array.isArray(collection)) return {};
  const item: unknown = Object.getOwnPropertyDescriptor(collection, match[2]!)?.value;
  if (!item || typeof item !== 'object') return {};
  const id: unknown = Object.getOwnPropertyDescriptor(item, 'id')?.value;
  if (typeof id !== 'string') return {};
  const key = match[1] === 'entities' ? 'entityId' : match[1] === 'assets' ? 'assetId' : 'materialId';
  return { [key]: id };
}

function schemaDiagnostic(error: ErrorObject, input: unknown): Diagnostic {
  let path = error.instancePath;
  let code = 'INVALID_VALUE';
  let message = error.message ?? 'The value does not match the scene schema.';
  let suggestion = 'Use the scene schema to correct this value.';
  if (error.keyword === 'required') {
    path += `/${pointerToken(String(error.params.missingProperty))}`;
    code = 'REQUIRED_FIELD';
    message = `Required field "${String(error.params.missingProperty)}" is missing.`;
    suggestion = `Add the "${String(error.params.missingProperty)}" field.`;
  } else if (error.keyword === 'additionalProperties') {
    path += `/${pointerToken(String(error.params.additionalProperty))}`;
    code = 'UNSUPPORTED_FIELD';
    message = `Field "${String(error.params.additionalProperty)}" is not supported by scene version ${SCENE_SCHEMA_VERSION}.`;
    suggestion = 'Remove this field; renderer, camera, hierarchy, and importer controls are not part of this authoring format.';
  } else if (path === '/version') {
    code = 'UNSUPPORTED_VERSION';
    message = `Only scene version ${SCENE_SCHEMA_VERSION} is supported.`;
    suggestion = 'Use a compatible authoring package or explicitly migrate the document; do not just relabel an unknown format.';
  } else if (path === '/format') {
    code = 'UNSUPPORTED_FORMAT';
    message = 'Expected the format identifier "strata.scene".';
    suggestion = 'Open a Strata scene document or create one with createScene / the scene create command.';
  } else if (error.keyword === 'pattern' && /\/(id|assetId|materialId)$/.test(path)) {
    code = 'INVALID_ID';
    message = 'IDs must start with a lowercase ASCII letter and contain at most 64 lowercase letters, digits, dots, underscores, or hyphens.';
    suggestion = 'Choose an explicit stable ID such as "courtyard.wall-1" and update any references to it.';
  } else if (path.endsWith('/mediaType') && error.keyword === 'pattern') {
    code = 'INVALID_MEDIA_TYPE';
    message = 'Expected a bare media type such as "model/gltf+json".';
    suggestion = 'Use a type/subtype media type without parameters; this descriptor does not enable asset import.';
  } else if (path.endsWith('/uri') && error.keyword === 'pattern') {
    code = 'INVALID_ASSET_URI';
    message = 'An external asset reference cannot contain only whitespace.';
    suggestion = 'Supply an explicit URI or path reference to an asset stored outside the scene document.';
  } else if (error.keyword === 'type') {
    code = 'INVALID_TYPE';
    message = `Expected ${String(error.params.type)}.`;
    suggestion = `Replace the value with a JSON ${String(error.params.type)}; implicit type coercion is not supported.`;
  } else if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].includes(error.keyword)) {
    code = 'OUT_OF_RANGE';
    suggestion = `Use a finite number that ${message}.`;
  } else if (['minItems', 'maxItems'].includes(error.keyword)) {
    code = 'INVALID_VECTOR';
    suggestion = `Supply exactly the components required by the schema (${String(error.params.limit)} for this vector).`;
  } else if (error.keyword === 'enum' || error.keyword === 'const') {
    code = 'UNSUPPORTED_VALUE';
    suggestion = `Use ${JSON.stringify(error.params.allowedValues ?? error.params.allowedValue)} as specified by the scene schema.`;
  } else if (error.keyword === 'false schema') {
    code = 'UNSUPPORTED_FIELD';
    message = 'This field is not supported for the selected asset kind.';
    suggestion = 'Remove fields belonging to another asset kind.';
  }
  return { code, path, message, suggestion, ...diagnosticContext(input, path) };
}

/** Shape and semantic validation used by file, code, and CLI authoring. Does not change the input. */
export function validateScene(input: unknown): Result<SceneDocument> {
  try {
    sortedJson(input);
  } catch (error) {
    if (!(error instanceof AuthoringError)) throw error;
    return {
      ok: false,
      diagnostics: error.diagnostics.map((diagnostic) => ({ ...diagnostic, ...diagnosticContext(input, diagnostic.path) })),
    };
  }
  if (!validateShape(input)) {
    return {
      ok: false,
      diagnostics: (validateShape.errors ?? []).filter((error) => error.keyword !== 'if').map((error) => schemaDiagnostic(error, input)),
    };
  }
  const scene = input;
  const diagnostics: Diagnostic[] = [];
  for (const collection of ['assets', 'materials', 'entities'] as const) {
    const firstIndices = new Map<string, number>();
    scene[collection].forEach((item, index) => {
      const previous = firstIndices.get(item.id);
      if (previous !== undefined) {
        const path = `/${collection}/${index}/id`;
        diagnostics.push({
          code: 'DUPLICATE_ID', path,
          message: `ID "${item.id}" is already present at /${collection}/${previous}/id.`,
          suggestion: 'Keep one item per stable ID; update the existing item or give the new item a distinct ID and update its references.',
          ...diagnosticContext(scene, path),
        });
      } else firstIndices.set(item.id, index);
    });
  }
  const assetIds = new Set(scene.assets.map((asset) => asset.id));
  const materialIds = new Set(scene.materials.map((material) => material.id));
  scene.entities.forEach((entity, index) => {
    if (!assetIds.has(entity.assetId)) {
      diagnostics.push({
        code: 'MISSING_ASSET', path: `/entities/${index}/assetId`,
        message: `Entity "${entity.id}" references missing asset "${entity.assetId}".`,
        suggestion: 'Add an asset descriptor with this ID or change the entity to reference an existing asset.',
        entityId: entity.id, assetId: entity.assetId,
      });
    }
    if (!materialIds.has(entity.materialId)) {
      diagnostics.push({
        code: 'MISSING_MATERIAL', path: `/entities/${index}/materialId`,
        message: `Entity "${entity.id}" references missing material "${entity.materialId}".`,
        suggestion: 'Add a material with this ID or change the entity to reference an existing material.',
        entityId: entity.id, materialId: entity.materialId,
      });
    }
    const norm = Math.hypot(...entity.transform.rotation);
    if (!Number.isFinite(norm) || Math.abs(norm - 1) > QUATERNION_NORM_TOLERANCE) {
      diagnostics.push({
        code: 'INVALID_QUATERNION', path: `/entities/${index}/transform/rotation`,
        message: `Rotation must be a unit quaternion within ${QUATERNION_NORM_TOLERANCE} of length 1.`,
        suggestion: 'Supply a normalized quaternion in [x,y,z,w] order; identity is [0,0,0,1].',
        entityId: entity.id,
      });
    }
  });
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, value: scene };
}

function parseErrorLocation(error: unknown, text: string): { line?: number; column?: number } {
  const message = error instanceof Error ? error.message : '';
  const explicit = /line (\d+) column (\d+)/.exec(message);
  if (explicit) return { line: Number(explicit[1]), column: Number(explicit[2]) };
  const position = /at position (\d+)/.exec(message);
  const offset = position ? Number(position[1]) : /Unexpected end of JSON input/.test(message) ? text.length : undefined;
  if (offset === undefined) return {};
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: before[before.length - 1]!.length + 1 };
}

/** Parse text and retain the filename/source label in every diagnostic. */
export function parseScene(text: string, source?: string): Result<SceneDocument> {
  let input: unknown;
  try {
    if (typeof text !== 'string') throw new TypeError('Scene text must be a string.');
    input = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: 'INVALID_JSON',
        path: '',
        message: error instanceof Error ? error.message : 'Invalid JSON text.',
        suggestion: 'Correct the JSON syntax (double-quoted keys and strings; no comments or trailing commas), then validate again.',
        ...(source !== undefined ? { source } : {}),
        ...parseErrorLocation(error, typeof text === 'string' ? text : ''),
      }],
    };
  }
  const result = validateScene(input);
  if (result.ok || source === undefined) return result;
  return { ok: false, diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic, source })) };
}

/** Validate before writing and preserve the caller's object/collection order in memory. */
export function serializeScene(scene: SceneDocument): string {
  const result = validateScene(scene);
  if (!result.ok) throw new AuthoringError(result.diagnostics);
  const byId = <T extends { id: string }>(items: T[]): T[] => [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return canonicalJson({
    ...result.value,
    assets: byId(result.value.assets),
    materials: byId(result.value.materials),
    entities: byId(result.value.entities),
  });
}
