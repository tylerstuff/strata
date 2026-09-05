import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseGeometryManifest, type GeometryManifest } from '../../packages/core/src/geometry/format.js';
import { geometryDevice } from '../unit/geometry-fixture.js';

export interface CookedInitializationSource {
  readonly directory: string;
  readonly manifest: GeometryManifest;
  readonly manifestSha256: string;
  readonly url: URL;
  readonly pages: readonly Uint8Array<ArrayBuffer>[];
}

/** Uses the production cooker and parser; all generated assets remain in the OS temporary directory. */
export async function cookInitializationSource(seed: number, shape: { tiles: number; cells: number } = { tiles: 2, cells: 8 }): Promise<CookedInitializationSource> {
  const directory = await mkdtemp(join(tmpdir(), `strata-host-initialization-${seed}-`));
  try {
    execFileSync('cargo', ['run', '--quiet', '--locked', '--package', 'strata-geometry-cooker', '--',
      '--output', directory, '--tiles', String(shape.tiles), '--cells', String(shape.cells), '--seed', String(seed)],
    { cwd: resolve(import.meta.dirname, '../..'), timeout: 30_000 });
    const raw = await readFile(join(directory, 'manifest.json'));
    const manifest = parseGeometryManifest(JSON.parse(raw.toString('utf8')));
    const pages = await Promise.all(manifest.pages.map(async page => new Uint8Array(await readFile(join(directory, page.url)))));
    return { directory, manifest, manifestSha256: createHash('sha256').update(raw).digest('hex'), pages,
      url: new URL(`https://geometry.test/seed-${seed}/manifest.json`) };
  } catch (cause) {
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }
}

export function removeInitializationSource(source: CookedInitializationSource): Promise<void> {
  return rm(source.directory, { recursive: true, force: true });
}

export function initializationSourceReceipt(source: CookedInitializationSource) {
  const manifest = source.manifest;
  return { seed: manifest.source.seed, tilesPerSide: manifest.source.tilesPerSide, cellsPerTile: manifest.source.cellsPerTile,
    sourceTriangles: manifest.source.triangleCount, tiles: manifest.tiles.length, clusters: manifest.clusters.length,
    lodRecords: manifest.tiles.reduce((count, tile) => count + tile.lods.length, 0), pages: manifest.pages.length,
    rootPageIds: [...manifest.rootPageIds], pageBytes: manifest.pageBytes, manifestSha256: source.manifestSha256,
    pageHashes: manifest.pages.map(page => ({ id: page.id, sha256: page.sha256 })) };
}

/** Opt-in CPU evidence only: counts and hashes, with no cooked payloads or ordinary CI output. */
export async function writeInitializationReceipt(name: string, value: unknown): Promise<void> {
  const directory = process.env.STRATA_CPU_INITIALIZATION_REPORT_DIR;
  if (!directory) return;
  const repository = resolve(import.meta.dirname, '../..');
  const withinRepository = relative(repository, resolve(directory));
  const outsideRepository = withinRepository === '..' || withinRepository.startsWith(`..${sep}`) || isAbsolute(withinRepository);
  if (!isAbsolute(directory) || !outsideRepository) {
    throw new Error('STRATA_CPU_INITIALIZATION_REPORT_DIR must be an absolute directory outside the repository.');
  }
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.json`), `${JSON.stringify({ schema: 'strata-cpu-geometry-initialization-v1',
    execution: 'CPU only; real cooked pages and recording fake GPU queue; queue acceptance is not GPU completion', ...value as object }, null, 2)}\n`);
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

export interface ControlledPageRequest {
  readonly source: CookedInitializationSource;
  readonly pageId: number;
  readonly signal: AbortSignal | null;
  readonly settled: boolean;
  respond(options?: { corrupt?: boolean; status?: number }): void;
  openStream(): ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  reject(reason: Error): void;
}

/** Deliberately ignores abort until the caller settles the fetch, to exercise stale-work ownership. */
export function controlledCookedFetch(sources: readonly CookedInitializationSource[], automatic = false) {
  const requests: ControlledPageRequest[] = [];
  const fetchPages: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const source = sources.find(value => value.manifest.pages.some(page => new URL(page.url, value.url).href === url.href));
    if (!source) throw new Error(`Unexpected cooked page source: ${url.href}`);
    const pageId = source.manifest.pages.findIndex(page => new URL(page.url, source.url).href === url.href);
    if (pageId < 0) throw new Error(`Unexpected cooked page URL: ${url.href}`);
    const response = deferred<Response>();
    let settled = false;
    const request: ControlledPageRequest = {
      source, pageId, signal: init?.signal ?? null,
      get settled() { return settled; },
      respond(options = {}) {
        if (settled) throw new Error('Controlled page request settled twice.');
        settled = true;
        const bytes = source.pages[pageId]!.slice();
        if (options.corrupt) bytes[0] = bytes[0]! ^ 1;
        // Multiple reads exercise the production response-body reader and its length/hash checks.
        const body = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) {
          controller.enqueue(bytes.subarray(0, 173));
          controller.enqueue(bytes.subarray(173, 32_768));
          controller.enqueue(bytes.subarray(32_768));
          controller.close();
        } });
        response.resolve(new Response(body, { status: options.status ?? 200, headers: { 'content-length': String(bytes.byteLength) } }));
      },
      openStream() {
        if (settled) throw new Error('Controlled page request settled twice.');
        settled = true;
        let controller!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
        const body = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(value) { controller = value; } });
        response.resolve(new Response(body, { headers: { 'content-length': String(source.pages[pageId]!.byteLength) } }));
        return controller;
      },
      reject(reason) {
        if (settled) throw new Error('Controlled page request settled twice.');
        settled = true; response.reject(reason);
      },
    };
    requests.push(request);
    if (automatic) request.respond();
    return response.promise;
  };
  return { fetch: fetchPages, requests, get pending() { return requests.filter(request => !request.settled); } };
}

export interface GeometryWriteReceipt { readonly label: string; readonly offset: number; readonly bytes: Uint8Array<ArrayBuffer> }

/** Records actual queue calls, including typed-array data offsets and explicit element counts. */
export function recordingGeometryDevice() {
  const gpu = geometryDevice();
  const receipts: GeometryWriteReceipt[] = [];
  const write: GPUQueue['writeBuffer'] = (buffer, bufferOffset, data, dataOffset = 0, size) => {
    const typed = ArrayBuffer.isView(data);
    const elementBytes = typed && 'BYTES_PER_ELEMENT' in data ? Number(data.BYTES_PER_ELEMENT) : 1;
    const byteOffset = (typed ? data.byteOffset : 0) + dataOffset * elementBytes;
    const byteLength = size === undefined ? data.byteLength - dataOffset * elementBytes : size * elementBytes;
    const source = typed ? data.buffer : data;
    const bytes = new Uint8Array(source, byteOffset, byteLength).slice();
    const target = gpu.buffers.find(value => value === (buffer as unknown));
    if (!target) throw new Error('Queue write references an unowned test buffer.');
    target.bytes.set(bytes, bufferOffset);
    receipts.push({ label: target.label, offset: bufferOffset, bytes });
  };
  gpu.raw.queue.writeBuffer.mockImplementation(write as unknown as NonNullable<ReturnType<typeof gpu.raw.queue.writeBuffer.getMockImplementation>>);
  return { ...gpu, receipts };
}
