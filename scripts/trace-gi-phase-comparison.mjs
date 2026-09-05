/** CPU-only comparison of retained proof artifacts. Never renders, mutates, or rewrites evidence. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const WORK_FIELDS = new Set(['traceRegeneratedTriangleCount', 'tracePackedTriangleCount', 'traceRefitLeafCount',
  'traceRefitAncestorCount', 'traceAttemptedWriteCalls', 'traceQueuedWriteCalls', 'traceQueuedUploadBytes',
  'traceFullBufferFallbackCount', 'traceMetadataBytes']);
const CHECKPOINTS = ['precondition', 'reset', 'final'];
const BUFFER_KEYS = ['probeRay', 'probeState', 'probeStats', 'probeConfig', 'reflectionStats', 'reflectionConfig',
  'Strata current tile LOD selections', 'Strata indirect geometry arguments and counters'];
const INPUT_IMAGES = ['Strata linear HDR and shadow visibility', 'Strata world normals and roughness',
  'Strata linear base color and metallic', 'Strata motion and current/previous view depths',
  'Strata raster depth', 'Strata directional shadow depth'];
const IMAGE_KEYS = ['native', 'probeIrradiance', 'probeVisibility', 'reflectionRaw', 'reflectionRawMetadata',
  'reflectionRadiance', 'reflectionSurface', 'reflectionMetadata', ...INPUT_IMAGES, 'Strata composed reflection HDR'];
const DERIVED_BUFFERS = new Set(['probeRay', 'probeState', 'probeStats', 'reflectionStats']);
const ORDER = [['incremental', 5399], ['full', 5399], ['full', 5400], ['incremental', 5400]];
const IDS = ['precondition', 'reset', ...Array.from({ length: 239 }, (_, i) => `held-${i + 1}`), 'final'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fileName = (id, key) => `${id}/${key.replaceAll(' ', '-')}.bin`;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(message, detail = {}) { throw Object.assign(Error(message), { proofDifference: { message, ...detail } }); }
function need(value, message, detail) { if (!value) fail(message, detail); }
function firstDifference(a, b, path = '$') {
  if (Object.is(a, b)) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return { path, actual: a, expected: b };
  if (Array.isArray(a) !== Array.isArray(b)) return { path, reason: 'shape' };
  const ak = Object.keys(a), bk = Object.keys(b);
  if (Array.isArray(a) && a.length !== b.length || !isDeepStrictEqual(ak.slice().sort(), bk.slice().sort())) return { path, reason: 'keys/length', actualKeys: ak, expectedKeys: bk };
  for (const key of bk) { const difference = firstDifference(a[key], b[key], `${path}.${key}`); if (difference) return difference; }
  return { path, reason: 'prototype or object representation' };
}
function equal(a, b, label) { if (!isDeepStrictEqual(a, b)) fail(`Semantic mismatch: ${label}`, { kind: 'semantic', label, difference: firstDifference(a, b) }); }
function equalBytes(a, b, label) {
  if (a.equals(b)) return;
  let first = 0; while (first < Math.min(a.length, b.length) && a[first] === b[first]) first++;
  fail(`Artifact mismatch: ${label}`, { kind: 'bytes', label, firstByte: first, actualByte: a[first], expectedByte: b[first],
    actualBytes: a.length, expectedBytes: b.length, actualSha256: sha(a), expectedSha256: sha(b) });
}
function words(values, count, label) {
  need(Array.isArray(values) && values.length === count && values.every(v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff), `Malformed ${label}`);
  const bytes = Buffer.alloc(count * 4); values.forEach((v, i) => bytes.writeUInt32LE(v, i * 4)); return bytes;
}
function semantic(value, key = '') {
  if (Array.isArray(value)) return value.map(v => semantic(v));
  if (!plain(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([field]) => key !== 'gi' || !WORK_FIELDS.has(field))
    .map(([field, child]) => [field, semantic(child, field)]));
}
function eventSemantic(event) {
  const copy = semantic(event);
  if (copy.type === 'creation') delete copy.initialWrites;
  if (copy.type === 'submission') { delete copy.firstWrite; delete copy.writes; }
  return copy;
}
function artifactRecord(value) { return plain(value) && typeof value.sha256 === 'string' && Number.isInteger(value.bytes); }
function checkReference(record, registry, label) {
  need(artifactRecord(record) && record.bytes > 0 && /^[a-f0-9]{64}$/.test(record.sha256), `Malformed artifact reference: ${label}`);
  if (record.name !== undefined) equal(record, registry.get(record.name), `artifact reference ${label}`);
}
function checkReferences(value, registry) {
  if (artifactRecord(value)) { checkReference(value, registry, value.name ?? 'unarchived frame'); return; }
  if (value && typeof value === 'object') Object.values(value).forEach(child => checkReferences(child, registry));
}
function validatePlan(p) {
  need(plain(p), 'Missing phase plan');
  equal({ width: p.width, height: p.height, format: p.format, cameraMode: p.cameraMode, counts: p.counts, phases: p.phases },
    { width: 1280, height: 720, format: 'bgra8unorm', cameraMode: 'tour',
      counts: { cells: 4, submissionsPerCell: 242, captureSubmissionsPerCell: 241, totalSubmissions: 968 },
      phases: [{ label: 5399, firstSampleIndex: 6123, lastSampleIndex: 6363 }, { label: 5400, firstSampleIndex: 6124, lastSampleIndex: 6364 }] }, 'frozen phase dimensions/counts');
  need(p.correctnessOnly === true && p.performanceEligible === false && p.geometry?.mode === 'resident-full'
    && p.geometry.pages === 80 && p.geometry.actualPoolBytes === 5242880 && p.maxRunMs === 300000, 'Wrong diagnostic scope');
  equal(p.initialWorld, { doorOpen: false, wallColor: 'red', lightIntensity: 1, objectOffset: -.4, roughness: .08 }, 'initial world');
  equal(p.precondition, { time: 5, controls: { temporal: true, debugView: 'final', exposureEV: 0, cameraCut: true,
    gi: { enabled: true, resetCache: true }, reflections: { resetHistory: true, mode: 'world', roughness: .08, maxDistance: 16, updateEvery: 1 } } }, 'precondition inputs');
  equal(p.reset, { time: 16, controls: { temporal: true, debugView: 'final', exposureEV: 0, cameraCut: true,
    gi: { enabled: true, doorOpen: true, wallColor: 'red', lightIntensity: 0, resetCache: true },
    reflections: { mode: 'world', roughness: .08, maxDistance: 16, updateEvery: 1, objectOffset: 0, resetHistory: true } } }, 'reset inputs');
  equal(p.held, { time: 16, controls: { temporal: true, debugView: 'final', exposureEV: 0 }, count: 240 }, 'held inputs');
}

function validateCell(cell, index) {
  const [updater, phaseLabel] = ORDER[index], r = cell.result, first = phaseLabel + 724;
  need(cell.id === `${index + 1}-${updater}-${phaseLabel}` && cell.updater === updater && cell.phaseLabel === phaseLabel, 'Wrong cell order/identity');
  need(r?.status === 'passed', 'Cell did not pass', { cell: cell.id, status: r?.status }); validatePlan(r.plan);
  need(Array.isArray(cell.shaderDescriptors) && cell.shaderDescriptors.length > 0 && cell.shaderDescriptors.every(d => plain(d)
    && typeof d.code === 'string' && d.code.trim().length > 0 && (d.label === undefined || typeof d.label === 'string')), 'Missing actual shader descriptors');
  equal(r.phase, { label: phaseLabel, firstSampleIndex: first, lastSampleIndex: first + 240 }, 'actual cell phase');
  equal(r.injection, { path: 'IntegratedRenderer.effect.frames', previousValue: 1, value: first, changedPropertyCount: 1,
    cachesUnchanged: true, historicalSubmissionIdsSynthesized: false }, 'injection receipt');
  need(r.cleanup?.after?.buffers === 0 && r.cleanup.after.textures === 0 && r.cleanup.outputDestroyed === true
    && Array.isArray(r.cleanup.errors) && r.cleanup.errors.length === 0, 'Cell cleanup failed or missing', { cell: cell.id });
  need(Array.isArray(r.frames) && r.frames.length === 242 && Array.isArray(cell.events) && cell.events.length === 488, 'Missing or extra frame/event', { cell: cell.id });
  need(Array.isArray(cell.artifacts), 'Missing artifact inventory');
  const registry = new Map();
  for (const a of cell.artifacts) {
    need(plain(a) && typeof a.name === 'string' && !a.name.startsWith('/') && !a.name.split('/').some(s => !s || s === '.' || s === '..')
      && !registry.has(a.name), 'Malformed or duplicate artifact name');
    checkReference(a, new Map([[a.name, a]]), a.name); registry.set(a.name, a);
  }
  const requireFile = name => need(registry.has(name), `Missing required artifact: ${name}`, { cell: cell.id });
  for (const prefix of ['initial', 'post-injection', ...CHECKPOINTS]) for (let i = 0; i < 5; i++) requireFile(`${prefix}/trace-${i}.bin`);
  for (const prefix of CHECKPOINTS) for (const key of [...BUFFER_KEYS, ...IMAGE_KEYS]) requireFile(fileName(prefix, key));
  requireFile('reset-queued/probeConfig.bin'); requireFile('reset-queued/reflectionConfig.bin');
  need([...registry.keys()].some(name => /^writes\/\d+\.bin$/.test(name)), 'No actual upload evidence');
  r.frames.forEach((f, i) => {
    const id = IDS[i], n = i + 1, clock = i === 0 ? 0 : first + i - 1, epoch = i === 0 ? 1 : 2, age = i === 0 ? 1 : i;
    need(f.id === id && f.localFrameId === n && f.effectFrames === clock + 1, 'Frame order/clock/submission mismatch', { cell: cell.id, index: i });
    equal(f.controls, i === 0 ? r.plan.initialWorld : { ...r.plan.initialWorld, doorOpen: true, lightIntensity: 0, objectOffset: 0 }, `${id} actual world`);
    need(f.gi?.sourceFrameId === n && f.gi.submittedFrames === n && f.gi.sampleFrameIndex === clock && f.gi.framesSinceReset === age
      && f.gi.cacheEpoch === epoch && f.gi.refreshFrontier === age * 32 % 384 && f.gi.enabled === true, `Invalid GI receipt ${id}`);
    need(f.reflections?.sourceFrameId === n && f.reflections.submittedFrames === n && f.reflections.framesSinceReset === age
      && f.reflections.cacheEpoch === epoch && f.reflections.mode === 'world', `Invalid reflection receipt ${id}`);
    need(f.geometry?.residentPages === 80 && f.geometry.poolBytes === 5242880, `Wrong resident geometry ${id}`);
    need(plain(f.camera) && Array.isArray(f.camera.view) && f.camera.view.length === 16
      && Array.isArray(f.camera.viewProjection) && f.camera.viewProjection.length === 16
      && [...f.camera.view, ...f.camera.viewProjection].every(Number.isFinite), `Missing/invalid camera ${id}`);
    need(Number.isInteger(f.validProbeCount) && Number.isInteger(f.invalidProbeCount) && f.validProbeCount >= 0
      && f.invalidProbeCount >= 0 && f.validProbeCount + f.invalidProbeCount === 384, `Malformed probe validity counts ${id}`);
    const pc = words(f.probeConfig, 24, 'probe config'), rc = words(f.reflectionConfig, 60, 'reflection config');
    need(f.probeConfig[16] === clock && f.probeConfig[18] === 1337 && f.probeConfig[9] === 32 && f.probeConfig[10] === 64
      && f.probeConfig[11] === epoch && f.probeConfig[17] === Number(i < 2)
      && f.reflectionConfig[40] === clock && f.reflectionConfig[41] === epoch && f.reflectionConfig[52] === Number(i < 2), `Actual GPU configuration receipt differs ${id}`);
    equal(Object.keys(f.buffers).sort(), [...BUFFER_KEYS].sort(), `${id} buffer inventory`);
    checkReferences(f, registry);
    for (const [key, bytes] of [['probeConfig', pc], ['reflectionConfig', rc]]) {
      need(f.buffers[key].bytes === bytes.length && f.buffers[key].sha256 === sha(bytes), `Config words/hash disagree ${id}/${key}`);
      const uploads = Object.entries(f.uploads).filter(([label]) => label.startsWith(key === 'probeConfig' ? 'Strata probe config' : 'Strata reflection config'));
      need(uploads.length === 1 && uploads[0][1].bytes === bytes.length && uploads[0][1].sha256 === sha(bytes), `Config upload/hash disagree ${id}/${key}`);
    }
    need(Object.keys(f.uploads).length === 4 && f.uploads['Strata current and previous transforms'] && f.uploads['Strata presentation settings'], `Missing camera/presentation upload ${id}`);
    const checkpoint = CHECKPOINTS.includes(id);
    equal(Object.keys(f.images).sort(), checkpoint ? [...IMAGE_KEYS].sort() : [], `${id} image inventory`);
    if (checkpoint) {
      need(Array.isArray(f.trace) && f.trace.length === 5, `Missing source checkpoint ${id}`);
      for (const key of BUFFER_KEYS) need(f.buffers[key].name === fileName(id, key), `Unlinked buffer checkpoint ${id}/${key}`);
      for (const key of IMAGE_KEYS) need(f.images[key].name === fileName(id, key), `Unlinked image checkpoint ${id}/${key}`);
      for (const [label, record] of Object.entries(f.uploads)) need(record.name === fileName(id, `upload-${label}`), `Unlinked uniform checkpoint ${id}/${label}`);
      f.trace.forEach((record, j) => need(record.name === `${id}/trace-${j}.bin`, `Unlinked source checkpoint ${id}/${j}`));
    }
  });
  equal(r.checkpoints, r.frames.filter(f => CHECKPOINTS.includes(f.id)), 'checkpoint/frame receipts');
  let cursor = 0;
  const take = (type, id) => {
    const e = cell.events[cursor++]; need(e?.type === type && (id === undefined || e.id === id), 'Event order/type differs', { cell: cell.id, cursor, type, id });
    return e;
  };
  const creation = take('creation'); need(creation.effectFrames === 0, 'Creation clock differs'); equal(creation.controls, r.plan.initialWorld, 'creation source');
  for (let i = 0; i < r.frames.length; i++) {
    const f = r.frames[i];
    if (i === 1) {
      const injection = take('injection'); equal(injection.injection, r.injection, 'event injection');
      need(injection.before.frames === 1 && injection.after.frames === first, 'Injection clock receipt differs');
      equal(injection.before.gi, injection.after.gi, 'injection GI unchanged'); equal(injection.before.reflection, injection.after.reflection, 'injection reflection unchanged');
      equal(injection.before.gi, r.frames[0].gi, 'injection actual prior GI');
      const queued = take('reset-queued'); need(queued.localFrameId === 1 && queued.before.localFrameId === 1 && queued.before.effectFrames === first, 'Queued reset committed early');
      need(queued.probeConfig?.[8] === 0 && queued.probeConfig[11] === 2 && queued.probeConfig[16] === first && queued.probeConfig[17] === 1
        && queued.reflectionConfig?.[40] === first && queued.reflectionConfig[41] === 2 && queued.reflectionConfig[44] === 0 && queued.reflectionConfig[52] === 1, 'Queued reset configuration differs');
    }
    const e = take('submission', f.id), spec = i === 0 ? r.plan.precondition : i === 1 ? r.plan.reset : r.plan.held;
    equal(e.requestedControls, spec.controls, `${f.id} requested controls`); need(e.time === spec.time && e.before.localFrameId === i, 'Submission time/ID differs');
    need(e.before.effectFrames === (i === 0 ? 0 : first + i - 1), 'Submission clock differs');
    need(Array.isArray(e.writes) && (i <= 1 || e.writes.length === 0) && e.writes.every(w => w.returned === true), 'Unexpected late/failed source write');
    const observed = take('frame', f.id); const { type, ...frame } = observed; equal(frame, f, 'frame event/result');
  }
  equal(take('cell-cleanup').cleanup, r.cleanup, 'final cleanup event'); need(cursor === cell.events.length, 'Late unconsumed event');
  checkReferences(cell.events, registry);
  return registry;
}

function shifted(value, delta) { return typeof value === 'number' && value >= 6123 ? value - delta : value; }
function acrossFrame(frame, delta) {
  const f = semantic(frame); f.effectFrames = shifted(f.effectFrames, delta); f.gi.sampleFrameIndex = shifted(f.gi.sampleFrameIndex, delta);
  f.probeConfig[16] = shifted(f.probeConfig[16], delta); f.reflectionConfig[40] = shifted(f.reflectionConfig[40], delta);
  delete f.validProbeCount; delete f.invalidProbeCount;
  for (const key of DERIVED_BUFFERS) delete f.buffers[key];
  for (const [key, count] of [['probeConfig', 24], ['reflectionConfig', 60]]) {
    const digest = sha(words(f[key], count, key)); f.buffers[key].sha256 = digest;
    for (const [label, record] of Object.entries(f.uploads)) if (label.startsWith(key === 'probeConfig' ? 'Strata probe config' : 'Strata reflection config')) record.sha256 = digest;
  }
  for (const key of Object.keys(f.images)) if (!INPUT_IMAGES.includes(key)) delete f.images[key];
  return f;
}
function acrossEvent(event, delta) {
  if (event.type === 'frame') return { type: 'frame', ...acrossFrame(event, delta) };
  const e = eventSemantic(event);
  const prior = obj => { if (!obj) return; if ('effectFrames' in obj) obj.effectFrames = shifted(obj.effectFrames, delta); if (obj.gi) obj.gi.sampleFrameIndex = shifted(obj.gi.sampleFrameIndex, delta); };
  prior(e); prior(e.before); prior(e.after);
  if (e.type === 'injection') { e.injection.value = shifted(e.injection.value, delta); e.after.frames = shifted(e.after.frames, delta); }
  if (e.type === 'reset-queued') { e.probeConfig[16] = shifted(e.probeConfig[16], delta); e.reflectionConfig[40] = shifted(e.reflectionConfig[40], delta); }
  return e;
}
function normalizeConfig(bytes, word, delta) { const copy = Buffer.from(bytes); copy.writeUInt32LE(shifted(copy.readUInt32LE(word * 4), delta), word * 4); return copy; }
function finiteArtifact(bytes, a) {
  if (a.format === 'rgba16float') for (let i = 0; i < bytes.length; i += 2) need((bytes.readUInt16LE(i) & 0x7c00) !== 0x7c00, 'Nonfinite retained half-float', { artifact: a.name, byte: i });
  if (['rg32float', 'r32float', 'depth32float'].includes(a.format)) for (let i = 0; i < bytes.length; i += 4) need(Number.isFinite(bytes.readFloatLE(i)), 'Nonfinite retained float', { artifact: a.name, byte: i });
}
function half(word) {
  const sign = word & 0x8000 ? -1 : 1, exponent = word >>> 10 & 31, fraction = word & 1023;
  return sign * (exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15));
}
function imageMetrics(a, b, width, height, hdr) {
  const regions = { full: [0, 0, 1, 1], wall: [.05, .1, .45, .75], sky: [.7, .1, .95, .45] };
  return Object.fromEntries(Object.entries(regions).map(([name, bounds]) => {
    const [x0, y0, x1, y1] = bounds.map((v, i) => Math.floor(v * (i % 2 ? height : width))), channels = hdr ? [0, 1, 2] : [2, 1, 0], stride = hdr ? 8 : 4;
    const sumA = [0, 0, 0], sumB = [0, 0, 0], signed = [0, 0, 0], channelMaxima = [0, 0, 0];
    let absolute = 0, squared = 0, max = 0, changed = 0, differingByteCount = 0, differingPixelCount = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const offset = (y * width + x) * stride; let different = false;
      let byteDifferent = false;
      for (let j = 0; j < stride; j++) { const differs = a[offset + j] !== b[offset + j]; differingByteCount += Number(differs); byteDifferent ||= differs; }
      differingPixelCount += Number(byteDifferent);
      channels.forEach((c, k) => {
        const av = hdr ? half(a.readUInt16LE(offset + c * 2)) : a[offset + c], bv = hdr ? half(b.readUInt16LE(offset + c * 2)) : b[offset + c], d = bv - av;
        sumA[k] += av; sumB[k] += bv; signed[k] += d; absolute += Math.abs(d); squared += d * d; max = Math.max(max, Math.abs(d));
        channelMaxima[k] = Math.max(channelMaxima[k], Math.abs(d)); different ||= d !== 0;
      });
      changed += Number(different);
    }
    const pixels = (x1 - x0) * (y1 - y0);
    return [name, { normalizedBounds: bounds, pixels, differingByteCount, differingPixelCount, changedRgbPixels: changed,
      maxAbsoluteDifferenceRgb: channelMaxima, meanPhase5399Rgb: sumA.map(v => v / pixels), meanPhase5400Rgb: sumB.map(v => v / pixels),
      signedMeanDifferenceRgb: signed.map(v => v / pixels), meanAbsoluteRgbDifference: absolute / (3 * pixels), rgbRmse: Math.sqrt(squared / (3 * pixels)), maxAbsoluteChannelDifference: max }];
  }));
}

export async function compareTraceGiPhaseCells(cells, readArtifact) {
  need(Array.isArray(cells) && cells.length === 4 && typeof readArtifact === 'function', 'Four complete phase cells and an artifact reader are required');
  const registries = cells.map(validateCell);
  for (let i = 1; i < 4; i++) {
    equal(cells[i].result.plan, cells[0].result.plan, 'common frozen plan');
    equal(cells[i].shaderDescriptors, cells[0].shaderDescriptors, 'ordered actual shader descriptors');
  }
  const read = async (index, name) => {
    const a = registries[index].get(name); need(a, `Missing artifact ${name}`);
    let bytes; try { bytes = await readArtifact(cells[index], name); } catch (cause) { fail(`Artifact read failed: ${name}`, { cell: cells[index].id, cause: String(cause) }); }
    need(Buffer.isBuffer(bytes) && bytes.length === a.bytes && sha(bytes) === a.sha256, `Artifact identity mismatch: ${name}`, { cell: cells[index].id });
    if (a.format !== undefined) {
      const bpp = { bgra8unorm: 4, rgba8unorm: 4, rgba16float: 8, rg32float: 8, rgba32uint: 16, depth32float: 4, r32float: 4 }[a.format];
      need(bpp && Number.isInteger(a.width) && a.width > 0 && Number.isInteger(a.height) && a.height > 0 && a.bytes === a.width * a.height * bpp, `Artifact dimensions/format differ: ${name}`);
    }
    finiteArtifact(bytes, a); return bytes;
  };
  let verifiedArtifacts = 0;
  for (let i = 0; i < 4; i++) for (const name of registries[i].keys()) { await read(i, name); verifiedArtifacts++; }
  const samePhase = [];
  for (const [a, b] of [[0, 1], [3, 2]]) {
    equal(semantic(cells[a].result), semantic(cells[b].result), `same-phase${cells[a].phaseLabel} result`);
    equal(cells[a].events.map(eventSemantic), cells[b].events.map(eventSemantic), `same-phase${cells[a].phaseLabel} events`);
    const names = i => [...registries[i].keys()].filter(n => !n.startsWith('writes/')).sort(); equal(names(a), names(b), 'same-phase non-write inventory');
    for (const name of names(a)) { equal(registries[a].get(name), registries[b].get(name), `same-phase metadata ${name}`); equalBytes(await read(a, name), await read(b, name), `${cells[a].id}/${cells[b].id}/${name}`); }
    samePhase.push({ phaseLabel: cells[a].phaseLabel, passed: true, exactNonWriteArtifacts: names(a).length, frames: 242, events: 488 });
  }
  const crossPhase = [];
  for (const [a, b] of [[0, 3], [1, 2]]) {
    equal(semantic(cells[a].result.frames[0]), semantic(cells[b].result.frames[0]), 'complete precondition semantic state');
    equal(cells[a].result.frames.map(f => acrossFrame(f, 0)), cells[b].result.frames.map(f => acrossFrame(f, 1)), 'across-phase frame input controls');
    equal(cells[a].events.map(e => acrossEvent(e, 0)), cells[b].events.map(e => acrossEvent(e, 1)), 'across-phase event input controls');
    const inputName = name => /^(initial|post-injection)\//.test(name) || name.startsWith('precondition/')
      || /\/trace-\d\.bin$/.test(name) || INPUT_IMAGES.some(key => name.endsWith(`/${key.replaceAll(' ', '-')}.bin`))
      || name.includes('/Strata-current-tile-LOD-selections.bin') || name.includes('/Strata-indirect-geometry-arguments-and-counters.bin')
      || name.includes('/upload-Strata-current-and-previous-transforms.bin') || name.includes('/upload-Strata-presentation-settings.bin');
    let exactInputs = 0;
    for (const name of registries[a].keys()) {
      if (inputName(name)) { equal(registries[a].get(name), registries[b].get(name), `across-phase input metadata ${name}`); equalBytes(await read(a, name), await read(b, name), `across-phase input ${name}`); exactInputs++; }
      const config = /\/(?:upload-Strata-probe-config[^/]*|probeConfig)\.bin$/.test(name) ? 16
        : /\/(?:upload-Strata-reflection-config[^/]*|reflectionConfig)\.bin$/.test(name) ? 40 : null;
      if (config !== null) equalBytes(await read(a, name), normalizeConfig(await read(b, name), config, 1), `across-phase clock-only config ${name}`);
    }
    const rayA = await read(a, 'reset/probeRay.bin'), rayB = await read(b, 'reset/probeRay.bin');
    need(rayA.length === 65536 && rayB.length === 65536, 'RESET ray stride/count differs');
    let changedDirectionWords = 0, changedRays = 0;
    for (let offset = 0; offset < rayA.length; offset += 32) {
      let different = false;
      for (const c of [16, 20, 24]) {
        need(Number.isFinite(rayA.readFloatLE(offset + c)) && Number.isFinite(rayB.readFloatLE(offset + c)), 'Nonfinite RESET direction');
        const changed = rayA.readUInt32LE(offset + c) !== rayB.readUInt32LE(offset + c); changedDirectionWords += Number(changed); different ||= changed;
      }
      changedRays += Number(different);
    }
    need(changedDirectionWords > 0, 'Clock intervention did not change actual RESET probe directions', { updater: cells[a].updater });
    const metrics = {};
    for (const [key, hdr] of [['native', false], ['Strata composed reflection HDR', true]]) {
      const name = fileName('final', key), meta = registries[a].get(name), other = registries[b].get(name);
      need(meta.width === 1280 && meta.height === 720 && meta.format === (hdr ? 'rgba16float' : 'bgra8unorm')
        && other.width === meta.width && other.height === meta.height && other.format === meta.format, 'Final presentation/HDR metadata differs');
      metrics[hdr ? 'linearHdr' : 'nativeBgraCodeValues'] = imageMetrics(await read(a, name), await read(b, name), meta.width, meta.height, hdr);
    }
    const rawLightingDifferences = {};
    for (const key of ['probeRay', 'probeState', 'probeStats', 'reflectionStats', 'probeIrradiance', 'probeVisibility',
      'reflectionRaw', 'reflectionRawMetadata', 'reflectionRadiance', 'reflectionSurface', 'reflectionMetadata']) {
      const name = fileName('final', key), left = await read(a, name), right = await read(b, name);
      need(left.length === right.length, 'Across-phase lighting resource size differs');
      let differingByteCount = 0, firstDifferingByte = null;
      for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) { differingByteCount++; firstDifferingByte ??= i; }
      rawLightingDifferences[key] = { bytes: left.length, differingByteCount, firstDifferingByte };
    }
    crossPhase.push({ updater: cells[a].updater, exactInputArtifacts: exactInputs, changedResetDirectionWords: changedDirectionWords,
      changedResetRays: changedRays, resetRayCount: 2048, metrics, rawLightingDifferences });
  }
  equal(crossPhase[0].metrics, crossPhase[1].metrics, 'phase difference independent of updater');
  equal(crossPhase[0].rawLightingDifferences, crossPhase[1].rawLightingDifferences, 'raw lighting difference independent of updater');
  equal(crossPhase[0].changedResetDirectionWords, crossPhase[1].changedResetDirectionWords, 'RESET direction intervention independent of updater');
  return { status: 'passed', kind: 'controlled-phase-comparison', verifiedArtifacts, samePhase, crossPhase,
    exclusions: { giUpdaterWorkFields: [...WORK_FIELDS], eventWriteFields: ['creation.initialWrites', 'submission.firstWrite', 'submission.writes'], artifactByteEqualityExcludedPrefix: 'writes/' },
    interpretation: { wallHdrChangedWithPhase: crossPhase[0].metrics.linearHdr.wall.changedRgbPixels > 0,
      wallNativeChangedWithPhase: crossPhase[0].metrics.nativeBgraCodeValues.wall.changedRgbPixels > 0,
      scope: 'Same-phase updater equivalence is strict. Cross-phase differences are descriptive in a controlled resident-full scene. No exact reconstruction, timing, old-wall-fix or historical-cause claim.' } };
}
