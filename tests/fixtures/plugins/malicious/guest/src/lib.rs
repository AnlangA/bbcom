//! Reproducible source for the reviewed G45 protocol-v2 fixture WAT files.

#![no_std]
// WIT resource imports expand to host shims whose ABI has more than seven
// scalar arguments. The generated signature is fixed by the v2 contract.
#![allow(clippy::too_many_arguments)]

extern crate alloc;

use alloc::string::{String, ToString};
use alloc::vec::Vec;

use bbcom_plugin_guest_runtime as _;

wit_bindgen::generate!({
    path: "../../../../../wit/bbcom-plugin-v2",
    world: "plugin",
    std_feature,
});

use self::bbcom::plugin::types;

#[cfg(not(any(
    feature = "primary",
    feature = "trap",
    feature = "runaway",
    feature = "memory"
)))]
compile_error!("select one G45 fixture feature");

struct FixtureGuest;

impl Guest for FixtureGuest {
    fn initialize(
        _context: types::HostContext,
    ) -> Result<types::PluginModel, types::ContractError> {
        initialization_behavior();
        Ok(types::PluginModel {
            surfaces: Vec::new(),
            commands: Vec::new(),
        })
    }

    fn handle_event(
        _event: types::PluginEvent,
    ) -> Result<types::EventResult, types::ContractError> {
        Ok(types::EventResult { accepted: true })
    }

    fn run_command(
        _invocation: types::CommandInvocation,
    ) -> Result<types::CommandResult, types::ContractError> {
        Ok(types::CommandResult {
            message: "G45".to_string(),
        })
    }

    fn migrate_state(
        _previous_api: String,
        state: Vec<u8>,
    ) -> Result<types::MigratedState, types::ContractError> {
        Ok(types::MigratedState {
            schema_version: 2,
            state,
        })
    }

    fn shutdown() {}
}

#[inline(never)]
fn initialization_behavior() {
    #[cfg(feature = "trap")]
    core::arch::wasm32::unreachable();

    #[cfg(feature = "runaway")]
    loop {
        core::hint::spin_loop();
    }

    #[cfg(feature = "memory")]
    {
        // Crossing the 64 MiB host limit marks the limiter before the trap,
        // which must therefore classify this as PLUGIN_MEMORY_LIMIT.
        let _ = core::arch::wasm32::memory_grow::<0>(1_024);
        core::arch::wasm32::unreachable();
    }
}

export!(FixtureGuest);
