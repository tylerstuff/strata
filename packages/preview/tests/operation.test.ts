import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewError } from '../src/errors.js';
import { MAX_OPERATION_TIMEOUT_MS, OperationGate } from '../src/operation.js';
import type { OperationContext, OperationKind, OperationOptions } from '../src/operation.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

function observe<T>(promise: Promise<T>) {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('preview operation ownership', () => {
  it('returns driver outcomes, uses distinct operation IDs, and releases settled ownership', async () => {
    const gate = new OperationGate();
    const ids: string[] = [];
    let context!: OperationContext;
    expect(await gate.run('load', {}, async current => {
      context = current;
      ids.push(current.id);
      current.throwIfAborted();
      expect(gate.activeKind).toBe('load');
      return 'loaded';
    })).toBe('loaded');
    const failure = new PreviewError('DRIVER_FAILURE', 'resize', 'Fake driver failure.');
    await expect(gate.run('resize', {}, async current => { ids.push(current.id); throw failure; })).rejects.toBe(failure);
    expect(ids[0]).not.toBe(ids[1]);
    expect(gate.busy).toBe(false);
    expect(gate.state).toBe('open');
    expect(gate.fault).toBeNull();
    expect(() => context.throwIfAborted()).toThrow(expect.objectContaining({ code: 'PREVIEW_DISPOSED' }));
    await expect(context.commit(async () => 'late')).rejects.toMatchObject({ code: 'PREVIEW_DISPOSED' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 1.5, NaN, Infinity, MAX_OPERATION_TIMEOUT_MS + 1, null])('rejects invalid deadline %s without superseding accepted work', async timeoutMs => {
    const gate = new OperationGate();
    const driver = deferred<void>();
    let context!: OperationContext;
    const accepted = gate.run('load', {}, async current => { context = current; await driver.promise; });
    await expect(gate.run('load', { timeoutMs } as OperationOptions, async () => {})).rejects.toMatchObject({ code: 'PREVIEW_INVALID_OPTIONS', stage: 'load' });
    expect(context.signal.aborted).toBe(false);
    driver.resolve();
    await accepted;
  });

  it('rejects invalid gate settings and unsupported operation options', async () => {
    expect(() => new OperationGate({ cleanupTimeoutMs: 0 })).toThrow(expect.objectContaining({ code: 'PREVIEW_INVALID_OPTIONS' }));
    expect(() => new OperationGate({ defaultTimeoutMs: Infinity })).toThrow(expect.objectContaining({ code: 'PREVIEW_INVALID_OPTIONS' }));
    expect(() => new OperationGate(null as never)).toThrow(expect.objectContaining({ code: 'PREVIEW_INVALID_OPTIONS' }));
    const gate = new OperationGate();
    await expect(gate.run('unknown' as OperationKind, {}, async () => {})).rejects.toMatchObject({ code: 'PREVIEW_INVALID_OPTIONS' });
    await expect(gate.run('load', { timeout: 10 } as OperationOptions, async () => {})).rejects.toMatchObject({ code: 'PREVIEW_INVALID_OPTIONS' });
    await expect(gate.run('load', { signal: {} } as OperationOptions, async () => {})).rejects.toMatchObject({ code: 'PREVIEW_INVALID_OPTIONS' });
    expect(gate.busy).toBe(false);
  });

  it('ignores preaborted requests without superseding another load', async () => {
    const gate = new OperationGate();
    const driver = deferred<void>();
    let context!: OperationContext;
    const accepted = gate.run('load', {}, async current => { context = current; await driver.promise; });
    const nextDriver = vi.fn(async () => {});
    await expect(gate.run('load', { signal: AbortSignal.abort() }, nextDriver)).rejects.toMatchObject({ code: 'PREVIEW_ABORTED' });
    expect(context.signal.aborted).toBe(false);
    expect(nextDriver).not.toHaveBeenCalled();
    driver.resolve();
    await accepted;
  });

  it('supersedes loads promptly but starts only the latest queued driver after old work settles', async () => {
    const gate = new OperationGate();
    const oldDriver = deferred<string>();
    const newDriver = deferred<string>();
    const calls: string[] = [];
    let context!: OperationContext;
    const oldResult = observe(gate.run('load', {}, async current => {
      context = current;
      calls.push('old');
      return oldDriver.promise;
    }));
    const skippedResult = observe(gate.run('load', {}, async () => { calls.push('skipped'); return 'skipped'; }));
    const newestResult = gate.run('load', {}, async () => { calls.push('new'); return newDriver.promise; });
    expect(await oldResult).toMatchObject({ ok: false, error: { code: 'PREVIEW_SUPERSEDED' } });
    expect(await skippedResult).toMatchObject({ ok: false, error: { code: 'PREVIEW_SUPERSEDED' } });
    expect(context.signal.aborted).toBe(true);
    expect(calls).toEqual(['old']);
    oldDriver.resolve('late old result');
    await flush();
    expect(calls).toEqual(['old', 'new']);
    expect(gate.busy).toBe(true);
    newDriver.resolve('new result');
    expect(await newestResult).toBe('new result');
    expect(gate.busy).toBe(false);
  });

  it.each([
    ['load', 'capture'], ['load', 'resize'],
    ['capture', 'load'], ['capture', 'capture'], ['capture', 'resize'],
    ['resize', 'load'], ['resize', 'capture'], ['resize', 'resize'],
  ] as const)('rejects %s -> %s concurrency without canceling the owner', async (active, next) => {
    const gate = new OperationGate();
    const driver = deferred<void>();
    let context!: OperationContext;
    const first = gate.run(active, {}, async current => { context = current; await driver.promise; });
    const busyDriver = vi.fn(async () => {});
    await expect(gate.run(next, {}, busyDriver)).rejects.toMatchObject({ code: 'PREVIEW_BUSY', details: { activeKind: active, activeOperationId: context.id } });
    expect(context.signal.aborted).toBe(false);
    expect(busyDriver).not.toHaveBeenCalled();
    driver.resolve();
    await first;
  });

  it('rejects caller cancellation promptly while retaining ownership through late failure', async () => {
    const gate = new OperationGate();
    const controller = new AbortController();
    const driver = deferred<void>();
    let context!: OperationContext;
    const result = observe(gate.run('load', { signal: controller.signal }, async current => { context = current; await driver.promise; }));
    controller.abort(new Error('Caller reason is not the public error contract.'));
    expect(await result).toMatchObject({ ok: false, error: { code: 'PREVIEW_ABORTED', stage: 'load', details: { operationId: context.id } } });
    expect(context.signal.reason).toBeInstanceOf(PreviewError);
    expect(() => context.throwIfAborted()).toThrow(context.signal.reason);
    const publication = vi.fn(async () => {});
    await expect(context.commit(publication)).rejects.toMatchObject({ code: 'PREVIEW_ABORTED' });
    expect(publication).not.toHaveBeenCalled();
    expect(gate.busy).toBe(true);
    await expect(gate.run('capture', {}, async () => {})).rejects.toMatchObject({ code: 'PREVIEW_BUSY' });
    let idle = false;
    const drained = gate.whenIdle().then(() => { idle = true; });
    await flush();
    expect(idle).toBe(false);
    driver.reject(new Error('Observed late cleanup failure.'));
    await drained;
    expect(gate.busy).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies the operation deadline to work and the cleanup deadline to retained ownership', async () => {
    const onFault = vi.fn();
    const gate = new OperationGate({ defaultTimeoutMs: 20, cleanupTimeoutMs: 50, onFault });
    const driver = deferred<void>();
    const result = observe(gate.run('load', {}, async () => driver.promise));
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ ok: false, error: { code: 'PREVIEW_TIMEOUT', details: { timeoutMs: 20 } } });
    expect(gate.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(49);
    expect(gate.state).toBe('open');
    await vi.advanceTimersByTimeAsync(1);
    expect(gate.state).toBe('faulted');
    expect(gate.fault).toMatchObject({ code: 'PREVIEW_CLEANUP_TIMEOUT' });
    expect(onFault).toHaveBeenCalledExactlyOnceWith(gate.fault);
    await expect(gate.run('load', {}, async () => {})).rejects.toBe(gate.fault);
    expect(gate.busy).toBe(true);
    driver.resolve();
    await gate.whenIdle();
    expect(gate.busy).toBe(false);
    expect(gate.state).toBe('faulted');
  });

  it('times out a queued load without letting its driver start', async () => {
    const gate = new OperationGate({ cleanupTimeoutMs: 100 });
    const oldDriver = deferred<void>();
    const old = observe(gate.run('load', {}, async () => oldDriver.promise));
    const nextDriver = vi.fn(async () => {});
    const queued = observe(gate.run('load', { timeoutMs: 10 }, nextDriver));
    await vi.advanceTimersByTimeAsync(10);
    expect(await queued).toMatchObject({ ok: false, error: { code: 'PREVIEW_TIMEOUT' } });
    oldDriver.resolve();
    await gate.whenIdle();
    expect(await old).toMatchObject({ ok: false, error: { code: 'PREVIEW_SUPERSEDED' } });
    expect(nextDriver).not.toHaveBeenCalled();
  });

  it('rejects queued work and permanently faults if superseded cleanup cannot settle', async () => {
    const gate = new OperationGate({ cleanupTimeoutMs: 10 });
    const oldDriver = deferred<void>();
    const old = observe(gate.run('load', {}, async () => oldDriver.promise));
    const nextDriver = vi.fn(async () => {});
    const next = observe(gate.run('load', {}, nextDriver));
    await vi.advanceTimersByTimeAsync(10);
    expect(await next).toMatchObject({ ok: false, error: { code: 'PREVIEW_CLEANUP_TIMEOUT' } });
    expect(gate.busy).toBe(true);
    oldDriver.resolve();
    await gate.whenIdle();
    expect(await old).toMatchObject({ ok: false, error: { code: 'PREVIEW_SUPERSEDED' } });
    expect(nextDriver).not.toHaveBeenCalled();
    expect(gate.state).toBe('faulted');
  });

  it('disposes permanently while retaining the active work until settlement', async () => {
    const gate = new OperationGate();
    const driver = deferred<void>();
    let context!: OperationContext;
    const active = observe(gate.run('load', {}, async current => { context = current; await driver.promise; }));
    const pendingDriver = vi.fn(async () => {});
    const queued = observe(gate.run('load', {}, pendingDriver));
    gate.dispose();
    gate.dispose();
    expect(context.signal.aborted).toBe(true);
    expect(await active).toMatchObject({ ok: false, error: { code: 'PREVIEW_SUPERSEDED' } });
    expect(await queued).toMatchObject({ ok: false, error: { code: 'PREVIEW_DISPOSED' } });
    expect(gate.state).toBe('disposed');
    await expect(gate.run('load', {}, async () => {})).rejects.toMatchObject({ code: 'PREVIEW_DISPOSED' });
    expect(gate.busy).toBe(true);
    driver.resolve();
    await gate.whenIdle();
    expect(pendingDriver).not.toHaveBeenCalled();
    expect(gate.busy).toBe(false);
  });
});

describe('artifact publication boundary', () => {
  it.each(['cancel', 'dispose', 'timeout'] as const)('preserves successful publication when %s arrives during the final receipt write', async cause => {
    const gate = new OperationGate();
    const controller = new AbortController();
    const publication = deferred<string>();
    let context!: OperationContext;
    let completed = false;
    const result = observe(gate.run('capture', { signal: controller.signal, timeoutMs: 10 }, async current => {
      context = current;
      return current.commit(() => publication.promise);
    })).then(outcome => { completed = true; return outcome; });
    if (cause === 'cancel') controller.abort();
    else if (cause === 'dispose') gate.dispose();
    else await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(context.signal.aborted).toBe(true);
    expect(completed).toBe(false);
    expect(gate.busy).toBe(true);
    publication.resolve('published receipt');
    expect(await result).toEqual({ ok: true, value: 'published receipt' });
    expect(gate.busy).toBe(false);
    expect(gate.state).toBe(cause === 'dispose' ? 'disposed' : 'open');
  });

  it.each(['cancel', 'dispose'] as const)('reports the actual publication error when %s races its failure', async cause => {
    const gate = new OperationGate();
    const controller = new AbortController();
    const publication = deferred<void>();
    const failure = new PreviewError('PREVIEW_ARTIFACT_EXISTS', 'publish', 'Receipt already exists.');
    let completed = false;
    const result = observe(gate.run('capture', { signal: controller.signal }, async context => context.commit(() => publication.promise)))
      .then(outcome => { completed = true; return outcome; });
    if (cause === 'cancel') controller.abort();
    else gate.dispose();
    await flush();
    expect(completed).toBe(false);
    publication.reject(failure);
    expect(await result).toEqual({ ok: false, error: failure });
    expect(gate.busy).toBe(false);
  });

  it('faults cleanup without prematurely rejecting a still-publishing capture', async () => {
    const onFault = vi.fn();
    const gate = new OperationGate({ cleanupTimeoutMs: 10, onFault });
    const controller = new AbortController();
    const publication = deferred<string>();
    let completed = false;
    const result = observe(gate.run('capture', { signal: controller.signal }, async context => context.commit(() => publication.promise)))
      .then(outcome => { completed = true; return outcome; });
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    expect(gate.state).toBe('faulted');
    expect(onFault).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    expect(gate.busy).toBe(true);
    await expect(gate.run('load', {}, async () => {})).rejects.toMatchObject({ code: 'PREVIEW_CLEANUP_TIMEOUT' });
    publication.resolve('receipt published after fault');
    expect(await result).toEqual({ ok: true, value: 'receipt published after fault' });
    expect(gate.state).toBe('faulted');
    expect(gate.busy).toBe(false);
  });

  it('tracks publication even when the driver mistakenly returns before awaiting it', async () => {
    const gate = new OperationGate();
    const publication = deferred<void>();
    let completed = false;
    const result = observe(gate.run('capture', {}, async context => {
      void context.commit(() => publication.promise);
      return 'driver returned early';
    })).then(outcome => { completed = true; return outcome; });
    await flush();
    expect(gate.busy).toBe(true);
    expect(completed).toBe(false);
    const failure = new Error('Publication failed after driver returned.');
    publication.reject(failure);
    expect(await result).toEqual({ ok: false, error: failure });
    expect(gate.busy).toBe(false);
  });

  it('preserves publisher cleanup diagnostics when an in-flight publication fails after cancellation', async () => {
    const gate = new OperationGate();
    const controller = new AbortController();
    const publication = deferred<void>();
    const syscallError = new Error('Link failed.');
    const detailedError = new PreviewError('PREVIEW_ARTIFACT_IO', 'publish-receipt', 'Link failed; cleanup also failed.', {
      incompleteArtifacts: ['/external/capture/image.png'],
    });
    const result = observe(gate.run('capture', { signal: controller.signal }, async context => {
      try { await context.commit(() => publication.promise); }
      catch { throw detailedError; }
    }));
    controller.abort();
    publication.reject(syscallError);
    expect(await result).toEqual({ ok: false, error: detailedError });
    expect(gate.busy).toBe(false);
  });

  it('preserves success after completed publication and retains postpublication cleanup ownership', async () => {
    const gate = new OperationGate();
    const controller = new AbortController();
    const cleanup = deferred<void>();
    const result = gate.run('capture', { signal: controller.signal }, async context => {
      const receipt = await context.commit(async () => 'receipt');
      await cleanup.promise;
      return receipt;
    });
    await flush();
    controller.abort();
    expect(gate.busy).toBe(true);
    await expect(gate.run('resize', {}, async () => {})).rejects.toMatchObject({ code: 'PREVIEW_BUSY' });
    cleanup.resolve();
    expect(await result).toBe('receipt');
  });

  it('does not reject a published capture when postpublication cleanup exceeds its deadline', async () => {
    const onFault = vi.fn();
    const gate = new OperationGate({ cleanupTimeoutMs: 10, onFault });
    const cleanup = deferred<void>();
    const committed = deferred<void>();
    let completed = false;
    const result = observe(gate.run('capture', {}, async context => {
      const receipt = await context.commit(async () => 'published receipt');
      committed.resolve();
      await cleanup.promise;
      return receipt;
    })).then(outcome => { completed = true; return outcome; });
    await committed.promise;
    gate.dispose();
    await vi.advanceTimersByTimeAsync(10);
    expect(onFault).toHaveBeenCalledOnce();
    expect(gate.state).toBe('faulted');
    expect(gate.busy).toBe(true);
    expect(completed).toBe(false);
    cleanup.resolve();
    expect(await result).toEqual({ ok: true, value: 'published receipt' });
    expect(gate.busy).toBe(false);
  });

  it('reports a real postpublication driver failure and forbids a second publication', async () => {
    const gate = new OperationGate();
    const failure = new Error('Postpublication cleanup failed.');
    await expect(gate.run('capture', {}, async context => {
      await context.commit(async () => 'receipt');
      await expect(context.commit(async () => 'duplicate')).rejects.toMatchObject({ code: 'PREVIEW_INVALID_OPTIONS' });
      throw failure;
    })).rejects.toBe(failure);
    expect(gate.busy).toBe(false);
  });
});
