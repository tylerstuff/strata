mod certified_lod;
mod hash;
mod trace_proxy;
pub use trace_proxy::{CookedTraceProxy, cook_trace_proxy, write_trace_proxy};

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;
use std::fs;
use std::io;
use std::path::Path;

pub const PAGE_BYTES: usize = 65536;
const CLUSTER_TRIANGLES: usize = 128;
const HESSIAN_BOUND: f64 = 0.07;

/// Opt-in recipes keep existing cooked asset identities unchanged by default.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LodProfile {
    #[default]
    Legacy,
    Certified,
}
impl LodProfile {
    fn steps(self, config: Config) -> Vec<usize> {
        match self {
            Self::Legacy => config.steps(),
            Self::Certified => [1, 2, 4, 8, 16, 32, 64, 128]
                .into_iter()
                .filter(|step| *step <= config.cells)
                .collect(),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub seed: u32,
    pub tiles: usize,
    pub cells: usize,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            seed: 1337,
            tiles: 8,
            cells: 128,
        }
    }
}
impl Config {
    pub fn validate(self) -> Result<Self, String> {
        if !(1..=16).contains(&self.tiles)
            || !(8..=128).contains(&self.cells)
            || !self.cells.is_power_of_two()
        {
            return Err("Use 1–16 tiles per side and a power-of-two 8–128 cells per tile.".into());
        }
        Ok(self)
    }
    fn steps(self) -> Vec<usize> {
        let mut steps: Vec<_> = [1, 8, 32, 128]
            .into_iter()
            .filter(|step| *step <= self.cells)
            .collect();
        if *steps.last().unwrap() != self.cells {
            steps.push(self.cells);
        }
        steps
    }
    fn extent(self) -> f64 {
        (self.tiles * self.cells) as f64
    }
}

#[derive(Clone, Copy, Debug)]
struct Vertex {
    position: [f32; 3],
    normal: [f32; 3],
    uv: [f32; 2],
}
impl Vertex {
    fn bytes(self, target: &mut Vec<u8>) {
        for channel in self.position.into_iter().chain(self.normal).chain(self.uv) {
            target.extend_from_slice(&channel.to_le_bytes());
        }
    }
}
#[derive(Clone, Debug)]
struct Mesh {
    vertices: Vec<Vertex>,
    indices: Vec<u32>,
}

fn height(x: f64, z: f64, seed: u32) -> (f64, f64, f64) {
    let phase = f64::from(seed % 1024) * std::f64::consts::TAU / 1024.0;
    let a = x / 19.0 + phase;
    let b = z / 13.0 - phase;
    let c = (x + z) / 9.0 + phase * 0.5;
    (
        6.0 * a.sin() + 3.0 * b.cos() + 2.0 * c.sin(),
        6.0 / 19.0 * a.cos() + 2.0 / 9.0 * c.cos(),
        -3.0 / 13.0 * b.sin() + 2.0 / 9.0 * c.cos(),
    )
}
fn vertex(config: Config, global_x: usize, global_z: usize) -> Vertex {
    let x = global_x as f64 - config.extent() * 0.5;
    let z = global_z as f64 - config.extent() * 0.5;
    let (y, dx, dz) = height(x, z, config.seed);
    let inverse = 1.0 / (dx * dx + 1.0 + dz * dz).sqrt();
    Vertex {
        position: [x as f32, y as f32, z as f32],
        normal: [
            (-dx * inverse) as f32,
            inverse as f32,
            (-dz * inverse) as f32,
        ],
        uv: [(x / 16.0) as f32, (z / 16.0) as f32],
    }
}
fn mesh(config: Config, tile: usize, step: usize) -> Mesh {
    let cells = config.cells;
    let origin_x = tile % config.tiles * cells;
    let origin_z = tile / config.tiles * cells;
    let mut result = Mesh {
        vertices: Vec::new(),
        indices: Vec::new(),
    };
    if step == 1 {
        for z in 0..=cells {
            for x in 0..=cells {
                result
                    .vertices
                    .push(vertex(config, origin_x + x, origin_z + z));
            }
        }
        // Coherent 8x8-cell clusters avoid long strip duplication in the finest source.
        for block_z in (0..cells).step_by(8) {
            for block_x in (0..cells).step_by(8) {
                for z in block_z..block_z + 8 {
                    for x in block_x..block_x + 8 {
                        let a = (z * (cells + 1) + x) as u32;
                        let b = a + (cells + 1) as u32;
                        result
                            .indices
                            .extend_from_slice(&[a, b, b + 1, a, b + 1, a + 1]);
                    }
                }
            }
        }
        return result;
    }
    let mut ids = BTreeMap::new();
    let mut add = |x: usize, z: usize| -> u32 {
        *ids.entry((x, z)).or_insert_with(|| {
            let id = result.vertices.len() as u32;
            result
                .vertices
                .push(vertex(config, origin_x + x, origin_z + z));
            id
        })
    };
    for z in (0..cells).step_by(step) {
        for x in (0..cells).step_by(step) {
            let center = add(x + step / 2, z + step / 2);
            let edges = [
                ((x, z), (x, z + step), x == 0),
                ((x, z + step), (x + step, z + step), z + step == cells),
                ((x + step, z + step), (x + step, z), x + step == cells),
                ((x + step, z), (x, z), z == 0),
            ];
            let mut perimeter = Vec::new();
            for ((ax, az), (bx, bz), boundary) in edges {
                let segments = if boundary { step } else { 1 };
                for index in 0..segments {
                    let px = (ax * (segments - index) + bx * index) / segments;
                    let pz = (az * (segments - index) + bz * index) / segments;
                    perimeter.push(add(px, pz));
                }
            }
            for index in 0..perimeter.len() {
                result.indices.extend_from_slice(&[
                    center,
                    perimeter[index],
                    perimeter[(index + 1) % perimeter.len()],
                ]);
            }
        }
    }
    result
}

#[derive(Clone, Copy, Debug)]
struct Bounds {
    min: [f32; 3],
    max: [f32; 3],
}
impl Bounds {
    fn of(vertices: &[Vertex]) -> Self {
        let mut result = Self {
            min: [f32::INFINITY; 3],
            max: [f32::NEG_INFINITY; 3],
        };
        for vertex in vertices {
            for axis in 0..3 {
                result.min[axis] = result.min[axis].min(vertex.position[axis]);
                result.max[axis] = result.max[axis].max(vertex.position[axis]);
            }
        }
        result
    }
    fn json(self) -> String {
        format!(
            "{{\"min\":[{},{},{}],\"max\":[{},{},{}]}}",
            f64::from(self.min[0]),
            f64::from(self.min[1]),
            f64::from(self.min[2]),
            f64::from(self.max[0]),
            f64::from(self.max[1]),
            f64::from(self.max[2])
        )
    }
}
#[derive(Debug)]
struct Cluster {
    id: usize,
    page: usize,
    vertex_offset: usize,
    vertex_count: usize,
    index_offset: usize,
    index_count: usize,
    bounds: Bounds,
}
#[derive(Debug)]
pub struct Page {
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub pinned: bool,
}
#[derive(Debug, Default)]
struct Lod {
    error: f64,
    clusters: Vec<usize>,
    pages: BTreeSet<usize>,
}
#[derive(Debug)]
pub struct Cooked {
    pub manifest: String,
    pub pages: Vec<Page>,
    pub cluster_count: usize,
    pub source_triangles: usize,
    pub root_pages: usize,
}

pub fn cook(config: Config) -> Result<Cooked, String> {
    cook_with_profile(config, LodProfile::Legacy)
}

pub fn cook_with_profile(config: Config, profile: LodProfile) -> Result<Cooked, String> {
    let config = config.validate()?;
    let steps = profile.steps(config);
    let certified_errors = if profile == LodProfile::Certified {
        Some(certified_lod::errors(config, &steps)?)
    } else {
        None
    };
    let mut lods: Vec<Vec<Lod>> = (0..config.tiles * config.tiles)
        .map(|_| (0..steps.len()).map(|_| Lod::default()).collect())
        .collect();
    let mut pages: Vec<Page> = Vec::new();
    let mut clusters = Vec::new();
    for (level, step) in steps.iter().copied().enumerate().rev() {
        let pinned = level == steps.len() - 1;
        // Root payload never shares a page with optional detail.
        let mut used = PAGE_BYTES;
        for (tile, tile_lods) in lods.iter_mut().enumerate() {
            let mesh = mesh(config, tile, step);
            let lod = &mut tile_lods[level];
            // Taylor interpolation bound: M/2 * barycentric variance, <= M*d²/6.
            // Fan-triangle diameter <= step; finest triangles add M/3. Margin covers f32 heights.
            lod.error = if let Some(errors) = &certified_errors {
                errors[tile][level]
            } else if step == 1 {
                0.0
            } else {
                HESSIAN_BOUND * ((step * step) as f64 / 6.0 + 1.0 / 3.0) + 0.0001
            };
            for triangle_indices in mesh.indices.chunks(CLUSTER_TRIANGLES * 3) {
                let mut local = BTreeMap::new();
                let mut vertices = Vec::new();
                let mut indices = Vec::new();
                for id in triangle_indices {
                    let next = local.len() as u32;
                    let local_id = *local.entry(*id).or_insert_with(|| {
                        vertices.push(mesh.vertices[*id as usize]);
                        next
                    });
                    indices.push(local_id);
                }
                let size = vertices.len() * 32 + indices.len() * 4;
                if used + size > PAGE_BYTES {
                    pages.push(Page {
                        bytes: vec![0; PAGE_BYTES],
                        sha256: String::new(),
                        pinned,
                    });
                    used = 0;
                }
                let page = pages.len() - 1;
                let vertex_offset = used;
                let index_offset = used + vertices.len() * 32;
                let mut payload = Vec::with_capacity(size);
                for vertex in &vertices {
                    vertex.bytes(&mut payload);
                }
                for index in &indices {
                    payload.extend_from_slice(&index.to_le_bytes());
                }
                pages[page].bytes[used..used + size].copy_from_slice(&payload);
                used += size;
                let id = clusters.len();
                clusters.push(Cluster {
                    id,
                    page,
                    vertex_offset,
                    vertex_count: vertices.len(),
                    index_offset,
                    index_count: indices.len(),
                    bounds: Bounds::of(&vertices),
                });
                lod.clusters.push(id);
                lod.pages.insert(page);
            }
        }
    }
    for page in &mut pages {
        page.sha256 = hash::sha256(&page.bytes);
    }
    if pages.len() > 8192 || clusters.len() > 262144 {
        return Err(
            "Cooked geometry exceeds the runtime manifest limits; use fewer tiles or cells.".into(),
        );
    }
    let extent = config.extent() as f32 * 0.5;
    let bounds = Bounds {
        min: [-extent, -11.0, -extent],
        max: [extent, 11.0, extent],
    };
    let source_triangles = config.tiles * config.tiles * config.cells * config.cells * 2;
    let mut json = format!(
        "{{\"format\":\"strata-geometry\",\"version\":1,\"pageBytes\":65536,\"vertexStride\":32,\"indexFormat\":\"uint32\",\"source\":{{\"kind\":\"analytic-heightfield-v1\",\"seed\":{},\"tilesPerSide\":{},\"cellsPerTile\":{},\"cellSize\":1,\"triangleCount\":{}}},\"bounds\":{},\"pages\":[",
        config.seed,
        config.tiles,
        config.cells,
        source_triangles,
        bounds.json()
    );
    for (id, page) in pages.iter().enumerate() {
        if id != 0 {
            json.push(',');
        }
        write!(json, "{{\"id\":{id},\"url\":\"pages/{id:06}.bin\",\"byteLength\":65536,\"sha256\":\"{}\",\"pinned\":{}}}", page.sha256, page.pinned).unwrap();
    }
    json.push_str("],\"clusters\":[");
    for cluster in &clusters {
        if cluster.id != 0 {
            json.push(',');
        }
        write!(json, "{{\"id\":{},\"pageId\":{},\"vertexOffset\":{},\"vertexCount\":{},\"indexOffset\":{},\"indexCount\":{},\"triangleCount\":{},\"bounds\":{}}}", cluster.id, cluster.page, cluster.vertex_offset, cluster.vertex_count, cluster.index_offset, cluster.index_count, cluster.index_count / 3, cluster.bounds.json()).unwrap();
    }
    json.push_str("],\"tiles\":[");
    for (id, levels) in lods.iter().enumerate() {
        if id != 0 {
            json.push(',');
        }
        let x = (id % config.tiles * config.cells) as f32 - extent;
        let z = (id / config.tiles * config.cells) as f32 - extent;
        let tile_bounds = Bounds {
            min: [x, -11.0, z],
            max: [x + config.cells as f32, 11.0, z + config.cells as f32],
        };
        write!(
            json,
            "{{\"id\":{id},\"bounds\":{},\"lods\":[",
            tile_bounds.json()
        )
        .unwrap();
        for (level, lod) in levels.iter().enumerate() {
            if level != 0 {
                json.push(',');
            }
            write!(
                json,
                "{{\"level\":{level},\"error\":{},\"clusterIds\":{:?},\"pageIds\":{:?}}}",
                lod.error,
                lod.clusters,
                lod.pages.iter().collect::<Vec<_>>()
            )
            .unwrap();
        }
        json.push_str("]}");
    }
    let roots: Vec<_> = pages
        .iter()
        .enumerate()
        .filter_map(|(id, page)| page.pinned.then_some(id))
        .collect();
    if profile == LodProfile::Certified {
        writeln!(json, "],\"rootPageIds\":{roots:?},\"cook\":{{\"profile\":\"certified-terrain-v1\",\"lodSteps\":{steps:?},\"errorMetric\":\"max-vertical-to-finest\",\"monotonicEnvelope\":true}}}}").unwrap();
    } else {
        writeln!(json, "],\"rootPageIds\":{roots:?}}}").unwrap();
    }
    Ok(Cooked {
        manifest: json,
        pages,
        cluster_count: clusters.len(),
        source_triangles,
        root_pages: roots.len(),
    })
}

/// Refuse Git directories, including worktree .git files, and unrelated nonempty destinations.
pub fn write_cooked(output: &Path, cooked: &Cooked) -> io::Result<()> {
    fs::create_dir_all(output)?;
    let output = fs::canonicalize(output)?;
    if output
        .ancestors()
        .any(|parent| parent.join(".git").exists())
    {
        return Err(io::Error::other(
            "Cooked geometry must remain outside every Git checkout.",
        ));
    }
    let reject_symlink = |path: &Path| -> io::Result<()> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => Err(io::Error::other(
                "Cooked output files and page directories must not be symbolic links.",
            )),
            Ok(_) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    };
    reject_symlink(&output.join("manifest.json"))?;
    reject_symlink(&output.join("pages"))?;
    if fs::read_dir(&output)?.next().is_some() {
        let previous = fs::read_to_string(output.join("manifest.json")).unwrap_or_default();
        if !previous.starts_with("{\"format\":\"strata-geometry\",\"version\":1,") {
            return Err(io::Error::other(
                "Refusing to overwrite an unrelated nonempty output directory.",
            ));
        }
    }
    fs::create_dir_all(output.join("pages"))?;
    for (id, page) in cooked.pages.iter().enumerate() {
        reject_symlink(&output.join(format!("pages/{id:06}.bin")))?;
        fs::write(output.join(format!("pages/{id:06}.bin")), &page.bytes)?;
    }
    fs::write(output.join("manifest.json"), &cooked.manifest)
}

#[cfg(test)]
mod tests;
