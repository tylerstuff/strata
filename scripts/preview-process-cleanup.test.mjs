import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createProcessTracker, formatProcessCleanupSummary } from './preview-process-cleanup.mjs';

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
  const tracker = createProcessTracker({ rootPid: fixture.pid, rootCommand: fixture.rootCommand, pollIntervalMs: 10,
    rootIsRunning: () => fixture.child.exitCode === null && fixture.child.signalCode === null, ...options });
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

const diagnosticArrays = ['limitations', 'observed', 'remaining', 'identityMismatches', 'censusErrors', 'signals'];
function diagnosticFixture() {
  const processRow = { pid: 102, ppid: 101, pgid: 102, start: 'Sun Sep 6 02:00:00 2026', state: 'S', command: '/fixture/worker',
    argv: ['PRIVATE_ARGV_PAYLOAD'], environment: { token: 'PRIVATE_ENV_PAYLOAD' }, scene: 'PRIVATE_SCENE_PAYLOAD', image: 'PRIVATE_IMAGE_PAYLOAD' };
  return {
    stdout: 'PRIVATE_STDOUT_PAYLOAD', stderr: 'PRIVATE_STDERR_PAYLOAD', workflow: { scene: 'PRIVATE_WORKFLOW_PAYLOAD' },
    error: { name: 'Error', message: 'Owned cleanup could not be verified', stack: 'PRIVATE_STACK_PAYLOAD' },
    process: {
      pid: 101, exitCode: 0, exitSignal: null, runnerSignal: 'SIGTERM', timedOut: false, cleanupUnknown: true,
      cleanupError: 'Cleanup identity was not verified', timeoutMs: 240000, termGraceMs: 5000, killGraceMs: 1000, exitGraceMs: 1000,
      scene: 'PRIVATE_PROCESS_SCENE_PAYLOAD', stdout: 'PRIVATE_PROCESS_STDOUT_PAYLOAD',
      ownership: {
        rootPid: 101, cleanupUnknown: true, limitations: ['Detached process ownership remained unknown'],
        initialRootObservation: { expected: { pid: 101, command: '/fixture/runner', argv: ['PRIVATE_INITIAL_ARGV_PAYLOAD'] },
          observed: { ...processRow, pid: 101, command: '/unexpected/runner' }, reason: 'command-mismatch', environment: 'PRIVATE_INITIAL_ENV_PAYLOAD' },
        observed: [{ ...processRow }], remaining: [{ ...processRow }],
        identityMismatches: [{ expected: { ...processRow }, current: { ...processRow, start: 'Sun Sep 6 02:00:01 2026' }, scene: 'PRIVATE_MISMATCH_PAYLOAD' }],
        censusErrors: [{ message: 'Process census exceeded its deadline', code: 'ETIMEDOUT', signal: 'SIGTERM', killed: true,
          diagnostic: { kind: 'ps-comm-row-parse', rowIndex: 7, rowBytes: 900, rowPrefix: '101 1 101 /fixture/worker',
            identity: { ...processRow }, stdout: 'PRIVATE_PARSE_STDOUT_PAYLOAD' },
          stdout: 'PRIVATE_CENSUS_STDOUT_PAYLOAD', stderr: 'PRIVATE_CENSUS_STDERR_PAYLOAD' }],
        signals: [{ ...processRow, signal: 'SIGTERM' }],
        scene: 'PRIVATE_OWNERSHIP_SCENE_PAYLOAD', images: ['PRIVATE_OWNERSHIP_IMAGE_PAYLOAD'],
      },
    },
  };
}

function parsedDiagnostic(outcome, maxBytes = 32768) {
  const text = formatProcessCleanupSummary(outcome, { maxBytes });
  assert.equal(typeof text, 'string');
  assert.ok(text.endsWith('\n'), 'The budget includes a terminal LF');
  assert.ok(!text.slice(0, -1).includes('\n'), 'Diagnostic is exactly one JSONL record');
  assert.ok(Buffer.byteLength(text, 'utf8') <= maxBytes, `Diagnostic exceeded ${maxBytes} UTF-8 bytes including LF`);
  const parsed = JSON.parse(text);
  assert.equal(parsed.format, 'strata.preview.process-cleanup-diagnostic');
  assert.equal(parsed.version, 1);
  return { text, parsed };
}

function assertWellFormedStrings(value) {
  if (typeof value === 'string') assert.ok(value.isWellFormed(), 'Truncation must not split a surrogate pair');
  else if (Array.isArray(value)) value.forEach(assertWellFormedStrings);
  else if (value && typeof value === 'object') Object.values(value).forEach(assertWellFormedStrings);
}

test('cleanup diagnostic retains actionable ownership evidence and excludes workflow payloads', () => {
  const input = diagnosticFixture(), before = structuredClone(input);
  const { text, parsed } = parsedDiagnostic(input);
  assert.deepEqual(input, before, 'Formatting must not mutate the retained original report');
  assert.equal(parsed.error.message, input.error.message);
  assert.equal(parsed.process.cleanupUnknown, true);
  assert.equal(parsed.process.exitCode, 0);
  assert.equal(parsed.process.exitSignal, null);
  assert.equal(parsed.process.runnerSignal, 'SIGTERM');
  assert.equal(parsed.process.timedOut, false);
  assert.equal(parsed.process.cleanupError, input.process.cleanupError);
  assert.equal(parsed.ownership.cleanupUnknown, true);
  assert.equal(parsed.ownership.rootPid, 101);
  assert.equal(parsed.ownership.initialRootObservation.reason, 'command-mismatch');
  assert.equal(parsed.ownership.initialRootObservation.expected.command, '/fixture/runner');
  assert.equal(parsed.ownership.initialRootObservation.observed.command, '/unexpected/runner');
  assert.deepEqual(parsed.ownership.limitations, input.process.ownership.limitations);
  assert.equal(parsed.ownership.remaining[0].pid, 102);
  assert.equal(parsed.ownership.identityMismatches[0].expected.start, 'Sun Sep 6 02:00:00 2026');
  assert.equal(parsed.ownership.identityMismatches[0].current.start, 'Sun Sep 6 02:00:01 2026');
  assert.equal(parsed.ownership.censusErrors[0].message, 'Process census exceeded its deadline');
  assert.equal(parsed.ownership.censusErrors[0].code, 'ETIMEDOUT');
  assert.equal(parsed.ownership.censusErrors[0].killed, true);
  assert.equal(parsed.ownership.censusErrors[0].diagnostic.kind, 'ps-comm-row-parse');
  assert.equal(parsed.ownership.censusErrors[0].diagnostic.rowIndex, 7);
  assert.equal(parsed.ownership.censusErrors[0].diagnostic.rowBytes, 900);
  assert.equal(parsed.ownership.signals[0].signal, 'SIGTERM');
  for (const key of diagnosticArrays) {
    assert.equal(parsed.counts[key], 1);
    assert.equal(parsed.omitted[key], 0);
  }
  assert.equal(parsed.truncated, false);
  assert.ok(!text.includes('PRIVATE_'), 'Only whitelisted process metadata belongs in the diagnostic');
});

for (const maxBytes of [1024, 2048, 32768]) {
  test(`cleanup diagnostic bounds Unicode and large arrays within ${maxBytes} exact UTF-8 bytes`, () => {
    const input = diagnosticFixture();
    const unicode = '🙂漢字"\\\n'.repeat(2000);
    input.error.message = unicode;
    input.process.cleanupError = unicode;
    input.process.ownership.limitations = Array.from({ length: 73 }, (_, index) => `reason-${index}-${unicode}`);
    for (const key of diagnosticArrays.filter(value => value !== 'limitations')) {
      const original = input.process.ownership[key][0];
      input.process.ownership[key] = Array.from({ length: 73 }, () => structuredClone(original));
    }
    for (const row of input.process.ownership.observed) row.command = unicode;
    for (const row of input.process.ownership.remaining) row.command = unicode;
    for (const row of input.process.ownership.censusErrors) row.message = unicode;
    const { text, parsed } = parsedDiagnostic(input, maxBytes);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.process.cleanupUnknown, true);
    assert.equal(parsed.process.exitCode, 0);
    assert.equal(parsed.ownership.cleanupUnknown, true);
    assertWellFormedStrings(parsed);
    for (const key of diagnosticArrays) {
      assert.equal(parsed.counts[key], 73, `Total ${key} evidence count must survive truncation`);
      assert.ok(parsed.ownership[key].length <= 32, `${key} exceeds its record cap`);
      assert.equal(parsed.omitted[key], 73 - parsed.ownership[key].length);
    }
    assert.ok(!text.includes('PRIVATE_'));
  });
}

test('cleanup diagnostic reports survivor totals after dropping bulky rows and keeps short root causes', () => {
  const input = diagnosticFixture();
  input.process.ownership.limitations = ['ROOT_CAUSE: initial root identity unavailable'];
  input.process.ownership.remaining = Array.from({ length: 80 }, () => ({ ...input.process.ownership.remaining[0], command: '/fixture/' + 'x'.repeat(8192) }));
  const { text, parsed } = parsedDiagnostic(input, 2048);
  assert.equal(parsed.counts.remaining, 80);
  assert.equal(parsed.omitted.remaining, 80 - parsed.ownership.remaining.length);
  assert.ok(parsed.omitted.remaining > 0);
  assert.ok(text.includes('ROOT_CAUSE'), 'A generic cleanupUnknown message alone is not actionable');
  assert.ok(text.includes('Process census exceeded its deadline'));
  assert.equal(parsed.process.cleanupUnknown, true);
  assert.equal(parsed.truncated, true);
});

test('cleanup diagnostic preserves known zero and false values without inventing missing processes', () => {
  const input = diagnosticFixture();
  input.process.runnerSignal = null;
  input.process.cleanupUnknown = false;
  input.process.cleanupError = null;
  input.process.ownership.cleanupUnknown = false;
  for (const key of diagnosticArrays) input.process.ownership[key] = [];
  const { parsed } = parsedDiagnostic(input);
  assert.equal(parsed.process.exitCode, 0);
  assert.equal(parsed.process.timedOut, false);
  assert.equal(parsed.process.runnerSignal, null);
  assert.equal(parsed.process.cleanupUnknown, false);
  assert.equal(parsed.ownership.cleanupUnknown, false);
  assert.equal(parsed.truncated, false);
  for (const key of diagnosticArrays) {
    assert.deepEqual(parsed.ownership[key], []);
    assert.equal(parsed.counts[key], 0); assert.equal(parsed.omitted[key], 0);
  }
});

test('cleanup diagnostic rejects unsupported byte budgets', () => {
  for (const maxBytes of [0, 1023, 32769, 2048.5, NaN, Infinity]) {
    assert.throws(() => formatProcessCleanupSummary(diagnosticFixture(), { maxBytes }));
  }
});

test('native cleanup diagnostics retain exact birth strings and unsettled descriptor evidence', () => {
  const input = diagnosticFixture(), ownership = input.process.ownership;
  ownership.identityProvider = 'linux-proc-stat-fd';
  ownership.observed[0].startTicks = '18446744073709550000';
  ownership.labelChanges = [{ pid: 101, startTicks: '18446744073709550000', previousCommand: 'node', currentCommand: 'renamed' }];
  ownership.labelChangeCount = 1;
  ownership.nativeErrors = [{ operation: 'read', pid: 101, code: 'ETIMEDOUT', message: 'Held process read did not settle', private: 'PRIVATE_NATIVE' }];
  ownership.nativeErrorCount = 1;
  ownership.nativeResources = { opened: 2, closed: 1, held: 1, pendingOpens: 0, pendingReads: 1, pendingCloses: 1,
    unsettled: true, environment: 'PRIVATE_NATIVE' };
  const { parsed, text } = parsedDiagnostic(input);
  assert.equal(parsed.ownership.identityProvider, 'linux-proc-stat-fd');
  assert.equal(parsed.ownership.observed[0].startTicks, '18446744073709550000');
  assert.equal(parsed.ownership.labelChanges[0].startTicks, '18446744073709550000');
  assert.equal(parsed.ownership.nativeErrors[0].code, 'ETIMEDOUT');
  assert.equal(parsed.ownership.nativeResources.unsettled, true);
  assert.equal(parsed.ownership.nativeResources.pendingReads, 1);
  assert.equal(parsed.ownership.nativeResources.pendingCloses, 1);
  assert.equal(parsed.truncated, false);
  assert.ok(!text.includes('PRIVATE_'));
});

test('native diagnostics preserve total counters and uncertainty at the minimum byte budget', () => {
  const input = diagnosticFixture(), ownership = input.process.ownership;
  const long = '🙂漢字"\\\n'.repeat(1000);
  ownership.identityProvider = 'linux-proc-stat-fd';
  ownership.labelChanges = Array.from({ length: 32 }, () => ({ pid: 101, startTicks: '9007199254740993', previousCommand: long, currentCommand: long }));
  ownership.labelChangeCount = 79;
  ownership.nativeErrors = Array.from({ length: 32 }, () => ({ operation: 'read', pid: 101, code: 'ETIMEDOUT', message: long }));
  ownership.nativeErrorCount = 200;
  ownership.nativeResources = { opened: 512, closed: 0, held: 512, pendingOpens: 0, pendingReads: 512, pendingCloses: 512, unsettled: true };
  const { parsed } = parsedDiagnostic(input, 1024);
  assert.equal(parsed.process.cleanupUnknown, true);
  assert.equal(parsed.ownership.cleanupUnknown, true);
  assert.equal(parsed.ownership.nativeResources.unsettled, true);
  assert.equal(parsed.counts.labelChanges, 79);
  assert.equal(parsed.counts.nativeErrors, 200);
  assert.equal(parsed.omitted.labelChanges, 79 - parsed.ownership.labelChanges.length);
  assert.equal(parsed.omitted.nativeErrors, 200 - parsed.ownership.nativeErrors.length);
  assert.equal(parsed.truncated, true);
  assertWellFormedStrings(parsed);
});

test('native diagnostic resource zero and settled false remain explicit', () => {
  const input = diagnosticFixture(), ownership = input.process.ownership;
  ownership.identityProvider = 'linux-proc-stat-fd';
  ownership.labelChanges = []; ownership.labelChangeCount = 0;
  ownership.nativeErrors = []; ownership.nativeErrorCount = 0;
  ownership.nativeResources = { opened: 0, closed: 0, held: 0, pendingOpens: 0, pendingReads: 0, pendingCloses: 0, unsettled: false };
  const { parsed } = parsedDiagnostic(input);
  assert.equal(parsed.ownership.nativeResources.unsettled, false);
  assert.equal(parsed.ownership.nativeResources.pendingReads, 0);
  assert.equal(parsed.counts.nativeErrors, 0);
  assert.equal(parsed.omitted.labelChanges, 0);
});
