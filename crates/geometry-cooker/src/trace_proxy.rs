use super::{Config, HESSIAN_BOUND, hash, vertex};
use std::fs;
use std::io;
use std::path::Path;

const CELLS: usize = 32;
const STEP: usize = 8;
const SCALE: f32 = 0.125;
const TRANSLATE_Y: f32 = -1.625;

#[derive(Debug)]
pub struct CookedTraceProxy {
    pub manifest: String,
    pub payload: Vec<u8>,
    pub source_manifest_sha256: String,
    pub max_vertical_error: f64,
    pub measured_max_vertical_error: f64,
}

fn world_position(config: Config, x: usize, z: usize) -> [f32; 3] {
    let p = vertex(config, x, z).position;
    [p[0] * SCALE, p[1] * SCALE + TRANSLATE_Y, p[2] * SCALE]
}

fn interpolated_height(vertices: &[[f32; 3]], x: usize, z: usize) -> f64 {
    let cell_x = (x / STEP).min(CELLS - 1);
    let cell_z = (z / STEP).min(CELLS - 1);
    let u = (x - cell_x * STEP) as f64 / STEP as f64;
    let v = (z - cell_z * STEP) as f64 / STEP as f64;
    let a = cell_z * (CELLS + 1) + cell_x;
    let h = |id: usize| f64::from(vertices[id][1]);
    if v >= u {
        (1.0 - v) * h(a) + (v - u) * h(a + CELLS + 1) + u * h(a + CELLS + 2)
    } else {
        (1.0 - u) * h(a) + v * h(a + CELLS + 2) + (u - v) * h(a + 1)
    }
}

/// A separate global tracing grid, not a streamed render LOD. Keep all of it resident.
pub fn cook_trace_proxy(config: Config, source_manifest: &str) -> Result<CookedTraceProxy, String> {
    config.validate()?;
    if config.seed != 1337 || config.tiles != 4 || config.cells != 64 {
        return Err("Trace proxy v1 requires seed1337, tiles4, cells64.".into());
    }
    let mut vertices = Vec::with_capacity((CELLS + 1) * (CELLS + 1));
    for z in 0..=CELLS {
        for x in 0..=CELLS {
            vertices.push(world_position(config, x * STEP, z * STEP));
        }
    }
    let mut payload = Vec::with_capacity(37644);
    for position in &vertices {
        for value in position {
            payload.extend_from_slice(&value.to_le_bytes());
        }
    }
    for z in 0..CELLS {
        for x in 0..CELLS {
            let a = (z * (CELLS + 1) + x) as u32;
            let b = a + (CELLS + 1) as u32;
            for id in [a, b, b + 1, a, b + 1, a + 1] {
                payload.extend_from_slice(&id.to_le_bytes());
            }
        }
    }
    // Each coarse diagonal is also an edge of the finest triangulation. The two
    // piecewise-linear surfaces differ linearly on every finest triangle, so its
    // vertical extrema occur at these vertices; this is not a lighting bound.
    let mut measured: f64 = 0.0;
    for z in 0..=CELLS * STEP {
        for x in 0..=CELLS * STEP {
            let fine = f64::from(world_position(config, x, z)[1]);
            measured = measured.max((fine - interpolated_height(&vertices, x, z)).abs());
        }
    }
    // Coarse triangle diameter squared=2*s²; M*d²/6 + finest M/3 + f32 margin.
    let max_vertical_error =
        (HESSIAN_BOUND * ((STEP * STEP) as f64 / 3.0 + 1.0 / 3.0) + 0.0001) * f64::from(SCALE);
    if measured > max_vertical_error {
        return Err("Measured proxy error exceeds the analytical bound.".into());
    }
    let source_hash = hash::sha256(source_manifest.as_bytes());
    let payload_hash = hash::sha256(&payload);
    let manifest = format!(
        concat!(
            "{{\"format\":\"strata-trace-proxy\",\"version\":1,",
            "\"sourceManifestSha256\":\"{}\",",
            "\"source\":{{\"kind\":\"analytic-heightfield-v1\",\"seed\":1337,\"tilesPerSide\":4,\"cellsPerTile\":64,\"cellSize\":1,\"triangleCount\":131072}},",
            "\"grid\":{{\"cellsPerSide\":32,\"sourceStep\":8}},",
            "\"transform\":{{\"scale\":0.125,\"translation\":[0,-1.625,0]}},",
            "\"material\":{{\"id\":5,\"albedo\":[0.08,0.65,0.12],\"roughness\":1,\"metallic\":0,\"emission\":[0,0,0]}},",
            "\"bounds\":{{\"min\":[-16,-3,-16],\"max\":[16,-0.25,16]}},",
            "\"error\":{{\"maxVertical\":{},\"measuredMaxVertical\":{}}},",
            "\"mesh\":{{\"url\":\"trace-proxy.bin\",\"byteLength\":37644,\"sha256\":\"{}\",\"vertexCount\":1089,\"vertexStride\":12,\"indexCount\":6144,\"indexFormat\":\"uint32\"}}}}\n"
        ),
        source_hash, max_vertical_error, measured, payload_hash
    );
    Ok(CookedTraceProxy {
        manifest,
        payload,
        source_manifest_sha256: source_hash,
        max_vertical_error,
        measured_max_vertical_error: measured,
    })
}

/// Only add a sidecar beside the exact external render manifest it was cooked against.
pub fn write_trace_proxy(output: &Path, proxy: &CookedTraceProxy) -> io::Result<()> {
    let output = fs::canonicalize(output)?;
    if output
        .ancestors()
        .any(|parent| parent.join(".git").exists())
    {
        return Err(io::Error::other(
            "Cooked tracing geometry must remain outside every Git checkout.",
        ));
    }
    for file in ["manifest.json", "trace-proxy.json", "trace-proxy.bin"] {
        match fs::symlink_metadata(output.join(file)) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(io::Error::other(
                    "Trace proxy files must not be symbolic links.",
                ));
            }
            Ok(_) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
    }
    if hash::sha256(&fs::read(output.join("manifest.json"))?) != proxy.source_manifest_sha256 {
        return Err(io::Error::other(
            "Trace proxy source manifest identity does not match the output directory.",
        ));
    }
    fs::write(output.join("trace-proxy.bin"), &proxy.payload)?;
    fs::write(output.join("trace-proxy.json"), &proxy.manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config {
            seed: 1337,
            tiles: 4,
            cells: 64,
        }
    }

    #[test]
    fn deterministic_grid_uses_exact_source_vertices_and_upward_complete_topology() {
        let a = cook_trace_proxy(config(), "exact manifest\n").unwrap();
        let b = cook_trace_proxy(config(), "exact manifest\n").unwrap();
        assert_eq!(a.payload, b.payload);
        assert_eq!(a.manifest, b.manifest);
        assert_eq!(a.payload.len(), 37644);
        let read = |offset| f32::from_le_bytes(a.payload[offset..offset + 4].try_into().unwrap());
        let index_start = 1089 * 12;
        let mut area = 0.0;
        for z in 0..=CELLS {
            for x in 0..=CELLS {
                let at = (z * 33 + x) * 12;
                assert_eq!(
                    [read(at), read(at + 4), read(at + 8)],
                    world_position(config(), x * STEP, z * STEP)
                );
                assert!((-3.0..=-0.25).contains(&read(at + 4)));
            }
        }
        for triangle in a.payload[index_start..].as_chunks::<12>().0 {
            let ids: Vec<_> = triangle
                .as_chunks::<4>()
                .0
                .iter()
                .map(|v| u32::from_le_bytes(*v) as usize)
                .collect();
            assert!(ids.iter().all(|id| *id < 1089));
            let p: Vec<_> = ids
                .iter()
                .map(|id| [read(id * 12), read(id * 12 + 8)])
                .collect();
            let cross_y = (p[1][1] - p[0][1]) * (p[2][0] - p[0][0])
                - (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]);
            assert!(cross_y > 0.0);
            area += cross_y * 0.5;
        }
        assert_eq!(area, 32.0 * 32.0);
        assert!(a.measured_max_vertical_error > 0.001);
        assert!(a.measured_max_vertical_error <= a.max_vertical_error);
        assert!((a.max_vertical_error - 0.18959583333333332).abs() < 1e-12);
        assert_ne!(
            a.source_manifest_sha256,
            cook_trace_proxy(config(), "exact manifest")
                .unwrap()
                .source_manifest_sha256
        );
    }

    #[test]
    fn rejects_unrecorded_fixture_variants() {
        for invalid in [
            Config {
                seed: 1,
                ..config()
            },
            Config {
                tiles: 8,
                ..config()
            },
            Config {
                cells: 128,
                ..config()
            },
        ] {
            assert!(cook_trace_proxy(invalid, "{}").is_err());
        }
    }
}
