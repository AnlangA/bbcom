pub const PROTOCOL_MAJOR: u32 = 1;
/// v3: additive SerialProposalEvent/ProposalResult and SessionQuery* payloads
/// for the parked serial-proposal and G43 session/capture pipelines.
pub const PROTOCOL_MINOR: u32 = 3;
pub const WIT_PACKAGE: &str = "bbcom:plugin@1.0.0";

pub const FRAME_LENGTH_PREFIX_BYTES: usize = 4;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_QUEUE_BYTES: usize = 16 * 1024 * 1024;
pub const HANDSHAKE_TIMEOUT_MS: u64 = 5_000;
pub const CALL_TIMEOUT_MS: u64 = 2_000;
pub const LONG_TASK_TIMEOUT_MS: u64 = 60_000;
pub const WASM_MEMORY_LIMIT_BYTES: usize = 64 * 1024 * 1024;
pub const HOST_PROCESS_MEMORY_LIMIT_BYTES: usize = 256 * 1024 * 1024;
pub const PLUGIN_STATE_SCHEMA_VERSION: u32 = 1;
pub const MAX_PLUGIN_PERSISTED_STATE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_WORKSPACE_PLUGIN_PERSISTED_STATE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_PLUGIN_STATE_CHUNK_BYTES: usize = 512 * 1024;

pub const MAX_PACKAGE_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_PACKAGE_EXPANDED_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_PACKAGE_FILES: u32 = 2_048;
