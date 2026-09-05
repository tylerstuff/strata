import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine, SceneCommitError, StrataError, type Engine } from '../../packages/core/src/index.js';
import { initializeCpuRuntime } from '../../packages/core/src/internal/cpu-runtime.js';
import { validateAuthoredFrameCamera } from '../../packages/core/src/rendering/authored-box-validation.js';
import type { AuthoredFrameMetadata, BoxCamera, BoxSceneDescriptor } from '../../packages/core/src/rendering/authored-box-types.js';
import type { RenderOptions, SceneOptions } from '../../packages/core/src/types.js';

// Mock the optional module itself: lifecycle tests never import the GPU renderer or
// its coordinate packer, and cannot accidentally allocate a real pipeline.
const factories = vi.hoisted(() => ({ authored: vi.fn(), diffuse: vi.fn() }));
vi.mock('../../packages/core/src/rendering/authored-box-renderer.js', () => ({ AuthoredBoxRenderer: { create: factories.authored } }));
vi.mock('../../packages/core/src/rendering/scene-renderer.js', () => ({ SceneRenderer: { create: factories.diffuse } }));
vi.mock('../../packages/core/src/internal/cpu-runtime.js', () => ({ initializeCpuRuntime: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function descriptor(sceneId = 'scene-a', sourceRevision: string | null = 'revision-a') {
  return {
    format: 'strata.runtime-boxes', version: 1, coordinateSystem: 'strata-world-v1', sceneId, sourceRevision,
    boxes: [{ id: 'box-a', dimensions: [1, 2, 3], transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      material: { baseColor: [.2, .4, .6, 1], metallic: .3, roughness: .7 } }],
    camera: { position: [0, 0, 4], rotation: [0, 0, 0, 1], projection: { kind: 'perspective', verticalFovRadians: 1, near: .1, far: 32 } },
    light: { directionToLight: [0, 1, 0], radiance: [1, 2, 3] }, background: [.01, .02, .03],
  } satisfies BoxSceneDescriptor;
}

function sceneMock(scene: BoxSceneDescriptor, allocation = 128) {
  return {
    gpuBufferBytes: allocation, gpuTextureBytes: 64, initialUploadBytes: 32,
    passNames: vi.fn(() => ['raster']), dispose: vi.fn<() => void>(),
    encode: vi.fn((_encoder: GPUCommandEncoder, _view: GPUTextureView, width: number, height: number,
      timeSeconds: number, controls: RenderOptions = {}) => {
      // This only models the renderer's metadata boundary; packing/render math is
      // covered separately. Real validation preserves the per-frame camera copy.
      const camera = validateAuthoredFrameCamera(scene, controls.camera ?? scene.camera, width, height);
      const length = Math.hypot(...camera.rotation);
      const authored: AuthoredFrameMetadata = Object.freeze({
        camera: Object.freeze({ ...camera, rotation: Object.freeze(camera.rotation.map(value => value / length)) as BoxCamera['rotation'] }),
        origin: Object.freeze([...camera.position]) as BoxCamera['position'], aspect: width / height,
        width, height, timeSeconds, debugView: controls.debugView === 'base-color' ? 'base-color' : 'final',
      });
      return { authored, drawCalls: 1, dispatchCalls: 0, triangles: 12, uploadBytes: 16, gpuBufferBytes: allocation, gpuTextureBytes: 64 };
    }),
  };
}
type MockScene = ReturnType<typeof sceneMock>;

function gpuFixture() {
  const loss = deferred<GPUDeviceLostInfo>();
  const pass = { end: vi.fn() };
  const encoder = { beginRenderPass: vi.fn(() => pass), finish: vi.fn(() => ({ command: true })) };
  const device = {
    features: new Set<GPUFeatureName>(), limits: { maxTextureDimension2D: 4096 }, lost: loss.promise,
    destroy: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    queue: { submit: vi.fn(), onSubmittedWorkDone: vi.fn(async () => {}) }, createCommandEncoder: vi.fn(() => encoder),
  };
  const adapter = { features: new Set<GPUFeatureName>(), limits: { maxTextureDimension2D: 4096 }, requestDevice: vi.fn(async () => device as unknown as GPUDevice) };
  const gpu = { requestAdapter: vi.fn(async () => adapter as unknown as GPUAdapter), getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm') };
  const view = {};
  const context = { configure: vi.fn(), unconfigure: vi.fn(), getCurrentTexture: vi.fn(() => ({ createView: () => view })) };
  const canvas = { width: 640, height: 360, getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement;
  return { device, gpu, context, canvas, encoder, view };
}

const identity = (sceneGeneration: number, sceneId: string | null, sourceRevision: string | null, renderer = 'authored-boxes') => ({
  sceneGeneration, renderer, sceneId, sourceRevision,
});

describe('authored engine commitment and frame lifecycle', () => {
  let gpu: ReturnType<typeof gpuFixture>;
  const engines: Engine[] = []; const created: MockScene[] = [];
  beforeEach(() => {
    vi.resetAllMocks(); created.length = 0; gpu = gpuFixture();
    vi.stubGlobal('navigator', { gpu: gpu.gpu });
    vi.mocked(initializeCpuRuntime).mockResolvedValue({ info: { abiVersion: 2, memoryBytes: 65536 }, buildStaticBvh: vi.fn(), waitForStaticBvhIdle: vi.fn(), dispose: vi.fn() });
    factories.authored.mockImplementation(async (_device, _format, scene: BoxSceneDescriptor) => {
      const value = sceneMock(scene); created.push(value); return value;
    });
  });
  afterEach(() => {
    for (const engine of engines.splice(0)) engine.dispose();
    vi.unstubAllGlobals();
  });
  async function ready() {
    const engine = await createEngine({ canvas: gpu.canvas }); engines.push(engine); return engine;
  }

  it('commits clear independently from submitted frames and resets generation frame bounds', async () => {
    const engine = await ready(); const initial = identity(0, null, null, 'clear');
    expect(engine.getTelemetry().scene).toEqual({ identity: initial, firstSubmittedFrameId: null, lastSubmittedFrameId: null });
    expect(engine.render().scene).toEqual(initial);
    const committed = await engine.setScene({ renderer: 'authored-boxes', scene: descriptor() });
    expect(committed).toEqual(identity(1, 'scene-a', 'revision-a'));
    expect(engine.getTelemetry().scene).toEqual({ identity: committed, firstSubmittedFrameId: null, lastSubmittedFrameId: null });
    expect(engine.render().frameId).toBe(2); expect(engine.render().frameId).toBe(3);
    expect(engine.getTelemetry().scene).toEqual({ identity: committed, firstSubmittedFrameId: 2, lastSubmittedFrameId: 3 });
    const clear = await engine.setScene(null);
    expect(clear).toEqual(identity(2, null, null, 'clear'));
    expect(engine.getTelemetry().submittedFrames).toBe(3);
    expect(engine.getTelemetry().scene).toEqual({ identity: clear, firstSubmittedFrameId: null, lastSubmittedFrameId: null });
    expect(created[0]!.dispose).toHaveBeenCalledOnce();
    expect(engine.render()).toMatchObject({ frameId: 4, scene: clear });
    expect(engine.getTelemetry().scene).toEqual({ identity: clear, firstSubmittedFrameId: 4, lastSubmittedFrameId: 4 });
  });

  it('rejects an invalid descriptor without superseding a pending valid request', async () => {
    const engine = await ready(); const pending = deferred<MockScene>();
    factories.authored.mockReturnValueOnce(pending.promise);
    const loading = engine.setScene({ renderer: 'authored-boxes', scene: descriptor('valid') });
    await vi.waitFor(() => expect(factories.authored).toHaveBeenCalledOnce());
    const invalid = descriptor('invalid'); invalid.boxes[0]!.dimensions[0] = -1;
    await expect(engine.setScene({ renderer: 'authored-boxes', scene: invalid })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(factories.authored).toHaveBeenCalledOnce();
    expect(engine.getTelemetry().scene.identity).toEqual(identity(0, null, null, 'clear'));
    const renderer = sceneMock(descriptor('valid')); pending.resolve(renderer);
    expect(await loading).toEqual(identity(1, 'valid', 'revision-a'));
    expect(renderer.dispose).not.toHaveBeenCalled();
    const next = await engine.setScene({ renderer: 'authored-boxes', scene: descriptor('next') });
    expect(next.sceneGeneration).toBe(2);
  });

  it('takes an immutable deep snapshot synchronously before the first asynchronous phase', async () => {
    const engine = await ready(); const pending = deferred<MockScene>(); factories.authored.mockReturnValueOnce(pending.promise);
    const input = descriptor(); const original = structuredClone(input);
    const loading = engine.setScene({ renderer: 'authored-boxes', scene: input });
    input.sceneId = 'changed'; input.sourceRevision = 'new-revision'; input.boxes[0]!.dimensions[0] = 7;
    input.boxes[0]!.transform.position[1] = 9; input.boxes[0]!.material.baseColor[0] = .8;
    input.camera.position[0] = 2; input.light.radiance[1] = 0; input.background[2] = .9;
    await vi.waitFor(() => expect(factories.authored).toHaveBeenCalledOnce());
    const snapshot = factories.authored.mock.calls[0]![2] as BoxSceneDescriptor;
    expect(snapshot).toEqual(original); expect(snapshot).not.toBe(input);
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.boxes[0]!.transform.position)).toBe(true);
    expect(Object.isFrozen(snapshot.camera.projection)).toBe(true);
    pending.resolve(sceneMock(snapshot));
    const receipt = await loading; expect(receipt).toEqual(identity(1, 'scene-a', 'revision-a'));
    expect(engine.render().authored!.camera).toEqual(original.camera);
  });

  it.each(['abort', 'supersede', 'clear', 'dispose'] as const)('rejects %s promptly while retaining ownership of a late renderer', async action => {
    const engine = await ready(); const first = await engine.setScene({ renderer: 'authored-boxes', scene: descriptor('first') });
    engine.render();
    const pending = deferred<MockScene>(); factories.authored.mockReturnValueOnce(pending.promise);
    const abort = new AbortController();
    const loading = engine.setScene({ renderer: 'authored-boxes', scene: descriptor('pending'), signal: abort.signal });
    let rejection: unknown;
    const settled = loading.catch(error => { rejection = error; });
    await vi.waitFor(() => expect(factories.authored).toHaveBeenCalledTimes(2));
    if (action === 'abort') abort.abort('caller stopped');
    if (action === 'supersede') await engine.setScene({ renderer: 'authored-boxes', scene: descriptor('replacement') });
    if (action === 'clear') await engine.setScene(null);
    if (action === 'dispose') engine.dispose();
    const code = action === 'abort' ? 'SCENE_LOAD_ABORTED' : action === 'dispose' ? 'ENGINE_DISPOSED' : 'SCENE_LOAD_SUPERSEDED';
    await vi.waitFor(() => expect(rejection).toMatchObject({ code }));
    await settled; // The factory promise is still unresolved here: rejection must be prompt.
    if (action === 'abort') expect(engine.getTelemetry().scene).toEqual({ identity: first, firstSubmittedFrameId: 1, lastSubmittedFrameId: 1 });
    const active = engine.getTelemetry().scene.identity;
    const late = sceneMock(descriptor('pending')); pending.resolve(late);
    await vi.waitFor(() => expect(late.dispose).toHaveBeenCalledOnce());
    expect(engine.getTelemetry().scene.identity).toEqual(active);
  });

  it('preserves the committed scene when asynchronous creation rejects', async () => {
    const engine = await ready(); const first = await engine.setScene({ renderer: 'authored-boxes', scene: descriptor() });
    const failure = new Error('pipeline failed'); factories.authored.mockRejectedValueOnce(failure);
    await expect(engine.setScene({ renderer: 'authored-boxes', scene: descriptor('failed') })).rejects.toMatchObject({ code: 'SCENE_LOAD_FAILED', cause: failure });
    expect(engine.getTelemetry().scene.identity).toEqual(first); expect(created[0]!.dispose).not.toHaveBeenCalled();
    expect(engine.render().scene).toEqual(first);
  });

  it('assigns distinct generations to identical source revisions and keeps historical receipts immutable', async () => {
    const engine = await ready(); const input = descriptor('same-scene', 'opaque-unchanged-revision');
    const first = await engine.setScene({ renderer: 'authored-boxes', scene: input }); const firstFrame = engine.render();
    const second = await engine.setScene({ renderer: 'authored-boxes', scene: input });
    expect(second.sceneGeneration).toBe(first.sceneGeneration + 1);
    expect(second.sourceRevision).toBe(first.sourceRevision); expect(second.sceneId).toBe(first.sceneId);
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(second)).toBe(true);
    expect(firstFrame.scene).toEqual(first);
    expect(engine.getTelemetry().scene).toEqual({ identity: second, firstSubmittedFrameId: null, lastSubmittedFrameId: null });
    expect(engine.render()).toMatchObject({ frameId: 2, scene: second });
    expect(firstFrame.scene.sceneGeneration).toBe(first.sceneGeneration);
  });

  it('returns the historical commit even when another continuation already committed clear', async () => {
    const engine = await ready();
    const loading = engine.setScene({ renderer: 'authored-boxes', scene: descriptor() });
    const clearing = loading.then(() => engine.setScene(null));
    // The earlier-registered continuation clears synchronously before this await
    // resumes. The load receipt must still identify the scene that it committed.
    const receipt = await loading;
    expect(receipt).toEqual(identity(1, 'scene-a', 'revision-a'));
    expect(engine.getTelemetry().scene.identity).toEqual(identity(2, null, null, 'clear'));
    expect(await clearing).toEqual(identity(2, null, null, 'clear'));
  });

  it('reports a retirement failure after commitment and keeps both identity and cleanup ownership honest', async () => {
    const engine = await ready(); await engine.setScene({ renderer: 'authored-boxes', scene: descriptor('old') });
    engine.render(); const old = created[0]!; const failure = new Error('old dispose failed'); old.dispose.mockImplementationOnce(() => { throw failure; });
    let failureResult: unknown;
    try { await engine.setScene({ renderer: 'authored-boxes', scene: descriptor('new', 'new-revision') }); } catch (error) { failureResult = error; }
    expect(failureResult).toBeInstanceOf(SceneCommitError);
    const committed = identity(2, 'new', 'new-revision');
    expect(failureResult).toMatchObject({ code: 'SCENE_LOAD_FAILED', stage: 'retire', commitOccurred: true, committedScene: committed, cause: failure });
    expect(engine.getTelemetry().scene).toEqual({ identity: committed, firstSubmittedFrameId: null, lastSubmittedFrameId: null });
    expect(engine.render()).toMatchObject({ frameId: 2, scene: committed });
    expect(created[1]!.encode).toHaveBeenCalledOnce(); expect(old.encode).toHaveBeenCalledOnce();
    engine.dispose(); expect(old.dispose).toHaveBeenCalledTimes(2); expect(created[1]!.dispose).toHaveBeenCalledOnce();
  });

  it('commits clear identity even when retiring its previous renderer fails', async () => {
    const engine = await ready(); await engine.setScene({ renderer: 'authored-boxes', scene: descriptor() }); engine.render();
    created[0]!.dispose.mockImplementationOnce(() => { throw new Error('retire failed'); });
    await expect(engine.setScene(null)).rejects.toMatchObject({ stage: 'retire', committedScene: identity(2, null, null, 'clear') });
    expect(engine.getTelemetry().scene).toEqual({ identity: identity(2, null, null, 'clear'), firstSubmittedFrameId: null, lastSubmittedFrameId: null });
    expect(engine.render()).toMatchObject({ frameId: 2, scene: identity(2, null, null, 'clear'), drawCalls: 0 });
  });

  it('counts only successful submissions and does not manufacture first/last frame identities on failure', async () => {
    const engine = await ready(); const committed = await engine.setScene({ renderer: 'authored-boxes', scene: descriptor() });
    gpu.device.queue.submit.mockImplementationOnce(() => { throw new Error('queue refused'); });
    expect(() => engine.render()).toThrowError(expect.objectContaining({ code: 'RENDER_FAILED' }));
    expect(engine.getTelemetry()).toMatchObject({ submittedFrames: 0, scene: { identity: committed, firstSubmittedFrameId: null, lastSubmittedFrameId: null } });
    expect(engine.render()).toMatchObject({ frameId: 1, scene: committed });
    gpu.device.queue.submit.mockImplementationOnce(() => { throw new Error('queue refused again'); });
    expect(() => engine.render()).toThrow();
    expect(engine.getTelemetry()).toMatchObject({ submittedFrames: 1, scene: { identity: committed, firstSubmittedFrameId: 1, lastSubmittedFrameId: 1 } });
    expect(engine.render()).toMatchObject({ frameId: 2, scene: committed });
  });

  it('forwards a one-frame camera override and reports effective view metadata without replacing the scene', async () => {
    const engine = await ready(); const input = descriptor(); const committed = await engine.setScene({ renderer: 'authored-boxes', scene: input });
    const camera = descriptor().camera; camera.position = [.25, .5, 5]; camera.projection.verticalFovRadians = .8;
    engine.resize(768, 512);
    const frame = engine.render({ camera, timeSeconds: 4.5, debugView: 'base-color', temporal: false, cameraCut: true });
    expect(frame.scene).toEqual(committed);
    expect(frame.authored).toEqual({ camera, origin: [.25, .5, 5], aspect: 1.5, width: 768, height: 512, timeSeconds: 4.5, debugView: 'base-color' });
    expect(created[0]!.encode).toHaveBeenLastCalledWith(gpu.encoder, gpu.view, 768, 512, 4.5,
      expect.objectContaining({ camera, debugView: 'base-color', temporal: false }), undefined);
    camera.position[0] = 2;
    expect(frame.authored!.camera.position[0]).toBe(.25);
    expect(engine.render().authored).toMatchObject({ camera: input.camera, debugView: 'final', timeSeconds: 0 });
    expect(engine.getTelemetry().scene.identity).toEqual(committed); expect(factories.authored).toHaveBeenCalledOnce();
  });

  it('rejects unsupported authored controls before encoding or submitting', async () => {
    const engine = await ready(); await engine.setScene({ renderer: 'authored-boxes', scene: descriptor() });
    for (const controls of [{ temporal: true }, { debugView: 'normal' }, { gi: { enabled: false } }, { reflections: { mode: 'off' } }]) {
      expect(() => engine.render(controls as RenderOptions)).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_FEATURE' }));
    }
    expect(created[0]!.encode).not.toHaveBeenCalled(); expect(gpu.device.queue.submit).not.toHaveBeenCalled();
    expect(engine.getTelemetry().scene.firstSubmittedFrameId).toBeNull();
  });

  it('rejects a camera outside the profile bounds before beginning GPU encoding', async () => {
    const engine = await ready(); const committed = await engine.setScene({ renderer: 'authored-boxes', scene: descriptor() });
    const camera = descriptor().camera; camera.position[0] = 5000;
    expect(() => engine.render({ camera })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_LIMIT' }));
    expect(created[0]!.encode).not.toHaveBeenCalled(); expect(gpu.device.createCommandEncoder).not.toHaveBeenCalled();
    expect(gpu.device.queue.submit).not.toHaveBeenCalled();
    expect(engine.getTelemetry().scene).toEqual({ identity: committed, firstSubmittedFrameId: null, lastSubmittedFrameId: null });
  });

  it('rejects camera overrides for clear and legacy diffuse scenes', async () => {
    const engine = await ready(); const camera = descriptor().camera;
    expect(() => engine.render({ camera })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_FEATURE' }));
    const diffuse = { gpuBufferBytes: 0, gpuTextureBytes: 0, initialUploadBytes: 0, dispose: vi.fn(),
      encode: vi.fn(() => ({ drawCalls: 1, dispatchCalls: 0, triangles: 12, uploadBytes: 0 })) };
    factories.diffuse.mockResolvedValueOnce(diffuse);
    await engine.setScene({ renderer: 'diffuse' });
    expect(() => engine.render({ camera })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_FEATURE' }));
    expect(diffuse.encode).not.toHaveBeenCalled(); expect(gpu.device.queue.submit).not.toHaveBeenCalled();
  });

  it('rejects unsupported descriptor keys without allocating a renderer', async () => {
    const engine = await ready(); const input = { renderer: 'authored-boxes', scene: { ...descriptor(), shadows: true } };
    await expect(engine.setScene(input as unknown as SceneOptions)).rejects.toBeInstanceOf(StrataError);
    expect(factories.authored).not.toHaveBeenCalled(); expect(engine.getTelemetry().scene.identity.sceneGeneration).toBe(0);
  });
});
