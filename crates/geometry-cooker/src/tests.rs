use super::*;

fn area(mesh: &Mesh) -> f64 {
    mesh.indices
        .as_chunks::<3>()
        .0
        .iter()
        .map(|triangle| {
            let [a, b, c] = triangle.map_vertices(mesh);
            let signed = f64::from(b[2] - a[2]) * f64::from(c[0] - a[0])
                - f64::from(b[0] - a[0]) * f64::from(c[2] - a[2]);
            assert!(signed > 0.0, "winding reversed or triangle degenerate");
            signed * 0.5
        })
        .sum()
}
trait Positions {
    fn map_vertices(&self, mesh: &Mesh) -> [[f32; 3]; 3];
}
impl Positions for [u32] {
    fn map_vertices(&self, mesh: &Mesh) -> [[f32; 3]; 3] {
        [
            mesh.vertices[self[0] as usize].position,
            mesh.vertices[self[1] as usize].position,
            mesh.vertices[self[2] as usize].position,
        ]
    }
}
type Point = [u32; 3];
fn boundary(mesh: &Mesh) -> BTreeSet<(Point, Point)> {
    let mut counts = BTreeMap::new();
    for triangle in mesh.indices.as_chunks::<3>().0 {
        for edge in 0..3 {
            let a = mesh.vertices[triangle[edge] as usize]
                .position
                .map(f32::to_bits);
            let b = mesh.vertices[triangle[(edge + 1) % 3] as usize]
                .position
                .map(f32::to_bits);
            *counts
                .entry(if a < b { (a, b) } else { (b, a) })
                .or_insert(0) += 1;
        }
    }
    assert!(counts.values().all(|count| *count == 1 || *count == 2));
    counts
        .into_iter()
        .filter_map(|(edge, count)| (count == 1).then_some(edge))
        .collect()
}

#[test]
fn complete_area_winding_and_full_boundaries_at_every_lod() {
    for cells in [8, 16, 32, 64, 128] {
        let config = Config {
            seed: 1337,
            tiles: 2,
            cells,
        };
        let source = mesh(config, 0, 1);
        assert_eq!(source.indices.len() / 3, cells * cells * 2);
        let source_boundary = boundary(&source);
        assert_eq!(source_boundary.len(), cells * 4);
        for step in config.steps() {
            let coarse = mesh(config, 0, step);
            assert_eq!(area(&coarse), (cells * cells) as f64);
            assert_eq!(
                boundary(&coarse),
                source_boundary,
                "step {step} changes locked boundaries"
            );
            for vertex in coarse.vertices {
                assert!(vertex.normal.iter().all(|value| value.is_finite()));
                let length: f32 = vertex.normal.iter().map(|value| value * value).sum();
                assert!((length - 1.0).abs() < 0.00001);
            }
        }
    }
}

#[test]
fn adjacent_tiles_share_identical_position_and_normal_bits() {
    let config = Config {
        seed: 42,
        tiles: 2,
        cells: 128,
    };
    let left = mesh(config, 0, 128);
    let right = mesh(config, 1, 8);
    let shared = |mesh: &Mesh| -> BTreeMap<u32, ([u32; 3], [u32; 3])> {
        mesh.vertices
            .iter()
            .filter(|vertex| vertex.position[0] == 0.0)
            .map(|vertex| {
                (
                    vertex.position[2].to_bits(),
                    (
                        vertex.position.map(f32::to_bits),
                        vertex.normal.map(f32::to_bits),
                    ),
                )
            })
            .collect()
    };
    assert_eq!(shared(&left), shared(&right));
    assert_eq!(shared(&left).len(), 129);
}

fn source_height(config: Config, x: f64, z: f64) -> f64 {
    let global_x = (x + config.extent() * 0.5).clamp(0.0, config.extent());
    let global_z = (z + config.extent() * 0.5).clamp(0.0, config.extent());
    let ix = (global_x.floor() as usize).min(config.tiles * config.cells - 1);
    let iz = (global_z.floor() as usize).min(config.tiles * config.cells - 1);
    let u = global_x - ix as f64;
    let v = global_z - iz as f64;
    let h = |dx, dz| f64::from(vertex(config, ix + dx, iz + dz).position[1]);
    if v >= u {
        h(0, 0) * (1.0 - v) + h(0, 1) * (v - u) + h(1, 1) * u
    } else {
        h(0, 0) * (1.0 - u) + h(1, 1) * v + h(1, 0) * (u - v)
    }
}

#[test]
fn stored_error_bound_covers_sampled_deviation_from_unique_source() {
    for seed in [0, 42, 1337, u32::MAX] {
        let config = Config {
            seed,
            tiles: 2,
            cells: 32,
        };
        for step in config.steps().into_iter().skip(1) {
            let coarse = mesh(config, 1, step);
            let error = HESSIAN_BOUND * ((step * step) as f64 / 6.0 + 1.0 / 3.0) + 0.0001;
            for triangle in coarse.indices.as_chunks::<3>().0 {
                let vertices = triangle.map_vertices(&coarse);
                for a in 0..=4 {
                    for b in 0..=4 - a {
                        let weights = [
                            f64::from(a) / 4.0,
                            f64::from(b) / 4.0,
                            f64::from(4 - a - b) / 4.0,
                        ];
                        let point: [f64; 3] = std::array::from_fn(|axis| {
                            vertices
                                .iter()
                                .zip(weights)
                                .map(|(vertex, weight)| f64::from(vertex[axis]) * weight)
                                .sum()
                        });
                        assert!(
                            (point[1] - source_height(config, point[0], point[2])).abs() <= error
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn deterministic_pages_offsets_and_pinned_root_pack() {
    let config = Config {
        seed: 42,
        tiles: 2,
        cells: 8,
    };
    let first = cook(config).unwrap();
    let second = cook(config).unwrap();
    assert_eq!(first.manifest, second.manifest);
    assert_eq!(first.source_triangles, 512);
    assert_eq!(
        first.root_pages, 1,
        "roots from separate tiles should share a packed page"
    );
    assert!(
        first
            .pages
            .iter()
            .skip(first.root_pages)
            .all(|page| !page.pinned)
    );
    for (a, b) in first.pages.iter().zip(second.pages) {
        assert_eq!(a.bytes.len(), PAGE_BYTES);
        assert_eq!(a.bytes, b.bytes);
        assert_eq!(a.sha256, hash::sha256(&a.bytes));
        assert_eq!(a.sha256, b.sha256);
    }
    assert_ne!(
        first.manifest,
        cook(Config { seed: 43, ..config }).unwrap().manifest
    );
}

#[test]
fn finest_block_cluster_has_bounded_compact_vertex_payload() {
    let fine = mesh(
        Config {
            seed: 0,
            tiles: 1,
            cells: 128,
        },
        0,
        1,
    );
    for cluster in fine.indices.chunks(CLUSTER_TRIANGLES * 3) {
        assert_eq!(cluster.len(), 384);
        assert_eq!(cluster.iter().collect::<BTreeSet<_>>().len(), 81);
    }
    assert_eq!(
        Config::default().tiles.pow(2) * Config::default().cells.pow(2) * 2,
        2_097_152
    );
}

#[test]
fn invalid_inputs_and_git_output_are_rejected() {
    for (tiles, cells) in [(0, 128), (17, 128), (8, 7), (8, 24), (8, 256)] {
        assert!(
            cook(Config {
                seed: 0,
                tiles,
                cells
            })
            .is_err()
        );
    }
    let directory = std::env::temp_dir().join(format!("strata-cooker-git-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join(".git"), "gitdir: external").unwrap();
    let cooked = cook(Config {
        seed: 0,
        tiles: 1,
        cells: 8,
    })
    .unwrap();
    assert!(write_cooked(&directory.join("nested"), &cooked).is_err());
    assert!(!directory.join("nested/manifest.json").exists());
    fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[test]
fn symlinked_page_destinations_cannot_redirect_output_into_git() {
    let directory =
        std::env::temp_dir().join(format!("strata-cooker-symlink-{}", std::process::id()));
    let output = directory.join("output");
    let repository = directory.join("repository");
    fs::create_dir_all(&repository).unwrap();
    fs::write(repository.join(".git"), "gitdir: external").unwrap();
    let cooked = cook(Config {
        seed: 0,
        tiles: 1,
        cells: 8,
    })
    .unwrap();
    write_cooked(&output, &cooked).unwrap();
    fs::remove_dir_all(output.join("pages")).unwrap();
    std::os::unix::fs::symlink(&repository, output.join("pages")).unwrap();
    assert!(write_cooked(&output, &cooked).is_err());
    assert!(!repository.join("000000.bin").exists());
    fs::remove_dir_all(directory).unwrap();
}
