import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { loadGalleryCatalog, orderedGalleryAssets } from './catalog.ts';

const originalFetch = globalThis.fetch;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
beforeEach(() => { Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'http://localhost:4173' } }); });
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  else delete globalThis.location;
});

function asset(id = 'fixture') {
  return {
    id, title: '<img src=x onerror=alert(1)>', category: 'fixture', benchmarkUse: 'CPU transport test', author: 'Example author', license: 'Example license',
    sourceUrl: 'https://example.com/source', licenseUrl: 'https://example.com/license',
    entryUrl: `/external-assets/${id}/scene.gltf`, sourceSha256: 'a'.repeat(64), triangles: 12, meshCount: 1, textureMaxEdge: 256,
    features: { requiredExtensions: [], usedExtensions: ['KHR_materials_unlit'], alphaModes: ['OPAQUE'], skins: 0, animations: 0, morphTargets: 0 },
    notes: ['Text stays data.'], unavailableReason: null,
  };
}
function catalog(assets = [asset()]) { return { format: 'strata.gallery.catalog', version: 1, available: true, assets, diagnostics: [] }; }
function respond(value, init) { globalThis.fetch = async () => new Response(JSON.stringify(value), init); }

test('loads normalized transport, resolves local entry and retains text without interpreting it', async () => {
  const input = catalog();
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/gallery/catalog');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(input));
  };
  const loaded = await loadGalleryCatalog();
  assert.equal(loaded.assets[0].entryUrl, 'http://localhost:4173/external-assets/fixture/scene.gltf');
  assert.equal(loaded.assets[0].title, input.assets[0].title);
  assert.deepEqual(loaded.assets[0].features, input.assets[0].features);
  assert.deepEqual([loaded.assets[0].meshCount, loaded.assets[0].textureMaxEdge], [1, 256]);
});

test('valid unavailable catalog and asset preserve reasons and null metadata', async () => {
  const input = catalog([{ ...asset(), entryUrl: null, sourceSha256: null, triangles: null, meshCount: null, textureMaxEdge: null, unavailableReason: 'External collection is not configured.' }]);
  input.available = false; input.diagnostics = ['Choose an external asset directory.'];
  respond(input);
  assert.deepEqual(await loadGalleryCatalog(), input);
});

test('accepts the separate generated-fixture route without allowing neighboring routes', async () => {
  respond(catalog([{ ...asset(), entryUrl: '/procedural-gallery-assets/fixture-red.gltf' }]));
  assert.equal((await loadGalleryCatalog()).assets[0].entryUrl, 'http://localhost:4173/procedural-gallery-assets/fixture-red.gltf');
  for (const entryUrl of ['/procedural-gallery-assets-private/model.gltf', '/procedural-gallery-assets/%2fprivate', '/procedural-gallery-assets/']) {
    respond(catalog([{ ...asset(), entryUrl }]));
    await assert.rejects(loadGalleryCatalog(), /Invalid gallery catalog/);
  }
});

test('unsafe attribution links become null while safe HTTPS links survive', async () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'http://example.com', '/local', 'https://user:secret@example.com', 'invalid']) {
    respond(catalog([{ ...asset(), sourceUrl: url, licenseUrl: url }]));
    const result = await loadGalleryCatalog();
    assert.equal(result.assets[0].sourceUrl, null);
    assert.equal(result.assets[0].licenseUrl, null);
  }
});

test('entry URLs cannot escape same-origin external-assets or hide path separators', async () => {
  for (const url of ['https://example.com/external-assets/fixture.gltf', '//example.com/external-assets/fixture.gltf',
    '/api/gallery/catalog', '/external-assets/../private', '/external-assets/%2e%2e/private',
    '/external-assets/a%2f..%2fprivate', '/external-assets/a%5cprivate', '/external-assets/%00.gltf',
    '/external-assets/%invalid', '/external-assets/', 'javascript:alert(1)', 'http://user:password@localhost:4173/external-assets/a.gltf']) {
    respond(catalog([{ ...asset(), entryUrl: url }]));
    await assert.rejects(loadGalleryCatalog(), /Invalid gallery catalog at \/assets\/0\/entryUrl/);
  }
});

test('requires transport version and required field types; rejects duplicate IDs', async () => {
  const changes = [
    value => { delete value.format; }, value => { value.version = 2; }, value => { value.available = 'yes'; },
    value => { value.assets.push(asset()); }, value => { value.assets[0].id = ''; },
    value => { value.assets[0].triangles = -1; }, value => { value.assets[0].meshCount = 1.5; },
    value => { delete value.assets[0].textureMaxEdge; }, value => { value.assets[0].sourceSha256 = 'not-a-digest'; },
    value => { value.assets[0].features.animations = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.assets[0].features.requiredExtensions = [2]; }, value => { value.assets[0].notes = 'text'; },
  ];
  for (const change of changes) {
    const value = catalog(); change(value); respond(value);
    await assert.rejects(loadGalleryCatalog(), /Invalid gallery catalog/);
  }
});

test('enforces response bytes even when content-length is absent or misleading', async () => {
  const oversized = new Uint8Array(2 * 1024 * 1024 + 1).fill(32);
  for (const headers of [{}, { 'content-length': '10' }]) {
    globalThis.fetch = async () => new Response(oversized, { headers });
    await assert.rejects(loadGalleryCatalog(), /exceeds 2097152 bytes/);
  }
  let canceled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'content-length': String(oversized.length) } });
  await assert.rejects(loadGalleryCatalog(), /exceeds 2097152 bytes/);
  assert.equal(canceled, true);
});

test('bounds asset/list/text sizes after parsing', async () => {
  for (const value of [catalog(Array.from({ length: 1025 }, (_, i) => asset(`asset-${i}`))),
    catalog([{ ...asset(), title: 'x'.repeat(16385) }]), catalog([{ ...asset(), notes: Array(257).fill('x') }])]) {
    respond(value);
    await assert.rejects(loadGalleryCatalog(), /Invalid gallery catalog/);
  }
});

test('rejects HTTP errors, invalid JSON and malformed UTF-8', async () => {
  respond({}, { status: 503 });
  await assert.rejects(loadGalleryCatalog(), /HTTP 503/);
  globalThis.fetch = async () => new Response('{invalid');
  await assert.rejects(loadGalleryCatalog(), /not valid JSON/);
  globalThis.fetch = async () => new Response(new Uint8Array([0xff]));
  await assert.rejects(loadGalleryCatalog(), TypeError);
});

test('respects cancellation before fetching and between response chunks', async () => {
  const before = new AbortController(); before.abort();
  globalThis.fetch = () => assert.fail('Aborted request must not fetch');
  await assert.rejects(loadGalleryCatalog(before.signal), { name: 'AbortError' });
  const during = new AbortController(); let canceled = false;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.signal, during.signal);
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode('{')); during.abort(); },
      cancel() { canceled = true; },
    }));
  };
  await assert.rejects(loadGalleryCatalog(during.signal), { name: 'AbortError' });
  assert.equal(canceled, true);
});

test('orders exact priority IDs, preserves remaining order and never mutates the catalog', () => {
  const ids = ['person-other', 'fox', 'casual_man_character', 'other-lantern', 'old_house__ruin__photoscan_asset',
    'old_lantern_game_ready_asset', 'stylized_berry_plant_pack_lowpoly_game_ready', 'last', 'detardeurus', 'light_fury'];
  const input = catalog(ids.map(asset));
  const ordered = orderedGalleryAssets(input);
  assert.deepEqual(ordered.map(value => value.id), ['light_fury', 'detardeurus', 'old_lantern_game_ready_asset', 'old_house__ruin__photoscan_asset',
    'stylized_berry_plant_pack_lowpoly_game_ready', 'fox', 'casual_man_character', 'person-other', 'other-lantern', 'last']);
  assert.deepEqual(input.assets.map(value => value.id), ids);
  assert.notEqual(ordered, input.assets);
});
