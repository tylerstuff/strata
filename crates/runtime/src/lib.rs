//! Versioned, per-WASM-instance lifecycle for the browser CPU runtime.
//!
//! The bootstrap deliberately contains no simulation or rendering systems yet.
//! A worker owns this module and its unshared linear memory. Future coarse jobs
//! can extend the ABI; JavaScript checks the ABI before initializing the module.

use std::sync::atomic::{AtomicBool, Ordering};

const ABI_VERSION: u32 = 1;
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
    RUNTIME.dispose()
}

#[unsafe(no_mangle)]
pub extern "C" fn strata_runtime_is_initialized() -> u32 {
    RUNTIME.is_initialized()
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
}
