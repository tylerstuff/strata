import { readFile } from 'node:fs/promises';

const text = (value, fallback = '', limit = 2048) => typeof value === 'string' ? value.slice(0, limit) : fallback;
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 100).map(item => text(item)) : [];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function link(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function entryPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\\\0?#:]/.test(value)
    || !/\.(gltf|glb)$/i.test(value)) return null;
  const parts = value.split('/');
  return parts.every(part => part && part !== '.' && part !== '..') ? value : null;
}

/** A bounded presentation of local metadata, not proof of renderer support or resource identity. */
export async function readGalleryCatalog(assetRoot, containedFile, assetPrefix = '/external-assets/') {
  const result = { format: 'strata.gallery.catalog', version: 1, available: false, assets: [], diagnostics: [] };
  if (!assetRoot) {
    result.diagnostics.push('Set STRATA_BENCHMARK_ASSET_DIR to the external local collection, then restart the gallery.');
    return result;
  }
  let catalog;
  try {
    const file = await containedFile(assetRoot, 'catalog.json');
    if (!file || file.size > 2 * 1024 * 1024) throw new Error('Unavailable catalog');
    const bytes = await readFile(file.path);
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Oversized catalog');
    catalog = JSON.parse(bytes.toString('utf8'));
    if (!catalog || !Array.isArray(catalog.assets) || catalog.assets.length > 200) throw new Error('Invalid catalog');
  } catch {
    result.diagnostics.push('The external catalog is unavailable or invalid. Use a catalog.json containing at most 200 assets.');
    return result;
  }
  result.available = true;
  const ids = new Set();
  for (const asset of catalog.assets) {
    if (!asset || typeof asset !== 'object' || typeof asset.id !== 'string'
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(asset.id) || ids.has(asset.id)) {
      result.diagnostics.push('Skipped an asset with an invalid or duplicate ID.');
      continue;
    }
    ids.add(asset.id);
    const path = entryPath(asset.recommended_gltf);
    let file = null;
    if (path) try { file = await containedFile(assetRoot, path); } catch { /* Missing or uncontained entry. */ }
    const counts = asset.recommended_counts ?? {};
    const edges = strings(asset.recommended_texture_dimensions).flatMap(value => /^\d+x\d+$/.test(value) ? value.split('x').map(Number) : [])
      .filter(value => Number.isSafeInteger(value) && value > 0);
    result.assets.push({
      id: asset.id, title: text(asset.title, asset.id), category: text(asset.category), benchmarkUse: text(asset.benchmark_use),
      author: text(asset.archive_author_credit), license: text(asset.license),
      sourceUrl: link(asset.source_url), licenseUrl: link(asset.license_url),
      entryUrl: file ? `${assetPrefix}${path.split('/').map(encodeURIComponent).join('/')}` : null,
      sourceSha256: typeof asset.recommended_gltf_sha256 === 'string' && /^[a-f0-9]{64}$/i.test(asset.recommended_gltf_sha256)
        ? asset.recommended_gltf_sha256.toLowerCase() : null,
      triangles: count(counts.triangles_stored_mesh_primitives_once), meshCount: count(counts.meshes),
      textureMaxEdge: edges.length ? Math.max(...edges) : null,
      features: {
        requiredExtensions: strings(asset.recommended_extensions_required), usedExtensions: strings(asset.recommended_extensions_used),
        alphaModes: strings(asset.alpha_modes), skins: count(counts.skins) ?? 0, animations: count(counts.animations) ?? 0,
        morphTargets: count(counts.morph_target_entries_across_primitives) ?? 0,
      },
      notes: strings(asset.caveats), unavailableReason: file ? null : 'The recommended glTF entry is missing or outside the allowed collection.',
    });
  }
  return result;
}
