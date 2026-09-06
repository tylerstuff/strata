import { describe, expect, it } from 'vitest';
import { assertBytesEqual, assertCompletedProofStage, createRecordedDevice, finishProofDevice, proofWriteInput } from '../browser/trace-update-proof-gpu.js';

function nativeFixture() {
  const raw = { calls: 0, queue: {
    writeBuffer(buffer: { bytes: Uint8Array }, offset: number, data: Parameters<GPUQueue['writeBuffer']>[2], dataOffset?: number, size?: number) {
      expect(this).toBe(raw.queue); buffer.bytes.set(proofWriteInput(data, dataOffset, size), offset); raw.calls++;
    }, submit() { expect(this).toBe(raw.queue); },
  }, createBuffer(descriptor: GPUBufferDescriptor) {
    expect(this).toBe(raw); return { size: descriptor.size, bytes: new Uint8Array(descriptor.size), destroy() {} };
  }, createCommandEncoder() { expect(this).toBe(raw); return {}; } };
  return { raw, recorder: createRecordedDevice(raw as unknown as GPUDevice) };
}

describe('GPU proof evidence forwarding', () => {
  it('uses element offsets for typed views, byte offsets for buffers and DataViews, and owns copied evidence', () => {
    const source = new Uint32Array([0x11111111, 0x22222222, 0x33333333, 0x44444444]);
    const slice = source.subarray(1, 4);
    expect(proofWriteInput(slice, 1, 1)).toEqual(new Uint8Array([0x33, 0x33, 0x33, 0x33]));
    expect(proofWriteInput(source.buffer, 4, 4)).toEqual(new Uint8Array([0x22, 0x22, 0x22, 0x22]));
    expect(proofWriteInput(new DataView(source.buffer, 4, 8), 4, 4)).toEqual(new Uint8Array([0x33, 0x33, 0x33, 0x33]));
    const saved = proofWriteInput(slice, 1, 1); source.fill(0); expect(saved[0]).toBe(0x33);
    expect(() => proofWriteInput(slice, 4, 1)).toThrow('source range');
  });
  it('forwards real receivers without replacing buffers and counts only trace writes for injected failures', () => {
    const { raw, recorder } = nativeFixture();
    const source = new Uint32Array([1, 2, 3, 4]);
    const trace = recorder.device.createBuffer({ label: 'Strata GI trace data 0', size: 16, usage: 12 });
    const other = recorder.device.createBuffer({ label: 'probe configuration', size: 16, usage: 12 });
    expect(recorder.traceBuffers.get('Strata GI trace data 0')).toBe(trace);
    recorder.setPhase('partial'); recorder.failTraceWrite(2);
    recorder.device.queue.writeBuffer(other, 0, source);
    recorder.device.queue.writeBuffer(trace, 4, source, 1, 1);
    expect(() => recorder.device.queue.writeBuffer(trace, 8, source, 2, 1)).toThrow('before forwarding');
    expect(raw.calls).toBe(2);
    expect(recorder.writes.map(w => [w.offset, w.byteLength, w.returned, w.phase])).toEqual([[4, 4, true, 'partial'], [8, 4, false, 'partial']]);
    expect((trace as unknown as { bytes: Uint8Array }).bytes).toEqual(new Uint8Array([0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    recorder.device.queue.writeBuffer(trace, 8, source, 2, 1); // The injected throw was one-shot.
    expect(recorder.writes[2]!.returned).toBe(true); expect(raw.calls).toBe(3);
    source.fill(0); expect(recorder.writes[0]!.bytes[0]).toBe(2);
    recorder.device.queue.submit([]); recorder.device.createCommandEncoder();
    expect(recorder.device.queue).toBe(recorder.device.queue);
    expect(recorder.device.createBuffer).toBe(recorder.device.createBuffer);
  });
  it('retains attempted evidence when the native write itself throws', () => {
    const { raw, recorder } = nativeFixture();
    const trace = recorder.device.createBuffer({ label: 'Strata reflection trace data 1', size: 4, usage: 12 });
    raw.queue.writeBuffer = () => { throw new Error('native write error'); };
    expect(() => recorder.device.queue.writeBuffer(trace, 0, new Uint32Array([42]))).toThrow('native write error');
    expect(recorder.writes[0]).toMatchObject({ returned: false, offset: 0, byteLength: 4 });
    expect(recorder.writes[0]!.bytes[0]).toBe(42);
  });
  it('rejects duplicate trace ownership and reports a bounded first differing byte', () => {
    const { recorder } = nativeFixture();
    recorder.device.createBuffer({ label: 'Strata GI trace data 0', size: 4, usage: 12 });
    expect(() => recorder.device.createBuffer({ label: 'Strata GI trace data 0', size: 4, usage: 12 })).toThrow('Duplicate owned');
    expect(() => recorder.failTraceWrite(0)).toThrow('ordinal');
    const a = new Uint8Array([3, 4]), b = new Uint8Array([3, 5]);
    try { assertBytesEqual(a, b, 'example'); throw new Error('Expected byte failure'); }
    catch (error) { expect(error).toMatchObject({ proofDifference: { firstByte: 1, actualByte: 4, expectedByte: 5, actualBytes: 2, expectedBytes: 2 } }); }
    expect(() => assertBytesEqual(a, a, 'equal')).not.toThrow();
  });
  it('stops on returned stage failures and retains their evidence', () => {
    const result = { status: 'failed', failures: [{ message: 'actual source bytes differ' }] };
    let nextStage = false;
    try { assertCompletedProofStage(result, 'Stage A'); nextStage = true; }
    catch (error) { expect(error).toMatchObject({ proofEvidence: result }); }
    expect(nextStage).toBe(false);
    expect(() => assertCompletedProofStage({ status: 'passed', failures: ['latent failure'] }, 'A')).toThrow();
    expect(() => assertCompletedProofStage({ status: 'running' }, 'A')).toThrow();
    expect(() => assertCompletedProofStage({ status: 'passed', failures: [] }, 'A')).not.toThrow();
  });
  it('retains scoped errors on failed runs and destroys the device after draining', async () => {
    const sequence: string[] = []; let i = 0;
    const device = { popErrorScope() {
      sequence.push(`pop${i}`);
      if (i++ === 1) return Promise.reject(new Error('scope lost'));
      return Promise.resolve(i === 1 ? { message: 'invalid storage binding' } : null);
    }, destroy() { sequence.push('destroy'); } } as unknown as GPUDevice;
    const result = await finishProofDevice(device, 3, () => sequence.push('expected-destroy'));
    expect(result.errors).toHaveLength(2);
    expect(result.errors.join(' ')).toContain('invalid storage binding');
    expect(result.errors.join(' ')).toContain('scope lost');
    expect(sequence).toEqual(['pop0', 'pop1', 'pop2', 'expected-destroy', 'destroy']);
    expect(result).toMatchObject({ destroyed: true, scopesAttempted: 3 });
  });
  it('bounds a stalled error scope and still destroys the device', async () => {
    let destroyed = false;
    const device = { popErrorScope: () => new Promise(() => {}), destroy() { destroyed = true; } } as unknown as GPUDevice;
    const result = await finishProofDevice(device, 1, () => {}, 5);
    expect(destroyed).toBe(true); expect(result.errors[0]).toContain('deadline exceeded');
  });
});
