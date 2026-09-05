import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const MAX_PROCESSES = 512;
const CENSUS_MS = 1000;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function diagnosticText(value, maxBytes = 512) {
  if (typeof value !== 'string') return null;
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let result = bytes.subarray(0, maxBytes).toString('utf8');
  while (Buffer.byteLength(result) > maxBytes || result.endsWith('\ufffd')) result = result.slice(0, -1);
  return result;
}
const diagnosticNumber = value => Number.isSafeInteger(value) ? value : null;
function diagnosticIdentity(value, stringBytes = 512) {
  if (!value || typeof value !== 'object') return null;
  return { pid: diagnosticNumber(value.pid), ppid: diagnosticNumber(value.ppid), pgid: diagnosticNumber(value.pgid),
    start: diagnosticText(value.start, Math.min(64, stringBytes)), state: diagnosticText(value.state, Math.min(32, stringBytes)),
    command: diagnosticText(value.command, stringBytes) };
}
function diagnosticDetail(value, stringBytes = 512) {
  if (!value || typeof value !== 'object') return null;
  return { kind: diagnosticText(value.kind, Math.min(64, stringBytes)), rowIndex: diagnosticNumber(value.rowIndex),
    rowBytes: diagnosticNumber(value.rowBytes), rowPrefix: diagnosticText(value.rowPrefix, stringBytes),
    identity: diagnosticIdentity(value.identity, stringBytes) };
}

async function census() {
  // comm records the executable, never argv or the process environment.
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=,comm='], {
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, encoding: 'utf8', timeout: CENSUS_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ok(stdout.trim(), 'Process census unexpectedly returned no rows');
  return stdout.split('\n').filter(line => line.trim()).map((line, rowIndex) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+?)\s*$/.exec(line);
    try { assert.ok(match, 'Ambiguous process census row'); }
    catch (error) {
      // This prefix is only the selected PID/PPID/PGID/lstart/stat/comm columns;
      // ps was never asked for argv or environment values.
      error.diagnostic = { kind: 'ps-comm-row-parse', rowIndex, rowBytes: Buffer.byteLength(line), rowPrefix: diagnosticText(line, 384) };
      throw error;
    }
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
      start: match[4].replace(/\s+/g, ' '), state: match[5], command: match[6] };
  });
}

async function bounded(work, milliseconds) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Process census exceeded its deadline')), Math.max(1, milliseconds));
    })]);
  } finally { clearTimeout(timer); }
}
const same = (a, b) => a.pid === b.pid && a.start === b.start && a.command === b.command;
const live = value => value !== undefined && !value.state?.startsWith('Z');

/**
 * Track only descendants of the exact spawned root and previously observed
 * descendants. Retain identities across reparenting; PGIDs are evidence, never
 * authority to kill other processes. Polling cannot discover every short-lived
 * parent, so abnormal shutdown always retains that uncertainty.
 */
export function createProcessTracker({ rootPid, rootCommand, pollIntervalMs = 25,
  readProcesses = census, signalProcess = (pid, signal) => process.kill(pid, signal) }) {
  assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0 && typeof rootCommand === 'string' && rootCommand.length > 0);
  assert.ok(Number.isInteger(pollIntervalMs) && pollIntervalMs >= 1 && pollIntervalMs <= 1000);
  const owned = new Map(), retired = new Set(), mismatched = new Set();
  let latest = new Map(), started = false, initialAttempted = false, initialObserved = false, stopping = false, timer, sampling, closing;
  let deadline = Infinity;
  const report = { rootPid, cleanupUnknown: false, observed: [], signals: [], remaining: [],
    identityMismatches: [], censusErrors: [], limitations: [
      'Identity evidence is matched observed PID, executable command and second-resolution ps start time; it is not a hostile PID-reuse-proof OS sandbox.',
    ] };
  function unknown(message) {
    report.cleanupUnknown = true;
    if (!report.limitations.includes(message)) report.limitations.push(message);
  }
  function mismatch(expected, current) {
    unknown('A recorded PID changed identity; that PID and its new descendants were not signaled.');
    if (!mismatched.has(expected.pid)) report.identityMismatches.push({ expected, current });
    mismatched.add(expected.pid);
  }
  async function takeSample() {
    try {
      const rows = await bounded(Promise.resolve().then(readProcesses), Math.min(CENSUS_MS, deadline - Date.now()));
      assert.ok(Array.isArray(rows), 'Process census must return an array');
      const current = new Map();
      for (const row of rows) {
        try { assert.ok(row && Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.ppid) && row.ppid >= 0
          && Number.isSafeInteger(row.pgid) && row.pgid >= 0 && typeof row.start === 'string' && row.start.length > 0
          && typeof row.command === 'string' && row.command.length > 0 && !/[\u0000\r\n]/.test(row.command)
          && (row.state === undefined || typeof row.state === 'string') && !current.has(row.pid), 'Invalid or duplicate process census identity'); }
        catch (error) { error.diagnostic = { kind: 'invalid-census-identity', identity: diagnosticIdentity(row) }; throw error; }
        current.set(row.pid, { pid: row.pid, ppid: row.ppid, pgid: row.pgid, start: row.start, command: row.command,
          ...(row.state === undefined ? {} : { state: row.state }) });
      }
      latest = current;
      if (!initialObserved) {
        if (initialAttempted) return;
        initialAttempted = true;
        const root = current.get(rootPid);
        if (!root || !live(root) || (root.command !== rootCommand && root.command !== basename(rootCommand))) {
          report.initialRootObservation = { expected: { pid: rootPid, command: diagnosticText(rootCommand) }, observed: diagnosticIdentity(root),
            reason: !root ? 'missing' : !live(root) ? 'not-live' : 'command-mismatch' };
          unknown('The spawned root identity was unavailable before initial observation.');
          return;
        }
        owned.set(root.pid, root); initialObserved = true;
      }
      const parents = new Set();
      for (const [pid, expected] of owned) {
        const value = current.get(pid);
        if (!value || !live(value)) { retired.add(pid); continue; }
        if (retired.has(pid) || !same(expected, value)) { mismatch(expected, value); continue; }
        if (!mismatched.has(pid)) parents.add(pid);
      }
      // Only currently identity-matched parents anchor newly observed ownership.
      let changed;
      do {
        changed = false;
        for (const value of current.values()) {
          if (!parents.has(value.ppid) || owned.has(value.pid) || !live(value)) continue;
          if (owned.size >= MAX_PROCESSES) { unknown('Owned process census exceeded its 512-identity limit.'); break; }
          owned.set(value.pid, value); parents.add(value.pid); changed = true;
        }
      } while (changed);
    } catch (error) {
      initialAttempted = true;
      latest = new Map();
      unknown('Process census failed or was ambiguous; absence and ownership cannot be proven.');
      if (report.censusErrors.length < 32) report.censusErrors.push({ message: diagnosticText(error.message),
        code: typeof error.code === 'number' ? error.code : diagnosticText(error.code, 64), signal: diagnosticText(error.signal, 32),
        killed: typeof error.killed === 'boolean' ? error.killed : null, diagnostic: diagnosticDetail(error.diagnostic) });
    }
  }
  function sample() {
    // Join an active census rather than allowing a late old result to overwrite
    // a newer identity decision. All injected/OS census calls are bounded.
    if (!sampling) sampling = takeSample().finally(() => { sampling = undefined; });
    return sampling;
  }
  async function poll() {
    await sample();
    if (!stopping) timer = setTimeout(poll, pollIntervalMs);
  }
  async function start() {
    if (started) return sample();
    started = true; await sample();
    if (!stopping) timer = setTimeout(poll, pollIntervalMs);
  }
  function remaining() {
    return [...owned.values()].filter(expected => live(latest.get(expected.pid)) && !retired.has(expected.pid)
      && !mismatched.has(expected.pid) && same(expected, latest.get(expected.pid)));
  }
  async function signalOwned(signal, signaled) {
    // Children first gives the root a chance to reap them while still alive.
    const candidates = remaining().sort((a, b) => (a.pid === rootPid) - (b.pid === rootPid));
    for (const expected of candidates) {
      if (Date.now() >= deadline) break;
      if (signaled.has(expected.pid)) continue;
      await sample(); // Fresh PID/start/command check immediately before signaling.
      if (Date.now() >= deadline) break;
      const current = latest.get(expected.pid);
      if (!live(current) || retired.has(expected.pid) || mismatched.has(expected.pid) || !same(expected, current)) continue;
      try {
        // Synchronous primitive avoids a gap inside an asynchronous signal seam.
        signalProcess(expected.pid, signal);
        report.signals.push({ pid: expected.pid, pgid: current.pgid, start: current.start, command: current.command, signal });
        signaled.add(expected.pid);
      } catch (error) {
        if (error.code !== 'ESRCH') unknown(`Could not signal an owned process: ${error.code ?? error.message}`);
      }
    }
  }
  function cleanup({ reason, termGraceMs = 1500, killGraceMs = 1000 }) {
    assert.ok(['graceful', 'failure', 'timeout', 'signal'].includes(reason));
    if (reason !== 'graceful') unknown('Abnormal shutdown can hide descendants that forked and reparented entirely between process samples.');
    if (closing) return closing;
    for (const value of [termGraceMs, killGraceMs]) assert.ok(Number.isInteger(value) && value >= 0 && value <= 10_000);
    closing = (async () => {
      stopping = true; clearTimeout(timer);
      deadline = Date.now() + CENSUS_MS + termGraceMs + killGraceMs;
      await sample();
      if (!initialObserved) unknown('The spawned root was never identified.');
      const termEnd = Math.min(deadline, Date.now() + termGraceMs), terminated = new Set(), killed = new Set();
      while (Date.now() < deadline) {
        await signalOwned(Date.now() < termEnd ? 'SIGTERM' : 'SIGKILL', Date.now() < termEnd ? terminated : killed);
        await sample();
        if (!remaining().length) break;
        await wait(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      }
      report.observed = [...owned.values()];
      report.remaining = remaining();
      if (report.remaining.length) unknown('Recorded processes remained alive at the cleanup deadline.');
      return structuredClone(report);
    })();
    return closing;
  }
  return { start, sample, cleanup };
}

/**
 * Attach synchronously to a freshly spawned ChildProcess with piped output.
 * Operational failures resolve with their output/ownership receipt; the caller
 * chooses reporting and exit status. The caller must not add a second kill path.
 */
export function superviseChildProcess(child, { rootCommand, timeoutMs = 240_000, termGraceMs = 5000, killGraceMs = 1000,
  exitGraceMs = 1000, maxOutputBytes = 8 * 1024 * 1024, pollIntervalMs = 25, readProcesses, signalProcess }) {
  assert.ok(typeof rootCommand === 'string' && rootCommand.length > 0 && child?.stdout && child?.stderr);
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300_000);
  assert.ok(Number.isInteger(maxOutputBytes) && maxOutputBytes > 0 && maxOutputBytes <= 32 * 1024 * 1024);
  for (const value of [termGraceMs, killGraceMs, exitGraceMs]) assert.ok(Number.isInteger(value) && value >= 0 && value <= 10_000);
  const result = { stdout: '', stderr: '', error: null, process: { pid: child.pid ?? null, timeoutMs, termGraceMs, killGraceMs,
    exitGraceMs, timedOut: false, runnerSignal: null, cleanupUnknown: false } };
  return new Promise(resolveResult => {
    let timeout, failure, closing, tracker, exit, resolveExit, logBytes = 0;
    const exited = new Promise(resolve => { resolveExit = resolve; });
    const finish = () => {
      clearTimeout(timeout);
      process.off('SIGINT', interrupt); process.off('SIGTERM', termination);
      result.process.exitCode = exit?.code ?? null; result.process.exitSignal = exit?.signal ?? null;
      if (!failure && exit?.code !== 0) failure = new Error(`Workflow failed (${exit?.code ?? exit?.signal})`);
      result.error = failure ? { name: failure.name ?? 'Error', message: failure.message ?? String(failure) } : null;
      resolveResult(result);
    };
    const cleanup = (reason, error) => {
      failure ??= error;
      if (closing) {
        if (reason !== 'graceful') {
          result.process.cleanupUnknown = true;
          void tracker?.cleanup({ reason, termGraceMs, killGraceMs }).catch(() => {});
        }
        return;
      }
      closing = (async () => {
        try {
          if (!tracker) throw new Error('The spawned workflow PID could not be observed');
          const ownership = await tracker.cleanup({ reason, termGraceMs, killGraceMs });
          result.process.ownership = ownership;
          result.process.cleanupUnknown ||= ownership.cleanupUnknown;
          if (ownership.cleanupUnknown) failure ??= new Error('Owned process cleanup could not be fully verified');
          if (reason === 'graceful' && ownership.signals.length) failure ??= new Error('Workflow exited before disposing all observed descendants');
        } catch (cleanupError) {
          result.process.cleanupUnknown = true;
          result.process.cleanupError = cleanupError.message;
          failure ??= cleanupError;
        }
        let exitTimer;
        try { await Promise.race([exited, new Promise(resolve => { exitTimer = setTimeout(resolve, exitGraceMs); })]); }
        finally { clearTimeout(exitTimer); }
        if (!exit) {
          result.process.cleanupUnknown = true;
          failure ??= new Error('Workflow exit was not observed after bounded process cleanup');
          child.stdout.destroy(); child.stderr.destroy(); child.unref();
        }
      })().catch(error => {
        failure ??= error; result.process.cleanupUnknown = true;
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }).finally(finish);
    };
    const interrupted = signal => { result.process.runnerSignal = signal; cleanup('signal', new Error(`Runner interrupted by ${signal}`)); };
    const interrupt = () => interrupted('SIGINT'), termination = () => interrupted('SIGTERM');
    // Keep these listeners through census/start and detached-child cleanup, not
    // merely until the workflow root emits close.
    process.on('SIGINT', interrupt); process.on('SIGTERM', termination);
    child.once('error', error => cleanup('failure', error));
    child.once('close', (code, signal) => {
      exit = { code, signal }; resolveExit();
      cleanup(code === 0 && !failure ? 'graceful' : 'failure', code === 0 ? undefined : new Error(`Workflow failed (${code ?? signal})`));
    });
    for (const [stream, field] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8'); stream.on('data', text => {
        const bytes = Buffer.from(text), remaining = Math.max(0, maxOutputBytes - logBytes);
        let retained = bytes.subarray(0, remaining).toString('utf8');
        while (Buffer.byteLength(retained) > remaining) retained = retained.slice(0, -1);
        result[field] += retained; logBytes += Buffer.byteLength(retained);
        if (bytes.length > remaining) { result.process.logTruncated = true; cleanup('failure', new Error('Workflow exceeded its output byte limit')); }
      });
    }
    timeout = setTimeout(() => { result.process.timedOut = true; cleanup('timeout', new Error(`Workflow exceeded its ${timeoutMs}ms deadline`)); }, timeoutMs);
    if (child.pid) {
      try {
        tracker = createProcessTracker({ rootPid: child.pid, rootCommand, pollIntervalMs,
          ...(readProcesses ? { readProcesses } : {}), ...(signalProcess ? { signalProcess } : {}) });
        void tracker.start().catch(error => cleanup('failure', error));
      } catch (error) { cleanup('failure', error); }
    }
  });
}

/** Diagnostic-only whitelist: one bounded JSON line, with no workload payloads. */
export function formatProcessCleanupSummary(outcome, { maxBytes = 32 * 1024 } = {}) {
  assert.ok(Number.isInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 32 * 1024, 'Diagnostic byte budget must be 1024..32768');
  const processInfo = outcome?.process ?? {}, ownership = processInfo.ownership ?? {};
  const names = ['limitations', 'observed', 'remaining', 'identityMismatches', 'censusErrors', 'signals'];
  const arrays = Object.fromEntries(names.map(name => [name, Array.isArray(ownership[name]) ? ownership[name] : []]));
  const counts = Object.fromEntries(names.map(name => [name, arrays[name].length]));
  const caps = Object.fromEntries(names.map(name => [name, Math.min(32, counts[name])]));
  let stringBytes = 512, includeInitialRoot = true;
  const boolean = value => typeof value === 'boolean' ? value : null;
  function render() {
    let truncated = !includeInitialRoot && ownership.initialRootObservation !== undefined;
    const text = (value, limit = stringBytes) => {
      const clipped = diagnosticText(value, limit);
      if (typeof value === 'string' && clipped !== value) truncated = true;
      return clipped;
    };
    const identity = value => value && typeof value === 'object' ? {
      pid: diagnosticNumber(value.pid), ppid: diagnosticNumber(value.ppid), pgid: diagnosticNumber(value.pgid),
      start: text(value.start, Math.min(64, stringBytes)), command: text(value.command), state: text(value.state, Math.min(32, stringBytes)),
    } : null;
    const detail = value => value && typeof value === 'object' ? {
      kind: text(value.kind, Math.min(64, stringBytes)), rowIndex: diagnosticNumber(value.rowIndex), rowBytes: diagnosticNumber(value.rowBytes),
      rowPrefix: text(value.rowPrefix), identity: identity(value.identity),
    } : null;
    const maps = {
      limitations: value => text(value), observed: identity, remaining: identity,
      identityMismatches: value => ({ expected: identity(value?.expected), current: identity(value?.current) }),
      censusErrors: value => ({ message: text(value?.message), code: typeof value?.code === 'number' ? diagnosticNumber(value.code) : text(value?.code, Math.min(64, stringBytes)),
        signal: text(value?.signal, Math.min(32, stringBytes)), killed: boolean(value?.killed), diagnostic: detail(value?.diagnostic) }),
      signals: value => ({ ...identity(value), signal: text(value?.signal, Math.min(32, stringBytes)) }),
    };
    const filtered = Object.fromEntries(names.map(name => [name, arrays[name].slice(0, caps[name]).map(maps[name])]));
    const omitted = Object.fromEntries(names.map(name => [name, counts[name] - filtered[name].length]));
    if (Object.values(omitted).some(count => count > 0)) truncated = true;
    const initial = ownership.initialRootObservation;
    const initialRootObservation = includeInitialRoot && initial && typeof initial === 'object' ? {
      expected: identity(initial.expected), observed: identity(initial.observed), reason: text(initial.reason, Math.min(64, stringBytes)),
    } : null;
    const summary = {
      format: 'strata.preview.process-cleanup-diagnostic', version: 1,
      error: outcome?.error ? { name: text(outcome.error.name, Math.min(64, stringBytes)), message: text(outcome.error.message) } : null,
      process: { pid: diagnosticNumber(processInfo.pid), exitCode: diagnosticNumber(processInfo.exitCode),
        exitSignal: text(processInfo.exitSignal, Math.min(32, stringBytes)), runnerSignal: text(processInfo.runnerSignal, Math.min(32, stringBytes)),
        timedOut: boolean(processInfo.timedOut), cleanupUnknown: boolean(processInfo.cleanupUnknown), cleanupError: text(processInfo.cleanupError),
        timeoutMs: diagnosticNumber(processInfo.timeoutMs), termGraceMs: diagnosticNumber(processInfo.termGraceMs),
        killGraceMs: diagnosticNumber(processInfo.killGraceMs), exitGraceMs: diagnosticNumber(processInfo.exitGraceMs) },
      ownership: { rootPid: diagnosticNumber(ownership.rootPid), cleanupUnknown: boolean(ownership.cleanupUnknown),
        ...(initialRootObservation ? { initialRootObservation } : {}), ...filtered },
      counts, omitted, truncated,
    };
    // text() may have set the flag while constructing the last fields.
    summary.truncated = truncated;
    return `${JSON.stringify(summary)}\n`;
  }
  let result = render();
  while (Buffer.byteLength(result) > maxBytes) {
    // Preserve one short reason/error ahead of bulky process rows. Exact totals
    // remain visible even when all rows from a category must be omitted.
    const drop = ['observed', 'signals', 'identityMismatches', 'remaining', 'limitations', 'censusErrors']
      .find(name => caps[name] > (name === 'limitations' || name === 'censusErrors' ? 1 : 0));
    if (drop) caps[drop]--;
    else if (stringBytes > 16) stringBytes = Math.max(16, Math.floor(stringBytes / 2));
    else if (includeInitialRoot && ownership.initialRootObservation !== undefined) includeInitialRoot = false;
    else {
      const last = ['limitations', 'censusErrors'].find(name => caps[name] > 0);
      if (last) caps[last]--;
      else throw new Error('Diagnostic envelope cannot fit its minimum byte budget');
    }
    result = render();
  }
  return result;
}
