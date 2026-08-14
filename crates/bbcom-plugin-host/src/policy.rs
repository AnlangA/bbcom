use std::time::Duration;

use bbcom_plugin_contracts::{
    CALL_TIMEOUT_MS, HANDSHAKE_TIMEOUT_MS, HOST_PROCESS_MEMORY_LIMIT_BYTES, LONG_TASK_TIMEOUT_MS,
    MAX_FRAME_BYTES, MAX_QUEUE_BYTES, WASM_MEMORY_LIMIT_BYTES,
};

use crate::{HostError, Result};

const DEFAULT_FUEL_PER_CALL: u64 = 10_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostPolicy {
    pub handshake_timeout: Duration,
    pub call_timeout: Duration,
    pub long_task_timeout: Duration,
    pub max_frame_bytes: usize,
    pub max_queue_bytes: usize,
    pub wasm_memory_bytes: usize,
    pub process_memory_bytes: usize,
    pub fuel_per_call: u64,
}

impl HostPolicy {
    #[must_use]
    pub const fn fixed() -> Self {
        Self {
            handshake_timeout: Duration::from_millis(HANDSHAKE_TIMEOUT_MS),
            call_timeout: Duration::from_millis(CALL_TIMEOUT_MS),
            long_task_timeout: Duration::from_millis(LONG_TASK_TIMEOUT_MS),
            max_frame_bytes: MAX_FRAME_BYTES,
            max_queue_bytes: MAX_QUEUE_BYTES,
            wasm_memory_bytes: WASM_MEMORY_LIMIT_BYTES,
            process_memory_bytes: HOST_PROCESS_MEMORY_LIMIT_BYTES,
            fuel_per_call: DEFAULT_FUEL_PER_CALL,
        }
    }
}

impl Default for HostPolicy {
    fn default() -> Self {
        Self::fixed()
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
