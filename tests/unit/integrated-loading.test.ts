import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegratedRenderer } from '../../packages/core/src/integrated/integrated-renderer.js';
import { fetchTraceSourceBytes } from '../../packages/core/src/geometry/trace-proxy.js';

afterEach(() => vi.unstubAllGlobals());
const options = { renderer: 'integrated' as const, manifestUrl: 'https://assets.test/manifest.json', traceProxyUrl: 'https://assets.test/trace-proxy.json' };

describe('bounded integrated source loading', () => {
  it('rejects an oversized announced manifest before decoding or allocating a GPU resource', async () => {
    const cancel = vi.fn(); const createBuffer = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } })));
    await expect(IntegratedRenderer.create({ createBuffer } as unknown as GPUDevice, 'rgba8unorm', options)).rejects.toThrow(/byte budget/);
    expect(cancel).toHaveBeenCalledOnce(); expect(createBuffer).not.toHaveBeenCalled();
  });
  it('cancels a chunked source as it exceeds the budget before JSON parsing', async () => {
    const cancel = vi.fn(); let pulls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(5 * 1024 * 1024)); }, cancel,
    }, { highWaterMark: 0 }))));
    await expect(IntegratedRenderer.create({} as GPUDevice, 'rgba8unorm', options)).rejects.toThrow(/byte budget/);
    expect(pulls).toBe(2); expect(cancel).toHaveBeenCalledOnce();
  });
  it('cancels a source reader when its caller aborts during a chunk delivery', async () => {
    const abort = new AbortController(); const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array([1])); abort.abort(); }, cancel,
    }, { highWaterMark: 0 }))));
    await expect(fetchTraceSourceBytes(new URL(options.manifestUrl), 8, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
