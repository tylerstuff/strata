import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createPhaseNetworkObserver } from './phase-network-observer.mjs';
import { installPhaseConsumerObserver } from './phase-consumer-observer.mjs';
import { phaseConsumerAssets, validatePhaseConsumerIntegrity } from './phase-consumer-admission.mjs';

const origin = 'http://127.0.0.1:1234', payload = new Uint8Array([7, 8, 9]);
const assets = [{ name: 'a.bin', bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }];
async function fixture(failed = true) {
  const declarations = phaseConsumerAssets(assets, origin), url = declarations[0].url;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(payload); controller.close(); } }));
  Object.defineProperty(response, 'url', { value: url }); const scope = { fetch: () => Promise.resolve(response) };
  const observer = installPhaseConsumerObserver({ cellId: 'cell', assets: declarations }, scope);
  const actual = await scope.fetch(url), reader = actual.body.getReader(); for (;;) { if ((await reader.read()).done) break; } reader.releaseLock();
  const consumer = await observer.finish(); let time = 0;
  const networkObserver = createPhaseNetworkObserver({ now: () => ++time, stage: () => ({ stage: 'cell-start', cellId: 'cell' }), error: e => { throw Error(e); } });
  function nativePair(path, failure) {
    const request = { url: () => origin + path, method: () => 'GET', resourceType: () => 'fetch', failure: () => ({ errorText: failure }) };
    const serverRequest = Object.assign(new EventEmitter(), { url: path, method: 'GET' });
    const serverResponse = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
    networkObserver.browser.request(request); networkObserver.server(serverRequest, serverResponse);
    networkObserver.browser.response({ request: () => request, status: () => 200, headers: () => ({}) });
    serverResponse.writableFinished = true; serverResponse.emit('finish'); serverResponse.emit('close');
    if (failure) networkObserver.browser.requestfailed(request); else networkObserver.browser.requestfinished(request);
  }
  nativePair('/external-assets/a.bin', failed ? 'net::ERR_ABORTED' : null); nativePair('/proof/full.mjs', null);
  const network = networkObserver.snapshot(); networkObserver.dispose();
  return { cells: [{ id: 'cell', result: { status: 'passed' }, consumer }], assets, origin, network,
    browserRequestFailures: failed ? [`${url}: net::ERR_ABORTED`] : [],
    cleanup: Object.fromEntries(['browserExited', 'serverClosed', 'deviceDestroyed', 'artifactsDrained', 'frozenInputsVerified', 'browserOwnershipVerified', 'browserLaunchSettled'].map(k => [k, true])) };
}
function resealNetwork(input) {
  input.network.events.forEach((event, i) => { event.eventId = i + 1; event.elapsedMs = i; });
  input.network.counts.events = input.network.events.length;
  input.network.counts.eventBytes = Buffer.byteLength(JSON.stringify(input.network.events));
}

test('exact consumed body and unique normal server completion qualify separately from failed raw transport', async () => {
  for (const failed of [false, true]) {
    const input = await fixture(failed), before = structuredClone(input), result = validatePhaseConsumerIntegrity(input);
    assert.deepEqual(result.errors, []); assert.equal(result.admissible, true); assert.deepEqual(input, before);
    assert.equal(input.network.admissible, !failed); assert.equal(input.network.counts.browserFailed, Number(failed));
    assert.deepEqual(result.pairs, [{ cellId: 'cell', url: origin + '/external-assets/a.bin', browserRequestId: 1, serverRequestId: 1,
      consumerId: 1, bytes: payload.length, sha256: assets[0].sha256, transportTerminal: failed ? 'requestfailed' : 'requestfinished', failureText: failed ? 'net::ERR_ABORTED' : null }]);
  }
});
test('missing, partial, hash-mismatched, canceled, aborted or unread bodies cannot qualify', async () => {
  for (const mutate of [x => { delete x.cells[0].consumer; }, x => { x.cells[0].consumer.records = []; },
    x => { x.cells[0].consumer.records[0].eofCount = 0; }, x => { x.cells[0].consumer.records[0].bytes--; },
    x => { x.cells[0].consumer.records[0].sha256 = '0'.repeat(64); }, x => { x.cells[0].consumer.records[0].cancelCalled = true; },
    x => { x.cells[0].consumer.records[0].signalAborted = true; }, x => { x.cells[0].consumer.records[0].error = 'read failed'; },
    x => { x.cells[0].consumer.records[0].readerCount = 0; }, x => { x.cells[0].consumer.records[0].readerReleased = false; },
    x => { x.cells[0].consumer.records[0].responseUrl += '?redirect'; }]) {
    const input = await fixture(); mutate(input); assert.equal(validatePhaseConsumerIntegrity(input).admissible, false);
  }
});
test('unsettled hooks, native work, digest, owned cleanup or invalid timestamp cannot qualify', async () => {
  for (const mutate of [x => { x.cells[0].consumer.hooksRestored = false; }, x => { x.cells[0].consumer.pendingFetches = 1; },
    x => { x.cells[0].consumer.pendingReads = 1; }, x => { x.cells[0].consumer.pendingCancels = 1; }, x => { x.cells[0].consumer.pendingDigests = 1; },
    x => { x.cleanup.browserLaunchSettled = false; }, x => { x.cleanup.frozenInputsVerified = false; }, x => { x.cleanup.forcedKill = true; },
    x => { x.cells[0].consumer.records[0].hashAt = x.cells[0].consumer.finishedAt + 1; },
    x => { x.cells[0].consumer.records[0].eofAt = x.cells[0].consumer.finishStartedAt + 1; }]) {
    const input = await fixture(); mutate(input); assert.equal(validatePhaseConsumerIntegrity(input).admissible, false);
  }
});
test('duplicate URL with distinct native identities is rejected instead of inferred as a retry', async () => {
  const input = await fixture();
  for (const event of input.network.events) if (event.requestId === 2) event.url = event.side === 'browser' ? origin + '/external-assets/a.bin' : '/external-assets/a.bin';
  resealNetwork(input); const result = validatePhaseConsumerIntegrity(input); assert.equal(result.admissible, false); assert.match(result.errors[0], /Repeated server URL/);
});
test('unpaired native events and changed cell attribution cannot qualify', async () => {
  for (const mutate of [x => { x.network.events.find(e => e.side === 'server' && e.type === 'request').url = '/external-assets/other.bin'; },
    x => { x.network.events.find(e => e.side === 'browser' && e.type === 'request').cellId = null; },
    x => { x.network.events.find(e => e.type === 'requestfailed').requestId = 99; },
    x => { x.cells[0].consumer.records[0].id = 2; }, x => { x.cells[0].consumer.records[0].url += '?retry'; }]) {
    const input = await fixture(); mutate(input); resealNetwork(input); assert.equal(validatePhaseConsumerIntegrity(input).admissible, false);
  }
});
test('truncation, non-asset cancellation, server abort/partial close and suppressed raw failures remain fatal', async () => {
  for (const mutate of [x => { const e = x.network.events.find(e => e.type === 'requestfailed'); e.failureText = 'net::ERR_CONTENT_LENGTH_MISMATCH'; x.browserRequestFailures = [`${e.url}: ${e.failureText}`]; },
    x => { const e = x.network.events.find(e => e.type === 'requestfailed'); e.responseObserved = false; },
    x => { x.network.events.find(e => e.side === 'server' && e.type === 'close').writableFinished = false; },
    x => { x.network.counts.serverAborted = 1; }, x => { x.browserRequestFailures = []; }, x => { x.network.admissible = true; },
    x => { x.network.events.find(e => e.type === 'requestfailed').url = origin + '/proof/full.mjs'; }]) {
    const input = await fixture(); mutate(input); resealNetwork(input); assert.equal(validatePhaseConsumerIntegrity(input).admissible, false);
  }
});
test('stale cell result and network count/ordering/cap corruption remain fatal', async () => {
  for (const mutate of [x => { x.cells[0].result.status = 'failed'; }, x => { x.network.counts.browserFailed = 0; },
    x => { x.network.events[1].elapsedMs = -1; }, x => { x.network.counts.droppedEvents = 1; },
    x => { x.network.limits.maxBrowserRequests++; }, x => { x.network.counts.eventBytes++; }]) {
    const input = await fixture(); mutate(input); assert.equal(validatePhaseConsumerIntegrity(input).admissible, false);
  }
});
