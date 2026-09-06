import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { boundedRegionOperation, canonicalJson, parseRegionInitializationArgs, validateHardwareEnvironment, validatePreparedEvidence,
  REGION_EXECUTION_PLAN, REGION_FIXTURE_IDENTITIES } from './test-region-initialization.mjs';

function controlledDeadline() {
  let time = 100, callback, clears = 0, fires = 0;
  const token = {};
  return {
    clock: { now: () => time, setTimer: action => { callback = action; return token; },
      clearTimer: value => { assert.equal(value, token); clears++; } },
    moveTo: value => { time = value; },
    fireTimer: () => { fires++; callback(); },
    get clears() { return clears; }, get fires() { return fires; },
  };
}
function deferredResult() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test('bounded runner accepts observed completion strictly before its monotonic deadline', async () => {
  const time = controlledDeadline(), original = deferredResult();
  const pending = boundedRegionOperation(() => original.promise, 'controlled operation', 10, time.clock);
  await Promise.resolve(); time.moveTo(109); original.resolve('accepted');
  assert.equal(await pending, 'accepted'); assert.equal(time.fires, 0); assert.equal(time.clears, 1);
});

for (const [name, observedTime] of [['exactly at', 110], ['after', 111]]) {
  test(`bounded runner rejects completion ${name} the deadline even when the timer never fires`, async () => {
    const time = controlledDeadline(), original = deferredResult(); let starts = 0;
    const pending = boundedRegionOperation(() => { starts++; return original.promise; }, 'controlled operation', 10, time.clock);
    await Promise.resolve(); assert.equal(starts, 1);
    time.moveTo(observedTime); original.resolve('overdue result');
    await assert.rejects(pending, /controlled operation exceeded 10ms/);
    assert.equal(time.fires, 0); assert.equal(time.clears, 1);
  });

  test(`bounded runner does not start work admitted ${name} the deadline`, async () => {
    const time = controlledDeadline(); let starts = 0;
    const pending = boundedRegionOperation(() => { starts++; return 'must not run'; }, 'controlled admission', 10, time.clock);
    time.moveTo(observedTime);
    await assert.rejects(pending, /controlled admission exceeded 10ms/);
    assert.equal(starts, 0); assert.equal(time.fires, 0); assert.equal(time.clears, 1);
  });
}

test('bounded runner counts synchronous invocation time against the original deadline', async () => {
  const time = controlledDeadline();
  await assert.rejects(boundedRegionOperation(() => { time.moveTo(110); return 'overdue'; }, 'synchronous invocation', 10, time.clock),
    /synchronous invocation exceeded 10ms/);
  assert.equal(time.fires, 0); assert.equal(time.clears, 1);
});

test('bounded runner rechecks admission when time expires after observing fulfillment', async () => {
  const time = controlledDeadline(), original = deferredResult();
  const clock = { ...time.clock, now: () => {
    const sampled = time.clock.now();
    // Fulfillment is sampled in time, then the continuation is delayed to the boundary.
    if (sampled === 109) time.moveTo(110);
    return sampled;
  } };
  const pending = boundedRegionOperation(() => original.promise, 'delayed continuation', 10, clock);
  await Promise.resolve(); time.moveTo(109); original.resolve('completed before deadline');
  await assert.rejects(pending, /delayed continuation exceeded 10ms/);
  assert.equal(time.fires, 0); assert.equal(time.clears, 1);
});

test('bounded runner preserves an original failure and clears its timer', async () => {
  const time = controlledDeadline(), failure = new Error('original operation failed');
  await assert.rejects(boundedRegionOperation(() => Promise.reject(failure), 'controlled failure', 10, time.clock), error => error === failure);
  assert.equal(time.clears, 1);
});

test('bounded runner timer can reject without detaching original settlement', async () => {
  const time = controlledDeadline(), original = deferredResult(); let settled = false;
  const pending = boundedRegionOperation(() => original.promise.finally(() => { settled = true; }), 'pending operation', 10, time.clock);
  await Promise.resolve(); time.moveTo(110); time.fireTimer();
  await assert.rejects(pending, /pending operation exceeded 10ms/);
  assert.equal(settled, false); assert.equal(time.clears, 1);
  original.reject(new Error('late original rejection'));
  await assert.rejects(original.promise, /late original rejection/);
  await Promise.resolve(); assert.equal(settled, true);
});

test('region runner imports as helpers and accepts only explicit prepare or frozen execution modes', () => {
  const prepared = parseRegionInitializationArgs(['--prepare-only', '--output', '/tmp/region-prepared']);
  assert.equal(prepared.prepareOnly, true);
  assert.equal(prepared.prepared, undefined);
  assert.equal(prepared.output, '/tmp/region-prepared');
  const native = parseRegionInitializationArgs(['--output', '/tmp/region-native', '--prepared', '/tmp/region-prepared']);
  assert.equal(native.prepareOnly, false);
  assert.equal(native.prepared, '/tmp/region-prepared');
  assert.equal(native.output, '/tmp/region-native');
});

for (const [label, args] of [
  ['no explicit mode', []],
  ['output only', ['--output', '/tmp/result']],
  ['preparation without output', ['--prepare-only']],
  ['execution without output', ['--prepared', '/tmp/prepared']],
  ['missing preparation path', ['--prepared', '--output', '/tmp/result']],
  ['missing output path', ['--prepare-only', '--output']],
  ['both execution modes', ['--prepare-only', '--prepared', '/tmp/prepared', '--output', '/tmp/result']],
  ['duplicate preparation flag', ['--prepare-only', '--prepare-only', '--output', '/tmp/result']],
  ['duplicate prepared input', ['--prepared', '/tmp/one', '--prepared', '/tmp/two', '--output', '/tmp/result']],
  ['duplicate output', ['--prepare-only', '--output', '/tmp/one', '--output', '/tmp/two']],
  ['unknown flag', ['--prepare-only', '--output', '/tmp/result', '--software']],
  ['positional argument', ['--prepare-only', '--output', '/tmp/result', 'extra']],
  ['overwriting frozen input', ['--prepared', '/tmp/frozen', '--output', '/tmp/frozen']],
  ['equivalent frozen output path', ['--prepared', '/tmp/frozen', '--output', '/tmp/another/../frozen']],
]) test(`region runner rejects ${label}`, () => {
  assert.throws(() => parseRegionInitializationArgs(args));
});

test('region receipt canonicalization sorts object keys and preserves ordered sequence identity', () => {
  const first = { z: [{ b: 2, a: 1 }, { source: 'second' }], a: { v: true, k: 5 } };
  const reorderedKeys = { a: { k: 5, v: true }, z: [{ a: 1, b: 2 }, { source: 'second' }] };
  assert.equal(canonicalJson(first), canonicalJson(reorderedKeys));
  assert.notEqual(canonicalJson(first), canonicalJson({ ...first, z: [...first.z].reverse() }));
});

test('region hardware guard accepts the declared headed Chrome environment', () => {
  assert.doesNotThrow(() => validateHardwareEnvironment({ STRATA_TEST_BROWSER_CHANNEL: 'chrome', STRATA_TEST_HEADED: '1', STRATA_TEST_SOFTWARE_GPU: '0' }));
});

for (const [label, overrides] of [
  ['Chromium substitution', { STRATA_TEST_BROWSER_CHANNEL: 'chromium' }],
  ['headless substitution', { STRATA_TEST_HEADED: '0' }],
  ['software GPU substitution', { STRATA_TEST_SOFTWARE_GPU: '1' }],
]) test(`region hardware guard rejects ${label}`, () => {
  assert.throws(() => validateHardwareEnvironment({ STRATA_TEST_BROWSER_CHANNEL: 'chrome', STRATA_TEST_HEADED: '1', STRATA_TEST_SOFTWARE_GPU: '0', ...overrides }));
});

function evidence() {
  const source = { head: '1'.repeat(40), tree: '2'.repeat(40), dirty: false, status: '',
    trackedDiffSha256: createHash('sha256').update('').digest('hex'), runnerSha256: '3'.repeat(64),
    inputs: [
      { path: 'packages/core/src/geometry/region-initialization.ts', bytes: 100, sha256: '4'.repeat(64) },
      { path: 'tests/browser/region-initialization-validation.ts', bytes: 200, sha256: '5'.repeat(64) },
    ] };
  const runtime = ['index.d.ts', 'index.js', 'strata_runtime.wasm', 'worker.js']
    .map((path, index) => ({ path, bytes: 10 + index, sha256: '6'.repeat(64) }));
  return { schema: 'strata-region-initialization-validation-v1', mode: 'prepared', passed: true, status: 'prepared',
    performanceEvidence: false, browserLaunched: false, gpuExecutionAttempted: false,
    generatedFixtureCleanup: 'removed', frozenCopiesVerifiedAfter: true,
    cleanupErrors: [], identityErrors: [], routeErrors: [], browserErrors: [], requestFailures: [], responseErrors: [],
    sourceBefore: source, sourceAfter: structuredClone(source), builtRuntimeBefore: runtime, builtRuntimeAfter: structuredClone(runtime),
    browserBundleSha256: '7'.repeat(64), preparationSha256: '8'.repeat(64),
    fixtures: structuredClone(REGION_FIXTURE_IDENTITIES), executionPlan: structuredClone(REGION_EXECUTION_PLAN),
    installedChrome: { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', version: '152.0.7977.82',
      executableSha256: '9'.repeat(64), infoPlistSha256: 'a'.repeat(64) } };
}
function mutateBoth(record, prefix, mutate) {
  mutate(record[`${prefix}Before`]); mutate(record[`${prefix}After`]);
}

test('frozen evidence validator accepts exact code, package, fixture, plan and installed browser identity', () => {
  const prepared = evidence(); const current = structuredClone(prepared);
  delete current.mode; delete current.passed; delete current.schema;
  const before = structuredClone({ prepared, current });
  assert.equal(validatePreparedEvidence(prepared, current), true);
  assert.deepEqual({ prepared, current }, before);
  assert.equal(REGION_EXECUTION_PLAN.directSubmissions, 8);
  assert.deepEqual(REGION_EXECUTION_PLAN.coordinatorLimits,
    { maxDesiredRegions: 4, maxLiveRegions: 2, maxManifestBytes: 2768, maxRetainedManifestBytes: 5536 });
  assert.deepEqual(REGION_FIXTURE_IDENTITIES.map(source => [source.seed, source.manifestBytes]), [[51, 2766], [52, 2768], [53, 2768], [54, 2766]]);
});

for (const [label, mutate] of [
  ['failed preparation', prepared => { prepared.passed = false; }],
  ['native report substituted for preparation', prepared => { prepared.mode = 'native'; }],
  ['unknown report schema', prepared => { prepared.schema = 'other'; }],
  ['incomplete preparation status', prepared => { prepared.status = 'running'; }],
  ['browser launched during preparation', prepared => { prepared.browserLaunched = true; }],
  ['GPU attempted during preparation', prepared => { prepared.gpuExecutionAttempted = true; }],
  ['unremoved generated fixtures', prepared => { prepared.generatedFixtureCleanup = 'pending'; }],
  ['unverified frozen copies', prepared => { prepared.frozenCopiesVerifiedAfter = false; }],
  ['failure retained in successful report', prepared => { prepared.failure = { message: 'earlier failure' }; }],
  ['cleanup failure retained in successful report', prepared => { prepared.cleanupErrors.push({ message: 'resource still live' }); }],
  ['source changed within preparation', prepared => { prepared.sourceAfter.head = 'b'.repeat(40); }],
  ['package changed within preparation', prepared => { prepared.builtRuntimeAfter[0].sha256 = 'b'.repeat(64); }],
  ['current HEAD drift', (_prepared, current) => mutateBoth(current, 'source', source => { source.head = 'b'.repeat(40); })],
  ['current tracked edit', (_prepared, current) => mutateBoth(current, 'source', source => { source.dirty = true; source.status = ' M file.ts\n'; })],
  ['current input content drift', (_prepared, current) => mutateBoth(current, 'source', source => { source.inputs[0].sha256 = 'b'.repeat(64); })],
  ['current input length drift', (_prepared, current) => mutateBoth(current, 'source', source => { source.inputs[0].bytes++; })],
  ['runner identity drift', (_prepared, current) => mutateBoth(current, 'source', source => { source.runnerSha256 = 'b'.repeat(64); })],
  ['current built package drift', (_prepared, current) => mutateBoth(current, 'builtRuntime', runtime => { runtime[0].sha256 = 'b'.repeat(64); })],
  ['browser bundle drift', (_prepared, current) => { current.browserBundleSha256 = 'b'.repeat(64); }],
  ['preparation plan hash drift', (_prepared, current) => { current.preparationSha256 = 'b'.repeat(64); }],
  ['fixture byte identity drift', (_prepared, current) => { current.fixtures[0].manifestSha256 = 'b'.repeat(64); }],
  ['enlarged execution allowance', (_prepared, current) => { current.executionPlan.directSubmissions++; }],
  ['installed Chrome binary drift', (_prepared, current) => { current.installedChrome.executableSha256 = 'b'.repeat(64); }],
  ['installed Chrome version drift', (_prepared, current) => { current.installedChrome.version = '153.0.0.0'; }],
]) test(`frozen evidence validator rejects ${label} before execution`, () => {
  const prepared = evidence(); const current = structuredClone(prepared);
  mutate(prepared, current);
  assert.throws(() => validatePreparedEvidence(prepared, current));
});

for (const [label, mutate] of [
  ['unsafe input path', record => mutateBoth(record, 'source', source => { source.inputs[0].path = '../outside.ts'; })],
  ['duplicate input path', record => mutateBoth(record, 'source', source => { source.inputs[1].path = source.inputs[0].path; })],
  ['unsorted input list', record => mutateBoth(record, 'source', source => { source.inputs.reverse(); })],
  ['malformed hash', record => mutateBoth(record, 'source', source => { source.inputs[0].sha256 = 'invalid'; })],
  ['negative input byte count', record => mutateBoth(record, 'source', source => { source.inputs[0].bytes = -1; })],
  ['missing source inventory', record => mutateBoth(record, 'source', source => { source.inputs = []; })],
  ['missing WASM runtime', record => { record.builtRuntimeBefore = record.builtRuntimeBefore.filter(file => file.path !== 'strata_runtime.wasm'); record.builtRuntimeAfter = structuredClone(record.builtRuntimeBefore); }],
  ['missing declarations', record => { record.builtRuntimeBefore = record.builtRuntimeBefore.filter(file => !file.path.endsWith('.d.ts')); record.builtRuntimeAfter = structuredClone(record.builtRuntimeBefore); }],
]) test(`frozen evidence validator rejects matching but invalid ${label}`, () => {
  const prepared = evidence(); mutate(prepared);
  assert.throws(() => validatePreparedEvidence(prepared, structuredClone(prepared)));
});
