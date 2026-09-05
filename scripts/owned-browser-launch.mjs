import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, relative, sep } from 'node:path';

let activeObserver;
const below = (root, path) => {
  const suffix = relative(root, path);
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};

/**
 * Test-runner ownership only. Install by calling launch() BEFORE importing
 * Playwright. Unlike launchServer's private logs, this observes the real child
 * synchronously when native spawn returns, before a server handle is available.
 * The external supervisor must still verify PID/parent/group/UID/profile itself.
 * No process is signalled here. children remains available for caller cleanup,
 * including when its deadline expires before the original launch settles.
 * candidateServer and unverifiedSpawns are evidence ONLY, not cleanup authority.
 * Only children and the identity-matched server identify owned processes.
 *
 * runtime is a CPU-test seam; real launches use the native defaults exclusively.
 */
export function createOwnedBrowserLaunch({ executablePath, temporaryDirectory, emit = record => {
  process.stderr.write(`<launched> pid=${record.pid} ${JSON.stringify(record)}\n`);
} }, runtime = {}) {
  const native = runtime.childProcess ?? childProcess;
  const synchronize = runtime.synchronize ?? syncBuiltinESMExports;
  const canonical = runtime.realpath ?? realpathSync;
  const environment = runtime.environment ?? process.env;
  assert.equal(typeof executablePath, 'string');
  assert(isAbsolute(executablePath), 'Browser executable must be an absolute frozen path.');
  assert.equal(typeof temporaryDirectory, 'string');
  assert(isAbsolute(temporaryDirectory), 'Invocation TMPDIR must be absolute.');
  assert.equal(typeof emit, 'function');
  const expectedExecutable = canonical(executablePath);
  const expectedTemporary = canonical(temporaryDirectory);
  assert.equal(canonical(environment.TMPDIR), expectedTemporary, 'Invocation TMPDIR differs.');
  const children = [], records = [], errors = [], unverifiedSpawns = [];
  let used = false, pending = false, server, candidateServer;

  function match(args) {
    const [file, argv, options] = args;
    if (typeof file !== 'string' || file !== executablePath || !Array.isArray(argv)) return null;
    if (canonical(file) !== expectedExecutable) return null;
    const profiles = argv.filter(arg => typeof arg === 'string' && arg.startsWith('--user-data-dir='));
    if (profiles.length !== 1) return null;
    const profileArgument = profiles[0].slice('--user-data-dir='.length);
    if (!isAbsolute(profileArgument)) return null;
    const profile = canonical(profileArgument);
    const env = options?.env ?? environment;
    if (canonical(env.TMPDIR) !== expectedTemporary || !below(expectedTemporary, profile)) return null;
    return { executablePath: expectedExecutable, temporaryDirectory: expectedTemporary, profile };
  }

  const observer = {
    get children() { return [...children]; },
    get records() { return records.map(record => ({ ...record })); },
    get errors() { return [...errors]; },
    get pending() { return pending; },
    get server() { return server; },
    get candidateServer() { return candidateServer; },
    get unverifiedSpawns() { return unverifiedSpawns.map(record => ({ ...record })); },
    async launch(factory) {
      assert.equal(typeof factory, 'function');
      assert(!used, 'Each ownership observer admits exactly one launch.');
      assert(!activeObserver, 'Another native browser launch is still pending.');
      const originalSpawn = native.spawn;
      assert.equal(typeof originalSpawn, 'function');
      used = true; pending = true; activeObserver = observer;
      function observedSpawn(...args) {
        let identity, qualificationError;
        try { identity = match(args); } catch (error) { errors.push(error); qualificationError = error; }
        // Preserve native this, argument identities, return identity and throws.
        const child = Reflect.apply(originalSpawn, this, args);
        try {
          if (identity && Number.isSafeInteger(child.pid) && child.pid > 0) {
            // Ownership precedes any callback/logging which can throw.
            children.push(child);
            const record = Object.freeze({ pid: child.pid, ...identity });
            records.push(record);
            try { emit(record); } catch (error) { errors.push(error); }
          } else if (args[0] === executablePath) {
            // Preserve diagnostic evidence when path validation fails, without
            // adopting or granting signalling authority over this process.
            unverifiedSpawns.push(Object.freeze({ pid: Number.isSafeInteger(child.pid) ? child.pid : null,
              executablePath, reason: qualificationError ? 'path-validation-error' : 'identity-not-qualified' }));
          }
        } catch (error) { errors.push(error); }
        return child;
      }
      let value, failure, failed = false, installed = false;
      try {
        native.spawn = observedSpawn; installed = true;
        synchronize();
        // This promise is the ORIGINAL launch. An outer deadline must not call
        // restore early: a late native spawn still needs to be owned.
        value = await factory();
        candidateServer = value;
        assert.equal(children.length, 1, 'Expected exactly one owned browser child.');
        assert.equal(value?.process?.(), children[0], 'Browser handle does not match the observed native child.');
        server = value;
      } catch (error) { failed = true; failure = error; }
      finally {
        try {
          if (installed) {
            if (native.spawn !== observedSpawn) errors.push(Error('Native spawn changed while browser launch was pending.'));
            else native.spawn = originalSpawn;
            synchronize();
          }
        } catch (error) { errors.push(error); }
        pending = false; activeObserver = undefined;
      }
      if (failed) throw failure;
      if (errors.length) throw new AggregateError(errors, 'Browser launch ownership observation failed.');
      return value;
    },
  };
  return Object.freeze(observer);
}
