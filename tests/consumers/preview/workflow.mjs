import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { canonicalJson, createProceduralScene, sceneRevision } from '@strata-engine/authoring';
import { prepareAuthoredPreviewLoad, PreviewSession } from '@strata-engine/preview';

const help = spawnSync(resolve('node_modules', '.bin', 'strata-preview'), ['--help'], {
  encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
});
if (help.error) throw help.error;
assert.equal(help.status, 0, `Packed CLI help failed: ${help.stdout}\n${help.stderr}`);
assert.equal(JSON.parse(help.stdout).status, 'help');
assert.equal(JSON.parse(help.stdout).usage.help, 'strata-preview --help');

// A valid tiny PNG encoder for this fake driver only; no browser, GPU, or renderer is used.
function png(width, height) {
  function chunk(type, data) {
    const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height, 255);
  for (let row = 0; row < height; row++) rows[row * (width * 4 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

class CpuFixtureDriver {
  width = 1;
  height = 1;
  generation = 0;
  frameId = 0;
  lastSubmittedFrameId = null;
  commit = null;
  status = 'ready';
  disposeCalls = 0;
  fenceCalls = 0;
  scene = null;

  prepareLoad(input) {
    return prepareAuthoredPreviewLoad(input);
  }

  async observe() {
    return structuredClone({
      status: this.status, commit: this.commit, width: this.width, height: this.height,
      lastSubmittedFrameId: this.lastSubmittedFrameId,
      telemetry: { source: 'cpu-fixture', submittedFrames: this.frameId, gpuSamples: { available: false, reason: 'No GPU in packed CPU fixture' } },
      environment: { driver: 'cpu-fixture', browser: null, adapter: null },
      gpuTimingUnavailableReason: 'CPU fake driver; no GPU',
    });
  }

  async setScene(scene, signal) {
    signal.throwIfAborted();
    this.scene = structuredClone(scene);
    this.commit = { generation: ++this.generation, source: 'cpu-fixture', sourceRevision: scene.sourceRevision };
    this.lastSubmittedFrameId = null;
    return structuredClone(this.commit);
  }

  async render(view, signal) {
    signal.throwIfAborted();
    this.lastSubmittedFrameId = ++this.frameId;
    return structuredClone({
      commit: this.commit, frameId: this.frameId, width: this.width, height: this.height,
      resolvedView: { ...view, viewport: { width: this.width, height: this.height } },
      metrics: { frameId: this.frameId, source: 'cpu-fixture', gpuSamples: { available: false, reason: 'CPU orchestration test' } },
    });
  }

  async resize(width, height, signal) { signal.throwIfAborted(); this.width = width; this.height = height; }
  async waitForIdle(signal) { signal.throwIfAborted(); this.fenceCalls++; }
  async screenshot(signal) { signal.throwIfAborted(); return png(this.width, this.height); }
  async dispose() { this.disposeCalls++; this.status = 'disposed'; }
}

const outputDirectory = resolve('captures');
await mkdir(outputDirectory);
const driver = new CpuFixtureDriver();
const session = new PreviewSession(driver);
const scene = createProceduralScene('packed-preview');
const originalScene = structuredClone(scene);
const revision = sceneRevision(scene);
const explicitView = () => ({
  camera: { position: [0, 1, 3], rotation: [0, 0, 0, 1], projection: { kind: 'perspective', verticalFovRadians: Math.PI / 3, near: 0.1, far: 100 } },
  light: { directionToLight: [0, 1, 0], radiance: [2, 2, 2] }, background: [0.05, 0.1, 0.15],
});
const view = explicitView();
const expectedDescriptor = prepareAuthoredPreviewLoad({ scene: originalScene, revision, view }).scene;
const request = ready => ({ expectedRevision: ready.sourceRevision, expectedLoadId: ready.loadId, expectedViewRevision: ready.viewRevision, outputDirectory });

assert.equal((await session.observe()).state, 'unready');
await assert.rejects(session.load({ scene, revision: 'wrong-revision', view }), { code: 'PREVIEW_SOURCE_REVISION_MISMATCH' });
assert.equal(driver.generation, 0);
const loading = session.load({ scene, revision, view });
scene.entities[0].transform.position[0] = 99;
view.camera.position[0] = 99;
const loaded = await loading;
assert.deepEqual(driver.scene, expectedDescriptor, 'Public load must keep the verified source lowering and synchronous snapshot');
assert.equal(loaded.resolvedView.camera.position[0], 0);
assert.equal(loaded.sourceRevision, revision);
assert.equal(loaded.commit.generation, 1);
assert.equal((await session.observe()).state, 'ready');

async function verifyPublication(result, width, height) {
  const bytes = await readFile(result.imagePath);
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.deepEqual(receipt, result.receipt);
  assert.equal(await readFile(result.receiptPath, 'utf8'), canonicalJson(receipt));
  assert.equal(receipt.format, 'strata.preview.capture');
  assert.equal(receipt.version, 1);
  assert.equal(receipt.image.width, width);
  assert.equal(receipt.image.height, height);
  assert.equal(receipt.image.relativePath, 'image.png');
  assert.equal(receipt.image.bytes, bytes.length);
  assert.equal(receipt.image.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(bytes, png(width, height));
  assert.equal(receipt.sourceRevision, revision);
  assert.equal(receipt.presentedFrameId, null);
  assert.equal(receipt.environment.driver, 'cpu-fixture');
  assert.equal(receipt.gpuCompletion.fencedThroughFrameId, receipt.submittedFrameIds.at(-1));
  assert.deepEqual(receipt.frames.map(frame => frame.frameId), receipt.submittedFrameIds);
  assert.deepEqual(receipt.gpuTimings.map(timing => timing.frameId), receipt.submittedFrameIds);
  assert.ok(receipt.gpuTimings.every(timing => timing.samples.length === 0 && timing.unavailableReason === 'CPU fake driver; no GPU'));
  assert.deepEqual(receipt.resolvedView.viewport, { width, height });
  assert.deepEqual(receipt.resolvedView.camera, explicitView().camera);
  assert.deepEqual(receipt.resolvedView.light, explicitView().light);
  assert.deepEqual(result.cleanupWarnings, []);
  return receipt;
}

const first = await session.capture({ ...request(loaded), captureId: 'first', frames: 2 });
const firstReceipt = await verifyPublication(first, 1, 1);
assert.equal(firstReceipt.submittedFrameIds.length, 2);
const firstBytes = await readFile(first.receiptPath);
await assert.rejects(session.capture({ ...request(loaded), captureId: 'first' }), { code: 'PREVIEW_OUTPUT_EXISTS' });
assert.deepEqual(await readFile(first.receiptPath), firstBytes);
assert.equal((await session.observe()).state, 'ready', 'Output failure must not make a healthy renderer unavailable');

const resized = await session.resize(2, 1);
assert.equal(resized.loadId, loaded.loadId);
assert.notEqual(resized.viewRevision, loaded.viewRevision);
await assert.rejects(session.capture({ ...request(loaded), captureId: 'stale-view' }), { code: 'PREVIEW_STALE_STATE' });
const resizedCapture = await session.capture({ ...request(resized), captureId: 'resized' });
await verifyPublication(resizedCapture, 2, 1);

const reloaded = await session.load({ scene: originalScene, revision, view: explicitView() });
assert.equal(reloaded.sourceRevision, resized.sourceRevision);
assert.notEqual(reloaded.loadId, resized.loadId, 'Reloading identical source still requires a new committed load identity');
assert.equal(reloaded.commit.generation, 2);
await assert.rejects(session.capture({ ...request(resized), captureId: 'stale-load' }), { code: 'PREVIEW_STALE_STATE' });
const finalCapture = await session.capture({ ...request(reloaded), captureId: 'after-reload' });
await verifyPublication(finalCapture, 2, 1);
assert.deepEqual(await readdir(outputDirectory), ['after-reload', 'first', 'resized']);
assert.ok(driver.fenceCalls >= 6);

await Promise.all([session.dispose(), session.dispose()]);
assert.equal(driver.disposeCalls, 1);
assert.equal((await session.observe()).state, 'disposed');
await assert.rejects(session.load({ scene: originalScene, revision, view: explicitView() }), { code: 'PREVIEW_DISPOSED' });
console.log('Preview consumer: Core-validated source lowering/snapshot, native PNG+receipt capture, stale tokens, resize, reload identity, recovery and disposal passed with CPU fake driver');
