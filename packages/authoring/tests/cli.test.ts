import { mkdtemp, readFile, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { batchSchema, readSceneFile, sceneSchema, serializeScene } from '../src/index.js';

const temporaryDirectories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'strata-authoring-cli-'));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('agent-facing CLI', () => {
  it('discovers supported capabilities and schemas as JSON without process output', async () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    const result = await runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.result).toMatchObject({
      ok: true,
      command: 'help',
      capabilities: { runtimeLoading: false, importing: false, browserPreview: false, revisionChecks: true },
      exitCodes: { '4': 'stale revision or busy/existing conflict' },
    });
    expect(await runCli(['help'])).toEqual(result);
    expect(JSON.parse(JSON.stringify(result.result))).toEqual(result.result);
    expect((await runCli(['schema'])).result).toEqual({ ok: true, command: 'schema', schemaName: 'scene', schema: sceneSchema });
    expect((await runCli(['schema', 'batch'])).result).toEqual({ ok: true, command: 'schema', schemaName: 'batch', schema: batchSchema });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each([
    [],
    ['render', 'scene.json'],
    ['__proto__'],
    ['help', 'extra'],
    ['schema', 'other'],
    ['schema', 'scene', 'extra'],
    ['create', 'scene.json'],
    ['create', 'scene.json', '--id'],
    ['create', 'scene.json', '--id', ''],
    ['create', 'scene.json', '--id', 'scene', '--id', 'scene'],
    ['create', 'scene.json', '--id=scene'],
    ['create', 'scene.json', '--id', 'scene', '--unknown'],
    ['create', 'scene.json', '--id', 'scene', '--fixture', 'imported'],
    ['inspect', 'scene.json', '--limit', '0'],
    ['inspect', 'scene.json', '--limit', '1001'],
    ['inspect', 'scene.json', '--limit', '1.5'],
    ['inspect', 'scene.json', '--limit', '1e2'],
    ['inspect', 'scene.json', '--limit', '1\n'],
    ['inspect', 'scene.json', '--entity', 'box', '--asset', 'box'],
    ['inspect', 'scene.json', '--entity', 'box', '--limit', '1'],
    ['inspect', 'scene.json', '--asset', 'box', '--after', 'box'],
    ['validate', 'scene.json', '--assets', '--assets'],
    ['validate', 'scene.json', '--asset-root', '/tmp'],
    ['diff', 'scene.json'],
    ['edit', 'scene.json', '--batch'],
    ['validate', 'scene.json', 'extra'],
  ])('rejects unsupported or ambiguous arguments before reading files: %j', async (...args) => {
    const result = await runCli(args);
    expect(result.exitCode).toBe(2);
    expect(result.result).toMatchObject({ ok: false, diagnostics: [{ code: 'CLI_USAGE', message: expect.any(String), suggestion: expect.any(String) }] });
    expect(result.result).not.toHaveProperty('stack');
  });

  it('creates an empty document and refuses to overwrite it', async () => {
    const path = join(await directory(), 'empty scene.json');
    const result = await runCli(['create', path, '--id', 'empty-scene', '--name', 'Empty scene']);
    expect(result.exitCode).toBe(0);
    expect(result.result).toMatchObject({ ok: true, command: 'create', path, sceneId: 'empty-scene', revision: expect.any(String) });
    const original = await readFile(path, 'utf8');
    expect(JSON.parse(original)).toMatchObject({ id: 'empty-scene', name: 'Empty scene', entities: [], assets: [], materials: [] });
    const conflict = await runCli(['create', path, '--id', 'replacement']);
    expect(conflict.exitCode).toBe(4);
    expect(conflict.result).toMatchObject({ ok: false, diagnostics: [{ code: 'FILE_EXISTS' }] });
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('paginates the fixture and selects records without returning the entire scene', async () => {
    const path = join(await directory(), 'boxes.json');
    expect((await runCli(['create', path, '--id', 'boxes-scene', '--fixture', 'boxes'])).exitCode).toBe(0);
    const initial = await readSceneFile(path);
    await writeFile(path, serializeScene({ ...initial.scene, entities: [...initial.scene.entities, { ...initial.scene.entities[0]!, id: 'box-2' }] }));
    const snapshot = await readSceneFile(path);
    const sorted = [...snapshot.scene.entities].sort((a, b) => a.id.localeCompare(b.id));
    const first = await runCli(['inspect', path, '--limit', '1']);
    expect(first.result).toMatchObject({
      ok: true,
      revision: snapshot.revision,
      inspection: { sceneId: 'boxes-scene', entities: [sorted[0]], nextCursor: sorted[0]!.id, selection: null },
    });
    expect(first.result).not.toHaveProperty('scene');
    const second = await runCli(['inspect', path, '--limit', '1', '--after', sorted[0]!.id]);
    expect(second.result).toMatchObject({ inspection: { entities: [sorted[1]] } });
    const selected = await runCli(['inspect', path, '--entity', sorted[0]!.id]);
    expect(selected.result).toMatchObject({ inspection: { entities: [], nextCursor: null, selection: { kind: 'entity', value: sorted[0] } } });
    const asset = snapshot.scene.assets[0]!;
    expect((await runCli(['inspect', path, '--asset', asset.id])).result).toMatchObject({ inspection: { entities: [], selection: { kind: 'asset', value: asset } } });
    const material = snapshot.scene.materials[0]!;
    expect((await runCli(['inspect', path, '--material', material.id])).result).toMatchObject({ inspection: { entities: [], selection: { kind: 'material', value: material } } });
    expect((await runCli(['inspect', path, '--entity', 'missing'])).exitCode).toBe(3);
    expect((await runCli(['inspect', path, '--after', 'missing'])).exitCode).toBe(3);
  });

  it('previews and applies a batch, rejects stale replay, and preserves the saved result', async () => {
    const root = await directory();
    const path = join(root, 'boxes.json');
    const batchPath = join(root, 'edit.json');
    await runCli(['create', path, '--id', 'boxes-scene', '--fixture', 'boxes']);
    const snapshot = await readSceneFile(path);
    const original = await readFile(path, 'utf8');
    const entity = structuredClone(snapshot.scene.entities[0]!);
    entity.name = 'Changed by CLI';
    entity.transform.position = [12.25, 0.5, -4];
    await writeFile(batchPath, JSON.stringify({ format: 'strata.scene-edit', version: 1, expectedRevision: snapshot.revision, operations: [{ op: 'set-entity', value: entity }] }));

    const preview = await runCli(['diff', path, '--batch', batchPath]);
    expect(preview.exitCode).toBe(0);
    expect(preview.result).toMatchObject({ command: 'diff', changed: true, baseRevision: snapshot.revision, changes: expect.any(Array) });
    expect(preview.result).not.toHaveProperty('scene');
    expect(await readFile(path, 'utf8')).toBe(original);
    const edited = await runCli(['edit', path, '--batch', batchPath]);
    expect(edited.exitCode).toBe(0);
    expect(edited.result).toEqual({ ...preview.result, command: 'edit' });
    const saved = await readSceneFile(path);
    expect(saved.revision).toBe(edited.result.revision);
    expect(saved.scene.entities.find(({ id }) => id === entity.id)).toEqual(entity);
    const stale = await runCli(['edit', path, '--batch', batchPath]);
    expect(stale.exitCode).toBe(4);
    expect(stale.result).toMatchObject({ diagnostics: [{ code: 'SCENE_STALE' }] });
    expect((await readSceneFile(path)).revision).toBe(saved.revision);

    await writeFile(batchPath, JSON.stringify({ format: 'strata.scene-edit', version: 1, expectedRevision: saved.revision, operations: [{ op: 'set-entity', value: entity }] }));
    const repeated = await runCli(['edit', path, '--batch', batchPath]);
    expect(repeated.exitCode).toBe(0);
    expect(repeated.result).toMatchObject({ changed: false, revision: saved.revision, changes: [] });
  });

  it('leaves the document intact after an invalid batch and reports the source file', async () => {
    const root = await directory();
    const path = join(root, 'scene.json');
    const batchPath = join(root, 'invalid.json');
    await runCli(['create', path, '--id', 'scene']);
    const original = await readFile(path, 'utf8');
    await writeFile(batchPath, '{');
    const malformed = await runCli(['edit', path, '--batch', batchPath]);
    expect(malformed.exitCode).toBe(3);
    expect(malformed.result).toMatchObject({ diagnostics: [{ code: 'INVALID_JSON', source: batchPath }] });
    expect(await readFile(path, 'utf8')).toBe(original);
    await writeFile(batchPath, JSON.stringify({ format: 'strata.scene-edit', version: 99, operations: [] }));
    expect((await runCli(['edit', path, '--batch', batchPath])).exitCode).toBe(3);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await runCli(['validate', path])).result).toMatchObject({ ok: true, assets: null });
    expect((await runCli(['validate', path, '--assets'])).result).toMatchObject({ ok: true, assets: { checked: 0 } });
  });

  it('separates filesystem failures from invalid documents', async () => {
    const root = await directory();
    const absent = join(root, 'absent.json');
    const missing = await runCli(['validate', absent]);
    expect(missing.exitCode).toBe(5);
    expect(missing.result).toMatchObject({ diagnostics: [{ code: 'IO_ERROR' }] });
    expect((await runCli(['edit', absent, '--batch', absent])).exitCode).toBe(5);
    await writeFile(absent, '{');
    const invalid = await runCli(['validate', absent]);
    expect(invalid.exitCode).toBe(3);
    expect(invalid.result).toMatchObject({ diagnostics: [{ code: 'INVALID_JSON', source: await realpath(absent) }] });
    expect((await runCli(['create', join(root, 'invalid-id.json'), '--id', 'Invalid ID'])).exitCode).toBe(3);
  });

  it('rejects oversized and nonregular batch input without changing the scene', async () => {
    const root = await directory();
    const path = join(root, 'scene.json');
    const batchPath = join(root, 'oversized.json');
    await runCli(['create', path, '--id', 'scene']);
    const original = await readFile(path, 'utf8');
    await writeFile(batchPath, '');
    await truncate(batchPath, 16 * 1024 * 1024 + 1);
    const oversized = await runCli(['edit', path, '--batch', batchPath]);
    expect(oversized.exitCode).toBe(3);
    expect(oversized.result).toMatchObject({ diagnostics: [{ code: 'FILE_TOO_LARGE', source: batchPath }] });
    expect((await runCli(['edit', path, '--batch', root])).exitCode).toBe(5);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('checks external references only when requested and accepts explicit and environment asset roots', async () => {
    vi.stubEnv('STRATA_BENCHMARK_ASSET_DIR', undefined);
    const root = await directory();
    const externalRoot = await directory();
    const path = join(root, 'references.json');
    await runCli(['create', path, '--id', 'references']);
    const snapshot = await readSceneFile(path);
    await writeFile(path, serializeScene({ ...snapshot.scene, assets: [{ id: 'external-mesh', kind: 'external', uri: 'tiny.gltf', mediaType: 'model/gltf+json' }] }));
    expect((await runCli(['validate', path])).result).toMatchObject({ ok: true, assets: null });
    const missing = await runCli(['validate', path, '--assets']);
    expect(missing.exitCode).toBe(3);
    expect(missing.result).toMatchObject({ diagnostics: [{ assetId: 'external-mesh', message: expect.any(String), suggestion: expect.any(String) }] });
    await writeFile(join(externalRoot, 'tiny.gltf'), '{}');
    const explicit = await runCli(['validate', path, '--assets', '--asset-root', externalRoot]);
    expect(explicit.exitCode).toBe(0);
    expect(explicit.result).toMatchObject({ assets: { checked: 1 } });
    vi.stubEnv('STRATA_BENCHMARK_ASSET_DIR', externalRoot);
    expect((await runCli(['validate', path, '--assets'])).result).toMatchObject({ ok: true, assets: { checked: 1 } });
    vi.stubEnv('STRATA_BENCHMARK_ASSET_DIR', undefined);
    await writeFile(join(root, 'tiny.gltf'), '{}');
    expect((await runCli(['validate', path, '--assets'])).result).toMatchObject({ ok: true, assets: { checked: 1 } });
  });
});
