import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJson, editSceneFile, readSceneFile } from '@strata-engine/authoring';
import { buildProject, inspectProject, validateProject } from '@strata-engine/preview/project';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function cli(args, status = 0) {
  const result = spawnSync(resolve('node_modules/.bin/strata-project'), args, {
    encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1, 'The installed CLI must report exactly one JSON object');
  return JSON.parse(result.stdout);
}

assert.equal(cli(['--help']).command, 'help');
const created = cli(['init', 'saved-project', '--id', 'packed-project']);
assert.equal(created.publicationOccurred, true);
const before = await inspectProject({ projectPath: created.projectPath });
assert.deepEqual(before.identity, created.identity);
const scenePath = join(before.projectRoot, before.project.scene);
const saved = await readSceneFile(scenePath);
const entity = structuredClone(saved.scene.entities[0]);
entity.transform.position[0] = 0.375;
const edited = await editSceneFile(scenePath, { format: 'strata.scene-edit', version: 1,
  expectedRevision: saved.revision, operations: [{ op: 'set-entity', value: entity }] });
const inspected = cli(['inspect', created.projectPath]);
assert.equal(inspected.identity.sourceRevision, edited.revision);
assert.notEqual(inspected.identity.inputRevision, before.identity.inputRevision);
assert.deepEqual((await validateProject({ projectPath: created.projectPath, checkAssets: true })).identity, inspected.identity);
const stale = cli(['build', created.projectPath, '--expected-input-revision', before.identity.inputRevision, '--out', 'stale-delivery'], 4);
assert.equal(stale.error.code, 'PROJECT_INPUT_STALE');
await assert.rejects(readdir('stale-delivery'), { code: 'ENOENT' });

const built = cli(['build', created.projectPath, '--expected-input-revision', inspected.identity.inputRevision, '--out', 'project-delivery']);
assert.equal(built.publicationOccurred, true);
assert.deepEqual(built.receipt.identity, inspected.identity);
assert.equal(await readFile(built.receiptPath, 'utf8'), `${canonicalJson(built.receipt)}\n`);
for (const file of built.receipt.files) {
  const bytes = await readFile(join(built.outputDirectory, file.path));
  assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
}
for (const file of built.receipt.runtime.files) {
  const installed = await readFile(join('node_modules/@strata-engine/core/dist', file.path));
  assert.equal(hash(installed), file.sha256);
}
const data = JSON.parse(await readFile(join(built.outputDirectory, 'project-runtime.json'), 'utf8'));
assert.equal(data.scene.boxes[0].transform.position[0], 0.375);
assert.equal(data.scene.sourceRevision, edited.revision);
assert.deepEqual(data.identity, inspected.identity);
assert.equal(Object.hasOwn(built.receipt, 'frame'), false, 'CPU packaging must not manufacture rendered-frame evidence');
const browserClient = await readFile(join(built.outputDirectory, 'app.js'), 'utf8');
assert.match(browserClient, /from ['"]@strata-engine\/core['"]/);
assert.doesNotMatch(browserClient, /(?:from|import\()\s*['"](?:node:|@strata-engine\/(?:preview|authoring))/);
assert.match(await readFile(join(built.outputDirectory, 'index.html'), 'utf8'), /"@strata-engine\/core":"\.\/runtime\/index.js"/);
const receiptBytes = await readFile(built.receiptPath);
await assert.rejects(buildProject({ projectPath: created.projectPath, expectedInputRevision: inspected.identity.inputRevision,
  outputDirectory: built.outputDirectory }), { code: 'PROJECT_OUTPUT_EXISTS' });
assert.deepEqual(await readFile(built.receiptPath), receiptBytes);
console.log('Saved project packed consumer: installed init/inspect/build CLI, shared authoring edit, stale-input rejection, exact complete Core files and exclusive receipt publication passed; browser execution remains unverified');
