import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegionValidationDeadline } from '../browser/region-validation-deadline.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe('region browser operation deadlines use monotonic completion time', () => {
  it('accepts on-time completion and clears its wakeup timer', async () => {
    vi.useFakeTimers(); let now = 0; const operation = deferred<number>();
    const deadline = new RegionValidationDeadline(100, () => now);
    const result = deadline.bounded(() => operation.promise, 10);
    now = 9; operation.resolve(42);
    await expect(result).resolves.toBe(42); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { name: 'per-operation', overall: 100, operation: 10, completion: 11 },
    { name: 'original overall', overall: 10, operation: 100, completion: 11 },
    { name: 'exact deadline', overall: 100, operation: 10, completion: 10 },
  ])('rejects overdue $name fulfillment before the delayed timer task runs', async limits => {
    vi.useFakeTimers(); let now = 0; const operation = deferred<number>();
    const deadline = new RegionValidationDeadline(limits.overall, () => now);
    const result = deadline.bounded(() => operation.promise, limits.operation);
    const rejected = expect(result).rejects.toThrow(/deadline exceeded/);
    // Only the monotonic clock advances. The timeout task deliberately does not run.
    now = limits.completion; operation.resolve(42);
    await rejected; expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an expired admission before invoking the operation thunk', async () => {
    const start = vi.fn(async () => 42);
    await expect(new RegionValidationDeadline(10, () => 10).bounded(start)).rejects.toThrow(/deadline exceeded/);
    expect(start).not.toHaveBeenCalled();
  });

  it('retains the original overall deadline across successive operations', async () => {
    vi.useFakeTimers(); let now = 8; const deadline = new RegionValidationDeadline(10, () => now);
    await expect(deadline.bounded(async () => 1, 100)).resolves.toBe(1);
    const operation = deferred<number>(); const result = deadline.bounded(() => operation.promise, 100);
    const rejected = expect(result).rejects.toThrow(/deadline exceeded/);
    now = 11; operation.resolve(2); await rejected;
  });

  it('keeps original operation settlement independent of an expired wait', async () => {
    vi.useFakeTimers(); let now = 0; let originalSettled = false;
    const operation = deferred<number>(); const original = operation.promise.then(value => { originalSettled = true; return value; });
    const result = new RegionValidationDeadline(100, () => now).bounded(() => original, 10);
    const rejected = expect(result).rejects.toThrow(/deadline exceeded/);
    now = 10; await vi.advanceTimersByTimeAsync(10); await rejected;
    expect(originalSettled).toBe(false);
    operation.resolve(42); await expect(original).resolves.toBe(42); expect(originalSettled).toBe(true);
  });
});

describe('region browser stage loops reject late RAF readiness', () => {
  it('expires a withheld RAF at the original stage deadline without waiting for the RAF timeout', async () => {
    vi.useFakeTimers(); let now = 0; const frame = deferred<void>(); const advance = vi.fn();
    const result = new RegionValidationDeadline(1000, () => now).stage({ milliseconds: 60, done: () => false, wait: () => frame.promise, advance });
    const rejected = expect(result).rejects.toThrow(/deadline exceeded/);
    now = 60; await vi.advanceTimersByTimeAsync(60); await rejected;
    expect(advance).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['drive', 'settlement'] as const)('rejects a late RAF before %s can advance or accept readiness', async mode => {
    let now = 0; let ready = false; const frame = deferred<void>(); const advance = vi.fn(() => { ready = true; });
    const wait = vi.fn(() => frame.promise); const deadline = new RegionValidationDeadline(1000, () => now);
    const result = deadline.stage({ milliseconds: 60, done: () => ready, wait, ...(mode === 'drive' ? { advance } : {}) });
    const rejected = expect(result).rejects.toThrow(/deadline exceeded/);
    now = 61; ready = true; frame.resolve();
    await rejected; expect(advance).not.toHaveBeenCalled(); expect(wait).toHaveBeenCalledTimes(1);
  });

  it('applies the original overall deadline even when the stage allowance is longer', async () => {
    let now = 0; const frame = deferred<void>(); const advance = vi.fn();
    const result = new RegionValidationDeadline(5, () => now).stage({ milliseconds: 60, done: () => false, wait: () => frame.promise, advance });
    const rejected = expect(result).rejects.toThrow(/deadline exceeded/);
    now = 6; frame.resolve(); await rejected; expect(advance).not.toHaveBeenCalled();
  });

  it('rejects an initially ready result after the original overall deadline', async () => {
    const done = vi.fn(() => true); const wait = vi.fn(async () => undefined);
    await expect(new RegionValidationDeadline(10, () => 10).stage({ milliseconds: 60, done, wait })).rejects.toThrow(/deadline exceeded/);
    expect(done).not.toHaveBeenCalled(); expect(wait).not.toHaveBeenCalled();
  });

  it('checks time again before accepting a done predicate or an advance that finishes late', async () => {
    let now = 0; const deadline = new RegionValidationDeadline(1000, () => now);
    await expect(deadline.stage({ milliseconds: 60, done: () => { now = 61; return true; }, wait: async () => undefined })).rejects.toThrow(/deadline exceeded/);
    now = 0; let ready = false;
    await expect(deadline.stage({ milliseconds: 60, done: () => ready, wait: async () => undefined,
      advance: () => { now = 61; ready = true; } })).rejects.toThrow(/deadline exceeded/);
  });

  it('allows an on-time RAF and advance, then rejects final success if cleanup crosses the original deadline', async () => {
    let now = 0; let ready = false; const deadline = new RegionValidationDeadline(100, () => now);
    const advance = vi.fn(() => { now = 2; ready = true; });
    await deadline.stage({ milliseconds: 60, done: () => ready, wait: async () => { now = 1; }, advance });
    expect(advance).toHaveBeenCalledTimes(1); expect(() => deadline.assertOpen()).not.toThrow();
    now = 101; expect(() => deadline.assertOpen()).toThrow(/deadline exceeded/);
  });
});
