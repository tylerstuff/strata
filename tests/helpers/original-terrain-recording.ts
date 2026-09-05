/** Test-owned observation only. No runtime imports, scheduler, cache or rendering decisions. */
export const ORIGINAL_TERRAIN = Object.freeze({
  manifestSha256: '12e3946f079ae252d79509710631ea70b5abe14ce8f0119a04b4eb544eab0adf',
  tiles: 64, pages: 1199, pageBytes: 65536, poolBytes: 8388608, roots: 24,
  movingFrames: 3600, delayedFrames: 1201, maxImageBytes: 16 * 1024 * 1024,
  maxFrameEvidenceBytes: 33 * 1024 * 1024, maxCaseEvidenceBytes: 4 * 1024 ** 3,
});
export type TerrainPolicy = 'greedy' | 'retain-fallback';
export type TerrainPhase = 'B' | 'C';
const counterKeys = ['requestsStarted', 'requestsCompleted', 'requestsFailed', 'requestsCancelled',
  'evictions', 'uploadedPages', 'uploadedBytes', 'fetchedBytes', 'discardedCompletions'] as const;
export interface GeometrySnapshot {
  sourceFrameId: number | null;
  requestsStarted: number; requestsCompleted: number; requestsFailed: number; requestsCancelled: number;
  evictions: number; uploadedPages: number; uploadedBytes: number; fetchedBytes: number; discardedCompletions: number;
  poolBytes: number; residentPages: number; pendingRequests: number; stagingReservedBytes: number;
  coverageMissingTiles: number | null; overflowCount: number | null;
}
function require(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function integer(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  require(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max, `Invalid ${label}`);
}
function snapshot(value: GeometrySnapshot): GeometrySnapshot {
  require(value && typeof value === 'object', 'Missing geometry snapshot');
  for (const key of counterKeys) integer(value[key], key);
  for (const key of ['poolBytes','residentPages','pendingRequests','stagingReservedBytes'] as const) integer(value[key], key);
  for (const key of ['coverageMissingTiles','overflowCount'] as const) if (value[key] !== null) integer(value[key], key);
  if (value.sourceFrameId !== null) integer(value.sourceFrameId, 'geometry source frame');
  return structuredClone(value);
}
function delta(after: GeometrySnapshot, before: GeometrySnapshot) {
  return Object.fromEntries(counterKeys.map(key => {
    require(after[key] >= before[key], `Counter decreased: ${key}`);
    return [key, after[key] - before[key]];
  })) as Record<typeof counterKeys[number], number>;
}
/** Existing run end is drained; derive the measured end from the final actual frame. */
export function terrainTimingWindows(run: {
  frames: readonly { frameId: number; elapsedMs: number; geometry: GeometrySnapshot }[];
  assetTraffic: { geometryAtCaptureStart: GeometrySnapshot; geometryAtCaptureEnd: GeometrySnapshot };
}) {
  require(run.frames.length > 0, 'No measured frames');
  const start = snapshot(run.assetTraffic.geometryAtCaptureStart);
  let previousId = -1, previousElapsed = -1, previous = start;
  for (const frame of run.frames) {
    integer(frame.frameId, 'frame ID'); require(frame.frameId > previousId, 'Frame IDs must advance');
    require(Number.isFinite(frame.elapsedMs) && frame.elapsedMs > previousElapsed && frame.elapsedMs < 60000, 'Invalid measured time');
    const current = snapshot(frame.geometry); delta(current, previous);
    if (current.sourceFrameId !== null) require(current.sourceFrameId <= frame.frameId, 'Feedback is from the future');
    previousId = frame.frameId; previousElapsed = frame.elapsedMs; previous = current;
  }
  const drained = snapshot(run.assetTraffic.geometryAtCaptureEnd);
  return { captureStart: start, lastMeasured: previous, drained,
    measuredDelta: delta(previous, start), postMeasurementDrainDelta: delta(drained, previous),
    lastMeasuredFrameId: previousId, qualification: 'Counters follow CPU queue boundaries; geometry sourceFrameId may lag. Drain is excluded from measured totals.' };
}

export function terrainDiagnosticStep(phase: TerrainPhase, index: number) {
  const poses = [0, 9.6, 19.2, 28.8, 38.4, 48, 57.6];
  integer(index, 'diagnostic index', (phase === 'B' ? ORIGINAL_TERRAIN.movingFrames : ORIGINAL_TERRAIN.delayedFrames) - 1);
  require(phase === 'B' || phase === 'C', 'Unknown diagnostic phase');
  if (phase === 'B') return { index, timeSeconds: index / 60, cameraCut: false };
  if (index <= 120) return { index, timeSeconds: 0, cameraCut: index === 0 };
  const leg = Math.floor((index - 121) / 180), j = (index - 121) % 180 + 1;
  return { index, timeSeconds: j >= 60 ? poses[leg + 1]! : poses[leg]! + (poses[leg + 1]! - poses[leg]!) * j / 60,
    cameraCut: j === 60 };

}
export interface TerrainTopology {
  manifestSha256: string;
  /** Actual manifest page IDs, one dependency list per LOD per tile. */
  dependencies: readonly (readonly (readonly number[])[])[];
  rootPages: readonly number[];
}
export function reserveTerrainEvidence(used: number, added: number): number {
  integer(used, 'retained evidence bytes'); integer(added, 'frame evidence bytes');
  require(added <= ORIGINAL_TERRAIN.maxFrameEvidenceBytes && used + added <= ORIGINAL_TERRAIN.maxCaseEvidenceBytes, 'Evidence byte cap exceeded');
  return used + added;
}
export interface TerrainImageEvidence { index: number; frameId: number; png: Uint8Array; }
export interface TerrainFrameEvidence {
  index: number; frameId: number; feedbackSourceFrameId: number;
  timeSeconds: number; cameraCut: boolean;
  viewProjection: readonly number[];
  /** 64B arguments followed by 64 actual 32B selections, copied from native mapped feedback. */
  feedback: Uint32Array;
  /** Mapping belonging to this encode, not a later CPU cache. */
  residency: Uint32Array;
  geometry: GeometrySnapshot;
  pageUploadBytes: number;
  /** Exact requirements from imageRequirements(); at most previous/current. A browser retains a bounded canvas ring. */
  images: readonly TerrainImageEvidence[];
}
const digest = async (bytes: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer))]
  .map(value => value.toString(16).padStart(2, '0')).join('');
function pngSize(bytes: Uint8Array): [number, number] {
  require(bytes.length >= 33 && bytes.subarray(0, 8).every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i]), 'Missing PNG header');
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  require(d.getUint32(8) === 13 && String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR', 'Invalid PNG dimensions record');
  return [d.getUint32(16), d.getUint32(20)];
}
/** Bounded stream: return owned evidence for external persistence, retain no full-frame/image corpus in RAM. */
export class TerrainDiagnosticRecorder {
  private next = 0;
  private lastId = -1;
  private bytes = 0;
  private imageCount = 0;
  private previousSelected: Uint32Array | undefined;
  private previousImage = false;
  private nextImage = false;
  private closed = false;
  private failed = false;
  private busy = false;
  private readonly topology: TerrainTopology;
  readonly expectedFrames: number;
  constructor(readonly phase: TerrainPhase, readonly mode: 'streamed' | 'resident-full', readonly policy: TerrainPolicy,
    readonly width: number, readonly height: number, topology: TerrainTopology) {
    require(phase === 'B' || phase === 'C', 'Unknown phase');
    require(mode === 'streamed' || (mode === 'resident-full' && phase === 'B'), 'Invalid reference mode');
    require(policy === 'greedy' || policy === 'retain-fallback', 'Unknown policy');
    require(mode === 'streamed' || policy === 'greedy', 'Resident reference cannot request retention');
    require((width === 1280 && height === 720) || (width === 1920 && height === 1080), 'Original dimensions required');
    require(topology.manifestSha256 === ORIGINAL_TERRAIN.manifestSha256, 'Original manifest identity required');
    require(topology.dependencies.length === 64 && topology.rootPages.length === 24, 'Original topology required');
    for (const lods of topology.dependencies) {
      require(lods.length === 4, 'Original four LODs required');
      for (const pages of lods) {
        require(pages.length > 0 && new Set(pages).size === pages.length, 'Invalid LOD dependencies');
        pages.forEach(id => integer(id, 'dependency page', 1198));
      }
    }
    topology.rootPages.forEach(id => integer(id, 'root page', 1198));
    require(new Set(topology.rootPages).size === 24, 'Duplicate roots');
    this.topology = structuredClone(topology);
    this.expectedFrames = phase === 'B' ? ORIGINAL_TERRAIN.movingFrames : ORIGINAL_TERRAIN.delayedFrames;
  }
  /** Inspect actual current feedback while the previous/current canvases are still retained. No state advances. */
  imageRequirements(feedback: Uint32Array) {
    require(!this.closed && !this.failed && this.next < this.expectedFrames, 'Recorder unavailable');
    require(feedback instanceof Uint32Array && feedback.length === 528, 'Exact native feedback layout required');
    const selected = Uint32Array.from({ length: 64 }, (_, tile) => feedback[17 + tile * 8]!);
    for (const lod of selected) integer(lod, 'selected LOD', 3);
    const transition = this.previousSelected !== undefined && selected.some((lod, tile) => lod !== this.previousSelected![tile]);
    const current = this.phase === 'C' || this.next % 6 === 0 || this.nextImage || transition;
    return { selectedLodTransition: transition, indices: [
      ...(this.phase === 'B' && transition && !this.previousImage ? [this.next - 1] : []),
      ...(current ? [this.next] : []),
    ] };
  }
  async record(input: TerrainFrameEvidence) {
    if (this.busy) this.failed = true;
    require(!this.closed && !this.failed && !this.busy, 'Recorder is closed, failed or busy');
    this.busy = true;
    try {
      const s = terrainDiagnosticStep(this.phase, this.next);
      require(input.index === this.next && input.timeSeconds === s.timeSeconds && input.cameraCut === s.cameraCut, 'Skipped or changed frozen step');
      integer(input.frameId, 'frame ID'); require(this.next === 0 || input.frameId === this.lastId + 1, 'Native frame IDs must be consecutive');
      require(input.feedbackSourceFrameId === input.frameId, 'Stale/mismatched evidence');
      require(input.viewProjection.length === 16 && input.viewProjection.every(Number.isFinite), 'Missing actual camera matrix');
      require(input.feedback instanceof Uint32Array && input.feedback.length === 16 + 64 * 8, 'Exact native feedback layout required');
      require(input.residency instanceof Uint32Array && input.residency.length === 1199, 'Exact encode residency map required');
      const requirements = this.imageRequirements(input.feedback);
      require(Array.isArray(input.images) && input.images.length === requirements.indices.length, 'Missing or extra required images');
      const images = input.images.map((image, i) => {
        require(image.index === requirements.indices[i] && image.frameId === input.frameId + image.index - input.index, 'Stale/mismatched required image');
        require(image.png instanceof Uint8Array && image.png.length <= ORIGINAL_TERRAIN.maxImageBytes, 'Image cap exceeded');
        const [width, height] = pngSize(image.png); require(width === this.width && height === this.height, 'Image resolution mismatch');
        return { index: image.index, frameId: image.frameId, png: image.png.slice() };
      });
      require(this.imageCount + images.length <= this.expectedFrames, 'Required image count cap exceeded');
      const slots = new Set<number>(); const capacity = this.mode === 'streamed' ? 128 : 1199;
      for (const slot of input.residency) if (slot !== 0xffffffff) { integer(slot, 'resident slot', capacity - 1); require(!slots.has(slot), 'Aliased physical page slot'); slots.add(slot); }
      for (const page of this.topology.rootPages) require(input.residency[page] !== 0xffffffff, 'Missing pinned root');
      const state = snapshot(input.geometry);
      require(state.poolBytes === capacity * 65536 && state.residentPages === slots.size, 'Pool/mapping disagreement');
      require(state.pendingRequests <= 4 && state.stagingReservedBytes <= 262144, 'Request/staging bound exceeded');
      require(state.requestsFailed === 0 && state.coverageMissingTiles === 0 && state.overflowCount === 0, 'Coverage/overflow/page failure');
      integer(input.pageUploadBytes, 'page upload bytes', 262144);
      require(input.pageUploadBytes % 65536 === 0, 'Page payload must be whole pages');
      let visible = 0, missing = 0, finer = 0;
      const selections: { tile: number; desired: number; selected: number; visible: boolean; changed: boolean; projectedErrorBound: number; priority: number }[] = [];
      const floats = new Float32Array(input.feedback.buffer, input.feedback.byteOffset, input.feedback.length);
      for (let tile = 0; tile < 64; tile++) {
        const b = 16 + tile * 8, desired = input.feedback[b]!, selected = input.feedback[b + 1]!, v = input.feedback[b + 2]!, changed = input.feedback[b + 3]!;
        integer(desired, 'desired LOD', 3); integer(selected, 'selected LOD', 3); integer(v, 'visible flag', 1); integer(changed, 'change flag', 1);
        for (const p of this.topology.dependencies[tile]![selected]!) require(input.residency[p] !== 0xffffffff, 'Selected LOD has absent dependency');
        if (this.mode === 'resident-full') require(selected === 0, 'Reference must remain finest including offscreen casters');
        require(Number.isFinite(floats[b + 4]) && floats[b + 4]! >= 0 && Number.isFinite(floats[b + 5]) && floats[b + 5]! >= 0, 'Invalid selection float');
        visible += v; missing += Number(v === 1 && selected > desired); finer += Number(v === 1 && selected < desired);
        selections.push({ tile, desired, selected, visible: Boolean(v), changed: Boolean(changed), projectedErrorBound: floats[b + 4]!, priority: floats[b + 5]! });
      }
      require(input.feedback[10] === 0 && input.feedback[11] === missing && input.feedback[12] === 0, 'GPU aggregate/selection mismatch');
      const bytes = input.feedback.byteLength + input.residency.byteLength + images.reduce((sum, image) => sum + image.png.byteLength, 0) + 16 * 8;
      reserveTerrainEvidence(this.bytes, bytes);
      // Snapshot before the asynchronous hash: caller/native unmap/reuse cannot alter evidence.
      const feedback = input.feedback.slice(), residency = input.residency.slice();
      const selected = Uint32Array.from({ length: 64 }, (_, tile) => feedback[17 + tile * 8]!);
      const result = { step: s, frameId: input.frameId, feedbackSourceFrameId: input.feedbackSourceFrameId,
        viewProjection: [...input.viewProjection], geometry: state,
        visibleTiles: visible, missingDetailTiles: missing, finerFallbackTiles: finer, selections,
        feedback, residency, selectedLodTransition: requirements.selectedLodTransition,
        images: await Promise.all(images.map(async image => ({ ...image, pngSha256: await digest(image.png) }))), bytes,
        imageValidation: 'signature-dimensions-sha256-only; complete decode/actual-render origin remain browser-runner gates' };
      require(!this.closed && !this.failed, 'Late record after cancellation or failure');
      this.next++; this.lastId = result.frameId; this.bytes += bytes;
      this.imageCount += result.images.length;
      this.previousSelected = selected;
      this.previousImage = requirements.indices.includes(result.step.index);
      this.nextImage = this.phase === 'B' && requirements.selectedLodTransition;
      return result;
    } catch (error) { this.failed = true; throw error; }
    finally { this.busy = false; }
  }
  cancel(): void { this.closed = true; this.failed = true; }
  complete(cleanup: { disposed: boolean; buffers: number; textures: number; wasm: number; pendingRequests: number; pendingReadbacks: number; errors: readonly string[] }) {
    require(!this.closed && !this.failed && !this.busy && this.next === this.expectedFrames, 'Incomplete or failed diagnostic');
    require(cleanup.disposed && ['buffers', 'textures', 'wasm', 'pendingRequests', 'pendingReadbacks'].every(k => cleanup[k as keyof typeof cleanup] === 0) && cleanup.errors.length === 0, 'Cleanup evidence incomplete');
    this.closed = true;
    // Keep the frozen capture span: a final-frame transition has no successor receipt.
    const boundaryCensoredBrackets = this.phase === 'B' && this.nextImage
      ? [{ transitionIndex: this.expectedFrames - 1, missingIndex: this.expectedFrames }] : [];
    return { status: 'complete' as const, frames: this.next, images: this.imageCount, bytes: this.bytes,
      boundaryCensoredBrackets, fullBracketCoverage: boundaryCensoredBrackets.length === 0,
      cleanup: structuredClone(cleanup), qualityAccepted: false };
  }
  get progress() { return { frames: this.next, images: this.imageCount, bytes: this.bytes, failed: this.failed, closed: this.closed }; }
}

/** Observe native feedback: retain native buffer/promise/arguments; capture the ticket at map invocation. */
export function observeTerrainFeedback(buffer: Pick<GPUBuffer, 'label' | 'size' | 'mapAsync' | 'getMappedRange'>,
  context: () => { frameId: number; generation: number }, emit: (e: { frameId: number; generation: number; bytes: ArrayBuffer }) => void) {
  require(/^Strata geometry feedback [0-3]$/.test(buffer.label) && buffer.size === 2112, 'Wrong original feedback buffer');
  const originals = new Map(['mapAsync', 'getMappedRange'].map(k => [k, Object.getOwnPropertyDescriptor(buffer, k)]));
  const nativeMap = buffer.mapAsync.bind(buffer), nativeRead = buffer.getMappedRange.bind(buffer);
  let active = true, receipt: { frameId: number; generation: number } | undefined;
  const errors: string[] = [];
  const restore = () => { active = false; for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(buffer, key, descriptor); else Reflect.deleteProperty(buffer, key);
  } };
  try {
    Object.defineProperty(buffer, 'mapAsync', { configurable: true, value: (...args: Parameters<GPUBuffer['mapAsync']>) => {
      if (active) {
        const c = context(); integer(c.frameId, 'feedback context frame'); integer(c.generation, 'feedback generation');
        receipt = { ...c };
      }
      return nativeMap(...args);
    } });
    Object.defineProperty(buffer, 'getMappedRange', { configurable: true, value: (...args: Parameters<GPUBuffer['getMappedRange']>) => {
      const mapped = nativeRead(...args);
      if (active) {
        try {
          require(receipt, 'Feedback read without an admitted map invocation');
          require(args.length === 0 || (args[0] === 0 && (args[1] === undefined || args[1] === 2112)), 'Unexpected feedback subrange');
          emit({ ...receipt, bytes: mapped.slice(0) }); receipt = undefined;
        } catch (e) { errors.push(String(e)); throw e; }
      }
      return mapped;
    } });
  } catch (e) { restore(); throw e; }
  return { detach: restore, get errors(): readonly string[] { return [...errors]; } };
}
