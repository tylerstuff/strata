import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installPhaseConsumerObserver } from './phase-consumer-observer.mjs';

const url = 'http://127.0.0.1:1234/external-assets/a.bin', bytes = new Uint8Array([1, 2, 3, 4]);
const asset = { url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const declared = { cellId: 'cell', assets: [asset] };
function fixture({ chunks = [{ done: false, value: bytes }, { done: true }], fetchFailure, readFailure } = {}) {
  const calls = { fetch: [], getReader: [], read: [], cancel: [], release: [] }, readPromises = [];
  const reader = { read(...args) { calls.read.push({ receiver: this, args });
    const promise = readFailure ? Promise.reject(readFailure) : Promise.resolve(chunks.shift()); readPromises.push(promise); return promise; },
    cancel(...args) { calls.cancel.push({ receiver: this, args }); return Promise.resolve(); },
    releaseLock(...args) { calls.release.push({ receiver: this, args }); return 47; } };
  const body = { getReader(...args) { calls.getReader.push({ receiver: this, args }); return reader; }, cancel: reader.cancel };
  const response = { url, status: 200, body };
  const fetchPromise = fetchFailure ? Promise.reject(fetchFailure) : Promise.resolve(response);
  const scope = { location: { href: 'http://127.0.0.1:1234/proof.html' }, fetch(...args) { calls.fetch.push({ receiver: this, args }); return fetchPromise; } };
  return { calls, reader, body, response, scope, fetchPromise, readPromises };
}
async function consume(scope, options) {
  const response = await scope.fetch(new URL(url), options), reader = response.body.getReader();
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; }
  reader.releaseLock(); return response;
}

test('forwards native receiver/arguments/objects/promises with no extra reads and restores all hooks', async () => {
  const f = fixture(), original = { fetch: f.scope.fetch, getReader: f.body.getReader, read: f.reader.read, cancel: f.reader.cancel, release: f.reader.releaseLock };
  const observer = installPhaseConsumerObserver(declared, f.scope), options = { method: 'GET' };
  const result = f.scope.fetch(url, options); assert.equal(result, f.fetchPromise); assert.equal(await result, f.response);
  assert.deepEqual(f.calls.fetch, [{ receiver: f.scope, args: [url, options] }]);
  assert.equal(f.response.body, f.body); const reader = f.body.getReader('native-argument'); assert.equal(reader, f.reader);
  assert.deepEqual(f.calls.getReader, [{ receiver: f.body, args: ['native-argument'] }]);
  const first = reader.read('forwarded'); assert.equal(first, f.readPromises[0]); assert.deepEqual(await first, { done: false, value: bytes });
  const last = reader.read(); assert.equal(last, f.readPromises[1]); assert.deepEqual(await last, { done: true });
  assert.equal(reader.releaseLock('release-argument'), 47);
  assert.deepEqual(f.calls.read.map(c => c.args), [['forwarded'], []]); assert(f.calls.read.every(c => c.receiver === reader));
  const finishing = observer.finish(); assert.equal(observer.finish(), finishing); const receipt = await finishing;
  assert.equal(f.calls.read.length, 2); assert.equal(f.calls.cancel.length, 0);
  assert.equal(f.scope.fetch, original.fetch); assert.equal(f.body.getReader, original.getReader); assert.equal(reader.read, original.read);
  assert.equal(reader.cancel, original.cancel); assert.equal(reader.releaseLock, original.release);
  assert.equal(receipt.hooksRestored, true); assert.deepEqual(receipt.errors, []);
  const record = receipt.records[0]; assert.equal(record.bytes, 4); assert.equal(record.sha256, asset.sha256); assert.equal(record.readerReleased, true);
  assert.equal(record.eofCount, 1); assert(record.hashAt >= record.eofAt && record.hashAt <= receipt.finishedAt);
  for (const name of ['pendingFetches', 'pendingReads', 'pendingCancels', 'pendingDigests']) assert.equal(receipt[name], 0);
});
test('real Response and ReadableStream native reads reach EOF unchanged', async () => {
  let pulls = 0; const response = new Response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(bytes); controller.close(); } }));
  Object.defineProperty(response, 'url', { value: url }); const scope = { fetch: () => Promise.resolve(response) };
  const observer = installPhaseConsumerObserver(declared, scope); assert.equal(await consume(scope), response);
  const receipt = await observer.finish(); assert.equal(pulls, 1); assert.equal(receipt.records[0].sha256, asset.sha256); assert.deepEqual(receipt.errors, []);
});
test('native fetch/read rejection reasons and promises are preserved', async () => {
  const error = Error('native failure');
  for (const kind of ['fetchFailure', 'readFailure']) {
    const f = fixture({ [kind]: error }), observer = installPhaseConsumerObserver(declared, f.scope);
    const fetched = f.scope.fetch(url); assert.equal(fetched, f.fetchPromise);
    if (kind === 'fetchFailure') await assert.rejects(fetched, e => e === error);
    else { const response = await fetched, reader = response.body.getReader(); const read = reader.read(); assert.equal(read, f.readPromises[0]); await assert.rejects(read, e => e === error); reader.releaseLock(); }
    const receipt = await observer.finish(); assert.equal(receipt.records[0].error, String(error));
  }
});
test('native synchronous errors and exotic init getters are neither replaced nor read twice', async () => {
  const error = Error('synchronous native'), scope = { fetch() { throw error; } }, observer = installPhaseConsumerObserver(declared, scope);
  assert.throws(() => scope.fetch(url), e => e === error); assert.match((await observer.finish()).errors[0], /Native fetch threw/);
  let reads = 0; const f = fixture(), native = f.scope.fetch;
  f.scope.fetch = function (url, init) { void init.method; return Reflect.apply(native, this, [url, init]); };
  const second = installPhaseConsumerObserver(declared, f.scope);
  const options = { get method() { reads++; return 'GET'; } }; assert.equal(f.scope.fetch(url, options), f.fetchPromise); await f.fetchPromise;
  assert.equal(reads, 1); assert.match((await second.finish()).errors[0], /accessors/);
});
test('partial and absent EOF remain explicit incomplete records; explicit cancellation is retained', async () => {
  const f = fixture(), observer = installPhaseConsumerObserver(declared, f.scope);
  const reader = (await f.scope.fetch(url)).body.getReader(); await reader.read(); const cancel = reader.cancel('consumer abort'); await cancel; reader.releaseLock();
  const record = (await observer.finish()).records[0]; assert.equal(record.eofCount, 0); assert.equal(record.sha256, null); assert.equal(record.cancelCalled, true);
  assert.equal(f.calls.read.length, 1); assert.deepEqual(f.calls.cancel[0].args, ['consumer abort']);
});
test('abort transitions and repeated requests cannot disappear from the receipt', async () => {
  const f = fixture(), observer = installPhaseConsumerObserver(declared, f.scope), controller = new AbortController();
  await consume(f.scope, { signal: controller.signal }); controller.abort(); await f.scope.fetch(url);
  const receipt = await observer.finish(); assert.equal(receipt.records[0].signalAborted, true);
  assert.equal(receipt.records.length, 2); assert.match(receipt.errors[0], /Repeated eligible URL/);
});
test('overlong chunks are never copied beyond the fixed declaration', async () => {
  const f = fixture({ chunks: [{ done: false, value: new Uint8Array(5) }, { done: true }] }), observer = installPhaseConsumerObserver(declared, f.scope);
  await consume(f.scope); const receipt = await observer.finish(); assert.equal(receipt.copiedBytes, 4); assert.match(receipt.records[0].error, /exceed/);
});
test('pending fetch/read work fails closure and late settlement cannot install new hooks', async () => {
  let resolveFetch; const scope = { fetch: () => new Promise(resolve => { resolveFetch = resolve; }) }, native = scope.fetch;
  const observer = installPhaseConsumerObserver(declared, scope); const pending = scope.fetch(url); const receipt = await observer.finish();
  assert.equal(receipt.pendingFetches, 1); assert.match(receipt.errors[0], /pending/); assert.equal(scope.fetch, native);
  const f = fixture(); resolveFetch(f.response); await pending; assert.equal(Object.hasOwn(f.body, 'getReader'), true); assert.equal(f.calls.getReader.length, 0);
  const readFixture = fixture(); let resolveRead; readFixture.reader.read = () => new Promise(resolve => { resolveRead = resolve; });
  const second = installPhaseConsumerObserver(declared, readFixture.scope); const reader = (await readFixture.scope.fetch(url)).body.getReader(); const read = reader.read();
  const pendingReceipt = await second.finish(); assert.equal(pendingReceipt.pendingReads, 1); assert.match(pendingReceipt.errors[0], /pending/);
  resolveRead({ done: true }); await read;
});
test('a restoration fault still restores other hooks and cannot report settled success', async () => {
  const f = fixture(), native = f.scope.fetch, observer = installPhaseConsumerObserver(declared, f.scope); await consume(f.scope);
  f.reader.read = () => Promise.resolve({ done: true }); const receipt = await observer.finish();
  assert.equal(receipt.hooksRestored, false); assert.match(receipt.errors[0], /hook changed/); assert.equal(f.scope.fetch, native);
});
test('unobserved body consumption never fabricates EOF or hashes', async () => {
  const f = fixture(), observer = installPhaseConsumerObserver(declared, f.scope); await f.scope.fetch(url);
  const receipt = await observer.finish(); assert.equal(receipt.records[0].readerCount, 0); assert.equal(receipt.records[0].sha256, null);
});
test('finish restores hooks immediately but waits for actual digest settlement and retains rejection', async () => {
  for (const reject of [false, true]) {
    const f = fixture(); let settle;
    f.scope.crypto = { subtle: { digest: () => new Promise((resolve, failure) => { settle = () => reject ? failure(Error('digest failed')) : resolve(Uint8Array.from(Buffer.from(asset.sha256, 'hex')).buffer); }) } };
    const native = f.scope.fetch, observer = installPhaseConsumerObserver(declared, f.scope); await consume(f.scope);
    let finished = false; const finish = observer.finish().then(receipt => { finished = true; return receipt; });
    await Promise.resolve(); assert.equal(finished, false); assert.equal(f.scope.fetch, native);
    settle(); const receipt = await finish; assert.equal(receipt.pendingDigests, 0);
    if (reject) assert.equal(receipt.records[0].error, 'Error: digest failed');
    else assert.equal(receipt.records[0].sha256, asset.sha256);
  }
});

test('an explicit abort during digest settlement remains visible before the receipt returns', async () => {
  const f = fixture(), controller = new AbortController(); let settle;
  f.scope.crypto = { subtle: { digest: () => new Promise(resolve => { settle = () => resolve(new Uint8Array(32).buffer); }) } };
  const observer = installPhaseConsumerObserver(declared, f.scope); await consume(f.scope, { signal: controller.signal });
  const finishing = observer.finish(); controller.abort(); settle();
  assert.equal((await finishing).records[0].signalAborted, true);
});
