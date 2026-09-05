use super::*;

fn soup(count: usize, distribution: u32) -> Job {
    let mut job = Job::new((count * 3) as u32, count as u32, MAX_WORKING_BYTES).unwrap();
    for source in 0..count {
        let x = match distribution {
            0 => source as f32,
            1 => (count - source) as f32,
            2 => 0.0,
            // Alternating extrema are hostile to naive end-pivot selection.
            _ => {
                if source % 2 == 0 {
                    source as f32
                } else {
                    (count * 2 - source) as f32
                }
            }
        };
        job.positions[source * 9..source * 9 + 9].copy_from_slice(&[
            x,
            0.0,
            0.0,
            x + 0.25,
            0.0,
            0.0,
            x,
            0.5,
            0.0,
        ]);
        job.indices[source * 3..source * 3 + 3].copy_from_slice(&[
            (source * 3) as u32,
            (source * 3 + 1) as u32,
            (source * 3 + 2) as u32,
        ]);
    }
    job
}

fn finish(job: &mut Job, quota: u32) {
    loop {
        let before = job.work_units;
        let status = job.step(quota);
        assert!(job.work_units > before);
        assert!(job.work_units - before <= quota);
        if status == DONE {
            break;
        }
        assert_eq!(status, RUNNING);
        assert!(
            job.work_units < 400_000_000,
            "build did not finish within a conservative work bound"
        );
    }
    let work = job.work_units;
    assert_eq!(job.step(quota), DONE);
    assert_eq!(job.work_units, work);
}

fn verify_tree(job: &Job) {
    assert_eq!(job.triangles.len(), job.indices.len() / 3);
    let mut visited_nodes = vec![false; job.nodes.len()];
    let mut visited_triangles = vec![false; job.triangles.len()];
    let mut source_ids = vec![false; job.triangles.len()];
    let mut stack = vec![(0usize, 1u32)];
    let mut depth = 0;
    while let Some((index, current_depth)) = stack.pop() {
        assert!(!visited_nodes[index]);
        visited_nodes[index] = true;
        depth = depth.max(current_depth);
        let node = job.nodes[index];
        assert!(
            node.minimum
                .iter()
                .chain(node.maximum.iter())
                .all(|v| v.is_finite())
        );
        if node.count == 0 {
            let first = node.first as usize;
            assert!(first > index && first + 1 < job.nodes.len());
            for child in first..first + 2 {
                for axis in 0..3 {
                    assert!(node.minimum[axis] <= job.nodes[child].minimum[axis]);
                    assert!(node.maximum[axis] >= job.nodes[child].maximum[axis]);
                }
                stack.push((child, current_depth + 1));
            }
        } else {
            assert!(node.count <= 4);
            for (triangle_index, visited) in visited_triangles
                .iter_mut()
                .enumerate()
                .take((node.first + node.count) as usize)
                .skip(node.first as usize)
            {
                assert!(!*visited);
                *visited = true;
                let triangle = job.triangles[triangle_index];
                let source = triangle.source_triangle_id as usize;
                assert!(!source_ids[source]);
                source_ids[source] = true;
                assert_eq!(triangle.material_id, 0);
                assert_eq!(triangle.padding, 0);
                assert_eq!(triangle.source_vertex0, job.indices[source * 3]);
                for (corner, point) in [triangle.p0, triangle.p1, triangle.p2].iter().enumerate() {
                    let original = job.indices[source * 3 + corner] as usize * 3;
                    for (axis, coordinate) in point.iter().enumerate() {
                        assert_eq!(
                            coordinate.to_bits(),
                            job.positions[original + axis].to_bits()
                        );
                        assert!(
                            *coordinate >= node.minimum[axis] && *coordinate <= node.maximum[axis]
                        );
                    }
                }
                let norm = triangle
                    .geometric_normal
                    .iter()
                    .map(|v| f64::from(*v).powi(2))
                    .sum::<f64>()
                    .sqrt();
                assert!((norm - 1.0).abs() <= 1e-7);
            }
        }
    }
    assert!(visited_nodes.into_iter().all(|seen| seen));
    assert!(visited_triangles.into_iter().all(|seen| seen));
    assert!(source_ids.into_iter().all(|seen| seen));
    assert_eq!(job.max_depth, depth);
    assert!(depth <= 19);
}

fn words<T>(values: &[T]) -> &[u32] {
    // These test-only calls use repr(C) Node/Triangle records with no padding.
    unsafe { std::slice::from_raw_parts(values.as_ptr().cast(), std::mem::size_of_val(values) / 4) }
}

#[test]
fn packed_layout_and_exact_budget() {
    assert_eq!(size_of::<Node>(), 32);
    assert_eq!(size_of::<Triangle>(), 64);
    assert_eq!(size_of::<Primitive>(), 40);
    assert_eq!(std::mem::offset_of!(Triangle, p1), 16);
    assert_eq!(std::mem::offset_of!(Triangle, p2), 32);
    assert_eq!(std::mem::offset_of!(Triangle, source_triangle_id), 44);
    assert_eq!(std::mem::offset_of!(Triangle, geometric_normal), 48);
    let (nodes, budget) = memory_budget(MAX_VERTICES, MAX_TRIANGLES).unwrap();
    assert_eq!(nodes, 524_287);
    assert_eq!(
        budget,
        12 * MAX_VERTICES + 116 * MAX_TRIANGLES + 32 * nodes as u32 + 1_048_576
    );
    assert!(budget < 256 * 1024 * 1024);
    for (vertices, triangles) in [
        (0, 1),
        (2, 1),
        (3, 0),
        (MAX_VERTICES + 1, 1),
        (3, MAX_TRIANGLES + 1),
    ] {
        assert_eq!(memory_budget(vertices, triangles), Err(INVALID));
    }
    let (_, minimum) = memory_budget(3, 1).unwrap();
    assert!(matches!(Job::new(3, 1, minimum - 1), Err(INVALID)));
    assert!(Job::new(3, 1, minimum).is_ok());
    assert!(matches!(
        Job::new(3, 1, MAX_WORKING_BYTES + 1),
        Err(INVALID)
    ));
}

#[test]
fn quotas_do_not_change_deterministic_output_or_work() {
    let mut tiny = soup(259, 3);
    assert_eq!(tiny.step(0), INVALID);
    assert_eq!(tiny.step(MAX_STEP_WORK_UNITS + 1), INVALID);
    assert_eq!(tiny.step(u32::MAX), INVALID);
    assert_eq!(tiny.work_units, 0);
    assert_eq!(tiny.step(1), RUNNING);
    assert_eq!(tiny.work_units, 1);
    assert!(matches!(tiny.phase, Phase::Vertices(1)));
    finish(&mut tiny, 1);
    let mut coarse = soup(259, 3);
    finish(&mut coarse, 8192);
    verify_tree(&tiny);
    verify_tree(&coarse);
    assert_eq!(words(&tiny.nodes), words(&coarse.nodes));
    assert_eq!(words(&tiny.triangles), words(&coarse.triangles));
    assert_eq!(tiny.work_units, coarse.work_units);
}

#[test]
fn median_partition_handles_duplicates_ordered_and_adversarial_inputs() {
    for distribution in 0..4 {
        let mut job = soup(8193, distribution);
        finish(&mut job, 137);
        verify_tree(&job);
        assert!(job.work_units < 8193 * 600);
        assert!(
            job.triangles
                .iter()
                .enumerate()
                .any(|(i, t)| i != t.source_triangle_id as usize)
        );
    }
}

#[test]
fn selector_places_exact_median_for_every_small_range_and_axis() {
    for count in 1..90 {
        for distribution in 0..4 {
            let source = soup(count, distribution);
            let mut primitives = (0..count)
                .map(|i| source.triangle(i).unwrap().1)
                .collect::<Vec<_>>();
            // Deliberately exercise equal centroids independently of spatial order.
            for axis in 0..3 {
                let mut values = primitives.clone();
                let mut expected = values.clone();
                expected.sort_by(|a, b| compare(key(a, axis), key(b, axis)));
                let mut selection = Selection::new(0, count, axis);
                let mut work = 0;
                while !selection.tick(&mut values) {
                    work += 1;
                    assert!(work < count * 100 + 100);
                }
                assert_eq!(values[count / 2].source, expected[count / 2].source);
                let pivot = key(&values[count / 2], axis);
                assert!(
                    values[..count / 2]
                        .iter()
                        .all(|p| compare(key(p, axis), pivot).is_lt())
                );
                assert!(
                    values[count / 2 + 1..]
                        .iter()
                        .all(|p| compare(key(p, axis), pivot).is_gt())
                );
            }
            primitives.clear();
        }
    }
}

#[test]
fn invalid_geometry_fails_without_dropping_or_exposing_partial_output() {
    for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut job = soup(1, 0);
        job.positions[8] = invalid;
        assert_eq!(job.step(8192), INVALID);
        assert_eq!(job.step(8192), INVALID);
        assert!(!job.complete());
    }
    for index in [3, u32::MAX] {
        let mut job = soup(1, 0);
        job.indices[2] = index;
        assert_eq!(job.step(8192), INVALID);
        assert!(job.triangles.is_empty());
    }
    let mut zero = soup(2, 0);
    zero.indices[5] = zero.indices[4];
    assert_eq!(zero.step(8192), INVALID);
    assert!(!zero.complete());
    let mut collinear = soup(1, 0);
    collinear
        .positions
        .copy_from_slice(&[0.0, 0.0, 0.0, 0.25, 0.5, 1.0, 0.5, 1.0, 2.0]);
    assert_eq!(collinear.step(8192), INVALID);
}

#[test]
fn exact_source_vertices_tiny_area_and_cancellation_survive() {
    for points in [
        [
            0.0,
            0.0,
            0.0,
            f32::from_bits(1),
            0.0,
            0.0,
            0.0,
            f32::from_bits(1),
            0.0,
        ],
        [1.0, 1.0, 0.0, 1e-30, 0.0, 0.0, 0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0, 1e-8, 0.0, 0.0, 0.0, 1.0, 0.0],
        [-f32::MAX, 0.0, 0.0, f32::MAX, 0.0, 0.0, 0.0, f32::MAX, 0.0],
    ] {
        let mut job = soup(1, 0);
        job.positions.copy_from_slice(&points);
        finish(&mut job, 1);
        verify_tree(&job);
        assert_eq!(job.triangles[0].geometric_normal[0], 0.0);
        assert_eq!(job.triangles[0].geometric_normal[1], 0.0);
        assert_eq!(job.triangles[0].geometric_normal[2].abs(), 1.0);
    }
}

#[test]
fn normals_preserve_winding_and_signed_zero_source_words() {
    let mut job = soup(1, 0);
    job.positions[0] = -0.0;
    job.indices.swap(1, 2);
    finish(&mut job, 100);
    assert_eq!(job.triangles[0].p0[0].to_bits(), (-0.0f32).to_bits());
    assert_eq!(job.triangles[0].geometric_normal, [0.0, 0.0, -1.0]);
    verify_tree(&job);
}

#[test]
fn instance_job_cancellation_and_restart_clear_all_outputs() {
    dispose();
    assert_eq!(step(1), STATE);
    assert!(positions_ptr().is_null());
    assert!(nodes_ptr().is_null());
    assert_eq!(begin(3, 1, MAX_WORKING_BYTES), RUNNING);
    assert_eq!(begin(3, 1, MAX_WORKING_BYTES), STATE);
    assert!(!positions_ptr().is_null());
    assert!(!indices_ptr().is_null());
    assert!(nodes_ptr().is_null());
    assert_eq!(node_count(), 0);
    assert_eq!(step(1), RUNNING);
    assert_eq!(work_units(), 1);
    dispose();
    assert_eq!(work_units(), 0);
    assert_eq!(working_bytes(), 0);
    assert!(indices_ptr().is_null());
    assert_eq!(step(10), STATE);
    assert_eq!(begin(3, 1, MAX_WORKING_BYTES), RUNNING);
    JOB.with_borrow_mut(|slot| {
        let job = slot.as_mut().unwrap();
        job.positions
            .copy_from_slice(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
        job.indices.copy_from_slice(&[0, 1, 2]);
    });
    assert_eq!(step(100), DONE);
    assert!(!nodes_ptr().is_null());
    assert!(!triangles_ptr().is_null());
    assert_eq!(node_count(), 1);
    assert_eq!(max_depth(), 1);
    dispose();
    assert!(triangles_ptr().is_null());
    assert_eq!(max_depth(), 0);
    assert_eq!(begin(3, 1, MAX_WORKING_BYTES), RUNNING);
    assert_eq!(step(100), INVALID); // Newly allocated input is zeroed, not prior data.
    dispose();
}

#[test]
#[ignore = "bounded million-triangle CPU smoke; run explicitly in release mode"]
fn million_triangle_smoke() {
    let count = MAX_TRIANGLES as usize;
    let mut job = Job::new(3, MAX_TRIANGLES, MAX_WORKING_BYTES).unwrap();
    job.positions
        .copy_from_slice(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
    for indices in job.indices.as_chunks_mut::<3>().0 {
        indices.copy_from_slice(&[0, 1, 2]);
    }
    let started = std::time::Instant::now();
    finish(&mut job, 8192);
    eprintln!(
        "million-triangle native CPU smoke: {:?}, {} work units, {} budget bytes, {} nodes, depth {}",
        started.elapsed(),
        job.work_units,
        job.working_bytes,
        job.nodes.len(),
        job.max_depth
    );
    assert_eq!(job.triangles.len(), count);
    assert_eq!(job.nodes.len(), 524_287);
    assert_eq!(job.max_depth, 19);
    verify_tree(&job);
}
