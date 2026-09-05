import assert from 'node:assert/strict';
import childProcess, { spawn as namedSpawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOwnedBrowserLaunch } from './owned-browser-launch.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture({ emit } = {}) {
  const child = { pid: 12345 }, calls = [], events = [], synchronization = [];
  const native = { spawn(...args) { calls.push({ receiver: this, args }); return child; } };
  const original = native.spawn, executablePath = '/frozen/chrome', temporaryDirectory = '/invocation/tmp';
  const runtime = { childProcess: native, synchronize: () => synchronization.push(native.spawn),
    realpath: path => { assert.equal(typeof path, 'string'); return path; }, environment: { TMPDIR: temporaryDirectory } };
  const observer = createOwnedBrowserLaunch({ executablePath, temporaryDirectory, emit: emit ?? (record => events.push(record)) }, runtime);
  const argv = ['--flag', `--user-data-dir=${temporaryDirectory}/profile`];
  const options = { env: runtime.environment, detached: true };
  const spawn = () => native.spawn(executablePath, argv, options);
  return { child, calls, events, synchronization, native, original, observer, argv, options, spawn, runtime, executablePath, temporaryDirectory };
}

test('CPU native forwarding preserves receiver, argument references, returned child and handle identity', async () => {
  const f = fixture(), receiver = { tag: 'native-this' }, server = { process: () => f.child };
  const value = await f.observer.launch(async () => {
    assert.notEqual(f.native.spawn, f.original, 'Wrapper must precede any factory import.');
    const returned = Reflect.apply(f.native.spawn, receiver, [f.executablePath, f.argv, f.options]);
    assert.equal(returned, f.child);
    assert.deepEqual(f.observer.children, [f.child]);
    assert.equal(f.events[0].pid, f.child.pid);
    assert.equal(f.observer.pending, true);
    return server;
  });
  assert.equal(value, server); assert.equal(f.observer.server, server);
  assert.equal(f.observer.candidateServer, server);
  assert.equal(f.calls[0].receiver, receiver);
  assert.equal(f.calls[0].args[1], f.argv); assert.equal(f.calls[0].args[2], f.options);
  assert.equal(f.native.spawn, f.original); assert.equal(f.observer.pending, false);
  assert.equal(f.synchronization.length, 2);
  f.observer.children.length = 0; f.observer.records[0].pid = 8;
  assert.equal(f.observer.children[0], f.child); assert.equal(f.observer.records[0].pid, 12345);
  await assert.rejects(f.observer.launch(() => server), /exactly one launch/);
});

test('CPU rejected launch retains its pre-handle child and restores only after original rejection', async () => {
  const f = fixture(), wait = deferred(), failure = Error('launch rejected');
  const pending = f.observer.launch(() => { f.spawn(); return wait.promise; });
  assert.equal(f.observer.children[0], f.child); assert.notEqual(f.native.spawn, f.original);
  wait.reject(failure); await assert.rejects(pending, error => error === failure);
  assert.equal(f.native.spawn, f.original); assert.equal(f.observer.server, undefined);
  assert.equal(f.observer.children[0], f.child);
});

test('CPU caller deadline cannot restore interception before late original launch settles', async () => {
  const f = fixture(), wait = deferred(), timedOut = deferred();
  const pending = f.observer.launch(() => wait.promise);
  const caller = Promise.race([pending, timedOut.promise]);
  timedOut.reject(Error('outer deadline')); await assert.rejects(caller, /outer deadline/);
  assert.equal(f.observer.pending, true); assert.notEqual(f.native.spawn, f.original);
  assert.equal(f.spawn(), f.child, 'Late pre-handle spawn must still be intercepted.');
  const server = { process: () => f.child }; wait.resolve(server);
  assert.equal(await pending, server); assert.equal(f.native.spawn, f.original);
});

test('CPU emission failure does not alter native spawn return and cannot erase owned child', async () => {
  let observer, observedOwned = false;
  const failure = Error('stderr failed');
  const f = fixture({ emit: record => {
    observedOwned = observer.children[0].pid === record.pid;
    throw failure;
  } }); observer = f.observer;
  const server = { process: () => f.child };
  await assert.rejects(observer.launch(() => { assert.equal(f.spawn(), f.child); return server; }), error => {
    assert(error instanceof AggregateError); assert.equal(error.errors[0], failure); return true;
  });
  assert(observedOwned); assert.equal(observer.children[0], f.child); assert.equal(observer.server, server);
  assert.equal(f.native.spawn, f.original);
});

test('CPU native synchronous spawn error is passed through unchanged', async () => {
  const f = fixture(), failure = Error('native spawn failed');
  f.native.spawn = function () { throw failure; }; const original = f.native.spawn;
  await assert.rejects(f.observer.launch(() => f.spawn()), error => error === failure);
  assert.equal(f.native.spawn, original); assert.deepEqual(f.observer.children, []);
});

test('CPU setup failure or falsey rejection restores globals and cannot become success', async () => {
  const f = fixture(), cause = Error('ESM synchronization failed');
  f.runtime.synchronize = () => { throw cause; };
  const setup = createOwnedBrowserLaunch({ executablePath: f.executablePath, temporaryDirectory: f.temporaryDirectory, emit() {} }, f.runtime);
  await assert.rejects(setup.launch(() => { throw Error('Must not invoke factory.'); }), error => error === cause);
  assert.equal(f.native.spawn, f.original); assert.equal(setup.pending, false);
  let caught = false;
  await f.observer.launch(() => { throw undefined; }).then(() => assert.fail('Falsey rejection became success.'), value => {
    caught = true; assert.equal(value, undefined);
  });
  assert(caught); assert.equal(f.native.spawn, f.original);
});

test('CPU throwing spawn getter or installation setter cannot leave the global observer locked', async () => {
  for (const failureStage of ['get', 'set']) {
    const f = fixture(), cause = Error(`spawn ${failureStage} failed`);
    Object.defineProperty(f.native, 'spawn', { configurable: true,
      get() { if (failureStage === 'get') throw cause; return f.original; },
      set() { throw cause; },
    });
    await assert.rejects(f.observer.launch(() => assert.fail('Factory ran after failed installation.')), error => error === cause);
    assert.equal(f.observer.pending, false);
    const next = fixture();
    await next.observer.launch(() => { next.spawn(); return { process: () => next.child }; });
    assert.equal(next.native.spawn, next.original);
  }
});

test('CPU unrelated executable, external/root/duplicate profile and other TMPDIR are never adopted', async () => {
  for (const kind of ['executable', 'external', 'root', 'duplicate', 'tmpdir', 'relative', 'no-pid']) {
    const f = fixture();
    let file = f.executablePath, argv = [...f.argv], options = f.options;
    if (kind === 'executable') file = '/other/chrome';
    if (kind === 'external') argv[1] = '--user-data-dir=/invocation/tmp-sibling/profile';
    if (kind === 'root') argv[1] = '--user-data-dir=/invocation/tmp';
    if (kind === 'duplicate') argv.push(argv[1]);
    if (kind === 'tmpdir') options = { env: { TMPDIR: '/other/tmp' } };
    if (kind === 'relative') argv[1] = '--user-data-dir=relative/profile';
    if (kind === 'no-pid') delete f.child.pid;
    await assert.rejects(f.observer.launch(() => {
      assert.equal(f.native.spawn(file, argv, options), f.child);
      return { process: () => f.child };
    }), /exactly one owned browser child/);
    assert.deepEqual(f.observer.children, []); assert.deepEqual(f.events, []);
    assert.equal(f.observer.unverifiedSpawns.length, kind === 'executable' ? 0 : 1);
    assert(f.observer.candidateServer); assert.equal(f.observer.server, undefined);
    assert.equal(f.calls.length, 1, 'Unrelated native calls are forwarded, not suppressed.');
  }
});

test('CPU canonical profile escape fails ownership and wrong returned browser handle is rejected', async () => {
  const f = fixture();
  f.runtime.realpath = path => path.endsWith('/profile') ? '/other/profile' : path;
  const escaped = createOwnedBrowserLaunch({ executablePath: f.executablePath, temporaryDirectory: f.temporaryDirectory, emit() {} }, f.runtime);
  await assert.rejects(escaped.launch(() => { f.spawn(); return { process: () => f.child }; }), /exactly one owned/);
  assert.deepEqual(escaped.children, []);
  const unmatched = { process: () => ({ pid: f.child.pid }) };
  await assert.rejects(f.observer.launch(() => { f.spawn(); return unmatched; }), /does not match/);
  assert.equal(f.observer.server, undefined); assert.equal(f.observer.children[0], f.child);
  assert.equal(f.observer.candidateServer, unmatched);
});

test('CPU path-validation exception still forwards native spawn and retains only unverified PID evidence', async () => {
  const f = fixture(), cause = Error('profile vanished');
  const observer = createOwnedBrowserLaunch({ executablePath: f.executablePath, temporaryDirectory: f.temporaryDirectory, emit() {
    assert.fail('Unverified candidate cannot be announced as owned.');
  } }, { ...f.runtime, realpath: path => { if (path.endsWith('/profile')) throw cause; return path; } });
  const unmatched = { process: () => f.child };
  await assert.rejects(observer.launch(() => { assert.equal(f.spawn(), f.child); return unmatched; }), /exactly one owned/);
  assert.equal(observer.candidateServer, unmatched); assert.equal(observer.server, undefined);
  assert.deepEqual(observer.children, []); assert.equal(observer.errors[0], cause);
  assert.deepEqual(observer.unverifiedSpawns, [{ pid: f.child.pid, executablePath: f.executablePath, reason: 'path-validation-error' }]);
  assert.equal(f.calls.length, 1); assert.equal(f.native.spawn, f.original);
});

test('CPU overlapping observers cannot replace a pending wrapper; multiple matching children fail admission', async () => {
  const f = fixture(), second = fixture(), wait = deferred();
  const pending = f.observer.launch(() => wait.promise);
  await assert.rejects(second.observer.launch(() => {}), /still pending/);
  f.spawn(); f.spawn(); wait.resolve({ process: () => f.child });
  await assert.rejects(pending, /exactly one owned/); assert.equal(f.observer.children.length, 2);
  assert.equal(f.native.spawn, f.original); assert.equal(second.native.spawn, second.original);
});

test('CPU real Node child (not a browser) proves native ESM spawn interception and exact process cleanup', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'strata-owned-launch-')));
  const profile = await mkdtemp(join(directory, 'profile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previousTmp = process.env.TMPDIR; process.env.TMPDIR = directory;
  t.after(() => { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; });
  const executablePath = process.execPath, original = childProcess.spawn;
  const records = [], observer = createOwnedBrowserLaunch({ executablePath, temporaryDirectory: directory, emit: r => records.push(r) });
  let child;
  await observer.launch(async () => {
    child = namedSpawn(executablePath, ['-e', 'process.exit(0)', '--', `--user-data-dir=${profile}`], { env: process.env, stdio: 'ignore' });
    assert.equal(observer.children[0], child, 'Own before the async launch yields.');
    await once(child, 'exit'); return { process: () => child };
  });
  assert.equal(child.exitCode, 0); assert.equal(records[0].pid, child.pid);
  assert.equal(childProcess.spawn, original); assert.equal(namedSpawn, original);
});
