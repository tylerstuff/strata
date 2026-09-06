import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { bundleTraceProof, decodeProofRays, finalizeProofReport, newExternalDirectory, parseProofArguments, parseProofInputJson, proofInputJson,
  proofHash, traceProofBundleReplacements, traceProofControlSpec, verifyProof } from './test-trace-updates.mjs';

test('GPU mode requires an explicit run, adapter class and reviewed manifest digest', () => {
  for (const args of [[], ['--run'], ['--prepare-only', '--run'], ['--help'],
    ['--run', '--manifest', 'manifest.json', '--manifest-sha256', '0'.repeat(64), '--output', '/tmp/proof'],
    ['--run', '--manifest', 'manifest.json', '--manifest-sha256', 'bad', '--output', '/tmp/proof', '--adapter', 'hardware'],
    ['--run', '--manifest', 'manifest.json', '--manifest-sha256', '0'.repeat(64), '--output', '/tmp/proof', '--adapter', 'hardware', '--allow-dirty-draft'],
    ['--prepare-only', '--asset-root', '/tmp/assets', '--rays', '/tmp/rays.bin', '--output', '/tmp/proof', '--output', '/tmp/again']]) {
    assert.throws(() => parseProofArguments(args));
  }
  const result = parseProofArguments(['--run', '--manifest', '/tmp/manifest.json', '--manifest-sha256', 'a'.repeat(64), '--output', '/tmp/proof', '--adapter', 'hardware']);
  assert.equal(result['--run'], true); assert.equal(result['--adapter'], 'hardware');
  const draft = parseProofArguments(['--prepare-only', '--asset-root', '/tmp/assets', '--rays', '/tmp/rays.bin', '--output', '/tmp/proof', '--allow-dirty-draft']);
  assert.equal(draft['--run'], undefined); assert.equal(draft['--allow-dirty-draft'], true);
  assert.equal(draft['--full-control'], 'full-correctness-only'); assert.equal(draft['--renderer-churn'], 'run');
});

test('control selection and churn omission require explicit frozen prepare arguments; run cannot override either', () => {
  const prepare = ['--prepare-only', '--asset-root', '/tmp/assets', '--rays', '/tmp/rays.bin', '--output', '/tmp/proof'];
  const options = parseProofArguments([...prepare, '--full-control', 'full-performance', '--renderer-churn', 'skip-unchanged-candidate-only']);
  assert.equal(options['--full-control'], 'full-performance'); assert.equal(options['--renderer-churn'], 'skip-unchanged-candidate-only');
  for (const flags of [['--full-control', 'full'], ['--renderer-churn', 'skip'], ['--full-control', 'full-performance', '--full-control', 'full-performance']]) {
    assert.throws(() => parseProofArguments([...prepare, ...flags]));
  }
  const run = ['--run', '--manifest', '/tmp/manifest.json', '--manifest-sha256', 'a'.repeat(64), '--output', '/tmp/proof', '--adapter', 'hardware'];
  for (const flags of [['--full-control', 'full-performance'], ['--renderer-churn', 'skip-unchanged-candidate-only']]) {
    assert.throws(() => parseProofArguments([...run, ...flags]));
  }
  assert.equal(traceProofControlSpec().timingEligibility, 'correctness-only');
  assert.equal(traceProofControlSpec('full-performance').timingEligibility, 'requires-matching-passed-direct-and-renderer-gates');
});

test('actual proof bundles substitute only the chosen control and preserve candidate source bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-proof-control-bundles-'));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const production = 'packages/core/src/gi/trace-updates.ts', bigint = 'tests/helpers/full-trace-updater.ts';
  const candidateBytes = await readFile(join(root, production));
  const entry = (direct) => ({ contents: `export { GiTraceUpdater } from './${production}';\n`
    + (direct ? `export { GiTraceUpdater as FullTraceUpdater } from './${bigint}';` : ''),
    resolveDir: root, sourcefile: 'control-selection-fixture.ts', loader: 'ts' });
  try {
    for (const id of ['full-correctness-only', 'full-performance']) for (const role of ['direct', 'candidate', 'full']) {
      const spec = traceProofControlSpec(id), replacements = traceProofBundleReplacements(id, role);
      const result = await bundleTraceProof(entry(role === 'direct'), directory, `${id}-${role}.mjs`, replacements);
      assert.deepEqual(result.substitutions.map(({ requested, actual }) => ({ requested, actual })), replacements);
      if (role === 'candidate') { assert.deepEqual(replacements, []); assert.equal(result.modules[spec.path], undefined); }
      else assert.equal(result.modules[spec.path], proofHash(await readFile(join(root, spec.path))));
      if (role !== 'full') assert.equal(result.modules[production], proofHash(candidateBytes));
      else assert.equal(result.modules[production], undefined);
      if (id === 'full-performance') assert.equal(result.modules[bigint], undefined);
      for (const file of result.files) assert.equal(proofHash(await readFile(join(directory, file.name))), file.sha256);
      assert.equal(result.performanceEligible, false, 'A correctness bundle is never timing evidence.');
    }
    assert.deepEqual(await readFile(join(root, production)), candidateBytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('frozen ray decoding preserves exact f32 words and byte offset without normalization', () => {
  const storage = Buffer.alloc(512 * 32 + 32, 0xab), bytes = storage.subarray(16, storage.length - 16);
  const values = [-0, 1.0000001192092896, -2.5, .0005, .3, -.4, .8660254, 24];
  for (let id = 0; id < 512; id++) values.forEach((v, word) => bytes.writeFloatLE(v, id * 32 + word * 4));
  const rays = decodeProofRays(bytes), restored = Buffer.alloc(bytes.length);
  rays.forEach((r, id) => [...r.origin, r.tMin, ...r.direction, r.tMax].forEach((v, word) => restored.writeFloatLE(v, id * 32 + word * 4)));
  assert.deepEqual(restored, bytes); assert(Object.is(rays[0].origin[0], -0));
  assert.deepEqual(parseProofInputJson(proofInputJson({ rays, normal: [0, -0, 1] })), { rays, normal: [0, -0, 1] });
  assert.throws(() => decodeProofRays(bytes.subarray(1)), /512/);
  bytes.writeFloatLE(NaN, 100 * 32 + 4); assert.throws(() => decodeProofRays(bytes), /Non-finite ray 100/);
});

test('draft manifest and tampered manifest are rejected before source or GPU admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-proof-admission-'));
  try {
    const path = join(directory, 'manifest.json');
    const bytes = JSON.stringify({ schemaVersion: 1, kind: 'strata-issue20-frozen-correctness-proof', runnable: false });
    await writeFile(path, bytes);
    await assert.rejects(verifyProof(path, proofHash(bytes)), /Draft manifests cannot request a GPU/);
    await writeFile(path, bytes + '\n');
    await assert.rejects(verifyProof(path, proofHash(bytes)), /Frozen input hash differs/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('another checkout or worktree is rejected before any missing parent is created', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-proof-output-'));
  try {
    for (const marker of ['directory', 'file', 'dangling-symlink']) {
      const checkout = join(directory, marker); await mkdir(checkout);
      if (marker === 'directory') await mkdir(join(checkout, '.git'));
      else if (marker === 'file') await writeFile(join(checkout, '.git'), 'gitdir: /external/main/.git/worktrees/proof\n');
      else await symlink(join(directory, 'missing-git'), join(checkout, '.git'));
      await writeFile(join(checkout, 'sentinel'), 'unchanged');
      const alias = join(directory, marker + '-alias'); await symlink(checkout, alias);
      const before = await readdir(checkout);
      for (const path of [checkout, alias]) {
        await assert.rejects(newExternalDirectory(join(path, 'missing', 'nested', 'evidence')), /outside every Git worktree/);
        await assert.rejects(lstat(join(checkout, 'missing')), { code: 'ENOENT' });
        assert.deepEqual(await readdir(checkout), before);
        assert.equal(await readFile(join(checkout, 'sentinel'), 'utf8'), 'unchanged');
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a valid external alias creates a canonical new output and never reuses evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-proof-exclusive-'));
  try {
    const external = join(directory, 'external'); await mkdir(external);
    const alias = join(directory, 'alias'); await symlink(external, alias);
    const target = join(alias, 'nested', 'evidence'), output = await newExternalDirectory(target);
    assert.equal(output, join(await realpath(external), 'nested', 'evidence'));
    await writeFile(join(output, 'sentinel'), 'preserve original evidence');
    await assert.rejects(newExternalDirectory(target), { code: 'EEXIST' });
    assert.deepEqual(await readdir(output), ['sentinel']);
    assert.equal(await readFile(join(output, 'sentinel'), 'utf8'), 'preserve original evidence');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('errors arriving during asynchronous finalization cannot be persisted as a pass', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-proof-finalization-'));
  try {
    for (const priorFailure of [false, true]) {
      const output = await newExternalDirectory(join(directory, String(priorFailure)));
      const original = { message: 'original GPU failure' };
      const report = { status: priorFailure ? 'fail' : 'pass', browserErrors: [], ...(priorFailure ? { failure: original } : {}) };
      assert.deepEqual(report.browserErrors, []); // The earlier run admission saw no browser errors.
      await finalizeProofReport(report, output, async () => {
        await new Promise(resolve => setImmediate(() => { report.browserErrors.push('late page error during close'); resolve(); }));
        await new Promise(resolve => setImmediate(() => { report.browserErrors.push('late console error during verification'); resolve(); }));
      });
      const saved = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
      assert.equal(report.status, 'fail'); assert.equal(saved.status, 'fail');
      assert.deepEqual(saved.browserErrors, ['late page error during close', 'late console error during verification']);
      assert.equal(saved.failure.message, priorFailure ? original.message : `Browser errors: ${saved.browserErrors.join('\n')}`);
      if (priorFailure) assert.equal(report.failure, original);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('clean finalization retains pass and unexpected finalizer rejection is recorded as failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-proof-final-status-'));
  try {
    for (const reject of [false, true]) {
      const output = await newExternalDirectory(join(directory, String(reject)));
      const report = { status: 'pass', browserErrors: [] };
      await finalizeProofReport(report, output, async () => { if (reject) throw Error('failed cleanup'); });
      const saved = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
      assert.equal(saved.status, reject ? 'fail' : 'pass');
      if (reject) assert.match(saved.finalizationFailure, /failed cleanup/);
      else assert.equal(saved.failure, undefined);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
