/** Normalized gallery HTTP transport only; external catalog parsing belongs to the server. */
export interface GalleryAssetFeatures {
  requiredExtensions: string[];
  usedExtensions: string[];
  alphaModes: string[];
  skins: number;
  animations: number;
  morphTargets: number;
}

export interface GalleryAsset {
  id: string;
  title: string;
  category: string;
  benchmarkUse: string;
  author: string;
  license: string;
  sourceUrl: string | null;
  licenseUrl: string | null;
  entryUrl: string | null;
  sourceSha256: string | null;
  triangles: number | null;
  meshCount: number | null;
  textureMaxEdge: number | null;
  features: GalleryAssetFeatures;
  notes: string[];
  unavailableReason: string | null;
}

export interface GalleryCatalog {
  format: 'strata.gallery.catalog';
  version: 1;
  available: boolean;
  assets: GalleryAsset[];
  diagnostics: string[];
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ASSETS = 1024;
const MAX_TEXT_LENGTH = 16_384;
const MAX_TEXT_ITEMS = 256;
const preferredIds = [
  'light_fury',
  'detardeurus',
  'old_lantern_game_ready_asset',
  'old_house__ruin__photoscan_asset',
  'stylized_berry_plant_pack_lowpoly_game_ready',
  'fox',
  'casual_man_character',
];

function invalid(path: string, expectation: string): never {
  throw new Error(`Invalid gallery catalog at ${path}: ${expectation}.`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'expected an object');
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) invalid(path, `expected text no longer than ${MAX_TEXT_LENGTH} characters`);
  return value;
}

function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

function textList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_TEXT_ITEMS) invalid(path, `expected an array of at most ${MAX_TEXT_ITEMS} strings`);
  return value.map((item, index) => text(item, `${path}/${index}`));
}

function count(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(path, 'expected a nonnegative safe integer');
  return value;
}

function nullableCount(value: unknown, path: string): number | null {
  return value === null ? null : count(value, path);
}

/** Unsafe attribution is omitted; titles, authors and license text remain ordinary data. */
function attribution(value: unknown, path: string): string | null {
  const candidate = nullableText(value, path);
  if (candidate === null) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : null;
  } catch { return null; }
}

function entry(value: unknown, origin: string, path: string): string | null {
  const candidate = nullableText(value, path);
  if (candidate === null) return null;
  let url: URL;
  try { url = new URL(candidate, `${origin}/`); }
  catch { return invalid(path, 'expected a contained same-origin asset URL or null'); }
  const prefix = ['/external-assets/', '/procedural-gallery-assets/'].find(prefix => url.pathname.startsWith(prefix));
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)
    || url.username !== '' || url.password !== '' || !prefix) {
    invalid(path, 'asset URL must resolve under a contained same-origin asset route');
  }
  // Do not let encoded path separators turn an approved URL prefix into another
  // route when the server decodes it. Server filesystem confinement is separate.
  const segments = url.pathname.slice(prefix.length).split('/');
  if (segments.length === 0 || segments.some(segment => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === '' || decoded === '.' || decoded === '..' || /[\\/\u0000]/.test(decoded);
    } catch { return true; }
  })) invalid(path, 'expected nonempty asset path segments without encoded separators');
  return url.href;
}

function parseCatalog(value: unknown, origin: string): GalleryCatalog {
  const catalog = record(value, '/');
  if (catalog.format !== 'strata.gallery.catalog') invalid('/format', 'expected strata.gallery.catalog');
  if (catalog.version !== 1) invalid('/version', 'expected supported catalog version 1');
  if (typeof catalog.available !== 'boolean') invalid('/available', 'expected a boolean');
  if (!Array.isArray(catalog.assets) || catalog.assets.length > MAX_ASSETS) invalid('/assets', `expected at most ${MAX_ASSETS} assets`);
  const ids = new Set<string>();
  const assets = catalog.assets.map((value, index): GalleryAsset => {
    const path = `/assets/${index}`;
    const asset = record(value, path);
    const id = text(asset.id, `${path}/id`);
    if (id.length === 0 || id.length > 256 || ids.has(id)) invalid(`${path}/id`, 'expected a unique nonempty ID no longer than 256 characters');
    ids.add(id);
    const features = record(asset.features, `${path}/features`);
    const sourceSha256 = nullableText(asset.sourceSha256, `${path}/sourceSha256`);
    if (sourceSha256 !== null && (sourceSha256.length !== 64 || !/^[a-fA-F0-9]{64}$/.test(sourceSha256))) invalid(`${path}/sourceSha256`, 'expected a 64-digit SHA256 or null');
    return {
      id, title: text(asset.title, `${path}/title`), category: text(asset.category, `${path}/category`),
      benchmarkUse: text(asset.benchmarkUse, `${path}/benchmarkUse`),
      author: text(asset.author, `${path}/author`), license: text(asset.license, `${path}/license`),
      sourceUrl: attribution(asset.sourceUrl, `${path}/sourceUrl`), licenseUrl: attribution(asset.licenseUrl, `${path}/licenseUrl`),
      entryUrl: entry(asset.entryUrl, origin, `${path}/entryUrl`), sourceSha256,
      triangles: nullableCount(asset.triangles, `${path}/triangles`),
      meshCount: nullableCount(asset.meshCount, `${path}/meshCount`), textureMaxEdge: nullableCount(asset.textureMaxEdge, `${path}/textureMaxEdge`),
      features: {
        requiredExtensions: textList(features.requiredExtensions, `${path}/features/requiredExtensions`),
        usedExtensions: textList(features.usedExtensions, `${path}/features/usedExtensions`),
        alphaModes: textList(features.alphaModes, `${path}/features/alphaModes`),
        skins: count(features.skins, `${path}/features/skins`), animations: count(features.animations, `${path}/features/animations`),
        morphTargets: count(features.morphTargets, `${path}/features/morphTargets`),
      },
      notes: textList(asset.notes, `${path}/notes`), unavailableReason: nullableText(asset.unavailableReason, `${path}/unavailableReason`),
    };
  });
  return { format: 'strata.gallery.catalog', version: 1, available: catalog.available, assets, diagnostics: textList(catalog.diagnostics, '/diagnostics') };
}

/** Fetch a bounded normalized response; unavailable catalogs are valid results. */
export async function loadGalleryCatalog(signal?: AbortSignal): Promise<GalleryCatalog> {
  signal?.throwIfAborted();
  const origin = globalThis.location.origin;
  const response = await fetch('/api/gallery/catalog', { ...(signal === undefined ? {} : { signal }), cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Gallery catalog request failed with HTTP ${response.status}.`);
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Gallery catalog response exceeds ${MAX_RESPONSE_BYTES} bytes.`);
  }
  if (!response.body) throw new Error('Gallery catalog response has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, json = '';
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error(`Gallery catalog response exceeds ${MAX_RESPONSE_BYTES} bytes.`);
      json += decoder.decode(chunk.value, { stream: true });
    }
    json += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { throw new Error('Gallery catalog response is not valid JSON.'); }
  return parseCatalog(parsed, origin);
}

/** Stable initial sequence; other assets retain the server's order. Never mutates input. */
export function orderedGalleryAssets(catalog: GalleryCatalog): GalleryAsset[] {
  const priority = new Map(preferredIds.map((id, index) => [id, index]));
  return [...catalog.assets].sort((a, b) => (priority.get(a.id) ?? preferredIds.length) - (priority.get(b.id) ?? preferredIds.length));
}
