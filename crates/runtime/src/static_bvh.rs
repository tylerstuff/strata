//! Stepped, exact-triangle static BVH construction for one unshared WASM instance.
//!
//! One work unit validates one vertex/triangle, scans one primitive, partitions
//! one key, sorts at most five keys, or performs a constant-size state transition.
//! Allocation and input-buffer zero filling happen in `begin`; geometry work is
//! performed only by `step`. No build stage sorts an entire range in one call.
//! The host fills both input buffers before its first step and must leave them
//! unchanged until completion or disposal. Output pointers are exposed only on
//! completion; every pointer is invalidated by disposal of the job or runtime.

use std::cell::RefCell;
use std::cmp::Ordering;
use std::mem::size_of;

pub const RUNNING: u32 = 0;
pub const DONE: u32 = 1;
pub const INVALID: u32 = 2;
pub const ALLOCATION: u32 = 3;
pub const STATE: u32 = 4;
pub const MAX_VERTICES: u32 = 2_097_152;
pub const MAX_TRIANGLES: u32 = 1_048_576;
pub const MAX_WORKING_BYTES: u32 = 512 * 1024 * 1024;
pub const MAX_STEP_WORK_UNITS: u32 = 262_144;
const HEADROOM: usize = 1024 * 1024;
const STACK_SIZE: usize = 32;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Node {
    pub minimum: [f32; 3],
    pub first: u32,
    pub maximum: [f32; 3],
    pub count: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Triangle {
    pub p0: [f32; 3],
    pub material_id: u32,
    pub p1: [f32; 3],
    pub source_vertex0: u32,
    pub p2: [f32; 3],
    pub source_triangle_id: u32,
    pub geometric_normal: [f32; 3],
    pub padding: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct Primitive {
    minimum: [f32; 3],
    maximum: [f32; 3],
    centroid: [f32; 3],
    source: u32,
}

#[derive(Clone, Copy, Debug, Default)]
struct Task {
    node: usize,
    start: usize,
    end: usize,
    depth: u32,
}

#[derive(Clone, Copy, Debug)]
struct Bounds {
    minimum: [f32; 3],
    maximum: [f32; 3],
}

impl Bounds {
    const EMPTY: Self = Self {
        minimum: [f32::INFINITY; 3],
        maximum: [f32::NEG_INFINITY; 3],
    };

    fn include(&mut self, minimum: [f32; 3], maximum: [f32; 3]) {
        for axis in 0..3 {
            self.minimum[axis] = self.minimum[axis].min(minimum[axis]);
            self.maximum[axis] = self.maximum[axis].max(maximum[axis]);
        }
    }

    fn longest_axis(self) -> usize {
        let mut axis = 0;
        for candidate in 1..3 {
            if f64::from(self.maximum[candidate]) - f64::from(self.minimum[candidate])
                > f64::from(self.maximum[axis]) - f64::from(self.minimum[axis])
            {
                axis = candidate;
            }
        }
        axis
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Key {
    centroid: f32,
    source: u32,
}

fn key(primitive: &Primitive, axis: usize) -> Key {
    Key {
        centroid: primitive.centroid[axis],
        source: primitive.source,
    }
}

fn compare(a: Key, b: Key) -> Ordering {
    // Centroids are finite. Treat -0 and +0 alike, then break every tie by the
    // original triangle ID, independently of previous partition operations.
    a.centroid
        .partial_cmp(&b.centroid)
        .unwrap()
        .then(a.source.cmp(&b.source))
}

#[derive(Clone, Copy, Debug, Default)]
enum SelectPhase {
    #[default]
    Start,
    Groups {
        cursor: usize,
        count: usize,
    },
    Waiting,
    Partition {
        low: usize,
        cursor: usize,
        high: usize,
        pivot: Key,
    },
}

#[derive(Clone, Copy, Debug, Default)]
struct SelectFrame {
    start: usize,
    end: usize,
    target: usize,
    phase: SelectPhase,
}

/// Deterministic median-of-medians quickselect, including its normally recursive
/// pivot selection, represented as a small resumable stack. Five-element sorts
/// have at most ten comparisons/swaps and require no allocations.
#[derive(Debug)]
struct Selection {
    axis: usize,
    frames: [SelectFrame; STACK_SIZE],
    depth: usize,
}

impl Selection {
    fn new(start: usize, end: usize, axis: usize) -> Self {
        let mut frames = [SelectFrame::default(); STACK_SIZE];
        frames[0] = SelectFrame {
            start,
            end,
            target: start + (end - start) / 2,
            phase: SelectPhase::Start,
        };
        Self {
            axis,
            frames,
            depth: 1,
        }
    }

    fn sort_five(&self, values: &mut [Primitive], start: usize, end: usize) {
        debug_assert!(end - start <= 5);
        for index in start + 1..end {
            let mut at = index;
            while at > start
                && compare(key(&values[at], self.axis), key(&values[at - 1], self.axis)).is_lt()
            {
                values.swap(at, at - 1);
                at -= 1;
            }
        }
    }

    fn finish(&mut self, values: &[Primitive]) -> bool {
        let completed = self.frames[self.depth - 1];
        let pivot = key(&values[completed.target], self.axis);
        self.depth -= 1;
        if self.depth == 0 {
            return true;
        }
        let parent = &mut self.frames[self.depth - 1];
        debug_assert!(matches!(parent.phase, SelectPhase::Waiting));
        parent.phase = SelectPhase::Partition {
            low: parent.start,
            cursor: parent.start,
            high: parent.end,
            pivot,
        };
        false
    }

    fn tick(&mut self, values: &mut [Primitive]) -> bool {
        let top = self.depth - 1;
        let frame = self.frames[top];
        match frame.phase {
            SelectPhase::Start => {
                if frame.end - frame.start <= 5 {
                    self.sort_five(values, frame.start, frame.end);
                    return self.finish(values);
                }
                self.frames[top].phase = SelectPhase::Groups {
                    cursor: frame.start,
                    count: 0,
                };
            }
            SelectPhase::Groups { cursor, count } => {
                if cursor < frame.end {
                    let end = (cursor + 5).min(frame.end);
                    self.sort_five(values, cursor, end);
                    values.swap(frame.start + count, cursor + (end - cursor) / 2);
                    self.frames[top].phase = SelectPhase::Groups {
                        cursor: end,
                        count: count + 1,
                    };
                } else {
                    debug_assert!(self.depth < STACK_SIZE);
                    self.frames[top].phase = SelectPhase::Waiting;
                    self.frames[self.depth] = SelectFrame {
                        start: frame.start,
                        end: frame.start + count,
                        target: frame.start + count / 2,
                        phase: SelectPhase::Start,
                    };
                    self.depth += 1;
                }
            }
            SelectPhase::Partition {
                mut low,
                mut cursor,
                mut high,
                pivot,
            } => {
                if cursor < high {
                    match compare(key(&values[cursor], self.axis), pivot) {
                        Ordering::Less => {
                            values.swap(low, cursor);
                            low += 1;
                            cursor += 1;
                        }
                        Ordering::Greater => {
                            high -= 1;
                            values.swap(cursor, high);
                        }
                        Ordering::Equal => {
                            cursor += 1;
                        }
                    }
                    self.frames[top].phase = SelectPhase::Partition {
                        low,
                        cursor,
                        high,
                        pivot,
                    };
                } else if frame.target < low {
                    self.frames[top].end = low;
                    self.frames[top].phase = SelectPhase::Start;
                } else if frame.target >= high {
                    self.frames[top].start = high;
                    self.frames[top].phase = SelectPhase::Start;
                } else {
                    return self.finish(values);
                }
            }
            SelectPhase::Waiting => unreachable!("a waiting selection always has an active child"),
        }
        false
    }
}

#[derive(Debug)]
enum Phase {
    Vertices(usize),
    Triangles(usize),
    NextNode,
    Scan {
        task: Task,
        cursor: usize,
        bounds: Bounds,
        centroids: Bounds,
    },
    Select {
        task: Task,
    },
    Pack(usize),
    Complete,
    Failed,
}

pub struct Job {
    positions: Vec<f32>,
    indices: Vec<u32>,
    primitives: Vec<Primitive>,
    nodes: Vec<Node>,
    triangles: Vec<Triangle>,
    pending: [Task; STACK_SIZE],
    pending_count: usize,
    selection: Selection,
    phase: Phase,
    work_units: u32,
    working_bytes: u32,
    max_depth: u32,
}

fn reserve<T>(count: usize) -> Result<Vec<T>, u32> {
    let mut values = Vec::new();
    values.try_reserve_exact(count).map_err(|_| ALLOCATION)?;
    Ok(values)
}

/// Includes all requested buffer capacities and fixed bookkeeping/allocator
/// headroom. It is a per-job budget, not a claim about WASM memory high-water use.
pub fn memory_budget(vertices: u32, triangles: u32) -> Result<(usize, u32), u32> {
    if !(3..=MAX_VERTICES).contains(&vertices) || triangles == 0 || triangles > MAX_TRIANGLES {
        return Err(INVALID);
    }
    let leaves = (triangles as usize)
        .div_ceil(4)
        .checked_next_power_of_two()
        .ok_or(INVALID)?;
    let nodes = leaves
        .checked_mul(2)
        .and_then(|n| n.checked_sub(1))
        .ok_or(INVALID)?;
    let bytes = (vertices as usize)
        .checked_mul(12)
        .and_then(|n| {
            (triangles as usize)
                .checked_mul(116)
                .and_then(|t| n.checked_add(t))
        })
        .and_then(|n| nodes.checked_mul(32).and_then(|b| n.checked_add(b)))
        .and_then(|n| n.checked_add(HEADROOM))
        .ok_or(INVALID)?;
    Ok((nodes, u32::try_from(bytes).map_err(|_| INVALID)?))
}

impl Job {
    pub fn new(vertices: u32, triangles: u32, max_working_bytes: u32) -> Result<Self, u32> {
        let (node_capacity, working_bytes) = memory_budget(vertices, triangles)?;
        if max_working_bytes > MAX_WORKING_BYTES || working_bytes > max_working_bytes {
            return Err(INVALID);
        }
        let mut positions = reserve::<f32>(vertices as usize * 3)?;
        positions.resize(vertices as usize * 3, 0.0);
        let mut indices = reserve::<u32>(triangles as usize * 3)?;
        indices.resize(triangles as usize * 3, 0);
        let primitives = reserve::<Primitive>(triangles as usize)?;
        let nodes = reserve::<Node>(node_capacity)?;
        let packed = reserve::<Triangle>(triangles as usize)?;
        Ok(Self {
            positions,
            indices,
            primitives,
            nodes,
            triangles: packed,
            pending: [Task::default(); STACK_SIZE],
            pending_count: 0,
            selection: Selection::new(0, 1, 0),
            phase: Phase::Vertices(0),
            work_units: 0,
            working_bytes,
            max_depth: 0,
        })
    }

    fn triangle(&self, source: usize) -> Result<(Triangle, Primitive), u32> {
        let indices = &self.indices[source * 3..source * 3 + 3];
        let mut points = [[0.0f32; 3]; 3];
        for corner in 0..3 {
            let start = (indices[corner] as usize).checked_mul(3).ok_or(INVALID)?;
            let point = self.positions.get(start..start + 3).ok_or(INVALID)?;
            points[corner].copy_from_slice(point);
        }
        let mut triangle = Triangle {
            p0: points[0],
            p1: points[1],
            p2: points[2],
            source_vertex0: indices[0],
            source_triangle_id: source as u32,
            ..Triangle::default()
        };
        let mut bounds = Bounds::EMPTY;
        let mut centroid = [0.0; 3];
        for axis in 0..3 {
            for point in &points {
                bounds.minimum[axis] = bounds.minimum[axis].min(point[axis]);
                bounds.maximum[axis] = bounds.maximum[axis].max(point[axis]);
            }
            centroid[axis] = ((f64::from(points[0][axis])
                + f64::from(points[1][axis])
                + f64::from(points[2][axis]))
                / 3.0) as f32;
        }
        // Every binary32-position product is exact in binary64. Error-free
        // expansion summation preserves cancellation between those products,
        // including nonzero triangles whose endpoint subtraction loses detail.
        let cross = [
            area_component(points, 1, 2),
            area_component(points, 2, 0),
            area_component(points, 0, 1),
        ];
        let scale = cross.iter().fold(0.0f64, |s, v| s.max(v.abs()));
        if scale == 0.0 {
            return Err(INVALID);
        }
        let scaled = cross.map(|v| v / scale);
        let length = scaled.iter().map(|v| v * v).sum::<f64>().sqrt();
        triangle.geometric_normal = scaled.map(|v| (v / length) as f32);
        let primitive = Primitive {
            minimum: bounds.minimum,
            maximum: bounds.maximum,
            centroid,
            source: source as u32,
        };
        Ok((triangle, primitive))
    }

    fn tick(&mut self) -> Result<(), u32> {
        let phase = std::mem::replace(&mut self.phase, Phase::Failed);
        self.phase = match phase {
            Phase::Vertices(index) => {
                if index == self.positions.len() / 3 {
                    Phase::Triangles(0)
                } else {
                    if self.positions[index * 3..index * 3 + 3]
                        .iter()
                        .any(|v| !v.is_finite())
                    {
                        return Err(INVALID);
                    }
                    Phase::Vertices(index + 1)
                }
            }
            Phase::Triangles(index) => {
                if index == self.indices.len() / 3 {
                    self.nodes.push(Node::default());
                    self.pending[0] = Task {
                        node: 0,
                        start: 0,
                        end: self.primitives.len(),
                        depth: 1,
                    };
                    self.pending_count = 1;
                    Phase::NextNode
                } else {
                    let (_, primitive) = self.triangle(index)?;
                    self.primitives.push(primitive);
                    Phase::Triangles(index + 1)
                }
            }
            Phase::NextNode => {
                if self.pending_count == 0 {
                    Phase::Pack(0)
                } else {
                    self.pending_count -= 1;
                    let task = self.pending[self.pending_count];
                    self.max_depth = self.max_depth.max(task.depth);
                    Phase::Scan {
                        task,
                        cursor: task.start,
                        bounds: Bounds::EMPTY,
                        centroids: Bounds::EMPTY,
                    }
                }
            }
            Phase::Scan {
                task,
                mut cursor,
                mut bounds,
                mut centroids,
            } => {
                if cursor < task.end {
                    let primitive = self.primitives[cursor];
                    bounds.include(primitive.minimum, primitive.maximum);
                    centroids.include(primitive.centroid, primitive.centroid);
                    cursor += 1;
                    Phase::Scan {
                        task,
                        cursor,
                        bounds,
                        centroids,
                    }
                } else {
                    self.nodes[task.node] = Node {
                        minimum: bounds.minimum,
                        maximum: bounds.maximum,
                        first: task.start as u32,
                        count: (task.end - task.start) as u32,
                    };
                    if task.end - task.start <= 4 {
                        Phase::NextNode
                    } else {
                        self.selection =
                            Selection::new(task.start, task.end, centroids.longest_axis());
                        Phase::Select { task }
                    }
                }
            }
            Phase::Select { task } => {
                if self.selection.tick(&mut self.primitives) {
                    let middle = task.start + (task.end - task.start) / 2;
                    let first = self.nodes.len();
                    if first + 2 > self.nodes.capacity()
                        || task.depth >= STACK_SIZE as u32
                        || self.pending_count + 2 > STACK_SIZE
                    {
                        return Err(INVALID);
                    }
                    self.nodes.push(Node::default());
                    self.nodes.push(Node::default());
                    self.nodes[task.node].first = first as u32;
                    self.nodes[task.node].count = 0;
                    self.pending[self.pending_count] = Task {
                        node: first + 1,
                        start: middle,
                        end: task.end,
                        depth: task.depth + 1,
                    };
                    self.pending[self.pending_count + 1] = Task {
                        node: first,
                        start: task.start,
                        end: middle,
                        depth: task.depth + 1,
                    };
                    self.pending_count += 2;
                    Phase::NextNode
                } else {
                    Phase::Select { task }
                }
            }
            Phase::Pack(index) => {
                if index == self.primitives.len() {
                    Phase::Complete
                } else {
                    let (triangle, _) = self.triangle(self.primitives[index].source as usize)?;
                    self.triangles.push(triangle);
                    Phase::Pack(index + 1)
                }
            }
            Phase::Complete => Phase::Complete,
            Phase::Failed => return Err(INVALID),
        };
        Ok(())
    }

    pub fn step(&mut self, quota: u32) -> u32 {
        if quota == 0 || quota > MAX_STEP_WORK_UNITS {
            return INVALID;
        }
        if matches!(self.phase, Phase::Complete) {
            return DONE;
        }
        if matches!(self.phase, Phase::Failed) {
            return INVALID;
        }
        for _ in 0..quota {
            self.work_units = self.work_units.saturating_add(1);
            if self.tick().is_err() {
                self.phase = Phase::Failed;
                return INVALID;
            }
            if matches!(self.phase, Phase::Complete) {
                return DONE;
            }
        }
        RUNNING
    }

    fn complete(&self) -> bool {
        matches!(self.phase, Phase::Complete)
    }
}

fn area_component(points: [[f32; 3]; 3], x: usize, y: usize) -> f64 {
    let [a, b, c] = points.map(|p| p.map(f64::from));
    let terms = [
        b[x] * c[y],
        -b[y] * c[x],
        a[x] * b[y],
        -a[y] * b[x],
        c[x] * a[y],
        -c[y] * a[x],
    ];
    let mut expansion = [0.0f64; 6];
    let mut length = 0;
    for term in terms {
        let mut q = term;
        let mut next_length = 0;
        for index in 0..length {
            let e = expansion[index];
            let sum = q + e;
            let b_virtual = sum - q;
            let a_virtual = sum - b_virtual;
            let error = (q - a_virtual) + (e - b_virtual);
            if error != 0.0 {
                expansion[next_length] = error;
                next_length += 1;
            }
            q = sum;
        }
        if q != 0.0 || next_length == 0 {
            expansion[next_length] = q;
            next_length += 1;
        }
        length = next_length;
    }
    expansion[..length].iter().sum()
}

thread_local! {
    static JOB: RefCell<Option<Job>> = const { RefCell::new(None) };
}

pub fn begin(vertices: u32, triangles: u32, maximum: u32) -> u32 {
    JOB.with_borrow_mut(|slot| {
        if slot.is_some() {
            return STATE;
        }
        match Job::new(vertices, triangles, maximum) {
            Ok(job) => {
                *slot = Some(job);
                RUNNING
            }
            Err(status) => status,
        }
    })
}
pub fn dispose() {
    JOB.with_borrow_mut(|slot| {
        *slot = None;
    });
}
pub fn step(quota: u32) -> u32 {
    JOB.with_borrow_mut(|slot| slot.as_mut().map_or(STATE, |job| job.step(quota)))
}
pub fn positions_ptr() -> *const f32 {
    JOB.with_borrow(|slot| {
        slot.as_ref()
            .map_or(std::ptr::null(), |job| job.positions.as_ptr())
    })
}
pub fn indices_ptr() -> *const u32 {
    JOB.with_borrow(|slot| {
        slot.as_ref()
            .map_or(std::ptr::null(), |job| job.indices.as_ptr())
    })
}
pub fn nodes_ptr() -> *const Node {
    JOB.with_borrow(|slot| {
        slot.as_ref()
            .filter(|job| job.complete())
            .map_or(std::ptr::null(), |job| job.nodes.as_ptr())
    })
}
pub fn triangles_ptr() -> *const Triangle {
    JOB.with_borrow(|slot| {
        slot.as_ref()
            .filter(|job| job.complete())
            .map_or(std::ptr::null(), |job| job.triangles.as_ptr())
    })
}
pub fn node_count() -> u32 {
    JOB.with_borrow(|slot| {
        slot.as_ref()
            .filter(|job| job.complete())
            .map_or(0, |job| job.nodes.len() as u32)
    })
}
pub fn max_depth() -> u32 {
    JOB.with_borrow(|slot| {
        slot.as_ref()
            .filter(|job| job.complete())
            .map_or(0, |job| job.max_depth)
    })
}
pub fn work_units() -> u32 {
    JOB.with_borrow(|slot| slot.as_ref().map_or(0, |job| job.work_units))
}
pub fn working_bytes() -> u32 {
    JOB.with_borrow(|slot| slot.as_ref().map_or(0, |job| job.working_bytes))
}

const _: () =
    assert!(size_of::<Node>() == 32 && size_of::<Triangle>() == 64 && size_of::<Primitive>() == 40);

#[cfg(test)]
mod tests;
