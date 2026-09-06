import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  createLinuxProcessProvider,
  createNativeProcessTracker,
  parseLinuxProcessStat,
} from './preview-process-identity-linux.mjs';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const execute = promisify(execFile);
const childPath = fileURLToPath(new URL('../tests/fixtures/preview-process-native-child.mjs', import.meta.url));
const nativeError = code => Object.assign(new Error(`Synthetic native ${code}`), { code });
const row = (pid, overrides = {}) => ({ pid, ppid: 1, pgid: pid, state: 'S',
  command: '/controlled/node', startTicks: String(pid * 10), ...overrides });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate, message = 'Expected deferred operation did not begin') {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(1);
  }
}

// Linux documents starttime as field22. This fixture constructs fields by their
// documented number, independently of the parser's delimiter/index strategy.
function statText(identity, command = identity.command) {
  const fields = Array.from({ length: 52 }, () => '0');
  fields[0] = String(identity.pid); fields[1] = `(${command})`;
  fields[2] = identity.state; fields[3] = String(identity.ppid);
  fields[4] = String(identity.pgid); fields[21] = identity.startTicks;
  return `${fields.join(' ')}\n`;
}

function synthetic(context, options = {}) {
  const native = new Map([[100, row(100)]]);
  const census = new Map([[100, row(100)]]);
  const opens = [], reads = [], closes = [], signals = [];
  const hooks = { open: null, read: null, close: null, census: null, signal: null };
  let rootRunning = true;
  const provider = {
    async open(pid) {
      opens.push(pid);
      if (hooks.open) await hooks.open(pid);
      const birth = native.get(pid)?.startTicks;
      const handle = {
        async read() {
          reads.push(pid);
          if (hooks.read) return hooks.read(pid, birth);
          const identity = native.get(pid);
          if (!identity) throw nativeError('ESRCH');
          return { ...identity };
        },
        async close() {
          closes.push(pid);
          if (hooks.close) await hooks.close(pid);
        },
      };
      return handle;
    },
  };
  const tracker = createNativeProcessTracker({
    rootPid: 100, rootCommand: '/controlled/node', rootIsRunning: () => rootRunning,
    nativeProvider: provider, censusMs: 30, pollIntervalMs: 1000,
    readProcesses: async () => {
      if (hooks.census) return hooks.census();
      return [...census.values()].map(identity => ({ ...identity, start: `birth-${identity.startTicks}` }));
    },
    signalProcess(pid, signal) {
      signals.push({ pid, signal });
      if (hooks.signal) return hooks.signal(pid, signal);
      native.delete(pid); census.delete(pid);
      if (pid === 100) rootRunning = false;
    },
    ...options,
  });
  const stop = extra => tracker.cleanup({ reason: 'graceful', termGraceMs: 0, killGraceMs: 20, ...extra });
  context.after(async () => { await stop(); });
  return { tracker, native, census, opens, reads, closes, signals, hooks, stop,
    add(identity) { native.set(identity.pid, { ...identity }); census.set(identity.pid, { ...identity }); },
    rootExited({ retainRows = false } = {}) {
      rootRunning = false;
      if (!retainRows) { native.delete(100); census.delete(100); }
    },
  };
}

function assertClosed(result, opened) {
  assert.equal(result.identityProvider, 'linux-proc-stat-fd');
  assert.equal(result.nativeResources.opened, opened);
  assert.equal(result.nativeResources.closed, opened);
  assert.equal(result.nativeResources.held, 0);
  assert.equal(result.nativeResources.pendingOpens, 0);
  assert.equal(result.nativeResources.pendingReads, 0);
  assert.equal(result.nativeResources.pendingCloses, 0);
  assert.equal(result.nativeResources.unsettled, false);
}

test('stat parser retains exact integer birth ticks and accepts parentheses in the label', () => {
  const identity = row(123, { command: 'name ) with ( parens', startTicks: '9007199254740993123', ppid: 9, pgid: 8 });
  assert.deepEqual(parseLinuxProcessStat(statText(identity), 123), identity);
  assert.throws(() => parseLinuxProcessStat(statText(identity), 124));
  for (const input of ['', '123 (cut off', statText({ ...identity, startTicks: '-1' }),
    statText({ ...identity, startTicks: '1.5' }), 'x'.repeat(4097)]) {
    assert.throws(() => parseLinuxProcessStat(input, 123));
  }
});

test('native provider uses one bounded positional read and closes the retained handle once', async () => {
  const identity = row(123), calls = [], bytes = Buffer.from(statText(identity));
  const provider = createLinuxProcessProvider({ openFile: async (...args) => {
    calls.push(['open', ...args]);
    return {
      async read(buffer, offset, length, position) {
        calls.push(['read', offset, length, position]); bytes.copy(buffer, offset);
        return { bytesRead: bytes.length, buffer };
      },
      async close() { calls.push(['close']); },
    };
  } });
  const handle = await provider.open(123);
  assert.deepEqual(await handle.read(), identity);
  await Promise.all([handle.close(), handle.close()]);
  assert.equal(calls[0][1], '/proc/123/stat');
  assert.deepEqual(calls.find(call => call[0] === 'read'), ['read', 0, 4097, 0]);
  assert.equal(calls.filter(call => call[0] === 'close').length, 1);
});

test('provider propagates missing/access failures and rejects oversized or malformed reads', async () => {
  for (const code of ['ENOENT', 'EACCES', 'ESRCH']) {
    const provider = createLinuxProcessProvider({ openFile: async () => { throw nativeError(code); } });
    await assert.rejects(provider.open(123), error => error.code === code);
  }
  for (const bytes of [Buffer.alloc(4097, 120), Buffer.from('123 (broken) S')]) {
    let closed = 0;
    const provider = createLinuxProcessProvider({ openFile: async () => ({
      async read(buffer) { bytes.copy(buffer); return { bytesRead: bytes.length, buffer }; },
      async close() { closed++; },
    }) });
    const handle = await provider.open(123);
    await assert.rejects(handle.read()); await handle.close();
    assert.equal(closed, 1);
  }
});

test('held birth identity survives label, parent and group changes through signaling', async context => {
  const h = synthetic(context);
  h.add(row(101, { ppid: 100 }));
  await h.tracker.start();
  h.native.set(101, row(101, { ppid: 1, pgid: 999, command: 'renamed-child' }));
  h.census.set(101, { ...h.native.get(101) });
  await h.tracker.sample();
  const result = await h.stop();
  assert.deepEqual(new Set(h.signals.map(call => call.pid)), new Set([100, 101]));
  assert.ok(result.signals.some(call => call.pid === 101 && call.command === 'renamed-child'));
  assert.ok(result.labelChanges.some(change => change.pid === 101));
  assert.ok(result.labelChangeCount >= 1);
  assert.deepEqual(result.identityMismatches, []);
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(h.opens.sort(), [100, 101]);
  assert.deepEqual(h.closes.sort(), [100, 101]);
  assertClosed(result, 2);
});

test('a held but renamed survivor remains visible at the cleanup deadline', async context => {
  const h = synthetic(context); await h.tracker.start();
  h.native.get(100).command = 'renamed-root'; h.census.get(100).command = 'renamed-root';
  h.hooks.signal = () => {};
  const result = await h.stop();
  assert.equal(result.cleanupUnknown, true);
  assert.equal(result.remaining.length, 1);
  assert.equal(result.remaining[0].pid, 100);
  assert.equal(result.remaining[0].command, 'renamed-root');
  assert.equal(result.remaining[0].startTicks, '1000');
  // The operation deadline can expire just before the final close settles. Its
  // report must retain uncertainty; actual close still has exactly one owner.
  assert.equal(result.nativeResources.opened, 1);
  await until(() => h.closes.length === 1);
  await h.stop(); assert.equal(h.closes.length, 1);
});

test('changed birth cannot authorize signals or newly observed descendants', async context => {
  const h = synthetic(context); await h.tracker.start();
  h.native.get(100).startTicks = '9999'; h.census.get(100).startTicks = '9999';
  h.add(row(102, { ppid: 100 }));
  await h.tracker.sample();
  const result = await h.stop();
  assert.equal(result.cleanupUnknown, true);
  assert.ok(result.identityMismatches.some(item => item.expected.pid === 100));
  assert.deepEqual(h.signals, []);
  assert.ok(!h.opens.includes(102));
  assertClosed(result, 1);
});

test('terminal retained-FD death retires the PID permanently without adopting its replacement', async context => {
  const h = synthetic(context); h.add(row(101, { ppid: 100 }));
  await h.tracker.start();
  h.native.delete(101); h.census.delete(101); await h.tracker.sample();
  h.add(row(101, { ppid: 100, startTicks: '99101' }));
  h.add(row(102, { ppid: 101 })); await h.tracker.sample();
  const result = await h.stop();
  assert.ok(!h.signals.some(call => call.pid === 101 || call.pid === 102));
  assert.equal(h.opens.filter(pid => pid === 101).length, 1);
  assert.ok(!h.opens.includes(102));
  assertClosed(result, 2);
});

for (const censusState of ['missing', 'Z']) {
  test(`${censusState} ps row with live held identity is uncertain and permanently retired`, async context => {
    const h = synthetic(context); h.add(row(101, { ppid: 100 }));
    await h.tracker.start();
    const earlierReads = h.reads.filter(pid => pid === 101).length;
    if (censusState === 'missing') h.census.delete(101);
    else h.census.get(101).state = censusState;
    await h.tracker.sample();
    assert.ok(h.reads.filter(pid => pid === 101).length > earlierReads,
      'A ps omission or terminal label must be checked against the retained native identity');
    // Even the original birth returning in a later ps census cannot restore
    // authority after the contradictory discovery observation retired its PID.
    h.census.set(101, { ...h.native.get(101) });
    h.add(row(102, { ppid: 101 }));
    await h.tracker.sample();
    const result = await h.stop();
    assert.equal(result.cleanupUnknown, true);
    assert.equal(h.opens.filter(pid => pid === 101).length, 1);
    assert.ok(!h.opens.includes(102));
    assert.ok(!h.signals.some(call => call.pid === 101 || call.pid === 102));
    assert.ok(result.observed.some(identity => identity.pid === 101));
    assertClosed(result, 2);
  });
}

for (const terminal of ['ESRCH', 'PROC_IDENTITY_EOF', 'Z']) {
  test(`missing ps row with retained ${terminal} verifies termination`, async context => {
    const h = synthetic(context); h.add(row(101, { ppid: 100 }));
    await h.tracker.start();
    const earlierReads = h.reads.filter(pid => pid === 101).length;
    h.census.delete(101);
    h.hooks.read = pid => {
      const identity = h.native.get(pid);
      if (pid === 101 && terminal !== 'Z') throw nativeError(terminal);
      if (!identity) throw nativeError('ESRCH');
      return { ...identity, ...(pid === 101 ? { state: 'Z' } : {}) };
    };
    await h.tracker.sample();
    assert.ok(h.reads.filter(pid => pid === 101).length > earlierReads);
    const result = await h.stop();
    assert.equal(result.cleanupUnknown, false);
    assert.deepEqual(result.nativeErrors, []);
    assert.deepEqual(result.remaining, []);
    assert.ok(!h.signals.some(call => call.pid === 101));
    assertClosed(result, 2);
  });
}

for (const failure of ['EACCES', 'malformed']) {
  test(`missing ps row with ${failure} native evidence remains uncertain`, async context => {
    const h = synthetic(context); h.add(row(101, { ppid: 100 }));
    await h.tracker.start();
    h.census.delete(101);
    h.hooks.read = pid => {
      const identity = h.native.get(pid);
      if (pid === 101) {
        if (failure === 'EACCES') throw nativeError('EACCES');
        return { ...identity, startTicks: 'invalid' };
      }
      if (!identity) throw nativeError('ESRCH');
      return { ...identity };
    };
    await h.tracker.sample();
    const result = await h.stop();
    assert.equal(result.cleanupUnknown, true);
    assert.ok(result.nativeErrors.some(error => error.pid === 101 && error.operation === 'read'));
    assert.ok(!h.signals.some(call => call.pid === 101));
    assertClosed(result, 2);
  });
}

for (const code of ['ENOENT', 'EACCES', 'EINVAL']) {
  test(`retained read ${code} is uncertainty, not proved absence`, async context => {
    const h = synthetic(context); await h.tracker.start();
    h.hooks.read = () => { throw nativeError(code); };
    const result = await h.stop();
    assert.equal(result.cleanupUnknown, true);
    assert.ok(result.nativeErrors.length > 0);
    assert.deepEqual(h.signals, []);
    assertClosed(result, 1);
  });
}

test('malformed native identity blocks signaling rather than proving death', async context => {
  const h = synthetic(context); await h.tracker.start();
  h.hooks.read = () => ({ ...row(100), startTicks: 'not-a-birth-tick' });
  const result = await h.stop();
  assert.equal(result.cleanupUnknown, true);
  assert.ok(result.nativeErrors.some(error => error.operation === 'read'));
  assert.deepEqual(h.signals, []); assertClosed(result, 1);
});

test('a dead parent cannot lend authority through a stale census PPID', async context => {
  const h = synthetic(context); await h.tracker.start();
  h.native.delete(100); h.add(row(102, { ppid: 100 }));
  await h.tracker.sample(); const result = await h.stop();
  assert.ok(!h.opens.includes(102)); assert.deepEqual(h.signals, []);
  assertClosed(result, 1);
});

test('child replacement or reparenting during open fails the final parent ownership check', async context => {
  const h = synthetic(context); await h.tracker.start();
  h.add(row(101, { ppid: 100 }));
  h.hooks.open = async pid => {
    if (pid === 101) h.native.set(101, row(101, { ppid: 777, startTicks: '99101' }));
  };
  await h.tracker.sample(); const result = await h.stop();
  assert.ok(!h.signals.some(call => call.pid === 101));
  assert.ok(!result.observed.some(item => item.pid === 101));
  assert.equal(h.closes.filter(pid => pid === 101).length, 1);
  assertClosed(result, 2);
});

test('root exit before initial open settles cannot establish initial ownership', async context => {
  const h = synthetic(context), opening = deferred();
  h.hooks.open = () => opening.promise;
  const starting = h.tracker.start(); await until(() => h.opens.length === 1);
  h.rootExited({ retainRows: true }); opening.resolve(); await starting;
  const result = await h.stop();
  assert.equal(result.cleanupUnknown, true);
  assert.deepEqual(result.observed, []); assert.deepEqual(h.signals, []);
  assert.equal(h.closes.length, 1); assertClosed(result, 1);
});

test('parent death while a child open is pending prevents late descendant admission', async context => {
  const h = synthetic(context), opening = deferred(); await h.tracker.start();
  h.add(row(101, { ppid: 100 }));
  h.hooks.open = pid => pid === 101 ? opening.promise : undefined;
  const sampling = h.tracker.sample(); await until(() => h.opens.includes(101));
  h.native.delete(100); opening.resolve(); await sampling;
  const result = await h.stop();
  assert.ok(!result.observed.some(identity => identity.pid === 101));
  assert.deepEqual(h.signals, []);
  assertClosed(result, 2);
});

test('initial executable-label mismatch remains rejected by the native tracker', async context => {
  const h = synthetic(context, { rootCommand: '/different/node' });
  await h.tracker.start(); const result = await h.stop();
  assert.equal(result.cleanupUnknown, true);
  assert.deepEqual(result.observed, []); assert.deepEqual(h.signals, []);
  assert.equal(result.initialRootObservation.reason, 'command-mismatch');
});

test('read resolving beyond the lease deadline permanently loses authority before the timer callback', async context => {
  const h = synthetic(context); await h.tracker.start();
  const actualNow = Date.now;
  let advance = 0;
  Date.now = () => actualNow() + advance;
  try {
    h.hooks.read = pid => {
      // Resolve immediately after moving wall time beyond the active lease.
      // No timeout callback gets an opportunity to win this promise race.
      advance = 1000;
      return { ...h.native.get(pid) };
    };
    await h.tracker.sample();
  } finally { Date.now = actualNow; h.hooks.read = null; }
  h.add(row(101, { ppid: 100 }));
  await h.tracker.sample(); const result = await h.stop();
  assert.equal(result.cleanupUnknown, true);
  assert.ok(result.nativeErrors.some(error => error.code === 'IDENTITY_TIMEOUT'));
  assert.deepEqual(h.signals, []);
  assert.ok(!h.opens.includes(101));
  assert.equal(h.closes.filter(pid => pid === 100).length, 1);
  assertClosed(result, 1);
});

test('cleanup never starts a new census after its final deadline', async context => {
  const h = synthetic(context); await h.tracker.start();
  const actualNow = Date.now;
  let advance = 0, expiredCensusCalls = 0;
  Date.now = () => actualNow() + advance;
  h.hooks.census = () => {
    if (advance) {
      expiredCensusCalls++;
      // This rejection must never be created after the operation deadline.
      return Promise.reject(nativeError('UNEXPECTED_LATE_CENSUS'));
    }
    return [...h.census.values()].map(identity => ({ ...identity, start: `birth-${identity.startTicks}` }));
  };
  h.hooks.signal = () => { advance = 1000; };
  let result;
  try { result = await h.stop(); }
  finally { Date.now = actualNow; }
  await delay(0);
  assert.equal(expiredCensusCalls, 0);
  assert.equal(result.cleanupUnknown, true);
  assert.equal(h.signals.length, 1);
  await until(() => h.closes.length === 1);
});

test('a census already pending at timeout observes its late rejection without restoring authority', async context => {
  const h = synthetic(context), census = deferred();
  let calls = 0;
  h.hooks.census = () => { calls++; return census.promise; };
  await h.tracker.start();
  census.reject(nativeError('LATE_CENSUS_FAILURE'));
  // Node's test runner also fails on any unhandled rejection after a test;
  // allow the delayed rejection its turn before inspecting the cleanup receipt.
  await delay(0);
  const result = await h.stop();
  assert.ok(calls >= 1);
  assert.equal(result.cleanupUnknown, true);
  assert.deepEqual(h.signals, []);
  assert.ok(result.censusErrors.length > 0);
  assert.deepEqual(h.opens, []);
  assertClosed(result, 0);
});

test('native census errors retain bounded diagnostic fields without workload payloads', async context => {
  const h = synthetic(context);
  const secret = 'UNEXPECTED_WORKLOAD_PAYLOAD';
  h.hooks.census = () => { throw Object.assign(new Error('Controlled census failure'), {
    code: 'ETIMEDOUT', signal: 'SIGTERM', killed: true, stdout: secret, stderr: secret,
    diagnostic: { kind: 'invalid-census-identity', rowIndex: 2, rowBytes: 72,
      rowPrefix: 'pid ppid pgid start state comm', identity: { ...row(100), start: 'known birth', argv: secret },
      scene: secret },
  }); };
  await h.tracker.start(); const result = await h.stop();
  assert.equal(result.cleanupUnknown, true);
  const error = result.censusErrors[0];
  assert.equal(error.code, 'ETIMEDOUT'); assert.equal(error.signal, 'SIGTERM'); assert.equal(error.killed, true);
  assert.equal(error.diagnostic.kind, 'invalid-census-identity');
  assert.equal(error.diagnostic.rowIndex, 2); assert.equal(error.diagnostic.rowBytes, 72);
  assert.equal(error.diagnostic.rowPrefix, 'pid ppid pgid start state comm');
  assert.equal(error.diagnostic.identity.pid, 100);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(h.signals, []); assert.deepEqual(h.opens, []);
});

test('an initial native timeout invalidates a late open and closes it exactly once', async context => {
  const h = synthetic(context), opening = deferred();
  h.hooks.open = () => opening.promise;
  await h.tracker.start();
  opening.resolve(); await until(() => h.closes.length === 1);
  await h.tracker.sample(); const result = await h.stop();
  assert.equal(result.cleanupUnknown, true);
  assert.deepEqual(result.observed, []); assert.deepEqual(h.signals, []);
  assert.equal(h.opens.length, 1); assert.equal(h.closes.length, 1);
  assertClosed(result, 1);
});

test('cleanup reports a pending open honestly and closes its late result without authority', async context => {
  const h = synthetic(context), opening = deferred();
  h.hooks.open = () => opening.promise;
  await h.tracker.start(); const result = await h.stop();
  assert.equal(result.cleanupUnknown, true);
  assert.ok(result.nativeResources.pendingOpens > 0);
  assert.equal(result.nativeResources.unsettled, true);
  assert.deepEqual(h.signals, []);
  opening.resolve(); await until(() => h.closes.length === 1);
  await h.stop(); assert.equal(h.closes.length, 1);
  assert.deepEqual(h.signals, []);
});

test('cleanup beginning during child acquisition prevents admission even before its deadline', async context => {
  const h = synthetic(context), opening = deferred(); await h.tracker.start();
  h.add(row(101, { ppid: 100 }));
  h.hooks.open = pid => pid === 101 ? opening.promise : undefined;
  const sampling = h.tracker.sample(); await until(() => h.opens.includes(101));
  const cleaning = h.stop(); opening.resolve(); await sampling;
  const result = await cleaning;
  assert.equal(result.cleanupUnknown, true);
  assert.ok(!result.observed.some(identity => identity.pid === 101));
  assert.ok(!h.signals.some(call => call.pid === 101));
  assert.equal(h.closes.filter(pid => pid === 101).length, 1);
  assertClosed(result, 2);
});

for (const parentDies of [false, true]) {
  test(`new descendant during cleanup is rejected and uncertain with ${parentDies ? 'dead' : 'live'} parent`, async context => {
    const h = synthetic(context); await h.tracker.start();
    h.add(row(101, { ppid: 100 }));
    if (parentDies) h.native.delete(100);
    const result = await h.stop();
    assert.equal(result.cleanupUnknown, true);
    assert.ok(!h.opens.includes(101));
    assert.ok(!h.signals.some(call => call.pid === 101));
    assertClosed(result, 1);
  });
}

test('late read after timeout cannot restore authority and closes only after actual settlement', async context => {
  const h = synthetic(context), reading = deferred(); await h.tracker.start();
  h.hooks.read = () => reading.promise;
  await h.tracker.sample();
  const result = await h.stop();
  assert.equal(result.cleanupUnknown, true);
  assert.ok(result.nativeResources.pendingReads > 0);
  assert.equal(result.nativeResources.unsettled, true);
  assert.deepEqual(h.signals, []); assert.deepEqual(h.closes, []);
  reading.resolve(row(100)); await until(() => h.closes.length === 1);
  await h.stop(); assert.equal(h.closes.length, 1); assert.deepEqual(h.signals, []);
});

test('pending close remains uncertain and is never invoked twice', async context => {
  const h = synthetic(context), closing = deferred(); await h.tracker.start();
  h.hooks.close = () => closing.promise;
  const result = await h.stop();
  assert.equal(result.cleanupUnknown, true);
  assert.equal(result.nativeResources.pendingCloses, 1);
  assert.equal(result.nativeResources.unsettled, true);
  assert.equal(h.closes.length, 1);
  closing.resolve(); await delay(0); await h.stop(); assert.equal(h.closes.length, 1);
});

test('failed native close is retained as uncertainty without retrying the close', async context => {
  const h = synthetic(context); await h.tracker.start();
  h.hooks.close = () => { throw nativeError('EIO'); };
  const result = await h.stop();
  assert.equal(result.cleanupUnknown, true);
  assert.ok(result.nativeErrors.some(error => error.code === 'EIO'));
  assert.equal(result.nativeResources.closed, 0);
  assert.equal(h.closes.length, 1); await h.stop(); assert.equal(h.closes.length, 1);
});

test('pending opens reserve bounded capacity and cannot admit extra candidates after timeout', async context => {
  const h = synthetic(context, { maxProcesses: 2 }), opening = deferred();
  await h.tracker.start();
  h.add(row(101, { ppid: 100 })); h.add(row(102, { ppid: 100 }));
  h.hooks.open = pid => pid === 101 ? opening.promise : undefined;
  await h.tracker.sample(); await h.tracker.sample();
  assert.ok(h.opens.includes(101)); assert.ok(!h.opens.includes(102));
  const result = await h.stop(); assert.equal(result.cleanupUnknown, true);
  assert.ok(result.nativeResources.pendingOpens > 0);
  opening.resolve(); await until(() => h.closes.includes(101));
  assert.equal(h.closes.filter(pid => pid === 101).length, 1);
  assert.ok(!h.signals.some(call => call.pid === 101 || call.pid === 102));
});

test('provider close waits for a real in-flight read and cannot be repeated after settlement', async () => {
  const reading = deferred(); let readStarted = false, closes = 0;
  const bytes = Buffer.from(statText(row(123)));
  const provider = createLinuxProcessProvider({ openFile: async () => ({
    async read(buffer) {
      readStarted = true; await reading.promise; bytes.copy(buffer);
      return { bytesRead: bytes.length, buffer };
    },
    async close() { closes++; },
  }) });
  const handle = await provider.open(123);
  const pending = handle.read(); await until(() => readStarted);
  const close = handle.close(); await delay(0); assert.equal(closes, 0);
  reading.resolve(); assert.deepEqual(await pending, row(123));
  await close; await handle.close(); assert.equal(closes, 1);
  await assert.rejects(handle.read());
});

// The real Linux fixture has its own expiry and a retained independent /proc FD
// for teardown verification. It never sends group-wide signals or churns PIDs.
async function launchNativeFixture(context) {
  const child = spawn(process.execPath, [childPath], { detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let stderr = '', handle, initial;
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text; });
  context.after(async () => {
    if (handle && initial && child.exitCode === null && child.signalCode === null) {
      try {
        const retained = await handle.read();
        const current = parseLinuxProcessStat(await readFile(`/proc/${child.pid}/stat`, 'utf8'), child.pid);
        if (retained.startTicks === initial.startTicks && current.startTicks === initial.startTicks
          && !['Z', 'X', 'x'].includes(current.state)) process.kill(child.pid, 'SIGKILL');
      } catch (error) { if (!['ESRCH', 'ENOENT'].includes(error.code)) throw error; }
    }
    await Promise.race([exit, delay(500)]);
    await handle?.close();
    if (child.connected) child.disconnect();
    child.stderr.destroy(); child.unref();
  });
  const messages = [];
  child.on('message', value => messages.push(value));
  child.once('error', error => messages.push({ kind: 'spawn-error', message: error.message }));
  await until(() => messages.some(value => value.kind === 'ready' || value.kind === 'spawn-error'), 'Native child startup timed out');
  assert.ok(messages.some(value => value.kind === 'ready'), JSON.stringify(messages));
  handle = await createLinuxProcessProvider().open(child.pid); initial = await handle.read();
  assert.equal(initial.pid, child.pid); assert.equal(stderr, '');
  return { child, exit, handle, initial, messages, stderr: () => stderr,
    running: () => child.exitCode === null && child.signalCode === null };
}

async function selectedCensus(pids) {
  let stdout;
  try {
    ({ stdout } = await execute('/bin/ps', ['-p', pids.join(','), '-o', 'pid=,ppid=,pgid=,lstart=,stat=,comm='],
      { encoding: 'utf8', timeout: 1000, env: { ...process.env, LC_ALL: 'C' } }));
  } catch (error) {
    if (error.code === 1 && !error.stdout?.trim()) return [];
    throw error;
  }
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.+)$/.exec(line);
    assert.ok(match, 'Malformed selected process fixture census');
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
      start: match[4], state: match[5], command: match[6] };
  });
}

test('Linux retained FD follows a renamed owned child through bounded escalation without touching the control',
  { skip: process.platform !== 'linux', timeout: 8000 }, async context => {
    const fixture = await launchNativeFixture(context), control = await launchNativeFixture(context);
    const tracker = createNativeProcessTracker({ rootPid: fixture.child.pid,
      // Controlled fixture only: Node24 may start with comm MainThread. This is
      // not a production initial-executable identity adaptation or Node22 proof.
      rootCommand: fixture.initial.command, rootIsRunning: fixture.running,
      nativeProvider: createLinuxProcessProvider(), pollIntervalMs: 10, censusMs: 1000,
      readProcesses: () => selectedCensus([fixture.child.pid, control.child.pid]),
    });
    context.after(() => tracker.cleanup({ reason: 'failure', termGraceMs: 30, killGraceMs: 100 }));
    await tracker.start();
    fixture.child.send({ kind: 'rename', title: 'strata-native-test' });
    await until(() => fixture.messages.some(value => value.kind === 'renamed'));
    const renamed = await fixture.handle.read();
    assert.equal(renamed.pid, fixture.initial.pid);
    assert.equal(renamed.startTicks, fixture.initial.startTicks);
    assert.notEqual(renamed.command, fixture.initial.command);
    await tracker.sample();
    const result = await tracker.cleanup({ reason: 'timeout', termGraceMs: 50, killGraceMs: 300 });
    assert.equal(result.cleanupUnknown, true, 'Abnormal cleanup retains the sampling blind-spot caveat');
    assert.deepEqual(result.remaining, []); assert.deepEqual(result.identityMismatches, []);
    assert.ok(result.labelChangeCount >= 1);
    assert.ok(result.signals.some(value => value.pid === fixture.child.pid && value.signal === 'SIGTERM'));
    assert.ok(result.signals.some(value => value.pid === fixture.child.pid && value.signal === 'SIGKILL'));
    assert.ok(result.signals.every(value => value.pid === fixture.child.pid && value.pid > 0));
    const fixtureExit = await fixture.exit;
    assert.deepEqual(fixtureExit, { code: null, signal: 'SIGKILL' });
    await assert.rejects(fixture.handle.read(), error => error.code === 'ESRCH');
    assert.equal((await control.handle.read()).startTicks, control.initial.startTicks);
    assert.ok(control.running()); assert.equal(fixture.stderr(), ''); assert.equal(control.stderr(), '');
    control.child.send({ kind: 'dispose' });
    const controlExit = await control.exit;
    assert.deepEqual(controlExit, { code: 0, signal: null });
    assertClosed(result, 1);
    context.diagnostic(JSON.stringify({ format: 'strata.native-process-test', version: 1,
      nodeVersion: process.version, initialLabelScope: 'Controlled fixture label only; no production Node24 admission change',
      fixtureInitial: fixture.initial, fixtureRenamed: renamed, controlInitial: control.initial,
      cleanup: result, fixtureExit, controlExit, controlAliveAfterFixtureCleanup: true,
      fixtureRetainedReadAfterExit: 'ESRCH' }));
  });
