/** Test-only actual-consumer receipts. No additional reads, retries, clones or replacement responses. */
export const PHASE_CONSUMER_CONTRACT = Object.freeze({ version: 1, name: 'frozen-asset-consumer-integrity',
  maxRequests: 83, maxAssetBytes: 8 * 1024 ** 2, maxCopiedBytes: 16 * 1024 ** 2,
  transportStatus: 'Raw requestfailed events remain failed; consumer acceptance is a separate result.' });

export function installPhaseConsumerObserver({ cellId, assets }, scope = globalThis) {
  const limits = PHASE_CONSUMER_CONTRACT, errors = [], records = [], undo = [], abortCleanup = [], digests = new Set(), seen = new Set();
  let copiedBytes = 0, pendingFetches = 0, pendingReads = 0, pendingCancels = 0, closed = false, restored = false, finishPromise;
  const fail = message => { if (errors.length < 8) errors.push(String(message).slice(0, 1024)); };
  if (typeof cellId !== 'string' || !cellId || !Array.isArray(assets) || !assets.length || assets.length > limits.maxRequests) throw Error('Invalid consumer declaration.');
  const declarations = new Map(); let declaredBytes = 0;
  for (const asset of assets) {
    if (typeof asset.url !== 'string' || declarations.has(asset.url) || new URL(asset.url).href !== asset.url
      || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > limits.maxAssetBytes
      || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw Error('Invalid frozen consumer asset.');
    declarations.set(asset.url, asset); declaredBytes += asset.bytes;
  }
  if (declaredBytes > limits.maxCopiedBytes) throw Error('Consumer copy budget exceeded.');
  const now = () => performance.now();
  const nativeFetch = scope.fetch;
  if (typeof nativeFetch !== 'function') throw Error('Native fetch required.');
  function replace(target, name, wrapper) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { value: wrapper, configurable: true, writable: true });
    undo.push(() => {
      if (target[name] !== wrapper) throw Error(`Consumer hook changed: ${name}`);
      if (descriptor) Object.defineProperty(target, name, descriptor); else delete target[name];
    });
  }
  const observePromise = (promise, fulfilled, rejected) => {
    // Observe without replacing the native promise returned to the consumer.
    promise.then(value => { try { fulfilled(value); } catch (cause) { fail(cause); } }, cause => {
      try { rejected(cause); } catch (error) { fail(error); }
    }).catch(fail);
  };
  function observedFetch(...args) {
    // Invoke native fetch exactly once, before observational parsing. Exotic
    // arguments/getters are not evaluated again by this bounded observer.
    let promise;
    try { promise = Reflect.apply(nativeFetch, this, args); }
    catch (cause) { fail(`Native fetch threw: ${cause}`); throw cause; }
    const input = args[0], init = args[1];
    let url, method, signal;
    try {
      if (typeof input === 'string') url = new URL(input, scope.location?.href).href;
      else if (input instanceof URL || input instanceof Request) url = input instanceof URL ? input.href : input.url;
      else return promise;
      if (!declarations.has(url)) return promise;
      if (init != null && Object.getPrototypeOf(init) !== Object.prototype) throw Error('Unsupported fetch init observation.');
      const properties = init == null ? {} : Object.getOwnPropertyDescriptors(init);
      for (const name of ['method', 'signal']) if (properties[name] && !('value' in properties[name])) throw Error('Fetch init accessors cannot be observed transparently.');
      method = properties.method?.value ?? (input instanceof Request ? input.method : 'GET');
      signal = properties.signal?.value ?? (input instanceof Request ? input.signal : undefined);
    } catch (cause) { fail(cause); return promise; }
    const declaration = declarations.get(url);
    if (closed || records.length >= limits.maxRequests) { fail('Fetch outside consumer admission.'); return promise; }
    const record = { id: records.length + 1, cellId, url, method,
      responseUrl: null, status: null, bytes: 0, readCalls: 0, readerCount: 0, eofCount: 0, sha256: null,
      signalAborted: false, cancelCalled: false, readerReleased: false, error: null, eofAt: null, hashAt: null };
    records.push(record);
    const duplicate = seen.has(url); seen.add(url);
    if (duplicate) fail('Repeated eligible URL cannot be uniquely paired.');
    const abort = () => { record.signalAborted = true; };
    try { if (signal) { if (signal.aborted) abort(); signal.addEventListener('abort', abort); abortCleanup.push(() => signal.removeEventListener('abort', abort)); } }
    catch (cause) { fail(cause); }
    const call = (native, receiver, values) => {
      try { return Reflect.apply(native, receiver, values); }
      catch (cause) { record.error = String(cause); throw cause; }
    };
    const cancel = (native, receiver, values) => {
      record.cancelCalled = true; const result = call(native, receiver, values); pendingCancels++;
      observePromise(result, () => { pendingCancels--; }, cause => { pendingCancels--; record.error = String(cause); }); return result;
    };
    pendingFetches++;
    observePromise(promise, response => {
      pendingFetches--; record.responseUrl = response.url; record.status = response.status;
      if (closed) { fail('Fetch settled after consumer admission closed.'); return; }
      if (duplicate || !response.body) { record.error = 'Duplicate request or missing response body.'; return; }
      copiedBytes += declaration.bytes;
      if (copiedBytes > limits.maxCopiedBytes) { fail('Consumer copy budget exceeded.'); return; }
      let bytes = new Uint8Array(declaration.bytes);
      const body = response.body, nativeGetReader = body.getReader, nativeCancel = body.cancel;
      replace(body, 'cancel', function (...values) { return cancel(nativeCancel, this, values); });
      replace(body, 'getReader', function (...values) {
        const reader = call(nativeGetReader, this, values); record.readerCount++;
        if (this !== body) record.error = 'Borrowed body observer cannot establish identity.';
        const nativeRead = reader.read, nativeReaderCancel = reader.cancel, nativeRelease = reader.releaseLock;
        try {
          replace(reader, 'read', function (...readArgs) {
            let result;
            try { result = Reflect.apply(nativeRead, this, readArgs); }
            catch (cause) { record.error = String(cause); throw cause; }
            if (this !== reader) record.error = 'Borrowed reader observer cannot establish identity.';
            record.readCalls++; pendingReads++;
            observePromise(result, chunk => {
              pendingReads--;
              if (closed) { fail('Read settled after consumer admission closed.'); return; }
              if (chunk.done) {
                record.eofCount++; record.eofAt = now();
                if (record.eofCount !== 1 || !bytes) { record.error = 'Repeated EOF.'; return; }
                const inputBytes = bytes.subarray(0, record.bytes); bytes = null;
                const digest = (scope.crypto ?? globalThis.crypto).subtle.digest('SHA-256', inputBytes).then(value => {
                  record.sha256 = [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join(''); record.hashAt = now();
                }, cause => { record.error = String(cause); }).finally(() => digests.delete(digest));
                digests.add(digest);
              } else {
                if (!(chunk.value instanceof Uint8Array) || !bytes || record.bytes + chunk.value.byteLength > bytes.length) {
                  record.error = 'Consumer bytes exceed the frozen asset or follow EOF.'; return;
                }
                bytes.set(chunk.value, record.bytes); record.bytes += chunk.value.byteLength;
              }
            }, cause => { pendingReads--; record.error = String(cause); });
            return result;
          });
          replace(reader, 'cancel', function (...cancelArgs) { return cancel(nativeReaderCancel, this, cancelArgs); });
          replace(reader, 'releaseLock', function (...releaseArgs) {
            const result = call(nativeRelease, this, releaseArgs); record.readerReleased = true; return result;
          });
        } catch (cause) { fail(cause); }
        return reader;
      });
    }, cause => { pendingFetches--; record.error = String(cause); });
    return promise;
  }
  replace(scope, 'fetch', observedFetch);
  return Object.freeze({
    finish() {
      if (finishPromise) return finishPromise;
      closed = true; const finishStartedAt = now(); restored = true;
      for (const restore of undo.reverse()) try { restore(); } catch (cause) { restored = false; fail(cause); }
      restored &&= scope.fetch === nativeFetch;
      if (pendingFetches || pendingReads || pendingCancels) fail('Consumer work remains pending.');
      finishPromise = Promise.allSettled([...digests]).then(() => {
        // Keep abort observation through digest settlement, then retire every hook.
        for (const restore of abortCleanup) try { restore(); } catch (cause) { restored = false; fail(cause); }
        const hooksRestoredAt = now();
        return { contractVersion: limits.version, cellId,
          clock: { kind: 'browser-performance', timeOrigin: performance.timeOrigin },
          records: records.map(record => ({ ...record })), errors: [...errors], hooksRestored: restored,
          pendingFetches, pendingReads, pendingCancels, pendingDigests: digests.size, copiedBytes,
          finishStartedAt, hooksRestoredAt, finishedAt: now() };
      });
      return finishPromise;
    },
  });
}
