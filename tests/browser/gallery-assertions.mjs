import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const width = 640;
const height = 360;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function inside(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
}

async function externalOutput(directory) {
  assert.equal(typeof directory, 'string', 'An external outputDirectory is required.');
  assert.ok(isAbsolute(directory), 'outputDirectory must be absolute.');
  const target = resolve(directory);
  assert.ok(!inside(resolve(repository), target), 'Gallery evidence must stay outside the repository.');
  // Resolve existing ancestors before mkdir so a symlink cannot redirect a new
  // output directory into the checkout. Also reject other Git worktrees.
  let ancestor = target;
  const suffix = [];
  for (;;) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      assert.notEqual(parent, ancestor, 'Cannot resolve output directory ancestry.');
      suffix.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
  const canonicalTarget = resolve(ancestor, ...suffix);
  assert.ok(!inside(await realpath(repository), canonicalTarget), 'Output resolves into the repository.');
  for (let current = ancestor;; current = dirname(current)) {
    let git = false;
    try { await access(join(current, '.git')); git = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.equal(git, false, 'Gallery evidence must stay outside Git worktrees.');
    if (dirname(current) === current) break;
  }
  await mkdir(canonicalTarget, { recursive: true });
  assert.equal(await realpath(canonicalTarget), canonicalTarget, 'Output directory changed during creation.');
  const runDirectory = join(canonicalTarget, `gallery-${randomUUID()}`);
  await mkdir(runDirectory);
  return runDirectory;
}

function assertReady(state, modelId) {
  assert.equal(state.format, 'strata.gallery.state');
  assert.equal(state.version, 1);
  assert.equal(state.phase, 'ready', JSON.stringify(state.error));
  assert.equal(state.error, null);
  assert.equal(state.busy, null);
  assert.equal(state.modelId, modelId);
  assert.equal(state.requestedModelId, modelId);
  assert.ok(Number.isSafeInteger(state.engineEpoch) && state.engineEpoch > 0);
  assert.ok(Number.isSafeInteger(state.viewRevision) && state.viewRevision > 0);
  assert.ok(Number.isSafeInteger(state.frame?.frameId) && state.frame.frameId > 0, 'Core must report an actual submission.');
  assert.equal(state.telemetry?.submittedFrames, state.frame.frameId);
  assert.equal(state.telemetry.gpuErrorCount, 0, state.telemetry.lastGpuError ?? 'Uncaptured GPU error.');
  assert.ok(state.frame.drawCalls > 0 && state.frame.triangles > 0, 'The imported model must submit geometry.');
  assert.ok(Number.isFinite(state.frame.cpuSubmissionMs) && state.frame.cpuSubmissionMs >= 0);
  assert.equal(state.measurements.submittedFrameId, state.frame.frameId);
  assert.equal(state.submittedView.frameId, state.frame.frameId);
  assert.deepEqual(state.submittedView.controls, state.settings.effective);
  assert.equal(state.frame.imported?.sourceUrl, state.asset.sourceUrl, 'Core must identify the imported source actually submitted.');
  assert.deepEqual(state.frame.imported?.animation, {
    clipId: state.settings.animation.clipId, timeSeconds: state.settings.animation.timeSeconds, loop: state.settings.animation.loop,
  }, 'Core must report the effective submitted animation state.');
  assert.deepEqual(state.viewport, { width, height });
  assert.equal(state.settings.scenePreset, 'model-only');
  assert.equal(state.settings.debugView, 'final');
}

function frozenIdentity(state) {
  return {
    phase: state.phase, modelId: state.modelId, engineEpoch: state.engineEpoch,
    sceneCommit: state.sceneCommit, viewRevision: state.viewRevision,
    frameId: state.frame?.frameId, submittedFrames: state.telemetry?.submittedFrames,
    gpuErrorCount: state.telemetry?.gpuErrorCount, viewport: state.viewport,
    settings: state.settings, submittedView: state.submittedView, live: state.live, busy: state.busy,
  };
}

function assertFrozen(expected, actual) {
  assert.deepEqual(frozenIdentity(actual), frozenIdentity(expected), 'Frame, view or animation changed while capture was frozen.');
}

async function twoCallbacks(page) {
  await page.evaluate(() => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The page stopped delivering animation callbacks.')), 20_000);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timeout); resolve(); }));
  }));
}

function pngSize(png) {
  assert.ok(png.length > 100, 'Canvas screenshot must contain PNG data.');
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function captureGeometry(canvas) {
  const geometry = await canvas.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const viewportBox = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    const scroll = { x: window.scrollX, y: window.scrollY };
    return {
      intrinsic: { width: element.width, height: element.height },
      viewportBox, scroll,
      documentBox: { ...viewportBox, x: rect.x + scroll.x, y: rect.y + scroll.y },
      deviceScaleFactor: window.devicePixelRatio,
    };
  });
  assert.deepEqual(geometry.intrinsic, { width, height }, 'The drawing buffer must retain the requested physical dimensions.');
  assert.equal(geometry.deviceScaleFactor, 1, 'The unscaled fixture capture requires deviceScaleFactor 1.');
  assert.ok(Math.abs(geometry.viewportBox.width - width) < 1e-6 && Math.abs(geometry.viewportBox.height - height) < 1e-6,
    `The canvas CSS content must be unscaled: ${JSON.stringify(geometry.viewportBox)}`);
  // Playwright 1.63's element screenshot encloses the document-space rectangle
  // after scrolling. Its epsilon removes floating-point noise at integer edges;
  // actual fractional placement can contribute one outer pixel row or column.
  const rect = geometry.documentBox;
  const x = Math.floor(rect.x + 1e-3);
  const y = Math.floor(rect.y + 1e-3);
  const screenshotBox = {
    x, y, width: Math.ceil(rect.x + rect.width - 1e-3) - x,
    height: Math.ceil(rect.y + rect.height - 1e-3) - y,
  };
  assert.ok(screenshotBox.width >= width && screenshotBox.width <= width + 1
    && screenshotBox.height >= height && screenshotBox.height <= height + 1,
  'Only outward pixel enclosure may differ from the unscaled canvas size.');
  return { ...geometry, screenshotBox };
}

async function imagePixels(page, png, expectedDimensions) {
  const decoded = await page.evaluate(async base64 => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 36;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Cannot decode the captured PNG for verification.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { width: image.naturalWidth, height: image.naturalHeight, pixels: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data) };
  }, png.toString('base64'));
  assert.equal(decoded.width, expectedDimensions.width);
  assert.equal(decoded.height, expectedDimensions.height);
  assert.equal(decoded.pixels.length, 64 * 36 * 4);
  const colors = new Set();
  let opaque = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let index = 0; index < decoded.pixels.length; index += 4) {
    const [r, g, b, alpha] = decoded.pixels.slice(index, index + 4);
    colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
    opaque += alpha >= 250 ? 1 : 0;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    minimum = Math.min(minimum, luminance);
    maximum = Math.max(maximum, luminance);
  }
  assert.ok(opaque / (64 * 36) > 0.99, 'Canvas evidence is unexpectedly transparent.');
  assert.ok(colors.size >= 3 && maximum - minimum >= 12, 'Canvas evidence is uniform or nearly empty.');
  return {
    pixels: decoded.pixels,
    summary: { sampleWidth: 64, sampleHeight: 36, pixelSha256: sha256(Buffer.from(decoded.pixels)), quantizedColors: colors.size, luminanceRange: maximum - minimum, opaqueFraction: opaque / (64 * 36) },
  };
}

function compareImages(before, after, reason) {
  assert.notEqual(before.evidence.image.sha256, after.evidence.image.sha256, `${reason}: PNG did not change.`);
  assert.notEqual(before.evidence.image.pixelSha256, after.evidence.image.pixelSha256, `${reason}: decoded pixels did not change.`);
  let changedPixels = 0;
  let totalDifference = 0;
  for (let index = 0; index < before.pixels.length; index += 4) {
    const difference = [0, 1, 2].map(channel => Math.abs(before.pixels[index + channel] - after.pixels[index + channel]));
    if (Math.max(...difference) >= 8) changedPixels++;
    totalDifference += difference.reduce((sum, value) => sum + value, 0);
  }
  const meanAbsoluteRgbDifference = totalDifference / (64 * 36 * 3);
  assert.ok(changedPixels >= 12 && meanAbsoluteRgbDifference >= 0.25, `${reason}: fixture change did not produce sufficient visible pixel evidence.`);
  return { reason, before: before.evidence.label, after: after.evidence.label, changedPixels, meanAbsoluteRgbDifference };
}

function compareLitObject(before, after) {
  // The green fixture fills the image center. Select its chromatic pixels in
  // both captures so changing the preset's background alone cannot pass.
  let changedObjectPixels = 0;
  for (let y = 14; y < 22; y += 1) for (let x = 27; x < 37; x += 1) {
    const offset = (y * 64 + x) * 4;
    const a = before.pixels.slice(offset, offset + 3);
    const b = after.pixels.slice(offset, offset + 3);
    if (a[1] > a[0] * 1.15 && a[1] > a[2] * 1.1 && b[1] > b[0] * 1.15 && b[1] > b[2] * 1.1
        && Math.max(...a.map((value, channel) => Math.abs(value - b[channel]))) >= 8) changedObjectPixels += 1;
  }
  assert.ok(changedObjectPixels >= 8, 'Lighting must change the lit green model, not only the background.');
  return { reason: 'lighting affects fixture material', changedObjectPixels };
}

function catalogFromTransport(transport, origin) {
  const attribution = value => {
    if (value === null) return null;
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
    catch { return null; }
  };
  return {
    ...transport,
    assets: transport.assets.map(asset => ({
      ...asset, entryUrl: asset.entryUrl === null ? null : new URL(asset.entryUrl, `${new URL(origin).origin}/`).href,
      sourceUrl: attribution(asset.sourceUrl), licenseUrl: attribution(asset.licenseUrl),
    })),
  };
}

/**
 * Functional assertions for two visibly distinct lit fixture models, including a
 * clip that visibly moves at half its duration. The launcher owns navigation and
 * browser lifetime, and should collect page errors before navigation as well.
 * All evidence stays in a unique directory outside Git; no performance claim is made.
 */
export async function runGalleryAssertions(page, { outputDirectory, firstModelId, secondModelId } = {}) {
  const runDirectory = await externalOutput(outputDirectory);
  const reportPath = join(runDirectory, 'report.json');
  const pageErrors = [];
  const onPageError = error => pageErrors.push({ name: error.name, message: error.message });
  const onCrash = () => pageErrors.push({ name: 'PageCrash', message: 'Gallery browser page crashed.' });
  page.on('pageerror', onPageError);
  page.on('crash', onCrash);
  const report = {
    format: 'strata.gallery.workflow-validation', version: 1,
    startedAt: new Date().toISOString(), evidenceKind: 'functional browser workflow; not performance evidence',
    viewport: { width, height }, captures: [], captureGeometry: [], comparisons: [], pageErrors, passed: false,
  };
  let failure;
  try {
    await page.waitForFunction(() => {
      const api = window.strataGallery;
      return api && ['ready', 'empty', 'unsupported', 'error', 'disposed'].includes(api.getState().phase);
    }, null, { timeout: 120_000 });
    const boot = await page.evaluate(() => ({ state: window.strataGallery.getState(), catalog: window.strataGallery.getCatalog(), methods: Object.keys(window.strataGallery).filter(key => typeof window.strataGallery[key] === 'function') }));
    assert.equal(boot.state.phase, 'ready', `Gallery initialization failed: ${JSON.stringify(boot.state.error)}`);
    for (const method of ['getState', 'getCatalog', 'selectModel', 'setScenePreset', 'setLightingPreset', 'setDebugView', 'setViewport', 'setAnimation', 'setLive', 'captureState', 'dispose']) {
      assert.ok(boot.methods.includes(method), `Missing gallery API: ${method}`);
    }
    const catalog = boot.catalog;
    assert.equal(catalog?.format, 'strata.gallery.catalog');
    assert.equal(catalog.version, 1);
    assert.equal(catalog.available, true);
    assert.ok(Array.isArray(catalog.assets));
    const response = await page.request.get(new URL('/api/gallery/catalog', page.url()).href, { timeout: 10_000 });
    assert.equal(response.status(), 200, 'Gallery catalog transport request failed.');
    const body = await response.body();
    assert.ok(body.length <= 2 * 1024 * 1024, 'Gallery catalog exceeds its response cap.');
    assert.deepEqual(catalog, catalogFromTransport(JSON.parse(body.toString('utf8')), page.url()), 'getCatalog differs from the normalized HTTP transport.');
    report.catalog = catalog;
    const available = catalog.assets.filter(asset => asset.entryUrl !== null && asset.unavailableReason === null);
    const selected = [firstModelId ?? available[0]?.id, secondModelId ?? available[1]?.id];
    assert.ok(Array.isArray(selected) && selected.length === 2 && selected.every(id => typeof id === 'string') && new Set(selected).size === 2, 'Supply two distinct fixture model IDs.');
    for (const id of selected) assert.ok(available.some(asset => asset.id === id), `Fixture model is unavailable: ${id}`);
    report.modelIds = selected;
    report.resize = await page.evaluate(async () => {
      const api = window.strataGallery;
      await api.setViewport(800, 450);
      const larger = await api.captureState(1);
      await api.setViewport(640, 360);
      return { larger: larger.state.viewport, final: api.getState().viewport };
    });
    assert.deepEqual(report.resize, { larger: { width: 800, height: 450 }, final: { width, height } });

    const capture = async (label, modelId, animation) => {
      const invocation = await page.evaluate(async ({ animation }) => {
        const api = window.strataGallery;
        if (animation) await api.setAnimation(animation);
        // Enabling live view first makes capture's pause guarantee observable.
        api.setLive(true);
        const beforeCapture = api.getState();
        return { beforeCapture, receipt: await api.captureState(4) };
      }, { animation: animation ?? null });
      const { receipt, beforeCapture } = invocation;
      assert.equal(receipt.format, 'strata.gallery.capture-state');
      assert.equal(receipt.version, 1);
      assert.equal(receipt.presentedFrameId, null);
      assert.ok(Number.isFinite(Date.parse(receipt.capturedAt)));
      assertReady(receipt.state, modelId);
      assertReady(beforeCapture, modelId);
      assert.equal(beforeCapture.live, true);
      assert.equal(receipt.state.frame.frameId, beforeCapture.frame.frameId + 4, 'captureState(4) must perform exactly four real submissions.');
      assert.equal(receipt.state.engineEpoch, beforeCapture.engineEpoch);
      assert.equal(receipt.state.live, false);
      assert.equal(receipt.state.settings.animation.playing, false);
      if (animation) {
        assert.equal(beforeCapture.settings.animation.playing, true);
        assert.equal(receipt.state.settings.animation.clipId, animation.clipId);
        assert.equal(receipt.state.settings.animation.timeSeconds, animation.timeSeconds);
        assert.equal(receipt.state.settings.animation.loop, animation.loop);
      }
      const before = await page.evaluate(() => window.strataGallery.getState());
      assertReady(before, modelId);
      assertFrozen(receipt.state, before);
      await twoCallbacks(page);
      const afterCallbacks = await page.evaluate(() => window.strataGallery.getState());
      assertReady(afterCallbacks, modelId);
      assertFrozen(before, afterCallbacks);
      const canvas = page.locator('canvas#viewport');
      await canvas.scrollIntoViewIfNeeded({ timeout: 30_000 });
      const geometry = { label, before: await captureGeometry(canvas) };
      report.captureGeometry.push(geometry);
      const png = await canvas.screenshot({ type: 'png', scale: 'css', animations: 'disabled', timeout: 30_000 });
      geometry.after = await captureGeometry(canvas);
      geometry.pngDimensions = pngSize(png);
      assert.deepEqual(geometry.after, geometry.before, 'Canvas layout or scroll changed during the screenshot.');
      const after = await page.evaluate(() => window.strataGallery.getState());
      assertReady(after, modelId);
      assertFrozen(before, after);
      const expectedDimensions = { width: geometry.before.screenshotBox.width, height: geometry.before.screenshotBox.height };
      assert.deepEqual(geometry.pngDimensions, expectedDimensions, 'PNG dimensions must match the recorded outward-rounded CSS pixel enclosure.');
      const decoded = await imagePixels(page, png, expectedDimensions);
      const filename = `${label}.png`;
      await writeFile(join(runDirectory, filename), png, { flag: 'wx' });
      const evidence = { label, beforeCapture, receipt, beforeScreenshot: before, afterCallbacks, afterScreenshot: after, geometry, image: { file: filename, ...geometry.pngDimensions, bytes: png.length, sha256: sha256(png), ...decoded.summary } };
      report.captures.push(evidence);
      assert.deepEqual(pageErrors, [], 'Uncaught browser errors occurred.');
      return { evidence, pixels: decoded.pixels };
    };

    const baselines = [];
    let animated;
    for (const [index, modelId] of selected.entries()) {
      const loaded = await page.evaluate(async id => {
        const api = window.strataGallery;
        await api.selectModel(id);
        await api.setScenePreset('model-only');
        await api.setLightingPreset('studio');
        await api.setDebugView('final');
        await api.setAnimation({ clipId: null, timeSeconds: 0, loop: false, playing: false });
        return api.getState();
      }, modelId);
      assertReady(loaded, modelId);
      assert.equal(loaded.settings.lightingPreset, 'studio');
      const clip = loaded.asset.clips.find(item => Number.isFinite(item.duration) && item.duration > 0);
      if (!animated && clip) animated = { modelId, clip };
      baselines.push(await capture(`model-${index + 1}-studio`, modelId));
    }
    report.comparisons.push(compareImages(baselines[0], baselines[1], 'model selection'));
    await page.evaluate(() => window.strataGallery.setLightingPreset('daylight'));
    const daylight = await capture('model-2-daylight', selected[1]);
    assert.equal(daylight.evidence.receipt.state.settings.lightingPreset, 'daylight');
    report.comparisons.push(compareImages(baselines[1], daylight, 'lighting preset'));
    report.comparisons.push(compareLitObject(baselines[1], daylight));
    assert.ok(animated, 'Fixtures must expose a supported positive-duration clip that moves visibly at half duration.');
    await page.evaluate(async id => {
      const api = window.strataGallery;
      await api.selectModel(id);
      await api.setScenePreset('model-only');
      await api.setLightingPreset('studio');
      await api.setDebugView('final');
    }, animated.modelId);
    const atStart = await capture('animation-start', animated.modelId, { clipId: animated.clip.id, timeSeconds: 0, loop: false, playing: true });
    const atMiddle = await capture('animation-middle', animated.modelId, { clipId: animated.clip.id, timeSeconds: animated.clip.duration / 2, loop: false, playing: true });
    report.animation = animated;
    report.comparisons.push(compareImages(atStart, atMiddle, 'explicit animation time'));
  } catch (error) { failure = error; }
  finally {
    try {
      const disposed = await page.evaluate(() => {
        if (!window.strataGallery) throw new Error('Gallery disposal API was never initialized.');
        window.strataGallery.dispose();
        window.strataGallery.dispose();
        return window.strataGallery.getState();
      });
      assert.equal(disposed.phase, 'disposed');
      assert.equal(disposed.live, false);
      assert.equal(disposed.asset, null);
      if (disposed.telemetry) {
        assert.equal(disposed.telemetry.wasmMemoryBytes, 0);
        assert.equal(disposed.telemetry.allocatedGpuBufferBytes, 0);
        assert.equal(disposed.telemetry.allocatedGpuTextureBytes, 0);
        assert.equal(disposed.telemetry.gpuErrorCount, 0);
      }
      await twoCallbacks(page);
      const afterDispose = await page.evaluate(() => window.strataGallery.getState());
      assert.equal(afterDispose.phase, 'disposed');
      assert.equal(afterDispose.telemetry?.submittedFrames, disposed.telemetry?.submittedFrames);
      report.disposed = afterDispose;
      assert.deepEqual(pageErrors, [], 'Uncaught browser errors occurred.');
    } catch (error) {
      report.cleanupError = { name: error.name, message: error.message };
      failure ??= error;
    }
    report.completedAt = new Date().toISOString();
    report.passed = failure === undefined;
    if (failure) report.error = { name: failure.name, message: failure.message };
    try { await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' }); }
    finally { page.off('pageerror', onPageError); page.off('crash', onCrash); }
  }
  if (failure) { failure.reportPath = reportPath; throw failure; }
  return { passed: true, reportPath, outputDirectory: runDirectory, imagePaths: report.captures.map(capture => join(runDirectory, capture.image.file)), report };
}
