import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decodeProofRays, parseProofArguments, parseProofInputJson, proofInputJson, proofHash, verifyProof } from './test-trace-updates.mjs';

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
