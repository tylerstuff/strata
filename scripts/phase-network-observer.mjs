/** Diagnostic metadata only: no body reads, request routing, or native method replacement. */
export const PHASE_NETWORK_LIMITS = Object.freeze({ maxBrowserRequests: 512, maxServerRequests: 512,
  maxEvents: 4096, maxEventBytesTotal: 4 * 1024 ** 2, maxTextBytes: 4096 });

/**
 * Register browser callbacks with page.on(name, observer.browser[name]); call
 * observer.server(req, res) before the existing HTTP handler. Keep the runner's
 * raw requestfailed error gate. Snapshot after browser/server closure, then
 * dispose listeners. IDs correlate native identities within each side; URLs
 * and timestamps permit descriptive comparison between sides; they do not
 * establish a shared request identity (no injected headers).
 */
export function createPhaseNetworkObserver({ now, stage, error }) {
  if (![now, stage, error].every(value => typeof value === 'function')) throw TypeError('Network observer callbacks are required.');
  const browserRequests = new WeakMap(), serverRequests = new WeakMap(), listeners = [], events = [], errors = [];
  const counts = { browserRequests: 0, serverRequests: 0, browserResponses: 0, browserFinished: 0, browserFailed: 0,
    serverFinished: 0, serverClosed: 0, serverErrors: 0, serverAborted: 0, incompleteServerCloses: 0,
    events: 0, eventBytes: 2, droppedEvents: 0, integrityFailures: 0 };
  let disposed = false, lastTime = -Infinity, notifying = false;
  const fail = message => {
    counts.integrityFailures++;
    // One bounded latched message and one notification, even if the sink throws
    // or recursively calls an observer callback. Counts retain subsequent faults.
    if (errors.length) return;
    const text = `Phase network observer: ${String(message).slice(0, 1024)}`;
    errors.push(text);
    if (!notifying) {
      notifying = true;
      try { error(text); } catch { errors.push('Phase network observer error callback threw.'); }
      finally { notifying = false; }
    }
  };
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const text = value => {
    check(typeof value === 'string' && Buffer.byteLength(value) <= PHASE_NETWORK_LIMITS.maxTextBytes, 'Missing or oversized text metadata.');
    return value;
  };
  const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
  const capture = (side, type, record) => {
    const elapsedMs = now(), context = stage();
    check(Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs >= lastTime, 'Invalid or backwards monotonic timestamp.');
    check(context && typeof context === 'object', 'Missing lifecycle stage.');
    const event = { eventId: counts.events + 1, elapsedMs, stage: text(context.stage),
      cellId: context.cellId === null ? null : text(context.cellId), side, type, ...record };
    lastTime = elapsedMs;
    const bytes = Buffer.byteLength(JSON.stringify(event)) + Number(events.length > 0);
    if (counts.events >= PHASE_NETWORK_LIMITS.maxEvents || counts.eventBytes + bytes > PHASE_NETWORK_LIMITS.maxEventBytesTotal) {
      counts.droppedEvents++; fail('Network event count/byte cap exceeded; evidence is incomplete.'); return;
    }
    events.push(event); counts.events++; counts.eventBytes += bytes;
  };
  const guard = operation => (...args) => {
    try { check(!disposed, 'Callback after observer disposal.'); operation(...args); }
    catch (cause) { fail(cause instanceof Error ? cause.message : 'Native metadata observation failed.'); }
  };
  const lookup = request => {
    check(object(request), 'Invalid native browser request identity.');
    const record = browserRequests.get(request); check(record, 'Event for unknown browser request.'); return record;
  };
  const browserRecord = record => ({ requestId: record.id, url: record.url, method: record.method });
  const browser = Object.freeze({
    request: guard(request => {
      check(object(request) && !browserRequests.has(request), 'Duplicate or invalid browser request.');
      check(counts.browserRequests < PHASE_NETWORK_LIMITS.maxBrowserRequests, 'Browser request cap exceeded.');
      const record = { id: ++counts.browserRequests, url: text(request.url()), method: text(request.method()), response: false, terminal: false };
      browserRequests.set(request, record);
      capture('browser', 'request', { ...browserRecord(record), resourceType: text(request.resourceType()) });
    }),
    response: guard(response => {
      const record = lookup(response.request()); check(!record.response && !record.terminal, 'Duplicate or out-of-order browser response.');
      const status = response.status(); check(Number.isInteger(status) && status >= 100 && status <= 599, 'Invalid browser HTTP status.');
      const headers = response.headers(); record.response = true; counts.browserResponses++;
      capture('browser', 'response', { ...browserRecord(record), status,
        contentLength: headers['content-length'] === undefined ? null : text(headers['content-length']),
        transferEncoding: headers['transfer-encoding'] === undefined ? null : text(headers['transfer-encoding']) });
    }),
    requestfinished: guard(request => {
      const record = lookup(request); check(record.response && !record.terminal, 'Out-of-order or duplicate browser completion.');
      record.terminal = true; counts.browserFinished++; capture('browser', 'requestfinished', browserRecord(record));
    }),
    requestfailed: guard(request => {
      const record = lookup(request); check(!record.terminal, 'Duplicate browser terminal event.');
      const failureText = text(request.failure()?.errorText); record.terminal = true; counts.browserFailed++;
      capture('browser', 'requestfailed', { ...browserRecord(record), failureText, responseObserved: record.response });
    }),
  });
  const server = guard((request, response) => {
    check(object(request) && object(response) && !serverRequests.has(request), 'Duplicate or invalid server request.');
    check(counts.serverRequests < PHASE_NETWORK_LIMITS.maxServerRequests, 'Server request cap exceeded.');
    const record = { requestId: ++counts.serverRequests, url: text(request.url), method: text(request.method), finished: false, closed: false };
    serverRequests.set(request, record);
    const values = () => {
      check(Number.isInteger(response.statusCode) && response.statusCode >= 100 && response.statusCode <= 599, 'Invalid server HTTP status.');
      check(typeof response.writableFinished === 'boolean', 'Missing server writableFinished state.');
      return { requestId: record.requestId, url: record.url, method: record.method, status: response.statusCode,
        writableFinished: response.writableFinished, finishObserved: record.finished };
    };
    const on = (target, name, operation) => { const callback = guard(operation); target.on(name, callback); listeners.push([target, name, callback]); };
    on(response, 'finish', () => {
      check(!record.finished && !record.closed, 'Duplicate or out-of-order server finish.');
      record.finished = true; counts.serverFinished++; capture('server', 'finish', values());
    });
    on(response, 'close', () => {
      check(!record.closed, 'Duplicate server close.'); record.closed = true; counts.serverClosed++;
      if (!response.writableFinished) counts.incompleteServerCloses++;
      capture('server', 'close', values());
    });
    on(response, 'error', cause => { counts.serverErrors++; capture('server', 'response-error', { ...values(), message: text(String(cause)) }); });
    on(request, 'error', cause => { counts.serverErrors++; capture('server', 'request-error', { ...values(), message: text(String(cause)) }); });
    on(request, 'aborted', () => { counts.serverAborted++; capture('server', 'aborted', values()); });
    capture('server', 'request', values());
  });
  return Object.freeze({ browser, server,
    snapshot() {
      return { limits: { ...PHASE_NETWORK_LIMITS }, events: events.map(value => ({ ...value })), counts: { ...counts }, errors: [...errors],
        admissible: errors.length === 0 && counts.browserFailed === 0 && counts.serverErrors === 0 && counts.serverAborted === 0
          && counts.incompleteServerCloses === 0 && counts.browserRequests === counts.browserFinished
          && counts.serverRequests === counts.serverFinished && counts.serverRequests === counts.serverClosed };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [target, name, callback] of listeners.splice(0)) target.removeListener(name, callback);
    },
  });
}
