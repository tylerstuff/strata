import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { bundleTraceProof, proofHash } from './test-trace-updates.mjs';
import { assertPhaseBundleGraph, closePhaseBrowser, finalizePhaseStatus, parsePhaseArguments, phaseNativePng, publishPhaseReport, PHASE_LIMITS, PHASE_RUNS,
  validatePhaseArtifact, verifyPhase, verifyPhaseFile, withPhaseDeadline } from './test-trace-gi-phase.mjs';

const temporary = async t => { const path = await mkdtemp(join(tmpdir(), 'strata-phase-launcher-')); t.after(() => rm(path, { recursive: true, force: true })); return path; };
test('phase GPU admission has no implicit run, software fallback, workload override, or dirty-run escape', () => {
  const prepare = ['--prepare-only', '--asset-root', '/assets', '--plan', '/plan.md', '--output', '/output'];
  assert.equal(parsePhaseArguments(prepare)['--prepare-only'], true);
  assert.equal(parsePhaseArguments([...prepare, '--allow-dirty-draft'])['--allow-dirty-draft'], true);
  const run = ['--run', '--manifest', '/manifest.json', '--manifest-sha256', 'a'.repeat(64), '--output', '/output'];
  assert.equal(parsePhaseArguments(run)['--run'], true);
  for (const invalid of [[], ['--run'], ['--prepare-only'], [...prepare, '--run'], [...prepare, '--output', '/new'],
    [...run, '--allow-dirty-draft'], [...run, '--adapter', 'software'], [...run, '--phase', '5399'], [...run, '--width', '32'],
    [...run, '--manifest-sha256', 'bad'], [...run, '--plan', '/alternate']]) assert.throws(() => parsePhaseArguments(invalid));
  assert.equal(PHASE_RUNS.length, 4); assert.deepEqual(PHASE_RUNS.map(c => [c.updater, c.phaseLabel]), [['incremental', 5399], ['full', 5399], ['full', 5400], ['incremental', 5400]]);
});
test('actual phase bundles contain one exact updater substitution and otherwise identical module hashes', async t => {
  const output = await temporary(t), entry = 'tests/browser/trace-gi-phase-validation.ts';
  const candidate = await bundleTraceProof(entry, output, 'candidate.mjs');
  const full = await bundleTraceProof(entry, output, 'full.mjs', [{ requested: 'packages/core/src/gi/trace-updates.ts', actual: 'tests/helpers/full-trace-performance-updater.ts' }]);
  assertPhaseBundleGraph(candidate, full);
  const changed = structuredClone(full); changed.modules['packages/core/src/gi/probe-cache-shaders.ts'] = 'f'.repeat(64);
  assert.throws(() => assertPhaseBundleGraph(candidate, changed), /Only the approved/);
  const swapped = structuredClone(full); swapped.substitutions[0].actual = 'tests/helpers/full-trace-updater.ts';
  assert.throws(() => assertPhaseBundleGraph(candidate, swapped));
  for (const file of [...candidate.files, ...full.files]) assert.equal(proofHash(await readFile(resolve(output, file.name))), file.sha256);
});
test('manifest tampering and non-runnable drafts fail before GPU import or source checks', async t => {
  const directory = await temporary(t), path = join(directory, 'manifest.json');
  const draft = { schemaVersion: 1, kind: 'strata-issue20-shared-lighting-phase-diagnostic', runnable: false };
  const bytes = JSON.stringify(draft); await writeFile(path, bytes);
  await assert.rejects(verifyPhase(path, proofHash(bytes)), /Draft manifests/);
  await assert.rejects(verifyPhase(path, '0'.repeat(64)), /Frozen SHA256 differs/);
  await assert.rejects(verifyPhaseFile(path, { sha256: proofHash(bytes), bytes: 1 }), /Frozen length/);
});
test('raw artifact payloads reject traversal, noncanonical transport, tampering, dimensions and byte overruns', () => {
  const data = Buffer.from([0, 1, 2, 255]), valid = { name: 'final/native.bin', bytes: 4, sha256: proofHash(data), base64: data.toString('base64'), format: 'bgra8unorm', width: 1, height: 1 };
  assert.deepEqual(validatePhaseArtifact(valid), data);
  for (const patch of [{ name: '../other.bin' }, { name: '/absolute.bin' }, { name: 'final/a/../../other.bin' }, { bytes: -1 },
    { bytes: PHASE_LIMITS.maxArtifactBytes + 1 }, { base64: 'AA==' }, { base64: valid.base64 + '\n' }, { sha256: '0'.repeat(64) },
    { width: 2 }, { height: NaN }, { format: 'unknown' }]) assert.throws(() => validatePhaseArtifact({ ...valid, ...patch }));
});
test('native PNG preserves BGRA channel values exactly without exposure, resampling or alpha change', () => {
  const source = Buffer.from([1, 2, 3, 4, 0, 127, 255, 255, 40, 30, 20, 10, 9, 8, 7, 6]);
  const png = phaseNativePng(source, 2, 2); assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let at = 8; const idat = []; while (at < png.length) { const length = png.readUInt32BE(at), type = png.toString('ascii', at + 4, at + 8);
    if (type === 'IHDR') { assert.equal(png.readUInt32BE(at + 8), 2); assert.equal(png.readUInt32BE(at + 12), 2); }
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length)); at += 12 + length;
  }
  assert.deepEqual([...inflateSync(Buffer.concat(idat))], [0, 3, 2, 1, 4, 255, 127, 0, 255, 0, 20, 30, 40, 10, 7, 8, 9, 6]);
  assert.throws(() => phaseNativePng(source, 3, 2));
});
test('late errors, missing device/browser/server teardown, forced kill and whole deadline cannot pass', () => {
  const valid = () => ({ status: 'pass', browserErrors: [], cleanup: { deviceDestroyed: true, browserExited: true, serverClosed: true, artifactsDrained: true, frozenInputsVerified: true } });
  assert.equal(finalizePhaseStatus(valid(), 1000), 'pass');
  for (const mutation of [r => r.browserErrors.push('late GPU error'), r => { r.cleanup.deviceDestroyed = false; },
    r => { r.cleanup.browserExited = false; }, r => { r.cleanup.serverClosed = false; }, r => { r.cleanup.forcedKill = true; },
    r => { r.cleanup.artifactsDrained = false; }, r => { r.cleanup.frozenInputsVerified = false; },
    r => { r.status = 'fail'; }]) { const r = valid(); mutation(r); assert.equal(finalizePhaseStatus(r, 1000), 'fail'); }
  assert.equal(finalizePhaseStatus(valid(), PHASE_LIMITS.totalMs), 'fail');
});
test('cleanup confirms the exact owned child exited, not merely a resolved close promise', async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child, 'spawn');
  await assert.rejects(closePhaseBrowser({ process: () => child, close: async () => {} }), /still alive/);
  const result = await closePhaseBrowser({ process: () => child, close: async () => { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; } });
  assert.equal(result.pid, child.pid); assert.equal(result.signalCode, 'SIGTERM');
});
test('bounded CPU watchdog fails an unresolved operation and does not retry it', async () => {
  let calls = 0; const work = () => { calls++; return new Promise(() => {}); };
  await assert.rejects(withPhaseDeadline(work(), 'synthetic owned work', 10), /deadline exceeded/); assert.equal(calls, 1);
  assert.equal(await withPhaseDeadline(Promise.resolve(7), 'already done', 100), 7);
});
test('absolute completion admission rejects overdue resolve and rejection even before the timer runs', async () => {
  let clock = 0; const now = () => clock;
  await assert.rejects(withPhaseDeadline(() => { clock = 11; return 'late success'; }, 'late resolve', 10, now), /deadline/);
  clock = 0; const cause = Error('late original rejection');
  await assert.rejects(withPhaseDeadline(() => { clock = 10; throw cause; }, 'late reject', 10, now), error => /deadline/.test(error.message) && error.cause === cause);
  clock = 0;
  assert.equal(await withPhaseDeadline(() => { clock = 9; return 7; }, 'on time', 10, now), 7);
});
test('an operation queued before expiry cannot start after the monotonic deadline', async () => {
  let clock = 0, calls = 0;
  const pending = withPhaseDeadline(() => { calls++; return 'must not start'; }, 'queued operation', 10, () => clock);
  clock = 10;
  await assert.rejects(pending, /deadline/); assert.equal(calls, 0);
});
test('disk reports stay provisional and a late completed write cannot return an admitted child success', async () => {
  const report = () => ({ status: 'pass', browserErrors: [], cleanup: { deviceDestroyed: true, browserExited: true, serverClosed: true, artifactsDrained: true, frozenInputsVerified: true } });
  let clock = 100, written;
  const runtime = { now: () => clock, write: async (_path, bytes) => { written = JSON.parse(bytes); clock = PHASE_LIMITS.totalMs + 1; } };
  await assert.rejects(publishPhaseReport(report(), '/synthetic-report.json', 0, runtime), /deadline/);
  assert.equal(written.status, 'collected'); assert.equal(written.publication.status, 'provisional');
  assert.match(written.publication.admission, /supervisor observation of child exit0/);
  clock = 100; runtime.write = async (_path, bytes) => { written = JSON.parse(bytes); clock = 200; };
  const completed = await publishPhaseReport(report(), '/synthetic-report.json', 0, runtime);
  assert.equal(completed.status, 'collected'); assert.equal(completed.childDataCompletedElapsedMs, 200);
  assert.equal(completed.reportSha256, proofHash(JSON.stringify(written, null, 2) + '\n'));
  assert.equal(written.observedElapsedMs, 100, 'The receipt does not claim to know its own later write completion.');
});
