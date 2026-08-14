/// Existing bounded command limits.
pub const MAX_CHECKSUM_DATA_BYTES: usize = 1024 * 1024;
pub const MAX_EXPORT_FRAMES: usize = 100_000;
pub const MAX_EXPORT_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_EXPORT_FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_EXPORT_BATCH_FRAMES: usize = 256;
pub const MAX_EXPORT_BATCH_BYTES: usize = 512 * 1024;
pub const MAX_AUTO_LOG_BATCH_FRAMES: usize = 256;
pub const MAX_AUTO_LOG_BATCH_BYTES: usize = 256 * 1024;
pub const MAX_AUTO_LOG_FRAME_ID_BYTES: usize = 256;
pub const MAX_AI_REQUEST_ID_BYTES: usize = 128;
pub const MAX_AI_PROMPT_BYTES: usize = 16 * 1024;
pub const MAX_AI_CONTEXT_BYTES: usize = 512_000;
pub const MAX_AI_MODEL_BYTES: usize = 64;
pub const MAX_AI_SHELL_BYTES: usize = 256;
pub const MAX_AI_SESSION_META_BYTES: usize = 4 * 1024;
pub const MAX_AI_CONTEXT_MODE_BYTES: usize = 64;
pub const MAX_AI_RESPONSE_BYTES: usize = 256 * 1024;
pub const MAX_CONCURRENT_AI_REQUESTS: usize = 2;

/// Workspace v1 limits. Oversized values are rejected as a whole.
pub const MAX_WORKSPACE_SESSIONS: usize = 64;
pub const MAX_WORKSPACE_FRAMES_PER_SESSION: usize = 100_000;
pub const MAX_WORKSPACE_FRAMES: usize = 250_000;
pub const MAX_WORKSPACE_FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_WORKSPACE_CAPTURE_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_WORKSPACE_DATABASE_BYTES: usize = 512 * 1024 * 1024;
/// Maximum canonical JSON body accepted by the one-time 0.7.3 backup.
///
/// The encrypted artifact has its own 512 MiB container ceiling. Keeping the
/// body at the workspace payload ceiling leaves deterministic room for the
/// versioned envelope and age framing instead of silently truncating either.
pub const MAX_LEGACY_BACKUP_CONTENT_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_WORKSPACE_MUTATIONS_PER_BATCH: usize = 256;
pub const MAX_WORKSPACE_FRAMES_PER_BATCH: usize = 256;
pub const MAX_WORKSPACE_BATCH_BYTES: usize = 512 * 1024;
pub const MAX_WORKSPACE_AI_MESSAGES: usize = 10_000;
pub const MAX_WORKSPACE_AI_MESSAGE_BYTES: usize = 256 * 1024;
pub const MAX_WORKSPACE_AI_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_PLUGIN_STATE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_WORKSPACE_PLUGIN_STATE_BYTES: usize = 64 * 1024 * 1024;

/// Plugin-center IPC limits. Lists and declarative UI are rejected as a whole.
pub const MAX_PLUGIN_CATALOG_ITEMS: usize = 512;
pub const MAX_INSTALLED_PLUGINS: usize = 128;
pub const MAX_PLUGIN_AUTHORIZATION_PERMISSIONS: usize = 32;
pub const MAX_PLUGIN_SERIAL_PROPOSALS: usize = 64;
pub const MAX_PLUGIN_PANELS: usize = 64;
pub const MAX_PLUGIN_PANEL_FIELDS: usize = 256;
pub const MAX_PLUGIN_PANEL_OPTIONS: usize = 64;
pub const MAX_PLUGIN_PANEL_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_PLUGIN_ID_BYTES: usize = 128;
pub const MAX_PLUGIN_VERSION_BYTES: usize = 128;
pub const MAX_PLUGIN_DISPLAY_NAME_BYTES: usize = 128;
pub const MAX_PLUGIN_DESCRIPTION_BYTES: usize = 1024;
pub const MAX_PLUGIN_PANEL_TITLE_BYTES: usize = 128;
pub const MAX_PLUGIN_PANEL_FIELD_ID_BYTES: usize = 64;
pub const MAX_PLUGIN_PANEL_LABEL_BYTES: usize = 256;
pub const MAX_PLUGIN_PANEL_VALUE_BYTES: usize = 4 * 1024;
pub const MAX_PLUGIN_PANEL_OPTION_BYTES: usize = 256;
pub const MAX_PLUGIN_HEX_PREVIEW_BYTES: usize = 4 * 1024;
