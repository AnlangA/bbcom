use std::time::Duration;

use bbcom_plugin_contracts::HANDSHAKE_TIMEOUT_MS;
use bbcom_plugin_contracts::v2::{
    ACTIVITY_TIMEOUT_MS, CALL_TIMEOUT_MS, HOST_PROCESS_MEMORY_LIMIT_BYTES, LONG_TASK_TIMEOUT_MS,
    MAX_FRAME_BYTES, MAX_QUEUE_BYTES, WASM_MEMORY_LIMIT_BYTES,
};

use crate::{HostError, Result};

const DEFAULT_FUEL_PER_CALL: u64 = 10_000_000;
// Initialization may build the maximum bounded declarative model (up to 32
// surfaces and 256 commands) and publish its first snapshots. It remains under
// the ordinary two-second epoch deadline, but needs a larger deterministic
// instruction allowance than a small event handler.
const INITIALIZATION_FUEL_PER_CALL: u64 = 50_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostPolicy {
    pub handshake_timeout: Duration,
    pub call_timeout: Duration,
    pub long_task_timeout: Duration,
    pub activity_timeout: Duration,
    pub max_frame_bytes: usize,
    pub max_queue_bytes: usize,
    pub wasm_memory_bytes: usize,
    pub process_memory_bytes: usize,
    pub fuel_per_call: u64,
    pub initialization_fuel: u64,
}

impl HostPolicy {
    #[must_use]
    pub const fn fixed() -> Self {
        Self {
            handshake_timeout: Duration::from_millis(HANDSHAKE_TIMEOUT_MS),
            call_timeout: Duration::from_millis(CALL_TIMEOUT_MS as u64),
            long_task_timeout: Duration::from_millis(LONG_TASK_TIMEOUT_MS),
            activity_timeout: Duration::from_millis(ACTIVITY_TIMEOUT_MS as u64),
            max_frame_bytes: MAX_FRAME_BYTES,
            max_queue_bytes: MAX_QUEUE_BYTES,
            wasm_memory_bytes: WASM_MEMORY_LIMIT_BYTES,
            process_memory_bytes: HOST_PROCESS_MEMORY_LIMIT_BYTES,
            fuel_per_call: DEFAULT_FUEL_PER_CALL,
            initialization_fuel: INITIALIZATION_FUEL_PER_CALL,
        }
    }
}

impl Default for HostPolicy {
    fn default() -> Self {
        Self::fixed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialization_has_bounded_extra_fuel_without_extending_its_deadline() {
        let policy = HostPolicy::fixed();
        assert_eq!(policy.fuel_per_call, 10_000_000);
        assert_eq!(policy.initialization_fuel, 50_000_000);
        assert_eq!(policy.call_timeout, Duration::from_secs(2));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AmbientAuthorityPolicy {
    pub wasi_linked: bool,
    pub network: bool,
    pub filesystem: bool,
    pub environment: bool,
    pub process: bool,
    pub device: bool,
    pub tauri: bool,
    pub webview: bool,
}

impl AmbientAuthorityPolicy {
    pub const NONE: Self = Self {
        wasi_linked: false,
        network: false,
        filesystem: false,
        environment: false,
        process: false,
        device: false,
        tauri: false,
        webview: false,
    };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostPlatform {
    Windows,
    MacOs,
    Linux,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcessLimitPolicy {
    pub platform: HostPlatform,
    pub memory_limit_bytes: usize,
    pub blocks_child_processes: bool,
    pub blocks_network: bool,
    pub restricts_filesystem: bool,
}

impl ProcessLimitPolicy {
    pub fn validate(self) -> Result<()> {
        if self.memory_limit_bytes == 0 || self.memory_limit_bytes > HOST_PROCESS_MEMORY_LIMIT_BYTES
        {
            return Err(HostError::InvalidProcessLimit);
        }
        if !self.blocks_child_processes || !self.blocks_network || !self.restricts_filesystem {
            return Err(HostError::IncompleteSandbox);
        }
        Ok(())
    }
}
