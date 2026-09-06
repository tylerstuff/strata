import { describe, expect, it, vi } from 'vitest';
import { GeometryChangeSignal, GeometryTransferBudget } from '../../packages/core/src/geometry/transfer-budget.js';
import type { GeometryTransferLimits } from '../../packages/core/src/geometry/transfer-budget.js';

const page = 65_536;
function budget(overrides: Partial<GeometryTransferLimits> = {}) {
  return new GeometryTransferBudget({ maxRequests: 2, pageStagingBytes: 2 * page,
    transientBytes: 100, residentBytes: 200, gpuBufferBytes: 300, uploadBytesPerFrame: page, ...overrides });
}
function gpu() {
  const writeBuffer = vi.fn();
  return { writeBuffer, device: { queue: { writeBuffer } } as unknown as GPUDevice, buffer: {} as GPUBuffer };
}
const invalid = { code: 'INVALID_OPTIONS' };

describe('shared geometry transfer budgets', () => {
  it.each([
    ['maxRequests', 0], ['maxRequests', 1.5], ['pageStagingBytes', page - 1],
    ['uploadBytesPerFrame', page - 1], ['uploadBytesPerFrame', page + 1],
    ['residentBytes', -1], ['transientBytes', NaN], ['gpuBufferBytes', Infinity],
    ['gpuBufferBytes', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('rejects impossible or invalid %s=%s limits', (name, value) => {
    expect(() => budget({ [name]: value })).toThrowError(expect.objectContaining(invalid));
  });

  it('copies immutable limits and permits empty non-page resource caps', () => {
    const limits = { maxRequests: 1, pageStagingBytes: page, transientBytes: 0, residentBytes: 0,
      gpuBufferBytes: 0, uploadBytesPerFrame: page };
    const shared = new GeometryTransferBudget(limits); limits.maxRequests = 8;
    expect(shared.limits.maxRequests).toBe(1);
    expect(Object.isFrozen(shared.limits)).toBe(true);
    expect(shared.tryReserve({})?.released).toBe(false);
    expect(() => shared.tryReserve({ transientBytes: 1 })).toThrowError(expect.objectContaining(invalid));
  });

  it('atomically admits several owners and releases each allocation exactly once', () => {
    const shared = budget();
    const [first, second] = shared.tryReserveMany([
      { transientBytes: 50, residentBytes: 50, gpuBufferBytes: 100 },
      { transientBytes: 50, residentBytes: 150, gpuBufferBytes: 200 },
    ])!;
    expect(first!.budget).toBe(shared);
    expect(first!.amounts).toEqual({ transientBytes: 50, residentBytes: 50, gpuBufferBytes: 100 });
    expect(Object.isFrozen(first!.amounts)).toBe(true);
    expect(shared.tryReserve({ transientBytes: 1 })).toBeUndefined();
    expect(shared.telemetry).toMatchObject({ transientBytes: 100, residentBytes: 200, gpuBufferBytes: 300,
      peakTransientBytes: 100, peakResidentBytes: 200, peakGpuBufferBytes: 300 });
    first!.release(); first!.release();
    expect(first!.released).toBe(true); expect(second!.released).toBe(false);
    expect(shared.telemetry).toMatchObject({ transientBytes: 50, residentBytes: 150, gpuBufferBytes: 200 });
    second!.release();
    expect(shared.telemetry).toMatchObject({ transientBytes: 0, residentBytes: 0, gpuBufferBytes: 0,
      peakTransientBytes: 100, peakResidentBytes: 200, peakGpuBufferBytes: 300 });
  });

  it('takes no partial hold for pressure, malformed later requests, or impossible combined demand', () => {
    const shared = budget(); const held = shared.tryReserve({ residentBytes: 100 })!;
    const before = shared.telemetry;
    expect(shared.tryReserveMany([{ transientBytes: 100 }, { residentBytes: 101 }])).toBeUndefined();
    expect(() => shared.tryReserveMany([{ transientBytes: 100 }, { gpuBufferBytes: -1 }])).toThrowError(expect.objectContaining(invalid));
    expect(() => shared.tryReserveMany([{ transientBytes: 60 }, { transientBytes: 50 }])).toThrowError(expect.objectContaining(invalid));
    expect(shared.telemetry).toEqual(before);
    held.release();
    expect(shared.tryReserveMany([{ transientBytes: 100 }, { residentBytes: 101 }])).toHaveLength(2);
  });

  it('distinguishes request-slot pressure from retained completed payload pressure', () => {
    const shared = budget({ maxRequests: 1 });
    const first = shared.tryRequest(page)!;
    expect(shared.tryRequest(page)).toBeUndefined();
    first.finishRequest(); first.finishRequest();
    expect(shared.telemetry).toMatchObject({ requests: 0, pageStagingBytes: page });
    const second = shared.tryRequest(page)!; second.finishRequest();
    expect(shared.tryRequest(page)).toBeUndefined();
    first.release(); first.release(); first.finishRequest();
    const third = shared.tryRequest(page)!;
    expect(shared.telemetry).toMatchObject({ requests: 1, pageStagingBytes: 2 * page, peakRequests: 1, peakPageStagingBytes: 2 * page });
    third.release(); third.finishRequest(); second.release();
    expect(shared.telemetry).toMatchObject({ requests: 0, pageStagingBytes: 0 });
    expect(() => shared.tryRequest(0)).toThrowError(expect.objectContaining(invalid));
    expect(() => shared.tryRequest(3 * page)).toThrowError(expect.objectContaining(invalid));
  });

  it('keeps canceled asynchronous work charged until its owner releases at settlement', async () => {
    const shared = budget({ maxRequests: 1, pageStagingBytes: page });
    const lease = shared.tryRequest(page)!;
    let settle!: () => void;
    const pending = new Promise<void>(resolve => { settle = resolve; }).finally(() => lease.release());
    const controller = new AbortController(); controller.abort();
    shared.beginFrame(0); shared.beginFrame(1);
    expect(shared.tryRequest(page)).toBeUndefined();
    expect(shared.telemetry).toMatchObject({ requests: 1, pageStagingBytes: page });
    settle(); await pending;
    expect(shared.telemetry).toMatchObject({ requests: 0, pageStagingBytes: 0 });
  });

  it('charges actual shared writes and gives frames no direct renewal method', () => {
    const shared = budget(); const frame = shared.beginFrame(0); const device = gpu();
    const half = new Uint8Array(page / 2);
    expect(() => frame.assertCurrent()).not.toThrow();
    expect(frame.budget).toBe(shared);
    expect('beginFrame' in frame).toBe(false);
    expect(frame.write(device.device, device.buffer, 0, half)).toBe(true);
    expect(frame.write(device.device, device.buffer, page / 2, half)).toBe(true);
    expect(frame.write(device.device, device.buffer, 0, new Uint8Array(4))).toBe(false);
    expect(device.writeBuffer).toHaveBeenCalledTimes(2);
    expect(frame.writtenBytes).toBe(page); expect(frame.remainingBytes).toBe(0);
    expect(shared.telemetry).toMatchObject({ uploadBytes: page, frameId: 0, frameWrittenBytes: page, frameRemainingBytes: 0 });
    const second = shared.beginFrame(8);
    expect(() => frame.assertCurrent()).toThrowError(expect.objectContaining(invalid));
    expect(() => second.assertCurrent()).not.toThrow();
    expect(second.remainingBytes).toBe(page);
    expect(shared.telemetry.uploadBytes).toBe(page);
    expect(() => frame.write(device.device, device.buffer, 0, new Uint8Array(4))).toThrowError(expect.objectContaining(invalid));
    expect(device.writeBuffer).toHaveBeenCalledTimes(2);
    for (const id of [8, 7, -1, 8.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => shared.beginFrame(id)).toThrowError(expect.objectContaining(invalid));
    }
  });

  it('reserves before the queue call and refunds synchronous failures without counting them', () => {
    const shared = budget(); const frame = shared.beginFrame(0); const device = gpu();
    device.writeBuffer.mockImplementationOnce(() => {
      expect(frame.remainingBytes).toBe(0);
      expect(frame.write(device.device, device.buffer, 0, new Uint8Array(4))).toBe(false);
      throw new Error('queue write failed');
    });
    expect(() => frame.write(device.device, device.buffer, 0, new Uint8Array(page))).toThrow('queue write failed');
    expect(frame.remainingBytes).toBe(page); expect(frame.writtenBytes).toBe(0);
    expect(shared.telemetry.uploadBytes).toBe(0);
    expect(frame.write(device.device, device.buffer, 0, new Uint8Array(page))).toBe(true);
    expect(shared.telemetry.uploadBytes).toBe(page);
  });

  it('rejects invalid write views/offsets before touching the queue and returns false for oversize writes', () => {
    const frame = budget().beginFrame(0); const device = gpu();
    for (const offset of [-4, 1, Infinity, Number.MAX_SAFE_INTEGER - 3]) {
      expect(() => frame.write(device.device, device.buffer, offset, new Uint8Array(8))).toThrowError(expect.objectContaining(invalid));
    }
    expect(() => frame.write(device.device, device.buffer, 0, new Uint8Array(3))).toThrowError(expect.objectContaining(invalid));
    expect(() => frame.write(device.device, device.buffer, 0, new Uint8Array(new SharedArrayBuffer(4)) as unknown as Uint8Array<ArrayBuffer>)).toThrowError(expect.objectContaining(invalid));
    expect(frame.write(device.device, device.buffer, 0, new Uint8Array(page + 4))).toBe(false);
    expect(device.writeBuffer).not.toHaveBeenCalled();
  });

  it('wakes availability observers after release and frame renewal without synchronous reentrancy', async () => {
    const shared = budget(); const lease = shared.tryReserve({ transientBytes: 100 })!;
    const callback = vi.fn(); const unsubscribe = shared.subscribe(callback);
    const revision = shared.revision; const changed = shared.waitForChange(revision);
    lease.release();
    expect(shared.revision).toBe(revision + 1); expect(callback).not.toHaveBeenCalled();
    await changed;
    expect(callback).toHaveBeenCalledOnce();
    await expect(shared.waitForChange(revision)).resolves.toBeUndefined();
    const beforeFrame = shared.revision; const frameChanged = shared.waitForChange(beforeFrame);
    shared.beginFrame(0); await frameChanged;
    expect(callback).toHaveBeenCalledTimes(2);
    unsubscribe(); shared.beginFrame(1); await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(2);
  });
});

describe('geometry change signal', () => {
  it('covers notification-before-subscription races and coalesces callback delivery', async () => {
    const changes = new GeometryChangeSignal(); const observed = changes.revision;
    changes.notify();
    await expect(changes.wait(observed)).resolves.toBeUndefined();
    const callback = vi.fn(); changes.subscribe(callback);
    const pending = changes.wait(changes.revision);
    changes.notify(); changes.notify();
    expect(changes.revision).toBe(3); expect(callback).not.toHaveBeenCalled();
    await pending; expect(callback).toHaveBeenCalledOnce();
  });

  it('isolates failed observers and honors unsubscribe before queued delivery', async () => {
    const changes = new GeometryChangeSignal(); const removed = vi.fn(); const next = vi.fn();
    changes.subscribe(() => { throw new Error('observer failed'); });
    const remove = changes.subscribe(removed); changes.subscribe(next);
    changes.notify(); remove(); await Promise.resolve();
    expect(removed).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledOnce();
    expect(() => changes.wait(-1)).toThrowError(expect.objectContaining(invalid));
  });
});
