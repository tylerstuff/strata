import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { applySceneBatch, canonicalJson, createProceduralScene, editSceneFile, sceneRevision, serializeScene } from '@strata-engine/authoring';

// Run only from an isolated installed consumer. Preparation and parser self-tests
// are CPU-only; the normal path controls exactly one installed stdio CLI.
const PLAN = Object.freeze({ browserLifetimes: 1, submittedFrames: 10, captures: 5, initialViewport: [512, 512], resizedViewport: [640, 360], operationTimeoutMs: 60000, workflowTimeoutMs: 240000 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let output, report;
function underOutput(file) {
  assert.ok(isAbsolute(file)); const local = relative(output, file);
  assert.ok(local && !local.startsWith('..') && !isAbsolute(local), 'Artifact must remain inside external output.');
}
function bounded(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

// The consumer rejects unknown/duplicate IDs, malformed UTF-8 and partial final
// records. A response may resolve out of order but exactly once per sent ID.
class Responses {
  constructor(accept, maximum = 4 * 1024 * 1024) { this.accept = accept; this.maximum = maximum; this.parts = []; this.bytes = 0; this.ids = new Set(); }
  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset), stop = end < 0 ? chunk.length : end;
      const piece = chunk.subarray(offset, stop);
      this.bytes += piece.length;
      assert.ok(this.bytes + 1 <= this.maximum, 'Response exceeds LF-inclusive byte limit');
      if (piece.length) this.parts.push(Buffer.from(piece));
      if (end >= 0) {
        const raw = Buffer.concat(this.parts, this.bytes);
        this.parts = []; this.bytes = 0;
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
        assert.ok(value && !Array.isArray(value) && typeof value === 'object');
        assert.equal(value.version, 1); assert.ok(Number.isSafeInteger(value.id) && value.id > 0, 'Uncorrelated or unsolicited response');
        assert.equal(typeof value.ok, 'boolean');
        assert.deepEqual(Object.keys(value).sort(), (value.ok ? ['version', 'id', 'ok', 'result'] : ['version', 'id', 'ok', 'error']).sort());
        if (!value.ok) { assert.equal(typeof value.error.code, 'string'); assert.equal(typeof value.error.stage, 'string'); assert.equal(typeof value.error.message, 'string'); assert.ok(value.error.details && typeof value.error.details === 'object'); }
        assert.ok(!this.ids.has(value.id), 'Duplicate terminal response'); this.ids.add(value.id);
        this.accept(value);
      }
      offset = end < 0 ? chunk.length : end + 1;
    }
  }
  end() { assert.equal(this.bytes, 0, 'Unterminated response at EOF'); assert.equal(this.parts.length, 0); }
}

function selfTest() {
  const got = [], parser = new Responses(value => got.push(value));
  const bytes = Buffer.from(JSON.stringify({ version: 1, id: 2, ok: true, result: '雪' }) + '\n' + JSON.stringify({ version: 1, id: 1, ok: true, result: {} }) + '\n');
  for (const byte of bytes) parser.push(Buffer.from([byte])); parser.end();
  assert.deepEqual(got.map(value => value.id), [2, 1]); assert.equal(got[0].result, '雪');
  assert.throws(() => parser.push(Buffer.from(JSON.stringify(got[0]) + '\n')), /Duplicate/);
  assert.throws(() => new Responses(() => {}).push(Buffer.from([0xff, 10])));
  const partial = new Responses(() => {}); partial.push(Buffer.from('{')); assert.throws(() => partial.end(), /Unterminated/);
  assert.throws(() => new Responses(() => {}, 3).push(Buffer.from('abc\n')), /byte limit/);
  assert.throws(() => new Responses(() => {}).push(Buffer.from('{"version":1,"id":null,"ok":true,"result":{}}\n')), /Uncorrelated/);
  assert.throws(() => new Responses(() => { throw new Error('Unsent ID'); }).push(Buffer.from('{"version":1,"id":99,"ok":true,"result":{}}\n')), /Unsent/);
  console.log('Connection workflow response parser CPU checks passed.');
}

function generatedInputs() {
  const a = createProceduralScene('preview-browser-box', 'Packed preview correctness box');
  a.entities[0].transform.position = [-0.55, 0, 0]; a.materials[0].baseColor = [0.8, 0.015, 0.015, 1];
  const revisionA = sceneRevision(a);
  const batch = { format: 'strata.scene-edit', version: 1, expectedRevision: revisionA, operations: [
    { op: 'set-entity', value: { ...a.entities[0], transform: { ...a.entities[0].transform, position: [0.55, 0, 0] } } },
    { op: 'set-material', value: { ...a.materials[0], baseColor: [0.015, 0.8, 0.015, 1] } },
  ] };
  const edited = applySceneBatch(a, batch); assert.equal(edited.ok, true); assert.equal(edited.value.changed, true); assert.equal(edited.value.changes.length, 2);
  const b = edited.value.scene, unsupported = structuredClone(a);
  unsupported.assets.push({ id: 'unsupported-model', kind: 'external', uri: 'https://invalid.example/never-fetch.glb', mediaType: 'model/gltf-binary' });
  const files = {
    'scene-a.json': serializeScene(a), 'scene-b.json': serializeScene(b), 'scene-unsupported.json': serializeScene(unsupported),
    'edit-a-to-b.json': canonicalJson(batch), 'edit-a-to-b-preview.json': canonicalJson(edited.value),
    'view-base-color.json': canonicalJson(view()), 'view-final.json': canonicalJson(view('final')),
  };
  return { files, revisions: { a: revisionA, b: sceneRevision(b), unsupported: sceneRevision(unsupported) } };
}
async function prepare() {
  const inputs = generatedInputs();
  await mkdir(join(output, 'inputs')); await mkdir(join(output, 'project')); await mkdir(join(output, 'captures'));
  const files = [];
  for (const [name, text] of Object.entries(inputs.files)) {
    const file = `inputs/${name}`; await writeFile(join(output, file), text, { flag: 'wx' });
    files.push({ path: file, bytes: Buffer.byteLength(text), sha256: hash(text) });
  }
  const manifest = canonicalJson({ format: 'strata.preview.connection.inputs', version: 1, plan: PLAN, sceneRevisions: inputs.revisions, files });
  await writeFile(join(output, 'input-sha256.json'), manifest, { flag: 'wx' });
  console.log(JSON.stringify({ status: 'prepared', inputManifestPath: join(output, 'input-sha256.json'), inputManifestSha256: hash(manifest), plan: PLAN }));
}
async function checkInputs() {
  const raw = await readFile(join(output, 'input-sha256.json')), manifest = JSON.parse(raw);
  assert.equal(raw.toString(), canonicalJson(manifest)); assert.equal(manifest.format, 'strata.preview.connection.inputs'); assert.equal(manifest.version, 1); assert.deepEqual(manifest.plan, PLAN);
  const generated = generatedInputs();
  assert.deepEqual(manifest.sceneRevisions, generated.revisions);
  assert.deepEqual(manifest.files.map(file => file.path).sort(), Object.keys(generated.files).map(name => `inputs/${name}`).sort());
  for (const file of manifest.files) {
    const bytes = await readFile(join(output, file.path)); assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
    assert.equal(bytes.toString(), generated.files[file.path.slice('inputs/'.length)]);
  }
  return { ...manifest, manifestSha256: hash(raw) };
}

function processRows() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024 }).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/); assert.ok(match);
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] };
  });
}
function ownedRows(pid) {
  const rows = processRows(), owned = new Set([pid]);
  let changed = true; while (changed) { changed = false; for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
  return rows.filter(row => owned.has(row.pid));
}

class StdioClient {
  constructor(projectRoot, outputRoot, browser) {
    const binary = resolve('node_modules/.bin/strata-preview-connection');
    const args = ['--project-root', projectRoot, '--output-root', outputRoot, '--browser', browser.channel, '--width', '512', '--height', '512', '--timeout-ms', '60000', '--cleanup-timeout-ms', '5000'];
    if (!browser.headless) args.push('--headed'); if (browser.softwareGpu) args.push('--software-gpu');
    this.requests = []; this.responses = []; this.stdout = []; this.stderr = []; this.stdoutBytes = 0; this.stderrBytes = 0; this.nextId = 1; this.pending = new Map(); this.exit = deferred(); this.closed = false; this.exiting = false; this.failure = null;
    this.child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pid = this.child.pid; this.binary = binary; this.args = args;
    this.parser = new Responses(response => {
      const pending = this.pending.get(response.id); assert.ok(pending, 'Response ID was not outstanding');
      this.pending.delete(response.id); clearTimeout(pending.timer); this.responses.push({ receivedAt: new Date().toISOString(), response }); pending.resolve(response);
    });
    this.child.stdout.on('data', chunk => {
      try { this.stdoutBytes += chunk.length; assert.ok(this.stdoutBytes <= 32 * 1024 * 1024, 'Workflow stdout exceeded bound'); this.stdout.push(Buffer.from(chunk)); this.parser.push(chunk); }
      catch (error) { this.fail(error); }
    });
    this.child.stderr.on('data', chunk => {
      this.stderrBytes += chunk.length; if (this.stderrBytes <= 1024 * 1024) this.stderr.push(Buffer.from(chunk));
      this.fail(new Error('Installed connection emitted unexpected stderr.'));
    });
    this.child.stdin.on('error', error => { if (!this.closed) this.fail(error); });
    this.child.on('error', error => this.fail(error));
    this.child.on('close', (code, signal) => {
      this.closed = true;
      try { this.parser.end(); if (this.pending.size) throw new Error('CLI exited with unresolved request IDs.'); if (!this.exiting) throw new Error('CLI exited before dispose.'); }
      catch (error) { this.fail(error); }
      this.exit.resolve({ code, signal, closedAt: new Date().toISOString() });
    });
  }
  fail(error) { this.failure ??= error; for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(this.failure); } this.pending.clear(); }
  check() { if (this.failure) throw this.failure; assert.ok(!this.closed, 'Connection process is closed.'); }
  batch(specifications) {
    this.check(); const responses = [], requests = [];
    for (const { method, params } of specifications) {
      const id = this.nextId++, value = { version: 1, id, method, params }, response = deferred();
      const timer = setTimeout(() => this.fail(new Error(`Request ${id} exceeded 60 seconds.`)), 60000);
      this.pending.set(id, { ...response, timer }); response.promise.catch(() => {}); responses.push(response.promise); requests.push(value);
      this.requests.push({ sentAt: new Date().toISOString(), request: value }); if (method === 'dispose') this.exiting = true;
    }
    const bytes = Buffer.from(requests.map(request => JSON.stringify(request) + '\n').join(''));
    assert.ok(bytes.length <= 65536); this.child.stdin.write(bytes, error => { if (error) this.fail(error); });
    return { requests, bytes, responses };
  }
  async request(method, params = {}) { return (await Promise.all(this.batch([{ method, params }]).responses))[0]; }
  async success(method, params = {}) { const response = await this.request(method, params); assert.equal(response.ok, true, JSON.stringify(response)); return response.result; }
  snapshot(label) { const rows = ownedRows(this.pid); report.process.snapshots.push({ label, at: new Date().toISOString(), rows }); return rows; }
  async save() {
    await writeFile(join(output, 'cli.stdout.jsonl'), Buffer.concat(this.stdout), { flag: 'wx' });
    await writeFile(join(output, 'cli.stderr.txt'), Buffer.concat(this.stderr), { flag: 'wx' });
    await writeFile(join(output, 'requests.jsonl'), this.requests.map(value => JSON.stringify(value) + '\n').join(''), { flag: 'wx' });
    await writeFile(join(output, 'responses.jsonl'), this.responses.map(value => JSON.stringify(value) + '\n').join(''), { flag: 'wx' });
  }
  async cleanup() {
    const signals = [];
    if (!this.closed) {
      this.exiting = true; this.child.stdin.end();
      try { await bounded(this.exit.promise, 5000, 'EOF cleanup timeout'); }
      catch { if (!this.closed) { signals.push('SIGTERM'); this.child.kill('SIGTERM'); } }
      if (!this.closed) {
        try { await bounded(this.exit.promise, 1500, 'SIGTERM cleanup timeout'); }
        catch { if (!this.closed) { signals.push('SIGKILL'); this.child.kill('SIGKILL'); } }
      }
      if (!this.closed) await bounded(this.exit.promise, 1500, 'CLI failed to exit after SIGKILL');
    }
    return { exit: await this.exit.promise, signals };
  }
}

// Decode only Chromium screenshot formats (8-bit RGB/RGBA, noninterlaced).
// Validate chunk CRCs and exact decompressed length before unfiltering pixels.
function decodePng(bytes) {
  assert.ok(bytes.length <= 64 * 1024 * 1024);
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let offset = 8, width, height, channels, ended = false;
  const compressed = [];
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, 'Truncated PNG chunk');
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    assert.ok(length <= bytes.length - offset - 12, 'Invalid PNG chunk length');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, offset + 8 + length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, bytes.readUInt32BE(offset + 8 + length), `${type} CRC mismatch`);
    if (offset === 8) assert.equal(type, 'IHDR');
    if (type === 'IHDR') {
      assert.equal(width, undefined, 'Duplicate PNG IHDR');
      assert.equal(length, 13);
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.ok(width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 64 * 1024 * 1024);
      assert.equal(data[8], 8, 'Expected an 8-bit screenshot');
      assert.ok(data[9] === 2 || data[9] === 6, 'Expected RGB or RGBA screenshot');
      channels = data[9] === 2 ? 3 : 4;
      assert.deepEqual([...data.subarray(10)], [0, 0, 0], 'Expected ordinary PNG compression/filtering without interlace');
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'IEND') { assert.equal(length, 0); ended = true; }
    offset += length + 12;
    if (ended) break;
  }
  assert.ok(ended && compressed.length > 0, 'Missing PNG image data/end');
  assert.equal(offset, bytes.length, 'Unexpected bytes after PNG end');
  const stride = width * channels;
  const rows = inflateSync(Buffer.concat(compressed), { maxOutputLength: (stride + 1) * height });
  assert.equal(rows.length, (stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const estimate = a + b - c, da = Math.abs(estimate - a), db = Math.abs(estimate - b), dc = Math.abs(estimate - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = rows[y * (stride + 1)];
    assert.ok(filter <= 4, `Unsupported PNG filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= channels ? pixels[index - channels] : 0;
      const above = y > 0 ? pixels[index - stride] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[index - stride - channels] : 0;
      const predictor = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, upperLeft)][filter];
      pixels[index] = (rows[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

function region(image, bounds, predicate = () => true) {
  const [x0, y0, x1, y1] = bounds.map((v, i) => Math.floor(v * (i % 2 === 0 ? image.width : image.height)));
  const sum = [0, 0, 0];
  let count = 0, xSum = 0, ySum = 0, area = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const index = (y * image.width + x) * image.channels;
    const [r, g, b] = image.pixels.subarray(index, index + 3);
    if (image.channels === 4) assert.equal(image.pixels[index + 3], 255, 'Preview canvas must be opaque');
    area++;
    if (predicate(r, g, b)) { count++; xSum += x; ySum += y; sum[0] += r; sum[1] += g; sum[2] += b; }
  }
  return { area, count, coverage: count / area, mean: sum.map(value => value / Math.max(1, count)), centroid: count ? [xSum / count, ySum / count] : null };
}
const red = (r, g, b) => r > 150 && r > g * 1.8 && r > b * 1.8;
const green = (r, g, b) => g > 150 && g > r * 1.8 && g > b * 1.8;
const dark = (r, g, b) => Math.max(r, g, b) < 45;
const whole = [0, 0, 1, 1];
const leftPatch = [0.29, 0.43, 0.39, 0.57];
const rightPatch = [0.61, 0.43, 0.71, 0.57];

function baseColorEvidence(image, color, position) {
  const object = region(image, whole, color);
  assert.ok(object.coverage > 0.035 && object.coverage < 0.15, `Expected a bounded box, got coverage ${object.coverage}`);
  const expectedX = position < 0 ? [0.28, 0.41] : [0.59, 0.72];
  assert.ok(object.centroid[0] / image.width > expectedX[0] && object.centroid[0] / image.width < expectedX[1], `Box center is in the wrong horizontal region: ${object.centroid}`);
  assert.ok(Math.abs(object.centroid[1] / image.height - 0.5) < 0.025, 'Box should be vertically centered');
  const occupied = region(image, position < 0 ? leftPatch : rightPatch, color);
  const cleared = region(image, position < 0 ? rightPatch : leftPatch, dark);
  assert.ok(occupied.coverage > 0.95, 'Expected box color throughout its interior patch');
  assert.ok(cleared.coverage > 0.99, 'Old/opposite box patch must show background');
  assert.ok(region(image, [0.02, 0.02, 0.2, 0.2], dark).coverage > 0.99, 'Corner should remain the explicit background');
  return { object, occupied, cleared };
}

function view(debugView = 'base-color') {
  return {
    camera: { position: [0, 0, 4], rotation: [0, 0, 0, 1], projection: { kind: 'perspective', verticalFovRadians: 55 * Math.PI / 180, near: 0.1, far: 32 } },
    light: { directionToLight: [0, 0, 1], radiance: [2, 2, 2] }, background: [0.002, 0.002, 0.002],
    debugView, timeSeconds: 0, temporal: false,
  };
}

async function verifyPublication(publication, ready, width, height, label, expectedPreviousFrameId = ready.frameId) {
  underOutput(publication.imagePath); underOutput(publication.receiptPath);
  assert.equal(dirname(publication.imagePath), dirname(publication.receiptPath));
  const bytes = await readFile(publication.imagePath);
  const receiptText = await readFile(publication.receiptPath, 'utf8');
  const receipt = JSON.parse(receiptText);
  assert.deepEqual(receipt, publication.receipt);
  assert.equal(receiptText, canonicalJson(receipt));
  assert.equal(receipt.format, 'strata.preview.capture'); assert.equal(receipt.version, 1);
  for (const key of ['sessionId', 'loadId', 'sceneId', 'sourceRevision', 'commit', 'viewRevision', 'resolvedView']) assert.deepEqual(receipt[key], ready[key]);
  assert.deepEqual([receipt.width, receipt.height], [width, height]);
  assert.deepEqual([receipt.image.width, receipt.image.height], [width, height]);
  assert.equal(receipt.image.relativePath, 'image.png');
  assert.equal(receipt.image.bytes, bytes.length); assert.equal(receipt.image.sha256, hash(bytes));
  assert.equal(receipt.presentedFrameId, null, 'GPU-fenced canvas evidence must not claim compositor identity');
  assert.equal(receipt.telemetry.gpuErrorCount, 0);
  assert.deepEqual(receipt.telemetry.scene.identity, receipt.commit);
  assert.equal(receipt.telemetry.scene.lastSubmittedFrameId, receipt.frameId);
  assert.equal(receipt.commit.renderer, 'authored-boxes');
  assert.equal(receipt.commit.sourceRevision, ready.sourceRevision);
  assert.equal(receipt.submittedFrameIds.length, 1);
  assert.equal(receipt.frameId, receipt.submittedFrameIds[0]);
  assert.equal(receipt.gpuCompletion.fencedThroughFrameId, receipt.frameId);
  assert.deepEqual(receipt.frames.map(frame => frame.frameId), receipt.submittedFrameIds);
  for (const frame of receipt.frames) {
    assert.deepEqual(frame.scene, receipt.commit);
    assert.deepEqual(frame.authored.camera, view().camera);
    assert.deepEqual([frame.authored.width, frame.authored.height], [width, height]);
    assert.equal(frame.authored.debugView, receipt.resolvedView.debugView);
    assert.deepEqual(frame.authored.motion, {
      previousSubmittedFrameId: expectedPreviousFrameId, valid: true, resetReason: null,
    }, 'Capture must retain the immediately preceding submitted load/resize frame as motion evidence');
    assert.equal(frame.triangles, 12, 'Exactly one authored box should be submitted');
  }
  assert.deepEqual(receipt.gpuTimings.map(timing => timing.frameId), receipt.submittedFrameIds);
  for (const timing of receipt.gpuTimings) {
    for (const sample of timing.samples) assert.equal(sample.frameId, timing.frameId);
    if (timing.samples.length === 0) assert.ok(typeof timing.unavailableReason === 'string' && timing.unavailableReason.length > 0);
  }
  assert.deepEqual(publication.cleanupWarnings ?? [], []);
  assert.deepEqual(receipt.resolvedView.camera, view().camera);
  assert.deepEqual(receipt.resolvedView.light, view().light);
  assert.deepEqual(receipt.resolvedView.background, view().background);
  assert.equal(receipt.resolvedView.temporal, false);
  assert.equal(Object.hasOwn(receipt.resolvedView, 'motion'), false, 'Per-frame motion provenance must not change stable view identity');
  assert.equal(receipt.resolvedView.timeSeconds, 0);
  assert.equal(receipt.resolvedView.debugView, label.startsWith('final-') ? 'final' : 'base-color');
  const decoded = decodePng(bytes);
  assert.deepEqual([decoded.width, decoded.height], [width, height]);
  report.captures.push({ label, imagePath: publication.imagePath, receiptPath: publication.receiptPath, receiptSha256: hash(receiptText),
    image: receipt.image, sessionId: receipt.sessionId, loadId: receipt.loadId, sourceRevision: receipt.sourceRevision,
    commit: receipt.commit, viewRevision: receipt.viewRevision, submittedFrameIds: receipt.submittedFrameIds,
    motion: receipt.frames.map(frame => ({ frameId: frame.frameId, ...frame.authored.motion })),
    gpuErrorCount: receipt.telemetry.gpuErrorCount, environment: receipt.environment });
  return { image: decoded, receipt };
}

function readyIdentity(ready, expected) {
  assert.equal(ready.sourceRevision, expected.revision); assert.equal(ready.sceneId, 'preview-browser-box');
  assert.equal(ready.commit.sceneId, ready.sceneId); assert.equal(ready.commit.sourceRevision, expected.revision);
  assert.equal(ready.commit.sceneGeneration, expected.generation); assert.equal(ready.commit.renderer, 'authored-boxes');
  assert.equal(ready.frameId, expected.frameId); assert.deepEqual([ready.width, ready.height], [expected.width, expected.height]);
  assert.equal(ready.loadId, `${ready.sessionId}:${hash(canonicalJson(ready.commit))}`);
  assert.equal(ready.viewRevision, hash(canonicalJson(ready.resolvedView)));
  assert.deepEqual(ready.resolvedView, { ...view(expected.debugView), width: expected.width, height: expected.height, aspect: expected.width / expected.height,
    origin: view().camera.position, renderer: 'authored-boxes', sceneFormatVersion: 1 });
}
function currentIdentity(result, expected) {
  assert.equal(result.state, expected ? 'initialized' : 'uninitialized');
  if (!expected) { assert.equal(result.observation, null); return; }
  const state = result.observation; assert.equal(state.state, 'ready');
  for (const key of ['sessionId', 'loadId', 'sceneId', 'sourceRevision', 'commit', 'frameId', 'width', 'height', 'viewRevision', 'resolvedView']) assert.deepEqual(state.ready[key], expected[key]);
  assert.deepEqual(state.driver.commit, expected.commit); assert.equal(state.driver.lastSubmittedFrameId, expected.frameId);
  assert.deepEqual([state.driver.width, state.driver.height], [expected.width, expected.height]);
  assert.deepEqual(state.driver.telemetry.scene.identity, expected.commit);
  assert.equal(state.driver.telemetry.scene.lastSubmittedFrameId, expected.frameId);
  assert.equal(state.driver.telemetry.submittedFrames, expected.frameId);
  assert.equal(state.driver.telemetry.gpuErrorCount, 0); assert.equal(state.driver.telemetry.lastGpuError, null);
}
async function inspectSettled(client, label, expected) {
  const started = Date.now(); let polls = 0;
  while (true) {
    const state = await client.success('inspect'); polls++;
    // Inspect includes itself in the active summary. Polling settlement is not a
    // retried mutation and submits no frames; never repeat a failed operation.
    const other = state.activeRequests.filter(request => request.method !== 'inspect');
    if (!other.length && (!state.observation || state.observation.state !== 'busy')) {
      currentIdentity(state, expected); report.observations.push({ label, polls, state }); return state;
    }
    assert.ok(Date.now() - started < 5000 && polls < 64, 'Owned work did not settle for the next assertion');
    if (state.observation) assert.ok(['ready', 'busy', 'unready'].includes(state.observation.state), 'Session became unavailable');
    await delay(25);
  }
}
async function rejectedWithoutFrame(client, method, params, code, label, expected) {
  const before = await inspectSettled(client, `${label}:before`, expected);
  const response = await client.request(method, params);
  assert.equal(response.ok, false, 'Expected the documented rejection'); assert.equal(response.error.code, code, JSON.stringify(response));
  const after = await inspectSettled(client, `${label}:after`, expected);
  assert.deepEqual(after.observation?.ready ?? null, before.observation?.ready ?? null);
  assert.deepEqual(after.observation?.driver.commit ?? null, before.observation?.driver.commit ?? null);
  assert.equal(after.observation?.driver.lastSubmittedFrameId ?? null, before.observation?.driver.lastSubmittedFrameId ?? null);
  report.checks.push({ name: label, rejectedRequestId: response.id, code, retainedFrameId: expected?.frameId ?? null, browserInitialized: after.observation !== null });
}
function captureParams(ready, captureId) {
  return { captureId, frames: 1, expectedRevision: ready.sourceRevision, expectedLoadId: ready.loadId, expectedViewRevision: ready.viewRevision };
}
function environmentMatches(receipt, browser) {
  const actual = receipt.environment.browser, adapter = receipt.environment.engine.adapter;
  assert.equal(actual.channel, browser.channel); assert.equal(actual.headless, browser.headless); assert.equal(actual.softwareGpu, browser.softwareGpu);
  assert.ok(typeof actual.version === 'string' && /^\d+\./.test(actual.version));
  assert.equal(receipt.environment.engine.cpu.abiVersion, 2);
  if (!browser.softwareGpu) {
    assert.equal(adapter.isFallbackAdapter, false);
    assert.doesNotMatch([adapter.vendor, adapter.architecture, adapter.device, adapter.description].join(' '), /swiftshader|llvmpipe|software adapter|microsoft basic render/i);
  }
}
async function capture(client, ready, width, height, label, browser) {
  const publication = await client.success('capture', captureParams(ready, label));
  assert.equal(publication.publicationOccurred, true); assert.equal(publication.error, undefined);
  assert.equal(dirname(publication.imagePath), join(output, 'captures', label));
  const verified = await verifyPublication(publication, ready, width, height, label);
  assert.equal(verified.receipt.frameId, ready.frameId + 1);
  assert.equal(verified.receipt.telemetry.submittedFrames, verified.receipt.frameId);
  assert.equal(verified.receipt.telemetry.lastGpuError, null);
  environmentMatches(verified.receipt, browser);
  for (const timing of verified.receipt.gpuTimings) for (const sample of timing.samples) {
    assert.ok(Number.isFinite(sample.gpuMs) && sample.gpuMs >= 0);
    assert.ok(Number.isFinite(sample.startOffsetMs) && Number.isFinite(sample.endOffsetMs) && sample.endOffsetMs >= sample.startOffsetMs);
  }
  await inspectSettled(client, `${label}:captured-current-state`, verified.receipt);
  return verified;
}

async function run() {
  report = { format: 'strata.preview.connection.browser-workflow', version: 1, status: 'running', startedAt: new Date().toISOString(),
    purpose: 'Installed persistent stdio preview correctness; no performance, numeric PBR or compositor identity claim.', plan: PLAN,
    captures: [], checks: [], observations: [], process: { snapshots: [] }, totalSubmittedFrames: 0, distinctSessionIds: 0, browserLifetimes: 0,
    limitations: ['Public disposal reports cleanup outcome but exposes no post-disposal resource-count snapshot.', 'PNG capture follows a GPU fence; presentedFrameId remains unobserved.', 'Process cleanup checks cover observed owned PIDs; the outer runner owns the dedicated process group.', 'Settlement-only inspection polls do not retry mutations or submit frames.', 'Full FrameMetrics are available for captured frames 2/4/6/8/10; preceding load/resize frames retain ready identities and linked motion provenance, not invented metrics.'] };
  let client, primaryError, aborted;
  const abort = () => { aborted ??= new Error('Workflow interrupted or exceeded its 230-second work allowance.'); client?.fail(aborted); };
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  // Reserve the final ten seconds of the 240-second budget for owned cleanup.
  const timer = setTimeout(abort, 230000);
  const browser = { channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium', headless: process.env.STRATA_TEST_HEADED !== '1', softwareGpu: process.env.STRATA_TEST_SOFTWARE_GPU === '1' };
  try {
    assert.ok(['chromium', 'chrome'].includes(browser.channel)); report.browser = browser;
    assert.ok(!(await readdir(output)).includes('workflow-report.json'), 'Evidence directory already contains a workflow result');
    const inputs = await checkInputs(); report.inputs = { manifestSha256: inputs.manifestSha256, files: inputs.files, sceneRevisions: inputs.sceneRevisions };
    assert.deepEqual(await readdir(join(output, 'project')), [], 'Prepared project directory must start empty');
    assert.deepEqual(await readdir(join(output, 'captures')), [], 'Prepared capture directory must start empty');
    const live = join(output, 'project', 'live-scene.json');
    await writeFile(live, await readFile(join(output, 'inputs', 'scene-a.json')), { flag: 'wx' });
    await writeFile(join(output, 'project', 'unsupported.json'), await readFile(join(output, 'inputs', 'scene-unsupported.json')), { flag: 'wx' });
    if (aborted) throw aborted;
    client = new StdioClient(join(output, 'project'), join(output, 'captures'), browser);
    report.process.cliPid = client.pid; report.process.binary = client.binary; report.process.arguments = client.args;
    const discover = await client.success('discover');
    assert.equal(discover.protocol, 'strata.preview.connection'); assert.equal(discover.version, 1); assert.equal(discover.transport, 'stdio-jsonl');
    assert.deepEqual(Object.keys(discover.methods).sort(), ['cancel', 'capture', 'discover', 'dispose', 'inspect', 'load', 'resize']);
    assert.equal(discover.projectRoot, join(output, 'project')); assert.equal(discover.outputRoot, join(output, 'captures'));
    assert.deepEqual(discover.browser, { ...browser, lazy: true });
    report.discovery = discover;
    await inspectSettled(client, 'initial-uninitialized', null);
    await rejectedWithoutFrame(client, 'unsupported-method', {}, 'CONNECTION_METHOD', 'unknown method rejected before initialization', null);
    await rejectedWithoutFrame(client, 'load', {}, 'CONNECTION_INVALID_REQUEST', 'missing load parameters rejected before initialization', null);
    await rejectedWithoutFrame(client, 'load', { scenePath: 'missing.json', expectedRevision: inputs.sceneRevisions.a, view: view() }, 'CONNECTION_SCENE_INPUT', 'missing scene file rejected before initialization', null);
    await rejectedWithoutFrame(client, 'load', { scenePath: 'unsupported.json', expectedRevision: inputs.sceneRevisions.unsupported, view: view() }, 'PREVIEW_UNSUPPORTED_ASSET', 'external descriptor rejected without browser or fetching', null);
    const canceled = client.batch([{ method: 'load', params: { scenePath: 'live-scene.json', expectedRevision: inputs.sceneRevisions.a, view: view() } }, { method: 'cancel', params: { requestId: client.nextId } }]);
    assert.equal(canceled.requests[1].params.requestId, canceled.requests[0].id);
    const [loadFailure, cancellation] = await Promise.all(canceled.responses);
    assert.equal(loadFailure.ok, false); assert.equal(loadFailure.error.code, 'PREVIEW_ABORTED');
    assert.equal(cancellation.ok, true); assert.equal(cancellation.result.cancellationRequested, true); assert.equal(cancellation.result.settled, false);
    await inspectSettled(client, 'same-write-cancellation-before-initialization', null);
    const lazyProcesses = client.snapshot('after-zero-GPU-preflight'); assert.deepEqual(lazyProcesses.map(row => row.pid), [client.pid]);
    report.checks.push({ name: 'initial load and cancel shared one raw stdin write; no browser initialized', requestIds: canceled.requests.map(value => value.id), rawWriteBytes: canceled.bytes.length, rawWriteSha256: hash(canceled.bytes), submittedFrames: 0 });

    const a = await client.success('load', { scenePath: 'live-scene.json', expectedRevision: inputs.sceneRevisions.a, view: view() });
    readyIdentity(a, { revision: inputs.sceneRevisions.a, generation: 1, frameId: 1, width: 512, height: 512, debugView: 'base-color' });
    await inspectSettled(client, 'load-a-current-state', a);
    const first = await capture(client, a, 512, 512, 'base-a', browser);
    report.checks.push({ name: 'base red box occupies expected left region', evidence: baseColorEvidence(first.image, red, -1) });
    client.snapshot('first-capture-browser-owned');
    await rejectedWithoutFrame(client, 'load', { scenePath: 'unsupported.json', expectedRevision: inputs.sceneRevisions.unsupported, view: view() }, 'PREVIEW_UNSUPPORTED_ASSET', 'unsupported descriptor retains the ready scene without rendering', first.receipt);

    const same = await client.success('load', { scenePath: 'live-scene.json', expectedRevision: inputs.sceneRevisions.a, view: view() });
    readyIdentity(same, { revision: inputs.sceneRevisions.a, generation: 2, frameId: 3, width: 512, height: 512, debugView: 'base-color' });
    assert.equal(same.sessionId, a.sessionId); assert.notEqual(same.loadId, a.loadId); assert.equal(same.viewRevision, a.viewRevision);
    await rejectedWithoutFrame(client, 'capture', captureParams(a, 'never-stale-load'), 'PREVIEW_STALE_STATE', 'same source generation rejects historical load token without rendering', same);
    const repeat = await capture(client, same, 512, 512, 'same-source-new-generation', browser);
    assert.ok(repeat.image.pixels.equals(first.image.pixels)); assert.equal(repeat.receipt.image.sha256, first.receipt.image.sha256);
    report.checks.push({ name: 'same source reload changes generation and retains identical pixels', previousLoadId: a.loadId, nextLoadId: same.loadId, imageSha256: repeat.receipt.image.sha256 });

    const batch = JSON.parse(await readFile(join(output, 'inputs', 'edit-a-to-b.json'), 'utf8'));
    const edited = await editSceneFile(live, batch);
    assert.equal(edited.changed, true); assert.equal(edited.baseRevision, inputs.sceneRevisions.a); assert.equal(edited.revision, inputs.sceneRevisions.b);
    assert.equal(await readFile(live, 'utf8'), await readFile(join(output, 'inputs', 'scene-b.json'), 'utf8'));
    await writeFile(join(output, 'applied-edit.json'), canonicalJson(edited), { flag: 'wx' });
    await rejectedWithoutFrame(client, 'load', { scenePath: 'live-scene.json', expectedRevision: inputs.sceneRevisions.a, view: view() }, 'PREVIEW_SOURCE_REVISION_MISMATCH', 'edited scene rejects stale source revision while current receipt stays historical A', repeat.receipt);
    const b = await client.success('load', { scenePath: 'live-scene.json', expectedRevision: inputs.sceneRevisions.b, view: view() });
    readyIdentity(b, { revision: inputs.sceneRevisions.b, generation: 3, frameId: 5, width: 512, height: 512, debugView: 'base-color' });
    assert.equal(b.sessionId, a.sessionId); assert.notEqual(b.loadId, same.loadId);
    await rejectedWithoutFrame(client, 'capture', captureParams(repeat.receipt, 'never-stale-source'), 'PREVIEW_STALE_STATE', 'prior source capture receipt cannot capture newly committed scene', b);
    const changed = await capture(client, b, 512, 512, 'base-b', browser);
    const moved = baseColorEvidence(changed.image, green, 1);
    assert.ok(region(changed.image, whole, red).coverage < 0.001); assert.ok(moved.object.centroid[0] - region(first.image, whole, red).centroid[0] > 120);
    report.checks.push({ name: 'authoring file batch visibly moves red-left to green-right', baseRevision: edited.baseRevision, revision: edited.revision, changes: edited.changes, evidence: moved });

    const resized = await client.success('resize', { width: 640, height: 360 });
    readyIdentity(resized, { revision: inputs.sceneRevisions.b, generation: 3, frameId: 7, width: 640, height: 360, debugView: 'base-color' });
    assert.equal(resized.loadId, b.loadId); assert.notEqual(resized.viewRevision, b.viewRevision);
    await rejectedWithoutFrame(client, 'capture', captureParams(changed.receipt, 'never-stale-view'), 'PREVIEW_STALE_STATE', 'stale view after physical resize submits no frame', resized);
    const resizeCapture = await capture(client, resized, 640, 360, 'resized', browser);
    const box = region(resizeCapture.image, whole, green);
    assert.ok(box.coverage > 0.025 && box.coverage < 0.09); assert.ok(box.centroid[0] > 360 && box.centroid[0] < 390); assert.ok(Math.abs(box.centroid[1] - 180) < 5);
    assert.ok(region(resizeCapture.image, [0.57, 0.43, 0.61, 0.57], green).coverage > 0.95);
    report.checks.push({ name: 'physical resize changes native dimensions and view identity', evidence: box });

    const final = await client.success('load', { scenePath: 'live-scene.json', expectedRevision: inputs.sceneRevisions.b, view: view('final') });
    readyIdentity(final, { revision: inputs.sceneRevisions.b, generation: 4, frameId: 9, width: 640, height: 360, debugView: 'final' });
    const lit = await capture(client, final, 640, 360, 'final-green', browser);
    const litMean = region(lit.image, [0.57, 0.43, 0.61, 0.57]).mean;
    assert.ok(litMean[1] > litMean[0] + 50 && litMean[1] > litMean[2] + 50); assert.notEqual(lit.receipt.image.sha256, resizeCapture.receipt.image.sha256);
    report.checks.push({ name: 'final lighting keeps the edited green material visible', greenMean: litMean });
    const observed = await inspectSettled(client, 'final-ten-submitted-frames', lit.receipt);
    report.totalSubmittedFrames = observed.observation.driver.telemetry.submittedFrames; assert.equal(report.totalSubmittedFrames, 10);
    report.distinctSessionIds = new Set(report.captures.map(value => value.sessionId)).size; assert.equal(report.distinctSessionIds, 1);
    assert.equal(report.captures.length, 5); report.browserLifetimes = 1;
    assert.deepEqual((await readdir(join(output, 'captures'))).sort(), ['base-a', 'base-b', 'final-green', 'resized', 'same-source-new-generation']);
    client.snapshot('before-public-dispose');
    const dispose = await client.success('dispose'); assert.deepEqual(dispose, { disposed: true }); report.dispose = dispose;
    client.child.stdin.end();
    const exit = await bounded(client.exit.promise, 7000, 'CLI did not exit after successful disposal');
    assert.deepEqual([exit.code, exit.signal], [0, null]); assert.equal(client.stderrBytes, 0); if (client.failure) throw client.failure;
    assert.deepEqual([...client.parser.ids].sort((a, b) => a - b), client.requests.map(value => value.request.id));
    assert.equal(client.responses.length, client.requests.length); report.terminalResponses = client.responses.length;
    report.status = 'passed';
  } catch (error) { primaryError = error; report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    clearTimeout(timer); process.off('SIGINT', abort); process.off('SIGTERM', abort);
    if (client) {
      try {
        report.cleanup = await client.cleanup();
        const seen = new Map(report.process.snapshots.flatMap(snapshot => snapshot.rows).map(row => [row.pid, row.command]));
        report.cleanup.remainingObservedOwnedProcesses = processRows().filter(row => seen.get(row.pid) === row.command);
        assert.deepEqual(report.cleanup.remainingObservedOwnedProcesses, []);
        if (report.status === 'passed') { assert.deepEqual(report.cleanup.signals, []); assert.deepEqual([report.cleanup.exit.code, report.cleanup.exit.signal], [0, null]); }
      } catch (error) { report.status = 'failed'; report.cleanupError = { message: error.message }; primaryError ??= error; }
      try { await client.save(); }
      catch (error) { report.status = 'failed'; report.logWriteError = { message: error.message }; primaryError ??= error; }
    }
    try {
      const after = await checkInputs(); assert.equal(after.manifestSha256, report.inputs.manifestSha256); report.preparedInputsUnchanged = true;
      if (client) assert.deepEqual((await readdir(join(output, 'project'))).sort(), ['live-scene.json', 'unsupported.json']);
    } catch (error) { report.status = 'failed'; report.inputVerificationError = { message: error.message }; primaryError ??= error; }
    report.finishedAt = new Date().toISOString();
    await writeFile(join(output, 'workflow-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify({ status: report.status, reportPath: join(output, 'workflow-report.json'), totalSubmittedFrames: report.totalSubmittedFrames, captures: report.captures.length, distinctSessionIds: report.distinctSessionIds, browserLifetimes: report.browserLifetimes }));
  if (primaryError) process.exitCode = 1;
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--self-test') selfTest();
else {
  const mode = args[0] ?? '--run'; assert.ok(mode === '--prepare' || mode === '--run'); assert.ok(args.length <= 2);
  const directory = args[1] ?? process.env.STRATA_PREVIEW_CHECK_OUTPUT; assert.ok(directory && isAbsolute(directory), 'An absolute external evidence directory is required.');
  output = resolve(directory); await mkdir(output, { recursive: true });
  if (mode === '--prepare') await prepare(); else await run();
}
