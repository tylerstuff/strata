import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeProcessTracker } from './preview-process-identity-linux.mjs';

// CPU-only tracker contracts. Every census, native handle, namespace read,
// existence check and real-signal seam is injected. No /proc or process kill.
const ROOT = 100, CANDIDATE = 101, CONTROL = 900;
const error = code => Object.assign(new Error(`Controlled ${code}`), { code });
const identity = (pid, ppid = 1, extra = {}) => ({ pid, ppid, pgid: pid, state: 'S', command: '/controlled/node',
  startTicks: String(pid * 10), ...extra });
const namespaceEvidence = () => ({ checkerPid: process.pid, nstgid: process.pid, valueCount: 1, byteCount: 100 });
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function waitFor(predicate) {
  const expires = Date.now() + 1500;
  while (!predicate()) { assert.ok(Date.now() < expires, 'Expected controlled operation to start or settle'); await delay(1); }
}

function fixture(context, options = {}) {
  const native = new Map([[ROOT, identity(ROOT)], [CONTROL, identity(CONTROL)]]);
  const census = new Map([...native].map(([pid, value]) => [pid, { ...value }]));
  const opens = [], nativeHandles = [], reads = [], closes = [], closed = [], signals = [], existence = [];
  const namespaceOpens = [], namespaceHandles = [], namespaceReads = [], namespaceCloses = [], namespaceClosed = [];
  const hooks = { open: null, read: null, close: null, census: null, namespaceOpen: null, namespaceRead: null,
    namespaceClose: null, existence: null, now: null };
  let running = true, offset = 0, censusCalls = 0;
  const rows = () => [...census.values()].map(value => ({ ...value, start: `birth-${value.startTicks}` }));
  const tracker = createNativeProcessTracker({
    rootPid: ROOT, rootCommand: '/controlled/node', rootIsRunning: () => running,
    censusMs: 30, pollIntervalMs: 1000, now: () => hooks.now ? hooks.now() : Date.now() + offset,
    nativeProvider: { async open(pid) {
      opens.push(pid);
      if (hooks.open) await hooks.open(pid);
      const record = { pid, number: nativeHandles.length + 1 }; nativeHandles.push(record);
      return {
        async read() {
          reads.push(pid);
          if (hooks.read) return hooks.read(pid);
          const value = native.get(pid);
          if (!value) throw error('ESRCH');
          return { ...value };
        },
        async close() { closes.push(record); if (hooks.close) await hooks.close(pid); closed.push(record); },
      };
    } },
    namespaceProvider: { async open() {
      const number = namespaceOpens.length + 1; namespaceOpens.push(number);
      if (hooks.namespaceOpen) await hooks.namespaceOpen(number);
      namespaceHandles.push(number);
      let reading;
      return {
        read(isUsable) {
          assert.equal(typeof isUsable, 'function', 'Namespace read receives the same-lease preflight');
          namespaceReads.push(number);
          reading = Promise.resolve().then(() => hooks.namespaceRead ? hooks.namespaceRead(number, isUsable) : namespaceEvidence());
          return reading;
        },
        async close() {
          namespaceCloses.push(number);
          if (reading) await reading.catch(() => {});
          if (hooks.namespaceClose) await hooks.namespaceClose(number);
          namespaceClosed.push(number);
        },
      };
    } },
    checkPidExistence(pid) {
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      existence.push(pid);
      if (hooks.existence) return hooks.existence(pid);
      throw error('ESRCH');
    },
    readProcesses: async () => {
      censusCalls++;
      return hooks.census ? hooks.census(censusCalls, rows()) : rows();
    },
    signalProcess(pid, signal) {
      assert.notEqual(pid, CONTROL, 'Unrelated process may never receive a real signal');
      signals.push({ pid, signal }); native.delete(pid); census.delete(pid);
      if (pid === ROOT) running = false;
    },
    ...options,
  });
  const rootExited = () => { running = false; native.delete(ROOT); census.delete(ROOT); };
  const stop = overrides => tracker.cleanup({ reason: 'graceful', termGraceMs: 0, killGraceMs: 20, ...overrides });
  const finish = async () => { rootExited(); return stop(); };
  context.after(async () => { await finish(); });
  return { tracker, hooks, native, census, opens, nativeHandles, reads, closes, closed, signals, existence,
    namespaceOpens, namespaceHandles, namespaceReads, namespaceCloses, namespaceClosed, rows, rootExited, stop, finish,
    get censusCalls() { return censusCalls; },
    advance(milliseconds) { offset += milliseconds; },
    add(pid = CANDIDATE, ppid = ROOT, extra = {}) { const value = identity(pid, ppid, extra); native.set(pid, value); census.set(pid, { ...value }); },
    disappear(pid = CANDIDATE, { keepRow = false, code = 'ENOENT', onOpen } = {}) {
      this.add(pid);
      hooks.open = async openedPid => {
        if (openedPid !== pid) return;
        native.delete(pid); if (!keepRow) census.delete(pid);
        if (onOpen) await onOpen();
        throw error(code);
      };
    },
  };
}

const acquisition = (result, pid = CANDIDATE) => {
  const entries = result.nativeAcquisitions.filter(entry => entry.pid === pid);
  assert.equal(entries.length, 1, `Exactly one acquisition event for PID ${pid}`);
  return entries[0];
};
function noCandidateAuthority(result, h, pids = [CANDIDATE]) {
  for (const pid of pids) {
    assert.ok(!result.observed.some(row => row.pid === pid), `PID ${pid} was not admitted`);
    assert.ok(!h.signals.some(call => call.pid === pid), `PID ${pid} received no real signal`);
    assert.ok(!result.remaining.some(row => row.pid === pid), `PID ${pid} has no retained authority`);
  }
  assert.deepEqual(h.native.get(CONTROL), identity(CONTROL), 'Unrelated native identity stays unchanged');
  assert.ok(!h.opens.includes(CONTROL));
}
function allResourcesClosed(result, h) {
  const expected = h.nativeHandles.length + h.namespaceHandles.length;
  assert.equal(result.nativeResources.opened, expected);
  assert.equal(result.nativeResources.closed, expected);
  assert.equal(result.nativeResources.held, 0);
  for (const key of ['pendingOpens', 'pendingReads', 'pendingCloses', 'pendingCensuses', 'pendingConfirmations',
    'heldIdentities', 'heldNamespaces']) assert.equal(result.nativeResources[key], 0, key);
  assert.equal(result.nativeResources.unsettled, false);
  assert.equal(h.closes.length, h.nativeHandles.length);
  assert.equal(new Set(h.closes).size, h.closes.length, 'Each native handle closes once');
  assert.equal(h.namespaceCloses.length, h.namespaceHandles.length);
  assert.equal(new Set(h.namespaceCloses).size, h.namespaceCloses.length, 'Each namespace handle closes once');
}

test('CPU absence: records root/success/failure acquisitions and accepts only the complete follow-up', async context => {
  const h = fixture(context); await h.tracker.start();
  h.add(102); await h.tracker.sample();
  h.disappear(); await h.tracker.sample();
  const result = await h.finish(), entry = acquisition(result);
  assert.equal(result.cleanupUnknown, false);
  assert.equal(result.nativeAcquisitionCount, 3);
  assert.deepEqual(result.nativeAcquisitions.map(item => item.sequence), [1, 2, 3]);
  assert.equal(acquisition(result, ROOT).role, 'root');
  assert.equal(acquisition(result, ROOT).resolution, 'admitted');
  assert.equal(acquisition(result, 102).resolution, 'admitted');
  assert.equal(entry.role, 'descendant');
  assert.equal(entry.discovery.row.pid, CANDIDATE);
  assert.equal(entry.discovery.row.ppid, ROOT);
  assert.equal(entry.parentBefore.startTicks, identity(ROOT).startTicks);
  assert.equal(entry.resolution, 'absent-before-admission');
  assert.equal(entry.providerOutcome.status, 'rejected');
  assert.equal(entry.providerOutcome.error.code, 'ENOENT');
  assert.equal(entry.observationOutcome.status, 'received');
  assert.ok(entry.scheduledAt <= entry.startedAt && entry.startedAt <= entry.settledAt);
  assert.ok(entry.confirmation.census.sampleId > entry.discovery.sampleId);
  assert.ok(entry.confirmation.census.rowCount >= 2, 'Confirmation is a whole census with live root and unrelated control');
  assert.equal(entry.confirmation.census.candidate, null);
  assert.deepEqual(entry.confirmation.census.dependents, { count: 0, rows: [] });
  assert.equal(entry.confirmation.namespaceBefore.nstgid, process.pid);
  assert.equal(entry.confirmation.namespaceAfter.nstgid, process.pid);
  assert.equal(entry.confirmation.parentAfter.startTicks, entry.parentBefore.startTicks);
  assert.equal(entry.confirmation.existence.code, 'ESRCH');
  assert.equal(entry.confirmation.existence.absent, true);
  assert.equal(entry.confirmation.existence.error.code, 'ESRCH');
  assert.ok(result.nativeErrors.some(item => item.pid === CANDIDATE && item.operation === 'open' && item.code === 'ENOENT'));
  assert.equal(result.nativeErrorCount, 1, 'Confirmation does not erase the original failure');
  assert.deepEqual(h.existence, [CANDIDATE]);
  assert.equal(h.namespaceOpens.length, 2);
  noCandidateAuthority(result, h); allResourcesClosed(result, h);
});

test('CPU absence: confirmation census is evidence only and does not recursively admit new candidates', async context => {
  const h = fixture(context); await h.tracker.start(); h.disappear();
  h.hooks.census = (call, rows) => call === 3 ? [...rows, { ...identity(103, ROOT), start: 'fresh-only' }] : rows;
  await h.tracker.sample(); const result = await h.finish();
  assert.equal(result.cleanupUnknown, false);
  assert.ok(!h.opens.includes(103));
  assert.equal(acquisition(result).confirmation.census.rowCount, 3);
  noCandidateAuthority(result, h, [CANDIDATE, 103]); allResourcesClosed(result, h);
});

for (const code of ['ESRCH', 'EACCES', 'EPERM', 'EIO']) {
  test(`CPU absence: descendant initial ${code} cannot enter the ENOENT-only gate`, async context => {
    const h = fixture(context); await h.tracker.start(); h.disappear(CANDIDATE, { code });
    await h.tracker.sample(); const result = await h.finish(), entry = acquisition(result);
    assert.equal(result.cleanupUnknown, true); assert.equal(entry.resolution, 'unresolved');
    assert.equal(entry.providerOutcome.error.code, code);
    assert.equal(h.namespaceOpens.length, 0); assert.deepEqual(h.existence, []);
    noCandidateAuthority(result, h); allResourcesClosed(result, h);
  });
}

test('CPU absence: root ENOENT remains unresolved and never borrows the descendant exception', async context => {
  const h = fixture(context); h.hooks.open = () => { throw error('ENOENT'); };
  await h.tracker.start(); const result = await h.finish();
  assert.equal(result.cleanupUnknown, true); assert.equal(acquisition(result, ROOT).resolution, 'unresolved');
  assert.deepEqual(result.observed, []); assert.deepEqual(h.existence, []); assert.equal(h.namespaceOpens.length, 0);
  allResourcesClosed(result, h);
});

for (const state of ['S', 'Z', 'X']) {
  test(`CPU absence: any fresh candidate row, including ${state}, rejects the gate`, async context => {
    const h = fixture(context); await h.tracker.start(); h.disappear(CANDIDATE, { keepRow: true });
    // The discovery row must remain live to begin acquisition; change only the fresh census.
    h.hooks.census = (call, rows) => call === 3 ? rows.map(row => row.pid === CANDIDATE ? { ...row, state } : row) : rows;
    await h.tracker.sample(); const result = await h.finish();
    assert.equal(result.cleanupUnknown, true); assert.equal(acquisition(result).resolution, 'unresolved');
    assert.equal(acquisition(result).confirmation.census.candidate.state, state);
    assert.deepEqual(h.existence, []); assert.equal(h.opens.filter(pid => pid === CANDIDATE).length, 1);
    noCandidateAuthority(result, h); allResourcesClosed(result, h);
  });
}

for (const outcome of ['present', 'EPERM', 'EIO']) {
  test(`CPU absence: native existence ${outcome} cannot confirm census absence`, async context => {
    const h = fixture(context); await h.tracker.start(); h.disappear();
    h.hooks.existence = () => { if (outcome !== 'present') throw error(outcome); };
    await h.tracker.sample(); const result = await h.finish();
    assert.equal(result.cleanupUnknown, true); assert.equal(acquisition(result).resolution, 'unresolved');
    assert.equal(acquisition(result).confirmation.existence.absent, false);
    assert.deepEqual(h.existence, [CANDIDATE]); assert.equal(h.opens.filter(pid => pid === CANDIDATE).length, 1);
    noCandidateAuthority(result, h); allResourcesClosed(result, h);
  });
}

for (const phase of ['discovery', 'confirmation']) {
  test(`CPU absence: ${phase} descendants never inherit authority through the candidate`, async context => {
    const h = fixture(context); await h.tracker.start(); h.disappear();
    const descendants = [identity(102, CANDIDATE), identity(103, 102)];
    if (phase === 'discovery') for (const row of descendants) { h.native.set(row.pid, row); h.census.set(row.pid, { ...row }); }
    else h.hooks.census = (call, rows) => call === 3 ? [...rows, ...descendants.map(row => ({ ...row, start: `birth-${row.startTicks}` }))] : rows;
    await h.tracker.sample(); const result = await h.finish();
    assert.equal(result.cleanupUnknown, true); assert.equal(acquisition(result).resolution, 'unresolved');
    assert.deepEqual(h.existence, []); assert.ok(!h.opens.includes(102) && !h.opens.includes(103));
    noCandidateAuthority(result, h, [CANDIDATE, 102, 103]); allResourcesClosed(result, h);
  });
}

for (const malformed of ['throw', 'duplicate', 'invalid-row', 'empty']) {
  test(`CPU absence: fresh census ${malformed} retains uncertainty and never runs general admission`, async context => {
    const h = fixture(context); await h.tracker.start(); h.disappear();
    h.hooks.census = (call, rows) => {
      if (call !== 3) return rows;
      if (malformed === 'throw') throw error('EIO');
      if (malformed === 'duplicate') return [...rows, rows[0]];
      if (malformed === 'invalid-row') return [...rows, { pid: -1, ppid: ROOT }];
      return [];
    };
    await h.tracker.sample(); const result = await h.finish();
    assert.equal(result.cleanupUnknown, true); assert.equal(acquisition(result).resolution, 'unresolved');
    assert.deepEqual(h.existence, []);
    noCandidateAuthority(result, h); allResourcesClosed(result, h);
  });
}

test('CPU absence: fresh census failure retains bounded command diagnostics without workload payloads', async context => {
  const h = fixture(context); await h.tracker.start(); h.disappear();
  const secret = 'UNEXPECTED_PRIVATE_WORKLOAD_PAYLOAD';
  h.hooks.census = (call, rows) => {
    if (call !== 3) return rows;
    throw Object.assign(new Error('Controlled census command failed'), { code: 23, signal: 'SIGTERM', killed: true,
      stdout: secret, stderr: secret, diagnostic: { kind: 'invalid-census-identity', rowIndex: 2, rowBytes: 2000,
        rowPrefix: 'bounded diagnostic prefix '.repeat(40), identity: { ...identity(107), start: 'known birth', argv: secret },
        scene: secret } });
  };
  await h.tracker.sample(); const result = await h.finish();
  assert.equal(result.cleanupUnknown, true); assert.equal(acquisition(result).resolution, 'unresolved');
  assert.equal(result.censusErrors.length, 1);
  const failure = result.censusErrors[0];
  assert.equal(failure.code, 23); assert.equal(failure.signal, 'SIGTERM'); assert.equal(failure.killed, true);
  assert.equal(failure.diagnostic.kind, 'invalid-census-identity'); assert.equal(failure.diagnostic.rowIndex, 2);
  assert.equal(failure.diagnostic.rowBytes, 2000); assert.equal(failure.diagnostic.identity.pid, 107);
  assert.ok(Buffer.byteLength(failure.diagnostic.rowPrefix) <= 512);
  assert.ok(failure.diagnostic.rowPrefix.startsWith('bounded diagnostic prefix'));
  assert.ok(!JSON.stringify(result).includes(secret)); assert.deepEqual(h.existence, []);
  noCandidateAuthority(result, h); allResourcesClosed(result, h);
});

const invalidNamespaces = [
  ['missing', undefined], ['multiple', { ...namespaceEvidence(), valueCount: 2 }],
  ['mismatched', { ...namespaceEvidence(), nstgid: process.pid + 1 }],
  ['wrong-checker', { ...namespaceEvidence(), checkerPid: process.pid + 1 }],
  ['zero', { ...namespaceEvidence(), nstgid: 0 }],
  ['unsafe', { ...namespaceEvidence(), nstgid: Number.MAX_SAFE_INTEGER + 1 }],
  ['fractional', { ...namespaceEvidence(), nstgid: 1.5 }],
  ['oversized', { ...namespaceEvidence(), byteCount: 65537 }],
];
for (const [label, value] of invalidNamespaces) {
  test(`CPU absence: invalid first namespace evidence (${label}) cannot fall back`, async context => {
    const h = fixture(context); await h.tracker.start(); h.disappear();
    h.hooks.namespaceRead = () => value;
    await h.tracker.sample(); const result = await h.finish();
    assert.equal(result.cleanupUnknown, true); assert.equal(acquisition(result).resolution, 'unresolved');
    assert.deepEqual(h.existence, []); assert.equal(h.namespaceOpens.length, 1);
    noCandidateAuthority(result, h); allResourcesClosed(result, h);
  });
}

test('CPU absence: a failed second namespace gate cannot upgrade earlier ESRCH to confirmation', async context => {
  const h = fixture(context); await h.tracker.start(); h.disappear();
  h.hooks.namespaceRead = number => number === 1 ? namespaceEvidence() : { ...namespaceEvidence(), valueCount: 2 };
  await h.tracker.sample(); const result = await h.finish(), entry = acquisition(result);
  assert.equal(result.cleanupUnknown, true); assert.equal(entry.resolution, 'unresolved');
  assert.equal(entry.confirmation.existence.absent, true);
  assert.deepEqual(h.existence, [CANDIDATE]); assert.equal(h.namespaceOpens.length, 2);
  noCandidateAuthority(result, h); allResourcesClosed(result, h);
});

for (const operation of ['open', 'read', 'close']) {
  test(`CPU absence: namespace ${operation} failure is retained as uncertainty`, async context => {
    const h = fixture(context); await h.tracker.start(); h.disappear();
    const name = { open: 'namespaceOpen', read: 'namespaceRead', close: 'namespaceClose' }[operation];
    h.hooks[name] = () => { throw error('EIO'); };
    await h.tracker.sample(); const result = await h.finish();
    assert.equal(result.cleanupUnknown, true); assert.equal(acquisition(result).resolution, 'unresolved');
    assert.equal(result.nativeErrors.filter(item => item.code === 'EIO').length, 1, 'Raw failure is recorded exactly once');
    assert.deepEqual(h.existence, []); noCandidateAuthority(result, h);
    if (operation === 'close') {
      assert.equal(h.namespaceCloses.length, 1); assert.equal(h.namespaceClosed.length, 0);
      assert.equal(result.nativeResources.unsettled, true);
    } else allResourcesClosed(result, h);
  });
}

test('CPU absence: namespace read and close failures both survive without replacing the primary failure', async context => {
  const h = fixture(context); await h.tracker.start(); h.disappear();
  h.hooks.namespaceRead = () => { throw error('EACCES'); };
  h.hooks.namespaceClose = () => { throw error('EIO'); };
  await h.tracker.sample(); const result = await h.finish();
  assert.equal(result.cleanupUnknown, true); assert.equal(acquisition(result).resolution, 'unresolved');
  assert.equal(acquisition(result).confirmation.error.code, 'EACCES');
  assert.equal(result.nativeErrors.filter(item => item.code === 'EACCES').length, 1);
  assert.equal(result.nativeErrors.filter(item => item.code === 'EIO').length, 1);
  assert.equal(result.nativeErrors.filter(item => item.code === 'ENOENT').length, 1);
  assert.equal(result.nativeErrorCount, 3);
  assert.deepEqual(h.namespaceCloses, [1]); assert.deepEqual(h.namespaceClosed, []);
  assert.equal(result.nativeResources.unsettled, true); assert.deepEqual(h.existence, []);
  noCandidateAuthority(result, h);
});

for (const change of ['death', 'birth', 'read-error', 'label']) {
  test(`CPU absence: retained parent ${change} is checked after the confirmation`, async context => {
    const h = fixture(context); await h.tracker.start(); h.disappear();
    h.hooks.namespaceRead = number => {
      if (number === 2) {
        if (change === 'death') h.rootExited();
        if (change === 'birth') h.native.get(ROOT).startTicks = '99999';
        if (change === 'label') h.native.get(ROOT).command = 'renamed-parent';
        if (change === 'read-error') h.hooks.read = () => { throw error('EIO'); };
      }
      return namespaceEvidence();
    };
    await h.tracker.sample(); h.hooks.read = null;
    const result = await h.finish();
    assert.equal(acquisition(result).resolution, change === 'label' ? 'absent-before-admission' : 'unresolved');
    assert.equal(result.cleanupUnknown, change !== 'label');
    assert.deepEqual(h.existence, [CANDIDATE]);
    noCandidateAuthority(result, h); allResourcesClosed(result, h);
  });
}

test('CPU absence: confirmed absence remains quarantined across PID reuse and dependent observations', async context => {
  const h = fixture(context); await h.tracker.start(); h.disappear(); await h.tracker.sample();
  h.hooks.open = null;
  h.add(CANDIDATE, CONTROL, { command: 'unrelated-reused-label', startTicks: '99999' });
  h.add(102, CANDIDATE);
  await h.tracker.sample(); const result = await h.finish(), entry = acquisition(result);
  assert.equal(result.cleanupUnknown, true); assert.ok(entry.laterContradiction);
  assert.equal(entry.confirmation.existence.absent, true, 'Prior observation evidence remains in the receipt');
  assert.equal(h.opens.filter(pid => pid === CANDIDATE).length, 1); assert.ok(!h.opens.includes(102));
  assert.deepEqual(h.existence, [CANDIDATE]);
  noCandidateAuthority(result, h, [CANDIDATE, 102]); allResourcesClosed(result, h);
});

test('CPU absence: a later dependent without the candidate row is also contradictory', async context => {
  const h = fixture(context); await h.tracker.start(); h.disappear(); await h.tracker.sample();
  h.add(102, CANDIDATE); await h.tracker.sample(); const result = await h.finish();
  assert.equal(result.cleanupUnknown, true); assert.ok(acquisition(result).laterContradiction);
  assert.ok(!h.opens.includes(102)); noCandidateAuthority(result, h, [CANDIDATE, 102]); allResourcesClosed(result, h);
});

test('CPU absence: confirming one candidate never clears unrelated sticky uncertainty', async context => {
  const h = fixture(context); await h.tracker.start();
  h.hooks.census = () => { throw error('PRIOR_CENSUS_FAILURE'); }; await h.tracker.sample(); h.hooks.census = null;
  h.disappear(); await h.tracker.sample(); const result = await h.finish();
  assert.equal(acquisition(result).resolution, 'absent-before-admission');
  assert.equal(result.cleanupUnknown, true);
  assert.ok(result.censusErrors.some(item => item.code === 'PRIOR_CENSUS_FAILURE'));
  assert.ok(result.nativeErrors.some(item => item.code === 'ENOENT'));
  noCandidateAuthority(result, h); allResourcesClosed(result, h);
});

test('CPU absence: lifetime acquisition capacity retains failed attempts and stops before an extra provider call', async context => {
  const h = fixture(context, { maxAcquisitions: 2, maxProcesses: 10 }); await h.tracker.start();
  h.disappear(); await h.tracker.sample(); h.add(102); await h.tracker.sample(); const result = await h.finish();
  assert.equal(result.nativeAcquisitionCount, 2); assert.equal(result.nativeAcquisitions.length, 2);
  assert.equal(result.nativeAcquisitionLimitReached, true); assert.equal(result.cleanupUnknown, true);
  assert.deepEqual(h.opens, [ROOT, CANDIDATE]);
  assert.equal(acquisition(result).providerOutcome.error.code, 'ENOENT');
  noCandidateAuthority(result, h, [CANDIDATE, 102]); allResourcesClosed(result, h);
});

test('CPU absence: an actual ENOENT settled after the lease is not an eligible in-time failure', async context => {
  const h = fixture(context); await h.tracker.start();
  h.disappear(CANDIDATE, { onOpen: () => { h.advance(1000); } });
  await h.tracker.sample(); const result = await h.finish(), entry = acquisition(result);
  assert.equal(entry.providerOutcome.status, 'rejected'); assert.equal(entry.providerOutcome.error.code, 'ENOENT');
  assert.equal(entry.resolution, 'unresolved'); assert.equal(result.cleanupUnknown, true);
  assert.equal(h.namespaceOpens.length, 0); assert.deepEqual(h.existence, []);
  noCandidateAuthority(result, h); allResourcesClosed(result, h);
});

test('CPU absence: late provider ENOENT is recorded separately from the observation timeout', async context => {
  const h = fixture(context), opening = deferred(); await h.tracker.start(); h.add();
  h.hooks.open = pid => pid === CANDIDATE ? opening.promise : undefined;
  await h.tracker.sample();
  h.native.delete(CANDIDATE); h.census.delete(CANDIDATE); opening.reject(error('ENOENT'));
  await delay(0); const result = await h.finish(), entry = acquisition(result);
  assert.equal(entry.providerOutcome.status, 'rejected'); assert.equal(entry.providerOutcome.error.code, 'ENOENT');
  assert.equal(entry.observationOutcome.status, 'timed-out');
  assert.equal(entry.observationOutcome.error.code, 'IDENTITY_TIMEOUT');
  assert.equal(entry.resolution, 'unresolved'); assert.equal(result.cleanupUnknown, true);
  assert.equal(h.namespaceOpens.length, 0); assert.deepEqual(h.existence, []);
  noCandidateAuthority(result, h); allResourcesClosed(result, h);
});

test('CPU absence: overdue namespace fulfillment cannot beat a delayed timer or trigger signal zero', async context => {
  const h = fixture(context); await h.tracker.start(); h.disappear();
  h.hooks.namespaceRead = () => { h.advance(1000); return namespaceEvidence(); };
  await h.tracker.sample(); const result = await h.finish();
  assert.equal(result.cleanupUnknown, true); assert.equal(acquisition(result).resolution, 'unresolved');
  assert.deepEqual(h.existence, []); assert.equal(h.namespaceOpens.length, 1);
  noCandidateAuthority(result, h); allResourcesClosed(result, h);
});

test('CPU absence: shutdown while fresh census is pending prevents later existence/admission checks', async context => {
  const h = fixture(context), confirming = deferred(); await h.tracker.start(); h.disappear();
  h.hooks.census = (call, rows) => call === 3 ? confirming.promise : rows;
  const sampling = h.tracker.sample(); await waitFor(() => h.censusCalls === 3);
  const stopping = h.stop(); confirming.resolve(h.rows()); await sampling; const result = await stopping;
  assert.equal(result.cleanupUnknown, true); assert.equal(acquisition(result).resolution, 'unresolved');
  assert.deepEqual(h.existence, []); assert.equal(h.namespaceOpens.length, 1);
  noCandidateAuthority(result, h); allResourcesClosed(result, h);
});

for (const operation of ['open', 'read', 'close']) {
  test(`CPU absence: pending namespace ${operation} remains owned through deadline and late settlement`, async context => {
    const h = fixture(context), held = deferred(); await h.tracker.start(); h.disappear();
    const name = { open: 'namespaceOpen', read: 'namespaceRead', close: 'namespaceClose' }[operation];
    h.hooks[name] = number => number === 1 ? held.promise : operation === 'read' ? namespaceEvidence() : undefined;
    await h.tracker.sample(); const result = await h.finish(), frozen = JSON.stringify(result);
    assert.equal(result.cleanupUnknown, true); assert.equal(acquisition(result).resolution, 'unresolved');
    assert.equal(result.nativeResources.unsettled, true);
    assert.ok(result.nativeResources.pendingConfirmations > 0);
    assert.ok(result.nativeResources[{ open: 'pendingOpens', read: 'pendingReads', close: 'pendingCloses' }[operation]] > 0);
    assert.deepEqual(h.existence, []);
    held.resolve(operation === 'read' ? namespaceEvidence() : undefined);
    await waitFor(() => h.namespaceClosed.length === 1);
    assert.equal(h.namespaceCloses.length, 1, 'Late namespace handle closes exactly once');
    assert.equal(JSON.stringify(result), frozen, 'Returned deadline receipt never upgrades after late settlement');
    noCandidateAuthority(result, h);
  });
}

test('CPU absence: a late namespace read failure is observed without mutating the terminal receipt', async context => {
  const h = fixture(context), reading = deferred(); await h.tracker.start(); h.disappear();
  h.hooks.namespaceRead = () => reading.promise;
  await h.tracker.sample(); const result = await h.finish(), frozen = JSON.stringify(result);
  assert.equal(result.cleanupUnknown, true); assert.ok(result.nativeResources.pendingConfirmations > 0);
  reading.reject(error('LATE_NAMESPACE_FAILURE')); await waitFor(() => h.namespaceClosed.length === 1);
  await delay(0); assert.equal(JSON.stringify(result), frozen);
  assert.deepEqual(h.existence, []); noCandidateAuthority(result, h);
});

test('CPU absence: pending final parent read keeps confirmation owned through cleanup and cannot upgrade its receipt', async context => {
  const h = fixture(context), reading = deferred(); await h.tracker.start(); h.disappear();
  let finalParentReads = 0;
  h.hooks.namespaceClose = number => {
    if (number !== 2) return;
    h.hooks.read = pid => {
      assert.equal(pid, ROOT);
      finalParentReads++;
      return reading.promise;
    };
  };
  await h.tracker.sample();
  const result = await h.finish(), frozen = JSON.stringify(result);
  try {
    assert.equal(finalParentReads, 1, 'Only the read after the second namespace close is held');
    assert.equal(result.cleanupUnknown, true); assert.equal(acquisition(result).resolution, 'unresolved');
    assert.equal(acquisition(result).confirmation.settledAt, null, 'Actual parent work is still unsettled');
    assert.equal(result.nativeResources.pendingConfirmations, 1);
    assert.equal(result.nativeResources.pendingReads, 1);
    assert.equal(result.nativeResources.pendingCloses, 1);
    assert.equal(result.nativeResources.heldIdentities, 1);
    assert.equal(result.nativeResources.unsettled, true);
    assert.deepEqual(h.namespaceClosed, [1, 2]);
    assert.deepEqual(h.existence, [CANDIDATE]);
    assert.deepEqual(h.closes, [], 'Parent descriptor waits for its actual read');
    assert.deepEqual(h.signals, []);
  } finally { reading.resolve(identity(ROOT)); }
  await waitFor(() => h.closed.length === 1);
  assert.equal(h.closes.length, 1); assert.equal(JSON.stringify(result), frozen);
  assert.deepEqual(h.signals, []); noCandidateAuthority(result, h);
});

test('CPU absence: a late acquired native handle is closed without confirmation or publication into the receipt', async context => {
  const h = fixture(context), opening = deferred(); await h.tracker.start(); h.add();
  h.hooks.open = pid => pid === CANDIDATE ? opening.promise : undefined;
  await h.tracker.sample(); const result = await h.finish(), frozen = JSON.stringify(result);
  assert.equal(result.cleanupUnknown, true); assert.ok(result.nativeResources.pendingOpens > 0);
  assert.equal(acquisition(result).providerOutcome.status, 'pending');
  assert.equal(acquisition(result).observationOutcome.status, 'timed-out');
  opening.resolve(); await waitFor(() => h.closes.some(item => item.pid === CANDIDATE));
  assert.equal(h.closes.filter(item => item.pid === CANDIDATE).length, 1);
  assert.equal(JSON.stringify(result), frozen); assert.equal(h.namespaceOpens.length, 0); assert.deepEqual(h.existence, []);
  noCandidateAuthority(result, h);
});
