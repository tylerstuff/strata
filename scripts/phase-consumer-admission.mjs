import assert from 'node:assert/strict';
import { PHASE_CONSUMER_CONTRACT } from './phase-consumer-observer.mjs';
import { PHASE_NETWORK_LIMITS } from './phase-network-observer.mjs';

export function phaseConsumerAssets(files, origin) {
  const base = new URL(origin);
  assert.equal(base.origin, origin); assert.equal(base.hostname, '127.0.0.1'); assert.equal(base.protocol, 'http:');
  return files.map(file => {
    assert(/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(file.name) && !file.name.split('/').includes('..'));
    return { url: new URL(`/external-assets/${file.name}`, base).href, bytes: file.bytes, sha256: file.sha256 };
  });
}

/** Independent metadata admission, after owned cleanup. Raw transport evidence is never rewritten. */
export function validatePhaseConsumerIntegrity({ cells, assets, origin, network, cleanup, browserRequestFailures }) {
  const pairs = [], errors = [], contract = PHASE_CONSUMER_CONTRACT;
  try {
    for (const name of ['browserExited', 'serverClosed', 'deviceDestroyed', 'artifactsDrained', 'frozenInputsVerified',
      'browserOwnershipVerified', 'browserLaunchSettled']) assert.equal(cleanup[name], true, `Unsettled cleanup: ${name}`);
    assert(!cleanup.forcedKill, 'Forced cleanup cannot qualify.');
    assert(Array.isArray(cells) && cells.length > 0 && new Set(cells.map(c => c.id)).size === cells.length, 'Invalid cells.');
    const declarations = phaseConsumerAssets(assets, origin), expected = new Map(declarations.map(a => [a.url, a]));
    assert(expected.size === assets.length && assets.length > 0 && assets.length <= contract.maxRequests, 'Duplicate/invalid asset declaration.');
    const totalBytes = declarations.reduce((n, a) => {
      assert(Number.isSafeInteger(a.bytes) && a.bytes > 0 && a.bytes <= contract.maxAssetBytes && /^[a-f0-9]{64}$/.test(a.sha256)); return n + a.bytes;
    }, 0);
    assert(totalBytes <= contract.maxCopiedBytes);
    assert.deepEqual(network.errors, []); assert.deepEqual(network.limits, PHASE_NETWORK_LIMITS); const counts = network.counts;
    assert(counts.browserRequests <= PHASE_NETWORK_LIMITS.maxBrowserRequests && counts.serverRequests <= PHASE_NETWORK_LIMITS.maxServerRequests);
    assert(counts.events <= PHASE_NETWORK_LIMITS.maxEvents && counts.eventBytes <= PHASE_NETWORK_LIMITS.maxEventBytesTotal);
    for (const name of ['serverErrors', 'serverAborted', 'incompleteServerCloses', 'droppedEvents', 'integrityFailures']) assert.equal(counts[name], 0, name);
    const browser = new Map(), server = new Map(); let previousTime = -1;
    const counted = { browserRequests: 0, browserResponses: 0, browserFinished: 0, browserFailed: 0, serverRequests: 0, serverFinished: 0, serverClosed: 0 };
    const counter = { 'browser:request': 'browserRequests', 'browser:response': 'browserResponses',
      'browser:requestfinished': 'browserFinished', 'browser:requestfailed': 'browserFailed', 'server:request': 'serverRequests',
      'server:finish': 'serverFinished', 'server:close': 'serverClosed' };
    for (const [index, event] of network.events.entries()) {
      assert.equal(event.eventId, index + 1); assert(Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 && event.elapsedMs >= previousTime); previousTime = event.elapsedMs;
      assert(Number.isSafeInteger(event.requestId) && event.requestId > 0); assert.equal(event.method, 'GET');
      assert.equal(typeof event.stage, 'string'); assert(event.cellId === null || cells.some(c => c.id === event.cellId));
      const key = counter[`${event.side}:${event.type}`]; assert(key, 'Unexpected network event.'); counted[key]++;
      const map = event.side === 'browser' ? browser : server;
      if (event.type === 'request') { assert(!map.has(event.requestId), 'Duplicate native request identity.'); map.set(event.requestId, []); }
      const group = map.get(event.requestId); assert(group, 'Unpaired native request event.');
      if (group.length) { assert.equal(event.url, group[0].url); assert.equal(event.method, group[0].method); }
      group.push(event);
    }
    assert.equal(counts.events, network.events.length); assert.equal(counts.eventBytes, Buffer.byteLength(JSON.stringify(network.events)));
    for (const [name, value] of Object.entries(counted)) assert.equal(counts[name], value, `Raw counter differs: ${name}`);
    assert.equal(counts.browserRequests, counts.browserResponses); assert.equal(counts.browserRequests, counts.browserFinished + counts.browserFailed);
    assert.equal(counts.serverRequests, counts.serverFinished); assert.equal(counts.serverRequests, counts.serverClosed);
    assert.equal(counts.browserRequests, counts.serverRequests);
    assert.equal(network.admissible, counts.browserFailed === 0, 'Raw transport status differs.');
    assert.deepEqual(browserRequestFailures, network.events.filter(e => e.side === 'browser' && e.type === 'requestfailed').map(e => `${e.url}: ${e.failureText}`));
    const keyOf = (cellId, url) => JSON.stringify([cellId, url]);
    const serverKeys = new Map(), browserKeys = new Map();
    for (const events of server.values()) {
      assert.deepEqual(events.map(e => e.type), ['request', 'finish', 'close'], 'Server did not finish and close normally.');
      const [request, finish, close] = events;
      for (const e of events) assert.equal(e.status, 200);
      assert.equal(request.writableFinished, false); assert.equal(request.finishObserved, false);
      for (const e of [finish, close]) { assert.equal(e.writableFinished, true); assert.equal(e.finishObserved, true); }
      const url = new URL(request.url, origin); assert.equal(url.origin, origin);
      const key = keyOf(request.cellId, url.href); assert(!serverKeys.has(key), 'Repeated server URL cannot be uniquely paired.'); serverKeys.set(key, events);
    }
    for (const events of browser.values()) {
      assert.equal(events.length, 3, 'Missing browser response/terminal.');
      const [request, response, terminal] = events;
      assert.equal(response.type, 'response'); assert.equal(response.status, 200);
      assert(['requestfinished', 'requestfailed'].includes(terminal.type));
      const key = keyOf(request.cellId, request.url); assert(!browserKeys.has(key), 'Repeated browser URL cannot be uniquely paired.'); browserKeys.set(key, events);
      assert(serverKeys.has(key), 'Browser request has no unique server request.');
      if (terminal.type === 'requestfailed') {
        assert.equal(terminal.failureText, 'net::ERR_ABORTED', 'Unapproved raw failure.'); assert.equal(terminal.responseObserved, true);
        assert(request.cellId !== null && expected.has(request.url), 'Failed request has no eligible consumer.');
      }
    }
    assert.equal(browserKeys.size, serverKeys.size);
    for (const cell of cells) {
      assert.equal(cell.result?.status, 'passed');
      const receipt = cell.consumer;
      assert.equal(receipt?.contractVersion, contract.version); assert.equal(receipt.cellId, cell.id); assert.deepEqual(receipt.errors, []);
      assert.equal(receipt.hooksRestored, true);
      for (const name of ['pendingFetches', 'pendingReads', 'pendingCancels', 'pendingDigests']) assert.equal(receipt[name], 0, `Unsettled consumer ${name}`);
      assert.equal(receipt.copiedBytes, totalBytes); assert.equal(receipt.records.length, assets.length);
      assert.equal(receipt.clock.kind, 'browser-performance'); assert(Number.isFinite(receipt.clock.timeOrigin) && receipt.clock.timeOrigin > 0);
      assert([receipt.finishStartedAt, receipt.hooksRestoredAt, receipt.finishedAt].every(t => Number.isFinite(t) && t >= 0));
      assert(receipt.finishStartedAt <= receipt.hooksRestoredAt && receipt.hooksRestoredAt <= receipt.finishedAt);
      const seen = new Set();
      for (const [index, record] of receipt.records.entries()) {
        assert.equal(record.id, index + 1); assert.equal(record.cellId, cell.id); assert.equal(record.method, 'GET');
        const asset = expected.get(record.url); assert(asset && !seen.has(record.url), 'Unpaired/repeated consumer URL.'); seen.add(record.url);
        assert.equal(record.responseUrl, record.url); assert.equal(record.status, 200); assert.equal(record.error, null);
        assert.equal(record.signalAborted, false); assert.equal(record.cancelCalled, false); assert.equal(record.readerReleased, true);
        assert.equal(record.readerCount, 1); assert.equal(record.eofCount, 1); assert(Number.isSafeInteger(record.readCalls) && record.readCalls >= 2);
        assert.equal(record.bytes, asset.bytes); assert.equal(record.sha256, asset.sha256);
        assert(Number.isFinite(record.eofAt) && record.eofAt >= 0 && record.eofAt <= receipt.finishStartedAt);
        assert(Number.isFinite(record.hashAt) && record.hashAt >= record.eofAt && record.hashAt <= receipt.finishedAt);
        const key = keyOf(cell.id, record.url), browserEvents = browserKeys.get(key), serverEvents = serverKeys.get(key);
        assert(browserEvents && serverEvents, 'Consumer lacks unique native browser/server identity.');
        const terminal = browserEvents[2];
        pairs.push({ cellId: cell.id, url: record.url, browserRequestId: browserEvents[0].requestId, serverRequestId: serverEvents[0].requestId,
          consumerId: record.id, bytes: record.bytes, sha256: record.sha256, transportTerminal: terminal.type,
          failureText: terminal.type === 'requestfailed' ? terminal.failureText : null });
      }
      assert.equal(seen.size, expected.size);
    }
    // Every failed request is now covered by exactly one verified consumer; no URL-only retry inference.
    assert.equal(pairs.filter(p => p.transportTerminal === 'requestfailed').length, counts.browserFailed);
  } catch (error) { errors.push(String(error.message ?? error)); }
  return { contractVersion: contract.version, admissible: errors.length === 0, errors, pairs };
}
