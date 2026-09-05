export const geometrySelectionShader = /* wgsl */ `
struct SelectionFrame { viewProjection: mat4x4f, view: mat4x4f, parameters: vec4f, settings: vec4u, };
@group(0) @binding(0) var<storage, read> metadata: array<u32>;
@group(0) @binding(1) var<storage, read> residency: array<u32>;
@group(0) @binding(2) var<storage, read_write> selections: array<u32>;
@group(0) @binding(3) var<storage, read_write> triangles: array<u32>;
@group(0) @binding(4) var<storage, read_write> arguments: array<atomic<u32>>;
@group(0) @binding(5) var<uniform> selectionFrame: SelectionFrame;
fn vectorAt(offset: u32) -> vec3f {
  return vec3f(bitcast<f32>(metadata[offset]), bitcast<f32>(metadata[offset + 1u]), bitcast<f32>(metadata[offset + 2u]));
}
fn corner(minimum: vec3f, maximum: vec3f, index: u32) -> vec3f {
  return vec3f(select(minimum.x, maximum.x, (index & 1u) != 0u), select(minimum.y, maximum.y, (index & 2u) != 0u), select(minimum.z, maximum.z, (index & 4u) != 0u));
}
fn visibleBox(minimum: vec3f, maximum: vec3f) -> bool {
  var outside = array<u32, 6>(0u, 0u, 0u, 0u, 0u, 0u);
  for (var index = 0u; index < 8u; index++) {
    let clip = selectionFrame.viewProjection * vec4f(corner(minimum, maximum, index), 1.0);
    outside[0] += select(0u, 1u, clip.x < -clip.w); outside[1] += select(0u, 1u, clip.x > clip.w);
    outside[2] += select(0u, 1u, clip.y < -clip.w); outside[3] += select(0u, 1u, clip.y > clip.w);
    outside[4] += select(0u, 1u, clip.z < 0.0); outside[5] += select(0u, 1u, clip.z > clip.w);
  }
  for (var index = 0u; index < 6u; index++) { if (outside[index] == 8u) { return false; } }
  return true;
}
fn nearestDepth(minimum: vec3f, maximum: vec3f) -> f32 {
  var depth = 1e20;
  for (var index = 0u; index < 8u; index++) {
    depth = min(depth, -(selectionFrame.view * vec4f(corner(minimum, maximum, index), 1.0)).z);
  }
  return max(depth, 0.1);
}
fn completeLod(lod: u32) -> bool {
  let record = metadata[5] + lod * 8u;
  let pageStart = metadata[record + 2u];
  for (var index = 0u; index < metadata[record + 3u]; index++) {
    if (residency[metadata[metadata[7] + pageStart + index]] == 0xffffffffu) { return false; }
  }
  return true;
}
@compute @workgroup_size(64) fn selectTiles(@builtin(global_invocation_id) id: vec3u) {
  let tile = id.x;
  if (tile >= metadata[0]) { return; }
  let record = metadata[4] + tile * 12u;
  let minimum = vectorAt(record); let maximum = vectorAt(record + 4u);
  let visible = visibleBox(minimum, maximum);
  let depth = select(nearestDepth(minimum, maximum), 1.0, selectionFrame.settings.w != 0u);
  let firstLod = metadata[record + 8u]; let count = metadata[record + 9u];
  var desired = count - 1u;
  if (visible) {
    desired = 0u;
    if (selectionFrame.settings.y == 0u) {
      for (var level = i32(count) - 1; level >= 0; level--) {
        let error = bitcast<f32>(metadata[metadata[5] + (firstLod + u32(level)) * 8u + 4u]);
        if (error * selectionFrame.parameters.x / depth <= selectionFrame.parameters.y) { desired = u32(level); break; }
      }
    }
  }
  var selected = 0xffffffffu;
  for (var level = desired; level < count; level++) {
    if (completeLod(firstLod + level)) { selected = level; break; }
  }
  let base = tile * 8u;
  let previous = selections[base + 1u];
  selections[base] = desired; selections[base + 1u] = selected;
  selections[base + 2u] = select(0u, 1u, visible);
  selections[base + 3u] = select(0u, 1u, previous != selected || selectionFrame.settings.x != 0u);
  selections[base + 4u] = 0u;
  selections[base + 5u] = bitcast<u32>(1.0 / (depth + 1.0));
  if (selected == 0xffffffffu) { atomicAdd(&arguments[10], 1u); return; }
  let selectedError = bitcast<f32>(metadata[metadata[5] + (firstLod + selected) * 8u + 4u]);
  selections[base + 4u] = bitcast<u32>(selectedError * selectionFrame.parameters.x / depth);
  if (visible && selected != desired) { atomicAdd(&arguments[11], 1u); }
}

var<workgroup> mainBase: u32;
var<workgroup> shadowBase: u32;
var<workgroup> triangleCount: u32;
@compute @workgroup_size(128) fn compactClusters(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let cluster = group.x + group.y * 32768u;
  if (lane == 0u) {
    mainBase = 0xffffffffu; shadowBase = 0xffffffffu; triangleCount = 0u;
    if (cluster < metadata[2]) {
      let record = metadata[6] + cluster * 16u;
      let tile = metadata[record + 4u];
      if (selections[tile * 8u + 1u] == metadata[record + 5u]) {
        triangleCount = metadata[record + 3u];
        // All selected tiles cast shadows; offscreen tiles explicitly retain coarse geometry.
        shadowBase = atomicAdd(&arguments[4], triangleCount * 3u) / 3u;
        atomicAdd(&arguments[9], 1u);
        if (selections[tile * 8u + 2u] != 0u && visibleBox(vectorAt(record + 8u), vectorAt(record + 12u))) {
          mainBase = atomicAdd(&arguments[0], triangleCount * 3u) / 3u;
          atomicAdd(&arguments[8], 1u);
        }
        if (shadowBase + triangleCount > selectionFrame.settings.z) {
          atomicAdd(&arguments[12], 1u); atomicMin(&arguments[4], selectionFrame.settings.z * 3u); shadowBase = 0xffffffffu;
        }
        if (mainBase != 0xffffffffu && mainBase + triangleCount > selectionFrame.settings.z) {
          atomicAdd(&arguments[12], 1u); atomicMin(&arguments[0], selectionFrame.settings.z * 3u); mainBase = 0xffffffffu;
        }
      }
    }
  }
  workgroupBarrier();
  if (lane < triangleCount) {
    let code = (cluster << 7u) | lane;
    if (mainBase != 0xffffffffu) { triangles[mainBase + lane] = code; }
    if (shadowBase != 0xffffffffu) { triangles[selectionFrame.settings.z + shadowBase + lane] = code; }
  }
}
`;

/** Appended to the shared lighting shader; geometry is pulled from actual resident cooked pages. */
export const geometryVertexShader = /* wgsl */ `
@group(1) @binding(0) var<storage, read> geometryPool: array<u32>;
@group(1) @binding(1) var<storage, read> geometryMetadata: array<u32>;
@group(1) @binding(2) var<storage, read> geometryResidency: array<u32>;
@group(1) @binding(3) var<storage, read> geometryTriangles: array<u32>;
@group(1) @binding(4) var<storage, read> geometrySelections: array<u32>;
struct PulledVertex { position: vec3f, normal: vec3f, uv: vec2f, cluster: u32, };
fn pullGeometry(vertexIndex: u32) -> PulledVertex {
  let code = geometryTriangles[vertexIndex / 3u];
  let cluster = code >> 7u; let triangle = code & 127u;
  let record = geometryMetadata[6] + cluster * 16u;
  let pageBase = geometryResidency[geometryMetadata[record]] * geometryMetadata[9];
  let index = geometryPool[pageBase + geometryMetadata[record + 2u] + triangle * 3u + vertexIndex % 3u];
  let vertex = pageBase + geometryMetadata[record + 1u] + index * 8u;
  var result: PulledVertex;
  result.position = vec3f(bitcast<f32>(geometryPool[vertex]), bitcast<f32>(geometryPool[vertex + 1u]), bitcast<f32>(geometryPool[vertex + 2u]));
  result.normal = vec3f(bitcast<f32>(geometryPool[vertex + 3u]), bitcast<f32>(geometryPool[vertex + 4u]), bitcast<f32>(geometryPool[vertex + 5u]));
  result.uv = vec2f(bitcast<f32>(geometryPool[vertex + 6u]), bitcast<f32>(geometryPool[vertex + 7u]));
  result.cluster = cluster;
  return result;
}
fn clusterColor(id: u32) -> vec3f {
  let hash = (id + 1u) * 2654435761u;
  return vec3f(f32(hash & 255u), f32((hash >> 8u) & 255u), f32((hash >> 16u) & 255u)) / 340.0 + 0.2;
}
@vertex fn virtualShadowMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return frame.lightViewProjection * vec4f(pullGeometry(index).position, 1.0);
}
@vertex fn virtualVertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  let vertex = pullGeometry(index);
  let record = geometryMetadata[6] + vertex.cluster * 16u;
  let tile = geometryMetadata[record + 4u];
  let selected = geometrySelections[tile * 8u + 1u];
  let desired = geometrySelections[tile * 8u];
  let changed = geometrySelections[tile * 8u + 3u] != 0u;
  let position = vec4f(vertex.position, 1.0);
  var output: VertexOutput;
  output.currentClip = frame.viewProjection * position;
  output.previousClip = frame.previousViewProjection * position;
  output.position = output.currentClip;
  output.world = vertex.position; output.normal = vertex.normal; output.uv = vertex.uv;
  output.color = vec3f(0.31, 0.48, 0.19); output.metallic = 0.0; output.roughness = 0.85;
  output.viewDepths = vec2f(-(frame.view * position).z, select(-(frame.previousView * position).z, -1.0, changed));
  let debug = u32(frame.parameters.z + 0.5);
  output.debugColor = clusterColor(vertex.cluster);
  if (debug == 2u) { output.debugColor = clusterColor(selected * 7u); }
  if (debug == 3u) { output.debugColor = select(vec3f(0.95, 0.35, 0.05), vec3f(0.1, 0.85, 0.3), selected == desired); }
  if (debug == 4u) { output.debugColor = vec3f(1.0); }
  return output;
}
`;
