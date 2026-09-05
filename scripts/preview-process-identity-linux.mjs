import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const alive = value => value && !/^[ZXx]/.test(value.state);
const validPid = value => Number.isSafeInteger(value) && value > 0;
function short(value, maxBytes = 512) {
  if (typeof value !== 'string') return null;
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let result = bytes.subarray(0, maxBytes).toString('utf8');
  while (Buffer.byteLength(result) > maxBytes || result.endsWith('\ufffd')) result = result.slice(0, -1);
  return result;
}
const number = value => Number.isSafeInteger(value) ? value : null;
function diagnosticIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  return { pid: number(value.pid), ppid: number(value.ppid), pgid: number(value.pgid),
    start: short(value.start, 64), state: short(value.state, 32), command: short(value.command),
    ...(typeof value.startTicks === 'string' ? { startTicks: short(value.startTicks, 32) } : {}) };
}
function diagnosticDetail(value) {
  if (!value || typeof value !== 'object') return null;
  return { kind: short(value.kind, 64), rowIndex: number(value.rowIndex), rowBytes: number(value.rowBytes),
    rowPrefix: short(value.rowPrefix), identity: diagnosticIdentity(value.identity) };
}
const problem = (code, message) => Object.assign(new Error(message), { code });

/** Identity fields only; comm may contain spaces, parentheses, or newlines. */
export function parseLinuxProcessStat(text, expectedPid) {
  assert.ok(validPid(expectedPid), 'Expected a positive safe PID');
  const invalid = () => { throw problem('INVALID_PROC_STAT', 'Malformed or oversized proc stat identity'); };
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4096 || !text.endsWith('\n') || text.includes('\0')) invalid();
  const opening = text.indexOf('('), closing = text.lastIndexOf(')');
  if (opening < 1 || closing <= opening || text[closing + 1] !== ' ') invalid();
  const pidText = text.slice(0, opening).trim();
  const fields = text.slice(closing + 1).trim().split(/\s+/);
  if (!/^[1-9]\d*$/.test(pidText) || Number(pidText) !== expectedPid || fields.length < 20
    || !/^[RSDZTtXxKWPI]$/.test(fields[0]) || !fields.slice(1).every(value => /^-?\d+$/.test(value))) invalid();
  const ppid = Number(fields[1]), pgid = Number(fields[2]), startTicks = fields[19];
  if (!/^\d+$/.test(fields[1]) || !/^\d+$/.test(fields[2]) || !Number.isSafeInteger(ppid) || ppid < 0
    || !Number.isSafeInteger(pgid) || pgid < 0 || !/^(0|[1-9]\d{0,19})$/.test(startTicks)
    || BigInt(startTicks) > 18446744073709551615n) invalid();
  return { pid: expectedPid, ppid, pgid, state: fields[0], command: text.slice(opening + 1, closing), startTicks };
}

/** Retain one proc inode. Never reopen by PID to refresh an admitted identity. */
export function createLinuxProcessProvider({ openFile = open } = {}) {
  assert.equal(typeof openFile, 'function');
  return {
    async open(pid) {
      assert.ok(validPid(pid));
      const handle = await openFile(`/proc/${pid}/stat`, 'r');
      let reading, closing;
      return {
        read() {
          if (closing) return Promise.reject(problem('PROC_HANDLE_CLOSED', 'Proc identity handle is closing'));
          if (!reading) reading = (async () => {
            const bytes = Buffer.alloc(4097);
            const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
            if (bytesRead === 0) throw problem('PROC_IDENTITY_EOF', 'Retained proc identity reached EOF');
            if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > 4096) throw problem('INVALID_PROC_STAT', 'Proc stat exceeded its byte limit');
            let text;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)); }
            catch { throw problem('INVALID_PROC_STAT', 'Proc stat identity contains invalid UTF-8'); }
            return parseLinuxProcessStat(text, pid);
          })().finally(() => { reading = undefined; });
          return reading;
        },
        close() {
          // close waits for the actual read, not its caller's observation timeout.
          if (!closing) closing = (async () => {
            if (reading) await reading.catch(() => {});
            await handle.close();
          })();
          return closing;
        },
      };
    },
  };
}

/**
 * Linux-only ownership evidence for the optional test launcher, not a sandbox.
 * ps discovers candidates; held proc descriptors establish continuing identity.
 * A numeric kill still has a final-check-to-signal race. No platform fallback is
 * performed here: the caller selects this provider explicitly or on Linux.
 */
export function createNativeProcessTracker({ rootPid, rootCommand, pollIntervalMs = 25,
  readProcesses, signalProcess = (pid, signal) => process.kill(pid, signal), nativeProvider,
  rootIsRunning, censusMs = 1000, maxProcesses = 512 }) {
  assert.ok(validPid(rootPid) && typeof rootCommand === 'string' && rootCommand.length > 0);
  for (const value of [readProcesses, signalProcess, rootIsRunning, nativeProvider?.open]) assert.equal(typeof value, 'function');
  assert.ok(Number.isInteger(pollIntervalMs) && pollIntervalMs >= 1 && pollIntervalMs <= 1000);
  assert.ok(Number.isInteger(censusMs) && censusMs >= 1 && censusMs <= 1000);
  assert.ok(Number.isInteger(maxProcesses) && maxProcesses >= 1 && maxProcesses <= 512);
  const owned = new Map(), retired = new Set(), rejected = new Set(), holders = new Set();
  const pendingOpens = new Set(), pendingReads = new Set(), pendingCloses = new Set();
  let opened = 0, closed = 0, initialAttempted = false, initialObserved = false;
  let started = false, stopping = false, terminal = false, timer, sampling, closing;
  let deadline = Infinity, latest = new Map();
  const report = { rootPid, identityProvider: 'linux-proc-stat-fd', cleanupUnknown: false,
    observed: [], signals: [], remaining: [], identityMismatches: [], censusErrors: [],
    labelChanges: [], labelChangeCount: 0, nativeErrors: [], nativeErrorCount: 0,
    limitations: [
      'Held proc descriptors provide continuity after admission; initial root admission still requires the expected process label and live ChildProcess observation.',
      'Process samples can miss a child that forks and reparents entirely between observations. Numeric-PID signaling retains a final-check-to-signal race.',
      'Native I/O observation deadlines do not cancel syscalls. Unsettled handles remain owned and late results are closed without new admissions.',
    ] };
  function unknown(message) {
    if (terminal) return;
    report.cleanupUnknown = true;
    if (!report.limitations.includes(message) && report.limitations.length < 32) report.limitations.push(message);
  }
  function nativeError(operation, pid, error) {
    if (terminal) return;
    unknown('Native identity I/O failed or remained unsettled; this is not proof that a process exited.');
    report.nativeErrorCount++;
    if (report.nativeErrors.length < 32) report.nativeErrors.push({ operation, pid, code: short(error?.code), message: short(error?.message) });
  }
  function track(set, promise) {
    const tracked = Promise.resolve(promise).finally(() => set.delete(tracked));
    set.add(tracked); void tracked.catch(() => {});
    return tracked;
  }
  async function until(promise, expires) {
    // The caller may already have started an operation. Observe it even when
    // the deadline has expired; a timeout does not cancel native work.
    const observed = Promise.resolve(promise);
    void observed.catch(() => {});
    let timeout;
    try {
      if (Date.now() >= expires) throw problem('IDENTITY_TIMEOUT', 'Identity observation exceeded its deadline');
      const result = await Promise.race([observed, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(problem('IDENTITY_TIMEOUT', 'Identity observation exceeded its deadline')), Math.max(1, expires - Date.now()));
      })]);
      // A fulfilled read can beat an overdue timer's callback after the event
      // loop was delayed. Such a result must not restore signaling authority.
      if (Date.now() >= expires) throw problem('IDENTITY_TIMEOUT', 'Identity observation completed after its deadline');
      return result;
    } finally { clearTimeout(timeout); }
  }
  const usable = lease => lease.active && !terminal && Date.now() < lease.expires;
  function rootLive() {
    try { return rootIsRunning() === true; }
    catch (error) { nativeError('root-state', rootPid, error); return false; }
  }
  function closeHolder(holder) {
    if (!holder.closePromise) holder.closePromise = track(pendingCloses, (async () => {
      try {
        if (holder.readPromise) await holder.readPromise.catch(() => {});
        await holder.handle.close();
        closed++; holders.delete(holder);
      } catch (error) { nativeError('close', holder.pid, error); }
    })());
    return holder.closePromise;
  }
  function retire(holder) {
    holder.disabled = true; retired.add(holder.pid); latest.delete(holder.pid);
    void closeHolder(holder);
  }
  function block(holder, operation, error) {
    holder.disabled = true; rejected.add(holder.pid); latest.delete(holder.pid);
    nativeError(operation, holder.pid, error); void closeHolder(holder);
  }
  function mismatch(holder, current) {
    if (holder.disabled) return;
    unknown('A held process identity changed; it and newly discovered descendants were not signaled.');
    if (report.identityMismatches.length < maxProcesses) report.identityMismatches.push({ expected: holder.initial, current });
    holder.disabled = true; rejected.add(holder.pid); latest.delete(holder.pid); void closeHolder(holder);
  }
  async function acquire(pid, lease) {
    if (!usable(lease) || stopping || rejected.has(pid) || retired.has(pid)) return null;
    const candidates = [...holders].filter(holder => !holder.admitted).length;
    if (owned.size + candidates + pendingOpens.size >= maxProcesses) {
      unknown(`Owned process identities and pending acquisitions exceeded the ${maxProcesses}-identity limit.`); return null;
    }
    const operation = track(pendingOpens, Promise.resolve().then(() => nativeProvider.open(pid)).then(handle => {
      opened++;
      const holder = { pid, handle, admitted: false, disabled: false, initial: null, current: null, readPromise: null, closePromise: null };
      holders.add(holder);
      if (!usable(lease) || stopping) {
        unknown('A native acquisition completed after its admission boundary and was not admitted.');
        holder.disabled = true; void closeHolder(holder);
      }
      return holder;
    }));
    try {
      const holder = await until(operation, lease.expires);
      if (!usable(lease) || stopping || holder.disabled) { void closeHolder(holder); return null; }
      if (typeof holder.handle?.read !== 'function' || typeof holder.handle?.close !== 'function') {
        block(holder, 'open', problem('INVALID_NATIVE_HANDLE', 'Native provider returned an invalid handle')); return null;
      }
      return holder;
    } catch (error) { rejected.add(pid); nativeError('open', pid, error); return null; }
  }
  function validateNative(value, pid) {
    assert.ok(value && value.pid === pid && validPid(value.pid) && Number.isSafeInteger(value.ppid) && value.ppid >= 0
      && Number.isSafeInteger(value.pgid) && value.pgid >= 0 && typeof value.command === 'string' && Buffer.byteLength(value.command) <= 4096
      && typeof value.state === 'string' && /^[RSDZTtXxKWPI]$/.test(value.state)
      && typeof value.startTicks === 'string' && /^(0|[1-9]\d{0,19})$/.test(value.startTicks)
      && BigInt(value.startTicks) <= 18446744073709551615n, 'Invalid retained native identity');
    return { pid: value.pid, ppid: value.ppid, pgid: value.pgid, command: value.command, state: value.state, startTicks: value.startTicks };
  }
  async function observe(holder, lease, row) {
    if (!lease.active || terminal || holder.disabled || holder.closePromise) return null;
    if (Date.now() >= lease.expires) {
      block(holder, 'read', problem('IDENTITY_TIMEOUT', 'Native identity observation cannot start after its deadline')); return null;
    }
    if (holder.pid === rootPid && !rootLive()) { retire(holder); return null; }
    try {
      if (!holder.readPromise) {
        const operation = track(pendingReads, Promise.resolve().then(() => holder.handle.read()));
        holder.readPromise = operation;
        void operation.finally(() => { if (holder.readPromise === operation) holder.readPromise = null; }).catch(() => {});
      }
      const value = validateNative(await until(holder.readPromise, lease.expires), holder.pid);
      if (!lease.active || terminal || holder.disabled) return null;
      if (Date.now() >= lease.expires) throw problem('IDENTITY_TIMEOUT', 'Native identity observation completed after its deadline');
      if (!alive(value) || (holder.pid === rootPid && !rootLive())) { retire(holder); return null; }
      if (holder.initial && holder.initial.startTicks !== value.startTicks) { mismatch(holder, value); return null; }
      const previous = holder.current;
      holder.current = { ...(row ?? holder.initial ?? {}), ...value };
      if (holder.admitted) {
        latest.set(holder.pid, holder.current);
        if (previous && previous.command !== value.command) {
          report.labelChangeCount++;
          if (report.labelChanges.length < 32) report.labelChanges.push({ pid: holder.pid, startTicks: value.startTicks,
            previousCommand: short(previous.command), currentCommand: short(value.command) });
        }
      }
      return holder.current;
    } catch (error) {
      if (!lease.active || terminal) return null;
      if (error?.code === 'ESRCH' || error?.code === 'PROC_IDENTITY_EOF') retire(holder);
      else block(holder, 'read', error);
      return null;
    }
  }
  async function admitRoot(row, lease) {
    if (!row || !alive(row) || !rootLive() || (row.command !== rootCommand && row.command !== basename(rootCommand))) {
      report.initialRootObservation = { expected: { pid: rootPid, command: short(rootCommand) }, observed: row ?? null,
        reason: !row ? 'missing' : !alive(row) ? 'not-live' : !rootLive() ? 'child-not-running' : 'command-mismatch' };
      unknown('The spawned root identity was unavailable before initial observation.'); return;
    }
    if (stopping) { unknown('Cleanup began before the root could be admitted.'); return; }
    const holder = await acquire(rootPid, lease);
    if (!holder) return;
    const value = await observe(holder, lease, row);
    if (!value || !usable(lease) || stopping || !rootLive() || value.command !== row.command) {
      if (!holder.disabled) { rejected.add(rootPid); holder.disabled = true; void closeHolder(holder); }
      unknown('Root admission changed or was interrupted before native identity confirmation.'); return;
    }
    holder.admitted = true; holder.initial = { ...value }; owned.set(rootPid, holder);
    latest.set(rootPid, value); initialObserved = true;
  }
  async function admitChild(row, parent, lease) {
    if (stopping) { unknown('A new descendant was discovered during cleanup and was not admitted.'); return false; }
    const before = await observe(parent, lease);
    if (!before || !usable(lease) || stopping) {
      if (stopping) unknown('Cleanup interrupted a candidate descendant admission.');
      return false;
    }
    const holder = await acquire(row.pid, lease);
    if (!holder) return false;
    const value = await observe(holder, lease, row);
    const after = value ? await observe(parent, lease) : null;
    if (!value || !after || !usable(lease) || stopping || value.ppid !== parent.pid || after.startTicks !== before.startTicks) {
      rejected.add(row.pid); holder.disabled = true; void closeHolder(holder);
      unknown('A candidate descendant could not be admitted with a confirmed live parent.'); return false;
    }
    holder.admitted = true; holder.initial = { ...value }; owned.set(row.pid, holder); latest.set(row.pid, value);
    return true;
  }
  async function takeSample() {
    const lease = { active: true, expires: Math.min(deadline, Date.now() + censusMs) };
    try {
      if (!usable(lease)) throw problem('IDENTITY_TIMEOUT', 'Process census cannot start after its deadline');
      const rows = await until(Promise.resolve().then(() => {
        if (!usable(lease)) throw problem('IDENTITY_TIMEOUT', 'Process census cannot start after its deadline');
        return readProcesses();
      }), lease.expires);
      if (!usable(lease)) return;
      assert.ok(Array.isArray(rows), 'Process census must return an array');
      const current = new Map();
      for (const row of rows) {
        try { assert.ok(row && validPid(row.pid) && Number.isSafeInteger(row.ppid) && row.ppid >= 0
          && Number.isSafeInteger(row.pgid) && row.pgid >= 0 && typeof row.start === 'string' && row.start.length > 0
          && typeof row.command === 'string' && row.command.length > 0 && !/[\0\r\n]/.test(row.command)
          && (row.state === undefined || typeof row.state === 'string') && !current.has(row.pid), 'Invalid or duplicate process census identity'); }
        catch (error) { error.diagnostic = { kind: 'invalid-census-identity', identity: diagnosticIdentity(row) }; throw error; }
        current.set(row.pid, { pid: row.pid, ppid: row.ppid, pgid: row.pgid, start: row.start, command: row.command, state: row.state });
      }
      if (!initialAttempted) { initialAttempted = true; await admitRoot(current.get(rootPid), lease); }
      for (const holder of owned.values()) {
        const row = current.get(holder.pid);
        if (holder.disabled) continue;
        if (!row || !alive(row)) {
          // Discovery absence is not native process death. Never regain
          // authority after this gap, but distinguish confirmed terminal reads
          // from a live held instance that the census failed to describe.
          const value = await observe(holder, lease);
          if (value) {
            unknown('Discovery omitted or marked dead a still-live held process; its authority was permanently retired.');
            retire(holder);
          } else if (!holder.disabled) block(holder, 'read', problem('IDENTITY_TIMEOUT', 'Discovery departure could not be confirmed before the observation deadline'));
          continue;
        }
        await observe(holder, lease, row);
      }
      let added;
      do {
        added = false;
        for (const row of current.values()) {
          if (owned.has(row.pid) || retired.has(row.pid) || rejected.has(row.pid) || !alive(row)) continue;
          const parent = owned.get(row.ppid);
          if (!parent) continue;
          if (stopping) {
            unknown('A new descendant candidate was discovered during cleanup and was not admitted.'); continue;
          }
          if (!latest.has(parent.pid)) continue;
          if (!usable(lease)) throw problem('IDENTITY_TIMEOUT', 'Native process census exceeded its deadline');
          added = await admitChild(row, parent, lease) || added;
        }
      } while (added && usable(lease));
    } catch (error) {
      if (!terminal) {
        initialAttempted = true;
        unknown('Process census failed or was ambiguous; absence and ownership cannot be proven.');
        if (report.censusErrors.length < 32) report.censusErrors.push({ message: short(error?.message),
          code: typeof error?.code === 'number' ? error.code : short(error?.code, 64), signal: short(error?.signal, 32),
          killed: typeof error?.killed === 'boolean' ? error.killed : null, diagnostic: diagnosticDetail(error?.diagnostic) });
      }
    } finally {
      if (!terminal && Date.now() >= lease.expires) unknown('Native process census reached its observation deadline.');
      lease.active = false;
    }
  }
  function sample() {
    if (terminal) return Promise.resolve();
    if (!sampling) sampling = takeSample().finally(() => { sampling = undefined; });
    return sampling;
  }
  async function poll() { await sample(); if (!stopping) timer = setTimeout(poll, pollIntervalMs); }
  async function start() {
    if (terminal || stopping) return;
    if (started) return sample();
    started = true; await sample(); if (!stopping) timer = setTimeout(poll, pollIntervalMs);
  }
  const remaining = () => [...latest.values()].filter(value => !owned.get(value.pid)?.disabled);
  async function signalOwned(signal, signaled) {
    for (const candidate of remaining().sort((a, b) => (a.pid === rootPid) - (b.pid === rootPid))) {
      if (Date.now() >= deadline) break;
      if (signaled.has(candidate.pid)) continue;
      const holder = owned.get(candidate.pid), lease = { active: true, expires: Math.min(deadline, Date.now() + censusMs) };
      try {
        const value = await observe(holder, lease);
        if (!value || !usable(lease) || holder.disabled) continue;
        signalProcess(value.pid, signal);
        report.signals.push({ ...value, signal }); signaled.add(value.pid);
      } catch (error) {
        if (error?.code === 'ESRCH') retire(holder);
        else { nativeError('signal', candidate.pid, error); }
      } finally { lease.active = false; }
    }
  }
  function resources() {
    return { opened, closed, held: holders.size, pendingOpens: pendingOpens.size,
      pendingReads: pendingReads.size, pendingCloses: pendingCloses.size,
      unsettled: holders.size + pendingOpens.size + pendingReads.size + pendingCloses.size > 0 };
  }
  function cleanup({ reason, termGraceMs = 1500, killGraceMs = 1000 }) {
    assert.ok(['graceful', 'failure', 'timeout', 'signal'].includes(reason));
    for (const value of [termGraceMs, killGraceMs]) assert.ok(Number.isInteger(value) && value >= 0 && value <= 10_000);
    if (reason !== 'graceful') unknown('Abnormal shutdown can hide descendants that forked and reparented entirely between process samples.');
    if (closing) return closing;
    stopping = true; clearTimeout(timer); deadline = Date.now() + censusMs + termGraceMs + killGraceMs;
    closing = (async () => {
      await sample();
      if (!initialObserved) unknown('The spawned root was never identified.');
      const termEnd = Math.min(deadline, Date.now() + termGraceMs), terminated = new Set(), killed = new Set();
      while (Date.now() < deadline) {
        const terminating = Date.now() < termEnd;
        await signalOwned(terminating ? 'SIGTERM' : 'SIGKILL', terminating ? terminated : killed);
        await sample();
        if (!remaining().length) break;
        await pause(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      }
      report.observed = [...owned.values()].map(holder => holder.initial);
      report.remaining = remaining();
      if (report.remaining.length) unknown('Recorded processes remained alive at the cleanup deadline.');
      for (const holder of holders) void closeHolder(holder);
      for (;;) {
        const pending = [...pendingOpens, ...pendingReads, ...pendingCloses];
        if (!pending.length) break;
        try { await until(Promise.allSettled(pending), deadline); }
        catch { unknown('Native descriptor cleanup remained unsettled at the cleanup deadline.'); break; }
      }
      report.nativeResources = resources();
      if (report.nativeResources.unsettled) unknown('Native descriptors or acquisitions were not confirmed closed.');
      terminal = true;
      return structuredClone(report);
    })();
    return closing;
  }
  return { start, sample, cleanup };
}
