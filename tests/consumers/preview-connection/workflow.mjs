import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdir, readFile, readdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import { canonicalJson, createProceduralScene, createSceneFile, editSceneFile, sceneRevision } from '@strata-engine/authoring';
import { prepareAuthoredPreviewLoad, PreviewSession, publishCapture } from '@strata-engine/preview';
import { createPreviewConnection, runPreviewConnectionStdio, PREVIEW_CONNECTION_LIMITS, PREVIEW_CONNECTION_VERSION } from '@strata-engine/preview/connection';

// Run only from the isolated archive installation. All images below are tiny
// synthetic PNGs; this verifies orchestration/publication, never rendered pixels.
const fixtureRoot = resolve('connection-fixture');
const projectRoot = join(fixtureRoot, 'project');
const outputRoot = join(fixtureRoot, 'captures');
await mkdir(join(projectRoot, 'nested'), { recursive: true });
await mkdir(outputRoot);
const scene = createProceduralScene('packed-connection');
const scenePath = join(projectRoot, 'nested', 'scene.json');
await createSceneFile(scenePath, scene);
const revision = sceneRevision(scene);
const unsupported = structuredClone(scene);
unsupported.assets.push({ id: 'external-reference', kind: 'external', uri: 'missing.glb', mediaType: 'model/gltf-binary' });
await createSceneFile(join(projectRoot, 'unsupported.json'), unsupported);
await createSceneFile(join(fixtureRoot, 'outside.json'), scene);
await symlink(join(fixtureRoot, 'outside.json'), join(projectRoot, 'linked.json'));
const view = () => ({
  camera: { position: [0, 1, 3], rotation: [0, 0, 0, 1], projection: { kind: 'perspective', verticalFovRadians: Math.PI / 3, near: 0.1, far: 100 } },
  light: { directionToLight: [0, 1, 0], radiance: [2, 2, 2] }, background: [0.05, 0.1, 0.15],
});
const envelope = (id, method, params = {}) => ({ version: 1, id, method, params });

const cliPath = resolve('node_modules', '.bin', 'strata-preview-connection');
function cli(args, input = '') {
  const result = spawnSync(cliPath, args, { input, encoding: 'utf8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `Installed CLI was terminated: ${result.stderr}`);
  return result;
}
const startup = ['--project-root', projectRoot, '--output-root', outputRoot];
const help = cli(['--help']);
assert.equal(help.status, 0); assert.equal(help.stderr, '');
assert.equal(help.stdout.trim().split('\n').length, 1);
assert.equal(JSON.parse(help.stdout).status, 'help');
assert.equal(JSON.parse(help.stdout).usage.help, 'strata-preview-connection --help');
const usage = cli(['--unknown']);
assert.equal(usage.status, 2); assert.equal(usage.stdout, '');
assert.equal(JSON.parse(usage.stderr).error.code, 'CONNECTION_CLI_USAGE');
const missingRoot = cli(['--project-root', join(fixtureRoot, 'absent'), '--output-root', outputRoot]);
assert.equal(missingRoot.status, 1); assert.equal(missingRoot.stdout, '');
assert.equal(JSON.parse(missingRoot.stderr).error.code, 'CONNECTION_ROOT_INVALID');
const protocol = cli(startup, [
  JSON.stringify(envelope(1, 'discover')), JSON.stringify(envelope(2, 'unknown')),
  JSON.stringify(envelope(3, 'load')), '{invalid-json',
].join('\n') + '\n');
assert.equal(protocol.status, 0, protocol.stderr); assert.equal(protocol.stderr, '');
const lines = protocol.stdout.trim().split('\n').map(line => JSON.parse(line));
assert.equal(lines.length, 4, 'Exactly one response per request/framing failure');
assert.equal(lines.find(line => line.id === 1).result.protocol, 'strata.preview.connection');
assert.equal(lines.find(line => line.id === 2).error.code, 'CONNECTION_METHOD');
assert.equal(lines.find(line => line.id === 3).error.code, 'CONNECTION_INVALID_REQUEST');
assert.equal(lines.find(line => line.id === null).error.code, 'CONNECTION_INVALID_JSON');
const eof = cli(startup);
assert.equal(eof.status, 0); assert.equal(eof.stdout, ''); assert.equal(eof.stderr, '');

const deferreds = new Set();
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  const result = { promise, resolve }; deferreds.add(result); return result;
}
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000); })]); }
  finally { clearTimeout(timer); }
}
function png(width, height) {
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height, 255);
  for (let row = 0; row < height; row++) rows[row * (width * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

class CpuDriver {
  width = 2; height = 2; generation = 0; frameId = 0; lastSubmittedFrameId = null;
  status = 'ready'; commit = null; scene = null; disposeCalls = 0; fenceCalls = 0; nextLoad = null;
  prepareLoad(input) { return prepareAuthoredPreviewLoad(input); }
  async observe() {
    return structuredClone({ status: this.status, commit: this.commit, width: this.width, height: this.height,
      lastSubmittedFrameId: this.lastSubmittedFrameId,
      telemetry: { source: 'cpu-connection-fixture', submittedFrames: this.frameId },
      environment: { driver: 'cpu-connection-fixture', browser: null, adapter: null },
      gpuTimingUnavailableReason: 'CPU fake driver; no GPU' });
  }
  holdLoad() { const hold = { entered: deferred(), release: deferred(), signal: null }; this.nextLoad = hold; return hold; }
  async setScene(value, signal) {
    const hold = this.nextLoad; this.nextLoad = null;
    if (hold) { hold.signal = signal; hold.entered.resolve(); await hold.release.promise; }
    // Deliberately keep ownership after cancellation until the held work settles.
    signal.throwIfAborted();
    this.scene = structuredClone(value);
    this.commit = { generation: ++this.generation, source: 'cpu-fixture', sourceRevision: value.sourceRevision };
    this.lastSubmittedFrameId = null;
    return structuredClone(this.commit);
  }
  async render(value, signal) {
    signal.throwIfAborted(); assert.equal(this.status, 'ready');
    this.lastSubmittedFrameId = ++this.frameId;
    return structuredClone({ commit: this.commit, frameId: this.frameId, width: this.width, height: this.height,
      resolvedView: { ...value, viewport: { width: this.width, height: this.height } },
      metrics: { frameId: this.frameId, source: 'cpu-connection-fixture' } });
  }
  async resize(width, height, signal) { signal.throwIfAborted(); this.width = width; this.height = height; }
  async waitForIdle(signal) { signal.throwIfAborted(); this.fenceCalls++; }
  async screenshot(signal) { signal.throwIfAborted(); return png(this.width, this.height); }
  async dispose() { this.disposeCalls++; this.status = 'disposed'; }
}

const driver = new CpuDriver();
let publicationHold = null, factoryCalls = 0;
const session = new PreviewSession(driver, { defaultTimeoutMs: 3000, cleanupTimeoutMs: 2000,
  publish: options => publishCapture(options, {
    publishReceipt: async (temporary, target) => {
      const hold = publicationHold;
      if (hold) { publicationHold = null; hold.target = target; hold.entered.resolve(); await hold.release.promise; }
      await link(temporary, target);
    },
  }),
});
const connection = await createPreviewConnection({ projectRoot, outputRoot, width: 2, height: 2, timeoutMs: 3000, cleanupTimeoutMs: 2000 }, {
  createSession: options => {
    factoryCalls++;
    assert.equal(options.width, 2); assert.equal(options.height, 2);
    assert.equal(options.signal.aborted, false);
    return session;
  },
});
assert.equal(factoryCalls, 0);
assert.equal(PREVIEW_CONNECTION_VERSION, 1);
assert.equal(PREVIEW_CONNECTION_LIMITS.mutations, 1);
const input = new PassThrough(), output = new PassThrough();
const waiting = new Map(), responseOrder = [];
const decoder = new TextDecoder();
let carry = '', nextId = 0;
output.on('data', bytes => {
  carry += decoder.decode(bytes, { stream: true });
  while (carry.includes('\n')) {
    const end = carry.indexOf('\n'), line = carry.slice(0, end); carry = carry.slice(end + 1);
    assert.ok(Buffer.byteLength(line) + 1 <= PREVIEW_CONNECTION_LIMITS.responseBytes);
    const response = JSON.parse(line), waiter = waiting.get(response.id);
    assert.equal(response.version, 1); assert.ok(waiter, `Unexpected or duplicate response ID: ${response.id}`);
    waiting.delete(response.id); responseOrder.push(response.id); waiter.resolve(response);
  }
});
const transport = runPreviewConnectionStdio({ connection, input, output, writeTimeoutMs: 2000 });
void transport.catch(error => { for (const waiter of waiting.values()) waiter.reject(error); });
function send(method, params = {}, fragmented = false) {
  const id = ++nextId;
  const promise = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
  const bytes = Buffer.from(JSON.stringify(envelope(id, method, params)) + '\n');
  if (fragmented) { input.write(bytes.subarray(0, 7)); input.write(bytes.subarray(7)); }
  else input.write(bytes);
  return { id, promise: bounded(promise, `response ${id}:${method}`) };
}
async function call(method, params = {}) { return send(method, params).promise; }
function ok(response) { assert.equal(response.ok, true, JSON.stringify(response)); return response.result; }
function rejected(response, code) { assert.equal(response.ok, false, JSON.stringify(response)); assert.equal(response.error.code, code); return response.error; }
async function settled() {
  for (let attempt = 0; attempt < 100; attempt++) {
    await delay(10);
    const state = ok(await call('inspect'));
    if (!state.activeRequests.some(work => work.method !== 'inspect') && state.observation?.state !== 'busy') return state;
  }
  throw new Error('Connection retained unsettled work unexpectedly');
}
const load = (expectedRevision = revision, selectedPath = 'nested/scene.json') => ({ scenePath: selectedPath, expectedRevision, view: view() });
const tokens = ready => ({ expectedRevision: ready.sourceRevision, expectedLoadId: ready.loadId, expectedViewRevision: ready.viewRevision });
async function verifyPublication(value, ready, width, height) {
  assert.equal(value.publicationOccurred, true);
  const bytes = await readFile(value.imagePath), text = await readFile(value.receiptPath, 'utf8'), receipt = JSON.parse(text);
  assert.equal(text, canonicalJson(receipt)); assert.deepEqual(receipt, value.receipt);
  assert.equal(receipt.format, 'strata.preview.capture'); assert.equal(receipt.version, 1);
  assert.equal(receipt.sourceRevision, ready.sourceRevision); assert.equal(receipt.loadId, ready.loadId);
  assert.equal(receipt.viewRevision, ready.viewRevision); assert.deepEqual(receipt.commit, ready.commit);
  assert.equal(receipt.presentedFrameId, null); assert.equal(receipt.environment.browser, null);
  assert.equal(receipt.image.width, width); assert.equal(receipt.image.height, height);
  assert.equal(receipt.image.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(receipt.image.bytes, bytes.length); assert.deepEqual(bytes, png(width, height));
  assert.deepEqual(receipt.resolvedView.viewport, { width, height });
  assert.equal(receipt.gpuCompletion.fencedThroughFrameId, receipt.submittedFrameIds.at(-1));
  assert.deepEqual(receipt.frames.map(frame => frame.frameId), receipt.submittedFrameIds);
  assert.ok(receipt.gpuTimings.every(sample => sample.samples.length === 0 && sample.unavailableReason === 'CPU fake driver; no GPU'));
  assert.deepEqual(value.cleanupWarnings, []);
  assert.ok(value.imagePath.startsWith(outputRoot + '/')); assert.ok(value.receiptPath.startsWith(outputRoot + '/'));
  return receipt;
}

try {
  const discovery = ok(await send('discover', {}, true).promise);
  assert.equal(discovery.protocol, 'strata.preview.connection'); assert.equal(discovery.transport, 'stdio-jsonl');
  assert.equal(discovery.projectRoot, projectRoot); assert.equal(discovery.outputRoot, outputRoot);
  assert.deepEqual(Object.keys(discovery.methods).sort(), ['cancel', 'capture', 'discover', 'dispose', 'inspect', 'load', 'resize']);
  assert.equal(ok(await call('inspect')).observation, null); assert.equal(factoryCalls, 0);
  rejected(await call('load', load('wrong-revision')), 'PREVIEW_SOURCE_REVISION_MISMATCH'); await settled();
  rejected(await call('load', load(revision, '../outside.json')), 'CONNECTION_SCENE_PATH'); await settled();
  rejected(await call('load', load(revision, 'linked.json')), 'CONNECTION_SCENE_PATH'); await settled();
  const missing = rejected(await call('load', load(revision, 'missing.json')), 'CONNECTION_SCENE_INPUT');
  assert.ok(missing.details.source.endsWith('/missing.json')); await settled();
  rejected(await call('load', load(sceneRevision(unsupported), 'unsupported.json')), 'PREVIEW_UNSUPPORTED_ASSET'); await settled();
  assert.equal(factoryCalls, 0, 'Invalid rooted/profile inputs must not initialize a browser/session');
  let ready = ok(await call('load', load())); await settled();
  assert.equal(factoryCalls, 1); assert.equal(ready.sourceRevision, revision); assert.equal(ready.commit.generation, 1);
  assert.deepEqual(driver.scene, prepareAuthoredPreviewLoad({ scene, revision, view: view() }).scene);
  assert.equal(ok(await call('inspect')).observation.state, 'ready');
  const first = ok(await call('capture', { ...tokens(ready), captureId: 'first', frames: 2 })); await settled();
  await verifyPublication(first, ready, 2, 2);
  const firstReceipt = await readFile(first.receiptPath);
  rejected(await call('capture', { ...tokens(ready), captureId: 'first' }), 'PREVIEW_OUTPUT_EXISTS');
  assert.equal((await settled()).observation.state, 'ready');
  assert.deepEqual(await readFile(first.receiptPath), firstReceipt);
  const resized = ok(await call('resize', { width: 3, height: 2 })); await settled();
  assert.equal(resized.loadId, ready.loadId); assert.notEqual(resized.viewRevision, ready.viewRevision);
  rejected(await call('capture', { ...tokens(ready), captureId: 'stale' }), 'PREVIEW_STALE_STATE'); await settled();
  ready = resized;

  const hold = driver.holdLoad(), loading = send('load', load());
  await bounded(hold.entered.promise, 'delayed setScene admission');
  const cancellation = ok(await call('cancel', { requestId: loading.id }));
  assert.equal(cancellation.cancellationRequested, true); assert.equal(cancellation.settled, false);
  rejected(await loading.promise, 'PREVIEW_ABORTED'); assert.equal(hold.signal.aborted, true);
  rejected(await call('resize', { width: 4, height: 2 }), 'PREVIEW_BUSY');
  assert.equal(ok(await call('inspect')).observation.state, 'busy');
  assert.equal(driver.generation, 1, 'Cancellation must not fabricate a new scene commit');
  hold.release.resolve();
  assert.equal((await settled()).observation.state, 'ready');
  assert.equal(driver.generation, 1);

  const publication = { entered: deferred(), release: deferred(), target: null };
  publicationHold = publication;
  const capturing = send('capture', { ...tokens(ready), captureId: 'publication-wins' });
  let captureTerminal = false; void capturing.promise.then(() => { captureTerminal = true; });
  await bounded(publication.entered.promise, 'native receipt publication');
  await assert.rejects(readFile(publication.target), { code: 'ENOENT' });
  const cancel = send('cancel', { requestId: capturing.id });
  assert.equal(ok(await cancel.promise).cancellationRequested, true);
  await delay(0); assert.equal(captureTerminal, false, 'Cancellation cannot resolve an in-flight publication as failure');
  publication.release.resolve();
  const published = ok(await capturing.promise); await settled();
  await verifyPublication(published, ready, 3, 2);
  assert.ok(responseOrder.indexOf(cancel.id) < responseOrder.indexOf(capturing.id), 'Control response must remain responsive during capture');

  const entity = structuredClone(scene.entities[0]); entity.transform.position[0] += 0.5;
  const edited = await editSceneFile(scenePath, { format: 'strata.scene-edit', version: 1, expectedRevision: revision, operations: [{ op: 'set-entity', value: entity }] });
  const editedBytes = await readFile(scenePath);
  const replacement = ok(await call('load', load(edited.revision))); await settled();
  assert.equal(factoryCalls, 1); assert.equal(replacement.sourceRevision, edited.revision);
  assert.notEqual(replacement.loadId, ready.loadId); assert.equal(replacement.commit.generation, 2);
  rejected(await call('capture', { ...tokens(ready), captureId: 'old-load' }), 'PREVIEW_STALE_STATE'); await settled();
  const editedCapture = ok(await call('capture', { ...tokens(replacement), captureId: 'edited' })); await settled();
  await verifyPublication(editedCapture, replacement, 3, 2);
  assert.deepEqual(await readFile(scenePath), editedBytes, 'Connection operations must not write scene files');
  assert.deepEqual((await readdir(outputRoot)).sort(), ['edited', 'first', 'publication-wins']);
  assert.equal(ok(await call('dispose')).disposed, true);
  await bounded(transport, 'disposed transport drain');
  assert.equal(connection.closing, true); assert.equal(driver.disposeCalls, 1);
  assert.equal(waiting.size, 0); assert.equal(carry, '');
  await connection.close(); assert.equal(driver.disposeCalls, 1);
  console.log('Connection consumer: installed CLI/help/errors/EOF, rooted shared authoring input, lazy initialization, real session capture/resize/reload, delayed cancellation ownership and native publication truth passed with CPU fakes');
} finally {
  for (const item of deferreds) item.resolve();
  await connection.close().catch(() => {});
  input.end();
  await bounded(transport, 'final transport cleanup').catch(() => {});
  input.destroy(); output.destroy();
}
