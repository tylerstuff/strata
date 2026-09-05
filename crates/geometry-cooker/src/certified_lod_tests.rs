use super::*;
use crate::{LodProfile, cook, cook_with_profile};

// Independent finest-plane interpolation, without rational-overlay helpers.
fn source_height(source: &Mesh, cells: usize, x: f64, z: f64) -> f64 {
    let xx = x - f64::from(source.vertices[0].position[0]);
    let zz = z - f64::from(source.vertices[0].position[2]);
    let ix = (xx.floor().max(0.) as usize).min(cells - 1);
    let iz = (zz.floor().max(0.) as usize).min(cells - 1);
    let u = xx - ix as f64;
    let v = zz - iz as f64;
    let h = |dx: usize, dz: usize| {
        f64::from(source.vertices[(iz + dz) * (cells + 1) + ix + dx].position[1])
    };
    if v >= u {
        h(0, 0) * (1. - v) + h(0, 1) * (v - u) + h(1, 1) * u
    } else {
        h(0, 0) * (1. - u) + h(1, 1) * v + h(1, 0) * (u - v)
    }
}
fn check_samples(source: &Mesh, coarse: &Mesh, cells: usize, bound: f64) {
    for t in triangles(coarse) {
        let sample = |weights: [f64; 3]| {
            let x: f64 = (0..3).map(|i| t.p[i].x as f64 * weights[i]).sum();
            let z: f64 = (0..3).map(|i| t.p[i].z as f64 * weights[i]).sum();
            let y: f64 = (0..3).map(|i| t.h[i] * weights[i]).sum();
            let error = (y - source_height(source, cells, x, z)).abs();
            assert!(
                error <= bound + 2e-12,
                "independent sample {x},{z}: {error} > {bound}"
            );
        };
        for a in 0..=8 {
            for b in 0..=8 - a {
                sample([
                    f64::from(a) / 8.,
                    f64::from(b) / 8.,
                    f64::from(8 - a - b) / 8.,
                ]);
            }
        }
        for edge in 0..3 {
            for i in 0..=32 {
                let mut weights = [0.; 3];
                weights[edge] = f64::from(i) / 32.;
                weights[(edge + 1) % 3] = 1. - weights[edge];
                sample(weights);
            }
        }
    }
}

#[test]
fn edge_intersection_extremum_is_not_replaced_with_vertex_only_sampling() {
    let a = Point { x: 0, z: 0 };
    let b = Point { x: 0, z: 1 };
    let c = Point { x: 1, z: 1 };
    let d = Point { x: 1, z: 0 };
    let fine = [
        Triangle {
            p: [a, b, c],
            h: [0., 1., 0.],
        },
        Triangle {
            p: [a, c, d],
            h: [0., 0., 1.],
        },
    ];
    let coarse = [
        Triangle {
            p: [a, b, d],
            h: [0., 1., 1.],
        },
        Triangle {
            p: [b, c, d],
            h: [1., 0., 1.],
        },
    ];
    let mut maximum = 0.;
    let mut vertices = 0.;
    for f in fine {
        for c in coarse {
            pair(f, c, &mut maximum);
            for p in f.p {
                if contains(c, rational(p)) {
                    candidate(f, c, rational(p), &mut vertices);
                }
            }
            for p in c.p {
                if contains(f, rational(p)) {
                    candidate(f, c, rational(p), &mut vertices);
                }
            }
        }
    }
    assert!(vertices < 1e-13);
    assert!((1.0..1.0 + 1e-13).contains(&maximum));
    let crossing = intersection(a, c, b, d).unwrap();
    assert_eq!(crossing.x * 2, crossing.d);
    assert_eq!(crossing.z * 2, crossing.d);
    assert!(intersection(a, b, a, b).is_none());
    let endpoint = intersection(a, c, c, d).unwrap();
    assert_eq!(endpoint.x, endpoint.d);
    assert_eq!(endpoint.z, endpoint.d);
}

#[test]
fn certified_errors_cover_independent_interior_and_edge_samples_for_multiple_seeds() {
    for seed in [0, 42, 1337, u32::MAX] {
        let config = Config {
            seed,
            tiles: 2,
            cells: 16,
        };
        let steps = LodProfile::Certified.steps(config);
        let errors = errors(config, &steps).unwrap();
        for (tile, levels) in errors.iter().enumerate() {
            let source = mesh(config, tile, 1);
            assert_eq!(levels[0], 0.);
            assert!(levels.windows(2).all(|pair| pair[0] <= pair[1]));
            for (&step, &bound) in steps.iter().zip(levels) {
                assert_eq!(
                    f64::from(bound as f32),
                    bound,
                    "stored source bound must be exactly representable as f32"
                );
                check_samples(&source, &mesh(config, tile, step), config.cells, bound);
            }
        }
    }
}

#[test]
fn maximum_supported_coordinate_and_root_step_remain_bounded() {
    let config = Config {
        seed: 1337,
        tiles: 16,
        cells: 128,
    };
    assert_eq!(
        LodProfile::Certified.steps(config),
        [1, 2, 4, 8, 16, 32, 64, 128]
    );
    for tile in [0, 255] {
        let source = mesh(config, tile, 1);
        validate_finest(&source, config.cells).unwrap();
        let coarse = mesh(config, tile, 128);
        let bound = surface_error(&source, &coarse, config.cells);
        assert!(bound.is_finite() && bound > 0. && bound < 22.0001);
        check_samples(&source, &coarse, config.cells, bound);
    }
}

#[test]
fn changed_finest_topology_is_rejected_instead_of_silently_certified() {
    let config = Config {
        seed: 1337,
        tiles: 1,
        cells: 8,
    };
    let mut source = mesh(config, 0, 1);
    validate_finest(&source, 8).unwrap();
    source.indices.swap(0, 1);
    assert!(validate_finest(&source, 8).is_err());
    let mut source = mesh(config, 0, 1);
    source.vertices[1].position[0] += 0.25;
    assert!(validate_finest(&source, 8).is_err());
}

#[test]
fn legacy_identity_and_profile_source_payloads_are_preserved() {
    let config = Config {
        seed: 1337,
        tiles: 4,
        cells: 64,
    };
    let original = cook(config).unwrap();
    // Local frozen fixture identity. Other platforms may differ in libm
    // transcendental rounding; same-platform determinism is tested below.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    assert_eq!(
        crate::hash::sha256(original.manifest.as_bytes()),
        "818d7d020a608d59e83b334b1737ac655de545986e5a8a7494d76910a09c86ca"
    );
    let explicit = cook_with_profile(config, LodProfile::Legacy).unwrap();
    assert_eq!(original.manifest, explicit.manifest);
    let config = Config {
        seed: 1337,
        tiles: 1,
        cells: 8,
    };
    let legacy = cook(config).unwrap();
    let quality = cook_with_profile(config, LodProfile::Certified).unwrap();
    assert!(
        quality
            .manifest
            .contains("\"profile\":\"certified-terrain-v1\"")
    );
    assert!(quality.manifest.contains("\"lodSteps\":[1, 2, 4, 8]"));
    assert!(!legacy.manifest.contains("\"cook\""));
    assert_eq!(legacy.source_triangles, quality.source_triangles);
    assert_eq!(
        legacy.pages[0].bytes, quality.pages[0].bytes,
        "pinned roots unchanged"
    );
    assert_eq!(
        legacy.pages.last().unwrap().bytes,
        quality.pages.last().unwrap().bytes,
        "finest payload unchanged"
    );
    let repeated = cook_with_profile(config, LodProfile::Certified).unwrap();
    assert_eq!(quality.manifest, repeated.manifest);
}

#[test]
fn supported_profile_packing_counts_respect_manifest_limits_except_largest_certified() {
    // Geometry/cluster sizes are seed-independent. Count the real producer's
    // cluster payloads without allocating hundreds of megabytes of zero pages.
    for cells in [8, 16, 32, 64, 128] {
        let config = Config {
            seed: 1337,
            tiles: 1,
            cells,
        };
        let payloads: Vec<_> = LodProfile::Certified
            .steps(config)
            .into_iter()
            .map(|step| {
                let source = mesh(config, 0, step);
                let sizes: Vec<_> = source
                    .indices
                    .chunks(crate::CLUSTER_TRIANGLES * 3)
                    .map(|ids| {
                        ids.iter().copied().collect::<BTreeSet<_>>().len() * 32 + ids.len() * 4
                    })
                    .collect();
                (step, sizes)
            })
            .collect();
        for tiles in 1..=16 {
            for profile in [LodProfile::Legacy, LodProfile::Certified] {
                let mut page_count = 0;
                let mut cluster_count = 0;
                for step in profile.steps(Config { tiles, ..config }) {
                    let sizes = &payloads.iter().find(|(value, _)| *value == step).unwrap().1;
                    let mut used = crate::PAGE_BYTES;
                    for _ in 0..tiles * tiles {
                        for size in sizes {
                            if used + size > crate::PAGE_BYTES {
                                page_count += 1;
                                used = 0;
                            }
                            used += size;
                            cluster_count += 1;
                        }
                    }
                }
                let oversized = profile == LodProfile::Certified && cells == 128 && tiles == 16;
                assert_eq!(page_count > 8192 || cluster_count > 262144, oversized);
                if cells == 128 && tiles == 16 {
                    assert_eq!(
                        page_count,
                        if profile == LodProfile::Certified {
                            8263
                        } else {
                            4791
                        }
                    );
                }
            }
        }
    }
}
