import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createProcessTracker } from './preview-process-cleanup.mjs';

const execute = promisify(execFile);
const parentPath = fileURLToPath(new URL('../tests/fixtures/preview-process-parent.mjs', import.meta.url));
const childPath = fileURLToPath(new URL('../tests/fixtures/preview-process-child.mjs', import.meta.url));
const supervisorPath = fileURLToPath(new URL('../tests/fixtures/preview-process-supervisor.mjs', import.meta.url));
const unsupported = process.platform === 'win32';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function commandFor(pid) {
  try {
    const result = await execute('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 });
    return result.stdout.trim();
  } catch (error) {
    if (error.code === 1 && !error.stdout?.trim()) return null;
    throw error;
  }
}

async function groupFor(pid) {
  const result = await execute('/bin/ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8', timeout: 1000 });
  return Number(result.stdout.trim());
}

async function assertStopped(...pids) {
  for (const pid of pids) {
    try {
      const result = await execute('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: 1000 });
      assert.ok(result.stdout.trim().startsWith('Z'), `Owned fixture ${pid} is still running`);
    } catch (error) {
      if (!(error.code === 1 && !error.stdout?.trim())) throw error;
    }
  }
}

async function launchFixture(context, { parent = true, supervisor = false, mode = 'normal' } = {}) {
  const token = `strata-process-test-${randomUUID()}`;
  const args = [supervisor ? supervisorPath : parent ? parentPath : childPath, token, mode];
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const pids = new Set([child.pid]);
  const messages = [];
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => { stderr += data; });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  // Cleanup is registered before startup assertions and only signals exact token-
  // verified PIDs. It does not rely on the helper under test or negative PGIDs.
  context.after(async () => {
    for (const pid of pids) {
      const command = await commandFor(pid);
      if (command?.includes(token)) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    if (child.connected) child.disconnect();
    await Promise.race([exit, delay(500)]);
    child.stderr.destroy(); child.unref();
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture startup deadline expired')), 2500);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited during startup (${code}): ${stderr}`)); });
    child.on('message', message => {
      messages.push(message);
      if (message?.workflowPid) pids.add(message.workflowPid);
      if (message?.childPid) pids.add(message.childPid);
      if (message?.kind === 'ready') { clearTimeout(timer); resolve(message); }
    });
  });
  assert.equal(stderr, '');
  const nextMessage = predicate => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.off('message', listener); reject(new Error('Fixture message deadline expired')); }, 2500);
      const listener = message => {
        if (predicate(message)) { clearTimeout(timer); child.off('message', listener); resolve(message); }
      };
      child.on('message', listener);
    });
  };
  return { child, pid: child.pid, childPid: ready.childPid, workflowPid: ready.workflowPid, stage: ready.stage,
    rootCommand: process.execPath, exit, token, nextMessage };
}

function ownedSignalsOnly(result, allowed, controlPid) {
  assert.ok(Array.isArray(result.signals));
  for (const entry of result.signals) {
    assert.ok(entry.pid > 0, 'Only individually verified PIDs may be signaled');
    assert.ok(allowed.includes(entry.pid), `Unexpected cleanup signal target ${entry.pid}`);
    assert.notEqual(entry.pid, controlPid);
    assert.ok(['SIGTERM', 'SIGKILL'].includes(entry.signal));
  }
  assert.ok(alive(controlPid), 'Unrelated control process must remain alive');
}

async function trackerFor(context, fixture, options = {}) {
  const tracker = createProcessTracker({ rootPid: fixture.pid, rootCommand: fixture.rootCommand, pollIntervalMs: 10, ...options });
  context.after(async () => { await tracker.cleanup({ reason: 'failure', termGraceMs: 30, killGraceMs: 100 }); });
  await tracker.start();
  await tracker.sample();
  return tracker;
}

test('retains a detached child after killing only the workflow group and reparenting', { skip: unsupported, timeout: 8000 }, async context => {
  const fixture = await launchFixture(context);
  const control = await launchFixture(context, { parent: false });
  const tracker = await trackerFor(context, fixture);
  assert.equal(await groupFor(fixture.pid), fixture.pid);
  assert.equal(await groupFor(fixture.childPid), fixture.childPid);
  assert.notEqual(fixture.pid, fixture.childPid);
  // This is deliberately the old launcher's insufficient group-only cleanup.
  process.kill(-fixture.pid, 'SIGKILL');
  assert.equal((await fixture.exit).signal, 'SIGKILL');
  assert.ok(alive(fixture.childPid), 'Detached child must demonstrate the original cleanup gap');
  await tracker.sample();
  const result = await tracker.cleanup({ reason: 'failure', termGraceMs: 80, killGraceMs: 150 });
  assert.equal(result.cleanupUnknown, true, 'Abnormal parent loss retains the census blind-spot caveat');
  assert.ok(result.observed.some(row => row.pid === fixture.childPid));
  assert.ok(result.signals.some(row => row.pid === fixture.childPid));
  assert.deepEqual(result.remaining, []);
  await assertStopped(fixture.pid, fixture.childPid);
  ownedSignalsOnly(result, [fixture.pid, fixture.childPid], control.pid);
});

test('successful graceful disposal is observed without fallback signals', { skip: unsupported, timeout: 8000 }, async context => {
  const fixture = await launchFixture(context);
  const control = await launchFixture(context, { parent: false });
  const tracker = await trackerFor(context, fixture);
  fixture.child.send('dispose');
  assert.deepEqual(await fixture.exit, { code: 0, signal: null });
  const result = await tracker.cleanup({ reason: 'graceful', termGraceMs: 50, killGraceMs: 100 });
  assert.equal(result.cleanupUnknown, false);
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(result.signals, []);
  assert.deepEqual(result.censusErrors, []);
  await assertStopped(fixture.pid, fixture.childPid);
  ownedSignalsOnly(result, [], control.pid);
});

test('timeout cleanup escalates an owned TERM-resistant child within a bound', { skip: unsupported, timeout: 8000 }, async context => {
  const fixture = await launchFixture(context, { mode: 'ignore-term' });
  const control = await launchFixture(context, { parent: false });
  const tracker = await trackerFor(context, fixture);
  const started = Date.now();
  const result = await tracker.cleanup({ reason: 'timeout', termGraceMs: 50, killGraceMs: 150 });
  assert.ok(Date.now() - started < 2500, 'Cleanup must finish within the configured short fixture budget plus census overhead');
  for (const pid of [fixture.pid, fixture.childPid]) {
    assert.ok(result.signals.some(row => row.pid === pid && row.signal === 'SIGTERM'));
    assert.ok(result.signals.some(row => row.pid === pid && row.signal === 'SIGKILL'));
  }
  assert.deepEqual(result.remaining, []);
  await assertStopped(fixture.pid, fixture.childPid);
  ownedSignalsOnly(result, [fixture.pid, fixture.childPid], control.pid);
});

test('signal interruption performs bounded cleanup of live owned descendants', { skip: unsupported, timeout: 8000 }, async context => {
  const fixture = await launchFixture(context);
  const control = await launchFixture(context, { parent: false });
  const tracker = await trackerFor(context, fixture);
  const result = await tracker.cleanup({ reason: 'signal', termGraceMs: 100, killGraceMs: 100 });
  assert.deepEqual(result.remaining, []);
  assert.ok(result.signals.some(row => row.pid === fixture.childPid && row.signal === 'SIGTERM'));
  await assertStopped(fixture.pid, fixture.childPid);
  ownedSignalsOnly(result, [fixture.pid, fixture.childPid], control.pid);
});

test('workflow failure retains and terminates an already observed child after parent exit', { skip: unsupported, timeout: 8000 }, async context => {
  const fixture = await launchFixture(context);
  const control = await launchFixture(context, { parent: false });
  const tracker = await trackerFor(context, fixture);
  fixture.child.send('exit-parent');
  assert.deepEqual(await fixture.exit, { code: 23, signal: null });
  assert.ok(alive(fixture.childPid));
  const result = await tracker.cleanup({ reason: 'failure', termGraceMs: 100, killGraceMs: 100 });
  assert.equal(result.cleanupUnknown, true);
  assert.deepEqual(result.remaining, []);
  await assertStopped(fixture.pid, fixture.childPid);
  ownedSignalsOnly(result, [fixture.pid, fixture.childPid], control.pid);
});

for (const mismatch of ['start', 'command']) {
  test(`changed ${mismatch} identity is unknown and never signaled`, { skip: unsupported, timeout: 8000 }, async context => {
    const fixture = await launchFixture(context, { parent: false });
    const control = await launchFixture(context, { parent: false });
    const row = { pid: fixture.pid, ppid: process.pid, pgid: fixture.pid, start: 'Sun Sep 6 02:00:00 2026', command: fixture.rootCommand };
    let changed = false;
    const calls = [];
    const tracker = await trackerFor(context, fixture, {
      readProcesses: async () => [{ ...row, ...(changed ? { [mismatch]: `${row[mismatch]}-changed` } : {}) }],
      signalProcess: (pid, signal) => { calls.push({ pid, signal }); process.kill(pid, signal); },
    });
    changed = true;
    const result = await tracker.cleanup({ reason: 'failure', termGraceMs: 20, killGraceMs: 20 });
    assert.equal(result.cleanupUnknown, true);
    assert.ok(result.identityMismatches.length > 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(result.signals, []);
    assert.ok(alive(fixture.pid)); assert.ok(alive(control.pid));
  });
}

test('unverified initial root cannot authorize signals', { skip: unsupported, timeout: 8000 }, async context => {
  const fixture = await launchFixture(context, { parent: false });
  const control = await launchFixture(context, { parent: false });
  const calls = [];
  const tracker = createProcessTracker({
    rootPid: fixture.pid, rootCommand: `${fixture.rootCommand}-unverified`, pollIntervalMs: 10,
    readProcesses: async () => {
      return [{ pid: fixture.pid, ppid: process.pid, pgid: fixture.pid, start: 'Sun Sep 6 02:00:00 2026', command: fixture.rootCommand }];
    },
    signalProcess: (pid, signal) => { calls.push({ pid, signal }); process.kill(pid, signal); },
  });
  context.after(async () => { await tracker.cleanup({ reason: 'failure', termGraceMs: 20, killGraceMs: 20 }); });
  await tracker.start();
  const result = await tracker.cleanup({ reason: 'failure', termGraceMs: 20, killGraceMs: 20 });
  assert.equal(result.cleanupUnknown, true);
  assert.deepEqual(result.observed, []);
  assert.deepEqual(calls, []); assert.deepEqual(result.signals, []);
  assert.ok(alive(fixture.pid)); assert.ok(alive(control.pid));
});

test('census failure after valid admission cannot signal using a stale snapshot', { skip: unsupported, timeout: 8000 }, async context => {
  const fixture = await launchFixture(context, { parent: false });
  const control = await launchFixture(context, { parent: false });
  let fail = false;
  const calls = [];
  const tracker = await trackerFor(context, fixture, {
    readProcesses: async () => {
      if (fail) throw new Error('Injected bounded census failure');
      return [{ pid: fixture.pid, ppid: process.pid, pgid: fixture.pid, start: 'Sun Sep 6 02:00:00 2026', command: fixture.rootCommand }];
    },
    signalProcess: (pid, signal) => { calls.push({ pid, signal }); process.kill(pid, signal); },
  });
  fail = true;
  const result = await tracker.cleanup({ reason: 'failure', termGraceMs: 20, killGraceMs: 20 });
  assert.equal(result.cleanupUnknown, true);
  assert.ok(result.observed.some(row => row.pid === fixture.pid));
  assert.ok(result.censusErrors.length > 0);
  assert.deepEqual(calls, []); assert.deepEqual(result.signals, []);
  assert.ok(alive(fixture.pid)); assert.ok(alive(control.pid));
});

test('an initially absent root cannot be adopted from a later census', { skip: unsupported, timeout: 8000 }, async context => {
  const fixture = await launchFixture(context, { parent: false });
  const control = await launchFixture(context, { parent: false });
  let appeared = false;
  const calls = [];
  const tracker = createProcessTracker({
    rootPid: fixture.pid, rootCommand: fixture.rootCommand, pollIntervalMs: 10,
    readProcesses: async () => appeared
      ? [{ pid: fixture.pid, ppid: process.pid, pgid: fixture.pid, start: 'Sun Sep 6 02:00:00 2026', command: fixture.rootCommand }]
      : [],
    signalProcess: (pid, signal) => { calls.push({ pid, signal }); process.kill(pid, signal); },
  });
  context.after(async () => { await tracker.cleanup({ reason: 'failure', termGraceMs: 20, killGraceMs: 20 }); });
  await tracker.start(); appeared = true;
  const result = await tracker.cleanup({ reason: 'failure', termGraceMs: 20, killGraceMs: 20 });
  assert.equal(result.cleanupUnknown, true);
  assert.deepEqual(result.observed, []);
  assert.deepEqual(calls, []); assert.deepEqual(result.signals, []);
  assert.ok(alive(fixture.pid)); assert.ok(alive(control.pid));
});

test('a hanging census is bounded and cannot authorize stale-identity signals', { skip: unsupported, timeout: 8000 }, async context => {
  const fixture = await launchFixture(context, { parent: false });
  const control = await launchFixture(context, { parent: false });
  let hang = false;
  const calls = [];
  const tracker = await trackerFor(context, fixture, {
    readProcesses: async () => {
      if (hang) return new Promise(() => {});
      return [{ pid: fixture.pid, ppid: process.pid, pgid: fixture.pid, start: 'Sun Sep 6 02:00:00 2026', command: fixture.rootCommand }];
    },
    signalProcess: (pid, signal) => { calls.push({ pid, signal }); process.kill(pid, signal); },
  });
  hang = true;
  const started = Date.now();
  const result = await tracker.cleanup({ reason: 'failure', termGraceMs: 20, killGraceMs: 20 });
  assert.ok(Date.now() - started < 2000, 'A census must not extend cleanup indefinitely');
  assert.equal(result.cleanupUnknown, true);
  assert.ok(result.censusErrors.some(error => /deadline/.test(error.message)));
  assert.deepEqual(calls, []); assert.deepEqual(result.signals, []);
  assert.ok(alive(fixture.pid)); assert.ok(alive(control.pid));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`production supervisor handles actual ${signal} and awaits detached descendants`, { skip: unsupported, timeout: 8000 }, async context => {
    const fixture = await launchFixture(context, { supervisor: true, mode: 'signal' });
    const control = await launchFixture(context, { parent: false });
    assert.equal(fixture.stage, 'tracked');
    const started = Date.now();
    process.kill(fixture.pid, signal);
    const { outcome } = await fixture.nextMessage(message => message.kind === 'outcome');
    assert.ok(Date.now() - started < 2500);
    assert.equal(outcome.process.runnerSignal, signal);
    assert.equal(outcome.process.cleanupUnknown, true);
    assert.ok(outcome.error, 'Interruption cannot be reported as a successful workflow');
    assert.deepEqual(outcome.process.ownership.remaining, []);
    await assertStopped(fixture.workflowPid, fixture.childPid);
    ownedSignalsOnly(outcome.process.ownership, [fixture.workflowPid, fixture.childPid], control.pid);
    assert.deepEqual(await fixture.exit, { code: 0, signal: null }, 'Supervisor must return its bounded cleanup outcome rather than die from the signal');
  });
}

test('production root-close path waits for a leftover detached child before returning', { skip: unsupported, timeout: 8000 }, async context => {
  const fixture = await launchFixture(context, { supervisor: true, mode: 'leftover' });
  const control = await launchFixture(context, { parent: false });
  assert.equal(fixture.stage, 'tracked');
  fixture.child.send('exit-workflow');
  const { outcome } = await fixture.nextMessage(message => message.kind === 'outcome');
  assert.equal(outcome.process.exitCode, 0);
  assert.ok(outcome.error, 'Root exit zero must not hide missing descendant disposal');
  assert.ok(outcome.process.ownership.signals.some(row => row.pid === fixture.childPid && row.signal === 'SIGKILL'));
  assert.deepEqual(outcome.process.ownership.remaining, []);
  await assertStopped(fixture.workflowPid, fixture.childPid);
  ownedSignalsOnly(outcome.process.ownership, [fixture.workflowPid, fixture.childPid], control.pid);
  assert.deepEqual(await fixture.exit, { code: 0, signal: null });
});

test('production signal handlers remain active while initial census is awaited', { skip: unsupported, timeout: 8000 }, async context => {
  const fixture = await launchFixture(context, { supervisor: true, mode: 'start-wait' });
  const control = await launchFixture(context, { parent: false });
  assert.equal(fixture.stage, 'census-waiting');
  process.kill(fixture.pid, 'SIGTERM');
  // Keep the initial await pending while the real signal is delivered. No test
  // signal handler exists in the supervisor to mask a missing production handler.
  await delay(30);
  assert.ok(alive(fixture.pid), 'Supervisor must handle SIGTERM during initial census');
  fixture.child.send('release-census');
  const { outcome } = await fixture.nextMessage(message => message.kind === 'outcome');
  assert.equal(outcome.process.runnerSignal, 'SIGTERM');
  assert.ok(outcome.error);
  assert.equal(outcome.process.cleanupUnknown, true);
  assert.deepEqual(outcome.process.ownership.remaining, []);
  await assertStopped(fixture.workflowPid, fixture.childPid);
  ownedSignalsOnly(outcome.process.ownership, [fixture.workflowPid, fixture.childPid], control.pid);
  assert.deepEqual(await fixture.exit, { code: 0, signal: null });
});

test('production operation deadline expires and awaits owned descendant cleanup', { skip: unsupported, timeout: 8000 }, async context => {
  const fixture = await launchFixture(context, { supervisor: true, mode: 'timeout' });
  const control = await launchFixture(context, { parent: false });
  assert.equal(fixture.stage, 'tracked');
  const { outcome } = await fixture.nextMessage(message => message.kind === 'outcome');
  assert.equal(outcome.process.timedOut, true);
  assert.equal(outcome.process.runnerSignal, null);
  assert.match(outcome.error.message, /750ms deadline/);
  assert.deepEqual(outcome.process.ownership.remaining, []);
  await assertStopped(fixture.workflowPid, fixture.childPid);
  ownedSignalsOnly(outcome.process.ownership, [fixture.workflowPid, fixture.childPid], control.pid);
  assert.deepEqual(await fixture.exit, { code: 0, signal: null });
});

test('production combined output overflow retains bounded prefixes and cleans owned descendants', { skip: unsupported, timeout: 8000 }, async context => {
  const fixture = await launchFixture(context, { supervisor: true, mode: 'overflow' });
  const control = await launchFixture(context, { parent: false });
  assert.equal(fixture.stage, 'tracked');
  fixture.child.send('overflow');
  const { outcome } = await fixture.nextMessage(message => message.kind === 'outcome');
  assert.equal(outcome.process.logTruncated, true);
  assert.equal(outcome.process.timedOut, false);
  assert.match(outcome.error.message, /output byte limit/);
  assert.equal(Buffer.byteLength(outcome.stdout) + Buffer.byteLength(outcome.stderr), 40);
  assert.ok(`stdout-prefix:${'o'.repeat(64)}`.startsWith(outcome.stdout));
  assert.ok(`stderr-prefix:${'e'.repeat(64)}`.startsWith(outcome.stderr));
  assert.deepEqual(outcome.process.ownership.remaining, []);
  await assertStopped(fixture.workflowPid, fixture.childPid);
  ownedSignalsOnly(outcome.process.ownership, [fixture.workflowPid, fixture.childPid], control.pid);
  assert.deepEqual(await fixture.exit, { code: 0, signal: null });
});
