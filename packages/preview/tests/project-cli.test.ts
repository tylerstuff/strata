import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { PreviewError } from '../src/errors.js';
import { runProjectCli, writeProjectCliResult, type ProjectCliApi } from '../src/project-cli.js';
import type { ProjectBuildResult, ProjectInspection } from '../src/project-types.js';

const token = `sha256:${'a'.repeat(64)}`;
const projectPath = resolve('fixture/project.json');
const outputDirectory = resolve('fixture-delivery');
const buildArguments = ['build', projectPath, '--expected-input-revision', token, '--out', outputDirectory];

function inspection(): ProjectInspection {
  return {
    projectPath, projectRoot: resolve('fixture'), sceneId: 'sample',
    project: { format: 'strata.project', version: 1, id: 'sample', name: 'Sample',
      scene: 'scene.json', view: 'view.json', width: 512, height: 512 },
    identity: { projectRevision: token, sourceRevision: token, inputRevision: token,
      projectSha256: 'a'.repeat(64), sceneSha256: 'b'.repeat(64), viewSha256: 'c'.repeat(64),
      runtimeSceneSha256: 'd'.repeat(64), resolvedViewSha256: 'e'.repeat(64) },
    counts: { assets: 1, materials: 1, entities: 1 },
    view: { camera: { position: [0, 0, 4], rotation: [0, 0, 0, 1],
      projection: { kind: 'perspective', verticalFovRadians: 1, near: 0.1, far: 32 } },
    light: { directionToLight: [0, 0, 1], radiance: [2, 2, 2] }, background: [0, 0, 0],
    debugView: 'final', timeSeconds: 0, temporal: false },
    capabilities: { profile: 'opaque-root-boxes', cooking: false, externalAssets: false },
  };
}

function buildResult(): ProjectBuildResult {
  return { publicationOccurred: true, outputDirectory, receiptPath: join(outputDirectory, 'build-receipt.json'),
    receipt: { format: 'strata.project.build', version: 1, projectId: 'sample', identity: inspection().identity,
      width: 512, height: 512, runtime: { package: '@strata-engine/core', version: '0.0.0', files: [] }, files: [] } };
}

function api() {
  return {
    initProject: vi.fn(async () => ({ ...inspection(), publicationOccurred: true as const })),
    inspectProject: vi.fn(async () => inspection()),
    validateProject: vi.fn(async () => inspection()),
    buildProject: vi.fn(async () => buildResult()),
  } satisfies ProjectCliApi;
}

function output() {
  const stdout: string[] = [], stderr: string[] = [];
  return { stdout, stderr, channels: {
    stdout: vi.fn(async (text: string) => { stdout.push(text); }),
    stderr: vi.fn(async (text: string) => { stderr.push(text); }),
  } };
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('saved project CLI argument contract', () => {
  it.each([['help'], ['--help'], ['discover'], ['build', '--help']].map(argv => ({ argv })))
  ('returns JSON discovery for $argv without invoking project work', async ({ argv }) => {
    const methods = api(), report = output();
    const outcome = await runProjectCli(argv, { api: methods });
    expect(await writeProjectCliResult(outcome, report.channels)).toBe(0);
    expect(report.stdout).toHaveLength(1); expect(report.stderr).toEqual([]);
    expect(report.stdout[0]!.split('\n')).toHaveLength(2);
    expect(JSON.parse(report.stdout[0]!)).toMatchObject({ ok: true, command: 'help', usage: {
      capabilities: { profile: 'opaque-root-boxes', browserLaunch: false, cooking: false, externalAssets: false },
      exitCodes: { success: 0, unexpectedOrCanceled: 1, usage: 2, invalidInput: 3, conflict: 4, io: 5 },
    } });
    for (const method of Object.values(methods)) expect(method).not.toHaveBeenCalled();
  });

  it.each([
    [], ['unsupported'], ['help', 'extra'], ['inspect'], ['inspect', 'a', 'b'],
    ['inspect', 'a', '--check-assets'], ['init', 'new'], ['init', 'new', '--id'],
    ['init', 'new', '--id', 'sample', '--id', 'sample'], ['init', 'new', '--id=sample'],
    ['init', 'new', '--id', 'sample', '--browser'], ['validate', 'a', '--check-assets', '--check-assets'],
    ['validate', 'a', '--asset-directory'], ['validate', 'a', '--asset-directory', 'one', '--asset-directory', 'two'],
    ['validate', 'a', '--check-assets', 'false'], ['build', 'a', '--out', 'new'],
    ['build', 'a', '--expected-input-revision', token], [...buildArguments, '--out', 'other'],
    [...buildArguments, '--unknown'], ['inspect', 'a\0b'], ['inspect', ''],
    ['build', 'a', '--expected-input-revision', token, '--out', 'new\npath'],
    ['validate', 'a', '--asset-directory', 'asset\0path'],
    ['inspect', 'https://example.invalid/project.json'],
    ['build', 'a', '--expected-input-revision', token, '--out', 'file:///tmp/delivery'],
    ['validate', 'a', '--asset-directory', 'https://example.invalid/assets'],
    ['init', 'new\\directory', '--id', 'sample'],
  ].map(argv => ({ argv })))('rejects strict malformed arguments $argv before dispatch', async ({ argv }) => {
    const methods = api(), report = output();
    const outcome = await runProjectCli(argv, { api: methods });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.result).toMatchObject({ ok: false, error: { code: 'PROJECT_CLI_USAGE', stage: 'arguments' } });
    expect(await writeProjectCliResult(outcome, report.channels)).toBe(2);
    expect(report.stdout).toHaveLength(1); expect(report.stderr).toEqual([]);
    expect(JSON.parse(report.stdout[0]!)).toEqual(outcome.result);
    expect(report.stdout[0]).not.toContain('"stack"');
    for (const method of Object.values(methods)) expect(method).not.toHaveBeenCalled();
  });

  it('resolves paths, forwards explicit init values and preserves optional fields', async () => {
    const methods = api(), controller = new AbortController();
    const result = await runProjectCli(['init', '--name', '海辺の scene', './new-project', '--id', 'sample'],
      { api: methods, signal: controller.signal });
    expect(result.exitCode).toBe(0);
    expect(methods.initProject).toHaveBeenCalledExactlyOnceWith({ directory: resolve('./new-project'), id: 'sample',
      name: '海辺の scene', signal: controller.signal });
    expect(methods.buildProject).not.toHaveBeenCalled();
    await runProjectCli(['init', './second-project', '--id', 'second'], { api: methods });
    expect(methods.initProject).toHaveBeenLastCalledWith({ directory: resolve('./second-project'), id: 'second' });
  });

  it('keeps inspection asset checks opt-in and lets asset-directory imply checks', async () => {
    const methods = api();
    await runProjectCli(['inspect', './fixture/project.json'], { api: methods });
    expect(methods.inspectProject).toHaveBeenCalledExactlyOnceWith({ projectPath });
    await runProjectCli(['validate', './fixture/project.json'], { api: methods });
    expect(methods.validateProject).toHaveBeenLastCalledWith({ projectPath });
    await runProjectCli(['validate', './fixture/project.json', '--check-assets'], { api: methods });
    expect(methods.validateProject).toHaveBeenLastCalledWith({ projectPath, checkAssets: true });
    await runProjectCli(['validate', './fixture/project.json', '--asset-directory', './external-assets'], { api: methods });
    expect(methods.validateProject).toHaveBeenLastCalledWith({ projectPath, checkAssets: true, assetDirectory: resolve('./external-assets') });
  });

  it('forwards the exact inspected token and resolved output/asset paths to build', async () => {
    const methods = api(), controller = new AbortController();
    const outcome = await runProjectCli([...buildArguments, '--asset-directory', './external-assets'], { api: methods, signal: controller.signal });
    expect(outcome.exitCode).toBe(0);
    expect(methods.buildProject).toHaveBeenCalledExactlyOnceWith({ projectPath, expectedInputRevision: token,
      outputDirectory, checkAssets: true, assetDirectory: resolve('./external-assets'), signal: controller.signal });
    expect(outcome.result).toMatchObject({ ok: true, command: 'build', path: projectPath, publicationOccurred: true, outputDirectory });
  });
});

describe('project CLI error and publication outcomes', () => {
  it.each([
    ['PROJECT_INVALID_OPTIONS', 3], ['PROJECT_DOCUMENT_INVALID', 3], ['PROJECT_INPUT_PATH', 3],
    ['PROJECT_INPUT_TOO_LARGE', 3], ['PROJECT_INPUT_INVALID', 3], ['PROJECT_ASSET_INVALID', 3],
    ['PROJECT_PREVIEW_UNSUPPORTED', 3], ['PROJECT_OUTPUT_EXISTS', 4], ['PROJECT_OUTPUT_CHANGED', 4], ['PROJECT_INPUT_STALE', 4],
    ['PROJECT_INPUT_CHANGED', 4], ['PROJECT_INPUT_IO', 5], ['PROJECT_OUTPUT_IO', 5],
    ['PROJECT_ABORTED', 1], ['PROJECT_RUNTIME_DISTRIBUTION_INVALID', 1],
  ] as const)('preserves %s diagnostics and maps its exit status to %d', async (code, status) => {
    const methods = api();
    const diagnostics = [{ code: 'ASSET_MISSING', path: '/assets/0/uri', source: '/external/texture.png',
      message: 'The referenced file is missing.', suggestion: 'Provide the selected local asset.' }];
    methods.buildProject.mockRejectedValue(new PreviewError(code, 'controlled-stage', 'Controlled failure.', {
      publicationOccurred: false, diagnostics, expectedInputRevision: token, actualInputRevision: `sha256:${'b'.repeat(64)}`,
    }));
    const outcome = await runProjectCli(buildArguments, { api: methods });
    expect(outcome.exitCode).toBe(status);
    expect(outcome.result).toEqual({ ok: false, command: 'build', path: projectPath,
      error: { code, stage: 'controlled-stage', message: 'Controlled failure.', details: {
        publicationOccurred: false, diagnostics, expectedInputRevision: token, actualInputRevision: `sha256:${'b'.repeat(64)}`,
      } } });
  });

  it('reports unexpected API rejection without a raw stack or false publication claim', async () => {
    const methods = api(); methods.inspectProject.mockRejectedValue(new Error('Controlled unexpected failure.'));
    const outcome = await runProjectCli(['inspect', projectPath], { api: methods });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result).toMatchObject({ ok: false, error: { code: 'PROJECT_FAILED', stage: 'cli', details: {} } });
    expect(JSON.stringify(outcome.result)).not.toContain('stack');
    expect(JSON.stringify(outcome.result)).not.toContain('publicationOccurred');
  });

  it('does not dispatch a command whose signal is already canceled', async () => {
    const methods = api(), controller = new AbortController(); controller.abort();
    const outcome = await runProjectCli(buildArguments, { api: methods, signal: controller.signal });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result).toMatchObject({ ok: false, error: { code: 'PROJECT_ABORTED' } });
    for (const method of Object.values(methods)) expect(method).not.toHaveBeenCalled();
  });

  it('awaits actual build settlement and preserves successful publication after cancellation', async () => {
    const methods = api(), controller = new AbortController(), completion = deferred<ProjectBuildResult>();
    methods.buildProject.mockImplementation(() => completion.promise);
    let settled = false;
    const pending = runProjectCli(buildArguments, { api: methods, signal: controller.signal }).then(result => { settled = true; return result; });
    await turn(); controller.abort(); await turn();
    expect(settled).toBe(false);
    completion.resolve({ ...buildResult(), cleanupWarnings: ['Owned temporary cleanup could not be confirmed.'] });
    const outcome = await pending;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result).toMatchObject({ ok: true, publicationOccurred: true,
      cleanupWarnings: ['Owned temporary cleanup could not be confirmed.'] });
  });

  it('waits for canceled build cleanup before exposing its actual rejection', async () => {
    const methods = api(), controller = new AbortController(), completion = deferred<ProjectBuildResult>();
    methods.buildProject.mockImplementation(() => completion.promise);
    let settled = false;
    const pending = runProjectCli(buildArguments, { api: methods, signal: controller.signal }).then(result => { settled = true; return result; });
    await turn(); controller.abort(); await turn(); expect(settled).toBe(false);
    completion.reject(new PreviewError('PROJECT_ABORTED', 'cleanup', 'Canceled work finished cleanup.',
      { publicationOccurred: false, outputDirectory }));
    const outcome = await pending;
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result).toMatchObject({ ok: false, error: { code: 'PROJECT_ABORTED', stage: 'cleanup',
      details: { publicationOccurred: false, outputDirectory } } });
  });

  it('preserves publication evidence when an error contains unserializable details', async () => {
    const methods = api(), details: Record<string, unknown> = { publicationOccurred: true, outputDirectory };
    details.circular = details;
    methods.buildProject.mockRejectedValue(new PreviewError('PROJECT_OUTPUT_IO', 'cleanup', 'Cleanup evidence could not be serialized.', details));
    const outcome = await runProjectCli(buildArguments, { api: methods });
    expect(outcome.exitCode).toBe(5);
    expect(outcome.result).toMatchObject({ error: { details: {
      publicationOccurred: true, outputDirectory, detailSerializationFailed: true, outcomeUnknown: true,
    } } });
    expect(() => JSON.stringify(outcome.result)).not.toThrow();
  });
});

describe('single-attempt terminal JSON reporting', () => {
  it('writes one complete JSON object and LF with no progress or error banner', async () => {
    const methods = api(), report = output();
    const outcome = await runProjectCli(buildArguments, { api: methods });
    expect(await writeProjectCliResult(outcome, report.channels)).toBe(0);
    expect(report.channels.stdout).toHaveBeenCalledTimes(1); expect(report.channels.stderr).not.toHaveBeenCalled();
    expect(report.stdout[0]).toBe(`${JSON.stringify(outcome.result)}\n`);
  });

  it('does not retry stdout after a partial write and preserves known publication on stderr', async () => {
    const report = output();
    report.channels.stdout.mockImplementation(async text => { report.stdout.push(text.slice(0, 25)); throw new Error('EPIPE'); });
    const outcome = { exitCode: 0, result: { ok: true, command: 'build', path: projectPath, ...buildResult() } };
    expect(await writeProjectCliResult(outcome, report.channels)).toBe(1);
    expect(report.channels.stdout).toHaveBeenCalledTimes(1); expect(report.channels.stderr).toHaveBeenCalledTimes(1);
    expect(report.stdout).toHaveLength(1);
    expect(JSON.parse(report.stderr[0]!)).toMatchObject({ ok: false, error: { code: 'PROJECT_REPORT_FAILED', stage: 'stdout',
      details: { publicationOccurred: true, deliveryUncertain: true, outputDirectory, receiptPath: buildResult().receiptPath } } });
  });

  it.each([true, false])('retains nested publication=%s and uncertainty when an error report cannot reach stdout', async publicationOccurred => {
    const methods = api(), report = output();
    methods.buildProject.mockRejectedValue(new PreviewError('PROJECT_OUTPUT_IO', 'cleanup', 'Actual work settled with an error.', {
      publicationOccurred, outcomeUnknown: true, outputDirectory, receiptPath: buildResult().receiptPath,
    }));
    const outcome = await runProjectCli(buildArguments, { api: methods });
    report.channels.stdout.mockRejectedValue(new Error('EPIPE'));
    expect(await writeProjectCliResult(outcome, report.channels)).toBe(1);
    expect(report.channels.stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(report.stderr[0]!)).toMatchObject({ error: { details: {
      publicationOccurred, outcomeUnknown: true, deliveryUncertain: true, outputDirectory, receiptPath: buildResult().receiptPath,
    } } });
  });

  it('returns failure when both output channels fail without another delivery attempt', async () => {
    const report = output(); report.channels.stdout.mockRejectedValue(new Error('EPIPE')); report.channels.stderr.mockRejectedValue(new Error('EPIPE'));
    expect(await writeProjectCliResult({ exitCode: 0, result: { ok: true } }, report.channels)).toBe(1);
    expect(report.channels.stdout).toHaveBeenCalledTimes(1); expect(report.channels.stderr).toHaveBeenCalledTimes(1);
  });

  it('reports serialization failure without attempting to write a malformed JSON prefix', async () => {
    const report = output(), result: Record<string, unknown> = { ok: true, publicationOccurred: true, outputDirectory };
    result.circular = result;
    expect(await writeProjectCliResult({ exitCode: 0, result }, report.channels)).toBe(1);
    expect(report.channels.stdout).not.toHaveBeenCalled(); expect(report.channels.stderr).toHaveBeenCalledTimes(1);
    expect(JSON.parse(report.stderr[0]!)).toMatchObject({ error: { details: { publicationOccurred: true, deliveryUncertain: true, outputDirectory } } });
  });
});

it('runs the real CPU init-to-inspect CLI flow with stable saved input identity', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'strata-project-cli-')));
  try {
    const target = join(directory, 'new-project'), initializedOutput = output(), inspectedOutput = output();
    const initialized = await runProjectCli(['init', target, '--id', 'cli-project', '--name', 'CLI project']);
    expect(initialized.exitCode).toBe(0);
    expect(await writeProjectCliResult(initialized, initializedOutput.channels)).toBe(0);
    const init = JSON.parse(initializedOutput.stdout[0]!) as ProjectInspection & { ok: boolean; publicationOccurred: boolean };
    expect(init.ok).toBe(true); expect(init.publicationOccurred).toBe(true);
    expect(init.projectPath).toBe(join(target, 'project.json'));
    const inspected = await runProjectCli(['inspect', init.projectPath]);
    expect(inspected.exitCode).toBe(0);
    expect(await writeProjectCliResult(inspected, inspectedOutput.channels)).toBe(0);
    const saved = JSON.parse(inspectedOutput.stdout[0]!) as ProjectInspection & { ok: boolean };
    expect(saved.ok).toBe(true); expect(saved.project.id).toBe('cli-project');
    expect(saved.identity).toEqual(init.identity);
    expect(saved.identity.inputRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(initializedOutput.stdout).toHaveLength(1); expect(inspectedOutput.stdout).toHaveLength(1);
    expect(initializedOutput.stderr).toEqual([]); expect(inspectedOutput.stderr).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
