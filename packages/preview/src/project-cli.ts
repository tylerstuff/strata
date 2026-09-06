import { resolve } from 'node:path';
import { PreviewError } from './errors.js';
import type { ProjectBuildOptions, ProjectBuildResult, ProjectInitOptions, ProjectInspection, ProjectReadOptions } from './project-types.js';

export interface ProjectCliApi {
  initProject(options: ProjectInitOptions): Promise<ProjectInspection>;
  inspectProject(options: ProjectReadOptions): Promise<ProjectInspection>;
  validateProject(options: ProjectReadOptions): Promise<ProjectInspection>;
  buildProject(options: ProjectBuildOptions): Promise<ProjectBuildResult>;
}

export interface ProjectCliDependencies { api?: ProjectCliApi; signal?: AbortSignal }
export interface ProjectCliOutcome { exitCode: number; result: Record<string, unknown> }
export interface ProjectCliOutput {
  stdout(text: string): void | Promise<void>;
  stderr(text: string): void | Promise<void>;
}

type Command = 'init' | 'inspect' | 'validate' | 'build';
type Arguments = { command: Command; path: string; flags: Map<string, string | true> };

const usage = {
  commands: {
    help: 'strata-project help | --help | discover',
    init: 'strata-project init NEW_DIRECTORY --id ID [--name NAME]',
    inspect: 'strata-project inspect PROJECT_JSON',
    validate: 'strata-project validate PROJECT_JSON [--check-assets] [--asset-directory PATH]',
    build: 'strata-project build PROJECT_JSON --expected-input-revision TOKEN --out NEW_DIRECTORY [--check-assets] [--asset-directory PATH]',
  },
  capabilities: { profile: 'opaque-root-boxes', browserLaunch: false, cooking: false, externalAssets: false },
  assets: 'Existence checks are opt-in and never fetch assets. --asset-directory implies --check-assets.',
  publication: 'Init and build require new directories. Build checks the exact inspected input revision. Cancellation awaits owned work; successful publication survives late cancellation.',
  output: 'One terminal JSON object on stdout. Reporting failures use stderr; stdout is never retried.',
  exitCodes: { success: 0, unexpectedOrCanceled: 1, usage: 2, invalidInput: 3, conflict: 4, io: 5 },
};

function invalid(message: string): never {
  throw new PreviewError('PROJECT_CLI_USAGE', 'arguments', message, { usage: usage.commands });
}

function parseArguments(argv: readonly string[]): Arguments | null {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) invalid('Arguments must be strings.');
  if (argv.length === 1 && ['--help', 'help', 'discover'].includes(argv[0]!)) return null;
  const command = argv[0];
  if (command !== 'init' && command !== 'inspect' && command !== 'validate' && command !== 'build') {
    invalid('Expected init, inspect, validate, build, or --help.');
  }
  if (argv.length === 2 && argv[1] === '--help') return null;
  const valued = new Set(command === 'init' ? ['id', 'name']
    : command === 'validate' ? ['asset-directory']
      : command === 'build' ? ['expected-input-revision', 'out', 'asset-directory'] : []);
  const boolean = new Set(command === 'validate' || command === 'build' ? ['check-assets'] : []);
  const flags = new Map<string, string | true>();
  let path: string | undefined;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument.startsWith('-')) {
      if (!argument.startsWith('--') || argument.includes('=')) invalid('Expected a supported flag without an equals sign.');
      const name = argument.slice(2);
      if (!valued.has(name) && !boolean.has(name)) invalid('Unknown flag for the selected command.');
      if (flags.has(name)) invalid(`--${name} may only be supplied once.`);
      if (boolean.has(name)) flags.set(name, true);
      else {
        const value = argv[++index];
        if (!value || value.startsWith('--')) invalid(`--${name} requires a value.`);
        flags.set(name, value);
      }
    } else {
      if (path !== undefined) invalid('Supply exactly one project path or new directory.');
      if (!argument || /[\\\u0000-\u001f\u007f-\u009f]/.test(argument) || /^[a-z][a-z0-9+.-]*:/i.test(argument)) {
        invalid('The path must be local, nonempty and contain no schemes, backslashes or control characters.');
      }
      path = resolve(argument);
    }
  }
  if (path === undefined) invalid(command === 'init' ? 'Supply the new project directory.' : 'Supply the project JSON path.');
  const required = command === 'init' ? ['id'] : command === 'build' ? ['expected-input-revision', 'out'] : [];
  for (const name of required) if (!flags.has(name)) invalid(`--${name} is required.`);
  for (const name of ['asset-directory', 'out']) {
    const value = flags.get(name);
    if (typeof value === 'string') {
      if (/[\\\u0000-\u001f\u007f-\u009f]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
        invalid(`--${name} must be local and cannot contain schemes, backslashes or control characters.`);
      }
      flags.set(name, resolve(value));
    }
  }
  return { command, path, flags };
}

const invalidCodes = new Set([
  'PROJECT_INVALID_OPTIONS', 'PROJECT_DOCUMENT_INVALID', 'PROJECT_INPUT_PATH', 'PROJECT_INPUT_TOO_LARGE',
  'PROJECT_INPUT_INVALID', 'PROJECT_ASSET_INVALID', 'PROJECT_PREVIEW_UNSUPPORTED',
]);
const conflictCodes = new Set(['PROJECT_OUTPUT_EXISTS', 'PROJECT_OUTPUT_CHANGED', 'PROJECT_INPUT_STALE', 'PROJECT_INPUT_CHANGED']);
const ioCodes = new Set(['PROJECT_INPUT_IO', 'PROJECT_OUTPUT_IO']);

function exitCode(code: string): number {
  if (code === 'PROJECT_CLI_USAGE') return 2;
  if (invalidCodes.has(code)) return 3;
  if (conflictCodes.has(code)) return 4;
  if (ioCodes.has(code)) return 5;
  return 1;
}

function evidence(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (typeof value.publicationOccurred === 'boolean') result.publicationOccurred = value.publicationOccurred;
  if (typeof value.outcomeUnknown === 'boolean') result.outcomeUnknown = value.outcomeUnknown;
  for (const key of ['outputDirectory', 'receiptPath', 'projectPath', 'path']) {
    if (typeof value[key] === 'string') result[key] = value[key];
  }
  return result;
}

function diagnostic(error: unknown): { code: string; stage: string; message: string; details: Record<string, unknown> } {
  if (error instanceof PreviewError) {
    let details: Record<string, unknown>;
    try { details = JSON.parse(JSON.stringify(error.details)) as Record<string, unknown>; }
    catch { details = { ...evidence(error.details), detailSerializationFailed: true, outcomeUnknown: true }; }
    return { code: error.code, stage: error.stage, message: error.message, details };
  }
  return { code: 'PROJECT_FAILED', stage: 'cli', message: error instanceof Error ? error.message : 'Unexpected project failure.', details: {} };
}

/** CPU-only command dispatch. Imports no browser adapter and never calls process.exit. */
export async function runProjectCli(argv: readonly string[], dependencies: ProjectCliDependencies = {}): Promise<ProjectCliOutcome> {
  let command: Command | null = null;
  let path: string | null = null;
  try {
    const args = parseArguments(argv);
    if (args === null) return { exitCode: 0, result: { ok: true, command: 'help', usage } };
    command = args.command; path = args.path;
    if (dependencies.signal !== undefined && !(dependencies.signal instanceof AbortSignal)) {
      throw new PreviewError('PROJECT_INVALID_OPTIONS', 'cli', 'Expected an AbortSignal.');
    }
    if (dependencies.signal?.aborted) throw new PreviewError('PROJECT_ABORTED', command, 'Project command was canceled before it started.');
    const api = dependencies.api ?? await import('./project.js');
    const signal = dependencies.signal === undefined ? {} : { signal: dependencies.signal };
    const assetDirectory = args.flags.get('asset-directory');
    const readOptions: ProjectReadOptions = {
      projectPath: path, ...signal,
      ...(args.flags.has('check-assets') || assetDirectory !== undefined ? { checkAssets: true } : {}),
      ...(typeof assetDirectory === 'string' ? { assetDirectory } : {}),
    };
    let result: ProjectInspection | ProjectBuildResult;
    if (command === 'init') {
      const name = args.flags.get('name');
      result = await api.initProject({ directory: path, id: args.flags.get('id') as string,
        ...(typeof name === 'string' ? { name } : {}), ...signal });
    } else if (command === 'inspect') result = await api.inspectProject(readOptions);
    else if (command === 'validate') result = await api.validateProject(readOptions);
    else result = await api.buildProject({ ...readOptions, expectedInputRevision: args.flags.get('expected-input-revision') as string,
      outputDirectory: args.flags.get('out') as string });
    // The API owns publication and cleanup. Never race it against cancellation
    // or apply a post-publication abort check here.
    return { exitCode: 0, result: { ok: true, command, path, ...result, ...(command === 'init' ? { publicationOccurred: true } : {}) } };
  } catch (error) {
    const failure = diagnostic(error);
    return { exitCode: exitCode(failure.code), result: { ok: false, command, path, error: failure } };
  }
}

/** Make one stdout attempt; a failed write may already have delivered a prefix. */
export async function writeProjectCliResult(outcome: ProjectCliOutcome, output: ProjectCliOutput): Promise<number> {
  try {
    await output.stdout(`${JSON.stringify(outcome.result)}\n`);
    return outcome.exitCode;
  } catch {
    const failure = outcome.result.error;
    const nested = failure && typeof failure === 'object' && !Array.isArray(failure)
      ? (failure as Record<string, unknown>).details : undefined;
    const details = { ...(nested && typeof nested === 'object' && !Array.isArray(nested)
      ? evidence(nested as Record<string, unknown>) : {}), ...evidence(outcome.result), deliveryUncertain: true };
    try {
      await output.stderr(`${JSON.stringify({ ok: false, command: outcome.result.command ?? null, path: outcome.result.path ?? null,
        error: { code: 'PROJECT_REPORT_FAILED', stage: 'stdout', message: 'The terminal JSON result could not be written; stdout was not retried.', details } })}\n`);
    } catch { /* There is no remaining diagnostic channel. */ }
    return 1;
  }
}
