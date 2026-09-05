import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  AuthoringError,
  batchSchema,
  createProceduralScene,
  createScene,
  createSceneFile,
  editSceneFile,
  inspectScene,
  parseBatch,
  previewSceneFile,
  readSceneFile,
  sceneSchema,
  validateSceneAssets,
} from './index.js';
import type { Diagnostic, InspectionQuery, Result } from './index.js';

export interface CliResult {
  exitCode: number;
  result: Record<string, unknown>;
}

type Command = 'help' | 'schema' | 'create' | 'inspect' | 'validate' | 'diff' | 'edit';
type FlagKind = 'value' | 'boolean';
const MAX_BATCH_FILE_BYTES = 16 * 1024 * 1024;

const commandFlags: Record<Command, Readonly<Record<string, FlagKind>>> = {
  help: {},
  schema: {},
  create: { id: 'value', name: 'value', fixture: 'value' },
  inspect: { entity: 'value', asset: 'value', material: 'value', limit: 'value', after: 'value' },
  validate: { assets: 'boolean', 'asset-root': 'value' },
  diff: { batch: 'value' },
  edit: { batch: 'value' },
};

const capabilities = {
  tool: 'strata-scene',
  protocolVersion: 1,
  sceneVersion: 1,
  batchVersion: 1,
  scope: 'Standalone scene documents and local authoring operations. No browser runtime scene loading.',
  capabilities: {
    sceneDocuments: true,
    typedEdits: true,
    revisionChecks: true,
    atomicBatchEditing: true,
    localAssetExistenceChecks: true,
    runtimeLoading: false,
    importing: false,
    cooking: false,
    browserPreview: false,
    localConnection: false,
  },
  commands: {
    help: { usage: 'strata-scene help | --help', description: 'Return command and capability discovery.' },
    schema: { usage: 'strata-scene schema [scene|batch]', description: 'Return the version 1 JSON schema; defaults to scene.' },
    create: { usage: 'strata-scene create <file> --id <id> [--name <name>] [--fixture boxes]', description: 'Create an empty scene or procedural boxes fixture without overwriting an existing path.' },
    inspect: { usage: 'strata-scene inspect <file> [--entity <id>|--asset <id>|--material <id>] [--limit <1..1000>] [--after <id>]', description: 'Inspect one record, or list entities in stable ID order. Pagination flags apply only to the entity list; default limit is 100.' },
    validate: { usage: 'strata-scene validate <file> [--assets] [--asset-root <path>]', description: 'Validate the scene and optionally check local asset references without fetching or importing. Asset roots default to STRATA_BENCHMARK_ASSET_DIR or the scene directory. --asset-root requires --assets.' },
    diff: { usage: 'strata-scene diff <file> --batch <batch.json>', description: 'Validate a revision-checked batch and preview changes without writing.' },
    edit: { usage: 'strata-scene edit <file> --batch <batch.json>', description: 'Validate and atomically apply a revision-checked batch.' },
  },
  output: { format: 'json', resultsPerInvocation: 1, noninteractive: true },
  limits: { batchFileBytes: MAX_BATCH_FILE_BYTES, entityPageSize: 1000 },
  exitCodes: { '0': 'success', '1': 'unexpected failure', '2': 'usage error', '3': 'invalid scene, batch, asset, or reference', '4': 'stale revision or busy/existing conflict', '5': 'filesystem I/O error' },
};

function usage(message: string, path = '/arguments'): never {
  throw new AuthoringError([{
    code: 'CLI_USAGE',
    path,
    message,
    suggestion: 'Run strata-scene --help for supported commands and arguments.',
  }]);
}

function unwrap<T>(result: Result<T>, source?: string): T {
  if (!result.ok) throw new AuthoringError(source === undefined
    ? result.diagnostics
    : result.diagnostics.map((diagnostic) => ({ ...diagnostic, source: diagnostic.source ?? source })));
  return result.value;
}

function parseArguments(command: Command, args: readonly string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith('-')) {
      positional.push(argument);
      continue;
    }
    if (!argument.startsWith('--') || argument.includes('=')) usage(`Unsupported argument ${JSON.stringify(argument)}.`);
    const flag = argument.slice(2);
    if (!Object.hasOwn(commandFlags[command], flag)) usage(`Unknown flag ${JSON.stringify(argument)} for ${command}.`);
    if (flags.has(flag)) usage(`Flag ${argument} may only be specified once.`);
    if (commandFlags[command][flag] === 'boolean') {
      flags.set(flag, true);
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith('--') || value.length === 0) usage(`Flag ${argument} requires a nonempty value.`);
    flags.set(flag, value);
  }
  return { positional, flags };
}

function stringFlag(flags: Map<string, string | true>, key: string, required = false): string | undefined {
  const value = flags.get(key);
  if (typeof value === 'string') return value;
  if (required) usage(`Missing required flag --${key}.`);
  return undefined;
}

async function readBatch(path: string) {
  let text: string;
  let handle: FileHandle | undefined;
  try {
    // O_NONBLOCK lets us reject FIFOs as nonregular files without waiting for a writer.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) throw new AuthoringError([{
      code: 'IO_ERROR', path: '', source: path,
      message: 'Batch input must be a regular file.',
      suggestion: 'Save the complete batch as a JSON file before invoking this command.',
    }]);
    const tooLarge = (): never => { throw new AuthoringError([{
      code: 'FILE_TOO_LARGE', path: '', source: path,
      message: `Batch exceeds ${MAX_BATCH_FILE_BYTES} bytes.`,
      suggestion: 'Use a smaller batch file and inspect the new revision between separate edits.',
    }]); };
    if (info.size > MAX_BATCH_FILE_BYTES) tooLarge();
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BATCH_FILE_BYTES - bytes + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAX_BATCH_FILE_BYTES) tooLarge();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    text = Buffer.concat(chunks, bytes).toString('utf8');
  } catch (error) {
    if (error instanceof AuthoringError) throw error;
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN';
    throw new AuthoringError([{
      code: 'IO_ERROR',
      path: '',
      source: path,
      message: `Cannot read batch file (${code}).`,
      suggestion: 'Check that the batch path exists, is a readable file, and is accessible to this process.',
    }]);
  } finally { await handle?.close().catch(() => undefined); }
  return unwrap(parseBatch(text, path));
}

function errorExitCode(diagnostics: readonly Diagnostic[]): number {
  if (diagnostics.some(({ code }) => code === 'CLI_USAGE')) return 2;
  if (diagnostics.some(({ code }) => code === 'SCENE_STALE' || code === 'FILE_BUSY' || code === 'FILE_EXISTS')) return 4;
  if (diagnostics.some(({ code }) => code === 'IO_ERROR')) return 5;
  return 3;
}

/** Execute without reading stdin, printing, terminating the process, or starting a browser. */
export async function runCli(argv: readonly string[]): Promise<CliResult> {
  const commandName = argv[0] === '--help' ? 'help' : argv[0];
  try {
    if (commandName === undefined) usage('Expected a command.');
    if (!Object.hasOwn(commandFlags, commandName)) usage(`Unsupported command ${JSON.stringify(commandName)}.`);
    const command = commandName as Command;
    const { positional, flags } = parseArguments(command, argv.slice(1));
    const success = (payload: Record<string, unknown>): CliResult => ({ exitCode: 0, result: { ok: true, command, ...payload } });

    if (command === 'help') {
      if (positional.length !== 0) usage('The help command does not accept positional arguments.');
      return success(capabilities);
    }
    if (command === 'schema') {
      if (positional.length > 1) usage('The schema command accepts at most one schema name.');
      const schemaName = positional[0] ?? 'scene';
      if (schemaName !== 'scene' && schemaName !== 'batch') usage('Schema name must be scene or batch.');
      return success({ schemaName, schema: schemaName === 'scene' ? sceneSchema : batchSchema });
    }
    if (positional.length !== 1 || positional[0]!.length === 0) usage(`The ${command} command requires exactly one scene file path.`);
    const path = resolve(positional[0]!);

    if (command === 'create') {
      const id = stringFlag(flags, 'id', true)!;
      const name = stringFlag(flags, 'name');
      const fixture = stringFlag(flags, 'fixture');
      if (fixture !== undefined && fixture !== 'boxes') usage('The only supported fixture is boxes.');
      const scene = fixture === 'boxes' ? createProceduralScene(id, name) : createScene(id, name);
      const snapshot = await createSceneFile(path, scene);
      return success({ path, sceneId: snapshot.scene.id, revision: snapshot.revision });
    }

    if (command === 'diff' || command === 'edit') {
      const batchPath = resolve(stringFlag(flags, 'batch', true)!);
      const batch = await readBatch(batchPath);
      const preview = command === 'diff' ? await previewSceneFile(path, batch) : await editSceneFile(path, batch);
      return success({ path, baseRevision: preview.baseRevision, revision: preview.revision, changed: preview.changed, changes: preview.changes });
    }

    if (command === 'inspect') {
      const selectors = (['entity', 'asset', 'material'] as const).filter((key) => flags.has(key));
      if (selectors.length > 1) usage('Choose only one of --entity, --asset, or --material.');
      if (selectors.length > 0 && (flags.has('limit') || flags.has('after'))) usage('Pagination flags cannot be used with a selected entity, asset, or material.');
      const limitText = stringFlag(flags, 'limit') ?? '100';
      if (!/^[1-9][0-9]*(?![\s\S])/.test(limitText) || Number(limitText) > 1000) usage('--limit must be an integer from 1 to 1000.');
      const snapshot = await readSceneFile(path);
      const selector = selectors[0];
      const query: InspectionQuery = selector === 'entity' ? { entityId: stringFlag(flags, 'entity')! }
        : selector === 'asset' ? { assetId: stringFlag(flags, 'asset')! }
        : selector === 'material' ? { materialId: stringFlag(flags, 'material')! }
        : { limit: Number(limitText), ...(flags.has('after') ? { after: stringFlag(flags, 'after')! } : {}) };
      return success({ path, revision: snapshot.revision, inspection: unwrap(inspectScene(snapshot.scene, query), path) });
    }

    const assetRoot = stringFlag(flags, 'asset-root');
    if (assetRoot !== undefined && !flags.has('assets')) usage('--asset-root requires --assets.');
    const snapshot = await readSceneFile(path);
    const assets = flags.has('assets')
      ? unwrap(await validateSceneAssets(snapshot.scene, { scenePath: path, ...(assetRoot === undefined ? {} : { assetRoot }) }))
      : null;
    return success({ path, sceneId: snapshot.scene.id, revision: snapshot.revision, assets });
  } catch (error) {
    if (error instanceof AuthoringError) {
      return { exitCode: errorExitCode(error.diagnostics), result: { ok: false, command: commandName ?? null, diagnostics: error.diagnostics } };
    }
    return {
      exitCode: 1,
      result: {
        ok: false,
        command: commandName ?? null,
        diagnostics: [{ code: 'INTERNAL_ERROR', path: '', message: 'Unexpected authoring failure.', suggestion: 'Report this failure with the command and a minimal scene/batch that reproduces it.' }],
      },
    };
  }
}
