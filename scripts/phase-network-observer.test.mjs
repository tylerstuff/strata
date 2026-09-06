import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createPhaseNetworkObserver, PHASE_NETWORK_LIMITS } from './phase-network-observer.mjs';

function fixture() {
  const errors = [], state = { elapsed: 0, stage: { stage: 'creation', cellId: '1-incremental-5399' } };
  const observer = createPhaseNetworkObserver({ now: () => state.elapsed, stage: () => state.stage, error: value => errors.push(value) });
  return { errors, state, observer };
}
const request = (url = 'http://127.0.0.1/external-assets/pages/000003.bin') => ({ url: () => url, method: () => 'GET', resourceType: () => 'fetch', failure: () => ({ errorText: 'net::ERR_ABORTED' }) });
const response = req => ({ request: () => req, status: () => 200, headers: () => ({ 'content-length': '65536' }), body: () => assert.fail('Body consumption forbidden') });
function http() {
  const req = Object.assign(new EventEmitter(), { url: '/external-assets/pages/000003.bin', method: 'GET' });
  const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
  return { req, res };
}
test('native browser identity separates equal URLs and freezes event-time stage/clock metadata', () => {
  const f = fixture(), a = request(), b = request(), native = { ...a }, resp = response(a);
  f.observer.browser.request(a); f.state.elapsed = 1; f.observer.browser.request(b);
  f.observer.browser.response(resp); f.observer.browser.requestfinished(a);
  f.state.stage.stage = 'browser-close'; f.state.elapsed = 2; f.observer.browser.requestfailed(b);
  const snapshot = f.observer.snapshot();
  assert.deepEqual(snapshot.events.map(e => e.eventId), [1, 2, 3, 4, 5]);
  assert.deepEqual(snapshot.events.map(e => e.requestId), [1, 2, 1, 1, 2]);
  assert.equal(snapshot.events[0].stage, 'creation'); assert.equal(snapshot.events[4].stage, 'browser-close');
  assert.equal(snapshot.events[4].elapsedMs, 2); assert.equal(snapshot.events[4].failureText, 'net::ERR_ABORTED');
  assert.equal(snapshot.events[4].responseObserved, false); assert.equal(snapshot.admissible, false);
  assert.deepEqual(f.errors, []); assert.deepEqual(a, native, 'Observer must not replace native methods');
  snapshot.events[0].url = 'edited'; snapshot.counts.events = 0; snapshot.errors.push('edited');
  assert.notEqual(f.observer.snapshot().events[0].url, 'edited'); assert.equal(f.observer.snapshot().counts.events, 5);
});
test('unknown, duplicate and out-of-order browser callbacks fail rather than fabricate request identity', () => {
  for (const act of [
    (o, r) => o.browser.response(response(r)), (o, r) => o.browser.requestfinished(r), (o, r) => o.browser.requestfailed(r),
    (o, r) => { o.browser.request(r); o.browser.request(r); },
    (o, r) => { o.browser.request(r); o.browser.requestfinished(r); },
    (o, r) => { o.browser.request(r); o.browser.response(response(r)); o.browser.requestfailed(r); o.browser.requestfinished(r); },
    (o, r) => { o.browser.request(r); o.browser.response(response(r)); o.browser.response(response(r)); },
  ]) { const f = fixture(); act(f.observer, request()); assert.equal(f.errors.length, 1); assert.equal(f.observer.snapshot().admissible, false); }
});
test('HTTP finish and close retain actual flags, stage and status without replacing native calls', () => {
  const f = fixture(), { req, res } = http(), originalEmit = res.emit;
  assert.equal(f.observer.server(req, res), undefined); assert.equal(res.emit, originalEmit);
  f.state.elapsed = 1; res.writableFinished = true; res.emit('finish');
  assert.equal(f.observer.snapshot().admissible, false, 'Response close is still unobserved.');
  f.state.elapsed = 2; f.state.stage = { stage: 'server-close', cellId: null }; res.emit('close');
  const s = f.observer.snapshot(); assert.equal(s.admissible, true);
  assert.deepEqual(s.events.map(e => [e.type, e.writableFinished, e.finishObserved]), [['request', false, false], ['finish', true, true], ['close', true, true]]);
  assert.equal(s.events[2].stage, 'server-close'); assert.equal(s.events[2].status, 200);
  f.observer.dispose(); f.observer.dispose();
  assert.equal(res.listenerCount('finish') + res.listenerCount('close') + res.listenerCount('error'), 0);
  assert.equal(req.listenerCount('error') + req.listenerCount('aborted'), 0);
});
test('premature server closure and errors remain failures with original diagnostic values', () => {
  const f = fixture(), { req, res } = http(); f.observer.server(req, res);
  f.state.stage = { stage: 'failure-cleanup', cellId: null }; res.statusCode = 500;
  req.emit('aborted'); req.emit('error', Error('request broken')); res.emit('error', Error('response broken')); res.emit('close');
  const s = f.observer.snapshot(); assert.equal(s.admissible, false);
  assert.equal(s.counts.serverErrors, 2); assert.equal(s.counts.serverAborted, 1); assert.equal(s.counts.incompleteServerCloses, 1);
  assert.equal(s.events.at(-1).writableFinished, false); assert.equal(s.events.at(-1).finishObserved, false);
  assert.match(s.events[2].message, /request broken/); assert.equal(s.events.at(-1).status, 500);
});
test('request caps apply separately to browser and server and cannot silently pass', () => {
  const f = fixture();
  for (let i = 0; i < PHASE_NETWORK_LIMITS.maxBrowserRequests; i++) { const r = request(); f.observer.browser.request(r); f.observer.browser.response(response(r)); f.observer.browser.requestfinished(r); }
  for (let i = 0; i < PHASE_NETWORK_LIMITS.maxServerRequests; i++) { const { req, res } = http(); f.observer.server(req, res); res.writableFinished = true; res.emit('finish'); res.emit('close'); }
  assert.equal(f.observer.snapshot().admissible, true);
  f.observer.browser.request(request()); const { req, res } = http(); f.observer.server(req, res);
  assert.equal(f.observer.snapshot().admissible, false); assert.equal(f.errors.length, 1);
  assert.equal(f.observer.snapshot().counts.integrityFailures, 2); f.observer.dispose();
});
test('event count and total UTF-8 byte limits latch incomplete evidence with bounded retained records', () => {
  for (const message of ['error', 'x'.repeat(3800)]) {
    const f = fixture(), { req, res } = http(); f.observer.server(req, res);
    for (let i = 0; i <= PHASE_NETWORK_LIMITS.maxEvents; i++) res.emit('error', Error(message));
    const s = f.observer.snapshot(); assert.equal(s.admissible, false); assert.equal(f.errors.length, 1);
    assert(s.counts.droppedEvents > 0); assert(s.events.length <= PHASE_NETWORK_LIMITS.maxEvents);
    assert(s.counts.eventBytes <= PHASE_NETWORK_LIMITS.maxEventBytesTotal);
    assert.equal(s.counts.eventBytes, Buffer.byteLength(JSON.stringify(s.events)));
    assert.deepEqual(s.events.map(e => e.eventId), Array.from({ length: s.events.length }, (_, i) => i + 1));
    f.observer.dispose();
  }
});
test('bad clocks/stages, throwing metadata and recursive error sinks cannot produce admitted evidence', () => {
  for (const alter of [f => { f.state.elapsed = NaN; }, f => { f.state.elapsed = -1; }, f => { f.state.stage = {}; },
    f => { f.state.stage.stage = 'x'.repeat(PHASE_NETWORK_LIMITS.maxTextBytes + 1); },
    f => { f.state.elapsed = 1; f.observer.browser.request(request()); f.state.elapsed = 0; }]) {
    const f = fixture(); alter(f); f.observer.browser.request(request()); assert.equal(f.errors.length, 1); assert.equal(f.observer.snapshot().admissible, false);
  }
  const f = fixture(); f.observer.browser.request({ url() { throw Error('native metadata failed'); } }); assert.match(f.errors[0], /native metadata failed/);
  let observer, calls = 0;
  observer = createPhaseNetworkObserver({ now: () => 0, stage: () => ({ stage: 'test', cellId: null }), error() { calls++; observer.browser.requestfinished(request()); throw Error('sink'); } });
  observer.browser.requestfinished(request()); const s = observer.snapshot();
  assert.equal(calls, 1); assert.equal(s.errors.length, 2); assert.equal(s.admissible, false);
});
test('pending requests and callbacks after disposal cannot be admitted', () => {
  const f = fixture(), r = request(); f.observer.browser.request(r); assert.equal(f.observer.snapshot().admissible, false);
  f.observer.dispose(); f.observer.browser.response(response(r)); assert.equal(f.errors.length, 1);
  assert.equal(f.observer.snapshot().admissible, false);
});
