import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { canonicalJson, parseScene, serializeScene } from '@strata-engine/authoring';
import { buildProject, initProject, inspectProject, validateProject, type ProjectBuildOptions } from '../src/project.js';
import * as output from '../src/project-output.js';

let directory: string;
beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'strata-project-build-'))); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => `${canonicalJson(value)}\n`;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
};

// These files exercise delivery and identity checks only. They are deliberately
// not a renderer, a compiled client implementation, or browser acceptance.
async function distributionFixture() {
  const packageRoot = join(directory, 'generated-core');
  await mkdir(join(packageRoot, 'dist/nested'), { recursive: true });
  const files = {
    'index.js': 'export const cpuDistributionFixture = true;\n',
    'worker.js': '// Generated CPU worker asset fixture.\n',
    'strata_runtime.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    'nested/auxiliary.js': 'export const auxiliary = 1;\n',
    'index.d.ts': 'export declare const cpuDistributionFixture: true;\n',
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(packageRoot, 'dist', name), bytes);
  const packagePath = join(packageRoot, 'package.json');
  await writeFile(packagePath, json({ name: '@strata-engine/core', version: '0.0.0' }));
  const clientPath = join(directory, 'generated-project-client.js');
  await writeFile(clientPath, "import * as Core from '@strata-engine/core';\n// CPU fixture only; no browser readiness or frame result.\nvoid Core;\n");
  return { packageRoot, packagePath, files, clientPath };
}
async function useGeneratedDistribution() {
  const fixture = await distributionFixture();
  const snapshot = output.snapshotRuntimeDistribution, client = output.readProjectClient;
  vi.spyOn(output, 'snapshotRuntimeDistribution').mockImplementation((_path, version, signal) => snapshot(fixture.packagePath, version, signal));
  vi.spyOn(output, 'readProjectClient').mockImplementation((_path, signal) => client(fixture.clientPath, signal));
  return fixture;
}
async function buildOptions(): Promise<ProjectBuildOptions> {
  const project = await initProject({ directory: join(directory, 'project'), id: 'saved-demo', name: 'Saved demo' });
  return { projectPath: project.projectPath, expectedInputRevision: project.identity.inputRevision, outputDirectory: join(directory, 'delivery') };
}

describe('saved project initialization and inspection', () => {
  test('publishes a new versioned project using real authoring and Core validation', async () => {
    const result = await initProject({ directory: join(directory, 'new-project'), id: 'sample-project' });
    expect(result).toMatchObject({ publicationOccurred: true, sceneId: 'sample-project',
      project: { format: 'strata.project', version: 1, id: 'sample-project', name: 'sample-project', scene: 'scene.json', view: 'view.json', width: 512, height: 512 },
      counts: { assets: 1, materials: 1, entities: 1 }, capabilities: { profile: 'opaque-root-boxes', cooking: false, externalAssets: false } });
    expect(await readdir(result.projectRoot)).toEqual(['project.json', 'scene.json', 'view.json']);
    expect(result.projectPath).toBe(join(result.projectRoot, 'project.json'));
    const inspected = await inspectProject({ projectPath: result.projectPath });
    expect(inspected.identity).toEqual(result.identity);
    expect(await validateProject({ projectPath: result.projectPath, checkAssets: true })).toEqual(inspected);
    expect(result.identity.projectSha256).toBe(hash(await readFile(result.projectPath)));
    const parsed = parseScene(await readFile(join(result.projectRoot, 'scene.json'), 'utf8'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.entities[0]?.id).toBe('box-1');
    (result.view.camera.position as unknown as number[])[0] = 50;
    expect((await inspectProject({ projectPath: result.projectPath })).view.camera.position[0]).toBe(0);
  });

  test('snapshots init options before asynchronous I/O', async () => {
    const options = { directory: join(directory, 'initial'), id: 'first-name', name: 'First name' };
    const pending = initProject(options);
    options.directory = join(directory, 'mutated'); options.id = 'second-name'; options.name = 'Second name';
    const result = await pending;
    expect(result.projectRoot).toBe(join(directory, 'initial'));
    expect(result.project.id).toBe('first-name'); expect(result.project.name).toBe('First name');
    await expect(readFile(join(directory, 'mutated/project.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('validates options before creating directories and does not execute accessors', async () => {
    let invoked = false;
    await expect(initProject({ directory: join(directory, 'bad'), get id() { invoked = true; return 'sample'; } })).rejects.toMatchObject({ code: 'PROJECT_INVALID_OPTIONS' });
    expect(invoked).toBe(false);
    await expect(initProject({ directory: join(directory, 'bad'), id: 'Invalid_ID' })).rejects.toMatchObject({ code: 'PROJECT_DOCUMENT_INVALID' });
    await expect(initProject({ directory: join(directory, 'bad'), id: 'sample', name: null } as never)).rejects.toMatchObject({ code: 'PROJECT_INVALID_OPTIONS' });
    expect(await readdir(directory)).toEqual([]);
  });

  test('preserves existing directories and permits only one concurrent initializer', async () => {
    const destination = join(directory, 'project');
    const outcomes = await Promise.allSettled([initProject({ directory: destination, id: 'sample' }), initProject({ directory: destination, id: 'sample' })]);
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(item => item.status === 'rejected')).toMatchObject({ reason: { code: 'PROJECT_OUTPUT_EXISTS', details: { publicationOccurred: false, incompleteArtifacts: [] } } });
    const bytes = await readFile(join(destination, 'scene.json'));
    await expect(initProject({ directory: destination, id: 'different' })).rejects.toMatchObject({ code: 'PROJECT_OUTPUT_EXISTS' });
    expect(await readFile(join(destination, 'scene.json'))).toEqual(bytes);
  });

  test('distinguishes exact file identity from canonical scene revision', async () => {
    const project = await initProject({ directory: join(directory, 'project'), id: 'sample' });
    await writeFile(join(project.projectRoot, 'scene.json'), `${await readFile(join(project.projectRoot, 'scene.json'), 'utf8')}\n`);
    const changed = await inspectProject({ projectPath: project.projectPath });
    expect(changed.identity.sourceRevision).toBe(project.identity.sourceRevision);
    expect(changed.identity.inputRevision).not.toBe(project.identity.inputRevision);
  });

  test('retains authoring asset diagnostics and rejects external assets from the renderer profile', async () => {
    const project = await initProject({ directory: join(directory, 'project'), id: 'sample' });
    const scenePath = join(project.projectRoot, 'scene.json');
    const parsed = parseScene(await readFile(scenePath, 'utf8'));
    if (!parsed.ok) throw new Error('Generated authoring fixture must parse');
    parsed.value.assets = [{ id: 'unit-box', kind: 'external', uri: 'missing.glb', mediaType: 'model/gltf-binary' }];
    await writeFile(scenePath, serializeScene(parsed.value));
    await expect(validateProject({ projectPath: project.projectPath, checkAssets: true })).rejects.toMatchObject({ code: 'PROJECT_ASSET_INVALID', details: { diagnostics: expect.any(Array) } });
    await expect(inspectProject({ projectPath: project.projectPath })).rejects.toMatchObject({ code: 'PROJECT_PREVIEW_UNSUPPORTED', details: { previewCode: 'PREVIEW_UNSUPPORTED_ASSET' } });
  });

  test('attributes runtime scene, view and viewport diagnostics to their actual saved input', async () => {
    const project = await initProject({ directory: join(directory, 'project'), id: 'sample' });
    const scenePath = join(project.projectRoot, 'scene.json'), viewPath = join(project.projectRoot, 'view.json');
    const sceneBytes = await readFile(scenePath, 'utf8');
    const scene = parseScene(sceneBytes);
    if (!scene.ok) throw new Error('Generated scene must parse');
    scene.value.entities[0]!.transform.scale = [2000, 1, 1];
    await writeFile(scenePath, serializeScene(scene.value));
    await expect(inspectProject({ projectPath: project.projectPath })).rejects.toMatchObject({ code: 'PROJECT_PREVIEW_UNSUPPORTED',
      details: { source: scenePath, sceneSource: scenePath, viewSource: viewPath,
        diagnostics: [expect.objectContaining({ source: scenePath, path: '/boxes/0/dimensions/0' })] } });
    await writeFile(scenePath, sceneBytes);
    const viewBytes = await readFile(viewPath, 'utf8'), view = JSON.parse(viewBytes);
    view.camera.projection.near = -1;
    await writeFile(viewPath, json(view));
    await expect(inspectProject({ projectPath: project.projectPath })).rejects.toMatchObject({ code: 'PROJECT_PREVIEW_UNSUPPORTED',
      details: { source: viewPath, diagnostics: [expect.objectContaining({ source: viewPath })] } });
    await writeFile(viewPath, viewBytes);
    const document = JSON.parse(await readFile(project.projectPath, 'utf8'));
    document.width = 16384; document.height = 1;
    await writeFile(project.projectPath, json(document));
    await expect(validateProject({ projectPath: project.projectPath })).rejects.toMatchObject({ code: 'PROJECT_PREVIEW_UNSUPPORTED',
      details: { source: project.projectPath, diagnostics: [expect.objectContaining({ source: project.projectPath })] } });
  });
});

describe('CPU-only project delivery', () => {
  test('resolves relative input and output paths before packaging awaits', async () => {
    const fixture = await useGeneratedDistribution(), options = await buildOptions();
    const other = join(directory, 'different-cwd'); await mkdir(other);
    let current = directory;
    vi.spyOn(process, 'cwd').mockImplementation(() => current);
    vi.mocked(output.readProjectClient).mockImplementation(async () => {
      current = other; return readFile(fixture.clientPath);
    });
    const result = await buildProject({ ...options, projectPath: relative(directory, options.projectPath), outputDirectory: 'delivery' });
    expect(result.outputDirectory).toBe(join(directory, 'delivery'));
    expect(result.receiptPath).toBe(join(directory, 'delivery/build-receipt.json'));
    await expect(readdir(join(other, 'delivery'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('copies the complete generated runtime distribution and publishes the canonical completion receipt last', async () => {
    const fixture = await useGeneratedDistribution(), options = await buildOptions();
    const publish = output.publishProjectDirectory;
    let observedPublication = false;
    vi.spyOn(output, 'publishProjectDirectory').mockImplementation(settings => publish(settings, {
      publishCompletion: async (temporary, destination) => {
        await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
        const staged = JSON.parse(await readFile(temporary, 'utf8'));
        for (const file of staged.files) expect(hash(await readFile(join(options.outputDirectory, file.path)))).toBe(file.sha256);
        observedPublication = true;
        await link(temporary, destination);
      },
    }));
    const result = await buildProject(options);
    expect(observedPublication).toBe(true);
    expect(result).toMatchObject({ publicationOccurred: true, outputDirectory: options.outputDirectory,
      receipt: { format: 'strata.project.build', version: 1, projectId: 'saved-demo', runtime: { package: '@strata-engine/core', version: '0.0.0' } } });
    expect(await readFile(result.receiptPath, 'utf8')).toBe(json(result.receipt));
    expect(result.receipt.runtime.files.map(file => file.path).sort()).toEqual(Object.keys(fixture.files).sort());
    for (const file of result.receipt.files) {
      const bytes = await readFile(join(result.outputDirectory, file.path));
      expect(file.bytes).toBe(bytes.length); expect(file.sha256).toBe(hash(bytes));
    }
    const deployed = JSON.parse(await readFile(join(result.outputDirectory, 'project-runtime.json'), 'utf8'));
    expect(deployed).toMatchObject({ format: 'strata.project.runtime', version: 1, projectId: 'saved-demo', identity: result.receipt.identity });
    expect(deployed.scene.format).not.toBe('strata.scene');
    expect(deployed).not.toHaveProperty('frame'); expect(result.receipt).not.toHaveProperty('frameId');
    const html = await readFile(join(result.outputDirectory, 'index.html'), 'utf8');
    expect(html).toContain('"@strata-engine/core":"./runtime/index.js"');
    for (const id of ['project-canvas', 'project-status', 'project-error']) expect(html).toContain(`id="${id}"`);
    expect(await readdir(result.outputDirectory)).toEqual(['app.js', 'build-receipt.json', 'index.html', 'project-runtime.json', 'runtime']);
    expect(await readFile(join(result.outputDirectory, 'app.js'))).toEqual(await readFile(fixture.clientPath));
    const original = result.receipt.identity.inputRevision;
    result.receipt.identity.inputRevision = 'mutated';
    expect(JSON.parse(await readFile(result.receiptPath, 'utf8')).identity.inputRevision).toBe(original);
  });

  test('rejects a stale or absent revision before resolving runtime distribution or touching output', async () => {
    const options = await buildOptions();
    const snapshot = vi.spyOn(output, 'snapshotRuntimeDistribution');
    await expect(buildProject({ ...options, expectedInputRevision: `sha256:${'0'.repeat(64)}` })).rejects.toMatchObject({ code: 'PROJECT_INPUT_STALE', details: { publicationOccurred: false } });
    await expect(buildProject({ ...options, expectedInputRevision: undefined } as never)).rejects.toMatchObject({ code: 'PROJECT_INVALID_OPTIONS' });
    expect(snapshot).not.toHaveBeenCalled();
    await expect(readdir(options.outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects a missing compiled browser client instead of publishing an incomplete delivery', async () => {
    const fixture = await distributionFixture(), options = await buildOptions();
    const snapshot = output.snapshotRuntimeDistribution, readClient = output.readProjectClient;
    vi.spyOn(output, 'snapshotRuntimeDistribution').mockImplementation((_path, version, signal) => snapshot(fixture.packagePath, version, signal));
    vi.spyOn(output, 'readProjectClient').mockImplementation((_path, signal) => readClient(join(directory, 'not-built-client.js'), signal));
    await expect(buildProject(options)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_DISTRIBUTION_INVALID', stage: 'snapshot-client' });
    await expect(readdir(options.outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('detects source changes during packaging, removes only its incomplete output, and retains previous builds', async () => {
    const fixture = await useGeneratedDistribution(), options = await buildOptions();
    const previous = await buildProject({ ...options, outputDirectory: join(directory, 'previous') });
    const previousBytes = await readFile(previous.receiptPath);
    const readClient = output.readProjectClient;
    vi.mocked(readClient).mockImplementationOnce(async () => {
      const scenePath = join(directory, 'project/scene.json');
      await writeFile(scenePath, `${await readFile(scenePath, 'utf8')}\n`);
      return readFile(fixture.clientPath);
    });
    await expect(buildProject(options)).rejects.toMatchObject({ code: 'PROJECT_INPUT_CHANGED', details: { publicationOccurred: false, incompleteArtifacts: [] } });
    await expect(readdir(options.outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(previous.receiptPath)).toEqual(previousBytes);
  });

  test('rejects an occupied output without deleting user files', async () => {
    await useGeneratedDistribution(); const options = await buildOptions();
    await mkdir(options.outputDirectory); await writeFile(join(options.outputDirectory, 'keep.txt'), 'keep');
    await expect(buildProject(options)).rejects.toMatchObject({ code: 'PROJECT_OUTPUT_EXISTS', details: { publicationOccurred: false, incompleteArtifacts: [] } });
    expect(await readFile(join(options.outputDirectory, 'keep.txt'), 'utf8')).toBe('keep');
  });
});

describe('project publication cancellation and failures', () => {
  test('a pre-aborted initializer creates nothing', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(initProject({ directory: join(directory, 'project'), id: 'sample', signal: controller.signal })).rejects.toMatchObject({ code: 'PROJECT_ABORTED', details: { publicationOccurred: false } });
    expect(await readdir(directory)).toEqual([]);
  });

  test('abort during held file sync waits for close and owned cleanup before public rejection', async () => {
    const entered = deferred(), release = deferred(), controller = new AbortController();
    const publish = output.publishProjectDirectory;
    let closed = false, settled = false;
    vi.spyOn(output, 'publishProjectDirectory').mockImplementation(settings => publish(settings, {
      openFile: async path => {
        const handle = await open(path, 'wx', 0o600);
        return { writeFile: bytes => handle.writeFile(bytes), sync: async () => { entered.resolve(); await release.promise; await handle.sync(); },
          close: async () => { await handle.close(); closed = true; } };
      },
    }));
    const pending = initProject({ directory: join(directory, 'project'), id: 'sample', signal: controller.signal });
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    void outcome.then(() => { settled = true; });
    await entered.promise; controller.abort(); await Promise.resolve();
    expect(settled).toBe(false); expect(closed).toBe(false);
    release.resolve();
    expect(await outcome).toMatchObject({ error: { code: 'PROJECT_ABORTED', details: { publicationOccurred: false, incompleteArtifacts: [] } } });
    expect(closed).toBe(true); expect(await readdir(directory)).toEqual([]);
  });

  test('a completion collision retains the unowned manifest and reports cleanup uncertainty', async () => {
    const publish = output.publishProjectDirectory;
    vi.spyOn(output, 'publishProjectDirectory').mockImplementation(settings => publish(settings, {
      publishCompletion: async (temporary, destination) => { await writeFile(destination, 'unowned', { flag: 'wx' }); await link(temporary, destination); },
    }));
    await expect(initProject({ directory: join(directory, 'project'), id: 'sample' })).rejects.toMatchObject({ code: 'PROJECT_OUTPUT_EXISTS',
      details: { publicationOccurred: false, incompleteArtifacts: [join(directory, 'project')], cleanupErrors: expect.any(Array) } });
    expect(await readdir(join(directory, 'project'))).toEqual(['project.json']);
    expect(await readFile(join(directory, 'project/project.json'), 'utf8')).toBe('unowned');
  });

  test('known completion publication wins cancellation arriving during the link operation', async () => {
    const entered = deferred(), release = deferred(), controller = new AbortController();
    const publish = output.publishProjectDirectory;
    vi.spyOn(output, 'publishProjectDirectory').mockImplementation(settings => publish(settings, {
      publishCompletion: async (temporary, destination) => { entered.resolve(); await release.promise; await link(temporary, destination); },
    }));
    const pending = initProject({ directory: join(directory, 'project'), id: 'sample', signal: controller.signal });
    await entered.promise; controller.abort(); release.resolve();
    const result = await pending;
    expect(result.publicationOccurred).toBe(true);
    expect((await inspectProject({ projectPath: result.projectPath })).identity).toEqual(result.identity);
  });

  test('late temporary-file cleanup failure preserves published build files and reports warnings', async () => {
    await useGeneratedDistribution(); const options = await buildOptions();
    const publish = output.publishProjectDirectory;
    vi.spyOn(output, 'publishProjectDirectory').mockImplementation(settings => publish(settings, {
      removeFile: async () => { throw new Error('injected temporary unlink failure'); },
    }));
    const result = await buildProject(options);
    expect(result.publicationOccurred).toBe(true); expect(result.cleanupWarnings).toHaveLength(1);
    expect(JSON.parse(await readFile(result.receiptPath, 'utf8'))).toEqual(result.receipt);
    expect(await readFile(join(result.outputDirectory, 'project-runtime.json'), 'utf8')).toContain('strata.project.runtime');
  });
});

describe('private installed distribution checks', () => {
  test('requires matching Core package version, precompiled WASM, and ordinary files', async () => {
    const fixture = await distributionFixture();
    await expect(output.snapshotRuntimeDistribution(fixture.packagePath, '0.1.0')).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_DISTRIBUTION_INVALID' });
    await writeFile(join(fixture.packageRoot, 'dist/strata_runtime.wasm'), 'not wasm');
    await expect(output.snapshotRuntimeDistribution(fixture.packagePath, '0.0.0')).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_DISTRIBUTION_INVALID' });
    await writeFile(join(fixture.packageRoot, 'dist/strata_runtime.wasm'), fixture.files['strata_runtime.wasm']);
    await symlink(fixture.clientPath, join(fixture.packageRoot, 'dist/redirect.js'));
    await expect(output.snapshotRuntimeDistribution(fixture.packagePath, '0.0.0')).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_DISTRIBUTION_INVALID' });
  });

  test('bounds file reads and rejects client imports across the Core-only boundary', async () => {
    const fixture = await distributionFixture();
    await expect(output.readProjectFile(fixture.clientPath, 4)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_DISTRIBUTION_INVALID' });
    await writeFile(fixture.clientPath, "import fs from 'node:fs';\n");
    await expect(output.readProjectClient(fixture.clientPath)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_DISTRIBUTION_INVALID' });
    await writeFile(fixture.clientPath, "import * as Core from '@strata-engine/core';\nawait import('playwright');\n");
    await expect(output.readProjectClient(fixture.clientPath)).rejects.toMatchObject({ code: 'PROJECT_RUNTIME_DISTRIBUTION_INVALID' });
  });
});
