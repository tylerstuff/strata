//! Certified vertical error between the cooked finest and coarse heightfield surfaces.
//! XZ overlay geometry is exact i128 rational arithmetic. Plane evaluation uses
//! outward-rounded f64 intervals on exactly representable source f32 heights.
use super::{Config, Mesh, mesh};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug)]
struct Point {
    x: i128,
    z: i128,
}
#[derive(Clone, Copy, Debug)]
struct RationalPoint {
    x: i128,
    z: i128,
    d: i128,
}
#[derive(Clone, Copy, Debug)]
struct Triangle {
    p: [Point; 3],
    h: [f64; 3],
}
#[derive(Clone, Copy, Debug)]
struct Interval {
    lo: f64,
    hi: f64,
}
fn down(v: f64) -> f64 {
    v.next_down()
}
fn up(v: f64) -> f64 {
    v.next_up()
}
impl Interval {
    fn exact(v: f64) -> Self {
        Self { lo: v, hi: v }
    }
    fn ratio(n: i128, d: i128) -> Self {
        assert!(n.abs() <= 1_i128 << 53 && d.abs() <= 1_i128 << 53 && d != 0);
        let v = n as f64 / d as f64;
        Self {
            lo: down(v),
            hi: up(v),
        }
    }
    fn add(self, b: Self) -> Self {
        Self {
            lo: down(self.lo + b.lo),
            hi: up(self.hi + b.hi),
        }
    }
    fn sub(self, b: Self) -> Self {
        Self {
            lo: down(self.lo - b.hi),
            hi: up(self.hi - b.lo),
        }
    }
    fn mul(self, b: Self) -> Self {
        let v = [
            self.lo * b.lo,
            self.lo * b.hi,
            self.hi * b.lo,
            self.hi * b.hi,
        ];
        Self {
            lo: down(v.into_iter().fold(f64::INFINITY, f64::min)),
            hi: up(v.into_iter().fold(f64::NEG_INFINITY, f64::max)),
        }
    }
    fn absolute(self) -> Self {
        Self {
            lo: if self.lo <= 0. && self.hi >= 0. {
                0.
            } else {
                self.lo.abs().min(self.hi.abs())
            },
            hi: self.lo.abs().max(self.hi.abs()),
        }
    }
}
fn cross(a: Point, b: Point) -> i128 {
    a.x * b.z - a.z * b.x
}
fn sub(a: Point, b: Point) -> Point {
    Point {
        x: a.x - b.x,
        z: a.z - b.z,
    }
}
fn rational(p: Point) -> RationalPoint {
    RationalPoint {
        x: p.x,
        z: p.z,
        d: 1,
    }
}
fn edge(a: Point, b: Point, p: RationalPoint) -> i128 {
    cross(
        sub(b, a),
        Point {
            x: p.x - a.x * p.d,
            z: p.z - a.z * p.d,
        },
    )
}
fn area(t: Triangle) -> i128 {
    cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0]))
}
fn contains(t: Triangle, p: RationalPoint) -> bool {
    let a = area(t);
    assert_ne!(a, 0);
    (0..3).all(|i| edge(t.p[i], t.p[(i + 1) % 3], p) * a >= 0)
}
fn intersection(a: Point, b: Point, c: Point, d: Point) -> Option<RationalPoint> {
    let r = sub(b, a);
    let s = sub(d, c);
    let q = sub(c, a);
    let mut den = cross(r, s);
    if den == 0 {
        return None;
    }
    let mut t = cross(q, s);
    let mut u = cross(q, r);
    if den < 0 {
        den = -den;
        t = -t;
        u = -u;
    }
    if t < 0 || t > den || u < 0 || u > den {
        return None;
    }
    Some(RationalPoint {
        x: a.x * den + r.x * t,
        z: a.z * den + r.z * t,
        d: den,
    })
}
fn evaluate(t: Triangle, p: RationalPoint) -> Interval {
    let den = area(t) * p.d;
    (0..3).fold(Interval::exact(0.), |sum, i| {
        sum.add(
            Interval::ratio(edge(t.p[(i + 1) % 3], t.p[(i + 2) % 3], p), den)
                .mul(Interval::exact(t.h[i])),
        )
    })
}
fn candidate(a: Triangle, b: Triangle, point: RationalPoint, maximum: &mut f64) {
    *maximum = maximum.max(evaluate(a, point).sub(evaluate(b, point)).absolute().hi);
}
fn pair(a: Triangle, b: Triangle, maximum: &mut f64) {
    // The height difference is affine on each convex overlap polygon. Its
    // extrema are contained vertices or edge intersections. Collinear edges
    // add no candidates beyond contained endpoints; exact signs need no epsilon.
    for p in a.p {
        if contains(b, rational(p)) {
            candidate(a, b, rational(p), maximum);
        }
    }
    for p in b.p {
        if contains(a, rational(p)) {
            candidate(a, b, rational(p), maximum);
        }
    }
    for i in 0..3 {
        for j in 0..3 {
            if let Some(p) = intersection(a.p[i], a.p[(i + 1) % 3], b.p[j], b.p[(j + 1) % 3]) {
                candidate(a, b, p, maximum);
            }
        }
    }
}
fn triangles(source: &Mesh) -> Vec<Triangle> {
    source
        .indices
        .as_chunks::<3>()
        .0
        .iter()
        .map(|ids| {
            let p = std::array::from_fn(|i| {
                let v = source.vertices[ids[i] as usize].position;
                assert_eq!(v[0].fract(), 0.);
                assert_eq!(v[2].fract(), 0.);
                Point {
                    x: v[0] as i128,
                    z: v[2] as i128,
                }
            });
            Triangle {
                p,
                h: std::array::from_fn(|i| f64::from(source.vertices[ids[i] as usize].position[1])),
            }
        })
        .collect()
}
fn fine_cell(source: &Mesh, cells: usize, x: usize, z: usize) -> [Triangle; 2] {
    let a = z * (cells + 1) + x;
    let b = a + cells + 1;
    [[a, b, b + 1], [a, b + 1, a + 1]].map(|ids| Triangle {
        p: ids.map(|id| {
            let v = source.vertices[id].position;
            Point {
                x: v[0] as i128,
                z: v[2] as i128,
            }
        }),
        h: ids.map(|id| f64::from(source.vertices[id].position[1])),
    })
}

/// Fail explicitly if the finest producer changes grid layout or triangulation.
fn validate_finest(source: &Mesh, cells: usize) -> Result<(), String> {
    let invalid =
        || "Certified LOD requires the current finest grid/diagonal topology.".to_string();
    if source.vertices.len() != (cells + 1) * (cells + 1)
        || source.indices.len() != cells * cells * 6
    {
        return Err(invalid());
    }
    let origin = source.vertices[0].position;
    for z in 0..=cells {
        for x in 0..=cells {
            let p = source.vertices[z * (cells + 1) + x].position;
            if p[0] != origin[0] + x as f32 || p[2] != origin[2] + z as f32 || !p[1].is_finite() {
                return Err(invalid());
            }
        }
    }
    let actual: BTreeSet<[u32; 3]> = source
        .indices
        .as_chunks::<3>()
        .0
        .iter()
        .map(|t| [t[0], t[1], t[2]])
        .collect();
    let mut expected = BTreeSet::new();
    for z in 0..cells {
        for x in 0..cells {
            let a = (z * (cells + 1) + x) as u32;
            let b = a + (cells + 1) as u32;
            expected.insert([a, b, b + 1]);
            expected.insert([a, b + 1, a + 1]);
        }
    }
    if actual != expected {
        return Err(invalid());
    }
    Ok(())
}

/// Integer bounds follow Config::validate: |XZ|<=1024, edge components<=128.
/// Intersection denominator<=32768; coordinate numerator<=37,748,736;
/// plane-weight numerator<=18,253,611,008 and denominator<=1,073,741,824.
/// Even orientation products are <6e14, inside i128; every f64 integer input
/// is checked <=2^53. Heights are original f32 values, exact in f64.
fn surface_error(source: &Mesh, coarse: &Mesh, cells: usize) -> f64 {
    let origin = Point {
        x: source.vertices[0].position[0] as i128,
        z: source.vertices[0].position[2] as i128,
    };
    let mut maximum = 0_f64;
    for t in triangles(coarse) {
        let min_x = t.p.iter().map(|p| p.x - origin.x).min().unwrap().max(0) as usize;
        let max_x =
            t.p.iter()
                .map(|p| p.x - origin.x)
                .max()
                .unwrap()
                .min(cells as i128) as usize;
        let min_z = t.p.iter().map(|p| p.z - origin.z).min().unwrap().max(0) as usize;
        let max_z =
            t.p.iter()
                .map(|p| p.z - origin.z)
                .max()
                .unwrap()
                .min(cells as i128) as usize;
        for z in min_z..max_z {
            for x in min_x..max_x {
                for f in fine_cell(source, cells, x, z) {
                    pair(f, t, &mut maximum);
                }
            }
        }
    }
    // Source-space GPU metadata uses f32. Preserve the interval upper bound
    // when converting the published value, rather than rounding it downward.
    let value = maximum as f32;
    f64::from(if f64::from(value) < maximum {
        value.next_up()
    } else {
        value
    })
}

pub(super) fn errors(config: Config, steps: &[usize]) -> Result<Vec<Vec<f64>>, String> {
    config.validate()?;
    let mut output = Vec::with_capacity(config.tiles * config.tiles);
    for tile in 0..config.tiles * config.tiles {
        let source = mesh(config, tile, 1);
        validate_finest(&source, config.cells)?;
        let mut previous = 0_f64;
        let mut levels = Vec::with_capacity(steps.len());
        for &step in steps {
            let measured = if step == 1 {
                0.
            } else {
                surface_error(&source, &mesh(config, tile, step), config.cells)
            };
            // The runtime expects monotonic bounds. A prefix maximum retains
            // conservatism even if another seed produces nonmonotonic maxima.
            previous = previous.max(measured);
            levels.push(previous);
        }
        output.push(levels);
    }
    Ok(output)
}

#[cfg(test)]
#[path = "certified_lod_tests.rs"]
mod tests;
