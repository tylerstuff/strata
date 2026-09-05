//! Versioned, per-WASM-instance lifecycle for the browser CPU runtime.
//!
//! A worker owns this module and its unshared linear memory. Static triangle
//! BVH jobs advance under explicit work quotas; JavaScript checks the ABI first.

mod static_bvh;

use std::sync::atomic::{AtomicBool, Ordering};

const ABI_VERSION: u32 = 2;
const SUCCESS: u32 = 0;
const INVALID_STATE: u32 = 1;

struct RuntimeLifecycle {
    initialized: AtomicBool,
}

impl RuntimeLifecycle {
    const fn new() -> Self {
        Self {
            initialized: AtomicBool::new(false),
        }
    }

    fn initialize(&self) -> u32 {
        match self
            .initialized
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => SUCCESS,
            Err(_) => INVALID_STATE,
        }
    }

    fn dispose(&self) -> u32 {
        match self
            .initialized
            .compare_exchange(true, false, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => SUCCESS,
            Err(_) => INVALID_STATE,
        }
    }

    fn is_initialized(&self) -> u32 {
        u32::from(self.initialized.load(Ordering::Acquire))
    }
}

// This state is isolated to each WebAssembly instance, not shared across engines.
static RUNTIME: RuntimeLifecycle = RuntimeLifecycle::new();

#[unsafe(no_mangle)]
pub extern "C" fn strata_abi_version() -> u32 {
    ABI_VERSION
}

/// Returns zero on the first initialization and one if already initialized.
#[unsafe(no_mangle)]
pub extern "C" fn strata_runtime_initialize() -> u32 {
    RUNTIME.initialize()
}

/// Returns zero when initialized and one if there was nothing to dispose.
#[unsafe(no_mangle)]
pub extern "C" fn strata_runtime_dispose() -> u32 {
    static_bvh::dispose();
    RUNTIME.dispose()
}

#[unsafe(no_mangle)]
pub extern "C" fn strata_runtime_is_initialized() -> u32 {
    RUNTIME.is_initialized()
}

/// BVH status: 0 running/success, 1 complete, 2 invalid input or budget,
/// 3 allocation failure, 4 invalid state. Only one job can exist at a time.
#[unsafe(no_mangle)]
pub extern "C" fn strata_bvh_begin(
    vertex_count: u32,
    triangle_count: u32,
    max_working_bytes: u32,
) -> u32 {
    if RUNTIME.is_initialized() == 0 {
        return static_bvh::STATE;
    }
    static_bvh::begin(vertex_count, triangle_count, max_working_bytes)
}

#[unsafe(no_mangle)]
pub extern "C" fn strata_bvh_positions_ptr() -> *const f32 {
    static_bvh::positions_ptr()
}
#[unsafe(no_mangle)]
pub extern "C" fn strata_bvh_indices_ptr() -> *const u32 {
    static_bvh::indices_ptr()
}
#[unsafe(no_mangle)]
pub extern "C" fn strata_bvh_step(work_units: u32) -> u32 {
    static_bvh::step(work_units)
}
#[unsafe(no_mangle)]
pub extern "C" fn strata_bvh_nodes_ptr() -> *const static_bvh::Node {
    static_bvh::nodes_ptr()
}
#[unsafe(no_mangle)]
pub extern "C" fn strata_bvh_triangles_ptr() -> *const static_bvh::Triangle {
    static_bvh::triangles_ptr()
}
#[unsafe(no_mangle)]
pub extern "C" fn strata_bvh_node_count() -> u32 {
    static_bvh::node_count()
}
/// Root depth is one. A maximum-size balanced tree has depth nineteen.
#[unsafe(no_mangle)]
pub extern "C" fn strata_bvh_max_depth() -> u32 {
    static_bvh::max_depth()
}
#[unsafe(no_mangle)]
pub extern "C" fn strata_bvh_work_units() -> u32 {
    static_bvh::work_units()
}
#[unsafe(no_mangle)]
pub extern "C" fn strata_bvh_working_bytes() -> u32 {
    static_bvh::working_bytes()
}
#[unsafe(no_mangle)]
pub extern "C" fn strata_bvh_dispose() {
    static_bvh::dispose();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_rejects_duplicate_transitions_and_can_restart() {
        let runtime = RuntimeLifecycle::new();
        assert_eq!(runtime.is_initialized(), 0);
        assert_eq!(runtime.dispose(), INVALID_STATE);
        assert_eq!(runtime.initialize(), SUCCESS);
        assert_eq!(runtime.is_initialized(), 1);
        assert_eq!(runtime.initialize(), INVALID_STATE);
        assert_eq!(runtime.dispose(), SUCCESS);
        assert_eq!(runtime.is_initialized(), 0);
        assert_eq!(runtime.initialize(), SUCCESS);
    }

    #[test]
    fn lifecycle_state_is_owned_by_its_runtime() {
        let first = RuntimeLifecycle::new();
        let second = RuntimeLifecycle::new();
        assert_eq!(first.initialize(), SUCCESS);
        assert_eq!(second.is_initialized(), 0);
        assert_eq!(second.initialize(), SUCCESS);
        assert_eq!(first.dispose(), SUCCESS);
        assert_eq!(second.is_initialized(), 1);
    }

    #[test]
    fn public_bvh_abi_requires_runtime_and_runtime_disposal_cancels_job() {
        assert_eq!(strata_abi_version(), 2);
        assert_eq!(strata_runtime_is_initialized(), 0);
        assert_eq!(
            strata_bvh_begin(3, 1, static_bvh::MAX_WORKING_BYTES),
            static_bvh::STATE
        );
        assert_eq!(strata_runtime_initialize(), SUCCESS);
        assert_eq!(
            strata_bvh_begin(3, 1, static_bvh::MAX_WORKING_BYTES),
            static_bvh::RUNNING
        );
        assert!(!strata_bvh_positions_ptr().is_null());
        assert_eq!(strata_bvh_step(1), static_bvh::RUNNING);
        assert_eq!(strata_runtime_dispose(), SUCCESS);
        assert!(strata_bvh_positions_ptr().is_null());
        assert!(strata_bvh_indices_ptr().is_null());
        assert!(strata_bvh_nodes_ptr().is_null());
        assert!(strata_bvh_triangles_ptr().is_null());
        assert_eq!(strata_bvh_node_count(), 0);
        assert_eq!(strata_bvh_working_bytes(), 0);
        assert_eq!(strata_bvh_step(1), static_bvh::STATE);
        assert_eq!(
            strata_bvh_begin(3, 1, static_bvh::MAX_WORKING_BYTES),
            static_bvh::STATE
        );
        strata_bvh_dispose();
        assert_eq!(strata_runtime_initialize(), SUCCESS);
        assert_eq!(
            strata_bvh_begin(3, 1, static_bvh::MAX_WORKING_BYTES),
            static_bvh::RUNNING
        );
        assert_eq!(strata_runtime_dispose(), SUCCESS);
    }
}
