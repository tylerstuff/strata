import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
import { applySceneBatch, canonicalJson, createProceduralScene, sceneRevision, serializeScene } from '@strata-engine/authoring';
import { createPreviewSession } from '@strata-engine/preview';

// This fixture runs only from installed archives in a temporary consumer. All
// scene documents, PNGs, receipts and reports stay in the external evidence path.
assert.ok(process.env.STRATA_PREVIEW_CHECK_OUTPUT, 'Run through scripts/test-preview-browser.mjs');
const output = resolve(process.env.STRATA_PREVIEW_CHECK_OUTPUT);
const captureDirectory = join(output, 'api-captures');
await mkdir(captureDirectory);
const controller = new AbortController();
const abort = () => controller.abort();
process.on('SIGINT', abort);
process.on('SIGTERM', abort);
const options = {
  width: 512, height: 512, channel: process.env.STRATA_TEST_BROWSER_CHANNEL ?? 'chromium',
  headless: process.env.STRATA_TEST_HEADED !== '1', softwareGpu: process.env.STRATA_TEST_SOFTWARE_GPU === '1',
  timeoutMs: 60_000, signal: controller.signal,
};
const operation = { timeoutMs: 60_000, signal: controller.signal };
const report = {
  format: 'strata.preview.browser-workflow', version: 1, status: 'running',
  purpose: 'Correctness of packaged preview orchestration, not a performance or numeric PBR oracle.',
  captures: [], checks: [], totalSubmittedFrames: 0,
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

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
const firstScene = createProceduralScene('preview-browser-box', 'Packed preview correctness box');
firstScene.entities[0].transform.position = [-0.55, 0, 0];
firstScene.materials[0].baseColor = [0.8, 0.015, 0.015, 1];
const revisionA = sceneRevision(firstScene);
const editBatch = {
  format: 'strata.scene-edit', version: 1, expectedRevision: revisionA,
  operations: [
    { op: 'set-entity', value: { ...firstScene.entities[0], transform: { ...firstScene.entities[0].transform, position: [0.55, 0, 0] } } },
    { op: 'set-material', value: { ...firstScene.materials[0], baseColor: [0.015, 0.8, 0.015, 1] } },
  ],
};
const edited = applySceneBatch(firstScene, editBatch);
assert.ok(edited.ok, `Installed authoring edit failed: ${JSON.stringify(edited)}`);
assert.equal(edited.value.changed, true);
assert.equal(edited.value.baseRevision, revisionA);
assert.equal(edited.value.changes.length, 2);
const secondScene = edited.value.scene, revisionB = edited.value.revision;
assert.equal(sceneRevision(secondScene), revisionB);
assert.equal(sceneRevision(firstScene), revisionA, 'Edit API must retain the original snapshot');
assert.notEqual(revisionA, revisionB);
await writeFile(join(output, 'scene-a.json'), serializeScene(firstScene));
await writeFile(join(output, 'scene-b.json'), serializeScene(secondScene));
await writeFile(join(output, 'edit-a-to-b.json'), canonicalJson(editBatch));
await writeFile(join(output, 'edit-a-to-b-preview.json'), canonicalJson(edited.value));
await writeFile(join(output, 'view-base-color.json'), canonicalJson(view()));
await writeFile(join(output, 'view-final.json'), canonicalJson(view('final')));

function request(ready, captureId) {
  return { outputDirectory: captureDirectory, captureId, frames: 1,
    expectedRevision: ready.sourceRevision, expectedLoadId: ready.loadId, expectedViewRevision: ready.viewRevision };
}
function underOutput(path) {
  assert.ok(isAbsolute(path));
  const local = relative(output, path);
  assert.ok(local !== '' && !local.startsWith('..') && !isAbsolute(local), `Artifact escaped external output: ${path}`);
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

let session;
try {
  session = await createPreviewSession(options);
  assert.equal((await session.observe()).state, 'unready');
  const mutableScene = structuredClone(firstScene), mutableView = view();
  const pending = session.load({ scene: mutableScene, revision: revisionA, view: mutableView }, operation);
  mutableScene.entities[0].transform.position[0] = 20;
  mutableScene.materials[0].baseColor = [0, 0, 1, 1];
  mutableView.camera.position[0] = 20;
  const first = await pending;
  assert.equal(first.sourceRevision, revisionA);
  assert.deepEqual(first.resolvedView.camera, view().camera);
  assert.throws(() => { first.resolvedView.camera.position[0] = 99; }, TypeError, 'Ready receipt should be an immutable snapshot');
  const a = await verifyPublication(await session.capture(request(first, 'base-a'), operation), first, 512, 512, 'base-a');
  report.checks.push({ name: 'synchronous input snapshot and red box region', evidence: baseColorEvidence(a.image, red, -1) });

  const second = await session.load({ scene: secondScene, revision: revisionB, view: view() }, operation);
  assert.ok(second.commit.sceneGeneration > first.commit.sceneGeneration);
  assert.notEqual(second.loadId, first.loadId);
  await assert.rejects(session.capture(request(first, 'stale-revision'), operation), { code: 'PREVIEW_STALE_STATE' });
  const b = await verifyPublication(await session.capture(request(second, 'base-b'), operation), second, 512, 512, 'base-b');
  const bEvidence = baseColorEvidence(b.image, green, 1);
  assert.ok(region(b.image, whole, red).coverage < 0.001, 'The new material must replace old red pixels');
  assert.ok(bEvidence.object.centroid[0] - region(a.image, whole, red).centroid[0] > 120, 'Authored translation must visibly move the object');
  report.checks.push({ name: 'installed authoring edit API validates a second revision changing transform and material',
    evidence: { image: bEvidence, baseRevision: edited.value.baseRevision, revision: edited.value.revision, changedIds: edited.value.changes.map(change => change.id) } });

  const beforeRejected = await session.observe();
  const external = structuredClone(secondScene);
  external.assets.push({ id: 'unsupported-model', kind: 'external', uri: 'https://invalid.example/never-fetch.glb', mediaType: 'model/gltf-binary' });
  await assert.rejects(session.load({ scene: external, revision: sceneRevision(external), view: view() }, operation), { code: 'PREVIEW_UNSUPPORTED_ASSET' });
  const afterRejected = await session.observe();
  assert.equal(afterRejected.state, 'ready');
  assert.deepEqual(afterRejected.ready, beforeRejected.ready);
  assert.deepEqual(afterRejected.driver.commit, beforeRejected.driver.commit);
  assert.equal(afterRejected.driver.lastSubmittedFrameId, beforeRejected.driver.lastSubmittedFrameId);
  report.checks.push({ name: 'unsupported unused external asset retains previous ready scene without a frame', passed: true });

  const same = await session.load({ scene: secondScene, revision: revisionB, view: view() }, operation);
  assert.equal(same.sourceRevision, second.sourceRevision);
  assert.ok(same.commit.sceneGeneration > second.commit.sceneGeneration);
  assert.notEqual(same.loadId, second.loadId);
  await assert.rejects(session.capture(request(second, 'stale-load'), operation), { code: 'PREVIEW_STALE_STATE' });
  const sameCapture = await verifyPublication(await session.capture(request(same, 'same-source-new-generation'), operation), same, 512, 512, 'same-source-new-generation');
  baseColorEvidence(sameCapture.image, green, 1);
  assert.ok(sameCapture.image.pixels.equals(b.image.pixels), 'Identical deterministic source/view must retain identical pixels across a new generation');
  report.checks.push({ name: 'same-source new generation rejects stale load identity and preserves pixels', passed: true });

  const resized = await session.resize(640, 360, operation);
  assert.equal(resized.loadId, same.loadId);
  assert.notEqual(resized.viewRevision, same.viewRevision);
  await assert.rejects(session.capture(request(same, 'stale-view'), operation), { code: 'PREVIEW_STALE_STATE' });
  const resizeCapture = await verifyPublication(await session.capture(request(resized, 'resized'), operation), resized, 640, 360, 'resized');
  const resizedBox = region(resizeCapture.image, whole, green);
  assert.ok(resizedBox.coverage > 0.025 && resizedBox.coverage < 0.09);
  assert.ok(resizedBox.centroid[0] > 360 && resizedBox.centroid[0] < 390);
  assert.ok(Math.abs(resizedBox.centroid[1] - 180) < 5);
  assert.ok(region(resizeCapture.image, [0.57, 0.43, 0.61, 0.57], green).coverage > 0.95);
  report.checks.push({ name: 'resize changes physical dimensions, aspect and view identity', evidence: resizedBox });

  const finalA = await session.load({ scene: secondScene, revision: revisionB, view: view('final') }, operation);
  const finalCaptureA = await verifyPublication(await session.capture(request(finalA, 'final-green'), operation), finalA, 640, 360, 'final-green');
  const finalEditBatch = { format: 'strata.scene-edit', version: 1, expectedRevision: revisionB,
    operations: [{ op: 'set-material', value: { ...secondScene.materials[0], baseColor: [0.015, 0.015, 0.8, 1], metallic: 0.25, roughness: 0.5 } }] };
  const finalEdit = applySceneBatch(secondScene, finalEditBatch);
  assert.ok(finalEdit.ok, `Installed final material edit failed: ${JSON.stringify(finalEdit)}`);
  const thirdScene = finalEdit.value.scene, revisionC = finalEdit.value.revision;
  await writeFile(join(output, 'edit-b-to-c.json'), canonicalJson(finalEditBatch));
  await writeFile(join(output, 'scene-c-final.json'), serializeScene(thirdScene));
  const finalB = await session.load({ scene: thirdScene, revision: revisionC, view: view('final') }, operation);
  const finalCaptureB = await verifyPublication(await session.capture(request(finalB, 'final-blue'), operation), finalB, 640, 360, 'final-blue');
  const patch = [0.57, 0.43, 0.61, 0.57];
  const greenMean = region(finalCaptureA.image, patch).mean, blueMean = region(finalCaptureB.image, patch).mean;
  assert.ok(greenMean[1] > greenMean[0] + 50 && greenMean[1] > greenMean[2] + 50, `Final material should be green: ${greenMean}`);
  assert.ok(blueMean[2] > blueMean[0] + 50 && blueMean[2] > blueMean[1] + 50, `Final material should be blue: ${blueMean}`);
  assert.ok(greenMean.reduce((sum, value, index) => sum + Math.abs(value - blueMean[index]), 0) > 120, 'Final material edit must visibly change the object interior');
  report.checks.push({ name: 'final-mode material edit visibly changes lit object interior', evidence: { greenMean, blueMean } });
  const beforeDispose = await session.observe();
  assert.equal(beforeDispose.state, 'ready');
  assert.equal(beforeDispose.driver.telemetry.gpuErrorCount, 0);
  assert.equal(beforeDispose.driver.telemetry.submittedFrames, 12, 'Invalid/stale requests must not submit frames');
  report.apiSubmittedFrames = beforeDispose.driver.telemetry.submittedFrames;
  assert.deepEqual((await readdir(captureDirectory)).sort(), ['base-a', 'base-b', 'final-blue', 'final-green', 'resized', 'same-source-new-generation']);
  await Promise.all([session.dispose(), session.dispose()]);
  assert.equal((await session.observe()).state, 'disposed');
  await assert.rejects(session.load({ scene: firstScene, revision: revisionA, view: view() }), { code: 'PREVIEW_DISPOSED' });
  session = undefined;
  report.checks.push({ name: 'API session disposed before CLI browser starts', passed: true });

  controller.signal.throwIfAborted();
  const args = ['capture', '--scene', join(output, 'scene-a.json'), '--view', join(output, 'view-base-color.json'),
    '--output', join(output, 'cli-captures'), '--width', '512', '--height', '512', '--frames', '1', '--timeout-ms', '60000', '--browser', options.channel];
  if (!options.headless) args.push('--headed');
  if (options.softwareGpu) args.push('--software-gpu');
  const cliPath = resolve('node_modules/.bin/strata-preview');
  let cli;
  try {
    cli = await promisify(execFile)(cliPath, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024, signal: controller.signal });
  } catch (error) {
    await writeFile(join(output, 'cli.stdout.json'), error.stdout ?? '');
    await writeFile(join(output, 'cli.stderr.txt'), error.stderr ?? '');
    throw error;
  }
  await writeFile(join(output, 'cli.stdout.json'), cli.stdout);
  await writeFile(join(output, 'cli.stderr.txt'), cli.stderr);
  assert.equal(cli.stderr, '', 'Installed CLI must produce clean stderr on success');
  const result = JSON.parse(cli.stdout); // Whole-stream parse rejects banners or a second result.
  assert.equal(cli.stdout, canonicalJson(result), 'CLI must emit exactly one canonical JSON document');
  assert.equal(result.status, 'captured'); assert.equal(result.publicationOccurred, true);
  assert.equal(result.error, undefined); assert.equal(result.cleanupWarnings, undefined);
  assert.equal(result.receipt.sourceRevision, revisionA);
  assert.notEqual(result.receipt.sessionId, first.sessionId, 'CLI must create an independent session');
  const cliCapture = await verifyPublication(result, { ...result.receipt, sceneId: firstScene.id, sourceRevision: revisionA }, 512, 512, 'installed-cli', 1);
  baseColorEvidence(cliCapture.image, red, -1);
  assert.equal(result.receipt.telemetry.submittedFrames, 2);
  report.cliSubmittedFrames = result.receipt.telemetry.submittedFrames;
  report.totalSubmittedFrames = report.apiSubmittedFrames + report.cliSubmittedFrames;
  report.checks.push({ name: 'installed one-shot CLI produces one clean result with verified red-box PNG and receipt', passed: true });
  report.status = 'passed';
  console.log('Packed preview browser correctness passed: two authored revisions, snapshots, regions/colors, same-source identity, stale tokens, resize, final material edit, receipts, GPU errors, disposal and installed CLI.');
} catch (error) {
  report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack };
  throw error;
} finally {
  try { if (session) await session.dispose(); }
  catch (error) { report.status = 'failed'; report.cleanupError = { message: error.message }; throw error; }
  finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    await writeFile(join(output, 'workflow-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
}
