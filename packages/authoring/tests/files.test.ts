import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthoringError, createProceduralScene, createSceneFile, editSceneFile, previewSceneFile,
  readSceneFile, sceneRevision, validateSceneAssets, type SceneBatch, type SceneDocument,
} from '../src/index.js';

let directory: string;
let path: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'strata-authoring-files-')); path = join(directory, 'scene.json'); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function move(scene: SceneDocument, x: number): SceneBatch {
  const entity = structuredClone(scene.entities[0]!);
  entity.transform.position[0] = x;
  return { format: 'strata.scene-edit', version: 1, expectedRevision: sceneRevision(scene), operations: [{ op: 'set-entity', value: entity }] };
}

describe('scene file transactions', () => {
  it('creates exclusively, previews without writing, atomically commits and preserves exact bytes on stale/invalid writes', async () => {
    const initial = await createSceneFile(path, createProceduralScene());
    const original = await readFile(path, 'utf8');
    await expect(createSceneFile(path, createProceduralScene('other'))).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: 'FILE_EXISTS' })] });
    const edit = move(initial.scene, 12.125);
    const preview = await previewSceneFile(path, edit);
    expect(preview.changed).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(original);
    const applied = await editSceneFile(path, edit);
    expect(applied).toEqual(preview);
    const next = await readFile(path, 'utf8');
    await expect(editSceneFile(path, edit)).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: 'SCENE_STALE' })] });
    expect(await readFile(path, 'utf8')).toBe(next);
    const bad: SceneBatch = { ...move(applied.scene, 15), operations: [{ op: 'remove-material', id: 'warm-stone' }] };
    await expect(editSceneFile(path, bad)).rejects.toBeInstanceOf(AuthoringError);
    expect(await readFile(path, 'utf8')).toBe(next);
    expect(await readdir(directory)).toEqual(['scene.json']);
    expect((await readSceneFile(path)).scene.entities[0]!.transform.position[0]).toBe(12.125);
  });

  it('keeps manually formatted bytes on an idempotent set', async () => {
    const scene = createProceduralScene();
    const manual = JSON.stringify(scene);
    await writeFile(path, manual);
    const result = await editSceneFile(path, move(scene, 0));
    expect(result.changed).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(manual);
  });

  it('preserves an existing scene permission mode under a restrictive writer umask', async () => {
    const { scene } = await createSceneFile(path, createProceduralScene());
    await chmod(path, 0o660);
    const previous = process.umask(0o077);
    try {
      await editSceneFile(path, move(scene, 5));
      expect((await stat(path)).mode & 0o777).toBe(0o660);
      const createdPath = join(directory, 'new.json');
      await createSceneFile(createdPath, createProceduralScene('new-scene'));
      expect((await stat(createdPath)).mode & 0o777).toBe(0o600);
    } finally { process.umask(previous); }
  });

  it('rejects invalid UTF-8 without replacing bytes or leaving a lock, and preserves valid multibyte names', async () => {
    const scene = createProceduralScene('unicode-scene', 'Valid 日本語 🏡');
    await createSceneFile(path, scene);
    expect((await readSceneFile(path)).scene.name).toBe(scene.name);
    const invalid = Buffer.from(JSON.stringify({ ...scene, name: 'invalid-byte' }));
    invalid[invalid.indexOf('invalid-byte')] = 0xff;
    await writeFile(path, invalid);
    await expect(readSceneFile(path)).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: 'INVALID_UTF8' })] });
    await expect(editSceneFile(path, move(scene, 8))).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: 'INVALID_UTF8' })] });
    expect(await readFile(path)).toEqual(invalid);
    expect(await readdir(directory)).toEqual(['scene.json']);
  });

  it('allows exactly one concurrent writer from the same revision', async () => {
    const { scene } = await createSceneFile(path, createProceduralScene());
    const outcomes = await Promise.allSettled([editSceneFile(path, move(scene, 1)), editSceneFile(path, move(scene, 2))]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult;
    expect(['FILE_BUSY', 'SCENE_STALE']).toContain(rejected.reason.diagnostics[0].code);
    const loaded = await readSceneFile(path);
    expect([1, 2]).toContain(loaded.scene.entities[0]!.transform.position[0]);
    expect(await readdir(directory)).toEqual(['scene.json']);
  });

  it('does not steal an existing lock and rejects leaf symlinks without changing the target', async () => {
    const { scene } = await createSceneFile(path, createProceduralScene());
    const lockPath = `${path}.strata-lock`;
    await writeFile(lockPath, '{"pid":42}');
    await expect(editSceneFile(path, move(scene, 10))).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: 'FILE_BUSY' })] });
    expect(await readFile(lockPath, 'utf8')).toBe('{"pid":42}');
    await rm(lockPath);
    const alias = join(directory, 'alias.json');
    await symlink(path, alias);
    await expect(editSceneFile(alias, move(scene, 10))).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: 'IO_ERROR' })] });
    expect((await readSceneFile(path)).revision).toBe(sceneRevision(scene));
    expect(await readdir(directory)).toEqual(['alias.json', 'scene.json']);
  });
});

describe('external descriptor checks', () => {
  it('rejects malformed options through the shared diagnostic contract', async () => {
    for (const options of [undefined, null, {}, { scenePath: path, assetRoot: null }, new Date()]) {
      const result = await validateSceneAssets(createProceduralScene(), options as Parameters<typeof validateSceneAssets>[1]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics[0]!.code).toBe('INVALID_OPTIONS');
    }
  });

  it('checks only local files below the selected external root and preserves asset IDs in diagnostics', async () => {
    const scene = createProceduralScene();
    scene.assets.push({ id: 'external', kind: 'external', uri: 'tiny%20fixture.bin', mediaType: 'application/octet-stream' });
    let checked = await validateSceneAssets(scene, { scenePath: path, assetRoot: directory });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.diagnostics[0]).toMatchObject({ code: 'ASSET_MISSING', assetId: 'external', path: '/assets/1/uri' });
    await writeFile(join(directory, 'tiny fixture.bin'), 'procedural test bytes');
    checked = await validateSceneAssets(scene, { scenePath: path, assetRoot: directory });
    expect(checked).toEqual({ ok: true, value: { checked: 1 } });
    for (const [uri, expected] of [
      ['https://example.invalid/asset.glb', 'ASSET_URI_UNSUPPORTED'],
      ['/absolute/asset.glb', 'ASSET_URI_UNSUPPORTED'],
      ['../missing', 'ASSET_OUTSIDE_ROOT'],
      ['%2e%2e/missing', 'ASSET_OUTSIDE_ROOT'],
      ['tiny%ZZ.bin', 'ASSET_URI_UNSUPPORTED'],
    ]) {
      scene.assets[1] = { id: 'external', kind: 'external', uri: uri!, mediaType: 'application/octet-stream' };
      const result = await validateSceneAssets(scene, { scenePath: path, assetRoot: directory });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics[0]!.code).toBe(expected);
    }
  });
});
