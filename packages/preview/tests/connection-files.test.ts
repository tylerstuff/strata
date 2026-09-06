import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as authoring from '@strata-engine/authoring';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createConnectionRoots } from '../src/connection-files.js';

let temporary: string;
let project: string;
let output: string;
let file: string;
const scene = authoring.createProceduralScene('connection-fixture');
const text = authoring.serializeScene(scene);

beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'strata-connection-files-')));
  project = join(temporary, 'project'); output = join(temporary, 'output');
  await mkdir(project); await mkdir(output); await mkdir(join(project, 'scenes'));
  file = join(project, 'scenes', 'scene.json');
  await writeFile(file, text);
});

afterEach(async () => { vi.restoreAllMocks(); await rm(temporary, { recursive: true, force: true }); });

describe('connection files: CPU-only fixed-root reads', () => {
  test('reads the authoring snapshot and canonical revision without modifying source bytes', async () => {
    const roots = await createConnectionRoots(project, output);
    const result = await roots.readScene('scenes/scene.json');
    expect(result).toEqual({ scene, revision: authoring.sceneRevision(scene) });
    expect(await readFile(file, 'utf8')).toBe(text);
    expect(roots.projectRoot).toBe(project); expect(roots.outputRoot).toBe(output);
    expect(Object.isFrozen(roots)).toBe(true);
    await roots.verifyOutput();
  });

  test('resolves explicitly selected startup aliases once', async () => {
    const alias = join(temporary, 'project-alias'); await symlink(project, alias, 'dir');
    const roots = await createConnectionRoots(alias, output);
    expect(roots.projectRoot).toBe(project);
    expect((await roots.readScene('scenes/scene.json')).revision).toBe(authoring.sceneRevision(scene));
  });

  test.each(['', '../scene.json', 'scenes/../scene.json', '/scene.json', 'C:/scene.json', 'file:scene.json', 'https://example.test/scene.json', 'scenes\\scene.json', 'scene\u0000.json', 'scene\n.json', 'scene\u007f.json', 'scene\u0085.json', '.', '界'.repeat(1366)])('rejects unsafe relative input %j', async path => {
    const roots = await createConnectionRoots(project, output);
    await expect(roots.readScene(path)).rejects.toMatchObject({ code: 'CONNECTION_SCENE_PATH' });
  });

  test('rejects symlink leaves and parents even when their target is inside the project', async () => {
    await symlink(file, join(project, 'leaf.json'));
    await symlink(join(project, 'scenes'), join(project, 'alias'), 'dir');
    const roots = await createConnectionRoots(project, output);
    for (const path of ['leaf.json', 'alias/scene.json']) {
      await expect(roots.readScene(path)).rejects.toMatchObject({ code: 'CONNECTION_SCENE_PATH' });
    }
  });

  test('rejects a symlink to an outside directory with a root-prefix-like name', async () => {
    const outside = join(temporary, 'project-outside'); await mkdir(outside); await writeFile(join(outside, 'scene.json'), text);
    await symlink(outside, join(project, 'outside'), 'dir');
    const roots = await createConnectionRoots(project, output);
    await expect(roots.readScene('outside/scene.json')).rejects.toMatchObject({ code: 'CONNECTION_SCENE_PATH' });
  });

  test.each(['project', 'output'] as const)('rejects replacement of the fixed %s root before I/O', async kind => {
    const roots = await createConnectionRoots(project, output), path = kind === 'project' ? project : output;
    await rename(path, path + '-original'); await mkdir(path);
    await expect(roots.verifyOutput()).rejects.toMatchObject({ code: 'CONNECTION_ROOT_CHANGED', details: { root: kind, source: path } });
    await expect(roots.readScene('scenes/scene.json')).rejects.toMatchObject({ code: 'CONNECTION_ROOT_CHANGED' });
  });

  test('rejects redirecting a fixed output root back to its original inode through a symlink', async () => {
    const roots = await createConnectionRoots(project, output);
    await rename(output, output + '-original'); await symlink(output + '-original', output, 'dir');
    await expect(roots.verifyOutput()).rejects.toMatchObject({ code: 'CONNECTION_ROOT_CHANGED' });
  });

  test('requires existing directories without creating roots', async () => {
    await expect(createConnectionRoots(join(temporary, 'missing'), output)).rejects.toMatchObject({ code: 'CONNECTION_ROOT_INVALID', details: { root: 'project' } });
    await expect(createConnectionRoots(project, file)).rejects.toMatchObject({ code: 'CONNECTION_ROOT_INVALID', details: { root: 'output' } });
    await expect(createConnectionRoots('', output)).rejects.toMatchObject({ code: 'CONNECTION_ROOT_INVALID' });
  });

  test('retains authoring diagnostics and canonical source for malformed JSON and schema', async () => {
    const roots = await createConnectionRoots(project, output);
    for (const invalid of ['{', JSON.stringify({ ...scene, version: 999 })]) {
      await writeFile(file, invalid);
      const error = await roots.readScene('scenes/scene.json').catch(error => error);
      expect(error).toMatchObject({ code: 'CONNECTION_SCENE_INPUT', stage: 'read-scene', details: { source: file } });
      expect(error.details.diagnostics.length).toBeGreaterThan(0);
      expect(error.details.diagnostics[0]).toMatchObject({ source: file, code: expect.any(String), path: expect.any(String) });
    }
  });

  test('delegates regular single-link, fatal UTF-8 and byte bounds to authoring', async () => {
    const roots = await createConnectionRoots(project, output);
    await link(file, join(project, 'hard-link.json'));
    await expect(roots.readScene('scenes/scene.json')).rejects.toMatchObject({ code: 'CONNECTION_SCENE_INPUT', details: { diagnostics: [expect.objectContaining({ code: 'IO_ERROR' })] } });
    await rm(join(project, 'hard-link.json')); await writeFile(file, Buffer.from([0xff]));
    await expect(roots.readScene('scenes/scene.json')).rejects.toMatchObject({ details: { diagnostics: [expect.objectContaining({ code: 'INVALID_UTF8' })] } });
    await truncate(file, authoring.MAX_SCENE_FILE_BYTES + 1);
    await expect(roots.readScene('scenes/scene.json')).rejects.toMatchObject({ details: { diagnostics: [expect.objectContaining({ code: 'FILE_TOO_LARGE' })] } });
    await expect(roots.readScene('scenes')).rejects.toMatchObject({ code: 'CONNECTION_SCENE_INPUT' });
    await expect(roots.readScene('missing.json')).rejects.toMatchObject({ code: 'CONNECTION_SCENE_INPUT', details: { source: join(project, 'missing.json') } });
  });

  test('checks abort before reading and after the delegated read settles', async () => {
    const roots = await createConnectionRoots(project, output);
    const already = new AbortController(); already.abort();
    await expect(roots.readScene('scenes/scene.json', already.signal)).rejects.toMatchObject({ code: 'PREVIEW_ABORTED' });
    const controller = new AbortController(), actualRead = authoring.readSceneFile;
    vi.spyOn(authoring, 'readSceneFile').mockImplementationOnce(async path => {
      const result = await actualRead(path); controller.abort(); return result;
    });
    await expect(roots.readScene('scenes/scene.json', controller.signal)).rejects.toMatchObject({ code: 'PREVIEW_ABORTED' });
  });

  test('detects root replacement during a delegated read before returning its snapshot', async () => {
    const roots = await createConnectionRoots(project, output), actualRead = authoring.readSceneFile;
    vi.spyOn(authoring, 'readSceneFile').mockImplementationOnce(async path => {
      const result = await actualRead(path); await rename(output, output + '-original'); await mkdir(output); return result;
    });
    await expect(roots.readScene('scenes/scene.json')).rejects.toMatchObject({ code: 'CONNECTION_ROOT_CHANGED', details: { root: 'output' } });
  });

  test('rejects replacement of the checked scene leaf during a delegated read', async () => {
    const roots = await createConnectionRoots(project, output), actualRead = authoring.readSceneFile;
    vi.spyOn(authoring, 'readSceneFile').mockImplementationOnce(async path => {
      const result = await actualRead(path); await rename(file, file + '.previous'); await writeFile(file, text); return result;
    });
    await expect(roots.readScene('scenes/scene.json')).rejects.toMatchObject({ code: 'CONNECTION_SCENE_INPUT', details: { source: file } });
  });
});
