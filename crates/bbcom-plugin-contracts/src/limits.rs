pub const FRAME_LENGTH_PREFIX_BYTES: usize = 4;
pub const HANDSHAKE_TIMEOUT_MS: u64 = 5_000;
/// Cold Wasm initialization includes the complete initial UI/command model
/// and synchronous host callbacks, so it needs a separate deadline from
/// ordinary interactive calls.
pub const INITIALIZATION_TIMEOUT_MS: u64 = 10_000;
pub const MAX_PLUGIN_PERSISTED_STATE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_WORKSPACE_PLUGIN_PERSISTED_STATE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_PLUGIN_STATE_CHUNK_BYTES: usize = 512 * 1024;

pub const MAX_PACKAGE_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_PACKAGE_EXPANDED_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_PACKAGE_FILES: u32 = 2_048;
