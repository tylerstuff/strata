import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { createLinuxNamespaceProvider } from './preview-process-namespace-linux.mjs';

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
  rootIsRunning, censusMs = 1000, maxProcesses = 512, maxAcquisitions = 512,
  namespaceProvider = createLinuxNamespaceProvider(), checkPidExistence = pid => process.kill(pid, 0),
  now = () => Date.now() }) {
  assert.ok(validPid(rootPid) && typeof rootCommand === 'string' && rootCommand.length > 0);
  for (const value of [readProcesses, signalProcess, rootIsRunning, nativeProvider?.open]) assert.equal(typeof value, 'function');
  assert.ok(Number.isInteger(pollIntervalMs) && pollIntervalMs >= 1 && pollIntervalMs <= 1000);
  assert.ok(Number.isInteger(censusMs) && censusMs >= 1 && censusMs <= 1000);
  assert.ok(Number.isInteger(maxProcesses) && maxProcesses >= 1 && maxProcesses <= 512);
  assert.ok(Number.isInteger(maxAcquisitions) && maxAcquisitions >= 1 && maxAcquisitions <= 512);
  for (const value of [namespaceProvider?.open, checkPidExistence, now]) assert.equal(typeof value, 'function');
  const owned = new Map(), retired = new Set(), rejected = new Set(), holders = new Set();
  const pendingOpens = new Set(), pendingReads = new Set(), pendingCloses = new Set();
  const pendingCensuses = new Set(), pendingConfirmations = new Set(), quarantined = new Map();
  const began = now(), elapsed = () => Math.max(0, now() - began);
  let sampleSequence = 0;
  let opened = 0, closed = 0, initialAttempted = false, initialObserved = false;
  let openedIdentities = 0, closedIdentities = 0, openedNamespaces = 0, closedNamespaces = 0;
  let started = false, stopping = false, terminal = false, timer, sampling, closing;
  let deadline = Infinity, latest = new Map();
  const report = { rootPid, identityProvider: 'linux-proc-stat-fd', cleanupUnknown: false,
    observed: [], signals: [], remaining: [], identityMismatches: [], censusErrors: [],
    labelChanges: [], labelChangeCount: 0, nativeErrors: [], nativeErrorCount: 0,
    nativeAcquisitions: [], nativeAcquisitionCount: 0, nativeAcquisitionLimitReached: false,
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
  const errorDetail = error => ({ code: short(error?.code), message: short(error?.message) });
  function recordNativeError(operation, pid, error) {
    if (terminal) return;
    report.nativeErrorCount++;
    if (report.nativeErrors.length < 32) report.nativeErrors.push({ operation, pid, code: short(error?.code), message: short(error?.message) });
  }
  function nativeError(operation, pid, error) {
    recordNativeError(operation, pid, error);
    unknown('Native identity I/O failed or remained unsettled; this is not proof that a process exited.');
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
      if (now() >= expires) throw problem('IDENTITY_TIMEOUT', 'Identity observation exceeded its deadline');
      const result = await Promise.race([observed, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(problem('IDENTITY_TIMEOUT', 'Identity observation exceeded its deadline')), Math.max(1, expires - now()));
      })]);
      // A fulfilled read can beat an overdue timer's callback after the event
      // loop was delayed. Such a result must not restore signaling authority.
      if (now() >= expires) throw problem('IDENTITY_TIMEOUT', 'Identity observation completed after its deadline');
      return result;
    } finally { clearTimeout(timeout); }
  }
  const usable = lease => lease.active && !terminal && now() < lease.expires;
  function rootLive() {
    try { return rootIsRunning() === true; }
    catch (error) { nativeError('root-state', rootPid, error); return false; }
  }
  function closeHolder(holder) {
    if (!holder.closePromise) holder.closePromise = track(pendingCloses, (async () => {
      try {
        if (holder.readPromise) await holder.readPromise.catch(() => {});
        await holder.handle.close();
        closed++;
        if (holder.purpose === 'namespace') closedNamespaces++; else closedIdentities++;
        holders.delete(holder);
      } catch (error) { holder.closeError = error; nativeError('close', holder.pid, error); }
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
  const confirmationUsable = lease => usable(lease) && !stopping;
  function requireConfirmation(lease) {
    if (!confirmationUsable(lease)) throw problem('IDENTITY_TIMEOUT', 'Candidate confirmation was interrupted or exceeded its original lease');
  }
  function reserveAcquisition(pid, context) {
    if (report.nativeAcquisitions.length >= maxAcquisitions) {
      report.nativeAcquisitionLimitReached = true;
      unknown(`Native acquisition ledger reached its ${maxAcquisitions}-attempt lifetime limit.`);
      return null;
    }
    const entry = { sequence: ++report.nativeAcquisitionCount, pid, role: context.role,
      discovery: { sampleId: context.sampleId, row: diagnosticIdentity(context.row) },
      parentBefore: diagnosticIdentity(context.before), scheduledAt: elapsed(), startedAt: null, settledAt: null,
      providerOutcome: { status: 'not-started', error: null },
      observationOutcome: { status: 'pending', error: null, expiresAt: Math.max(0, context.lease.expires - began) },
      resolution: 'pending', confirmation: null, laterContradiction: null };
    report.nativeAcquisitions.push(entry);
    return entry;
  }
  async function acquire(pid, lease, context) {
    if (!usable(lease) || stopping || rejected.has(pid) || retired.has(pid)) return null;
    const candidates = [...holders].filter(holder => holder.purpose === 'identity' && !holder.admitted).length;
    if (owned.size + candidates + pendingOpens.size >= maxProcesses) {
      unknown(`Owned process identities and pending acquisitions exceeded the ${maxProcesses}-identity limit.`); return null;
    }
    const entry = reserveAcquisition(pid, { ...context, lease });
    if (!entry) return null;
    let actualError;
    const operation = track(pendingOpens, Promise.resolve().then(async () => {
      requireConfirmation(lease);
      if (rejected.has(pid) || retired.has(pid)) throw problem('ADMISSION_INTERRUPTED', 'Candidate was excluded before native open');
      entry.startedAt = elapsed(); entry.providerOutcome.status = 'pending';
      let handle;
      try { handle = await nativeProvider.open(pid); }
      catch (error) {
        actualError = error; entry.settledAt = elapsed();
        entry.providerOutcome = { status: 'rejected', error: errorDetail(error) };
        recordNativeError('open', pid, error);
        throw error;
      }
      entry.settledAt = elapsed(); entry.providerOutcome = { status: 'fulfilled', error: null };
      opened++; openedIdentities++;
      const holder = { pid, handle, purpose: 'identity', acquisition: entry, admitted: false, disabled: false,
        initial: null, current: null, readPromise: null, closePromise: null };
      holders.add(holder);
      if (!confirmationUsable(lease)) {
        unknown('A native acquisition completed after its admission boundary and was not admitted.');
        holder.disabled = true; void closeHolder(holder);
      }
      return holder;
    }));
    try {
      const holder = await until(operation, lease.expires);
      entry.observationOutcome.status = 'received';
      if (!confirmationUsable(lease) || holder.disabled) {
        entry.resolution = 'unresolved'; void closeHolder(holder); return null;
      }
      if (typeof holder.handle?.read !== 'function' || typeof holder.handle?.close !== 'function') {
        entry.resolution = 'unresolved'; block(holder, 'open', problem('INVALID_NATIVE_HANDLE', 'Native provider returned an invalid handle')); return null;
      }
      return holder;
    } catch (error) {
      rejected.add(pid); entry.resolution = 'unresolved';
      entry.observationOutcome = { ...entry.observationOutcome,
        status: error?.code === 'IDENTITY_TIMEOUT' ? 'timed-out' : stopping ? 'interrupted' : 'received', error: errorDetail(error) };
      if (actualError === error && error?.code === 'ENOENT' && context.role === 'descendant'
        && confirmationUsable(lease)) {
        quarantined.set(pid, entry);
        await confirmAbsent(entry, context, lease);
      } else {
        if (actualError !== error) recordNativeError('open-observation', pid, error);
        unknown('Native acquisition was unresolved; no ownership or absence was established.');
      }
      return null;
    }
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
    if (now() >= lease.expires) {
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
      if (now() >= lease.expires) throw problem('IDENTITY_TIMEOUT', 'Native identity observation completed after its deadline');
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
  async function admitRoot(row, lease, sampleId) {
    if (!row || !alive(row) || !rootLive() || (row.command !== rootCommand && row.command !== basename(rootCommand))) {
      report.initialRootObservation = { expected: { pid: rootPid, command: short(rootCommand) }, observed: row ?? null,
        reason: !row ? 'missing' : !alive(row) ? 'not-live' : !rootLive() ? 'child-not-running' : 'command-mismatch' };
      unknown('The spawned root identity was unavailable before initial observation.'); return;
    }
    if (stopping) { unknown('Cleanup began before the root could be admitted.'); return; }
    const holder = await acquire(rootPid, lease, { role: 'root', row, sampleId });
    if (!holder) return;
    const value = await observe(holder, lease, row);
    if (!value || !usable(lease) || stopping || !rootLive() || value.command !== row.command) {
      if (!holder.disabled) { rejected.add(rootPid); holder.disabled = true; void closeHolder(holder); }
      holder.acquisition.resolution = 'unresolved';
      unknown('Root admission changed or was interrupted before native identity confirmation.'); return;
    }
    holder.acquisition.resolution = 'admitted';
    holder.admitted = true; holder.initial = { ...value }; owned.set(rootPid, holder);
    latest.set(rootPid, value); initialObserved = true;
  }
  async function admitChild(row, parent, lease, snapshot) {
    if (stopping) { unknown('A new descendant was discovered during cleanup and was not admitted.'); return false; }
    const before = await observe(parent, lease);
    if (!before || !usable(lease) || stopping) {
      if (stopping) unknown('Cleanup interrupted a candidate descendant admission.');
      return false;
    }
    const holder = await acquire(row.pid, lease, { role: 'descendant', row, parent, before, snapshot, sampleId: snapshot.id });
    if (!holder) return false;
    const value = await observe(holder, lease, row);
    const after = value ? await observe(parent, lease) : null;
    if (!value || !after || !usable(lease) || stopping || value.ppid !== parent.pid || after.startTicks !== before.startTicks) {
      rejected.add(row.pid); holder.disabled = true; void closeHolder(holder);
      holder.acquisition.resolution = 'unresolved';
      unknown('A candidate descendant could not be admitted with a confirmed live parent.'); return false;
    }
    holder.acquisition.resolution = 'admitted';
    holder.admitted = true; holder.initial = { ...value }; owned.set(row.pid, holder); latest.set(row.pid, value);
    return true;
  }
  function recordCensusError(error) {
    if (terminal) return;
    if (report.censusErrors.length < 32) report.censusErrors.push({ message: short(error?.message),
      code: typeof error?.code === 'number' ? error.code : short(error?.code, 64), signal: short(error?.signal, 32),
      killed: typeof error?.killed === 'boolean' ? error.killed : null, diagnostic: diagnosticDetail(error?.diagnostic) });
  }
  function validateCensus(rows) {
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
    return current;
  }
  function takeCensus(lease, confirmation = false) {
    const id = ++sampleSequence;
    return track(pendingCensuses, Promise.resolve().then(() => {
      if (!usable(lease) || (confirmation && stopping)) throw problem('IDENTITY_TIMEOUT', 'Process census cannot start after its boundary');
      return readProcesses();
    }).then(rows => {
      if (!usable(lease) || (confirmation && stopping)) throw problem('IDENTITY_TIMEOUT', 'Process census settled after its boundary');
      return { id, rows: validateCensus(rows) };
    }));
  }
  function dependents(snapshot, pid, lease) {
    if (snapshot.rows.size > 65536) throw problem('CENSUS_GRAPH_LIMIT', 'Candidate ancestry check exceeded its row bound');
    const children = new Map();
    for (const row of snapshot.rows.values()) {
      if (!usable(lease)) throw problem('IDENTITY_TIMEOUT', 'Candidate ancestry check exceeded its lease');
      if (!children.has(row.ppid)) children.set(row.ppid, []);
      children.get(row.ppid).push(row);
    }
    const queue = [pid], seen = new Set([pid]), rows = [];
    let count = 0;
    for (let index = 0; index < queue.length; index++) {
      if (!usable(lease)) throw problem('IDENTITY_TIMEOUT', 'Candidate ancestry check exceeded its lease');
      for (const row of children.get(queue[index]) ?? []) {
        if (seen.has(row.pid)) throw problem('CENSUS_GRAPH_CYCLE', 'Candidate ancestry check encountered a cycle');
        seen.add(row.pid); queue.push(row.pid); count++;
        if (rows.length < 16) rows.push(diagnosticIdentity(row));
      }
    }
    return { count, rows };
  }
  function checkQuarantined(snapshot, lease, exceptPid) {
    for (const [pid, entry] of quarantined) {
      if (pid === exceptPid) continue;
      const row = snapshot.rows.get(pid), descendants = dependents(snapshot, pid, lease);
      if (row || descendants.count) {
        const previous = entry.laterContradiction;
        entry.laterContradiction = previous ? { ...previous, count: previous.count + 1 }
          : { sampleId: snapshot.id, count: 1, row: diagnosticIdentity(row), dependents: descendants };
        unknown('A quarantined candidate or observed dependent reappeared; it cannot regain ownership or ancestry authority.');
      }
    }
  }
  async function readNamespace(lease) {
    requireConfirmation(lease);
    let holder, primaryError;
    let operation = 'namespace-open';
    try {
      const handle = await track(pendingOpens, Promise.resolve().then(() => {
        requireConfirmation(lease); return namespaceProvider.open();
      }));
      opened++; openedNamespaces++;
      holder = { pid: process.pid, handle, purpose: 'namespace', admitted: false, disabled: true,
        readPromise: null, closePromise: null };
      holders.add(holder);
      operation = 'namespace-read';
      requireConfirmation(lease);
      if (typeof handle?.read !== 'function' || typeof handle?.close !== 'function') {
        throw problem('INVALID_NAMESPACE_HANDLE', 'Namespace provider returned an invalid diagnostic handle');
      }
      holder.readPromise = track(pendingReads, Promise.resolve().then(() => {
        requireConfirmation(lease); return handle.read(() => confirmationUsable(lease));
      }));
      const value = await holder.readPromise;
      requireConfirmation(lease);
      if (!value || value.checkerPid !== process.pid || value.nstgid !== process.pid || value.valueCount !== 1
        || !Number.isSafeInteger(value.byteCount) || value.byteCount < 1 || value.byteCount > 65536) {
        throw problem('INVALID_PROC_NAMESPACE', 'Proc mount and checking process namespace were not established');
      }
      return { checkerPid: value.checkerPid, nstgid: value.nstgid, valueCount: 1, byteCount: value.byteCount };
    } catch (error) {
      primaryError = error;
      nativeError(operation, process.pid, error);
      throw error;
    } finally {
      if (holder) {
        await closeHolder(holder);
        if (holder.closeError && !primaryError) throw holder.closeError;
      }
    }
  }
  async function confirmAbsent(entry, context, lease) {
    const evidence = entry.confirmation = { startedAt: elapsed(), settledAt: null, failedGate: 'discovery',
      discoveryDependents: null, namespaceBefore: null, namespaceAfter: null, census: null,
      existence: null, parentAfter: null, error: null };
    // Observe the whole actual operation. A timeout does not remove ownership
    // of a pending namespace read/close or census, and late success has no gate.
    const operation = track(pendingConfirmations, (async () => {
      let parentRead;
      try {
        requireConfirmation(lease);
        evidence.discoveryDependents = dependents(context.snapshot, entry.pid, lease);
        if (evidence.discoveryDependents.count) throw problem('CANDIDATE_DEPENDENTS', 'Discovery observed a dependent through the unadmitted candidate');
        evidence.failedGate = 'namespace-before';
        evidence.namespaceBefore = await readNamespace(lease);
        requireConfirmation(lease); evidence.failedGate = 'census';
        let snapshot;
        try { snapshot = await takeCensus(lease, true); }
        catch (error) { recordCensusError(error); throw error; }
        requireConfirmation(lease);
        const candidate = snapshot.rows.get(entry.pid), descendants = dependents(snapshot, entry.pid, lease);
        evidence.census = { sampleId: snapshot.id, rowCount: snapshot.rows.size,
          candidate: diagnosticIdentity(candidate), dependents: descendants };
        checkQuarantined(snapshot, lease, entry.pid);
        if (!snapshot.rows.size || candidate || descendants.count) {
          throw problem('CANDIDATE_CENSUS_CONTRADICTION', 'Fresh full census did not establish candidate and observed dependent absence');
        }
        evidence.failedGate = 'existence'; requireConfirmation(lease);
        try { await checkPidExistence(entry.pid); evidence.existence = { code: null, absent: false }; }
        catch (error) { evidence.existence = { code: short(error?.code), absent: error?.code === 'ESRCH', error: errorDetail(error) }; }
        requireConfirmation(lease);
        if (!evidence.existence.absent) throw problem('CANDIDATE_EXISTENCE_UNKNOWN', 'Independent signal-zero check did not establish current absence');
        evidence.failedGate = 'namespace-after';
        evidence.namespaceAfter = await readNamespace(lease);
        requireConfirmation(lease); evidence.failedGate = 'parent';
        const observingParent = observe(context.parent, lease);
        parentRead = context.parent.readPromise;
        const after = await observingParent;
        evidence.parentAfter = diagnosticIdentity(after);
        requireConfirmation(lease);
        if (!after || context.parent.disabled || !context.parent.admitted || after.pid !== context.before.pid
          || after.startTicks !== context.before.startTicks) throw problem('CANDIDATE_PARENT_CHANGED', 'Retained parent lost continuity during candidate confirmation');
        evidence.failedGate = null;
        entry.resolution = 'absent-before-admission';
      } catch (error) {
        entry.resolution = 'unresolved'; evidence.error = errorDetail(error);
        unknown('Candidate absence confirmation failed; the unadmitted PID remains quarantined without authority.');
        throw error;
      } finally {
        // observe() has its own observation deadline. Its underlying retained
        // parent read (and any failure-triggered close) still belongs to this
        // confirmation after that observation returns.
        if (parentRead) await parentRead.catch(() => {});
        if (context.parent.closePromise) await context.parent.closePromise;
        evidence.settledAt = elapsed();
      }
    })());
    try { await until(operation, lease.expires); }
    catch (error) {
      entry.resolution = 'unresolved';
      if (!evidence.error) {
        evidence.error = errorDetail(error);
        nativeError('confirm-observation', entry.pid, error);
      }
    }
  }
  async function takeSample() {
    const lease = { active: true, expires: Math.min(deadline, now() + censusMs) };
    try {
      if (!usable(lease)) throw problem('IDENTITY_TIMEOUT', 'Process census cannot start after its deadline');
      const snapshot = await until(takeCensus(lease), lease.expires);
      if (!usable(lease)) return;
      const current = snapshot.rows;
      checkQuarantined(snapshot, lease);
      if (!initialAttempted) { initialAttempted = true; await admitRoot(current.get(rootPid), lease, snapshot.id); }
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
          added = await admitChild(row, parent, lease, snapshot) || added;
        }
      } while (added && usable(lease));
    } catch (error) {
      if (!terminal) {
        initialAttempted = true;
        unknown('Process census failed or was ambiguous; absence and ownership cannot be proven.');
        recordCensusError(error);
      }
    } finally {
      if (!terminal && now() >= lease.expires) unknown('Native process census reached its observation deadline.');
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
      if (now() >= deadline) break;
      if (signaled.has(candidate.pid)) continue;
      const holder = owned.get(candidate.pid), lease = { active: true, expires: Math.min(deadline, now() + censusMs) };
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
    return { opened, closed, openedIdentities, closedIdentities, openedNamespaces, closedNamespaces,
      held: holders.size, pendingOpens: pendingOpens.size,
      pendingReads: pendingReads.size, pendingCloses: pendingCloses.size,
      pendingCensuses: pendingCensuses.size, pendingConfirmations: pendingConfirmations.size,
      heldIdentities: [...holders].filter(holder => holder.purpose === 'identity').length,
      heldNamespaces: [...holders].filter(holder => holder.purpose === 'namespace').length,
      unsettled: holders.size + pendingOpens.size + pendingReads.size + pendingCloses.size
        + pendingCensuses.size + pendingConfirmations.size > 0 };
  }
  function cleanup({ reason, termGraceMs = 1500, killGraceMs = 1000 }) {
    assert.ok(['graceful', 'failure', 'timeout', 'signal'].includes(reason));
    for (const value of [termGraceMs, killGraceMs]) assert.ok(Number.isInteger(value) && value >= 0 && value <= 10_000);
    if (reason !== 'graceful') unknown('Abnormal shutdown can hide descendants that forked and reparented entirely between process samples.');
    if (closing) return closing;
    stopping = true; clearTimeout(timer); deadline = now() + censusMs + termGraceMs + killGraceMs;
    closing = (async () => {
      await sample();
      if (!initialObserved) unknown('The spawned root was never identified.');
      const termEnd = Math.min(deadline, now() + termGraceMs), terminated = new Set(), killed = new Set();
      while (now() < deadline) {
        const terminating = now() < termEnd;
        await signalOwned(terminating ? 'SIGTERM' : 'SIGKILL', terminating ? terminated : killed);
        await sample();
        if (!remaining().length) break;
        await pause(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
      }
      report.observed = [...owned.values()].map(holder => holder.initial);
      report.remaining = remaining();
      if (report.remaining.length) unknown('Recorded processes remained alive at the cleanup deadline.');
      for (const holder of holders) void closeHolder(holder);
      for (;;) {
        const pending = [...pendingOpens, ...pendingReads, ...pendingCloses, ...pendingCensuses, ...pendingConfirmations];
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
